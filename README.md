🚀 HubSpot Billing Updater v2.0

Sistema automatizado de gestión de facturación para HubSpot que soporta flujos manuales (tickets de revisión) y automáticos (emisión directa de facturas).

📋 Descripción

Este proyecto automatiza el proceso de facturación en HubSpot basándose en Line Items con dos modos de operación:

Facturación Manual (facturacion_automatica=false)
Genera tickets de Orden de Facturación para revisión humana con 30 días de anticipación.

Facturación Automática (facturacion_automatica=true)
Emite facturas directamente cuando llega la fecha. (La facturación urgente por disparo manual — facturar_ahora=true — se hace únicamente desde el TICKET.)

✨ Características

✅ 3 fases de procesamiento (Fechas/Cupo, Tickets Manuales, Facturas Automáticas)

✅ Idempotencia garantizada (no crea duplicados)

✅ Snapshots inmutables en tickets

✅ Webhook de facturación inmediata

✅ Modo DRY_RUN para testing

✅ Soporte mirrors UY / PY

✅ Gestión de cupo (horas o monto), con consumo idempotente post-facturación

🏗️ Arquitectura
src/
├── phases/
│   ├── phase1.js    # Fechas, calendario, cupo, mirrors
│   ├── phase2.js    # Tickets manuales (lookahead 30 días)
│   └── phase3.js    # Facturas automáticas
├── services/
│   ├── ticketService.js
│   ├── invoiceService.js
│   └── snapshotService.js
├── utils/
└── config/

🚀 Inicio Rápido
Instalación
npm install

Configuración
HUBSPOT_PRIVATE_TOKEN=tu_token_aqui
DRY_RUN=false

Uso
# Procesar un deal específico
node src/runBilling.js --deal 12345

# Procesar todos los deals
node src/runBilling.js --allDeals

# Modo testing
DRY_RUN=true node src/runBilling.js --deal 12345

📊 Flujo de Ejecución

Phase 1
Normaliza fechas, inicializa cupo y sincroniza mirrors PY ↔ UY.

Phase 2
Crea tickets manuales para line items que facturan dentro de 30 días.

Phase 3
Emite facturas automáticas (fecha = hoy).

👤 Responsable del Ticket (DEFINICIÓN OFICIAL)

El responsable del ticket NO sale del Deal

El responsable se toma exclusivamente del Line Item

Propiedad usada:
responsable_asignado (Line Item)

Reglas

El responsable se asigna solo al CREAR el ticket

En updates posteriores, el sistema NO modifica hubspot_owner_id

El usuario puede reasignar manualmente el ticket en HubSpot

No existe PM en el sistema

La propiedad pm_asignado ya no se usa

🧮 Cálculos de Facturación (Ticket)

Las siguientes propiedades son la fuente de verdad:

Subtotal real

subtotal_real

Calculado como:
cantidad_real * monto_unitario_real

No incluye descuentos ni IVA

Descuentos

descuento_en_porcentaje (opcional)

descuento_por_unidad_real

descuento_monto_total_real
(descuento_por_unidad_real * cantidad_real)

Total real a facturar

total_real_a_facturar

Se calcula a partir de:

subtotal_real

Descuento (porcentaje o monto total)

IVA (si aplica)

⚠️ Estos cálculos se leen y recalculan en el ticket.
La lógica ya está implementada y no se redefine en updates.

🔧 Configuración en HubSpot
Propiedades críticas

Line Item

responsable_asignado

facturacion_automatica

Ticket

of_ticket_key

facturar_ahora (disparo de facturación urgente)

Propiedades de cálculo (subtotal_real, total_real_a_facturar, etc.)

Invoice

of_invoice_key

of_invoice_status

🔔 Webhook – Facturación Urgente (Facturar ahora)

Evento: Property Change

Objeto: Ticket

Propiedad: facturar_ahora

URL:

https://tu-dominio/api/escuchar-cambios

(la ruta filtra por propertyName=facturar_ahora; no existe /api/facturar-ahora)

Nota: el disparo "facturar ahora" desde line item fue ELIMINADO en 2026-07 (control de cambios N°5). El router responde 200 "skipped" a eventos de line item; la suscripción del webhook de line item y la propiedad en las vistas del CRM ya fueron retiradas. La facturación urgente se dispara únicamente desde el TICKET.

🧪 Testing e Idempotencia

Clave única de ticket y factura:

<dealId>::LIK:<lineItemKey>::<fechaYMD>   (of_ticket_key, ver src/utils/ticketKey.js)


Ejecutar dos veces no crea duplicados.

📝 Decisiones Clave

El Deal no define responsables

El Line Item define el responsable

El Ticket es la única fuente editable post-creación

Ediciones en Line Item con ticket existente solo afectan fechas futuras

El consumo de cupo ocurre solo al emitir factura


la regla de facturacion en phase 3 es asi.

facturar_ahora (ticket) / phase3
       ↓
  [GUARD] countActivePlanInvoices >= totalPayments → skip   ← lo que agregamos
       ↓
  createInvoiceFromTicket
       ↓
  [IDEMPOTENCIA] of_invoice_id + invoice_key match → return early   ← ya existía
       ↓
  createInvoiceDirect   ← solo llega si pasó ambos filtros

