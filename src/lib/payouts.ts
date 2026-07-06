// Payout orchestration: split a paid order's revenue per shop, create one
// Payout row per shop, and disburse via RazorpayX. The webhook handler later
// flips PROCESSING → PAID via markPayoutPaid().
//
// TIMING (clawback fix): payouts are HELD until delivery. markPaymentCaptured no
// longer calls enqueuePayouts — the order's DELIVERED transition does (see
// follow-up note for src/lib/shipments.ts). Disbursing only after delivery means
// a pre-delivery refund never has to recover funds already sent to a seller. For
// the post-delivery dispute case, reversePayoutsForOrder claws back.

import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { razorpayCreatePayout } from "@/lib/stubs";
// razorpayReversePayout is not part of the stubs re-export surface — import it
// straight from the provider module.
import { razorpayReversePayout } from "@/lib/providers/razorpay";
import { usdCentsToInrPaiseAt } from "@/lib/fx";
import { shopNetUsdCents } from "@/lib/fees";
import { sendPayoutNotification } from "@/lib/email";
import { log } from "@/lib/log";

const polog = log.child({ module: "payouts" });

export type EnqueuePayoutsResult = {
  created: { payoutId: string; shopId: string; amountInrPaise: number }[];
};

/**
 * Release payouts for a DELIVERED order. For each shop with items in the order:
 *   - subtotal = sum(qty * unitPriceUsdCents) for that shop's order items
 *   - net (USD cents) = full shop subtotal (the 10% platform fee is collected
 *     from the buyer at checkout, NOT deducted from the seller here)
 *   - amount (INR paise) = net converted at the order's snapshotted fxRate
 *   - create Payout row (with orderId), call RazorpayX, persist payoutId
 *
 * Idempotent per (orderId, shopId) via the DB unique constraint — a re-run (or
 * a duplicate delivery event) can't double-pay a seller.
 */
export async function enqueuePayouts(orderId: string): Promise<EnqueuePayoutsResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      fxRate: true,
      items: { select: { id: true, shopId: true, qty: true, unitPriceUsdCents: true } },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const fxRate = Number(order.fxRate);

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
    // Idempotency: one Payout per (orderId, shopId).
    const existing = await prisma.payout.findUnique({
      where: { orderId_shopId: { orderId, shopId } },
      select: { id: true },
    });
    if (existing) continue;

    const netUsd = shopNetUsdCents(group.subtotal);
    const amountInrPaise = usdCentsToInrPaiseAt(netUsd, fxRate);

    let payout: { id: string };
    try {
      payout = await prisma.payout.create({
        data: {
          shopId,
          orderId,
          status: "PROCESSING",
          amountInrPaise,
          orderItemIds: group.itemIds,
        },
        select: { id: true },
      });
    } catch (err) {
      // Lost a race to a concurrent release for the same (orderId, shopId).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }

    // Look up the shop's Razorpay fund account (set during onboarding).
    const bank = await prisma.bankAccount.findUnique({
      where: { shopId },
      select: { razorpayFundAccountId: true },
    });

    if (bank?.razorpayFundAccountId) {
      const res = await razorpayCreatePayout({
        fundAccountId: bank.razorpayFundAccountId,
        amountInrPaise,
        reference: `${orderId}_${shopId}`,
      });
      await prisma.payout.update({
        where: { id: payout.id },
        data: { razorpayPayoutId: res.payoutId },
      });
    }
    // If bank is missing we still create the Payout row (PROCESSING). An
    // admin can wire the bank later and retry; outside Module 4 scope.

    created.push({ payoutId: payout.id, shopId, amountInrPaise });
  }

  return { created };
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

  await prisma.payout.update({
    where: { id: payout.id },
    data: { status: "FAILED", failureReason: input.reason ?? null },
  });
}

/**
 * Clawback path: reverse every not-yet-reversed payout tied to an order after a
 * buyer-favored dispute/refund on a DELIVERED order (payouts already released).
 * Writes a PayoutReversal ledger row and flips the payout to REVERSED. Failures
 * are logged to Sentry but never throw — a clawback hiccup must not block the
 * buyer's refund. No-op when no payouts were disbursed (pre-delivery case).
 */
export async function reversePayoutsForOrder(
  orderId: string,
  reason?: string,
): Promise<{ reversed: number }> {
  const payouts = await prisma.payout.findMany({
    where: { orderId, status: { in: ["PROCESSING", "PAID"] } },
    select: { id: true, amountInrPaise: true, razorpayPayoutId: true },
  });

  let reversed = 0;
  for (const p of payouts) {
    try {
      const { reversalRef } = await razorpayReversePayout({
        payoutId: p.razorpayPayoutId ?? p.id,
        amountInrPaise: p.amountInrPaise,
        reason,
      });
      await prisma.$transaction([
        prisma.payoutReversal.create({
          data: {
            payoutId: p.id,
            amountInrPaise: p.amountInrPaise,
            reason: reason ?? null,
            reversalRef,
          },
        }),
        prisma.payout.update({
          where: { id: p.id },
          data: { status: "REVERSED", reversedAt: new Date(), reversalId: reversalRef },
        }),
      ]);
      reversed += 1;
    } catch (err) {
      polog.error({ err, payoutId: p.id, orderId }, "payout reversal failed");
      Sentry.captureException(err, { extra: { payoutId: p.id, orderId, phase: "payout-reversal" } });
    }
  }
  return { reversed };
}
