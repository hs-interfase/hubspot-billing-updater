# Solicitud: modificar avisos al equipo de facturación

> Documento de organización de la solicitud. Fecha: 2026-06-23.

## 0. Aclaración previa: hay DOS avisos distintos

| | **Aviso MANUAL** | **Aviso MANSOFT (automática)** |
|---|---|---|
| Builder | `src/services/billing/buildMensajeFacturacion.js` | `src/services/billing/buildMensajeMantsoft.js` |
| Cron | `src/jobs/cronMensajeFacturacion.js` | `src/jobs/cronMensajeMantsoft.js` |
| Propiedad del deal | `mensaje_de_facturacion` | `mensaje_mansoft` |
| Se alimenta de | **TICKETS** (stage READY) | **LINE ITEMS** (`mansoft_pendiente=true`) |
| Título | "📋 Solicitud de Facturación" | "📋 Aviso Mantsoft" |

➡️ La **1ª entrega** (lista de 19 campos) corresponde al **aviso MANUAL** (`mensaje_de_facturacion`),
porque trabaja con tickets y los campos son por-factura (fecha de factura, condición de pago, etc.).

---

## 1. Aviso MANUAL — 1ª entrega (los 19 campos, mostrando título aunque el dato sea null)

Estado de cada campo contra el código actual y la propiedad del ticket:

| # | Campo solicitado | Propiedad del ticket | Estado actual |
|---|---|---|---|
| 1 | Empresa | (derivada de `producto_id`) | ✅ ya se muestra ("Empresa emisora") |
| 2 | Nombre del Negocio | `dealname` | ✅ ya se muestra |
| 3 | Cliente | `nombre_empresa` | ✅ ya se muestra ("Cliente final") |
| 4 | Cliente al que se factura | `empresa_que_factura` (dealMeta) | ✅ ya se muestra ("Cliente que factura") |
| 5 | Fecha de la factura | hoy | ✅ ya se muestra |
| 6 | Descripción de la factura | `of_descripcion_producto` | ✅ ya se muestra |
| 7 | Rubro | `of_rubro` | ✅ ya se muestra |
| 8 | Unidad de Negocio | `unidad_de_negocio` | ✅ ya se muestra |
| 9 | Moneda | `of_moneda` | ✅ ya se muestra |
| 10 | Cantidad | `cantidad_real` | ✅ ya se muestra |
| 11 | **Precio unitario (sin IVA)** | `monto_unitario_real` | ⚠️ se trae pero **NO se muestra** → agregar fila |
| 12 | Subtotal | `subtotal_real` | ✅ ya se muestra |
| 13 | **IVA** | `of_iva` | ⚠️ se trae pero **NO se muestra** → agregar fila |
| 14 | Monto Total a facturar | `total_real_a_facturar` | ✅ ya se muestra |
| 15 | **Condición de Pago** | ❓ **NO existe propiedad** | 🔴 BLOQUEANTE — hay que definir/crear |
| 16 | **IRAE** | `exonera_irae` | ⚠️ se trae pero **NO se muestra** → agregar fila |
| 17 | **TRADING** | `opera_trading` | ⚠️ existe, **falta en TICKET_PROPS** del cron + agregar fila |
| 18 | Frecuencia de Facturación | `of_frecuencia_de_facturacion` | ✅ ya se muestra |
| 19 | Observaciones | `observaciones_ventas` | 🐛 **BUG**: el builder lee `tp.observaciones`, pero el cron trae `observaciones_ventas` → siempre sale vacío |

### Cambios adicionales pedidos para el MANUAL
- **URL de acceso al ticket** → tenemos el `ticketId`; falta el **portalId de HubSpot** (no está en el código). Agregarlo por `.env` (`HUBSPOT_PORTAL_ID`).
- **Momento de facturación** → propiedad `momento_de_facturacion` ya existe en el ticket → agregar a `TICKET_PROPS` + fila.
- **Inicio de contrato** → ❓ no hay propiedad clara en el ticket. 🔴 BLOQUEANTE — definir cuál es.

### Comportamiento "mostrar aunque sea null"
- Hoy ambos builders **ocultan** las filas null (`if (value === null) return ''`).
- Implementar con **flag de debug temporal** (ej. `SHOW_NULLS=true` en `.env`):
  cuando está activo, cada campo se muestra con `(sin datos)` si está null. Apagable en producción.

