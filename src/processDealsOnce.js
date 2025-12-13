// src/processDealsOnce.js
import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';
import { updateLineItemSchedule, computeNextBillingDateFromLineItems } from './billingEngine.js';


// Por ahora trabajamos con appointmentscheduled (Prueba 1).
// Más adelante usaremos algo como process.env.HUBSPOT_CLOSED_WON_STAGE = 'closedwon'
const TARGET_STAGE = 'appointmentscheduled';

// Normaliza una fecha cruda (string, number, Date) a Date "local" (medianoche)
function normalizeToLocalDay(raw) {
  if (!raw) return null;
  const str = raw.toString().trim();
  if (!str) return null;

  // Caso "YYYY-MM-DD"
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let d;
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]); // 1-12
    const day = Number(m[3]);   // 1-31
    d = new Date(year, month - 1, day);
  } else {
    d = new Date(str);
  }

  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

// Devuelve todas las fechas de facturación (Date) de un line item
// usando fecha_inicio_de_facturacion y fecha_2..fecha_48
function collectAllBillingDatesFromLineItem(lineItem) {
  const p = lineItem.properties || {};
  const out = [];

  const add = (raw) => {
    const d = normalizeToLocalDay(raw);
    if (!d) return;
    out.push(d);
  };

  add(p.fecha_inicio_de_facturacion);
  for (let i = 2; i <= 48; i++) {
    add(p[`fecha_${i}`]);
  }

  return out;
}

/**
 * Próxima fecha de facturación a partir de TODOS los line items:
 * - Devuelve la mínima fecha >= today (hoy a medianoche).
 * - Si no hay ninguna fecha >= today, devuelve null.
 */
export function computeNextBillingDateFromLineItems(
  lineItems,
  today = new Date()
) {
  const todayMid = new Date(today);
  todayMid.setHours(0, 0, 0, 0);

  let candidate = null;

  for (const li of lineItems || []) {
    const dates = collectAllBillingDatesFromLineItem(li);
    for (const d of dates) {
      if (d < todayMid) continue; // ignorar fechas pasadas
      if (!candidate || d < candidate) {
        candidate = d;
      }
    }
  }

  return candidate;
}

/**
 * Última fecha de facturación (la más reciente < today) a partir de TODOS los line items.
 */
export function computeLastBillingDateFromLineItems(
  lineItems,
  today = new Date()
) {
  const todayMid = new Date(today);
  todayMid.setHours(0, 0, 0, 0);

  let candidate = null;

  for (const li of lineItems || []) {
    const dates = collectAllBillingDatesFromLineItem(li);
    for (const d of dates) {
      if (d >= todayMid) continue; // solo fechas anteriores a hoy
      if (!candidate || d > candidate) {
        candidate = d;
      }
    }
  }

  return candidate;
}


// Un mensajito de texto para el deal
function buildNextBillingMessage(nextDate) {
  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');

  return `Próxima factura estimada para el ${dd}/${mm}/${yyyy}. (mensaje de prueba)`;
}

async function processDealsOnce() {
  console.log('Buscando deals en etapa', TARGET_STAGE);

  const searchRequest = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'dealstage',
            operator: 'EQ',
            value: TARGET_STAGE,
          },
          // Aquí luego podemos agregar:
          // { propertyName: 'facturacion_activa', operator: 'EQ', value: 'true' }
        ],
      },
    ],
    properties: ['dealname', 'dealstage'],
    limit: 10,
  };

  const res = await hubspotClient.crm.deals.searchApi.doSearch(searchRequest);

  if (!res.results.length) {
    console.log('No hay deals en esa etapa.');
    return;
  }

  console.log(`Encontrados ${res.results.length} deal(s).`);

  for (const d of res.results) {
    console.log('\nProcesando deal:', d.id, '-', d.properties.dealname);

    const { deal, lineItems } = await getDealWithLineItems(d.id);

    console.log(`  Line items encontrados: ${lineItems.length}`);

    const nextBillingDate = computeNextBillingDateFromLineItems(lineItems);
    const message = buildNextBillingMessage(nextBillingDate);

    // HubSpot espera fechas tipo YYYY-MM-DD para campos date
    const yyyy = nextBillingDate.getFullYear();
    const mm = String(nextBillingDate.getMonth() + 1).padStart(2, '0');
    const dd = String(nextBillingDate.getDate()).padStart(2, '0');
    const nextDateStr = `${yyyy}-${mm}-${dd}`;

    // Cambia estos nombres por los de tus propiedades reales del negocio:
    const updateBody = {
      properties: {
        facturacion_proxima_fecha: nextDateStr,
        facturacion_mensaje_proximo_aviso: message,
        facturacion_activa: 'true', // si tenés un boolean
      },
    };

    try {
      await hubspotClient.crm.deals.basicApi.update(deal.id, updateBody);
      console.log('  Deal actualizado con próxima fecha y mensaje.');
    } catch (err) {
      console.error('  Error actualizando deal:', err.response?.body || err);
    }
  }

  console.log('\nProceso terminado.');
}

processDealsOnce().catch((err) => {
  console.error('Error general:', err.response?.body || err);
});
