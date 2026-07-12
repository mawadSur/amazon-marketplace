import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import { formatUsd } from "@/lib/format";
import type { ShipmentStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

// RTO / exception triage. Read-only for v1: an operator can see which orders are
// stuck (EXCEPTION) or came back (RETURNED) and drill into the order.
const TRIAGE_STATUSES: ShipmentStatus[] = ["EXCEPTION", "RETURNED"];

const FILTERS: Array<ShipmentStatus | "ALL"> = ["ALL", "EXCEPTION", "RETURNED"];

function isTriageStatus(s: string | undefined): s is ShipmentStatus {
  return !!s && (TRIAGE_STATUSES as string[]).includes(s);
}

export default async function AdminShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const filter = isTriageStatus(sp.status) ? sp.status : "ALL";

  const shipments = await prisma.shipment.findMany({
    where: { status: filter === "ALL" ? { in: TRIAGE_STATUSES } : filter },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      status: true,
      carrier: true,
      trackingNumber: true,
      updatedAt: true,
      order: {
        select: {
          id: true,
          status: true,
          totalUsdCents: true,
          buyer: { select: { email: true, name: true } },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shipment triage</h1>
        <p className="text-sm text-muted-foreground">
          Stuck (exception) and returned (RTO) shipments. Read-only — resolve the
          underlying order from its detail page.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((s) => {
          const active = s === filter;
          const href = s === "ALL" ? "/admin/shipments" : `/admin/shipments?status=${s}`;
          return (
            <Link
              key={s}
              href={href}
              className={
                active
                  ? "rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background"
                  : "rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent"
              }
            >
              {s.toLowerCase()}
            </Link>
          );
        })}
      </div>

      {shipments.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No stuck or returned shipments. Nothing needs triage right now.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {shipments.map((s) => (
            <li key={s.id}>
              <Link
                href={`/admin/orders/${s.order.id}`}
                className="flex items-center justify-between gap-4 rounded-lg border bg-card p-3 transition hover:bg-accent"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm">{s.order.id}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.carrier}
                    {s.trackingNumber ? ` · ${s.trackingNumber}` : ""} ·{" "}
                    {s.order.buyer.email ?? s.order.buyer.name ?? "buyer"} ·{" "}
                    {s.updatedAt.toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm tabular-nums">{formatUsd(s.order.totalUsdCents)}</span>
                  <StatusPill value={s.order.status} />
                  <StatusPill value={s.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
