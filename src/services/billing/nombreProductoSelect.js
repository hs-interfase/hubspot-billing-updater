// src/services/billing/nombreProductoSelect.js
//
// Split producto 13-jul (D-reunión §3): el line item tiene un select `nombre_producto`
// que el vendedor puede cambiar para elegir de qué producto sale el LI. Cuando cambia,
// el MOTOR reescribe el hs_product_id del line item al ID que corresponde a la opción
// elegida; de ahí en más el producto del ticket (of_producto vía deal.producto),
// el área, la empresa emisora (empresaEmisora.js) y la factura se recalculan solos al
// re-correr las phases.
//
// ⚠ Nombre interno de la propiedad del LI: CONFIRMAR con la usuaria (se creó el select
//   "nombre producto"). Si el interno no es `nombre_producto`, cambiar LI_NOMBRE_PRODUCTO_PROP.
//
// ⚠ CASING: los VALORES internos de las opciones del select usan ISCert / ISCert ISA /
//   IJServ (I mayúscula), distinto de la biblioteca (iSCert / iSCert ISA / iJServ). Este
//   mapa usa los valores EXACTOS del select (lo que manda el webhook), NO los de biblioteca.
//   IDs = biblioteca de PRODUCCIÓN (el motor corre en prod).

import logger from '../../../lib/logger.js';
import { hubspotClient } from '../../hubspotClient.js';

const MODULE = 'nombreProductoSelect';

export const LI_NOMBRE_PRODUCTO_PROP = 'nombre_producto';

// Valor interno de la opción del select `nombre_producto` (LI) → hs_product_id (PROD).
export const NOMBRE_PRODUCTO_TO_ID = {
  'ISCert':     '33688819740', // iSCert (Interfase)
  'ISCert ISA': '46035674794', // iSCert ISA (ISA) — split 13-jul
  'i2':         '33695559590',
  'MiFactura':  '33695559589',
  'MiRecibo':   '33688695889',
  'IJServ':     '33688695870', // iJServ
  'Flota':      '33695559578',
  'Proyectos':  '33688943634',
  'iGDoc':      '33688819739',
  'Liferay':    '45054899755',
  'NNDD Ops':   '45054899756',
  'Portal':     '33695807329',
  'PayRoll':    '33688695865',
};

// Inverso: hs_product_id → valor del select `nombre_producto`. Sin colisiones (cada
// opción → un ID distinto). Se usa para autocompletar el select al crear el LI.
export const ID_TO_NOMBRE_PRODUCTO = Object.fromEntries(
  Object.entries(NOMBRE_PRODUCTO_TO_ID).map(([nombre, id]) => [id, nombre])
);

/** Resuelve el product ID (prod) desde el valor del select. null si la opción no está mapeada. */
export function resolveProductIdFromNombre(nombreProducto) {
  const v = String(nombreProducto ?? '').trim();
  if (!v) return null;
  return NOMBRE_PRODUCTO_TO_ID[v] ?? null;
}

/** Resuelve el valor del select desde el hs_product_id. null si el ID no está mapeado. */
export function resolveNombreFromProductId(productId) {
  const id = String(productId ?? '').trim();
  if (!id) return null;
  return ID_TO_NOMBRE_PRODUCTO[id] ?? null;
}

/**
 * Sincroniza `nombre_producto` de los line items para que SIEMPRE refleje el nombre
 * del hs_product_id (invariante 13-jul: "si el product id dice una cosa, el
 * nombre_producto debe decir eso"). Sobrescribe cuando difiere (incluye el LI recién
 * creado, con el select vacío). El cambio DELIBERADO del vendedor no se pierde: lo
 * maneja product_reassign usando el valor del evento, y el estado final converge.
 * No-op cuando ya coinciden (sin llamadas de más). (D-reunión §3, 13-jul.)
 *
 * @param {Array<{id:string, properties?:Object}>} lineItems
 * @returns {Promise<number>} cantidad de LIs sincronizados
 */
export async function syncNombreProductoFromProductId(lineItems = []) {
  let synced = 0;
  for (const li of lineItems) {
    const props = li?.properties || {};
    const pid = props.hs_product_id ? String(props.hs_product_id) : null;
    if (!pid) continue;                          // sin producto asociado → nada que reflejar
    const nombre = resolveNombreFromProductId(pid);
    if (!nombre) {
      logger.warn(
        { module: MODULE, fn: 'syncNombreProductoFromProductId', lineItemId: li.id, hs_product_id: pid },
        'hs_product_id sin opción de select mapeada → no se sincroniza nombre_producto'
      );
      continue;
    }
    const current = String(props.nombre_producto ?? '').trim();
    if (current === nombre) continue;            // ya refleja el product id → no-op
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
        properties: { [LI_NOMBRE_PRODUCTO_PROP]: nombre },
      });
      if (li.properties) li.properties.nombre_producto = nombre; // reflejar en el objeto en memoria
      synced++;
      logger.info(
        { module: MODULE, fn: 'syncNombreProductoFromProductId', lineItemId: li.id, hs_product_id: pid, from: current || '(vacío)', to: nombre },
        'nombre_producto sincronizado desde hs_product_id'
      );
    } catch (err) {
      logger.error(
        { module: MODULE, fn: 'syncNombreProductoFromProductId', lineItemId: li.id, err: err?.message },
        'No se pudo sincronizar nombre_producto'
      );
    }
  }
  return synced;
}

/**
 * Reasocia el producto de un line item según su select `nombre_producto`.
 * Lee el LI fresco (el webhook puede venir batcheado/viejo), mapea la opción al
 * product ID y, si difiere del hs_product_id actual, lo reescribe.
 *
 * `explicitNombre` (valor del evento/webhook) tiene prioridad sobre lo que se lea del LI:
 * evita que una corrida de cron que sincronizó nombre_producto←ID en el ínterin pise el
 * cambio deliberado del vendedor (el estado final converge al producto elegido).
 *
 * @param {string|number} lineItemId
 * @param {string|null} explicitNombre valor de nombre_producto del evento (opcional)
 * @returns {Promise<{changed:boolean, reason?:string, nombre?:string, oldId?:string|null, newId?:string}>}
 */
export async function reassignLineItemProduct(lineItemId, explicitNombre = null) {
  const li = await hubspotClient.crm.lineItems.basicApi.getById(
    String(lineItemId),
    [LI_NOMBRE_PRODUCTO_PROP, 'hs_product_id']
  );
  const props = li?.properties || {};
  const nombre = (explicitNombre != null && String(explicitNombre).trim())
    ? String(explicitNombre).trim()
    : props[LI_NOMBRE_PRODUCTO_PROP];
  const currentId = props.hs_product_id ? String(props.hs_product_id) : null;

  const targetId = resolveProductIdFromNombre(nombre);
  if (!targetId) {
    logger.warn(
      { module: MODULE, fn: 'reassignLineItemProduct', lineItemId, nombre },
      'nombre_producto sin opción mapeada → no se reasocia producto'
    );
    return { changed: false, reason: 'nombre_no_mapeado', nombre, oldId: currentId };
  }

  if (currentId === targetId) {
    return { changed: false, reason: 'ya_coincide', nombre, oldId: currentId, newId: targetId };
  }

  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), {
    properties: { hs_product_id: targetId },
  });

  logger.info(
    { module: MODULE, fn: 'reassignLineItemProduct', lineItemId, nombre, oldId: currentId, newId: targetId },
    'hs_product_id reasignado desde nombre_producto'
  );
  return { changed: true, nombre, oldId: currentId, newId: targetId };
}
