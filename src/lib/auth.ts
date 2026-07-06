// NextAuth v5 (Auth.js) configuration.
//
// Two credentials providers:
//   - "phone-otp" for India seller signin (phone + OTP verified via checkOtp:
//     Twilio Verify in prod, OtpCode table in the dev fallback)
//   - "email-password" for US buyer signin (email + bcrypt-hashed password)
//
// Roles live on the User row; the session carries `role` and `id`.

import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { peekRateLimit, rateLimit, clientKey } from "@/lib/ratelimit";
import { checkOtp } from "@/lib/providers/twilio";
import { log } from "@/lib/log";
import type { UserRole } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }
}

const phoneSchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().length(6),
});

const emailSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// Credential brute-force lockout. We count only *failed* attempts (bcrypt
// mismatch / unknown account) against two independent sliding windows: one per
// source IP (stops a single host spraying many accounts) and one per targeted
// account identifier (stops distributed guessing of one account). A successful
// sign-in records nothing, so legitimate users are never locked out by their
// own login.
const LOGIN_IP_MAX = 20; // failed attempts per IP per window
const LOGIN_ACCT_MAX = 5; // failed attempts per account identifier per window
const LOGIN_WINDOW_SEC = 15 * 60;

/** Best-effort key pair for a credential attempt. Falls back to "unknown" IP
 *  when NextAuth hands us no request (never in HTTP flows, but keeps types safe). */
function loginKeys(request: Request | undefined, kind: string, identifier: string) {
  const ipKey = request
    ? clientKey(request, `auth.${kind}.ip`)
    : `auth.${kind}.ip:unknown`;
  const acctKey = `auth.${kind}.acct:${identifier}`;
  return { ipKey, acctKey };
}

/** Throws a clear lockout error if the IP or the targeted account has exceeded
 *  the failed-attempt budget. Peeks only — does not itself count as an attempt. */
async function assertNotLockedOut(
  request: Request | undefined,
  kind: string,
  identifier: string,
): Promise<void> {
  const { ipKey, acctKey } = loginKeys(request, kind, identifier);
  const [ipState, acctState] = await Promise.all([
    peekRateLimit(ipKey, LOGIN_IP_MAX, LOGIN_WINDOW_SEC),
    peekRateLimit(acctKey, LOGIN_ACCT_MAX, LOGIN_WINDOW_SEC),
  ]);
  if (!ipState.ok || !acctState.ok) {
    log.warn(
      { kind, ipLocked: !ipState.ok, acctLocked: !acctState.ok },
      "auth lockout: too many failed sign-in attempts",
    );
    throw new Error("ACCOUNT_TEMPORARILY_LOCKED: too many failed attempts, try again later");
  }
}

/** Record one failed credential attempt against both the IP and account windows. */
async function recordLoginFailure(
  request: Request | undefined,
  kind: string,
  identifier: string,
): Promise<void> {
  const { ipKey, acctKey } = loginKeys(request, kind, identifier);
  await Promise.all([
    rateLimit(ipKey, LOGIN_IP_MAX, LOGIN_WINDOW_SEC),
    rateLimit(acctKey, LOGIN_ACCT_MAX, LOGIN_WINDOW_SEC),
  ]);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  // We run behind CloudFront + ALB (and Vercel/Fly in other envs), all trusted
  // reverse proxies that set X-Forwarded-Host / X-Forwarded-Proto. trustHost
  // makes Auth.js derive the callback origin from those forwarded headers so
  // links/callbacks resolve to the public origin, not the internal ALB host.
  // When AUTH_URL is set it takes precedence over the forwarded host (canonical
  // origin, e.g. https://shezmin.com); Auth.js reads AUTH_URL from the env
  // automatically. Locally neither is needed, so dev still works out of the box.
  trustHost: true,
  providers: [
    Credentials({
      id: "phone-otp",
      name: "Phone OTP",
      credentials: { phone: {}, code: {} },
      authorize: async (creds, request) => {
        const parsed = phoneSchema.safeParse(creds);
        if (!parsed.success) return null;
        const { phone, code } = parsed.data;

        // Reject up front if this IP or phone is already locked out.
        await assertNotLockedOut(request, "otp", phone);

        // Validate the code through the Twilio provider: real Twilio Verify when
        // configured, or the dev OtpCode-table fallback otherwise. checkOtp
        // owns per-code attempt/expiry/single-use; the IP+account lockout here
        // is the outer brute-force guard.
        const ok = await checkOtp(phone, code);
        if (!ok) {
          await recordLoginFailure(request, "otp", phone);
          return null;
        }

        const user = await prisma.user.upsert({
          where: { phone },
          update: { phoneVerified: new Date() },
          create: { phone, phoneVerified: new Date(), role: "SELLER" },
        });

        return { id: user.id, name: user.name ?? null, email: user.email ?? null };
      },
    }),
    Credentials({
      id: "email-password",
      name: "Email",
      credentials: { email: {}, password: {} },
      authorize: async (creds, request) => {
        const parsed = emailSchema.safeParse(creds);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const identifier = email.toLowerCase();

        // Reject up front if this IP or account is already locked out.
        await assertNotLockedOut(request, "pw", identifier);

        const account = await prisma.account.findFirst({
          where: { provider: "credentials", providerAccountId: email },
          include: { user: true },
        });
        if (!account?.access_token) {
          await recordLoginFailure(request, "pw", identifier);
          return null;
        }

        const ok = await bcrypt.compare(password, account.access_token);
        if (!ok) {
          await recordLoginFailure(request, "pw", identifier);
          return null;
        }

        return {
          id: account.user.id,
          email: account.user.email,
          name: account.user.name ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (dbUser) {
          token.sub = dbUser.id;
          token.role = dbUser.role;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.sub) session.user.id = token.sub;
      if (token?.role) session.user.role = token.role as UserRole;
      return session;
    },
  },
});

export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("UNAUTHENTICATED");
  return session.user;
}

export async function requireRole(roles: UserRole | UserRole[]) {
  const user = await requireUser();
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(user.role)) throw new Error("FORBIDDEN");
  return user;
}
