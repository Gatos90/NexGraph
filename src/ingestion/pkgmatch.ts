import fsp from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/connection.js";
import { createChildLogger } from "../logger.js";
import { cleanupTempDir } from "./extract.js";
import type { ExtractResult } from "./extract.js";

const logger = createChildLogger("pkgmatch");

// ─── Types ──────────────────────────────────────────────────

/** A dependency extracted from a package manifest file. */
export interface PackageDependency {
  /** The package/module name as declared in the manifest */
  name: string;
  /** Version constraint (e.g., "^1.0.0", ">=0.5", "v1.2.3") */
  version: string;
  /** The manifest file path relative to repo root */
  manifestPath: string;
  /** The ecosystem: npm, cargo, go */
  ecosystem: "npm" | "cargo" | "go";
  /** Whether this is a dev/build dependency vs runtime */
  isDev: boolean;
}

/** Info about a repository in the same project. */
interface RepoInfo {
  id: string;
  projectId: string;
  url: string;
  name: string | null;
  sourceType: string;
  graphName: string | null;
  defaultBranch: string;
}

/** A resolved match between a dependency and a repo. */
interface ResolvedDependencyEdge {
  /** Package name from the manifest */
  packageName: string;
  /** Manifest file where the dependency was declared */
  manifestPath: string;
  /** Ecosystem (npm/cargo/go) */
  ecosystem: string;
  /** Version constraint from manifest */
  versionConstraint: string;
  /** Whether the dep is dev-only */
  isDev: boolean;
  /** The matched repo's ID */
  matchedRepoId: string;
  /** The matched repo's name or URL */
  matchedRepoIdentifier: string;
  /** Confidence of the match (0–1) */
  confidence: number;
  /** How the match was resolved */
  resolutionMethod: string;
}

export interface PkgMatchResult {
  edgesCreated: number;
  dependenciesFound: number;
  reposScanned: number;
  matchesFound: number;
}

// ─── Manifest Parsing ───────────────────────────────────────

/**
 * Extract dependencies from a package.json file.
 */
function parsePackageJson(
  content: string,
  manifestPath: string,
): PackageDependency[] {
  const deps: PackageDependency[] = [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    logger.warn({ manifestPath }, "Failed to parse package.json");
    return deps;
  }

  const addDeps = (
    section: unknown,
    isDev: boolean,
  ): void => {
    if (typeof section !== "object" || section === null) return;
    for (const [name, version] of Object.entries(
      section as Record<string, unknown>,
    )) {
      if (typeof version === "string") {
        deps.push({
          name,
          version,
          manifestPath,
          ecosystem: "npm",
          isDev,
        });
      }
    }
  };

  addDeps(parsed.dependencies, false);
  addDeps(parsed.devDependencies, true);
  addDeps(parsed.peerDependencies, false);
  addDeps(parsed.optionalDependencies, false);

  return deps;
}

/**
 * Extract dependencies from a Cargo.toml file.
 * Uses a simple line-based parser (no full TOML parser dependency).
 */
function parseCargoToml(
  content: string,
  manifestPath: string,
): PackageDependency[] {
  const deps: PackageDependency[] = [];
  const lines = content.split("\n");

  let currentSection = "";
  let isDev = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Track sections
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      isDev =
        currentSection === "dev-dependencies" ||
        currentSection === "build-dependencies";
      continue;
    }

    // Only process dependency sections
    if (
      currentSection !== "dependencies" &&
      currentSection !== "dev-dependencies" &&
      currentSection !== "build-dependencies"
    ) {
      continue;
    }

    // Simple dependency: name = "version"
    const simpleMatch = trimmed.match(
      /^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/,
    );
    if (simpleMatch) {
      deps.push({
        name: simpleMatch[1],
        version: simpleMatch[2],
        manifestPath,
        ecosystem: "cargo",
        isDev,
      });
      continue;
    }

    // Table dependency: name = { version = "...", ... }
    const tableMatch = trimmed.match(
      /^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/,
    );
    if (tableMatch) {
      deps.push({
        name: tableMatch[1],
        version: tableMatch[2],
        manifestPath,
        ecosystem: "cargo",
        isDev,
      });
      continue;
    }

    // Table dependency without version (path/git dep): name = { path = "...", ... }
    const pathMatch = trimmed.match(
      /^([a-zA-Z0-9_-]+)\s*=\s*\{.*(?:path|git)\s*=\s*"([^"]+)"/,
    );
    if (pathMatch) {
      deps.push({
        name: pathMatch[1],
        version: pathMatch[2],
        manifestPath,
        ecosystem: "cargo",
        isDev,
      });
    }
  }

  return deps;
}

