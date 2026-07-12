// /admin/disputes/[disputeId] — admin view of a dispute with resolution flow.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import { DisputeStatusPill } from "@/components/safety/dispute-status-pill";
import { ResolveDisputeForm } from "@/components/safety/resolve-dispute-form";
import { getDisputeForAdmin } from "@/lib/disputes";
import { formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

const REASON_LABELS: Record<string, string> = {
  NOT_RECEIVED: "Item not received",
  NOT_AS_DESCRIBED: "Not as described",
  DAMAGED: "Damaged on arrival",
  COUNTERFEIT: "Counterfeit",
  OTHER: "Other",
};

type ShippingAddressLike = {
  fullName?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
};

export default async function AdminDisputeDetailPage({
  params,
}: {
  params: Promise<{ disputeId: string }>;
}) {
  const { disputeId } = await params;

  const dispute = await getDisputeForAdmin(disputeId);
  if (!dispute) notFound();

  const order = dispute.order;
  const shippingAddr = (order.shippingAddress ?? null) as
    | ShippingAddressLike
    | null;

  const recentActions = await prisma.adminAction.findMany({
    where: { targetType: "dispute", targetId: dispute.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { admin: { select: { email: true, name: true } } },
  });

  const resolved =
    dispute.status === "RESOLVED_BUYER" || dispute.status === "RESOLVED_SELLER";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/admin/disputes"
            className="text-xs text-muted-foreground transition hover:text-foreground"
          >
            ← All disputes
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Dispute on order #{dispute.orderId.slice(-8)}
          </h1>
          <p className="text-sm text-muted-foreground">
            Against <span className="font-medium">{dispute.shop.name}</span> ·{" "}
            {dispute.orderItemIds.length} item
            {dispute.orderItemIds.length === 1 ? "" : "s"} · Opened{" "}
            {new Date(dispute.openedAt).toLocaleString()} by{" "}
            {dispute.openedBy.email ?? dispute.openedBy.name ?? dispute.openedBy.phone ?? "buyer"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DisputeStatusPill value={dispute.status} />
          <StatusPill value={order.status} />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Buyer&apos;s claim</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="font-medium">Reason:</span>{" "}
              {REASON_LABELS[dispute.reason] ?? dispute.reason}
            </p>
            <p className="whitespace-pre-wrap">{dispute.description}</p>
            {dispute.evidenceUrls.length > 0 ? (
              <div>
                <p className="font-medium">Evidence</p>
                <ul className="mt-1 space-y-1">
                  {dispute.evidenceUrls.map((u) => (
                    <li key={u}>
                      <a
                        href={u}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="break-all text-blue-700 underline"
                      >
                        {u}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No evidence URLs.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Order</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Placed</span>
              <span>{new Date(order.placedAt).toLocaleDateString()}</span>
            </div>
            {order.deliveredAt ? (
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">Delivered</span>
                <span>{new Date(order.deliveredAt).toLocaleDateString()}</span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium tabular-nums">
                {formatUsd(order.totalUsdCents)}
              </span>
            </div>
            <ul className="space-y-2 border-t pt-2">
              {order.items.map((it) => {
                const isDisputed = dispute.orderItemIds.includes(it.id);
                return (
                  <li
                    key={it.id}
                    className={`flex items-start gap-3 rounded-md ${
                      isDisputed ? "bg-amber-50 p-2 ring-1 ring-amber-200" : ""
                    }`}
                  >
                    <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-muted">
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
                      <Link
                        href={`/admin/listings/${it.product.id}`}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {it.product.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        qty {it.qty} · shop {it.product.shopId.slice(-6)}
                        {isDisputed ? " · disputed" : ""} · {it.status.toLowerCase()}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <Link
              href={`/admin/orders/${order.id}`}
              className="text-xs underline"
            >
              View order timeline →
            </Link>
          </CardContent>
        </Card>

        {shippingAddr ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Shipping address</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {shippingAddr.fullName}
              <br />
              {shippingAddr.line1}
              {shippingAddr.line2 ? (
                <>
                  <br />
                  {shippingAddr.line2}
                </>
              ) : null}
              <br />
              {shippingAddr.city}, {shippingAddr.region} {shippingAddr.postalCode}
              <br />
              {shippingAddr.country}
            </CardContent>
          </Card>
        ) : null}

        {dispute.resolution ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Resolution on file</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="whitespace-pre-wrap">{dispute.resolution}</p>
              {dispute.resolvedAt ? (
                <p className="text-xs text-muted-foreground">
                  Resolved {new Date(dispute.resolvedAt).toLocaleString()}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ResolveDisputeForm disputeId={dispute.id} disabled={resolved} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent admin actions</CardTitle>
          </CardHeader>
          <CardContent>
            {recentActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No actions yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {recentActions.map((a) => (
                  <li key={a.id} className="border-b pb-2 last:border-0">
                    <div>
                      <span className="font-medium">{a.action}</span> by{" "}
                      {a.admin.email ?? a.admin.name ?? a.adminId}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {a.createdAt.toLocaleString()}
                    </div>
                    {a.reason ? <p className="mt-1 text-xs">{a.reason}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
