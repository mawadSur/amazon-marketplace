"use client";

// Admin-side form to resolve a dispute. Posts to /api/admin/disputes/[id]/resolve
// with { outcome, resolution }. Resolution text is required for both
// outcomes (we want a written rationale in the AdminAction audit log).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function ResolveDisputeForm({
  disputeId,
  disabled,
}: {
  disputeId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(outcome: "BUYER" | "SELLER") {
    setError(null);
    if (resolution.trim().length < 5) {
      setError("Resolution notes are required (min 5 characters).");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/admin/disputes/${disputeId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, resolution: resolution.trim() }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }
      setResolution("");
      router.refresh();
    });
  }

  if (disabled) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        This dispute has already been resolved.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <Label htmlFor="resolve-resolution">Resolution notes (required)</Label>
        <p className="text-xs text-muted-foreground">
          Briefly explain the decision. Visible to the buyer and recorded to
          the admin audit log.
        </p>
        <textarea
          id="resolve-resolution"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          rows={4}
          maxLength={4000}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="e.g. Tracking confirms delivery to listed address; seller fulfilled the order."
          disabled={pending}
        />
      </div>

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <p className="text-xs text-muted-foreground">
        Resolving in favor of the buyer refunds ONLY this shop&apos;s disputed
        items and claws back only this shop&apos;s payout. Other shops on the
        order are untouched.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => submit("BUYER")}
          disabled={pending}
        >
          {pending ? "Working…" : "Resolve in favor of buyer"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => submit("SELLER")}
          disabled={pending}
        >
          Resolve in favor of seller
        </Button>
      </div>
    </div>
  );
}
