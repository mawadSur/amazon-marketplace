import { NextResponse } from "next/server";
import { z } from "zod";
import { sendOtp } from "@/lib/stubs";
import { rateLimit, clientKey, rateLimitHeaders } from "@/lib/ratelimit";

const bodySchema = z.object({
  phone: z
    .string()
    .trim()
    // Permissive E.164-ish: digits + optional leading "+", 8-20 chars total.
    .regex(/^\+?\d{8,19}$/, "Enter a valid phone number with country code"),
});

export async function POST(req: Request) {
  // Strict: OTP sending costs real money + opens a brute-force window per code.
  const rl = await rateLimit(clientKey(req, "otp.send"), 5, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  // Per-phone cap on top of the per-IP cap — same number can only request 3/min.
  const phoneRl = await rateLimit(`otp.send:phone:${parsed.data.phone}`, 3, 60);
  if (!phoneRl.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterSeconds: phoneRl.retryAfterSeconds },
      { status: 429, headers: rateLimitHeaders(phoneRl) },
    );
  }

  try {
    const result = await sendOtp(parsed.data.phone);
    return NextResponse.json(result);
  } catch {
    // sendOtp fails closed when the SMS provider is unconfigured, and can also
    // surface transient provider errors. Never leak internals to the client.
    return NextResponse.json({ error: "OTP_UNAVAILABLE" }, { status: 503 });
  }
}
