// Order lifecycle helpers: create from cart (transactional snapshot), and
// fetch helpers for buyer + seller surfaces. Pricing/fees are computed via
// src/lib/fees.ts; FX comes from src/lib/stubs.ts. No external I/O here.

import { Prisma } from "@prisma/client";
import type { OrderItemStatus, OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { FX_USD_TO_INR } from "@/lib/stubs";
import { usdCentsToInrPaiseAt } from "@/lib/fx";
import { estimateLanded } from "@/lib/customs";

export type ShippingAddress = {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone?: string;
};

export type CreateOrderInput = {
  userId: string;
  shippingAddress: ShippingAddress;
  fxRate?: number;
};

export type CreateOrderResult = {
  orderId: string;
  totalUsdCents: number;
};

/**
 * Convert a user's cart into a placed Order in a single DB transaction:
 *   - snapshot per-line USD + INR prices into OrderItem (incl. shopId for splits)
 *   - create the Payment row (PENDING)
 *   - clear the cart
 *
 * Throws "CART_EMPTY" if there is nothing to order. Throws "PRODUCT_UNAVAILABLE"
 * if any cart line points at a non-published product (defensive — cart.ts
 * guards on add, but listings can be unpublished after the fact).
 */
export async function createOrderFromCart(
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const fxRate = input.fxRate ?? FX_USD_TO_INR;

  // Read outside the transaction to keep the TX short; re-validate inside.
  const cart = await prisma.cart.findUnique({
    where: { userId: input.userId },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              status: true,
              shopId: true,
              priceUsdCents: true,
              inventory: true,
              title: true,
              shop: { select: { category: true } },
            },
          },
        },
      },
    },
  });
  if (!cart || cart.items.length === 0) throw new Error("CART_EMPTY");
  for (const it of cart.items) {
    if (it.product.status !== "PUBLISHED") throw new Error("PRODUCT_UNAVAILABLE");
    if (it.product.inventory < it.qty) throw new Error("OUT_OF_STOCK");
  }

  // Compute landed cost (subtotal + shipping + duty + service) for the actual
  // destination, so the order total reflects what the buyer is being charged.
  const landed = estimateLanded(
    cart.items.map((it) => ({
      category: it.product.shop.category,
      lineSubtotalUsdCents: it.qty * it.product.priceUsdCents,
    })),
    input.shippingAddress.country,
  );
  const subtotal = landed.subtotalUsdCents;
  const shipping = landed.shippingUsdCents;
  // TODO(schema): break duty + service into their own columns. Today we lump
  // them into feesUsdCents and re-derive at display time using customs.ts.
  const fees = landed.dutyUsdCents + landed.serviceUsdCents;
  const total = landed.totalUsdCents;

  // Single TX so cart-clear + order create are atomic.
  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        buyerId: input.userId,
        status: "PLACED",
        currency: "USD",
        subtotalUsdCents: subtotal,
        shippingUsdCents: shipping,
        feesUsdCents: fees,
        totalUsdCents: total,
        fxRate: new Prisma.Decimal(fxRate),
        shippingAddress: input.shippingAddress as unknown as Prisma.InputJsonValue,
        items: {
          create: cart.items.map((it) => ({
            productId: it.product.id,
            shopId: it.product.shopId,
            qty: it.qty,
            unitPriceUsdCents: it.product.priceUsdCents,
            // Snapshot INR at the order's resolved fxRate so payouts settle at
            // the rate the buyer was quoted (not a later static rate).
            unitPriceInrPaise: usdCentsToInrPaiseAt(it.product.priceUsdCents, fxRate),
          })),
        },
        payment: {
          create: {
            provider: "stripe",
            status: "PENDING",
            amountUsdCents: total,
          },
        },
      },
      select: { id: true, totalUsdCents: true },
    });

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return created;
  });

  return { orderId: order.id, totalUsdCents: order.totalUsdCents };
}

/**
 * Derive an order's headline status after per-shop disputes resolve (Wave 2).
 * With per-shop disputes Order.status can't be a single all-or-nothing flag, so:
 *   - any dispute still OPEN/UNDER_REVIEW  → DISPUTED (order stays flagged)
 *   - no open disputes AND every item REFUNDED → REFUNDED (whole order refunded)
 *   - no open disputes AND some items still active → back to the fulfillment
 *     status (DELIVERED if delivered, else PAID); per-item REFUNDED marks carry
 *     the partial-refund detail instead of the order-level flag.
 * Pure/​testable — the caller supplies the item statuses + open-dispute flag.
 */
