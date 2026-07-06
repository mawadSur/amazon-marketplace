import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";

const BASE = "https://shezmin.com";

// Static, always-present public routes.
const STATIC_ROUTES = [
  "",
  "/shop",
  "/search",
  "/about",
  "/about/story",
  "/help/faq",
  "/legal/privacy",
  "/legal/terms",
  "/legal/returns",
  "/sign-in",
];

// Full sitemap: static routes + every published product, approved shop, and
// category. Catalog pages are force-dynamic, so this runs against a live DB;
// a query failure degrades gracefully to the static routes rather than 500ing.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => ({
    url: `${BASE}${r}`,
    changeFrequency: r === "" ? "daily" : "weekly",
    priority: r === "" ? 1 : 0.7,
  }));

  try {
    const [products, shops, categories] = await Promise.all([
      prisma.product.findMany({
        where: { status: "PUBLISHED", shop: { status: "APPROVED" } },
        select: { slug: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 5000,
      }),
      prisma.shop.findMany({
        where: { status: "APPROVED" },
        select: { slug: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 2000,
      }),
      prisma.category.findMany({ select: { slug: true } }),
    ]);

    for (const p of products) {
      entries.push({
        url: `${BASE}/products/${p.slug}`,
        lastModified: p.updatedAt,
        changeFrequency: "weekly",
        priority: 0.8,
      });
    }
    for (const s of shops) {
      entries.push({
        url: `${BASE}/shop/${s.slug}`,
        lastModified: s.updatedAt,
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }
    for (const c of categories) {
      entries.push({
        url: `${BASE}/shop/category/${c.slug}`,
        changeFrequency: "weekly",
        priority: 0.6,
      });
    }
  } catch {
    // DB unavailable (e.g. build-time introspection) — return static routes only.
  }

  return entries;
}
