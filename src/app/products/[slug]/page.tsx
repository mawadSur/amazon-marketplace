// /products/[slug] — Amazon-style 3-column product detail page.
// Left: gallery. Center: title, rating, price, description, about-shop.
// Right: sticky buy-box with quantity, Buy Now, Add to Cart, trust badges.
// Full-width customer reviews block below.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  RotateCcw,
  Shield,
  Star,
  Store,
  Truck,
} from "lucide-react";
import { MarketplaceNav } from "@/components/buyer/marketplace-nav";
import { ProductGallery } from "@/components/buyer/product-gallery";
import { AddToCartButton } from "@/components/buyer/add-to-cart-button";
import { WishlistToggle } from "@/components/buyer/wishlist-toggle";
import { ReviewForm } from "@/components/buyer/review-form";
import {
  getProductBySlug,
  getFrequentlyBoughtTogether,
  getRelatedProducts,
} from "@/lib/catalog";
import {
  RelatedProductsRail,
  FrequentlyBoughtTogether,
} from "@/components/buyer/related-products-rail";
import { isWishlisted } from "@/lib/wishlist";
import { auth } from "@/lib/auth";
import { formatRating } from "@/lib/format";
import { effectiveTier } from "@/lib/tiers";
import { TierBadge } from "@/components/safety/tier-badge";

export const dynamic = "force-dynamic";

const SITE = "https://shezmin.com";