/**
 * Extract dependencies from a go.mod file.
 */
function parseGoMod(
  content: string,
  manifestPath: string,
): PackageDependency[] {
  const deps: PackageDependency[] = [];
  const lines = content.split("\n");

  let inRequireBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Single-line require: require github.com/foo/bar v1.2.3
    const singleMatch = trimmed.match(
      /^require\s+(\S+)\s+(\S+)/,
    );
    if (singleMatch && !trimmed.includes("(")) {
      deps.push({
        name: singleMatch[1],
        version: singleMatch[2],
        manifestPath,
        ecosystem: "go",
        isDev: false,
      });
      continue;
    }

    // Block require
    if (trimmed === "require (") {
      inRequireBlock = true;
      continue;
    }

    if (inRequireBlock) {
      if (trimmed === ")") {
        inRequireBlock = false;
        continue;
      }

      // Module path + version inside require block
      const blockMatch = trimmed.match(/^(\S+)\s+(\S+)/);
      if (blockMatch) {
        deps.push({
          name: blockMatch[1],
          version: blockMatch[2],
          manifestPath,
          ecosystem: "go",
          isDev: false,
        });
      }
    }
  }

  return deps;
}

// ─── Manifest File Detection ────────────────────────────────

/** Manifest files we scan for. */
const MANIFEST_FILES = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
]);

/**
 * Check if a file path is a package manifest file.
 * Only matches root-level or workspace-level manifests.
 */
function isManifestFile(relativePath: string): boolean {
  const basename = path.basename(relativePath);
  return MANIFEST_FILES.has(basename);
}

// ─── Dependency-to-Repo Matching ────────────────────────────

/**
 * Extract the package/crate/module name from a repository.
 * This is what other repos would reference as a dependency.
 */
function extractRepoPackageNames(repo: RepoInfo): string[] {
  const names: string[] = [];

  // Use the repo name if set
  if (repo.name) {
    names.push(repo.name);
  }

  // Extract from URL: last path segment (common for git repos)
  // e.g., "https://github.com/org/my-lib" → "my-lib"
  // e.g., "/path/to/my-lib" → "my-lib"
  if (repo.url) {
    const urlPath = repo.url.replace(/\.git$/, "");
    const lastSegment = urlPath.split("/").filter(Boolean).pop();
    if (lastSegment && !names.includes(lastSegment)) {
      names.push(lastSegment);
    }

    // For GitHub/GitLab URLs, also include org/repo format
    // e.g., "github.com/org/repo" from "https://github.com/org/repo"
    const ghMatch = repo.url.match(
      /(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+\/[^/]+?)(?:\.git)?$/,
    );
    if (ghMatch && !names.includes(ghMatch[1])) {
      names.push(ghMatch[1]);
    }
  }

  return names;
}

/**
 * Match a dependency to a repo in the same project.
 * Returns the best match confidence and method, or null if no match.
 */
