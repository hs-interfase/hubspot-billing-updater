// exportReporte.mjs
// Script standalone para exportar reporte consolidado de Deals + Line Items + Tickets
// Uso: node exportReporte.mjs [--pipeline <pipelineId>]
// Requiere: HUBSPOT_PRIVATE_TOKEN y DATABASE_URL en .env o variable de entorno

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import ExcelJS from 'exceljs';
import { getDolar } from '../../src/services/fxService.js';
import { resolverEntidadFacturadora } from '../../src/services/billing/resolverEntidadFacturadora.js';
import { lastBusinessDayOfMonth, formatDateISO } from '../../src/utils/dateUtils.js';

// ── Config ──
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

const hubspot = new Client({ accessToken: TOKEN });

// Association type IDs (deal → company)
// Etiquetas por portal (mismos envs que el motor): Empresa Factura prod=9 / sandbox=2 · Partner prod=2 / sandbox=3.
const ASSOC_PRIMARY_COMPANY = 5;
const ASSOC_EMPRESA_FACTURA = parseInt(process.env.ASSOC_LABEL_EMPRESA_FACTURA || '9', 10);
const ASSOC_PARTNER = parseInt(process.env.ASSOC_LABEL_EMPRESA_PARTNER || '2', 10);

// Probabilidad de corte para separar hojas
const PROB_CORTE = 0.85;

// ── Stage sets para clasificación de tickets ──
const LISTO_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_READY,
  process.env.BILLING_AUTOMATED_READY,
].filter(Boolean));

const INVOICED_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_ID_BILLED,
  process.env.BILLING_TICKET_STAGE_ID_CREATED,
  process.env.BILLING_TICKET_STAGE_ID_LATE,
  process.env.BILLING_TICKET_PIPELINE_ID_PAID,
  process.env.BILLING_AUTOMATED_CREATED,
  process.env.BILLING_AUTOMATED_LATE,
  process.env.BILLING_AUTOMATED_PAID,
].filter(Boolean));

// NOTA: estadoBacklog() se elimino — quedo sin llamadores cuando la clasificacion
// Backlog/Facturado paso a resolverse inline (tieneFactura || INVOICED_STAGES -> Facturado).

// ── Helpers ──
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const safe = (v) => (v ?? '').toString().trim();
const safeNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const ymd = (v) => safe(v).slice(0, 10);

function mesAnio(fechaStr) {
  const d = ymd(fechaStr);
  if (!d || d.length < 7) return { mes: '', anio: '' };
  const [y, m] = d.split('-');
  return { mes: m, anio: y };
}

function esRenovacionAutomatica(fechaVenc) {
  const d = ymd(fechaVenc);
  return d.startsWith('2099') ? 'SI' : 'NO';
}

function esRepetitivo(freq) {
  const f = safe(freq).toLowerCase();
  return f && !['unico', 'único', 'pago único', 'pago unico', 'one_time', ''].includes(f) ? 'SI' : 'NO';
}

// Fecha a dd/mm/yyyy para las columnas visibles (mesAnio sigue usando ymd internamente).
const dmy = (v) => {
  const d = ymd(v);
  if (!d || d.length < 10) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
};

// Probabilidad 0..1 → "NN%".
const pct = (v) => { const n = safeNum(v); return n == null ? '' : `${Math.round(n * 100)}%`; };

// Frecuencia de facturación → etiqueta en español (los LIs guardan códigos en inglés).
// Pedido Paola 21-jul: mostrar los mismos labels del editor de LI (mensual/pago único...),
// nunca el código en inglés.
const FREQ_ES = {
  weekly: 'Semanal', biweekly: 'Quincenal', monthly: 'Mensual', quarterly: 'Trimestral',
  per_six_months: 'Semestral', annually: 'Anual', per_two_years: 'Bienal',
  per_three_years: 'Trienal', per_four_years: 'Cada 4 años', per_five_years: 'Cada 5 años',
  one_time: 'Pago único',
};
const frecuenciaLI = (raw) => FREQ_ES[safe(raw)] || (safe(raw) || 'Pago único');
// El ticket sella 'Único' (vocabulario del snapshot); en el reporte se muestra igual
// que el label del LI para que la columna sea homogénea en los 3 CSV.
const frecuenciaDisplay = (v) => (safe(v) === 'Único' ? 'Pago único' : safe(v));

// La columna "Valor del Dólar" es INFORMATIVA (dólares a pesos): si el TC sellado es 1
// (fila en USD, getDolar('USD')=1) o falta, se muestra el TC del DÍA — UYU, o PYG si el
// país operativo es Paraguay. Si tampoco hay TC del día, queda el sellado (peor es nada).
// ⚠️ DEFINICIÓN 23-jul (explicar al cliente): el TC del día es un PLACEHOLDER. El valor
// definitivo lo va a mandar el equipo POR NEGOCIO (prop `dolar` del deal, que ya tiene
// prioridad como TC sellado); los tickets YA FACTURADOS traen su propio TC real de Nodum
// (prop `dolar` del ticket, pisada al facturar). Cuando el dólar del negocio esté cargado,
// este fallback al TC del día deja de aparecer solo.
// Orden de preferencia (decisión usuaria 30-jul):
//   1. `tc_pesos` del NEGOCIO — TC a pesos (UYU/PYG por país operativo) CONGELADO en el
//      alta y en el cierre-ganado. Es la respuesta al pedido de Paola ("el TC vigente al
//      día que corresponda", 21-jul). Lo escribe `ensureDealDolar`.
//   2. El TC sellado de la fila, si NO es 1 (un negocio en pesos ya lo trae bien).
//   3. El TC de HOY — último recurso para negocios viejos sin `tc_pesos` todavía.
// 🔴 Esta columna es INFORMATIVA: nunca multiplica ni divide montos.
function tcInformativo(tcSellado, pais, rates, tcPesosDeal) {
  if (tcPesosDeal != null && tcPesosDeal > 0) return tcPesosDeal;
  if (tcSellado != null && tcSellado !== 1) return tcSellado;
  const dia = safe(pais).toLowerCase() === 'paraguay' ? rates?.PYG : rates?.UYU;
  return dia != null ? dia : tcSellado;
}

