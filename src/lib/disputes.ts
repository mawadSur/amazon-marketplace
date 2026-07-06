// Dispute lifecycle for Module 6. Buyers open disputes on their orders;
// admins resolve them. All admin mutations write a paired AdminAction in
// the same transaction. A buyer-favored resolution flips the Order to REFUNDED
// AND drives real refund movement: enqueueRefund (Stripe/Razorpay) plus
// reversePayoutsForOrder to claw back any already-released seller payouts.

import { prisma } from "@/lib/db";
import { enqueueRefund } from "@/lib/payments";
import { reversePayoutsForOrder } from "@/lib/payouts";
import { claimBuyerProtection, resolveBuyerProtection } from "@/lib/buyer-protection";
import { enqueueTrustRecompute } from "@/lib/trust-score";
import type {
  Dispute,
  DisputeReason,
  DisputeStatus,
  Prisma,
} from "@prisma/client";

// ---------------------------------------------------------------- helpers

/** Recompute trust for every shop with an item in this order (best-effort). */
async function recomputeShopsForOrder(orderId: string): Promise<void> {
  try {
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { shopId: true },
    });
    const shopIds = [...new Set(items.map((i) => i.shopId))];
    await Promise.all(shopIds.map((id) => enqueueTrustRecompute(id)));
  } catch {
    /* best-effort — never block the dispute action */
  }
}

// ---------------------------------------------------------------- open

export type OpenDisputeInput = {
  orderId: string;
  buyerId: string;
  reason: DisputeReason;
  description: string;
  evidenceUrls?: string[];
};

const ORDER_OPENABLE_STATUSES = new Set([
  "PAID",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "COMPLETED",
]);

/**
 * Buyer-protection claim window: a dispute (and its full refund) can only be
 * opened within this many days of delivery. Bounds our refund liability so a
 * buyer can't claw back funds months after receiving the goods.
 */
export const DISPUTE_CLAIM_WINDOW_DAYS = 30;
const DISPUTE_CLAIM_WINDOW_MS = DISPUTE_CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Open a dispute. Throws ORDER_NOT_FOUND / ORDER_NOT_DISPUTABLE /
 * ALREADY_DISPUTED / DESCRIPTION_REQUIRED / CLAIM_WINDOW_EXPIRED.
 */
export async function openDispute(input: OpenDisputeInput): Promise<Dispute> {
  const description = input.description?.trim() ?? "";
  if (!description) throw new Error("DESCRIPTION_REQUIRED");

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, buyerId: input.buyerId },
    select: { id: true, status: true, deliveredAt: true, dispute: { select: { id: true } } },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.dispute) throw new Error("ALREADY_DISPUTED");
  if (!ORDER_OPENABLE_STATUSES.has(order.status)) {
    throw new Error("ORDER_NOT_DISPUTABLE");
  }
  // Claim window: once delivered, the buyer has DISPUTE_CLAIM_WINDOW_DAYS to
  // open a claim. Undelivered orders (deliveredAt null) are not yet bounded.
  if (order.deliveredAt && Date.now() - order.deliveredAt.getTime() > DISPUTE_CLAIM_WINDOW_MS) {
    throw new Error("CLAIM_WINDOW_EXPIRED");
  }

  const evidenceUrls = (input.evidenceUrls ?? [])
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  const dispute = await prisma.$transaction(async (tx) => {
    const d = await tx.dispute.create({
      data: {
        orderId: input.orderId,
        openedById: input.buyerId,
        reason: input.reason,
        description,
        evidenceUrls,
        status: "OPEN",
      },
    });
    await tx.order.update({
      where: { id: input.orderId },
      data: { status: "DISPUTED" },
    });
    return d;
  });

  // Flip BuyerProtection to CLAIMED outside the TX so a failure here doesn't
  // block dispute opening. Best-effort.
  try {
    await claimBuyerProtection(input.orderId);
  } catch {
    /* ignore */
  }

  // A new dispute drags the seller's trust score down — recompute.
  await recomputeShopsForOrder(input.orderId);

  return dispute;
}

// ---------------------------------------------------------------- resolve

export type ResolveDisputeInput = {
  disputeId: string;
  adminId: string;
  outcome: "BUYER" | "SELLER";
  resolution: string;
};

/**
 * Resolve a dispute: writes Dispute.status + resolution, an AdminAction, and
 * (for outcome=BUYER) flips Order to REFUNDED then drives the real refund
 * (enqueueRefund) + payout clawback (reversePayoutsForOrder). For
 * outcome=SELLER, restores Order to DELIVERED if it was ever delivered.
 */