function matchDependencyToRepo(
  dep: PackageDependency,
  repo: RepoInfo,
  repoPackageNames: string[],
): { confidence: number; method: string } | null {
  const depNameLower = dep.name.toLowerCase();

  for (const repoName of repoPackageNames) {
    const repoNameLower = repoName.toLowerCase();

    // Exact name match
    if (depNameLower === repoNameLower) {
      return { confidence: 0.95, method: "exact_name" };
    }

    // For scoped npm packages: @scope/name matches repo named "name"
    if (dep.ecosystem === "npm" && depNameLower.startsWith("@")) {
      const unscoped = depNameLower.split("/").pop();
      if (unscoped === repoNameLower) {
        return { confidence: 0.85, method: "npm_unscoped_match" };
      }
    }

    // For Go modules: full module path contains repo name
    // e.g., dep "github.com/org/mylib" matches repo with URL "github.com/org/mylib"
    if (dep.ecosystem === "go") {
      if (depNameLower === repoNameLower) {
        return { confidence: 0.95, method: "exact_module_path" };
      }
      // Go dep name ends with repo name segment
      const depLastSegment = depNameLower.split("/").pop();
      if (depLastSegment === repoNameLower) {
        return { confidence: 0.80, method: "go_segment_match" };
      }
      // Go dep path contains the repo org/name
      if (repoName.includes("/") && depNameLower.includes(repoNameLower)) {
        return { confidence: 0.90, method: "go_path_contains" };
      }
    }

    // For Cargo crates: name with hyphens vs underscores are equivalent
    if (dep.ecosystem === "cargo") {
      const normalizedDep = depNameLower.replace(/-/g, "_");
      const normalizedRepo = repoNameLower.replace(/-/g, "_");
      if (normalizedDep === normalizedRepo) {
        return { confidence: 0.90, method: "cargo_normalized_name" };
      }
    }

    // Suffix match: dep name ends with repo name or vice versa
    // (handles cases like "my-org-mylib" matching repo "mylib")
    if (
      depNameLower.endsWith(repoNameLower) ||
      repoNameLower.endsWith(depNameLower)
    ) {
      if (depNameLower.length > 2 && repoNameLower.length > 2) {
        return { confidence: 0.70, method: "suffix_match" };
      }
    }
  }

  // Check if the dependency version points to a file/path/git URL
  // that matches the repo URL
  if (dep.version && repo.url) {
    const versionLower = dep.version.toLowerCase();
    const urlLower = repo.url.toLowerCase();

    // npm file: or link: dependencies
    if (
      dep.ecosystem === "npm" &&
      (dep.version.startsWith("file:") ||
        dep.version.startsWith("link:") ||
        dep.version.startsWith("git+") ||
        dep.version.startsWith("github:"))
    ) {
      const versionPath = dep.version
        .replace(/^(file:|link:|git\+|github:)/, "")
        .replace(/\.git$/, "");
      if (urlLower.includes(versionPath.toLowerCase())) {
        return { confidence: 0.90, method: "npm_path_version" };
      }
    }

    // Cargo path/git dependencies
    if (dep.ecosystem === "cargo" && urlLower.includes(versionLower.replace(/\.git$/, ""))) {
      return { confidence: 0.85, method: "cargo_path_dep" };
    }
  }

  return null;
}

// ─── Main Resolution Function ───────────────────────────────

/**
 * Resolve package/dependency references between a source repo and
 * all other repos in the same project. Scans package.json, Cargo.toml,
 * and go.mod files in the source repo, matches dependency names to
 * other project repos, and creates CROSS_REPO_DEPENDS edges.
 */
