// KYC verification provider (Module 1).
//
// Extracted from src/lib/stubs.ts. Verifies a seller's GST / PAN / Udyam
// identifiers against a KYC provider's REST API.
//
// Gating (fail-closed in prod):
//   - creds present (KYC_PROVIDER_API_KEY + KYC_PROVIDER_BASE_URL) -> real REST
//     call to the provider.
//   - creds absent AND NODE_ENV !== "production" -> dev pass-through (any
//     non-empty identifier passes).
//   - creds absent AND NODE_ENV === "production" -> throw. NEVER auto-pass KYC
//     in production.
//
// Signature is stable and re-exported from "@/lib/stubs".
//
// REQUEST/RESPONSE MAPPING — NEEDS CONFIRMATION against the chosen provider.
// This targets a generic GST/PAN verification REST shape:
//   POST {BASE_URL}/kyc/verify
//   Authorization: Bearer {KYC_PROVIDER_API_KEY}
//   body: { gstNumber?, panNumber?, udyamNumber? }
//   200 -> { verified: boolean, reason?: string }   (or { status: "..." })
// Adjust the endpoint path + field names when the provider is finalized.

import { env } from "@/lib/env";
import { log } from "@/lib/log";

const logger = log.child({ module: "kyc" });

type KycInput = {
  gstNumber?: string;
  panNumber?: string;
  udyamNumber?: string;
};

type KycResult = { verified: boolean; reason?: string };

function hasCreds(): boolean {
  return Boolean(env.KYC_PROVIDER_API_KEY && env.KYC_PROVIDER_BASE_URL);
}

/** Interpret a variety of provider response shapes into { verified, reason }. */
function interpretResponse(data: unknown): KycResult {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.verified === "boolean") {
      return { verified: d.verified, reason: typeof d.reason === "string" ? d.reason : undefined };
    }
    // Common alternate: a string status field.
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

export async function verifyKyc(inp: KycInput): Promise<KycResult> {
  // Boundary validation applies in every mode.
  if (!inp.gstNumber && !inp.panNumber && !inp.udyamNumber) {
    return { verified: false, reason: "Provide at least one of GST / PAN / Udyam." };
  }

  if (hasCreds()) {
    const base = env.KYC_PROVIDER_BASE_URL!.replace(/\/+$/, "");
    try {
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
        // Fail closed on a bad response: do NOT verify.
        return { verified: false, reason: `KYC provider returned ${res.status}.` };
      }

      const data = await res.json().catch(() => null);
      const result = interpretResponse(data);
      logger.info({ verified: result.verified }, "kyc verification result");
      return result;
    } catch (err) {
      logger.error({ err }, "kyc verification threw");
      return { verified: false, reason: "KYC verification is temporarily unavailable." };
    }
  }

  if (env.NODE_ENV === "production") {
    // Fail closed: never auto-pass KYC without a real provider in prod.
    throw new Error(
      "KYC unavailable: provider not configured (set KYC_PROVIDER_API_KEY and KYC_PROVIDER_BASE_URL).",
    );
  }

  // Dev fallback: any non-empty identifier passes.
  logger.warn("kyc dev fallback (auto-pass) — provider not configured");
  return { verified: true };
}
