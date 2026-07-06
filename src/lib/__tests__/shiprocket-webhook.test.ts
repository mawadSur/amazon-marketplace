// Unit tests for the Shiprocket tracking webhook (src/app/api/webhooks/shiprocket
// /route.ts) against MOCKED shipment helpers. Covers the three money-critical
// paths: fail-closed / signature-fail in production, happy-path DELIVERED (which
// releases held seller payouts via updateShipmentStatus), and idempotent replay
// (a re-sent DELIVERED must not double-fire — the route delegates that guarantee
// to updateShipmentStatus, which no-ops on an unchanged status).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env stand-in so each test can flip NODE_ENV + the webhook secret.
// Declared via vi.hoisted so it exists before the hoisted vi.mock factory runs.
const mockEnv = vi.hoisted(() => ({
  NODE_ENV: "production" as string,
  SHIPROCKET_WEBHOOK_SECRET: undefined as string | undefined,
  SHIPROCKET_PICKUP_LOCATION: "Primary",
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

vi.mock("@/lib/shipments", () => ({
  getShipmentByTrackingNumber: vi.fn(),
  updateShipmentStatus: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/log", () => {
  const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { log: { child: () => child, ...child } };
});

import { POST } from "@/app/api/webhooks/shiprocket/route";
import { getShipmentByTrackingNumber, updateShipmentStatus } from "@/lib/shipments";

const getShipment = getShipmentByTrackingNumber as unknown as ReturnType<typeof vi.fn>;
const updateStatus = updateShipmentStatus as unknown as ReturnType<typeof vi.fn>;

const SECRET = "shiprocket_secret_token";

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/webhooks/shiprocket", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockEnv.NODE_ENV = "production";
  mockEnv.SHIPROCKET_WEBHOOK_SECRET = SECRET;
  getShipment.mockResolvedValue({ id: "ship_1", status: "IN_TRANSIT" });
  updateStatus.mockResolvedValue({ id: "ship_1", status: "DELIVERED" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("shiprocket webhook — fail closed / auth", () => {
  it("returns 503 in production when the secret is unset (fail closed)", async () => {
    mockEnv.SHIPROCKET_WEBHOOK_SECRET = undefined;

    const res = await POST(makeReq({ awb: "AWB1", current_status: "Delivered" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "WEBHOOK_NOT_CONFIGURED" });
    // No money-touching side effects when unconfigured.
    expect(getShipment).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("rejects a request with a wrong/missing token (401) and never touches a shipment", async () => {
    const res = await POST(
      makeReq({ awb: "AWB1", current_status: "Delivered" }, { "x-api-key": "wrong" }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "BAD_SIGNATURE" });
    expect(updateStatus).not.toHaveBeenCalled();

    // Missing header entirely is also rejected.
    const res2 = await POST(makeReq({ awb: "AWB1", current_status: "Delivered" }));
    expect(res2.status).toBe(401);
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("shiprocket webhook — happy path DELIVERED", () => {
  it("maps Delivered → DELIVERED and calls updateShipmentStatus for the AWB's shipment", async () => {
    const res = await POST(
      makeReq({ awb: "AWB1", current_status: "Delivered" }, { "x-api-key": SECRET }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: "DELIVERED" });
    expect(getShipment).toHaveBeenCalledWith("AWB1");
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: "ship_1", status: "DELIVERED" }),
    );
  });

  it("does NOT mis-read 'RTO Delivered' as a real delivery — maps to RETURNED", async () => {
    const res = await POST(
      makeReq({ awb: "AWB1", current_status: "RTO Delivered" }, { "x-api-key": SECRET }),
    );

    expect(res.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "RETURNED" }),
    );
  });

  it("maps 'Undelivered' → EXCEPTION", async () => {
    await POST(
      makeReq({ awb: "AWB1", current_status: "Undelivered" }, { "x-api-key": SECRET }),
    );
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "EXCEPTION" }),
    );
  });

  it("returns 400 when the AWB is missing", async () => {
    const res = await POST(
      makeReq({ current_status: "Delivered" }, { "x-api-key": SECRET }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "MISSING_AWB" });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("acknowledges an unmapped status with 200 and applies nothing", async () => {
    const res = await POST(
      makeReq({ awb: "AWB1", current_status: "Pickup Scheduled" }, { "x-api-key": SECRET }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ignored: "Pickup Scheduled" });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("returns 404 when no shipment matches the AWB", async () => {
    getShipment.mockResolvedValue(null);
    const res = await POST(
      makeReq({ awb: "UNKNOWN", current_status: "Delivered" }, { "x-api-key": SECRET }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "SHIPMENT_NOT_FOUND" });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe("shiprocket webhook — idempotent replay", () => {
  it("a re-sent DELIVERED delegates to updateShipmentStatus each time (which no-ops on unchanged status), never erroring", async () => {
    // Second delivery of the same AWB — the shipment is already DELIVERED. The
    // route always forwards to updateShipmentStatus, which is the idempotency
    // point (early-return on unchanged status → no double payout release).
    getShipment.mockResolvedValue({ id: "ship_1", status: "DELIVERED" });
    updateStatus.mockResolvedValue({ id: "ship_1", status: "DELIVERED" });

    const first = await POST(
      makeReq({ awb: "AWB1", current_status: "Delivered" }, { "x-api-key": SECRET }),
    );
    const second = await POST(
      makeReq({ awb: "AWB1", current_status: "Delivered" }, { "x-api-key": SECRET }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both forwarded DELIVERED; the no-double-fire guarantee lives in
    // updateShipmentStatus (covered by its own tests / status guard).
    expect(updateStatus).toHaveBeenCalledTimes(2);
    for (const call of updateStatus.mock.calls) {
      expect(call[0]).toMatchObject({ shipmentId: "ship_1", status: "DELIVERED" });
    }
  });
});

describe("shiprocket webhook — dev mode", () => {
  it("processes unauthenticated in dev when no secret is set", async () => {
    mockEnv.NODE_ENV = "development";
    mockEnv.SHIPROCKET_WEBHOOK_SECRET = undefined;

    const res = await POST(makeReq({ awb: "AWB1", current_status: "Delivered" }));

    expect(res.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: "ship_1", status: "DELIVERED" }),
    );
  });
});
