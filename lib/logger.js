// lib/logger.js (ESM)
import pino from "pino";

const isProd =
  process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT;

const level = process.env.LOG_LEVEL || (isProd ? "info" : "debug");

// Activá pretty solo cuando vos quieras (evita sorpresas en cron/railway)
const usePretty =
  !isProd &&
  (process.env.PRETTY_LOGS === "true" || process.env.PRETTY_LOGS === "1");

let transport;
if (usePretty) {
  try {
    transport = pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        singleLine: true,
        ignore: "pid,hostname", // opcional
      },
    });
  } catch {
    // Si pino-pretty rompe por algo de Node/Windows, seguimos con JSON
    transport = undefined;
  }
}

const logger = pino(
  {
    level,
    base: {
      service: "hubspot-billing-updater",
    },
  },
  transport
);

export default logger;
