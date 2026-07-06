// POST /api/webhooks/stripe
//
// REAL MODE (env.STRIPE_WEBHOOK_SECRET set): verifies the Stripe signature
// header against the RAW body, parses the event via
// `stripe.webhooks.constructEvent`, and dispatches:
//   - checkout.session.completed -> markPaymentCaptured (event id for idempotency
//     + captured amount/currency for verification)
//   - charge.dispute.created (bank chargeback) -> mark order DISPUTED, claw back
//     seller payouts (reversePayoutsForOrder), Sentry alert for manual review
//   - charge.refunded -> reconcile Payment/Order to REFUNDED if not already
// Each of the latter two is idempotent via the ProcessedWebhookEvent ledger.
// Any other event type is acknowledged with 200 so Stripe stops retrying.
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
import { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { markPaymentCaptured } from "@/lib/payments";
import { reversePayoutsForOrder } from "@/lib/payouts";

const stubSchema = z.object({
  orderId: z.string().min(1),
  providerChargeId: z.string().optional(),
});

/** Resolve our Order id from a Stripe charge/payment_intent by matching the
 * Payment we persisted at capture time. Null when no Payment matches. */
async function resolveOrderIdFromCharge(
  chargeId: string | null,
  intentId: string | null,
): Promise<string | null> {
  // Capture stores the Stripe payment_intent id (pi_...) in Payment.providerChargeId
  // and leaves providerIntentId null (see markPaymentCaptured). Stripe dispute/refund
  // events carry BOTH the charge id (ch_...) and the payment_intent id — so the
  // reliable production join is intentId == providerChargeId. We also match on the
  // charge id (dev-stub / legacy rows store ch_... there) and on providerIntentId
  // in case it is ever populated, for defence in depth.
  const or: Prisma.PaymentWhereInput[] = [];
  if (intentId) {
    or.push({ providerChargeId: intentId });
    or.push({ providerIntentId: intentId });
  }
  if (chargeId) {
    or.push({ providerChargeId: chargeId });
  }
  if (or.length === 0) return null;
  const payment = await prisma.payment.findFirst({ where: { OR: or }, select: { orderId: true } });
  return payment?.orderId ?? null;
}

/** True if this event id was already processed (idempotency ledger). */
async function eventAlreadyProcessed(eventId: string): Promise<boolean> {
  const seen = await prisma.processedWebhookEvent.findUnique({ where: { id: eventId } });
  return Boolean(seen);
}

/** Record an event id as processed. Swallows the duplicate-insert race. */
async function recordProcessedEvent(eventId: string, orderId: string | null): Promise<void> {
  try {
    await prisma.processedWebhookEvent.create({
      data: { id: eventId, provider: "stripe", orderId: orderId ?? undefined },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
}

/**
 * charge.dispute.created — a bank chargeback. Mark the order DISPUTED and claw
 * back any seller payouts already released, then Sentry-alert for manual review
 * (a chargeback needs human handling: evidence submission / accept). Idempotent
 * on the event id. Money-safe: reversePayoutsForOrder never throws and only
 * touches PROCESSING/PAID payouts, so a replay is a no-op.
 */
async function handleChargeDisputeCreated(event: Stripe.Event): Promise<void> {
  if (await eventAlreadyProcessed(event.id)) return;

  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id ?? null;
  const intentId =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id ?? null;
  const orderId = await resolveOrderIdFromCharge(chargeId, intentId);

  if (!orderId) {
    // Nothing to reconcile locally, but a chargeback we can't map still needs a
    // human — alert and acknowledge so Stripe stops retrying.
    Sentry.captureException(new Error("STRIPE_CHARGEBACK_UNMATCHED"), {
      extra: { eventId: event.id, chargeId, intentId, disputeId: dispute.id },
    });
    await recordProcessedEvent(event.id, null);
    return;
  }

  // Move the order out of a settled state into DISPUTED (idempotent — a second
  // pass just re-sets the same status).
  await prisma.order.update({ where: { id: orderId }, data: { status: "DISPUTED" } });

  // Claw back released payouts (best-effort; self-logging on failure).
  await reversePayoutsForOrder(orderId, `stripe chargeback ${dispute.id}`);

  Sentry.captureException(new Error("STRIPE_CHARGEBACK_NEEDS_REVIEW"), {
    extra: { eventId: event.id, orderId, disputeId: dispute.id, reason: dispute.reason },
  });

  await recordProcessedEvent(event.id, orderId);
}

/**
 * charge.refunded — the charge was refunded at Stripe (e.g. via dashboard or our
 * own refund). Reconcile our Payment/Order to REFUNDED if not already. Does NOT
 * call the gateway (the refund already happened). Idempotent on the event id and
 * on the already-REFUNDED status.
 */
async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  if (await eventAlreadyProcessed(event.id)) return;

  const charge = event.data.object as Stripe.Charge;
  const chargeId = charge.id ?? null;
  const intentId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;
  const orderId = await resolveOrderIdFromCharge(chargeId, intentId);

  if (!orderId) {
    Sentry.captureException(new Error("STRIPE_REFUND_UNMATCHED"), {
      extra: { eventId: event.id, chargeId, intentId },
    });
    await recordProcessedEvent(event.id, null);
    return;
  }

  // Only reconcile on a FULL refund. `charge.refunded` is true only when the
  // charge is entirely refunded; a partial refund (amount_refunded < amount)
  // must NOT flip the whole order to REFUNDED or claw back every seller payout.
  const fullyRefunded =
    charge.refunded === true ||
    (typeof charge.amount === "number" &&
      typeof charge.amount_refunded === "number" &&
      charge.amount >= 0 &&
      charge.amount_refunded >= charge.amount);
  if (!fullyRefunded) {
    await recordProcessedEvent(event.id, orderId);
    return;
  }

  // Reconcile Payment -> REFUNDED (only from a live status; never revive) and the
  // Order -> REFUNDED unless it's already in a terminal refunded state.
  await prisma.payment.updateMany({
    where: { orderId, status: { not: "REFUNDED" } },
    data: { status: "REFUNDED" },
  });
  await prisma.order.updateMany({
    where: { id: orderId, status: { not: "REFUNDED" } },
    data: { status: "REFUNDED" },
  });

  // Claw back any seller payouts already released for the now-refunded order.
  // Idempotent: reversePayoutsForOrder only touches PROCESSING/PAID payouts, so
  // if this refund came from our own dispute flow (which already reversed them)
  // this is a no-op. Prevents a dashboard-initiated refund from leaving sellers paid.
  await reversePayoutsForOrder(orderId, `stripe refund ${chargeId ?? event.id}`);

  await recordProcessedEvent(event.id, orderId);
}

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
    } else if (event.type === "charge.dispute.created" || event.type === "charge.refunded") {
      try {
        if (event.type === "charge.dispute.created") {
          await handleChargeDisputeCreated(event);
        } else {
          await handleChargeRefunded(event);
        }
      } catch (err) {
        // Reconcile failed — 500 so Stripe retries. The ledger record is written
        // only after the work succeeds, so a retry re-runs (idempotent) work.
        Sentry.captureException(err, {
          extra: { route: "webhooks/stripe", eventType: event.type, eventId: event.id },
        });
        const msg = err instanceof Error ? err.message : "ERROR";
        return NextResponse.json({ error: msg }, { status: 500 });
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
