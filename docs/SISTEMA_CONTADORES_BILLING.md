# Sistema de Contadores de Billing — Line Item

> **Fuente de verdad: el código.** Este doc fue verificado contra el repo
> (lectura directa + grep) el 2026-06-25. Donde una versión previa del doc
> divergía del código, se marca con **[CORRECCIÓN]**. Cada writer/lector lleva
> su referencia `archivo:línea` para poder re-auditarlo.

Cada Line Item (LI) tiene propiedades que rastrean el progreso de facturación.
Este documento describe cada una: qué es, quién la escribe, quién la lee, cuándo,
y cómo interactúan.

---

## Tabla resumen

| Propiedad | Tipo | Stateless / Stateful | Writer(s) en código | ¿Se recomputa en cada corrida hoy? |
|---|---|---|---|---|
| `hs_recurring_billing_number_of_payments` | meta (input) | — | Manual en HubSpot / `scripts/fix/fillNumberOfPayments.mjs` | No (es input) |
| `facturas_restantes` | contador | **stateless** (conteo) | `recalcFacturasRestantes.js` | **No** (solo en eventos) |
| `facturas_por_derivar` | contador | **stateless** (conteo) | `recalcDerivedFacturas.js` | **No** (solo al emitir) |
| `progreso_pagos` | display | **stateless** (conteo) | `syncBillingState.js` | **No** (solo en eventos) |
| `fechas_completas` | flag | derivado de conteo | `recalcFacturasRestantes.js` | **No** |
| `pagos_restantes` | contador | **⚠️ stateful** (decremental) | `syncAfterPromotion.js` | Solo al promover un ticket |
| `pagos_emitidos` | numérica | **sin writer** | **— (ninguno)** ⚠️ bug latente | Nunca lo escribe el motor |

> **El refactor "recalc contadores" (Phase R)** apunta a los tres **stateless**
> (`facturas_restantes`, `facturas_por_derivar`, `progreso_pagos`), que son
> conteos puros e idempotentes. `pagos_restantes` (stateful) y `pagos_emitidos`
> (sin writer) quedan **fuera** de Phase R por las razones de abajo.

---

## Propiedades

### 1. `hs_recurring_billing_number_of_payments` (alias `number_of_payments`)

**Qué es:** total de pagos contratados del plan. La "meta" del plan fijo.

**Quién lo escribe:** manualmente en HubSpot al crear el LI, o vía
`scripts/fix/fillNumberOfPayments.mjs` (calcula desde fecha inicio, fecha
vigencia y frecuencia). El motor **no** lo escribe: es input.

**Valores:**
- `N > 0` → plan fijo de N pagos.
- vacío/null/0 → auto-renew (si hay frecuencia) o pago único (si no hay frecuencia).

---

### 2. `facturas_restantes`

**Qué es:** pagos que aún faltan emitir. `max(0, cuotasTotales − countTickets)`,
con `countTickets` = tickets del LIK en `INVOICED_STAGES`.

**Writer único:** `src/services/billing/recalcFacturasRestantes.js`.
Llamado desde:
- `syncBillingState.js:97` (plan fijo).
- `src/propagacion/invoice.js` (cancelación) y demás eventos de facturación.

**Lógica (`recalcFacturasRestantes.js`):**
1. Lee `hs_recurring_billing_number_of_payments` → `cuotasTotales`.
2. AUTO_RENEW → limpia `facturas_restantes` (`''`) y retorna.
3. **[CORRECCIÓN — pago único YA resuelto]** Si `cuotasTotales` inválido/≤0
   **y no hay frecuencia** → fuerza `cuotasTotales = 1` (`recalcFacturasRestantes.js:85-91`,
   bloque `PAGO_UNICO`). *El "gap de pago único" que describía la versión previa
   del doc ya está implementado (Opción B). Queda como pendiente solo validar en
   una corrida real que sella `fechas_completas`.*
4. PLAN_FIJO con `cuotasTotales` inválido **y con** frecuencia → no calcula
   (limpia si tenía valor; `reason: no_total_payments`).
