import { describe, it, expect, vi } from "vitest";

// Mock external dependencies
const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  pool: { query: mockQuery },
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("simple-git", () => ({
  simpleGit: vi.fn(),
}));

// ─── Reproduce parseGitLog for unit testing ──────────────────

const MAX_COMMITS_PER_FILE = 20;

interface GitFileCommit {
  filePath: string;
  commitSha: string;
  authorName: string;
  authorEmail: string;
  commitDate: string;
  commitMessage: string;
  changeType: string;
}

function parseGitLog(output: string, knownFiles: string[]): GitFileCommit[] {
  const knownSet = new Set(knownFiles);
  const fileCommitCounts = new Map<string, number>();
  const results: GitFileCommit[] = [];

  const lines = output.split("\n");
  let currentCommit: {
    sha: string;
    author: string;
    email: string;
    date: string;
    message: string;
  } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const commitMatch = trimmed.match(/^([0-9a-f]{40})\|(.+?)\|(.+?)\|(.+?)\|(.*)$/);
    if (commitMatch) {
      currentCommit = {
        sha: commitMatch[1],
        author: commitMatch[2],
        email: commitMatch[3],
        date: commitMatch[4],
        message: commitMatch[5],
      };
      continue;
    }

    const statusMatch = trimmed.match(/^([ADMR])\d*\t(.+?)(?:\t(.+))?$/);
    if (statusMatch && currentCommit) {
      const changeType = statusMatch[1];
      const filePath = statusMatch[3] || statusMatch[2];

      if (!knownSet.has(filePath)) continue;

      const count = fileCommitCounts.get(filePath) || 0;
      if (count >= MAX_COMMITS_PER_FILE) continue;
      fileCommitCounts.set(filePath, count + 1);

      results.push({
        filePath,
        commitSha: currentCommit.sha,
        authorName: currentCommit.author,
        authorEmail: currentCommit.email,
        commitDate: currentCommit.date,
        commitMessage: currentCommit.message,
        changeType,
      });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════

describe("parseGitLog", () => {
  it("parses a single commit with file changes", () => {
    const output = [
      "abc123456789012345678901234567890123abcd|John Doe|john@example.com|2024-01-15T10:30:00+00:00|Initial commit",
      "A\tsrc/index.ts",
      "A\tsrc/app.ts",
    ].join("\n");

    const knownFiles = ["src/index.ts", "src/app.ts"];
    const result = parseGitLog(output, knownFiles);

    expect(result).toHaveLength(2);
    expect(result[0].filePath).toBe("src/index.ts");
    expect(result[0].authorName).toBe("John Doe");
    expect(result[0].authorEmail).toBe("john@example.com");
    expect(result[0].changeType).toBe("A");
    expect(result[0].commitSha).toBe("abc123456789012345678901234567890123abcd");
  });

  it("handles multiple commits", () => {
    const output = [
      "aaaa23456789012345678901234567890123aaaa|Alice|alice@ex.com|2024-01-01|First",
      "M\tsrc/a.ts",
      "bbbb23456789012345678901234567890123bbbb|Bob|bob@ex.com|2024-01-02|Second",
      "M\tsrc/a.ts",
    ].join("\n");

    const knownFiles = ["src/a.ts"];
    const result = parseGitLog(output, knownFiles);

    expect(result).toHaveLength(2);
    expect(result[0].authorName).toBe("Alice");
    expect(result[1].authorName).toBe("Bob");
  });

  it("filters out unknown files", () => {
    const output = [
      "aaaa23456789012345678901234567890123aaaa|Alice|a@a.com|2024-01-01|msg",
      "M\tsrc/known.ts",
      "M\tsrc/unknown.ts",
    ].join("\n");

    const knownFiles = ["src/known.ts"];
    const result = parseGitLog(output, knownFiles);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/known.ts");
  });

  it("handles rename status (R) using new path", () => {
    const output = [
      "aaaa23456789012345678901234567890123aaaa|Alice|a@a.com|2024-01-01|rename",
      "R100\told/path.ts\tnew/path.ts",
    ].join("\n");

    const knownFiles = ["new/path.ts"];
    const result = parseGitLog(output, knownFiles);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("new/path.ts");
    expect(result[0].changeType).toBe("R");
  });

  it("limits commits per file to MAX_COMMITS_PER_FILE", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const sha = `a${i.toString().padStart(39, "0")}`;
      lines.push(`${sha}|Author|e@e.com|2024-01-${(i + 1).toString().padStart(2, "0")}|msg ${i}`);
      lines.push(`M\tsrc/file.ts`);
    }

    const result = parseGitLog(lines.join("\n"), ["src/file.ts"]);
    expect(result).toHaveLength(MAX_COMMITS_PER_FILE);
  });

  it("returns empty for empty input", () => {
    expect(parseGitLog("", ["src/a.ts"])).toEqual([]);
  });

  it("ignores lines before any commit header", () => {
    const output = [
      "M\torphan-line.ts",
      "aaaa23456789012345678901234567890123aaaa|Alice|a@a.com|2024-01-01|msg",
      "M\tsrc/real.ts",
    ].join("\n");

    const result = parseGitLog(output, ["orphan-line.ts", "src/real.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/real.ts");
  });
});

// ─── Integration: getGitHistoryForRepo / getGitTimelineForRepo ─

import { getGitHistoryForRepo, getGitTimelineForRepo } from "./git-history.js";

describe("getGitHistoryForRepo", () => {
  it("returns structured history data", async () => {
    // file query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        file_path: "src/index.ts",
        last_author: "Alice",
        last_email: "alice@ex.com",
        last_date: "2024-01-15",
        commit_count: "5",
      }],
    });
    // recent commits query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        file_path: "src/index.ts",
        commit_sha: "abc123",
        author_name: "Alice",
        author_email: "alice@ex.com",
        commit_date: "2024-01-15",
        commit_message: "fix bug",
      }],
    });
    // author stats query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        author_name: "Alice",
        author_email: "alice@ex.com",
        file_count: "10",
        commit_count: "20",
      }],
    });
    // timeline query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        day: "2024-01-15",
        commits: "3",
        files_changed: "5",
      }],
    });
    // total query
    mockQuery.mockResolvedValueOnce({
      rows: [{ cnt: "20" }],
    });

    const result = await getGitHistoryForRepo("repo-1");

    expect(result.files).toHaveLength(1);
    expect(result.files[0].file_path).toBe("src/index.ts");
    expect(result.files[0].commit_count).toBe(5);
    expect(result.authors).toHaveLength(1);
    expect(result.authors[0].name).toBe("Alice");
    expect(result.timeline).toHaveLength(1);
    expect(result.total_commits).toBe(20);
  });
});

describe("getGitTimelineForRepo", () => {
  it("returns commits grouped with files", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        commit_sha: "abc123",
        author_name: "Alice",
        author_email: "alice@ex.com",
        commit_date: "2024-01-15",
        commit_message: "add feature",
        files: [{ path: "src/a.ts", change: "M" }],
      }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ cnt: "5" }],
    });

    const result = await getGitTimelineForRepo("repo-1");

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].sha).toBe("abc123");
    expect(result.commits[0].files).toHaveLength(1);
    expect(result.total_files).toBe(5);
  });
});
