// Partial per-shop refund + per-shop clawback tests. The escrow ledger is MOCKED
// (its internals are covered in escrow*.test.ts) so we assert the CALLS the money
// path makes. Covers Wave 2:
//   - refundOrderItems issues a PARTIAL Stripe refund of ONLY the disputed items'
//     subtotal, with a per-(order,shop) idempotency key, flips those items to
//     REFUNDED, and records a per-shop escrow REFUND
//   - a replay (items already REFUNDED) does NOT re-hit the gateway (no double
//     refund) but self-heals the escrow ledger
//   - reversePayoutsForOrder(orderId, reason, shopId) reverses ONLY that shop's
//     payout — an innocent shop on the same order is untouched

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    orderItem: { updateMany: vi.fn(), findMany: vi.fn() },
    payout: { findMany: vi.fn(), update: vi.fn() },
    payoutReversal: { create: vi.fn() },
    bankAccount: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/escrow", () => ({
  holdEscrow: vi.fn(() => Promise.resolve()),
  releaseEscrow: vi.fn(() => Promise.resolve(true)),
  refundEscrow: vi.fn(() => Promise.resolve(true)),
  refundShopEscrow: vi.fn(() => Promise.resolve(true)),
  reverseReleaseEscrow: vi.fn(() => Promise.resolve(true)),
  reverseReleaseEscrowToTarget: vi.fn(() => Promise.resolve(true)),
  shopRefundRecorded: vi.fn(() => Promise.resolve(false)),
  getRefundedUsdCents: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("@/lib/stubs", () => ({
  stripeRefund: vi.fn(() => Promise.resolve({ refundId: "re_1", status: "succeeded" })),
  razorpayCreatePayout: vi.fn(() => Promise.resolve({ payoutId: "pout_1", status: "processing" })),
}));
vi.mock("@/lib/providers/razorpay", () => ({
  razorpayReversePayout: vi.fn(() => Promise.resolve({ reversalRef: "rev_1" })),
}));
vi.mock("@/lib/fx", () => ({ usdCentsToInrPaiseAt: vi.fn((usd: number) => usd * 80) }));
vi.mock("@/lib/fees", () => ({ shopNetUsdCents: vi.fn((s: number) => s) }));
vi.mock("@/lib/buyer-protection", () => ({ createBuyerProtection: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/trust-score", () => ({ enqueueTrustRecompute: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: vi.fn(() => Promise.resolve({ sent: true })),
  sendRefundConfirmation: vi.fn(() => Promise.resolve({ sent: true })),
  sendPayoutNotification: vi.fn(() => Promise.resolve({ sent: true })),
}));
vi.mock("@/lib/queue", () => ({ getQueue: vi.fn(() => ({ add: vi.fn() })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import { refundOrderItems } from "@/lib/payments";
import { reversePayoutsForOrder } from "@/lib/payouts";
import { prisma } from "@/lib/db";
import { stripeRefund } from "@/lib/stubs";
import {
  refundShopEscrow,
  reverseReleaseEscrow,
  reverseReleaseEscrowToTarget,
  shopRefundRecorded,
  getRefundedUsdCents,
} from "@/lib/escrow";
import { razorpayReversePayout } from "@/lib/providers/razorpay";

const db = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn> };
  orderItem: { updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  payout: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  payoutReversal: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => unknown)(prisma) : Promise.resolve(arg),
  );
  db.orderItem.updateMany.mockResolvedValue({ count: 2 });
  db.payout.update.mockResolvedValue({});
  db.payoutReversal.create.mockResolvedValue({});
});

afterEach(() => vi.clearAllMocks());

