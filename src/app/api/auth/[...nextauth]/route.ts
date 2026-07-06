// NextAuth catch-all. GET passes straight through to the Auth.js handler.
// POST is wrapped so credential sign-in attempts are IP-rate-limited at the
// edge of the route — the same coarse protection register/otp already have —
// on top of the per-IP + per-account lockout enforced inside authorize()
// (see src/lib/auth.ts). Non-sign-in POSTs (csrf, signout, session) pass
// through untouched.

import { NextResponse, type NextRequest } from "next/server";
import { GET as authGet, POST as authPost } from "@/lib/auth-route";
import { rateLimit, clientKey, rateLimitHeaders } from "@/lib/ratelimit";

export const GET = authGet;

export async function POST(req: NextRequest) {
  // Credential sign-in POSTs to /api/auth/callback/<providerId> (phone-otp or
  // email-password). OAuth callbacks arrive as GET, so gating POST /callback/*
  // targets exactly the credential brute-force surface.
  const { pathname } = new URL(req.url);
  if (pathname.includes("/callback/")) {
    const rl = await rateLimit(clientKey(req, "auth.signin"), 10, 60);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait a moment." },
        { status: 429, headers: rateLimitHeaders(rl) },
      );
    }
  }
  return authPost(req);
}
