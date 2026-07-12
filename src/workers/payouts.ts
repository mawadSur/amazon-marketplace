// Weekly payout-batch worker (Wave 2 scheduler). The repeatable BullMQ job
// registered by schedulePayoutBatch() fires on PAYOUT_RUN_WEEKDAY and this
// processor runs runPayoutBatch(), which disburses every PENDING payout whose
// PAYOUT_HOLD_DAYS hold window has elapsed.
//
// Concurrency 1: the batch is inherently a single sweep — no reason to run two
// copies at once (runPayoutBatch is idempotent even if we did, but this keeps a
// single scheduled fire from fanning out).

import type { Worker } from "bullmq";
import { makeWorker } from "@/lib/queue";
import { runPayoutBatch } from "@/lib/payout-batch";

export function startPayoutBatchWorker(): Worker {
  return makeWorker(
    "payouts.batch",
    async () => {
      const res = await runPayoutBatch();
      return res;
    },
    { concurrency: 1 },
  );
}
