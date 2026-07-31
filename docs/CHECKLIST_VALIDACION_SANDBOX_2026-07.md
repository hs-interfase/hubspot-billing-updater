# CHECKLIST DE VALIDACIÓN EN SANDBOX — features de tickets (julio 2026)

> **Rama:** `feat/semana-tickets-fase1` · **Portal:** SANDBOX (51101688) — NO tocar prod.
> **Qué se valida:** (A) eliminación de `facturar_ahora` en LINE ITEMS (el de ticket queda),
> (B) edición de props reales del TICKET manual → `valor_recalc` del deal,
> (C) aviso al responsable del ticket cuando el sync LI→ticket escribe cambios,
> más Fase 0 (ticket emitido editable) y la asociación al closedwon (Fase 3).
> **Guion pensado para correrse de punta a punta un lunes, en orden 1→6.**

---

## Prerrequisitos generales

- [ ] `.env` apuntando a SANDBOX (token de la app privada de pruebas, `BILLING_TICKET_PIPELINE_ID` y stages del portal de pruebas).
- [ ] `DATABASE_URL` de la cola de webhooks del entorno de pruebas a mano. Verificar conexión:

```sql
-- psql "$DATABASE_URL"
SELECT status, count(*) FROM webhook_queue GROUP BY status ORDER BY 1;
```

- [ ] Servidor de webhooks corriendo y recibiendo (Railway de pruebas, o local con `npm start` + túnel). Logs: panel de Railway del servicio de webhooks, o consola local (con `PRETTY_LOGS=true` se leen mejor).
- [ ] Pasada de un deal puntual (para Fase 0 y regresiones): `node ./src/runBilling.js --deal <DEAL_ID>`.
- [ ] Flags del `.env` sandbox revisadas ANTES de arrancar (anotar valores):
  - `LI_PROP_SYNC_ENABLED` (sync LI→ticket; para las checklists 4 y 5 debe estar `true`)
  - `LI_SYNC_OWNER_ALERT_ENABLED` (aviso al responsable; **ausente = ON**)
  - `ASSOC_ALL_ON_CLOSEDWON` + `ASSOC_CLOSEDWON_ONLY_MANUAL` (checklist 2: ambas `true`)
  - `DEAL_ALERTS_ENABLED` (si está off, no esperar emails de alertas de deal)
- [ ] **Estados reales de la cola** (para leer las queries): `pending` → `processing` → `done` | `failed` | `superseded` (dedup). OJO: el estado final exitoso es **`done`**, no "completed".

Query genérica para mirar los últimos jobs (se reusa en todas las checklists):

```sql
SELECT id, action_type, object_type, object_id, deal_id, property_name,
       status, error, created_at, finished_at
  FROM webhook_queue
 ORDER BY id DESC
 LIMIT 20;
```

---

## 1. Fase 0 — Ticket emitido sigue editable (nada lo revierte)

**Precondiciones**
- [ ] Un deal ganado (`facturacion_activa=true`) con al menos un ticket en etapa **Emitido** del pipeline manual (o emitir uno durante la prueba).
- [ ] Anotar: `DEAL_ID`, `TICKET_ID`, `INVOICE_ID` de la factura asociada, y los valores actuales de nota / descripción / `monto_unitario_real`.

**Pasos**
1. [ ] En HubSpot, editar en el ticket emitido: `nota`, descripción (`content`) y `monto_unitario_real` (poner valores distinguibles, ej. sufijo `-TEST-F0`).
2. [ ] Correr la pasada del deal: `node ./src/runBilling.js --deal <DEAL_ID>`.
3. [ ] Reabrir el ticket en HubSpot y comparar campo por campo.
4. [ ] Abrir la factura asociada y comparar montos/fechas contra lo anotado.

**Resultado esperado**
- NADA se revierte: los tres campos editados conservan el valor `-TEST-F0` (Phase P clasifica el emitido como `protected` y no lo re-snapshotea).
- La factura asociada **NO cambia** (freeze rule: la factura emitida queda congelada; editar el ticket post-emisión NO la actualiza — para tocar la factura es por invoice-editor).

**Evidencia a registrar**
- [x] `DEAL_ID`, `TICKET_ID`, `INVOICE_ID` + captura del ticket antes/después de la pasada.
- [x] Captura de la factura sin cambios.
- [x] Log de la pasada mostrando el ticket clasificado como protegido (buscar `protected` / Phase P en el log del deal).
- [ ] **Anotar la evidencia también en `docs/PLAN_FEATURES_TICKETS_2026-07.md` (Fase 0)** — el plan lo pide como criterio de cierre.

### ✅ CORRIDA 2026-07-29 — PASA

**Caso:** deal `62638017133` "MiFactura Soporte Toyotoshi 2025/2026" (original PY, espejo UY
`62638858131`) · ticket `46740740632` (Emitido, pipeline manual) · factura `570496510292`
(`id_factura_nodum=2087`).

**Edición aplicada** (por API, equivalente a la edición de UI para el motor): `nota` + sufijo
` -TEST-F0` · `content` vacío → `TEST-F0` · `monto_unitario_real` `1272.73` → `1333.33`.
Pasada: `node ./src/runBilling.js --deal 62638017133`.

**Resultado:** los **3 campos sobrevivieron** intactos. La **factura no cambió en ningún campo**
(freeze rule confirmada). Lo único que se movió en el ticket fue **lo derivado**, correctamente:
`subtotal_real` 1272.73 → 1333.33 (monto × cantidad) y `of_margen_usd` 318.73 → 379.33 (+60.60,
el mismo delta del monto). En el log, Phase P: *"Key cubierta por ticket protegido, saltando
creación"*.

