// Payout orchestration: split a paid order's revenue per shop, create one
// Payout row per shop, and disburse via RazorpayX. The webhook handler later
// flips PROCESSING → PAID via markPayoutPaid().
//
// TIMING — platform holds, then distributes (Wave 2 weekly scheduler):
//   1. At DELIVERED, enqueuePayouts CREATES one PENDING Payout per shop with
//      eligibleAt = deliveredAt. NO money moves and NO escrow RELEASE is
//      recorded yet — funds stay in escrow (the platform holds them).
//   2. A weekly bulk batch (runPayoutBatch) picks up PENDING payouts whose
//      hold window (PAYOUT_HOLD_DAYS after eligibleAt) has elapsed, RECOMPUTES
//      each shop's net owed EXCLUDING refunded/disputed items (so a dispute
//      during the hold window reduces/cancels the payout before money leaves),
//      then disburses via RazorpayX, flips PENDING→PROCESSING, stamps
//      disbursedAt, and records the escrow RELEASE for the net amount.
//   3. markPayoutPaid flips PROCESSING→PAID on the RazorpayX webhook.
//
// Holding until the window elapses means a pre-disbursement refund/dispute never
// has to recover funds already sent to a seller — reversePayoutsForOrder simply
// CANCELS a still-PENDING payout (no gateway reversal). Only a disbursed
// (PROCESSING/PAID) payout needs a real clawback.

import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { razorpayCreatePayout } from "@/lib/stubs";
import { usdCentsToInrPaiseAt } from "@/lib/fx";
import { shopNetUsdCents } from "@/lib/fees";
import { reverseReleaseEscrow } from "@/lib/escrow";
import { sendPayoutNotification } from "@/lib/email";
import { log } from "@/lib/log";

const polog = log.child({ module: "payouts" });

export type EnqueuePayoutsResult = {
  created: { payoutId: string; shopId: string; amountInrPaise: number }[];
};

/**
 * At DELIVERED, CREATE a HELD payout per shop — funds stay in escrow until the
 * weekly batch disburses them. For each shop with items in the order:
 *   - subtotal = sum(qty * unitPriceUsdCents) for that shop's order items
 *   - net (USD cents) = full shop subtotal (the 10% platform fee is collected
 *     from the buyer at checkout, NOT deducted from the seller here)
 *   - amount (INR paise) = net converted at the order's snapshotted fxRate
 *   - create Payout row status PENDING with eligibleAt = deliveredAt
 *
 * NO money moves and NO escrow RELEASE happens here — both are deferred to
 * runPayoutBatch after the hold window elapses (platform-holds-then-distributes).
 * The stored amountInrPaise is the delivery-time estimate; the batch RECOMPUTES
 * it (excluding refunded/disputed items) before disbursing.
 *
 * Idempotent per (orderId, shopId) via the DB unique constraint — a re-run (or a
 * duplicate delivery event) can't create a second held payout for a seller.
 */
