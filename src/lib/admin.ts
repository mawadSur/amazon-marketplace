// Admin-side mutations and read helpers for Module 7.
//
// All writes happen inside a transaction with a paired AdminAction row, so the
// audit log can never disagree with reality.
//
// Module 2 already exports a seller-facing `publishProduct`; the admin version
// here is `adminPublishProduct` to avoid name collisions when both are imported.

import { prisma } from "@/lib/db";
import { applyBadgeNow } from "@/lib/badges";
import { enqueueStoryVideo } from "@/lib/story-video";
import {
  listStrandedPayouts,
  retryPayout,
  retryStrandedPayoutsForShop,
  type RetryPayoutResult,
} from "@/lib/payouts";
import { runPayoutBatch, type PayoutBatchResult } from "@/lib/payout-batch";
import { env } from "@/lib/env";
import { nextPayoutRunAt, payoutBatchCron, payoutRunWeekdayName } from "@/lib/queue";

// ---------------------------------------------------------------- shops

export async function approveShop(shopId: string, adminId: string, reason?: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error("SHOP_NOT_FOUND");

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.shop.update({
      where: { id: shopId },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
      },
    });
    await tx.adminAction.create({
      data: {
        adminId,
        targetType: "shop",
        targetId: shopId,
        action: "approve",
        reason: reason ?? null,
      },
    });
    return u;
  });

  // Re-derive badge from the canonical rules (VERIFIED or TOP_RATED depending
  // on KYC + reviews). Best-effort; never roll back approval on a badge failure.
  try {
    await applyBadgeNow(shopId);
  } catch {
    /* ignore */
  }

  // Trigger Provenance Story generation (D3) — best-effort, runs async via
  // the ai.story_video worker. Approval is what unlocks the shop for buyers,
  // so generating the story now means the storefront has it ready.
  try {
    await enqueueStoryVideo(shopId);
  } catch {
    /* worker not running / Redis missing — story can be regenerated later */
  }

  return updated;
}

export async function rejectShop(shopId: string, adminId: string, reason: string) {
  if (!reason || !reason.trim()) throw new Error("REASON_REQUIRED");
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error("SHOP_NOT_FOUND");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.shop.update({
      where: { id: shopId },
      data: { status: "REJECTED" },
    });
    await tx.adminAction.create({
      data: {
        adminId,
        targetType: "shop",
        targetId: shopId,
        action: "reject",
        reason,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------- products

export async function adminPublishProduct(
  productId: string,
  adminId: string,
  reason?: string,
) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("PRODUCT_NOT_FOUND");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id: productId },
      data: { status: "PUBLISHED", publishedAt: new Date(), rejectionNote: null },
    });
    await tx.adminAction.create({
      data: {
        adminId,
        targetType: "product",
        targetId: productId,
        action: "approve",
        reason: reason ?? null,
      },
    });
    return updated;
  });
}

export async function rejectProduct(productId: string, adminId: string, reason: string) {
  if (!reason || !reason.trim()) throw new Error("REASON_REQUIRED");
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("PRODUCT_NOT_FOUND");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id: productId },
      data: { status: "REJECTED", rejectionNote: reason },
    });
    await tx.adminAction.create({
      data: {
        adminId,
        targetType: "product",
        targetId: productId,
        action: "reject",
        reason,
      },
    });
    return updated;
  });
}

// ---------------------------------------------------------------- dashboard summary

export type NamedCount = { key: string; label: string; count: number };
export type GmvPoint = { date: string; gmvUsdCents: number; orders: number };
export type TopShop = { shopId: string; name: string; units: number; revenueUsdCents: number };
export type TopProduct = { productId: string; title: string; units: number; revenueUsdCents: number };

/** One-shot dashboard KPI bundle. Independent queries run in one Promise.all;
 * the top-shop/product name lookups depend on the OrderItem roll-up so run
 * after. Money stays in integer minor units (USD cents / INR paise). */
