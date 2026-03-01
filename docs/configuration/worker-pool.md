# Worker Pool

NexGraph uses a pool of Node.js [worker threads](https://nodejs.org/api/worker_threads.html) to parallelize AST parsing during the ingestion pipeline. This significantly speeds up indexing for large repositories.

## Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WORKER_POOL_SIZE` | `number` | `0` (auto) | Number of worker threads to spawn. |

### Auto-sizing

When `WORKER_POOL_SIZE` is `0` (the default), the pool size is calculated automatically:

```
pool_size = max(1, os.cpus().length - 1)
```

This reserves one CPU core for the main thread (handling HTTP requests, database writes, and job orchestration) while using all remaining cores for parsing.

### Manual sizing

Set `WORKER_POOL_SIZE` to a specific positive integer to override auto-detection. This is useful when:

- Running in a container with CPU limits that `os.cpus()` doesn't reflect
- Sharing the host with other CPU-intensive services
- Debugging parsing issues (set to `1` for sequential execution)

## Architecture

```
Main Thread                    Worker Threads
┌─────────────┐               ┌──────────────┐
│  HTTP API   │               │  Worker #1   │
│  DB Writes  │  ◄── msgs ──► │  (AST parse) │
│  Job Queue  │               ├──────────────┤
│             │  ◄── msgs ──► │  Worker #2   │
│  WorkerPool │               │  (AST parse) │
│  .exec()    │               ├──────────────┤
│             │  ◄── msgs ──► │  Worker #N   │
└─────────────┘               │  (AST parse) │
                              └──────────────┘
```

### Task dispatch

1. The main thread calls `pool.exec(task)` which returns a `Promise`
2. If a worker is idle, the task is dispatched immediately via `postMessage`
3. If all workers are busy, the task is queued and dispatched when a worker becomes free
4. Workers run `parse-worker.ts` — a self-contained module that imports only pure AST extraction logic (`parse-core.ts`), with no database or logger dependencies

### Worker isolation

Workers **must not** import modules that create database connections at module scope (such as `src/db/connection.ts`). The codebase separates CPU-intensive pure functions into `*-core.ts` files specifically for worker thread safety. The main thread handles all database writes after receiving parsed results from workers.

## Lifecycle

The worker pool is created when an indexing job starts and destroyed when it completes:

1. **Creation** — `new WorkerPool(workerUrl, poolSize)` spawns `N` worker threads
2. **Execution** — Tasks are submitted via `pool.exec(task)` during the parse phase
3. **Destruction** — `pool.destroy()` terminates all workers and rejects pending tasks

## Recommendations

| Scenario | `WORKER_POOL_SIZE` | Notes |
|----------|-------------------|-------|
| Default / single-purpose server | `0` (auto) | Best for most deployments |
| Container with 2 vCPUs | `1` | Leave one core for main thread |
| Container with 8 vCPUs | `6`–`7` | Leave 1–2 cores for main thread + DB |
| Debugging / testing | `1` | Sequential, easier to trace errors |
| Shared host with other services | 50% of available cores | Avoid starving other processes |
