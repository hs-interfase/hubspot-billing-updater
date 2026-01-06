// src/utils/dateDebug.js
export function logDateEnvOnce() {
  const tz = process.env.BILLING_TZ || "America/Montevideo";
  console.log("[dates] BILLING_TZ:", tz);
  console.log("[dates] server now ISO:", new Date().toISOString());
  console.log("[dates] server tz offset (min):", new Date().getTimezoneOffset());
}