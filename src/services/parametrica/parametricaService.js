// src/services/parametrica/parametricaService.js
//
// Lógica del ajuste de precio por paramétrica — caso masivo iJServ (Petróleo).
// Lee/escribe line items en HubSpot; el estado de cada corrida vive en
// parametrica_batches / parametrica_items (api/parametrica/Db.js).
//
// Exclusiones del ajuste (se listan aparte en la pantalla, no se tocan):
//   - Espejos UY (of_line_item_py_origen_id presente): el cron de mirroring
//     deriva su price del costo del LI PY y pisaría el cambio.
//   - LIs de deals que todavía no están en cierre ganado (o ya se cancelaron).

import { hubspotClient } from '../../hubspotClient.js';
import {
  isDealGanadoStage,
  PROXIMOS_A_FACTURAR_STAGE,
  TICKET_STAGE_LISTO_MANUAL,
  BILLING_AUTOMATED_READY,
  INVOICED_STAGES,
  isCancelledTicketStage,
  isDryRun,
} from '../../config/constants.js';
import { resolveEmpresasPorDeal } from './empresaLookup.js';
import { NOMBRE_LI_RETRO } from './retroactivo.js';
import logger from '../../../lib/logger.js';

const MOD = 'parametricaService';

// Fecha YYYY-MM-DD en hora Montevideo (evita correrse de día por UTC)
const fmtFechaMvd = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Montevideo', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const hoyMvd = () => fmtFechaMvd.format(new Date());

export const IJSERV_PRODUCT_ID = (process.env.IJSERV_PRODUCT_ID || '').trim();

const LI_PROPS = [
  'hs_object_id', 'hs_lastmodifieddate',
  'name', 'description', 'price', 'quantity', 'amount', 'hs_product_id',
  'area', 'servicio', 'subrubro', 'unidad_de_negocio', 'nombre_empresa', 'nombre_producto',
  'empresa_que_factura',          // entidad del grupo que emite (en el LI, no en el ticket)
  'of_moneda', 'deal_currency_code', 'dolar',
  'uy', 'pais_operativo', 'of_line_item_py_origen_id', 'pausa',
  'monto_unitario_original', 'monto_unitario_actual',
  'ajuste_factura_aparte', 'tipo_de_parametrica',
  'fecha_ultimo_ajuste', 'porcentaje_ultimo_ajuste',
  // Para el ajuste retroactivo: a qué fecha se engancha el puntual y qué
  // props del original hay que copiarle para que el motor lo facture igual.
  'billing_next_date', 'momento_de_facturacion', 'recurringbillingfrequency',
  'facturacion_activa', 'facturacion_automatica', 'responsable_asignado',
  'hubspot_owner_id', 'nota',
  // Elegibilidad: el contrato tiene que estar vigente y no ser una NC.
  'fin_del_contrato', 'inicio_del_contrato', 'nc',
  // Impuestos que hereda el puntual.
  'hs_tax_rate_group_id', 'exonera_irae',
];

/** Meses enteros entre una fecha YYYY-MM-DD y hoy. null si no hay fecha. */
export function mesesDesde(ymd, hoy = hoyMvd()) {
  const f = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  const [ay, am, ad] = f.split('-').map(Number);
  const [by, bm, bd] = String(hoy).slice(0, 10).split('-').map(Number);
  let meses = (by - ay) * 12 + (bm - am);
  if (bd < ad) meses -= 1;          // todavía no se cumplió el mes
  return meses;
}

// Marca del line item creado por el ajuste retroactivo. NO se usa
// `ajuste_factura_aparte` para esto: esa prop es una preferencia del line item
// ORIGINAL ("cuando me ajusten, cobrame la diferencia aparte"), no un sello.
export const NOTA_LI_RETRO = 'AJUSTE_RETROACTIVO_PARAMETRICA';

/** ¿Este line item es uno de ajuste retroactivo que creamos nosotros? */
export function esLineItemDeAjusteRetro(props = {}) {
  return String(props.nota || '').includes(NOTA_LI_RETRO) ||
    String(props.name || '').trim() === NOMBRE_LI_RETRO;
}

