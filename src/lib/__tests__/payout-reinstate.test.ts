// Tests for reinstatePayoutForShop (src/lib/payout-clawback.ts) — the Wave 2
// seller-favored-dispute recovery. When a hold-window dispute cancels a shop's
// payout and then resolves SELLER, the vindicated seller must be re-paid. The
// money-path deps are MOCKED; we assert the DB writes the function makes.
//
//   - a payout CANCELLED PRE-DISBURSEMENT (REVERSED, never sent to the gateway) is
//     resurrected to PENDING with the recomputed net + fresh hold window
//   - a still-PENDING payout is a no-op (the batch self-corrects)
//   - nothing owed (no ACTIVE items) is a no-op
//   - a payout already DISBURSED can't be safely topped up → manual-review alert

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    orderItem: { findMany: vi.fn() },
    payout: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/providers/razorpay", () => ({ razorpayReversePayout: vi.fn() }));
vi.mock("@/lib/escrow", () => ({
  reverseReleaseEscrow: vi.fn(() => Promise.resolve(true)),
  reverseReleaseEscrowToTarget: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/lib/fx", () => ({ usdCentsToInrPaiseAt: vi.fn((usd: number) => usd * 80) }));
vi.mock("@/lib/fees", () => ({ shopNetUsdCents: vi.fn((s: number) => s) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import { reinstatePayoutForShop } from "@/lib/payout-clawback";
import { prisma } from "@/lib/db";
import * as Sentry from "@sentry/nextjs";

const db = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn> };
  orderItem: { findMany: ReturnType<typeof vi.fn> };
  payout: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

const DELIVERED = new Date("2026-06-01T00:00:00Z");

beforeEach(() => {
  db.order.findUnique.mockResolvedValue({ fxRate: 80, deliveredAt: DELIVERED });
  // Default: one ACTIVE $50 item still owed to the shop.
  db.orderItem.findMany.mockResolvedValue([
    { id: "a1", qty: 1, unitPriceUsdCents: 5000, status: "ACTIVE" },
  ]);
  db.payout.updateMany.mockResolvedValue({ count: 1 });
  db.payout.create.mockResolvedValue({ id: "new_payout", amountInrPaise: 400_000 });
});

afterEach(() => vi.clearAllMocks());

describe("reinstatePayoutForShop", () => {
  it("resurrects a pre-disbursement CANCELLED payout back to PENDING with the owed net", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "p1",
      status: "REVERSED",
      razorpayPayoutId: null,
      disbursedAt: null,
    });

    const res = await reinstatePayoutForShop("order_1", "shopA");

    expect(res).toEqual({ status: "reinstated", payoutId: "p1", amountInrPaise: 400_000 });
    // Guarded on the exact never-disbursed shape so a racing disbursement isn't clobbered.
    expect(db.payout.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", status: "REVERSED", razorpayPayoutId: null, disbursedAt: null },
      data: expect.objectContaining({
        status: "PENDING",
        amountInrPaise: 400_000, // $50 * 80
        orderItemIds: ["a1"],
        reversedAt: null,
        reversalId: null,
      }),
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("is a no-op when the payout is still PENDING (the batch will recompute)", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "p1",
      status: "PENDING",
      razorpayPayoutId: null,
      disbursedAt: null,
    });

    const res = await reinstatePayoutForShop("order_1", "shopA");

    expect(res).toEqual({ status: "noop", reason: "PENDING_WILL_RECOMPUTE" });
    expect(db.payout.updateMany).not.toHaveBeenCalled();
    expect(db.payout.create).not.toHaveBeenCalled();
  });

  it("is a no-op when the shop is owed nothing (all items refunded)", async () => {
    db.orderItem.findMany.mockResolvedValue([
      { id: "a1", qty: 1, unitPriceUsdCents: 5000, status: "REFUNDED" },
    ]);
    db.payout.findUnique.mockResolvedValue({
      id: "p1",
      status: "REVERSED",
      razorpayPayoutId: null,
      disbursedAt: null,
    });

    const res = await reinstatePayoutForShop("order_1", "shopA");

    expect(res).toEqual({ status: "noop", reason: "NOTHING_OWED" });
    expect(db.payout.updateMany).not.toHaveBeenCalled();
  });

  it("flags a DISBURSED payout for manual review instead of moving money blind", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "p1",
      status: "PAID",
      razorpayPayoutId: "po_live",
      disbursedAt: DELIVERED,
    });

    const res = await reinstatePayoutForShop("order_1", "shopA");

    expect(res).toMatchObject({ status: "manual", payoutId: "p1" });
    expect(db.payout.updateMany).not.toHaveBeenCalled();
    expect(db.payout.create).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it("creates a fresh PENDING payout when none exists yet but the order is delivered", async () => {
    db.payout.findUnique.mockResolvedValue(null);

    const res = await reinstatePayoutForShop("order_1", "shopA");

    expect(res).toMatchObject({ status: "reinstated", payoutId: "new_payout" });
    expect(db.payout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopId: "shopA",
          orderId: "order_1",
          status: "PENDING",
          amountInrPaise: 400_000,
          eligibleAt: DELIVERED,
        }),
      }),
    );
  });
});