export async function resolvePackageDependencies(
  connectionId: string,
  sourceRepoId: string,
  targetRepoId: string,
  projectId: string,
): Promise<PkgMatchResult> {
  // Load source repo info
  const sourceRepo = await loadRepoInfo(sourceRepoId);
  if (!sourceRepo) {
    throw new Error("Source repository not found");
  }

  // Load all repos in the project (for matching targets)
  const projectRepos = await loadProjectRepos(projectId);
  // Build package name index for target repo
  const targetRepo = projectRepos.find((r) => r.id === targetRepoId);
  if (!targetRepo) {
    throw new Error("Target repository not found in project");
  }

  const targetPackageNames = extractRepoPackageNames(targetRepo);

  // Also read the target repo's own manifest to get its declared package name
  const targetManifestNames = await readRepoManifestPackageName(targetRepo);
  for (const n of targetManifestNames) {
    if (!targetPackageNames.includes(n)) {
      targetPackageNames.push(n);
    }
  }

  logger.info(
    {
      sourceRepoId,
      targetRepoId,
      targetPackageNames,
    },
    "Resolving package dependencies",
  );

  // Extract dependencies from source repo manifests
  const dependencies = await extractDependenciesFromRepo(sourceRepo);

  if (dependencies.length === 0) {
    logger.info({ sourceRepoId }, "No package dependencies found in source repo");
    return {
      edgesCreated: 0,
      dependenciesFound: 0,
      reposScanned: 1,
      matchesFound: 0,
    };
  }

  logger.info(
    { sourceRepoId, depCount: dependencies.length },
    "Extracted package dependencies",
  );

  // Match dependencies to the target repo
  const resolvedEdges: ResolvedDependencyEdge[] = [];
  const edgeSet = new Set<string>();

  for (const dep of dependencies) {
    const match = matchDependencyToRepo(dep, targetRepo, targetPackageNames);
    if (match) {
      const dedupKey = `${dep.manifestPath}:${dep.name}->${targetRepoId}`;
      if (!edgeSet.has(dedupKey)) {
        edgeSet.add(dedupKey);
        resolvedEdges.push({
          packageName: dep.name,
          manifestPath: dep.manifestPath,
          ecosystem: dep.ecosystem,
          versionConstraint: dep.version,
          isDev: dep.isDev,
          matchedRepoId: targetRepo.id,
          matchedRepoIdentifier: targetRepo.name ?? targetRepo.url,
          confidence: match.confidence,
          resolutionMethod: match.method,
        });
      }
    }
  }

  logger.info(
    {
      sourceRepoId,
      targetRepoId,
      matchCount: resolvedEdges.length,
    },
    "Package dependency matching complete",
  );

  // Delete previous CROSS_REPO_DEPENDS edges for this source→target pair
  await pool.query(
    `DELETE FROM cross_repo_edges
     WHERE project_id = $1
       AND source_repo_id = $2
       AND target_repo_id = $3
       AND edge_type = 'CROSS_REPO_DEPENDS'`,
    [projectId, sourceRepoId, targetRepoId],
  );

  // Insert new edges
  let edgesCreated = 0;

  for (const edge of resolvedEdges) {
    await pool.query(
      `INSERT INTO cross_repo_edges
         (project_id, source_repo_id, target_repo_id, source_node, target_node, edge_type, metadata)
       VALUES ($1, $2, $3, $4, $5, 'CROSS_REPO_DEPENDS', $6)`,
      [
        projectId,
        sourceRepoId,
        targetRepoId,
        `${edge.manifestPath}:${edge.packageName}`,
        `package:${edge.matchedRepoIdentifier}`,
        JSON.stringify({
          package_name: edge.packageName,
          manifest_path: edge.manifestPath,
          ecosystem: edge.ecosystem,
          version_constraint: edge.versionConstraint,
          is_dev: edge.isDev,
          confidence: edge.confidence,
          resolution_method: edge.resolutionMethod,
        }),
      ],
    );
    edgesCreated++;
  }

  logger.info(
    { connectionId, edgesCreated },
    "Cross-repo dependency edges created",
  );

  return {
    edgesCreated,
    dependenciesFound: dependencies.length,
    reposScanned: 1,
    matchesFound: resolvedEdges.length,
  };
}

// ─── Helper Functions ───────────────────────────────────────

async function loadRepoInfo(repoId: string): Promise<RepoInfo | null> {
  const result = await pool.query<RepoInfo>(
    `SELECT id, project_id AS "projectId", url, name, source_type AS "sourceType",
            graph_name AS "graphName", default_branch AS "defaultBranch"
     FROM repositories WHERE id = $1`,
    [repoId],
  );
  return result.rows[0] ?? null;
}

async function loadProjectRepos(projectId: string): Promise<RepoInfo[]> {
  const result = await pool.query<RepoInfo>(
    `SELECT id, project_id AS "projectId", url, name, source_type AS "sourceType",
            graph_name AS "graphName", default_branch AS "defaultBranch"
     FROM repositories WHERE project_id = $1`,
    [projectId],
  );
  return result.rows;
}

