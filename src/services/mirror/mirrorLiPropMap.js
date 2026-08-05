// src/services/mirror/mirrorLiPropMap.js
//
// TANDA D — el mapeo LINE ITEM ORIGINAL (PY) → LINE ITEM ESPEJO (UY), puro y
// testeable. Sin I/O: acá sólo se decide QUÉ se copia, CÓMO se traduce y QUÉ
// avisa antes. El orquestador (mirrorLiPuntualSync.js) hace las llamadas.
//
// ── FUENTE DE LA LISTA DE PROPS ──────────────────────────────────────────────
// La regla dice "con las mismas propiedades que ya se transferían antes del
// cierre ganado". Esa lista NO se inventa acá: es la `allowedProps` que
// dealMirroring.js ya usa en el upsert del espejo (mirrorDealToUruguay §4).
// Está copiada abajo como MIRROR_COPY_PROPS y las dos tienen que seguir siendo
// la misma lista — hay un test que las compara para que no se separen en
// silencio.
//
// ── LA TRADUCCIÓN (§3.1 del plan) ────────────────────────────────────────────
//   costo del original → PRECIO del espejo · cliente final → cliente final ·
//   descripción → descripción
//
// De las tres, sólo la primera es una traducción de verdad; las otras dos son
// identidad (mismo nombre de prop a cada lado), y así están implementadas.
//
// 🔴 El PRECIO del original NO se copia al espejo — nunca se copió, y no es un
// olvido: el price del espejo ES el costo del original (el espejo UY factura al
// costo de PY). Por eso `price` está en las SENSIBLES (avisa) pero no en las
// copiables. Copiarlo rompería el modelo económico del espejo entero.
//
// ❓ `cliente final`: NO existe hoy ninguna prop de line item con ese nombre en
// el código ni en el portal (se buscó `cliente_final` / `clientefinal` en todo
// src/ el 1-ago: cero resultados; lo más cercano es `cliente_partner`, que vive
// en el TICKET y lo deriva ticketService desde la etiqueta de asociación de la
// empresa, no desde el LI). La traducción es identidad, así que el día que la
// prop exista alcanza con sumarla a MIRROR_COPY_PROPS. Queda marcado como hueco
// en vez de inventar un nombre de prop que rompería en runtime con un 400.
//
// ── LAS SENSIBLES (decisión usuaria 1-ago) ───────────────────────────────────
// costo · precio · cantidad, y nada más. Son las que avisan ANTES de tocar el
// espejo; el resto avisa después. El costo son DOS props porque el costo vive
// en dos lugares desde la definición del 7-jul: `costo_total_usd` es la fuente
// de verdad (siempre USD) y `hs_cost_of_goods_sold` es la derivada en moneda
// del deal.

/**
 * Props del LI original que se COPIAN al espejo (identidad de nombre).
 * Espejo exacto de la `allowedProps` de dealMirroring.js — ver test
 * mirrorLiPropMap.test.mjs, que falla si las dos listas se separan.
 */
export const MIRROR_COPY_PROPS = new Set([
  'name',
  'description',
  'quantity',
  'recurringbillingfrequency',
  'hs_recurring_billing_frequency',
  'hs_recurring_billing_start_date',
  'hs_recurring_billing_number_of_payments',
  'hs_recurring_billing_period',
  'billing_anchor_date',
  'servicio',
  'subrubro',
  'unidad_de_negocio',
  'renovacion_automatica',
  'facturacion_activa',
  'pausa',
  'motivo_de_pausa',
  'hs_product_id',
  'hs_sku',
]);

/**
 * Props del LI original que, al cambiar, obligan a RECALCULAR el `price` del
 * espejo (la traducción costo → precio). No se copian con su propio nombre:
 * alimentan la cuenta de computeMirrorUnitPrice().
 *
 * `quantity` está en las dos listas a propósito: se copia tal cual Y cambia el
 * precio unitario del espejo, porque el costo del original es TOTAL de la línea
 * y el price del espejo es UNITARIO (price = costo_total_usd ÷ quantity).
 */
export const MIRROR_PRICE_SOURCE_PROPS = new Set([
  'costo_total_usd',
  'hs_cost_of_goods_sold',
  'dolar',
  'quantity',
]);

