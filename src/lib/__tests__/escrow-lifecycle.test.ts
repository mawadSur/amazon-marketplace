// Wiring tests for the escrow lifecycle across the money path. The escrow ledger
// module (src/lib/escrow.ts) is MOCKED here so we assert the CALLS the money
// path makes (its internal correctness is covered in escrow.test.ts). Covers:
//   - markPaymentCaptured records a HOLD inside the capture transaction
//   - a replayed/no-op capture records NO hold (no double-hold)
//   - enqueuePayouts records a RELEASE for each shop's net portion at delivery
//   - refundOrder records a REFUND and is single/idempotent (the dispute path
//     fires both a direct refund AND resolveBuyerProtection('PAID') — one refund)
//   - a standalone buyer-protection PAID routes through the one refund path

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────
vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    orderItem: { updateMany: vi.fn() },
    payment: { update: vi.fn() },
    product: { updateMany: vi.fn() },
    processedWebhookEvent: { findUnique: vi.fn(), create: vi.fn() },
    payout: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    payoutReversal: { create: vi.fn() },
    bankAccount: { findUnique: vi.fn() },
    buyerProtection: { findUnique: vi.fn(), update: vi.fn() },
    dispute: { count: vi.fn(() => Promise.resolve(0)) },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/escrow", () => ({
  holdEscrow: vi.fn(),
  releaseEscrow: vi.fn(() => Promise.resolve(true)),
  refundEscrow: vi.fn(() => Promise.resolve(true)),
  reverseReleaseEscrow: vi.fn(() => Promise.resolve(true)),
  getRefundedUsdCents: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("@/lib/trust-score", () => ({ enqueueTrustRecompute: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(() => Promise.resolve({ sent: true })),
  sendRefundConfirmation: vi.fn(() => Promise.resolve({ sent: true })),
  sendPayoutNotification: vi.fn(() => Promise.resolve({ sent: true })),
}));
vi.mock("@/lib/stubs", () => ({
  stripeRefund: vi.fn(() => Promise.resolve({ refundId: "re_test", status: "succeeded" })),
  razorpayCreatePayout: vi.fn(() => Promise.resolve({ payoutId: "pout_1", status: "processing" })),
}));
vi.mock("@/lib/providers/razorpay", () => ({ razorpayReversePayout: vi.fn() }));
vi.mock("@/lib/fx", () => ({ usdCentsToInrPaiseAt: vi.fn((usd: number) => usd * 80) }));
vi.mock("@/lib/fees", () => ({ shopNetUsdCents: vi.fn((subtotal: number) => subtotal) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

const queueAdd = vi.fn(() => Promise.resolve(undefined));
vi.mock("@/lib/queue", () => ({ getQueue: vi.fn(() => ({ add: queueAdd })) }));

import { markPaymentCaptured, refundOrder, enqueueRefund } from "@/lib/payments";
import { enqueuePayouts, markPayoutFailed, reversePayoutsForOrder } from "@/lib/payouts";
import { resolveBuyerProtection } from "@/lib/buyer-protection";
import { prisma } from "@/lib/db";
import { holdEscrow, releaseEscrow, refundEscrow, reverseReleaseEscrow } from "@/lib/escrow";
import { razorpayReversePayout } from "@/lib/providers/razorpay";
import { stripeRefund } from "@/lib/stubs";

const db = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  payment: { update: ReturnType<typeof vi.fn> };
  product: { updateMany: ReturnType<typeof vi.fn> };
  processedWebhookEvent: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  payout: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  payoutReversal: { create: ReturnType<typeof vi.fn> };
  bankAccount: { findUnique: ReturnType<typeof vi.fn> };
  buyerProtection: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

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
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]),
  );
  db.processedWebhookEvent.findUnique.mockResolvedValue(null);
  db.processedWebhookEvent.create.mockResolvedValue({});
  db.order.updateMany.mockResolvedValue({ count: 1 });
  db.payment.update.mockResolvedValue({});
  db.product.updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => vi.clearAllMocks());

