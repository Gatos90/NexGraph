/**
 * Generic worker_threads pool for parallel task execution.
 * Distributes tasks across a configurable number of workers.
 */
import { Worker } from "node:worker_threads";
import os from "node:os";
import { createChildLogger } from "../logger.js";

const logger = createChildLogger("worker-pool");

// ─── Types ──────────────────────────────────────────────────

export interface WorkerTask {
  id: number;
  [key: string]: unknown;
}

export interface WorkerResult {
  id: number;
  [key: string]: unknown;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  currentResolve?: (result: WorkerResult) => void;
  currentReject?: (error: Error) => void;
}

interface PendingTask {
  task: WorkerTask;
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
}

// ─── Default Pool Size ──────────────────────────────────────

/**
 * Resolve pool size: 0 means auto-detect (CPU cores - 1, min 1).
 */
export function resolvePoolSize(configured: number): number {
  if (configured > 0) return configured;
  return Math.max(1, os.cpus().length - 1);
}

// ─── Worker Pool ────────────────────────────────────────────

export class WorkerPool {
  private workers: PoolWorker[] = [];
  private taskQueue: PendingTask[] = [];
  private destroyed = false;

  constructor(workerUrl: URL, poolSize: number) {
    const size = Math.max(1, poolSize);
    logger.info({ poolSize: size }, "Creating worker pool");

    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl);
      const poolWorker: PoolWorker = { worker, busy: false };

      worker.on("message", (result: WorkerResult) => {
        poolWorker.busy = false;
        const resolve = poolWorker.currentResolve;
        poolWorker.currentResolve = undefined;
        poolWorker.currentReject = undefined;
        resolve?.(result);
        this.processQueue();
      });

      worker.on("error", (err) => {
        poolWorker.busy = false;
        const reject = poolWorker.currentReject;
        poolWorker.currentResolve = undefined;
        poolWorker.currentReject = undefined;
        if (reject) {
          reject(err);
        } else {
          logger.error({ err }, "Unhandled worker error");
        }
        this.processQueue();
      });

      this.workers.push(poolWorker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  exec(task: WorkerTask): Promise<WorkerResult> {
    if (this.destroyed) {
      return Promise.reject(new Error("Worker pool is destroyed"));
    }

    return new Promise<WorkerResult>((resolve, reject) => {
      const freeWorker = this.workers.find((w) => !w.busy);
      if (freeWorker) {
        this.dispatch(freeWorker, task, resolve, reject);
      } else {
        this.taskQueue.push({ task, resolve, reject });
      }
    });
  }

  private dispatch(
    poolWorker: PoolWorker,
    task: WorkerTask,
    resolve: (result: WorkerResult) => void,
    reject: (error: Error) => void,
  ): void {
    poolWorker.busy = true;
    poolWorker.currentResolve = resolve;
    poolWorker.currentReject = reject;
    poolWorker.worker.postMessage(task);
  }

  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    const freeWorker = this.workers.find((w) => !w.busy);
    if (!freeWorker) return;

    const pending = this.taskQueue.shift();
    if (!pending) return;
    this.dispatch(freeWorker, pending.task, pending.resolve, pending.reject);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const pending of this.taskQueue) {
      pending.reject(new Error("Worker pool destroyed"));
    }
    this.taskQueue = [];
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers = [];
    logger.info("Worker pool destroyed");
  }
}
