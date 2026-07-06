// Legacy Sentry client entry point.
//
// The real init lives in `instrumentation-client.ts` (the Turbopack-preferred
// location). This module simply re-exports it so behavior is identical whether
// Next loads the config from here or from instrumentation-client.

export * from "./instrumentation-client";