describe("refundOrderItems — partial per-shop refund", () => {
  // shopA items: a1 (2 x 1000) + a2 (1 x 500) = 2500 buyer-side cents.
  function shopAOrder(itemStatus = "ACTIVE") {
    return {
      id: "order_1",
      buyer: { email: "buyer@example.com" },
      payment: {
        id: "pay_1",
        status: "CAPTURED",
        providerChargeId: "ch_1",
        providerIntentId: "pi_1",
        amountUsdCents: 10_000,
      },
      items: [
        { id: "a1", qty: 2, unitPriceUsdCents: 1000, status: itemStatus },
        { id: "a2", qty: 1, unitPriceUsdCents: 500, status: itemStatus },
      ],
    };
  }

  it("refunds only the disputed items' subtotal with a per-shop idempotency key", async () => {
    db.order.findUnique.mockResolvedValue(shopAOrder());

    await refundOrderItems({
      orderId: "order_1",
      shopId: "shopA",
      orderItemIds: ["a1", "a2"],
      reason: "damaged",
    });

    // PARTIAL Stripe refund of A's subtotal (2500), keyed per (order, shop).
    expect(stripeRefund).toHaveBeenCalledTimes(1);
    expect(stripeRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        amountUsdCents: 2500,
        idempotencyKey: "refund_order_1_shopA",
      }),
    );
    // Only shopA's items flip to REFUNDED.
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order_1", shopId: "shopA", id: { in: ["a1", "a2"] } },
      data: { status: "REFUNDED" },
    });
    // Escrow records the PARTIAL refund keyed per shop.
    expect(refundShopEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", shopId: "shopA", amountUsdCents: 2500 }),
    );
  });

  it("does NOT re-refund on replay (items already REFUNDED) but self-heals escrow", async () => {
    db.order.findUnique.mockResolvedValue(shopAOrder("REFUNDED"));
    // The durable "already refunded" signal is the per-shop escrow entry, NOT
    // OrderItem.status — a replay finds it recorded and skips the gateway.
    vi.mocked(shopRefundRecorded).mockResolvedValueOnce(true);

    await refundOrderItems({
      orderId: "order_1",
      shopId: "shopA",
      orderItemIds: ["a1", "a2"],
      reason: "damaged",
    });

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
    // Ledger heal still runs (idempotent on the per-shop ref).
    expect(refundShopEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", shopId: "shopA", amountUsdCents: 2500 }),
    );
  });

  it("does NOT re-refund when a whole-order refund already covered the total (over-refund clamp)", async () => {
    db.order.findUnique.mockResolvedValue(shopAOrder());
    // The order's already-refunded total equals the captured amount — a prior
    // whole-order refund (distinct ref) covered everything.
    vi.mocked(getRefundedUsdCents).mockResolvedValueOnce(10_000);

    await refundOrderItems({
      orderId: "order_1",
      shopId: "shopA",
      orderItemIds: ["a1", "a2"],
      reason: "dispute after chargeback",
    });

    // Gateway is skipped (no double-pay) and no new escrow refund is recorded...
    expect(stripeRefund).not.toHaveBeenCalled();
    expect(refundShopEscrow).not.toHaveBeenCalled();
    // ...but the items are still marked REFUNDED for consistency.
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order_1", shopId: "shopA", id: { in: ["a1", "a2"] } },
      data: { status: "REFUNDED" },
    });
  });

  it("hard-stops (no gateway, no ledger) when the whole order is already REFUNDED", async () => {
    // A whole-order refund already returned everything and flipped Payment→REFUNDED
    // (reliable even if its best-effort escrow write failed). A per-shop partial must
    // not fire a second gateway refund under the distinct refund_<order>_<shop> key.
    const order = shopAOrder();
    order.payment.status = "REFUNDED";
    db.order.findUnique.mockResolvedValue(order);

    await refundOrderItems({
      orderId: "order_1",
      shopId: "shopA",
      orderItemIds: ["a1", "a2"],
      reason: "dispute resolved after full chargeback",
    });

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(refundShopEscrow).not.toHaveBeenCalled();
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it("is a no-op when no matching items exist for the shop", async () => {
    db.order.findUnique.mockResolvedValue({ ...shopAOrder(), items: [] });

    await refundOrderItems({
      orderId: "order_1",
      shopId: "shopA",
      orderItemIds: ["a1"],
      reason: "x",
    });

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(refundShopEscrow).not.toHaveBeenCalled();
  });
});

