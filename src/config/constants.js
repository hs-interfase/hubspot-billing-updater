// src/config/constants.js

/**
 * Constantes globales para el proyecto de facturación.
 * (stages/pipelines + helpers de semántica)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MAPA DE STAGES Y SU SEMÁNTICA (leer antes de modificar)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PIPELINE MANUAL (TICKET_PIPELINE / BILLING_TICKET_PIPELINE_ID)
 * ──────────────────────────────────────────────────────────────
 * FORECAST stages (BILLING_TICKET_FORECAST / _50 / _75 / _85 / _95)
 *   → "Promesas de facturación". Uno por cada bucket de probabilidad del deal.
 *     Se crean en Phase P. No se tocan hasta que Phase 2 los promueve.
 *
 * TICKET_STAGES.NEW  (env: BILLING_TICKET_STAGE_ID)
 *   → "PRÓXIMOS A FACTURAR" (manual).
 *     Phase 2 promueve el ticket forecast aquí cuando faltan ≤30 días para facturar.
 *     Queda EDITABLE por el equipo de administración durante esa ventana.
 *     phase2.js importa el alias exportado PROXIMOS_A_FACTURAR_STAGE (abajo)
 *     — no confundir con TICKET_STAGES.READY ("Listo para Facturar").
 *
 * TICKET_STAGES.READY  (env: BILLING_TICKET_STAGE_READY)
 *   → "LISTO PARA FACTURAR" (manual).
 *     El admin mueve el ticket aquí cuando está confirmado para emitir factura.
 *     La función legacy emitInvoicesForReadyTickets() (invoices.js) busca tickets
 *     en este stage para crear la factura ficticia en HubSpot.
 *     Exportado también como TICKET_STAGE_LISTO_MANUAL (alias explícito).
 *
 * TICKET_STAGES.INVOICED  (env: BILLING_TICKET_STAGE_ID_BILLED)
 *   → "EMITIDO" (manual). Admin confirma que Nodum emitió la factura real.
 *
 * TICKET_STAGES.CANCELLED  (env: BILLING_TICKET_STAGE_CANCELLED)
 *   → "CANCELADO" (manual).
 *
 * PIPELINE AUTOMÁTICO (AUTOMATED_TICKET_PIPELINE / BILLING_AUTOMATED_PIPELINE_ID)
 * ────────────────────────────────────────────────────────────────────────────────
 * FORECAST stages (BILLING_AUTOMATED_FORECAST / _50 / _75 / _85 / _95)
 *   → Equivalentes a los manuales pero en el pipeline automático.
 *
 * BILLING_AUTOMATED_READY  (env: BILLING_AUTOMATED_READY)
 *   → "LISTO PARA FACTURAR" (automático).
 *     Phase 3 promueve aquí cuando planYMD ≤ HOY y emite la factura ficticia
 *     en el mismo paso. No hay etapa intermedia editable.
 *     ⚠️  A diferencia del pipeline manual, aquí no existe el concepto de
 *         "próximos a facturar" separado: el ticket pasa directo de forecast a
 *         ready+factura en una sola operación.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PUNTOS DE MEZCLA CONOCIDOS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. HISTÓRICO (saneado 2026-07-01): el término "READY" se usaba para dos cosas:
 *    - TICKET_STAGES.NEW: "Próximos a Facturar" — Phase 2 promueve aquí
 *    - TICKET_STAGES.READY / TICKET_STAGE_LISTO_MANUAL: "Listo para Facturar" — admin confirma
 *    Hoy phase2.js usa el alias PROXIMOS_A_FACTURAR_STAGE y su función se llama
 *    promoteManualForecastTicketToProximos; recalcFromTickets.js resuelve el destino
 *    con resolveTargetPromotionStage (auto→BILLING_AUTOMATED_READY emisible /
 *    manual→PRÓXIMOS, asimetría intencional). Regla vigente: usar siempre los alias
 *    explícitos (PROXIMOS_A_FACTURAR_STAGE, TICKET_STAGE_LISTO_MANUAL) en lugar de
 *    TICKET_STAGES.NEW / TICKET_STAGES.READY directamente, y no nombrar "READY"
 *    nada que apunte a NEW.
 *
 * 2. El pipeline automático NO tiene etapa "Próximos a Facturar": Phase 3 promueve
 *    directo a BILLING_AUTOMATED_READY y emite la factura en el mismo paso.
 *
 * 3. getTicketStage (ticketService.js) está @deprecated y MUERTA (sin call sites,
 *    verificado 2026-07-01). Su lógica NEW/READY es pre-alias — NO revivirla.
 * ─────────────────────────────────────────────────────────────────────────────
 */


