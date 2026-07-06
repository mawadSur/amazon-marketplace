import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared, hoisted mock handles so the vi.mock factories (hoisted above imports)
// can reference them. We keep the REAL @/lib/auth and @/lib/onboarding modules
// and only mock their leaf dependencies (DB, next-auth, rate-limit, etc.).
const h = vi.hoisted(() => ({
  // captured NextAuth(config) so we can reach the credentials providers
  capturedConfig: { value: undefined as any },
  authFn: vi.fn(),
  // prisma seams
  accountFindFirst: vi.fn(),
  shopFindUnique: vi.fn(),
  shopKycUpsert: vi.fn(),
  // bcrypt / kyc provider
  compare: vi.fn(),
  verifyKyc: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: any) => {
    h.capturedConfig.value = config;
    return { handlers: {}, auth: h.authFn, signIn: vi.fn(), signOut: vi.fn() };
  },
}));
// Credentials(config) normally builds a provider object; passing the config
// straight through lets the test read provider.authorize directly.
vi.mock("next-auth/providers/credentials", () => ({ default: (config: any) => config }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));

vi.mock("@/lib/db", () => ({
  prisma: {
    account: { findFirst: h.accountFindFirst },
    shop: { findUnique: h.shopFindUnique },
    shopKyc: { upsert: h.shopKycUpsert },
    user: { upsert: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("bcryptjs", () => ({ default: { compare: h.compare } }));
vi.mock("@/lib/ratelimit", () => ({
  peekRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  rateLimit: vi.fn().mockResolvedValue({ ok: true }),
  clientKey: () => "test-key",
}));
vi.mock("@/lib/providers/twilio", () => ({ checkOtp: vi.fn() }));
vi.mock("@/lib/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// onboarding leaf deps
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/stubs", () => ({
  verifyKyc: h.verifyKyc,
  razorpayCreateFundAccount: vi.fn(),
}));
vi.mock("@/lib/fraud", () => ({ runSignupChecks: vi.fn() }));
vi.mock("@/lib/badges", () => ({ applyBadgeNow: vi.fn() }));

// Real modules under test (importing @/lib/auth runs NextAuth -> captures config)
import "@/lib/auth";
import { submitKyc } from "@/lib/onboarding";

function emailAuthorize() {
  const providers = h.capturedConfig.value?.providers ?? [];
  const provider = providers.find((p: any) => p.id === "email-password");
  if (!provider) throw new Error("email-password provider not found");
  return provider.authorize as (
    creds: Record<string, unknown>,
    request: Request | undefined,
  ) => Promise<unknown>;
}

describe("auth email-password provider — case-insensitive account lookup", () => {
  beforeEach(() => {
    h.accountFindFirst.mockReset();
    h.compare.mockReset();
  });

  it("looks up the account by the LOWERCASED email so mixed-case login matches", async () => {
    // Account was stored at registration with a lowercased providerAccountId.
    h.accountFindFirst.mockResolvedValue({
      access_token: "hashed-password",
      user: { id: "u1", email: "user@example.com", name: null },
    });
    h.compare.mockResolvedValue(true);

    const authorize = emailAuthorize();
    const result = await authorize(
      { email: "User@Example.com", password: "hunter2hunter2" },
      undefined,
    );

    expect(h.accountFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "credentials",
          providerAccountId: "user@example.com",
        }),
      }),
    );
    expect(result).toMatchObject({ id: "u1", email: "user@example.com" });
  });

  it("returns null (and never crashes) when no account matches", async () => {
    h.accountFindFirst.mockResolvedValue(null);
    const authorize = emailAuthorize();
    const result = await authorize(
      { email: "nobody@example.com", password: "hunter2hunter2" },
      undefined,
    );
    expect(result).toBeNull();
  });
});

describe("submitKyc — GSTIN / PAN / Udyam format validation", () => {
  beforeEach(() => {
    h.authFn.mockReset();
    h.shopFindUnique.mockReset();
    h.shopKycUpsert.mockReset();
    h.verifyKyc.mockReset();

    h.authFn.mockResolvedValue({ user: { id: "u1", role: "SELLER" } });
    h.shopFindUnique.mockResolvedValue({ id: "s1" });
    h.shopKycUpsert.mockResolvedValue({});
    // Return unverified so the action returns a result instead of redirecting;
    // its being CALLED at all proves the input passed schema validation.
    h.verifyKyc.mockResolvedValue({ verified: false, reason: "pending" });
  });

  function fd(fields: Record<string, string>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return form;
  }

  it("accepts a valid PAN alone and proceeds to verification", async () => {
    const result = await submitKyc(fd({ panNumber: "ABCDE1234F" }));
    expect(h.verifyKyc).toHaveBeenCalledWith(
      expect.objectContaining({ panNumber: "ABCDE1234F" }),
    );
    // verifyKyc returned unverified, so the action reports that (not a schema error)
    expect(result).toEqual({ ok: false, error: "pending" });
  });

  it("accepts a valid 15-char GSTIN", async () => {
    await submitKyc(fd({ gstNumber: "22AAAAA0000A1Z5" }));
    expect(h.verifyKyc).toHaveBeenCalledWith(
      expect.objectContaining({ gstNumber: "22AAAAA0000A1Z5" }),
    );
  });

  it("accepts a valid Udyam number", async () => {
    await submitKyc(fd({ udyamNumber: "UDYAM-MH-12-1234567" }));
    expect(h.verifyKyc).toHaveBeenCalledWith(
      expect.objectContaining({ udyamNumber: "UDYAM-MH-12-1234567" }),
    );
  });

  it("rejects a malformed PAN and never calls the KYC provider", async () => {
    const result = await submitKyc(fd({ panNumber: "ABC123" }));
    expect(h.verifyKyc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.fieldErrors?.panNumber).toBeTruthy();
    }
  });

  it("rejects a malformed GSTIN and never calls the KYC provider", async () => {
    const result = await submitKyc(fd({ gstNumber: "NOT-A-GSTIN" }));
    expect(h.verifyKyc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.fieldErrors?.gstNumber).toBeTruthy();
    }
  });

  it("rejects a malformed Udyam number and never calls the KYC provider", async () => {
    const result = await submitKyc(fd({ udyamNumber: "UDYAM-1-2-3" }));
    expect(h.verifyKyc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.fieldErrors?.udyamNumber).toBeTruthy();
    }
  });

  it("still requires at least one identifier when all are empty", async () => {
    const result = await submitKyc(fd({}));
    expect(h.verifyKyc).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });
});
