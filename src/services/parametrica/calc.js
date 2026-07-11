// src/services/parametrica/calc.js
//
// Cálculo puro del ajuste de precio por paramétrica (sin HubSpot ni DB).
// La reversa NO usa el % inverso: el redondeo a 2 decimales no es reversible,
// por eso el price viejo se guarda en parametrica_items y se restaura tal cual.

/**
 * Aplica un porcentaje al precio y redondea a 2 decimales.
 * @param {number} priceViejo
 * @param {number} pct  porcentaje (ej. 7.5 = +7,5%; -12 = -12%)
 * @returns {number} precio nuevo con 2 decimales
 */
export function calcularPriceNuevo(priceViejo, pct) {
  const nuevo = priceViejo * (1 + pct / 100);
  return Math.round((nuevo + Number.EPSILON) * 100) / 100;
}

/**
 * Valida el porcentaje ingresado.
 * @param {*} pct
 * @param {number} maxPct  umbral de advertencia (abs), default 30
 * @returns {{ok: boolean, error?: string, warning?: string, pct?: number}}
 */
export function validarPorcentaje(pct, maxPct = 30) {
  const n = typeof pct === 'string' ? Number(pct.replace(',', '.')) : Number(pct);
  if (!Number.isFinite(n)) return { ok: false, error: 'El porcentaje debe ser un número' };
  if (n === 0) return { ok: false, error: 'El porcentaje no puede ser 0' };
  if (n <= -100) return { ok: false, error: 'El porcentaje no puede ser -100% o menor' };
  const out = { ok: true, pct: n };
  if (Math.abs(n) > maxPct) {
    out.warning = `El porcentaje supera el umbral de ±${maxPct}% — verificá que sea correcto`;
  }
  return out;
}
