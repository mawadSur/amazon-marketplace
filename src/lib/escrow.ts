// Escrow ledger (D4) — platform-custody accounting of buyer funds, buyer-side
// USD cents. One Escrow summary row per Order over an append-only EscrowEntry
// ledger. Lifecycle:
//   HOLD    on capture (markPaymentCaptured) for the full order total
//   RELEASE at disbursement (runPayoutBatch, the weekly batch) for each shop's
//           net payout portion — funds are HELD from delivery until the hold
//           window elapses, so RELEASE is recorded when money actually moves
//   REFUND  on buyer refund (refundOrder) for the amount returned to the buyer
// A payout clawback (reversePayoutsForOrder) records a NEGATIVE RELEASE entry so
// released nets back down. Reconcilable at any time:
//   held == released + refunded + stillHeld   (stillHeld = platform fee +
//   shipping still in custody, must be >= 0).
//
// Every write is idempotent via the EscrowEntry.ref UNIQUE constraint — a
// replayed capture/release/refund is a duplicate-insert no-op. HOLD is designed
// to run INSIDE the caller's capture transaction (pass the tx client); the other
// operations self-manage a small transaction.

import { Prisma } from "@prisma/client";
import type { EscrowStatus, EscrowEntryType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";

const eslog = log.child({ module: "escrow" });

/** A Prisma client or an interactive-transaction client — both expose the model
 * delegates used here, so a caller can thread its own transaction in. */
type EscrowDb = Prisma.TransactionClient | typeof prisma;

function isP2002(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Derive the summary status from the running totals. released is NET (clawbacks
 * subtract), so a fully-clawed-back-then-refunded order reads REFUNDED.
 *
 * RELEASED is keyed off `releasableUsdCents` — the seller-owed portion (order
 * subtotal) — NOT the full held total. HOLD records the full buyer total
 * (subtotal + shipping + fee), but RELEASE only ever moves each shop's net
 * (= subtotal); the platform cut stays in custody forever. Keying RELEASED off
 * held would make it unreachable for every real order. `releasableUsdCents`
 * defaults to held so pre-existing callers/rows that never recorded a releasable
 * target keep the old (held-based) behaviour.
 */
export function deriveEscrowStatus(
  heldUsdCents: number,
  releasedUsdCents: number,
  refundedUsdCents: number,
  releasableUsdCents: number = heldUsdCents,
): EscrowStatus {
  if (refundedUsdCents >= heldUsdCents && refundedUsdCents > 0) return "REFUNDED";
  if (refundedUsdCents > 0) return "PARTIALLY_REFUNDED";
  if (releasableUsdCents > 0 && releasedUsdCents >= releasableUsdCents) return "RELEASED";
  if (releasedUsdCents > 0) return "PARTIALLY_RELEASED";
  return "HELD";
}

/** Stable idempotency refs — one per (order[, shop]) movement. */
export const escrowRef = {
  hold: (orderId: string) => `hold_${orderId}`,
  release: (orderId: string, shopId: string) => `release_${orderId}_${shopId}`,
  releaseReversal: (orderId: string, shopId: string) => `relrev_${orderId}_${shopId}`,
  refund: (orderId: string) => `refund_${orderId}`,
  /** Per-shop PARTIAL refund (Wave 2) — a per-shop dispute refunds only that
   * shop's disputed items, so it needs a ref DISTINCT from the whole-order
   * `refund_<order>`. Keyed on (order, shop) so it is idempotent per shop and a
   * shop-B refund never collides with a shop-A refund on the same order. */
  refundShop: (orderId: string, shopId: string) => `refund_${orderId}_${shopId}`,
  /** PARTIAL release reversal (Wave 2) — a per-shop dispute that refunds only a
   * SUBSET of a shop's items claws back only that subset's payout portion, so it
   * nets the release down by a partial amount under a ref DISTINCT from the full
   * clawback `relrev_<order>_<shop>`. */
  releaseReversalPartial: (orderId: string, shopId: string) => `relrevp_${orderId}_${shopId}`,
};

/**
 * Record the initial HOLD when buyer funds are captured. MEANT to run inside the
 * capture transaction — pass the tx client so the hold commits atomically with
 * the PLACED→PAID flip. Idempotent: the caller's atomic guard ensures a single
 * execution per order, and the HOLD entry ref UNIQUE constraint backs that up.
 *
 * `releasableUsdCents` is the seller-owed portion (order subtotal) used to derive
 * the RELEASED status; it defaults to the full amount when omitted.
 *
 * Uses upsert (not create) on the orderId-unique summary row: a RELEASE/REFUND
 * that ran out of order (legacy/racing path) may have lazily materialised the
 * row with heldUsdCents 0. A plain create would then P2002 and abort the whole
 * capture transaction — which the caller misreads as "already processed" and
 * rolls back a real capture. Upsert fills in the held/releasable totals and adds
 * the HOLD entry whether or not the row already existed.
 */
export async function holdEscrow(
  db: EscrowDb,
  input: { orderId: string; amountUsdCents: number; releasableUsdCents?: number; reason?: string },
): Promise<void> {
  const now = new Date();
  const releasable = input.releasableUsdCents ?? input.amountUsdCents;
  const holdEntry = {
    orderId: input.orderId,
    type: "HOLD" as const,
    amountUsdCents: input.amountUsdCents,
    ref: escrowRef.hold(input.orderId),
    reason: input.reason ?? null,
  };
  await db.escrow.upsert({
    where: { orderId: input.orderId },
    create: {
      orderId: input.orderId,
      status: "HELD",
      heldUsdCents: input.amountUsdCents,
      releasableUsdCents: releasable,
      heldAt: now,
      entries: { create: holdEntry },
    },
    update: {
      heldUsdCents: input.amountUsdCents,
      releasableUsdCents: releasable,
      heldAt: now,
      entries: { create: holdEntry },
    },
  });
}

/**
 * Apply one signed movement to the ledger + summary in a single transaction.
 * Idempotent on `ref` (a duplicate is swallowed as a no-op). Returns true when a
 * new entry was written, false on a no-op replay. Never throws on a replay;
 * other DB errors propagate. Best-effort orchestration (never blocking the real
 * money movement) is the caller's responsibility.
 */
async function applyEntry(input: {
  orderId: string;
  type: EscrowEntryType;
  /** Signed: RELEASE/REFUND positive, a clawback RELEASE reversal negative. */
  amountUsdCents: number;
  ref: string;
  reason?: string;
}): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Lazily materialise a summary row for legacy orders captured before the
      // escrow ledger existed (they never got a HOLD). heldUsdCents stays 0, so
      // reconcile() will flag them — deliberately visible, not silently masked.
      // Upsert (not find-then-create) so two concurrent movements with DIFFERENT
      // refs can't race on the orderId-unique row and have one throw P2002 that
      // gets mistaken for a duplicate ref (which would silently drop a real
      // release/refund). After this the only P2002 possible is the entry ref.
      const escrow = await tx.escrow.upsert({
        where: { orderId: input.orderId },
        create: { orderId: input.orderId, status: "HELD", heldUsdCents: 0, releasableUsdCents: 0 },
        update: {},
      });

      await tx.escrowEntry.create({
        data: {
          escrowId: escrow.id,
          orderId: input.orderId,
          type: input.type,
          amountUsdCents: input.amountUsdCents,
          ref: input.ref,
          reason: input.reason ?? null,
        },
      });

      // Atomic increments keep the money counters race-safe: two concurrent
      // (different-ref) movements on the same order can't lose an update the way
      // a read-then-set would. Status is then derived from the post-increment
      // row, so it too reflects both writes.
      const relDelta = input.type === "RELEASE" ? input.amountUsdCents : 0;
      const refDelta = input.type === "REFUND" ? input.amountUsdCents : 0;
      const now = new Date();
      const updated = await tx.escrow.update({
        where: { id: escrow.id },
        data: {
          releasedUsdCents: relDelta !== 0 ? { increment: relDelta } : undefined,
          refundedUsdCents: refDelta !== 0 ? { increment: refDelta } : undefined,
          releasedAt: input.type === "RELEASE" ? now : undefined,
          refundedAt: input.type === "REFUND" ? now : undefined,
        },
      });

      const status = deriveEscrowStatus(
        updated.heldUsdCents,
        updated.releasedUsdCents,
        updated.refundedUsdCents,
        updated.releasableUsdCents,
      );
      if (status !== updated.status) {
        await tx.escrow.update({ where: { id: escrow.id }, data: { status } });
      }
      return true;
    });
  } catch (err) {
    if (isP2002(err)) {
      // Only a genuine duplicate of THIS entry's ref is an idempotent no-op.
      // Any other P2002 (e.g. a residual race materialising the summary row) must
      // NOT be swallowed as "already recorded" — that would silently drop a real
      // ledger movement. Re-check the ref: present → true replay (no-op); absent
      // → surface it so the best-effort caller logs/retries instead of dropping.
      const existing = await prisma.escrowEntry.findUnique({
        where: { ref: input.ref },
        select: { id: true },
      });
      if (existing) return false;
    }
    throw err;
  }
}

