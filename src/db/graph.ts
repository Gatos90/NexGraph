import { pool, ensureAgeLoaded } from "./connection.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("graph");

export async function createGraph(name: string): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureAgeLoaded(client);
    await client.query("SELECT ag_catalog.create_graph($1)", [name]);
    logger.info({ graph: name }, "Graph created");
  } finally {
    client.release();
  }
}

export async function dropGraph(name: string): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureAgeLoaded(client);
    await client.query("SELECT ag_catalog.drop_graph($1, true)", [name]);
    logger.info({ graph: name }, "Graph dropped");
  } finally {
    client.release();
  }
}

export async function graphExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1) AS exists",
    [name],
  );
  return rows[0].exists;
}

export async function ensureGraph(name: string): Promise<void> {
  const exists = await graphExists(name);
  if (!exists) {
    await createGraph(name);
  }
}
