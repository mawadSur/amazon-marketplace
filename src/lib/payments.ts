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
import {
  holdEscrow,
  refundEscrow,
  refundShopEscrow,
  shopRefundRecorded,
  getRefundedUsdCents,
} from "@/lib/escrow";
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
      subtotalUsdCents: true,
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
      // Escrow: record the initial HOLD for the full buyer total, atomically
      // with the capture. The PLACED→PAID guard above ensures this runs exactly
      // once per order — a replayed capture never reaches here (count===0).
      // releasableUsdCents = the seller-owed portion (subtotal); the platform cut
      // (shipping + fee) is never released, so RELEASED is derived against this.
      await holdEscrow(tx, {
        orderId: order.id,
        amountUsdCents: order.totalUsdCents,
        releasableUsdCents: order.subtotalUsdCents,
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

/**
 * A refund request. When `shopId` + `orderItemIds` are set it is a PARTIAL,
 * per-shop refund (Wave 2 per-shop disputes) — only that shop's disputed items
 * are refunded. Omit both for the whole-order refund (full chargeback / order
 * cancellation), which stays the default back-compat behaviour.
 */
export type RefundInput = {
  orderId: string;
  reason?: string;
  /** Set (with orderItemIds) for a partial per-shop refund. */
  shopId?: string;
  /** The specific OrderItem ids to refund (a single shop's disputed items). */
  orderItemIds?: string[];
};
export type RefundJobPayload = RefundInput;

/**
 * Enqueue a refund. Use this from caller paths (e.g. dispute resolution) so a
 * gateway failure can be retried by the worker without holding up the request.
 * The worker calls `refundOrder` and BullMQ handles the retry backoff.
 * Stuck refunds surface as Orders where status=REFUNDED but payment.status=CAPTURED.
 * The scope (shopId/orderItemIds) is carried through so a partial per-shop refund
 * retries as a partial refund, never as a full-order one.
 */
export async function enqueueRefund(input: RefundInput): Promise<void> {
  const q = getQueue<RefundJobPayload>("payments.refund");
  await q.add(
    "refund",
    {
      orderId: input.orderId,
      reason: input.reason,
      shopId: input.shopId,
      orderItemIds: input.orderItemIds,
    },
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
//
/**
 * Whole-order refund bookkeeping: mark EVERY OrderItem REFUNDED and set
 * Order.status = REFUNDED (and, when `paymentId` is given, flip Payment → REFUNDED)
 * — atomically. Marking items is what stops a subsequent per-shop dispute from
 * double-refunding the buyer: openDispute rejects REFUNDED items, and the refund
 * clamp in refundOrderItems backstops any path that slips through. Idempotent —
 * updateMany/update converge on a replay.
 */
async function markWholeOrderRefunded(orderId: string, paymentId?: string): Promise<void> {
  await prisma.$transaction([
    ...(paymentId
      ? [prisma.payment.update({ where: { id: paymentId }, data: { status: "REFUNDED" } })]
      : []),
    prisma.orderItem.updateMany({ where: { orderId }, data: { status: "REFUNDED" } }),
    prisma.order.update({ where: { id: orderId }, data: { status: "REFUNDED" } }),
  ]);
}

// Dispatcher: a scoped input (shopId + orderItemIds) is a PARTIAL per-shop
// refund and is routed to refundOrderItems; otherwise this is the whole-order
// refund below (unchanged behaviour).
export async function refundOrder(input: RefundInput): Promise<void> {
  if (input.shopId && input.orderItemIds && input.orderItemIds.length > 0) {
    return refundOrderItems({
      orderId: input.orderId,
      shopId: input.shopId,
      orderItemIds: input.orderItemIds,
      reason: input.reason,
    });
  }

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
  if (order.payment.status === "REFUNDED") {
    // Already refunded at the gateway — do NOT re-refund. But the escrow REFUND
    // mirror is a best-effort write that a prior attempt may have failed after
    // flipping Payment→REFUNDED. Re-attempt ONLY the remainder (full total minus
    // anything already refunded, e.g. via per-shop partials) — idempotent on the
    // per-order refund ref — so a retry self-heals the ledger without ever
    // double-counting a prior partial refund.
    try {
      const already = await getRefundedUsdCents(order.id);
      const remainder = order.payment.amountUsdCents - already;
      if (remainder > 0) {
        await refundEscrow({ orderId: order.id, amountUsdCents: remainder, reason: input.reason });
      }
    } catch (err) {
      plog.error({ err, orderId: order.id }, "escrow refund ledger heal failed");
      Sentry.captureException(err, { extra: { orderId: order.id, phase: "escrow-refund-heal" } });
    }
    // Heal item/order status too: a payment flipped REFUNDED elsewhere may have
    // left items ACTIVE, which would let a per-shop dispute double-refund. Idempotent.
    await markWholeOrderRefunded(order.id);
    return;
  }

  // Refund only the REMAINDER not already returned via per-shop partial refunds.
  // refundOrderItems leaves Payment CAPTURED after a partial, so a later
  // whole-order refund is NOT short-circuited by the REFUNDED guard above; without
  // this the gateway would be asked to over-refund and the escrow ledger would
  // double-count the partial (refunded > held → negative stillHeld).
  const alreadyRefunded = await getRefundedUsdCents(order.id);
  const refundable = order.payment.amountUsdCents - alreadyRefunded;
  if (refundable <= 0) {
    // The whole order is already refunded via partials — nothing to send back.
    // Flip Payment→REFUNDED and mark all items/order REFUNDED for consistency; no
    // gateway call, no escrow write.
    await markWholeOrderRefunded(order.id, order.payment.id);
    return;
  }

  await stripeRefund({
    chargeId: order.payment.providerChargeId,
    intentId: order.payment.providerIntentId,
    amountUsdCents: refundable,
    reason: input.reason,
    idempotencyKey: `refund_${order.id}`,
  });

  // Flip Payment→REFUNDED AND mark every item/order REFUNDED atomically. Marking
  // items is what stops a subsequent per-shop dispute (openDispute rejects REFUNDED
  // items) from double-refunding the buyer under the distinct refund_<order>_<shop>
  // key.
  await markWholeOrderRefunded(order.id, order.payment.id);

  // Escrow: record the REFUND (ledger half of the single-refund guarantee) for the
  // remainder. Idempotent on the per-order refund ref, so a concurrent/replayed
  // refund is a no-op. Best-effort — the money already moved at the gateway; a
  // bookkeeping hiccup must not roll it back. Surface failures instead of swallowing.
  try {
    await refundEscrow({ orderId: order.id, amountUsdCents: refundable, reason: input.reason });
  } catch (err) {
    plog.error({ err, orderId: order.id }, "escrow refund ledger write failed");
    Sentry.captureException(err, { extra: { orderId: order.id, phase: "escrow-refund" } });
  }

  // Fire-and-forget refund confirmation to the buyer.
  if (order.buyer?.email) {
    void sendRefundConfirmation(order.buyer.email, {
      orderId: order.id,
      amountUsdCents: refundable,
    }).catch((err) => plog.error({ err, orderId: order.id }, "refund confirmation email failed"));
  }
}

export type RefundItemsInput = {
  orderId: string;
  shopId: string;
  orderItemIds: string[];
  reason?: string;
};

/**
 * PARTIAL, per-shop refund (Wave 2 per-shop disputes): refund ONLY the disputed
 * items' amount = sum(qty * unitPriceUsdCents) for the given items — NOT the
 * whole order. The Stripe refund and the escrow ledger entry are each keyed on a
 * per-(order, shop) idempotency ref (`refund_<order>_<shop>`), DISTINCT from the
 * whole-order `refund_<order>`, so:
 *   - a partial refund never blocks or collides with a different shop's refund
 *     on the same order (multi-shop orders can partially refund independently);
 *   - a worker retry / replay never double-refunds a shop (Stripe dedups on the
 *     key, escrow dedups on the ref, and the OrderItem status guard short-circuits).
 *
 * The disputed items are flipped to OrderItem.status = REFUNDED here (idempotent
 * updateMany scoped to shop + item ids). Payment.status is NOT flipped to
 * REFUNDED — that is reserved for a full-order refund; a partial refund leaves
 * the payment CAPTURED (only some items were returned).
 */
export async function refundOrderItems(input: RefundItemsInput): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
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
      items: {
        where: { shopId: input.shopId, id: { in: input.orderItemIds } },
        select: { id: true, qty: true, unitPriceUsdCents: true, status: true },
      },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (!order.payment) return;
  // Never refund an uncaptured payment (nothing to return at the gateway).
  if (order.payment.status === "PENDING" || order.payment.status === "AUTHORIZED") return;
  // Whole order already fully refunded → the buyer got everything back and every
  // item is REFUNDED. A per-shop partial must NOT hit the gateway again (it uses a
  // DISTINCT refund_<order>_<shop> key, so Stripe wouldn't dedup it). Payment.status
  // is flipped atomically by markWholeOrderRefunded, so it is the reliable stop —
  // unlike the escrow refunded-counter clamp below, whose write is best-effort. The
  // whole-order refund already recorded the full escrow REFUND, so no ledger write here.
  if (order.payment.status === "REFUNDED") {
    plog.info(
      { orderId: order.id, shopId: input.shopId },
      "per-shop refund skipped — whole order already fully refunded",
    );
    return;
  }

  const items = order.items;
  if (items.length === 0) return; // no matching items for this shop — nothing to do

  const amountUsdCents = items.reduce((sum, it) => sum + it.qty * it.unitPriceUsdCents, 0);
  if (amountUsdCents <= 0) return;

  // Idempotency: the per-shop escrow REFUND entry (written only AFTER a successful
  // gateway refund) is the durable "already refunded" signal — NOT OrderItem.status.
  // resolveDispute pre-flips the disputed items to REFUNDED in its committed
  // transaction BEFORE this worker runs, so gating on item status would make the
  // FIRST real refund look like a replay and skip stripeRefund entirely (buyer
  // marked refunded but never actually credited). On a genuine replay the escrow
  // entry exists → skip the gateway (Stripe also dedups on the idempotency key) and
  // just self-heal the ledger.
  const alreadyRefunded = await shopRefundRecorded(order.id, input.shopId);
  if (alreadyRefunded) {
    try {
      await refundShopEscrow({
        orderId: order.id,
        shopId: input.shopId,
        amountUsdCents,
        reason: input.reason,
      });
    } catch (err) {
      plog.error({ err, orderId: order.id, shopId: input.shopId }, "escrow partial-refund ledger heal failed");
      Sentry.captureException(err, {
        extra: { orderId: order.id, shopId: input.shopId, phase: "escrow-partial-refund-heal" },
      });
    }
    return;
  }

  // Over-refund clamp (BUG D / whole-then-partial): a whole-order refund uses a
  // DISTINCT ref (refund_<order>) from this per-shop key, so shopRefundRecorded
  // above won't catch it. If the order's already-refunded total plus this refund
  // would exceed what was captured, a prior whole-order refund already covered these
  // items — refunding again would over-pay the buyer. Skip the gateway, mark the
  // items REFUNDED for consistency, and alert. (Sequential guard; a truly concurrent
  // whole+partial pair still needs DB-level row locking — tracked separately.)
  const alreadyRefundedTotal = await getRefundedUsdCents(order.id);
  if (alreadyRefundedTotal + amountUsdCents > order.payment.amountUsdCents) {
    plog.error(
      {
        orderId: order.id,
        shopId: input.shopId,
        alreadyRefundedTotal,
        amountUsdCents,
        capturedUsdCents: order.payment.amountUsdCents,
      },
      "per-shop refund would exceed captured total — skipping to avoid double refund",
    );
    Sentry.captureException(new Error("REFUND_OVER_RUN_BLOCKED"), {
      extra: { orderId: order.id, shopId: input.shopId, phase: "refund-over-run" },
    });
    await prisma.orderItem.updateMany({
      where: { orderId: order.id, shopId: input.shopId, id: { in: input.orderItemIds } },
      data: { status: "REFUNDED" },
    });
    return;
  }

  // Partial Stripe refund, keyed per (order, shop) so retries never double-pay.
  await stripeRefund({
    chargeId: order.payment.providerChargeId,
    intentId: order.payment.providerIntentId,
    amountUsdCents,
    reason: input.reason,
    idempotencyKey: `refund_${order.id}_${input.shopId}`,
  });

  // Mark the disputed items REFUNDED (scoped; idempotent — a replay updates 0
  // rows once they are already REFUNDED).
  await prisma.orderItem.updateMany({
    where: { orderId: order.id, shopId: input.shopId, id: { in: input.orderItemIds } },
    data: { status: "REFUNDED" },
  });

  // Escrow: record the PARTIAL REFUND (per-shop ref). Best-effort — the money
  // already moved at the gateway; a bookkeeping hiccup must not roll it back.
  try {
    await refundShopEscrow({
      orderId: order.id,
      shopId: input.shopId,
      amountUsdCents,
      reason: input.reason,
    });
  } catch (err) {
    plog.error({ err, orderId: order.id, shopId: input.shopId }, "escrow partial-refund ledger write failed");
    Sentry.captureException(err, {
      extra: { orderId: order.id, shopId: input.shopId, phase: "escrow-partial-refund" },
    });
  }

  // Fire-and-forget partial refund confirmation to the buyer.
  if (order.buyer?.email) {
    void sendRefundConfirmation(order.buyer.email, {
      orderId: order.id,
      amountUsdCents,
    }).catch((err) => plog.error({ err, orderId: order.id }, "partial refund confirmation email failed"));
  }
}
