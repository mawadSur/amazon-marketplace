"use client";

// Admin-only "run the weekly payout batch now" trigger. Modeled on
// payout-retry-buttons.tsx: useTransition + fetch + inline status + refresh.
// The server route wraps requireRole("ADMIN") and records an AdminAction.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type BatchResult = {
  eligible: number;
  disbursed: number;
  stranded: number;
  cancelled: number;
  skipped: number;
};

export function RunPayoutBatchButton() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick() {
    setMsg(null);
    startTransition(async () => {
      const res = await fetch(`/api/admin/payouts/run-batch`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        result?: BatchResult;
      };
      if (!res.ok || !data.result) {
        setMsg({ text: data.error ?? "Batch failed.", ok: false });
        return;
      }
      const r = data.result;
      setMsg({
        text: `Disbursed ${r.disbursed}/${r.eligible} eligible (${r.stranded} stranded, ${r.cancelled} cancelled)`,
        ok: true,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={onClick} disabled={pending}>
        {pending ? "Running…" : "Run batch now"}
      </Button>
      {msg ? (
        <p className={`text-xs ${msg.ok ? "text-green-700" : "text-destructive"}`}>{msg.text}</p>
      ) : null}
    </div>
  );
}
