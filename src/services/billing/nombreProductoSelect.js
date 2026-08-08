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

// Valor interno de la opción del select `nombre_producto` (LI) → hs_product_id, POR PORTAL.
// IDs tomados de `PRODUCTS` de la migración (definitivos/4_PROGRAMAS/migracion_pasoA_dryrun.mjs)
// — misma fuente que usa la carga → garantiza que coincidan en ambos entornos.
// OJO casing: los VALORES del select son ISCert / ISCert ISA / IJServ (I mayúscula), distinto
// de la biblioteca (iSCert…). El mapa usa el valor EXACTO del select (lo que manda el webhook).
export const NOMBRE_PRODUCTO_TO_ID_BY_ENV = {
  'ISCert':     { sandbox: '41948442381', prod: '33688819740' }, // iSCert (Interfase)
  'ISCert ISA': { sandbox: '46035551908', prod: '46035674794' }, // iSCert ISA (ISA) — split 13-jul
  'i2':         { sandbox: '42010181658', prod: '33695559590' },
  'MiFactura':  { sandbox: '42010181659', prod: '33695559589' },
  'MiRecibo':   { sandbox: '42004648587', prod: '33688695889' },
  'IJServ':     { sandbox: '41943895217', prod: '33688695870' }, // iJServ
  'Flota':      { sandbox: '41943895219', prod: '33695559578' },
  'Proyectos':  { sandbox: '41943709577', prod: '33688943634' },
  'iGDoc':      { sandbox: '42010367402', prod: '33688819739' },
  'Liferay':    { sandbox: '45055023516', prod: '45054899755' },
  'NNDD Ops':   { sandbox: '45054899742', prod: '45054899756' },
  'Portal':     { sandbox: '42010181660', prod: '33695807329' },
  'PayRoll':    { sandbox: '42010367404', prod: '33688695865' },
};

// Entorno del deployment: HUBSPOT_ENV=sandbox usa IDs de pruebas; cualquier otro valor
// (o ausente) cae a PROD (default seguro para producción).
const PRODUCTO_ENV = String(process.env.HUBSPOT_ENV || 'production').toLowerCase() === 'sandbox'
  ? 'sandbox' : 'prod';

// Mapa resuelto para ESTE entorno (valor select → hs_product_id del portal actual).
export const NOMBRE_PRODUCTO_TO_ID = Object.fromEntries(
  Object.entries(NOMBRE_PRODUCTO_TO_ID_BY_ENV).map(([nombre, ids]) => [nombre, ids[PRODUCTO_ENV]])
);

// Inverso: hs_product_id → valor del select `nombre_producto`. Sin colisiones (cada
// opción → un ID distinto). Se usa para autocompletar el select al crear el LI.
export const ID_TO_NOMBRE_PRODUCTO = Object.fromEntries(
  Object.entries(NOMBRE_PRODUCTO_TO_ID).map(([nombre, id]) => [id, nombre])
);

// ── Traducción al select del TICKET (`of_producto`) ──────────────────────────
// Los DOS selects tienen los mismos productos pero con CASING DISTINTO:
//   line_item.nombre_producto → 'ISCert' · 'ISCert ISA' · 'IJServ'   (I mayúscula)
//   ticket.of_producto        → 'iSCert' · 'iJServ'                  (casing biblioteca)
// Verificado por API el 2-ago contra el portal. Escribir el valor del otro select da
// 400, así que la traducción es OBLIGATORIA — no alcanza con copiar el string.
//
// 🔴 HUECO CONOCIDO: `of_producto` NO tiene opción «iSCert ISA» (el ticket sólo conoce
// «iSCert»). Hasta que se agregue la opción en el portal, el split del 13-jul no se
// puede representar en el ticket y las dos ramas caen en 'iSCert'.
export const NOMBRE_PRODUCTO_TO_OF_PRODUCTO = {
  'ISCert': 'iSCert',
  'ISCert ISA': 'iSCert', // ⚠️ ver hueco de arriba
  'IJServ': 'iJServ',
  'i2': 'i2',
  'MiFactura': 'MiFactura',
  'MiRecibo': 'MiRecibo',
  'Flota': 'Flota',
  'Proyectos': 'Proyectos',
  'iGDoc': 'iGDoc',
  'Liferay': 'Liferay',
  'NNDD Ops': 'NNDD Ops',
  'Portal': 'Portal',
  'PayRoll': 'PayRoll',
};