describe("reversePayoutsForOrder — per-shop clawback", () => {
  // fx mock is identity*80; shopNetUsdCents is identity. So a shop's disbursed
  // amountInrPaise == (shop subtotal in USD cents) * 80.

  it("FULL clawback when the whole shop is disputed (no items left ACTIVE)", async () => {
    db.order.findUnique.mockResolvedValue({ fxRate: 80 });
    // Every one of shopA's items is REFUNDED → remaining ACTIVE net 0 → full clawback.
    db.orderItem.findMany.mockResolvedValue([
      { qty: 1, unitPriceUsdCents: 1000, status: "REFUNDED" },
    ]);
    // First findMany: active payouts to reverse (scoped to shopA). Second: the
    // already-REVERSED sweep (also scoped).
    db.payout.findMany
      .mockResolvedValueOnce([
        { id: "pA", shopId: "shopA", amountInrPaise: 80_000, razorpayPayoutId: "po_A" },
      ])
      .mockResolvedValueOnce([]);

    const { reversed } = await reversePayoutsForOrder("order_1", "dispute A", "shopA");

    expect(reversed).toBe(1);
    // The query is scoped to shopA (won't touch shopB's payout).
    expect(db.payout.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ orderId: "order_1", shopId: "shopA" }),
      }),
    );
    // Whole payout reversed at the gateway; payout flipped REVERSED; full escrow reversal.
    expect(razorpayReversePayout).toHaveBeenCalledTimes(1);
    expect(razorpayReversePayout).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: "po_A", amountInrPaise: 80_000 }),
    );
    expect(db.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pA" }, data: expect.objectContaining({ status: "REVERSED" }) }),
    );
    expect(reverseReleaseEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", shopId: "shopA" }),
    );
    expect(reverseReleaseEscrowToTarget).not.toHaveBeenCalled();
  });

  it("PARTIAL clawback when only a subset is disputed — seller keeps the undisputed net", async () => {
    // shopA disbursed $100 (amountInrPaise 800000). Buyer disputed $50 (a2 REFUNDED);
    // a1 ($50) stays ACTIVE → remaining net $50 → claw back only $50 (400000 paise).
    db.order.findUnique.mockResolvedValue({ fxRate: 80 });
    db.orderItem.findMany.mockResolvedValue([
      { qty: 1, unitPriceUsdCents: 5000, status: "ACTIVE" },
      { qty: 1, unitPriceUsdCents: 5000, status: "REFUNDED" },
    ]);
    db.payout.findMany
      .mockResolvedValueOnce([
        { id: "pA", shopId: "shopA", amountInrPaise: 800_000, razorpayPayoutId: "po_A" },
      ])
      .mockResolvedValueOnce([]);

    const { reversed } = await reversePayoutsForOrder("order_1", "dispute A", "shopA");

    expect(reversed).toBe(1);
    // Only the disputed portion is reversed at the gateway.
    expect(razorpayReversePayout).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: "po_A", amountInrPaise: 400_000 }),
    );
    // Payout stays live with the amount reduced to what the seller keeps (NOT REVERSED).
    expect(db.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pA" }, data: { amountInrPaise: 400_000 } }),
    );
    // Escrow release netted DOWN TO the remaining $50 net — not zeroed.
    expect(reverseReleaseEscrowToTarget).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1", shopId: "shopA", targetUsdCents: 5000 }),
    );
    expect(reverseReleaseEscrow).not.toHaveBeenCalled();
  });

  it("whole-order behaviour is preserved when shopId is omitted (back-compat)", async () => {
    db.payout.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await reversePayoutsForOrder("order_1", "full chargeback");

    // No shopId in the where clause → all shops in scope (unchanged default).
    const firstCall = db.payout.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(firstCall.where).not.toHaveProperty("shopId");
  });
});