import { etapaUnicaEnabled } from './etapaUnicaFlags.js';

export const IVA_UY_TAX_GROUP_ID = (process.env.IVA_UY_TAX_GROUP_ID || '').trim();
export const IVA_PY_TAX_GROUP_ID = (process.env.IVA_PY_TAX_GROUP_ID || '').trim();
export const EXENTO_TAX_GROUP_ID = (process.env.IVA_EXENTO_TAX_GROUP_ID || '').trim();

export const ASSOC_LABEL_EMPRESA_FACTURA = parseInt(process.env.ASSOC_LABEL_EMPRESA_FACTURA || '2', 10);
// Etiqueta "Partner" deal→company. typeId difiere por portal (PROD=2; SANDBOX=3, creada 2026-07-02).
// Default 0 = deshabilitado. La comparten cliente_partner (ticketService) y la doble etiqueta del mirror (dealMirroring).
export const ASSOC_LABEL_EMPRESA_PARTNER = parseInt(process.env.ASSOC_LABEL_EMPRESA_PARTNER || '0', 10);

// Etiquetas ticket→company (par USER_DEFINED creado 2026-07-07 en ambos portales).
// typeId por portal: "Empresa Factura" SANDBOX=5 / PROD=13; "Partner" SANDBOX=7 / PROD=11.
// Default 0 = deshabilitado (el ticket se asocia igual, pero sin etiqueta).
export const ASSOC_TICKET_LABEL_EMPRESA_FACTURA = parseInt(process.env.ASSOC_TICKET_LABEL_EMPRESA_FACTURA || '0', 10);
export const ASSOC_TICKET_LABEL_PARTNER = parseInt(process.env.ASSOC_TICKET_LABEL_PARTNER || '0', 10);

// Etiqueta deal→deal "Negocio Espejo (Mirror)" (par USER_DEFINED creado 2026-08-06).
// Se aplica SIEMPRE desde el negocio ORIGINAL hacia el ESPEJO; HubSpot crea sola la
// inversa "Negocio Original". typeId por portal: PROD=15 (la inversa es la 16).
// Default 0 = deshabilitado (el espejo se crea igual, pero sin asociarse al original).
export const ASSOC_LABEL_DEAL_MIRROR = parseInt(process.env.ASSOC_LABEL_DEAL_MIRROR || '0', 10);


export const DEAL_STAGE_LOST = process.env.DEAL_STAGE_LOST || 'closedlost';

// Lookahead para tickets manuales (30 días)
export const MANUAL_TICKET_LOOKAHEAD_DAYS = 30;

// ===============================
// Tickets MANUALES (pipeline + stages)
// ===============================
export const TICKET_PIPELINE =
  process.env.BILLING_TICKET_PIPELINE_ID || '';