📄 Licencia

ISC

Versión: 2.0.0
Última actualización: 2026-01







































🚀 HubSpot Billing Updater v2.0

Sistema automatizado de gestión de facturación para HubSpot que soporta flujos manuales (tickets de revisión) y automáticos (emisión directa de facturas).

📋 Descripción

Este proyecto automatiza el proceso de facturación en HubSpot basándose en Line Items con dos modos de operación:

Facturación Manual (facturacion_automatica=false)
Genera tickets de Orden de Facturación para revisión humana con 30 días de anticipación.

Facturación Automática (facturacion_automatica=true)
Emite facturas directamente cuando llega la fecha. (La facturación urgente por disparo manual — facturar_ahora=true — se hace únicamente desde el TICKET.)

✨ Características

✅ 3 fases de procesamiento (Fechas/Cupo, Tickets Manuales, Facturas Automáticas)

✅ Idempotencia garantizada (no crea duplicados)

✅ Snapshots inmutables en tickets

✅ Webhook de facturación inmediata

✅ Modo DRY_RUN para testing

✅ Soporte mirrors UY / PY

✅ Gestión de cupo (horas o monto), con consumo idempotente post-facturación

🏗️ Arquitectura
src/
├── phases/
│   ├── phase1.js    # Fechas, calendario, cupo, mirrors
│   ├── phase2.js    # Tickets manuales (lookahead 30 días)
│   └── phase3.js    # Facturas automáticas
├── services/
│   ├── ticketService.js
│   ├── invoiceService.js
│   └── snapshotService.js
├── utils/
└── config/

🚀 Inicio Rápido
Instalación
npm install

Configuración
HUBSPOT_PRIVATE_TOKEN=tu_token_aqui
DRY_RUN=false

Uso
# Procesar un deal específico
node src/runBilling.js --deal 12345

# Procesar todos los deals
node src/runBilling.js --allDeals

# Modo testing
DRY_RUN=true node src/runBilling.js --deal 12345

📊 Flujo de Ejecución

Phase 1
Normaliza fechas, inicializa cupo y sincroniza mirrors PY ↔ UY.

Phase 2
Crea tickets manuales para line items que facturan dentro de 30 días.

Phase 3
Emite facturas automáticas (fecha = hoy).

👤 Responsable del Ticket (DEFINICIÓN OFICIAL)

El responsable del ticket NO sale del Deal

El responsable se toma exclusivamente del Line Item

Propiedad usada:
responsable_asignado (Line Item)

Reglas

El responsable se asigna solo al CREAR el ticket

En updates posteriores, el sistema NO modifica hubspot_owner_id

El usuario puede reasignar manualmente el ticket en HubSpot

No existe PM en el sistema

La propiedad pm_asignado ya no se usa

🧮 Cálculos de Facturación (Ticket)

Las siguientes propiedades son la fuente de verdad:

Subtotal real

subtotal_real

Calculado como:
cantidad_real * monto_unitario_real

No incluye descuentos ni IVA

Descuentos

descuento_en_porcentaje (opcional)

descuento_por_unidad_real

descuento_monto_total_real
(descuento_por_unidad_real * cantidad_real)

Total real a facturar

total_real_a_facturar

Se calcula a partir de:

subtotal_real

Descuento (porcentaje o monto total)

IVA (si aplica)

⚠️ Estos cálculos se leen y recalculan en el ticket.
La lógica ya está implementada y no se redefine en updates.

🔧 Configuración en HubSpot
Propiedades críticas

Line Item

responsable_asignado

facturacion_automatica

Ticket

of_ticket_key

facturar_ahora (disparo de facturación urgente)

Propiedades de cálculo (subtotal_real, total_real_a_facturar, etc.)

Invoice

of_invoice_key

of_invoice_status

🔔 Webhook – Facturación Urgente (Facturar ahora)

Evento: Property Change

Objeto: Ticket

Propiedad: facturar_ahora

URL:

https://tu-dominio/api/escuchar-cambios

(la ruta filtra por propertyName=facturar_ahora; no existe /api/facturar-ahora)

Nota: el disparo "facturar ahora" desde line item fue ELIMINADO en 2026-07 (control de cambios N°5). El router responde 200 "skipped" a eventos de line item; la suscripción del webhook de line item y la propiedad en las vistas del CRM ya fueron retiradas. La facturación urgente se dispara únicamente desde el TICKET.

🧪 Testing e Idempotencia

Clave única de ticket y factura:

<dealId>::LIK:<lineItemKey>::<fechaYMD>   (of_ticket_key, ver src/utils/ticketKey.js)


Ejecutar dos veces no crea duplicados.

📝 Decisiones Clave

El Deal no define responsables

El Line Item define el responsable

El Ticket es la única fuente editable post-creación

Ediciones en Line Item con ticket existente solo afectan fechas futuras

El consumo de cupo ocurre solo al emitir factura

📄 Licencia

ISC

Versión: 2.0.0
Última actualización: 2026-01