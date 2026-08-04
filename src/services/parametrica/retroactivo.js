// src/services/parametrica/retroactivo.js
//
// Ajuste retroactivo de pago único — cálculo puro (sin HubSpot ni DB).
//
// Cuando el ajuste por paramétrica se aplica con una FECHA (mes y año), el
// porcentaje debería haber estado vigente desde ese mes. Las facturas que ya
// salieron en el medio salieron con el precio viejo, así que se cobra la
// diferencia en un line item aparte, de pago único.
//
// Definición de la usuaria (4-ago-2026):
//   - Un line item por CADA line item ajustado (no uno sumado por negocio).
//   - Se llama «Ajuste retroactivo de pago único».
//   - Lo factura el motor solo, acompañando al siguiente line item: la fecha
//     del puntual es la PRÓXIMA fecha de facturación del LI ajustado.
//   - Se cuentan las facturas que YA salieron entre el mes del ajuste y hoy.
//     Mensual el 1°, ajuste de julio, hoy 4-ago → julio y agosto = 2.
//     Mensual a fin de mes, hoy 4-ago → sólo julio = 1, porque el de agosto
//     todavía no salió y va a salir ya ajustado.
//
// El conteo NO recalcula el calendario: se cuentan los tickets ya facturados
// del line item (ver contarPeriodosFacturados en parametricaService.js). El
// ticket ES la factura, así que el momento de facturación ya está contemplado.

/** Nombre del line item que se crea. Es el que ve el cliente en la factura. */
export const NOMBRE_LI_RETRO = 'Ajuste retroactivo';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre',
];
// Variantes que escribe la gente. El índice es el mes (1-12).
const ALIAS_MESES = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, set: 9, setiembre: 9, septiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
};

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** "2026-07" → "julio 2026" */
export function etiquetaMes(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''));
  if (!m) return String(ym ?? '');
  const mes = Number(m[2]);
  return `${MESES[mes - 1] || m[2]} ${m[1]}`;
}

/**
 * Parsea el mes del ajuste. Acepta "julio 2026", "jul 2026", "07/2026",
 * "2026-07" y el value de un <input type="month">.
 *
 * @param {*} txt
 * @param {string} hoyYmd  hoy en YYYY-MM-DD (Montevideo), para validar
 * @param {number} maxMeses  cuántos meses para atrás se admiten
 * @returns {{ok:boolean, error?:string, ym?:string, desde?:string, label?:string}}
 */
export function parseMesAjuste(txt, hoyYmd, maxMeses = 24) {
  const crudo = sinAcentos(txt);
  if (!crudo) return { ok: false, error: 'Falta el mes del ajuste' };

  let anio = null;
  let mes = null;

  // 2026-07 · 2026/07
  let m = /^(\d{4})[-/](\d{1,2})$/.exec(crudo);
  if (m) { anio = Number(m[1]); mes = Number(m[2]); }

  // 07/2026 · 7-2026
  if (mes == null) {
    m = /^(\d{1,2})[-/](\d{4})$/.exec(crudo);
    if (m) { mes = Number(m[1]); anio = Number(m[2]); }
  }

  // julio 2026 · jul 2026 · julio de 2026
  if (mes == null) {
    m = /^([a-z]+)\.?\s+(?:de\s+)?(\d{4})$/.exec(crudo);
    if (m && ALIAS_MESES[m[1]]) { mes = ALIAS_MESES[m[1]]; anio = Number(m[2]); }
  }

  if (mes == null || !Number.isInteger(mes) || mes < 1 || mes > 12 || !anio) {
    return { ok: false, error: `No entiendo "${txt}" — escribí el mes y el año, por ejemplo "julio 2026"` };
  }

  const ym = `${anio}-${String(mes).padStart(2, '0')}`;
  const hoyYm = String(hoyYmd).slice(0, 7);

  if (ym > hoyYm) {
    return { ok: false, error: `${etiquetaMes(ym)} es futuro — el ajuste retroactivo sólo mira meses que ya pasaron` };
  }
  if (mesesEntre(ym, hoyYm) > maxMeses) {
    return { ok: false, error: `${etiquetaMes(ym)} queda a más de ${maxMeses} meses — verificá que sea correcto` };
  }

  return { ok: true, ym, desde: `${ym}-01`, label: etiquetaMes(ym) };
}

/** Diferencia en meses entre dos YYYY-MM (b - a). */
export function mesesEntre(a, b) {
  const [aa, am] = String(a).split('-').map(Number);
  const [ba, bm] = String(b).split('-').map(Number);
  return (ba - aa) * 12 + (bm - am);
}

const redondear2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Monto del line item retroactivo. Es UN MONTO ÚNICO, no una recurrencia:
 * si el ajuste era de 100 por mes y son 3 meses, el line item vale 300.
 *
 *   ajustePorPago = (precio nuevo − precio viejo) × cantidad del original
 *   importe       = ajustePorPago × pagos          ← el precio del line item
 *
 * Va con cantidad 1 y en la moneda original del negocio, SIN impuestos: el
 * IVA lo aplica HubSpot con el tax group que se hereda del line item original.
 *
 * @returns {{deltaUnitario:number, ajustePorPago:number, importe:number}}
 */
export function calcularRetroactivo({ priceViejo, priceNuevo, cantidad = 1, periodos = 0 }) {
  const deltaUnitario = redondear2(Number(priceNuevo) - Number(priceViejo));
  const qty = Number(cantidad) > 0 ? Number(cantidad) : 1;
  const n = Number.isFinite(Number(periodos)) ? Math.max(0, Math.trunc(Number(periodos))) : 0;
  const ajustePorPago = redondear2(deltaUnitario * qty);
  return { deltaUnitario, ajustePorPago, importe: redondear2(ajustePorPago * n) };
}

const fmtMonto = (n) => Number(n).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Descripción del line item retroactivo — tiene que explicarse sola en la
 * factura y en el ticket, sin que nadie tenga que abrir la pantalla: de qué
 * line item viene (nombre e ID), cuántos pagos cubre y desde qué mes.
 */
export function descripcionRetro({
  servicio, lineItemId, mesLabel, periodos, ajustePorPago, importe, moneda,
}) {
  const pagos = periodos === 1 ? '1 pago' : `${periodos} pagos`;
  const m = moneda ? `${moneda} ` : '';
  return [
    `Ajuste retroactivo por ${pagos} contando a partir de ${mesLabel}.`,
    `Line item original: "${servicio || 's/nombre'}"${lineItemId ? ` (ID ${lineItemId})` : ''}.`,
    `Monto único de ${m}${fmtMonto(importe)} en moneda original, sin impuestos`,
    `(${m}${fmtMonto(ajustePorPago)} por pago × ${periodos}).`,
  ].join(' ');
}

/**
 * Decide si una fila puede llevar ajuste retroactivo y por qué no, si no puede.
 * @returns {{aplica:boolean, motivo?:string}}
 */
export function evaluarRetroactivo({ periodos, proximaFecha, deltaUnitario }) {
  if (!periodos) return { aplica: false, motivo: 'sin_facturas_en_el_periodo' };
  if (deltaUnitario === 0) return { aplica: false, motivo: 'sin_diferencia' };
  if (!proximaFecha) return { aplica: false, motivo: 'sin_proxima_fecha' };
  return { aplica: true };
}

export const MOTIVOS_RETRO = {
  sin_facturas_en_el_periodo: 'No salió ninguna factura entre el mes del ajuste y hoy',
  sin_diferencia: 'El ajuste no cambia el precio',
  sin_proxima_fecha: 'El line item no tiene próxima fecha de facturación — no hay a qué acompañar',
};
