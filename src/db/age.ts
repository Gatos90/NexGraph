import type pg from "pg";
import { ensureAgeLoaded, pool } from "./connection.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("age");

// ─── Types ───────────────────────────────────────────────────

export interface AgeVertex {
  id: number;
  label: string;
  properties: Record<string, unknown>;
}

export interface AgeEdge {
  id: number;
  label: string;
  start_id: number;
  end_id: number;
  properties: Record<string, unknown>;
}

export type AgePath = Array<AgeVertex | AgeEdge>;

export type AgeValue =
  | AgeVertex
  | AgeEdge
  | AgePath
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface CypherColumn {
  name: string;
}

// ─── Validation ──────────────────────────────────────────────

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(value: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${context}: "${value}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
    );
  }
}

function validateCypherQuery(query: string): void {
  if (query.includes("$$")) {
    throw new Error("Cypher query must not contain $$ (dollar-quote delimiter)");
  }
}

// ─── agtype Parser ───────────────────────────────────────────

/**
 * Parse an AGE JSON-like string into a JS value.
 * Handles both quoted-key (standard JSON) and unquoted-key AGE output.
 */
function parseAgeJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    // AGE may output unquoted keys; attempt to quote them and retry
    const fixed = str.replace(/(?<=[[{,])\s*([a-zA-Z_]\w*)\s*(?=:)/g, '"$1"');
    return JSON.parse(fixed);
  }
}

/**
 * Parse a single agtype value returned by AGE into a native JS value.
 *
 * Handles vertices (`::vertex`), edges (`::edge`), paths (`::path`),
 * numerics (`::numeric`), and plain JSON scalars/objects/arrays.
 */
export function parseAgtype(raw: unknown): AgeValue {
  if (raw === null || raw === undefined) return null;

  const str = String(raw);
  if (str === "") return null;

  // Type-suffixed values: body::vertex | body::edge | body::path | body::numeric
  const suffixMatch = str.match(/^(.+)::(vertex|edge|path|numeric)$/s);
  if (suffixMatch) {
    const [, body, typeName] = suffixMatch;
    switch (typeName) {
      case "vertex":
        return parseAgeJson(body) as AgeVertex;
      case "edge":
        return parseAgeJson(body) as AgeEdge;
      case "path":
        return parsePath(body);
      case "numeric":
        return Number(body);
    }
  }

  // Plain JSON scalar, object, or array
  try {
    return JSON.parse(str) as AgeValue;
  } catch {
    return str;
  }
}

/**
 * Parse an AGE path value.
 * Path format: [{...}::vertex, {...}::edge, {...}::vertex]
 */
function parsePath(body: string): AgePath {
  const inner = body.trim().slice(1, -1); // strip outer []

  // Split on ::vertex / ::edge boundaries (capturing group keeps delimiters)
  const parts = inner.split(/::(vertex|edge)/);
  // Result: [jsonBody, "vertex", ", jsonBody", "edge", ", jsonBody", "vertex"]

  const elements: AgePath = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const jsonStr = parts[i].replace(/^,\s*/, "").trim();
    if (!jsonStr) continue;
    try {
      elements.push(parseAgeJson(jsonStr) as AgeVertex | AgeEdge);
    } catch {
      logger.warn({ raw: jsonStr }, "Failed to parse path element");
    }
  }

  return elements;
}

// ─── Query Building & Execution ──────────────────────────────

function buildCypherSQL(
  graph: string,
  query: string,
  columns: CypherColumn[],
  hasParams: boolean,
): string {
  const colDef = columns.map((c) => `${c.name} ag_catalog.agtype`).join(", ");
  if (hasParams) {
    return `SELECT * FROM ag_catalog.cypher('${graph}', $$ ${query} $$, $1::ag_catalog.agtype) as (${colDef})`;
  }
  return `SELECT * FROM ag_catalog.cypher('${graph}', $$ ${query} $$) as (${colDef})`;
}

function parseRows<T>(
  rows: Record<string, unknown>[],
  columns: CypherColumn[],
): T[] {
  return rows.map((row) => {
    const parsed: Record<string, unknown> = {};
    for (const col of columns) {
      parsed[col.name] = parseAgtype(row[col.name]);
    }
    return parsed as T;
  });
}

/**
 * Execute a Cypher query against an AGE graph and return parsed results.
 *
 * The query is wrapped in AGE's `cypher()` SQL function and dollar-quoted.
 * Results are automatically parsed from agtype to native JS values.
 *
 * @param graph   - Graph name (valid SQL identifier)
 * @param query   - Cypher query string (must not contain `$$`)
 * @param params  - Optional parameter map. Reference in Cypher as `$key`.
 *                  Passed as a JSON-serialized agtype to the `cypher()` function.
 * @param columns - Column definitions for the result set. Defaults to
 *                  a single `result` column.
 */
export async function cypher<T = Record<string, AgeValue>>(
  graph: string,
  query: string,
  params?: Record<string, unknown>,
  columns: CypherColumn[] = [{ name: "result" }],
): Promise<T[]> {
  validateIdentifier(graph, "graph name");
  validateCypherQuery(query);
  for (const col of columns) {
    validateIdentifier(col.name, "column name");
  }

  const hasParams = params !== undefined && Object.keys(params).length > 0;
  const sql = buildCypherSQL(graph, query, columns, hasParams);
  const sqlParams = hasParams ? [JSON.stringify(params)] : [];

  logger.debug({ graph, cypher: query, params }, "Executing Cypher query");

  const client = await pool.connect();
  try {
    await ensureAgeLoaded(client);
    const result = await client.query(sql, sqlParams);
    return parseRows<T>(result.rows as Record<string, unknown>[], columns);
  } finally {
    client.release();
  }
}