/**
 * Record RELEASE of a shop's net payout portion (USD cents) at disbursement
 * (the weekly batch flips the payout to PROCESSING). Idempotent per
 * (orderId, shopId). Returns whether a new entry was written.
 */
export async function releaseEscrow(input: {
  orderId: string;
  shopId: string;
  amountUsdCents: number;
  reason?: string;
}): Promise<boolean> {
  return applyEntry({
    orderId: input.orderId,
    type: "RELEASE",
    amountUsdCents: input.amountUsdCents,
    ref: escrowRef.release(input.orderId, input.shopId),
    reason: input.reason ?? "payout released at disbursement",
  });
}

/**
 * FULL payout clawback: reverse a shop's RELEASE all the way back to 0 by recording
 * a NEGATIVE RELEASE for whatever is still released. PRIOR-AWARE — it subtracts any
 * earlier reversal (a PARTIAL clawback under the relrevp ref, or a prior full
 * clawback under relrev) before choosing its amount, so a partial-then-full sequence
 * (e.g. a per-shop dispute followed by a whole-order chargeback, or a payout.reversed
 * webhook landing on a partially-clawed payout) nets released to exactly 0 instead of
 * double-subtracting into the negative and breaking reconcile(). No-op when nothing
 * is released or it is already fully reversed. Idempotent per (orderId, shopId).
 */
