"use client";

// Admin-only payout retry triggers. Modeled on
// src/components/orders/mark-payout-paid-button.tsx: useTransition + fetch +
// inline status message + router.refresh(). The server routes wrap
// requireRole("ADMIN") and pair the mutation with an AdminAction audit row.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** Retry a single stranded payout. Disabled when the shop has no fund account
 * (a retry would just re-strand it). */
export function RetryPayoutButton({
  payoutId,
  disabled,
}: {
  payoutId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick() {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/payouts/${payoutId}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        result?: { status?: string; reason?: string };
      };
      if (!res.ok) {
        setMsg({ text: data.error ?? "Retry failed.", ok: false });
        return;
      }
      if (data.result?.status === "initiated") {
        setMsg({ text: "Disbursed", ok: true });
        router.refresh();
      } else {
        setMsg({ text: data.result?.reason ?? data.result?.status ?? "skipped", ok: false });
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={onClick} disabled={pending || disabled}>
        {pending ? "Retrying…" : "Retry"}
      </Button>
      {msg ? (
        <p className={`text-xs ${msg.ok ? "text-green-700" : "text-destructive"}`}>{msg.text}</p>
      ) : null}
    </div>
  );
}

/** Bulk-retry every stranded payout for one shop. */
export function RetryShopPayoutsButton({
  shopId,
  disabled,
}: {
  shopId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick() {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/payouts/retry-shop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        disbursed?: number;
        total?: number;
      };
      if (!res.ok) {
        setMsg({ text: data.error ?? "Bulk retry failed.", ok: false });
        return;
      }
      setMsg({ text: `Disbursed ${data.disbursed ?? 0}/${data.total ?? 0}`, ok: true });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={onClick} disabled={pending || disabled}>
        {pending ? "Retrying…" : "Retry all for shop"}
      </Button>
      {msg ? (
        <p className={`text-xs ${msg.ok ? "text-green-700" : "text-destructive"}`}>{msg.text}</p>
      ) : null}
    </div>
  );
}