// ── Intercompany (definición Paola 22-jul) ──────────────────────────────────
// "Dentro de Uruguay se facturan entre sí": el CLIENTE que recibe la factura es ISA
// Uruguay o Interfase Uruguay y la EMITE otra empresa del grupo. Detección por NOMBRE
// del Cliente Factura contra el registro de empresas. Ajustable sin código con
// EXPORT_INTERCO_CLIENTES (nombres separados por ;).
//
// ⚠️ CORREGIDO 30-jul: el default viejo era 'ISA URUGUAY;INTERFASE URUGUAY' y NO matcheaba
// NUNCA. Esas dos empresas SÍ existen en el CRM, pero con OTRO nombre — "ISA LTDA" y
// "INTERFASE S.A." (verificado por API). Como el match es por substring, la columna
// quedaba en NO incluso en casos genuinos. Los nombres viejos quedan como alias
// inofensivos por si algún día las renombran.
const normEmp = (s) => safe(s).toUpperCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ⚠️ Los nombres DIFIEREN por portal (verificado por API 30-jul): en PROD la empresa es
// "Interfase" a secas; en sandbox es "INTERFASE S.A.". El token corto 'INTERFASE' cubre
// las dos (el match es por substring). ISA UY es "ISA LTDA" en sandbox y NO EXISTE aún
// en PROD — hasta que se cree, ninguna fila con ISA UY de cliente puede marcar SI.
const INTERCO_CLIENTES_UY = (process.env.EXPORT_INTERCO_CLIENTES
  || 'ISA LTDA;ISA URUGUAY;INTERFASE')
  .split(';').map((s) => normEmp(s)).filter(Boolean);

// El match es por substring: un token corto de más (p.ej. 'ISA' solo) haría entrar
// clientes ajenos como "INDUFAR CISA" → mantener los tokens largos.
// Y las entidades del grupo en PARAGUAY NO son intercompany (la definición es UY↔UY):
// se excluyen explícitamente en vez de depender de que el punto final de "INTERFASE S.A."
// sea lo único que las separa de "INTERFASE S.A SUCURSAL PARAGUAY".
const INTERCO_EXCLUIR = (process.env.EXPORT_INTERCO_EXCLUIR || 'PARAGUAY')
  .split(';').map((s) => normEmp(s)).filter(Boolean);

function esFilaIntercompany(row) {
  // El cliente que RECIBE la factura: la empresa con etiqueta "Empresa Factura" si existe;
  // si no, la Primary — que en ese caso ES el cliente facturado (la mayoría de los negocios
  // sólo tienen Primary). ⚠️ Sin este fallback la detección moría acá: el caso real de PROD
  // ("Portal Barbados", cliente Interfase, emite ISA UY) tiene la empresa como Primary(5),
  // NO como Empresa Factura(9) → 'Cliente Factura' venía vacío y nunca marcaba (30-jul).
  const cli = normEmp(row['Cliente Factura']) || normEmp(row['Cliente Beneficiario']);
  if (!cli) return false;
  if (INTERCO_EXCLUIR.some((x) => cli.includes(x))) return false;
  const token = INTERCO_CLIENTES_UY.find((t) => cli.includes(t));
  if (!token) return false;
  // "la entidad facturadora es LA OTRA": si la emisora es la misma empresa que recibe,
  // no es intercompany. Emisora vacía → cuenta igual (el cliente ya es del grupo).
  const propia = token.startsWith('ISA') ? 'ISA UY' : 'INTERFASE UY';
  return normEmp(row['Entidad Facturadora']) !== propia;
}

// Momento de facturación → etiqueta legible.
const MOMENTO_ES = { adelantado: 'Adelantado', fin_de_mes: 'Fin de mes', vencido: 'Vencido' };
const momentoLabel = (raw) => MOMENTO_ES[safe(raw)] || safe(raw);

// Fecha estimada para filas armadas desde el LINE ITEM (fallback de Forecast sin ticket).
// La fecha buena la calcula el MOTOR en el ticket (anchor-based, fecha_resolucion_esperada);
// acá solo se proyecta la base (ancla → inicio) según momento_de_facturacion:
//   adelantado → día 1 del mes · fin_de_mes → último día HÁBIL (regla fin-de-mes 2026-06,
//   misma función del motor) · vencido/otro → la base tal cual.
function fechaEstimadaLI(lp) {
  const base = ymd(lp.billing_anchor_date || lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion);
  if (!base) return '';
  const momento = safe(lp.momento_de_facturacion).toLowerCase();
  if (momento === 'adelantado') return `${base.slice(0, 7)}-01`;
  if (momento === 'fin_de_mes') {
    const [y, m] = base.split('-').map(Number);
    return formatDateISO(lastBusinessDayOfMonth(new Date(y, m - 1, 15)));
  }
  return base;
}

// ── TC helpers ──────────────────────────────────────────────────────────────

// NOTA: aca vivian getLatestExchangeRate(), convertToUSD() y getTCForCurrency(),
// que convertian a USD con el "TC del dia" de exchange_rates. Se eliminaron al pasar
// el reporte al dolar SELLADO por negocio/ticket (prop `dolar`). El cron cronExchangeRates,
// que puebla esa tabla, sigue funcionando sin cambios.

// ── Rate-limited API helpers ──
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 110) await sleep(110 - diff);
  lastCall = Date.now();
}

// ── HubSpot data fetching ──

