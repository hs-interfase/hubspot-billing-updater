// api/invoice-editor/stageTransitions.js
//
// Matriz MÍNIMA de transiciones de etapa_de_la_factura (prep cancelar/revertir,
// hallazgo #4 del control de cambios: Cancelada → Emitida permitía re-editar una
// factura terminal y duplicar la facturación del período).
//
// Decisión aprobada: 'Cancelada' es TERMINAL e irreversible. Para volver a
// facturar el período se usa la refacturación del ticket (factura NUEVA con la
// misma of_invoice_key), nunca reviviendo la cancelada.
//
// Deliberadamente conservadora: SOLO bloquea salir de 'Cancelada'; todo el resto
// de las transiciones (Pendiente/Emitida/Enviada/Paga/Atrasada entre sí, y
// cualquiera → Cancelada) sigue permitido como hoy. Esta matriz se endurecerá
// cuando aterrice el flujo nuevo de cancelar/revertir tickets.

export const ETAPA_CANCELADA = 'Cancelada'

/**
 * ¿Está permitido pasar la factura de la etapa `desde` a la etapa `hacia`?
 *
 * - null/undefined en cualquiera de los dos lados → permitido (flujos que no
 *   mandan etapa, o facturas sin etapa seteada, siguen funcionando como hoy).
 * - false ÚNICAMENTE cuando desde === 'Cancelada' y hacia !== 'Cancelada'.
 *
 * @param {string|null|undefined} desde etapa actual de la factura
 * @param {string|null|undefined} hacia etapa solicitada
 * @returns {boolean}
 */
export function esTransicionEtapaPermitida(desde, hacia) {
  if (desde == null || hacia == null) return true
  const from = String(desde).trim()
  const to = String(hacia).trim()
  if (from === '' || to === '') return true
  return !(from === ETAPA_CANCELADA && to !== ETAPA_CANCELADA)
}
