// Admin-side status pill covering shop / product / order / payment / payout
// / dispute / shipment / KYC enums. Decoupled from the seller-side
// AI-job pill in src/components/listing/status-pill.tsx.

import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warn" | "danger";

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-blue-100 text-blue-800",
  success: "bg-green-100 text-green-800",
  warn: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
};

// Map every status string we expect to surface to a tone.
const TONES: Record<string, Tone> = {
  // Shop
  PENDING_REVIEW: "warn",
  APPROVED: "success",
  SUSPENDED: "danger",
  REJECTED: "danger",
  // Product
  DRAFT: "neutral",
  PUBLISHED: "success",
  ARCHIVED: "neutral",
  // Order
  PLACED: "info",
  PAID: "success",
  PROCESSING: "info",
  SHIPPED: "info",
  DELIVERED: "success",
  COMPLETED: "success",
  CANCELLED: "neutral",
  REFUNDED: "warn",
  DISPUTED: "danger",
  // Payment
  PENDING: "warn",
  AUTHORIZED: "info",
  CAPTURED: "success",
  FAILED: "danger",
  // Payout (overlaps with Payment intentionally)
  PAID_OUT: "success",
  // KYC
  NOT_SUBMITTED: "neutral",
  SUBMITTED: "info",
  VERIFIED: "success",
  // Payout ops (admin-derived)
  STRANDED: "danger",
  // Shipment
  LABEL_PENDING: "neutral",
  LABEL_CREATED: "info",
  PICKED_UP: "info",
  IN_TRANSIT: "info",
  CUSTOMS: "info",
  OUT_FOR_DELIVERY: "info",
  EXCEPTION: "danger",
  RETURNED: "warn",
  // Buyer protection
  ELIGIBLE: "neutral",
  CLAIMED: "warn",
  DENIED: "danger",
  // Dispute
  OPEN: "warn",
  UNDER_REVIEW: "info",
  RESOLVED_BUYER: "success",
  RESOLVED_SELLER: "success",
  // Badge
  NONE: "neutral",
  NEW: "info",
  TOP_RATED: "success",
};

export function StatusPill({ value, className }: { value: string; className?: string }) {
  const tone = TONES[value] ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        TONE_STYLES[tone],
        className,
      )}
    >
      {value.toLowerCase().replace(/_/g, " ")}
    </span>
  );
}
