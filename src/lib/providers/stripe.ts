// Stripe checkout + refund provider (Module 4).
//
// Gating (fail-closed): STRIPE_SECRET_KEY present -> real Stripe SDK calls;
// absent AND dev/test -> the local /checkout/stub fallback; absent AND
// production -> throw (never fail open on a money path). Signatures are stable
// and re-exported from "@/lib/stubs".

import Stripe from "stripe";
import { env, publicEnv } from "@/lib/env";

function getStripe(): Stripe | null {
  return env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
}

export async function stripeCreateCheckout(inp: {
  orderId: string;
  amountUsdCents: number;
}): Promise<{ url: string; intentId: string }> {
  const stripe = getStripe();
  if (!stripe) {
    if (env.NODE_ENV === "production") {
      throw new Error("STRIPE_SECRET_KEY missing — refusing Stripe checkout in production (fail-closed).");
    }
    // Dev fallback: local stub Pay-now page simulates a Stripe Checkout URL.
    return { url: `/checkout/stub/${inp.orderId}`, intentId: `pi_stub_${inp.orderId}` };
  }

  const base = publicEnv.NEXT_PUBLIC_APP_URL;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: inp.amountUsdCents,
          product_data: { name: `Shezmin order ${inp.orderId.slice(-8)}` },
        },
      },
    ],
    success_url: `${base}/checkout/success/${inp.orderId}`,
    cancel_url: `${base}/cart`,
    client_reference_id: inp.orderId,
    metadata: { orderId: inp.orderId },
    payment_intent_data: { metadata: { orderId: inp.orderId } },
  });

  return {
    url: session.url ?? `${base}/checkout/success/${inp.orderId}`,
    // payment_intent is null until the buyer pays; fall back to the session id
    // for reconciliation. The real intent arrives on the completion webhook.
    intentId:
      typeof session.payment_intent === "string" ? session.payment_intent : session.id,
  };
}

export async function stripeRefund(inp: {
  chargeId?: string | null;
  intentId?: string | null;
  amountUsdCents: number;
  reason?: string;
  /** Stable key derived from the order so worker retries never double-refund. */
  idempotencyKey?: string;
}): Promise<{ refundId: string; status: "succeeded" }> {
  const stripe = getStripe();
  if (!stripe) {
    if (env.NODE_ENV === "production") {
      throw new Error("STRIPE_SECRET_KEY missing — refusing Stripe refund in production (fail-closed).");
    }
    const tail = (inp.chargeId ?? inp.intentId ?? "unknown").slice(-12);
    return { refundId: `re_stub_${tail}`, status: "succeeded" };
  }

  const params: Stripe.RefundCreateParams = { amount: inp.amountUsdCents };
  if (inp.chargeId) params.charge = inp.chargeId;
  else if (inp.intentId) params.payment_intent = inp.intentId;
  else throw new Error("STRIPE_REFUND_NO_TARGET");
  // Keep the human reason as metadata (Stripe's `reason` enum is a fixed set).
  if (inp.reason) params.metadata = { reason: inp.reason.slice(0, 500) };

  const refund = await stripe.refunds.create(
    params,
    inp.idempotencyKey ? { idempotencyKey: inp.idempotencyKey } : undefined,
  );
  return { refundId: refund.id, status: "succeeded" };
}
