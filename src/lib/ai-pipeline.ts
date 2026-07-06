// AI listing pipeline orchestrator.
//
// On product creation we kick off 4 AI jobs:
//   1. BACKGROUND_REMOVAL   — independent, runs in parallel
//   2. DESCRIPTION          — independent, runs in parallel (uses sourceText)
//   3. PRICING_SUGGESTION   — independent, runs in parallel (uses category)
//   4. CATEGORIZATION       — depends on (2); enqueued by the description worker
//                             after the title/description are written.
//
// Each AiJob row is created up-front so the polling UI can show all four
// statuses (QUEUED → RUNNING → SUCCEEDED). Workers update the rows directly.

import type { AiJobKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getQueue, type QueueName } from "@/lib/queue";

const QUEUE_FOR: Record<
  "BACKGROUND_REMOVAL" | "DESCRIPTION" | "PRICING_SUGGESTION" | "CATEGORIZATION" | "AVATAR_VIDEO",
  QueueName
> = {
  BACKGROUND_REMOVAL: "ai.background_removal",
  DESCRIPTION: "ai.description",
  PRICING_SUGGESTION: "ai.pricing",
  CATEGORIZATION: "ai.categorization",
  AVATAR_VIDEO: "ai.avatar_video",
};

export const PIPELINE_KINDS: AiJobKind[] = [
  "BACKGROUND_REMOVAL",
  "DESCRIPTION",
  "PRICING_SUGGESTION",
  "CATEGORIZATION",
  // AVATAR_VIDEO's row is created up-front (so the status UI shows it) but it's
  // enqueued later — after BG removal succeeds, since the clean cutout is the
  // best input. See enqueueAvatarVideo().
  "AVATAR_VIDEO",
];

/** Pipeline kinds that are NOT enqueued immediately in startPipeline. */
const DEFERRED_KINDS = new Set<AiJobKind>(["CATEGORIZATION", "AVATAR_VIDEO"]);

export interface PipelineInput {
  productId: string;
  imageKey: string;
  sourceLang: string;
  sourceText: string;
}

/**
 * Create AiJob rows for all 4 pipeline steps and enqueue the three that can
 * run immediately (BG, description, pricing). Categorization is enqueued by
 * the description worker once title/description exist.
 */
export async function startPipeline(input: PipelineInput) {
  const jobs = await Promise.all(
    PIPELINE_KINDS.map((kind) =>
      prisma.aiJob.create({
        data: {
          productId: input.productId,
          kind,
          status: "QUEUED",
          input: {
            imageKey: input.imageKey,
            sourceLang: input.sourceLang,
            sourceText: input.sourceText,
          },
        },
      }),
    ),
  );

  // Enqueue the independent jobs now. Categorization + avatar video are deferred.
  for (const job of jobs) {
    if (DEFERRED_KINDS.has(job.kind)) continue;
    const queueName = QUEUE_FOR[job.kind as keyof typeof QUEUE_FOR];
    await getQueue(queueName).add(
      job.kind,
      { aiJobId: job.id, productId: input.productId },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false, // keep failed jobs for admin inspection
      },
    );
  }

  return jobs;
}

/**
 * Enqueue the AVATAR_VIDEO job after background removal succeeds (the clean
 * cutout is the best input). Flips the product to QUEUED so the PDP/editor can
 * show "generating". Honors the AVATAR_VIDEO_ENABLED kill-switch.
 * `attempts: 2` keeps Higgsfield credit spend bounded on flaky renders.
 */
export async function enqueueAvatarVideo(productId: string) {
  const { env } = await import("@/lib/env");
  if (env.AVATAR_VIDEO_ENABLED === "false") return;

  const job = await prisma.aiJob.findFirst({
    where: { productId, kind: "AVATAR_VIDEO", status: "QUEUED" },
  });
  if (!job) return;

  await prisma.product.update({
    where: { id: productId },
    data: { avatarVideoStatus: "QUEUED" },
  });
  await getQueue("ai.avatar_video").add(
    "AVATAR_VIDEO",
    { aiJobId: job.id, productId },
    {
      attempts: 2,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { age: 86_400, count: 1000 },
      removeOnFail: false, // keep failed renders for admin inspection
    },
  );
}

/**
 * Called by the description worker after it writes title/description to the
 * Product. Enqueues the categorization job whose AiJob row already exists.
 */
export async function enqueueAfterCategorize(productId: string) {
  const job = await prisma.aiJob.findFirst({
    where: { productId, kind: "CATEGORIZATION", status: "QUEUED" },
  });
  if (!job) return;
  await getQueue("ai.categorization").add(
    "CATEGORIZATION",
    { aiJobId: job.id, productId },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: false, // keep failed jobs for admin inspection
    },
  );
}
