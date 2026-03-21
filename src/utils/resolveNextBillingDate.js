// src/services/billing/resolveNextBillingDate.js
import { parseLocalDate, formatDateISO, getTodayYMD } from "../utils/dateUtils.js"; // ajustá path
import { isAutoRenew } from "../services/billing/mode.js"; 

function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

// next >= hoy usando start+interval (infinito)
function computeNextFromStart({ startRaw, interval, addInterval }) {
  if (!startRaw || !interval) return null;

  const today = parseLocalDate(getTodayYMD());
  if (!today) return null;
  const today0 = startOfDay(today);

  const start = parseLocalDate(startRaw);
  if (!start) return null;

  let next = startOfDay(start);

  // fast path: solo días (weekly/biweekly)
  if (interval.days && interval.days > 0 && (!interval.months || interval.months === 0)) {
    const step = interval.days;
    const diffDays = Math.floor((today0.getTime() - next.getTime()) / (24 * 3600 * 1000));
    const jumps = Math.max(0, Math.floor(diffDays / step));
    next.setDate(next.getDate() + jumps * step);
    while (next.getTime() < today0.getTime()) next.setDate(next.getDate() + step);
    return formatDateISO(next);
  }

  // meses/años
  while (next.getTime() < today0.getTime()) {
    const tmp = addInterval(next, interval);
    if (!tmp || tmp.getTime() === next.getTime()) break;
    next = startOfDay(tmp);
  }

  return formatDateISO(next);
}

/**
 * Devuelve la próxima fecha de facturación (YMD) o null según reglas:
 * - Deal cancelado => null
 * - PLAN_FIJO:
 *    - restantes <= 0 => null
 *    - restantes > 0 => próxima fecha (preview, o computed)
 * - AUTO_RENEW:
 *    - si activo => próxima fecha (anchor si existe, si no computed)
 *
 * Nota: No depende de hs_recurring_billing_terms. El modo sale de isAutoRenew().
 */
export function resolveNextBillingDate({
  lineItemProps,
  facturasRestantes,        // number | null (solo relevante en PLAN_FIJO)
  dealIsCanceled = false,   // boolean (te lo pasa syncBillingState)
  upcomingDates,            // array de YMD (preview)
  startRaw,                 // YMD
  interval,                 // {days, months, years...}
  addInterval,              // fn(date, interval) => date
}) {
  if (dealIsCanceled) return null;

  const todayYmd = getTodayYMD();
  const autorenew = isAutoRenew({ properties: lineItemProps });

  // PLAN_FIJO: si no quedan facturas => null
  if (!autorenew) {
    if (typeof facturasRestantes === "number" && facturasRestantes <= 0) return null;
  }

  // preview (primera fecha >= hoy)
  const nextFromPreview = upcomingDates?.find((d) => d && d >= todayYmd) || null;

  // Si es PLAN_FIJO: con preview alcanza (tu engine ya controla longitud por cuotas)
  if (!autorenew) return nextFromPreview;

  // AUTO_RENEW: anchor primero, si no computed infinito
  const anchorRaw = String(lineItemProps.billing_anchor_date ?? "").trim();
  const anchorDate = anchorRaw ? parseLocalDate(anchorRaw) : null;
  const anchorYmd = anchorDate ? formatDateISO(anchorDate) : null;

  if (anchorYmd) {
    const computedFromAnchor = computeNextFromStart({
      startRaw: anchorYmd,
      interval,
      addInterval,
    });
    return computedFromAnchor || nextFromPreview;
  }

  const computed = computeNextFromStart({ startRaw, interval, addInterval });
  return computed || nextFromPreview;
}
