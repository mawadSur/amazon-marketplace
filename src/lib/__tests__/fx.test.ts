import { describe, expect, it } from "vitest";
import {
  FX_USD_TO_INR,
  usdCentsToInrPaise,
  inrPaiseToUsdCents,
  usdCentsToInrPaiseAt,
  inrPaiseToUsdCentsAt,
} from "@/lib/fx";

describe("usdCentsToInrPaise (static rate)", () => {
  it("multiplies USD cents by the static rate and rounds", () => {
    // 10000 cents ($100) × 83.5 = 835,000 paise
    expect(usdCentsToInrPaise(10_000)).toBe(835_000);
    expect(usdCentsToInrPaise(0)).toBe(0);
  });

  it("rounds to the nearest whole paise", () => {
    // 1 cent × 83.5 = 83.5 → 84 (round-half-up)
    expect(usdCentsToInrPaise(1)).toBe(84);
    // 3 cents × 83.5 = 250.5 → 251
    expect(usdCentsToInrPaise(3)).toBe(251);
  });
});

describe("inrPaiseToUsdCents (static rate)", () => {
  it("divides paise by the static rate and rounds", () => {
    expect(inrPaiseToUsdCents(835_000)).toBe(10_000);
    expect(inrPaiseToUsdCents(0)).toBe(0);
  });
});

describe("usd<->inr round-trip", () => {
  it("returns to (approximately) the original cents within a 1-cent rounding tolerance", () => {
    for (const cents of [1, 99, 100, 999, 5_000, 12_345, 99_999, 1_000_000]) {
      const back = inrPaiseToUsdCents(usdCentsToInrPaise(cents));
      expect(Math.abs(back - cents)).toBeLessThanOrEqual(1);
    }
  });

  it("is exact for cents that convert to a whole number of paise at the static rate", () => {
    // Any cents value where cents×83.5 is integral round-trips exactly.
    expect(inrPaiseToUsdCents(usdCentsToInrPaise(10_000))).toBe(10_000);
    expect(inrPaiseToUsdCents(usdCentsToInrPaise(20_000))).toBe(20_000);
  });
});

describe("usdCentsToInrPaiseAt (explicit rate)", () => {
  it("uses the provided rate when it is a positive finite number", () => {
    // Order.fxRate snapshot at placement — settle at the quoted rate, not today's.
    expect(usdCentsToInrPaiseAt(10_000, 90)).toBe(900_000);
    expect(usdCentsToInrPaiseAt(10_000, 80)).toBe(800_000);
  });

  it("falls back to the static rate for a missing/invalid rate", () => {
    const expected = usdCentsToInrPaise(10_000); // 835,000 at FX_USD_TO_INR
    expect(usdCentsToInrPaiseAt(10_000, null)).toBe(expected);
    expect(usdCentsToInrPaiseAt(10_000, undefined)).toBe(expected);
    expect(usdCentsToInrPaiseAt(10_000, 0)).toBe(expected);
    expect(usdCentsToInrPaiseAt(10_000, -5)).toBe(expected);
    expect(usdCentsToInrPaiseAt(10_000, Number.NaN)).toBe(expected);
    expect(usdCentsToInrPaiseAt(10_000, Number.POSITIVE_INFINITY)).toBe(expected);
  });
});

describe("inrPaiseToUsdCentsAt (explicit rate)", () => {
  it("is the inverse of usdCentsToInrPaiseAt at the same rate (within rounding)", () => {
    const rate = 90;
    const paise = usdCentsToInrPaiseAt(12_345, rate);
    expect(Math.abs(inrPaiseToUsdCentsAt(paise, rate) - 12_345)).toBeLessThanOrEqual(1);
  });

  it("falls back to the static rate for a missing/invalid rate", () => {
    const expected = inrPaiseToUsdCents(835_000);
    expect(inrPaiseToUsdCentsAt(835_000, null)).toBe(expected);
    expect(inrPaiseToUsdCentsAt(835_000, -1)).toBe(expected);
    expect(inrPaiseToUsdCentsAt(835_000, Number.NaN)).toBe(expected);
  });
});

describe("FX_USD_TO_INR", () => {
  it("is a positive finite constant", () => {
    expect(Number.isFinite(FX_USD_TO_INR)).toBe(true);
    expect(FX_USD_TO_INR).toBeGreaterThan(0);
  });
});