export const TICKET_STAGES = {
  // "Próximos a Facturar": Phase 2 promueve aquí cuando faltan ≤30 días.
  // Editable por administración durante esa ventana.
  // Usar el alias PROXIMOS_A_FACTURAR_STAGE para mayor claridad.
  NEW: process.env.BILLING_TICKET_STAGE_ID || '',
  // "Listo para Facturar": el admin mueve el ticket aquí cuando confirma emisión.
  // La función emitInvoicesForReadyTickets() (invoices.js, legacy) lee este stage.
  // Usar el alias TICKET_STAGE_LISTO_MANUAL para mayor claridad.
  READY: process.env.BILLING_TICKET_STAGE_READY || '',
  // "Emitido": Nodum confirmó la factura real. Cuenta en EMITTED_STAGES.
  INVOICED: process.env.BILLING_TICKET_STAGE_ID_BILLED || '',
  CANCELLED: process.env.BILLING_TICKET_STAGE_CANCELLED || '',
};

// Alias explícitos para eliminar ambigüedad en el código:
// Usar estos en lugar de TICKET_STAGES.NEW / TICKET_STAGES.READY directamente.
export const PROXIMOS_A_FACTURAR_STAGE = TICKET_STAGES.NEW;    // Phase 2 promueve aquí
export const TICKET_STAGE_LISTO_MANUAL = TICKET_STAGES.READY;  // Admin confirma, emitInvoicesForReadyTickets lee aquí

// Manual forecast stages por bucket de deal stage
export const BILLING_TICKET_FORECAST =
  process.env.BILLING_TICKET_FORECAST || '';
export const BILLING_TICKET_FORECAST_50 =
  process.env.BILLING_TICKET_FORECAST_50 || '';
export const BILLING_TICKET_FORECAST_75 =
  process.env.BILLING_TICKET_FORECAST_75 || '';
export const BILLING_TICKET_FORECAST_85 =
  process.env.BILLING_TICKET_FORECAST_85 || '';
export const BILLING_TICKET_FORECAST_95 =
  process.env.BILLING_TICKET_FORECAST_95 || '';

export const FORECAST_MANUAL_STAGES = new Set([
  BILLING_TICKET_FORECAST,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
  BILLING_TICKET_FORECAST_85,
  BILLING_TICKET_FORECAST_95,
]);

// Subconjunto hasta el 75% — bajo ETAPA_UNICA_ENABLED, el 85%/95% manual se
// retira del uso (esos tickets nacen directo en «Próximos a facturar»), así
// que el escaneo de vencidos por ETAPA sólo tiene sentido hasta acá.
// Ver PLAN_proximos_cambios_tickets_2026-07-29.md §2 / TANDA A punto 1.
export const FORECAST_MANUAL_STAGES_UP_TO_75 = new Set([
  BILLING_TICKET_FORECAST,
  BILLING_TICKET_FORECAST_50,
  BILLING_TICKET_FORECAST_75,
]);

// ===============================
// Stages post-emisión — MANUALES
// ===============================
export const BILLING_TICKET_STAGE_ID_CREATED =
  process.env.BILLING_TICKET_STAGE_ID_CREATED || '';

export const BILLING_TICKET_STAGE_ID_LATE =
  process.env.BILLING_TICKET_STAGE_ID_LATE || '';

export const BILLING_TICKET_STAGE_ID_PAID =
  process.env.BILLING_TICKET_PIPELINE_ID_PAID || '';

// ===============================
// Tickets AUTOMÁTICOS (pipeline + stages)
// ===============================
export const AUTOMATED_TICKET_PIPELINE =
  process.env.BILLING_AUTOMATED_PIPELINE_ID || '';

// "Listo para Facturar" automático.
// Phase 3 promueve aquí y emite la factura ficticia en el mismo paso.
// ⚠️  A diferencia del pipeline manual, NO existe una etapa intermedia
//     de "Próximos a Facturar": el ticket pasa directo de forecast a ready+factura.
export const BILLING_AUTOMATED_READY =
  process.env.BILLING_AUTOMATED_READY || '';

// Auto forecast stages por bucket de deal stage
export const BILLING_AUTOMATED_FORECAST =
  process.env.BILLING_AUTOMATED_FORECAST || '';
