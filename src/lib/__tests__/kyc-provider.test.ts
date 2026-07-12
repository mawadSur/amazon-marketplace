// Unit tests for the Signzy KYC provider (src/lib/providers/kyc.ts) against a
// MOCKED env + fetch. Covers the gating matrix (dev pass-through, prod fail-
// closed, legacy fallback) and the Signzy token-exchange + verify flow.
//
// The mocked-contract tests that verifyKyc is CALLED with { gstNumber, panNumber,
// udyamNumber } live in auth-onboarding.test.ts (which mocks @/lib/stubs); those
// stay green because this rewrite keeps the verifyKyc(KycInput) -> KycResult
// signature stable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env stand-in flipped per-test. Declared via vi.hoisted so it exists
// before the hoisted vi.mock factory runs.
const mockEnv = vi.hoisted(() => ({
  NODE_ENV: "test" as string,
  SIGNZY_BASE_URL: undefined as string | undefined,
  SIGNZY_USERNAME: undefined as string | undefined,
  SIGNZY_PASSWORD: undefined as string | undefined,
  SIGNZY_REALM: undefined as string | undefined,
  SIGNZY_LOGIN_PATH: "/api/backopsusers/login",
  SIGNZY_PAN_PATH: "/api/v3/getpandetails",
  SIGNZY_GSTIN_PATH: "/api/v3/gstin",
  SIGNZY_UDYAM_PATH: undefined as string | undefined,
  KYC_PROVIDER_API_KEY: undefined as string | undefined,
  KYC_PROVIDER_BASE_URL: undefined as string | undefined,
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return { log: { child: () => child, ...child } };
});

// Re-imported per-test (see beforeEach) so the module-level token cache resets.
let verifyKyc: (inp: {
  gstNumber?: string;
  panNumber?: string;
  udyamNumber?: string;
}) => Promise<{ verified: boolean; reason?: string }>;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route mocked fetch by URL substring so token exchange + verify can differ. */
function routeFetch(routes: Record<string, () => Response>): FetchImpl {
  return async (url: string) => {
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

function useSignzyCreds() {
  mockEnv.SIGNZY_BASE_URL = "https://gateway.signzy.example";
  mockEnv.SIGNZY_USERNAME = "user@shezmin.com";
  mockEnv.SIGNZY_PASSWORD = "s3cret";
}

beforeEach(async () => {
  mockEnv.NODE_ENV = "test";
  mockEnv.SIGNZY_BASE_URL = undefined;
  mockEnv.SIGNZY_USERNAME = undefined;
  mockEnv.SIGNZY_PASSWORD = undefined;
  mockEnv.SIGNZY_REALM = undefined;
  mockEnv.SIGNZY_UDYAM_PATH = undefined;
  mockEnv.KYC_PROVIDER_API_KEY = undefined;
  mockEnv.KYC_PROVIDER_BASE_URL = undefined;
  // Reset the module registry so the module-level token cache starts empty and
  // each test forces a fresh Signzy login.
  vi.resetModules();
  ({ verifyKyc } = await import("@/lib/providers/kyc"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyKyc — boundary validation", () => {
  it("rejects when no identifier is provided (before any provider call)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await verifyKyc({});
    expect(result.verified).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("verifyKyc — gating (no creds)", () => {
  it("dev pass-through: any non-empty identifier passes when unconfigured", async () => {
    mockEnv.NODE_ENV = "development";
    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result).toEqual({ verified: true });
  });

  it("prod fail-closed: throws when no provider is configured", async () => {
    mockEnv.NODE_ENV = "production";
    await expect(verifyKyc({ panNumber: "ABCDE1234F" })).rejects.toThrow(/Signzy is not configured/);
  });
});

describe("verifyKyc — Signzy flow", () => {
  it("exchanges creds for a token then verifies PAN (happy path)", async () => {
    useSignzyCreds();
    const fetchMock = vi.fn(
      routeFetch({
        "/api/backopsusers/login": () => jsonResponse({ id: "tok-123", userid: "u1" }),
        "/api/v3/getpandetails": () => jsonResponse({ result: { status: "VALID" } }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result).toEqual({ verified: true });

    // Login call sent username/password.
    const loginBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(loginBody).toMatchObject({ username: "user@shezmin.com", password: "s3cret" });
    // Verify call carried the token in the Authorization header.
    const verifyInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((verifyInit.headers as Record<string, string>).Authorization).toBe("tok-123");
    expect(JSON.parse(verifyInit.body as string)).toEqual({ pan: "ABCDE1234F" });
  });

  it("rejects (fail-closed) when Signzy reports an invalid identifier", async () => {
    useSignzyCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routeFetch({
          "/login": () => jsonResponse({ id: "tok", userid: "u1" }),
          "/gstin": () => jsonResponse({ result: { valid: false, message: "GSTIN not found" } }),
        }),
      ),
    );
    const result = await verifyKyc({ gstNumber: "22AAAAA0000A1Z5" });
    expect(result).toEqual({ verified: false, reason: "GSTIN not found" });
  });

  it("verified only when every provided identifier passes", async () => {
    useSignzyCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routeFetch({
          "/login": () => jsonResponse({ id: "tok", userid: "u1" }),
          "/getpandetails": () => jsonResponse({ verified: true }),
          "/gstin": () => jsonResponse({ status: "INVALID" }),
        }),
      ),
    );
    const result = await verifyKyc({ panNumber: "ABCDE1234F", gstNumber: "22AAAAA0000A1Z5" });
    expect(result.verified).toBe(false);
  });

  it("returns unavailable (never throws) when Signzy login fails", async () => {
    useSignzyCreds();
    vi.stubGlobal("fetch", vi.fn(routeFetch({ "/login": () => jsonResponse({}, 500) })));
    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/temporarily unavailable/);
  });

  it("does NOT fail-open on a bare transport-level status:'success'", async () => {
    // 'success'/'yes' are request-processed markers, not identifier verdicts.
    // Treating them as verified would be a fail-OPEN KYC bypass.
    useSignzyCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routeFetch({
          "/login": () => jsonResponse({ id: "tok", userid: "u1" }),
          "/getpandetails": () => jsonResponse({ status: "success" }),
        }),
      ),
    );
    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result.verified).toBe(false);
  });

  it("clears the cached token and re-authenticates once on a 401 verify", async () => {
    useSignzyCreds();
    let loginCalls = 0;
    let verifyCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url.includes("/login")) {
        loginCalls += 1;
        return jsonResponse({ id: `tok-${loginCalls}`, userid: "u1" });
      }
      if (url.includes("/getpandetails")) {
        verifyCalls += 1;
        // First verify: cached token rejected (revoked/expired early). Retry: OK.
        return verifyCalls === 1
          ? jsonResponse({}, 401)
          : jsonResponse({ result: { status: "VALID" } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result).toEqual({ verified: true });
    expect(loginCalls).toBe(2); // re-authenticated after clearing the cache
    expect(verifyCalls).toBe(2); // one retry only
    // The retried verify carried the FRESH token, not the stale one.
    const lastVerify = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    expect((lastVerify.headers as Record<string, string>).Authorization).toBe("tok-2");
  });

  it("retries at most once on repeated 401s (no infinite loop, fails closed)", async () => {
    useSignzyCreds();
    let verifyCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/login")) return jsonResponse({ id: "tok", userid: "u1" });
      if (url.includes("/getpandetails")) {
        verifyCalls += 1;
        return jsonResponse({}, 401);
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/401/);
    expect(verifyCalls).toBe(2); // original + exactly one retry
  });

  it("Udyam-only with no Udyam endpoint asks for PAN/GST instead of passing", async () => {
    useSignzyCreds();
    // No fetch expected — the guard returns before any network call.
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("should not fetch"); }));
    const result = await verifyKyc({ udyamNumber: "UDYAM-MH-12-1234567" });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/Udyam/);
  });
});

describe("verifyKyc — legacy fallback", () => {
  it("uses the legacy generic endpoint when only KYC_PROVIDER_* are set", async () => {
    mockEnv.KYC_PROVIDER_API_KEY = "legacy-key";
    mockEnv.KYC_PROVIDER_BASE_URL = "https://legacy.example";
    const fetchMock = vi.fn(routeFetch({ "/kyc/verify": () => jsonResponse({ verified: true }) }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyKyc({ panNumber: "ABCDE1234F" });
    expect(result).toEqual({ verified: true });
    expect((fetchMock.mock.calls[0][0] as string)).toContain("https://legacy.example/kyc/verify");
  });
});
