// Twilio Verify OTP provider (Module 1).
//
// Extracted from src/lib/stubs.ts. Gating (fail-closed in prod):
//   - creds present (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN +
//     TWILIO_VERIFY_SERVICE_SID) -> real Twilio Verify. Verify OWNS the code:
//     we do NOT generate/hash/persist an OtpCode row and NEVER return devCode.
//     The matching verify-check must go through Twilio Verify too (see NOTE).
//   - creds absent AND NODE_ENV !== "production" -> dev fallback: write a fixed
//     OtpCode row (bcrypt-hashed) so the auth.ts OtpCode verify path keeps
//     working locally, and expose devCode so the dev UI can show it.
//   - creds absent AND NODE_ENV === "production" -> throw (fail closed).
//
// Signature is stable and re-exported from "@/lib/stubs".
//
// Verify side lives in checkOtp() below: src/lib/auth.ts's phone-otp
// authorize() calls checkOtp(phone, code), which routes to Twilio Verify's
// verificationChecks in real mode and to the OtpCode table in the dev fallback.

import twilio, { type Twilio } from "twilio";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import bcrypt from "bcryptjs";

const STUB_OTP = "123456";

const logger = log.child({ module: "twilio" });

/** True when every Twilio Verify credential is configured. */
function hasVerifyCreds(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID,
  );
}

let client: Twilio | null = null;
function getClient(): Twilio {
  if (!client) {
    client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
  }
  return client;
}

export async function sendOtp(phone: string): Promise<{ sent: true; devCode?: string }> {
  if (hasVerifyCreds()) {
    // Real mode: Twilio Verify generates, stores, and rate-limits the code.
    await getClient()
      .verify.v2.services(env.TWILIO_VERIFY_SERVICE_SID!)
      .verifications.create({ to: phone, channel: "sms" });
    logger.info({ phone }, "otp sent via twilio verify");
    // Never leak a code back to the client in real mode.
    return { sent: true };
  }

  if (env.NODE_ENV === "production") {
    // Fail closed: refuse to fake OTPs in production.
    throw new Error(
      "OTP unavailable: Twilio Verify is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID).",
    );
  }

  // Dev fallback: persist a fixed code so auth.ts's OtpCode verify path works
  // locally, and surface it so the dev UI can display it.
  const hash = await bcrypt.hash(STUB_OTP, 10);
  await prisma.otpCode.create({
    data: {
      phone,
      codeHash: hash,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  logger.warn({ phone }, "otp dev fallback (fixed code) — Twilio Verify not configured");
  return { sent: true, devCode: STUB_OTP };
}

/**
 * Verify a submitted OTP code. Counterpart to sendOtp — the credential path in
 * src/lib/auth.ts calls this so the send/verify modes stay in lockstep.
 *
 *   - Verify creds present -> Twilio Verify owns the code: check via
 *     verificationChecks.create({ to, code }); "approved" === valid. No OtpCode
 *     row is ever consulted (none was written).
 *   - creds absent AND NODE_ENV !== "production" -> dev fallback: validate against
 *     the OtpCode table (bcrypt), enforcing expiry, a per-code attempt cap, and
 *     single use — the exact logic the auth route used to run inline.
 *   - creds absent AND NODE_ENV === "production" -> throw (fail closed).
 *
 * Returns true only when the code is valid. Never throws for an invalid code.
 */
export async function checkOtp(phone: string, code: string): Promise<boolean> {
  if (hasVerifyCreds()) {
    try {
      const check = await getClient()
        .verify.v2.services(env.TWILIO_VERIFY_SERVICE_SID!)
        .verificationChecks.create({ to: phone, code });
      const ok = check.status === "approved";
      logger.info({ phone, ok }, "otp verify check via twilio");
      return ok;
    } catch (err) {
      // Verify throws (e.g. 404) when the code expired, was never sent, or the
      // max check attempts were exceeded — all of which mean "not valid".
      logger.warn({ phone, err }, "twilio verify check failed");
      return false;
    }
  }

  if (env.NODE_ENV === "production") {
    // Fail closed: never validate OTPs without a real verifier in production.
    throw new Error(
      "OTP verification unavailable: Twilio Verify is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID).",
    );
  }

  // Dev fallback: validate against the OtpCode table written by sendOtp.
  const otp = await prisma.otpCode.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) return false;

  // Burn the code after too many attempts so it can't be hammered.
  const MAX_OTP_ATTEMPTS = 5;
  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
    return false;
  }

  const ok = await bcrypt.compare(code, otp.codeHash);
  if (!ok) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return false;
  }

  // Single use: consume on success.
  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  return true;
}