---

## 2. Aviso MANSOFT (automática)

- **Mostrar todos los nombres de propiedades aunque estén null** (mismo flag de debug).
- **Link a la URL del NEGOCIO (deal)** + **nombre o ID del line item** vinculado a ese mansoft.
  - Tenemos `dealId` y `li.id` / `lp.name`. Falta solo el `portalId` (mismo `.env` de arriba).
- Ya muestra "Inicio de facturación" y "Próxima fecha" (no hace falta agregarlos acá).

---

## 3. Estado de los bloqueantes (actualizado 2026-06-23)

1. **"Condición de Pago"** (#15) — ⏸️ **IGNORADO por ahora** (decisión del usuario).
2. **"Inicio de contrato"** (manual) — ⚠️ **PENDIENTE de definir** qué propiedad es. No se agregó.
3. **portalId de HubSpot** — ✅ **resuelto en runtime** vía API `account-info` usando `HUBSPOT_PRIVATE_TOKEN`
   (con cache). Se puede sobreescribir con `HUBSPOT_PORTAL_ID` en `.env` si se prefiere fijarlo.

## 4. ✅ IMPLEMENTADO

**Aviso MANUAL (`buildMensajeFacturacion.js` + `cronMensajeFacturacion.js`):**
- Labels alineados a la lista de 19 (Empresa, Cliente, Cliente al que se factura, etc.).
- Fecha: la fila ahora se llama **"Fecha solicitud facturación"** y muestra `fecha_resolucion_esperada`.
- Filas nuevas: **Precio unitario (sin IVA)** (`monto_unitario_real`), **IVA** (`of_iva` → Sí/No),
  **IRAE** (`exonera_irae` → Exento/Aplica), **TRADING** (`opera_trading` → Sí/No),
  **Momento de facturación** (`momento_de_facturacion`), **Ticket** (link a HubSpot).
- 🐛 Corregido: Observaciones leía `observaciones` → ahora `observaciones_ventas`.
- `TICKET_PROPS` ampliado: `opera_trading`, `momento_de_facturacion`.

**Aviso MANSOFT (`buildMensajeMantsoft.js` + `cronMensajeMantsoft.js`):**
- Fila **"Negocio"** con link al deal en HubSpot.
- Fila **"ID line item"** en cada ítem (el nombre ya estaba en el título).
- Campos de contrato/pagos pedidos:
  - **Inicio de contrato** (`inicio_del_contrato`)
  - **Vigencia de contrato** (`fin_del_contrato`) — reemplaza al viejo "Vencimiento contrato"
  - **Inicio de facturación** / cuándo se factura (`hs_recurring_billing_start_date`) — ya existía
  - **Cantidad de pagos** (`hs_recurring_billing_number_of_payments`)
  - **Pagos emitidos** (`pagos_emitidos`), **Pagos restantes** (`pagos_restantes`)
  - **Progreso de pagos** (calculado: "X de Y emitidos" / "Quedan X de Y")
- `LI_PROPS` ampliado: `inicio_del_contrato`, `fin_del_contrato`.
- ℹ️ Nota: el aviso **MANUAL no lleva** "inicio de contrato" (confirmado por el usuario).

**Ambos:**
- Flag de debug temporal **`SHOW_NULLS=true`** (en `.env`): muestra todos los campos con
  "(sin datos)" aunque estén null, para verificar que las propiedades llegan. Apagable en producción.
- Helper nuevo `src/utils/hubspotPortal.js` (resuelve portalId + arma URLs de ticket/deal).

## 5. Pendiente / próximos pasos
- ✅ "Inicio de contrato" resuelto: va solo en MANSOFT (`inicio_del_contrato`), no en manual.
- ✅ portalId real confirmado contra la API: **`51101688`**.
- Decidir si "Fecha solicitud facturación" debe ir por línea (hoy va en el encabezado, tomando
  el `fecha_resolucion_esperada` del primer ticket del grupo).
- Probar el aviso MANUAL con datos reales cuando haya un ticket en stage READY
  (la sandbox hoy tiene 0 tickets en ambos pipelines).
