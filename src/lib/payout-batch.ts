// Weekly bulk payout batch (Wave 2 scheduler). Split out of src/lib/payouts.ts
// to keep both files small. See the payouts.ts header for the full
// platform-holds-then-distributes timing model.
//
// enqueuePayouts (payouts.ts) creates PENDING held payouts at delivery;
// runPayoutBatch here disburses the ones whose PAYOUT_HOLD_DAYS window has
// elapsed, recomputing each shop's net from CURRENT item statuses so a dispute
// or refund during the hold window reduces/cancels the payout before money
// leaves escrow. Idempotent: it only ever claims still-PENDING rows via a
// conditional updateMany, so a scheduled run overlapping a manual "run now" can
// never double-disburse.

import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { razorpayCreatePayout } from "@/lib/stubs";
import { usdCentsToInrPaiseAt } from "@/lib/fx";
import { shopNetUsdCents } from "@/lib/fees";
import { releaseEscrow } from "@/lib/escrow";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { alertStrandedPayout, markPayoutPaid, payoutReference } from "@/lib/payouts";

const polog = log.child({ module: "payout-batch" });

export type PayoutBatchItemResult =
  | { payoutId: string; shopId: string; status: "disbursed"; amountInrPaise: number }
  | { payoutId: string; shopId: string; status: "stranded"; amountInrPaise: number }
  | { payoutId: string; shopId: string; status: "cancelled"; reason: string }
  | { payoutId: string; shopId: string; status: "skipped"; reason: string };

export type PayoutBatchResult = {
  eligible: number;
  disbursed: number;
  stranded: number;
  cancelled: number;
  skipped: number;
  results: PayoutBatchItemResult[];
};

/**
 * Weekly bulk disbursement. Finds every PENDING payout whose hold window
 * (eligibleAt + PAYOUT_HOLD_DAYS) has elapsed by `now`, and for each:
 *   - RECOMPUTES the shop's net owed from CURRENT item statuses, EXCLUDING
 *     REFUNDED and DISPUTED items (so a dispute/refund during the hold window
 *     reduces — or, if everything is refunded/disputed, cancels — the payout
 *     before money leaves escrow).
 *   - net <= 0        → CANCEL the payout (REVERSED, no gateway, no escrow move).
 *   - net > 0         → flip PENDING→PROCESSING (guarded), stamp disbursedAt +
 *                       the recomputed amount, record the escrow RELEASE, then
 *                       call RazorpayX (or strand it if the shop has no fund
 *                       account). In non-production, flip it straight to PAID
 *                       (no webhook in dev).
 *
 * IDEMPOTENT: the batch only ever selects PENDING rows and flips them via a
 * conditional updateMany (status: PENDING → …), so a second run — or a scheduled
 * run overlapping a manual "run now" — finds nothing left to disburse. The
 * RazorpayX call additionally reuses the (orderId_shopId) idempotency reference,
 * so even a rare double-pick dedups at the gateway. Never double-disburses.
 */
export async function runPayoutBatch(now: Date = new Date()): Promise<PayoutBatchResult> {
  const cutoff = new Date(now.getTime() - env.PAYOUT_HOLD_DAYS * 24 * 60 * 60 * 1000);

  const due = await prisma.payout.findMany({
    where: { status: "PENDING", eligibleAt: { lte: cutoff } },
    select: { id: true, shopId: true, orderId: true, amountInrPaise: true },
    orderBy: { eligibleAt: "asc" },
  });

  const result: PayoutBatchResult = {
    eligible: due.length,
    disbursed: 0,
    stranded: 0,
    cancelled: 0,
    skipped: 0,
    results: [],
  };

  for (const p of due) {
    try {
      const item = await disbursePayout(p, now);
      result.results.push(item);
      if (item.status === "disbursed") result.disbursed += 1;
      else if (item.status === "stranded") result.stranded += 1;
      else if (item.status === "cancelled") result.cancelled += 1;
      else result.skipped += 1;
    } catch (err) {
      polog.error({ err, payoutId: p.id, orderId: p.orderId }, "payout batch item failed");
      Sentry.captureException(err, { extra: { payoutId: p.id, phase: "payout-batch-item" } });
      result.skipped += 1;
      result.results.push({ payoutId: p.id, shopId: p.shopId, status: "skipped", reason: "ERROR" });
    }
  }

  polog.info(
    {
      eligible: result.eligible,
      disbursed: result.disbursed,
      stranded: result.stranded,
      cancelled: result.cancelled,
      skipped: result.skipped,
    },
    "payout batch complete",
  );
  return result;
}

/** Disburse (or cancel) one due PENDING payout. See runPayoutBatch for the
 * money-safety rationale. Recomputes net from current item statuses. */
