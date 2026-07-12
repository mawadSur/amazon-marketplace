// Seller-payout clawback + reinstatement (Wave 2). Split out of src/lib/payouts.ts
// to keep both files small; re-exported from "@/lib/payouts" so callers keep a
// single import surface. See the payouts.ts header for the full
// platform-holds-then-distributes timing model.

import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { razorpayReversePayout } from "@/lib/providers/razorpay";
import { usdCentsToInrPaiseAt } from "@/lib/fx";
import { shopNetUsdCents } from "@/lib/fees";
import { reverseReleaseEscrow, reverseReleaseEscrowToTarget } from "@/lib/escrow";
import { log } from "@/lib/log";

const polog = log.child({ module: "payout-clawback" });

/**
 * Claw back an order's disbursed seller payouts on a refund/chargeback/dispute.
 *
 * Scope + amount depend on `shopId`:
 *  - shopId OMITTED (whole-order refund / card chargeback): FULL clawback of every
 *    shop's payout — the buyer got their entire order back, so no seller keeps
 *    anything.
 *  - shopId PROVIDED (per-shop dispute, Wave 2): PARTIAL clawback. Only the
 *    DISPUTED portion is reversed; the shop keeps its payout for the items it still
 *    legitimately sold. The disputed items were already flipped REFUNDED/DISPUTED by
 *    the caller (resolveDispute commits that before calling this), so we recompute
 *    the shop's remaining-ACTIVE net (mirrors disbursePayout) and claw back only
 *    (disbursed − remainingNet). When nothing remains active (whole-shop dispute)
 *    this collapses to a full clawback.
 *
 * Per payout: reverse the clawed amount at RazorpayX, record a PayoutReversal, and
 *  - PARTIAL (remaining net > 0): reduce payout.amountInrPaise to what the seller
 *    keeps (payout stays PAID/PROCESSING) and net the escrow RELEASE DOWN TO the
 *    remaining net via reverseReleaseEscrowToTarget.
 *  - FULL (remaining net == 0): flip the payout to REVERSED (terminal; the
 *    markPayoutPaid/Failed guards refuse to override) and net the whole RELEASE back
 *    down via reverseReleaseEscrow.
 * The escrow write is best-effort (it must never block the gateway clawback).
 *
 * Self-heal: a prior run may have flipped a payout to REVERSED (full clawback) but
 * had its best-effort escrow reversal fail. The sweep re-attempts reverseReleaseEscrow
 * for every already-REVERSED payout in scope — idempotent, so a healed shop is a
 * no-op. (A failed PARTIAL escrow write is not auto-swept, but getEscrowSummary's
 * reconcile surfaces the resulting drift.)
 *
 * Idempotent on a clean re-run: a partially-clawed payout has amountInrPaise already
 * reduced to the remaining net, so the recompute yields clawback 0 and it is skipped.
 * Never throws: per-payout failures are logged + Sentry-captured so a partial failure
 * can't block the buyer refund that drives it.
 */
