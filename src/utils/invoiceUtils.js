export async function countActivePlanInvoices(lik) {
  try {
    const resp = await hubspotClient.crm.objects.searchApi.doSearch('invoices', {
      filterGroups: [{
        filters: [{ propertyName: 'line_item_key', operator: 'EQ', value: lik }]
      }],
      properties: ['etapa_de_la_factura'],
      limit: 100,
    });

    const results = resp?.results ?? [];
    return results.filter(inv => {
      const etapa = (inv.properties?.etapa_de_la_factura || '').trim().toLowerCase();
      return etapa !== 'cancelada';
    }).length;
  } catch (err) {
    logger.warn({ module: 'urgentBillingService', fn: 'countActivePlanInvoices', lik, err },
      'Error contando facturas activas, fail open');
    return null; // fail open: no bloqueamos si no podemos contar
  }
}
