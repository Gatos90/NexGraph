import { describe, it, expect, vi } from "vitest";

// Mock DB, logger, and extract to prevent side effects
vi.mock("../db/connection.js", () => ({
  pool: { query: vi.fn() },
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("./extract.js", () => ({
  cleanupTempDir: vi.fn(),
}));

import {
  parsePackageJson,
  parseCargoToml,
  parseGoMod,
  matchDependencyToRepo,
  extractRepoPackageNames,
} from "./pkgmatch.js";
import type { PackageDependency } from "./pkgmatch.js";

// ─── parsePackageJson Tests ──────────────────────────────────

describe("parsePackageJson", () => {
  it("extracts runtime dependencies", () => {
    const content = JSON.stringify({
      dependencies: {
        express: "^4.18.0",
        lodash: "~4.17.0",
      },
    });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({
      name: "express",
      version: "^4.18.0",
      ecosystem: "npm",
      isDev: false,
    });
    expect(deps[1]).toMatchObject({
      name: "lodash",
      version: "~4.17.0",
      ecosystem: "npm",
      isDev: false,
    });
  });

  it("extracts devDependencies as isDev=true", () => {
    const content = JSON.stringify({
      devDependencies: {
        vitest: "^1.0.0",
      },
    });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      name: "vitest",
      isDev: true,
    });
  });

  it("extracts peerDependencies as isDev=false", () => {
    const content = JSON.stringify({
      peerDependencies: {
        react: "^18.0.0",
      },
    });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      name: "react",
      isDev: false,
    });
  });

  it("extracts optionalDependencies as isDev=false", () => {
    const content = JSON.stringify({
      optionalDependencies: {
        fsevents: "2.3.3",
      },
    });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ name: "fsevents", isDev: false });
  });

  it("extracts scoped packages", () => {
    const content = JSON.stringify({
      dependencies: {
        "@hono/zod-openapi": "^0.11.0",
      },
    });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("@hono/zod-openapi");
  });

  it("ignores non-string version values", () => {
    const content = JSON.stringify({
      dependencies: {
        valid: "^1.0.0",
        invalid: 123,
        alsoInvalid: null,
      },
    });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("valid");
  });

  it("returns empty array for malformed JSON", () => {
    const deps = parsePackageJson("{ invalid json", "package.json");
    expect(deps).toHaveLength(0);
  });

  it("returns empty array when no dependency sections exist", () => {
    const content = JSON.stringify({ name: "my-app", version: "1.0.0" });
    const deps = parsePackageJson(content, "package.json");
    expect(deps).toHaveLength(0);
  });

  it("uses the correct manifestPath", () => {
    const content = JSON.stringify({ dependencies: { foo: "1.0.0" } });
    const deps = parsePackageJson(content, "packages/ui/package.json");
    expect(deps[0].manifestPath).toBe("packages/ui/package.json");
  });
});

// ─── parseCargoToml Tests ────────────────────────────────────

describe("parseCargoToml", () => {
  it("extracts simple dependencies", () => {
    const content = `
[dependencies]
serde = "1.0"
tokio = "1.28"
`;
    const deps = parseCargoToml(content, "Cargo.toml");
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({
      name: "serde",
      version: "1.0",
      ecosystem: "cargo",
      isDev: false,
    });
    expect(deps[1]).toMatchObject({
      name: "tokio",
      version: "1.28",
      ecosystem: "cargo",
      isDev: false,
    });
  });

  it("extracts table dependencies with version", () => {
    const content = `
[dependencies]
serde = { version = "1.0", features = ["derive"] }
`;
    const deps = parseCargoToml(content, "Cargo.toml");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      name: "serde",
      version: "1.0",
    });
  });

  it("extracts path/git dependencies", () => {
    const content = `
[dependencies]
my-lib = { path = "../my-lib" }
other = { git = "https://github.com/org/other.git" }
`;
    const deps = parseCargoToml(content, "Cargo.toml");
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({
      name: "my-lib",
      version: "../my-lib",
    });
    expect(deps[1]).toMatchObject({
      name: "other",
      version: "https://github.com/org/other.git",
    });
  });

  it("marks dev-dependencies as isDev=true", () => {
    const content = `
[dev-dependencies]
assert_cmd = "2.0"
`;
    const deps = parseCargoToml(content, "Cargo.toml");
    expect(deps).toHaveLength(1);
    expect(deps[0].isDev).toBe(true);
  });

  it("marks build-dependencies as isDev=true", () => {
    const content = `
[build-dependencies]
cc = "1.0"
`;
    const deps = parseCargoToml(content, "Cargo.toml");
    expect(deps).toHaveLength(1);
    expect(deps[0].isDev).toBe(true);
  });

  it("ignores non-dependency sections", () => {
    const content = `
[package]
name = "my-app"
version = "0.1.0"

[dependencies]
serde = "1.0"

[profile.release]
opt-level = 3
`;
    const deps = parseCargoToml(content, "Cargo.toml");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("serde");
  });
});