// Número de contrato: propiedad NUEVA del line item (bloque 2), todavía sin
// crear en los portales. Se pide sólo si está configurada, porque pedir una
// prop inexistente en el search hace fallar el request entero.
export const NUMERO_CONTRATO_PROP = (process.env.PARAMETRICA_PROP_NUMERO_CONTRATO || '').trim();

function propsAPedir() {
  return NUMERO_CONTRATO_PROP ? [...LI_PROPS, NUMERO_CONTRATO_PROP] : LI_PROPS;
}

// ────────────────────────────────────────────────────────────
// Lectura
// ────────────────────────────────────────────────────────────

/**
 * Busca todos los line items del producto iJServ (paginado).
 */
export async function searchIjservLineItems() {
  if (!IJSERV_PRODUCT_ID) {
    throw new Error('IJSERV_PRODUCT_ID no configurado');
  }
  const all = [];
  let after;
  const MAX_PAGES = 30;

  for (let page = 0; page < MAX_PAGES; page++) {
    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_product_id', operator: 'EQ', value: IJSERV_PRODUCT_ID },
        ],
      }],
      properties: propsAPedir(),
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) searchBody.after = after;

    const res = await hubspotClient.crm.lineItems.searchApi.doSearch(searchBody);
    const results = res?.results || [];
    all.push(...results);

    const nextAfter = res?.paging?.next?.after;
    if (!nextAfter || results.length < 100) break;
    after = nextAfter;
  }
  return all;
}

/**
 * Resuelve el deal asociado de cada line item (batch associations v4, chunks de 100)
 * y lee dealname + dealstage de cada deal (batch read).
 * @returns Map(lineItemId -> {dealId, dealName, dealStage})
 */
export async function resolveDealsForLineItems(lineItems) {
  const liToDeal = new Map();
  if (!lineItems.length) return liToDeal;

  for (let i = 0; i < lineItems.length; i += 100) {
    const inputs = lineItems.slice(i, i + 100).map(li => ({ id: String(li.id) }));
    const resp = await hubspotClient.crm.associations.v4.batchApi.getPage(
      'line_items', 'deals', { inputs }
    );
    for (const item of resp?.results || []) {
      const lineItemId = String(item?._from?.id || item?.from?.id || '');
      const dealId = String(item?.to?.[0]?.toObjectId || '');
      if (lineItemId && dealId) liToDeal.set(lineItemId, dealId);
    }
  }

  const dealIds = [...new Set(liToDeal.values())];
  const deals = new Map();
  for (let i = 0; i < dealIds.length; i += 100) {
    const inputs = dealIds.slice(i, i + 100).map(id => ({ id }));
    const resp = await hubspotClient.crm.deals.batchApi.read(
      { inputs, properties: ['dealname', 'dealstage'] }, false
    );
    for (const d of resp?.results || []) {
      deals.set(String(d.id), {
        dealName: d.properties?.dealname || '',
        dealStage: d.properties?.dealstage || '',
      });
    }
  }

  const out = new Map();
  for (const [liId, dealId] of liToDeal) {
    const deal = deals.get(dealId) || { dealName: '', dealStage: '' };
    out.set(liId, { dealId, ...deal });
  }
  return out;
}

/**
 * Arma la vista completa: elegibles para el ajuste + excluidos con motivo.
 *
 * Elegible = line item iJServ, no espejo, con precio, cuyo negocio está de
 * CIERRE GANADO EN ADELANTE (ganado / en ejecución / finalizado). Antes de
 * ganar, el motor rearma el negocio libremente y no tiene sentido ajustarlo.
 */
