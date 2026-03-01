import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("../db/connection.js", () => ({
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

vi.mock("./structure.js", () => ({
  detectLanguage: vi.fn((path: string) => {
    if (path.endsWith(".ts")) return "TypeScript";
    if (path.endsWith(".js")) return "JavaScript";
    return "Unknown";
  }),
}));

import { deleteFileContents } from "./content-store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deleteFileContents", () => {
  it("deletes from both tables", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await deleteFileContents("repo-1", ["src/a.ts", "src/b.ts"]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain("DELETE FROM file_contents");
    expect(mockQuery.mock.calls[1][0]).toContain("DELETE FROM indexed_files");
    expect(mockQuery.mock.calls[0][1]).toEqual(["repo-1", ["src/a.ts", "src/b.ts"]]);
  });

  it("does nothing for empty file list", async () => {
    await deleteFileContents("repo-1", []);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