export const BILLING_AUTOMATED_FORECAST_50 =
  process.env.BILLING_AUTOMATED_FORECAST_50 || '';
export const BILLING_AUTOMATED_FORECAST_75 =
  process.env.BILLING_AUTOMATED_FORECAST_75 || '';
export const BILLING_AUTOMATED_FORECAST_85 =
  process.env.BILLING_AUTOMATED_FORECAST_85 || '';
export const BILLING_AUTOMATED_FORECAST_95 =
  process.env.BILLING_AUTOMATED_FORECAST_95 || '';

export const BILLING_AUTOMATED_CANCELLED =
  process.env.BILLING_AUTOMATED_CANCELLED || '';

// ===============================
// Stages post-emisión — AUTOMÁTICOS
// ===============================
export const BILLING_AUTOMATED_CREATED =
  process.env.BILLING_AUTOMATED_CREATED || '';

export const BILLING_AUTOMATED_LATE =
  process.env.BILLING_AUTOMATED_LATE || '';

export const BILLING_AUTOMATED_PAID =
  process.env.BILLING_AUTOMATED_PAID || '';

// ===============================
// Sets de stages — FORECAST
// ===============================
export const FORECAST_AUTO_STAGES = new Set([
  BILLING_AUTOMATED_FORECAST,
  BILLING_AUTOMATED_FORECAST_50,
  BILLING_AUTOMATED_FORECAST_75,
  BILLING_AUTOMATED_FORECAST_85,
  BILLING_AUTOMATED_FORECAST_95,
]);

// Alias por compatibilidad
export const AUTOMATED_TICKET_INITIAL_STAGE =
  process.env.BILLING_AUTOMATED_FORECAST || BILLING_AUTOMATED_FORECAST;

// Map de pipeline → stage de cancelación (usado en cancelForecastTickets)
export const CANCELLED_STAGE_BY_PIPELINE = {
  [TICKET_PIPELINE]: TICKET_STAGES.CANCELLED,
  [AUTOMATED_TICKET_PIPELINE]: BILLING_AUTOMATED_CANCELLED,
};

// ===============================
// Sets semánticos para conteo de facturas_restantes
// ===============================

/**
 * PENDING_STAGES: tickets que reservan una obligación pero aún no facturaron.
 * Incluye todos los stages pre-factura de ambos pipelines.
 */
export const PENDING_STAGES = new Set([
  // Manual — promesas (forecast)
  ...FORECAST_MANUAL_STAGES,
  // Manual — "Próximos a Facturar" (Phase 2 promueve aquí ≤30 días antes)
  TICKET_STAGES.NEW,
  // Manual — "Listo para Facturar" (admin confirma, espera emisión)
  TICKET_STAGES.READY,
  // Auto — promesas (forecast)
  ...FORECAST_AUTO_STAGES,
  // Auto — "Listo para Facturar" auto (Phase 3 promueve aquí y emite de inmediato)
  BILLING_AUTOMATED_READY,
]);

/**
 * INVOICED_STAGES: tickets que ya generaron factura (se descuentan del total de payments).
 * Excluye CANCELLED (no cuenta como facturado).
 */
export const INVOICED_STAGES = new Set([
  // Manual post-ready
  BILLING_TICKET_STAGE_ID_CREATED,
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto post-ready
  BILLING_AUTOMATED_CREATED,
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
]);

/**
 * EMITTED_STAGES: tickets con factura confirmada por Nodum.
 * Usado para promoción de deal 85% → 95%.
 * Excluye CREATED (factura HubSpot sin confirmación Nodum).
 */
export const EMITTED_STAGES = new Set([
  // Manual
  BILLING_TICKET_STAGE_ID_CREATED,  // ← NUEVO
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto
  BILLING_AUTOMATED_CREATED,        // ← NUEVO
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
]);

/**
 * COMPLETED_STAGES: tickets completamente pagados.
 * Usado para short-circuit en line items de 1 solo pago.
 */
