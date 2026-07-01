#!/usr/bin/env node
/**
 * auditDeals.mjs  (v3)
 *
 * Auditoría masiva de deals en DOS bloques independientes:
 *
 *   A) CONTEO  ── ¿el line item tiene la cantidad de tickets que debería, ni más ni menos?
 *      - Pago único  → 1 ticket
 *      - Plan fijo    → term completo (todos los pagos del plan)
 *      - Auto-renew   → un ticket por período entre 01/01 del año pasado y 31/12 del año que viene
 *
 *   B) ETAPA  ── ¿están en la etapa correcta según su fecha y tipo?
 *      Clasificación de stages (robusta, sin depender de cada ID):
 *        · FORECAST  → promesa, aún no promovido
 *        · EMITIDO   → factura ya generada (INVOICED_STAGES)
 *        · PROMOVIDO_NO_EMITIDO → "Próximas a Facturar" / "Listo para Facturar" / auto-ready
 *          (todo lo que no es forecast, ni emitido, ni cancelado)
 *      Reglas:
 *        · AUTO pasado: debe estar EMITIDO con numero_de_factura (Nodum) Y of_invoice_id (HubSpot).
 *            - si no está emitido (forecast o "listo") → AUTO_PASADO_NO_EMITIDO
 *            - si está emitido pero falta Nodum         → AUTO_EMITIDO_SIN_NODUM
 *            - si está emitido pero falta invoice HS    → AUTO_EMITIDO_SIN_INVOICE_HS
 *        · MANUAL pasado:
 *            - si sigue en FORECAST → MANUAL_PASADO_EN_FORECAST (debería estar al menos en Próximas)
 *            - si trae Nodum (vino de migración) pero sin invoice HS → MANUAL_MIGRADO_SIN_INVOICE_HS
 *        · Migrado (tiene Nodum): las tres fechas deberían coincidir.
 *
 *   ESTRUCTURA: tickets sin line_item_key, sin of_deal_id, LIK ajeno, fechas duplicadas.
 *
 * Uso:
 *   node auditDeals.mjs                 # todos los deals
 *   node auditDeals.mjs --deal <ID>     # solo un deal (imprime desglose por LI en consola)
 *   node auditDeals.mjs --pipeline <ID> # filtrar por pipeline de DEAL
 *   node auditDeals.mjs --mirrors       # solo mirrors UY
 *
 * Genera: audit_deals_YYYY-MM-DD.xlsx (3 hojas: Resumen / Conteo / Etapas)
 */

import 'dotenv/config';
import { Client } from '@hubspot/api-client';
import ExcelJS from 'exceljs';

import {
  TICKET_PIPELINE,
  AUTOMATED_TICKET_PIPELINE,
  FORECAST_MANUAL_STAGES,
  FORECAST_AUTO_STAGES,
  INVOICED_STAGES,
  TICKET_STAGES,
  BILLING_AUTOMATED_CANCELLED,
} from '../../src/config/constants.js';

// ─── Propiedades clave ──────────────────────────────────────────────────────────
const LIK_PROP          = 'line_item_key';
const NODUM_NUMBER_PROP = 'numero_de_factura';
const INVOICE_OBJ_PROP  = 'of_invoice_id';

// ─── Config ─────────────────────────────────────────────────────────────────────
const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;
if (!TOKEN) { console.error('❌ Falta HUBSPOT_PRIVATE_TOKEN'); process.exit(1); }

// El audit abortaba con "Error fatal: Premature close" (error de stream de node-fetch
// a mitad de deals/search). numberOfApiCallRetries del SDK NO cubre ese caso, así que
// envolvemos el cliente en un Proxy recursivo que reintenta CUALQUIER error transitorio
// (429, 5xx, y errores de red incl. ECONNRESET / socket hang up / premature close).
// El audit es solo-lectura → reintentar es seguro.
const rawHubspot = new Client({ accessToken: TOKEN, numberOfApiCallRetries: 6 });