⚠️ **Gotcha de selección de caso (costó un intento):** el primer candidato (ticket `46722816942`,
deal `62637996037` "Eidas … - UY") era un **espejo UY** → `runBilling` lo saltea
(`isMirrorDealFromDeal`, `runBilling.js:144`: *"Mirror suelto, saltando — se procesa desde su
original"*) y la pasada no ejercita nada. **Para cualquier prueba de esta checklist hay que elegir
el deal ORIGINAL**, no el espejo: se reconoce por `es_mirror_de_py` o `deal_py_origen_id` con valor.
Las ediciones de ese intento fallido se restauraron a sus valores originales.

---

## 2. Asociación al closedwon — e2e (Fase 3)

**Precondiciones**
- [ ] `.env` sandbox: `ASSOC_ALL_ON_CLOSEDWON=true` y `ASSOC_CLOSEDWON_ONLY_MANUAL=true`.
- [ ] Un deal **NO ganado** (stage previo a closedwon, `facturacion_activa` vacía/false) con line items que generen cronograma forecast en ambos pipelines (manual y automático). Correr una pasada para que existan los tickets forecast.
- [ ] Anotar `DEAL_ID`.

**Pasos**
1. [ ] Con el deal NO ganado: abrir el negocio en HubSpot → pestaña de tickets asociados.
2. [ ] Verificar contra Search que los tickets existen aunque no se vean (los forecast nacen sin asociación):
   - En el CRM: lista de tickets filtrada por `of_deal_id = <DEAL_ID>` → deben aparecer.
3. [ ] Pasar el deal a **closedwon** (esto encola/ejecuta el flujo; si el webhook de dealstage no dispara la pasada completa, correr `node ./src/runBilling.js --deal <DEAL_ID>`).
4. [ ] Reabrir el negocio y contar los tickets asociados por pipeline.
5. [ ] Regresión: verificar que la promoción/emisión siguió normal (tickets con fecha ≤30 días promovidos a "Próximos a Facturar"; automáticos del día emitidos como siempre).

**Resultado esperado**
- Antes del cierre: **0 tickets asociados** visibles en el negocio (aunque el cronograma exista por Search).
- Después del cierre, política vigente (decisión 13-jul + ajustes 19-jul y 22-jul, `associateOnClosedWon.js`):
  - pipeline **MANUAL** → TODOS asociados (pasados y futuros);
  - pipeline **AUTOMÁTICO pasado** (por `fecha_resolucion_esperada` ≤ hoy) → asociado;
  - pipeline **AUTOMÁTICO futuro** → SOLO el próximo a facturar por line item (resto queda suelto hasta que le toque; kill-switch `ASSOC_NEXT_AUTO_FORECAST=false`).
  > ⚠️ Nota: la política NO es "solo manuales" a secas — el flag `ASSOC_CLOSEDWON_ONLY_MANUAL` gobierna el trato especial del automático, pero el pasado automático y el próximo futuro SÍ se asocian.
- Idempotencia: correr la pasada de nuevo NO duplica asociaciones.
- Regresión intacta: promoción a "Próximos a Facturar" y emisión automática sin cambios de comportamiento.

**Evidencia a registrar**
- [x] `DEAL_ID` + captura del negocio ANTES (0 asociados) y DESPUÉS (asociados por pipeline).
- [x] Conteo esperado vs. real: manuales / auto pasados / próximo auto.
- [x] Log de `associateOnClosedWon` (asociados/saltados).

### ✅ CORRIDA 2026-07-29 — PASA

**El sandbox no tenía ningún caso servible:** de los 58 deals abiertos, **0 tienen line items** (toda
la data es migrada = ganada), y `seedTestDeals.mjs` nace en `closedwon` y apunta a una company que
en sandbox **no existe** (`52069639218` → 404). Se sembró a medida: deal `63252656430`
`[TEST-P2] Asociacion al ganar`, stage **`decisionmakerboughtin` (Calificado, 50%)**, company
`55480071766` (LA HORQUILLA), con 2 LIs mensuales de plan finito elegidos para que el cronograma
cayera a ambos lados de hoy:
- LI `57565277478` **MANUAL** 4 pagos, start −1 mes → 2 pasados + 2 futuros
- LI `57573566267` **AUTO** 6 pagos, start −2 meses → 3 pasados + 3 futuros

**ANTES de ganar** (`runBilling --deal`): Phase P creó **10 tickets** y el hook registró
`applies:false` → **0 asociados**, con los 10 igual encontrables por `of_deal_id`. Salió además el
guard existente *"Facturación próxima/vencida en negocio no ganado"* en `billing_error` del deal.

**DESPUÉS de pasar a `closedwon`** (+ `facturacion_activa=true` en deal y LIs — en el portal eso lo
hace un workflow, el motor la lee pero no la escribe):

| Regla | Esperado | Real |
|---|---|---|
| MANUAL → todos (pasados y futuros) | 4/4 | **4/4** ✅ |
| AUTO pasado → se asocia | 3/3 | **3/3** ✅ |
| AUTO futuro → sólo el próximo por LI | 1/3 (el de 2026-08-29) | **1/3** ✅ |

Log del hook: `ticketsFound:10 · considered:8 · dealLinked:3 · companyLinked:3 · alreadyLinked:5 ·
skippedByPipeline:2 · autoPastLinked:3 · autoNextLinked:1 · errors:0`. **8 asociados de 10**; los
sueltos son los automáticos de sep y oct, que se asociarán solos cuando pasen a ser "el próximo".

**Regresión OK:** Phase 3 emitió las **3 facturas** de los automáticos vencidos
(`574939212119`, `574927393603`, `574928513945`).

**Idempotencia OK:** segunda pasada → `dealLinked:0 · alreadyLinked:8 · autoInvoicesEmitted:0`;
siguen siendo 10 tickets y 8 asociaciones. No duplica.

🧹 **Datos de prueba a limpiar** cuando ya no hagan falta: deal `63252656430` + sus 2 LIs + 10 tickets
+ 3 invoices (llevan el prefijo `[TEST-P2]`).

---

## 3. Regresión `facturar_ahora` (post tarea A — eliminado en LI, vivo en ticket)

**Precondiciones**
- [ ] Un LINE ITEM de un deal ganado cualquiera (anotar `LI_ID`, `DEAL_ID`).
- [ ] Un TICKET del pipeline **manual** elegible para urgente (deal ganado con `facturacion_activa=true`, ticket en etapa forecast o editable, NO del pipeline automático). Anotar `TICKET_ID`.
- [ ] Nota: si la suscripción `line_item.propertyChange / facturar_ahora` ya se quitó (checklist 6), el paso (a) no genera evento — igual vale probarlo mientras la suscripción exista.

### (a) LI → NO pasa nada

1. [ ] Marcar `facturar_ahora=true` en el LINE ITEM.
2. [ ] Mirar el log del webhook: debe responder **200** con `facturar_ahora solo soportado en tickets, skipped`.
3. [ ] Verificar que NO se creó job:

```sql
SELECT * FROM webhook_queue
 WHERE object_type = 'line_item'
   AND action_type = 'urgent_line_item'
   AND created_at > NOW() - INTERVAL '15 minutes';
-- esperado: 0 filas
```

4. [ ] Verificar en HubSpot: sin ticket nuevo, sin factura nueva, sin `of_billing_error` nuevo en el LI. (El flag `facturar_ahora` del LI queda en true — ya nadie lo resetea; se limpia a mano.)

### (b) Ticket manual → flujo urgente completo

1. [ ] Marcar `facturar_ahora=true` en el TICKET manual elegible.
2. [ ] Verificar el job:

```sql
SELECT id, action_type, object_id, status, error, created_at, finished_at
  FROM webhook_queue
 WHERE action_type = 'urgent_ticket'
   AND object_id = '<TICKET_ID>'
 ORDER BY id DESC LIMIT 5;
-- esperado: 1 fila con status='done'
```

3. [ ] Verificar en HubSpot: factura creada y asociada, ticket movido a la etapa post-emisión, `facturar_ahora` reseteado a `false`, sin `of_billing_error`.

**Resultado esperado**
- (a) 200 skipped, cola sin `urgent_line_item`, cero efectos en HubSpot.
- (b) job `urgent_ticket` en `done`; invoice creada; stage movido; flag reseteado.

**Evidencia a registrar**
- [x] `LI_ID`, `TICKET_ID`, `INVOICE_ID`, ids de job de la cola.
- [x] Captura de la respuesta/log 200 skipped del LI y del ticket facturado.

### ✅ CORRIDA 2026-07-29 — PASA (las dos capas)

Sobre el deal sembrado en la prueba 2 (`63252656430`).

**(a) LINE ITEM — nada pasa, verificado por DUPLICADO:**
1. *Capa portal:* `facturar_ahora=true` en el LI `57565277478` → **cero jobs en la cola** en 10
   minutos (ni `urgent_line_item` ni ningún otro). La suscripción está efectivamente retirada.
2. *Capa código:* como la suscripción retirada impide probar el código, se mandó el evento
   **firmado v3 a mano** contra el servicio real de testing (`webhooks-testing.up.railway.app`):
   → **`HTTP 200 {"message":"facturar_ahora solo soportado en tickets, skipped","objectType":"line_item"}`**
   y **ningún job encolado**. O sea: aunque alguien reponga la suscripción por error, el motor no
   factura desde el LI.
   > Cómo se reproduce: el endpoint **sí valida firma** (`verifyHubSpotSignature` está en
   > `server.js:57`, no en el handler → un POST pelado da **401**). Hay que firmar con
   > `HUBSPOT_CLIENT_SECRET`: `HMAC-SHA256('POST'+url+rawBody+timestamp)` en base64, headers
   > `X-HubSpot-Signature-v3` + `X-HubSpot-Request-Timestamp` (ventana de 5 min).
3. Confirmado el comportamiento ya previsto: **el flag del LI queda en `true`** (ya nadie lo
   resetea) → se limpió a mano.

**(b) TICKET manual — flujo urgente completo, intacto:** `facturar_ahora=true` en el ticket
`47295677217` (manual, "Próximos a facturar", sin factura) → job **`#7729 urgent_ticket` → `done`**
→ factura **`574967680541`** creada (Pendiente, USD 1.000, fecha de hoy) **y asociada al ticket**,
ticket movido a **"Listo para facturar"**, `facturar_ahora` **reseteado a `false`**, `of_billing_error`
vacío.

---

## 4. Ticket → `valor_recalc` (tarea B)

**Precondiciones**
- [ ] Suscripciones `ticket.propertyChange` activas en la app privada de sandbox para: `monto_unitario_real`, `cantidad_real`, `of_costo_usd`, `dolar`.
- [ ] Un ticket del pipeline **manual** en **"Próximos a Facturar"** (etapa editable no-forecast) con `of_deal_id` poblado. Anotar `TICKET_ID`, `DEAL_ID`.
- [ ] Un ticket del mismo deal (u otro) en etapa **forecast manual**. Anotar `TICKET_FC_ID`.
- [ ] Anotar valores actuales del deal: `valor_total`, `valor_total_moneda_original`, `margen_total_usd`.

**Pasos**
1. [ ] Editar `monto_unitario_real` en el ticket de "Próximos a Facturar" (ej. +100).
2. [ ] Verificar el job:

```sql
SELECT id, action_type, object_type, object_id, deal_id, property_name,
       status, error, created_at, finished_at
  FROM webhook_queue
 WHERE action_type = 'valor_recalc'
   AND object_id = '<TICKET_ID>'
 ORDER BY id DESC LIMIT 5;
-- esperado: 1 fila, deal_id = <DEAL_ID>, status = 'done'
```

3. [ ] Verificar en el deal: `valor_total` / `valor_total_moneda_original` / `margen_total_usd` actualizados coherentes con la edición.
4. [ ] Editar la MISMA prop en el ticket FORECAST (`TICKET_FC_ID`) → log del webhook: **200 skipped**, y:

```sql
SELECT count(*) FROM webhook_queue
 WHERE action_type = 'valor_recalc' AND object_id = '<TICKET_FC_ID>';
-- esperado: 0
```

5. [ ] Dedup: hacer DOS ediciones seguidas (ej. `monto_unitario_real` y enseguida `cantidad_real`) en el ticket de "Próximos a Facturar" y mirar:

```sql
SELECT id, property_name, status, created_at, finished_at
  FROM webhook_queue
 WHERE action_type = 'valor_recalc' AND deal_id = '<DEAL_ID>'
 ORDER BY id DESC LIMIT 5;
```

**Resultado esperado**
- Paso 2-3: job `valor_recalc` con `deal_id` correcto en `done`; VALOR/MARGEN del deal recalculados (recalcula SOLO el valor: NO crea tickets ni corre phases).
- Paso 4: ticket forecast → 200 skipped, sin job (el forecast lo cubre el re-snapshot del cron; también deben quedar fuera automático y emitido).
- Paso 5 (dedup por `(deal_id, action_type)`): si el worker toma un job teniendo otro `pending` más viejo del mismo deal, el viejo queda **`superseded`**. ⚠️ Como el worker atiende FIFO cada ~2s, con dos ediciones rápidas lo NORMAL es ver **ambos jobs en `done`** (el segundo recalc es idempotente y no cambia nada); `superseded` aparece recién cuando un job fue reencolado (deal_locked/reaper) o la cola venía cargada. **Ambos desenlaces son correctos**; lo que NO debe pasar es un `failed` ni un valor final incoherente en el deal.

**Evidencia a registrar**
- [x] `TICKET_ID`, `TICKET_FC_ID`, `DEAL_ID`, ids de jobs.
- [x] Deal antes/después (captura de las 3 props de VALOR/MARGEN).
- [x] Salida de las 3 queries de arriba.

### ✅ CORRIDA 2026-07-29 — PASA

Sobre el deal sembrado en la prueba 2 (`63252656430`). `TICKET_ID` = `47298308702`
("Próximos a facturar") · `TICKET_FC_ID` = `47275177280` (85% Forecast).

| Punto | Esperado | Real |
|---|---|---|
| Editar `monto_unitario_real` en "Próximos" encola | job con `deal_id` resuelto, `done` | **`#7730 valor_recalc` ticket → deal `63252656430` → `done`** ✅ |
| VALOR del deal recalculado | 7000 → 7100 | **7100** (los 4 campos: `valor_total`, `..._moneda_original`, `margen_total_usd`, `amount`) ✅ |
| Misma prop en ticket **forecast** | 0 jobs | **0 jobs** — guard anti-tormenta OK ✅ |
| Dedup (2 ediciones seguidas) | ambas `done` o una `superseded`, ninguna `failed` | **`#7731` + `#7732` ambas `done`** ✅ |

VALOR final coherente a mano: **8500** = manuales 5500 + automáticos 3000.

---

## 5. Aviso al responsable del ticket (tarea C)

**Precondiciones**
- [ ] `.env` sandbox: `LI_PROP_SYNC_ENABLED=true` (sin esto el sync LI→ticket ni corre) y `LI_SYNC_OWNER_ALERT_ENABLED` **ausente o `true`** (ausente = ON).
- [ ] Un LI cuyo ticket del pipeline manual esté en **"Próximos a Facturar"** y tenga **owner** (propietario asignado). Anotar `LI_ID`, `TICKET_ID`.
- [ ] Otro LI cuyo ticket en "Próximos a Facturar" NO tenga owner. Anotar `LI_ID_2`, `TICKET_ID_2`.
- [ ] Para el escenario (d): un LI de un deal ORIGINAL (PY) que tenga espejo UY, con ticket en "Próximos a Facturar". Anotar `LI_PY_ID`, `DEAL_UY_ID`.
- [ ] Suscripción `line_item.propertyChange / price` activa (ya está en la lista de 45 de la app).
- [ ] **El aviso al responsable va SIN correo** (definición usuaria 26-jul): solo la prop `of_billing_error` del ticket + la tarea que crea el workflow de HubSpot sobre esa prop (si está configurado). No esperar email al owner.

### (a) Ticket CON owner

1. [ ] Editar `price` del primer LI.
2. [ ] Verificar el job `li_prop_sync`:

```sql
SELECT id, action_type, object_id, property_name, status, error, finished_at
  FROM webhook_queue
 WHERE action_type = 'li_prop_sync' AND object_id = '<LI_ID>'
 ORDER BY id DESC LIMIT 5;
-- esperado: status='done'
```

3. [ ] Verificar en el ticket: `monto_unitario_real` (y derivadas `of_costo`/`of_margen`) actualizados con el nuevo price.
4. [ ] Verificar `of_billing_error` del ticket: contiene el mensaje de aviso (qué prop cambió el vendedor).
5. [ ] Si el workflow de HubSpot sobre `of_billing_error` está configurado: verificar la tarea creada al responsable del ticket.

### (b) Ticket SIN owner

1. [ ] Editar `price` del segundo LI.
2. [ ] Verificar: patch aplicado + `of_billing_error` escrito, **sin error** (el job termina `done`, no `failed`). Si el workflow crea tarea, queda sin asignar o no se crea — anotar el comportamiento observado.

### (c) Flag OFF

1. [ ] Setear `LI_SYNC_OWNER_ALERT_ENABLED=false` y reiniciar el servicio.
2. [ ] Editar `price` de nuevo en el primer LI.
3. [ ] Verificar: el sync SÍ aplica el cambio al ticket, pero NO escribe aviso nuevo en `of_billing_error` (→ tampoco se dispara el workflow).
4. [ ] Restaurar el flag (borrarlo del `.env` = ON) y reiniciar.

### (d) Aviso a MIRROR (deal espejo UY) — este SÍ va por correo

1. [ ] Editar `price` del LI del deal ORIGINAL PY (`LI_PY_ID`) con ticket en "Próximos a Facturar".
2. [ ] Verificar que el sync actualizó el/los ticket(s) del original (job `li_prop_sync` en `done`).
3. [ ] Verificar en el deal espejo UY (`DEAL_UY_ID`): `billing_error` con el aviso "Cambio en el negocio ORIGINAL … revisar el espejo UY" (indica prop cambiada, LI PY→UY y cantidad de tickets actualizados).
4. [ ] Verificar la bandeja del **destinatario de mirrors** (`MIRROR_ALERT_TO_EMAIL` = María Bitencurt; si la env no está seteada, cae al operativo default `ALERT_TO_EMAIL`): llegó el correo del aviso al mirror.

**Resultado esperado**
- El sync es quirúrgico: SOLO las props influidas por `price` cambian; nota/observaciones/lo demás del responsable queda intacto. Solo toca tickets del pipeline manual en "Próximos a Facturar" (forecast/automático/emitido se saltean).
- **El aviso al responsable NO manda correo** (definición 26-jul): (a) patch + `of_billing_error` + tarea del workflow al owner. (b) patch + prop escrita, sin `failed`. (c) patch sin aviso.
- (d) El aviso a MIRROR sí llega por correo al destinatario de mirrors (`MIRROR_ALERT_TO_EMAIL`, con fallback al operativo default), además del `billing_error` en el deal UY. El anti-loop se respeta: editar un LI de un deal que YA es espejo NO genera aviso.
- Ojo colateral esperado: como `price` también recalcula el VALOR del deal (post `li_prop_sync`), `valor_total` puede moverse — es correcto.

**Evidencia a registrar**
- [x] `LI_ID`/`TICKET_ID` de los escenarios (a)-(c) + `LI_PY_ID`/`DEAL_UY_ID` del (d) + ids de jobs.
- [x] Captura del ticket (props sincronizadas + `of_billing_error`) y de la tarea del workflow (a).
- [x] Captura del `billing_error` del deal UY (d). ⚠️ **El correo NO se pudo verificar** — decisión
  29-jul de no poner `RESEND_API_KEY` en testing (ver arriba).

### ✅ CORRIDA 2026-07-29 — PASA (con dos matices anotados)

**(a) Ticket CON owner** — LI `57565277478` price 1000→1400 → job **`#7733 li_prop_sync` → `done`**;
ticket `47298308702`: `monto_unitario_real` 1150 → **1400**, `subtotal_real` 2800; `of_billing_error`
escrito con el texto completo: *"El vendedor modificó el elemento de pedido «…» (57565277478):
propiedad **price**. Cambios aplicados a este ticket: monto_unitario_real="1400", of_margen="1400".
Verificá los datos antes de facturar."* Colateral esperado confirmado: encadenó `#7734 valor_recalc`.

**(b) Ticket SIN owner — NO SE PUEDE EJERCITAR COMO ESTÁ ESCRITO, y no hace falta.** HubSpot
**no deja limpiar `hubspot_owner_id`** por API: el PATCH con `''` y con `null` devuelve **200 pero
el valor persiste** (verificado dos veces). Y el aviso **no lee el owner**: el propio módulo lo
documenta — `ticketOwnerId` *"hoy NO condiciona nada (el workflow de HubSpot resuelve el owner)"*
(`liSyncTicketAlert.js:51-52`). Lo que el escenario quería probar (job `done`, prop escrita, sin
`failed`) quedó demostrado igual en (a) y en la corrida de (b). **Sugerencia: reescribir el escenario
(b) del checklist o eliminarlo.**

**(c) Flag OFF** — `LI_SYNC_OWNER_ALERT_ENABLED=false` en Railway testing → price 1500→1600 → job
`#7737` `done`, ticket **sí** actualizado a 1600, `of_billing_error` **vacío**. El sync se aplica y
el aviso se omite, exactamente como se diseñó. Flag restaurada a `true`.

**(d) Aviso a MIRROR** — original PY `62638758686` (MiRecibo-TIGO) · LI `57007904909` (`uy=true`) ·
ticket `46740543151` en "Próximos" · espejo UY `62638808845`. Price 658.5→700→720 → sync aplicado al
ticket PY **y** `billing_error` escrito en el **deal UY** con el detalle completo (*"Cambio en el
negocio ORIGINAL … revisar el espejo UY. Deal PY … → Deal UY … LI UY 57008579616. Propiedad del LI
cambiada: price"*). Precio del LI migrado **restaurado a 658.5** al cerrar.

⚠️ **Trampa de método (costó una repetición):** el primer intento de (d) corrió **mientras Railway
todavía estaba deployando** la restauración de la flag → el proceso vivo aún tenía
`LI_SYNC_OWNER_ALERT_ENABLED=false` y el aviso al responsable no se escribió; parecía un bug y no lo
era. **Después de tocar una env hay que esperar `SUCCESS` en `railway deployment list`, no que la
variable figure seteada.** Dato bueno que salió de ese error: **los dos avisos son independientes** —
el del espejo salió igual con la flag del responsable apagada.

---

## 6. Checklist manual en HubSpot (tarea A — la corre la usuaria en el portal)

> Idealmente ANTES del deploy de la rama; como mínimo, mismo día.

- [x] **Quitar la suscripción** `line_item.propertyChange / facturar_ahora` en la app privada — **HECHO 26-jul (usuaria)**. **Conservar** la de `ticket.propertyChange / facturar_ahora` (verificar que sigue activa al repasar esta lista).
- [x] **Ocultar** la propiedad `facturar_ahora` de vistas, tarjetas y editores de LINE ITEM — **HECHO 26-jul (usuaria)**. **NO borrar la propiedad** (hay historia y el código de tickets la comparte por nombre).
- [x] **Revisar workflows** de HubSpot: ninguno debe escribir `facturar_ahora` en line items — ✅ **29-jul, verificado por API en los DOS portales** (`GET /automation/v4/flows` + la definición completa de cada flow, buscando la cadena `facturar_ahora`):

| | Sandbox 51101688 | **Prod 50148277** |
|---|---|---|
| workflows totales | 30 (negocio 12 · ticket 17 · empresa 1) | 32 (negocio 12 · ticket 17 · empresa 2 · `0-115` 1) |
| **de tipo LINE ITEM** | **0** | **0** |
| mencionan `facturar_ahora` | **ninguno** | **ninguno** |

  Doble refuerzo: no hay ningún workflow de line item (y un workflow sólo escribe propiedades del
  objeto que inscribe), y además la propiedad no aparece en la definición de ninguno. La búsqueda
  cubre también el custom code de Operations Hub, que viaja dentro de la definición del flow.
  ⚠️ Lo que **no** cubre: escrituras desde integraciones externas o desde otra app privada.
- [x] 🆕 **30-jul — RESUELTO: de los 3 workflows de PROD que escribían `cancelar_ticket=true`, los 2 eco quedaron APAGADOS** (verificado por API: `1780939532` ⚪ · `1782918733` ⚪ · `1767305350` 🔴 activo, que es el legítimo). ⚠️ En **sandbox siguen prendidos** los dos equivalentes (`1782915938`, `1782918796`): los entornos quedaron distintos, y ahí el `of_billing_error` de un ticket automático cancelado se va a seguir pisando.
  - `1767305350` **Propagacion de cierre** (16 acciones, 2 ponen la casilla) — **uso legítimo**: cancela los tickets cuando se cae el negocio. **Dejar como está.**
  - `1780939532` *«Órdenes de Facturación», estado del ticket «Cancelado»* → **una sola acción**: `cancelar_ticket=true`.
  - `1782918733` *«Órdenes de facturación Automáticas», estado «Cancelada»* → **una sola acción**: idem.

  Los dos últimos son un **eco**: el ticket YA está en la etapa Cancelado y sólo marcan la casilla, que
  el motor **resetea a `false` enseguida** → no dejan nada durable, sólo un job por cancelación. Y en el
  pipeline **automático** el handler responde *"Los tickets automáticos no se cancelan desde esta
  casilla"* y **eso pisa el `of_billing_error`** de la cancelación definitiva (visto en vivo el 30-jul,
  ticket `47295259060`: el aviso bueno quedó tapado). **Sugerencia: apagar esos dos.** Los mismos existen
  en sandbox (`1782915938`, `1782918796`). ⚠️ Decisión de la usuaria — **no se tocó nada en PROD**.
- [x] **Confirmar que la suscripción de TICKET quedó intacta** — ✅ **29-jul, probado por comportamiento**: en la prueba 3(b) marcar `facturar_ahora` en el ticket `47295677217` disparó el job `#7729 urgent_ticket` de verdad. Si la suscripción no estuviera activa, el evento nunca habría llegado.
- [x] **Drenar la cola antes del deploy** — ✅ **29-jul: 0 filas** (`action_type='urgent_line_item' AND status IN ('pending','processing')`).

```sql
SELECT count(*) FROM webhook_queue
 WHERE action_type = 'urgent_line_item'
   AND status IN ('pending', 'processing');
-- DEBE dar 0 antes del deploy
```

- [ ] Evidencia pendiente: captura de workflows revisados, captura de la suscripción de ticket activa, resultado de la query en 0.
- [ ] Pendiente aparte (no bloquea): actualizar tutoriales/videos que muestren "facturar ahora" en el LI.

---

## Cierre

- [ ] Las 6 checklists en verde → anotar fecha/hora y resultados en este archivo.
- [ ] Evidencia de Fase 0 volcada en `docs/PLAN_FEATURES_TICKETS_2026-07.md`.
- [ ] Si algo falló: id del job + `error` de la fila de `webhook_queue` + log del servicio, y frenar el deploy hasta revisar.

---

## 7. Cancelar vs Revertir (flags: `CANCEL_REVERT_FLOW_ENABLED` + `CUPO_REVERT_ON_CANCEL_ENABLED`)

> Rama: `feat/cancelar-revertir-nucleo` (Bloques 1-4). Núcleo: casillas `cancelar_ticket` /
> `revertir_factura`, bifurcación cancel/revert en `propagacion/invoice.js`, reversión real
> de cupo (`revertCupoForInvoice`), contador `of_refacturaciones` y avisos (admin + espejo UY).

**Recordatorio de envs a setear en el `.env` sandbox ANTES de arrancar (anotar valores):**

- [x] `CANCEL_REVERT_FLOW_ENABLED=true` (llave maestra; default OFF — solo `true`/`1`/`yes` prende)
- [x] `CUPO_REVERT_ON_CANCEL_ENABLED=true` (reversión real de cupo; misma semántica)
- [x] `ADMIN_ALERT_TO_EMAIL` (destino del email de reversión a administración; vacía → cae a `ALERT_TO_EMAIL`)
- [x] `MIRROR_ALERT_TO_EMAIL` (destino de avisos a espejo UY; vacía → cae a `ALERT_TO_EMAIL`)
- [x] `NC_TUTORIAL_URL` (link del tutorial de nota de crédito que cita el aviso de tickets automáticos)
- [x] `REBILL_ALERT_THRESHOLD` (umbral del título "⚠️ Período refacturado N veces"; default `2`; `0` o vacía = sin refuerzo)
- [x] `DEAL_ALERTS_ENABLED` ausente o `true` (si está en `false` NO esperar ninguno de los emails de esta checklist)
- [ ] **Props ya creadas por la usuaria (26-jul)**: casillas `cancelar_ticket` y `revertir_factura` + contador `of_refacturaciones` en el ticket; suscripción `ticket.propertyChange / revertir_factura` activa (26-jul). El motivo de reversión usa la prop EXISTENTE `motivo_del_ajuste` (no hay prop nueva de motivo).

Query genérica de la cola para todos los escenarios:

```sql
SELECT id, action_type, object_id, deal_id, status, error, created_at, finished_at
  FROM webhook_queue
 WHERE action_type IN ('ticket_cancel_request', 'ticket_revert_request')
 ORDER BY id DESC LIMIT 10;
```

**Precondiciones generales**
- [ ] Deal ganado con cupo configurado (`tipo_de_cupo`, `cupo_total`/`cupo_total_monto`) y un ticket manual EMITIDO con factura viva que consumió cupo (marker `cupo_consumo_invoice_id` = invoice). Anotar `DEAL_ID`, `TICKET_ID`, `INVOICE_ID` y valores de `cupo_consumido` / `cupo_restante` / `cupo_estado` / `of_cupo_historial`.
- [ ] Un segundo juego equivalente para el escenario (c) cancelar definitivo.
- [ ] Para (d): un ticket NC (cantidad/monto negativos) emitido con factura, que re-ACREDITÓ cupo al emitirse.
- [ ] Para (g): deal ORIGINAL PY con espejo UY y ticket emitido. Anotar `LI_PY_ID`, `DEAL_UY_ID`.

### (a) Revertir manual con cupo — camino feliz

1. [ ] Completar `motivo_del_ajuste` en el ticket (texto distinguible) y marcar `revertir_factura=true`.
2. [ ] Verificar job `ticket_revert_request` en `done` (query genérica).
3. [ ] Verificar factura: `etapa_de_la_factura='Cancelada'` + `fecha_de_cancelacion` de hoy.
4. [ ] Verificar deal: cupo re-acreditado (`cupo_consumido` -X, `cupo_restante` +X) y `cupo_estado` recalculado.
5. [ ] Verificar ticket: marker de consumo limpio, `of_cupo_historial` con 2 líneas (consumo + reversion), `of_refacturaciones=1`, props de factura limpias, ticket en **Próximos a Facturar**, `revertir_factura` reseteada.
6. [ ] Verificar bandeja de `ADMIN_ALERT_TO_EMAIL`: email "Factura revertida para refacturar" con negocio/ticket/invoice/motivo/refacturación N° 1/resultado del cupo.

### (b) Refacturar tras revertir

1. [ ] Emitir de nuevo el ticket (facturar ahora / flujo manual normal) → factura F2.
2. [ ] Verificar: `consumeCupo` consume la F2 con marker NUEVO (`cupo_consumo_invoice_id` = F2) y `of_cupo_historial` acumula la nueva línea de consumo (3 líneas en total).

### (c) Cancelar definitivo — el período se cierra

1. [ ] En el segundo ticket, marcar `cancelar_ticket=true` (con factura viva y flujo prendido).
2. [ ] Verificar job `ticket_cancel_request` en `done`; factura Cancelada; cupo re-acreditado (con `CUPO_REVERT_ON_CANCEL_ENABLED=true`).
3. [ ] Verificar ticket: etapa **CANCELADO**, `of_invoice_id` **CONSERVADO** (no se limpia — es lo que evita que missedBillingGuard re-emita), `motivo_cancelacion_del_ticket` escrito.
4. [ ] Correr `node ./src/runBilling.js --deal <DEAL_ID>` → el cron **NO refactura** ese período en la corrida siguiente (ni missedBillingGuard ni el sweep de canceladas lo reviven).

### (d) NC: revertir la factura de una nota de crédito

1. [ ] Revertir (`revertir_factura=true`) la factura del ticket NC.
2. [ ] Verificar: el cupo se re-DEBITA (la NC había acreditado; la reversión deshace ese crédito — signo inverso al escenario (a)) y el historial lo registra.

### (e) Gate Nodum

1. [ ] En el editor de facturas, intentar cancelar/revertir una factura con `id_factura_nodum` asentado → **409** con el mensaje de bloqueo Nodum.
2. [ ] Marcar `revertir_factura=true` en un ticket cuya factura está asentada en Nodum → aviso en `of_billing_error` (nota de crédito / tutorial) + casilla reseteada, factura INTACTA.

### (f) Cupo agotado vs desactivado manual

1. [ ] Con un deal en `cupo_estado='Agotado'` (`cupo_activo=false` apagado POR EL MOTOR): revertir una factura con cupo → `cupo_activo` vuelve a `true` (reactivación condicionada).
2. [ ] Con un deal en `cupo_estado='Desactivado'` (apagado HUMANO): revertir → `cupo_activo` **NO** se reactiva (solo números y estado recalculado).

### (g) Espejo PY→UY

1. [ ] Revertir (y en otra corrida cancelar) la factura de un ticket del deal ORIGINAL PY con espejo UY.
2. [ ] Verificar en el deal UY: `billing_error` con el aviso según el caso (revertida: "el período se va a refacturar" / cancelada: "DEFINITIVAMENTE… la promoción del ticket UY NO se deshace") + email a `MIRROR_ALERT_TO_EMAIL`.
3. [ ] Verificar que el ticket UY quedó **INTACTO** (no se deshace la promoción; la verificación es manual).

### (h) Doble disparo editor + casilla

1. [ ] Cancelar la factura por el editor (o casilla) y ENSEGUIDA disparar la otra vía sobre el mismo período.
2. [ ] Verificar: la segunda vía NO genera doble crédito de cupo (idempotencia por marker: `no_consumio_o_ya_revertido`) ni doble incremento del contador.

### (i) Ambas flags OFF — neutralidad total

1. [ ] Setear `CANCEL_REVERT_FLOW_ENABLED=false` y `CUPO_REVERT_ON_CANCEL_ENABLED=false`, reiniciar.
2. [ ] Cancelar una factura por el editor y correr la pasada del deal: TODO como hoy — ticket vuelve a stage facturable con el aviso textual de cupo actual, SIN reversión real de cupo, SIN contador, SIN emails nuevos (admin/espejo), sin gate.

### (j) Revertir con flag OFF

1. [ ] Con `CANCEL_REVERT_FLOW_ENABLED=false`, marcar `revertir_factura=true` en un ticket con factura viva.
2. [ ] Verificar: `of_billing_error` = aviso "La reversión de facturas todavía no está habilitada…", casilla reseteada a `false`, factura y cupo INTACTOS.

**Resultado esperado global**
- (a)-(h) con flags ON: cupo consistente (historial como libro mayor), contador solo en reversión explícita, avisos SOLO por acción deliberada (el sweep del cron que re-propaga canceladas NO manda emails ni toca contador).
- (i)-(j) con flags OFF: cero diferencia contra el comportamiento actual, salvo el aviso "no habilitada" de la casilla.

**Evidencia a registrar**
- [x] IDs (`DEAL_ID`/`TICKET_ID`/`INVOICE_ID`/jobs) por escenario + capturas de deal (cupo), ticket (historial/contador/etapa) y factura.
- [x] Capturas de los emails (admin y mirror) y de los `billing_error`/`of_billing_error`.
- [x] Salidas de las queries a `webhook_queue`.

### ✅ CORRIDA 2026-07-29/30 — 10 de 10 PASAN (la (c) falló, se corrigió y se re-validó el 30-jul)

**Entorno.** Flags `true` en el servicio `webhooks` de testing (verificado por `railway variables`
DESPUÉS del `SUCCESS` del deploy). **Drift corregido:** en `CRON hs-billing-updater` de testing
`NC_TUTORIAL_URL` estaba en `true` (el mismo error de dedo que se había arreglado sólo en webhooks el
29-jul) → seteada a la URL real. No la lee ningún path del cron (el gate vive en webhooks + editor),
pero se corrige para no repetir el patrón B8. `REBILL_ALERT_THRESHOLD` y `DEAL_ALERTS_ENABLED`
ausentes = defaults (2 / ON). `RESEND_API_KEY` sigue **fuera** de testing por la decisión del 29-jul.

**Siembra (el sandbox no tenía NADA de cupo:** 0 tickets con `cupo_consumo_invoice_id`, 1 solo deal
con `tipo_de_cupo` y en 0/Agotado**).** Sobre el deal de pruebas `63252656430` `[TEST-P2]`:
`tipo_de_cupo='Por Monto'`, `cupo_total_monto=20000`, `cupo_activo=true`, `cupo_umbral=2000` +
`parte_del_cupo=true` en el LI manual `57565277478`. Los consumos se generaron **de verdad**
(`facturar_ahora` en el ticket → `consumeCupoAfterInvoice`), no a mano.

| Esc. | Resultado | Evidencia |
|---|---|---|
| (a) | ✅ PASA | ticket `47298308702` · factura `574991796999` → **Cancelada** + `fecha_de_cancelacion` hoy · job `#7748 done` · cupo 4400→**1200** / restante 15600→**18800** (+3200 exacto) · historial 2 líneas (consumo+reversion) · `of_refacturaciones=1` · stage → `1311451807` · casilla reseteada · log `adminRevertAlert` *"Email de reversión a administración enviado… destinoDedicado=promichfsd@gmail.com"* + `alertService` *"RESEND_API_KEY no configurado — email omitido"* (el mail se arma y direcciona bien; no se envía por decisión) |
| (b) | ✅ PASA | F2 `574976225542` con marker NUEVO · historial 3 líneas · cupo vuelve a 4400/15600 (sin doble consumo) · contador **sigue en 1** |
| (c) | 🔴 **FALLA** | La cancelación en sí es correcta (job `#7750 done` · factura Cancelada · cupo +1200 · ticket a **CANCELADO `1311451813` conservando `of_invoice_id`** · `motivo_cancelacion_del_ticket` escrito · contador NO se toca). **La primera pasada la deshace** — ver el bloque de abajo |
| (d) | ✅ PASA | NC del ticket `47275177280` (`nc=true`, `cantidad_real=-1` → `subtotal_real=-1200` recalculada por HubSpot): emisión acredita (consumido 3200→**2000**), y la reversión **RE-DEBITA** (2000→**3200**) con línea `reversion \| -1200` en el historial |
| (e) | ✅ PASA | **Editor: HTTP 409** *"Esta factura ya está asentada en Nodum (id 9001)… emití una nota de crédito. Tutorial: https://webhooks-testing.up.railway.app/guia"* · **Casilla:** mismo texto en `of_billing_error`, casilla reseteada, **factura INTACTA** (Pendiente, sin fecha de cancelación) y ticket conserva `of_invoice_id` |
| (f) | ✅ PASA | **Agotado (apagado por el motor):** revertir → consumido 4400→3200, restante 0→1200, **`cupo_activo` vuelve a `true`**, estado recalculado a `Bajo Umbral` (umbral 2000). **Desactivado (humano):** revertir → números se corrigen igual (4400→3200 / 1200) y **`cupo_activo` SIGUE en `false`**, estado `Desactivado` |
| (g) | ✅ PASA | Par PY→UY sembrado (deal UY `63261409185`, LI UY `57563014574`, `deal_uy_mirror_id` en el PY). **Revertir** → `billing_error` en el UY: *"…revertida: el período se va a refacturar. Verificar el ticket UY manualmente. Deal PY: 63252656430 \| LI PY: 57565277478 → LI UY: 57563014574 \| Ticket PY: 47275177280"*. **Cancelar** → *"…cancelada DEFINITIVAMENTE (período cerrado, no se refactura). La promoción del ticket UY NO se deshace…"*. **Ticket UY `47280694534` INTACTO** (historial de `hs_pipeline_stage`: un solo valor, el de su creación) |
| (h) | ✅ PASA | **Editor→casilla:** editor 200 (`modo:"revertir"`) → contador 5→6, cupo re-acreditado **una** vez (4400→3200); casilla enseguida → *"No hay factura emitida para revertir en este ticket."*, contador **sigue 6**, cupo sin segundo crédito. **Casilla→editor:** editor **400** *"La factura ya está cancelada."* (Cancelada terminal), un solo crédito |
| (i) | ✅ PASA | Flags a `false` (deploy `f1de51b1` esperado hasta `SUCCESS`): editor 200 **sin `modo`** en la respuesta y **sin gate** · ticket a stage facturable · **cupo NO revertido** (consumido sigue 4400, marker sin limpiar, historial sin línea de reversión) · **contador sin cambios** · pasada del deal: `propagated: 11` con el comportamiento de hoy, sin avisos |
| (j) | ✅ PASA | `of_billing_error` = *"La reversión de facturas todavía no está habilitada en el sistema. Hablá con administración."* · casilla reseteada · factura Pendiente y cupo **intactos** · contador sin cambios |

Flags **restauradas a `true`** al cerrar, con `SUCCESS` de deploy confirmado.

#### 🔴 BLOQUEANTE — la cancelación DEFINITIVA no sobrevive a la pasada siguiente

`propagateCancelledInvoicesForDeal` (`invoice.js:846`, corre en cada pasada del deal) re-propaga
**toda** factura `Cancelada` con `cancelIntent=null` → `resolveCancellationBranch(null)` = `'revert'`
→ `prepareTicketForRebillingAfterCancellation` **saca el ticket de CANCELADO, lo manda a stage
facturable y le borra `of_invoice_id`** — justo lo que el docstring de
`finalizeTicketAfterDefinitiveCancellation` marca como ⚠️ CRÍTICO conservar.

Medido, con las dos flags prendidas:

- **Manual** (ticket `47275177280`, factura `574991465568`): cancelado definitivo 22:41 → CANCELADO;
  a las 22:42 la pasada lo devolvió a `1311451807` con `of_invoice_id` vacío. El período anulado queda
  abierto y refacturable, y `missedBillingGuard` ya no lo ve resuelto.
- **Automático** (ticket `47295259060`, factura `574939212119`, cancelado definitivo desde el editor
  con `modo:'cancelar'` → stage `1311404155`): la pasada siguiente lo devolvió a READY `1311404151` y
  **`sweepAutoBacklog` EMITIÓ UNA FACTURA NUEVA del período anulado** — `575082098724` (*"Backlog:
  factura emitida"*). Dos facturas para la misma `of_invoice_key`: la anulada y una nueva viva.
  **Es exactamente el hallazgo #4 que esta feature venía a cerrar.**
- **Efecto colateral sobre la refacturación (b):** el sweep re-propaga la factura VIEJA cancelada
  sobre el ticket que ya tiene la NUEVA viva (las dos comparten `of_invoice_key`) y le borra la
  referencia a la nueva → la F2 queda huérfana y el ticket vuelve a "Próximos a Facturar" como si no
  se hubiera facturado.
- Lo que **sí** aguantó: **cupo sin doble crédito** en todos los casos (idempotencia por
  `cupo_consumo_invoice_id`: la 2ª pasada ve el marker limpio y hace skip) y **contador sin inflarse**
  (`computeContadorRefacturaciones` con intent null devuelve null). Tampoco se mandan avisos.

#### ✅ FIX 30-jul + re-validación — `resolveCancelledPropagationGuard`

Criterio aplicado, el de cualquier sistema de facturación (comprobantes inmutables, `void` terminal,
y el estado del período se decide desde el documento **vigente**, no desde uno superado). `of_invoice_id`
queda definido como **"la factura que gobierna el período"** — la viva, o la última si el período se
cerró; el historial completo lo llevan las asociaciones ticket↔factura de HubSpot. **El estado se
decide desde datos (etapa + ids), nunca desde texto**; el texto (`motivo_cancelacion_del_ticket`,
`of_billing_error`, `of_cupo_historial`) queda para humanos. Sin props nuevas.

Tres guardas en `propagateInvoiceStateToTicket`, **antes de cualquier escritura** (el paso 4/5 ya
movía el stage a CANCELADO y la rama 5b lo revertía — ese ida y vuelta era parte del churn), y sólo
para `etapa='Cancelada'` **sin intent explícito**: una acción deliberada (editor o casilla) nunca se
saltea.

| Guarda | Condición | Qué cierra |
|---|---|---|
| `periodo_cerrado` | el ticket ya está en la etapa CANCELADO de su pipeline | la cancelación definitiva ya no se re-abre |
| `factura_superada` | el ticket apunta a OTRA factura **y esa factura está viva** (se verifica; si no se puede, **no** se saltea → fail-open al comportamiento actual) | la refacturación ya no se deshace |
| `ya_limpio` | el ticket ya está sin factura, sin status y en la etapa facturable | no se reescribe el mismo aviso (ni su timestamp) en cada pasada |

**Re-validación en sandbox (30-jul), las tres guardas vistas en vivo:**

- **(c) manual:** ticket `47275177280` cancelado definitivo (factura `575231373738`) → pasada del deal
  → **sigue en CANCELADO `1311451813` con `of_invoice_id` y `of_invoice_status='Cancelada'` intactos**.
  Sweep: `propagated: 0 · skipped: 13`, todas con `reason: periodo_cerrado`.
- **(c) automático — el caso de plata:** ticket `47295259060` cancelado definitivo desde el editor
  (`modo:'cancelar'`, factura `575082098724`) → pasada → **sigue en `1311404155`,
  `invoicesEmitted: 0` y el período `…::2026-05-29` sigue con 2 facturas (las dos Canceladas): NO se
  emitió ninguna nueva.** Antes de la guarda, esta misma secuencia emitía factura nueva.
- **(b) refacturación:** ticket `47295677217` revertido y refacturado (F2 `575230632306`) → pasada →
  **conserva F2 y su etapa**; la factura vieja `574967680541` se saltea con
  `reason: factura_superada · pointedInvoiceId: 575230632306`.
- **`ya_limpio`** observado en los tickets que quedaron en el estado post-reversión
  (`47298308702`, `47295259060` antes del re-test): ya no reescriben el aviso en cada pasada.

**14 tests unitarios nuevos** (`src/__tests__/cancelledPropagationGuard.test.mjs`), suite completa
**358/358**. Las guardas `factura_superada` y `ya_limpio` **no dependen de las flags**: corrigen
también el comportamiento actual de producción (donde el problema 2 ya ocurre).

#### ✅ DEFINICIÓN 30-jul — el nombre dice lo que le pasa al ticket (y revertir es sólo para manuales)

Salió de mirar el resultado de la (c): el endpoint se llamaba `/cancelar` pero por dentro hacía un
**revert** (`modo` default `'revertir'`), y la vía que usa de verdad la pantalla —el `PATCH` de
`etapa_de_la_factura` → `Cancelada`— propagaba **sin intención**, o sea también revert. El nombre y el
efecto no coincidían por ninguno de los dos caminos.

| Acción | Factura | Ticket | Automáticos |
|---|---|---|---|
| **Cancelar** | Cancelada | **CANCELADO** — período cerrado, no se refactura | sí |
| **Revertir** | Cancelada | vuelve a facturable, listo para refacturar | **NO** → cancelar, editar o nota de crédito |

Por qué revertir no aplica a automáticos: revertir un **manual** deja el período **parado** esperando
que una persona apriete "facturar ahora"; revertir un **automático** **re-arma el cron**, que lo emite
solo en el próximo ciclo — idéntico si nadie corrigió nada, y corriendo una carrera contra el usuario
si estaba corrigiendo (el mensaje viejo lo admitía: *"pause el line item, o modifique o cancele el
ticket antes del próximo ciclo"*). Es la misma regla que las casillas del ticket aplican desde el
26-jul; el editor era el hueco.

**Qué cambió** (todo bajo `CANCEL_REVERT_FLOW_ENABLED`; apagada, comportamiento idéntico al de hoy):
- `POST /:id/cancelar` — **default `modo='cancelar'`**; `revertir` sobre una factura automática →
  **409** con el texto de nota de crédito; si no se puede resolver el pipeline → **409 fail-closed**
  (mismo criterio que el gate Nodum). Helper puro `resolveEditorCancelMode` + 10 tests.
- `PATCH /:id` con `etapa='Cancelada'` — ahora propaga con intent `'cancel'` (cierra el período) **y
  pasa por el gate Nodum**, que antes esquivaba: el gate sólo estaba en el POST.
- `GET /:id` devuelve **`es_automatica`** (resuelve `ticket_id → hs_pipeline`).
- Pantalla: antes de guardar, si la etapa pasa a Cancelada, aparece un aviso con **qué le va a pasar al
  ticket**; en automáticas dice que no se puede revertir y cuáles son las alternativas, y en manuales
  apunta a la casilla *Revertir factura* del ticket.

**Prueba en vivo (30-jul, editor local contra el sandbox):** `revertir` sobre automática → **409** ·
`modo` inválido → **400** · sin `modo` sobre automática → **200 `modo:"cancelar"`** y ticket
`47276414521` a **CANCELADO conservando `of_invoice_id`** · `revertir` sobre manual → **200** y ticket
a Próximos a Facturar (contador 1→2) · `PATCH etapa=Cancelada` sobre manual → ticket **CANCELADO**, no
a facturable · `PATCH etapa=Cancelada` sobre factura con `id_factura_nodum` → **409** y factura
intacta. Suite completa **371/371**.

✅ **Guía web `/guia` actualizada (30-jul).** El bloque `cancelar-factura` decía *"Cancelar una
factura no cancela el ticket"* y mencionaba un botón "Cancelar" que la pantalla no tiene: reescrito con
la semántica nueva (cancelar cierra el período · el cupo vuelve solo y queda en el historial · Nodum →
nota de crédito), y **se agregó la sección `revertir-factura`**: qué es, que es **sólo para manuales** y
por qué, los 4 pasos desde el ticket (motivo del ajuste → casilla → corregir → facturar ahora), las 4
propiedades y el aviso a administración. Más entrada en el índice y tip. Verificado: backticks
balanceados, `node --check` del JS de la página y la guía servida respondiendo 200 con las dos
secciones. ⚠️ **Describe el comportamiento CON la llave prendida**: si se mergea `main` con
`CANCEL_REVERT_FLOW_ENABLED` apagada, la guía dice algo que todavía no pasa → **prender la llave en el
mismo movimiento del merge**.

#### ✅ VALIDACIÓN EN SANDBOX de la definición, contra el servicio DEPLOYADO (30-jul, `9ec0940`)

No contra un servidor local: `https://webhooks-testing.up.railway.app`, con el deploy en `SUCCESS` y
el commit verificado por hash.

| | Resultado |
|---|---|
| **A.** `GET` de una automática | `es_automatica: true` (resuelve `ticket_id → hs_pipeline`) |
| **B.** `revertir` sobre automática | **409** con el texto de nota de crédito |
| **C.** sin `modo` sobre automática | **200 `modo:"cancelar"`** · ticket `47285972996` → **CANCELADO** conservando `of_invoice_id` |
| **D.** `revertir` sobre manual | `es_automatica: false` · **200** · ticket a Próximos a Facturar, contador 1→2 |
| **E.** `PATCH etapa=Cancelada` (la vía de la pantalla) | ticket **CANCELADO**, no a facturable · `motivo_cancelacion_del_ticket` escrito |
| **F.** factura con `id_factura_nodum` | **409 por las DOS vías** (`PATCH` y `POST`), factura **intacta en Pendiente** |
| **G.** pasada del deal después de todo | `propagated: 0` · `invoicesEmitted: 0` · **los 5 tickets cancelados siguen CANCELADOS con su factura conservada** (2 manuales, 2 automáticos, 1 manual del `PATCH`) |

**Un hallazgo lateral, y es buena noticia:** al intentar re-emitir el ticket `47298308702` el motor
**se negó** — *"Invoice activa ya existe para este período (guard `invoiceExistsForKey`)"*. Era la
factura huérfana `574976225542` que había dejado el bug de ayer (el sweep viejo le borró al ticket la
referencia a su factura nueva). O sea: **el guard anti-duplicado aguantó** y el período nunca corrió
riesgo de facturarse dos veces. Se re-vinculó la factura al ticket y se siguió la prueba con ella.

⚠️ **De paso:** `associateOnClosedWon.test.mjs` estaba **rojo desde el 29-jul** y no por el código —
el re-sync de etiquetas (`TICKET_LABEL_SYNC_ENABLED=true` en el `.env` real) corre al final de
`associateAllTicketsOnClosedWon` sobre TODOS los tickets considerados, así que el happy path veía un
`create` extra sobre el ticket ya vinculado. El test se aisló fijando la llave en `false` antes de los
imports (valida la mecánica de asociación; el re-sync tiene su propio archivo de tests).

#### Otros 3 hallazgos

1. **`of_billing_error` se cortaba a 250** (`cancelMsg.slice(0, 250)` hardcodeado ×3) y el resultado
   del cupo va al FINAL del mensaje → *"Cupo re-acreditado: +3200. Restante: 18800."* **nunca llegaba**
   (el mensaje base de la rama revertir ya mide ~270). También se comía el aviso textual viejo
   *"⚠️ Este ticket tenía cupo…"* de la rama con flags OFF. La usuaria pasó `of_billing_error` del
   ticket a **texto largo** el 29-jul (las dos props son `textarea` en los dos portales) → **CORREGIDO**
   con la constante `AVISO_MAX_LEN = 2000` (`invoice.js:283/315/410`). Suite 323/323.
2. **`Período: desconocido` siempre.** `invoiceDateToYMD(ip.hs_createdate)` recibe ISO 8601
   (`2026-07-29T19:29:11.615Z`): no matchea `YYYY-MM-DD` y `Number(s)` es `NaN` → devuelve `null`.
   **NO se corrigió a propósito:** ese mismo valor alimenta `ticketUpdate.fecha_de_facturacion`
   (`invoice.js:568-569`), o sea que hoy esa fecha **nunca se escribe** desde la propagación y
   arreglarlo la empieza a escribir — dato real y sensible a TZ (`hs_createdate` es un instante UTC;
   convertirlo en America/Montevideo puede dar el día anterior → trampa del "día menos").
3. **Un workflow del portal de pruebas vuelve a poner `cancelar_ticket=true`** unos segundos después
   de que el motor la resetea (`src=AUTOMATION_PLATFORM`, visto en los dos tickets del escenario (c) y
   en el automático de (i)). Los handlers lo absorben (ya en CANCELADO → sólo reset; automático →
   aviso + reset), pero **hay que revisarlo en PROD** — es del mismo tipo que el punto abierto de la
   checklist 6 (workflows que escriben nuestras props).

#### Gotchas de método (para la próxima corrida)

- **HubSpot perdió 2 de 8 eventos de `revertir_factura`** (el PATCH quedó registrado en el historial
  de la prop, y del mismo PATCH llegó el evento de `motivo_del_ajuste` pero **no** el de la casilla).
  Consecuencia operativa real: **la casilla queda en `true` sin que pase nada**, y como ya está en
  `true` volver a marcarla **no genera evento nuevo** → hay que destildar y volver a tildar. Sin
  aviso al usuario. Vale evaluar un barrido periódico de casillas pendientes (patrón del reaper).
- `subtotal_real` y `total_real_a_facturar` son **props calculadas**: no se pueden setear por API
  (400 `READ_ONLY_VALUE`). Para armar una NC se toca `cantidad_real` y HubSpot recalcula.
- Un `node ... | grep` **enmascara el exit code** del node (el del pipe es el de grep): un PATCH que
  falló con 400 dejó seguir la cadena `&&` y emitió una factura que no correspondía.
- La pasada del deal **borra tickets forecast duplicados**: el `47295102726` desapareció (404) entre
  dos corridas.

**Datos de prueba que quedan EN PIE a propósito** (para re-validar el fix de (c) sin volver a
sembrar): deal `63252656430` `[TEST-P2]` con cupo configurado + espejo `[TEST-P7]` `63261409185`
(LI `57563014574`, ticket `47280694534`). El `id_factura_nodum=9001` falso de la factura
`574967680541` **ya se limpió**.

---

## 8. Etiquetas «Empresa Factura» / «Partner» en los tickets (llave `TICKET_LABEL_SYNC_ENABLED`)

> Pedido 29-jul. Dos capas distintas, se validan por separado:
> **(1) heredar al nacer/ganar** — ya prendido en los dos portales por env
> (`ASSOC_TICKET_LABEL_EMPRESA_FACTURA` / `_PARTNER`: prod **13/11**, sandbox **5/7**), no necesita
> código nuevo. **(2) re-sync** (`syncTicketCompanyLabels.js` + RUTA 8), llave **OFF por default**.

**Precondiciones**
- [ ] Sandbox: `ASSOC_TICKET_LABEL_EMPRESA_FACTURA=5`, `ASSOC_TICKET_LABEL_PARTNER=7` (ya seteadas
      29-jul en los 4 servicios de testing) y `TICKET_LABEL_SYNC_ENABLED=true`.
- [ ] Un deal **ORIGINAL** (⚠️ no un espejo: `runBilling.js:144` saltea los mirrors) con **3 empresas**
      asociadas: la principal sin etiqueta, una con *Empresa Factura* (typeId 2 en sandbox) y otra con
      *Partner* (typeId 3). Anotar `DEAL_ID` y los 3 `COMPANY_ID`.

**Pasos**
1. [ ] **Capa 1 — al ganar.** Deal no ganado con LIs que generen cronograma → correr una pasada →
       pasarlo a `closedwon` + `facturacion_activa=true` → correr `node ./src/runBilling.js --deal <DEAL_ID>`.
2. [ ] Verificar en un ticket recién vinculado: tiene las **3** empresas asociadas, y las etiquetas
       caen en las **mismas** empresas que en el negocio.
3. [ ] **Capa 2 — el gap.** Tomar un ticket que YA estaba asociado antes de este cambio (o quitarle a
       mano la etiqueta a una de sus empresas) → correr la pasada de nuevo → la etiqueta **vuelve**.
4. [ ] **Capa 2 — cambio posterior.** En el NEGOCIO, mover la etiqueta *Empresa Factura* de una empresa
       a otra → esperar el evento (RUTA 8) o correr la pasada → el ticket **pierde** la etiqueta vieja y
       **gana** la nueva. La empresa vieja **sigue asociada al ticket, sin etiqueta**.
5. [ ] **Idempotencia.** Correr otra vez: `labelsAgregados:0 · labelsQuitados:0 · companiesAsociadas:0`.
6. [ ] **Llave OFF.** `TICKET_LABEL_SYNC_ENABLED=false` + repetir el paso 4 → el ticket **no cambia**
       (los tickets nuevos igual nacen etiquetados: eso no depende de esta llave).

**Resultado esperado**
- Ningún ticket **desasociado** en ningún escenario: sólo se agregan/quitan **etiquetas**.
- Etiquetas puestas a mano de **otro** tipo (typeId que el motor no gestiona) quedan intactas.
- En un **espejo**, la misma empresa (Interfase UY) aparece con *Empresa Factura* **y** *Partner* —
  es correcto, viene así del negocio (`dealMirroring.js:1291`).
- RUTA 8 responde **200** a todo evento de asociación, incluso a los que ignora (deal↔contacto,
  deal↔line item): un 4xx repetido puede hacer que HubSpot deshabilite la suscripción.

**Evidencia a registrar**
- [ ] `DEAL_ID` + los 3 `COMPANY_ID` + `TICKET_ID` usados.
- [ ] Log de `syncTicketCompanyLabels` de cada paso (`ticketsRevisados / companiesAsociadas /
      labelsAgregados / labelsQuitados / errors`).
- [ ] Id del job `ticket_label_sync` de la cola y su `status`.

### ✅ CORRIDA 2026-07-30 — PASA (y encontró un bug, ya corregido)

**Escenario:** se reusó el deal **`63252656430` `[TEST-P2]`** (el de la prueba 2, ya ganado, con
tickets ya asociados = justo el caso del gap). Se le agregaron 2 empresas etiquetadas en el NEGOCIO:
**`55485729366` INTERFASE S.A. → Empresa Factura** y **`55486545410` INTERFASE S.A SUCURSAL PARAGUAY
→ Partner**; la principal `55480071766` LA HORQUILLA quedó sin etiqueta.

| # | Qué se probó | Resultado |
|---|---|---|
| 1 | **Herencia por webhook (RUTA 8)** — al etiquetar en el negocio | ✅ **Sin correr el motor.** Jobs `#7774`/`#7775` `ticket_label_sync` → `done`: `ticketsRevisados=8 · companiesAsociadas=16 · labelsAgregados=16 · errors=0` (16 = 8 tickets × 2 empresas nuevas) |
| 2 | **Idempotencia (en vivo)** | ✅ El **segundo** evento (`#7775`) dio `companiesAsociadas=0 · labelsAgregados=0 · labelsQuitados=0` sin que nadie lo forzara |
| 3 | **Cambio posterior de etiqueta** — mover *Empresa Factura* a otra empresa | ✅ `labelsAgregados=8 · labelsQuitados=8 · errors=0`. La empresa vieja **quedó asociada al ticket, sin etiqueta** |
| 4 | **Llave OFF** (`TICKET_LABEL_SYNC_ENABLED=false` en `webhooks`) | ✅ Se movió la etiqueta en el negocio y **los tickets no se movieron** ⚠️ ojo: la llave hay que apagarla **en los dos servicios** — el `CRON hs-billing-updater` la tenía en `true` y corrigió por su cuenta un rato después |
| 5 | **Pieza (a): re-sync desde el hook de closedwon** | ✅ Corrida local `runBilling --deal`: el log de `associateOnClosedWon` trae `labelSync:{ticketsRevisados:7, labelsAgregados:1, labelsQuitados:0, errors:0}` — recuperó exactamente la etiqueta que se había quitado a mano |
| 6 | **Idempotencia (corrida controlada)** | ✅ Segunda corrida: `companiesAsociadas=0 · labelsAgregados=0 · labelsQuitados=0` |
| 7 | **Estado final** | ✅ Los 7 tickets asociados tienen **las 3 empresas del negocio**, con `EF` y `PARTNER` en las mismas que allá y la principal sin etiqueta |

#### 🐛 Bug encontrado y corregido durante la prueba: el PUT de etiquetas BORRABA el `Primary`

El endpoint de etiquetas **reemplaza** los tipos del par, no los suma. Verificado contra el portal:

```
1. marco la empresa como Primary   → ["HUBSPOT_DEFINED:26","HUBSPOT_DEFINED:339"]
2. aplico "Empresa Factura"        → ["HUBSPOT_DEFINED:339","USER_DEFINED:5"]   ← se perdió el 26
3. con el fix (specs preservados)  → ["HUBSPOT_DEFINED:339","HUBSPOT_DEFINED:26","USER_DEFINED:5"]
```

O sea: etiquetar una empresa **le borraba en silencio la marca de PRINCIPAL en el ticket**, y habría
borrado cualquier etiqueta puesta a mano en ese par. Corregido con `specsPreservando`
(`pruebas 88e96ef` · `main 9d6084e`), **verificado en vivo**: tras el re-sync el par quedó
`USER_DEFINED:5=Empresa Factura` **+** `HUBSPOT_DEFINED:26=Primary`. El fake client de los tests
también se corrigió — sólo sumaba tipos, así que el bug le pasaba por debajo. Suite **361/361**.

🧹 **Datos de prueba:** las 2 empresas quedaron asociadas al deal `[TEST-P2]` (sirven para re-validar).
El `Primary` del par ticket `47285972996` ↔ `55485729366` se puso a mano durante la prueba.
