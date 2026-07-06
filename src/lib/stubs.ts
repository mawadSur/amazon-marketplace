// Dev stubs for external services. Agents should import these and route
// calls through them; swap real SDK calls in when keys are configured.
//
// Convention: every stub is a Promise-returning function whose shape matches
// what the real integration would return, so swapping later is a 1-file edit.

import { env } from "@/lib/env";
import { generateText } from "@/lib/ai";
import { buildKey, putObject, publicUrl } from "@/lib/storage";

// ---------------------------------------------------------------- Provider re-exports
//
// The external-integration stubs (OTP, KYC, RazorpayX payouts, Stripe,
// Shiprocket) now live in src/lib/providers/* so phase-2 owners can wire real
// SDK calls without touching this file. They are re-exported here so existing
// importers of "@/lib/stubs" keep working unchanged.

export { sendOtp } from "@/lib/providers/twilio"; // Module 1
export { verifyKyc } from "@/lib/providers/kyc"; // Module 1
export { razorpayCreateFundAccount, razorpayCreatePayout } from "@/lib/providers/razorpay"; // Module 1/4
export { stripeCreateCheckout, stripeRefund } from "@/lib/providers/stripe"; // Module 4
export { shiprocketCreateShipment } from "@/lib/providers/shiprocket"; // Module 5

// ---------------------------------------------------------------- Background removal (Module 2)

export type RemoveBackgroundInput = {
  imageUrl: string;
  shopId: string;
  productId: string;
};

/**
 * Remove an image's background. Real path POSTs to remove.bg and re-hosts the
 * resulting PNG to S3. Degrades to a sentinel URL when REMOVE_BG_API_KEY is
 * absent (dev/stub), mirroring the ANTHROPIC_API_KEY gating elsewhere.
 */
export async function removeBackground(
  input: RemoveBackgroundInput,
): Promise<{ outputUrl: string; source: "remove.bg" | "stub" }> {
  if (!env.REMOVE_BG_API_KEY) {
    return { outputUrl: input.imageUrl + "#bg-removed-stub", source: "stub" };
  }

  const form = new FormData();
  form.append("image_url", input.imageUrl);
  form.append("size", "auto");
  form.append("format", "png");

  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": env.REMOVE_BG_API_KEY },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`REMOVE_BG_FAILED: ${res.status} ${detail.slice(0, 200)}`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const key = buildKey({
    shopId: input.shopId,
    productId: input.productId,
    kind: "bg-removed",
    ext: "png",
  });
  try {
    await putObject(key, bytes, "image/png");
    return { outputUrl: publicUrl(key), source: "remove.bg" };
  } catch {
    // Storage not configured / no public base — fall back to the sentinel so the
    // pipeline still completes rather than wedging on an infra gap.
    return { outputUrl: input.imageUrl + "#bg-removed-stub", source: "stub" };
  }
}

// ---------------------------------------------------------------- Avatar try-on video (Module 2)

export type AvatarVideoInput = {
  /** Clean cutout (BG_REMOVED) URL preferred; falls back to ORIGINAL. */
  imageUrl: string;
  title: string;
  category: string; // textiles | jewelry | handicrafts
  attributes?: Record<string, unknown> | null;
  shopId: string;
  productId: string;
};

export type AvatarVideoOutput = {
  videoUrl: string;
  posterUrl: string | null;
  durationSeconds: number;
  costUsdMicros: number;
  source: "higgsfield" | "stub";
};

/** Build a garment-aware image→video prompt. Shared by the worker + seed script. */
export function buildAvatarPrompt(inp: {
  title: string;
  category: string;
  attributes?: Record<string, unknown> | null;
}): string {
  const material =
    (inp.attributes && typeof inp.attributes.material === "string"
      ? (inp.attributes.material as string)
      : "") || "";
  const t = `${inp.title} ${material}`.toLowerCase();
  if (inp.category === "jewelry" || /necklace|earring|ring|bangle|jhumka|pendant/.test(t)) {
    return `Close-up of a South Asian model elegantly wearing this ${inp.title}, slow gentle rotation showing the detail and sparkle, soft studio lighting, neutral seamless background, photorealistic, no text, no logos, 4-6 seconds.`;
  }
  const garment = /saree|sari/.test(t)
    ? "saree"
    : /lehenga/.test(t)
      ? "lehenga"
      : /kurta|suit/.test(t)
        ? "outfit"
        : "garment";
  return `A South Asian fashion model wearing this ${inp.title} ${garment}, full-body, a gentle natural turn to show the drape and fabric movement, soft studio lighting, neutral seamless background, photorealistic, elegant, no text, no logos, 4-6 seconds.`;
}

const HIGGSFIELD_API_BASE = "https://platform.higgsfield.ai/v1";
const AVATAR_POLL_INTERVAL_MS = 5_000;
const AVATAR_POLL_MAX_ATTEMPTS = 60; // ~5 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a short avatar try-on video via Higgsfield (image→video) and re-host
 * the result to our S3. Degrades to a sentinel when HIGGSFIELD_API_KEY is unset
 * (the worker then leaves avatarVideoStatus=NONE so the PDP shows images only).
 *
 * NOTE: the Higgsfield REST request/response shapes below follow their
 * image-to-video API; confirm field names against current docs when wiring a
 * live key. The no-key path keeps the app fully functional without it.
 */
