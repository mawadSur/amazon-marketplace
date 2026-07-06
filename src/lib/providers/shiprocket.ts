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
// REQUEST/RESPONSE MAPPING — NEEDS CONFIRMATION. Shiprocket's ad-hoc order
// endpoint requires full billing/shipping addresses, itemized line items, and a
// configured pickup location — none of which are in this function's input
// contract (orderId, weightGrams, destinationCountry). The payload below uses
// documented field names with placeholders for the missing data; see the
// follow-up: createShipment() must be extended to pass real order/address/line
// -item details before this is production-complete.

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

export async function shiprocketCreateShipment(inp: {
  orderId: string;
  weightGrams: number;
  destinationCountry: string;
}): Promise<ShipmentResult> {
  if (hasCreds()) {
    // 1) Create an ad-hoc order. Placeholder address/line-item fields flagged in
    //    the header MUST be replaced with real order data (follow-up).
    const order = await api<{ order_id: number; shipment_id: number }>(
      "/orders/create/adhoc",
      {
        method: "POST",
        body: JSON.stringify({
          order_id: inp.orderId,
          order_date: new Date().toISOString().slice(0, 10),
          // TODO(confirm): pickup_location must match a configured Shiprocket
          // pickup nickname; addresses + order_items need real order data.
          pickup_location: "Primary",
          billing_customer_name: "Customer",
          billing_country: inp.destinationCountry,
          shipping_is_billing: true,
          order_items: [],
          payment_method: "Prepaid",
          sub_total: 0,
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
