# Recorrido de prueba — Salud general en producción (DEAL E)

Health-check end-to-end sobre **un único deal** que ejercita todo el motor: mirror PY→UY, cupo,
line item manual + automático, ciclo Mantsoft (alta → edición → baja temporal → re-alta), edición
de factura por el editor y cancelación.

> **Entorno:** los scripts usan `import 'dotenv/config'` → escriben en el portal del `.env` (**producción**).
> Confirmá el `.env` antes de empezar.

## Deal de prueba

[`scripts/seed/seedMirror.mjs`](scripts/seed/seedMirror.mjs) crea **DEAL E** (Paraguay, `closedwon` 85%,
cupo por monto 50.000):

| LI | Tipo | Producto | Notas |
|----|------|----------|-------|
| **E-LI1** | Manual | Portal (`33695807329`) | cupo×monto, mensual 3p, `cogs=500`, `uy=true` |
| **E-LI2** | Automático | iJServ (`33688695870`) | auto-renew, inicio +5d, `cogs=800`, `uy=true` |

Ambos productos resuelven **Empresa emisora = ISA** en el mensaje Mantsoft. El seed loguea la emisora
esperada de cada LI como auto-verificación.

## Patrón de cada paso

```
1. Editás el objeto en HubSpot
2. node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>        # mirror / tickets / flags Mantsoft
3. node src/jobs/cronMensajeMantsoft.js --deal <DEAL_PY_ID>   # escribe mensaje_mansoft en el deal
4. Verificás en HubSpot
```
> Probá siempre con `--dry` primero (no escribe nada).

---

## Paso 0 — Seed con productos

```bash
node scripts/seed/seedMirror.mjs --dry     # revisar plan + emisora esperada (ISA/ISA)
node scripts/seed/seedMirror.mjs           # crea el deal real
```

- [ ] Anotar el **DEAL_PY_ID** (también queda en `test-seed-manifest.json`).
- [ ] Deal PY `closedwon` (85%), `cupo_total_monto=50000`, 2 LIs con producto asociado.
- [ ] El log mostró `Empresa emisora esperada: ISA` para ambos LIs.

---

## Paso 1 — Primera corrida: alta Mantsoft + creación del mirror

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>
node src/jobs/cronMensajeMantsoft.js --deal <DEAL_PY_ID> --dry
node src/jobs/cronMensajeMantsoft.js --deal <DEAL_PY_ID>
```

Verificar:
- [ ] **Deal UY espejo** creado por Phase 1 (`es_mirror_de_py`, `deal_py_origen_id = DEAL_PY_ID`).
- [ ] LI UY espejo E-LI1: `price ≈ 167` (cogs 500 / qty 3), **manual**, **sin** cupo.
- [ ] LI UY espejo E-LI2: `price = 800` (cogs 800 / qty 1), **manual**, auto-renew.
- [ ] Tickets PY: E-LI1 → 1 ticket READY manual (start hoy) + forecast; E-LI2 → ventana forecast
      automático (start +5d, Phase 3 aún no factura).
- [ ] Cupo PY `cupo_consumido` actualizado por E-LI1.
- [ ] **`mensaje_mansoft` del deal PY**: sección **🆕 Altas de hoy (1)** con E-LI2, y en el encabezado
      **Empresa emisora = ISA** ✅. El manual E-LI1 **no** aparece (Mantsoft solo dispara en automáticos).
- [ ] **Admin = Mantsoft**: el aviso rico vive en `mensaje_mansoft`; `billing_error` está vacío/secundario.

---

## Paso 2 — Edición del mirror **antes** de facturar

En HubSpot, en el **LI UY espejo de E-LI1**, editar `hs_cost_of_goods_sold` a un valor custom
(ej. `2000`) y/o un campo del ticket mirror.

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>
```

- [ ] El valor editado **NO se sobreescribe** (sigue en `2000`). El mirror respeta ediciones manuales.

---

## Paso 3 — Edición del automático → Mantsoft "edición"

