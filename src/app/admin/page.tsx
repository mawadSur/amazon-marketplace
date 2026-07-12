import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CountBarChart, CountPieChart, GmvAreaChart } from "@/components/admin/charts";
import { summary } from "@/lib/admin";
import { formatInr, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const s = await summary();

  const gmvData = s.gmvSeries.map((p) => ({
    date: p.date,
    gmvUsd: p.gmvUsdCents / 100,
    orders: p.orders,
  }));
  const funnelData = s.ordersByStatus.map((r) => ({ label: r.label, count: r.count }));
  const disputeData = s.disputesByReason.map((r) => ({ label: r.label, count: r.count }));

  const revenueTiles = [
    { label: "GMV (all-time)", value: formatUsd(s.gmvAllTimeUsdCents) },
    { label: "GMV (30d)", value: formatUsd(s.gmv30dUsdCents) },
    { label: "GMV (7d)", value: formatUsd(s.gmv7dUsdCents) },
    { label: "GMV (24h)", value: formatUsd(s.gmvLast24hUsdCents), href: "/admin/orders?since=1" },
    { label: "Platform fees", value: formatUsd(s.platformFeesUsdCents) },
    { label: "AOV", value: formatUsd(s.aovUsdCents) },
  ];

  const opsTiles = [
    {
      label: "Pending sellers",
      value: String(s.pendingSellers),
      href: "/admin/sellers?status=PENDING_REVIEW",
      alert: s.pendingSellers > 0,
    },
    {
      label: "Pending listings",
      value: String(s.pendingListings),
      href: "/admin/listings?status=PENDING_REVIEW",
      alert: s.pendingListings > 0,
    },
    { label: "Open disputes", value: String(s.openDisputes), href: "/admin/disputes", alert: s.openDisputes > 0 },
    {
      label: "Stranded payouts",
      value: String(s.strandedCount),
      href: "/admin/payouts",
      alert: s.strandedCount > 0,
    },
    {
      label: "KYC submitted",
      value: String(s.kycSubmitted),
      href: "/admin/sellers",
      alert: s.kycSubmitted > 0,
    },
    {
      label: "BP claims open",
      value: String(s.bpClaimed),
      href: "/admin/disputes",
      alert: s.bpClaimed > 0,
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin overview</h1>
        <p className="text-sm text-muted-foreground">Live marketplace KPIs pulled from Prisma.</p>
      </div>

      {/* Revenue KPIs */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Revenue</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {revenueTiles.map((t) => (
            <Tile key={t.label} label={t.label} value={t.value} href={t.href} />
          ))}
        </div>
      </section>

      {/* Operational queue */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Needs attention</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {opsTiles.map((t) => (
            <Tile key={t.label} label={t.label} value={t.value} href={t.href} alert={t.alert} />
          ))}
        </div>
      </section>

      {/* Charts */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">GMV — last 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            <GmvAreaChart data={gmvData} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Orders by status</CardTitle>
          </CardHeader>
          <CardContent>
            <CountBarChart data={funnelData} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Disputes by reason</CardTitle>
          </CardHeader>
          <CardContent>
            <CountPieChart data={disputeData} />
          </CardContent>
        </Card>
      </section>

      {/* Money movement + trust */}
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <BreakdownCard
          title="Payments"
          rows={[
            { label: "Captured", value: String(s.paymentsCaptured) },
            { label: "Failed", value: String(s.paymentsFailed) },
          ]}
        />
        <BreakdownCard
          title="Payouts"
          href="/admin/payouts"
          rows={[
            { label: "Held", value: `${s.payoutsHeldCount} · ${formatInr(s.payoutsHeldInrPaise)}` },
            { label: "Stranded", value: String(s.strandedCount) },
            { label: "Retryable", value: String(s.strandedRetryableCount) },
            { label: "Reversed", value: String(s.payoutsReversed) },
          ]}
        />
        <BreakdownCard
          title="Funds held (derived)"
          rows={[
            { label: "Orders", value: String(s.fundsHeldOrders) },
            { label: "Value", value: formatUsd(s.fundsHeldUsdCents) },
          ]}
        />
        <BreakdownCard
          title="Buyer protection"
          rows={[
            { label: "Claimed", value: String(s.bpClaimed) },
            { label: "Paid", value: String(s.bpPaid) },
            { label: "Denied", value: String(s.bpDenied) },
          ]}
        />
        <BreakdownCard
          title="KYC pipeline"
          href="/admin/sellers"
          rows={[
            { label: "Submitted", value: String(s.kycSubmitted) },
            { label: "Verified", value: String(s.kycVerified) },
            { label: "Rejected", value: String(s.kycRejected) },
            { label: "Not submitted", value: String(s.kycNotSubmitted) },
          ]}
        />
        <BreakdownCard
          title="Shops"
          href="/admin/sellers"
          rows={s.shopsByStatus.map((r) => ({ label: r.label, value: String(r.count) }))}
        />
      </section>

      {/* Leaderboards */}
      <section className="grid gap-4 lg:grid-cols-2">
        <LeaderCard
          title="Top shops (by units)"
          empty="No sales yet."
          rows={s.topShops.map((t) => ({
            key: t.shopId,
            href: `/admin/sellers/${t.shopId}`,
            name: t.name,
            units: t.units,
            revenue: formatUsd(t.revenueUsdCents),
          }))}
        />
        <LeaderCard
          title="Top products (by units)"
          empty="No sales yet."
          rows={s.topProducts.map((t) => ({
            key: t.productId,
            href: `/admin/listings/${t.productId}`,
            name: t.title,
            units: t.units,
            revenue: formatUsd(t.revenueUsdCents),
          }))}
        />
      </section>

      {/* Recent admin activity */}
      <section>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent admin activity</CardTitle>
          </CardHeader>
          <CardContent>
            {s.recentActions.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No admin actions recorded yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {s.recentActions.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="font-medium">{a.action.replace(/_/g, " ")}</span>{" "}
                      <span className="text-muted-foreground">
                        {a.targetType}
                        {a.reason ? ` — ${a.reason}` : ""}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {(a.admin?.email ?? a.admin?.name ?? "admin")} · {a.createdAt.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  href,
  alert,
}: {
  label: string;
  value: string;
  href?: string;
  alert?: boolean;
}) {
  const inner = (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={`text-2xl font-semibold tabular-nums ${
            alert ? "text-amber-700" : "text-foreground"
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block transition hover:opacity-90">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}

function BreakdownCard({
  title,
  rows,
  href,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
  href?: string;
}) {
  const head = <CardTitle className="text-sm">{title}</CardTitle>;
  return (
    <Card>
      <CardHeader className="pb-2">
        {href ? (
          <Link href={href} className="underline-offset-2 hover:underline">
            {head}
          </Link>
        ) : (
          head
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {rows.length === 0 ? (
          <p className="text-muted-foreground">—</p>
        ) : (
          rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="tabular-nums">{r.value}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function LeaderCard({
  title,
  rows,
  empty,
}: {
  title: string;
  empty: string;
  rows: Array<{ key: string; href: string; name: string; units: number; revenue: string }>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r, i) => (
              <li key={r.key} className="flex items-center justify-between gap-3 text-sm">
                <Link href={r.href} className="min-w-0 truncate underline-offset-2 hover:underline">
                  <span className="text-muted-foreground">{i + 1}.</span> {r.name}
                </Link>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {r.units} u · {r.revenue}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