/**
 * Props SENSIBLES: avisan al espejo ANTES de modificarlo (decisión usuaria
 * 1-ago). costo · precio · cantidad. El costo son dos props (ver cabecera).
 */
export const MIRROR_SENSITIVE_LI_PROPS = new Set([
  // Monto y costo de PY — las tres confirmadas el 1-ago.
  'price',
  'quantity',
  'hs_cost_of_goods_sold',
  'costo_total_usd',

  // ── Agregadas el 5-ago-2026 para cubrir lo que María pidió por escrito ──
  // (correo del 6-jul, "Notificaciones PY + Lógica edición de ticket"). Ella
  // pidió aviso ante «monto y costo de PY», «fecha de facturación esperada» y
  // «campo UY (si un line item pasa a formar parte de UY o si deja de serlo)».
  // Las dos primeras ya estaban; faltaban estas.
  //
  // La fecha va con sus DOS nombres porque el motor las trata como sinónimos
  // (syncLineItemPropToTicket.js:87-88).
  'hs_recurring_billing_start_date',
  'fecha_inicio_de_facturacion',
  // El campo UY sólo AVISA: no se copia al espejo (no tendría sentido, el
  // espejo ES el lado UY). Al estar acá, isMirrorableLiProp lo deja pasar.
  'uy',
]);

// 📌 A propósito NO se incluye `billing_next_date`: la recalcula el motor en
// cada ciclo, así que avisar por ella sería ruido constante y no una edición
// de nadie. La fecha que una persona EDITA es la de inicio de facturación.

/** Etiqueta legible de la prop, para el texto del aviso ("pasó de X a Y"). */
export const MIRROR_PROP_LABELS = {
  price: 'precio',
  quantity: 'cantidad',
  hs_cost_of_goods_sold: 'costo',
  costo_total_usd: 'costo (USD)',
  hs_recurring_billing_start_date: 'fecha de facturación esperada',
  fecha_inicio_de_facturacion: 'fecha de facturación esperada',
  uy: 'campo UY',
  dolar: 'tipo de cambio',
  name: 'nombre',
  description: 'descripción',
  servicio: 'rubro',
  subrubro: 'subrubro',
  unidad_de_negocio: 'unidad de negocio',
  renovacion_automatica: 'renovación automática',
  facturacion_activa: 'facturación activa',
  pausa: 'pausa',
  motivo_de_pausa: 'motivo de pausa',
};

/** Nombre legible de una prop (cae al nombre técnico si no está mapeada). */
export function labelDeProp(propertyName) {
  return MIRROR_PROP_LABELS[propertyName] || String(propertyName || '');
}

/** ¿Esta prop del original AVISA antes de tocar el espejo? */
export function esPropSensible(propertyName) {
  return MIRROR_SENSITIVE_LI_PROPS.has(propertyName);
}

/**
 * ¿Esta prop del original tiene algo que hacer en el espejo? (copiarse,
 * recalcular el precio, o avisar aunque no se copie — el caso de `price`).
 */
export function isMirrorableLiProp(propertyName) {
  if (!propertyName) return false;
  return (
    MIRROR_COPY_PROPS.has(propertyName) ||
    MIRROR_PRICE_SOURCE_PROPS.has(propertyName) ||
    MIRROR_SENSITIVE_LI_PROPS.has(propertyName)
  );
}

/**
 * El PRECIO unitario del espejo a partir del costo del original.
 *
 * Es la MISMA cuenta que hace dealMirroring.js en el upsert (definición
 * 2026-07-07 + PY3 de María del 7-jul), movida acá para que el camino puntual y
 * el camino del cron no puedan diferir:
 *
 *   price = costo_total_usd ÷ quantity           ← fuente de verdad (USD)
 *   price = hs_cost_of_goods_sold ÷ dolar        ← fallback legacy
 *   price = hs_cost_of_goods_sold                ← sólo si el deal PY ya es USD
 *
 * El espejo se crea con deal_currency_code='USD', así que el price va SIEMPRE
 * en USD: usar cogs directo en un deal en guaraníes lo inflaba ×TC.
 * Deal en moneda ≠ USD sin dato USD confiable → NO se adivina: missingCost.
 *
 * @param {Object} srcProps        properties del LI original
 * @param {string} [sourceCurrency] moneda del deal PY ('USD', 'PYG', …)
 * @returns {{price:string, unitCost:number, source:string|null, missingCost:boolean}}
 */