En HubSpot, editar una **watched prop** de **E-LI2 PY** (ej. `price` 2000→2500, o `description`, o
`quantity`). Watched props: [`src/services/billing/mansoftSnapshot.js`](src/services/billing/mansoftSnapshot.js#L23).

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>        # Phase P detecta diff → tipo=edicion
node src/jobs/cronMensajeMantsoft.js --deal <DEAL_PY_ID>
```

- [ ] `mensaje_mansoft`: sección **🔄 Ediciones de hoy (1)** con el bloque de cambios
      (ej. "Precio unitario: 2000.00 → 2500.00").

---

## Paso 4 — Baja temporal (pausa del LI)

En HubSpot, en **E-LI2 PY** setear **juntas**:
`pausa = true`, `fecha_de_baja = <hoy>`, `motivo_de_pausa = <texto>`, `es_definitivo = false`.

> ⚠️ La `fecha_de_baja` **hay que cargarla a mano** acá. El mensaje la muestra pero **no** es watched
> prop, así que solo aparece si está seteada en el LI al momento de la baja.

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>        # transición false→true → tipo=baja
node src/jobs/cronMensajeMantsoft.js --deal <DEAL_PY_ID>
```

- [ ] `mensaje_mansoft`: sección **🛑 Bajas de hoy (1)** con **Fecha de baja**, **Motivo** y
      **Tipo de baja = Temporal** visibles.
- [ ] Phase 3 **saltea** el LI en pausa (no factura).
- [ ] **Supresión**: con la pausa activa, editar otra watched prop → correr cron → **no** re-avisa
      (la baja ya se notificó una vez).

---

## Paso 5 — Re-alta (sacar la pausa)

En HubSpot, **E-LI2 PY**: `pausa = false`.

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>        # pausa true→false; se levanta la supresión
node src/jobs/cronMensajeMantsoft.js --deal <DEAL_PY_ID>
```

- [ ] Vuelve a avisar.

> **Nota para la demo:** hoy la re-alta se clasifica como **edición** ("🔄 Pausa: true → false"), no como
> un bloque "reactivación" propio. Es el comportamiento esperado (decidido para esta prueba).

---

## Paso 6 — Facturación del automático (salud Phase 3)

En HubSpot, en **E-LI2 PY** cambiar `hs_recurring_billing_start_date` a **hoy**.

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>
```

- [ ] Phase 3 emite **factura PY**.
- [ ] Ticket UY mirror promovido a **"Próximos a Facturar"** + nota en el deal UY.
- [ ] **Anotar el `invoice_id`** de la factura emitida (objeto factura con `ticket_id`, lo usás en 6b).

---

## Paso 6b — Edición de la factura por el editor

La factura se edita desde la web app del **Editor de Facturas**.

```bash
npm start          # node server.js → http://localhost:8080  (usa .env producción)
```

1. Abrir `http://localhost:8080/invoice-editor` → **Basic Auth**: `APP_EDITOR_USER` (`admintest`) /
   `APP_EDITOR_PASSWORD`.
2. Cargar la factura por su **`invoice_id`** (Paso 6).
3. Editar campos permitidos (whitelist en
   [`api/invoice-editor/invoiceFields.config.json`](api/invoice-editor/invoiceFields.config.json)).
   Caso realista: cargar **`id_factura_nodum`** (número Nodum) → la etapa pasa a **"Emitida"** automáticamente.
4. Guardar. El backend hace en orden: actualiza la factura → `syncInvoiceToTicket` →
   `propagateInvoiceStateToTicket` → `tryAdvanceDealToEnEjecucion` → **audit log** en Postgres.

Verificar:
- [ ] El **ticket** recibió los campos sincronizados (`id_factura_nodum`, montos, etapa).
- [ ] El **deal PY** pasó a **En Ejecución (95%)**.
- [ ] El **audit log** aparece en `http://localhost:8080/invoice-editor/audit`.
- [ ] (Opcional) Cancelar la factura desde el editor (botón / `POST /invoice-editor/api/:id/cancelar`)
      y verificar que la cancelación se propaga al ticket.

> El editor necesita `APP_EDITOR_PASSWORD`, `HUBSPOT_PRIVATE_TOKEN` y acceso a Postgres
> (`DATABASE_URL` / `DATABASE_PUBLIC_URL`) para el audit log.

---

## Paso 7 — Cancelación del deal

En HubSpot, mover el deal PY a un stage cancelado: `closedlost`, **Suspendido** (`1330251122`) o
**Anulado** (`1330251123`).

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>
```

- [ ] Corre `propagateDealCancellation`.
- [ ] Tickets forecast cancelados; facturas canceladas propagadas.
- [ ] Revisar el efecto en el **deal UY espejo**.

---

## Paso 8 — Idempotencia / salud general

```bash
node src/jobs/cronDealsBatch.js --deal <DEAL_PY_ID>   # sin cambios previos
```

- [ ] **No** se duplican tickets, line items ni el deal mirror.

---

## Limpieza

```bash
node scripts/cleanup/cleanupTestDeals.mjs   # usa test-seed-manifest.json
```

---

## Checklist de salud (resumen)

| Ítem | Cómo se verifica | Paso |
|---|---|---|
| Mirror UY creado | deal con `deal_py_origen_id` | 1 |
| Cupo correcto | `cupo_consumido` tras E-LI1 | 1 |
| Ticket manual + automático | pipelines manual / automático | 1 |
| Emisora = ISA (productos) | encabezado de `mensaje_mansoft` | 1 |
| **Admin = Mantsoft** | `mensaje_mansoft` vs `billing_error` | 1 |
| Edición mirror persiste | costo no sobreescrito | 2 |
| Mantsoft edición | sección 🔄 con diff | 3 |
| Baja temporal + fecha_de_baja + supresión | sección 🛑 con fecha/motivo + no re-aviso | 4 |
| Re-alta | vuelve a avisar | 5 |
| Edición factura por editor | sync a ticket + deal→En Ejecución + audit log | 6b |
| Cancelación | tickets/facturas canceladas | 7 |
| Idempotencia | 2da corrida sin duplicados | 8 |
