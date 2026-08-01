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

// ═══════════════════════════════════════════════════════════════════════════
// CUPO_ASIENTO_EN_EMISION_ENABLED — el asiento se mueve a la emisión (§1, D2)
// ═══════════════════════════════════════════════════════════════════════════
//
// HOY el cupo se asienta cuando se CREA la factura (`invoiceService.js` paso 11
// → consumeCupoAfterInvoice), y la factura nace en etapa `Pendiente` y sin
// `id_factura_nodum`: el cupo se compromete contra una factura que todavía no
// existe para Nodum. Es el pedido de la usuaria del 29-jul.
//
// Con la llave prendida el asiento pasa al momento en que la factura llega a
// una etapa ASENTABLE — «Emitida» o posterior, menos «Cancelada» (decisión de
// la usuaria, 31-jul). Se engancha en `propagateInvoiceStateToTicket`, que es
// por donde pasan tanto el editor externo como el pipeline de Nodum.
//
// 🔴 LO QUE ESTA LLAVE **NO** HACE: no construye el freno. Verificado en el
// código el 31-jul — **hoy no existe ningún chequeo que impida facturar por
// encima del cupo**: `createInvoiceFromTicket` no tiene guard de cupo, y al
// agotarse lo único que pasa es que `cupo_activo='false'` hace que las facturas
// siguientes **dejen de consumir** (validación 4 de consumeCupo), no que se
// frenen. El §1.1 del plan da ese freno por existente y **es falso**.
// Decisión de la usuaria (31-jul): mover el asiento igual; el freno se trata
// aparte. Consecuencia a tener presente: entre «factura creada» y «Emitida» el
// cupo queda sin asentar, y como tampoco hay freno, esa ventana no está
// cubierta por nada.
//
// La REVERSIÓN no necesita llave nueva: `revertCupoForInvoice` ya actúa sólo si
// el ticket tiene el marker `cupo_consumo_invoice_id` de esa factura, así que
// revertir una factura que nunca se asentó ya es un no-op limpio — que es
// exactamente lo que pide D3.

/** ¿El asiento del cupo se hace en la emisión en vez de al crear la factura? Default: NO. */
export function cupoAsientoEnEmisionEnabled() {
  return flagOn('CUPO_ASIENTO_EN_EMISION_ENABLED');
}

/** Etapas de factura que NO asientan cupo. El resto sí. */
const ETAPAS_FACTURA_SIN_ASIENTO = new Set(['pendiente', 'cancelada']);

/**
 * ¿Esta etapa de factura asienta el cupo?
 *
 * «Emitida o posterior, menos Cancelada» (usuaria, 31-jul). Se define por
 * COMPLEMENTO y no por whitelist a propósito: los valores conocidos hoy son
 * Pendiente · Emitida · Enviada · Paga · Atrasada · Cancelada, y si mañana
 * aparece una etapa nueva va a ser posterior a Emitida — con whitelist el cupo
 * dejaría de asentarse en silencio, que es el modo de fallar caro.
 *
 * Etapa vacía ⇒ false: una factura sin etapa no se asienta.
 *
 * @param {string|null|undefined} etapa valor de `etapa_de_la_factura`
 * @returns {boolean}
 */
export function esEtapaFacturaAsentable(etapa) {
  const e = String(etapa ?? '').trim().toLowerCase();
  if (!e) return false;
  return !ETAPAS_FACTURA_SIN_ASIENTO.has(e);
}
