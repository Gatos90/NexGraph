import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgeVertex, AgeEdge } from "./age.js";

// Hoist mock function so it's available before vi.mock factory executes
const mockPoolQuery = vi.hoisted(() => vi.fn());
const mockEnsureAgeLoaded = vi.hoisted(() => vi.fn(async () => {}));

// Mock connection module to prevent real pool creation
vi.mock("./connection.js", () => ({
  pool: {
    query: mockPoolQuery,
    connect: vi.fn(async () => ({
      query: mockPoolQuery,
      release: vi.fn(),
    })),
  },
  ensureAgeLoaded: mockEnsureAgeLoaded,
}));

// Mock logger
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  parseAgtype,
  cypher,
  cypherWithClient,
  createNode,
  createEdge,
  matchNodes,
  matchEdges,
} from "./age.js";

// ─── parseAgtype ─────────────────────────────────────────────

describe("parseAgtype", () => {
  it("should return null for null input", () => {
    expect(parseAgtype(null)).toBeNull();
  });

  it("should return null for undefined input", () => {
    expect(parseAgtype(undefined)).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(parseAgtype("")).toBeNull();
  });

  describe("vertex parsing", () => {
    it("should parse a vertex with standard JSON", () => {
      const raw = '{"id": 1, "label": "File", "properties": {"path": "/src/main.ts"}}::vertex';
      const result = parseAgtype(raw) as AgeVertex;
      expect(result).toEqual({
        id: 1,
        label: "File",
        properties: { path: "/src/main.ts" },
      });
    });

    it("should parse a vertex with unquoted AGE keys", () => {
      const raw = '{id: 1, label: "File", properties: {path: "/src/main.ts"}}::vertex';
      const result = parseAgtype(raw) as AgeVertex;
      expect(result).toEqual({
        id: 1,
        label: "File",
        properties: { path: "/src/main.ts" },
      });
    });
  });

  describe("edge parsing", () => {
    it("should parse an edge", () => {
      const raw =
        '{"id": 10, "label": "IMPORTS", "start_id": 1, "end_id": 2, "properties": {"resolved": true}}::edge';
      const result = parseAgtype(raw) as AgeEdge;
      expect(result).toEqual({
        id: 10,
        label: "IMPORTS",
        start_id: 1,
        end_id: 2,
        properties: { resolved: true },
      });
    });

    it("should parse an edge with unquoted keys", () => {
      const raw =
        '{id: 10, label: "IMPORTS", start_id: 1, end_id: 2, properties: {}}::edge';
      const result = parseAgtype(raw) as AgeEdge;
      expect(result).toEqual({
        id: 10,
        label: "IMPORTS",
        start_id: 1,
        end_id: 2,
        properties: {},
      });
    });
  });

  describe("numeric parsing", () => {
    it("should parse an integer numeric", () => {
      expect(parseAgtype("42::numeric")).toBe(42);
    });

    it("should parse a float numeric", () => {
      expect(parseAgtype("3.14::numeric")).toBeCloseTo(3.14);
    });
  });

  describe("path parsing", () => {
    it("should parse a simple path with vertex-edge-vertex", () => {
      const raw =
        '[{"id": 1, "label": "File", "properties": {}}::vertex, ' +
        '{"id": 10, "label": "IMPORTS", "start_id": 1, "end_id": 2, "properties": {}}::edge, ' +
        '{"id": 2, "label": "File", "properties": {}}::vertex]::path';
      const result = parseAgtype(raw) as Array<AgeVertex | AgeEdge>;
      expect(result).toHaveLength(3);
      expect((result[0] as AgeVertex).label).toBe("File");
      expect((result[1] as AgeEdge).label).toBe("IMPORTS");
      expect((result[2] as AgeVertex).label).toBe("File");
    });
  });

  describe("plain JSON scalars", () => {
    it("should parse a JSON string", () => {
      expect(parseAgtype('"hello"')).toBe("hello");
    });

    it("should parse a JSON number", () => {
      expect(parseAgtype("42")).toBe(42);
    });

    it("should parse a JSON boolean", () => {
      expect(parseAgtype("true")).toBe(true);
      expect(parseAgtype("false")).toBe(false);
    });

    it("should parse a JSON null", () => {
      expect(parseAgtype("null")).toBeNull();
    });

    it("should parse a JSON object", () => {
      expect(parseAgtype('{"key": "value"}')).toEqual({ key: "value" });
    });

    it("should parse a JSON array", () => {
      expect(parseAgtype("[1, 2, 3]")).toEqual([1, 2, 3]);
    });

    it("should return raw string if not valid JSON", () => {
      expect(parseAgtype("just a string")).toBe("just a string");
    });
  });
});

// ─── Cypher query validation ─────────────────────────────────

describe("cypher query validation", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("should reject graph names with special characters", async () => {
    await expect(cypher("bad-graph", "MATCH (n) RETURN n")).rejects.toThrow(
      "Invalid graph name",
    );
  });

  it("should reject graph names starting with a number", async () => {
    await expect(cypher("123graph", "MATCH (n) RETURN n")).rejects.toThrow(
      "Invalid graph name",
    );
  });

  it("should reject queries containing $$", async () => {
    await expect(
      cypher("test_graph", "MATCH (n) WHERE n.val = $$ RETURN n"),
    ).rejects.toThrow("must not contain $$");
  });

  it("should reject invalid column names", async () => {
    await expect(
      cypher("test_graph", "MATCH (n) RETURN n", undefined, [
        { name: "bad-col" },
      ]),
    ).rejects.toThrow("Invalid column name");
  });

  it("should accept valid identifiers", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await cypher("valid_graph", "MATCH (n) RETURN n");
    expect(result).toEqual([]);
  });

  it("should accept identifiers with underscores and numbers", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await cypher(
      "proj_abc123_repo_def456",
      "MATCH (n) RETURN n",
    );
    expect(result).toEqual([]);
  });
});

