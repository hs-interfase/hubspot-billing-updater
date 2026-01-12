# 🚀 HubSpot Billing Updater v2.0

Sistema automatizado de gestión de facturación para HubSpot que soporta flujos **manuales** (tickets de revisión) y **automáticos** (emisión directa de facturas).

## 📋 Descripción

Este proyecto automatiza el proceso de facturación en HubSpot basándose en Line Items con dos modos de operación:

- **Facturación Manual** (`facturacion_automatica=false`): Genera tickets de "Orden de Facturación" para revisión humana con 30 días de anticipación
- **Facturación Automática** (`facturacion_automatica=true`): Emite facturas directamente cuando llega la fecha o mediante disparo manual


## ✨ Características
- ✅ **3 Fases de procesamiento** (Fechas/Cupo, Tickets Manuales, Facturas Automáticas)
- ✅ **Idempotencia garantizada** (no crea duplicados)
- ✅ **Snapshots inmutables** (copia datos a tickets para evitar cambios posteriores)
- ✅ **Webhook para facturación inmediata** (disparar desde HubSpot)
- ✅ **Modo DRY_RUN** (testing sin afectar datos)
- ✅ **Soporte para mirrors UY/PY** (sincronización entre países)
- ✅ **Gestión de cupo** (por horas o por monto) con inicialización automática y consumo idempotente. Si un deal tiene `cupo_activo=true` y `cupo_consumido` o `cupo_restante` están vacíos, el sistema los inicializa: `cupo_consumido=0` y `cupo_restante=cupo_total`/`cupo_total_monto`. Tras crear cada factura, se descuenta del cupo sólo una vez (aunque se vuelva a procesar el ticket) y se desactiva el cupo cuando se agota.


## 🏗️ Arquitectura

```
src/
├── phases/          # Lógica de 3 fases
│   ├── phase1.js    # Fechas, calendario, cupo
│   ├── phase2.js    # Tickets manuales (lookahead 30 días)
│   └── phase3.js    # Facturas automáticas
├── services/        # Servicios reutilizables
│   ├── ticketService.js
│   ├── invoiceService.js
│   └── snapshotService.js
├── utils/           # Utilidades
└── config/          # Constantes
```

Ver documentación completa: [REFACTOR_DOCUMENTATION.md](docs/REFACTOR_DOCUMENTATION.md)

## 🚀 Inicio Rápido

### Instalación

```bash
npm install
```

### Configuración

Crear archivo `.env`:

```env
HUBSPOT_PRIVATE_TOKEN=tu_token_aqui
DRY_RUN=false
```

### Uso

```bash
# Procesar un deal específico
node src/runBilling.js --deal 12345

# Procesar todos los deals
node src/runBilling.js --allDeals

# Modo testing (no crea recursos reales)
DRY_RUN=true node src/runBilling.js --deal 12345
```

## 📊 Flujo de Ejecución

1. **Phase 1**: Actualiza fechas de facturación, contadores de avisos y cupo del deal
2. **Phase 2**: Crea tickets manuales para line items que requieren revisión (dentro de 30 días)
3. **Phase 3**: Emite facturas automáticas para line items que tocan hoy o tienen `facturar_ahora=true`

Ver diagramas: [FLOW_DIAGRAM.md](docs/FLOW_DIAGRAM.md)

## 🔧 Configuración en HubSpot

### Propiedades Requeridas

Consulta el checklist completo: [HUBSPOT_PROPERTIES_CHECKLIST.md](docs/HUBSPOT_PROPERTIES_CHECKLIST.md)

**Propiedades críticas a crear:**
- Line Item: `of_invoice_id`, `of_invoice_key`, `of_invoice_status`
- Ticket: `of_ticket_key`
- Invoice: `of_invoice_key`, `of_invoice_status`

### Webhook (Facturación Inmediata)

Configurar en HubSpot → Settings → Webhooks:
- **Evento:** Property Change
- **Objeto:** Line Item
- **Propiedad:** `facturar_ahora`
- **URL:** `https://tu-dominio.vercel.app/api/facturar-ahora`

## 📚 Documentación

- [📖 Documentación Completa](docs/REFACTOR_DOCUMENTATION.md) - Funciones, arquitectura, propiedades
- [✅ Checklist de Propiedades](docs/HUBSPOT_PROPERTIES_CHECKLIST.md) - Qué crear en HubSpot
- [🔄 Diagramas de Flujo](docs/FLOW_DIAGRAM.md) - Visualización de procesos
- [📋 Billing Flow Original](docs/billing-flow.md) - Documentación legacy

## 🧪 Testing

```bash
# Modo DRY_RUN (no crea recursos reales)
DRY_RUN=true node src/runBilling.js --deal 12345

# Testing de idempotencia (ejecutar 2 veces)
node src/runBilling.js --deal 12345
node src/runBilling.js --deal 12345  # No debe crear duplicados
```

## 🔑 Decisiones de Diseño

