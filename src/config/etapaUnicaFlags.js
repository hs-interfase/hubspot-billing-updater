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
// 🔴 NO PRENDER ESTA LLAVE HASTA QUE ESTÉ LA TANDA C (las tres fechas y los
// contadores). Verificado el 31-jul al cerrar la TANDA B: con la etapa única,
// tres cosas siguen leyendo la partición vieja forecast / no-forecast y quedan
// mal. No rompen con la llave apagada; con la llave prendida, sí:
//
//   1. recalcFromTickets.js:408-428 — `promotedCount` cuenta PROMOTED_STAGES,
//      que incluye «Próximos a facturar». Con todo el cronograma ganado en la
//      etapa única, un plan fijo de 12 da promotedCount=12 ≥ 12 ⇒ el invariante
//      I3 lo toma por COMPLETO y vacía `billing_next_date` sin haber facturado.
//   2. recalcFromTickets.js:382 y syncBillingNextDateFromTickets.js:40 —
//      `billing_next_date` se deriva SÓLO de etapas forecast ⇒ con la etapa
//      única se congela (el invariante I4 evita que se vacíe, salvo el caso 1).
//   3. `pagos_restantes` lo descuenta syncAfterPromotion desde la promoción de
//      Phase 2, que bajo esta llave ya no ocurre (la etapa es una sola) ⇒ deja
//      de descontarse por ese camino. Y buildDesiredDates corta con
//      `pagos_restantes === 0` (phasep.js), así que el número importa.
//
// El nuevo punto de descuento y la definición de las tres fechas (próxima /
// notificado / confirmado) son la TANDA C — ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §2.5.

function flagOn(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** ¿Está habilitada la etapa única de tickets manuales? Default: NO. */
export function etapaUnicaEnabled() {
  return flagOn('ETAPA_UNICA_ENABLED');
}