describe("markPaymentCaptured — records the escrow HOLD", () => {
  it("holds the full order total inside the capture transaction", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());

    await markPaymentCaptured({ orderId: "order_1", capturedAmountUsdCents: 10_000, capturedCurrency: "usd" });

    // Called with the tx client (=== prisma here) and the full total.
    expect(holdEscrow).toHaveBeenCalledTimes(1);
    expect(holdEscrow).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ orderId: "order_1", amountUsdCents: 10_000 }),
    );
  });

  it("does NOT hold when the order is already captured (no double-hold)", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder({ status: "PAID" }));
    db.order.updateMany.mockResolvedValue({ count: 0 }); // conditional flip matched nothing

    await markPaymentCaptured({ orderId: "order_1" });

    expect(holdEscrow).not.toHaveBeenCalled();
  });

  it("does NOT hold when the webhook event was already processed", async () => {
    db.order.findUnique.mockResolvedValue(placedOrder());
    db.processedWebhookEvent.findUnique.mockResolvedValue({ id: "evt_1" });

    await markPaymentCaptured({ orderId: "order_1", eventId: "evt_1" });

    expect(holdEscrow).not.toHaveBeenCalled();
  });
});

describe("enqueuePayouts — creates HELD payouts at delivery (no release yet)", () => {
  it("creates a PENDING payout with eligibleAt and does NOT release escrow", async () => {
    const deliveredAt = new Date("2026-01-01T00:00:00Z");
    db.order.findUnique.mockResolvedValue({
      id: "order_1",
      fxRate: 80,
      deliveredAt,
      items: [{ id: "oi1", shopId: "shopA", qty: 2, unitPriceUsdCents: 1_000 }],
    });
    db.payout.findUnique.mockResolvedValue(null);
    db.payout.create.mockResolvedValue({ id: "payout_1" });

    await enqueuePayouts("order_1");

    // Held payout: PENDING, eligibleAt = deliveredAt, amount = 2*1000 * 80.
    expect(db.payout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopId: "shopA",
          status: "PENDING",
          amountInrPaise: 160_000,
          eligibleAt: deliveredAt,
        }),
      }),
    );
    // Platform-holds-then-distributes: NO escrow RELEASE at delivery.
    expect(releaseEscrow).not.toHaveBeenCalled();
  });

  it("is idempotent — an existing held payout is left untouched (no double-pay)", async () => {
    db.order.findUnique.mockResolvedValue({
      id: "order_1",
      fxRate: 80,
      deliveredAt: new Date("2026-01-01T00:00:00Z"),
      items: [{ id: "oi1", shopId: "shopA", qty: 2, unitPriceUsdCents: 1_000 }],
    });
    db.payout.findUnique.mockResolvedValue({ id: "payout_1" });

    await enqueuePayouts("order_1");

    expect(db.payout.create).not.toHaveBeenCalled();
    expect(releaseEscrow).not.toHaveBeenCalled();
  });
});

describe("markPayoutFailed — nets the phantom RELEASE back down", () => {
  it("reverses the escrow release when a disbursement fails", async () => {
    db.payout.findFirst.mockResolvedValue({
      id: "payout_1",
      status: "PROCESSING",
      orderId: "order_1",
      shopId: "shopA",
      amountInrPaise: 1_000,
    });
    db.payout.update.mockResolvedValue({});

    await markPayoutFailed({ payoutId: "payout_1", reason: "bank rejected" });

    expect(db.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }),
    );
    // Seller got nothing → net the prior RELEASE back down.
    expect(reverseReleaseEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", shopId: "shopA" }),
    );
  });

  it("ignores an already-REVERSED payout (terminal guard, no escrow write)", async () => {
    db.payout.findFirst.mockResolvedValue({
      id: "payout_1",
      status: "REVERSED",
      orderId: "order_1",
      shopId: "shopA",
    });

    await markPayoutFailed({ payoutId: "payout_1" });

    expect(db.payout.update).not.toHaveBeenCalled();
    expect(reverseReleaseEscrow).not.toHaveBeenCalled();
  });
});