export async function reversePayoutsForOrder(
  orderId: string,
  reason?: string,
  shopId?: string,
): Promise<{ reversed: number }> {
  const payouts = await prisma.payout.findMany({
    where: shopId
      ? { orderId, shopId, status: { in: ["PROCESSING", "PAID"] } }
      : { orderId, status: { in: ["PROCESSING", "PAID"] } },
    select: { id: true, shopId: true, amountInrPaise: true, razorpayPayoutId: true },
  });

  // fxRate is only needed to value the remaining-active net for a per-shop partial
  // clawback; the whole-order path always fully claws back regardless of items.
  let fxRate: number | undefined;
  if (shopId && payouts.length > 0) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { fxRate: true } });
    fxRate = order ? Number(order.fxRate) : undefined;
  }

  let reversed = 0;
  for (const p of payouts) {
    try {
      // How much of THIS payout does the seller still legitimately keep?
      // Whole-order (no shopId) → 0 (full clawback). Per-shop → remaining ACTIVE net.
      let remainingNetUsd = 0;
      let remainingNetInr = 0;
      if (shopId) {
        const items = await prisma.orderItem.findMany({
          where: { orderId, shopId: p.shopId },
          select: { qty: true, unitPriceUsdCents: true, status: true },
        });
        const activeSubtotal = items
          .filter((it) => it.status === "ACTIVE")
          .reduce((sum, it) => sum + it.qty * it.unitPriceUsdCents, 0);
        remainingNetUsd = shopNetUsdCents(activeSubtotal);
        remainingNetInr =
          remainingNetUsd > 0 && fxRate !== undefined
            ? usdCentsToInrPaiseAt(remainingNetUsd, fxRate)
            : 0;
        // Never let the seller "keep" more than was actually disbursed.
        if (remainingNetInr > p.amountInrPaise) remainingNetInr = p.amountInrPaise;
      }

      const clawbackInr = p.amountInrPaise - remainingNetInr;
      if (clawbackInr <= 0) continue; // seller still owed the full payout — nothing to claw

      const { reversalRef } = await razorpayReversePayout({
        payoutId: p.razorpayPayoutId ?? p.id,
        amountInrPaise: clawbackInr,
        reason,
      });

      const partial = remainingNetInr > 0;
      await prisma.$transaction([
        prisma.payoutReversal.create({
          data: {
            payoutId: p.id,
            amountInrPaise: clawbackInr,
            reason: reason ?? null,
            reversalRef,
          },
        }),
        prisma.payout.update({
          where: { id: p.id },
          data: partial
            ? { amountInrPaise: remainingNetInr }
            : { status: "REVERSED", reversedAt: new Date(), reversalId: reversalRef },
        }),
      ]);
      reversed += 1;

      // Net this shop's escrow RELEASE back down. PARTIAL → down TO the remaining
      // net; FULL → all the way to 0. Best-effort.
      try {
        if (partial) {
          await reverseReleaseEscrowToTarget({
            orderId,
            shopId: p.shopId,
            targetUsdCents: remainingNetUsd,
            reason,
          });
        } else {
          await reverseReleaseEscrow({ orderId, shopId: p.shopId, reason });
        }
      } catch (err) {
        polog.error({ err, payoutId: p.id, orderId }, "escrow release reversal after payout clawback failed");
        Sentry.captureException(err, {
          extra: { payoutId: p.id, orderId, shopId: p.shopId, phase: "payout-clawback-escrow" },
        });
      }
    } catch (err) {
      polog.error({ err, payoutId: p.id, orderId }, "payout reversal failed");
      Sentry.captureException(err, { extra: { payoutId: p.id, orderId, phase: "payout-reversal" } });
    }
  }

  // Self-heal: re-attempt the (full) escrow RELEASE reversal for every already-
  // REVERSED payout in scope, in case a prior run's best-effort escrow write failed.
  // Idempotent per (order, shop) — a no-op once healed.
  const reversedRows = await prisma.payout.findMany({
    where: shopId ? { orderId, shopId, status: "REVERSED" } : { orderId, status: "REVERSED" },
    select: { shopId: true },
  });
  for (const shop of new Set(reversedRows.map((r) => r.shopId))) {
    try {
      await reverseReleaseEscrow({ orderId, shopId: shop, reason });
    } catch (err) {
      polog.error({ err, orderId, shopId: shop }, "escrow release reversal self-heal failed");
      Sentry.captureException(err, {
        extra: { orderId, shopId: shop, phase: "payout-clawback-escrow-heal" },
      });
    }
  }

  return { reversed };
}

export type ReinstateResult =
  | { status: "reinstated"; payoutId: string; amountInrPaise: number }
  | { status: "noop"; reason: string }
  | { status: "manual"; payoutId: string; reason: string };

function alertReinstateManual(info: {
  orderId: string;
  shopId: string;
  payoutId: string | null;
  reason: string;
}): void {
  polog.error(info, "seller-favored dispute needs MANUAL payout reinstatement — seller may be underpaid");
  Sentry.captureException(new Error("PAYOUT_REINSTATE_MANUAL"), { extra: { ...info } });
}

/**
 * Re-establish a shop's payout after a dispute resolves in the SELLER's favour
 * (Wave 2). During the hold window the weekly batch excludes DISPUTED items when it
 * recomputes a shop's net; if every item was disputed it CANCELS the payout to a
 * terminal REVERSED (amount 0) without ever disbursing. When that dispute then
 * resolves SELLER, the items return to ACTIVE but nothing re-pays the seller — this
 * fixes that.
 *
 * Safe, automatic case: a payout CANCELLED PRE-DISBURSEMENT (REVERSED, never sent to
 * the gateway: no razorpayPayoutId, no disbursedAt) is resurrected to PENDING with
 * the recomputed net owed and a FRESH hold window, so the next batch disburses it
 * normally. Guarded on those exact fields so it can never revive a payout that
 * actually moved money. A still-PENDING payout is a no-op (the batch self-corrects).
 *
 * A payout already DISBURSED (PROCESSING/PAID) or really CLAWED BACK at the gateway
 * can't be topped up here — the (orderId, shopId) unique constraint allows only one
 * payout per shop per order, and re-disbursing risks a double-pay. Those rarer cases
 * are flagged for manual ops review instead of moving money blind. Best-effort.
 */
