import { PgBoss } from "pg-boss";
import { config } from "../config.js";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("queue");

let boss: PgBoss | null = null;

export function getBoss(): PgBoss {
  if (!boss) {
    throw new Error("pg-boss not initialized — call initBoss() first");
  }
  return boss;
}

export async function initBoss(): Promise<PgBoss> {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
  });

  boss.on("error", (err: Error) => {
    logger.error({ err }, "pg-boss error");
  });

  await boss.start();
  logger.info("pg-boss started");

  await boss.createQueue(INDEXING_QUEUE);
  logger.info({ queue: INDEXING_QUEUE }, "pg-boss queue created");

  await boss.createQueue(EMBEDDING_REINDEX_QUEUE);
  logger.info({ queue: EMBEDDING_REINDEX_QUEUE }, "pg-boss queue created");

  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 });
    boss = null;
    logger.info("pg-boss stopped");
  }
}

// ─── Queue Names ────────────────────────────────────────────

export const INDEXING_QUEUE = "indexing";
export const EMBEDDING_REINDEX_QUEUE = "embedding-reindex";