describe("reversePayoutsForOrder — self-heals a missing escrow reversal on re-run", () => {
  it("re-attempts the release reversal for an already-REVERSED payout", async () => {
    // No PROCESSING/PAID payouts left (the clawback already flipped them), but a
    // prior run's best-effort escrow reversal may have failed — the sweep heals it.
    db.payout.findMany
      .mockResolvedValueOnce([]) // active payouts to reverse now
      .mockResolvedValueOnce([{ shopId: "shopA" }]); // already-REVERSED sweep

    const { reversed } = await reversePayoutsForOrder("order_1", "dispute");

    expect(reversed).toBe(0);
    expect(razorpayReversePayout).not.toHaveBeenCalled();
    expect(reverseReleaseEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", shopId: "shopA" }),
    );
  });
});

describe("refundOrder — records a REFUND and is single/idempotent", () => {
  function capturedOrder(status = "CAPTURED") {
    return {
      id: "order_1",
      status: status === "REFUNDED" ? "REFUNDED" : "PAID",
      buyer: { email: "buyer@example.com" },
      payment: {
        id: "pay_1",
        status,
        providerChargeId: "ch_1",
        providerIntentId: "pi_1",
        amountUsdCents: 10_000,
      },
    };
  }

  it("refunds once and records the escrow REFUND", async () => {
    db.order.findUnique.mockResolvedValue(capturedOrder());

    await refundOrder({ orderId: "order_1", reason: "dispute" });

    expect(stripeRefund).toHaveBeenCalledTimes(1);
    expect(refundEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", amountUsdCents: 10_000 }),
    );
  });

  it("dispute path fires TWO refund attempts but money moves ONCE", async () => {
    // Attempt 1 sees a CAPTURED payment; after it flips REFUNDED, attempt 2 (the
    // resolveBuyerProtection('PAID') side) sees REFUNDED and no-ops.
    db.order.findUnique
      .mockResolvedValueOnce(capturedOrder("CAPTURED"))
      .mockResolvedValueOnce(capturedOrder("REFUNDED"));

    await refundOrder({ orderId: "order_1", reason: "dispute" }); // direct enqueueRefund → worker
    await refundOrder({ orderId: "order_1", reason: "dispute" }); // buyer-protection PAID → worker

    // Real money moves ONCE: the gateway refund and the Payment→REFUNDED flip
    // each happen a single time.
    expect(stripeRefund).toHaveBeenCalledTimes(1);
    expect(db.payment.update).toHaveBeenCalledTimes(1);
    // The escrow REFUND mirror is idempotent (per-order refund ref): the second,
    // already-REFUNDED attempt re-invokes it to SELF-HEAL a possibly-missing
    // ledger write, and the duplicate ref makes it a no-op — so no double-refund.
    expect(refundEscrow).toHaveBeenCalledTimes(2);
  });
});

describe("resolveBuyerProtection('PAID') — one refund via the single path", () => {
  it("standalone claim routes to enqueueRefund (no second refund mechanism)", async () => {
    db.buyerProtection.findUnique.mockResolvedValue({ id: "bp_1", status: "CLAIMED" });
    db.buyerProtection.update.mockResolvedValue({});

    await resolveBuyerProtection("order_1", "PAID", "approved");

    // Flips the protection status...
    expect(db.buyerProtection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }),
    );
    // ...and enqueues exactly one refund on the shared payments.refund queue.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "refund",
      expect.objectContaining({ orderId: "order_1" }),
      expect.any(Object),
    );
  });

  it("DENIED moves no money", async () => {
    db.buyerProtection.findUnique.mockResolvedValue({ id: "bp_1", status: "CLAIMED" });
    db.buyerProtection.update.mockResolvedValue({});

    await resolveBuyerProtection("order_1", "DENIED", "rejected");

    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("already-resolved protection is a no-op (no refund enqueued)", async () => {
    db.buyerProtection.findUnique.mockResolvedValue({ id: "bp_1", status: "PAID" });

    await resolveBuyerProtection("order_1", "PAID", "approved again");

    expect(db.buyerProtection.update).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

// Re-export sanity: enqueueRefund is still on the payments public surface.
describe("public surface unchanged", () => {
  it("enqueueRefund still enqueues a refund job", async () => {
    await enqueueRefund({ orderId: "order_9", reason: "x" });
    expect(queueAdd).toHaveBeenCalledWith(
      "refund",
      expect.objectContaining({ orderId: "order_9" }),
      expect.any(Object),
    );
  });
});
