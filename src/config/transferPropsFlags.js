// src/config/transferPropsFlags.js
//
// TANDA E — propiedades de TRANSFERENCIA (correo de Paola 29-jul, definiciones
// de la usuaria 30-jul). Ver definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §5.bis.
//
// De los 4 ítems que faltaban de la lista del cliente, tres NO necesitaron
// código — quedaron cerrados por verificación (1-ago):
//
//   · PRODUCTO   → `of_producto` del ticket YA existe y ya se llena de donde
//                  corresponde (decisión de la usuaria). No se agrega prop nueva.
//   · RESPONSABLE→ `hubspot_owner_id` del ticket alcanza: "sólo owner del ticket
//                  está bien" (usuaria). NO se crea la prop de varios responsables.
//   · MONEDA     → `of_moneda` del ticket YA existe y sale de `deal_currency_code`
//                  del negocio (`extractDealSnapshots`). Falta que SIGA al negocio.
//   · VENDEDOR   → `of_propietario_secundario` del ticket YA existe y ES el
//                  `hubspot_owner_id` DEL NEGOCIO — la definición exacta de Paola.
//                  NO se crea una segunda prop: la que hay es la que notifica el
//                  workflow `1771473309` de PROD (avisa al owner del ticket + a
//                  `of_propietario_secundario` al pasar a «Notificado»). Duplicarla
//                  sería tener dos fuentes del mismo dato, y la que el workflow lee
//                  se quedaría vieja.
//
// Lo ÚNICO que faltaba de verdad, y es lo que prende esta llave: vendedor y
// moneda se escriben SÓLO al armar el snapshot del ticket. Si después cambia el
// vendedor o la moneda DEL NEGOCIO, los tickets ya creados se quedan con el valor
// viejo — y el workflow `1771473309` termina avisándole al vendedor ANTERIOR.
// Las dos suscripciones de webhook ya existen en PROD (`deal.propertyChange` sobre
// `hubspot_owner_id` y `deal_currency_code`, doc de webhooks 14-jul), pero el
// router las ignoraba: caían en "Property not supported".
//
// ⚠️ Vendedor y moneda NO salen del line item → NO van por LI_PROP_TO_TICKET_KEYS.
// Van por el camino deal→ticket (`services/deal/syncDealPropToTicket.js`).
//
// Default OFF (mismo criterio que etapaUnicaFlags.js / cancelRevertFlags.js):
// apagada, el motor se comporta EXACTAMENTE como hoy — el evento del negocio
// vuelve a caer en "Property not supported" y ningún ticket se toca.
//
// Parser: SOLO 'true' / '1' / 'yes' (trim + case-insensitive) prenden. Todo lo
// demás (ausente, vacío, 'false', basura) = OFF. Evaluación POR LLAMADA (sin
// cache), para que tests y runtime puedan cambiar process.env libremente.
//
// ✅ NO hay props nuevas que crear en el portal para esta tanda: las dos props
// de destino (`of_propietario_secundario` y `of_moneda`) ya existen en los dos
// portales — están en la lista de suscripciones de ticket de PROD (14-jul).

function flagOn(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** ¿Se bajan al ticket los cambios de vendedor / moneda del negocio? Default: NO. */
export function dealPropSyncEnabled() {
  return flagOn('DEAL_PROP_SYNC_ENABLED');
}