export async function reverseReleaseEscrow(input: {
  orderId: string;
  shopId: string;
  reason?: string;
}): Promise<boolean> {
  const original = await prisma.escrowEntry.findUnique({
    where: { ref: escrowRef.release(input.orderId, input.shopId) },
    select: { amountUsdCents: true },
  });
  if (!original || original.amountUsdCents <= 0) return false; // nothing released
  const priors = await prisma.escrowEntry.findMany({
    where: {
      ref: {
        in: [
          escrowRef.releaseReversal(input.orderId, input.shopId),
          escrowRef.releaseReversalPartial(input.orderId, input.shopId),
        ],
      },
    },
    select: { amountUsdCents: true },
  });
  const priorReversed = priors.reduce((sum, e) => sum + e.amountUsdCents, 0); // negative
  const remaining = original.amountUsdCents + priorReversed;
  if (remaining <= 0) return false; // already fully reversed (or over) — idempotent no-op
  return applyEntry({
    orderId: input.orderId,
    type: "RELEASE",
    amountUsdCents: -remaining,
    ref: escrowRef.releaseReversal(input.orderId, input.shopId),
    reason: input.reason ?? "payout clawback",
  });
}

/**
 * Record a REFUND to the buyer (USD cents). Idempotent per order via the refund
 * ref — a second refund attempt on an already-refunded order is a no-op, which
 * is the ledger half of the single-refund guarantee.
 */
export async function refundEscrow(input: {
  orderId: string;
  amountUsdCents: number;
  reason?: string;
}): Promise<boolean> {
  return applyEntry({
    orderId: input.orderId,
    type: "REFUND",
    amountUsdCents: input.amountUsdCents,
    ref: escrowRef.refund(input.orderId),
    reason: input.reason ?? "buyer refund",
  });
}

/**
 * Record a PARTIAL REFUND to the buyer for ONE shop's disputed items (Wave 2
 * per-shop disputes). Uses a per-(order, shop) ref so it is idempotent PER SHOP:
 * refunding shop A never blocks a later refund of shop B on the same order, and a
 * replayed shop-A refund is a no-op. Increments the same `refundedUsdCents`
 * counter as a full refund, so the summary reads PARTIALLY_REFUNDED while the
 * refunded total is below the held total — and the ledger still reconciles
 * (held == released + refunded + stillHeld). Idempotent per (orderId, shopId).
 */
export async function refundShopEscrow(input: {
  orderId: string;
  shopId: string;
  amountUsdCents: number;
  reason?: string;
}): Promise<boolean> {
  return applyEntry({
    orderId: input.orderId,
    type: "REFUND",
    amountUsdCents: input.amountUsdCents,
    ref: escrowRef.refundShop(input.orderId, input.shopId),
    reason: input.reason ?? "buyer partial refund (per-shop dispute)",
  });
}

/**
 * True once a per-shop REFUND entry exists for (order, shop) — the durable signal
 * that this per-shop refund already completed its gateway path. Used as the
 * refundOrderItems idempotency guard INSTEAD of OrderItem.status: dispute
 * resolution pre-flips the disputed items to REFUNDED in its own committed
 * transaction BEFORE the refund worker runs, so item status would look like an
 * already-processed replay and wrongly skip the real gateway refund. The escrow
 * entry only exists AFTER stripeRefund succeeded, so it is the correct signal.
 */
export async function shopRefundRecorded(orderId: string, shopId: string): Promise<boolean> {
  const entry = await prisma.escrowEntry.findUnique({
    where: { ref: escrowRef.refundShop(orderId, shopId) },
    select: { id: true },
  });
  return Boolean(entry);
}

