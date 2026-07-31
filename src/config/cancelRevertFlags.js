// src/config/cancelRevertFlags.js
//
// Llaves del flujo cancelar/revertir (bloque 2). DOS llaves INDEPENDIENTES,
// ambas default OFF:
//
//   - CANCEL_REVERT_FLOW_ENABLED: habilita la bifurcación cancel/revert
//     (intent en propagateInvoiceStateToTicket + modo en el editor + gate
//     Nodum + lock de deal). OFF → comportamiento idéntico al actual en TODO.
//
//   - CUPO_REVERT_ON_CANCEL_ENABLED: habilita llamar revertCupoForInvoice en
//     la rama Cancelada (cierra el doble consumo, hallazgo #1). Separada para
//     poder prender SOLO el fix tras validar en sandbox. OFF → el aviso
//     textual actual de cupo queda como está.
//
// Parser: SOLO 'true' / '1' / 'yes' (trim + case-insensitive) prenden.
// Todo lo demás (ausente, vacío, 'false', basura) = OFF.
// ⚠️ Semántica INVERSA a DEAL_ALERTS_ENABLED (que es default ON y solo apaga
// con 'false'/'0'/'no'): acá lo seguro es APAGADO, entonces solo un valor
// afirmativo explícito prende.
//
// Evaluación POR LLAMADA (patrón liSyncAlertasApagadas): sin cache, para que
// tests y runtime puedan cambiar process.env sin depender del orden de import.

function flagOn(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** ¿Está habilitado el flujo cancelar/revertir (llave maestra)? Default: NO. */
export function cancelRevertFlowEnabled() {
  return flagOn('CANCEL_REVERT_FLOW_ENABLED');
}

/** ¿Está habilitada la reversión real de cupo al cancelar? Default: NO. */
export function cupoRevertOnCancelEnabled() {
  return flagOn('CUPO_REVERT_ON_CANCEL_ENABLED');
}
