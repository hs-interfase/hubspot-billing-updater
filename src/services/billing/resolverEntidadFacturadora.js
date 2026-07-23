// src/services/billing/resolverEntidadFacturadora.js
//
// ÚNICA regla de resolución de la ENTIDAD FACTURADORA (la emisora del grupo).
// Definición usuaria 23-jul, dos niveles:
//   1. pais_operativo del NEGOCIO = 'Paraguay' → 'ISA PY' SIEMPRE (sin importar producto).
//   2. 'Uruguay' → por producto (EMPRESA_EMISORA_MAP, misma fuente que los mensajes),
//      con el ÁREA como desempate de los dos iSCert: área 'iSCert ISA' → ISA UY ·
//      área 'iSCert' → Interfase UY (el área GANA si contradice al producto — hay dos
//      productos desde el split 13-jul, pero un LI viejo puede apuntar al equivocado).
//   3. Mixto / otro / vacío → no se resuelve ('' — el caller no toca y loguea).
//
// ⚠️ VOCABULARIO: la salida son los valores REALES del select (`empresa_que_factura` del
// line item / `entidad_facturadora` del ticket): 'Interfase UY | ISA UY | ISA PY |
// Interfase PY' — verificados por API el 20 y 23-jul en AMBOS portales. NO usar acá el
// vocabulario de display de los mensajes ('ISA' / 'Interfase'): escribir un valor que no
// es opción del select da 400.

import { EMPRESA_EMISORA_MAP } from './empresaEmisora.js';

// display del mensaje → valor del select (los deals UY emiten por su entidad UY).
const DISPLAY_TO_SELECT = {
  'ISA': 'ISA UY',
  'Interfase': 'Interfase UY',
  'ISA PY': 'ISA PY',
};

// Desempate iSCert por ÁREA (usuaria 23-jul: "el área define cuál es").
// Claves normalizadas en minúsculas; el resto de las áreas no definen emisora.
const AREA_TO_ENTIDAD = {
  'iscert isa': 'ISA UY',
  'iscert': 'Interfase UY',
};

/**
 * Resuelve la entidad facturadora de UN line item dentro de su negocio.
 *
 * @param {Object} args
 * @param {string} args.paisOperativo - pais_operativo del DEAL ('Uruguay'/'Paraguay'/otro)
 * @param {string} args.productId - hs_product_id del line item
 * @param {string} args.area - select `area` del line item
 * @returns {{ valor: string, metodo: string }} valor '' cuando no se resuelve.
 *   metodo ∈ pais | area | area_gana_a_producto | producto | pais_no_resuelto | sin_producto_ni_area
 */
export function resolverEntidadFacturadora({ paisOperativo, productId, area } = {}) {
  const pais = String(paisOperativo || '').trim().toLowerCase();
  if (pais === 'paraguay') return { valor: 'ISA PY', metodo: 'pais' };
  if (pais !== 'uruguay') return { valor: '', metodo: 'pais_no_resuelto' };

  const porArea = AREA_TO_ENTIDAD[String(area || '').trim().toLowerCase()] || '';
  const display = EMPRESA_EMISORA_MAP[String(productId || '').trim()] || '';
  const porProducto = DISPLAY_TO_SELECT[display] || '';

  if (porArea) {
    const contradice = porProducto && porArea !== porProducto;
    return { valor: porArea, metodo: contradice ? 'area_gana_a_producto' : 'area' };
  }
  if (porProducto) return { valor: porProducto, metodo: 'producto' };
  return { valor: '', metodo: 'sin_producto_ni_area' };
}
