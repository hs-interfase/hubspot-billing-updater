// test-nodum-prop.mjs
import { hubspotClient } from './src/hubspotClient.js'

// Probar con los primeros 5 IDs de la lista
const ids = [
  '004D16F3C7B4DF8A03258CFC0066EA41',
  '015283E172EA00DB03258C0C006DD2EC',
  '01FB698A3BC26EF703258CA80057FFC3',
  '0248ACD766DEE5B603258B46006D7A3C',
  '0272FBE61D1B855203258CCB00051423',
]

// Primero: ¿hay algún deal con id_crm_origen poblado?
const check = await hubspotClient.crm.deals.searchApi.doSearch({
  filterGroups: [{
    filters: [{ propertyName: 'id_crm_origen', operator: 'HAS_PROPERTY' }]
  }],
  properties: ['dealname', 'id_crm_origen'],
  limit: 3
})
console.log('Deals con id_crm_origen poblado:', check.total)
for (const d of (check.results || [])) {
  console.log(`  ${d.id} | ${d.properties.id_crm_origen} | ${d.properties.dealname}`)
}

// Luego buscar los IDs específicos
console.log('\n--- Buscando IDs específicos ---')
for (const id of ids) {
  const resp = await hubspotClient.crm.deals.searchApi.doSearch({
    filterGroups: [{
      filters: [{ propertyName: 'id_crm_origen', operator: 'EQ', value: id }]
    }],
    properties: ['dealname', 'id_crm_origen', 'amount', 'deal_currency_code'],
    limit: 1
  })
  const deal = resp.results?.[0]
  console.log(`${id} -> ${deal ? `${deal.properties.dealname} (${deal.properties.deal_currency_code} ${deal.properties.amount})` : 'NO ENCONTRADO'}`)
}