5. PLAN_FIJO sin `line_item_key` → retorna sin calcular (`reason: missing_line_item_key`).
6. Cuenta tickets por LIK en `INVOICED_STAGES` (`of_line_item_key EQ`, limit 100) → `countTickets`.
7. `restantes = max(0, cuotasTotales − countTickets)`.
8. Si `restantes === 0` → setea `fechas_completas = 'true'` y dispara `alertFechasCompletas`.
   También corrige `fechas_completas` a `true` si ya era 0 pero el flag estaba en `false`.

---

### 3. `facturas_por_derivar`

**Qué es:** pagos del plan fijo que aún no fueron "derivados" al flujo operativo.
`max(0, cuotasTotales − countDerived)`, con `countDerived` = tickets del LIK en
`DERIVED_STAGES` (= `READY` + `INVOICED_STAGES`; excluye forecast y "Próximos a Facturar").

**Writer único:** `src/services/billing/recalcDerivedFacturas.js`.
Llamado desde `invoiceService.js` (`createInvoiceFromTicket`, al emitir).

**Lógica:** paralela a `facturas_restantes` —
- AUTO_RENEW → limpia.
- **[CORRECCIÓN]** Pago único ya cubierto: `recalcDerivedFacturas.js:93-99` fuerza
  `cuotasTotales = 1` con el mismo criterio.
- PLAN_FIJO → `porDerivar = max(0, cuotasTotales − countDerived)`.
- Dispara `alertDerivacionCompleta` al llegar a 0.

**Diferencia con `facturas_restantes`:** `facturas_restantes` mide contra
`INVOICED_STAGES` (facturas confirmadas); `facturas_por_derivar` mide contra
`DERIVED_STAGES` (READY + facturadas) → cuántos faltan promover/derivar al flujo
operativo.

---

### 4. `fechas_completas`

**Qué es:** flag (`'true'`/`'false'`). Indica que el plan del LI está completo:
no se generan más tickets. **Es el flag más importante del sistema** — una vez en
`true`, el LI queda "sellado".

**Writer:** `recalcFacturasRestantes.js` — cuando `restantes === 0` (y la
corrección de consistencia: si ya era 0 pero el flag estaba en `false`). Al
sellar dispara `alertFechasCompletas`.

**Lectores (consumidores):**
- `billingEngine.js` `updateLineItemSchedule()` → **regla predominante**: si
  `fechas_completas=true` → `billing_next_date = ''` y sale.
- `recalcFromTickets()` → guard: si `true` → skip recalc completo (`EMPTY_RESULT`).
- `filterActiveLineItems()` (`phases/index.js:129-134`) → excluye esos LIs de las
  fases P/2/3.
- `phaseP/buildDesiredDates()` → relacionado (ver `pagos_restantes`).

> **Orden importa para Phase R:** como Phase 1 excluye de P/2/3 los LIs con
> `fechas_completas=true`, el recálculo de contadores debe ir **al final** (tras
> Phase 3). Así un `fechas_completas=true` recién sellado afecta la corrida
> siguiente, no la actual.

---

### 5. `progreso_pagos`

**Qué es:** string de display. Ej: `"███░░░░░░░ 3 / 12"`.

**Writer:** `src/services/billing/syncBillingState.js` — tras
`recalcFacturasRestantes`, arma la barra con
`buildPagoDisplay(countTickets, cuotasTotales)` (`syncBillingState.js:104-106`).
También se limpia en cancelación (`syncBillingState.js:80-82`).

**Fórmula (`buildPagoDisplay`, `syncBillingState.js:24-33`):**
- `cuotasTotales ≤ 0`/undefined → `''`.
- si no → barra Unicode de 10 bloques + `"emitidas / cuotasTotales"` (emitidas se
  capa al total).

---

### 6. `pagos_restantes` — ⚠️ STATEFUL  **[CORRECCIÓN]**