export async function listarLineItemsIjserv() {
  const lis = await searchIjservLineItems();
  const dealsByLi = await resolveDealsForLineItems(lis);
  const empresasPorDeal = await resolveEmpresasPorDeal(
    [...dealsByLi.values()].map(d => d.dealId).filter(Boolean)
  );

  const elegibles = [];
  const excluidos = [];
  const hoy = hoyMvd();

  for (const li of lis) {
    const p = li.properties || {};
    const deal = dealsByLi.get(String(li.id)) || {};
    const empresaDatos = (deal.dealId && empresasPorDeal.get(String(deal.dealId))) || {};
    const row = {
      lineItemId: String(li.id),
      dealId: deal.dealId || null,
      dealName: deal.dealName || '',
      dealStage: deal.dealStage || '',
      entidadFacturadora: p.empresa_que_factura || '',
      clienteFactura: empresaDatos.clienteFactura || p.nombre_empresa || '',
      codigoEmpresa: empresaDatos.codigoEmpresa || '',
      codigoContacto: empresaDatos.codigoContacto || '',
      numeroContrato: (NUMERO_CONTRATO_PROP ? p[NUMERO_CONTRATO_PROP] : '') || '',
      empresa: p.nombre_empresa || '',
      descripcion: p.description || '',
      area: p.area || '',
      producto: p.nombre_producto || 'iJServ',
      rubro: p.servicio || '',
      servicio: p.name || '',
      quantity: p.quantity != null && p.quantity !== '' ? Number(p.quantity) : null,
      price: p.price != null && p.price !== '' ? Number(p.price) : null,
      moneda: p.of_moneda || p.deal_currency_code || '',
      fechaUltimoAjuste: p.fecha_ultimo_ajuste || null,
      porcentajeUltimoAjuste: p.porcentaje_ultimo_ajuste || null,
      montoUnitarioOriginal: p.monto_unitario_original || null,
      pausa: p.pausa === 'true',
      cantidad: p.quantity != null && p.quantity !== '' ? Number(p.quantity) : 1,
      proximaFecha: (p.billing_next_date || '').toString().slice(0, 10) || null,
      finDelContrato: (p.fin_del_contrato || '').toString().slice(0, 10) || null,
      mesesDesdeUltimoAjuste: mesesDesde(p.fecha_ultimo_ajuste, hoy),
      esNc: p.nc === 'true',
    };

    if (p.of_line_item_py_origen_id) {
      excluidos.push({ ...row, motivo: 'espejo_intercompany' });
    } else if (esLineItemDeAjusteRetro(p)) {
      // Un ajuste retroactivo no se vuelve a ajustar: es un pago único ya cerrado.
      excluidos.push({ ...row, motivo: 'li_de_ajuste_retroactivo' });
    } else if (row.esNc) {
      // Una nota de crédito no se ajusta: su importe corrige una factura ya
      // emitida, con el precio que tenía en ese momento.
      excluidos.push({ ...row, motivo: 'nota_de_credito' });
    } else if (!deal.dealId) {
      excluidos.push({ ...row, motivo: 'sin_deal' });
    } else if (!isDealGanadoStage(deal.dealStage)) {
      excluidos.push({ ...row, motivo: 'deal_no_ganado' });
    } else if (row.finDelContrato && row.finDelContrato < hoy) {
      // El contrato tiene que estar VIGENTE al día de hoy: ajustar el precio de
      // algo que ya terminó no cambia nada y ensucia la lista.
      excluidos.push({ ...row, motivo: 'contrato_vencido' });
    } else if (row.price == null || Number.isNaN(row.price)) {
      excluidos.push({ ...row, motivo: 'sin_precio' });
    } else {
      elegibles.push(row);
    }
  }
  return { productoId: IJSERV_PRODUCT_ID, elegibles, excluidos };
}

/**
 * Cuenta, por line item, los tickets ya promovidos con fecha futura que
 * conservarán el precio viejo (Phase P no re-snapshotea los protegidos).
 * @returns Map(lineItemId -> {count, stages: [..]})
 */
