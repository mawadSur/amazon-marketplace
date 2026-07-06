// Shipment orchestration: create labels via the Shiprocket stub, append
// tracking events, and on delivery flip the order + mark payouts paid.
//
// JSON-stored event shape (append-only):
//   [{ at: string ISO, status: ShipmentStatus, note?: string }, ...]
//
// Module 5 owns this file. The seller "Mark shipped" route and the dev
// "Advance status" API both route through here so all status writes share
// one code path.

import type { Prisma, ShipmentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { shiprocketCreateShipment } from "@/lib/stubs";
import { enqueuePayouts, markPayoutPaid } from "@/lib/payouts";
import { sendShippingUpdate } from "@/lib/email";

const logger = log.child({ module: "shipments" });

/**
 * Fire a shipping-update email to the order's buyer. Fire-and-forget: email is
 * a notification side-channel and must never block or fail a status write.
 */
function notifyShippingUpdate(
  to: string | null | undefined,
  inp: { orderId: string; status: string; trackingNumber?: string | null },
): void {
  if (!to) return;
  void sendShippingUpdate(to, inp).catch((err) => {
    logger.error({ err, orderId: inp.orderId }, "shipping update email failed");
  });
}

export type ShipmentEvent = {
  at: string;
  status: ShipmentStatus;
  note?: string;
};

/** Lifecycle order used by simulateShipmentProgress + buyer/seller UIs. */
export const SHIPMENT_LIFECYCLE: ShipmentStatus[] = [
  "LABEL_PENDING",
  "LABEL_CREATED",
  "PICKED_UP",
  "IN_TRANSIT",
  "CUSTOMS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

function readEvents(raw: Prisma.JsonValue | null | undefined): ShipmentEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ShipmentEvent[] = [];
  for (const row of raw) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const r = row as Record<string, unknown>;
      const at = typeof r.at === "string" ? r.at : null;
      const status = typeof r.status === "string" ? (r.status as ShipmentStatus) : null;
      if (at && status) {
        const note = typeof r.note === "string" ? r.note : undefined;
        out.push({ at, status, ...(note ? { note } : {}) });
      }
    }
  }
  return out;
}

/**
 * Create a Shiprocket shipment for one of a seller's orders.
 *
 *   - verifies the order belongs to this seller (at least one item from their shop)
 *   - rejects if a Shipment already exists OR order is not in PAID/PROCESSING
 *   - sums product weights (default 500g per unit when weightGrams is null)
 *   - calls the shiprocket stub for tracking number + label + customs doc
 *   - writes Shipment row (LABEL_CREATED) with an initial event
 *   - flips Order to SHIPPED + shippedAt
 *
 * Throws: NO_SHOP | ORDER_NOT_FOUND | INVALID_STATE | ALREADY_SHIPPED.
 */
export async function createShipment(input: {
  orderId: string;
  sellerId: string;
}) {
  const shop = await prisma.shop.findUnique({
    where: { ownerId: input.sellerId },
    select: { id: true },
  });
  if (!shop) throw new Error("NO_SHOP");

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, items: { some: { shopId: shop.id } } },
    select: {
      id: true,
      status: true,
      shippingAddress: true,
      buyer: { select: { email: true } },
      shipment: { select: { id: true } },
      items: {
        select: {
          qty: true,
          unitPriceInrPaise: true,
          product: { select: { weightGrams: true, title: true, slug: true } },
        },
      },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.shipment) throw new Error("ALREADY_SHIPPED");
  if (order.status !== "PAID" && order.status !== "PROCESSING") {
    throw new Error("INVALID_STATE");
  }

  // Default 500g per unit if weight is missing on the product.
  let weightGrams = 0;
  for (const it of order.items) {
    weightGrams += it.qty * (it.product.weightGrams ?? 500);
  }
  if (weightGrams <= 0) weightGrams = 500;

  // The shipping address is stored as JSON on the order; project it to the
  // fields Shiprocket needs. See ShippingAddress in src/lib/orders.ts.
  const addr = (order.shippingAddress ?? {}) as {
    fullName?: string;
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    phone?: string;
  };
  const destinationCountry = addr.country ?? "US";

  // Build itemized line items + sub_total from real order data. Shiprocket is an
  // India-based carrier, so selling_price/sub_total are sent in INR rupees
  // (unitPriceInrPaise / 100). Currency + field names remain NEEDS-CONFIRMATION.
  const orderItems = order.items.map((it) => ({
    name: it.product.title,
    sku: it.product.slug, // no dedicated SKU column; slug is the stable per-product key.
    units: it.qty,
    sellingPrice: it.unitPriceInrPaise / 100,
  }));
  const subTotal = order.items.reduce(
    (sum, it) => sum + (it.qty * it.unitPriceInrPaise) / 100,
    0,
  );

  const sr = await shiprocketCreateShipment({
    orderId: order.id,
    weightGrams,
    destinationCountry,
    buyerName: addr.fullName ?? "Customer",
    email: order.buyer?.email ?? undefined,
    phone: addr.phone,
    addressLine1: addr.line1 ?? "",
    addressLine2: addr.line2,
    city: addr.city ?? "",
    state: addr.region ?? "",
    pincode: addr.postalCode ?? "",
    orderItems,
    subTotal,
  });

  const now = new Date();
  const firstEvent: ShipmentEvent = {
    at: now.toISOString(),
    status: "LABEL_CREATED",
    note: `Label created via Shiprocket (${destinationCountry}).`,
  };

  const shipment = await prisma.$transaction(async (tx) => {
    const created = await tx.shipment.create({
      data: {
        orderId: order.id,
        carrier: "shiprocket",
        trackingNumber: sr.trackingNumber,
        labelUrl: sr.labelUrl,
        customsDocUrl: sr.customsDocUrl,
        status: "LABEL_CREATED",
        estimatedDelivery: sr.estimatedDelivery,
        events: [firstEvent] as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { status: "SHIPPED", shippedAt: now },
    });
    return created;
  });

  notifyShippingUpdate(order.buyer?.email, {
    orderId: order.id,
    status: "LABEL_CREATED",
    trackingNumber: sr.trackingNumber,
  });

  return shipment;
}