> **La versión previa del doc no listaba esta propiedad y, en su punto 6,
> atribuía su writer a `pagos_emitidos`. Es al revés:** quien escribe es
> `syncLineItemAfterPromotion`, y lo que escribe es **`pagos_restantes`**, no
> `pagos_emitidos`.

**Qué es:** "promesas" de pago que quedan. **No se deriva de un conteo**: es un
**decremento acumulado**.

**Writer único:** `src/services/lineItems/syncAfterPromotion.js`.
- Init: si `pagos_restantes` está vacío → arranca en `totalPayments`
  (`syncAfterPromotion.js:114-118`).
- Cada promoción de ticket → `newRemaining = max(0, currentRemaining − 1)`
  (`syncAfterPromotion.js:120-123`).
- PATCH solo si cambió (`syncAfterPromotion.js:191-196`).
- Llamado desde Phase 2, Phase 3, y `urgentBillingService.js:575-585`.

**Lectores (¡no es cosmético!):**
- `phaseP/buildDesiredDates()` (`phasep.js:326`) → si `pagos_restantes === 0`
  ⇒ **early return, no crea forecasts**.
- `dealAlerts.js` → `pagos_restantes === 0` dispara alerta `billing_error` en el deal.
- Mensajes Mantsoft (`buildMensajeMantsoft.js:208`).

**Por qué NO se toca en Phase R:** al ser decremental, recomputarlo "como los
stateless" lo rompe (doble decremento / reset). Y como **alimenta el gating de
Phase P y las alertas**, convertirlo a stateless es un refactor con riesgo real,
no cosmético → tratar en task aparte si hace falta.

---

### 7. `pagos_emitidos` — ⚠️ SIN WRITER (bug latente)  **[CORRECCIÓN]**

**Qué es:** propiedad **numérica** en HubSpot (confirmado: **no** es rollup ni
calculada). Cantidad de pagos ya emitidos.

**Writer:** **ninguno.** grep en todo `src/`: `pagos_emitidos` **solo se lee**,
nunca se escribe. La versión previa del doc decía que la escribía
`syncLineItemAfterPromotion` — **falso** (esa función escribe `pagos_restantes`).

**Lectores:**
- `billingEngine.js:549-550` → `noHaIniciado = !lastTicketedYmd && pagosEmitidos === 0`
  (guard de init de `billing_anchor_date`).
- `billingEngine.js:855-857` (`computeLineItemCounters`) y `:891-893`
  (`computeBillingCountersForLineItem`) → `restantes = total − emitidos`.
- `cronMensajeMantsoft.js:58`, `buildMensajeMantsoft.js:207`.

**Impacto (bug latente):** como es numérica sin writer ni rollup, su valor es
estático (lo que se haya cargado a mano, típicamente vacío/0). Entonces:
- el guard de `billing_anchor_date` cae siempre al lado `pagosEmitidos === 0`;
- `computeLineItemCounters` / `computeBillingCountersForLineItem` calculan
  `avisosRestantes` sobre un `emitidos` que nadie mantiene.

**Decisión:** fuera de Phase R. Registrar como bug aparte. Opciones a evaluar:
(a) que el motor lo escriba (p. ej. = `countTickets` en `INVOICED_STAGES`), o
(b) dejar de leerlo y derivar esos cálculos del conteo de tickets (que ya es la
fuente de verdad de `facturas_restantes`).

---

## Propiedades de fecha (writers reales — verificados por grep)

> La versión previa del doc atribuía estas a `recalcFromTickets`. En el código
> los writers están **distribuidos**:

| Propiedad | Writer(s) reales |
|---|---|
| `billing_next_date` | `billingEngine.js` `updateLineItemSchedule` (recurrente / pago único), `syncBillingState.js` (solo AUTO_RENEW), `syncAfterPromotion.js`, `recalcFromTickets` / `syncBillingNextDateFromTickets`. En **PLAN_FIJO la fuente de verdad son los tickets**, no `syncBillingState`. |
| `last_ticketed_date` | `billingEngine.js:514,624,661`, `syncAfterPromotion.js`, `recalcFromTickets`. |
| `last_billing_period` | `invoiceService.js:78,314,535` (al crear invoice / sync), `recalcFromTickets`. |
| `billing_last_billed_date` | `propagacion/invoice.js:367` (fecha **real** de emisión confirmada por Nodum). |
| `billing_anchor_date` | `billingEngine.js:553,561` `updateLineItemSchedule` — solo si está vacía o si el LI no inició (`!lastTicketedYmd && pagosEmitidos === 0`). |

