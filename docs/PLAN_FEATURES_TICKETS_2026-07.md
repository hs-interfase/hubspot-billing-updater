# PLAN DE ACCIÓN — Nuevas features de tickets

> Rama: `feat/features-tickets` (nace de `pruebas` @ 2026-07-05).
> Origen: revisión 5-jul con mapa de código completo (checklist maestro §4bis en `definitivos/TAREAS_PENDIENTES.md`).
> Documento vivo: se va marcando `[x]` y anotando decisiones a medida que armamos cada fase en esta rama.

## Resumen y orden propuesto

| # | Fase | Tarea | Estimación | Bloqueada por |
|---|------|-------|------------|---------------|
| 0 | Verificación | Editar ticket emitido (confirmar que ya funciona) | ½ día | — |
| 1 | Código | Eliminar "facturar ahora" del line item | 2 días | — |
| 2 | Código | Editar ticket desde LI con ticket en estado editable | 2-3 días | Stack de propiedades (correo 6-jul) |
| 3 | Investigación → decisión | Tickets visibles desde el negocio recién al cierre ganado | 1 día investigación; 5-8 días si hay que diferir la asociación | Resultado de la investigación UI + decisión todos-vs-manuales |
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

## Fase 3 — Tickets visibles desde el negocio recién al cierre ganado

**Aclaración usuaria 5-jul:** los tickets forecast siguen naciendo en cualquier etapa; lo que se quiere es que **no se vean/asocien en el negocio hasta closedwon**. Pendiente decidir: al cierre, ¿se asocian TODOS o solo los manuales?

**⚠ Riesgo estructural (por qué NO se apura):** el motor descubre los tickets de un deal por la asociación CRM (`getTicketsForDeal`, `src/services/tickets/ticketService.js:587`), igual que el export CSV (`fetchTicketsForDeal`, `cronExportReporte.js:291`). Ticket sin asociación = invisible para Phase P (dedup → duplicados), contadores, CSV y Paso C/D — exactamente la falla vivida en la corrida sandbox del 4-jul (49% huérfanos por 429).

**Paso 3a — Investigación UI (1 día, PRIMERO):**
- [ ] Probar en el portal de pruebas (51101688) si la tarjeta/tabla de tickets del registro de negocio se puede FILTRAR por pipeline o etapa (personalización de registro / association card). Los forecast ya viven en stages propios → si la tarjeta filtra, el problema de visibilidad se resuelve por configuración.
- [ ] Si funciona: replicar en prod, documentar, FIN (~1 día total, riesgo cero, sin tocar el motor).

**Paso 3b — Solo si la UI no alcanza (5-8 días, idealmente POST go-live):**
- [ ] Diseño: descubrimiento alternativo (candidata: Search por prop `of_deal_id`, ya existe en el ticket; contemplar el indexing lag conocido de la Search API) o asociación con etiqueta diferenciada.
- [ ] Decisión todos-vs-solo-manuales al cierre.
- [ ] Regresión completa en sandbox: Phase P dedup, catch-up, recalc contadores, CSV forecast (los pre-cierre DEBEN seguir saliendo en FORECAST/BACKLOG), VALOR (§5). Migración no afectada (históricos entran ganados).

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
| 2026-07-05 | T4 no se apura: la asociación deal→ticket es el mecanismo de descubrimiento del motor (falla ya vivida 4-jul). |
| (pendiente) | Stack de propiedades T3 (correo usuaria 6-jul). |
| (pendiente) | Campos editables post-emisión (Paola) — define si T2 crece. |
| (pendiente) | T4: todos vs solo manuales al cierre. |
