# Contexto — Recalcular contadores derivados dentro del motor

> Documento de handoff para arrancar el task en un chat nuevo.
> Repo: `hubspot-billing-updater` (Node ESM, deploy en Railway).

---

## 1. Objetivo del task

Hacer que **el comportamiento natural del motor** mantenga al día los contadores
derivados de facturación de cada line item, **en cada corrida activa** (al tocar
"Actualizar" y en los crons), sin depender de scripts manuales ni de que ocurra
una emisión/cancelación.

Contadores involucrados (a confirmar la lista completa en el paso 0):
- `progreso_pagos` — barra `███░░ 3 / 12`
- `facturas_restantes`
- `facturas_por_derivar`
- `pagos_emitidos`
- (posibles otros: "pagos restantes", etc. → **enumerarlos todos primero**)

---

## 2. El problema (verificado en código)

Hoy esos contadores **solo se recalculan cuando ocurre un EVENTO real de
facturación**: emisión de factura, cambio de etapa de un ticket, o cancelación.
**Ni "Actualizar" ni el cron nocturno los recomputan.**

Síntoma reportado por la usuaria: se clona un negocio de **12 pagos**, se edita el
clon a **6 pagos**; al tocar "Actualizar" el progreso de pagos **queda desfasado**
(sigue calculado sobre 12) hasta que se emita/cancele algo.

---

## 3. Cómo funciona el motor hoy (verificado)

Todos los entry points convergen en el mismo núcleo:

`runPhasesForDealLocked` → `runPhasesForDeal`  (en `src/phases/index.js`)

Lo disparan:
- **"Actualizar"** (line item) → webhook `api/escuchar-cambios.js` → cola
  `src/webhookQueue.js` (`executeJob`, caso `'recalc'`).
- **CLI** `src/runBilling.js`.
- **Cron días de semana** `src/jobs/cronDealsBatch.js` (selectivo).
- **Cron fin de semana** `src/jobs/cronWeekendFull.js` (barrido completo + auditorías).

Secuencia real dentro de `runPhasesForDeal` (pasos generales intercalados con fases):
1. Limpieza de tickets clonados
2. **Phase 1** (`phase1.js`) — fechas, calendario, cupo, `line_item_key`, impuestos, mirror, tags
3. Si cancelado → propaga y termina
4. Propaga facturas canceladas
5. Promoción 85%→95%
6. **Phase P** (`phasep.js`) — crea/actualiza/borra tickets forecast
7. Asignación de owner
8. Catch-up (promueve forecasts atrasados)
9. **Phase 2** (`phase2.js`) — promueve manual a "Próximos a Facturar"
10. **Phase 3** (`phase3.js`) — promueve a READY y **emite** factura automática

---

## 4. Quiénes escriben los contadores y cuándo (verificado)

| Contador | Mecánica | Writer (archivo) | Qué hace |
|---|---|---|---|
| `facturas_restantes` | **stateless** (conteo) | `src/services/billing/recalcFacturasRestantes.js` | `total − tickets en INVOICED_STAGES` por LIK. Pone `fechas_completas=true` al llegar a 0. AUTO_RENEW → vacío. |
| `facturas_por_derivar` | **stateless** (conteo) | `src/services/billing/recalcDerivedFacturas.js` | `total − tickets en DERIVED_STAGES` (READY + INVOICED) por LIK. |
| `progreso_pagos` (+ `billing_next_date` autorenew) | **stateless** (conteo) | `src/services/billing/syncBillingState.js` | Llama a `recalcFacturasRestantes` y arma la barra con `buildPagoDisplay(countInvoiced, total)`. |
| `pagos_restantes` | **⚠️ stateful (decremental)** | `src/services/lineItems/syncAfterPromotion.js` (línea ~195) | Cada promoción de ticket hace `max(0, actual − 1)`. Se inicializa en `total` si está vacío. NO se deriva de un conteo. |
| `pagos_emitidos` | **no lo escribe el código** | — (¿propiedad **calculada/rollup de HubSpot**? CONFIRMAR en HubSpot) | Solo se LEE en `src/billingEngine.js` y avisos Mantsoft. |

`total` = `hs_recurring_billing_number_of_payments`.
Stages: `INVOICED_STAGES` y `DERIVED_STAGES` exportados desde `src/config/constants.js`.

### ⚠️ Distinción crítica para el refactor: stateless vs stateful
- Los **stateless** (`facturas_restantes`, `facturas_por_derivar`, `progreso_pagos`)
  se calculan contando tickets → **recomputarlos en cada corrida es seguro e
  idempotente**. Son el caso fácil.