async function disbursePayout(
  p: { id: string; shopId: string; orderId: string | null; amountInrPaise: number },
  now: Date,
): Promise<PayoutBatchItemResult> {
  if (!p.orderId) {
    // Legacy payout with no source order — can't recompute; leave it for ops.
    return { payoutId: p.id, shopId: p.shopId, status: "skipped", reason: "NO_ORDER" };
  }
  const orderId = p.orderId;

  const [order, items] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, select: { fxRate: true } }),
    prisma.orderItem.findMany({
      where: { orderId, shopId: p.shopId },
      select: { qty: true, unitPriceUsdCents: true, status: true },
    }),
  ]);
  const fxRate = order ? Number(order.fxRate) : undefined;

  // Recompute net from ACTIVE items only — a REFUNDED or (still-open) DISPUTED
  // item must not be paid out. This is what makes a hold-window dispute reduce
  // or cancel the payout before money moves.
  const activeSubtotal = items
    .filter((it) => it.status === "ACTIVE")
    .reduce((sum, it) => sum + it.qty * it.unitPriceUsdCents, 0);
  const netUsd = shopNetUsdCents(activeSubtotal);

  if (netUsd <= 0) {
    // Everything for this shop was refunded/disputed during the hold window.
    // CANCEL the held payout — no gateway reversal (nothing was ever disbursed)
    // and no escrow move (no RELEASE was ever recorded). Guarded on PENDING so a
    // concurrent run can't double-flip.
    const upd = await prisma.payout.updateMany({
      where: { id: p.id, status: "PENDING" },
      data: {
        status: "REVERSED",
        reversedAt: now,
        amountInrPaise: 0,
        failureReason: "cancelled at batch — all items refunded/disputed",
      },
    });
    if (upd.count === 0) {
      return { payoutId: p.id, shopId: p.shopId, status: "skipped", reason: "ALREADY_PROCESSED" };
    }
    return { payoutId: p.id, shopId: p.shopId, status: "cancelled", reason: "ALL_REFUNDED_OR_DISPUTED" };
  }

  const amountInrPaise = usdCentsToInrPaiseAt(netUsd, fxRate);

  // Claim the payout: PENDING → PROCESSING (disbursement initiated). Conditional
  // on still-PENDING so exactly one runner disburses it — the idempotency point.
  const claim = await prisma.payout.updateMany({
    where: { id: p.id, status: "PENDING" },
    data: { status: "PROCESSING", disbursedAt: now, amountInrPaise },
  });
  if (claim.count === 0) {
    return { payoutId: p.id, shopId: p.shopId, status: "skipped", reason: "ALREADY_PROCESSED" };
  }

  // Escrow: record the RELEASE of this shop's net now that disbursement is
  // initiated (mirrors the PROCESSING invariant that markPayoutFailed /
  // reversePayoutsForOrder rely on). Best-effort — a ledger hiccup must not block
  // the seller's money.
  try {
    await releaseEscrow({ orderId, shopId: p.shopId, amountUsdCents: netUsd });
  } catch (err) {
    polog.error({ err, orderId, shopId: p.shopId }, "escrow release ledger write failed");
    Sentry.captureException(err, { extra: { orderId, shopId: p.shopId, phase: "escrow-release" } });
  }

  // Look up the shop's Razorpay fund account (set during onboarding).
  const bank = await prisma.bankAccount.findUnique({
    where: { shopId: p.shopId },
    select: { razorpayFundAccountId: true },
  });

  if (!bank?.razorpayFundAccountId) {
    // STRANDED: PROCESSING with no provider payout id. Seller unpaid until ops
    // wires the bank and retryPayout / retryStrandedPayoutsForShop runs.
    alertStrandedPayout({ payoutId: p.id, shopId: p.shopId, orderId, amountInrPaise });
    return { payoutId: p.id, shopId: p.shopId, status: "stranded", amountInrPaise };
  }

  const res = await razorpayCreatePayout({
    fundAccountId: bank.razorpayFundAccountId,
    amountInrPaise,
    reference: payoutReference(orderId, p.shopId),
  });
  // Persist provider id only while still null (no double-write under a race).
  await prisma.payout.updateMany({
    where: { id: p.id, razorpayPayoutId: null },
    data: { razorpayPayoutId: res.payoutId },
  });

  // No RazorpayX webhook in dev — complete the flow by flipping to PAID here.
  // In production the payout.processed webhook (markPayoutPaid) does this once
  // the money actually lands.
  if (env.NODE_ENV !== "production") {
    try {
      await markPayoutPaid({ payoutId: p.id });
    } catch (err) {
      polog.error({ err, payoutId: p.id }, "dev auto mark-paid failed");
    }
  }

  return { payoutId: p.id, shopId: p.shopId, status: "disbursed", amountInrPaise };
}
