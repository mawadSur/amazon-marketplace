// Sentry client-side init. Bundled into the browser when SENTRY_DSN is set.
//
// This is the Turbopack-recommended location for client instrumentation
// (Next 15 loads `instrumentation-client.ts` automatically). The legacy
// `sentry.client.config.ts` re-exports this module so both entry points share
// one implementation.

import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
  });
}

// Capture navigation transactions for App Router client-side routing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
