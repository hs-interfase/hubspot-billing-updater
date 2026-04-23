// test-nodum-prop.mjs
import { hubspotClient } from './src/hubspotClient.js'

// Buscar company "Tribunal de Cuentas" por código 1817
const resp = await hubspotClient.crm.companies.searchApi.doSearch({
  filterGroups: [{
    filters: [{ propertyName: 'codigo_cliente_comercial', operator: 'EQ', value: '1817' }]
  }],
  properties: ['name'],
  limit: 1
})

const company = resp.results?.[0]
console.log('Company:', company?.id, company?.properties?.name)

if (company) {
  // Traer tickets asociados a esa company via Associations API
  const assoc = await hubspotClient.crm.associations.v4.basicApi.getPage(
    'companies', company.id, 'tickets', undefined, 100
  )
  console.log('Tickets asociados:', assoc.results?.length || 0)
  
  if (assoc.results?.length) {
    // Traer detalle del primer ticket
    const ticketId = assoc.results[0].toObjectId
    const ticket = await hubspotClient.crm.tickets.basicApi.getById(ticketId, [
      'subject', 'of_moneda', 'total_real_a_facturar', 'of_fecha_de_facturacion',
      'numero_de_factura', 'hs_pipeline_stage', 'nombre_empresa'
    ])
    console.log('Ejemplo ticket:', JSON.stringify(ticket.properties, null, 2))
  }
}