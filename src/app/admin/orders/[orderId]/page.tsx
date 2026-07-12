import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import { getOrderTimeline } from "@/lib/admin";
import { formatUsd, formatInr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const data = await getOrderTimeline(orderId);
  if (!data) notFound();
  const { order, events, payouts } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/admin/orders"
            className="text-xs text-muted-foreground transition hover:text-foreground"
          >
            ← All orders
          </Link>
          <h1 className="mt-1 truncate font-mono text-xl">{order.id}</h1>
          <p className="text-sm text-muted-foreground">
            Placed {order.placedAt.toLocaleString()}
          </p>
        </div>
        <StatusPill value={order.status} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Buyer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>{order.buyer.name ?? "(no name)"}</div>
            <div className="text-muted-foreground">
              {order.buyer.email ?? "no email"} · {order.buyer.phone ?? "no phone"}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm tabular-nums">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatUsd(order.subtotalUsdCents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Shipping</span>
              <span>{formatUsd(order.shippingUsdCents)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fees</span>
              <span>{formatUsd(order.feesUsdCents)}</span>
            </div>
            <div className="flex justify-between border-t pt-1 font-medium">
              <span>Total</span>
              <span>{formatUsd(order.totalUsdCents)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              FX rate: {order.fxRate.toString()}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Items ({order.items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {order.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items.</p>
          ) : (
            <ul className="divide-y">
              {order.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/listings/${it.product.id}`}
                      className="block truncate hover:underline"
                    >
                      {it.product.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      Shop {it.shopId} · qty {it.qty}
                    </div>
                  </div>
                  <div className="ml-3 tabular-nums">
                    {formatUsd(it.unitPriceUsdCents * it.qty)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {order.payment ? (
              <>
                <div>
                  Status: <StatusPill value={order.payment.status} />
                </div>
                <div className="text-muted-foreground">Provider: {order.payment.provider}</div>
                <div className="text-muted-foreground">
                  Amount: {formatUsd(order.payment.amountUsdCents)}
                </div>
                {order.payment.providerIntentId ? (
                  <div className="text-xs text-muted-foreground">
                    Intent: {order.payment.providerIntentId}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">No payment recorded yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Shipment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {order.shipment ? (
              <>
                <div>
                  Status: <StatusPill value={order.shipment.status} />
                </div>
                <div className="text-muted-foreground">
                  Carrier: {order.shipment.carrier}
                </div>
                <div className="text-muted-foreground">
                  Tracking: {order.shipment.trackingNumber ?? "—"}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">No shipment recorded yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Payouts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {payouts.length === 0 ? (
              <p className="text-muted-foreground">
                No payouts yet (Module 4 may not have created them).
              </p>
            ) : (
              <ul className="space-y-2">
                {payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs">{p.id}</div>
                      <div className="text-xs text-muted-foreground">
                        Shop {p.shopId} · {p.createdAt.toLocaleDateString()}
                      </div>
                    </div>
                    <div className="ml-3 flex items-center gap-2">
                      <span className="tabular-nums">{formatInr(p.amountInrPaise)}</span>
                      <StatusPill value={p.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {events.map((e) => (
                <li key={e.label} className="flex justify-between">
                  <span>{e.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.at.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {order.disputes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Disputes ({order.disputes.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {order.disputes.map((d) => (
              <div key={d.id} className="space-y-1 border-b pb-2 last:border-0 last:pb-0">
                <div>
                  Shop: <span className="font-medium">{d.shop.name}</span> ·
                  Status: <StatusPill value={d.status} /> · Reason:{" "}
                  {d.reason.toLowerCase()}
                </div>
                <p className="text-xs text-muted-foreground">
                  {d.orderItemIds.length} item
                  {d.orderItemIds.length === 1 ? "" : "s"} disputed
                </p>
                <p className="text-muted-foreground">{d.description}</p>
                <Link
                  href={`/admin/disputes/${d.id}`}
                  className="text-xs underline"
                >
                  Review dispute →
                </Link>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Shipping to: {JSON.stringify(order.shippingAddress)}
      </p>
    </div>
  );
}