// ─── parseGoMod Tests ────────────────────────────────────────

describe("parseGoMod", () => {
  it("extracts single-line require statements", () => {
    const content = `
module github.com/my-org/my-app

go 1.21

require github.com/gin-gonic/gin v1.9.1
`;
    const deps = parseGoMod(content, "go.mod");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      name: "github.com/gin-gonic/gin",
      version: "v1.9.1",
      ecosystem: "go",
      isDev: false,
    });
  });

  it("extracts block require statements", () => {
    const content = `
module github.com/my-org/my-app

go 1.21

require (
\tgithub.com/gin-gonic/gin v1.9.1
\tgithub.com/stretchr/testify v1.8.4
)
`;
    const deps = parseGoMod(content, "go.mod");
    expect(deps).toHaveLength(2);
    expect(deps[0]).toMatchObject({
      name: "github.com/gin-gonic/gin",
      version: "v1.9.1",
    });
    expect(deps[1]).toMatchObject({
      name: "github.com/stretchr/testify",
      version: "v1.8.4",
    });
  });

  it("handles mixed single and block requires", () => {
    const content = `
module example.com/app

require github.com/single/dep v1.0.0

require (
\tgithub.com/block/dep1 v2.0.0
\tgithub.com/block/dep2 v3.0.0
)
`;
    const deps = parseGoMod(content, "go.mod");
    expect(deps).toHaveLength(3);
  });

  it("marks all Go deps as isDev=false", () => {
    const content = `
module example.com/app

require (
\tgithub.com/foo/bar v1.0.0
)
`;
    const deps = parseGoMod(content, "go.mod");
    expect(deps.every((d) => !d.isDev)).toBe(true);
  });

  it("returns empty for no require statements", () => {
    const content = `
module example.com/app

go 1.21
`;
    const deps = parseGoMod(content, "go.mod");
    expect(deps).toHaveLength(0);
  });
});

// ─── extractRepoPackageNames Tests ───────────────────────────

describe("extractRepoPackageNames", () => {
  function makeRepo(overrides: Partial<{
    id: string;
    projectId: string;
    url: string;
    name: string | null;
    sourceType: string;
    graphName: string | null;
    defaultBranch: string;
  }> = {}) {
    return {
      id: "repo-1",
      projectId: "proj-1",
      url: "https://github.com/org/my-lib.git",
      name: null,
      sourceType: "git_url",
      graphName: null,
      defaultBranch: "main",
      ...overrides,
    };
  }

  it("includes repo name when set", () => {
    const names = extractRepoPackageNames(makeRepo({ name: "my-lib" }));
    expect(names).toContain("my-lib");
  });

  it("extracts last segment from URL (strips .git)", () => {
    const names = extractRepoPackageNames(makeRepo({ url: "https://github.com/org/my-lib.git" }));
    expect(names).toContain("my-lib");
  });

  it("extracts org/repo format from GitHub URLs", () => {
    const names = extractRepoPackageNames(makeRepo({ url: "https://github.com/org/my-lib.git" }));
    expect(names).toContain("org/my-lib");
  });

  it("extracts from GitLab URLs too", () => {
    const names = extractRepoPackageNames(makeRepo({ url: "https://gitlab.com/team/service.git" }));
    expect(names).toContain("team/service");
  });

  it("extracts from local paths", () => {
    const names = extractRepoPackageNames(makeRepo({ url: "/path/to/my-lib", name: null }));
    expect(names).toContain("my-lib");
  });

  it("deduplicates when name matches URL segment", () => {
    const names = extractRepoPackageNames(
      makeRepo({ url: "https://github.com/org/my-lib.git", name: "my-lib" }),
    );
    const count = names.filter((n) => n === "my-lib").length;
    expect(count).toBe(1);
  });
});

// ─── matchDependencyToRepo Tests ─────────────────────────────

