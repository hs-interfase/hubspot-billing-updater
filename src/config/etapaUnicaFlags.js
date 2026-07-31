// src/config/etapaUnicaFlags.js
//
// Llave del plan "etapa única" (TANDA A, 30-jul): unifica 85% Forecast / 95%
// Forecast / «Próximos a facturar» para tickets MANUALES bajo una sola
// frontera — la NOTIFICACIÓN, no la etapa. Ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.
//
// Default OFF (mismo criterio que cancelRevertFlags.js): apagada, el
// comportamiento de los crons / cancelForecastTickets / avisos al responsable
// es IDÉNTICO al actual.
//
// Parser: SOLO 'true' / '1' / 'yes' (trim + case-insensitive) prenden. Todo lo
// demás (ausente, vacío, 'false', basura) = OFF. Evaluación POR LLAMADA (sin
// cache), para que tests y runtime puedan cambiar process.env libremente.
//
// ✅ LOS TRES BLOQUEANTES DE CÓDIGO ESTÁN CERRADOS — TANDA C (31-jul).
// Eran los tres puntos que seguían leyendo la partición vieja forecast /
// no-forecast. Quedaron resueltos así (§2.5 del plan):
//
//   1. `promotedCount` incluía «Próximos» ⇒ I3 daba el plan por completo y
//      vaciaba `billing_next_date` sin haber facturado. → recalcFromTickets
//      cuenta CONSUMIDOS = lo que cruzó la frontera (`contarConsumidos`).
//   2. `billing_next_date` salía sólo de etapas forecast ⇒ se congelaba. →
//      recalcFromTickets y syncBillingNextDateFromTickets toman la próxima
//      fecha NO NOTIFICADA (`fechaProximaNoNotificada` / isTicketEngineManaged).
//   3. `pagos_restantes` dejaba de descontarse. → pasa de contador decremental
//      a DERIVADO (total − consumidos) en recalcFromTickets; el descuento cae
//      en el paso a «Notificado», que es la decisión de la usuaria del 31-jul.
//      syncAfterPromotion deja de escribirlo, y `buildDesiredDates` deja de
//      leer la prop (usa la misma cuenta derivada).
//
// Y `last_ticketed_date` quedó ELIMINADA: no se escribe más. Los lectores que
// no tienen los tickets a mano usan `fechaNotificadaDelLineItem`
// (utils/ticketFrontera.js), que devuelve `last_billing_period` = NOTIFICADO.
//
// 🔴 LO QUE FALTA ANTES DE PRENDERLA — no es código:
//   a. Las 6 pruebas de sandbox (§2.6 del plan) con la llave prendida, que
//      validan B+C juntas. Escriben en el portal de verdad.
//   b. Apagar el workflow `1771474299` de PROD el mismo día que se prenda, o
//      llegan DOS avisos por ticket (§2.7).
//
// ✅ Ya NO hay props nuevas que crear en el portal. Los dos avisos al
// responsable (resumen al cierre ganado · individual a 1 mes) los manda un
// WORKFLOW DE HUBSPOT, no el motor — decisión de la usuaria del 30 y 31-jul.
// Por eso se borraron `dealWonScheduleSummaryAlert.js` (30-jul) e
// `individualBillingReminderAlert.js` (31-jul), y ni `of_resumen_cronograma_enviado`
// ni `of_aviso_1mes_enviado` hacen falta.

function flagOn(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** ¿Está habilitada la etapa única de tickets manuales? Default: NO. */
export function etapaUnicaEnabled() {
  return flagOn('ETAPA_UNICA_ENABLED');
}
