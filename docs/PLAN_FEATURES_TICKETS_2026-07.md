# PLAN DE ACCIÓN — Nuevas features de tickets

> Ramas: `feat/features-tickets` (plan) · **`feat/assoc-closedwon` (implementación Fase 3, arranca 6-jul)** — ambas desde `pruebas` @ 2026-07-05.
> Origen: revisión 5-jul con mapa de código completo (checklist maestro §4bis en `definitivos/TAREAS_PENDIENTES.md`).
> Documento vivo: se va marcando `[x]` y anotando decisiones a medida que armamos cada fase.

## Cronología comprometida (2026-07-05)
- Usuaria envía correo con las tareas → **los plazos corren desde la APROBACIÓN**.
- Ventana comprometida en cola de tareas: **15 al 30 de agosto 2026**.
- Objetivo interno: **entregar antes del 20 de agosto**.
- **Migración PROD: entre el 20 y el 25 de agosto 2026** (las features deben estar entregadas antes).
- El desarrollo arranca YA en ramas sin mergear (la aprobación gatea el deploy, no el desarrollo).

## Arranque 6-jul (rama `feat/assoc-closedwon`)
1. [x] Fix retry de `associateTicketToDealWithRetry` (backoff más largo para el lag de indexación; 429/5xx ya los cubre el proxy `hubspotClient`/`withRetry`) + `createTicketAssociations` **ya no traga el fallo**: si la asociación ticket→deal falla tras los reintentos, reporta accionable y devuelve `false` (causa del ~49% de huérfanos del 4-jul). `src/services/tickets/ticketService.js`.
2. [x] Hook al closedwon: `associateAllTicketsOnClosedWon` (`src/services/tickets/associateOnClosedWon.js`) — Search por `of_deal_id` → asocia faltantes al deal + companies/contacts, idempotente. Gateado por `facturacion_activa` (ganado). Cableado en `runPhasesForDeal` tras Phase 3, detrás de flag `ASSOC_ALL_ON_CLOSEDWON` (off por default). Seam `ASSOC_CLOSEDWON_ONLY_MANUAL` para el filtro todos-vs-manuales.
3. [x] Tests unitarios sin red (fakes + inyección de deps): `src/__tests__/associateOnClosedWon.test.mjs` — gate, happy path (solo faltantes), idempotencia, filtro por pipeline, resiliencia ante error, y el fix de `createTicketAssociations`. 7/7 verde.
4. [ ] Seed sandbox e2e + validación nocturna (deal no ganado → 0 asociados; pasar a closedwon → cronograma completo asociado).
5. [ ] Ajuste Paso C de migración (filtrar por stage además de asociación) — ambas copias. Revisar `auditLineItemTickets`.
6. [ ] Commitear en `feat/assoc-closedwon` SOLO los archivos de la feature (no barrer los cambios de `pruebas` sin commitear: mirrors, audit-log).

## Resumen y orden propuesto

| # | Fase | Tarea | Estimación | Bloqueada por |
|---|------|-------|------------|---------------|
| 0 | Verificación | Editar ticket emitido (confirmar que ya funciona) | ½ día | — |
| 1 | Código | Eliminar "facturar ahora" del line item | 2 días | — |
| 2 | Código | Editar ticket desde LI con ticket en estado editable | 2-3 días | Stack de propiedades (correo 6-jul) |
| 3 | Código | Tickets asociados al negocio al cierre ganado | 2-3 días (diagnóstico corregido 5-jul: cambio ADITIVO) | Decisión todos-vs-manuales (no bloquea el arranque) |
| 4 | Evaluación (CAUTELA) | Cambio de moneda del ticket | sin compromiso | Decisión de negocio; NO prometer a Paola |

Camino crítico: Fase 3. Fases 0 y 1 arrancan ya; la 2 apenas esté el stack.

---

## Fase 0 — Editar ticket en estado emitido (verificación, ½ día)

**Hallazgo 5-jul:** ya funciona. El motor no re-snapshotea ni revierte tickets fuera de forecast (Phase P los clasifica `protected`, `src/phases/phasep.js:894-925`); la factura emitida queda congelada por diseño (freeze rule, `src/services/invoiceService.js:378-399`).