export function deriveOrderStatus(input: {
  hasOpenDisputes: boolean;
  itemStatuses: OrderItemStatus[];
  deliveredAt: Date | null;
}): Extract<OrderStatus, "DISPUTED" | "REFUNDED" | "DELIVERED" | "PAID"> {
  if (input.hasOpenDisputes) return "DISPUTED";
  const allRefunded =
    input.itemStatuses.length > 0 && input.itemStatuses.every((s) => s === "REFUNDED");
  if (allRefunded) return "REFUNDED";
  return input.deliveredAt ? "DELIVERED" : "PAID";
}

/**
 * Recompute + persist Order.status from the current per-item statuses and
 * open-dispute count, inside the caller's transaction. Used by dispute
 * resolution so an order that had one of several shops refunded settles to the
 * right headline status. Runs on a tx client so it commits atomically with the
 * resolution.
 */
export async function refreshOrderStatusAfterDisputeResolution(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const [openDisputes, order] = await Promise.all([
    tx.dispute.count({
      where: { orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
    }),
    tx.order.findUnique({
      where: { id: orderId },
      select: { deliveredAt: true, items: { select: { status: true } } },
    }),
  ]);
  if (!order) return;

  const next = deriveOrderStatus({
    hasOpenDisputes: openDisputes > 0,
    itemStatuses: order.items.map((i) => i.status),
    deliveredAt: order.deliveredAt,
  });
  await tx.order.update({ where: { id: orderId }, data: { status: next } });
}

const buyerOrderInclude = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          slug: true,
          title: true,
          images: { orderBy: { position: "asc" as const }, take: 1, select: { url: true } },
          shop: { select: { name: true, slug: true } },
        },
      },
    },
  },
  payment: true,
} satisfies Prisma.OrderInclude;

export async function getOrderForBuyer(userId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, buyerId: userId },
    include: buyerOrderInclude,
  });
}

export async function getOrdersForBuyer(userId: string) {
  return prisma.order.findMany({
    where: { buyerId: userId },
    orderBy: { placedAt: "desc" },
    include: buyerOrderInclude,
  });
}

const sellerOrderInclude = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          slug: true,
          title: true,
          images: { orderBy: { position: "asc" as const }, take: 1, select: { url: true } },
        },
      },
    },
  },
  payment: { select: { status: true } },
  buyer: { select: { name: true, email: true } },
} satisfies Prisma.OrderInclude;

/** Returns the order ONLY if at least one item belongs to the seller's shop. */
export async function getOrderForSeller(userId: string, orderId: string) {
  const shop = await prisma.shop.findUnique({
    where: { ownerId: userId },
    select: { id: true },
  });
  if (!shop) return null;

  const order = await prisma.order.findFirst({
    where: { id: orderId, items: { some: { shopId: shop.id } } },
    include: sellerOrderInclude,
  });
  if (!order) return null;

  // Hide other shops' items from this seller's view.
  return {
    ...order,
    shopId: shop.id,
    items: order.items.filter((it) => it.shopId === shop.id),
  };
}

export async function getOrdersForSeller(userId: string) {
  const shop = await prisma.shop.findUnique({
    where: { ownerId: userId },
    select: { id: true },
  });
  if (!shop) return { shopId: null as string | null, orders: [] as Awaited<ReturnType<typeof listOrdersForShop>> };

  const orders = await listOrdersForShop(shop.id);
  return { shopId: shop.id, orders };
}

async function listOrdersForShop(shopId: string) {
  return prisma.order.findMany({
    where: { items: { some: { shopId } }, status: { not: "PLACED" } },
    orderBy: { placedAt: "desc" },
    include: {
      items: {
        where: { shopId },
        select: {
          id: true,
          qty: true,
          unitPriceUsdCents: true,
          product: { select: { id: true, slug: true, title: true } },
        },
      },
      payment: { select: { status: true } },
      buyer: { select: { name: true, email: true } },
    },
  });
}
