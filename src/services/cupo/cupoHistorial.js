// src/services/cupo/cupoHistorial.js
//
// Historial de eventos de cupo en el ticket (prop `of_cupo_historial`).
//
// Formato de línea (una por evento, separadas por \n):
//   "2026-08-12 | consumo | -300 | invoice 12345"
//   "2026-08-20 | reversion | 300 | invoice 12345 | por usuario@x.com"
//
// El `valor` se registra CON SU SIGNO: un consumo de nota de crédito es
// negativo; su reversión también (re-débito). El historial es evidencia,
// no fuente de verdad: la idempotencia sigue viviendo en
// cupo_consumo_invoice_id y los números del cupo en el deal.
//
// Tope de tamaño: HubSpot limita los textos largos (~65k chars). Si el
// historial supera HISTORIAL_MAX_CHARS se recortan las líneas MÁS VIEJAS
// (las del principio) y se deja la nota '[historial recortado]' arriba.

export const HISTORIAL_MAX_CHARS = 60000;

const NOTA_RECORTE = '[historial recortado]';

/**
 * Construye una línea del historial de cupo.
 *
 * @param {Object} params
 * @param {string} params.fecha     - 'YYYY-MM-DD'
 * @param {'consumo'|'reversion'} params.tipo
 * @param {number|string} params.valor - valor del evento, con su signo
 * @param {string|number} params.invoiceId
 * @param {string} [params.extra]   - texto opcional (p.ej. 'por usuario@x')
 * @returns {string}
 */
export function buildCupoHistorialLine({ fecha, tipo, valor, invoiceId, extra } = {}) {
  const base = `${fecha} | ${tipo} | ${valor} | invoice ${invoiceId}`;
  return extra ? `${base} | ${extra}` : base;
}

/**
 * Appendea una línea al historial existente.
 *
 * - Tolera historial vacío/undefined (devuelve solo la línea).
 * - Si el resultado supera `maxChars`, recorta las líneas MÁS VIEJAS
 *   (del principio) hasta entrar, dejando la nota '[historial recortado]'
 *   como primera línea. La línea nueva (la más reciente) nunca se pierde.
 *
 * @param {string|null|undefined} actual - historial actual
 * @param {string} linea                 - línea nueva a agregar
 * @param {number} [maxChars]            - tope de tamaño (default 60000)
 * @returns {string}
 */
export function appendHistorial(actual, linea, maxChars = HISTORIAL_MAX_CHARS) {
  const base = actual == null ? '' : String(actual);
  const nuevo = base ? `${base}\n${linea}` : String(linea);
  if (nuevo.length <= maxChars) return nuevo;

  // Recorte: descartar líneas viejas (del principio) hasta entrar en el tope.
  // Se filtra una nota de recorte previa para no acumular notas repetidas.
  const lineas = nuevo.split('\n').filter((l) => l !== NOTA_RECORTE);
  while (
    lineas.length > 1 &&
    NOTA_RECORTE.length + 1 + lineas.join('\n').length > maxChars
  ) {
    lineas.shift();
  }
  return `${NOTA_RECORTE}\n${lineas.join('\n')}`;
}
