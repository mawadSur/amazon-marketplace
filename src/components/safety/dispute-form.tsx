"use client";

// Buyer-facing form to open a PER-SHOP dispute on specific order items. The
// buyer selects the item(s) that went wrong; a dispute covers exactly ONE shop,
// so selecting an item from a second shop clears the previous shop's selection.
// Posts to /api/disputes with { orderId, orderItemIds, reason, description },
// then redirects to the buyer's view of the new dispute.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EvidenceUrlList } from "@/components/safety/evidence-url-list";

const REASONS: { value: string; label: string }[] = [
  { value: "NOT_RECEIVED", label: "I never received the item" },
  { value: "NOT_AS_DESCRIBED", label: "Item not as described" },
  { value: "DAMAGED", label: "Item arrived damaged" },
  { value: "COUNTERFEIT", label: "Item appears counterfeit" },
  { value: "OTHER", label: "Other" },
];

export type DisputeFormItem = {
  id: string;
  title: string;
  shopId: string;
  shopName: string;
  qty: number;
  /** ACTIVE items are selectable; DISPUTED / REFUNDED are shown but disabled. */
  status: string;
};

export function DisputeForm({
  orderId,
  items,
}: {
  orderId: string;
  items: DisputeFormItem[];
}) {
  const router = useRouter();
  const [reason, setReason] = useState(REASONS[0].value);
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState<string[]>(["", "", ""]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const itemsById = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

  function toggle(itemId: string) {
    const item = itemsById.get(itemId);
    if (!item) return;
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
        return next;
      }
      // Enforce single-shop scope: adding an item from a different shop clears
      // any previously-selected items from another shop.
      const currentShop = [...next]
        .map((id) => itemsById.get(id)?.shopId)
        .find(Boolean);
      if (currentShop && currentShop !== item.shopId) next.clear();
      next.add(itemId);
      return next;
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const orderItemIds = [...selected];
    if (orderItemIds.length === 0) {
      setError("Select at least one item to dispute.");
      return;
    }
    if (description.trim().length < 10) {
      setError("Please describe what went wrong (at least 10 characters).");
      return;
    }
    const evidenceUrls = evidence.map((u) => u.trim()).filter(Boolean);

    startTransition(async () => {
      const res = await fetch("/api/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          orderItemIds,
          reason,
          description: description.trim(),
          evidenceUrls: evidenceUrls.length > 0 ? evidenceUrls : undefined,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(humanizeError(data.error) ?? `Request failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { dispute?: { id: string } };
      const id = data.dispute?.id;
      router.refresh();
      if (id) router.push(`/buyer/disputes/${id}`);
      else router.push("/buyer/disputes");
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-lg border bg-card p-6">
      <div className="space-y-2">
        <Label>Which item(s) went wrong?</Label>
        <p className="text-xs text-muted-foreground">
          A dispute covers items from one shop. Selecting an item from another
          shop starts a fresh selection.
        </p>
        <ul className="space-y-2">
          {items.map((it) => {
            const selectable = it.status === "ACTIVE";
            const isChecked = selected.has(it.id);
            return (
              <li key={it.id}>
                <label
                  className={`flex items-start gap-3 rounded-md border p-3 text-sm ${
                    selectable ? "cursor-pointer hover:bg-accent" : "opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={isChecked}
                    disabled={!selectable || pending}
                    onChange={() => toggle(it.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{it.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {it.shopName} · qty {it.qty}
                      {it.status === "DISPUTED"
                        ? " · already in a dispute"
                        : it.status === "REFUNDED"
                          ? " · refunded"
                          : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dispute-reason">Reason</Label>
        <select
          id="dispute-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={pending}
        >
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dispute-description">What happened?</Label>
        <textarea
          id="dispute-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          maxLength={4000}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Walk us through what went wrong, including dates."
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          {description.length}/4000 characters
        </p>
      </div>

      <EvidenceUrlList values={evidence} onChange={setEvidence} disabled={pending} />

      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Submitting…" : "Open dispute"}
        </Button>
      </div>
    </form>
  );
}

function humanizeError(code?: string): string | null {
  switch (code) {
    case "ORDER_NOT_FOUND":
      return "We couldn't find that order on your account.";
    case "ALREADY_DISPUTED":
      return "A dispute is already open for this shop on this order.";
    case "ORDER_NOT_DISPUTABLE":
      return "This order isn't eligible for a dispute yet.";
    case "ITEMS_REQUIRED":
      return "Select at least one item to dispute.";
    case "ITEMS_INVALID":
      return "One of the selected items isn't part of this order.";
    case "ITEMS_MULTIPLE_SHOPS":
      return "A dispute can only cover items from a single shop.";
    case "ITEMS_NOT_DISPUTABLE":
      return "One of the selected items can't be disputed (already refunded).";
    case "CLAIM_WINDOW_EXPIRED":
      return "The dispute window for this order has closed.";
    case "FORBIDDEN":
      return "Only buyers can open disputes.";
    case "UNAUTHENTICATED":
      return "Please sign in to open a dispute.";
    default:
      return null;
  }
}
