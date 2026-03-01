import type { Job } from "pg-boss";
import { pool } from "../db/index.js";
import { createChildLogger } from "../logger.js";
import { getBoss, EMBEDDING_REINDEX_QUEUE } from "./boss.js";
import { generateEmbeddings } from "../ingestion/embeddings.js";

const logger = createChildLogger("embedding-reindex-worker");

export interface EmbeddingReindexJobData {
  jobId: string;
  projectId: string;
}

interface RepositoryRow {
  id: string;
  graph_name: string | null;
}

interface IndexedRepositoryRow {
  id: string;
  graph_name: string;
}

async function updateJobStatus(
  jobId: string,
  status: "pending" | "running" | "completed" | "failed" | "cancelled",
  extra: {
    phase?: string;
    progress?: number;
    errorMessage?: string;
  } = {},
): Promise<void> {
  const sets = ["status = $1"];
  const values: unknown[] = [status];
  let idx = 2;

  if (extra.phase !== undefined) {
    sets.push(`phase = $${idx++}`);
    values.push(extra.phase);
  }
  if (extra.progress !== undefined) {
    sets.push(`progress = $${idx++}`);
    values.push(extra.progress);
  }
  if (extra.errorMessage !== undefined) {
    sets.push(`error_message = $${idx++}`);
    values.push(extra.errorMessage);
  }
  if (status === "running") {
    sets.push("started_at = COALESCE(started_at, NOW())");
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    sets.push("completed_at = NOW()");
  }

  values.push(jobId);
  await pool.query(
    `UPDATE embedding_reindex_jobs
     SET ${sets.join(", ")}, updated_at = NOW()
     WHERE id = $${idx}`,
    values,
  );
}

async function isCancelled(jobId: string): Promise<boolean> {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM embedding_reindex_jobs WHERE id = $1",
    [jobId],
  );
  if (result.rows.length === 0) return true;
  return result.rows[0].status === "cancelled";
}

async function handleEmbeddingReindexJob(
  jobs: Job<EmbeddingReindexJobData>[],
): Promise<void> {
  const job = jobs[0];
  const { jobId, projectId } = job.data;

  await pool.query(
    "UPDATE embedding_reindex_jobs SET boss_job_id = $1, updated_at = NOW() WHERE id = $2",
    [job.id, jobId],
  );

  await updateJobStatus(jobId, "running", { phase: "collect_repositories", progress: 2 });

  try {
    const reposResult = await pool.query<RepositoryRow>(
      `SELECT id, graph_name
       FROM repositories
       WHERE project_id = $1
       ORDER BY created_at`,
      [projectId],
    );

    const repos = reposResult.rows.filter(
      (r): r is IndexedRepositoryRow =>
        typeof r.graph_name === "string" && r.graph_name.length > 0,
    );

    if (repos.length === 0) {
      await updateJobStatus(jobId, "completed", {
        phase: "done",
        progress: 100,
      });
      logger.info({ jobId, projectId }, "Embedding reindex completed (no indexed repos)");
      return;
    }

    let embeddedTotal = 0;
    for (let i = 0; i < repos.length; i++) {
      if (await isCancelled(jobId)) {
        await updateJobStatus(jobId, "cancelled", {
          phase: "cancelled",
          progress: Math.round((i / repos.length) * 100),
        });
        return;
      }

      const repo = repos[i];
      const phase = `repository_${i + 1}_of_${repos.length}`;
      const baseProgress = 5 + Math.round((i / repos.length) * 90);
      await updateJobStatus(jobId, "running", { phase, progress: baseProgress });

      const result = await generateEmbeddings(
        repo.id,
        projectId,
        repo.graph_name,
        (pct) => {
          const mappedPct = baseProgress + Math.round((pct / 100) * (90 / repos.length));
          updateJobStatus(jobId, "running", {
            phase,
            progress: Math.min(99, mappedPct),
          }).catch(() => {});
        },
      );

      embeddedTotal += result.symbolsEmbedded;
    }

    await updateJobStatus(jobId, "completed", { phase: "done", progress: 100 });
    logger.info(
      { jobId, projectId, repositories: repos.length, embeddedTotal },
      "Embedding reindex completed",
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await updateJobStatus(jobId, "failed", {
      phase: "failed",
      progress: 100,
      errorMessage,
    });
    logger.error({ jobId, projectId, err }, "Embedding reindex failed");
    throw err;
  }
}

export async function registerEmbeddingReindexWorker(): Promise<void> {
  const boss = getBoss();
  await boss.work<EmbeddingReindexJobData>(
    EMBEDDING_REINDEX_QUEUE,
    { localConcurrency: 1 },
    handleEmbeddingReindexJob,
  );
  logger.info("Embedding reindex worker registered");
}
