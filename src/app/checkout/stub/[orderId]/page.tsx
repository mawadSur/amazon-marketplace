// /checkout/stub/[orderId] — dev-only "Stripe" surface, reskinned to the
// Amazon look. In real life the Stripe Checkout URL points at stripe.com;
// the stub URL points here so the local dev flow works. The Pay-now button
// POSTs to /api/webhooks/stripe to simulate capture.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { MarketplaceNav } from "@/components/buyer/marketplace-nav";
import { auth } from "@/lib/auth";
import { getOrderForBuyer } from "@/lib/orders";
import { formatUsd } from "@/lib/format";
import { PayNowButton } from "@/components/checkout/pay-now-button";

export const dynamic = "force-dynamic";

export default async function StripeStubPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  // Dev-only surface: in production real Stripe Checkout replaces this page, so
  // it must never be reachable (it simulates payment capture without a card).
  if (process.env.NODE_ENV === "production") notFound();

  const { orderId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/sign-in?next=${encodeURIComponent(`/checkout/stub/${orderId}`)}`);
  }

  const order = await getOrderForBuyer(session.user.id, orderId);
  if (!order) {
    return (
      <>
        <MarketplaceNav />
        <main className="bg-background pb-12">
          <div className="mx-auto max-w-3xl px-4 py-10">
            <div className="rounded-sm border border-border bg-card p-8 text-center">
              <h1 className="text-2xl font-medium text-foreground">
                Order not found
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                We couldn&apos;t find that order on your account.
              </p>
              <Link href="/cart" className="amzn-link mt-4 inline-block text-sm">
                Back to cart
              </Link>
            </div>
          </div>
        </main>
      </>
    );
  }

  // Already paid? Skip straight to success.
  if (order.status !== "PLACED") {
    redirect(`/checkout/success/${orderId}`);
  }

  return (
    <>
      <MarketplaceNav />
      <main className="bg-background pb-12">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <div className="rounded-sm border border-border bg-card p-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Dev mode · Stripe stub
            </p>
            <h2 className="mt-1 text-xl font-medium text-foreground">
              Demo payment
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This is a demo Stripe payment page. Order #{order.id.slice(-8)}.
            </p>

            <div className="mt-4 rounded-sm border border-border bg-background p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">
                  Amount due
                </span>
                <span className="text-lg font-bold tabular-nums text-foreground">
                  {formatUsd(order.totalUsdCents)}
                </span>
              </div>
            </div>

            <div className="mt-4">
              <PayNowButton orderId={order.id} />
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              No card is charged. Click &ldquo;Pay now&rdquo; to simulate a
              successful Stripe checkout.
            </p>

            <p className="mt-4 text-center text-sm">
              <Link href="/cart" className="amzn-link">
                Cancel and return to cart
              </Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
