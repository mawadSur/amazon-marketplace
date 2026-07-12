// Unit tests for the weekly bulk payout batch (src/lib/payout-batch.ts) against a
// MOCKED Prisma client (no live DB). Covers the scheduler's money-critical
// contract:
//   - the hold window is applied (eligibleAt <= now - PAYOUT_HOLD_DAYS)
//   - a due payout is disbursed once and the escrow RELEASE is recorded at
//     DISBURSEMENT (not at delivery)
//   - idempotency: the conditional PENDING→PROCESSING claim means a re-run (or a
//     lost race) never double-disburses
//   - a dispute/refund during the hold window reduces (partial) or cancels
//     (full) the shop's payout before money leaves escrow
//   - a missing fund account strands the payout (PROCESSING, no gateway id)

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────
vi.mock("@/lib/db", () => ({
  prisma: {
    payout: { findMany: vi.fn(), updateMany: vi.fn() },
    order: { findUnique: vi.fn() },
    orderItem: { findMany: vi.fn() },
    bankAccount: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/stubs", () => ({ razorpayCreatePayout: vi.fn() }));
vi.mock("@/lib/fx", () => ({ usdCentsToInrPaiseAt: vi.fn((usd: number) => usd * 80) }));
vi.mock("@/lib/fees", () => ({ shopNetUsdCents: vi.fn((subtotal: number) => subtotal) }));
vi.mock("@/lib/escrow", () => ({ releaseEscrow: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/lib/env", () => ({ env: { PAYOUT_HOLD_DAYS: 5, NODE_ENV: "test" } }));
vi.mock("@/lib/payouts", () => ({
  alertStrandedPayout: vi.fn(),
  markPayoutPaid: vi.fn(() => Promise.resolve()),
  payoutReference: (orderId: string | null, shopId: string) => `${orderId}_${shopId}`,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import { runPayoutBatch } from "@/lib/payout-batch";
import { prisma } from "@/lib/db";
import { razorpayCreatePayout } from "@/lib/stubs";
import { releaseEscrow } from "@/lib/escrow";
import { alertStrandedPayout, markPayoutPaid } from "@/lib/payouts";

const db = prisma as unknown as {
  payout: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  order: { findUnique: ReturnType<typeof vi.fn> };
  orderItem: { findMany: ReturnType<typeof vi.fn> };
  bankAccount: { findUnique: ReturnType<typeof vi.fn> };
};

afterEach(() => vi.clearAllMocks());

const NOW = new Date("2026-03-10T12:00:00Z");

/** Wire the per-item read + claim/persist updateMany so a due payout disburses. */
function arrangeActiveItems(items: { qty: number; unitPriceUsdCents: number; status: string }[]) {
  db.order.findUnique.mockResolvedValue({ fxRate: 80 });
  db.orderItem.findMany.mockResolvedValue(items);
  db.payout.updateMany.mockResolvedValue({ count: 1 });
}

describe("runPayoutBatch — hold window", () => {
  it("queries only PENDING payouts past the PAYOUT_HOLD_DAYS cutoff (delivered <5d excluded)", async () => {
    db.payout.findMany.mockResolvedValue([]);

    await runPayoutBatch(NOW);

    // cutoff = now - 5 days. A payout delivered <5 days ago has eligibleAt > cutoff
    // and is therefore NOT returned by this query.
    const expectedCutoff = new Date("2026-03-05T12:00:00Z");
    expect(db.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "PENDING", eligibleAt: { lte: expectedCutoff } },
      }),
    );
  });
});

describe("runPayoutBatch — disburses a due payout once", () => {
  it("disburses, records the escrow RELEASE at disbursement, and flips PENDING→PROCESSING", async () => {
    db.payout.findMany.mockResolvedValue([
      { id: "p1", shopId: "shopA", orderId: "o1", amountInrPaise: 80_000 },
    ]);
    arrangeActiveItems([{ qty: 1, unitPriceUsdCents: 1_000, status: "ACTIVE" }]);
    db.bankAccount.findUnique.mockResolvedValue({ razorpayFundAccountId: "fa_1" });
    (razorpayCreatePayout as ReturnType<typeof vi.fn>).mockResolvedValue({
      payoutId: "pout_1",
      status: "processing",
    });

    const res = await runPayoutBatch(NOW);

    expect(res.disbursed).toBe(1);
    // Claimed with the conditional PENDING guard (the idempotency point).
    expect(db.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1", status: "PENDING" },
        data: expect.objectContaining({ status: "PROCESSING", amountInrPaise: 80_000 }),
      }),
    );
    // Escrow RELEASE recorded HERE (at disbursement), for the net USD.
    expect(releaseEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", shopId: "shopA", amountUsdCents: 1_000 }),
    );
    // Gateway called with the stable (order_shop) idempotency reference.
    expect(razorpayCreatePayout).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "o1_shopA", amountInrPaise: 80_000 }),
    );
    // No RazorpayX webhook in dev → auto mark-paid.
    expect(markPayoutPaid).toHaveBeenCalledWith({ payoutId: "p1" });
  });
});

describe("runPayoutBatch — idempotency (never double-disburse)", () => {
  it("second run finds nothing PENDING → no gateway call", async () => {
    db.payout.findMany.mockResolvedValue([]); // all already PROCESSING/PAID

    const res = await runPayoutBatch(NOW);

    expect(res.disbursed).toBe(0);
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
  });

  it("lost the PENDING→PROCESSING race (claim count 0) → skipped, no gateway call", async () => {
    db.payout.findMany.mockResolvedValue([
      { id: "p1", shopId: "shopA", orderId: "o1", amountInrPaise: 80_000 },
    ]);
    db.order.findUnique.mockResolvedValue({ fxRate: 80 });
    db.orderItem.findMany.mockResolvedValue([{ qty: 1, unitPriceUsdCents: 1_000, status: "ACTIVE" }]);
    db.payout.updateMany.mockResolvedValue({ count: 0 }); // another runner claimed it first

    const res = await runPayoutBatch(NOW);

    expect(res.skipped).toBe(1);
    expect(res.disbursed).toBe(0);
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
    expect(releaseEscrow).not.toHaveBeenCalled();
  });
});

describe("runPayoutBatch — dispute/refund during the hold window", () => {
  it("all items refunded → payout CANCELLED (REVERSED), no gateway, escrow untouched", async () => {
    db.payout.findMany.mockResolvedValue([
      { id: "p1", shopId: "shopA", orderId: "o1", amountInrPaise: 80_000 },
    ]);
    db.order.findUnique.mockResolvedValue({ fxRate: 80 });
    db.orderItem.findMany.mockResolvedValue([{ qty: 1, unitPriceUsdCents: 1_000, status: "REFUNDED" }]);
    db.payout.updateMany.mockResolvedValue({ count: 1 });

    const res = await runPayoutBatch(NOW);

    expect(res.cancelled).toBe(1);
    expect(res.disbursed).toBe(0);
    // Cancelled → REVERSED (zeroed), no gateway reversal, no escrow move.
    expect(db.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1", status: "PENDING" },
        data: expect.objectContaining({ status: "REVERSED", amountInrPaise: 0 }),
      }),
    );
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
    expect(releaseEscrow).not.toHaveBeenCalled();
  });

  it("one of two items refunded → payout REDUCED to the ACTIVE items' net", async () => {
    db.payout.findMany.mockResolvedValue([
      { id: "p1", shopId: "shopA", orderId: "o1", amountInrPaise: 160_000 },
    ]);
    arrangeActiveItems([
      { qty: 1, unitPriceUsdCents: 1_000, status: "ACTIVE" },
      { qty: 1, unitPriceUsdCents: 1_000, status: "REFUNDED" },
    ]);
    db.bankAccount.findUnique.mockResolvedValue({ razorpayFundAccountId: "fa_1" });
    (razorpayCreatePayout as ReturnType<typeof vi.fn>).mockResolvedValue({
      payoutId: "pout_1",
      status: "processing",
    });

    const res = await runPayoutBatch(NOW);

    expect(res.disbursed).toBe(1);
    // Net = 1 ACTIVE item * 1000 = 1000 USD → 80_000 paise (down from 160_000).
    expect(db.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PROCESSING", amountInrPaise: 80_000 }),
      }),
    );
    expect(releaseEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: "shopA", amountUsdCents: 1_000 }),
    );
    expect(razorpayCreatePayout).toHaveBeenCalledWith(
      expect.objectContaining({ amountInrPaise: 80_000 }),
    );
  });
});

describe("runPayoutBatch — stranded when no fund account", () => {
  it("flips PROCESSING + records RELEASE but strands (no gateway id) and alerts", async () => {
    db.payout.findMany.mockResolvedValue([
      { id: "p1", shopId: "shopA", orderId: "o1", amountInrPaise: 80_000 },
    ]);
    arrangeActiveItems([{ qty: 1, unitPriceUsdCents: 1_000, status: "ACTIVE" }]);
    db.bankAccount.findUnique.mockResolvedValue({ razorpayFundAccountId: null });

    const res = await runPayoutBatch(NOW);

    expect(res.stranded).toBe(1);
    expect(res.disbursed).toBe(0);
    // The escrow RELEASE still runs (PROCESSING invariant), but the gateway is
    // never called and the seller-unpaid condition surfaces.
    expect(releaseEscrow).toHaveBeenCalled();
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
    expect(alertStrandedPayout).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: "p1", shopId: "shopA", orderId: "o1" }),
    );
  });
});
