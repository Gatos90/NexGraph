import { pool } from "../db/connection.js";
import { cypher } from "../db/age.js";
import type { AgeVertex } from "../db/age.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("typematch");

// ─── Types ──────────────────────────────────────────────────

/** A type definition extracted from a repo graph. */
interface TypeDef {
  /** AGE vertex id */
  vertexId: number;
  /** Symbol name (e.g., "UserProfile") */
  name: string;
  /** Graph node label: Class, Interface, or CodeElement */
  label: string;
  /** element_type for CodeElement nodes (e.g., "struct", "dataclass", "enum") */
  elementType: string;
  /** Signature text from the parser */
  signature: string;
  /** Whether the symbol is exported */
  exported: boolean;
  /** File path where defined */
  filePath: string;
  /** Names of methods/fields belonging to this type */
  members: string[];
}

interface RepoRow {
  id: string;
  project_id: string;
  graph_name: string;
}

export interface TypeMatchResult {
  edgesCreated: number;
  sourceTypesLoaded: number;
  targetTypesLoaded: number;
  matchesFound: number;
}

interface MatchedPair {
  sourceNode: string;
  targetNode: string;
  sourceName: string;
  targetName: string;
  confidence: number;
  resolutionMethod: string;
  sourceLabel: string;
  targetLabel: string;
}

// ─── Type-bearing node labels and element types ─────────────

/** Graph labels that represent type definitions. */
const TYPE_LABELS = ["Class", "Interface", "CodeElement", "Struct", "Enum", "Trait", "TypeAlias", "Namespace"] as const;

/** CodeElement subtypes that represent type/struct definitions. */
const TYPE_ELEMENT_TYPES = new Set([
  "struct",
  "dataclass",
  "enum",
  "type_alias",
  "record",
  "annotation_type",
  "trait",
]);

// ─── Name Normalization ─────────────────────────────────────

/**
 * Normalize a type name for comparison:
 * - Strip common prefixes/suffixes: I-prefix for interfaces, -Impl suffix
 * - Convert to lowercase for case-insensitive matching
 */
function normalizeName(name: string): string {
  let n = name;
  // Strip leading "I" prefix common in C#/TypeScript interfaces (e.g., IUserProfile → UserProfile)
  // Only strip if next char is uppercase (to avoid stripping from names like "Item")
  if (n.length > 1 && n[0] === "I" && n[1] >= "A" && n[1] <= "Z") {
    n = n.slice(1);
  }
  // Strip -Impl suffix (e.g., UserServiceImpl → UserService)
  if (n.endsWith("Impl")) {
    n = n.slice(0, -4);
  }
  return n.toLowerCase();
}

/**
 * Convert a name to a set of tokens by splitting on camelCase/PascalCase/snake_case boundaries.
 */
function tokenize(name: string): Set<string> {
  // Split on camelCase/PascalCase boundaries and underscores
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean);
  return new Set(parts);
}

// ─── Similarity Scoring ─────────────────────────────────────

/**
 * Compute Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if two types are cross-language equivalents
 * (e.g., TS interface ↔ Python dataclass ↔ Go struct ↔ Java class).
 */
function areTypeEquivalents(a: TypeDef, b: TypeDef): boolean {
  // All these represent "type definitions" across languages
  const typeKinds = new Set(["Class", "Interface"]);
  const structKinds = new Set(["struct", "dataclass", "record"]);

  const aIsType = typeKinds.has(a.label) || structKinds.has(a.elementType);
  const bIsType = typeKinds.has(b.label) || structKinds.has(b.elementType);

  return aIsType && bIsType;
}

// ─── Matching Logic ─────────────────────────────────────────

/**
 * Score how well two type definitions match.
 * Returns null if no match, or a confidence score (0–1) with method.
 */
function scoreTypeMatch(
  source: TypeDef,
  target: TypeDef,
): { confidence: number; method: string } | null {
  const srcNorm = normalizeName(source.name);
  const tgtNorm = normalizeName(target.name);

  // Tier 1: Exact name match (after normalization)
  if (srcNorm === tgtNorm && srcNorm.length > 0) {
    // Both exported: highest confidence
    if (source.exported && target.exported) {
      // Cross-language type equivalents get a small boost
      if (areTypeEquivalents(source, target)) {
        return { confidence: 0.95, method: "exact_name_exported" };
      }
      return { confidence: 0.90, method: "exact_name_exported" };
    }
    // At least one is not exported — still a match but lower confidence
    return { confidence: 0.80, method: "exact_name" };
  }

  // Only consider further matching for exported types
  if (!source.exported || !target.exported) return null;

  // Must be type-equivalent kinds for structural matching
  if (!areTypeEquivalents(source, target)) return null;

  // Tier 2: Token-based name similarity
  const srcTokens = tokenize(source.name);
  const tgtTokens = tokenize(target.name);
  const nameSim = jaccardSimilarity(srcTokens, tgtTokens);

  // Tier 3: Structural similarity — compare member names
  let memberSim = 0;
  if (source.members.length > 0 && target.members.length > 0) {
    const srcMembers = new Set(source.members.map((m) => m.toLowerCase()));
    const tgtMembers = new Set(target.members.map((m) => m.toLowerCase()));
    memberSim = jaccardSimilarity(srcMembers, tgtMembers);
  }

  // Combined scoring: name similarity + structural similarity
  if (nameSim >= 0.6 && memberSim >= 0.5) {
    // Strong name + structural match
    const combined = nameSim * 0.4 + memberSim * 0.6;
    return { confidence: Math.min(0.85, 0.50 + combined * 0.35), method: "name_and_structure" };
  }

  if (nameSim >= 0.6) {
    // Good name match, no/weak structural data
    return { confidence: Math.min(0.75, 0.50 + nameSim * 0.25), method: "token_name" };
  }

  if (memberSim >= 0.7 && srcTokens.size > 0 && tgtTokens.size > 0) {
    // Strong structural match with some name overlap
    const hasNameOverlap = jaccardSimilarity(srcTokens, tgtTokens) > 0.2;
    if (hasNameOverlap) {
      return { confidence: Math.min(0.70, 0.45 + memberSim * 0.25), method: "structure_with_name_hint" };
    }
  }

  return null;
}