const DEAL_PROPS = [
  'dealname', 'dealstage', 'deal_currency_code', 'hubspot_owner_id',
  'pais_operativo', 'unidad_de_negocio', 'pipeline',
  'facturacion_activa', 'closedate', 'hs_deal_stage_probability',
  'deal_py_origen_id', 'deal_uy_mirror_id', 'es_mirror_de_py',
  'dolar', 'tc_pesos', 'tipo_de_venta',
  // condiciones_de_pago NO va acá: en el DEAL nunca existió (se pedía y HubSpot la
  // ignoraba en silencio → columna siempre vacía). Vive en el LINE ITEM (creada 23-jul).
];

const LI_PROPS = [
  'name', 'description', 'price', 'hs_cost_of_goods_sold', 'quantity', 'amount',
  'costo_total_usd', 'dolar', 'monto_usd', 'margen_usd',
  'hs_line_item_currency_code', 'mig_moneda',
  'discount', 'hs_discount_percentage', 'hs_margin',
  'facturacion_activa', 'facturacion_automatica',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'fecha_vencimiento_contrato', 'billing_anchor_date', 'facturas_restantes',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'hs_product_id', 'line_item_key', 'of_line_item_key',
  'servicio', 'subrubro', 'reventa', 'porcentaje_margen',
  'uy', 'pais_operativo', 'hubspot_owner_id', 'empresa_que_factura',
  'momento_de_facturacion', 'area', 'condiciones_de_pago',
];

const TICKET_PROPS = [
  'of_ticket_key', 'of_line_item_key', 'of_deal_id', 'of_estado',
  'fecha_resolucion_esperada', 'hs_pipeline_stage', 'hs_pipeline',
  'of_producto_nombres', 'of_descripcion_producto', 'content', 'observaciones',
  'of_rubro', 'of_subrubro', 'reventa', 'of_costo', 'of_costo_usd', 'of_margen',
  'of_facturacion_usd', 'of_margen_usd', 'entidad_facturadora',
  'subtotal_real', 'total_real_a_facturar', 'numero_de_factura', 'dolar',
  'of_pais_operativo', 'of_moneda', 'momento_de_facturacion', 'area',
  'of_frecuencia_de_facturacion',
  'nombre_empresa', 'empresa_id', 'empresa_que_factura', 'cliente_partner',
];

async function fetchAllDeals(pipelineFilter) {
  const deals = [];
  let after = undefined;

  const filters = [];
  if (pipelineFilter) {
    filters.push({ propertyName: 'pipeline', operator: 'EQ', value: pipelineFilter });
  }

  while (true) {
    await rateLimit();
    const body = {
      ...(filters.length ? { filterGroups: [{ filters }] } : {}),
      properties: DEAL_PROPS,
      limit: 100,
      sorts: [{ propertyName: 'dealname', direction: 'ASCENDING' }],
      ...(after ? { after } : {}),
    };

    const resp = await hubspot.crm.deals.searchApi.doSearch(body);
    const results = resp?.results || [];
    deals.push(...results);

    after = resp?.paging?.next?.after;
    if (!after || results.length === 0) break;

    console.log(`  Deals fetched: ${deals.length}...`);
  }

  return deals;
}

async function fetchLineItems(dealId) {
  await rateLimit();
  let liIds = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', 100);
    liIds = (resp.results || []).map(r => String(r.toObjectId));
  } catch { return []; }

  if (!liIds.length) return [];

  const items = [];
  for (let i = 0; i < liIds.length; i += 100) {
    await rateLimit();
    const resp = await hubspot.crm.lineItems.batchApi.read({
      inputs: liIds.slice(i, i + 100).map(id => ({ id })),
      properties: LI_PROPS,
    });
    items.push(...(resp?.results || []));
  }
  return items;
}

async function fetchDealCompaniesWithTypes(dealId) {
  await rateLimit();
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'companies', 100);
    return resp.results || [];
  } catch { return []; }
}

const companyCache = new Map();
async function fetchCompany(companyId) {
  if (companyCache.has(companyId)) return companyCache.get(companyId);
  await rateLimit();
  try {
    const c = await hubspot.crm.companies.basicApi.getById(String(companyId), ['name']);
    companyCache.set(companyId, c);
    return c;
  } catch {
    companyCache.set(companyId, null);
    return null;
  }
}

