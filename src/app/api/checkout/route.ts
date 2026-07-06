// POST /api/checkout
// Body: { shippingAddress }. Creates an Order from the buyer's current cart
// (in a Prisma transaction), then asks the Stripe stub for a checkout URL.
// Returns { orderId, checkoutUrl } so the client can redirect.

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createOrderFromCart } from "@/lib/orders";
import { stripeCreateCheckout } from "@/lib/stubs";
import { prisma } from "@/lib/db";
import { rateLimit, clientKey, rateLimitHeaders } from "@/lib/ratelimit";

const shippingSchema = z.object({
  fullName: z.string().min(2).max(120),
  line1: z.string().min(2).max(200),
  line2: z.string().max(200).optional().or(z.literal("").transform(() => undefined)),
  city: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  postalCode: z.string().min(2).max(20),
  country: z.string().min(2).max(60),
  phone: z.string().max(30).optional().or(z.literal("").transform(() => undefined)),
});

const bodySchema = z.object({ shippingAddress: shippingSchema });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const rl = await rateLimit(clientKey(req, "checkout", session.user.id), 5, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_INPUT", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let order: { orderId: string; totalUsdCents: number };
  try {
    order = await createOrderFromCart({
      userId: session.user.id,
      shippingAddress: parsed.data.shippingAddress,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const status =
      msg === "CART_EMPTY" ? 400 : msg === "PRODUCT_UNAVAILABLE" ? 409 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  // Money path: a Stripe/DB failure here must surface (and alert) rather than
  // leaving the buyer on a dead redirect. The Order already exists (PLACED), so
  // it can be retried from the cart.
  try {
    const checkout = await stripeCreateCheckout({
      orderId: order.orderId,
      amountUsdCents: order.totalUsdCents,
    });

    // Persist the intent id on the Payment row for later reconciliation.
    await prisma.payment.update({
      where: { orderId: order.orderId },
      data: { providerIntentId: checkout.intentId },
    });

    return NextResponse.json({ orderId: order.orderId, checkoutUrl: checkout.url });
  } catch (err) {
    Sentry.captureException(err, { extra: { route: "api/checkout", orderId: order.orderId } });
    return NextResponse.json({ error: "CHECKOUT_INIT_FAILED", orderId: order.orderId }, { status: 502 });
  }
}