- **`pagos_restantes` es STATEFUL**: es un decremento acumulado (`−1` por promoción).
  Si el motor lo "recomputa" como los otros, se **rompe** (doble decremento / reset).
  Decisión a tomar en el chat nuevo: **(a)** dejarlo como está (decremental por
  promoción) y NO tocarlo en el recálculo, o **(b)** convertirlo a stateless
  (`total − tickets promovidos`) y unificar con los demás.
- **`pagos_emitidos`**: si la usuaria espera que el motor lo mantenga, primero hay
  que confirmar si es una propiedad calculada de HubSpot (entonces NO se toca desde
  Node) o si debería pasar a ser escrita por el motor (decisión de diseño).

### Dónde se llaman HOY (todos event-driven, NO en el flujo activo de fases)
- `syncBillingState`: `invoiceService.js` (al emitir ×2), `ticketService.js` (al
  escribir etapas de ticket ×2), `phase1.js` (**solo** con `dealIsCanceled:true`),
  `ticketCleanupService.js` (cancelación).
- `recalcFacturasRestantes`: `propagacion/invoice.js` (cancelación), `syncBillingState`.
- `recalcDerivedFacturas`: `invoiceService.js` (al emitir ×2).

### Importante: `recalcFromTickets` ≠ los contadores
`src/services/lineItems/recalcFromTickets.js` **SÍ** corre dentro de las fases
(phase2, phase3, catch-up de `phases/index.js`, `missedBillingGuard.js`), pero solo
recalcula **fechas** (`billing_next_date`, `last_ticketed_date`, etc.) y cuenta
tickets para invariantes de fecha. **No escribe** los contadores de progreso.

---

## 5. Idea de solución (a diseñar en el chat nuevo)

Insertar, dentro del flujo de fases, una recomputación de contadores **por line
item**, idealmente **después de Phase 3** (cuando las etapas de tickets ya están
estables tras promover/emitir).

Opciones a evaluar:
- **(A)** Nuevo paso en `phases/index.js` tras Phase 3: loop de line items →
  `syncBillingState` + `recalcDerivedFacturas` (reutiliza writers de producción).
- **(B)** Unificar el conteo en **una sola búsqueda de tickets por LIK** y
  computar los contadores juntos (más eficiente y consistente que 2-3 searches por
  línea) — escribir un nuevo "recalcContadores" y que los writers actuales lo usen.

---

## 6. Restricciones / cuidados (prudencia)

- **Costo de API**: el cron procesa muchos deals; cada contador hoy hace búsquedas
  de tickets por línea. Medir y, si se puede, **una sola búsqueda por LIK**.
- **Idempotencia**: los writers ya hacen PATCH solo si el valor cambió — mantenerlo.
- **Efecto colateral**: `recalcFacturasRestantes` marca `fechas_completas=true` al
  llegar a 0, y Phase 1 lee `fechas_completas` para saltar el schedule → cuidar el
  **orden** (por eso conviene recomputar al final, no antes de Phase 1).
- **Mirror UY**: la corrida debe cubrir también las líneas del espejo (hoy el cron
  corre fases sobre el mirror; "Actualizar" no corre P/2/3 sobre el mirror — gap aparte).
- **`facturacion_activa=false`**: decidir si los contadores se recomputan igual
  (reflejan la realidad de los tickets, así que probablemente sí).
- **Casos borde** ya cubiertos por los writers: pago único (sin total ni
  frecuencia → 1 cuota), auto-renew (contadores vacíos), sin total utilizable.
- **Tests**: ya existen (`src/__tests__/buildPagoDisplay.test.js`, etc.). Agregar
  cobertura del nuevo paso.

---

## 7. Primeros pasos sugeridos para el chat nuevo

0. Confirmar en **HubSpot** si `pagos_emitidos` es propiedad calculada/rollup
   (el código nunca la escribe). Definir qué hacer con `pagos_restantes`
   (stateful) vs los stateless. Cerrar la lista completa de contadores.
1. Decidir punto de inserción (A vs B) y orden respecto a `fechas_completas`.
2. Implementar con una sola búsqueda de tickets por LIK si es viable.
3. Probar en `--dry` sobre el deal del clon 12→6 antes de tocar el flujo real.
4. Correr `cronDealsBatch --deal <id> --dry` y validar.

## 8. Material ya disponible
- Script manual de respaldo (no es la solución final, pero sirve para validar el
  "esperado"): `scripts/fix/recalcProgresoPagos.mjs` (dry por defecto).
