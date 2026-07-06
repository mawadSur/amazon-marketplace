// 404 — rendered inside the root layout (nav/footer + globals.css apply).
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="container mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center px-4 py-20 text-center">
      <p className="mirage-eyebrow">404</p>
      <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
        This page has wandered off
      </h1>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist, or the product may
        have sold out. Let&apos;s get you back to the collection.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground shadow-sm transition hover:opacity-90"
        >
          Back to home
        </Link>
        <Link
          href="/shop"
          className="rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          Browse the shop
        </Link>
      </div>
    </main>
  );
}