function isTransientErr(err) {
  const msg    = String(err?.message || err?.cause?.message || '');
  const code   = err?.code || err?.cause?.code || '';
  const status = err?.response?.status ?? err?.statusCode;
  if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
       'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'ECONNABORTED'].includes(code)) return true;
  return /premature close|socket hang up|econnreset|etimedout|network|fetch failed|aborted|timeout/i.test(msg);
}
async function callWithRetry(fn, tries = 6) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (!isTransientErr(err) || attempt >= tries) throw err;
      const delay = Math.min(600 * 2 ** attempt, 10_000);
      process.stdout.write(`\n   ⚠️ red (${String(err?.message || err?.code).slice(0, 50)}) → reintento ${attempt + 1}/${tries} en ${delay}ms\n`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
function retryProxy(target) {
  return new Proxy(target, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v === 'function') return (...args) => callWithRetry(() => v.apply(t, args));
      if (v && typeof v === 'object') return retryProxy(v);
      return v;
    },
  });
}
const hubspot = retryProxy(rawHubspot);

const args = process.argv.slice(2);
const pipelineFilter = (() => { const i = args.indexOf('--pipeline'); return i !== -1 ? args[i + 1] : null; })();
const singleDealId   = (() => { const i = args.indexOf('--deal');     return i !== -1 ? args[i + 1] : null; })();
const mirrorsOnly    = args.includes('--mirrors');
const VERBOSE        = !!singleDealId; // en modo deal único, desglose por LI en consola

const HARD_MAX = 24; // tope por lado (pasado / futuro) en auto-renew

// ─── Sets de etapas ─────────────────────────────────────────────────────────────
const FORECAST_STAGES  = new Set([...FORECAST_MANUAL_STAGES, ...FORECAST_AUTO_STAGES].filter(Boolean));
const EMITTED_STAGES   = new Set([...INVOICED_STAGES].filter(Boolean));
const CANCELLED_STAGES = new Set([TICKET_STAGES.CANCELLED, BILLING_AUTOMATED_CANCELLED].filter(Boolean));

