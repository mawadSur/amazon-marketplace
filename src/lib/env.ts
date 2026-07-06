// Centralized env access with light validation.
// Server-only values throw if accessed without being set.
//
// Many providers + the .env.example template ship empty placeholders, which
// `z.string().url()` rejects ("" isn't a valid URL). To keep the schema
// declarative, we pre-process `process.env` and treat "" as undefined for
// every optional field. Required fields still throw if blank.

import { z } from "zod";

/** Drop empty-string entries so `.optional()` schemas see them as undefined. */
function nonEmpty(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = v === "" ? undefined : v;
  }
  return out;
}

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  // Direct (non-pooled) Postgres URL used by `prisma migrate`. Optional at
  // runtime; only required for migrations (see prisma/schema.prisma directUrl).
  DIRECT_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(16).optional(),
  // Canonical deployment origin for NextAuth callbacks (e.g. https://shezmin.com).
  AUTH_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // RazorpayX source account (the payer account funds are debited from) for payouts.
  RAZORPAY_ACCOUNT_NUMBER: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  REMOVE_BG_API_KEY: z.string().optional(),
  HIGGSFIELD_API_KEY: z.string().optional(),
  // Cost kill-switch: when "false", runtime avatar-video generation is skipped
  // even if HIGGSFIELD_API_KEY is set. Absent/any-other-value = enabled.
  AVATAR_VIDEO_ENABLED: z.string().optional(),
  SHIPROCKET_EMAIL: z.string().optional(),
  SHIPROCKET_PASSWORD: z.string().optional(),
  KYC_PROVIDER_API_KEY: z.string().optional(),
  // Base URL of the KYC verification provider's REST API.
  KYC_PROVIDER_BASE_URL: z.string().url().optional(),
  // Transactional email (Resend).
  RESEND_API_KEY: z.string().optional(),
  // Verified "From" address for outbound email (e.g. "Shezmin <no-reply@shezmin.com>").
  EMAIL_FROM: z.string().optional(),
});

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  // Canonical public site origin (used for canonical URLs, emails, sitemaps).
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
});

// Keys kept .optional() for dev/test convenience but MUST be present in
// production — the app fails CLOSED (never boots half-configured) rather than
// failing open on missing payment/auth/queue secrets.
const PRODUCTION_REQUIRED = [
  "AUTH_SECRET",
  "REDIS_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;

// During `next build`, Next.js sets NODE_ENV=production and imports server
// modules to collect page data — but CI build environments legitimately lack
// runtime secrets. Skip the fail-closed check during the build phase so the
// enforcement fires at actual runtime (server boot / request handling), not at
// compile time. SKIP_ENV_VALIDATION offers an explicit escape hatch too.
const isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.SKIP_ENV_VALIDATION === "1";

const refinedServerSchema = serverSchema.superRefine((val, ctx) => {
  if (val.NODE_ENV !== "production" || isBuildPhase) return;
  const missing: string[] = [];
  for (const key of PRODUCTION_REQUIRED) {
    if (!val[key]) missing.push(key);
  }
  // AUTH_SECRET has a length floor even when present; superRefine sees the
  // already-parsed value, so a too-short secret is caught by the field schema.
  if (missing.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Missing required production env vars: ${missing.join(", ")}. Set them before deploying (fail-closed).`,
    });
  }
});

export const env = refinedServerSchema.parse(
  nonEmpty(process.env as Record<string, string | undefined>),
);
export const publicEnv = publicSchema.parse(
  nonEmpty({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  }),
);
