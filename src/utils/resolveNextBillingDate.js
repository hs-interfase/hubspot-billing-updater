// src/utils/resolveNextBillingDate.js
import { parseLocalDate, formatDateISO, getTodayYMD } from "./dateUtils.js";

function upper(v) {
  return (v ?? "").toString().trim().toUpperCase();
}

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
 * Si es auto-renew o >24 pagos:
 * - si billing_anchor_date válida: usarla
 * - si no: calcular next infinito por start+interval
 *
 * Si NO es special: usa preview (como hoy).
 */
export function resolveNextBillingDate({
  lineItemProps,
  upcomingDates,
  startRaw,
  interval,
  addInterval,
}) {
  const todayYmd = getTodayYMD();

  const terms = upper(lineItemProps.hs_recurring_billing_terms);
  const isAutoRenew = terms === "AUTOMATICALLY RENEW";

  const nPayments =
    parseInt((lineItemProps.hs_recurring_billing_number_of_payments ?? "").toString(), 10) || 0;

  const isOver24 = !isAutoRenew && nPayments > 24;
  const isSpecial = isAutoRenew || isOver24;

  // modo normal: preview
  const nextFromPreview =
    upcomingDates?.find((d) => d && d >= todayYmd) || null;

  if (!isSpecial) return nextFromPreview;

  // modo special: anchor primero
  const anchorRaw = (lineItemProps.billing_anchor_date ?? "").toString().trim();
  const anchorDate = anchorRaw ? parseLocalDate(anchorRaw) : null;
  const anchorYmd = anchorDate ? formatDateISO(anchorDate) : null;

  if (anchorYmd && anchorYmd >= todayYmd) {
    console.log("📌 [billing] usando billing_anchor_date", {
      anchorYmd,
      isAutoRenew,
      nPayments,
    });
    return anchorYmd;
  }

  // si falta anchor: calcular infinito
  const computed = computeNextFromStart({ startRaw, interval, addInterval });

  console.log("🧠 [billing] computed next (special)", {
    computed,
    isAutoRenew,
    nPayments,
    startRaw,
    interval,
  });

  return computed || nextFromPreview;
}