**Pasos:**
- [ ] Sandbox: emitir un ticket (o usar uno emitido de la corrida), editar campos (nota, descripción, monto), correr el cron/pasada del deal y verificar que NADA se revierte.
- [ ] Verificar que la factura asociada NO cambió (comportamiento esperado).
- [ ] Documentar en la guía del responsable qué significa editar post-emisión (la factura no se actualiza; para tocar la factura → invoice-editor).
- [ ] **Decisión pendiente con Paola:** qué campos esperan editar post-emisión. Si son MONTOS, ticket y factura divergen → decidir conscientemente (¿sync ticket→invoice nueva? ¿siempre vía invoice-editor?). Solo en ese caso esta tarea crece a 4-6 días.

**Criterio de cierre:** evidencia sandbox anotada aquí + párrafo en doc del responsable.

---

## Fase 1 — Eliminar "facturar ahora" del line item (2 días)

**Estado actual:** el disparador existe en LI y en ticket, independientes. LI: webhook `api/escuchar-cambios.js:83-95` encola `urgent_line_item` → `processUrgentLineItem` (`src/services/urgentBillingService.js:755`). Ticket: `escuchar-cambios.js:96-107` → `processUrgentTicket` (`:984`). Eliminar el del LI NO afecta el del ticket.

**Pasos código (esta rama):**
- [ ] `api/escuchar-cambios.js`: eliminar la rama `objectType === 'line_item'` para `facturar_ahora` (dejar intacta la de ticket).
- [ ] `src/webhookQueue.js`: retirar el dispatch de `actionType: 'urgent_line_item'`.
- [ ] Decidir destino de `processUrgentLineItem` y `_executeUrgentBillingForLineItem` en `urgentBillingService.js`: eliminar vs dejar muertos con comentario. Propuesta: **eliminar** (git conserva la historia).
- [ ] Revisar tests que referencien el flujo LI urgente y ajustarlos.
- [ ] Buscar y limpiar referencias en `public/guia-facturacion-interfase.html`, `public/doc-responsable-of.html`, `public/doc-admin-facturacion.html`.

**Pasos HubSpot (fuera del código, checklist aparte):**
- [ ] Quitar la suscripción del webhook a `facturar_ahora` en line items (dejar la de tickets).
- [ ] Ocultar la prop `facturar_ahora` de vistas/editor de line items (prod + sandbox).
- [ ] Revisar si algún workflow de HubSpot escribe `facturar_ahora` en LIs.

**Validación sandbox:**
- [ ] Marcar `facturar_ahora=true` en un LI → NO pasa nada (ni ticket ni factura ni error).
- [ ] Marcar `facturar_ahora=true` en un ticket → flujo urgente completo OK (regresión).

**Fuera de esta rama (usuaria, en paralelo, no bloquea):** actualizar tutoriales y regrabar videos.

---

## Fase 2 — Editar ticket desde el line item con ticket editable (2-3 días)

**Estado actual:** la propagación LI→ticket (re-snapshot) solo aplica a tickets en forecast (`phasep.js:1061-1092`); al promoverse a "Próximos a facturar" (NEW) el ticket es fuente de verdad y el LI deja de pisarlo (partición forecast/protected, `phasep.js:894-925`).

**GATE:** stack de propiedades de la usuaria (correo 6-jul) — define POR CAMPO quién gana: qué props siempre propaga el LI vs cuáles son del responsable y no se pisan. Con eso la política de conflicto queda cerrada y el código es mecánico.

**Pasos (cuando esté el stack):**
- [ ] Volcar aquí el stack de propiedades acordado (tabla campo → dueño LI/responsable).
- [ ] Extender el re-snapshot de Phase P a tickets en NEW (¿y READY? — definir), aplicando SOLO los campos cuyo dueño es el LI.
- [ ] Mantener intacto el bloqueo total para emitidos/cancelados y mirrors sellados (`dealMirroring.js` sello `mig_espejo_independiente`).
- [ ] Tests unitarios de la política por campo + escenario seed en sandbox (editar LI con ticket en NEW → campos LI se actualizan, campos del responsable se conservan).

---

## Fase 3 — Tickets asociados al negocio al cierre ganado (2-3 días)