// ─── Helpers ──────────────────────────────────────────────────────────────────
let lastCall = 0;
async function rateLimit() {
  const now = Date.now();
  const diff = now - lastCall;
  if (diff < 120) await new Promise(r => setTimeout(r, 120 - diff));
  lastCall = Date.now();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safe  = v => (v ?? '').toString().trim();

function nowMontevideoYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montevideo' });
}
function toYmd(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const ms = Number(s);
  if (!Number.isNaN(ms) && ms > 0) return new Date(ms).toISOString().slice(0, 10);
  return '';
}
function parseLocalDate(raw) {
  const d = toYmd(raw);
  if (!d) return null;
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd);
}
function formatDateISO(d) {
  if (!d || !Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addInterval(d, interval) {
  if (!d || !interval) return null;
  const r = new Date(d.getTime());
  if (interval.months) r.setMonth(r.getMonth() + interval.months);
  if (interval.days)   r.setDate(r.getDate() + interval.days);
  return r;
}
function getInterval(freqRaw) {
  switch ((freqRaw ?? '').toString().trim().toLowerCase()) {
    case 'weekly':         case 'semanal':    return { months: 0,  days: 7 };
    case 'biweekly':       case 'quincenal':  return { months: 0,  days: 14 };
    case 'monthly':        case 'mensual':    return { months: 1,  days: 0 };
    case 'bimestral':                          return { months: 2,  days: 0 };
    case 'quarterly':      case 'trimestral': return { months: 3,  days: 0 };
    case 'per_six_months': case 'semestral':  return { months: 6,  days: 0 };
    case 'annually':       case 'anual':      return { months: 12, days: 0 };
    case 'per_two_years':                      return { months: 24, days: 0 };
    default:                                   return null;
  }
}

// ─── Clasificación de ticket ────────────────────────────────────────────────────
function ticketPipeline(t) {
  const p = safe(t?.properties?.hs_pipeline);
  if (p === AUTOMATED_TICKET_PIPELINE) return 'auto';
  if (p === TICKET_PIPELINE) return 'manual';
  return 'desconocido';
}
const stageOf      = t => safe(t?.properties?.hs_pipeline_stage);
const isCancelled  = t => CANCELLED_STAGES.has(stageOf(t));
const isForecast   = t => FORECAST_STAGES.has(stageOf(t));
const isEmitted    = t => EMITTED_STAGES.has(stageOf(t));

function ticketFecha(t) {
  const tp = t?.properties || {};
  return toYmd(tp.of_fecha_de_facturacion) || toYmd(tp.fecha_resolucion_esperada) || '';
}

// ─── CONTEO esperado por LI ─────────────────────────────────────────────────────
function buildExpected(li) {
  const p = li?.properties || {};
  const startYmd =
    toYmd(p.hs_recurring_billing_start_date) ||
    toYmd(p.fecha_inicio_de_facturacion) || '';

  if (!startYmd) return { mode: 'sin_fecha_inicio', expectedTotal: 0 };

  const freqKey  = (p.recurringbillingfrequency || p.hs_recurring_billing_frequency || '').trim();
  const interval = freqKey ? getInterval(freqKey) : null;

  if (!freqKey)  return { mode: 'pago_unico', expectedTotal: 1 };
  if (!interval) return { mode: 'frecuencia_desconocida', expectedTotal: 1 };

  const termRaw = p.hs_recurring_billing_number_of_payments ?? p.number_of_payments ?? null;
  const term    = termRaw ? parseInt(String(termRaw), 10) : null;
  const isAutoRenew =
    String(p.renovacion_automatica || '').toLowerCase() === 'true' || !(term > 0);

  if (!isAutoRenew) return { mode: 'plan_fijo', expectedTotal: term, term };

  const currentYear = new Date().getFullYear();
  const windowStart = `${currentYear - 1}-01-01`;
  const windowEnd   = `${currentYear + 1}-12-31`;
  const today       = nowMontevideoYmd();

  const origin = parseLocalDate(toYmd(p.billing_anchor_date) || startYmd);
  if (!origin) return { mode: 'auto_renew_sin_start', expectedTotal: 0, windowStart, windowEnd };

  const pastDates = [], futureDates = [];
  let d = new Date(origin.getTime()), safety = 0;
  while (safety++ < 1200) {
    if (!d || !Number.isFinite(d.getTime())) break;
    const ymd = formatDateISO(d);
    if (ymd > windowEnd) break;
    if (ymd >= windowStart) (ymd < today ? pastDates : futureDates).push(ymd);
    const next = addInterval(d, interval);
    if (!next || !Number.isFinite(next.getTime()) || next.getTime() === d.getTime()) break;
    d = next;
  }
  const expectedTotal = pastDates.slice(-HARD_MAX).length + futureDates.slice(0, HARD_MAX).length;
  return { mode: 'auto_renew', expectedTotal, windowStart, windowEnd };
}

// ─── Props ──────────────────────────────────────────────────────────────────────
const DEAL_PROPS = [
  'dealname', 'dealstage', 'pipeline', 'pais_operativo',
  'facturacion_activa', 'facturacion_automatica',
  'es_mirror_de_py', 'deal_uy_mirror_id', 'deal_py_origen_id',
];
const LI_PROPS = [
  'name', LIK_PROP, 'of_line_item_py_origen_id',
  'recurringbillingfrequency', 'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date', 'fecha_inicio_de_facturacion',
  'hs_recurring_billing_number_of_payments', 'number_of_payments',
  'renovacion_automatica', 'facturacion_automatica',
  'billing_anchor_date', 'billing_next_date', 'last_ticketed_date',
];
const TICKET_PROPS = [
  'subject', 'hs_pipeline', 'hs_pipeline_stage',
  'of_ticket_key', 'of_line_item_key', 'of_deal_id',
  INVOICE_OBJ_PROP, NODUM_NUMBER_PROP,
  'fecha_resolucion_esperada', 'of_fecha_de_facturacion', 'fecha_real_de_facturacion',
];

// ─── Fetchers ─────────────────────────────────────────────────────────────────
async function fetchAllDeals() {
  const deals = [];
  let after;
  const filters = [];
  if (pipelineFilter) filters.push({ propertyName: 'pipeline', operator: 'EQ', value: pipelineFilter });
  if (mirrorsOnly)    filters.push({ propertyName: 'es_mirror_de_py', operator: 'EQ', value: 'true' });
  while (true) {
    await rateLimit();
    const body = {
      ...(filters.length ? { filterGroups: [{ filters }] } : {}),
      properties: DEAL_PROPS, limit: 100,
      sorts: [{ propertyName: 'dealname', direction: 'ASCENDING' }],
      ...(after ? { after } : {}),
    };
    const resp = await hubspot.crm.deals.searchApi.doSearch(body);
    deals.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (!after || !resp?.results?.length) break;
    process.stdout.write(`\r   Deals leídos: ${deals.length}...`);
  }
  console.log(`\r   Deals leídos: ${deals.length}   `);
  return deals;
}
async function fetchLineItemsForDeal(dealId) {
  await rateLimit();
  let liIds = [];
  try {
    const resp = await hubspot.crm.associations.v4.basicApi.getPage('deals', String(dealId), 'line_items', undefined, 100);
    liIds = (resp?.results || []).map(r => String(r.toObjectId));
  } catch { return []; }
  if (!liIds.length) return [];
  await rateLimit();
  const batch = await hubspot.crm.lineItems.batchApi.read({ inputs: liIds.map(id => ({ id })), properties: LI_PROPS });
  return batch?.results || [];
}
async function fetchTicketsForDeal(dealId) {
  const tickets = [];
  let after;
  while (true) {
    await rateLimit();
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'of_deal_id', operator: 'EQ', value: String(dealId) }] }],
      properties: TICKET_PROPS, limit: 100, ...(after ? { after } : {}),
    };
    const resp = await hubspot.crm.tickets.searchApi.doSearch(body);
    tickets.push(...(resp?.results || []));
    after = resp?.paging?.next?.after;
    if (!after || !resp?.results?.length) break;
  }
  return tickets;
}

