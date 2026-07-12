// Unit tests for the money path in src/lib/payments.ts — capture idempotency /
// concurrency and refund idempotency — against a MOCKED Prisma client (no live
// DB required; the suite runs with the placeholder DATABASE_URL from
// vitest.config.ts). These exercise the branch logic of the atomic PLACED→PAID
// transition, the webhook-event ledger, the conditional inventory decrement, and
// the idempotency-keyed refund.
//
// COVERAGE NOTE: these tests target branch behaviour, not line coverage. The
// project already has `test:coverage` (v8) wired but NO enforced threshold, and
// this suite intentionally does not add one — the DB/queue/worker seams
// (recomputeTrustScore persistence, avatar worker, real gateway calls) are only
// reachable in the P1-15 integration runner, so a hard global threshold here
// would fail CI for code that is untestable without a test DB. Leaving the
// threshold decision to a human once that integration runner lands.

import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted by vitest) ──────────────────────────────────────────────
vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    orderItem: { updateMany: vi.fn() },
    payment: { update: vi.fn() },
    product: { updateMany: vi.fn() },
    processedWebhookEvent: { findUnique: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/queue", () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock("@/lib/buyer-protection", () => ({ createBuyerProtection: vi.fn() }));
// Escrow ledger is exercised in escrow.test.ts / escrow-lifecycle.test.ts; here
// it's mocked so the capture/refund branch logic is tested in isolation.
vi.mock("@/lib/escrow", () => ({
  holdEscrow: vi.fn(() => Promise.resolve()),
  refundEscrow: vi.fn(() => Promise.resolve(true)),
  getRefundedUsdCents: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("@/lib/trust-score", () => ({ enqueueTrustRecompute: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(() => Promise.resolve({ sent: true })),
  sendRefundConfirmation: vi.fn(() => Promise.resolve({ sent: true })),
}));
vi.mock("@/lib/stubs", () => ({
  stripeRefund: vi.fn(() => Promise.resolve({ refundId: "re_test", status: "succeeded" })),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import { markPaymentCaptured, refundOrder } from "@/lib/payments";
import { prisma } from "@/lib/db";
import { getQueue } from "@/lib/queue";
import { enqueueTrustRecompute } from "@/lib/trust-score";
import { createBuyerProtection } from "@/lib/buyer-protection";
import { sendOrderConfirmation, sendRefundConfirmation } from "@/lib/email";
import { stripeRefund } from "@/lib/stubs";
import * as Sentry from "@sentry/nextjs";

const db = prisma as unknown as {
  order: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  orderItem: { updateMany: ReturnType<typeof vi.fn> };
  payment: { update: ReturnType<typeof vi.fn> };
  product: { updateMany: ReturnType<typeof vi.fn> };
  processedWebhookEvent: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

// A capturable order fixture (PLACED, one line item, payment present).
function placedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    status: "PLACED",
    currency: "usd",
    totalUsdCents: 10_000,
    buyer: { email: "buyer@example.com" },
    payment: { id: "pay_1", status: "AUTHORIZED" },
    items: [{ productId: "prod_1", qty: 2, shopId: "shop_1" }],
    ...overrides,
  };
}

beforeEach(() => {
  // Default: $transaction runs its callback with the mocked client as `tx`
  // (tx === prisma), so all the tx.* calls hit the same configured mocks.
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as unknown[]),
  );
  db.processedWebhookEvent.findUnique.mockResolvedValue(null);
  db.processedWebhookEvent.create.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.payment.update.mockResolvedValue({});
  db.product.updateMany.mockResolvedValue({ count: 1 });
  (createBuyerProtection as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (enqueueTrustRecompute as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("markPaymentCaptured — happy path", () => {
  it("transitions PLACED→PAID, captures payment, decrements inventory, and fires side-effects", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());

    await markPaymentCaptured({
      orderId: "order_1",
      capturedAmountUsdCents: 10_000,
      capturedCurrency: "usd",
      providerChargeId: "ch_1",
    });

    // Atomic guard: the update is conditioned on status PLACED.
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "order_1", status: "PLACED" } }),
    );
    // Payment flipped to CAPTURED.
    expect(db.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay_1" },
        data: expect.objectContaining({ status: "CAPTURED" }),
      }),
    );
    // Inventory decremented conditionally (guarded on gte qty).
    expect(db.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "prod_1", inventory: { gte: 2 } },
        data: { inventory: { decrement: 2 } },
      }),
    );
    // Side-effects fire exactly once.
    expect(createBuyerProtection).toHaveBeenCalledTimes(1);
    expect(enqueueTrustRecompute).toHaveBeenCalledWith("shop_1");
    expect(sendOrderConfirmation).toHaveBeenCalledWith(
      "buyer@example.com",
      expect.objectContaining({ orderId: "order_1", totalUsdCents: 10_000 }),
    );
    // Payouts are HELD until delivery — capture must not enqueue a payout.
    expect(getQueue).not.toHaveBeenCalledWith("payouts.disburse");
  });
});

