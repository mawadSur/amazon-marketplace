// Payment-capture side of the transaction layer. Triggered by the Stripe
// webhook handler. On success, flips Order → PAID (via a concurrency-safe
// conditional transition) and creates buyer protection + a trust recompute.
//
// Payouts are HELD until delivery (see src/lib/payouts.ts) — capture no longer
// disburses, so a pre-delivery refund never has to claw back funds already sent.

import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { stripeRefund } from "@/lib/stubs";
import { getQueue } from "@/lib/queue";
import { createBuyerProtection } from "@/lib/buyer-protection";
import { enqueueTrustRecompute } from "@/lib/trust-score";
import { sendOrderConfirmation, sendRefundConfirmation } from "@/lib/email";
import { log } from "@/lib/log";

const plog = log.child({ module: "payments" });

export type MarkCapturedInput = {
  orderId: string;
  /** Provider webhook event id — recorded so a replayed event is a no-op. */
  eventId?: string;
  /** "stripe" | "razorpay"; defaults to "stripe". */
  provider?: string;
  providerChargeId?: string;
  providerIntentId?: string;
  /** Amount the gateway actually captured; verified against the order total. */
  capturedAmountUsdCents?: number;
  /** Currency the gateway captured (e.g. "usd"); verified against order.currency. */
  capturedCurrency?: string;
};

export async function markPaymentCaptured(input: MarkCapturedInput): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      status: true,
      currency: true,
      totalUsdCents: true,
      buyer: { select: { email: true } },
      payment: { select: { id: true, status: true } },
      items: { select: { productId: true, qty: true, shopId: true } },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (!order.payment) throw new Error("PAYMENT_MISSING");
  const paymentId = order.payment.id;

  // ── Amount + currency verification ──────────────────────────────────────
  // A mismatch means a tampered/misrouted event — never capture. Flag for
  // review and bail (fail-closed).
  if (
    typeof input.capturedAmountUsdCents === "number" &&
    input.capturedAmountUsdCents !== order.totalUsdCents
  ) {
    plog.error(
      { orderId: order.id, expected: order.totalUsdCents, got: input.capturedAmountUsdCents },
      "capture amount mismatch — refusing capture",
    );
    Sentry.captureException(new Error("CAPTURE_AMOUNT_MISMATCH"), {
      extra: { orderId: order.id, expected: order.totalUsdCents, got: input.capturedAmountUsdCents },
    });
    return;
  }
  if (
    input.capturedCurrency &&
    input.capturedCurrency.toLowerCase() !== order.currency.toLowerCase()
  ) {
    plog.error(
      { orderId: order.id, expected: order.currency, got: input.capturedCurrency },
      "capture currency mismatch — refusing capture",
    );
    Sentry.captureException(new Error("CAPTURE_CURRENCY_MISMATCH"), {
      extra: { orderId: order.id, expected: order.currency, got: input.capturedCurrency },
    });
    return;
  }

  const now = new Date();

  // ── Concurrency-safe, idempotent transition ─────────────────────────────
  // The conditional updateMany from the single pre-paid state (PLACED) is the
  // atomic guard: exactly one caller can flip PLACED→PAID. count===0 means the
  // order was already captured OR is no longer capturable (CANCELLED/REFUNDED),
  // so a late/duplicate webhook can neither double-capture nor revive a dead
  // order. The webhook-event ledger insert shares the TX so a replayed event
  // is a no-op.
  let transitioned = false;
  try {
    transitioned = await prisma.$transaction(async (tx) => {
      if (input.eventId) {
        const seen = await tx.processedWebhookEvent.findUnique({ where: { id: input.eventId } });
        if (seen) return false;
        await tx.processedWebhookEvent.create({
          data: { id: input.eventId, provider: input.provider ?? "stripe", orderId: order.id },
        });
      }
      const res = await tx.order.updateMany({
        where: { id: order.id, status: "PLACED" },
        data: { status: "PAID", paidAt: now },
      });
      if (res.count === 0) return false;
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: "CAPTURED",
          capturedAt: now,
          providerChargeId: input.providerChargeId ?? null,
          providerIntentId: input.providerIntentId ?? undefined,
        },
      });
      return true;
    });
  } catch (err) {
    // Duplicate event id (PK collision under a race) = already processed.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }

  if (!transitioned) return; // already captured / not capturable — no side-effects

  // ── Side-effects (run exactly once per successful transition) ────────────
  // Failures here must NOT roll back the capture — the money is real.

  // Inventory: conditional decrement guards against overselling. A shortfall
  // means we captured for stock we can't fulfil → refund the buyer + alert
  // (never silently swallow — that stranded a paid, unfulfillable order).
  for (const it of order.items) {
    const res = await prisma.product.updateMany({
      where: { id: it.productId, inventory: { gte: it.qty } },
      data: { inventory: { decrement: it.qty } },
    });
    if (res.count === 0) {
      plog.error(
        { orderId: order.id, productId: it.productId, qty: it.qty },
        "inventory shortfall on capture — enqueuing refund",
      );
      Sentry.captureException(new Error("CAPTURE_INVENTORY_SHORTFALL"), {
        extra: { orderId: order.id, productId: it.productId, qty: it.qty },
      });
      try {
        await enqueueRefund({ orderId: order.id, reason: "inventory shortfall at capture" });
      } catch (e) {
        Sentry.captureException(e, { extra: { orderId: order.id, phase: "shortfall-refund" } });
      }
    }
  }

  // NOTE: payouts are intentionally NOT enqueued here — they are held until the
  // order is DELIVERED (see enqueuePayouts in src/lib/payouts.ts). This is the
  // clawback fix: no seller funds move before delivery.

  try {
    await createBuyerProtection(order.id);
  } catch {
    /* protection creation is best-effort */
  }

  // A captured order bumps each shop's sales signal — recompute trust scores.
  const shopIds = [...new Set(order.items.map((it) => it.shopId))];
  await Promise.all(shopIds.map((id) => enqueueTrustRecompute(id)));

  // Transactional email — fire-and-forget; never block/throw into the flow.
  if (order.buyer?.email) {
    void sendOrderConfirmation(order.buyer.email, {
      orderId: order.id,
      totalUsdCents: order.totalUsdCents,
    }).catch((err) => plog.error({ err, orderId: order.id }, "order confirmation email failed"));
  }
}

