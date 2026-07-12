// Escrow-ledger tests for the Wave 2 PARTIAL per-shop refund (real escrow module,
// mocked Prisma — mirrors escrow.test.ts). Covers:
//   - escrowRef.refundShop is DISTINCT from the whole-order refund ref
//   - refundShopEscrow records a per-shop REFUND entry with that ref
//   - a multi-shop order that partially refunds ONE shop still reconciles:
//     held == released + refunded + stillHeld, with stillHeld >= 0, and the
//     summary status reads PARTIALLY_REFUNDED

import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    escrow: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    escrowEntry: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import {
  refundShopEscrow,
  reverseReleaseEscrow,
  getEscrowSummary,
  deriveEscrowStatus,
  escrowRef,
} from "@/lib/escrow";
import { prisma } from "@/lib/db";

const db = prisma as unknown as {
  escrow: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  escrowEntry: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  db.escrow.upsert.mockResolvedValue({ id: "esc_1" });
  db.escrow.update.mockResolvedValue({});
  db.escrowEntry.create.mockResolvedValue({});
  db.escrowEntry.findMany.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("escrowRef.refundShop — distinct per-shop ref", () => {
  it("differs from the whole-order refund ref and is keyed per shop", () => {
    expect(escrowRef.refundShop("order_1", "shopA")).toBe("refund_order_1_shopA");
    expect(escrowRef.refundShop("order_1", "shopA")).not.toBe(escrowRef.refund("order_1"));
    expect(escrowRef.refundShop("order_1", "shopA")).not.toBe(
      escrowRef.refundShop("order_1", "shopB"),
    );
  });
});

describe("refundShopEscrow — per-shop REFUND entry", () => {
  it("records a REFUND entry with the per-shop ref and advances refunded", async () => {
    db.escrow.findUnique.mockResolvedValue({
      id: "esc_1",
      status: "PARTIALLY_RELEASED",
      heldUsdCents: 6_000,
      releasedUsdCents: 3_000,
      refundedUsdCents: 0,
    });
    db.escrow.update.mockResolvedValue({
      status: "PARTIALLY_RELEASED",
      heldUsdCents: 6_000,
      releasedUsdCents: 3_000,
      refundedUsdCents: 2_000,
    });

    const wrote = await refundShopEscrow({ orderId: "order_1", shopId: "shopA", amountUsdCents: 2_000 });

    expect(wrote).toBe(true);
    expect(db.escrowEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUND",
          amountUsdCents: 2_000,
          ref: escrowRef.refundShop("order_1", "shopA"),
        }),
      }),
    );
    // Partial refund (2000) < held (6000) → PARTIALLY_REFUNDED.
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { status: "PARTIALLY_REFUNDED" } }),
    );
  });

  it("is idempotent per (order, shop) — a replayed shop refund is a no-op", async () => {
    const P2002 = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "5.22.0",
    });
    db.escrowEntry.create.mockRejectedValue(P2002);
    db.escrowEntry.findUnique.mockResolvedValue({ id: "ee_1" }); // ref present ⇒ replay

    const wrote = await refundShopEscrow({ orderId: "order_1", shopId: "shopA", amountUsdCents: 2_000 });

    expect(wrote).toBe(false);
    expect(db.escrow.update).not.toHaveBeenCalled();
  });
});

describe("reverseReleaseEscrow — FULL clawback is prior-aware (no double-subtract)", () => {
  it("after a PARTIAL reversal, nets the REMAINING release to 0 (not the whole original)", async () => {
    // Original release for the shop was 10000¢; a prior PARTIAL clawback already
    // netted it down by 6000¢ (relrevp). A subsequent FULL clawback (e.g. a
    // whole-order chargeback) must reverse only the remaining 4000¢, not another
    // 10000¢ — otherwise releasedUsdCents goes negative and reconcile breaks.
    db.escrowEntry.findUnique.mockResolvedValue({ amountUsdCents: 10_000 }); // original release
    db.escrowEntry.findMany.mockResolvedValue([{ amountUsdCents: -6000 }]); // prior partial reversal

    const wrote = await reverseReleaseEscrow({ orderId: "order_1", shopId: "shopA" });

    expect(wrote).toBe(true);
    expect(db.escrowEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RELEASE",
          amountUsdCents: -4000, // remaining = 10000 + (-6000)
          ref: escrowRef.releaseReversal("order_1", "shopA"),
        }),
      }),
    );
  });

  it("is an idempotent no-op once already fully reversed", async () => {
    db.escrowEntry.findUnique.mockResolvedValue({ amountUsdCents: 10_000 });
    // Prior reversals already sum to the full original (e.g. relrevp -6000 + relrev -4000).
    db.escrowEntry.findMany.mockResolvedValue([
      { amountUsdCents: -6000 },
      { amountUsdCents: -4000 },
    ]);

    const wrote = await reverseReleaseEscrow({ orderId: "order_1", shopId: "shopA" });

    expect(wrote).toBe(false);
    expect(db.escrowEntry.create).not.toHaveBeenCalled();
  });
});

describe("getEscrowSummary — reconciles a multi-shop PARTIAL refund", () => {
  it("balances held == released + refunded + stillHeld after clawing back + refunding one shop", async () => {
    // Order: held 6000 (subtotal 5000 + platform cut 1000). shopA net 2000,
    // shopB net 3000 released at delivery. shopA disputed → refund A's 2000 +
    // claw back A's release (-2000). shopB untouched.
    db.escrow.findUnique.mockResolvedValue({
      status: "PARTIALLY_REFUNDED",
      heldUsdCents: 6_000,
      releasedUsdCents: 3_000, // 2000 + 3000 - 2000 (clawback)
      refundedUsdCents: 2_000, // shopA partial refund
      entries: [
        { type: "HOLD", amountUsdCents: 6_000 },
        { type: "RELEASE", amountUsdCents: 2_000 }, // shopA
        { type: "RELEASE", amountUsdCents: 3_000 }, // shopB
        { type: "RELEASE", amountUsdCents: -2_000 }, // shopA clawback
        { type: "REFUND", amountUsdCents: 2_000 }, // shopA partial refund
      ],
    });

    const s = await getEscrowSummary("order_1");

    expect(s).not.toBeNull();
    // stillHeld = platform cut (1000) + shopB's still-released net stays with the
    // seller; from the ledger: 6000 - 3000 - 2000 = 1000.
    expect(s!.stillHeldUsdCents).toBe(1_000);
    expect(s!.releasedUsdCents + s!.refundedUsdCents + s!.stillHeldUsdCents).toBe(s!.heldUsdCents);
    expect(s!.stillHeldUsdCents).toBeGreaterThanOrEqual(0);
    expect(s!.reconciled).toBe(true);
    // Partial refund → PARTIALLY_REFUNDED (not full REFUNDED).
    expect(deriveEscrowStatus(6_000, 3_000, 2_000, 5_000)).toBe("PARTIALLY_REFUNDED");
  });
});
