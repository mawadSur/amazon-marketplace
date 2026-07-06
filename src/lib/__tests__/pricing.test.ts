import { describe, expect, it } from "vitest";
import { positionLabel, type PriceSuggestion } from "@/lib/pricing";

// positionLabel is the only pure, DB-free surface of pricing.ts. recommendPrice
// reads Prisma comparables + optionally calls Claude, so it belongs to the
// integration suite (see inventory-decrement.skip.test.ts for the DB-bound seam).
function suggestion(partial: Partial<PriceSuggestion>): PriceSuggestion {
  return {
    recommendedUsdCents: 6_000,
    marketLowUsdCents: 5_000,
    marketHighUsdCents: 8_000,
    sampleSize: 10,
    confidence: 6,
    rationale: "test",
    aiAssisted: false,
    ...partial,
  };
}

describe("positionLabel", () => {
  it("returns 'unknown' when there are fewer than 5 comparables", () => {
    expect(positionLabel(6_000, suggestion({ sampleSize: 4 }))).toBe("unknown");
    expect(positionLabel(6_000, suggestion({ sampleSize: 0 }))).toBe("unknown");
  });

  it("returns 'below' when the price is under the market low (p25)", () => {
    expect(positionLabel(4_000, suggestion({}))).toBe("below");
  });

  it("returns 'above' when the price is over the market high (p75)", () => {
    expect(positionLabel(9_000, suggestion({}))).toBe("above");
  });

  it("returns 'in_range' when the price sits within the band (inclusive of bounds)", () => {
    expect(positionLabel(6_000, suggestion({}))).toBe("in_range");
    // Boundaries are inclusive: not < low and not > high → in_range.
    expect(positionLabel(5_000, suggestion({}))).toBe("in_range");
    expect(positionLabel(8_000, suggestion({}))).toBe("in_range");
  });
});
