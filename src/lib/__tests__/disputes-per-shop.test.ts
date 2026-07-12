// Per-shop / per-item dispute tests for src/lib/disputes.ts against a MOCKED
// Prisma client + mocked money-path deps. Covers Wave 2:
//   - openDispute derives shopId from the selected items, records orderItemIds,
//     flips ONLY those items to DISPUTED, and enforces single-shop scope
//   - one dispute per (order, shop) is enforced
//   - resolveDispute(BUYER) refunds ONLY this shop's items (scoped enqueueRefund)
//     and claws back ONLY this shop's payout (reversePayoutsForOrder with shopId)
//   - resolveDispute(SELLER) reverts this shop's items to ACTIVE, moves no money

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findFirst: vi.fn(), update: vi.fn() },
    dispute: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderItem: { updateMany: vi.fn(), findMany: vi.fn() },
    adminAction: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/payments", () => ({ enqueueRefund: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/payouts", () => ({
  reversePayoutsForOrder: vi.fn(() => Promise.resolve({ reversed: 1 })),
  reinstatePayoutForShop: vi.fn(() => Promise.resolve({ status: "noop", reason: "PENDING_WILL_RECOMPUTE" })),
}));
vi.mock("@/lib/orders", () => ({
  refreshOrderStatusAfterDisputeResolution: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/buyer-protection", () => ({ claimBuyerProtection: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/trust-score", () => ({ enqueueTrustRecompute: vi.fn(() => Promise.resolve()) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import { openDispute, resolveDispute } from "@/lib/disputes";
import { prisma } from "@/lib/db";
import { enqueueRefund } from "@/lib/payments";
import { reversePayoutsForOrder, reinstatePayoutForShop } from "@/lib/payouts";
import { refreshOrderStatusAfterDisputeResolution } from "@/lib/orders";

const db = prisma as unknown as {
  order: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  dispute: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  orderItem: { updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  adminAction: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  db.orderItem.updateMany.mockResolvedValue({ count: 2 });
  db.orderItem.findMany.mockResolvedValue([{ shopId: "shopA" }, { shopId: "shopB" }]);
  db.order.update.mockResolvedValue({});
  db.adminAction.create.mockResolvedValue({});
});

afterEach(() => vi.clearAllMocks());

// Multi-shop order: shopA has a1,a2; shopB has b1.
function multiShopOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    status: "DELIVERED",
    deliveredAt: new Date(),
    items: [
      { id: "a1", shopId: "shopA", status: "ACTIVE" },
      { id: "a2", shopId: "shopA", status: "ACTIVE" },
      { id: "b1", shopId: "shopB", status: "ACTIVE" },
    ],
    ...overrides,
  };
}

describe("openDispute — per-shop / per-item", () => {
  it("derives shopId from selected items, records orderItemIds, flips them DISPUTED", async () => {
    db.order.findFirst.mockResolvedValue(multiShopOrder());
    db.dispute.findUnique.mockResolvedValue(null); // no existing dispute for the shop
    db.dispute.create.mockResolvedValue({ id: "disp_A", shopId: "shopA" });

    const d = await openDispute({
      orderId: "order_1",
      buyerId: "buyer_1",
      orderItemIds: ["a1", "a2"],
      reason: "DAMAGED",
      description: "Both arrived cracked",
    });

    expect(d).toEqual({ id: "disp_A", shopId: "shopA" });
    // Dispute carries shopId (derived) + the disputed item ids.
    expect(db.dispute.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order_1",
          shopId: "shopA",
          orderItemIds: ["a1", "a2"],
          status: "OPEN",
        }),
      }),
    );
    // Only shopA's items flip to DISPUTED.
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order_1", id: { in: ["a1", "a2"] } },
      data: { status: "DISPUTED" },
    });
    expect(db.order.update).toHaveBeenCalledWith({
      where: { id: "order_1" },
      data: { status: "DISPUTED" },
    });
  });

  it("rejects a selection spanning multiple shops", async () => {
    db.order.findFirst.mockResolvedValue(multiShopOrder());

    await expect(
      openDispute({
        orderId: "order_1",
        buyerId: "buyer_1",
        orderItemIds: ["a1", "b1"], // two shops
        reason: "OTHER",
        description: "mixed selection",
      }),
    ).rejects.toThrow("ITEMS_MULTIPLE_SHOPS");
    expect(db.dispute.create).not.toHaveBeenCalled();
  });

  it("enforces one dispute per (order, shop)", async () => {
    db.order.findFirst.mockResolvedValue(multiShopOrder());
    db.dispute.findUnique.mockResolvedValue({ id: "disp_existing" }); // shopA already disputed

    await expect(
      openDispute({
        orderId: "order_1",
        buyerId: "buyer_1",
        orderItemIds: ["a1"],
        reason: "DAMAGED",
        description: "second attempt for shopA",
      }),
    ).rejects.toThrow("ALREADY_DISPUTED");
    expect(db.dispute.create).not.toHaveBeenCalled();
  });

  it("rejects an item id not on the order", async () => {
    db.order.findFirst.mockResolvedValue(multiShopOrder());

    await expect(
      openDispute({
        orderId: "order_1",
        buyerId: "buyer_1",
        orderItemIds: ["ghost"],
        reason: "OTHER",
        description: "not a real item",
      }),
    ).rejects.toThrow("ITEMS_INVALID");
  });

  it("requires at least one item", async () => {
    await expect(
      openDispute({
        orderId: "order_1",
        buyerId: "buyer_1",
        orderItemIds: [],
        reason: "OTHER",
        description: "nothing selected here",
      }),
    ).rejects.toThrow("ITEMS_REQUIRED");
  });
});