// Plain-text, single-line summary of a product for meta tags / structured data.
function metaDescription(title: string, description: string | null, shopName: string): string {
  const raw = (description ?? "")
    .replace(/\s*[-*•]\s+/g, " ") // flatten bullet markers
    .replace(/\s+/g, " ")
    .trim();
  const base = raw || `${title} — hand-picked from ${shopName}, direct from India on Shezmin.`;
  return base.length > 160 ? `${base.slice(0, 157).trimEnd()}…` : base;
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const product = await getProductBySlug(slug);
  if (!product || product.status !== "PUBLISHED" || product.shop.status !== "APPROVED") {
    return { title: "Product not found" };
  }
  const description = metaDescription(product.title, product.description, product.shop.name);
  const image = product.images[0]?.url;
  const canonical = `/products/${product.slug}`;
  return {
    title: product.title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: product.title,
      description,
      url: canonical,
      siteName: "Shezmin",
      images: image ? [{ url: image, alt: product.title }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: product.title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

function formatDeliveryDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function splitPrice(cents: number): { dollars: string; cents: string } {
  const whole = Math.floor(cents / 100);
  const rem = cents % 100;
  return {
    dollars: whole.toLocaleString("en-US"),
    cents: rem.toString().padStart(2, "0"),
  };
}

export default async function ProductPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();
  if (product.status !== "PUBLISHED" || product.shop.status !== "APPROVED") notFound();

  const session = await auth();
  const isAuthed = !!session?.user?.id;
  const isBuyer = session?.user?.role === "BUYER";

  let wishlisted = false;
  if (isAuthed) {
    wishlisted = await isWishlisted(session.user.id, product.id);
  }

  const [fbtProducts, relatedProducts] = await Promise.all([
    getFrequentlyBoughtTogether({
      productId: product.id,
      shopId: product.shopId,
      limit: 2,
    }),
    getRelatedProducts({
      productId: product.id,
      categoryId: product.categoryId,
      shopId: product.shopId,
      priceUsdCents: product.priceUsdCents,
      limit: 8,
    }),
  ]);

  const { dollars, cents } = splitPrice(product.priceUsdCents);
  const deliveryDate = formatDeliveryDate(9);
  const inStock = product.inventory > 0;
  const lowStock = product.inventory > 0 && product.inventory < 5;
  const ratingValue = product.ratingAvg ?? 0;
  const filledStars = Math.round(ratingValue);
  const categoryName = product.category?.name ?? "All";

  // Product/Offer structured data for rich results (Google Merchant / SEO).
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: metaDescription(product.title, product.description, product.shop.name),
    image: product.images.map((img) => img.url),
    sku: product.id,
    brand: { "@type": "Brand", name: product.shop.name },
    offers: {
      "@type": "Offer",
      priceCurrency: "USD",
      price: (product.priceUsdCents / 100).toFixed(2),
      availability: inStock
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
      url: `${SITE}/products/${product.slug}`,
    },
    ...(product.ratingCount > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: ratingValue.toFixed(1),
            reviewCount: product.ratingCount,
          },
        }
      : {}),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <MarketplaceNav />
      <main className="bg-background pb-12">
        <div className="mx-auto max-w-7xl px-4 py-3">
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Link href="/" className="amzn-link">Home</Link>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            <Link href="/shop" className="amzn-link">{categoryName}</Link>
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            <Link href={`/shop/${product.shop.slug}`} className="amzn-link truncate">{product.shop.name}</Link>
          </nav>

          <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[40%_36%_22%]">
            {/* Col 1: Gallery */}
            <section aria-label="Product images">
              <ProductGallery
                images={product.images}
                title={product.title}
                video={
                  product.avatarVideoStatus === "READY" && product.avatarVideoUrl
                    ? { url: product.avatarVideoUrl, poster: product.avatarVideoPoster }
                    : null
                }
              />
            </section>

            {/* Col 2: Details */}
            <section aria-label="Product details" className="min-w-0 space-y-3">
              <h1 className="font-display text-3xl font-semibold leading-tight text-foreground">
                {product.title}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/shop/${product.shop.slug}`}
                  className="text-sm text-accent hover:text-destructive hover:underline"
                >
                  Visit the {product.shop.name} Store
                </Link>
                <TierBadge tier={effectiveTier(product.shop)} />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StarRow value={filledStars} size="h-4 w-4" ariaLabel={`Average rating ${formatRating(product.ratingAvg)} out of 5`} />
                <Link href="#reviews" className="amzn-link text-sm">{formatRating(product.ratingAvg)} ({product.ratingCount} ratings)</Link>
              </div>

              <hr className="border-border" />

              <div className="space-y-1">
                <p className="text-3xl font-medium tabular-nums text-foreground">
                  <span className="align-top text-base">$</span>
                  {dollars}
                  <sup className="ml-0.5 text-base font-medium">{cents}</sup>
                </p>
                <p className="text-xs text-muted-foreground">
                  Inclusive of all taxes
                </p>
              </div>

              <hr className="border-border" />

              {product.description ? (
                <div className="space-y-2">
                  <h2 className="text-sm font-bold text-foreground">About this item</h2>
                  {renderDescription(product.description)}
                </div>
              ) : null}
              {product.shop.bio ? (
                <div className="space-y-1 pt-2">
                  <p className="text-sm leading-relaxed text-foreground">{product.shop.bio}</p>
                  <Link href={`/shop/${product.shop.slug}`} className="amzn-link text-sm">Read more about {product.shop.name}</Link>
                </div>
              ) : null}
            </section>

            {/* Col 3: Buy box */}
            <aside aria-label="Buy box" className="lg:sticky lg:top-[110px] lg:self-start">
              <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
                <p className="text-2xl font-medium tabular-nums text-foreground">
                  <span className="align-top text-sm">$</span>
                  {dollars}
                  <sup className="ml-0.5 text-sm font-medium">{cents}</sup>
                </p>
                <p className="text-sm text-foreground">
                  FREE delivery{" "}
                  <span className="font-bold">{deliveryDate}</span>
                </p>
                {inStock ? (
                  <p className="text-sm font-medium text-green-700">In Stock</p>
                ) : (
                  <p className="text-sm font-medium text-destructive">
                    Currently out of stock
                  </p>
                )}
                {lowStock ? (
                  <p className="text-xs text-destructive">
                    Only {product.inventory} left in stock.
                  </p>
                ) : null}

                <div>
                  <label htmlFor="buy-qty" className="block text-xs font-medium text-foreground">Quantity:</label>
                  <select id="buy-qty" name="qty" defaultValue={1} className="mt-1 h-9 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring">
                    {Array.from({ length: Math.min(10, Math.max(1, product.inventory)) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <AddToCartButton productId={product.id} isAuthed={isAuthed} variant="yellow" label="Buy Now" buyNow />
                <AddToCartButton productId={product.id} isAuthed={isAuthed} variant="orange" />
                <div className="pt-1">
                  <WishlistToggle productId={product.id} isAuthed={isAuthed} initialWishlisted={wishlisted} />
                </div>

                <ul className="space-y-1.5 border-t border-border pt-3 text-xs">
                  {[
                    { Icon: Shield, label: "Secure transaction" },
                    { Icon: Truck, label: "Ships from Shezmin" },
                    { Icon: Store, label: `Sold by ${product.shop.name}` },
                    { Icon: RotateCcw, label: "14-day returns" },
                  ].map(({ Icon, label }) => (
                    <li key={label} className="flex items-start gap-2 text-foreground">
                      <Icon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <span>{label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          </div>

          <FrequentlyBoughtTogether
            primary={{
              slug: product.slug,
              title: product.title,
              priceUsdCents: product.priceUsdCents,
              image: product.images[0]?.url ?? null,
            }}
            others={fbtProducts}
          />

          <RelatedProductsRail
            heading="Customers who viewed this also viewed"
            products={relatedProducts}
          />

          {/* Customer reviews */}
          <section id="reviews" className="mt-12 space-y-4 border-t border-border pt-8">
            <h2 className="font-display text-2xl font-semibold text-foreground">Customer reviews</h2>
            <div className="flex items-center gap-3">
              <StarRow value={filledStars} size="h-5 w-5" />
              <p className="text-sm text-foreground"><span className="font-medium">{formatRating(product.ratingAvg)}</span> out of 5</p>
              <p className="text-sm text-muted-foreground">{product.ratingCount} global rating{product.ratingCount === 1 ? "" : "s"}</p>
            </div>
            <ReviewForm productId={product.id} isAuthed={isAuthed} isBuyer={isBuyer} />
            <ul className="space-y-4">
              {product.reviews.map((r) => (
                <li key={r.id} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                  <p className="text-sm font-medium text-foreground">{r.buyer.name ?? "Anonymous buyer"}</p>
                  <div className="mt-1">
                    <StarRow value={r.rating} size="h-4 w-4" ariaLabel={`${r.rating} out of 5 stars`} />
                  </div>
                  {r.body ? (
                    <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-foreground">{r.body}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString()}</p>
                </li>
              ))}
              {product.reviews.length === 0 ? (
                <li className="text-sm text-muted-foreground">No reviews yet — be the first.</li>
              ) : null}
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}

function StarRow({
  value,
  size,
  ariaLabel,
}: {
  value: number;
  size: string;
  ariaLabel?: string;
}) {
  return (
    <span aria-label={ariaLabel} className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`${size} fill-current ${
            n <= value ? "amzn-star" : "text-border"
          }`}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}

function renderDescription(description: string) {
  // Detect bullet-style descriptions (lines starting with -, *, or •).
  const lines = description.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const bullets = lines.filter((l) => /^\s*[-*•]\s+/.test(l));
  if (bullets.length >= 2 && bullets.length === lines.length) {
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground">
        {bullets.map((l, i) => (
          <li key={i}>{l.replace(/^\s*[-*•]\s+/, "")}</li>
        ))}
      </ul>
    );
  }
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
      {description}
    </p>
  );
}
