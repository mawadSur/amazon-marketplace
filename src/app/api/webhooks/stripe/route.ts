// POST /api/webhooks/stripe
//
// REAL MODE (env.STRIPE_WEBHOOK_SECRET set): verifies the Stripe signature
// header against the RAW body, parses the event via
// `stripe.webhooks.constructEvent`, and dispatches checkout.session.completed to
// markPaymentCaptured (passing the event id for idempotency + the captured
// amount/currency for verification). Other event types are acknowledged with 200.
//
// FAIL-CLOSED: when the signing secret is unset we NEVER accept an anonymous
// body-driven capture in production (env.ts already requires the secret in
// prod). Only in dev/test does the local stub Pay-now page POST `{ orderId }`.
//
// Raw body is read ONCE at the top — req.text()/req.json() can't both run.

import { NextResponse } from "next/server";
import Stripe from "stripe";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { env } from "@/lib/env";
import { markPaymentCaptured } from "@/lib/payments";

const stubSchema = z.object({
  orderId: z.string().min(1),
  providerChargeId: z.string().optional(),
});

export async function POST(req: Request) {
  const rawBody = await req.text();

  // ───── REAL MODE ─────
  if (env.STRIPE_WEBHOOK_SECRET) {
    if (!env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: "STRIPE_SECRET_KEY missing — required alongside STRIPE_WEBHOOK_SECRET" },
        { status: 500 },
      );
    }
    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return NextResponse.json({ error: "NO_SIGNATURE" }, { status: 401 });
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return NextResponse.json({ error: "BAD_SIGNATURE" }, { status: 401 });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId ?? session.client_reference_id ?? null;
      if (!orderId) {
        return NextResponse.json({ error: "MISSING_ORDER_REFERENCE" }, { status: 400 });
      }
      try {
        await markPaymentCaptured({
          orderId,
          eventId: event.id,
          provider: "stripe",
          providerChargeId:
            typeof session.payment_intent === "string" ? session.payment_intent : undefined,
          capturedAmountUsdCents:
            typeof session.amount_total === "number" ? session.amount_total : undefined,
          capturedCurrency: session.currency ?? undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "ERROR";
        const status = msg === "ORDER_NOT_FOUND" ? 404 : 500;
        if (status >= 500) {
          Sentry.captureException(err, { extra: { route: "webhooks/stripe", orderId, eventId: event.id } });
        }
        return NextResponse.json({ error: msg }, { status });
      }
    }
    // Other event types: acknowledge so Stripe stops retrying.
    return NextResponse.json({ ok: true, received: event.type });
  }

  // ───── NO SIGNING SECRET ─────
  // Fail closed in production — an unauthenticated capture must never run.
  if (env.NODE_ENV === "production") {
    return NextResponse.json({ error: "WEBHOOK_NOT_CONFIGURED" }, { status: 500 });
  }

  // ───── DEV STUB MODE ─────
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = stubSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  }

  try {
    await markPaymentCaptured({
      orderId: parsed.data.orderId,
      provider: "stripe",
      providerChargeId: parsed.data.providerChargeId ?? `ch_stub_${parsed.data.orderId}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const status = msg === "ORDER_NOT_FOUND" ? 404 : 500;
    if (status >= 500) {
      Sentry.captureException(err, { extra: { route: "webhooks/stripe (dev stub)", orderId: parsed.data.orderId } });
    }
    return NextResponse.json({ error: msg }, { status });
  }

  return NextResponse.json({ ok: true });
}