---

## Flujo por tipo de LI

### Plan Fijo (frecuencia + `number_of_payments`)
```
getEffectiveBillingConfig → maxOccurrences = number_of_payments, interval = freq
buildDesiredDates         → N fechas desde anchor, descuenta tickets promovidos
Phase P                   → crea forecasts para fechas pendientes
Phase 2/3                 → promueve a READY → syncAfterPromotion (pagos_restantes--)
recalcFromTickets         → si promotedCount >= N → billing_next_date = ''
recalcFacturasRestantes   → restantes = total - count; si 0 → fechas_completas=true
syncBillingState          → progreso_pagos = "███░░ 3/12"
updateLineItemSchedule    → si fechas_completas=true → billing_next_date='' y sale
```
✅ Funciona.

### Auto-Renew (frecuencia, sin `number_of_payments` finito, o `renovacion_automatica=true`)
```
isAutoRenew = true
recalcFacturasRestantes → limpia facturas_restantes
syncBillingState        → progreso_pagos = ''
buildDesiredDates       → hasta hardMax=24 fechas a futuro
updateLineItemSchedule  → billing_next_date infinito desde anchor
```
✅ Funciona. No usa contadores de plan fijo.

### Pago Único (sin frecuencia, sin `number_of_payments`)
```
buildDesiredDates       → { desiredCount: 1, dates: [startYmd] }
Phase P                 → crea 1 ticket forecast
updateLineItemSchedule  → path ONE_TIME: si lastTicketedYmd → billing_next_date=''
recalcFacturasRestantes → [CORRECCIÓN] PAGO_UNICO: cuotasTotales=1 → calcula bien
recalcDerivedFacturas   → [CORRECCIÓN] PAGO_UNICO: cuotasTotales=1
syncBillingState        → progreso_pagos = "██████████ 1 / 1"
```
✅ **Resuelto en código** (Opción B ya implementada). Pendiente: validar en
corrida real que `fechas_completas` se sella.

---

## Implicancias para el refactor "Phase R" (recalc contadores)

1. **Phase R** = nuevo paso tras Phase 3 en `phases/index.js`, loop sobre los LIs
   refrescados, que recompone los **tres stateless** por LIK preservando los
   efectos colaterales (`fechas_completas=true` a 0, alertas). Cubre los tres
   entry points (Actualizar, cron, CLI) porque todos convergen en `runPhasesForDeal`.
2. **`pagos_restantes`** → no se toca en Phase R (stateful + alimenta gating/alertas).
3. **`pagos_emitidos`** → fuera de Phase R; bug latente a tratar aparte.
4. **Eficiencia:** hoy los stateless hacen 2 búsquedas de tickets por LIK
   (`INVOICED` + `DERIVED`). Una sola búsqueda alcanza para los tres (lo demuestra
   `scripts/fix/recalcProgresoPagos.mjs`). Opción A (reusar writers, seguro) para
   arrancar; Opción B (1 búsqueda por LIK) como optimización medida.

---

## Pendientes / decisiones abiertas

- [ ] **`pagos_emitidos`:** definir si el motor lo escribe o se deja de leer
      (bug latente — hoy nadie lo mantiene).
- [ ] **`pagos_restantes`:** ¿dejar stateful (recomendado) o migrar a stateless?
      Migrar toca gating de Phase P + alertas → task aparte.
- [ ] **Pago único:** validar en corrida real que `fechas_completas` se sella
      (el path ya existe en código).
- [ ] **Phase R:** punto de inserción tras Phase 3; arrancar con Opción A.