**⚠ DIAGNÓSTICO CORREGIDO 5-jul (inventario exhaustivo de asociaciones, verificado en código):** la versión anterior de esta fase estaba mal dimensionada. La realidad:
- Los tickets forecast **YA nacen SIN asociación** al deal (`safeCreateTicket` sin associations, `phasep.js:1001`) → hoy NO se ven desde el negocio antes del cierre. La mitad "no verlos pre-cierre" **ya está garantizada**.
- La asociación se crea recién al **promover/emitir** (`createTicketAssociations` en phase2:170, phase3:176/332, urgente:562, manual:229, recalc:193) — todos flujos gateados por `facturacion_activa` (= closedwon).
- El descubrimiento del motor NO depende de la asociación: Phase P, CSV forecast, contadores, catch-up, phase2/3, invoice, avisos — todo va por **Search** (`of_deal_id` / `of_line_item_key` / `of_ticket_key`). Solo hay 3 lectores-por-asociación productivos (`getTicketsForDeal` para ensure24/dedup clones, `auditLineItemTickets` de cronWeekendFull, `ticketCleanupService`).

**La tarea REAL es aditiva:** al detectar closedwon/`facturacion_activa`, asociar de una vez TODOS los tickets del deal (o solo los del pipeline manual — decisión pendiente), en vez de que aparezcan de a uno a medida que se promueven. Patrón ya probado en el repo: `scripts/fix/fixTicketAssociations.mjs` (Search por `of_deal_id` → asociar faltantes, idempotente).

**Pasos:**
- [x] **Prerrequisito (ya era bug crítico §2 del checklist):** endurecido `associateTicketToDealWithRetry` (backoff creciente [0,500,1500,3000,5000] para el lag de indexación; 429/5xx los cubre el proxy) + `createTicketAssociations` **ya no traga el fallo** (reporta accionable + devuelve `false`). `ticketService.js`.
- [x] Hook al closedwon (`associateOnClosedWon.js`, cableado en `phases/index.js` tras Phase 3): Search por `of_deal_id` → asocia faltantes (deal + companies/contacts), idempotente, flag `ASSOC_ALL_ON_CLOSEDWON`, seam `ASSOC_CLOSEDWON_ONLY_MANUAL`.
- [x] Decisión usuaria/Paola: **RESUELTO reunión 13-jul → SOLO MANUALES.** El pipeline manual se asocia al ganar; el automático NO se asocia y se muestra ordenado por fecha en la vista (facturados / listo-notificado / próximo-sin-notificar). Encodado en `ASSOC_CLOSEDWON_ONLY_MANUAL=true` (seteado en `.env` sandbox + `.env.real`; comentarios en `phases/index.js` y `associateOnClosedWon.js` actualizados; test de política por env agregado, suite 107/107). Prod: master flag `ASSOC_ALL_ON_CLOSEDWON` sigue OFF hasta el deploy de las assoc (hold usuaria) → al prender en Railway setear ambos. Falta (vista): ordenar por fecha el bloque de tickets automáticos en el negocio.
- [ ] **Interacción migración (único cuidado real):** Paso C asume "asociado = promovido" para editar solo promovidos (`migracion_pasoC:13,251`). Si el motor asocia forecast de deals ganados antes de C → C debe filtrar por stage además de asociación. Ajuste chico en C (ambas copias) o secuenciar.
- [ ] `auditLineItemTickets` (`cronWeekendFull.js:210`) cuenta por asociación: revisar que los conteos queden coherentes (hoy está sesgado a promovidos; con esto probablemente mejora).
- [x] Tests unitarios sin red (7/7 verde). [ ] Falta validación sandbox e2e: deal no ganado → 0 tickets visibles; pasar a closedwon → cronograma completo asociado; regresión promoción/emisión.
- [x] **Etiquetas ticket↔company (7-jul, modelo confirmado por usuaria)** — ⚠️ **CÓDIGO EN WORKING TREE SIN COMMITEAR** (decisión usuaria 8-jul: no subir aún; pasó por el stash `assoc-wip-mirrors-A-F`, ya popeado — no existe más; test restaurado, suite 94/94; al retomar: commit + Railway envs + re-correr backfill `scripts/fix/backfillTicketsAreaProducto.mjs` para los tickets nuevos del medio). Labels del portal y envs `.env`/`.env.real` quedaron:  beneficiario → prop `nombre_empresa` + asociación sin label · Cliente Factura → label **"Empresa Factura"** · Partner → label **"Partner"**. Labels creados por API en ambos portales (ticket→company: sandbox EF=5/Partner=7 · prod EF=13/Partner=11); `getDealCompanies` ahora devuelve `{ids, facturaId, partnerId}` (`normalizeCompaniesInfo` acepta el array legacy → tests viejos intactos); `createTicketAssociations` y el barrido de closedwon crean la asociación etiquetada, gateado por `ASSOC_TICKET_LABEL_EMPRESA_FACTURA`/`_PARTNER` (default 0=off; ya en `.env`/`.env.real`, **falta Railway**). Pre-cierre no hay asociación pero los valores se ven igual (props texto `nombre_empresa`/`empresa_que_factura`/`cliente_partner` desde la creación). Gap conocido: el barrido solo etiqueta tickets recién vinculados → tickets ya asociados de antes necesitarían mini-backfill de etiquetas.
- [x] **Vistas por Producto/Área (7-jul; snapshot del motor también en el stash de arriba):** backfill corrido en AMBOS portales — sandbox 29.486 tickets 0 fallos (area 26.863/29.524 · of_producto 29.485/29.524) y **prod 8-jul: 309 tickets 0 fallos (of_producto 309/309 · area 290/309, 19 LIs sin área)**, vistas sandbox validadas por usuaria. Detalle original:  snapshot nuevo `deriveProductoTicket(deal.producto, li.name)` → `ticket.of_producto` (select con catálogo; opciones alineadas por API con `deal.producto` en ambos portales, dup PayRoll/Payroll eliminado) + test 5/5. Backfill `scripts/fix/backfillTicketsAreaProducto.mjs` (area desde LI + of_producto desde deal, solo campos vacíos) **corrido en sandbox: 29.486 tickets, 0 fallos** → area 26.863/29.524 · of_producto 29.485/29.524. **Prod pendiente** (tras validación de vistas en sandbox). Fix aparte: `of_propietario_secundario` en prod era checkbox → select.