const ownerCache = new Map();
async function fetchOwnerName(ownerId) {
  if (!ownerId) return '';
  if (ownerCache.has(ownerId)) return ownerCache.get(ownerId);
  await rateLimit();
  try {
    const resp = await hubspot.apiRequest({ method: 'GET', path: `/crm/v3/owners/${ownerId}` });
    const data = await resp.json();
    const name = `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.email || '';
    ownerCache.set(ownerId, name);
    return name;
  } catch {
    ownerCache.set(ownerId, '');
    return '';
  }
}

const productCache = new Map();
async function fetchProductName(productId) {
  if (!productId) return '';
  if (productCache.has(productId)) return productCache.get(productId);
  await rateLimit();
  try {
    const p = await hubspot.crm.products.basicApi.getById(String(productId), ['name']);
    const name = p?.properties?.name || '';
    productCache.set(productId, name);
    return name;
  } catch {
    productCache.set(productId, '');
    return '';
  }
}

async function fetchTicketsForDeal(dealId) {
  const tickets = [];
  let after = undefined;

  while (true) {
    await rateLimit();
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: TICKET_PROPS,
      limit: 100,
      ...(after ? { after } : {}),
    };

    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    const results = resp?.results || [];
    tickets.push(...results);

    after = resp?.paging?.next?.after;
    if (!after || results.length === 0) break;
  }

  return tickets;
}

// ── Resolve helpers ──

async function resolveDealCompanies(dealId) {
  const assocs = await fetchDealCompaniesWithTypes(dealId);
  let primaryId = null, facturaId = null, partnerId = null;

  for (const a of assocs) {
    const cId = String(a.toObjectId);
    const types = a.associationTypes || [];
    for (const t of types) {
      const tid = t.typeId ?? t.associationTypeId;
      if (tid === ASSOC_EMPRESA_FACTURA) facturaId = cId;
      else if (tid === ASSOC_PARTNER) partnerId = cId;
      else if (tid === ASSOC_PRIMARY_COMPANY) primaryId = cId;
    }
    if (!primaryId && types.length === 0) primaryId = cId;
  }
  if (!primaryId && assocs.length > 0) primaryId = String(assocs[0].toObjectId);

  const [primary, factura, partner] = await Promise.all([
    primaryId ? fetchCompany(primaryId) : null,
    facturaId ? fetchCompany(facturaId) : null,
    partnerId ? fetchCompany(partnerId) : null,
  ]);

  return {
    beneficiario: { id: primaryId || '', nombre: primary?.properties?.name || '' },
    factura: { id: facturaId || '', nombre: factura?.properties?.name || '' },
    partner: { id: partnerId || '', nombre: partner?.properties?.name || '' },
  };
}

const stageCache = new Map();
async function resolveStageLabel(pipelineId, stageId) {
  const key = `${pipelineId}::${stageId}`;
  if (stageCache.has(key)) return stageCache.get(key);

  if (!stageCache.has('__pipelines_loaded__')) {
    await rateLimit();
    try {
      const pipelines = await hubspot.crm.pipelines.pipelinesApi.getAll('deals');
      for (const p of pipelines?.results || []) {
        for (const s of p.stages || []) {
          stageCache.set(`${p.id}::${s.id}`, s.label);
        }
      }
    } catch (e) {
      console.warn('  Warn: no se pudieron cargar pipelines', e.message);
    }
    stageCache.set('__pipelines_loaded__', true);
  }

  return stageCache.get(key) || stageId;
}

// ── Build rows ──

function buildDealBase(deal, companies, ownerName) {
  const dp = deal.properties || {};
  return {
    'Cliente Beneficiario': companies.beneficiario.nombre,
    'ID Cliente Beneficiario': companies.beneficiario.id,
    // "Cliente Factura" = la empresa que RECIBE y paga la factura (renombre 22-jul;
    // antes "Empresa Factura"). No confundir con 'Entidad Facturadora' (quien emite).
    'Cliente Factura': companies.factura.nombre,
    'ID Cliente Factura': companies.factura.id,
    'Partner': companies.partner.nombre,
    'ID Partner': companies.partner.id,
    'Negocio': safe(dp.dealname),
    'ID Negocio': deal.id,
    'Ejecutivo Asignado': ownerName,
    'País Operativo': safe(dp.pais_operativo),
    'Ciclo de Negocio': '',
    'Tipo de Venta': safe(dp.tipo_de_venta), // ítem 139: prop creada el 20-jul en ambos portales
    'Probabilidad': pct(dp.hs_deal_stage_probability),
    'Fecha de Cierre': dmy(dp.closedate),
    'Moneda': safe(dp.deal_currency_code),
    // 'Condiciones de Pago' se llena en las filas (viene del LINE ITEM desde el 23-jul).
    // Se decide POR FILA en marcarIntercompany (definición 22-jul); acá solo el default.
    'Intercompany': 'NO',
    // Dólar congelado del negocio (no es columna: la usan las filas como fallback del TC).
    '__dolarNegocio': safeNum(dp.dolar),
    // TC informativo a pesos congelado en el negocio (30-jul). Las filas de TICKET no
    // tienen el deal en scope, sólo dealBase → viaja por acá.
    '__tcPesosNegocio': safeNum(dp.tc_pesos),
  };
}

function buildLineItemRow(li, dealBase, deal, productName, latestRates) {
  const lp = li.properties || {};
  const freq = safe(lp.recurringbillingfrequency || lp.hs_recurring_billing_frequency);
  const fechaInicio = ymd(lp.hs_recurring_billing_start_date || lp.fecha_inicio_de_facturacion);
  const fechaVenc = ymd(lp.fecha_vencimiento_contrato);
  const esAuto = safe(lp.facturacion_automatica).toLowerCase() === 'true';
  const incluyeUY = safe(lp.uy).toLowerCase() === 'true';
  // Fecha estimada proyectada por momento_de_facturacion (antes mostraba el inicio de
  // contrato tal cual — bug commercial controller 23-jul). Solo aplica al FALLBACK sin
  // ticket: las filas desde ticket traen fecha_resolucion_esperada del motor.
  const fechaFact = fechaEstimadaLI(lp);
  const { mes, anio } = mesAnio(fechaFact);

  const monto = safeNum(lp.amount);
  // Definición 2026-07-07: costo_total_usd = fuente de verdad (total, USD).
  // Costo (moneda del negocio) = costo_total_usd × dolar(LI); fallback legacy cogs × qty.
  const costoUsdFuente = safeNum(lp.costo_total_usd);
  const dolarLi = safeNum(lp.dolar);
  const costo = (costoUsdFuente != null && dolarLi > 0)
    ? costoUsdFuente * dolarLi
    : safeNum(lp.hs_cost_of_goods_sold) != null
      ? safeNum(lp.hs_cost_of_goods_sold) * (safeNum(lp.quantity) || 1)
      : (costoUsdFuente != null ? costoUsdFuente : null); // sin dolar: al menos en deals USD es el valor correcto
  const margenBruto = (monto != null && costo != null) ? monto - costo : null;
  // Margen %: ELIMINADA (23-jul) — mostraba valores absurdos (of_margen absoluto en las
  // filas de ticket) y el cliente pidió sacarla, no recalcularla.

  // Moneda REAL del line item (hs_line_item_currency_code / mig_moneda); NO la "home currency"
  // del negocio (que en HubSpot es USD para todos y ocultaba PYG/UYU).
  const moneda = safe(lp.hs_line_item_currency_code) || safe(lp.mig_moneda) || dealBase['Moneda'];
  const esUSD = safe(moneda).toUpperCase() === 'USD';
  // Columna "Dólar" = TC de dólares a pesos (pedido Paola 21-jul), NO el TC aplicado a la
  // conversión de la fila. Dólar del LI, fallback dólar congelado del negocio. En filas
  // USD el sellado vale 1 (getDolar('USD')=1) y NO es un TC a pesos → se muestra el TC
  // del día (UYU; PYG si el país operativo es Paraguay). Sin dato → queda el sellado.
  const dealDolar = safeNum(deal.properties?.dolar);
  const tcSellado = dolarLi != null ? dolarLi : dealDolar;
  const tc = tcInformativo(tcSellado, dealBase['País Operativo'], latestRates, safeNum(deal.properties?.tc_pesos));
  // Columnas USD = props CALCULADAS de HubSpot (monto_usd/margen_usd usan el dólar asignado).
  // Fallback USD→valor en moneda (la fórmula monto_usd divide por `dolar`, que en USD puede faltar).
  const montoUSD = safeNum(lp.monto_usd) != null ? safeNum(lp.monto_usd) : (esUSD ? monto : null);
  const costoUSD = costoUsdFuente != null ? costoUsdFuente : (esUSD ? costo : null);
  const margenBrutoUSD = safeNum(lp.margen_usd) != null
    ? safeNum(lp.margen_usd)
    : (montoUSD != null && costoUSD != null ? Math.round((montoUSD - costoUSD) * 100) / 100 : null);

  return {
    ...dealBase,
    'Moneda': moneda,
    'Rubro': safe(lp.servicio),
    // Área de Negocio = prop `area` del LI (regla por país); fallback producto/nombre.
    'Área de Negocio': safe(lp.area) || productName || safe(lp.name),
    'Descripción Producto': safe(lp.description),
    // Entidad del grupo que EMITE la factura (Interfase UY / ISA UY / ISA PY / Interfase PY).
    // Distinta de 'Cliente Factura', que es la empresa CLIENTE a la que se le factura.
    // Prop del LI; si está vacía (históricos sin backfill) se resuelve AL VUELO con la
    // regla país+producto/área — mismo resolver que escribe el motor (23-jul).
    'Entidad Facturadora': safe(lp.empresa_que_factura) || resolverEntidadFacturadora({
      paisOperativo: deal.properties?.pais_operativo,
      productId: lp.hs_product_id,
      area: lp.area,
    }).valor,
    'Descripción Ticket': '',
    // 21-jul: mensaje_para_responsable se archivó; Observaciones es del ticket (LI vacío).
    'Observaciones': '',
    'Condiciones de Pago': safe(lp.condiciones_de_pago),
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': dmy(fechaFact),
    'Mes': mes, 'Año': anio,
    'Monto en Moneda Original': monto,
    'Costo en Moneda Original': costo,
    'Margen Bruto en Moneda Original': margenBruto,
    'Valor del Dólar': tc,
    'Monto en Dólares': montoUSD,
    'Costo en Dólares': costoUSD,
    'Margen Bruto en Dólares': margenBrutoUSD,
    'Momento de Facturación': momentoLabel(lp.momento_de_facturacion),
    'Repetitivo': esRepetitivo(freq),
    'Reventa': safe(lp.reventa).toLowerCase() === 'true' ? 'SI' : 'NO',
    'Sub Rubro': safe(lp.subrubro),
    'N Factura': '',
    'Facturas Restantes': safe(lp.facturas_restantes), // ítem 133
    'ORIGEN': 'Line Item',
    'Facturación Automática': esAuto ? 'SI' : 'NO',
    // Fechas de contrato SOLO para facturación automática (pedido 23-jul).
    'Fecha Inicio Contrato': esAuto ? dmy(fechaInicio) : '',
    'Frecuencia': frecuenciaLI(freq),
    'Fecha Fin Contrato': esAuto ? dmy(fechaVenc) : '',
    'Renovación Automática': esRenovacionAutomatica(fechaVenc),
  };
}

function buildTicketRow(ticket, dealBase, lineItemMap, productNameMap, latestRates) {
  const tp = ticket.properties || {};
  const lik = safe(tp.of_line_item_key);
  const li = lineItemMap.get(lik);
  const lp = li?.properties || {};

  const fechaFact = ymd(tp.fecha_resolucion_esperada);
  const { mes, anio } = mesAnio(fechaFact);
  // Frecuencia del TICKET (of_frecuencia_de_facturacion, ya en español); fallback al código del LI.
  const freq = safe(tp.of_frecuencia_de_facturacion) || frecuenciaLI(lp?.recurringbillingfrequency);
  const esAuto = safe(lp?.facturacion_automatica || '').toLowerCase() === 'true';
  const fechaInicio = ymd(lp?.hs_recurring_billing_start_date || lp?.fecha_inicio_de_facturacion || '');
  const fechaVenc = ymd(lp?.fecha_vencimiento_contrato || '');
  const incluyeUY = safe(lp?.uy || '').toLowerCase() === 'true';

  const monto = safeNum(tp.subtotal_real);
  const costo = safeNum(tp.of_costo);
  const margenBruto = (monto != null && costo != null) ? monto - costo : null;

  // Moneda: la del TICKET (of_moneda, sellada al crear la OF); fallback moneda del deal.
  const moneda = safe(tp.of_moneda) || dealBase['Moneda'];
  const esUSD = safe(moneda).toUpperCase() === 'USD';
  const tieneFactura = safe(tp.numero_de_factura) !== '';
  // Columna "Dólar" = TC de dólares a pesos (pedido Paola 21-jul), NO el TC aplicado.
  // Dólar sellado del ticket (TC del día en que se facturó/creó la OF), fallback dólar
  // del LI y después el del negocio. En filas USD el sellado vale 1 → TC del día.
  const tcSellado = safeNum(tp.dolar) != null
    ? safeNum(tp.dolar)
    : (safeNum(lp?.dolar) != null ? safeNum(lp?.dolar) : dealBase['__dolarNegocio']);
  const tc = tcInformativo(tcSellado, safe(tp.of_pais_operativo) || dealBase['País Operativo'], latestRates, dealBase['__tcPesosNegocio']);

  // Columnas USD = props CALCULADAS de HubSpot (usan el dólar sellado del ticket).
  const costoUSD = safeNum(tp.of_costo_usd) != null ? safeNum(tp.of_costo_usd) : (esUSD ? costo : null);
  // of_facturacion_usd = 0 con subtotal > 0 ⇒ viene ANULADO por la regla intercompany
  // VIEJA del motor (of_intercompany=true en los espejos). Bajo la definición 22-jul el
  // espejo SÍ factura → recalcular desde el subtotal y el dólar sellado (si la fila es
  // intercompany de verdad, el FACT 0 lo pone marcarIntercompany después).
  const usdAnulado = safeNum(tp.of_facturacion_usd) === 0 && monto != null && monto > 0;
  const montoUSD = (!usdAnulado && safeNum(tp.of_facturacion_usd) != null)
    ? safeNum(tp.of_facturacion_usd)
    : (esUSD ? monto : (tc > 0 && monto != null ? Math.round((monto / tc) * 100) / 100 : null));
  const margenBrutoUSD = (!usdAnulado && safeNum(tp.of_margen_usd) != null)
    ? safeNum(tp.of_margen_usd)
    : (montoUSD != null && costoUSD != null ? Math.round((montoUSD - costoUSD) * 100) / 100 : null);

  return {
    ...dealBase,
    // Empresas: si la etiqueta de asociación todavía no existe (p.ej. estados tempranos),
    // caer a las props que el motor sella en el ticket: nombre_empresa / empresa_id /
    // empresa_que_factura / cliente_partner.
    'Cliente Beneficiario': dealBase['Cliente Beneficiario'] || safe(tp.nombre_empresa),
    'ID Cliente Beneficiario': dealBase['ID Cliente Beneficiario'] || safe(tp.empresa_id),
    // Emisora sellada en el ticket; fallback al select del line item de origen, y si
    // ambos están vacíos (históricos sin backfill) se resuelve AL VUELO con la regla
    // país+producto/área — mismo resolver que escribe el motor (23-jul).
    'Entidad Facturadora': safe(tp.entidad_facturadora) || safe(lp?.empresa_que_factura)
      || resolverEntidadFacturadora({
        paisOperativo: safe(tp.of_pais_operativo) || dealBase['País Operativo'],
        productId: lp?.hs_product_id,
        area: safe(tp.area) || lp?.area,
      }).valor,
    // ⚠️ doble vocabulario: `empresa_que_factura` en el TICKET es la empresa CLIENTE.
    'Cliente Factura': dealBase['Cliente Factura'] || safe(tp.empresa_que_factura),
    'Partner': dealBase['Partner'] || safe(tp.cliente_partner),
    'Moneda': moneda,
    'Rubro': safe(tp.of_rubro || lp?.servicio || ''),
    // Área de Negocio = prop `area` del ticket (snapshot del LI, regla por país); fallback legacy.
    'Área de Negocio': safe(tp.area || lp?.area || '') || productNameMap.get(safe(lp?.hs_product_id)) || safe(tp.of_producto_nombres || lp?.name || ''),
    'Descripción Producto': safe(tp.of_descripcion_producto || lp?.description || ''),
    // 21-jul: la prop `descripcion` del ticket se archivó; el texto operativo vive en `content`.
    'Descripción Ticket': safe(tp.content || ''),
    'Observaciones': safe(tp.observaciones || ''),
    'Condiciones de Pago': safe(lp?.condiciones_de_pago), // del LI de origen (prop creada 23-jul)
    'Incluye UY': incluyeUY ? 'SI' : 'NO',
    'Fecha Fact Estimada': dmy(fechaFact),
    'Mes': mes, 'Año': anio,
    'Monto en Moneda Original': monto,
    'Costo en Moneda Original': costo,
    'Margen Bruto en Moneda Original': margenBruto,
    // Margen %: ELIMINADA (23-jul) — acá iba of_margen crudo (margen ABSOLUTO en moneda
    // original, ej. 12.610) disfrazado de porcentaje. Se saca, no se recalcula.
    'Valor del Dólar': tc,
    'Monto en Dólares': montoUSD,
    'Costo en Dólares': costoUSD,
    'Margen Bruto en Dólares': margenBrutoUSD,
    'Momento de Facturación': momentoLabel(tp.momento_de_facturacion || lp?.momento_de_facturacion),
    'Repetitivo': esRepetitivo(freq),
    'Reventa': safe(tp.reventa || lp?.reventa || '').toLowerCase() === 'true' ? 'SI' : 'NO',
    'Sub Rubro': safe(tp.of_subrubro || lp?.subrubro || ''),
    'N Factura': safe(tp.numero_de_factura),
    'Facturas Restantes': safe(lp?.facturas_restantes), // ítem 133 (del LI de origen)
    'ORIGEN': 'Ticket',
    'Facturación Automática': esAuto ? 'SI' : 'NO',
    // Fechas de contrato SOLO para facturación automática (pedido 23-jul).
    'Fecha Inicio Contrato': esAuto ? dmy(fechaInicio) : '',
    'Frecuencia': frecuenciaDisplay(freq),
    'Fecha Fin Contrato': esAuto ? dmy(fechaVenc) : '',
    'Renovación Automática': esRenovacionAutomatica(fechaVenc),
  };
}

function isValidTicket(ticket) {
  const tp = ticket.properties || {};
  const estado = safe(tp.of_estado).toUpperCase();
  return !['DUPLICADO_UI', 'DEPRECATED'].includes(estado);
}

// ── MAIN ──
async function main() {
  const args = process.argv.slice(2);
  const pipelineIdx = args.indexOf('--pipeline');
  const pipelineFilter = pipelineIdx >= 0 ? args[pipelineIdx + 1] : null;

  console.log('=== Exportando reporte consolidado ===');
  if (pipelineFilter) console.log(`  Pipeline filter: ${pipelineFilter}`);

  // 0) Las conversiones a USD usan el dólar SELLADO (props de HubSpot). El TC del día se
  //    busca SOLO para la columna informativa "Dólar" de las filas USD (sellado = 1, que
  //    no es un TC "de dólares a pesos"): pedido Paola 21-jul, validado usuaria 22-jul.
  //    Vía fxService (BCU/BCP) — sin DB, sigue corriendo local.
  const latestRates = { UYU: null, PYG: null };
  try { latestRates.UYU = await getDolar('UYU'); } catch { /* columna queda con el sellado */ }
  try { latestRates.PYG = await getDolar('PYG'); } catch { /* idem */ }
  console.log(`\n0. TC del día para filas USD (columna Dólar): UYU=${latestRates.UYU ?? '—'} · PYG=${latestRates.PYG ?? '—'}`);

  // 1) Fetch all deals
  console.log('\n1. Descargando deals...');
  const allDeals = await fetchAllDeals(pipelineFilter);
  console.log(`   Total deals: ${allDeals.length}`);

  // 2) Pre-load pipelines
  await resolveStageLabel('', '');

  // 3) Process each deal
  const pipelineRows  = [];
  const forecastRows  = [];
  const listoRows     = [];
  const facturadoRows = [];

  for (let i = 0; i < allDeals.length; i++) {
    const deal = allDeals[i];
    const dp = deal.properties || {};
    const dealId = deal.id;
    const prob = safeNum(dp.hs_deal_stage_probability) ?? 0;

    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(`\n  Procesando deal ${i + 1}/${allDeals.length}: ${safe(dp.dealname)} (prob: ${prob}%)`);
    }

    const stageLabel = await resolveStageLabel(safe(dp.pipeline), safe(dp.dealstage));
    const companies = await resolveDealCompanies(dealId);
    const ownerName = await fetchOwnerName(safe(dp.hubspot_owner_id));

    const dealBase = buildDealBase(deal, companies, ownerName);
    dealBase['Ciclo de Negocio'] = stageLabel;

    // Intercompany POR FILA (definición 22-jul): cliente = ISA/Interfase Uruguay y
    // emisora otra empresa del grupo → FACT 0 (el MB conserva su valor).
    const marcarIntercompany = (row) => {
      if (esFilaIntercompany(row)) {
        row['Intercompany'] = 'SI';
        row['Monto en Moneda Original'] = 0;
        row['Monto en Dólares'] = 0;
      }
      return row;
    };

    const lineItems = await fetchLineItems(dealId);

    const liKeyMap = new Map();
    for (const li of lineItems) {
      const lp = li.properties || {};
      const lik = safe(lp.line_item_key || lp.of_line_item_key);
      if (lik) liKeyMap.set(lik, li);
    }

    const productNameMap = new Map();
    await Promise.all(lineItems.map(async (li) => {
      const productId = safe(li.properties?.hs_product_id);
      if (productId) {
        const name = await fetchProductName(productId);
        productNameMap.set(productId, name);
      }
    }));

    if (prob < PROB_CORTE) {
      // Sub-fuente (columna Estado) por bucket de probabilidad del deal (spec Paola jul-2026).
      const tipoForecast = prob < 0.50 ? 'Forecast' : prob < 0.75 ? 'Forecast en Strech' : 'Forecast Firme';
      // Forecast DESDE TICKETS (definición 23-jul, igual que Backlog): el motor ya crea
      // tickets de forecast para deals en pipeline, y su fecha_resolucion_esperada
      // respeta momento_de_facturacion (la fila desde LI mostraba el inicio de contrato).
      // Fallback: LIs sin ticket emitido → fila desde el LI (ORIGEN = 'Line Item') con
      // fecha proyectada por fechaEstimadaLI.
      const ticketsForecast = (await fetchTicketsForDeal(dealId)).filter(isValidTicket);
      const liKeysConTicket = new Set();
      for (const ticket of ticketsForecast) {
        const row = buildTicketRow(ticket, dealBase, liKeyMap, productNameMap, latestRates);
        const lik = safe(ticket.properties?.of_line_item_key);
        if (lik) liKeysConTicket.add(lik);
        row['FUENTE'] = 'Forecast';
        row['Estado'] = tipoForecast; // sub-fuente: Forecast / Forecast en Strech / Forecast Firme
        pipelineRows.push(marcarIntercompany(row));
      }
      for (const li of lineItems) {
        const lik = safe(li.properties?.line_item_key || li.properties?.of_line_item_key);
        if (lik && liKeysConTicket.has(lik)) continue; // ya cubierto por su(s) ticket(s)
        const productName = productNameMap.get(safe(li.properties?.hs_product_id)) || '';
        const row = buildLineItemRow(li, dealBase, deal, productName, latestRates);
        row['FUENTE'] = 'Forecast';
        row['Estado'] = tipoForecast;
        pipelineRows.push(marcarIntercompany(row));
      }
    } else {
      const tickets = await fetchTicketsForDeal(dealId);
      const validTickets = tickets.filter(isValidTicket);

      for (const ticket of validTickets) {
        const tp = ticket.properties || {};
        const row = buildTicketRow(ticket, dealBase, liKeyMap, productNameMap, latestRates);
        const tieneFactura = safe(tp.numero_de_factura) !== '';
        const stage = safe(tp.hs_pipeline_stage);
        marcarIntercompany(row);

        // Facturado = con nº de factura o en etapas Emitido/Enviado/Atrasado/Cobrado.
        if (tieneFactura || INVOICED_STAGES.has(stage)) {
          row['FUENTE'] = 'Facturación';
          row['Estado'] = 'Facturado'; // definición usuaria 19-jul
          facturadoRows.push(row);
        } else if (LISTO_STAGES.has(stage)) {
          // Listo para facturar (ambos pipelines) → Notificado.
          row['FUENTE'] = 'Backlog';
          row['Estado'] = 'Notificado';
          listoRows.push(row);
        } else {
          // 85% / 95% / Próximos a facturar (y forecast previo) → Pendiente de notificar.
          row['FUENTE'] = 'Backlog';
          row['Estado'] = 'Pendiente de notificar';
          forecastRows.push(row);
        }
      }
    }
  }

  console.log(`\n  Pipeline rows : ${pipelineRows.length}`);
  console.log(`  Forecast rows : ${forecastRows.length}`);
  console.log(`  Listo rows    : ${listoRows.length}`);
  console.log(`  Facturado rows: ${facturadoRows.length}`);

  // 4) Build Excel
  console.log('\n4. Generando Excel...');

  const wb = new ExcelJS.Workbook();

  const COLUMNS = [
    { header: 'Cliente Beneficiario', key: 'Cliente Beneficiario', width: 30 },
    { header: 'ID Cliente Beneficiario', key: 'ID Cliente Beneficiario', width: 15 },
    { header: 'Entidad Facturadora', key: 'Entidad Facturadora', width: 18 },
    { header: 'Cliente Factura', key: 'Cliente Factura', width: 30 },
    { header: 'ID Cliente Factura', key: 'ID Cliente Factura', width: 15 },
    { header: 'Partner', key: 'Partner', width: 25 },
    { header: 'ID Partner', key: 'ID Partner', width: 15 },
    { header: 'Negocio', key: 'Negocio', width: 35 },
    { header: 'ID Negocio', key: 'ID Negocio', width: 15 },
    { header: 'Ejecutivo Asignado', key: 'Ejecutivo Asignado', width: 22 },
    { header: 'País Operativo', key: 'País Operativo', width: 15 },
    { header: 'Incluye UY', key: 'Incluye UY', width: 12 },
    { header: 'Ciclo de Negocio', key: 'Ciclo de Negocio', width: 22 },
    { header: 'Tipo de Venta', key: 'Tipo de Venta', width: 16 },
    // Renombres Paola 21-jul: FUENTE (Forecast/Backlog/Facturación) · Estado (sub-fuente)
    { header: 'FUENTE', key: 'FUENTE', width: 14 },
    { header: 'Estado', key: 'Estado', width: 22 },
    { header: 'Intercompany', key: 'Intercompany', width: 13 },
    { header: 'Probabilidad', key: 'Probabilidad', width: 13 },
    { header: 'Fecha de Cierre', key: 'Fecha de Cierre', width: 15 },
    { header: 'Moneda', key: 'Moneda', width: 10 },
    { header: 'Rubro', key: 'Rubro', width: 25 },
    { header: 'Área de Negocio', key: 'Área de Negocio', width: 30 },
    { header: 'Descripción Producto', key: 'Descripción Producto', width: 40 },
    { header: 'Descripción Ticket', key: 'Descripción Ticket', width: 40 },
    { header: 'Observaciones', key: 'Observaciones', width: 30 },
    { header: 'Fecha Fact Estimada', key: 'Fecha Fact Estimada', width: 18 },
    { header: 'Mes', key: 'Mes', width: 8 },
    { header: 'Año', key: 'Año', width: 8 },
    // Renombres 23-jul (commercial controller): moneda explícita en cada columna de plata,
    // "Valor del Dólar" (antes "Dólar") y Margen % ELIMINADA (traía of_margen absoluto).
    { header: 'Monto en Moneda Original', key: 'Monto en Moneda Original', width: 18 },
    { header: 'Costo en Moneda Original', key: 'Costo en Moneda Original', width: 18 },
    { header: 'Margen Bruto en Moneda Original', key: 'Margen Bruto en Moneda Original', width: 20 },
    { header: 'Valor del Dólar', key: 'Valor del Dólar', width: 12 },
    { header: 'Monto en Dólares', key: 'Monto en Dólares', width: 15 },
    { header: 'Costo en Dólares', key: 'Costo en Dólares', width: 15 },
    { header: 'Margen Bruto en Dólares', key: 'Margen Bruto en Dólares', width: 18 },
    { header: 'Repetitivo', key: 'Repetitivo', width: 12 },
    { header: 'Reventa', key: 'Reventa', width: 10 },
    { header: 'Sub Rubro', key: 'Sub Rubro', width: 20 },
    { header: 'N Factura', key: 'N Factura', width: 15 },
    { header: 'Facturas Restantes', key: 'Facturas Restantes', width: 16 },
    { header: 'ORIGEN', key: 'ORIGEN', width: 12 },
    { header: 'Momento de Facturación', key: 'Momento de Facturación', width: 20 },
    { header: 'Condiciones de Pago', key: 'Condiciones de Pago', width: 25 },
    { header: 'Facturación Automática', key: 'Facturación Automática', width: 20 },
    { header: 'Fecha Inicio Contrato', key: 'Fecha Inicio Contrato', width: 18 },
    { header: 'Frecuencia', key: 'Frecuencia', width: 15 },
    { header: 'Fecha Fin Contrato', key: 'Fecha Fin Contrato', width: 18 },
    { header: 'Renovación Automática', key: 'Renovación Automática', width: 20 },
  ];

  function addSheet(name, rows) {
    const ws = wb.addWorksheet(name);
    ws.columns = COLUMNS;

    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    ws.getRow(1).height = 30;

    for (const row of rows) {
      ws.addRow(row);
    }

    // Forma objeto: con 26+ columnas el cálculo por letra (A..Z) se rompía.
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  // 3 grandes conceptos (spec Paola jul-2026): Forecast / Backlog / Facturado
  const backlogRows = [...forecastRows, ...listoRows];
  addSheet('Forecast', pipelineRows);
  addSheet('Backlog', backlogRows);
  addSheet('Facturado', facturadoRows);

  const outPath = `reporte_consolidado_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await wb.xlsx.writeFile(outPath);

  console.log(`\n✅ Reporte generado: ${outPath}`);
  console.log(`   Forecast : ${pipelineRows.length} filas`);
  console.log(`   Backlog  : ${backlogRows.length} filas (pendiente ${forecastRows.length} + notificado ${listoRows.length})`);
  console.log(`   Facturado: ${facturadoRows.length} filas`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
