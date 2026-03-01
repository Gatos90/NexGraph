import pg from "pg";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("db");

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  min: config.DB_POOL_MIN,
  max: config.DB_POOL_MAX,
});

const ageInitByClient = new WeakMap<pg.PoolClient, Promise<void>>();

/**
 * Ensure AGE is loaded and search_path is set for a specific connection.
 * This is safe to call multiple times; initialization is deduplicated per client.
 */
export async function ensureAgeLoaded(client: pg.PoolClient): Promise<void> {
  let initPromise = ageInitByClient.get(client);
  if (!initPromise) {
    initPromise = (async () => {
      await client.query("LOAD 'age'");
      await client.query(`SET search_path = ag_catalog, "$user", public`);
      logger.debug("AGE extension loaded on connection");
    })();
    ageInitByClient.set(client, initPromise);
  }

  try {
    await initPromise;
  } catch (err) {
    ageInitByClient.delete(client);
    throw err;
  }
}

pool.on("error", (err) => {
  logger.error({ err }, "Unexpected pool error");
});

export { pool };

export async function initExtensions(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS age");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    logger.info("Database extensions initialized (age, pg_trgm, vector)");
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info("Database pool closed");
}