/**
 * Read manifest files from a repo's source to get its declared package name.
 * For npm: reads "name" from package.json.
 * For Cargo: reads [package] name from Cargo.toml.
 * For Go: reads module path from go.mod.
 */
async function readRepoManifestPackageName(
  repo: RepoInfo,
): Promise<string[]> {
  let extractResult: ExtractResult | null = null;
  const names: string[] = [];

  try {
    extractResult = await extractSource(
      repo.sourceType as "git_url" | "zip_upload" | "local_path",
      repo.url,
      { branch: repo.defaultBranch },
    );

    for (const file of extractResult.files) {
      const basename = path.basename(file.relativePath);
      // Only check root-level manifests for the package name
      const depth = file.relativePath.split("/").length;
      if (depth > 2) continue;

      if (basename === "package.json") {
        try {
          const content = await fsp.readFile(file.absolutePath, "utf-8");
          const parsed = JSON.parse(content) as Record<string, unknown>;
          if (typeof parsed.name === "string" && parsed.name) {
            names.push(parsed.name);
            // Also add unscoped name for @scope/name packages
            if (parsed.name.startsWith("@")) {
              const unscoped = parsed.name.split("/").pop();
              if (unscoped) names.push(unscoped);
            }
          }
        } catch {
          // Skip unparseable files
        }
      } else if (basename === "Cargo.toml") {
        try {
          const content = await fsp.readFile(file.absolutePath, "utf-8");
          const nameMatch = content.match(
            /\[package\][^[]*?name\s*=\s*"([^"]+)"/s,
          );
          if (nameMatch) {
            names.push(nameMatch[1]);
          }
        } catch {
          // Skip
        }
      } else if (basename === "go.mod") {
        try {
          const content = await fsp.readFile(file.absolutePath, "utf-8");
          const moduleMatch = content.match(/^module\s+(\S+)/m);
          if (moduleMatch) {
            names.push(moduleMatch[1]);
            // Also add the last segment
            const lastSeg = moduleMatch[1].split("/").pop();
            if (lastSeg && lastSeg !== moduleMatch[1]) {
              names.push(lastSeg);
            }
          }
        } catch {
          // Skip
        }
      }
    }
  } catch (err) {
    logger.warn(
      { repoId: repo.id, err },
      "Failed to read manifest from target repo",
    );
  } finally {
    if (extractResult?.isTempDir) {
      await cleanupTempDir(extractResult.rootDir);
    }
  }

  return names;
}

/**
 * Extract all dependencies from manifest files in a repo.
 */
async function extractDependenciesFromRepo(
  repo: RepoInfo,
): Promise<PackageDependency[]> {
  let extractResult: ExtractResult | null = null;

  try {
    extractResult = await extractSource(
      repo.sourceType as "git_url" | "zip_upload" | "local_path",
      repo.url,
      { branch: repo.defaultBranch },
    );

    const allDeps: PackageDependency[] = [];

    for (const file of extractResult.files) {
      if (!isManifestFile(file.relativePath)) continue;

      let content: string;
      try {
        content = await fsp.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const basename = path.basename(file.relativePath);

      if (basename === "package.json") {
        allDeps.push(...parsePackageJson(content, file.relativePath));
      } else if (basename === "Cargo.toml") {
        allDeps.push(...parseCargoToml(content, file.relativePath));
      } else if (basename === "go.mod") {
        allDeps.push(...parseGoMod(content, file.relativePath));
      }
    }

    return allDeps;
  } finally {
    if (extractResult?.isTempDir) {
      await cleanupTempDir(extractResult.rootDir);
    }
  }
}

async function extractSource(
  sourceType: "git_url" | "zip_upload" | "local_path",
  url: string,
  options: { branch?: string },
): Promise<ExtractResult> {
  // Import dynamically to avoid circular dependency issues
  const { extractSource: extract } = await import("./extract.js");
  return extract(sourceType, url, options);
}

// ─── Exported Parsers (for testing) ─────────────────────────

export { parsePackageJson, parseCargoToml, parseGoMod, matchDependencyToRepo, extractRepoPackageNames };