### ¿Cuándo se crea un Ticket?
- Line Item con `facturacion_automatica=false`
- Próxima fecha de facturación dentro de 30 días
- No existe ticket previo con la misma clave

### ¿Cuándo se crea una Factura?
- Line Item con `facturacion_automatica=true`
- HOY es la fecha de facturación **O** `facturar_ahora=true`
- No existe factura previa

### Idempotencia
- **Tickets:** Clave única `<dealId>::<lineItemId>::<fecha>`
- **Facturas:** Clave única `<dealId>::<lineItemId>::<fecha>`
- Búsqueda antes de crear para evitar duplicados

## 📝 Changelog v2.0

### ✨ Nuevo
- Phase 2: Tickets manuales con lookahead 30 días
- Phase 3: Facturas automáticas basadas en `facturacion_automatica`
- Servicios modulares (ticketService, invoiceService, snapshotService)
- Webhook para facturación inmediata
- Snapshots inmutables en tickets
- Idempotencia completa

### 🔧 Modificado
- Phase 1: Eliminada dependencia de "bolsa de horas" (bagEngine)
- Arquitectura modular y testeable

### 🗑️ Eliminado
- Referencias a `bagEngine.js` (obsoleto)

## 🤝 Contribuir

1. Fork el proyecto
2. Crear branch de feature (`git checkout -b feature/AmazingFeature`)
3. Commit cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push al branch (`git push origin feature/AmazingFeature`)
5. Abrir Pull Request

## 📄 Licencia

ISC

## 👥 Autores

- Proyecto original: Michellefsd
- Refactor v2.0: 2025-12-25

---

**Versión:** 2.0.0  
**Última actualización:** 2025-12-25






























## ⏳ Inicio diferido de facturación (HubSpot Billing Start Delay)

HubSpot permite que un **Line Item** configure el inicio de la facturación recurrente de tres formas:

- **Inicio inmediato**
- **Inicio en una fecha fija**
- **Inicio diferido** por **días** o **meses** (delay)

Cuando el usuario elige **inicio diferido**, HubSpot **no completa** `hs_recurring_billing_start_date`.  
En su lugar, completa propiedades de delay:

- `hs_billing_start_delay_days` *(número de días de retraso)*
- `hs_billing_start_delay_months` *(número de meses de retraso)*
- `hs_billing_start_delay_type` *(modo elegido por HubSpot: días/meses/fecha fija)*

### 🔥 Problema que resuelve

Nuestro motor (especialmente **Phase 1**) históricamente asumía que el inicio real de facturación venía en:

- `hs_recurring_billing_start_date`

Pero con **inicio diferido**, esa propiedad puede venir `null`, lo que provoca que:

- el line item parezca “sin fecha”
- se calcule mal la **próxima fecha de facturación**
- se omita el item en el calendario
- el deal termine con `facturacion_proxima_fecha` incorrecta

### ✅ Solución implementada: normalización antes de Phase 1

Agregamos una normalización previa que:

1. Detecta line items con `hs_billing_start_delay_days` o `hs_billing_start_delay_months`
2. Calcula una **fecha real** de inicio (`hs_recurring_billing_start_date`) usando una fecha base
3. **Convierte** el delay a una fecha fija y limpia los campos de delay

Esto permite que el motor opere sobre una “fecha justa” (fecha concreta), manteniendo la lógica existente del calendario.

### 📌 Archivo y función

- Archivo: `src/normalizeBillingStartDelay.js`
- Funciones principales:
  - `normalizeBillingStartDelayForLineItem(lineItem, deal)`
  - `normalizeBillingStartDelay(lineItems, deal)`

### 🧮 Fecha base para el cálculo

Para calcular la fecha efectiva, usamos esta prioridad (puede ajustarse según negocio):

1. `lineItem.createdate` o `lineItem.hs_createdate` (si existe)
2. `deal.properties.closedate` (si existe)
3. fallback: **hoy** (00:00)

Luego:
- si hay `hs_billing_start_delay_days`: `baseDate + days`
- si hay `hs_billing_start_delay_months`: `baseDate + months` *(con ajuste por fin de mes)*

### ✍️ Propiedades que actualizamos en HubSpot

Cuando hacemos la conversión, actualizamos el line item con:

- `hs_recurring_billing_start_date = YYYY-MM-DD`
- `hs_billing_start_delay_days = null`
- `hs_billing_start_delay_months = null`

> No forzamos `hs_billing_start_delay_type` manualmente.  
> Primero lo logueamos para confirmar el valor real que usa HubSpot en este portal.

### 🧾 Logs para debug (Phase 1)

Antes de la conversión logueamos:

```js
console.log('[phase1][billing-delay]', {
  lineItemId: li.id,
  hs_billing_start_delay_type: p.hs_billing_start_delay_type,
  hs_billing_start_delay_days: p.hs_billing_start_delay_days,
  hs_billing_start_delay_months: p.hs_billing_start_delay_months,
  hs_recurring_billing_start_date: p.hs_recurring_billing_start_date,
});
