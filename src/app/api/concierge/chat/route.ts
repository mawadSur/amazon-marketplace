// POST /api/concierge/chat — stateless multi-turn concierge endpoint.
//
// Body: { priorIntent: SearchIntent | null, utterance: string, history: ConciergeTurn[] }
// Returns: { intent, chips, results, assistantReply, reset, suggestion? }
//
// Conversation history is held client-side (sessionStorage) and replayed here,
// so the endpoint stays stateless and horizontally scalable.

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { rateLimit, clientKey, rateLimitHeaders } from "@/lib/ratelimit";
import {
  parseIntent,
  refineIntent,
  emptyIntent,
  removableChips,
  removeFacet,
  coerceIntent,
  relaxationSuggestion,
  type SearchIntent,
  type ConciergeTurn,
  type RemovableFacet,
} from "@/lib/concierge";
import { searchWithIntent } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const turnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(500),
});

const removeSchema = z.object({
  facet: z.enum(["category", "region", "priceMax", "priceMin", "context", "keyword"]),
  value: z.string().max(120),
});

const bodySchema = z.object({
  priorIntent: z.unknown().nullable().optional(),
  utterance: z.string().trim().max(200).optional(),
  remove: removeSchema.optional(),
  history: z.array(turnSchema).max(20).optional(),
});

type CardResult = {
  id: string;
  slug: string;
  title: string;
  priceUsdCents: number;
  images: { url: string }[];
  shop: {
    name: string;
    slug: string;
    region: string | null;
    badge: string | null;
    trustScore: number | null;
    manualTier: string | null;
  };
};

function toCards(rows: Awaited<ReturnType<typeof searchWithIntent>>): CardResult[] {
  return rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    priceUsdCents: p.priceUsdCents,
    images: p.images,
    shop: {
      name: p.shop.name,
      slug: p.shop.slug,
      region: p.shop.region ?? null,
      badge: (p.shop as { badge?: string | null }).badge ?? null,
      trustScore: (p.shop as { trustScore?: number | null }).trustScore ?? null,
      manualTier: (p.shop as { manualTier?: string | null }).manualTier ?? null,
    },
  }));
}

export async function POST(req: Request) {
  // The utterance path calls the Anthropic-backed intent parser, so an
  // unauthenticated caller can amplify LLM spend. Cap anonymous traffic hard
  // and key per-IP; signed-in users are trusted with a higher, per-user ceiling.
  const session = await auth();
  const userId = session?.user?.id ?? null;
  const { limit, windowSeconds } = userId
    ? { limit: 40, windowSeconds: 60 }
    : { limit: 6, windowSeconds: 60 };
  const rl = await rateLimit(clientKey(req, "concierge.chat", userId), limit, windowSeconds);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Slow down a moment." },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  }

  const prior = coerceIntent(parsed.data.priorIntent ?? null);
  const history: ConciergeTurn[] = parsed.data.history ?? [];
  const utterance = parsed.data.utterance?.trim();
  const remove = parsed.data.remove;

  if (!utterance && !remove && !prior) {
    return NextResponse.json({ error: "NOTHING_TO_DO" }, { status: 400 });
  }

  let refined: { intent: SearchIntent; assistantReply: string; reset: boolean };
  if (remove) {
    // Dismiss a single active filter — pure, no LLM.
    const intent = removeFacet(prior ?? emptyIntent(), remove.facet as RemovableFacet, remove.value);
    refined = { intent, assistantReply: "", reset: false };
  } else if (utterance) {
    // First turn (no prior intent + no history) → parse from scratch; else refine.
    const isFirstTurn = !prior && history.length === 0;
    refined = isFirstTurn
      ? { intent: await parseIntent(utterance), assistantReply: "", reset: false }
      : await refineIntent(prior ?? emptyIntent(), utterance, history);
  } else {
    // Re-run search against the existing intent (e.g. after a chip change).
    refined = { intent: prior ?? emptyIntent(), assistantReply: "", reset: false };
  }

  const intent = refined.intent;
  const rows = await searchWithIntent(intent);
  const chips = removableChips(intent);
  const results = toCards(rows);

  const assistantReply =
    refined.assistantReply ||
    (results.length > 0
      ? `Found ${results.length} match${results.length === 1 ? "" : "es"}.`
      : "I couldn't find a match.");

  const suggestion =
    results.length === 0 && !refined.reset ? relaxationSuggestion(chips) : null;

  return NextResponse.json({
    intent,
    chips,
    results,
    assistantReply,
    reset: refined.reset,
    suggestion,
  });
}