/**
 * Total REFUND recorded so far for an order (USD cents), from the cached summary.
 * 0 when the order has no escrow row. Lets a whole-order refund return ONLY the
 * remainder on top of any prior per-shop partial refunds, so a full refund that
 * follows a partial can't over-refund (negative stillHeld / double-count).
 */
export async function getRefundedUsdCents(orderId: string): Promise<number> {
  const escrow = await prisma.escrow.findUnique({
    where: { orderId },
    select: { refundedUsdCents: true },
  });
  return escrow?.refundedUsdCents ?? 0;
}

/**
 * Reduce a shop's NET released escrow DOWN TO `targetUsdCents` by recording a
 * negative RELEASE for the difference — a PARTIAL payout clawback that reverses
 * only the disputed items' portion while leaving the undisputed (still-owed)
 * release intact. Reads the original RELEASE minus any prior reversal so re-runs
 * converge; idempotent per (order, shop) via the partial-reversal ref. No-op when
 * already at/below target or when nothing was released for the shop.
 */
export async function reverseReleaseEscrowToTarget(input: {
  orderId: string;
  shopId: string;
  targetUsdCents: number;
  reason?: string;
}): Promise<boolean> {
  const original = await prisma.escrowEntry.findUnique({
    where: { ref: escrowRef.release(input.orderId, input.shopId) },
    select: { amountUsdCents: true },
  });
  if (!original || original.amountUsdCents <= 0) return false; // nothing released
  const priors = await prisma.escrowEntry.findMany({
    where: {
      ref: {
        in: [
          escrowRef.releaseReversal(input.orderId, input.shopId),
          escrowRef.releaseReversalPartial(input.orderId, input.shopId),
        ],
      },
    },
    select: { amountUsdCents: true },
  });
  const priorReversed = priors.reduce((sum, e) => sum + e.amountUsdCents, 0); // negative
  const currentNet = original.amountUsdCents + priorReversed;
  const target = Math.max(0, input.targetUsdCents);
  const delta = currentNet - target;
  if (delta <= 0) return false; // already netted down to (or below) target
  return applyEntry({
    orderId: input.orderId,
    type: "RELEASE",
    amountUsdCents: -delta,
    ref: escrowRef.releaseReversalPartial(input.orderId, input.shopId),
    reason: input.reason ?? "partial payout clawback (per-shop dispute)",
  });
}

export type EscrowSummary = {
  orderId: string;
  status: EscrowStatus;
  heldUsdCents: number;
  releasedUsdCents: number;
  refundedUsdCents: number;
  /** held - released - refunded — platform funds still in custody. */
  stillHeldUsdCents: number;
  /** True when the ledger balances (stillHeld >= 0 and entries sum to summary). */
  reconciled: boolean;
};

/**
 * Read the escrow summary for an order (for the admin dashboard). Recomputes the
 * running totals from the append-only entries and cross-checks them against the
 * cached summary, so a drift between the two surfaces as reconciled=false.
 * Returns null when the order has no escrow record.
 */
export async function getEscrowSummary(orderId: string): Promise<EscrowSummary | null> {
  const escrow = await prisma.escrow.findUnique({
    where: { orderId },
    include: { entries: { select: { type: true, amountUsdCents: true } } },
  });
  if (!escrow) return null;

  let held = 0;
  let released = 0;
  let refunded = 0;
  for (const e of escrow.entries) {
    if (e.type === "HOLD") held += e.amountUsdCents;
    else if (e.type === "RELEASE") released += e.amountUsdCents;
    else refunded += e.amountUsdCents;
  }

  const stillHeldUsdCents = held - released - refunded;
  // The summary must match the recomputed ledger, funds can't be over-released
  // or over-refunded, and nothing may go negative.
  const reconciled =
    stillHeldUsdCents >= 0 &&
    released >= 0 &&
    refunded >= 0 &&
    held === escrow.heldUsdCents &&
    released === escrow.releasedUsdCents &&
    refunded === escrow.refundedUsdCents;

  if (!reconciled) {
    eslog.error(
      {
        orderId,
        ledger: { held, released, refunded, stillHeldUsdCents },
        summary: {
          held: escrow.heldUsdCents,
          released: escrow.releasedUsdCents,
          refunded: escrow.refundedUsdCents,
        },
      },
      "escrow reconciliation mismatch",
    );
  }

  return {
    orderId,
    status: escrow.status,
    heldUsdCents: escrow.heldUsdCents,
    releasedUsdCents: escrow.releasedUsdCents,
    refundedUsdCents: escrow.refundedUsdCents,
    stillHeldUsdCents,
    reconciled,
  };
}
