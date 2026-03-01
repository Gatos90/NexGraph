import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClientQuery = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease }),
);
const mockEnd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("pg", () => {
  class MockPool {
    connect = mockConnect;
    query = vi.fn();
    end = mockEnd;
    on = vi.fn();
  }
  return { default: { Pool: MockPool } };
});

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgres://test:test@localhost:5432/testdb",
    DB_POOL_MIN: 2,
    DB_POOL_MAX: 10,
  },
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

import { ensureAgeLoaded, initExtensions, closePool } from "./connection.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
});

describe("ensureAgeLoaded", () => {
  it("executes LOAD and SET search_path on first call for a client", async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    const client = { query: mockClientQuery } as unknown as Parameters<typeof ensureAgeLoaded>[0];

    await ensureAgeLoaded(client);

    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls[0][0]).toBe("LOAD 'age'");
    expect(mockClientQuery.mock.calls[1][0]).toContain("search_path");
  });

  it("deduplicates initialization for same client", async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    const client = { query: mockClientQuery } as unknown as Parameters<typeof ensureAgeLoaded>[0];

    await ensureAgeLoaded(client);
    await ensureAgeLoaded(client);

    // Should only run the init queries once
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
  });

  it("retries after failed initialization", async () => {
    const failClient = { query: vi.fn() } as unknown as Parameters<typeof ensureAgeLoaded>[0];
    (failClient.query as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("LOAD failed"));

    await expect(ensureAgeLoaded(failClient)).rejects.toThrow("LOAD failed");

    // Should be able to retry after failure
    (failClient.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    await ensureAgeLoaded(failClient);

    expect(failClient.query).toHaveBeenCalledTimes(3); // 1 failed + 2 success
  });
});

describe("initExtensions", () => {
  it("creates all required extensions", async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });

    await initExtensions();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
    expect(mockClientQuery.mock.calls[0][0]).toContain("age");
    expect(mockClientQuery.mock.calls[1][0]).toContain("pg_trgm");
    expect(mockClientQuery.mock.calls[2][0]).toContain("vector");
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("closePool", () => {
  it("closes the pool", async () => {
    await closePool();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });
});