// ─── Graph Loading ──────────────────────────────────────────

/**
 * Load type definitions from a repo's graph.
 * Queries for Class, Interface, and CodeElement nodes,
 * then loads their member names (methods/fields via DEFINES or class_name).
 */
async function loadTypeDefs(graphName: string): Promise<TypeDef[]> {
  const types: TypeDef[] = [];

  for (const label of TYPE_LABELS) {
    try {
      const rows = await cypher<{ f: AgeVertex; n: AgeVertex }>(
        graphName,
        `MATCH (f:File)-[:DEFINES]->(n:${label}) RETURN f, n`,
        undefined,
        [{ name: "f" }, { name: "n" }],
      );

      for (const row of rows) {
        const props = row.n.properties;
        const elementType = typeof props.element_type === "string" ? props.element_type : "";

        // For CodeElement, only include type-bearing subtypes
        if (label === "CodeElement" && !TYPE_ELEMENT_TYPES.has(elementType)) {
          continue;
        }

        types.push({
          vertexId: row.n.id,
          name: typeof props.name === "string" ? props.name : "",
          label,
          elementType,
          signature: typeof props.signature === "string" ? props.signature : "",
          exported: props.exported === true,
          filePath: typeof row.f.properties.path === "string" ? row.f.properties.path : "",
          members: [], // filled below
        });
      }
    } catch {
      // Label may not exist in this graph
    }
  }

  // Load members for classes and interfaces
  // Methods have a class_name property linking them to their parent
  if (types.length > 0) {
    await loadMembers(graphName, types);
  }

  return types;
}

/**
 * Load method/field names belonging to each type definition.
 * Uses the class_name property on Method nodes and DEFINES edges for nested elements.
 */
async function loadMembers(graphName: string, types: TypeDef[]): Promise<void> {
  const typeByName = new Map<string, TypeDef[]>();
  for (const t of types) {
    const existing = typeByName.get(t.name) ?? [];
    existing.push(t);
    typeByName.set(t.name, existing);
  }

  // Load Method nodes that have class_name set
  try {
    const methodRows = await cypher<{ m: AgeVertex }>(
      graphName,
      "MATCH (m:Method) WHERE m.class_name <> '' RETURN m",
      undefined,
      [{ name: "m" }],
    );

    for (const row of methodRows) {
      const className = typeof row.m.properties.class_name === "string"
        ? row.m.properties.class_name
        : "";
      const methodName = typeof row.m.properties.name === "string"
        ? row.m.properties.name
        : "";

      if (className && methodName) {
        const parents = typeByName.get(className);
        if (parents) {
          for (const parent of parents) {
            parent.members.push(methodName);
          }
        }
      }
    }
  } catch {
    // Method label may not exist
  }

  // Also extract member names from signatures for interfaces/structs
  // (interfaces may not have Method nodes, but the signature contains field info)
  for (const t of types) {
    if (t.members.length === 0 && t.signature) {
      const extracted = extractMembersFromSignature(t.signature);
      t.members.push(...extracted);
    }
  }
}

/**
 * Extract member/field names from a type signature string.
 * Handles patterns like:
 *   interface Foo { bar: string; baz: number }
 *   struct Foo { bar string; baz int }
 *   class Foo(bar: str, baz: int)  (Python dataclass)
 */
function extractMembersFromSignature(signature: string): string[] {
  const members: string[] = [];
  const seen = new Set<string>();

  // Match identifier followed by colon or space+type (common in TS/Go/Rust/Python)
  const patterns = [
    /(?:^|[{;,\n])\s*(\w+)\s*:/g,           // TS/Python: name: type
    /(?:^|[{;,\n])\s*(\w+)\s+\w+/g,          // Go/Rust: name Type
    /\(([^)]*)\)/g,                           // Python dataclass params
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(signature)) !== null) {
      const name = match[1]?.trim();
      if (name && name.length > 1 && !seen.has(name) && !/^(return|const|let|var|type|interface|class|struct|enum|pub|fn|func|def)$/i.test(name)) {
        seen.add(name);
        members.push(name);
      }
    }
  }

  return members;
}