// ─── Auditar un deal ──────────────────────────────────────────────────────────
function auditDeal(deal, lineItems, tickets) {
  const dp = deal.properties || {};
  const today = nowMontevideoYmd();
  const anomalies = [];
  const push = (grupo, a) => anomalies.push({ grupo, ...a });

  // Agrupar tickets por LIK
  const ticketsByLik = new Map();
  const ticketsSinLik = [], ticketsSinDeal = [];
  for (const t of tickets) {
    const tp = t.properties || {};
    const lik = safe(tp.of_line_item_key);
    if (!safe(tp.of_deal_id)) ticketsSinDeal.push(t);
    if (!lik) { ticketsSinLik.push(t); continue; }
    if (!ticketsByLik.has(lik)) ticketsByLik.set(lik, []);
    ticketsByLik.get(lik).push(t);
  }

  if (ticketsSinLik.length) push('ESTRUCTURA', {
    tipo: 'TICKET_SIN_LIK', gravedad: '🔴', liId: '', liNombre: '', lik: '',
    detalle: `${ticketsSinLik.length} ticket(s) sin of_line_item_key`,
    ticketIds: ticketsSinLik.map(t => t.id).join(', '), esperado: '', real: ticketsSinLik.length, diferencia: '',
  });
  if (ticketsSinDeal.length) push('ESTRUCTURA', {
    tipo: 'TICKET_SIN_DEAL', gravedad: '🔴', liId: '', liNombre: '', lik: '',
    detalle: `${ticketsSinDeal.length} ticket(s) sin of_deal_id`,
    ticketIds: ticketsSinDeal.map(t => t.id).join(', '), esperado: '', real: ticketsSinDeal.length, diferencia: '',
  });

  const dealLiks = new Set(lineItems.map(li => safe(li.properties?.[LIK_PROP])).filter(Boolean));
  for (const [lik, tks] of ticketsByLik.entries()) {
    if (!dealLiks.has(lik)) push('ESTRUCTURA', {
      tipo: 'TICKET_LIK_AJENO', gravedad: '🟠', liId: '', liNombre: '', lik,
      detalle: `${tks.length} ticket(s) con LIK que no pertenece a ningún LI de este deal`,
      ticketIds: tks.map(t => t.id).join(', '), esperado: '', real: tks.length, diferencia: '',
    });
  }

  if (VERBOSE) console.log(`\n   ── Deal ${deal.id} · ${safe(dp.dealname)} · LIs=${lineItems.length} · tickets=${tickets.length}`);

  for (const li of lineItems) {
    const lp = li.properties || {};
    const lik = safe(lp[LIK_PROP]);
    const nombre = safe(lp.name);

    if (!lik) {
      push('ESTRUCTURA', {
        tipo: 'LI_SIN_LIK', gravedad: '🟠', liId: li.id, liNombre: nombre, lik: '',
        detalle: 'Line item sin line_item_key', ticketIds: '', esperado: '', real: '', diferencia: '',
      });
      continue;
    }

    const all     = ticketsByLik.get(lik) || [];
    const activos  = all.filter(t => !isCancelled(t));
    const exp      = buildExpected(li);

    // ── A: CONTEO ──
    let actualCount, fueraVentana = [];
    if (exp.mode === 'auto_renew') {
      const inWin = activos.filter(t => { const f = ticketFecha(t); return f && f >= exp.windowStart && f <= exp.windowEnd; });
      actualCount = inWin.length;
      fueraVentana = activos.filter(t => !inWin.includes(t));
    } else {
      actualCount = activos.length;
    }
    const expected = exp.expectedTotal ?? 0;
    const diff = actualCount - expected;
    const detalleConteo = `Modo: ${exp.mode}${exp.term ? ` | term=${exp.term}` : ''}`;

    if (VERBOSE) {
      const verdict = diff === 0 ? '✅' : (diff < 0 ? '🔴 faltan' : '🟡 sobran');
      console.log(`      LI ${li.id} "${nombre.slice(0,30)}" · ${exp.mode} · esperado=${expected} real=${actualCount} ${verdict}`);
    }

    if (diff < 0) push('CONTEO', {
      tipo: 'TICKETS_FALTANTES', gravedad: '🔴', liId: li.id, liNombre: nombre, lik,
      detalle: detalleConteo, ticketIds: '', esperado: expected, real: actualCount, diferencia: diff,
    });
    if (diff > 0) push('CONTEO', {
      tipo: 'TICKETS_EXTRA', gravedad: '🟡', liId: li.id, liNombre: nombre, lik,
      detalle: detalleConteo, ticketIds: activos.map(t => t.id).join(', '), esperado: expected, real: actualCount, diferencia: diff,
    });
    if (fueraVentana.length) push('CONTEO', {
      tipo: 'AUTO_TICKETS_FUERA_VENTANA', gravedad: '🟡', liId: li.id, liNombre: nombre, lik,
      detalle: `${fueraVentana.length} ticket(s) auto fuera de la ventana ${exp.windowStart}..${exp.windowEnd}`,
      ticketIds: fueraVentana.map(t => t.id).join(', '), esperado: '', real: fueraVentana.length, diferencia: '',
    });

    // ── ESTRUCTURA: duplicados por fecha ──
    const fechaCount = new Map();
    for (const t of activos) {
      const f = ticketFecha(t); if (!f) continue;
      if (!fechaCount.has(f)) fechaCount.set(f, []);
      fechaCount.get(f).push(t.id);
    }
    for (const [f, ids] of fechaCount.entries()) {
      if (ids.length > 1) push('ESTRUCTURA', {
        tipo: 'DUPLICADO_FECHA', gravedad: '🔴', liId: li.id, liNombre: nombre, lik,
        detalle: `Fecha ${f} duplicada en ${ids.length} tickets`,
        ticketIds: ids.join(', '), esperado: 1, real: ids.length, diferencia: ids.length - 1,
      });
    }

    // ── B: ETAPAS ──
    for (const t of activos) {
      const tp = t.properties || {};
      const f = ticketFecha(t); if (!f) continue;
      const pasado = f < today;
      const pipe = ticketPipeline(t);
      const tieneNodum   = !!safe(tp[NODUM_NUMBER_PROP]);
      const tieneInvoice = !!safe(tp[INVOICE_OBJ_PROP]);

      // Coherencia de fechas en migrados
      if (tieneNodum) {
        const f1 = toYmd(tp.fecha_resolucion_esperada);
        const f2 = toYmd(tp.of_fecha_de_facturacion);
        const f3 = toYmd(tp.fecha_real_de_facturacion);
        if ([f1, f2, f3].filter(Boolean).length === 3 && !(f1 === f2 && f2 === f3)) push('ETAPA', {
          tipo: 'MIGRADO_FECHAS_DESCOORDINADAS', gravedad: '🟠', liId: li.id, liNombre: nombre, lik,
          detalle: `resolucion=${f1} facturacion=${f2} real=${f3} (deberían coincidir)`,
          ticketIds: t.id, esperado: 'iguales', real: 'distintas', diferencia: '',
        });
      }

      if (!pasado) continue; // reglas de etapa son sobre tickets pasados

      if (pipe === 'auto') {
        if (isEmitted(t)) {
          if (!tieneNodum) push('ETAPA', {
            tipo: 'AUTO_EMITIDO_SIN_NODUM', gravedad: '🟠', liId: li.id, liNombre: nombre, lik,
            detalle: `Ticket auto emitido (${f}) sin numero_de_factura (Nodum)`,
            ticketIds: t.id, esperado: 'con Nodum', real: 'sin Nodum', diferencia: '',
          });
          if (!tieneInvoice) push('ETAPA', {
            tipo: 'AUTO_EMITIDO_SIN_INVOICE_HS', gravedad: '🟠', liId: li.id, liNombre: nombre, lik,
            detalle: `Ticket auto emitido (${f}) sin of_invoice_id (factura HubSpot no enlazada)`,
            ticketIds: t.id, esperado: 'con invoice', real: 'sin invoice', diferencia: '',
          });
        } else {
          const donde = isForecast(t) ? 'FORECAST' : 'Listo/promovido (no emitido)';
          push('ETAPA', {
            tipo: 'AUTO_PASADO_NO_EMITIDO', gravedad: '🔴', liId: li.id, liNombre: nombre, lik,
            detalle: `Ticket auto con fecha pasada (${f}) en ${donde} (debería estar EMITIDO con factura). nodum=${tieneNodum} invoice=${tieneInvoice}`,
            ticketIds: t.id, esperado: 'emitido+factura', real: donde, diferencia: '',
          });
        }
      } else if (pipe === 'manual') {
        if (isForecast(t)) push('ETAPA', {
          tipo: 'MANUAL_PASADO_EN_FORECAST', gravedad: '🟠', liId: li.id, liNombre: nombre, lik,
          detalle: `Ticket manual con fecha pasada (${f}) sigue en FORECAST (debería estar al menos en Próximas a Facturar)`,
          ticketIds: t.id, esperado: 'próximas+', real: 'forecast', diferencia: '',
        });
        if (tieneNodum && !tieneInvoice) push('ETAPA', {
          tipo: 'MANUAL_MIGRADO_SIN_INVOICE_HS', gravedad: '🟠', liId: li.id, liNombre: nombre, lik,
          detalle: `Ticket manual migrado (${f}) con Nodum pero sin of_invoice_id`,
          ticketIds: t.id, esperado: 'con invoice', real: 'sin invoice', diferencia: '',
        });
      }
    }
  }

  const conteo = anomalies.filter(a => a.grupo !== 'ETAPA');
  const etapa  = anomalies.filter(a => a.grupo === 'ETAPA');
  return {
    dealId: deal.id, dealNombre: safe(dp.dealname), pais: safe(dp.pais_operativo),
    esMirror: safe(dp.es_mirror_de_py) === 'true' ? 'Sí' : 'No',
    totalLIs: lineItems.length, totalTickets: tickets.length,
    anomalias: anomalies, countConteo: conteo.length, countEtapa: etapa.length,
  };
}

