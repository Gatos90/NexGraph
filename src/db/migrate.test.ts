import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockClientQuery = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease }),
);

vi.mock("./connection.js", () => ({
  pool: { query: mockPoolQuery, connect: mockConnect },
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: mockReaddir,
    readFile: mockReadFile,
  },
}));

import { runMigrations } from "./migrate.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
});

describe("runMigrations", () => {
  it("creates migrations table and skips when no pending migrations", async () => {
    // ensureMigrationsTable
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // getAppliedMigrations
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ filename: "001_init.sql" }, { filename: "002_data.sql" }],
    });
    // getMigrationFiles
    mockReaddir.mockResolvedValueOnce(["001_init.sql", "002_data.sql"]);

    await runMigrations();

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    expect(mockConnect).not.toHaveBeenCalled(); // no migrations to run
  });

  it("runs pending migrations in transaction", async () => {
    // ensureMigrationsTable
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // getAppliedMigrations
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ filename: "001_init.sql" }] });
    // getMigrationFiles
    mockReaddir.mockResolvedValueOnce(["001_init.sql", "002_data.sql"]);
    // readFile for 002_data.sql
    mockReadFile.mockResolvedValueOnce("CREATE TABLE data (id INT);");
    // client queries: BEGIN, SET LOCAL, sql, INSERT, COMMIT
    mockClientQuery.mockResolvedValue({ rows: [] });

    await runMigrations();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClientQuery.mock.calls[0][0]).toBe("BEGIN");
    expect(mockClientQuery.mock.calls[1][0]).toContain("search_path");
    expect(mockClientQuery.mock.calls[2][0]).toBe("CREATE TABLE data (id INT);");
    expect(mockClientQuery.mock.calls[3][0]).toContain("INSERT INTO schema_migrations");
    expect(mockClientQuery.mock.calls[3][1]).toEqual(["002_data.sql"]);
    expect(mockClientQuery.mock.calls[4][0]).toBe("COMMIT");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("rolls back on migration failure", async () => {
    // ensureMigrationsTable
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // getAppliedMigrations
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // getMigrationFiles
    mockReaddir.mockResolvedValueOnce(["001_init.sql"]);
    // readFile
    mockReadFile.mockResolvedValueOnce("BAD SQL;");
    // client queries: BEGIN, SET LOCAL, then fail on sql
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SET LOCAL
      .mockRejectedValueOnce(new Error("syntax error")) // SQL
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(runMigrations()).rejects.toThrow("syntax error");

    expect(mockClientQuery.mock.calls[3][0]).toBe("ROLLBACK");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("runs multiple pending migrations in order", async () => {
    // ensureMigrationsTable
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // getAppliedMigrations
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // getMigrationFiles
    mockReaddir.mockResolvedValueOnce(["001_init.sql", "002_data.sql"]);
    // readFile for each
    mockReadFile
      .mockResolvedValueOnce("CREATE TABLE t1 (id INT);")
      .mockResolvedValueOnce("CREATE TABLE t2 (id INT);");
    // client queries for each migration (BEGIN, SET LOCAL, SQL, INSERT, COMMIT) x2
    mockClientQuery.mockResolvedValue({ rows: [] });

    await runMigrations();

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });
});