export async function generateAvatarVideo(inp: AvatarVideoInput): Promise<AvatarVideoOutput> {
  if (!env.HIGGSFIELD_API_KEY) {
    return {
      videoUrl: inp.imageUrl + "#avatar-video-stub",
      posterUrl: inp.imageUrl,
      durationSeconds: 0,
      costUsdMicros: 0,
      source: "stub",
    };
  }

  const prompt = buildAvatarPrompt(inp);
  const auth = { Authorization: `Bearer ${env.HIGGSFIELD_API_KEY}` };

  // 1) Submit the image→video job.
  const submitRes = await fetch(`${HIGGSFIELD_API_BASE}/image2video`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ image_url: inp.imageUrl, prompt, duration: 5 }),
  });
  if (!submitRes.ok) {
    throw new Error(`HIGGSFIELD_SUBMIT_FAILED: ${submitRes.status}`);
  }
  const submitJson = (await submitRes.json()) as { id?: string; job_id?: string };
  const jobId = submitJson.id ?? submitJson.job_id;
  if (!jobId) throw new Error("HIGGSFIELD_NO_JOB_ID");

  // 2) Poll until completion (bounded).
  let videoSrc: string | null = null;
  for (let i = 0; i < AVATAR_POLL_MAX_ATTEMPTS; i++) {
    await sleep(AVATAR_POLL_INTERVAL_MS);
    const statusRes = await fetch(`${HIGGSFIELD_API_BASE}/jobs/${jobId}`, { headers: auth });
    if (!statusRes.ok) continue;
    const statusJson = (await statusRes.json()) as {
      status?: string;
      result?: { url?: string; video_url?: string };
      error?: string;
    };
    const status = (statusJson.status ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded") {
      videoSrc = statusJson.result?.url ?? statusJson.result?.video_url ?? null;
      break;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`HIGGSFIELD_JOB_FAILED: ${statusJson.error ?? "unknown"}`);
    }
  }
  if (!videoSrc) throw new Error("HIGGSFIELD_TIMEOUT");

  // 3) Download + re-host to our S3 so we control the asset + CDN allowlist.
  const bytes = Buffer.from(await (await fetch(videoSrc)).arrayBuffer());
  const key = buildKey({ shopId: inp.shopId, productId: inp.productId, kind: "avatar-video", ext: "mp4" });
  await putObject(key, bytes, "video/mp4");

  return {
    videoUrl: publicUrl(key),
    posterUrl: inp.imageUrl,
    durationSeconds: 5,
    // Higgsfield bills in credits; record a rough estimate for cost telemetry.
    costUsdMicros: 250_000,
    source: "higgsfield",
  };
}

// ---------------------------------------------------------------- Claude-backed AI helpers (Module 2/3)

export async function aiGenerateDescription(inp: {
  sourceText: string;
  sourceLang: string;
  shopName: string;
  category: string;
}): Promise<{ title: string; description: string; tags: string[] }> {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      title: `${inp.category} from ${inp.shopName}`,
      description:
        inp.sourceText ||
        `Authentic ${inp.category} from ${inp.shopName}. Handcrafted with care.`,
      tags: [inp.category, "handmade", "india"],
    };
  }
  const sys = `You write US-English product listings for a marketplace of authentic Indian goods. Translate from the source language. Output JSON: {"title": string (<= 70 chars), "description": string (120-220 words, friendly, no superlatives, mention craft and provenance), "tags": string[] (3-6 lowercase, no spaces)}.`;
  const prompt = `Shop: ${inp.shopName}\nCategory: ${inp.category}\nSource (${inp.sourceLang}): ${inp.sourceText}\n\nReturn only the JSON.`;
  const { text } = await generateText({ system: sys, prompt, maxTokens: 800 });
  try {
    const parsed = JSON.parse(text);
    return {
      title: String(parsed.title),
      description: String(parsed.description),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    };
  } catch {
    return { title: inp.sourceText.slice(0, 70), description: inp.sourceText, tags: [inp.category] };
  }
}

export async function aiSuggestPrice(inp: {
  category: string;
  attributes?: Record<string, unknown>;
}): Promise<{ priceUsdCents: number; rationale: string }> {
  const benchmarks: Record<string, number> = {
    handicrafts: 4500,
    textiles: 6800,
    jewelry: 8900,
  };
  const cents = benchmarks[inp.category.toLowerCase()] ?? 5000;
  return { priceUsdCents: cents, rationale: `Stub benchmark for ${inp.category}.` };
}

export async function aiCategorize(inp: {
  title: string;
  description: string;
}): Promise<{ category: string; tags: string[] }> {
  const t = (inp.title + " " + inp.description).toLowerCase();
  const category = t.includes("saree") || t.includes("textile") || t.includes("fabric")
    ? "textiles"
    : t.includes("ring") || t.includes("necklace") || t.includes("earring") || t.includes("jewelry")
      ? "jewelry"
      : "handicrafts";
  return { category, tags: [category] };
}

// ---------------------------------------------------------------- FX (Module 4)

// FX helpers now live in the dependency-free src/lib/fx.ts so client components
// (via format.ts) don't pull this server module — and its env/prisma/SDK
// imports — into the browser bundle. Re-exported here for back-compat.
export { FX_USD_TO_INR, usdCentsToInrPaise, inrPaiseToUsdCents } from "@/lib/fx";
