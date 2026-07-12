// Unit tests for the escrow ledger in src/lib/escrow.ts against a MOCKED Prisma
// client (no live DB). Covers the reconcilable append-only ledger:
//   - holdEscrow writes the initial HOLD + summary inside a caller transaction
//   - release/refund/reverse apply signed movements and recompute status
//   - every write is idempotent on the entry `ref` (P2002 → no-op, not throw)
//   - deriveEscrowStatus lifecycle
//   - getEscrowSummary reconciliation: held == released + refunded + stillHeld

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
  holdEscrow,
  releaseEscrow,
  refundEscrow,
  reverseReleaseEscrow,
  getEscrowSummary,
  deriveEscrowStatus,
  escrowRef,
} from "@/lib/escrow";
import { prisma } from "@/lib/db";

const db = prisma as unknown as {
  escrow: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
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

const P2002 = new Prisma.PrismaClientKnownRequestError("dup", {
  code: "P2002",
  clientVersion: "5.22.0",
});

beforeEach(() => {
  // $transaction runs its callback with the mocked client as `tx`.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  db.escrow.create.mockResolvedValue({ id: "esc_1" });
  db.escrow.upsert.mockResolvedValue({ id: "esc_1" });
  db.escrow.update.mockResolvedValue({});
  db.escrowEntry.create.mockResolvedValue({});
  db.escrowEntry.findMany.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("deriveEscrowStatus — lifecycle", () => {
  it("maps totals to the right status", () => {
    expect(deriveEscrowStatus(10_000, 0, 0)).toBe("HELD");
    expect(deriveEscrowStatus(10_000, 4_000, 0)).toBe("PARTIALLY_RELEASED");
    expect(deriveEscrowStatus(10_000, 10_000, 0)).toBe("RELEASED");
    expect(deriveEscrowStatus(10_000, 4_000, 3_000)).toBe("PARTIALLY_REFUNDED");
    expect(deriveEscrowStatus(10_000, 0, 10_000)).toBe("REFUNDED");
    // A refund always wins over a release for the headline status.
    expect(deriveEscrowStatus(10_000, 8_000, 10_000)).toBe("REFUNDED");
  });

  it("keys RELEASED off the releasable target, not the full held total", () => {
    // Real order: held = total (subtotal 9_000 + shipping/fee 1_000); only the
    // 9_000 seller subtotal is ever releasable. Releasing it in full = RELEASED
    // even though released (9_000) < held (10_000) — the platform cut stays held.
    expect(deriveEscrowStatus(10_000, 9_000, 0, 9_000)).toBe("RELEASED");
    expect(deriveEscrowStatus(10_000, 4_000, 0, 9_000)).toBe("PARTIALLY_RELEASED");
    // A fully-delivered, fully-paid-out order is RELEASED, not stuck PARTIALLY.
    expect(deriveEscrowStatus(11_999, 10_000, 0, 10_000)).toBe("RELEASED");
  });
});

describe("holdEscrow — initial hold inside the caller transaction", () => {
  it("upserts the Escrow summary + a HOLD entry with the per-order ref", async () => {
    const tx = {
      escrow: { upsert: vi.fn().mockResolvedValue({ id: "esc_1" }) },
    } as unknown as Prisma.TransactionClient;

    // releasable defaults to the full amount when omitted.
    await holdEscrow(tx, { orderId: "order_1", amountUsdCents: 10_000 });

    expect((tx.escrow.upsert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: "order_1" },
        create: expect.objectContaining({
          orderId: "order_1",
          status: "HELD",
          heldUsdCents: 10_000,
          releasableUsdCents: 10_000,
          entries: {
            create: expect.objectContaining({
              type: "HOLD",
              amountUsdCents: 10_000,
              ref: escrowRef.hold("order_1"),
            }),
          },
        }),
      }),
    );
  });

  it("records the seller-releasable portion (subtotal) when provided", async () => {
    const tx = {
      escrow: { upsert: vi.fn().mockResolvedValue({ id: "esc_1" }) },
    } as unknown as Prisma.TransactionClient;

    // held = full buyer total; releasable = seller subtotal (drives RELEASED).
    await holdEscrow(tx, { orderId: "order_1", amountUsdCents: 11_999, releasableUsdCents: 10_000 });

    expect((tx.escrow.upsert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ heldUsdCents: 11_999, releasableUsdCents: 10_000 }),
        update: expect.objectContaining({ heldUsdCents: 11_999, releasableUsdCents: 10_000 }),
      }),
    );
  });
});

