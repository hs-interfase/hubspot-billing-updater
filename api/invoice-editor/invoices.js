// ─────────────────────────────────────────────────────────────────────────────
// CAMBIOS A APLICAR EN api/invoice-editor/invoices.js
// ─────────────────────────────────────────────────────────────────────────────
//
// 1) Agregar helper syncTicketInvoiceStatus() después de writeAuditLog
// 2) Agregar endpoint POST /:id/cancelar después del PATCH
// 3) Modificar PATCH /:id para propagar etapa_de_la_factura al ticket
//
// ─────────────────────────────────────────────────────────────────────────────


// ── CAMBIO 1 ──────────────────────────────────────────────────────────────────
// Agregar este helper DESPUÉS de la función writeAuditLog, antes del primer router.get

/**
 * Propaga el cambio de etapa de la factura al ticket asociado.
 * Actualiza invoice_status en el ticket y, si es Cancelada, limpia of_invoice_id / of_invoice_key.
 *
 * @param {string} ticketId
 * @param {string} etapa  - valor de etapa_de_la_factura (ej: 'Cancelada', 'Emitida', etc.)
 * @param {string} invoiceId  - solo necesario para el log
 */
async function syncTicketInvoiceStatus(ticketId, etapa, invoiceId) {
  if (!ticketId) return;

  const props = { invoice_status: etapa };

  if (etapa === 'Cancelada') {
    props.of_invoice_id  = '';
    props.of_invoice_key = '';
  }

  try {
    await hs().patch(`/crm/v3/objects/tickets/${ticketId}`, { properties: props });
    console.info(`[InvoiceEditor] Ticket ${ticketId} actualizado → invoice_status=${etapa}`);
  } catch (err) {
    // No bloqueamos la respuesta si falla la propagación, pero lo registramos
    console.error(
      `[InvoiceEditor] Error actualizando ticket ${ticketId} desde invoice ${invoiceId}:`,
      err.response?.data || err.message
    );
  }
}


// ── CAMBIO 2 ──────────────────────────────────────────────────────────────────
// Agregar este endpoint DESPUÉS del router.patch('/:id', ...)

// ─────────────────────────────────────────────
// POST /invoice-editor/api/:id/cancelar
// Cancela la factura y propaga al ticket asociado
// ─────────────────────────────────────────────
router.post('/:id/cancelar', async (req, res) => {
  const { id } = req.params
  const user = req.headers['x-app-user'] || 'admin'

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'El Invoice ID debe ser un número.' })
  }

  try {
    // 1) Leer invoice para obtener ticket_id y etapa actual
    const { data: invoice } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
      params: { properties: 'etapa_de_la_factura,ticket_id' },
    })

    const etapaActual = invoice.properties?.etapa_de_la_factura
    const ticketId    = invoice.properties?.ticket_id

    if (etapaActual === 'Cancelada') {
      return res.status(400).json({ error: 'La factura ya está cancelada.' })
    }

    // 2) Actualizar invoice en HubSpot
    await hs().patch(`/crm/v3/objects/invoices/${id}`, {
      properties: { etapa_de_la_factura: 'Cancelada' },
    })

    // 3) Propagar al ticket (limpia of_invoice_id + of_invoice_key + invoice_status)
    await syncTicketInvoiceStatus(ticketId, 'Cancelada', id)

    // 4) Audit log
    writeAuditLog({
      timestamp: new Date().toISOString(),
      invoiceId: id,
      user,
      changes: {
        etapa_de_la_factura: { from: etapaActual, to: 'Cancelada' },
        ...(ticketId && { ticketActualizado: ticketId }),
      },
    })

    return res.json({
      success: true,
      invoiceId: id,
      ticketId: ticketId || null,
      etapaAnterior: etapaActual,
    })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][CANCELAR]', err.response?.data || err.message)
    return res.status(500).json({
      error: 'Error al cancelar la factura.',
      detail: err.response?.data?.message || err.message,
    })
  }
})


// ── CAMBIO 3 ──────────────────────────────────────────────────────────────────
// En el PATCH /:id existente, REEMPLAZAR el bloque try/catch del PATCH por este:
// (solo agrega la propagación al ticket si etapa_de_la_factura está en el update)

/*
  try {
    await hs().patch(`/crm/v3/objects/invoices/${id}`, {
      properties: filteredProperties,
    })

    // ── NUEVO: propagar etapa al ticket si cambió ──
    if (filteredProperties.etapa_de_la_factura) {
      // Leer ticket_id de la invoice
      const { data: invoice } = await hs().get(`/crm/v3/objects/invoices/${id}`, {
        params: { properties: 'ticket_id' },
      })
      const ticketId = invoice.properties?.ticket_id
      await syncTicketInvoiceStatus(ticketId, filteredProperties.etapa_de_la_factura, id)
    }
    // ── FIN NUEVO ──

    writeAuditLog({
      timestamp: new Date().toISOString(),
      invoiceId: id,
      user: req.headers['x-app-user'] || 'admin',
      changes: changes || filteredProperties,
      ...(rejectedFields.length > 0 && { rejectedFields }),
    })

    return res.json({
      success: true,
      invoiceId: id,
      updated: filteredProperties,
      ...(rejectedFields.length > 0 && { rejected: rejectedFields }),
    })

  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `No se encontró la factura con ID ${id}.` })
    }
    console.error('[InvoiceEditor][PATCH]', err.response?.data || err.message)
    return res.status(500).json({
      error: 'Error al actualizar la factura en HubSpot.',
      detail: err.response?.data?.message || err.message,
    })
  }
*/