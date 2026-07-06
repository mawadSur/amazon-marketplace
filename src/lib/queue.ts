// BullMQ-based job queues. One queue per AI workload kind keeps backpressure
// independent — e.g. a backlog of background-removal jobs shouldn't slow
// description generation.

import { Queue, Worker, type Processor, type QueueOptions, type WorkerOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

const qlog = log.child({ module: "queue" });

let _conn: IORedis | null = null;

function connection() {
  if (!env.REDIS_URL) throw new Error("REDIS_URL not set");
  if (!_conn) {
    _conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    // Surface connection-level failures — otherwise ioredis errors can go
    // unhandled and crash the process or silently stall the workers.
    _conn.on("error", (err) => qlog.error({ err }, "redis connection error"));
  }
  return _conn;
}

// Sensible retry/backoff defaults so any add() inherits resilient behavior even
// when the caller doesn't pass options. Per-add options still override these.
export const DEFAULT_JOB_OPTIONS: NonNullable<QueueOptions["defaultJobOptions"]> = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: false, // keep failed jobs for admin inspection
};

export type QueueName =
  | "ai.background_removal"
  | "ai.description"
  | "ai.translation"
  | "ai.pricing"
  | "ai.categorization"
  | "ai.lifestyle_photo"
  | "ai.search_intent"
  | "ai.story_video"
  | "ai.avatar_video"
  | "trust.recompute"
  | "payments.refund";

const _queues = new Map<QueueName, Queue>();

export function getQueue<T = unknown>(name: QueueName, opts?: Partial<QueueOptions>): Queue<T> {
  let q = _queues.get(name) as Queue<T> | undefined;
  if (!q) {
    q = new Queue<T>(name, {
      connection: connection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
      ...opts,
    });
    _queues.set(name, q as Queue);
  }
  return q;
}

export function makeWorker<T = unknown>(
  name: QueueName,
  processor: Processor<T>,
  opts?: Partial<WorkerOptions>,
): Worker<T> {
  return new Worker<T>(name, processor, {
    connection: connection(),
    concurrency: 2,
    ...opts,
  });
}