describe("releaseEscrow — seller portion released at delivery", () => {
  it("records a positive RELEASE entry and advances the summary", async () => {
    db.escrow.findUnique.mockResolvedValue({
      id: "esc_1",
      status: "HELD",
      heldUsdCents: 10_000,
      releasedUsdCents: 0,
      refundedUsdCents: 0,
    });
    // The increment update returns the post-increment row (drives status calc).
    db.escrow.update.mockResolvedValue({
      status: "HELD",
      heldUsdCents: 10_000,
      releasedUsdCents: 4_000,
      refundedUsdCents: 0,
    });

    const wrote = await releaseEscrow({ orderId: "order_1", shopId: "shopA", amountUsdCents: 4_000 });

    expect(wrote).toBe(true);
    expect(db.escrowEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RELEASE",
          amountUsdCents: 4_000,
          ref: escrowRef.release("order_1", "shopA"),
        }),
      }),
    );
    // Money counter bumped via an atomic increment (race-safe).
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ releasedUsdCents: { increment: 4_000 } }),
      }),
    );
    // Status recomputed from the post-increment totals.
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { status: "PARTIALLY_RELEASED" } }),
    );
  });

  it("is a no-op on a duplicate ref (idempotent replay) and never throws", async () => {
    db.escrowEntry.create.mockRejectedValue(P2002);
    // The catch re-checks the ref: present ⇒ genuine replay ⇒ swallow as no-op.
    db.escrowEntry.findUnique.mockResolvedValue({ id: "ee_1" });

    const wrote = await releaseEscrow({ orderId: "order_1", shopId: "shopA", amountUsdCents: 4_000 });

    expect(wrote).toBe(false);
    expect(db.escrow.update).not.toHaveBeenCalled();
  });

  it("does NOT swallow a P2002 that is not this entry's ref (no silent drop)", async () => {
    // A residual race on the orderId-unique summary row surfaces as P2002 while
    // THIS entry's ref does not yet exist — it must propagate, not be dropped.
    db.escrowEntry.create.mockRejectedValue(P2002);
    db.escrowEntry.findUnique.mockResolvedValue(null);

    await expect(
      releaseEscrow({ orderId: "order_1", shopId: "shopA", amountUsdCents: 4_000 }),
    ).rejects.toBe(P2002);
    expect(db.escrow.update).not.toHaveBeenCalled();
  });
});

describe("refundEscrow — buyer refund", () => {
  it("records a REFUND entry and flips the summary to REFUNDED at full total", async () => {
    db.escrow.findUnique.mockResolvedValue({
      id: "esc_1",
      status: "HELD",
      heldUsdCents: 10_000,
      releasedUsdCents: 0,
      refundedUsdCents: 0,
    });
    db.escrow.update.mockResolvedValue({
      status: "HELD",
      heldUsdCents: 10_000,
      releasedUsdCents: 0,
      refundedUsdCents: 10_000,
    });

    const wrote = await refundEscrow({ orderId: "order_1", amountUsdCents: 10_000 });

    expect(wrote).toBe(true);
    expect(db.escrowEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "REFUND",
          amountUsdCents: 10_000,
          ref: escrowRef.refund("order_1"),
        }),
      }),
    );
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ refundedUsdCents: { increment: 10_000 } }),
      }),
    );
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { status: "REFUNDED" } }),
    );
  });

  it("second refund attempt on the same order is a no-op (single-refund guarantee)", async () => {
    db.escrowEntry.create.mockRejectedValue(P2002); // refund_<order> ref already exists
    db.escrowEntry.findUnique.mockResolvedValue({ id: "ee_1" }); // ref present ⇒ replay

    const wrote = await refundEscrow({ orderId: "order_1", amountUsdCents: 10_000 });

    expect(wrote).toBe(false);
    expect(db.escrow.update).not.toHaveBeenCalled();
  });
});