export async function summary() {
  const now = Date.now();
  const d1 = new Date(now - 24 * 60 * 60 * 1000);
  const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [
    pendingSellers,
    pendingListings,
    openDisputes,
    ordersAllTime,
    ordersLast24h,
    gmvAllAgg,
    gmv24hAgg,
    gmv7dAgg,
    gmv30dAgg,
    feesAllAgg,
    ordersByStatusRaw,
    paymentsByStatusRaw,
    payoutsHeldAgg,
    payoutsReversed,
    stranded,
    disputesByReasonRaw,
    protectionByStatusRaw,
    kycByStatusRaw,
    shopsByStatusRaw,
    fundsHeldAgg,
    orderItems,
    gmvSeriesRows,
    recentActions,
  ] = await Promise.all([
    prisma.shop.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.product.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.dispute.count({ where: { status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
    prisma.order.count(),
    prisma.order.count({ where: { placedAt: { gte: d1 } } }),
    prisma.order.aggregate({ _sum: { totalUsdCents: true } }),
    prisma.order.aggregate({ where: { placedAt: { gte: d1 } }, _sum: { totalUsdCents: true } }),
    prisma.order.aggregate({ where: { placedAt: { gte: d7 } }, _sum: { totalUsdCents: true } }),
    prisma.order.aggregate({ where: { placedAt: { gte: d30 } }, _sum: { totalUsdCents: true } }),
    prisma.order.aggregate({ _sum: { feesUsdCents: true } }),
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.payment.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.payout.aggregate({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      _sum: { amountInrPaise: true },
      _count: { _all: true },
    }),
    prisma.payout.count({ where: { status: "REVERSED" } }),
    listStrandedPayouts(),
    prisma.dispute.groupBy({ by: ["reason"], _count: { _all: true } }),
    prisma.buyerProtection.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.shopKyc.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.shop.groupBy({ by: ["status"], _count: { _all: true } }),
    // Funds held: orders with a captured payment that are past checkout but not
    // yet terminal (not delivered/completed/refunded/cancelled). Derived from
    // order + payment state — no Escrow model dependency.
    prisma.order.aggregate({
      where: {
        status: { in: ["PAID", "PROCESSING", "SHIPPED"] },
        payment: { status: "CAPTURED" },
      },
      _sum: { totalUsdCents: true },
      _count: { _all: true },
    }),
    // OrderItem roll-up for top shops/products. Revenue = sum(qty * unitPrice),
    // which Prisma groupBy can't express, so we reduce in JS. Fine at MVP scale.
    prisma.orderItem.findMany({
      select: { shopId: true, productId: true, qty: true, unitPriceUsdCents: true },
    }),
    prisma.order.findMany({
      where: { placedAt: { gte: d30 } },
      select: { placedAt: true, totalUsdCents: true },
      orderBy: { placedAt: "asc" },
    }),
    prisma.adminAction.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { admin: { select: { email: true, name: true } } },
    }),
  ]);

  function toNamedCounts<T extends { _count: { _all: number } }>(
    rows: T[],
    keyOf: (r: T) => string,
  ): NamedCount[] {
    return rows.map((r) => {
      const key = keyOf(r);
      return { key, label: key.toLowerCase().replace(/_/g, " "), count: r._count._all };
    });
  }

  const ordersByStatus: NamedCount[] = toNamedCounts(ordersByStatusRaw, (r) => r.status);
  const disputesByReason: NamedCount[] = toNamedCounts(disputesByReasonRaw, (r) => r.reason);
  const shopsByStatus: NamedCount[] = toNamedCounts(shopsByStatusRaw, (r) => r.status);

  const countsByStatus = (rows: { status: string; _count: { _all: number } }[]) =>
    Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Partial<Record<string, number>>;
  const paymentCounts = countsByStatus(paymentsByStatusRaw);
  const bp = countsByStatus(protectionByStatusRaw);
  const kyc = countsByStatus(kycByStatusRaw);

  // GMV / orders time series, bucketed by calendar day (UTC) over 30 days.
  const seriesMap = new Map<string, { gmvUsdCents: number; orders: number }>();
  for (const o of gmvSeriesRows) {
    const day = o.placedAt.toISOString().slice(0, 10);
    const cur = seriesMap.get(day) ?? { gmvUsdCents: 0, orders: 0 };
    cur.gmvUsdCents += o.totalUsdCents;
    cur.orders += 1;
    seriesMap.set(day, cur);
  }
  const gmvSeries: GmvPoint[] = [...seriesMap.entries()]
    .map(([date, v]) => ({ date, gmvUsdCents: v.gmvUsdCents, orders: v.orders }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Top shops / products by units (tie-break revenue).
  const shopAgg = new Map<string, { units: number; revenueUsdCents: number }>();
  const productAgg = new Map<string, { units: number; revenueUsdCents: number }>();
  for (const it of orderItems) {
    const rev = it.qty * it.unitPriceUsdCents;
    const s = shopAgg.get(it.shopId) ?? { units: 0, revenueUsdCents: 0 };
    s.units += it.qty;
    s.revenueUsdCents += rev;
    shopAgg.set(it.shopId, s);
    const p = productAgg.get(it.productId) ?? { units: 0, revenueUsdCents: 0 };
    p.units += it.qty;
    p.revenueUsdCents += rev;
    productAgg.set(it.productId, p);
  }
  const topShopIds = [...shopAgg.entries()]
    .sort((a, b) => b[1].units - a[1].units || b[1].revenueUsdCents - a[1].revenueUsdCents)
    .slice(0, 5);
  const topProductIds = [...productAgg.entries()]
    .sort((a, b) => b[1].units - a[1].units || b[1].revenueUsdCents - a[1].revenueUsdCents)
    .slice(0, 5);

  const [shopNames, productTitles] = await Promise.all([
    topShopIds.length
      ? prisma.shop.findMany({
          where: { id: { in: topShopIds.map(([id]) => id) } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    topProductIds.length
      ? prisma.product.findMany({
          where: { id: { in: topProductIds.map(([id]) => id) } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);
  const shopNameById = new Map(shopNames.map((s) => [s.id, s.name]));
  const productTitleById = new Map(productTitles.map((p) => [p.id, p.title]));

  const topShops: TopShop[] = topShopIds.map(([id, v]) => ({
    shopId: id,
    name: shopNameById.get(id) ?? id,
    units: v.units,
    revenueUsdCents: v.revenueUsdCents,
  }));
  const topProducts: TopProduct[] = topProductIds.map(([id, v]) => ({
    productId: id,
    title: productTitleById.get(id) ?? id,
    units: v.units,
    revenueUsdCents: v.revenueUsdCents,
  }));

  const gmvAllTimeUsdCents = gmvAllAgg._sum.totalUsdCents ?? 0;
  const aovUsdCents = ordersAllTime > 0 ? Math.round(gmvAllTimeUsdCents / ordersAllTime) : 0;
  return {
    // Backwards-compatible fields (existing tiles).
    pendingSellers,
    pendingListings,
    openDisputes,
    ordersLast24h,
    gmvLast24hUsdCents: gmv24hAgg._sum.totalUsdCents ?? 0,
    // GMV windows + revenue.
    gmvAllTimeUsdCents,
    gmv7dUsdCents: gmv7dAgg._sum.totalUsdCents ?? 0,
    gmv30dUsdCents: gmv30dAgg._sum.totalUsdCents ?? 0,
    platformFeesUsdCents: feesAllAgg._sum.feesUsdCents ?? 0,
    aovUsdCents,
    ordersAllTime,

    // Funnels / breakdowns.
    ordersByStatus,
    disputesByReason,
    shopsByStatus,

    // Payments.
    paymentsCaptured: paymentCounts.CAPTURED ?? 0,
    paymentsFailed: paymentCounts.FAILED ?? 0,

    // Payouts.
    payoutsHeldCount: payoutsHeldAgg._count._all,
    payoutsHeldInrPaise: payoutsHeldAgg._sum.amountInrPaise ?? 0,
    payoutsReversed,
    strandedCount: stranded.length,
    strandedRetryableCount: stranded.filter((p) => p.hasFundAccount).length,

    // Funds held (derived).
    fundsHeldUsdCents: fundsHeldAgg._sum.totalUsdCents ?? 0,
    fundsHeldOrders: fundsHeldAgg._count._all,

    // Buyer protection.
    bpClaimed: bp.CLAIMED ?? 0,
    bpPaid: bp.PAID ?? 0,
    bpDenied: bp.DENIED ?? 0,

    // KYC.
    kycSubmitted: kyc.SUBMITTED ?? 0,
    kycNotSubmitted: kyc.NOT_SUBMITTED ?? 0,
    kycRejected: kyc.REJECTED ?? 0,
    kycVerified: kyc.VERIFIED ?? 0,

    // Charts + leaderboards + activity.
    gmvSeries,
    topShops,
    topProducts,
    recentActions,
  };
}

// ---------------------------------------------------------------- payout ops

/** Admin-triggered retry of a single stranded payout. Delegates money-safe
 * work to payouts.retryPayout, then records an AdminAction (written regardless
 * of outcome so every attempt is traceable). */
export async function adminRetryPayout(
  payoutId: string,
  adminId: string,
  reason?: string,
): Promise<RetryPayoutResult> {
  const result = await retryPayout(payoutId);
  await prisma.adminAction.create({
    data: {
      adminId,
      targetType: "payout",
      targetId: payoutId,
      action: "retry_payout",
      reason: reason ?? `outcome:${result.status}`,
    },
  });
  return result;
}

/** Admin-triggered bulk retry of every stranded payout for a shop (e.g. right
 * after ops wires its fund account). One AdminAction summarises the batch. */
export async function adminRetryStrandedPayoutsForShop(
  shopId: string,
  adminId: string,
  reason?: string,
): Promise<RetryPayoutResult[]> {
  const results = await retryStrandedPayoutsForShop(shopId);
  const initiated = results.filter((r) => r.status === "initiated").length;
  await prisma.adminAction.create({
    data: {
      adminId,
      targetType: "shop",
      targetId: shopId,
      action: "retry_stranded_payouts",
      reason: reason ?? `retried ${results.length}, disbursed ${initiated}`,
    },
  });
  return results;
}

/** Admin-triggered "run the weekly payout batch now". Delegates to the
 * money-safe runPayoutBatch (idempotent — safe alongside the scheduled run),
 * then records an AdminAction summarising the sweep. */
export async function adminRunPayoutBatch(
  adminId: string,
  reason?: string,
): Promise<PayoutBatchResult> {
  const result = await runPayoutBatch();
  await prisma.adminAction.create({
    data: {
      adminId,
      targetType: "payout",
      targetId: "batch",
      action: "run_payout_batch",
      reason:
        reason ??
        `eligible ${result.eligible}, disbursed ${result.disbursed}, stranded ${result.stranded}, cancelled ${result.cancelled}, skipped ${result.skipped}`,
    },
  });
  return result;
}

/** Weekly payout schedule summary for the /admin/payouts header (cron day +
 * hold window + next run). Redis-independent — pure schedule math. */
export function getPayoutScheduleInfo() {
  return {
    weekday: payoutRunWeekdayName(),
    holdDays: env.PAYOUT_HOLD_DAYS,
    cron: payoutBatchCron(),
    nextRunAt: nextPayoutRunAt(),
  };
}

/** Held + stranded payouts for the /admin/payouts triage view: every
 * PENDING/PROCESSING payout (money owed, not yet paid), enriched with shop
 * name, order id, eligibility (PENDING held payout whose hold window has
 * elapsed), whether it is stranded (PROCESSING, no gateway id) and retryable
 * (shop has a fund account). */
export async function listHeldPayouts() {
  const [held, stranded] = await Promise.all([
    prisma.payout.findMany({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        shopId: true,
        orderId: true,
        status: true,
        amountInrPaise: true,
        razorpayPayoutId: true,
        eligibleAt: true,
        createdAt: true,
        shop: { select: { name: true } },
      },
    }),
    listStrandedPayouts(),
  ]);

  const fundedByPayout = new Map(stranded.map((s) => [s.payoutId, s.hasFundAccount]));
  const now = Date.now();
  const holdMs = env.PAYOUT_HOLD_DAYS * 24 * 60 * 60 * 1000;

  return held.map((p) => {
    const isStranded = p.status === "PROCESSING" && !p.razorpayPayoutId;
    // A held (PENDING) payout is eligible once its hold window has elapsed — it
    // will disburse on the next batch run.
    const isEligible =
      p.status === "PENDING" && !!p.eligibleAt && p.eligibleAt.getTime() + holdMs <= now;
    return {
      payoutId: p.id,
      shopId: p.shopId,
      shopName: p.shop?.name ?? p.shopId,
      orderId: p.orderId,
      status: p.status,
      amountInrPaise: p.amountInrPaise,
      eligibleAt: p.eligibleAt,
      isEligible,
      createdAt: p.createdAt,
      isStranded,
      // Only PROCESSING-without-gateway-id rows appear in listStrandedPayouts.
      hasFundAccount: fundedByPayout.get(p.id) ?? false,
    };
  });
}

// ---------------------------------------------------------------- order timeline

export type OrderTimelineEvent = {
  label: string;
  at: Date;
};

export async function getOrderTimeline(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      buyer: { select: { id: true, email: true, phone: true, name: true } },
      items: {
        include: {
          product: { select: { id: true, title: true, slug: true, shopId: true } },
        },
      },
      payment: true,
      shipment: true,
      disputes: { include: { shop: { select: { name: true } } } },
    },
  });
  if (!order) return null;

  const events: OrderTimelineEvent[] = [{ label: "Placed", at: order.placedAt }];
  if (order.paidAt) events.push({ label: "Paid", at: order.paidAt });
  if (order.shippedAt) events.push({ label: "Shipped", at: order.shippedAt });
  if (order.deliveredAt) events.push({ label: "Delivered", at: order.deliveredAt });
  if (order.completedAt) events.push({ label: "Completed", at: order.completedAt });
  if (order.cancelledAt) events.push({ label: "Cancelled", at: order.cancelledAt });

  // Payouts may not exist yet if Module 4 hasn't created them. Be defensive.
  const shopIds = Array.from(new Set(order.items.map((i) => i.shopId)));
  const payouts =
    shopIds.length > 0
      ? await prisma.payout.findMany({
          where: { shopId: { in: shopIds } },
          orderBy: { createdAt: "desc" },
        })
      : [];

  return { order, events, payouts };
}
