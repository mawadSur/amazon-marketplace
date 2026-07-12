import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/admin/status-pill";
import {
  RetryPayoutButton,
  RetryShopPayoutsButton,
} from "@/components/admin/payout-retry-buttons";
import { RunPayoutBatchButton } from "@/components/admin/run-payout-batch-button";
import { getPayoutScheduleInfo, listHeldPayouts } from "@/lib/admin";
import { formatInr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminPayoutsPage() {
  const rows = await listHeldPayouts();
  const schedule = getPayoutScheduleInfo();

  const heldTotalPaise = rows.reduce((sum, r) => sum + r.amountInrPaise, 0);
  const eligible = rows.filter((r) => r.isEligible);
  const eligibleTotalPaise = eligible.reduce((sum, r) => sum + r.amountInrPaise, 0);
  const stranded = rows.filter((r) => r.isStranded);
  const strandedTotalPaise = stranded.reduce((sum, r) => sum + r.amountInrPaise, 0);
  const retryable = stranded.filter((r) => r.hasFundAccount);

  // Shops with >1 retryable stranded payout get a bulk "retry all" affordance.
  const retryableByShop = new Map<string, { name: string; count: number }>();
  for (const r of retryable) {
    const cur = retryableByShop.get(r.shopId) ?? { name: r.shopName, count: 0 };
    cur.count += 1;
    retryableByShop.set(r.shopId, cur);
  }
  const bulkShops = [...retryableByShop.entries()].filter(([, v]) => v.count > 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payouts</h1>
        <p className="text-sm text-muted-foreground">
          Held (PENDING / PROCESSING) and stranded seller payouts. Payouts are held
          in escrow at delivery and disbursed by a weekly batch after the hold
          window. Stranded payouts have no RazorpayX payout id — the seller is
          unpaid until retried.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Weekly payout schedule</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Runs</span>{" "}
              <span className="font-medium capitalize">{schedule.weekday.toLowerCase()}</span>{" "}
              <span className="text-muted-foreground">weekly</span>
            </div>
            <div>
              <span className="text-muted-foreground">Hold window</span>{" "}
              <span className="font-medium">{schedule.holdDays} days after delivery</span>
            </div>
            <div>
              <span className="text-muted-foreground">Next run</span>{" "}
              <span className="font-medium">{schedule.nextRunAt.toUTCString()}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Cron (UTC)</span>{" "}
              <span className="font-mono text-xs">{schedule.cron}</span>
            </div>
          </div>
          <RunPayoutBatchButton />
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Held payouts" value={String(rows.length)} sub={formatInr(heldTotalPaise)} />
        <StatCard
          label="Eligible now"
          value={String(eligible.length)}
          sub={formatInr(eligibleTotalPaise)}
          tone={eligible.length > 0 ? "success" : "neutral"}
        />
        <StatCard
          label="Stranded"
          value={String(stranded.length)}
          sub={formatInr(strandedTotalPaise)}
          tone="warn"
        />
        <StatCard
          label="Retryable now"
          value={String(retryable.length)}
          sub="have a fund account"
          tone={retryable.length > 0 ? "success" : "neutral"}
        />
      </div>

      {bulkShops.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Bulk retry by shop</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {bulkShops.map(([shopId, v]) => (
              <div
                key={shopId}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-2 text-sm"
              >
                <span>
                  <span className="font-medium">{v.name}</span>{" "}
                  <span className="text-muted-foreground">· {v.count} retryable</span>
                </span>
                <RetryShopPayoutsButton shopId={shopId} />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No held or stranded payouts. Everything owed has been disbursed.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Shop</th>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Fund acct</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.payoutId} className="border-t border-border align-middle">
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/sellers/${r.shopId}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {r.shopName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {r.orderId ? (
                      <Link
                        href={`/admin/orders/${r.orderId}`}
                        className="font-mono text-xs underline-offset-2 hover:underline"
                      >
                        {r.orderId.slice(0, 10)}…
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatInr(r.amountInrPaise)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <StatusPill value={r.status} />
                      {r.isStranded ? <StatusPill value="STRANDED" /> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {r.isStranded ? (
                      r.hasFundAccount ? (
                        <span className="text-green-700">yes</span>
                      ) : (
                        <span className="text-amber-700">missing</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.createdAt.toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.isStranded ? (
                      <RetryPayoutButton payoutId={r.payoutId} disabled={!r.hasFundAccount} />
                    ) : (
                      <span className="text-xs text-muted-foreground">in flight</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "warn" | "success";
}) {
  const valueTone =
    tone === "warn"
      ? "text-amber-700"
      : tone === "success"
        ? "text-green-700"
        : "text-foreground";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-3xl font-semibold tabular-nums ${valueTone}`}>{value}</p>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}