export const COMPLETED_STAGES = new Set([
  BILLING_TICKET_STAGE_ID_PAID,
  BILLING_AUTOMATED_PAID,
]);

/**
 * PROMOTED_STAGES: tickets que ya salieron del forecast (promovidos o más allá).
 * Usado por recalcFromTickets para calcular last_ticketed_date.
 * Excluye stages FORECAST y CANCELLED.
 */
export const PROMOTED_STAGES = new Set([
  // Manual — "Próximos a Facturar" (Phase 2 promovió desde forecast)
  TICKET_STAGES.NEW,
  // Manual — "Listo para Facturar" (admin confirmó)
  TICKET_STAGES.READY,
  // Manual — post-emisión
  BILLING_TICKET_STAGE_ID_CREATED,
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto — "Listo para Facturar" auto (Phase 3 promovió y emitió)
  BILLING_AUTOMATED_READY,
  // Auto — post-emisión
  BILLING_AUTOMATED_CREATED,
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
]);

// ===============================
// Deal stages — pipeline de negocio
// ===============================
export const DEAL_STAGE_WON          = process.env.DEAL_STAGE_85  || 'closedwon';
export const DEAL_STAGE_EN_EJECUCION = process.env.DEAL_STAGE_95  || '';
export const DEAL_STAGE_FINALIZADO   = process.env.DEAL_STAGE_100 || '';
export const DEAL_STAGE_SUSPENDED    = process.env.DEAL_STAGE_SUSPENDED || '';
export const DEAL_STAGE_VOIDED       = process.env.DEAL_STAGE_VOIDED   || '';

// Stages activos para billing (bucket 95)
export const BILLING_ACTIVE_DEAL_STAGES = new Set([
  DEAL_STAGE_WON,
  DEAL_STAGE_EN_EJECUCION,
  DEAL_STAGE_FINALIZADO,
]);

// Stages que representan un negocio cancelado/dado de baja.
// .filter(Boolean): SUSPENDED/VOIDED default a '' si no están en el .env,
// y un '' en el Set haría match espurio con un deal sin stage.
export const CANCELLED_DEAL_STAGES = new Set(
  [DEAL_STAGE_LOST, DEAL_STAGE_SUSPENDED, DEAL_STAGE_VOIDED].filter(Boolean)
);

// Fuente única de verdad para "¿este stage es de cancelación?".
export function isDealCancelledStage(stage) {
  return CANCELLED_DEAL_STAGES.has(String(stage || ''));
}

// Stages del lado GANADO — las TRES que confirmó la usuaria (2-ago-2026):
// «Cierre ganado», «En Ejecución» y «Finalizado» (buckets 85/95/100 de
// resolveBucketFromDealStage). Es la FRONTERA de la que depende quién manda:
// antes de ganar el motor rearma libremente; desde acá los ajustes son puntuales.
//
// .filter(Boolean) por el mismo motivo que CANCELLED_DEAL_STAGES: EN_EJECUCION y
// FINALIZADO defaultean a '' si no están en el .env, y un '' en el Set haría match
// espurio con un deal sin stage. (Por eso no se reusa BILLING_ACTIVE_DEAL_STAGES,
// que arma el mismo trío SIN filtrar.)
export const WON_DEAL_STAGES = new Set(
  [DEAL_STAGE_WON, DEAL_STAGE_EN_EJECUCION, DEAL_STAGE_FINALIZADO].filter(Boolean)
);

// Fuente única de verdad para "¿este negocio ya está ganado?".
export function isDealGanadoStage(stage) {
  return WON_DEAL_STAGES.has(String(stage || ''));
}