// ─── Excel ────────────────────────────────────────────────────────────────────
async function exportExcel(summaryRows, conteoRows, etapaRows) {
  const wb = new ExcelJS.Workbook();
  const today = nowMontevideoYmd();

  const ws1 = wb.addWorksheet('Resumen por Deal');
  ws1.columns = [
    { header: 'Deal ID', key: 'dealId', width: 16 },
    { header: 'Deal Nombre', key: 'dealNombre', width: 40 },
    { header: 'País', key: 'pais', width: 12 },
    { header: 'Mirror', key: 'esMirror', width: 10 },
    { header: 'Line Items', key: 'totalLIs', width: 12 },
    { header: 'Tickets', key: 'totalTickets', width: 12 },
    { header: '# Problemas Conteo', key: 'countConteo', width: 18 },
    { header: '# Problemas Etapa', key: 'countEtapa', width: 18 },
  ];
  styleHeader(ws1);
  for (const r of summaryRows) ws1.addRow(r);
  applyConditionalColor(ws1, 7, summaryRows.length);
  applyConditionalColor(ws1, 8, summaryRows.length);
  ws1.autoFilter = { from: 'A1', to: 'H1' };
  ws1.views = [{ state: 'frozen', ySplit: 1 }];

  const detailCols = [
    { header: 'Deal ID', key: 'dealId', width: 16 },
    { header: 'Deal Nombre', key: 'dealNombre', width: 35 },
    { header: 'País', key: 'pais', width: 12 },
    { header: 'Mirror', key: 'esMirror', width: 10 },
    { header: 'Gravedad', key: 'gravedad', width: 10 },
    { header: 'Grupo', key: 'grupo', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 30 },
    { header: 'LI ID', key: 'liId', width: 16 },
    { header: 'LI Nombre', key: 'liNombre', width: 30 },
    { header: 'LIK', key: 'lik', width: 22 },
    { header: 'Detalle', key: 'detalle', width: 60 },
    { header: 'Esperado', key: 'esperado', width: 14 },
    { header: 'Real', key: 'real', width: 14 },
    { header: 'Diferencia', key: 'diferencia', width: 12 },
    { header: 'Ticket IDs', key: 'ticketIds', width: 50 },
  ];
  const ws2 = wb.addWorksheet('Conteo'); ws2.columns = detailCols; styleHeader(ws2);
  for (const r of conteoRows) ws2.addRow(r);
  ws2.autoFilter = { from: 'A1', to: 'O1' }; ws2.views = [{ state: 'frozen', ySplit: 1 }];

  const ws3 = wb.addWorksheet('Etapas'); ws3.columns = detailCols; styleHeader(ws3);
  for (const r of etapaRows) ws3.addRow(r);
  ws3.autoFilter = { from: 'A1', to: 'O1' }; ws3.views = [{ state: 'frozen', ySplit: 1 }];

  const outPath = `audit_deals_${today}.xlsx`;
  await wb.xlsx.writeFile(outPath);
  return outPath;
}
function styleHeader(ws) {
  ws.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(1).height = 28;
}
function applyConditionalColor(ws, colNumber, rowCount) {
  for (let i = 2; i <= rowCount + 1; i++) {
    const cell = ws.getRow(i).getCell(colNumber);
    if (Number(cell.value) > 0) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
      cell.font = { color: { argb: 'FF9C0006' }, bold: true };
    } else {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
      cell.font = { color: { argb: 'FF276221' } };
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const today = nowMontevideoYmd();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AUDITORÍA MASIVA DE DEALS (v3: Conteo + Etapas)');
  console.log(`  Fecha (Montevideo): ${today}`);
  if (pipelineFilter) console.log(`  Pipeline deal:     ${pipelineFilter}`);
  if (singleDealId)   console.log(`  Deal único:        ${singleDealId}`);
  if (mirrorsOnly)    console.log(`  Filtro:            Solo mirrors UY`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let deals;
  if (singleDealId) {
    console.log('📥 Cargando deal único...');
    deals = [await hubspot.crm.deals.basicApi.getById(String(singleDealId), DEAL_PROPS)];
  } else {
    console.log('📥 Cargando todos los deals...');
    deals = await fetchAllDeals();
  }
  console.log(`   Total deals a auditar: ${deals.length}\n`);

  const summaryRows = [], conteoRows = [], etapaRows = [];

  for (let i = 0; i < deals.length; i++) {
    const deal = deals[i];
    const nombre = safe(deal.properties?.dealname);
    if (!VERBOSE) process.stdout.write(`\r   [${i+1}/${deals.length}] ${nombre.slice(0, 45).padEnd(45)} `);

    const [lineItems, tickets] = await Promise.all([
      fetchLineItemsForDeal(deal.id),
      fetchTicketsForDeal(deal.id),
    ]);
    await sleep(100);

    const result = auditDeal(deal, lineItems, tickets);
    summaryRows.push({
      dealId: result.dealId, dealNombre: result.dealNombre, pais: result.pais,
      esMirror: result.esMirror, totalLIs: result.totalLIs, totalTickets: result.totalTickets,
      countConteo: result.countConteo, countEtapa: result.countEtapa,
    });
    for (const a of result.anomalias) {
      const row = {
        dealId: result.dealId, dealNombre: result.dealNombre, pais: result.pais, esMirror: result.esMirror,
        gravedad: a.gravedad, grupo: a.grupo, tipo: a.tipo, liId: a.liId, liNombre: a.liNombre, lik: a.lik,
        detalle: a.detalle, esperado: a.esperado, real: a.real, diferencia: a.diferencia, ticketIds: a.ticketIds,
      };
      (a.grupo === 'ETAPA' ? etapaRows : conteoRows).push(row);
    }
  }

  console.log('\n');
  console.log('📊 Generando Excel...');
  const outPath = await exportExcel(summaryRows, conteoRows, etapaRows);

  const dealsConteoOk = summaryRows.filter(r => r.countConteo === 0).length;
  const dealsEtapaOk  = summaryRows.filter(r => r.countEtapa === 0).length;
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESUMEN FINAL');
  console.log(`  Deals auditados:          ${deals.length}`);
  console.log(`  ✅ Conteo OK:             ${dealsConteoOk}  |  con problemas: ${deals.length - dealsConteoOk}`);
  console.log(`  ✅ Etapas OK:             ${dealsEtapaOk}  |  con problemas: ${deals.length - dealsEtapaOk}`);
  console.log(`  Anomalías Conteo+Estruct: ${conteoRows.length}`);
  console.log(`  Anomalías Etapa:          ${etapaRows.length}`);
  console.log('');
  const tipoCounts = {};
  for (const r of [...conteoRows, ...etapaRows]) tipoCounts[r.tipo] = (tipoCounts[r.tipo] || 0) + 1;
  for (const [tipo, count] of Object.entries(tipoCounts).sort((a, b) => b[1] - a[1]))
    console.log(`     ${tipo.padEnd(32)} ${count}`);
  console.log('');
  console.log(`  📁 Reporte: ${outPath}`);
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message ?? err);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
