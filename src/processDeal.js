// src/processDeal.js
import { hubspotClient, getDealWithLineItems } from './hubspotClient.js';

// DEMO: fecha global = mínima fecha_inicio_de_facturacion de los line items
function computeNextBillingDateFromLineItems(lineItems) {
  const dates = [];

  for (const li of lineItems) {
    const props = li.properties || {};
    const raw = props.fecha_inicio_de_facturacion; // 👈 nombre correcto
    if (!raw) continue;

    const d = new Date(raw); // asumimos que viene en un formato que Date entiende
    if (!Number.isNaN(d.getTime())) {
      dates.push(d);
    }
  }

  if (!dates.length) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }

  return dates.reduce((min, d) => (d < min ? d : min), dates[0]);
}

// Lo dejamos por ahora aunque no lo usemos, por si más adelante reactivamos datos del negocio
async function getOwnerNameFromDeal(deal) {
  const ownerId = deal.properties?.hubspot_owner_id;
  if (!ownerId) return 'Sin propietario asignado';

  try {
    const owner = await hubspotClient.crm.owners.ownersApi.getById(ownerId);
    const first = owner.firstName || '';
    const last = owner.lastName || '';
    const fullName = `${first} ${last}`.trim();
    return fullName || owner.email || `Owner ${ownerId}`;
  } catch {
    return `Owner ${ownerId}`;
  }
}

function formatMoney(value, currency) {
  const num = Number(value);
  if (Number.isNaN(num)) return `no definido ${currency || ''}`.trim();
  return `${num.toFixed(2)} ${currency || ''}`.trim();
}

/**
 * Bloque de texto para un line item.
 */
function buildLineItemBlock(li, idx, moneda, notaNegocio) {
  const p = li.properties || {};

  const nombreProducto = p.name || `Línea ${idx + 1}`;
  const servicio = p.servicio || '(servicio no definido)';
  const frecuencia = p.frecuencia_de_facturacion || 'no definida';

  // Fecha de inicio de facturación (prop del line item)
  let inicioLineaTexto = 'no definida';

  if (p.fecha_inicio_de_facturacion) {
    const d = new Date(p.fecha_inicio_de_facturacion);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      inicioLineaTexto = `${da}/${m}/${y}`;
    }
  }

  const contratoA = p.contrato_a;
  const terminoA = p.termino_a;

  // Tus valores ya vienen tipo "1 Año", "Cantidad de meses", etc.
  let duracion = 'no definida';
  if (contratoA && terminoA) {
    duracion = `${contratoA} / ${terminoA}`;
  } else if (contratoA) {
    duracion = `${contratoA}`;
  } else if (terminoA) {
    duracion = `${terminoA}`;
  }

  const tercerosRaw = (p.terceros || '').toString().toLowerCase();
  const esTerceros =
    tercerosRaw === 'true' ||
    tercerosRaw === '1' ||
    tercerosRaw === 'sí' ||
    tercerosRaw === 'si' ||
    tercerosRaw === 'yes';
  const tercerosTexto = esTerceros ? 'Sí, facturación a terceros.' : 'No.';

  const notaLinea = p.nota;
  const notaLineaTexto = notaLinea ? `- Nota de la línea: ${notaLinea}` : null;

  // 👇 Comentamos lo que mete "nota del negocio" dentro de la línea
  // const notaNegocioTexto = notaNegocio
  //   ? `- Nota del negocio: ${notaNegocio}`
  //   : null;

  const qty = Number(p.quantity || 1);
  const unitPrice = Number(p.price || 0);
  const total = qty * unitPrice;

  const parts = [
    `Servicio`,
    `- Producto: ${nombreProducto}`,
    `- Servicio: ${servicio}`,
    `- Frecuencia de facturación: ${frecuencia}`,
  ];

  if (inicioLineaTexto !== 'no definida') {
    parts.push(`- Fecha de inicio de facturación: ${inicioLineaTexto}`);
  }

  if (duracion !== 'no definida') {
    parts.push(`- Duración del contrato: ${duracion}`);
  }

  parts.push(
    `- Facturación a terceros: ${tercerosTexto}`,
    `- Cantidad: ${qty}`,
    `- Precio unitario: ${formatMoney(unitPrice, moneda)}`,
    `- Importe total: ${formatMoney(total, moneda)}`
  );

  // if (notaNegocioTexto) parts.push(notaNegocioTexto);
  if (notaLineaTexto) parts.push(notaLineaTexto);

  return parts.join('\n');
}