// ─── Main Resolution Function ───────────────────────────────

/**
 * Resolve type/interface matches between two repositories.
 * Loads type definitions from both repo graphs, computes matches
 * based on name similarity and structural compatibility, and creates
 * CROSS_REPO_MIRRORS edges in the cross_repo_edges table.
 */
export async function resolveTypeMatching(
  connectionId: string,
  sourceRepoId: string,
  targetRepoId: string,
  projectId: string,
): Promise<TypeMatchResult> {
  // Load repo info
  const [sourceRepo, targetRepo] = await Promise.all([
    loadRepoInfo(sourceRepoId),
    loadRepoInfo(targetRepoId),
  ]);

  if (!sourceRepo || !targetRepo) {
    throw new Error("Source or target repository not found");
  }

  if (!sourceRepo.graph_name || !targetRepo.graph_name) {
    throw new Error(
      "Source or target repository has not been indexed (no graph)",
    );
  }

  // Step 1: Load type definitions from both repos
  logger.info(
    { sourceRepoId, targetRepoId },
    "Loading type definitions from both repos",
  );

  const [sourceTypes, targetTypes] = await Promise.all([
    loadTypeDefs(sourceRepo.graph_name),
    loadTypeDefs(targetRepo.graph_name),
  ]);

  logger.info(
    {
      sourceRepoId,
      sourceTypes: sourceTypes.length,
      targetRepoId,
      targetTypes: targetTypes.length,
    },
    "Type definitions loaded",
  );

  if (sourceTypes.length === 0 || targetTypes.length === 0) {
    return {
      edgesCreated: 0,
      sourceTypesLoaded: sourceTypes.length,
      targetTypesLoaded: targetTypes.length,
      matchesFound: 0,
    };
  }

  // Step 2: Match types across repos
  const matches: MatchedPair[] = [];
  const usedTargets = new Set<number>(); // Prevent duplicate target matches

  // Sort source types: exported first, then by name length (longer = more specific)
  const sortedSources = [...sourceTypes].sort((a, b) => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    return b.name.length - a.name.length;
  });

  for (const src of sortedSources) {
    let bestMatch: { target: TypeDef; confidence: number; method: string } | null = null;

    for (const tgt of targetTypes) {
      // Skip already-matched targets
      if (usedTargets.has(tgt.vertexId)) continue;

      const result = scoreTypeMatch(src, tgt);
      if (result && (!bestMatch || result.confidence > bestMatch.confidence)) {
        bestMatch = { target: tgt, ...result };
      }
    }

    if (bestMatch) {
      usedTargets.add(bestMatch.target.vertexId);
      matches.push({
        sourceNode: `${src.label}:${src.name}:${src.filePath}`,
        targetNode: `${bestMatch.target.label}:${bestMatch.target.name}:${bestMatch.target.filePath}`,
        sourceName: src.name,
        targetName: bestMatch.target.name,
        confidence: bestMatch.confidence,
        resolutionMethod: bestMatch.method,
        sourceLabel: src.label,
        targetLabel: bestMatch.target.label,
      });
    }
  }

  logger.info(
    { sourceRepoId, targetRepoId, matchCount: matches.length },
    "Type matching complete",
  );

  // Step 3: Delete previous resolved edges for this connection
  await pool.query(
    `DELETE FROM cross_repo_edges
     WHERE project_id = $1
       AND source_repo_id = $2
       AND target_repo_id = $3
       AND edge_type = 'CROSS_REPO_MIRRORS'`,
    [projectId, sourceRepoId, targetRepoId],
  );

  // Step 4: Insert new edges
  let edgesCreated = 0;

  for (const match of matches) {
    await pool.query(
      `INSERT INTO cross_repo_edges
         (project_id, source_repo_id, target_repo_id, source_node, target_node, edge_type, metadata)
       VALUES ($1, $2, $3, $4, $5, 'CROSS_REPO_MIRRORS', $6)`,
      [
        projectId,
        sourceRepoId,
        targetRepoId,
        match.sourceNode,
        match.targetNode,
        JSON.stringify({
          source_name: match.sourceName,
          target_name: match.targetName,
          confidence: match.confidence,
          resolution_method: match.resolutionMethod,
          source_label: match.sourceLabel,
          target_label: match.targetLabel,
        }),
      ],
    );
    edgesCreated++;
  }

  logger.info(
    { connectionId, edgesCreated },
    "Cross-repo mirror edges created",
  );

  return {
    edgesCreated,
    sourceTypesLoaded: sourceTypes.length,
    targetTypesLoaded: targetTypes.length,
    matchesFound: matches.length,
  };
}

// ─── Helpers ────────────────────────────────────────────────

async function loadRepoInfo(repoId: string): Promise<RepoRow | null> {
  const result = await pool.query<RepoRow>(
    "SELECT id, project_id, graph_name FROM repositories WHERE id = $1",
    [repoId],
  );
  return result.rows[0] ?? null;
}
