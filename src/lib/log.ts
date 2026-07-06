// Structured application logger (pino).
//
// - Development: pretty, human-readable output (pino-pretty transport).
// - Production/test: single-line JSON to stdout (log aggregator friendly).
//
// Import the shared instance everywhere: `import { log } from "@/lib/log"`.
// Prefer child loggers for scoped context, e.g. `log.child({ module: "payments" })`.

import pino, { type Logger } from "pino";

const isProd = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

export const log: Logger = pino({
  level,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }),
});
