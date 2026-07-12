// KYC verification provider (Module 1) — SIGNZY.
//
// Verifies a seller's PAN / GSTIN / Udyam identifiers against Signzy's API
// gateway. The flow mirrors Signzy's documented gateway contract:
//   1) exchange credentials for an access token (cached, ~14-day validity),
//   2) call the per-identifier verification endpoints with that token,
//   3) map Signzy's response to { verified, reason }.
//
// PAN and GSTIN verification are SYNCHRONOUS at Signzy (real-time lookups), so
// verifyKyc stays synchronous: it returns VERIFIED / REJECTED, never a "pending"
// state. (If an account later needs async/pending KYC, KycResult would grow a
// status field and onboarding.ts would persist ShopKyc.status = SUBMITTED.)
//
// Gating (fail-closed in prod), unchanged from the previous provider:
//   - Signzy creds present -> real gateway calls.
//   - Legacy KYC_PROVIDER_* creds present (and no Signzy creds) -> legacy generic
//     REST call, so pre-existing deployments keep working (superseded, not broken).
//   - no creds AND NODE_ENV !== "production" -> dev pass-through (any non-empty id).
//   - no creds AND NODE_ENV === "production" -> throw. NEVER auto-pass KYC in prod.
//
// Signature (verifyKyc(KycInput) -> KycResult) is stable and re-exported from
// "@/lib/stubs".
//
// NEEDS CONFIRMATION against the owner's Signzy account (see returned followUps):
// the login path/realm, the exact PAN/GSTIN/Udyam endpoint paths, the request
// field names (pan / gstin / udyam), and the Authorization header format. All of
// these are env-configurable so they can be corrected without a code change.

import { env } from "@/lib/env";
import { log } from "@/lib/log";

const logger = log.child({ module: "kyc" });

type KycInput = {
  gstNumber?: string;
  panNumber?: string;
  udyamNumber?: string;
};

type KycResult = { verified: boolean; reason?: string };

// Signzy access tokens are valid ~14 days; refresh a little early.
const TOKEN_TTL_MS = 13 * 24 * 60 * 60_000;

function hasSignzyCreds(): boolean {
  return Boolean(env.SIGNZY_BASE_URL && env.SIGNZY_USERNAME && env.SIGNZY_PASSWORD);
}

