// test-nodum-prop.mjs
import { hubspotClient } from './src/hubspotClient.js'
import { PROMOTED_STAGES } from './src/config/constants.js'

// Intendencia de Lavalleja - factura 6435
const companyId = '53946065514'
const montoUYU = 43060
const tcTrad = 39.845
const montoUSD = montoUYU / tcTrad
const fechaValor = '2025-10-01'

console.log(`Factura: UYU ${montoUYU} / tc ${tcTrad} = USD ${montoUSD.toFixed(2)}`)

const assoc = await hubspotClient.crm.associations.v4.basicApi.getPage(
  'companies', companyId, 'tickets', undefined, 100
)
const ticketIds = assoc.results.map(r => String(r.toObjectId))

const batch = await hubspotClient.crm.tickets.batchApi.read({
  inputs: ticketIds.map(id => ({ id })),
  properties: ['subject', 'of_moneda', 'total_real_a_facturar', 'of_fecha_de_facturacion', 'hs_pipeline_stage']
})

console.log('\nTodos los tickets (sin filtro de moneda):')
for (const t of batch.results) {
  const p = t.properties
  const monto = parseFloat(p.total_real_a_facturar || '0')
  const diffDirecto = Math.abs(monto - montoUYU).toFixed(2)
  const diffConvertido = Math.abs(monto - montoUSD).toFixed(2)
  const promoted = PROMOTED_STAGES.has(p.hs_pipeline_stage)
  console.log(`  ticket ${t.id} | ${p.of_moneda} ${monto} | fecha=${p.of_fecha_de_facturacion}`)
  console.log(`    diff vs UYU ${montoUYU}: ${diffDirecto} | diff vs USD ${montoUSD.toFixed(2)}: ${diffConvertido}`)
  console.log(`    promoted=${promoted} | ${p.subject}`)
}