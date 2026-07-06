// POST /api/webhooks/shiprocket
//
// Shiprocket tracking webhook — in PRODUCTION this is the ONLY path that drives a
// shipment to DELIVERED. simulateShipmentProgress (the dev advance helper) throws
// SIMULATION_DISABLED in prod, so without this webhook prod orders freeze at
// LABEL_CREATED and the seller payouts held until delivery (released on the
// DELIVERED transition in src/lib/shipments.ts) NEVER settle.
//
// Mirrors the Stripe/Razorpay webhook routes: raw body read ONCE, verify the
// caller, map the provider status, and delegate the money-touching side-effects
// to updateShipmentStatus — which is idempotent on an unchanged status (an early
// no-op return), so a re-sent DELIVERED can't double-release a payout.
//
// FAIL-CLOSED: when SHIPROCKET_WEBHOOK_SECRET is unset we refuse to process in
// production (503 WEBHOOK_NOT_CONFIGURED) — an unauthenticated status change must
// never release seller money. Only dev/test may process unauthenticated so local
// flows work end-to-end.
//
// AUTH SCHEME — NEEDS CONFIRMATION. Shiprocket's exact webhook authentication
// (header NAME + a shared token match vs an HMAC over the raw body) is not
// finalised. We default to a shared secret sent in the `x-api-key` header,
// compared in constant time. If Shiprocket actually signs the body (HMAC),
// swap verifyToken() for an HMAC-over-rawBody check like the Razorpay route
// before go-live.
//
// STATUS CODES — NEEDS CONFIRMATION. The numeric `shipment_status` codes and the
// exact `current_status` strings Shiprocket sends are matched loosely below;
// confirm the real code table before relying on the EXCEPTION/RETURNED mappings.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { ShipmentStatus } from "@prisma/client";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { getShipmentByTrackingNumber, updateShipmentStatus } from "@/lib/shipments";

const logger = log.child({ module: "webhooks/shiprocket" });

/** Constant-time shared-token compare (default auth scheme, see header). */
function verifyToken(provided: string | null, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Map a Shiprocket status string to our ShipmentStatus.
 *
 * NEEDS-CONFIRMATION: exact strings + numeric `shipment_status` codes. RTO /
 * returned and undelivered/exception are checked FIRST because "RTO Delivered"
 * contains the substring "delivered" and must not be mis-read as a real delivery.
 * Returns null for statuses we don't act on (acknowledged, not applied).
 */
function mapShiprocketStatus(raw: string): ShipmentStatus | null {
  const s = raw.toLowerCase().trim();
  if (!s) return null;
  if (s.includes("rto") || s.includes("return")) return "RETURNED";
  if (
    s.includes("undelivered") ||
    s.includes("exception") ||
    s.includes("lost") ||
    s.includes("damaged")
  ) {
    return "EXCEPTION";
  }
  if (s.includes("delivered")) return "DELIVERED";
  if (s.includes("out for delivery")) return "OUT_FOR_DELIVERY";
  if (s.includes("in transit") || s.includes("in-transit") || s.includes("shipped")) {
    return "IN_TRANSIT";
  }
  if (s.includes("picked")) return "PICKED_UP";
  return null;
}

type ShiprocketPayload = {
  awb?: string | number;
  awb_code?: string | number;
  current_status?: string;
  shipment_status?: string | number;
  status?: string;
  order_id?: string | number;
};

function extractAwb(p: ShiprocketPayload): string | null {
  const raw = p.awb ?? p.awb_code;
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

function extractStatus(p: ShiprocketPayload): string {
  return String(p.current_status ?? p.status ?? p.shipment_status ?? "");
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  const configured = Boolean(env.SHIPROCKET_WEBHOOK_SECRET);

  // ───── FAIL CLOSED (prod, no secret) ─────
  if (!configured && env.NODE_ENV === "production") {
    return NextResponse.json({ error: "WEBHOOK_NOT_CONFIGURED" }, { status: 503 });
  }

  // ───── VERIFY (real mode) ─────
  if (configured) {
    // Default auth scheme (NEEDS-CONFIRMATION): shared token in `x-api-key`.
    const token = req.headers.get("x-api-key");
    if (!verifyToken(token, env.SHIPROCKET_WEBHOOK_SECRET as string)) {
      return NextResponse.json({ error: "BAD_SIGNATURE" }, { status: 401 });
    }
  }
  // else: dev/test with no secret → process unauthenticated (local flows only).

  let payload: ShiprocketPayload;
  try {
    payload = JSON.parse(rawBody) as ShiprocketPayload;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  const awb = extractAwb(payload);
  if (!awb) {
    return NextResponse.json({ error: "MISSING_AWB" }, { status: 400 });
  }

  const statusRaw = extractStatus(payload);
  const status = mapShiprocketStatus(statusRaw);
  if (!status) {
    // Unmapped/intermediate status — acknowledge so Shiprocket stops retrying,
    // but apply nothing (we never guess a money-releasing transition).
    logger.info({ awb, statusRaw }, "shiprocket webhook: unmapped status ignored");
    return NextResponse.json({ ok: true, ignored: statusRaw });
  }

  const shipment = await getShipmentByTrackingNumber(awb);
  if (!shipment) {
    // 404 → Shiprocket retries; the shipment row may not be visible yet, or the
    // AWB is unknown. Log for operator triage.
    logger.warn({ awb, status }, "shiprocket webhook: no shipment for AWB");
    return NextResponse.json({ error: "SHIPMENT_NOT_FOUND" }, { status: 404 });
  }

  try {
    // Idempotent: updateShipmentStatus early-returns when status is unchanged, so
    // a replayed DELIVERED does not re-run payout release.
    await updateShipmentStatus({
      shipmentId: shipment.id,
      status,
      eventNote: `Shiprocket: ${statusRaw || status}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const httpStatus = msg === "SHIPMENT_NOT_FOUND" ? 404 : 500;
    if (httpStatus >= 500) {
      Sentry.captureException(err, {
        extra: { route: "webhooks/shiprocket", awb, status },
      });
    }
    return NextResponse.json({ error: msg }, { status: httpStatus });
  }

  logger.info({ awb, status, shipmentId: shipment.id }, "shiprocket webhook applied");
  return NextResponse.json({ ok: true, status });
}
