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
  | "payments.refund"
  // Weekly bulk seller-payout batch (Wave 2). Driven by a BullMQ repeatable job
  // (see schedulePayoutBatch) whose processor calls runPayoutBatch().
  | "payouts.batch";

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

// ─────────────────────────────────────────────────────────────────────────────
// Weekly payout batch schedule (Wave 2)
//
// The batch runs once a week on PAYOUT_RUN_WEEKDAY at a fixed UTC time. The cron
// day-of-week + a Redis-independent nextPayoutRunAt() are derived here so the
// admin dashboard can show the schedule without touching Redis, and the worker
// registers the repeatable job via schedulePayoutBatch().
// ─────────────────────────────────────────────────────────────────────────────

/** Cron/JS day-of-week index: Sunday = 0 … Saturday = 6. */
const WEEKDAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

/** Fixed run time (UTC) for the weekly batch. */
export const PAYOUT_BATCH_HOUR_UTC = 9;
export const PAYOUT_BATCH_MINUTE_UTC = 0;

/** BullMQ job-scheduler id for the repeatable weekly batch. */
export const PAYOUT_BATCH_SCHEDULER_ID = "weekly-payout-batch";

/** Resolve PAYOUT_RUN_WEEKDAY to a 0–6 index (defaults to Monday = 1). */
export function payoutRunWeekdayIndex(): number {
  const idx = WEEKDAYS.indexOf(env.PAYOUT_RUN_WEEKDAY.trim().toUpperCase() as (typeof WEEKDAYS)[number]);
  return idx >= 0 ? idx : 1;
}

/** Canonical weekday name the batch runs on (e.g. "MONDAY"). */
export function payoutRunWeekdayName(): string {
  return WEEKDAYS[payoutRunWeekdayIndex()];
}

/** Cron expression (UTC) for the weekly batch, e.g. "0 9 * * 1". */
export function payoutBatchCron(): string {
  return `${PAYOUT_BATCH_MINUTE_UTC} ${PAYOUT_BATCH_HOUR_UTC} * * ${payoutRunWeekdayIndex()}`;
}

/**
 * Next scheduled batch run STRICTLY after `now`, computed in UTC without a cron
 * library (so it works on the admin server component without a Redis round-trip).
 */
export function nextPayoutRunAt(now: Date = new Date()): Date {
  const dow = payoutRunWeekdayIndex();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      PAYOUT_BATCH_HOUR_UTC,
      PAYOUT_BATCH_MINUTE_UTC,
      0,
      0,
    ),
  );
  let add = (dow - next.getUTCDay() + 7) % 7;
  // If today is the run day but the run time has already passed (or is exactly
  // now), roll forward a full week.
  if (add === 0 && next.getTime() <= now.getTime()) add = 7;
  next.setUTCDate(next.getUTCDate() + add);
  return next;
}

/**
 * Register (idempotently) the repeatable weekly payout batch. Safe to call on
 * every worker boot — upsertJobScheduler replaces any existing scheduler with
 * the same id, so a changed PAYOUT_RUN_WEEKDAY takes effect on the next deploy.
 */
export async function schedulePayoutBatch(): Promise<void> {
  const q = getQueue("payouts.batch");
  await q.upsertJobScheduler(
    PAYOUT_BATCH_SCHEDULER_ID,
    { pattern: payoutBatchCron(), tz: "UTC" },
    { name: "payouts.batch", opts: { removeOnComplete: { count: 50 }, removeOnFail: false } },
  );
}