**Estimación REAL: 2-3 días** (incluye el fix del retry, el ajuste de Paso C y la validación). La investigación de UI (filtrar tarjeta) ya NO hace falta: el comportamiento pre-cierre deseado ya existe.

### Revisión de riesgos futuros (6-jul) — impacto de asociar forecast al ganar

Antes "asociado = promovido/cerca de facturar"; ahora un ganado asocia TODO su cronograma. Se auditaron los lectores-por-asociación que **actúan**:

- **`cleanupClonedTicketsForDeal`** (PRE de cada pasada, `ticketCleanupService.js`): PASO A deprecia solo `source_type=CLONE_OBJECTS` (los forecast NO lo son) · PASO B mismatch (solo si el LI de la key ya no está en el deal) · PASO C dedup por `of_ticket_key` (keys de forecast son únicas por fecha). **No toca forecast por error.** Su `getAssocIdsV4` SÍ pagina.
- **`getTicketsForDeal`** (usa ensure24 / findCanonical / `archiveClonedTicketsByKey`): chequeos de existencia/dedup → **más completos = más seguro** (menos duplicados). `archiveClonedTicketsByKey` (destructivo) solo archiva tickets con la MISMA key → no afecta a otros forecast.
- **`auditLineItemTickets`** (`cronWeekendFull.js`): **solo REPORTA** (mismatches/missingForecast); el conteo se vuelve más preciso para ganados. No dispara acción.

**Conclusión:** ningún guard destructivo se dispara mal. El cambio es aditivo y en varios casos MEJORA la precisión.

**⚠ PERO expone un límite de escala latente (BLOQUEA prender el flag):** `getTicketsForDeal` (`ticketService.js:587`) y `readTickets` (`ticketCleanupService.js`) hacen `batchApi.read` **sin trocear a 100** y `getTicketsForDeal` lee asociaciones con `getPage(...,100)` **sin paginar**. Nunca falló porque "asociado=promovido" daba <100 tickets/deal. Con la feature, un ganado grande (varias líneas × ~24 forecast) puede pasar 100 asociados → **HubSpot 400 en el batch read** (protegido por try/catch: no rompe la pasada, pero deja cleanup/dedup parcial de ese deal). `auditLineItemTickets` usa `getPage(...,500)` sin paginar (tope holgado, conviene paginar igual).