/**
 * Producto del TICKET a partir del LINE ITEM (definición usuaria 2-ago-2026):
 * «`of_producto` es el nombre del PRODUCTO asociado al line item».
 *
 * Antes salía de `deal.producto`, que es la UNIÓN de los productos del negocio → con
 * varios line items todos los tickets recibían el mismo producto (medido: 4 de 5
 * tickets con el producto equivocado). Acá se resuelve por línea.
 *
 * Prioriza el select ya resuelto y cae al `hs_product_id` si el select todavía no se
 * rellenó (el orden de Phase 1 no garantiza que ya haya corrido el id→select).
 *
 * @param {object} lineItemProps - properties del line item
 * @returns {string} valor del select `of_producto`, o '' si no se puede resolver
 */
export function ofProductoDesdeLineItem(lineItemProps = {}) {
  const porSelect = String(lineItemProps[LI_NOMBRE_PRODUCTO_PROP] || '').trim();
  if (porSelect && NOMBRE_PRODUCTO_TO_OF_PRODUCTO[porSelect]) {
    return NOMBRE_PRODUCTO_TO_OF_PRODUCTO[porSelect];
  }
  const porId = ID_TO_NOMBRE_PRODUCTO[String(lineItemProps.hs_product_id || '').trim()];
  return porId ? (NOMBRE_PRODUCTO_TO_OF_PRODUCTO[porId] || '') : '';
}

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
 * RELLENA `nombre_producto` desde el hs_product_id SOLO cuando el select está VACÍO
 * (caso creación: el LI nace con product id y sin nombre_producto → se autocompleta).
 *
 * Regla de prioridad (definición usuaria 14-jul): `nombre_producto` es la FUENTE DE
 * VERDAD; el `hs_product_id` la sigue. Por eso acá NO se pisa un nombre_producto que
 * ya tenga valor — el id manda solo cuando el nombre está vacío. La reconciliación
 * inversa (nombre gana → reasignar id) vive en `reconcileLineItemsProducto` (cron
 * nocturno); el cambio deliberado del vendedor lo maneja `reassignLineItemProduct`
 * (webhook, tiempo real).
 *
 * @param {Array<{id:string, properties?:Object}>} lineItems
 * @returns {Promise<number>} cantidad de LIs rellenados
 */
export async function syncNombreProductoFromProductId(lineItems = []) {
  let synced = 0;
  for (const li of lineItems) {
    const props = li?.properties || {};
    const pid = props.hs_product_id ? String(props.hs_product_id) : null;
    if (!pid) continue;                          // sin producto asociado → nada que reflejar
    const current = String(props.nombre_producto ?? '').trim();
    if (current) continue;                        // ya tiene valor → NO se pisa (nombre manda)
    const nombre = resolveNombreFromProductId(pid);
    if (!nombre) {
      logger.warn(
        { module: MODULE, fn: 'syncNombreProductoFromProductId', lineItemId: li.id, hs_product_id: pid },
        'hs_product_id sin opción de select mapeada → no se rellena nombre_producto'
      );
      continue;
    }
    try {
      await hubspotClient.crm.lineItems.basicApi.update(String(li.id), {
        properties: { [LI_NOMBRE_PRODUCTO_PROP]: nombre },
      });
      if (li.properties) li.properties.nombre_producto = nombre; // reflejar en el objeto en memoria
      synced++;
      logger.info(
        { module: MODULE, fn: 'syncNombreProductoFromProductId', lineItemId: li.id, hs_product_id: pid, to: nombre },
        'nombre_producto rellenado desde hs_product_id (estaba vacío)'
      );
    } catch (err) {
      logger.error(
        { module: MODULE, fn: 'syncNombreProductoFromProductId', lineItemId: li.id, err: err?.message },
        'No se pudo rellenar nombre_producto'
      );
    }
  }
  return synced;
}

