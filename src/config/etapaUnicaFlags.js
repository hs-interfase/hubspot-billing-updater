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

function flagOn(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** ¿Está habilitada la etapa única de tickets manuales? Default: NO. */
export function etapaUnicaEnabled() {
  return flagOn('ETAPA_UNICA_ENABLED');
}