function hasLegacyCreds(): boolean {
  return Boolean(env.KYC_PROVIDER_API_KEY && env.KYC_PROVIDER_BASE_URL);
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- Signzy flow

// Module-level token cache shared across invocations in the same process
// (mirrors src/lib/providers/shiprocket.ts getToken()).
let cachedAuth: { token: string; userId: string; expiresAt: number } | null = null;

/** Exchange Signzy credentials for an access token + user id (cached). */
async function getSignzyAuth(): Promise<{ token: string; userId: string }> {
  if (cachedAuth && cachedAuth.expiresAt > Date.now()) {
    return { token: cachedAuth.token, userId: cachedAuth.userId };
  }

  const base = trimBase(env.SIGNZY_BASE_URL!);
  const res = await fetch(`${base}${env.SIGNZY_LOGIN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.SIGNZY_USERNAME,
      password: env.SIGNZY_PASSWORD,
      // Some Signzy accounts require a realm/tenant on login; only send when set.
      ...(env.SIGNZY_REALM ? { realm: env.SIGNZY_REALM } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body: body.slice(0, 300) }, "signzy login failed");
    throw new Error(`Signzy login failed (${res.status}).`);
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // Signzy returns the auth token in `id` (14-day expiry); accept common aliases.
  const token =
    (typeof data?.id === "string" && data.id) ||
    (typeof data?.access_token === "string" && data.access_token) ||
    (typeof data?.accessToken === "string" && data.accessToken) ||
    (typeof data?.token === "string" && data.token) ||
    "";
  const userId =
    (typeof data?.userid === "string" && data.userid) ||
    (typeof data?.userId === "string" && data.userId) ||
    (typeof (data?.data as Record<string, unknown>)?.id === "string"
      ? ((data!.data as Record<string, unknown>).id as string)
      : "") ||
    "";
  if (!token) throw new Error("Signzy login response missing token.");

  cachedAuth = { token, userId, expiresAt: Date.now() + TOKEN_TTL_MS };
  return { token, userId };
}

/**
 * Status strings that mean the IDENTIFIER (PAN/GSTIN) itself is valid/active.
 *
 * Deliberately EXCLUDES generic transport-level markers like "success"/"yes":
 * many Signzy/marketplace envelopes use status:"success" to mean "the API
 * request was processed" — NOT "the PAN/GSTIN is valid". Treating those as a
 * PASS is the dangerous fail-OPEN direction for a KYC gate, so we only accept
 * identifier-specific verdicts and stay fail-closed on anything ambiguous.
 *
 * NEEDS CONFIRMATION with the owner's Signzy account: pin the EXACT positive
 * marker the account returns (e.g. panStatus/gstinStatus === "VALID"/"EXISTING"/
 * "ACTIVE") rather than relying on this alias list.
 */
function isPositiveStatus(s: string): boolean {
  return ["valid", "active", "existing", "exists", "verified"].includes(
    s.trim().toLowerCase(),
  );
}

function reasonFrom(r: Record<string, unknown>): string | undefined {
  for (const k of ["reason", "message", "error", "remarks"]) {
    if (typeof r[k] === "string" && r[k]) return r[k] as string;
  }
  return undefined;
}

/** Map a Signzy verification response into { verified, reason }. Fail-closed. */
function interpretSignzy(data: unknown): KycResult {
  if (!data || typeof data !== "object") {
    return { verified: false, reason: "Unrecognized Signzy response." };
  }
  const root = data as Record<string, unknown>;
  // Signzy often nests the payload under `result`.
  const r =
    root.result && typeof root.result === "object"
      ? (root.result as Record<string, unknown>)
      : root;

  for (const key of ["verified", "valid", "isValid", "active"]) {
    if (typeof r[key] === "boolean") {
      const ok = r[key] as boolean;
      return { verified: ok, reason: ok ? undefined : reasonFrom(r) };
    }
  }
  for (const key of ["status", "panStatus", "gstinStatus", "gstnStatus", "result"]) {
    if (typeof r[key] === "string") {
      const ok = isPositiveStatus(r[key] as string);
      return { verified: ok, reason: ok ? undefined : (reasonFrom(r) ?? `Status: ${r[key]}`) };
    }
  }
  return { verified: false, reason: reasonFrom(r) ?? "Signzy response could not be interpreted." };
}

/**
 * POST a single identifier to a Signzy endpoint and interpret the response.
 *
 * `isRetry` guards a SINGLE re-authentication attempt: the cached token can be
 * revoked/expired before its TTL (early revocation, password rotation, plan
 * change), which surfaces as a 401/403. When that happens we drop the cached
 * token and re-run getSignzyAuth()+fetch exactly once, so an expired token
 * doesn't silently wedge ALL seller KYC closed until the process/deploy
 * restarts. Callers must not pass `isRetry` — it's internal.
 */
async function signzyVerify(
  path: string,
  payload: Record<string, unknown>,
  isRetry = false,
): Promise<KycResult> {
  const { token, userId } = await getSignzyAuth();
  const base = trimBase(env.SIGNZY_BASE_URL!);
  // Legacy "patrons" style endpoints embed the userId in the path; support both
  // by substituting a {userId} placeholder when present.
  const resolvedPath = path.replace("{userId}", encodeURIComponent(userId));

  const res = await fetch(`${base}${resolvedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Signzy authenticates with the raw login `id` in the Authorization header.
      Authorization: token,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // Auth failure on a cached token: invalidate it and re-authenticate once.
    if ((res.status === 401 || res.status === 403) && !isRetry) {
      logger.warn(
        { path: resolvedPath, status: res.status },
        "signzy auth rejected — clearing cached token and retrying once",
      );
      cachedAuth = null;
      return signzyVerify(path, payload, true);
    }
    const body = await res.text().catch(() => "");
    logger.error({ path: resolvedPath, status: res.status, body: body.slice(0, 300) }, "signzy verify error");
    return { verified: false, reason: `KYC provider returned ${res.status}.` };
  }
  const data = await res.json().catch(() => null);
  return interpretSignzy(data);
}

async function verifyViaSignzy(inp: KycInput): Promise<KycResult> {
  // Verify every provided-and-checkable identifier. Fail-closed: the seller is
  // verified only if at least one check ran and every attempted check passed.
  const checks: Array<{ id: string; run: Promise<KycResult> }> = [];

  if (inp.panNumber) {
    checks.push({ id: "PAN", run: signzyVerify(env.SIGNZY_PAN_PATH, { pan: inp.panNumber }) });
  }
  if (inp.gstNumber) {
    checks.push({ id: "GSTIN", run: signzyVerify(env.SIGNZY_GSTIN_PATH, { gstin: inp.gstNumber }) });
  }
  if (inp.udyamNumber) {
    if (env.SIGNZY_UDYAM_PATH) {
      checks.push({ id: "Udyam", run: signzyVerify(env.SIGNZY_UDYAM_PATH, { udyam: inp.udyamNumber }) });
    } else if (checks.length === 0) {
      // Only a Udyam number was supplied but no Udyam endpoint is enabled.
      return {
        verified: false,
        reason: "Udyam verification isn't enabled for this account — add a PAN or GST number.",
      };
    }
    // else: PAN/GST will be checked; Udyam is skipped (best-effort).
  }

  if (checks.length === 0) {
    return { verified: false, reason: "No verifiable identifier was provided." };
  }

  const results = await Promise.all(checks.map((c) => c.run));
  const failed = checks.find((_, i) => !results[i].verified);
  if (failed) {
    const res = results[checks.indexOf(failed)];
    logger.info({ failed: failed.id, verified: false }, "signzy kyc rejected");
    return { verified: false, reason: res.reason ?? `${failed.id} could not be verified.` };
  }

  logger.info({ verified: true, checks: checks.map((c) => c.id) }, "signzy kyc verified");
  return { verified: true };
}

// ---------------------------------------------------------------- Legacy flow

/** Interpret a variety of legacy provider response shapes into { verified, reason }. */
function interpretLegacy(data: unknown): KycResult {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.verified === "boolean") {
      return { verified: d.verified, reason: typeof d.reason === "string" ? d.reason : undefined };
    }
    if (typeof d.status === "string") {
      const ok = ["verified", "valid", "success", "active"].includes(d.status.toLowerCase());
      return {
        verified: ok,
        reason: ok ? undefined : (typeof d.message === "string" ? d.message : `KYC status: ${d.status}`),
      };
    }
  }
  return { verified: false, reason: "Unrecognized KYC provider response." };
}

