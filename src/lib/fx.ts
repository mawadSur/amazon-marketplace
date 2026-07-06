// Pure FX helpers — NO server imports (no env, no prisma, no SDKs), so currency
// formatting in client components never drags server-only code into the browser
// bundle. The static rate is a stub; swap for a live FX provider later.

export const FX_USD_TO_INR = 83.5;

export function usdCentsToInrPaise(usdCents: number): number {
  return Math.round(usdCents * FX_USD_TO_INR);
}

export function inrPaiseToUsdCents(inrPaise: number): number {
  return Math.round(inrPaise / FX_USD_TO_INR);
}

/**
 * Convert USD cents to INR paise using an explicit FX rate — typically the rate
 * snapshotted onto the Order at placement (Order.fxRate) so payouts settle at
 * the rate the buyer was quoted, not today's static rate. Falls back to the
 * static rate for a missing/invalid input.
 */
export function usdCentsToInrPaiseAt(usdCents: number, fxRate?: number | null): number {
  const rate = typeof fxRate === "number" && Number.isFinite(fxRate) && fxRate > 0 ? fxRate : FX_USD_TO_INR;
  return Math.round(usdCents * rate);
}

/** Inverse of {@link usdCentsToInrPaiseAt} using an explicit FX rate. */
export function inrPaiseToUsdCentsAt(inrPaise: number, fxRate?: number | null): number {
  const rate = typeof fxRate === "number" && Number.isFinite(fxRate) && fxRate > 0 ? fxRate : FX_USD_TO_INR;
  return Math.round(inrPaise / rate);
}