function getLineItemStartDateIso(li) {
  const p = li.properties || {};
  const raw = p.fecha_inicio_de_facturacion;
  if (!raw) return null;

  const d = new Date(raw); // asumimos YYYY-MM-DD o algo que Date entienda
  if (Number.isNaN(d.getTime())) return null;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`; // YYYY-MM-DD
}

/**
 * Mensaje completo:
 * SOLO queremos las líneas cuyo fecha_inicio_de_facturacion coincide con la próxima fecha.
 * Sin datos generales de negocio por ahora.
 */
function buildNextBillingMessage({ deal, nextDate, lineItems }) {
  const props = deal.properties || {};
  const moneda = props.deal_currency_code || '(sin definir)';
  const notaNegocio = props.nota || null;

  const yyyy = nextDate.getFullYear();
  const mm = String(nextDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextDate.getDate()).padStart(2, '0');
  const nextDateIso = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD

  // 1) Separar line-items que tienen fecha válida
  const withDates = lineItems
    .map((li) => ({ li, iso: getLineItemStartDateIso(li) }))
    .filter((x) => x.iso);

  let relevantLineItems;

  if (withDates.length > 0) {
    // 2) Tomar solo los line-items cuya fecha_inicio_de_facturacion coincide con la próxima fecha
    relevantLineItems = withDates
      .filter((x) => x.iso === nextDateIso)
      .map((x) => x.li);

    // Por seguridad: si por alguna razón no hay match exacto, usamos todos con fecha
    if (!relevantLineItems.length) {
      relevantLineItems = withDates.map((x) => x.li);
    }
  } else {
    // 3) Si NINGÚN line-item tiene fecha de inicio, mostramos todos
    relevantLineItems = lineItems;
  }

  const lineBlocks = relevantLineItems.map((li, idx) =>
    [
      `------------------------------`,
      buildLineItemBlock(li, idx + 1, moneda, notaNegocio),
    ].join('\n')
  );

  // Por pedido tuyo: solo mostramos las líneas de elemento de pedido
  return lineBlocks.join('\n\n');
}

/**
 * Procesa UN deal:
 * - Lee deal + line items
 * - Calcula facturacion_proxima_fecha (mínima fecha_inicio_de_facturacion)
 * - Arma mensaje SOLO con el/los line items de esa fecha
 * - Actualiza el deal con fecha y mensaje
 */
export async function processDeal(dealId) {
  if (!dealId) {
    throw new Error('processDeal requiere un dealId');
  }

  const { deal, lineItems } = await getDealWithLineItems(dealId);

  const nextBillingDate = computeNextBillingDateFromLineItems(lineItems);
  // Dejamos comentado el uso de ownerName / datos de negocio en el mensaje por ahora
  // const ownerName = await getOwnerNameFromDeal(deal);

  const message = buildNextBillingMessage({
    deal,
    // ownerName,
    nextDate: nextBillingDate,
    lineItems,
  });

  const yyyy = nextBillingDate.getFullYear();
  const mm = String(nextBillingDate.getMonth() + 1).padStart(2, '0');
  const dd = String(nextBillingDate.getDate()).padStart(2, '0');
  const nextDateStr = `${yyyy}-${mm}-${dd}`;

  const updateBody = {
    properties: {
      facturacion_proxima_fecha: nextDateStr,
      facturacion_mensaje_proximo_aviso: message,
    },
  };

  await hubspotClient.crm.deals.basicApi.update(dealId, updateBody);

  return {
    dealId,
    dealName: deal.properties?.dealname,
    nextBillingDate: nextDateStr,
    lineItemsCount: lineItems.length,
  };
}
