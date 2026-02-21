// lib/logger.js (ESM)
import pino from "pino";

const isProd =
  process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT);

const level = process.env.LOG_LEVEL || (isProd ? "info" : "debug");

const usePretty =
  !isProd &&
  (process.env.PRETTY_LOGS === "true" || process.env.PRETTY_LOGS === "1");

const logtailToken = process.env.LOGTAIL_SOURCE_TOKEN;

// Opcional: Better Stack te muestra un "Ingesting host" en el source.
// Si no lo ponés, muchas libs usan el default. Si tu UI te lo da, guardalo en env:
const ingestingHost = process.env.LOGTAIL_INGESTING_HOST; // ej: "https://in.logs.betterstack.com"

let transport;

if (usePretty) {
  try {
    transport = pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        singleLine: true,
        ignore: "pid,hostname",
      },
    });
  } catch {
    transport = undefined;
  }
} else if (logtailToken) {
  // Envío a Better Stack (Logtail)
  transport = pino.transport({
    target: "@logtail/pino",
    options: {
      sourceToken: logtailToken,
      ...(ingestingHost ? { options: { endpoint: ingestingHost } } : {}),
    },
  });
}

const logger = pino(
  {
    level,
    base: { service: "hubspot-billing-updater" },
  },
  transport
);

export default logger;