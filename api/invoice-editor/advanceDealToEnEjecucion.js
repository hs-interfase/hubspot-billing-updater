// api/invoice-editor/advanceDealToEnEjecucion.js
/**
 * Avanza un deal de Ganado (closedwon / SC6) a En Ejecución (SC7)
 * cuando se detecta la primera factura Nodum asociada.
 *
 * Flujo: invoiceId → ticket_id (ya conocido) → of_deal_id → dealstage → PATCH
 *
 * Fire-and-forget: nunca lanza excepción hacia el llamador.
 * Logging con console para no introducir dependencia de logger del core.
 */
import axios from 'axios'

function hs() {
  return axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_TOKEN}` },
    timeout: 10000,
  })
}

const DEAL_STAGE_WON          = process.env.DEAL_STAGE_80 || 'closedwon'
const DEAL_STAGE_EN_EJECUCION = process.env.DEAL_STAGE_95 || '1327905636'

/**
 * Intenta avanzar el deal asociado al ticket a "En Ejecución".
 * Solo actúa si el deal está actualmente en "Ganado" (DEAL_STAGE_WON).
 *
 * @param {string|null} ticketId  ID del ticket asociado a la factura
 */
export async function tryAdvanceDealToEnEjecucion(ticketId) {
  if (!ticketId) return

  try {
    // 1) Ticket → of_deal_id
    const { data: ticket } = await hs().get(`/crm/v3/objects/tickets/${ticketId}`, {
      params: { properties: 'of_deal_id' },
    })

    const dealId = ticket.properties?.of_deal_id

    if (!dealId) {
      console.warn('[advanceDeal] ticket sin of_deal_id, skip', { ticketId })
      return
    }

    // 2) Deal → dealstage actual
    const { data: deal } = await hs().get(`/crm/v3/objects/deals/${dealId}`, {
      params: { properties: 'dealstage' },
    })

    const currentStage = deal.properties?.dealstage

    if (currentStage !== DEAL_STAGE_WON) {
      console.log('[advanceDeal] deal no está en Ganado, skip', { dealId, currentStage })
      return
    }

    // 3) Avanzar a En Ejecución
    await hs().patch(`/crm/v3/objects/deals/${dealId}`, {
      properties: { dealstage: DEAL_STAGE_EN_EJECUCION },
    })

    console.info('[advanceDeal] ✅ Deal avanzado a En Ejecución', { dealId, ticketId })

  } catch (err) {
    // fire-and-forget: loguear y absorber sin bloquear la respuesta al cliente
    console.error('[advanceDeal] Error al avanzar deal', {
      ticketId,
      detail: err.response?.data || err.message,
    })
  }
}