describe("markPaymentCaptured — idempotency & concurrency", () => {
  it("is a no-op when the order is no longer in PLACED (already captured)", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder({ status: "PAID" }));
    // The conditional updateMany matches 0 rows for a non-PLACED order.
    db.order.updateMany.mockResolvedValue({ count: 0 });

    await markPaymentCaptured({ orderId: "order_1" });

    expect(db.payment.update).not.toHaveBeenCalled();
    expect(db.product.updateMany).not.toHaveBeenCalled();
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
    expect(enqueueTrustRecompute).not.toHaveBeenCalled();
  });

  it("loses the race safely — second concurrent caller finds count===0 and does nothing", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());
    // First caller wins the PLACED→PAID flip, second sees 0 rows affected.
    db.order.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await markPaymentCaptured({ orderId: "order_1" });
    await markPaymentCaptured({ orderId: "order_1" });

    // Only the winning call captured + decremented — no double-capture.
    expect(db.payment.update).toHaveBeenCalledTimes(1);
    expect(db.product.updateMany).toHaveBeenCalledTimes(1);
    expect(sendOrderConfirmation).toHaveBeenCalledTimes(1);
  });

  it("treats a previously-seen webhook event as processed (ledger hit → no capture)", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());
    db.processedWebhookEvent.findUnique.mockResolvedValue({ id: "evt_1" });

    await markPaymentCaptured({ orderId: "order_1", eventId: "evt_1" });

    expect(db.processedWebhookEvent.create).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
  });

  it("records the webhook event id in the ledger inside the capture transaction", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());

    await markPaymentCaptured({ orderId: "order_1", eventId: "evt_new", provider: "stripe" });

    expect(db.processedWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: "evt_new", provider: "stripe", orderId: "order_1" }),
      }),
    );
    expect(db.payment.update).toHaveBeenCalledTimes(1);
  });

  it("swallows a duplicate-event PK collision (P2002) as already-processed, without throwing", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());
    db.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5.22.0" }),
    );

    await expect(
      markPaymentCaptured({ orderId: "order_1", eventId: "evt_dup" }),
    ).resolves.toBeUndefined();

    // No side-effects run when the transition never happened.
    expect(db.product.updateMany).not.toHaveBeenCalled();
    expect(sendOrderConfirmation).not.toHaveBeenCalled();
  });

  it("rethrows non-P2002 transaction errors", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());
    db.$transaction.mockRejectedValue(new Error("db down"));

    await expect(markPaymentCaptured({ orderId: "order_1" })).rejects.toThrow("db down");
  });
});

describe("markPaymentCaptured — verification (fail-closed)", () => {
  it("refuses capture on an amount mismatch and never opens a transaction", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder({ totalUsdCents: 10_000 }));

    await markPaymentCaptured({ orderId: "order_1", capturedAmountUsdCents: 9_999 });

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it("refuses capture on a currency mismatch", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder({ currency: "usd" }));

    await markPaymentCaptured({ orderId: "order_1", capturedCurrency: "inr" });

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it("throws ORDER_NOT_FOUND for an unknown order", async () => {
    db.order.findUnique.mockResolvedValue(null);
    await expect(markPaymentCaptured({ orderId: "missing" })).rejects.toThrow("ORDER_NOT_FOUND");
  });

  it("throws PAYMENT_MISSING when the order has no payment row", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder({ payment: null }));
    await expect(markPaymentCaptured({ orderId: "order_1" })).rejects.toThrow("PAYMENT_MISSING");
  });
});