// Al final del archivo, antes del cierre
export const INVOICED_TICKET_STAGES = new Set([
  process.env.BILLING_TICKET_STAGE_ID_BILLED,
  process.env.BILLING_TICKET_STAGE_ID_LATE,
  process.env.BILLING_TICKET_PIPELINE_ID_PAID,
  process.env.BILLING_AUTOMATED_CREATED,
  process.env.BILLING_AUTOMATED_LATE,
  process.env.BILLING_AUTOMATED_PAID,
].filter(Boolean));

// ===============================
// Helpers semánticos
// ===============================

/**
 * Devuelve true si el ticket está todavía en FORECAST (promesa).
 * OJO: "promovido" (READY / AUTO_READY) debe devolver false.
 */
export function isForecastStage(stageId) {
  if (!stageId) return false;
  const id = String(stageId);
  return FORECAST_MANUAL_STAGES.has(id) || FORECAST_AUTO_STAGES.has(id);
}

/**
 * FORECAST_TICKET_STAGES: unión de todos los stages forecast (manual + auto).
 * Usado para derivar billing_next_date desde tickets reales.
 */
export const FORECAST_TICKET_STAGES = new Set([
  ...FORECAST_MANUAL_STAGES,
  ...FORECAST_AUTO_STAGES,
]);

/**
 * Alias por compatibilidad con lo que veníamos hablando.
 */
export function isForecastTicketStage(stageId) {
  return isForecastStage(stageId);
}

/**
 * DERIVED_STAGES: tickets que llegaron a "Listo para Facturar" o más allá.
 * Usado por recalcFromTickets para calcular last_billing_period.
 * = PROMOTED_STAGES sin TICKET_STAGES.NEW ("Próximos a Facturar").
 */
export const DERIVED_STAGES = new Set([
  // Manual — "Listo para Facturar" (admin confirmó)
  TICKET_STAGES.READY,
  // Manual — post-emisión
  BILLING_TICKET_STAGE_ID_CREATED,
  TICKET_STAGES.INVOICED,
  BILLING_TICKET_STAGE_ID_LATE,
  BILLING_TICKET_STAGE_ID_PAID,
  // Auto — "Listo para Facturar" auto (Phase 3 promovió y emitió)
  BILLING_AUTOMATED_READY,
  // Auto — post-emisión
  BILLING_AUTOMATED_CREATED,
  BILLING_AUTOMATED_LATE,
  BILLING_AUTOMATED_PAID,
]);


// ═══════════════════════════════════════════════════════════════════════════
// LA FRONTERA ES LA NOTIFICACIÓN (ETAPA_UNICA_ENABLED — TANDA B, 30-jul)
// ═══════════════════════════════════════════════════════════════════════════
//
// Criterio del cliente (confirmado por escrito, 29-jul; ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.0):
//
//   Todo lo que TODAVÍA NO fue notificado es futuro: el motor arma el
//   cronograma y puede rearmarlo. Desde «Notificado» en adelante es pasado:
//   no se toca.
//
// De ahí salen las dos particiones que usa Phase P (y los listeners):
//
//   · ENGINE-MANAGED ("no notificado")  → el motor manda sobre la ESTRUCTURA
//     (qué tickets existen y en qué fecha). Whitelist explícita:
//        - flag OFF: exactamente los stages FORECAST (manual + auto) = hoy.
//        - flag ON : + «Próximos a facturar» manual (TICKET_STAGES.NEW), que
//          pasa a ser la etapa única del tramo cierre-ganado → Notificado.
//     ⚠️ Los ids de 85%/95% manual (en PROD «Backlog cierre ganado» 1329838706
//        y «Backlog avanzado» 1296492871) SIGUEN en la whitelist aunque se
//        retiren del uso: hay tickets viejos parados ahí y el motor tiene que
//        poder rearmarlos/reubicarlos. Por eso las 3 props NO se pisan con el
//        mismo id — lo que se unifica es el DESTINO (ver resolveForecastStage
//        en phasep.js: bajo la flag, buckets 85/95/100 manuales apuntan todos
//        a «Próximos a facturar»).
//
//   · CRUZÓ LA FRONTERA ("pasado")      → intocable. Es el COMPLEMENTO de la
//     whitelist, menos los cancelados por el motor. Definirlo por complemento
//     y no por whitelist es deliberado: una etapa nueva o un env sin mapear
//     (p.ej. «Cobrado» manual 1311451812 en sandbox) cae del lado seguro.
//
// El caso CANCELADO se parte en dos y esa distinción es la que evita perder
// plata (ver isTicketPeriodoCerrado en utils/ticketFrontera.js):
//   · cancelado CON factura (of_invoice_id) = período cerrado por cancelación
//     definitiva → cruzó la frontera: protege su fecha y cuenta como consumido.
//   · cancelado SIN factura (lo canceló el motor, o se perdió el negocio) →
//     ni protege ni consume: esa fecha se puede volver a armar (§2.4).