export function computeMirrorUnitPrice(srcProps = {}, sourceCurrency = 'USD') {
  const qty = parseFloat(srcProps.quantity) || 1;
  const costoTotalUsd = parseFloat(srcProps.costo_total_usd);
  const cogsMonedaDeal = parseFloat(srcProps.hs_cost_of_goods_sold);
  const dolarLi = parseFloat(srcProps.dolar);

  let unitCost = NaN;
  let source = null;
  if (costoTotalUsd > 0) {
    unitCost = costoTotalUsd / qty;
    source = 'costo_total_usd/qty';
  } else if (cogsMonedaDeal > 0 && dolarLi > 0) {
    unitCost = cogsMonedaDeal / dolarLi;
    source = 'cogs/dolar';
  } else if (cogsMonedaDeal > 0 && String(sourceCurrency || 'USD').toUpperCase() === 'USD') {
    unitCost = cogsMonedaDeal;
    source = 'cogs';
  }

  if (isNaN(unitCost) || unitCost <= 0) {
    return { price: '0', unitCost: 0, source: null, missingCost: true };
  }
  return { price: String(unitCost), unitCost, source, missingCost: false };
}

/**
 * EL PATCH PUNTUAL: dada la prop que cambió en el original, qué props del
 * espejo hay que escribir — y NADA MÁS. Es el corazón de "puntual": el resto
 * del line item espejo no se toca, así que lo que el equipo operativo editó a
 * mano en UY sobrevive.
 *
 * @param {Object} params
 * @param {string} params.propertyName   prop del LI original que cambió
 * @param {Object} params.srcProps       properties actuales del LI original
 * @param {string} [params.sourceCurrency] moneda del deal PY
 * @returns {{patch:Object, missingCost:boolean, priceSource:string|null}}
 *          patch vacío ⇒ esta prop no escribe nada en el espejo (p.ej. `price`,
 *          que avisa pero no se copia).
 */
export function buildMirrorLiPatch({ propertyName, srcProps = {}, sourceCurrency = 'USD' }) {
  const patch = {};
  let missingCost = false;
  let priceSource = null;

  // 1) Copia por identidad de nombre (descripción → descripción, etc.)
  if (MIRROR_COPY_PROPS.has(propertyName) && propertyName in srcProps) {
    patch[propertyName] = srcProps[propertyName];
  }

  // 2) Traducción costo → precio del espejo
  if (MIRROR_PRICE_SOURCE_PROPS.has(propertyName)) {
    const { price, source, missingCost: mc } = computeMirrorUnitPrice(srcProps, sourceCurrency);
    patch.price = price;
    missingCost = mc;
    priceSource = source;
  }

  return { patch, missingCost, priceSource };
}

/**
 * Sólo las claves cuyo valor DIFIERE del actual. Es lo que convierte el update
 * del cron (hoy: reescribe la hoja entera) en un update puntual, y lo que hace
 * que la corrida siguiente no pise lo que el camino reactivo ya escribió.
 *
 * Comparación por string, igual que el patch mínimo del sync LI→ticket: HubSpot
 * devuelve todo como texto y `120` vs `120.0` no debe contar como cambio…
 * salvo que lo sea de verdad, por eso los numéricos se comparan por valor
 * numérico cuando ambos lados parsean.
 *
 * @param {Object} desired  props que se querrían escribir
 * @param {Object} current  properties actuales del objeto destino
 * @returns {Object} subconjunto de `desired` que realmente cambia
 */
export function pickChangedProps(desired = {}, current = {}) {
  const out = {};
  for (const [k, v] of Object.entries(desired)) {
    const cur = current?.[k];
    const a = Number(v);
    const b = Number(cur);
    const ambosNumericos =
      String(v ?? '').trim() !== '' &&
      String(cur ?? '').trim() !== '' &&
      Number.isFinite(a) &&
      Number.isFinite(b);
    if (ambosNumericos) {
      if (a !== b) out[k] = v;
    } else if (String(v ?? '') !== String(cur ?? '')) {
      out[k] = v;
    }
  }
  return out;
}