export async function resolveDispute(input: ResolveDisputeInput): Promise<Dispute> {
  const resolution = input.resolution?.trim() ?? "";
  if (!resolution) throw new Error("RESOLUTION_REQUIRED");

  const dispute = await prisma.dispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      status: true,
      orderId: true,
      order: { select: { status: true, deliveredAt: true } },
    },
  });
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");
  if (dispute.status === "RESOLVED_BUYER" || dispute.status === "RESOLVED_SELLER") {
    throw new Error("DISPUTE_ALREADY_RESOLVED");
  }

  const nextDisputeStatus: DisputeStatus =
    input.outcome === "BUYER" ? "RESOLVED_BUYER" : "RESOLVED_SELLER";

  return prisma.$transaction(async (tx) => {
    const updated = await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: nextDisputeStatus,
        resolution,
        resolvedAt: new Date(),
      },
    });

    if (input.outcome === "BUYER") {
      await tx.order.update({
        where: { id: dispute.orderId },
        data: { status: "REFUNDED" },
      });
    } else {
      // Seller wins — restore order to DELIVERED if we know it was delivered,
      // otherwise leave it DISPUTED for ops to address.
      if (dispute.order.deliveredAt) {
        await tx.order.update({
          where: { id: dispute.orderId },
          data: { status: "DELIVERED" },
        });
      }
    }

    await tx.adminAction.create({
      data: {
        adminId: input.adminId,
        targetType: "dispute",
        targetId: dispute.id,
        action: input.outcome === "BUYER" ? "resolve_buyer" : "resolve_seller",
        reason: resolution,
      },
    });

    return updated;
  }).then(async (updated) => {
    // Side-effects outside the TX. Each is best-effort — none should roll
    // back the resolution. Admins can retry from /admin/orders/[id] if needed.
    if (input.outcome === "BUYER") {
      try {
        await enqueueRefund({ orderId: dispute.orderId, reason: resolution });
      } catch {
        /* refund retried by the payments.refund worker */
      }
      // Claw back any payouts already released to sellers (post-delivery
      // disputes). No-op when funds were still held (pre-delivery). Best-effort:
      // reversePayoutsForOrder never throws, so it can't block the buyer refund.
      await reversePayoutsForOrder(dispute.orderId, resolution);
      try {
        await resolveBuyerProtection(dispute.orderId, "PAID", resolution);
      } catch {
        /* protection resolution is best-effort */
      }
    } else {
      try {
        await resolveBuyerProtection(dispute.orderId, "DENIED", resolution);
      } catch {
        /* ignore */
      }
    }
    // Resolution may change the shop's standing — recompute trust.
    await recomputeShopsForOrder(dispute.orderId);
    return updated;
  });
}

// ---------------------------------------------------------------- reads

export type AdminDisputeFilter = {
  status?: DisputeStatus[];
  /** Default true — only show un-resolved unless overridden. */
  openOnly?: boolean;
};

const adminListInclude = {
  openedBy: { select: { id: true, email: true, name: true, phone: true } },
  order: {
    select: {
      id: true,
      status: true,
      totalUsdCents: true,
      placedAt: true,
      deliveredAt: true,
    },
  },
} satisfies Prisma.DisputeInclude;

export async function listDisputesForAdmin(filter: AdminDisputeFilter = {}) {
  const statuses =
    filter.status ??
    (filter.openOnly === false
      ? undefined
      : (["OPEN", "UNDER_REVIEW"] as DisputeStatus[]));

  return prisma.dispute.findMany({
    where: statuses ? { status: { in: statuses } } : undefined,
    orderBy: { openedAt: "desc" },
    take: 200,
    include: adminListInclude,
  });
}

const buyerDisputeInclude = {
  order: {
    select: {
      id: true,
      status: true,
      totalUsdCents: true,
      placedAt: true,
      items: {
        include: {
          product: {
            select: {
              id: true,
              slug: true,
              title: true,
              images: {
                orderBy: { position: "asc" as const },
                take: 1,
                select: { url: true },
              },
              shop: { select: { name: true, slug: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.DisputeInclude;

const adminDetailInclude = {
  openedBy: { select: { id: true, email: true, name: true, phone: true } },
  order: {
    select: {
      id: true,
      status: true,
      totalUsdCents: true,
      placedAt: true,
      deliveredAt: true,
      shippingAddress: true,
      items: {
        include: {
          product: {
            select: {
              id: true,
              slug: true,
              title: true,
              shopId: true,
              images: {
                orderBy: { position: "asc" as const },
                take: 1,
                select: { url: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.DisputeInclude;

export type AdminDisputeDetail = Prisma.DisputeGetPayload<{
  include: typeof adminDetailInclude;
}>;
export type BuyerDisputeDetail = Prisma.DisputeGetPayload<{
  include: typeof buyerDisputeInclude;
}>;

/** Admin-side dispute detail; null if not found. */
export async function getDisputeForAdmin(
  disputeId: string,
): Promise<AdminDisputeDetail | null> {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    include: adminDetailInclude,
  });
}

/** Buyer-side dispute detail; caller must verify ownership. */
export async function getDisputeForBuyer(
  disputeId: string,
): Promise<BuyerDisputeDetail | null> {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    include: buyerDisputeInclude,
  });
}

/** Role-routed wrapper. Prefer `getDisputeForAdmin` / `getDisputeForBuyer`. */
export async function getDispute(
  disputeId: string,
  role: "BUYER" | "ADMIN",
): Promise<AdminDisputeDetail | BuyerDisputeDetail | null> {
  return role === "ADMIN"
    ? getDisputeForAdmin(disputeId)
    : getDisputeForBuyer(disputeId);
}

export async function listDisputesForBuyer(buyerId: string) {
  return prisma.dispute.findMany({
    where: { openedById: buyerId },
    orderBy: { openedAt: "desc" },
    take: 100,
    include: {
      order: {
        select: {
          id: true,
          status: true,
          totalUsdCents: true,
          placedAt: true,
        },
      },
    },
  });
}