describe("resolveDispute — per-shop", () => {
  function shopADispute(status = "OPEN") {
    return {
      id: "disp_A",
      status,
      orderId: "order_1",
      shopId: "shopA",
      orderItemIds: ["a1", "a2"],
    };
  }

  it("BUYER: refunds ONLY shopA's items and claws back ONLY shopA's payout", async () => {
    db.dispute.findUnique.mockResolvedValue(shopADispute());
    db.dispute.update.mockResolvedValue(shopADispute("RESOLVED_BUYER"));

    await resolveDispute({
      disputeId: "disp_A",
      adminId: "admin_1",
      outcome: "BUYER",
      resolution: "Photos confirm damage — refunding this shop.",
    });

    // Only shopA's disputed items flip to REFUNDED (scoped to shopId + ids).
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order_1", shopId: "shopA", id: { in: ["a1", "a2"] } },
      data: { status: "REFUNDED" },
    });
    // Partial per-shop refund is enqueued with the scope.
    expect(enqueueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_1",
        shopId: "shopA",
        orderItemIds: ["a1", "a2"],
      }),
    );
    // Clawback is scoped to shopA — shopB's payout is untouched.
    expect(reversePayoutsForOrder).toHaveBeenCalledWith(
      "order_1",
      "Photos confirm damage — refunding this shop.",
      "shopA",
    );
    // Order status is derived (not blindly set to REFUNDED).
    expect(refreshOrderStatusAfterDisputeResolution).toHaveBeenCalled();
  });

  it("SELLER: reverts shopA's items to ACTIVE and moves no money", async () => {
    db.dispute.findUnique.mockResolvedValue(shopADispute());
    db.dispute.update.mockResolvedValue(shopADispute("RESOLVED_SELLER"));

    await resolveDispute({
      disputeId: "disp_A",
      adminId: "admin_1",
      outcome: "SELLER",
      resolution: "Tracking confirms delivery; seller fulfilled.",
    });

    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: {
        orderId: "order_1",
        shopId: "shopA",
        id: { in: ["a1", "a2"] },
        status: "DISPUTED",
      },
      data: { status: "ACTIVE" },
    });
    expect(enqueueRefund).not.toHaveBeenCalled();
    expect(reversePayoutsForOrder).not.toHaveBeenCalled();
    // Seller won → re-establish the shop's payout so a hold-window cancellation
    // doesn't leave the vindicated seller unpaid.
    expect(reinstatePayoutForShop).toHaveBeenCalledWith("order_1", "shopA");
  });

  it("rejects re-resolving an already-resolved dispute", async () => {
    db.dispute.findUnique.mockResolvedValue(shopADispute("RESOLVED_BUYER"));

    await expect(
      resolveDispute({
        disputeId: "disp_A",
        adminId: "admin_1",
        outcome: "SELLER",
        resolution: "flip flop attempt",
      }),
    ).rejects.toThrow("DISPUTE_ALREADY_RESOLVED");
  });
});