export type RefundInput = { orderId: string; reason?: string };
export type RefundJobPayload = { orderId: string; reason?: string };

/**
 * Enqueue a refund. Use this from caller paths (e.g. dispute resolution) so a
 * gateway failure can be retried by the worker without holding up the request.
 * The worker calls `refundOrder` and BullMQ handles the retry backoff.
 * Stuck refunds surface as Orders where status=REFUNDED but payment.status=CAPTURED.
 */
export async function enqueueRefund(input: RefundInput): Promise<void> {
  const q = getQueue<RefundJobPayload>("payments.refund");
  await q.add(
    "refund",
    { orderId: input.orderId, reason: input.reason },
    {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: false, // keep failed jobs for admin inspection
    },
  );
}

// Refund a captured payment. Stripe call happens after the read so a gateway
// failure cannot leave the Payment row in an inconsistent state. Idempotent on
// already-REFUNDED; the Stripe call carries a stable idempotency key derived
// from the order so worker retries never double-refund.
export async function refundOrder(input: RefundInput): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      status: true,
      buyer: { select: { email: true } },
      payment: {
        select: {
          id: true,
          status: true,
          providerChargeId: true,
          providerIntentId: true,
          amountUsdCents: true,
        },
      },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (!order.payment) return;
  if (order.payment.status === "REFUNDED") return;

  await stripeRefund({
    chargeId: order.payment.providerChargeId,
    intentId: order.payment.providerIntentId,
    amountUsdCents: order.payment.amountUsdCents,
    reason: input.reason,
    idempotencyKey: `refund_${order.id}`,
  });

  await prisma.payment.update({
    where: { id: order.payment.id },
    data: { status: "REFUNDED" },
  });

  // Fire-and-forget refund confirmation to the buyer.
  if (order.buyer?.email) {
    void sendRefundConfirmation(order.buyer.email, {
      orderId: order.id,
      amountUsdCents: order.payment.amountUsdCents,
    }).catch((err) => plog.error({ err, orderId: order.id }, "refund confirmation email failed"));
  }
}