// ─── SQL building ────────────────────────────────────────────

describe("cypher SQL execution", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("should build SQL without params when none provided", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await cypher("my_graph", "MATCH (n) RETURN n");

    expect(mockPoolQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("cypher('my_graph'");
    expect(sql).toContain("MATCH (n) RETURN n");
    expect(sql).toContain("result ag_catalog.agtype");
    expect(sql).not.toContain("$1::ag_catalog.agtype");
    expect(params).toEqual([]);
  });

  it("should build SQL with params when provided", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await cypher("my_graph", "MATCH (n {name: $name}) RETURN n", {
      name: "test",
    });

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("$1::ag_catalog.agtype");
    expect(params).toEqual([JSON.stringify({ name: "test" })]);
  });

  it("should use custom column definitions", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ a: '{"id": 1}::vertex', e: '{"id": 10}::edge' }],
    });

    await cypher("g", "MATCH (a)-[e]->(b) RETURN a, e", undefined, [
      { name: "a" },
      { name: "e" },
    ]);

    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("a ag_catalog.agtype, e ag_catalog.agtype");
  });

  it("should parse result rows through parseAgtype", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          result:
            '{"id": 1, "label": "File", "properties": {"path": "a.ts"}}::vertex',
        },
      ],
    });

    const results = await cypher<{ result: AgeVertex }>(
      "g",
      "MATCH (n) RETURN n",
    );
    expect(results).toHaveLength(1);
    expect(results[0].result).toEqual({
      id: 1,
      label: "File",
      properties: { path: "a.ts" },
    });
  });
});

// ─── createNode ──────────────────────────────────────────────

describe("createNode", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("should reject invalid node labels", async () => {
    await expect(createNode("g", "bad-label", {})).rejects.toThrow(
      "Invalid node label",
    );
  });

  it("should create a node with properties", async () => {
    const vertex = { id: 1, label: "File", properties: { path: "/a.ts" } };
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ v: JSON.stringify(vertex) + "::vertex" }],
    });

    const result = await createNode("g", "File", { path: "/a.ts" });
    expect(result).toEqual(vertex);

    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("CREATE (v:File");
  });

  it("should create a node without properties", async () => {
    const vertex = { id: 1, label: "Module", properties: {} };
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ v: JSON.stringify(vertex) + "::vertex" }],
    });

    const result = await createNode("g", "Module");
    expect(result).toEqual(vertex);
  });
});

// ─── createEdge ──────────────────────────────────────────────

describe("createEdge", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("should reject invalid edge labels", async () => {
    await expect(createEdge("g", 1, 2, "bad-label")).rejects.toThrow(
      "Invalid edge label",
    );
  });

  it("should create an edge between two nodes", async () => {
    const edge = {
      id: 10,
      label: "IMPORTS",
      start_id: 1,
      end_id: 2,
      properties: {},
    };
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ e: JSON.stringify(edge) + "::edge" }],
    });

    const result = await createEdge("g", 1, 2, "IMPORTS");
    expect(result).toEqual(edge);

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("CREATE (a)-[e:IMPORTS");
    expect(params[0]).toContain('"start_id":1');
    expect(params[0]).toContain('"end_id":2');
  });
});

// ─── matchNodes ──────────────────────────────────────────────

describe("matchNodes", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("should match nodes by label without properties", async () => {
    const vertex = { id: 1, label: "File", properties: { path: "/a.ts" } };
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ n: JSON.stringify(vertex) + "::vertex" }],
    });

    const results = await matchNodes("g", "File");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(vertex);

    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("MATCH (n:File)");
  });

  it("should match nodes with property filter", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await matchNodes("g", "File", { path: "/a.ts" });

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("MATCH (n:File {path: $path})");
    expect(params[0]).toContain('"path":"/a.ts"');
  });
});

// ─── matchEdges ──────────────────────────────────────────────

describe("matchEdges", () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it("should match edges by label", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await matchEdges("g", "IMPORTS");

    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("MATCH (a)-[e:IMPORTS]->(b)");
    expect(sql).toContain("a ag_catalog.agtype, e ag_catalog.agtype, b ag_catalog.agtype");
  });

  it("should filter by start and end node labels", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await matchEdges("g", "IMPORTS", "File", "Module");

    const [sql] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain("MATCH (a:File)-[e:IMPORTS]->(b:Module)");
  });
});

// ─── cypherWithClient ────────────────────────────────────────

describe("cypherWithClient", () => {
  it("should use the provided client instead of pool", async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cypherWithClient(mockClient as any, "g", "MATCH (n) RETURN n");

    expect(mockClient.query).toHaveBeenCalledOnce();
    const [sql] = mockClient.query.mock.calls[0];
    expect(sql).toContain("cypher('g'");
  });

  it("should validate identifiers same as cypher()", async () => {
    const mockClient = { query: vi.fn() };

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cypherWithClient(mockClient as any, "bad-graph", "MATCH (n) RETURN n"),
    ).rejects.toThrow("Invalid graph name");
  });
});
