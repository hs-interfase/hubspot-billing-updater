// src/config/mirrorPuntualFlags.js
//
// Llave de la TANDA D — EL ESPEJO. Ver
// definitivos/PLAN_proximos_cambios_tickets_2026-07-29.md §3.
//
// LA REGLA (cerrada 29/30-jul, no re-derivarla):
//
//   Line item original → line item espejo: SE COPIA, PUNTUAL (sólo la prop que
//   cambió), con las mismas propiedades que ya se transferían antes del cierre
//   ganado y con la traducción que corresponda (costo del original → PRECIO del
//   espejo · descripción → descripción).
//
//   Ticket original → ticket espejo: SE AVISA, NO SE COPIA. El aviso lleva el
//   ANTES y el DESPUÉS ("en el original, tal propiedad pasó de X a Y") y se
//   emite ANTES del cambio para las props sensibles.
//
// Default OFF (mismo criterio que etapaUnicaFlags.js / cancelRevertFlags.js):
// apagada, el comportamiento del espejo es IDÉNTICO al de hoy — el LI espejo se
// reescribe entero en cada corrida del cron y el ticket espejo no se entera de
// nada. Con cada pieza hay un test de par OFF/ON que lo fija.
//
// Parser: SOLO 'true' / '1' / 'yes' (trim + case-insensitive) prenden. Todo lo
// demás (ausente, vacío, 'false', basura) = OFF. Evaluación POR LLAMADA (sin
// cache), para que tests y runtime puedan cambiar process.env libremente.
//
// ── LAS TRES DECISIONES DE LA USUARIA (1-ago), para no re-preguntarlas ───────
//
//   1. FORMA DEL AVISO al ticket espejo: prop informativa `of_billing_error`
//      del ticket + correo a MIRROR_ALERT_TO_EMAIL. El motor NO crea la tarea
//      (la crea un workflow de HubSpot desde la prop, igual que el aviso al
//      responsable del sync LI→ticket). El correo es la convención vigente
//      desde el 25-jul: "todos los avisos a mirror van también por correo".
//
//   2. PROPS SENSIBLES (avisan ANTES de tocar el espejo): sólo las tres
//      confirmadas — costo · precio · cantidad. En props concretas del LI:
//      `price`, `quantity`, `hs_cost_of_goods_sold`, `costo_total_usd`.
//      Todo lo demás que se copie avisa DESPUÉS. Agregar una prop a la lista
//      es una línea en MIRROR_SENSITIVE_LI_PROPS (mirrorLiPropMap.js).
//
//   3. A QUÉ TICKET del espejo va el aviso cuando el original tiene varios:
//      al de la MISMA FECHA, resuelto por clave de ticket (§3.2 caso 8).
//      Si el espejo no tiene ticket de ese período, el aviso NO se pierde:
//      cae al `billing_error` del DEAL espejo, que es exactamente lo que hace
//      el motor hoy.
//
// ── LO QUE ESTA LLAVE **NO** CAMBIA ─────────────────────────────────────────
//
//   · La PROMOCIÓN del ticket UY a «Próximos a facturar»
//     (mirrorUtils.js:232-238) sigue igual. El motor lo promueve A PROPÓSITO
//     para que administración lo revise: no se deshace nunca.
//   · Los espejos SELLADOS (`mig_espejo_independiente`) siguen sin copiarse.
//     Lo que suma la llave es que ahora TAMBIÉN AVISAN al ticket espejo, no
//     sólo al deal.
//   · Ningún ticket se archiva. El aviso a un ticket que ya cruzó la frontera
//     (§3.2 caso 7) escribe of_billing_error y nada más: avisar sí, tocar nunca.
//
// ── 🔴 DOS COSAS A SABER ANTES DE PRENDERLA ─────────────────────────────────
//
//   1. EL CAMINO REACTIVO CUELGA DE `LI_PROP_SYNC_ENABLED`. La copia puntual y
//      el aviso se enganchan dentro de syncLineItemPropToTickets, y a esa
//      función sólo se llega si la RUTA 4 de api/escuchar-cambios.js encoló el
//      evento — y esa ruta exige `LI_PROP_SYNC_ENABLED`. Con esa llave apagada,
//      prender ésta sólo cambia el camino del CRON (el upsert puntual), no el
//      reactivo. Verificar el estado de las dos llaves en Railway antes de dar
//      por prendida la tanda.
//
//   2. LA COLA COLAPSA EVENTOS Y ESO PUEDE PERDER UN AVISO. webhook_queue
//      marca 'superseded' los pending del mismo (deal_id, action_type) sin
//      mirar la propiedad (webhookQueue.js:162-181): si el vendedor toca dos
//      props del mismo negocio seguidas, del primer evento no queda nada.
//      · La COPIA se recupera sola: el upsert puntual del cron compara todas
//        las props deseadas contra el espejo y escribe lo que difiera.
//      · El AVISO de esa propiedad se pierde. Es la trampa conocida de la cola
//        (también la sufre `li_prop_sync`), y arreglarla es tarea aparte —
//        acá sólo queda anotado para no descubrirlo en producción.

function flagOn(name) {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** ¿Está habilitado el espejo puntual + el aviso al ticket espejo? Default: NO. */
export function mirrorPuntualEnabled() {
  return flagOn('MIRROR_PUNTUAL_ENABLED');
}