describe("reverseReleaseEscrow — payout clawback nets released back down", () => {
  it("records a NEGATIVE release equal to the prior release", async () => {
    db.escrowEntry.findUnique.mockResolvedValue({ amountUsdCents: 4_000 }); // original release
    db.escrow.findUnique.mockResolvedValue({
      id: "esc_1",
      status: "PARTIALLY_RELEASED",
      heldUsdCents: 10_000,
      releasedUsdCents: 4_000,
      refundedUsdCents: 0,
    });
    db.escrow.update.mockResolvedValue({
      status: "PARTIALLY_RELEASED",
      heldUsdCents: 10_000,
      releasedUsdCents: 0, // 4000 + (-4000)
      refundedUsdCents: 0,
    });

    const wrote = await reverseReleaseEscrow({ orderId: "order_1", shopId: "shopA" });

    expect(wrote).toBe(true);
    expect(db.escrowEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RELEASE",
          amountUsdCents: -4_000,
          ref: escrowRef.releaseReversal("order_1", "shopA"),
        }),
      }),
    );
    // released decrements by the original amount (negative increment)...
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ releasedUsdCents: { increment: -4_000 } }),
      }),
    );
    // ...netting back to 0 → status returns to HELD.
    expect(db.escrow.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: { status: "HELD" } }),
    );
  });

  it("is a no-op when nothing was released for the shop", async () => {
    db.escrowEntry.findUnique.mockResolvedValue(null);

    const wrote = await reverseReleaseEscrow({ orderId: "order_1", shopId: "shopA" });

    expect(wrote).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("getEscrowSummary — reconciliation", () => {
  it("balances held == released + refunded + stillHeld and reports reconciled", async () => {
    // Delivered order: full total held, seller's net released, platform cut still held.
    db.escrow.findUnique.mockResolvedValue({
      status: "PARTIALLY_RELEASED",
      heldUsdCents: 10_000,
      releasedUsdCents: 7_000,
      refundedUsdCents: 0,
      entries: [
        { type: "HOLD", amountUsdCents: 10_000 },
        { type: "RELEASE", amountUsdCents: 7_000 },
      ],
    });

    const s = await getEscrowSummary("order_1");

    expect(s).not.toBeNull();
    expect(s!.stillHeldUsdCents).toBe(3_000);
    expect(s!.releasedUsdCents + s!.refundedUsdCents + s!.stillHeldUsdCents).toBe(s!.heldUsdCents);
    expect(s!.reconciled).toBe(true);
  });

  it("reconciles a clawed-back-then-refunded order (release nets to 0, full refund)", async () => {
    db.escrow.findUnique.mockResolvedValue({
      status: "REFUNDED",
      heldUsdCents: 10_000,
      releasedUsdCents: 0,
      refundedUsdCents: 10_000,
      entries: [
        { type: "HOLD", amountUsdCents: 10_000 },
        { type: "RELEASE", amountUsdCents: 7_000 },
        { type: "RELEASE", amountUsdCents: -7_000 }, // clawback
        { type: "REFUND", amountUsdCents: 10_000 },
      ],
    });

    const s = await getEscrowSummary("order_1");

    expect(s!.stillHeldUsdCents).toBe(0);
    expect(s!.reconciled).toBe(true);
  });

  it("flags a drift between the cached summary and the recomputed ledger", async () => {
    db.escrow.findUnique.mockResolvedValue({
      status: "HELD",
      heldUsdCents: 10_000,
      releasedUsdCents: 5_000, // summary claims 5000 released...
      refundedUsdCents: 0,
      entries: [{ type: "HOLD", amountUsdCents: 10_000 }], // ...but no RELEASE entry exists
    });

    const s = await getEscrowSummary("order_1");

    expect(s!.reconciled).toBe(false);
  });

  it("returns null for an order with no escrow record", async () => {
    db.escrow.findUnique.mockResolvedValue(null);
    expect(await getEscrowSummary("missing")).toBeNull();
  });
});
