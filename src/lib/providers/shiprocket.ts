// Shiprocket logistics provider (Module 5).
//
// Extracted from src/lib/stubs.ts. Implements the real Shiprocket flow:
// authenticate (cached token) -> create an ad-hoc order -> assign an AWB
// (tracking number) -> generate a shipping label -> (international) generate a
// customs invoice. Returns the documented shape.
//
// Gating (fail-closed in prod):
//   - creds present (SHIPROCKET_EMAIL + SHIPROCKET_PASSWORD) -> real API.
//   - creds absent AND NODE_ENV !== "production" -> dev stub.
//   - creds absent AND NODE_ENV === "production" -> throw (fail closed).
//
// Signature is stable and re-exported from "@/lib/stubs".
//
// REQUEST/RESPONSE FIELD MAPPING — NEEDS CONFIRMATION. The ad-hoc order payload
// below is now built from REAL order data (buyer, full shipping address,
// itemized line items, sub_total) forwarded by createShipment(). The exact
// Shiprocket field NAMES, the currency expected for selling_price/sub_total
// (this code sends INR rupees, matching Shiprocket's India-based domestic
// contract), and the pickup_location nickname (env.SHIPROCKET_PICKUP_LOCATION,
// which must match a nickname configured in the Shiprocket dashboard) all still
// need to be confirmed against the live API docs before go-live.

import { env } from "@/lib/env";
import { log } from "@/lib/log";

const logger = log.child({ module: "shiprocket" });

const API_BASE = "https://apiv2.shiprocket.in/v1/external";
// Shiprocket tokens are valid for ~10 days; refresh a little early.
const TOKEN_TTL_MS = 9 * 24 * 60 * 60_000;

type ShipmentResult = {
  trackingNumber: string;
  labelUrl: string;
  customsDocUrl: string;
  estimatedDelivery: Date;
};

/** One itemized line for the ad-hoc order payload. */
export type ShiprocketOrderItem = {
  name: string;
  sku: string;
  units: number;
  /** Per-unit selling price in the carrier's currency (INR rupees). */
  sellingPrice: number;
};

/**
 * Real input contract for a Shiprocket ad-hoc order. createShipment() populates
 * every field from the order + its shipping address + line items so the provider
 * never has to fabricate a placeholder customer/address/sub_total.
 */
export type ShiprocketShipmentInput = {
  orderId: string;
  weightGrams: number;
  destinationCountry: string;
  // Buyer + shipping address (real order data).
  buyerName: string;
  email?: string;
  phone?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  pincode: string;
  // Itemized line items + order subtotal (carrier currency, INR rupees).
  orderItems: ShiprocketOrderItem[];
  subTotal: number;
};

function hasCreds(): boolean {
  return Boolean(env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD);
}

// Module-level token cache shared across invocations in the same process.
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body: body.slice(0, 300) }, "shiprocket auth failed");
    throw new Error(`Shiprocket auth failed (${res.status}).`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Shiprocket auth response missing token.");

  cachedToken = { token: data.token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return data.token;
}

async function api<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ path, status: res.status, body: body.slice(0, 300) }, "shiprocket api error");
    throw new Error(`Shiprocket ${path} failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function shiprocketCreateShipment(inp: ShiprocketShipmentInput): Promise<ShipmentResult> {
  if (hasCreds()) {
    // 1) Create an ad-hoc order from REAL order data. Field NAMES + currency are
    //    still NEEDS-CONFIRMATION (see header), but the values are no longer
    //    placeholders: buyer, full shipping address, itemized line items, and
    //    sub_total all come from createShipment().
    //
    // Split the buyer's full name into first/last as Shiprocket's ad-hoc order
    // expects separate fields.
    const nameParts = inp.buyerName.trim().split(/\s+/);
    const firstName = nameParts[0] || "Customer";
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

    const order = await api<{ order_id: number; shipment_id: number }>(
      "/orders/create/adhoc",
      {
        method: "POST",
        body: JSON.stringify({
          order_id: inp.orderId,
          order_date: new Date().toISOString().slice(0, 10),
          // pickup_location must match a nickname configured in the Shiprocket
          // dashboard (NEEDS-CONFIRMATION that "Primary" / this env value exists).
          pickup_location: env.SHIPROCKET_PICKUP_LOCATION,
          billing_customer_name: firstName,
          billing_last_name: lastName,
          billing_address: inp.addressLine1,
          billing_address_2: inp.addressLine2 ?? "",
          billing_city: inp.city,
          billing_state: inp.state,
          billing_pincode: inp.pincode,
          billing_country: inp.destinationCountry,
          billing_email: inp.email ?? "",
          billing_phone: inp.phone ?? "",
          shipping_is_billing: true,
          order_items: inp.orderItems.map((it) => ({
            name: it.name,
            sku: it.sku,
            units: it.units,
            selling_price: it.sellingPrice,
          })),
          payment_method: "Prepaid",
          sub_total: inp.subTotal,
          length: 10,
          breadth: 10,
          height: 10,
          weight: Math.max(inp.weightGrams, 1) / 1000, // Shiprocket expects kg.
        }),
      },
    );

    // 2) Assign an AWB (tracking number).
    const awb = await api<{ response?: { data?: { awb_code?: string; etd?: string } } }>(
      "/courier/assign/awb",
      { method: "POST", body: JSON.stringify({ shipment_id: order.shipment_id }) },
    );
    const trackingNumber = awb.response?.data?.awb_code ?? String(order.shipment_id);

    // 3) Generate the shipping label.
    const label = await api<{ label_url?: string }>("/courier/generate/label", {
      method: "POST",
      body: JSON.stringify({ shipment_id: [order.shipment_id] }),
    });

    // 4) International shipments need a customs invoice.
    const isInternational = inp.destinationCountry.toUpperCase() !== "IN";
    let customsDocUrl = "";
    if (isInternational) {
      const invoice = await api<{ invoice_url?: string }>("/orders/print/invoice", {
        method: "POST",
        body: JSON.stringify({ ids: [order.order_id] }),
      });
      customsDocUrl = invoice.invoice_url ?? "";
    }

    const etd = awb.response?.data?.etd;
    const estimatedDelivery = etd ? new Date(etd) : new Date(Date.now() + 9 * 24 * 60 * 60_000);

    logger.info({ orderId: inp.orderId, trackingNumber }, "shiprocket shipment created");
    return {
      trackingNumber,
      labelUrl: label.label_url ?? "",
      customsDocUrl,
      estimatedDelivery,
    };
  }

  if (env.NODE_ENV === "production") {
    // Fail closed: never fabricate a tracking number in production.
    throw new Error(
      "Shipping unavailable: Shiprocket is not configured (set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD).",
    );
  }

  // Dev stub: deterministic fake shipment so local flows work end-to-end.
  logger.warn({ orderId: inp.orderId }, "shiprocket dev stub — creds not configured");
  const eta = new Date(Date.now() + 9 * 24 * 60 * 60_000);
  return {
    trackingNumber: `SR${inp.orderId.toUpperCase()}`,
    labelUrl: `/stub/labels/${inp.orderId}.pdf`,
    customsDocUrl: `/stub/customs/${inp.orderId}.pdf`,
    estimatedDelivery: eta,
  };
}