/**
 * Decide la reconciliación producto↔nombre para UN line item (pura, testeable).
 * Prioridad (definición usuaria 14-jul):
 *   - `nombre_producto` NO vacío → GANA: si el id que le corresponde difiere del actual,
 *     hay que reasignar hs_product_id. (Si el nombre no está mapeado, no se toca.)
 *   - `nombre_producto` vacío → gana el id: rellenar nombre desde hs_product_id.
 *
 * @returns {{op:'none'|'set_product_id'|'set_nombre', productId?:string, nombre?:string, reason?:string}}
 */
export function decideProductoReconciliation({ productId, nombre } = {}) {
  const pid = productId != null ? String(productId).trim() : '';
  const nom = nombre != null ? String(nombre).trim() : '';

  if (nom) {
    const targetId = resolveProductIdFromNombre(nom);
    if (!targetId) return { op: 'none', reason: 'nombre_no_mapeado', nombre: nom };
    if (targetId !== pid) return { op: 'set_product_id', productId: targetId, nombre: nom };
    return { op: 'none', reason: 'ya_coincide' };
  }
  // nombre vacío → fallback al id
  if (pid) {
    const nombreFromId = resolveNombreFromProductId(pid);
    if (!nombreFromId) return { op: 'none', reason: 'id_no_mapeado' };
    return { op: 'set_nombre', nombre: nombreFromId };
  }
  return { op: 'none', reason: 'sin_datos' };
}

/**
 * Reconcilia un lote de line items aplicando la prioridad (nombre gana; si vacío, id).
 * Para el cron nocturno. Idempotente y convergente. Nunca lanza por item.
 *
 * @param {Array<{id:string, properties?:Object}>} lineItems
 * @returns {Promise<{reassignedId:number, filledNombre:number, ok:number, unmapped:number, errors:number}>}
 */
export async function reconcileLineItemsProducto(lineItems = [], { client = hubspotClient } = {}) {
  const stats = { reassignedId: 0, filledNombre: 0, ok: 0, unmapped: 0, errors: 0 };
  for (const li of lineItems) {
    const props = li?.properties || {};
    const d = decideProductoReconciliation({ productId: props.hs_product_id, nombre: props.nombre_producto });

    if (d.op === 'none') {
      if (d.reason === 'nombre_no_mapeado' || d.reason === 'id_no_mapeado') stats.unmapped++;
      else stats.ok++;
      continue;
    }
    try {
      if (d.op === 'set_product_id') {
        await client.crm.lineItems.basicApi.update(String(li.id), { properties: { hs_product_id: d.productId } });
        if (li.properties) li.properties.hs_product_id = d.productId;
        stats.reassignedId++;
        logger.info({ module: MODULE, fn: 'reconcileLineItemsProducto', lineItemId: li.id, nombre: d.nombre, newId: d.productId }, 'Reconciliación: hs_product_id reasignado desde nombre_producto (nombre gana)');
      } else if (d.op === 'set_nombre') {
        await client.crm.lineItems.basicApi.update(String(li.id), { properties: { [LI_NOMBRE_PRODUCTO_PROP]: d.nombre } });
        if (li.properties) li.properties.nombre_producto = d.nombre;
        stats.filledNombre++;
        logger.info({ module: MODULE, fn: 'reconcileLineItemsProducto', lineItemId: li.id, nombre: d.nombre }, 'Reconciliación: nombre_producto rellenado desde hs_product_id (estaba vacío)');
      }
    } catch (err) {
      stats.errors++;
      logger.error({ module: MODULE, fn: 'reconcileLineItemsProducto', lineItemId: li.id, op: d.op, err: err?.message }, 'No se pudo reconciliar producto del line item');
    }
  }
  return stats;
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
