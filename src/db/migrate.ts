import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "./connection.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("migrate");

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  "migrations",
);

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  return new Set(rows.map((r) => r.filename));
}

async function getMigrationFiles(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const files = await getMigrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    logger.info("No pending migrations");
    return;
  }

  logger.info({ count: pending.length }, "Running pending migrations");

  for (const file of pending) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = await fs.readFile(filePath, "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = public");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
      await client.query("COMMIT");
      logger.info({ file }, "Migration applied");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error({ err, file }, "Migration failed");
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info("All migrations applied");
}

// CLI entry point: `tsx src/db/migrate.ts`
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      logger.fatal({ err }, "Migration CLI failed");
      process.exit(1);
    });
}