- [x] **ANTES de `ASSOC_ALL_ON_CLOSEDWON=true` — HECHO 6-jul:** helper `readTicketsInChunks` (trocea `batchApi.read` a ≤100) + `getAllAssociatedIds` extendido con `wrap` opcional (ya paginaba), ambos en `src/utils/hubspotAssociations.js`. Aplicados en `getTicketsForDeal` (`ticketService.js`, ahora pagina + trocea), `readTickets` (`ticketCleanupService.js`, trocea; sus asociaciones ya paginaban en `getAssocIdsV4`) y `auditLineItemTickets` (`cronWeekendFull.js`, pagina + trocea, con `withRetry` como `wrap`). Tests `src/__tests__/hubspotAssociations.test.mjs` 5/5 verde; suite `*.test.mjs` 79/79 sin regresión.

---

## Fase 4 — Cambio de moneda del ticket (EVALUACIÓN, con cautela)

**Postura acordada 5-jul:** hacia Paola, "lo estamos evaluando" — sin compromiso. No entra al MVP salvo decisión explícita.

**Referencia interna (no comunicar como promesa):** MVP acotado posible — `of_moneda` es prop del ticket y la invoice ya toma `hs_currency` del ticket (`invoiceService.js:380`); cambiarla en un ticket manual editable antes de emitir es viable si el responsable ajusta montos a mano y se re-deriva `dolar` por ticket. Impactos abiertos: export CSV y contadores asumen moneda única. Si algún día se aprueba: 4-6 días. Cruza con "Multi-moneda en un mismo negocio" (checklist §6).

---

## Registro de decisiones

| Fecha | Decisión |
|-------|----------|
| 2026-07-05 | Tareas 1-4 acordadas como esenciales; moneda con cautela (no comprometer). |
| 2026-07-05 | Estimaciones ajustadas: T1=2d · T2≈0 (solo permitir editar) · T3=2-3d · T4=investigar UI primero. |
| 2026-07-05 | ~~T4 no se apura: la asociación es el mecanismo de descubrimiento~~ **CORREGIDO mismo día tras inventario**: el descubrimiento es por Search; los forecast ya nacen sin asociar; T4 = agregar asociación masiva al closedwon (aditivo, 2-3 días). |
| 2026-07-07 | Modelo empresas en ticket: beneficiario = principal (prop + asociación sin label) · Cliente Factura y Partner = asociaciones CON etiqueta propia ticket↔company. Preferencia usuaria: lo que se pueda por workflows de HubSpot; el match "qué empresa es la de factura" no lo hacen los workflows nativos (comparación dinámica entre props) → motor. |
| 2026-07-07 | Producto en vistas de tickets = prop `of_producto` (select, catálogo del deal), NO `of_producto_nombres` (texto). Se alimenta del deal con heurística por nombre de LI. |
| 2026-07-07 | Propietario de tickets: mecanismo `assignTicketOwners` ya existe (asigna al closedwon desde `responsable_asignado` del LI → la notificación de HubSpot recién sale al ganar, como pide la usuaria; no se puede asignar-sin-notificar por API). Falta fallback al vendedor del deal — esperando lógica de Paola/Victoria. |
| 2026-07-08 | Usuaria: "ahora no subiré las assoc" → código de asociaciones etiquetadas + snapshot `of_producto` quedó SIN commitear en el working tree (pasó por el stash `assoc-wip-mirrors-A-F`, popeado el mismo día; junto con fixes mirrors A-F). Backfills area/of_producto ya corridos en ambos portales quedan firmes. |
| 2026-07-08 | Propietario de tickets confirmado por usuaria: **vendedor del deal** como fallback cuando el LI no tiene `responsable_asignado` — implementado en `assignTicketOwners` (sigue gateado a closedwon+; suite 89/89). |
| (pendiente) | Stack de propiedades T3 (correo usuaria 6-jul). |
| (pendiente) | Campos editables post-emisión (Paola) — define si T2 crece. |
| (pendiente) | T4: todos vs solo manuales al cierre. |