export async function enqueuePayouts(orderId: string): Promise<EnqueuePayoutsResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      fxRate: true,
      deliveredAt: true,
      items: { select: { id: true, shopId: true, qty: true, unitPriceUsdCents: true } },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  // Never create a payout for a refunded/cancelled order. A whole-order refund or
  // card chargeback flips Order→REFUNDED but leaves OrderItems ACTIVE, and a late
  // DELIVERED event would otherwise enqueue a PENDING payout the batch then
  // disburses in full — paying the seller for an order the buyer was refunded.
  if (order.status === "REFUNDED" || order.status === "CANCELLED") {
    polog.warn({ orderId, status: order.status }, "skipping payout enqueue for settled (refunded/cancelled) order");
    return { created: [] };
  }
  const fxRate = Number(order.fxRate);
  // Start of the hold window. deliveredAt is normally set by the DELIVERED
  // transition just before this runs; fall back to now for safety.
  const eligibleAt = order.deliveredAt ?? new Date();

  // Group items by shop.
  const byShop = new Map<string, { itemIds: string[]; subtotal: number }>();
  for (const it of order.items) {
    const entry = byShop.get(it.shopId) ?? { itemIds: [], subtotal: 0 };
    entry.itemIds.push(it.id);
    entry.subtotal += it.qty * it.unitPriceUsdCents;
    byShop.set(it.shopId, entry);
  }

  const created: EnqueuePayoutsResult["created"] = [];

  for (const [shopId, group] of byShop) {
    const netUsd = shopNetUsdCents(group.subtotal);
    const amountInrPaise = usdCentsToInrPaiseAt(netUsd, fxRate);

    // Idempotency: one Payout per (orderId, shopId). A held payout already
    // exists (duplicate delivery event) → nothing to do; the batch will disburse
    // it. No escrow heal needed — RELEASE is recorded at disbursement, not here.
    const existing = await prisma.payout.findUnique({
      where: { orderId_shopId: { orderId, shopId } },
      select: { id: true },
    });
    if (existing) continue;

    try {
      const payout = await prisma.payout.create({
        data: {
          shopId,
          orderId,
          status: "PENDING",
          amountInrPaise,
          orderItemIds: group.itemIds,
          eligibleAt,
        },
        select: { id: true },
      });
      created.push({ payoutId: payout.id, shopId, amountInrPaise });
    } catch (err) {
      // Lost a race to a concurrent enqueue for the same (orderId, shopId).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }

  return { created };
}

/** Stable RazorpayX idempotency reference for a (order, shop) payout. Shared by
 * runPayoutBatch and retryPayout so a retry dedups against the original attempt
 * at the gateway rather than double-paying. */
export function payoutReference(orderId: string | null, shopId: string): string {
  return `${orderId}_${shopId}`;
}

/** Alert (log + Sentry) that a payout could not be disbursed and the seller is
 * unpaid until it is retried. Never throws. */
export function alertStrandedPayout(info: {
  payoutId: string;
  shopId: string;
  orderId: string | null;
  amountInrPaise: number;
}): void {
  polog.error(info, "payout STRANDED — shop has no RazorpayX fund account; seller unpaid until retry");
  Sentry.captureException(new Error("PAYOUT_STRANDED"), { extra: { ...info } });
}

export type StrandedPayout = {
  payoutId: string;
  shopId: string;
  orderId: string | null;
  amountInrPaise: number;
  createdAt: Date;
  /** True once the shop has a fund account — i.e. this payout is now retryable. */
  hasFundAccount: boolean;
};

/**
 * Surface stranded payouts: status PROCESSING with NO razorpayPayoutId. These
 * are sellers owed money who were never actually disbursed (the shop had no
 * fund account when the order delivered). `hasFundAccount` marks the ones ops
 * can retry now.
 */
export async function listStrandedPayouts(): Promise<StrandedPayout[]> {
  const rows = await prisma.payout.findMany({
    where: { status: "PROCESSING", razorpayPayoutId: null },
    select: { id: true, shopId: true, orderId: true, amountInrPaise: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];

  const shopIds = [...new Set(rows.map((r) => r.shopId))];
  const banks = await prisma.bankAccount.findMany({
    where: { shopId: { in: shopIds }, razorpayFundAccountId: { not: null } },
    select: { shopId: true },
  });
  const funded = new Set(banks.map((b) => b.shopId));

  return rows.map((r) => ({
    payoutId: r.id,
    shopId: r.shopId,
    orderId: r.orderId,
    amountInrPaise: r.amountInrPaise,
    createdAt: r.createdAt,
    hasFundAccount: funded.has(r.shopId),
  }));
}

export type RetryPayoutResult =
  | { status: "initiated"; payoutId: string; razorpayPayoutId: string }
  | { status: "skipped"; payoutId: string; reason: string }
  | { status: "stranded"; payoutId: string; reason: string };

/**
 * Disburse a STRANDED payout once the shop's fund account exists. Money-safe
 * guards (never double-pay):
 *   - only a PROCESSING payout with NO razorpayPayoutId is eligible. A PAID /
 *     FAILED / REVERSED payout, or one already carrying a provider payout id, is
 *     left untouched.
 *   - the RazorpayX call reuses the SAME idempotency reference as enqueuePayouts
 *     (`${orderId}_${shopId}`), so even a concurrent double-retry dedups to a
 *     single payout at the gateway.
 *   - the provider id is persisted via a conditional updateMany (razorpayPayoutId
 *     still null), so a racing retry that already wrote it is a no-op.
 */
export async function retryPayout(payoutId: string): Promise<RetryPayoutResult> {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    select: {
      id: true,
      shopId: true,
      orderId: true,
      status: true,
      amountInrPaise: true,
      razorpayPayoutId: true,
    },
  });
  if (!payout) throw new Error("PAYOUT_NOT_FOUND");

  // Already-initiated / terminal guard — never re-disburse.
  if (payout.razorpayPayoutId) {
    return { status: "skipped", payoutId: payout.id, reason: "ALREADY_INITIATED" };
  }
  if (payout.status !== "PROCESSING") {
    return { status: "skipped", payoutId: payout.id, reason: `NOT_RETRYABLE_STATUS_${payout.status}` };
  }

  const bank = await prisma.bankAccount.findUnique({
    where: { shopId: payout.shopId },
    select: { razorpayFundAccountId: true },
  });
  if (!bank?.razorpayFundAccountId) {
    alertStrandedPayout({
      payoutId: payout.id,
      shopId: payout.shopId,
      orderId: payout.orderId,
      amountInrPaise: payout.amountInrPaise,
    });
    return { status: "stranded", payoutId: payout.id, reason: "NO_FUND_ACCOUNT" };
  }

  const res = await razorpayCreatePayout({
    fundAccountId: bank.razorpayFundAccountId,
    amountInrPaise: payout.amountInrPaise,
    reference: payoutReference(payout.orderId, payout.shopId),
  });

  await prisma.payout.updateMany({
    where: { id: payout.id, razorpayPayoutId: null },
    data: { razorpayPayoutId: res.payoutId },
  });

  polog.info(
    { payoutId: payout.id, razorpayPayoutId: res.payoutId },
    "stranded payout retried — disbursed",
  );
  return { status: "initiated", payoutId: payout.id, razorpayPayoutId: res.payoutId };
}

/** Retry every stranded payout for a shop (e.g. right after its bank/fund
 * account is verified). Per-payout failures are logged, not thrown. */
export async function retryStrandedPayoutsForShop(shopId: string): Promise<RetryPayoutResult[]> {
  const rows = await prisma.payout.findMany({
    where: { shopId, status: "PROCESSING", razorpayPayoutId: null },
    select: { id: true },
  });
  const results: RetryPayoutResult[] = [];
  for (const r of rows) {
    try {
      results.push(await retryPayout(r.id));
    } catch (err) {
      polog.error({ err, payoutId: r.id, shopId }, "retryPayout failed");
      Sentry.captureException(err, { extra: { payoutId: r.id, shopId, phase: "retry-stranded" } });
      results.push({ status: "skipped", payoutId: r.id, reason: "RETRY_ERROR" });
    }
  }
  return results;
}

/** Webhook side-effect: razorpay payout completed. Idempotent on PAID. */
export async function markPayoutPaid(input: {
  razorpayPayoutId?: string;
  payoutId?: string;
}): Promise<void> {
  const where = input.razorpayPayoutId
    ? { razorpayPayoutId: input.razorpayPayoutId }
    : input.payoutId
      ? { id: input.payoutId }
      : null;
  if (!where) throw new Error("PAYOUT_KEY_REQUIRED");

  const payout = await prisma.payout.findFirst({
    where,
    select: {
      id: true,
      status: true,
      amountInrPaise: true,
      shop: { select: { owner: { select: { email: true } } } },
    },
  });
  if (!payout) throw new Error("PAYOUT_NOT_FOUND");
  if (payout.status === "PAID") return;

  // Terminal-state guard: REVERSED is a terminal status WE set via
  // reversePayoutsForOrder (with PayoutReversal ledger linkage). A stale/out-of-
  // order payout.processed webhook must NOT revive it to PAID and erase the
  // clawback — mirrors the guard in markPayoutFailed.
  if (payout.status === "REVERSED") {
    polog.warn(
      { payoutId: payout.id },
      "ignoring PAID transition for already-REVERSED payout (terminal-state guard)",
    );
    return;
  }

  await prisma.payout.update({
    where: { id: payout.id },
    data: { status: "PAID", paidAt: new Date() },
  });

  // Notify the shop owner their payout landed — fire-and-forget.
  const ownerEmail = payout.shop?.owner?.email;
  if (ownerEmail) {
    void sendPayoutNotification(ownerEmail, {
      payoutId: payout.id,
      amountInrPaise: payout.amountInrPaise,
    }).catch((err) => polog.error({ err, payoutId: payout.id }, "payout notification email failed"));
  }
}

export async function markPayoutFailed(input: {
  razorpayPayoutId?: string;
  payoutId?: string;
  reason?: string;
}): Promise<void> {
  const where = input.razorpayPayoutId
    ? { razorpayPayoutId: input.razorpayPayoutId }
    : input.payoutId
      ? { id: input.payoutId }
      : null;
  if (!where) throw new Error("PAYOUT_KEY_REQUIRED");

  const payout = await prisma.payout.findFirst({ where });
  if (!payout) throw new Error("PAYOUT_NOT_FOUND");

  // Terminal-state guard: REVERSED is a terminal status WE set via
  // reversePayoutsForOrder (with its PayoutReversal ledger linkage). An inbound
  // payout.reversed webhook must NOT downgrade it to FAILED — that would erase
  // the clawback's meaning and drop the reversal linkage. Ignore idempotently.
  if (payout.status === "REVERSED") {
    polog.warn(
      { payoutId: payout.id },
      "ignoring FAILED transition for already-REVERSED payout (terminal-state guard)",
    );
    return;
  }

  await prisma.payout.update({
    where: { id: payout.id },
    data: { status: "FAILED", failureReason: input.reason ?? null },
  });

  // Escrow: runPayoutBatch records a RELEASE when it flips the payout to
  // PROCESSING (disbursement initiated), BEFORE it actually succeeds. A FAILED
  // payout means the seller received NOTHING, so net that RELEASE back down —
  // otherwise releasedUsdCents stays
  // inflated by funds nobody got, and reconcile() (which only checks arithmetic
  // balance) never surfaces it. Idempotent per (orderId, shopId); best-effort so
  // a ledger hiccup never blocks the failure bookkeeping. retryPayout refuses a
  // FAILED payout, so this reversal is terminal and safe.
  if (payout.orderId) {
    try {
      await reverseReleaseEscrow({
        orderId: payout.orderId,
        shopId: payout.shopId,
        reason: input.reason ?? "payout failed",
      });
    } catch (err) {
      polog.error({ err, payoutId: payout.id }, "escrow release reversal on payout failure failed");
      Sentry.captureException(err, {
        extra: { payoutId: payout.id, phase: "escrow-release-reversal-failed" },
      });
    }
  }
}

// Clawback + reinstatement live in src/lib/payout-clawback.ts (per-shop partial
// clawback + seller-favored-dispute reinstatement) to keep this file small;
// re-exported here so callers keep importing from "@/lib/payouts".
export { reversePayoutsForOrder, reinstatePayoutForShop } from "@/lib/payout-clawback";
export type { ReinstateResult } from "@/lib/payout-clawback";
