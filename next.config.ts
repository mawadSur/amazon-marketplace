import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// Derive an image host allow-list. When S3_PUBLIC_BASE_URL is set (e.g. the
// CloudFront/R2 CDN origin that serves uploaded media) we pin remotePatterns to
// that exact host so we don't proxy-optimize arbitrary third-party images.
// Fall back to the broad wildcard hosts otherwise so local dev / preview builds
// that only have the raw bucket envs keep working.
function imageRemotePatterns(): NonNullable<NextConfig["images"]>["remotePatterns"] {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (base) {
    try {
      const { hostname } = new URL(base);
      return [{ protocol: "https", hostname }];
    } catch {
      // Malformed URL — fall through to the wildcard defaults below.
    }
  }
  return [
    { protocol: "https", hostname: "**.r2.cloudflarestorage.com" },
    { protocol: "https", hostname: "**.amazonaws.com" },
    { protocol: "https", hostname: "**.cloudfront.net" },
  ];
}

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) for the
  // Docker web image; see Dockerfile.web.
  output: "standalone",
  images: {
    remotePatterns: imageRemotePatterns(),
  },
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },
};

// Sentry wraps the build only when credentials are configured. Without them
// the wrapper is a no-op pass-through, so local dev with no SENTRY_DSN is
// unaffected.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Disable telemetry from the build wrapper itself.
  telemetry: false,
});