/** Stages CANCELADO de ambos pipelines. */
export const CANCELLED_TICKET_STAGES = new Set(
  [TICKET_STAGES.CANCELLED, BILLING_AUTOMATED_CANCELLED].filter(Boolean)
);

/** ¿El ticket está en la etapa CANCELADO de su pipeline? */
export function isCancelledTicketStage(stageId) {
  if (!stageId) return false;
  return CANCELLED_TICKET_STAGES.has(String(stageId));
}

/**
 * ¿El motor manda sobre la estructura de un ticket en este stage?
 * Flag OFF ⇒ idéntico a isForecastStage (comportamiento de hoy).
 * Flag ON  ⇒ además «Próximos a facturar» manual (la etapa única).
 */
export function isEngineManagedStage(stageId) {
  if (!stageId) return false;
  const id = String(stageId);
  if (isForecastStage(id)) return true;
  return (
    etapaUnicaEnabled() &&
    Boolean(PROXIMOS_A_FACTURAR_STAGE) &&
    id === String(PROXIMOS_A_FACTURAR_STAGE)
  );
}

/**
 * ¿Este stage ya cruzó la frontera de la notificación? (= «Notificado» /
 * «Listo para facturar» automático en adelante).
 * Complemento de isEngineManagedStage, sin los CANCELADO — el caso cancelado
 * lo desempata isTicketPeriodoCerrado, que necesita el ticket entero.
 */
export function isPastFrontierStage(stageId) {
  if (!stageId) return false;
  const id = String(stageId);
  if (isEngineManagedStage(id)) return false;
  if (isCancelledTicketStage(id)) return false;
  return true;
}

/**
 * Devuelve true si el stage corresponde a un ticket ya facturado
 * (post-READY, excluyendo CANCELLED).
 */
export function isInvoicedStage(stageId) {
  if (!stageId) return false;
  return INVOICED_STAGES.has(String(stageId));
}

/**
 * Devuelve true si el stage indica pago completado.
 */
export function isCompletedStage(stageId) {
  if (!stageId) return false;
  return COMPLETED_STAGES.has(String(stageId));
}

// ===============================
// Otros
// ===============================
export const DEFAULT_CURRENCY = 'USD';

// Frescura de tipos de cambio (CHECK-4).
// BCU/BCP no cotizan fines de semana ni feriados, así que el último cierre puede
// tener varios días sin que sea un problema. Por eso el default tolera un fin de
// semana largo. Configurable por env. Si la última tasa es MÁS vieja que esto,
// se considera obsoleta y se alerta.
export const EXCHANGE_RATE_STALE_DAYS = Number(process.env.EXCHANGE_RATE_STALE_DAYS || 4);

// DRY RUN mode (evita crear recursos reales en HubSpot)
export const isDryRun = () => {
  return (process.env.DRY_RUN || '').toString().toLowerCase() === 'true';
};

// Lookback para el cron (días hacia atrás en hs_lastmodifieddate)
export const CRON_LOOKBACK_DAYS = parseInt(process.env.CRON_LOOKBACK_DAYS || '3', 10);