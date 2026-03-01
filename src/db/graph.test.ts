import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockClientQuery = vi.hoisted(() => vi.fn());
const mockRelease = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease }),
);
const mockEnsureAgeLoaded = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./connection.js", () => ({
  pool: { query: mockQuery, connect: mockConnect },
  ensureAgeLoaded: mockEnsureAgeLoaded,
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createGraph, dropGraph, graphExists, ensureGraph } from "./graph.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
});

describe("createGraph", () => {
  it("executes CREATE GRAPH query via client", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    await createGraph("test_graph");

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockEnsureAgeLoaded).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    expect(mockClientQuery.mock.calls[0][0]).toContain("create_graph");
    expect(mockClientQuery.mock.calls[0][1]).toEqual(["test_graph"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("dropGraph", () => {
  it("executes DROP GRAPH query via client", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    await dropGraph("test_graph");

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockEnsureAgeLoaded).toHaveBeenCalledTimes(1);
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    expect(mockClientQuery.mock.calls[0][0]).toContain("drop_graph");
    expect(mockClientQuery.mock.calls[0][1]).toEqual(["test_graph"]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe("graphExists", () => {
  it("returns true when graph exists", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ exists: true }],
    });

    const result = await graphExists("test_graph");
    expect(result).toBe(true);
  });

  it("returns false when graph does not exist", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ exists: false }],
    });

    const result = await graphExists("test_graph");
    expect(result).toBe(false);
  });
});

describe("ensureGraph", () => {
  it("creates graph if it does not exist", async () => {
    // graphExists uses pool.query
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
    // createGraph uses pool.connect → client.query
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    await ensureGraph("test_graph");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("does not create if graph already exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });

    await ensureGraph("test_graph");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