export async function reinstatePayoutForShop(
  orderId: string,
  shopId: string,
): Promise<ReinstateResult> {
  const [order, items, payout] = await Promise.all([
    prisma.order.findUnique({ where: { id: orderId }, select: { fxRate: true, deliveredAt: true } }),
    prisma.orderItem.findMany({
      where: { orderId, shopId },
      select: { id: true, qty: true, unitPriceUsdCents: true, status: true },
    }),
    prisma.payout.findUnique({
      where: { orderId_shopId: { orderId, shopId } },
      select: { id: true, status: true, razorpayPayoutId: true, disbursedAt: true },
    }),
  ]);

  const active = items.filter((it) => it.status === "ACTIVE");
  const owedUsd = shopNetUsdCents(active.reduce((s, it) => s + it.qty * it.unitPriceUsdCents, 0));
  if (owedUsd <= 0) return { status: "noop", reason: "NOTHING_OWED" };

  // A still-PENDING payout self-corrects — the next batch recomputes from live item
  // statuses and includes the now-ACTIVE items.
  if (payout && payout.status === "PENDING") {
    return { status: "noop", reason: "PENDING_WILL_RECOMPUTE" };
  }

  const fxRate = order ? Number(order.fxRate) : undefined;
  const neverDisbursed = payout && !payout.razorpayPayoutId && !payout.disbursedAt;

  // Safe path: resurrect a pre-disbursement CANCELLED payout back to PENDING.
  if (payout && payout.status === "REVERSED" && neverDisbursed) {
    if (fxRate === undefined) {
      alertReinstateManual({ orderId, shopId, payoutId: payout.id, reason: "NO_FX_RATE" });
      return { status: "manual", payoutId: payout.id, reason: "NO_FX_RATE" };
    }
    const eligibleAt = order?.deliveredAt ?? new Date();
    // Guarded on the exact pre-disbursement shape so a racing disbursement can't be
    // clobbered. eligibleAt is refreshed so a fresh hold window applies.
    const upd = await prisma.payout.updateMany({
      where: { id: payout.id, status: "REVERSED", razorpayPayoutId: null, disbursedAt: null },
      data: {
        status: "PENDING",
        amountInrPaise: usdCentsToInrPaiseAt(owedUsd, fxRate),
        orderItemIds: active.map((it) => it.id),
        eligibleAt,
        reversedAt: null,
        reversalId: null,
        failureReason: null,
      },
    });
    if (upd.count === 0) return { status: "noop", reason: "ALREADY_CHANGED" };
    const amountInrPaise = usdCentsToInrPaiseAt(owedUsd, fxRate);
    polog.info({ orderId, shopId, payoutId: payout.id, amountInrPaise }, "payout reinstated for seller-favored dispute");
    return { status: "reinstated", payoutId: payout.id, amountInrPaise };
  }

  // No payout row yet but the order is delivered and the shop is owed — create a
  // fresh PENDING one (safety net; enqueuePayouts normally does this at delivery).
  if (!payout && order?.deliveredAt) {
    if (fxRate === undefined) {
      alertReinstateManual({ orderId, shopId, payoutId: null, reason: "NO_FX_RATE" });
      return { status: "manual", payoutId: "", reason: "NO_FX_RATE" };
    }
    try {
      const created = await prisma.payout.create({
        data: {
          shopId,
          orderId,
          status: "PENDING",
          amountInrPaise: usdCentsToInrPaiseAt(owedUsd, fxRate),
          orderItemIds: active.map((it) => it.id),
          eligibleAt: order.deliveredAt,
        },
        select: { id: true, amountInrPaise: true },
      });
      polog.info({ orderId, shopId, payoutId: created.id }, "payout created on seller-favored dispute reinstatement");
      return { status: "reinstated", payoutId: created.id, amountInrPaise: created.amountInrPaise };
    } catch (err) {
      // Lost a race to a concurrent create/enqueue — the other one covers it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { status: "noop", reason: "RACED_CREATE" };
      }
      throw err;
    }
  }

  // Not yet delivered → enqueuePayouts will create the payout at delivery.
  if (!payout) return { status: "noop", reason: "NOT_DELIVERED" };

  // Disbursed / really-clawed-back → can't safely top up under the unique
  // constraint; flag for manual review.
  alertReinstateManual({ orderId, shopId, payoutId: payout.id, reason: `DISBURSED_STATUS_${payout.status}` });
  return { status: "manual", payoutId: payout.id, reason: `DISBURSED_STATUS_${payout.status}` };
}