/**
 * Append an event + flip the shipment's status. When transitioning to
 * DELIVERED, also flips the Order to DELIVERED + deliveredAt AND marks
 * every Payout tied to this order's items as PAID via markPayoutPaid.
 *
 * Idempotent on the DELIVERED side-effects (order won't re-stamp; payouts
 * are skipped if already PAID).
 *
 * Throws: SHIPMENT_NOT_FOUND.
 */
export async function updateShipmentStatus(input: {
  shipmentId: string;
  status: ShipmentStatus;
  eventNote?: string;
}) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    select: {
      id: true,
      orderId: true,
      status: true,
      events: true,
      trackingNumber: true,
      order: { select: { buyer: { select: { email: true } } } },
    },
  });
  if (!shipment) throw new Error("SHIPMENT_NOT_FOUND");

  // Idempotency: no-op if status is unchanged.
  if (shipment.status === input.status) {
    return prisma.shipment.findUnique({ where: { id: shipment.id } });
  }

  const now = new Date();
  const events = readEvents(shipment.events);
  events.push({
    at: now.toISOString(),
    status: input.status,
    ...(input.eventNote ? { note: input.eventNote } : {}),
  });

  const updated = await prisma.shipment.update({
    where: { id: shipment.id },
    data: {
      status: input.status,
      events: events as unknown as Prisma.InputJsonValue,
    },
  });

  notifyShippingUpdate(shipment.order?.buyer?.email, {
    orderId: shipment.orderId,
    status: input.status,
    trackingNumber: shipment.trackingNumber,
  });

  if (input.status === "DELIVERED") {
    // Flip order to DELIVERED if not already.
    const order = await prisma.order.findUnique({
      where: { id: shipment.orderId },
      select: { id: true, status: true, deliveredAt: true, items: { select: { id: true } } },
    });
    if (order) {
      if (order.status !== "DELIVERED" && !order.deliveredAt) {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: "DELIVERED", deliveredAt: now },
        });
      }

      // Payouts are HELD until delivery (see src/lib/payouts.ts). Release them
      // now: create one PROCESSING Payout per shop and initiate RazorpayX.
      // Idempotent per (orderId, shopId), so a duplicate DELIVERED event (e.g. a
      // re-sent tracking webhook) can't double-pay a seller.
      await enqueuePayouts(order.id);

      // In dev there is no RazorpayX webhook to confirm disbursement, so flip
      // the just-created rows to PAID here to complete the flow. In production
      // the payout.processed webhook (markPayoutPaid) does this once the money
      // actually lands.
      if (env.NODE_ENV !== "production") {
        const itemIds = order.items.map((it) => it.id);
        if (itemIds.length > 0) {
          const payouts = await prisma.payout.findMany({
            where: { orderItemIds: { hasSome: itemIds } },
            select: { id: true, status: true },
          });
          for (const p of payouts) {
            if (p.status !== "PAID") {
              await markPayoutPaid({ payoutId: p.id });
            }
          }
        }
      }
    }
  }

  return updated;
}

/**
 * Advance a shipment one step forward in SHIPMENT_LIFECYCLE. No-op if the
 * shipment is already DELIVERED. Returns the updated shipment (or the
 * current row when no progression is possible).
 *
 * Throws: SHIPMENT_NOT_FOUND.
 */
export async function simulateShipmentProgress(shipmentId: string) {
  // Fail closed: this dev helper fabricates lifecycle progress (including
  // DELIVERED, which releases seller payouts). In production, status must come
  // only from real Shiprocket tracking webhooks calling updateShipmentStatus.
  if (env.NODE_ENV === "production") {
    throw new Error("SIMULATION_DISABLED");
  }

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { id: true, status: true },
  });
  if (!shipment) throw new Error("SHIPMENT_NOT_FOUND");

  const idx = SHIPMENT_LIFECYCLE.indexOf(shipment.status);
  // If the current status isn't on the happy path (EXCEPTION/RETURNED) or
  // already terminal, return without changes.
  if (idx < 0 || idx >= SHIPMENT_LIFECYCLE.length - 1) {
    return prisma.shipment.findUnique({ where: { id: shipment.id } });
  }

  const next = SHIPMENT_LIFECYCLE[idx + 1];
  return updateShipmentStatus({
    shipmentId: shipment.id,
    status: next,
    eventNote: `Advanced to ${next.toLowerCase().replace(/_/g, " ")} (dev).`,
  });
}

/** Read helper used by buyer/seller/public tracking pages. */
export async function getShipmentByOrderId(orderId: string) {
  return prisma.shipment.findUnique({ where: { orderId } });
}

export async function getShipmentByTrackingNumber(trackingNumber: string) {
  return prisma.shipment.findUnique({ where: { trackingNumber } });
}

/** Parse the JSON events column into a sorted (oldest-first) array. */
export function parseShipmentEvents(raw: Prisma.JsonValue | null | undefined): ShipmentEvent[] {
  return readEvents(raw).sort((a, b) => a.at.localeCompare(b.at));
}