async function verifyViaLegacy(inp: KycInput): Promise<KycResult> {
  const base = trimBase(env.KYC_PROVIDER_BASE_URL!);
  const res = await fetch(`${base}/kyc/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.KYC_PROVIDER_API_KEY}`,
    },
    body: JSON.stringify({
      gstNumber: inp.gstNumber,
      panNumber: inp.panNumber,
      udyamNumber: inp.udyamNumber,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body: body.slice(0, 500) }, "kyc provider error");
    return { verified: false, reason: `KYC provider returned ${res.status}.` };
  }
  const data = await res.json().catch(() => null);
  const result = interpretLegacy(data);
  logger.info({ verified: result.verified }, "legacy kyc verification result");
  return result;
}

// ---------------------------------------------------------------- Entry point

export async function verifyKyc(inp: KycInput): Promise<KycResult> {
  // Boundary validation applies in every mode.
  if (!inp.gstNumber && !inp.panNumber && !inp.udyamNumber) {
    return { verified: false, reason: "Provide at least one of GST / PAN / Udyam." };
  }

  if (hasSignzyCreds()) {
    try {
      return await verifyViaSignzy(inp);
    } catch (err) {
      logger.error({ err }, "signzy kyc verification threw");
      return { verified: false, reason: "KYC verification is temporarily unavailable." };
    }
  }

  if (hasLegacyCreds()) {
    try {
      return await verifyViaLegacy(inp);
    } catch (err) {
      logger.error({ err }, "kyc verification threw");
      return { verified: false, reason: "KYC verification is temporarily unavailable." };
    }
  }

  if (env.NODE_ENV === "production") {
    // Fail closed: never auto-pass KYC without a real provider in prod.
    throw new Error(
      "KYC unavailable: Signzy is not configured (set SIGNZY_BASE_URL, SIGNZY_USERNAME, SIGNZY_PASSWORD).",
    );
  }

  // Dev fallback: any non-empty identifier passes.
  logger.warn("kyc dev fallback (auto-pass) — provider not configured");
  return { verified: true };
}