/**
 * Execute a Cypher query using a specific pg client (for use within transactions).
 * Same API as {@link cypher} but accepts an explicit client.
 */
export async function cypherWithClient<T = Record<string, AgeValue>>(
  client: pg.PoolClient,
  graph: string,
  query: string,
  params?: Record<string, unknown>,
  columns: CypherColumn[] = [{ name: "result" }],
): Promise<T[]> {
  validateIdentifier(graph, "graph name");
  validateCypherQuery(query);
  for (const col of columns) {
    validateIdentifier(col.name, "column name");
  }

  const hasParams = params !== undefined && Object.keys(params).length > 0;
  const sql = buildCypherSQL(graph, query, columns, hasParams);
  const sqlParams = hasParams ? [JSON.stringify(params)] : [];

  logger.debug({ graph, cypher: query, params }, "Executing Cypher query (client)");

  await ensureAgeLoaded(client);
  const result = await client.query(sql, sqlParams);
  return parseRows<T>(result.rows as Record<string, unknown>[], columns);
}

// ─── Helper Functions ────────────────────────────────────────

/**
 * Build a Cypher property pattern `{key1: $key1, key2: $key2}` from an object,
 * returning both the pattern string and the param map.
 */
function buildPropertyPattern(
  properties: Record<string, unknown>,
): { pattern: string; params: Record<string, unknown> } {
  const keys = Object.keys(properties);
  if (keys.length === 0) return { pattern: "", params: {} };

  for (const key of keys) {
    validateIdentifier(key, "property key");
  }

  const assignments = keys.map((k) => `${k}: $${k}`);
  return {
    pattern: `{${assignments.join(", ")}}`,
    params: properties,
  };
}

/**
 * Create a node with the given label and properties.
 * Returns the created vertex.
 */
export async function createNode(
  graph: string,
  label: string,
  properties: Record<string, unknown> = {},
): Promise<AgeVertex> {
  validateIdentifier(label, "node label");
  const { pattern, params } = buildPropertyPattern(properties);
  const cypherQuery = `CREATE (v:${label} ${pattern}) RETURN v`;
  const rows = await cypher<{ v: AgeVertex }>(
    graph,
    cypherQuery,
    Object.keys(params).length > 0 ? params : undefined,
    [{ name: "v" }],
  );
  return rows[0].v;
}

/**
 * Create a directed edge between two nodes matched by AGE `id()`.
 * Returns the created edge.
 */
export async function createEdge(
  graph: string,
  startId: number,
  endId: number,
  label: string,
  properties: Record<string, unknown> = {},
): Promise<AgeEdge> {
  validateIdentifier(label, "edge label");
  const { pattern, params } = buildPropertyPattern(properties);
  const cypherQuery =
    `MATCH (a), (b) WHERE id(a) = $start_id AND id(b) = $end_id ` +
    `CREATE (a)-[e:${label} ${pattern}]->(b) RETURN e`;
  const rows = await cypher<{ e: AgeEdge }>(
    graph,
    cypherQuery,
    { ...params, start_id: startId, end_id: endId },
    [{ name: "e" }],
  );
  return rows[0].e;
}

/**
 * Match nodes by label with an optional property filter.
 * Returns all matched vertices.
 */
export async function matchNodes(
  graph: string,
  label: string,
  properties?: Record<string, unknown>,
): Promise<AgeVertex[]> {
  validateIdentifier(label, "node label");

  let cypherQuery: string;
  let params: Record<string, unknown> | undefined;

  if (properties && Object.keys(properties).length > 0) {
    const built = buildPropertyPattern(properties);
    cypherQuery = `MATCH (n:${label} ${built.pattern}) RETURN n`;
    params = built.params;
  } else {
    cypherQuery = `MATCH (n:${label}) RETURN n`;
  }

  const rows = await cypher<{ n: AgeVertex }>(graph, cypherQuery, params, [
    { name: "n" },
  ]);
  return rows.map((r) => r.n);
}

/**
 * Match edges by relationship label, optionally filtering start/end node labels.
 * Returns triples of (start vertex, edge, end vertex).
 */
export async function matchEdges(
  graph: string,
  edgeLabel: string,
  startLabel?: string,
  endLabel?: string,
): Promise<Array<{ start: AgeVertex; edge: AgeEdge; end: AgeVertex }>> {
  validateIdentifier(edgeLabel, "edge label");
  if (startLabel) validateIdentifier(startLabel, "start node label");
  if (endLabel) validateIdentifier(endLabel, "end node label");

  const startPattern = startLabel ? `(a:${startLabel})` : "(a)";
  const endPattern = endLabel ? `(b:${endLabel})` : "(b)";
  const cypherQuery = `MATCH ${startPattern}-[e:${edgeLabel}]->${endPattern} RETURN a, e, b`;

  const rows = await cypher<{ a: AgeVertex; e: AgeEdge; b: AgeVertex }>(
    graph,
    cypherQuery,
    undefined,
    [{ name: "a" }, { name: "e" }, { name: "b" }],
  );
  return rows.map((r) => ({ start: r.a, edge: r.e, end: r.b }));
}
