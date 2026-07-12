// Unit tests for the payout state machine in src/lib/payouts.ts against a MOCKED
// Prisma client (no live DB). Covers the money-critical guards:
//   - enqueuePayouts with a missing fund account -> STRANDED (PROCESSING, no
//     razorpayPayoutId) + a Sentry alert, seller not paid
//   - retryPayout after the fund account is set -> INITIATED (RazorpayX called)
//   - retryPayout twice -> no double-pay (skipped once already initiated)
//   - markPayoutFailed terminal-state guard: an already-REVERSED payout is NOT
//     downgraded to FAILED

import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted by vitest) ──────────────────────────────────────────────
vi.mock("@/lib/db", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    payout: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    bankAccount: { findUnique: vi.fn(), findMany: vi.fn() },
    payoutReversal: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/stubs", () => ({ razorpayCreatePayout: vi.fn() }));
vi.mock("@/lib/providers/razorpay", () => ({ razorpayReversePayout: vi.fn() }));
vi.mock("@/lib/fx", () => ({ usdCentsToInrPaiseAt: vi.fn((usd: number) => usd * 80) }));
vi.mock("@/lib/fees", () => ({ shopNetUsdCents: vi.fn((subtotal: number) => subtotal) }));
vi.mock("@/lib/email", () => ({ sendPayoutNotification: vi.fn(() => Promise.resolve({ sent: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import {
  enqueuePayouts,
  retryPayout,
  markPayoutFailed,
  listStrandedPayouts,
} from "@/lib/payouts";
import { prisma } from "@/lib/db";
import { razorpayCreatePayout } from "@/lib/stubs";
import * as Sentry from "@sentry/nextjs";

const db = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn> };
  payout: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  bankAccount: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
};

afterEach(() => vi.clearAllMocks());

describe("enqueuePayouts — creates a HELD payout at delivery (no disbursement)", () => {
  it("creates a PENDING payout with eligibleAt and never touches the gateway", async () => {
    const deliveredAt = new Date("2026-02-01T00:00:00Z");
    db.order.findUnique.mockResolvedValue({
      id: "order1",
      fxRate: 80,
      deliveredAt,
      items: [{ id: "oi1", shopId: "shopA", qty: 1, unitPriceUsdCents: 1000 }],
    });
    db.payout.findUnique.mockResolvedValue(null); // no existing payout
    db.payout.create.mockResolvedValue({ id: "payout1" });

    const res = await enqueuePayouts("order1");

    expect(res.created).toEqual([
      { payoutId: "payout1", shopId: "shopA", amountInrPaise: 80000 },
    ]);
    // Row created as PENDING (held), eligibleAt = deliveredAt — funds stay in
    // escrow until the weekly batch disburses.
    expect(db.payout.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING", eligibleAt: deliveredAt }),
      }),
    );
    // No fund-account lookup, no gateway call, no strand alert at delivery — all
    // of that moves to runPayoutBatch.
    expect(db.bankAccount.findUnique).not.toHaveBeenCalled();
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe("retryPayout — disburse once the fund account exists", () => {
  it("initiates the RazorpayX payout and persists the provider id", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "payout1",
      shopId: "shopA",
      orderId: "order1",
      status: "PROCESSING",
      amountInrPaise: 80000,
      razorpayPayoutId: null,
    });
    db.bankAccount.findUnique.mockResolvedValue({ razorpayFundAccountId: "fa_123" });
    (razorpayCreatePayout as ReturnType<typeof vi.fn>).mockResolvedValue({
      payoutId: "pout_live_1",
      status: "processing",
    });
    db.payout.updateMany.mockResolvedValue({ count: 1 });

    const res = await retryPayout("payout1");

    expect(res).toEqual({
      status: "initiated",
      payoutId: "payout1",
      razorpayPayoutId: "pout_live_1",
    });
    expect(razorpayCreatePayout).toHaveBeenCalledWith(
      expect.objectContaining({ fundAccountId: "fa_123", reference: "order1_shopA" }),
    );
    // Provider id persisted only while still null (no double-pay under a race).
    expect(db.payout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "payout1", razorpayPayoutId: null },
        data: { razorpayPayoutId: "pout_live_1" },
      }),
    );
  });

  it("stays stranded (no gateway call) when the fund account is still missing", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "payout1",
      shopId: "shopA",
      orderId: "order1",
      status: "PROCESSING",
      amountInrPaise: 80000,
      razorpayPayoutId: null,
    });
    db.bankAccount.findUnique.mockResolvedValue({ razorpayFundAccountId: null });

    const res = await retryPayout("payout1");

    expect(res).toEqual({ status: "stranded", payoutId: "payout1", reason: "NO_FUND_ACCOUNT" });
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
  });

  it("does NOT double-pay: a payout already carrying a provider id is skipped", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "payout1",
      shopId: "shopA",
      orderId: "order1",
      status: "PROCESSING",
      amountInrPaise: 80000,
      razorpayPayoutId: "pout_live_1", // already initiated
    });

    const res = await retryPayout("payout1");

    expect(res).toEqual({ status: "skipped", payoutId: "payout1", reason: "ALREADY_INITIATED" });
    expect(db.bankAccount.findUnique).not.toHaveBeenCalled();
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
  });

  it("does NOT re-disburse a PAID payout", async () => {
    db.payout.findUnique.mockResolvedValue({
      id: "payout1",
      shopId: "shopA",
      orderId: "order1",
      status: "PAID",
      amountInrPaise: 80000,
      razorpayPayoutId: null,
    });

    const res = await retryPayout("payout1");

    expect(res).toEqual({
      status: "skipped",
      payoutId: "payout1",
      reason: "NOT_RETRYABLE_STATUS_PAID",
    });
    expect(razorpayCreatePayout).not.toHaveBeenCalled();
  });
});

describe("markPayoutFailed — terminal-state guard", () => {
  it("does NOT downgrade an already-REVERSED payout to FAILED", async () => {
    db.payout.findFirst.mockResolvedValue({ id: "payout1", status: "REVERSED" });

    await markPayoutFailed({ razorpayPayoutId: "pout_live_1", reason: "reversed by bank" });

    expect(db.payout.update).not.toHaveBeenCalled();
  });

  it("marks a PROCESSING payout FAILED as normal", async () => {
    db.payout.findFirst.mockResolvedValue({ id: "payout1", status: "PROCESSING" });
    db.payout.update.mockResolvedValue({});

    await markPayoutFailed({ razorpayPayoutId: "pout_live_1", reason: "insufficient balance" });

    expect(db.payout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "payout1" },
        data: { status: "FAILED", failureReason: "insufficient balance" },
      }),
    );
  });
});

describe("listStrandedPayouts — surfaces unpaid sellers", () => {
  it("flags which stranded payouts are now retryable", async () => {
    db.payout.findMany.mockResolvedValue([
      { id: "p1", shopId: "shopA", orderId: "o1", amountInrPaise: 80000, createdAt: new Date(0) },
      { id: "p2", shopId: "shopB", orderId: "o2", amountInrPaise: 40000, createdAt: new Date(0) },
    ]);
    db.bankAccount.findMany.mockResolvedValue([{ shopId: "shopA" }]); // only shopA funded

    const res = await listStrandedPayouts();

    expect(res).toEqual([
      expect.objectContaining({ payoutId: "p1", shopId: "shopA", hasFundAccount: true }),
      expect.objectContaining({ payoutId: "p2", shopId: "shopB", hasFundAccount: false }),
    ]);
  });
});