describe("matchDependencyToRepo", () => {
  function makeDep(overrides: Partial<PackageDependency> = {}): PackageDependency {
    return {
      name: "my-lib",
      version: "^1.0.0",
      manifestPath: "package.json",
      ecosystem: "npm",
      isDev: false,
      ...overrides,
    };
  }

  function makeRepo(overrides: Partial<{
    id: string;
    projectId: string;
    url: string;
    name: string | null;
    sourceType: string;
    graphName: string | null;
    defaultBranch: string;
  }> = {}) {
    return {
      id: "repo-1",
      projectId: "proj-1",
      url: "https://github.com/org/my-lib.git",
      name: "my-lib",
      sourceType: "git_url",
      graphName: null,
      defaultBranch: "main",
      ...overrides,
    };
  }

  describe("exact name match", () => {
    it("returns 0.95 for exact name match", () => {
      const dep = makeDep({ name: "my-lib" });
      const repo = makeRepo({ name: "my-lib" });
      const result = matchDependencyToRepo(dep, repo, ["my-lib"]);
      expect(result).toEqual({ confidence: 0.95, method: "exact_name" });
    });

    it("is case-insensitive", () => {
      const dep = makeDep({ name: "My-Lib" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my-lib"]);
      expect(result).toEqual({ confidence: 0.95, method: "exact_name" });
    });
  });

  describe("npm scoped package matching", () => {
    it("matches @scope/name to repo named 'name' with confidence 0.85", () => {
      const dep = makeDep({ name: "@myorg/my-lib", ecosystem: "npm" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my-lib"]);
      expect(result).toEqual({ confidence: 0.85, method: "npm_unscoped_match" });
    });

    it("does not match for non-npm ecosystem", () => {
      const dep = makeDep({ name: "@myorg/my-lib", ecosystem: "cargo" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["other-lib"]);
      expect(result).toBeNull();
    });
  });

  describe("Go module matching", () => {
    it("matches exact Go module path with 0.95 (via exact_name)", () => {
      // exact_name check fires first since dep name equals a repoPackageName
      const dep = makeDep({ name: "github.com/org/my-lib", ecosystem: "go" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["github.com/org/my-lib"]);
      expect(result).toEqual({ confidence: 0.95, method: "exact_name" });
    });

    it("matches Go dep last segment to repo name with 0.80", () => {
      const dep = makeDep({ name: "github.com/org/my-lib", ecosystem: "go" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my-lib"]);
      expect(result).toEqual({ confidence: 0.80, method: "go_segment_match" });
    });

    it("matches Go dep path containing org/repo with 0.90", () => {
      const dep = makeDep({ name: "github.com/org/my-lib/v2", ecosystem: "go" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["org/my-lib"]);
      expect(result).toEqual({ confidence: 0.90, method: "go_path_contains" });
    });
  });

  describe("Cargo crate matching", () => {
    it("normalizes hyphens to underscores for matching with 0.90", () => {
      const dep = makeDep({ name: "my-lib", ecosystem: "cargo" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my_lib"]);
      expect(result).toEqual({ confidence: 0.90, method: "cargo_normalized_name" });
    });
  });

  describe("suffix match", () => {
    it("matches when dep name ends with repo name with 0.70", () => {
      const dep = makeDep({ name: "org-my-lib" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my-lib"]);
      // "org-my-lib" ends with "my-lib"
      expect(result).toEqual({ confidence: 0.70, method: "suffix_match" });
    });

    it("matches when repo name ends with dep name", () => {
      const dep = makeDep({ name: "lib" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my-lib"]);
      // "my-lib" ends with "lib" and both > 2 chars
      expect(result).toEqual({ confidence: 0.70, method: "suffix_match" });
    });

    it("does not match very short names (≤2 chars)", () => {
      const dep = makeDep({ name: "ab" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["ab-extended"]);
      expect(result).toBeNull();
    });
  });

  describe("npm path/git version matching", () => {
    it("matches file: dependency pointing to repo URL with 0.90", () => {
      // After stripping "file:", the version path must be a substring of repo URL
      const dep = makeDep({
        name: "some-name",
        version: "file:my-lib",
        ecosystem: "npm",
      });
      const repo = makeRepo({ url: "/workspace/my-lib" });
      const result = matchDependencyToRepo(dep, repo, ["unrelated"]);
      expect(result).toEqual({ confidence: 0.90, method: "npm_path_version" });
    });

    it("matches git+ dependency pointing to repo URL with 0.90", () => {
      const dep = makeDep({
        name: "some-name",
        version: "git+https://github.com/org/my-lib.git",
        ecosystem: "npm",
      });
      const repo = makeRepo({ url: "https://github.com/org/my-lib.git" });
      const result = matchDependencyToRepo(dep, repo, ["unrelated"]);
      expect(result).toEqual({ confidence: 0.90, method: "npm_path_version" });
    });

    it("matches github: shorthand", () => {
      const dep = makeDep({
        name: "some-name",
        version: "github:org/my-lib",
        ecosystem: "npm",
      });
      const repo = makeRepo({ url: "https://github.com/org/my-lib.git" });
      const result = matchDependencyToRepo(dep, repo, ["unrelated"]);
      expect(result).toEqual({ confidence: 0.90, method: "npm_path_version" });
    });
  });

  describe("Cargo path/git dependency matching", () => {
    it("matches Cargo path dep pointing to repo URL with 0.85", () => {
      // The version string must be a substring of repo URL (after .git strip)
      const dep = makeDep({
        name: "some-crate",
        version: "my-lib",
        ecosystem: "cargo",
      });
      const repo = makeRepo({ url: "/workspace/my-lib" });
      const result = matchDependencyToRepo(dep, repo, ["unrelated"]);
      expect(result).toEqual({ confidence: 0.85, method: "cargo_path_dep" });
    });
  });

  describe("no match", () => {
    it("returns null when nothing matches", () => {
      const dep = makeDep({ name: "totally-different", ecosystem: "npm" });
      const result = matchDependencyToRepo(dep, makeRepo(), ["my-lib", "org/my-lib"]);
      expect(result).toBeNull();
    });
  });
});
