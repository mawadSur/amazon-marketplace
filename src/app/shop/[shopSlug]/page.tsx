// /shop/[shopSlug] — Amazon "brand store" feel. Breadcrumbs, hero banner,
// product grid, and a collapsible About section.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { MarketplaceNav } from "@/components/buyer/marketplace-nav";
import { ProductCard } from "@/components/buyer/product-card";
import { VerificationBadge } from "@/components/safety/verification-badge";
import { TrustScoreBadge } from "@/components/safety/trust-score-badge";
import { TierBadge } from "@/components/safety/tier-badge";
import { getShopBySlug, regionNameToSlug } from "@/lib/catalog";
import { effectiveTier } from "@/lib/tiers";
import { parseStoryScript } from "@/lib/story-video";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: {
  params: Promise<{ shopSlug: string }>;
}): Promise<Metadata> {
  const { shopSlug } = await props.params;
  const shop = await getShopBySlug(shopSlug);
  if (!shop) return { title: "Shop not found" };
  const description =
    shop.bio?.trim() ||
    `Shop ${shop.name} — a verified Shezmin boutique based in ${shop.city}, ${shop.region}.`;
  const canonical = `/shop/${shop.slug}`;
  const image = shop.bannerUrl ?? shop.logoUrl ?? undefined;
  return {
    title: shop.name,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: shop.name,
      description,
      url: canonical,
      siteName: "Shezmin",
      images: image ? [{ url: image, alt: `${shop.name} store` }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: shop.name,
      description,
      images: image ? [image] : undefined,
    },
  };
}

export default async function ShopPage(props: {
  params: Promise<{ shopSlug: string }>;
}) {
  const { shopSlug } = await props.params;
  const shop = await getShopBySlug(shopSlug);
  if (!shop) notFound();

  const script = parseStoryScript(shop.storyScript);
  const productCount = shop.products.length;

  return (
    <>
      <MarketplaceNav />
      <main className="bg-background">
        {/* Breadcrumb */}
        <div className="container mx-auto max-w-7xl px-4 pt-6">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <Link href="/" className="hover:text-accent hover:underline">
              Home
            </Link>
            <span className="px-1.5">›</span>
            <Link href="/shop" className="hover:text-accent hover:underline">
              Shops
            </Link>
            <span className="px-1.5">›</span>
            <span className="text-foreground">{shop.name}</span>
          </nav>
        </div>

        {/* Hero banner */}
        <section className="container mx-auto max-w-7xl px-4 pt-6 pb-6">
          <div className="grid gap-6 rounded-lg bg-muted p-6 ring-1 ring-border md:grid-cols-[auto_1fr] md:items-center md:p-10">
            <div className="flex flex-col items-start gap-4">
              {shop.logoUrl ? (
                <div className="h-20 w-20 overflow-hidden rounded-md border border-border bg-card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={shop.logoUrl}
                    alt={`${shop.name} logo`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
              ) : null}
              <div>
                <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                  {shop.name}
                </h1>
                <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                  <MapPin className="h-4 w-4" aria-hidden />
                  {shop.city},{" "}
                  <Link
                    href={`/shop/region/${regionNameToSlug(shop.region)}`}
                    className="text-accent hover:underline"
                  >
                    {shop.region}
                  </Link>
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <TierBadge tier={effectiveTier(shop)} />
                  <VerificationBadge value={shop.badge} hideIfNone />
                  <TrustScoreBadge score={shop.trustScore} />
                </div>
              </div>
            </div>
            <div className="text-sm leading-relaxed text-foreground">
              {shop.bio ? (
                <p className="max-w-2xl">{shop.bio}</p>
              ) : (
                <p className="max-w-2xl text-muted-foreground">
                  A verified Shezmin boutique based in {shop.city}, {shop.region}.
                </p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                <Link
                  href={`/shop/category/${shop.category}`}
                  className="text-accent hover:underline"
                >
                  {shop.category}
                </Link>{" "}
                · {productCount}{" "}
                {productCount === 1 ? "product" : "products"}
              </p>
            </div>
          </div>
        </section>

        {/* Products */}
        <section className="container mx-auto max-w-7xl px-4 pb-8">
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <h2 className="font-display text-xl font-bold tracking-tight">
                Products from {shop.name}
              </h2>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {productCount}
                </span>{" "}
                {productCount === 1 ? "result" : "results"}
              </p>
            </div>
            {productCount > 0 ? (
              <div className="mt-5 grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
                {shop.products.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={{
                      slug: p.slug,
                      title: p.title,
                      priceUsdCents: p.priceUsdCents,
                      images: p.images,
                      shop: {
                        name: shop.name,
                        slug: shop.slug,
                        region: shop.region,
                        badge: shop.badge,
                        trustScore: shop.trustScore,
                        manualTier: shop.manualTier,
                      },
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                This shop hasn&apos;t published any products yet.
              </p>
            )}
          </div>
        </section>

        {/* About the shop (collapsible) */}
        {script || shop.story ? (
          <section className="container mx-auto max-w-7xl px-4 pb-14">
            <details className="group rounded-lg border border-border bg-card" open>
              <summary className="flex cursor-pointer items-center justify-between p-5 font-display text-lg font-bold tracking-tight">
                <span>About {shop.name}</span>
                <span className="text-xs font-normal text-muted-foreground group-open:hidden">
                  Show
                </span>
                <span className="hidden text-xs font-normal text-muted-foreground group-open:inline">
                  Hide
                </span>
              </summary>
              <div className="border-t border-border p-5">
                {script && script.slides.length > 0 ? (
                  <>
                    {script.aiAssisted ? (
                      <p className="mb-3 text-xs text-muted-foreground">
                        AI-narrated · written from {shop.name}&apos;s own words
                      </p>
                    ) : null}
                    <div className="grid gap-4 sm:grid-cols-2">
                      {script.slides.map((slide, i) => {
                        if (slide.kind === "title") {
                          return (
                            <div
                              key={i}
                              className="rounded-md bg-muted p-5 text-center sm:col-span-2"
                            >
                              <p className="font-display text-lg font-semibold tracking-tight">
                                {slide.text}
                              </p>
                            </div>
                          );
                        }
                        if (slide.kind === "image") {
                          return (
                            <figure
                              key={i}
                              className="overflow-hidden rounded-md border border-border bg-muted"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={slide.imageUrl}
                                alt={slide.caption ?? `${shop.name} story image`}
                                loading="lazy"
                                className="h-44 w-full object-cover"
                              />
                              {slide.caption ? (
                                <figcaption className="px-3 py-2 text-xs text-muted-foreground">
                                  {slide.caption}
                                </figcaption>
                              ) : null}
                            </figure>
                          );
                        }
                        if (slide.kind === "products") {
                          return (
                            <p
                              key={i}
                              className="text-center text-sm font-medium text-muted-foreground sm:col-span-2"
                            >
                              {slide.text}
                            </p>
                          );
                        }
                        return (
                          <p
                            key={i}
                            className="text-sm leading-relaxed text-foreground"
                          >
                            {slide.text}
                          </p>
                        );
                      })}
                    </div>
                  </>
                ) : shop.story ? (
                  <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
                    {shop.story}
                  </p>
                ) : null}
              </div>
            </details>
          </section>
        ) : null}
      </main>
    </>
  );
}
