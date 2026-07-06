import { describe, expect, it, vi, beforeEach } from "vitest";

// --- Mocks --------------------------------------------------------------
// prisma.$queryRaw drives the DB (hard) dependency.
const queryRaw = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    get $queryRaw() {
      return queryRaw;
    },
  },
}));

// env must expose a REDIS_URL so the ready route instantiates a client.
vi.mock("@/lib/env", () => ({
  env: { REDIS_URL: "redis://localhost:6379" },
}));

// Silence structured logging.
vi.mock("@/lib/log", () => ({
  log: { child: () => ({ error: vi.fn(), info: vi.fn() }) },
}));

// Mutable Redis mock behavior — a single singleton client is reused across the
// ready route's requests, so per-test tweaks to `ping` control the outcome.
const ping = vi.fn();
vi.mock("ioredis", () => {
  return {
    default: class MockRedis {
      status = "ready";
      on() {
        return this;
      }
      async connect() {
        this.status = "ready";
      }
      ping() {
        return ping();
      }
    },
  };
});

beforeEach(() => {
  queryRaw.mockReset();
  ping.mockReset();
});

describe("GET /api/health (liveness)", () => {
  it("returns 200 { status: 'ok' } without touching DB or Redis", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    // Liveness must never probe dependencies.
    expect(queryRaw).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready (readiness)", () => {
  it("returns 503 when the DB check fails (hard dependency)", async () => {
    queryRaw.mockRejectedValue(new Error("db down"));
    ping.mockResolvedValue("PONG");
    const { GET } = await import("@/app/api/health/ready/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.db).toBe(false);
    expect(body.status).toBe("unavailable");
  });

  it("returns 200 with redis:'degraded' when only Redis fails (soft dependency)", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    ping.mockRejectedValue(new Error("redis down"));
    const { GET } = await import("@/app/api/health/ready/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db).toBe(true);
    expect(body.redis).toBe("degraded");
    expect(body.status).toBe("ok");
  });

  it("returns 200 with redis:'ok' when both dependencies are healthy", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    ping.mockResolvedValue("PONG");
    const { GET } = await import("@/app/api/health/ready/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", db: true, redis: "ok" });
  });
});