describe("markPaymentCaptured — inventory shortfall", () => {
  it("enqueues a refund + alerts when the conditional decrement affects 0 rows (oversold)", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());
    // Stock vanished mid-flight: guarded updateMany is a no-op.
    db.product.updateMany.mockResolvedValue({ count: 0 });
    const add = vi.fn().mockResolvedValue(undefined);
    (getQueue as ReturnType<typeof vi.fn>).mockReturnValue({ add });

    await markPaymentCaptured({ orderId: "order_1" });

    // Refund enqueued onto the payments.refund queue (never silently swallowed).
    expect(getQueue).toHaveBeenCalledWith("payments.refund");
    expect(add).toHaveBeenCalledWith(
      "refund",
      expect.objectContaining({ orderId: "order_1" }),
      expect.any(Object),
    );
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe("refundOrder — idempotency", () => {
  it("calls the gateway with a stable per-order idempotency key, then flips REFUNDED", async () => {
    db.order.findUnique.mockResolvedValue({
      id: "order_1",
      status: "PAID",
      buyer: { email: "buyer@example.com" },
      payment: {
        id: "pay_1",
        status: "CAPTURED",
        providerChargeId: "ch_1",
        providerIntentId: "pi_1",
        amountUsdCents: 10_000,
      },
    });

    await refundOrder({ orderId: "order_1", reason: "damaged" });

    expect(stripeRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        chargeId: "ch_1",
        intentId: "pi_1",
        amountUsdCents: 10_000,
        idempotencyKey: "refund_order_1", // stable across worker retries
      }),
    );
    expect(db.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pay_1" }, data: { status: "REFUNDED" } }),
    );
    expect(sendRefundConfirmation).toHaveBeenCalledWith(
      "buyer@example.com",
      expect.objectContaining({ orderId: "order_1", amountUsdCents: 10_000 }),
    );
  });

  it("marks EVERY item + the order REFUNDED so a later per-shop dispute can't double-refund", async () => {
    db.order.findUnique.mockResolvedValue({
      id: "order_1",
      status: "PAID",
      buyer: { email: "buyer@example.com" },
      payment: {
        id: "pay_1",
        status: "CAPTURED",
        providerChargeId: "ch_1",
        providerIntentId: "pi_1",
        amountUsdCents: 10_000,
      },
    });

    await refundOrder({ orderId: "order_1", reason: "chargeback" });

    // Whole-order refund flips all items REFUNDED (openDispute then rejects them).
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order_1" },
      data: { status: "REFUNDED" },
    });
    expect(db.order.update).toHaveBeenCalledWith({
      where: { id: "order_1" },
      data: { status: "REFUNDED" },
    });
  });

  it("is a no-op when the payment is already REFUNDED (never double-refunds)", async () => {
    db.order.findUnique.mockResolvedValue({
      id: "order_1",
      status: "REFUNDED",
      buyer: { email: "buyer@example.com" },
      payment: {
        id: "pay_1",
        status: "REFUNDED",
        providerChargeId: "ch_1",
        providerIntentId: "pi_1",
        amountUsdCents: 10_000,
      },
    });

    await refundOrder({ orderId: "order_1" });

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(db.payment.update).not.toHaveBeenCalled();
    expect(sendRefundConfirmation).not.toHaveBeenCalled();
  });

  it("returns quietly when the order has no payment row", async () => {
    db.order.findUnique.mockResolvedValue({
      id: "order_1",
      status: "PLACED",
      buyer: { email: "buyer@example.com" },
      payment: null,
    });

    await refundOrder({ orderId: "order_1" });
    expect(stripeRefund).not.toHaveBeenCalled();
  });

  it("throws ORDER_NOT_FOUND for an unknown order", async () => {
    db.order.findUnique.mockResolvedValue(null);
    await expect(refundOrder({ orderId: "missing" })).rejects.toThrow("ORDER_NOT_FOUND");
  });
});