export async function contarTicketsProtegidosFuturos(lineItemIds) {
  const out = new Map();
  const hoy = hoyMvd();
  const stagesProtegidos = [
    PROXIMOS_A_FACTURAR_STAGE,
    TICKET_STAGE_LISTO_MANUAL,
    BILLING_AUTOMATED_READY,
  ].filter(Boolean);

  for (const liId of lineItemIds) {
    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: stagesProtegidos.map(stage => ({
          filters: [
            { propertyName: 'of_line_item_ids', operator: 'CONTAINS_TOKEN', value: String(liId) },
            { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stage },
            { propertyName: 'fecha_resolucion_esperada', operator: 'GTE', value: hoy },
          ],
        })),
        properties: ['hs_pipeline_stage'],
        limit: 100,
      });
      const results = resp?.results || [];
      if (results.length) {
        out.set(String(liId), {
          count: results.length,
          stages: [...new Set(results.map(t => t.properties?.hs_pipeline_stage))],
        });
      }
    } catch (err) {
      logger.warn({ module: MOD, fn: 'contarTicketsProtegidosFuturos', liId, err: err?.message },
        'No se pudo contar tickets protegidos — se omite advertencia para este LI');
    }
  }
  return out;
}

/**
 * Cuenta, por line item, cuántos PAGOS del período quedaron al precio viejo:
 * los tickets cuya fecha de facturación está entre el mes del ajuste y hoy.
 *
 * La regla es POR FECHA, no por estado (definición de la usuaria, 4-ago-2026):
 * el ticket ES la factura, y su fecha ya contempla el momento de facturación.
 * Por eso el mes en curso cuenta o no según qué día factura ese line item:
 *
 *   · adelantado / mes vencido → caen el 1°, así que el mes en curso SIEMPRE
 *     cuenta como retroactivo, aunque hoy sea el 1°.
 *   · fin de mes → es el único caso relativo: cuenta sólo si el día que factura
 *     este mes ya pasó. A mitad de mes, el de este mes todavía no salió y va a
 *     salir ya ajustado, así que no cuenta.
 *
 * Comparar la fecha del ticket con hoy resuelve los dos casos sin recalcular
 * ningún calendario. Los CANCELADOS no cuentan (no hubo factura) y las notas
 * de crédito tampoco.
 *
 * Aparte se informan los `sinFacturar`: tickets del período que todavía no
 * llegaron a una etapa de facturado. Cuentan igual —su precio ya está fijado—
 * pero se avisan en el preview por si hay que mirarlos.
 *
 * @param {string[]} lineItemIds
 * @param {string} desde  YYYY-MM-DD (primer día del mes del ajuste)
 * @param {string} [hasta] YYYY-MM-DD (default: hoy)
 * @param {object} [deps] inyectable para los tests
 * @returns {Promise<Map<string, {pagos:number, sinFacturar:number, error?:string}>>}
 */
export async function contarPagosDelPeriodo(
  lineItemIds, desde, hasta = hoyMvd(),
  { stagesFacturados = INVOICED_STAGES, esCancelado = isCancelledTicketStage } = {}
) {
  const out = new Map();
  const facturados = new Set([...stagesFacturados].filter(Boolean));

  for (const liId of lineItemIds) {
    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: 'of_line_item_ids', operator: 'CONTAINS_TOKEN', value: String(liId) },
            { propertyName: 'fecha_resolucion_esperada', operator: 'GTE', value: desde },
            { propertyName: 'fecha_resolucion_esperada', operator: 'LTE', value: hasta },
          ],
        }],
        properties: ['hs_pipeline_stage', 'fecha_resolucion_esperada', 'nc'],
        limit: 100,
      });
      const tickets = (resp?.results || []).filter(t =>
        t.properties?.nc !== 'true' && !esCancelado(t.properties?.hs_pipeline_stage)
      );
      out.set(String(liId), {
        pagos: tickets.length,
        sinFacturar: tickets.filter(t => !facturados.has(t.properties?.hs_pipeline_stage)).length,
      });
    } catch (err) {
      logger.warn({ module: MOD, fn: 'contarPagosDelPeriodo', liId, err: err?.message },
        'No se pudieron contar los pagos del período — el LI queda sin retroactivo');
      out.set(String(liId), { pagos: 0, sinFacturar: 0, error: err?.message || 'error' });
    }
  }
  return out;
}

