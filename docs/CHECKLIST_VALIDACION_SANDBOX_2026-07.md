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
- [ ] `DEAL_ID`, `TICKET_ID`, `INVOICE_ID` + captura del ticket antes/después de la pasada.
- [ ] Captura de la factura sin cambios.
- [ ] Log de la pasada mostrando el ticket clasificado como protegido (buscar `protected` / Phase P en el log del deal).
- [ ] **Anotar la evidencia también en `docs/PLAN_FEATURES_TICKETS_2026-07.md` (Fase 0)** — el plan lo pide como criterio de cierre.

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
- [ ] `DEAL_ID` + captura del negocio ANTES (0 asociados) y DESPUÉS (asociados por pipeline).
- [ ] Conteo esperado vs. real: manuales / auto pasados / próximo auto.
- [ ] Log de `associateOnClosedWon` (asociados/saltados).

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
- [ ] `LI_ID`, `TICKET_ID`, `INVOICE_ID`, ids de job de la cola.
- [ ] Captura de la respuesta/log 200 skipped del LI y del ticket facturado.

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
- [ ] `TICKET_ID`, `TICKET_FC_ID`, `DEAL_ID`, ids de jobs.
- [ ] Deal antes/después (captura de las 3 props de VALOR/MARGEN).
- [ ] Salida de las 3 queries de arriba.

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
- [ ] `LI_ID`/`TICKET_ID` de los escenarios (a)-(c) + `LI_PY_ID`/`DEAL_UY_ID` del (d) + ids de jobs.
- [ ] Captura del ticket (props sincronizadas + `of_billing_error`) y de la tarea del workflow (a).
- [ ] Captura del `billing_error` del deal UY + del correo recibido por el operativo (d).

---

## 6. Checklist manual en HubSpot (tarea A — la corre la usuaria en el portal)

> Idealmente ANTES del deploy de la rama; como mínimo, mismo día.

- [x] **Quitar la suscripción** `line_item.propertyChange / facturar_ahora` en la app privada — **HECHO 26-jul (usuaria)**. **Conservar** la de `ticket.propertyChange / facturar_ahora` (verificar que sigue activa al repasar esta lista).
- [x] **Ocultar** la propiedad `facturar_ahora` de vistas, tarjetas y editores de LINE ITEM — **HECHO 26-jul (usuaria)**. **NO borrar la propiedad** (hay historia y el código de tickets la comparte por nombre).
- [ ] **Revisar workflows** de HubSpot: ninguno debe escribir `facturar_ahora` en line items (buscar en workflows activos por la propiedad).
- [ ] **Confirmar que la suscripción de TICKET quedó intacta**: `ticket.propertyChange / facturar_ahora` activa en la app privada.
- [ ] **Drenar la cola antes del deploy**: no debe quedar ningún urgente de LI en vuelo:

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

## Próximo: cancelar/revertir ticket

> Control de cambios aprobado (26-jul) — la checklist de validación se diseña aparte cuando esté la implementación; placeholder para no perderlo de vista.
