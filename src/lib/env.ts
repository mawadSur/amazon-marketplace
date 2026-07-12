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
  // Weekly bulk payout scheduler (Wave 2). Seller payouts are HELD at delivery
  // and disbursed in a weekly batch on this weekday. Accepts a weekday NAME
  // (case-insensitive, e.g. "MONDAY"); anything unrecognised falls back to
  // Monday in the schedule helpers. Default: Monday.
  PAYOUT_RUN_WEEKDAY: z.string().default("MONDAY"),
  // Hold window in DAYS after delivery before a payout becomes eligible for the
  // weekly batch (gives the buyer time to open a dispute before money leaves
  // escrow). Coerced from the string env value. Default: 5.
  PAYOUT_HOLD_DAYS: z.coerce.number().int().min(0).default(5),
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
  // Shared secret authenticating inbound Shiprocket tracking webhooks. The
  // webhook route fails CLOSED in production when this is absent (matching the
  // Stripe/Razorpay webhook pattern).
  SHIPROCKET_WEBHOOK_SECRET: z.string().optional(),
  // Nickname of a pickup location configured in the Shiprocket dashboard; sent
  // as `pickup_location` on ad-hoc orders. Defaults to "Primary".
  SHIPROCKET_PICKUP_LOCATION: z.string().default("Primary"),
  // KYC — Signzy API gateway (primary provider). When these are set, seller KYC
  // (PAN / GSTIN / Udyam) is verified against Signzy. The provider exchanges
  // username+password (+optional realm) for an access token, then calls the
  // per-identifier endpoints. Endpoint paths are configurable so the exact
  // account-specific paths can be corrected without a code change.
  SIGNZY_BASE_URL: z.string().url().optional(),
  SIGNZY_USERNAME: z.string().optional(),
  SIGNZY_PASSWORD: z.string().optional(),
  // Optional tenant/realm sent on the Signzy login call (some accounts require it).
  SIGNZY_REALM: z.string().optional(),
  // Signzy endpoint paths (relative to SIGNZY_BASE_URL). Defaults are best-effort
  // and MUST be confirmed against the owner's Signzy account. A path may contain
  // a `{userId}` placeholder (substituted with the login user id) for the
  // legacy "patrons" style endpoints.
  SIGNZY_LOGIN_PATH: z.string().default("/api/backopsusers/login"),
  SIGNZY_PAN_PATH: z.string().default("/api/v3/getpandetails"),
  SIGNZY_GSTIN_PATH: z.string().default("/api/v3/gstin"),
  // Optional: only set when the account has an Udyam/MSME verification endpoint.
  SIGNZY_UDYAM_PATH: z.string().optional(),
  // Legacy generic KYC provider (SUPERSEDED by SIGNZY_* above). Kept so existing
  // deployments that set these keep working: used only when no SIGNZY_* creds are
  // present. Prefer migrating to the Signzy vars.
  KYC_PROVIDER_API_KEY: z.string().optional(),
  KYC_PROVIDER_BASE_URL: z.string().url().optional(),
  // Transactional email (Resend).
  RESEND_API_KEY: z.string().optional(),
  // Verified "From" address for outbound email (e.g. "Shezmin <no-reply@shezmin.com>").
  EMAIL_FROM: z.string().optional(),
  // Observability (Sentry). DSN activates server/edge/worker error capture; the
  // ORG/PROJECT/AUTH_TOKEN triple enables source-map upload during `next build`.
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  // Structured-log verbosity. Defaults to "info" in log.ts when unset.
  LOG_LEVEL: z.string().optional(),
  // Used by seed scripts (prisma/seed.ts) for generated imagery.
  GEMINI_API_KEY: z.string().optional(),
});

const publicSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  // Canonical public site origin (used for canonical URLs, emails, sitemaps).
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().optional(),
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
  // Payout source account — required at payout time; fail closed at boot rather
  // than throwing on the first DELIVERED transition in production.
  "RAZORPAY_ACCOUNT_NUMBER",
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
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  }),
);
