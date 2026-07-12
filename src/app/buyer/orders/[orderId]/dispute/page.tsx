// /buyer/orders/[orderId]/dispute — buyer opens a dispute against an order.
//
// We don't modify Module 4's order detail page; users arrive here via a
// direct link or button on the orders list. Pre-flight checks (order
// exists, belongs to caller, not already disputed) happen server-side here
// so we can render a clear message instead of letting the API 4xx fire.

import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketplaceNav } from "@/components/buyer/marketplace-nav";
import { auth } from "@/lib/auth";
import { getOrderForBuyer } from "@/lib/orders";
import { formatUsd } from "@/lib/format";
import { DisputeForm } from "@/components/safety/dispute-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function OpenDisputePage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/sign-in?next=${encodeURIComponent(`/buyer/orders/${orderId}/dispute`)}`,
    );
  }

  const order = await getOrderForBuyer(session.user.id, orderId);
  if (!order) {
    return (
      <>
        <MarketplaceNav />
        <main className="container mx-auto max-w-md px-4 py-16 text-center">
          <h1 className="text-2xl font-semibold">Order not found</h1>
          <Link href="/buyer/orders" className="mt-4 inline-block underline">
            Back to orders
          </Link>
        </main>
      </>
    );
  }

  const ineligible = ["PLACED", "CANCELLED", "REFUNDED"].includes(order.status);
  // Per-shop disputes: an item is disputable only while ACTIVE. DISPUTED items
  // already belong to a dispute; REFUNDED items are done.
  const formItems = order.items.map((it) => ({
    id: it.id,
    title: it.product.title,
    shopId: it.shopId,
    shopName: it.product.shop.name,
    qty: it.qty,
    status: it.status,
  }));
  const noDisputableItems = !formItems.some((it) => it.status === "ACTIVE");

  return (
    <>
      <MarketplaceNav />
      <main className="container mx-auto max-w-3xl px-4 py-10">
        <Link
          href={`/buyer/orders/${order.id}`}
          className="text-xs text-muted-foreground underline"
        >
          ← Back to order
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Open a dispute
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          File a complaint about order #{order.id.slice(-8)}. Our team will
          review and respond.
        </p>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <section className="lg:col-span-2">
            {ineligible ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  This order isn&apos;t eligible for a dispute (status:{" "}
                  {order.status.toLowerCase()}). If you believe this is a
                  mistake, please contact support.
                </CardContent>
              </Card>
            ) : noDisputableItems ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  Every item on this order is already in a dispute or refunded.{" "}
                  <Link href="/buyer/disputes" className="underline">
                    View your disputes
                  </Link>
                  .
                </CardContent>
              </Card>
            ) : (
              <DisputeForm orderId={order.id} items={formItems} />
            )}
          </section>

          <aside>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Order summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  Placed {new Date(order.placedAt).toLocaleDateString()}
                </p>
                <ul className="space-y-2">
                  {order.items.map((it) => (
                    <li key={it.id} className="flex items-start gap-3">
                      <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-md bg-muted">
                        {it.product.images[0]?.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={it.product.images[0].url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {it.product.title}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {it.product.shop.name} · qty {it.qty}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="flex items-baseline justify-between border-t pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatUsd(order.totalUsdCents)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Review our{" "}
                  <Link href="/legal/returns" className="underline">
                    return &amp; refund policy
                  </Link>{" "}
                  before filing.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </>
  );
}