/**
 * Cuenta, por line item, las facturas que YA SALIERON con el precio ajustado.
 * Se usa al revertir: revertir el precio no deshace una factura emitida, eso
 * se corrige con nota de crédito. Sirve para el listado de reversas que
 * quedaron con facturas emitidas.
 *
 * @param {string[]} lineItemIds
 * @param {string} desde  YYYY-MM-DD — la fecha en que se aplicó el ajuste
 * @returns {Promise<Map<string, number>>}
 */
export async function contarFacturasEmitidasDesde(lineItemIds, desde, hasta = hoyMvd()) {
  const out = new Map();
  const facturados = new Set([...INVOICED_STAGES].filter(Boolean));
  if (!desde) return out;

  for (const liId of lineItemIds) {
    try {
      const resp = await hubspotClient.crm.tickets.searchApi.doSearch({
        filterGroups: facturados.size
          ? [...facturados].map(stage => ({
              filters: [
                { propertyName: 'of_line_item_ids', operator: 'CONTAINS_TOKEN', value: String(liId) },
                { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stage },
                { propertyName: 'fecha_resolucion_esperada', operator: 'GTE', value: desde },
                { propertyName: 'fecha_resolucion_esperada', operator: 'LTE', value: hasta },
              ],
            }))
          : [],
        properties: ['hs_pipeline_stage', 'fecha_resolucion_esperada'],
        limit: 100,
      });
      const n = (resp?.results || []).length;
      if (n) out.set(String(liId), n);
    } catch (err) {
      logger.warn({ module: MOD, fn: 'contarFacturasEmitidasDesde', liId, err: err?.message },
        'No se pudieron contar las facturas emitidas — la reversa no queda marcada');
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// Escritura
// ────────────────────────────────────────────────────────────

// Asociación line item → deal (HUBSPOT_DEFINED), igual que en el mirroring.
const LINE_ITEM_TO_DEAL_ASSOC_ID = 20;

// Props que el puntual hereda del line item ajustado para que el motor y los
// tickets lo traten igual (área, rubro, entidad que factura, responsable…).
// NO se heredan las de recurrencia: el retroactivo es de PAGO ÚNICO, y en este
// motor pago único = sin frecuencia + fecha de inicio (billingEngine.js:518).
// Los IMPUESTOS salen de acá: `hs_tax_rate_group_id` es lo que define el IVA
// del line item (phase1.js:209) y `exonera_irae` va aparte. El precio que se
// escribe es NETO, igual que en todo el motor: el impuesto lo aplica HubSpot.
const PROPS_HEREDADAS_RETRO = [
  'area', 'servicio', 'subrubro', 'unidad_de_negocio', 'nombre_empresa',
  'nombre_producto', 'hs_product_id', 'empresa_que_factura', 'of_moneda',
  'pais_operativo', 'uy', 'responsable_asignado', 'hubspot_owner_id',
  'momento_de_facturacion', 'facturacion_automatica', 'dolar',
  'hs_tax_rate_group_id', 'exonera_irae',
];

/**
 * Crea el line item «Ajuste retroactivo» en el mismo negocio, enganchado a la
 * próxima fecha de facturación del line item ajustado.
 *
 * Es un MONTO ÚNICO: cantidad 1 y precio = la diferencia acumulada de todos
 * los pagos, en moneda original y sin impuestos.
 *
 * @returns {Promise<{id:string|null, dryRun:boolean}>}
 */
export async function crearLineItemRetroactivo({
  origen, dealId, importe, fecha, descripcion,
}) {
  const p = origen.properties || origen || {};
  const properties = {
    name: NOMBRE_LI_RETRO,
    description: descripcion,
    price: String(importe),
    quantity: '1',
    // Pago único: SIN frecuencia, con fecha de inicio. El motor lo factura una
    // vez y después deja billing_next_date vacío (billingEngine.js, "2) Pago
    // único (con startDate)"). La frecuencia NO se manda: se deja ausente en
    // vez de mandarla vacía, porque es un select y un '' en el create da 400.
    hs_recurring_billing_start_date: fecha,
    fecha_inicio_de_facturacion: fecha,
    billing_next_date: fecha,
    facturacion_activa: 'true',
    // El ajuste no tiene costo propio: el margen es 100% para que no ensucie
    // el costo/margen del negocio.
    hs_cost_of_goods_sold: '0',
    costo_total_usd: '0',
    nota: NOTA_LI_RETRO,
  };

  for (const key of PROPS_HEREDADAS_RETRO) {
    if (p[key] != null && p[key] !== '') properties[key] = String(p[key]);
  }

  if (isDryRun()) {
    logger.info({ module: MOD, fn: 'crearLineItemRetroactivo', dealId, properties },
      '[DRY_RUN] create de line item retroactivo omitido');
    return { id: null, dryRun: true };
  }

  const resp = await hubspotClient.crm.lineItems.basicApi.create({
    properties,
    associations: [{
      to: { id: String(dealId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: LINE_ITEM_TO_DEAL_ASSOC_ID }],
    }],
  });
  return { id: String(resp.id), dryRun: false };
}

/**
 * Da de baja un line item retroactivo al revertir el lote.
 * Se archiva (no se desactiva) porque nunca debió existir: si el motor ya le
 * armó un ticket, el archivado dispara la cancelación del forecast como con
 * cualquier line item borrado.
 */
export async function archivarLineItemRetroactivo(lineItemId) {
  if (isDryRun()) {
    logger.info({ module: MOD, fn: 'archivarLineItemRetroactivo', lineItemId }, '[DRY_RUN] archive omitido');
    return;
  }
  await hubspotClient.crm.lineItems.basicApi.archive(String(lineItemId));
}

/**
 * Lee el price actual de un LI (para verificar que no cambió desde el preview).
 * Trae además TODAS las props del line item: el ajuste retroactivo necesita
 * heredarlas para crear el puntual, y así no hace falta una segunda lectura.
 */
export async function leerPriceActual(lineItemId) {
  const li = await hubspotClient.crm.lineItems.basicApi.getById(String(lineItemId), LI_PROPS);
  const p = li?.properties || {};
  return {
    price: p.price != null && p.price !== '' ? Number(p.price) : null,
    montoUnitarioOriginal: p.monto_unitario_original || null,
    proximaFecha: (p.billing_next_date || '').toString().slice(0, 10) || null,
    cantidad: p.quantity != null && p.quantity !== '' ? Number(p.quantity) : 1,
    props: p,
  };
}

/**
 * Aplica el ajuste a UN line item: price nuevo + props de rastreo.
 * monto_unitario_original solo se setea si estaba vacío (primer ajuste).
 */
export async function aplicarAjusteLineItem({ lineItemId, priceViejo, priceNuevo, pct, montoUnitarioOriginal }) {
  const properties = {
    price: String(priceNuevo),
    fecha_ultimo_ajuste: hoyMvd(),
    porcentaje_ultimo_ajuste: String(pct),
  };
  if (montoUnitarioOriginal == null || montoUnitarioOriginal === '') {
    properties.monto_unitario_original = String(priceViejo);
  }
  if (isDryRun()) {
    logger.info({ module: MOD, fn: 'aplicarAjusteLineItem', lineItemId, properties }, '[DRY_RUN] update omitido');
    return;
  }
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties });
}

/**
 * Revierte UN line item al price_viejo guardado en DB.
 */
export async function revertirLineItem({ lineItemId, priceViejo }) {
  const properties = {
    price: String(priceViejo),
    fecha_ultimo_ajuste: hoyMvd(),
  };
  if (isDryRun()) {
    logger.info({ module: MOD, fn: 'revertirLineItem', lineItemId, properties }, '[DRY_RUN] update omitido');
    return;
  }
  await hubspotClient.crm.lineItems.basicApi.update(String(lineItemId), { properties });
}
