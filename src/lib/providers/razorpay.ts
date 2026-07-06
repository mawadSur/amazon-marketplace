// RazorpayX payouts provider (Module 1/4).
//
// RazorpayX (contacts / fund_accounts / payouts) is NOT part of the `razorpay`
// npm SDK, so we call the REST API directly with HTTP Basic auth
// (key_id:key_secret) — mirroring the fetch pattern used elsewhere in this repo.
//
// Gating (fail-closed): RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET present -> real
// RazorpayX calls; absent AND dev/test -> deterministic stub IDs; absent AND
// production -> throw. Signatures are stable and re-exported from "@/lib/stubs".

import { env } from "@/lib/env";

const RZP_API_BASE = "https://api.razorpay.com/v1";

function rzpAuthHeader(): string | null {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  return (
    "Basic " +
    Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")
  );
}

async function rzpPost(
  path: string,
  body: Record<string, unknown>,
  auth: string,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${RZP_API_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { description?: string } | undefined;
    throw new Error(`RAZORPAYX_${res.status}: ${err?.description ?? res.statusText}`);
  }
  return json;
}

export async function razorpayCreateFundAccount(inp: {
  name: string;
  accountNumber: string;
  ifsc: string;
}): Promise<{ contactId: string; fundAccountId: string }> {
  const auth = rzpAuthHeader();
  if (!auth) {
    if (env.NODE_ENV === "production") {
      throw new Error("RAZORPAY_KEY_ID/SECRET missing — refusing RazorpayX in production (fail-closed).");
    }
    // Dev stub: deterministic IDs derived from input.
    const suffix = Buffer.from(inp.accountNumber).toString("hex").slice(0, 12);
    return { contactId: `cont_stub_${suffix}`, fundAccountId: `fa_stub_${suffix}` };
  }

  const contact = await rzpPost("/contacts", { name: inp.name, type: "vendor" }, auth);
  const contactId = String(contact.id);

  const fundAccount = await rzpPost(
    "/fund_accounts",
    {
      contact_id: contactId,
      account_type: "bank_account",
      bank_account: { name: inp.name, ifsc: inp.ifsc, account_number: inp.accountNumber },
    },
    auth,
  );

  return { contactId, fundAccountId: String(fundAccount.id) };
}

export async function razorpayCreatePayout(inp: {
  fundAccountId: string;
  amountInrPaise: number;
  reference: string;
}): Promise<{ payoutId: string; status: "processing" }> {
  const auth = rzpAuthHeader();
  if (!auth) {
    if (env.NODE_ENV === "production") {
      throw new Error("RAZORPAY_KEY_ID/SECRET missing — refusing RazorpayX payout in production (fail-closed).");
    }
    return { payoutId: `pout_stub_${inp.reference}`, status: "processing" };
  }
  if (!env.RAZORPAY_ACCOUNT_NUMBER) {
    throw new Error("RAZORPAY_ACCOUNT_NUMBER missing — required to source RazorpayX payouts.");
  }

  const payout = await rzpPost(
    "/payouts",
    {
      account_number: env.RAZORPAY_ACCOUNT_NUMBER,
      fund_account_id: inp.fundAccountId,
      amount: inp.amountInrPaise,
      currency: "INR",
      mode: "IMPS",
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: inp.reference,
      narration: "Shezmin seller payout",
    },
    auth,
    // Idempotency: RazorpayX dedups payouts sharing this header value.
    { "X-Payout-Idempotency": inp.reference },
  );

  return { payoutId: String(payout.id), status: "processing" };
}

/**
 * Clawback a payout after a buyer-favored dispute/refund. A *queued* RazorpayX
 * payout can be cancelled via API; a *processed* one has no recall endpoint and
 * must be recovered out-of-band (direct debit / manual) — callers still record a
 * PayoutReversal ledger row so ops can chase the funds. Returns a reversal ref.
 */
export async function razorpayReversePayout(inp: {
  payoutId: string;
  amountInrPaise: number;
  reason?: string;
}): Promise<{ reversalRef: string }> {
  const auth = rzpAuthHeader();
  if (!auth) {
    if (env.NODE_ENV === "production") {
      throw new Error("RAZORPAY_KEY_ID/SECRET missing — refusing RazorpayX reversal in production (fail-closed).");
    }
    return { reversalRef: `rvsl_stub_${inp.payoutId}` };
  }

  try {
    // Best-effort cancel — succeeds only while the payout is still queued.
    const res = await rzpPost(`/payouts/${inp.payoutId}/cancel`, {}, auth);
    return { reversalRef: String(res.id ?? `rvsl_${inp.payoutId}`) };
  } catch {
    // Already processed / not cancellable: ledger-only reversal for ops recovery.
    return { reversalRef: `rvsl_${inp.payoutId}` };
  }
}
