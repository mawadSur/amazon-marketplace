// Reviews API — POST creates / upserts a buyer's review on a product.
// Must be an authenticated BUYER. One review per (productId, buyerId).

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { rateLimit, clientKey, rateLimitHeaders } from "@/lib/ratelimit";
import { enqueueTrustRecompute } from "@/lib/trust-score";

const schema = z.object({
  productId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  body: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  // BUYER role required — sellers/admins can't review products via this route.
  if (session.user.role !== "BUYER") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const rl = await rateLimit(clientKey(req, "reviews.write", session.user.id), 5, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_INPUT", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { productId, rating, body } = parsed.data;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, status: true, shopId: true },
  });
  if (!product) {
    return NextResponse.json({ error: "PRODUCT_NOT_FOUND" }, { status: 404 });
  }

  // Verified-purchase gate: the buyer must have a delivered/completed order that
  // contains an item from this product's shop. OrderItem.shopId is denormalized,
  // so this is a single indexed lookup.
  const purchase = await prisma.orderItem.findFirst({
    where: {
      shopId: product.shopId,
      order: {
        buyerId: session.user.id,
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
    },
    select: { id: true },
  });
  if (!purchase) {
    return NextResponse.json({ error: "PURCHASE_REQUIRED" }, { status: 403 });
  }

  const review = await prisma.review.upsert({
    where: { productId_buyerId: { productId, buyerId: session.user.id } },
    update: { rating, body: body ?? null },
    create: { productId, buyerId: session.user.id, rating, body: body ?? null },
  });

  // A new/updated review moves the shop's trust score. Best-effort.
  await enqueueTrustRecompute(product.shopId);

  return NextResponse.json({ review });
}
