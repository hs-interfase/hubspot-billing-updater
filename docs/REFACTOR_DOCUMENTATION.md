# 📚 DOCUMENTACIÓN COMPLETA - REFACTOR HUBSPOT BILLING UPDATER

## 1. ESTRUCTURA DE CARPETAS Y ARCHIVOS

```
src/
├── runBilling.js                    # CLI principal (orquestador)
├── hubspotClient.js                  # Cliente HubSpot + getDealWithLineItems
│
├── config/
│   └── constants.js                  # Constantes (lookahead 30 días, pipelines, etc.)
│
├── phases/
│   ├── index.js                      # Exporta runPhasesForDeal (orquestador de fases)
│   ├── phase1.js                     # Fechas, calendario, cupo (EXISTENTE, ajustado)
│   ├── phase2.js                     # Tickets manuales (facturacion_automatica=false) ✨ NUEVO
│   └── phase3.js                     # Facturas automáticas (facturacion_automatica=true) ✨ NUEVO
│
├── services/
│   ├── invoiceService.js             # Creación de facturas con idempotencia ✨ NUEVO
│   ├── ticketService.js              # Creación de tickets con idempotencia ✨ NUEVO
│   └── snapshotService.js            # Copiar datos Deal/LineItem → Ticket ✨ NUEVO
│
├── utils/
│   ├── dateUtils.js                  # Helpers de fechas (parseLocalDate, formatDateISO, diffDays) ✨ NUEVO
│   ├── parsers.js                    # parseBool, parseNumber, safeString ✨ NUEVO
│   └── idempotency.js                # Generación de keys únicas (ticket_key, invoice_key) ✨ NUEVO
│
├── billingEngine.js                  # Lógica de fechas/frecuencias (EXISTENTE)
├── cupo.js                           # Cálculo de cupo (EXISTENTE)
├── dealMirroring.js                  # Mirrors UY/PY (EXISTENTE)
├── invoices.js                       # Legacy invoice handling (EXISTENTE, puede deprecarse)
└── tickets.js                        # Legacy ticket handling (EXISTENTE, puede deprecarse)

api/
├── update-billing.js                 # Endpoint Vercel (EXISTENTE)
└── facturar-ahora.js                 # Webhook para disparar facturación inmediata ✨ NUEVO
```

---

## 2. FUNCIONES POR ARCHIVO

### **src/phases/index.js**
Orquestador principal de las 3 fases.

**Funciones:**
- `runPhasesForDeal({ deal, lineItems })`: Ejecuta Phase 1, 2 y 3 secuencialmente
  - **Input:** Deal object, array de Line Items
  - **Output:** `{ dealId, ticketsCreated, autoInvoicesEmitted, phase1, phase2, phase3 }`

---

### **src/phases/phase1.js** (EXISTENTE, AJUSTADO)
Actualiza fechas, calendario interno y cupo del deal.

**Funciones:**
- `runPhase1(dealId)`: Ejecuta toda la lógica de Phase 1
  - Calcula próximas fechas de facturación
  - Actualiza contadores de avisos
  - Actualiza cupo del deal
  - Sincroniza mirrors UY/PY
  - **Input:** dealId (string)
  - **Output:** void (efectos secundarios en HubSpot)

**Cambios aplicados:**
- ✅ Eliminada referencia a `bagEngine.js` (bolsa de horas)
- ✅ Mantiene toda la lógica existente de fechas y cupo

---

### **src/phases/phase2.js** ✨ NUEVO
Generación de tickets manuales con lookahead de 30 días.

**Funciones:**
- `runPhase2({ deal, lineItems })`: Crea tickets para line items con facturacion_automatica=false
  - Filtra line items elegibles (facturacion_activa=true && facturacion_automatica=false)
  - Obtiene próxima fecha de facturación
  - Si está dentro de 30 días, crea ticket (con idempotencia)
  - **Input:** Deal object, array de Line Items
  - **Output:** `{ ticketsCreated, errors }`

- `getNextBillingDate(lineItemProps)`: Helper para obtener próxima fecha
  - Busca en `hs_recurring_billing_start_date`, `fecha_inicio_de_facturacion`, y fechas extras (fecha_2...fecha_24)
  - **Input:** Line Item properties
  - **Output:** string YYYY-MM-DD o null

---

### **src/phases/phase3.js** ✨ NUEVO
Emisión de facturas automáticas cuando toca facturar.

**Funciones:**
- `runPhase3({ deal, lineItems })`: Emite facturas para line items con facturacion_automatica=true
  - Filtra line items elegibles (facturacion_activa=true && facturacion_automatica=true)
  - Verifica si hoy es día de facturación O si tiene `facturar_ahora=true`
  - Emite factura automática (con idempotencia)
  - Resetea flag `facturar_ahora` después de procesar
  - **Input:** Deal object, array de Line Items
  - **Output:** `{ invoicesEmitted, errors }`

- `getNextBillingDate(lineItemProps)`: Helper (igual que Phase 2)
- `resetFacturarAhoraFlag(lineItemId)`: Resetea flag después de facturar

---

### **src/services/ticketService.js** ✨ NUEVO
Servicio de creación y gestión de tickets.

**Funciones:**
- `createManualBillingTicket(deal, lineItem, billingDate)`: Crea ticket de orden de facturación
  - Genera `of_ticket_key` única para idempotencia
  - Busca ticket existente antes de crear
  - Copia snapshots del Deal y Line Item al Ticket
  - Asocia ticket al Deal
  - **Input:** Deal object, Line Item object, billingDate (YYYY-MM-DD)
  - **Output:** `{ ticketId, created }` (created=true si se creó nuevo)

- `updateTicket(ticketId, properties)`: Actualiza propiedades de un ticket
  - **Input:** ticketId (string), properties (object)
  - **Output:** void

- `findTicketByKey(ticketKey)` (privado): Busca ticket por of_ticket_key
  - **Input:** ticketKey (string)
  - **Output:** Ticket object o null

---

### **src/services/invoiceService.js** ✨ NUEVO
Servicio de creación de facturas.

**Funciones:**
- `createAutoInvoiceFromLineItem(deal, lineItem, billingDate)`: Crea factura automática
  - Verifica si ya existe factura (por `of_invoice_id` en line item o por `of_invoice_key`)
  - Calcula monto (quantity × price)
  - Crea factura en HubSpot
  - Asocia a Deal, Line Item y Contacto
  - Actualiza line item con referencia a factura
  - **Input:** Deal object, Line Item object, billingDate (YYYY-MM-DD)
  - **Output:** `{ invoiceId, created }`

- `createInvoiceFromTicket(ticket)`: Crea factura desde ticket manual (legacy/opcional)
  - Similar a createAutoInvoiceFromLineItem pero desde Ticket
  - **Input:** Ticket object
  - **Output:** `{ invoiceId, created }`

- `findInvoiceByKey(invoiceKey)` (privado): Busca factura por of_invoice_key
  - **Input:** invoiceKey (string)
  - **Output:** Invoice object o null

---

### **src/services/snapshotService.js** ✨ NUEVO
Crea snapshots inmutables de datos para Tickets.

**Funciones:**
- `extractLineItemSnapshots(lineItem)`: Extrae datos clave del Line Item
  - **Input:** Line Item object
  - **Output:** `{ precio_hora_snapshot, horas_previstas_snapshot, monto_original_snapshot, of_producto_nombres }`

- `extractDealSnapshots(deal)`: Extrae datos clave del Deal
  - **Input:** Deal object
  - **Output:** `{ of_moneda, of_pais_operativo, of_rubro, responsable_asignado }`

- `createTicketSnapshots(deal, lineItem, billingDate)`: Combina snapshots para Ticket
  - **Input:** Deal object, Line Item object, billingDate (YYYY-MM-DD)
  - **Output:** Object con todos los snapshots combinados

---

### **src/utils/dateUtils.js** ✨ NUEVO
Utilidades para trabajar con fechas en formato YYYY-MM-DD.

**Funciones:**
- `parseLocalDate(raw)`: Parsea string o timestamp a Date
- `formatDateISO(date)`: Formatea Date a YYYY-MM-DD
- `isYMD(str)`: Valida formato YYYY-MM-DD
- `addMonths(date, months)`: Suma meses a una fecha
- `addDays(date, days)`: Suma días a una fecha
- `compareDates(a, b)`: Compara dos fechas
- `getTodayYMD()`: Devuelve hoy en YYYY-MM-DD
- `diffDays(dateA, dateB)`: Diferencia en días entre dos fechas

---

### **src/utils/parsers.js** ✨ NUEVO
Helpers de parsing.

**Funciones:**
- `parseBool(raw)`: Parsea booleanos de HubSpot (true, 1, sí, si, yes)
- `parseNumber(raw, defaultValue)`: Parsea números de forma segura
- `safeString(raw)`: Convierte a string seguro

---

### **src/utils/idempotency.js** ✨ NUEVO
Generación de claves únicas para evitar duplicados.

**Funciones:**
- `generateTicketKey(dealId, lineItemId, billingDate)`: Genera key única para ticket
  - Formato: `<dealId>::<lineItemId>::<billingDate>`
- `generateInvoiceKey(dealId, lineItemId, billingDate)`: Genera key única para factura
  - Formato: `<dealId>::<lineItemId>::<billingDate>`

---

### **src/config/constants.js** ✨ NUEVO
Constantes globales del proyecto.

**Constantes:**
- `MANUAL_TICKET_LOOKAHEAD_DAYS = 30`: Días de anticipación para tickets manuales
- `TICKET_PIPELINE`: ID del pipeline de tickets
- `TICKET_STAGES`: Stages del pipeline (NEW, IN_REVIEW, READY, INVOICED, CANCELLED)
- `DEFAULT_CURRENCY = 'USD'`: Moneda por defecto
- `isDryRun()`: Helper para verificar modo DRY_RUN

---

### **api/facturar-ahora.js** ✨ NUEVO
Webhook para HubSpot que dispara facturación inmediata.

**Funciones:**
- `handler(req, res)`: Handler principal del webhook
  - Recibe webhook de HubSpot cuando cambia `facturar_ahora` en un line item
  - Valida payload
  - Obtiene line item y deal
  - Ejecuta Phase 3 solo para ese line item
  - **Input:** req (request), res (response)
  - **Output:** JSON response `{ success, lineItemId, invoicesEmitted, errors }`

**Configuración en HubSpot:**
- Tipo: Property Change
- Objeto: Line Item
- Propiedad: facturar_ahora
- URL: `https://tu-dominio.vercel.app/api/facturar-ahora`
- Método: POST

---

## 3. REGLAS DE IDEMPOTENCIA

### **Tickets (Phase 2)**
- **Clave única:** `of_ticket_key = <dealId>::<lineItemId>::<billingDate>`
- **Verificación:** Antes de crear ticket, se busca por `of_ticket_key` en HubSpot
- **Resultado:** Si existe, se retorna el ticket existente (no se crea duplicado)

### **Facturas (Phase 3)**
- **Clave única:** `of_invoice_key = <dealId>::<lineItemId>::<billingDate>`
- **Verificación doble:**
  1. Se verifica si el line item ya tiene `of_invoice_id` (referencia directa)
  2. Se busca factura por `of_invoice_key` en HubSpot
- **Resultado:** Si existe, se retorna la factura existente (no se crea duplicado)

### **DRY RUN Mode**
- Variable de entorno: `DRY_RUN=true`
- Cuando está activo, NO se crean recursos reales en HubSpot
- Útil para testing y validación sin afectar datos de producción

---

## 4. PROPIEDADES DE HUBSPOT NECESARIAS

### **Deal (Negocio)**

#### Facturación (existentes)
- ✅ `facturacion_activa` (boolean)
- ✅ `facturacion_frecuencia_de_facturacion` (text/enum)
- ✅ `facturacion_proxima_fecha` (date)
- ✅ `facturacion_ultima_fecha` (date)

#### Cupo (existentes)
- ✅ `tipo_de_cupo` (enum: HORAS | MONTO)
- ✅ `cupo_total` (number)
- ✅ `cupo_total_horas` (number)
- ✅ `cupo_total_monto` (number)
- ✅ `cupo_consumido` (number)
- ✅ `cupo_restante` (number)

#### Responsables (existentes)
- ✅ `responsable_asignado` (user)
- ✅ `pais_operativo` (enum)
- ✅ `deal_currency_code` (text)

---

### **Line Item**

#### Estándar HubSpot (existentes)
- ✅ `name` (text)
- ✅ `price` (number)
- ✅ `quantity` (number)
- ✅ `hs_recurring_billing_start_date` (date)
- ✅ `hs_recurring_billing_frequency` (enum)

#### Facturación v2 (existentes)
- ✅ `facturacion_activa` (boolean)
- ✅ `facturacion_automatica` (boolean) - **CLAVE para Phase 2/3**
- ✅ `facturar_ahora` (boolean) - **Disparo inmediato**

#### Cupo (existentes)
- ✅ `parte_del_cupo` (boolean)

#### Snapshots (recomendados, verificar existencia)
- ⚠️ `precio_hora_snapshot` (number) - **CREAR SI NO EXISTE**
- ⚠️ `horas_previstas_snapshot` (number) - **CREAR SI NO EXISTE**
- ⚠️ `monto_original_snapshot` (number) - **CREAR SI NO EXISTE**

#### Invoice tracking (nuevas, CREAR)
- ❌ `of_invoice_id` (text) - **CREAR**
- ❌ `of_invoice_key` (text) - **CREAR**
- ❌ `of_invoice_status` (text/enum) - **CREAR**

---

### **Ticket (Orden de Facturación)**

#### Identificación/relación (existentes)
- ✅ `of_deal_id` (text)
- ✅ `of_line_item_ids` (text)

#### Ticket key (nueva, CREAR)
- ❌ `of_ticket_key` (text) - **CREAR** (para idempotencia)

#### Datos de facturación (existentes)
- ✅ `of_fecha_de_facturacion` (date)
- ✅ `of_moneda` (text/enum)
- ✅ `monto_real_a_facturar` (number)
- ✅ `responsable_asignado` (user)

#### Snapshots (recomendados, verificar existencia)
- ⚠️ `precio_hora_snapshot` (number) - **CREAR SI NO EXISTE**
- ⚠️ `horas_previstas_snapshot` (number) - **CREAR SI NO EXISTE**
- ⚠️ `monto_original_snapshot` (number) - **CREAR SI NO EXISTE**
- ⚠️ `of_producto_nombres` (text) - **CREAR SI NO EXISTE**
- ⚠️ `of_pais_operativo` (text) - **CREAR SI NO EXISTE**
- ⚠️ `of_rubro` (text) - **CREAR SI NO EXISTE**
- ⚠️ `of_aplica_cupo` (boolean) - **CREAR SI NO EXISTE**

#### Invoice tracking (existentes)
- ✅ `of_invoice_id` (text)
- ✅ `of_invoice_key` (text)
- ✅ `of_invoice_status` (text/enum)
- ✅ `of_invoice_url` (text)

---

### **Invoice (Factura)**

#### Propiedades estándar HubSpot
- Nativas de HubSpot (no requieren creación)

#### Tracking custom (nuevas, CREAR)
- ❌ `of_invoice_key` (text) - **CREAR** (para idempotencia)
- ❌ `of_invoice_status` (text/enum) - **CREAR** (draft, open, paid, cancelled)

---

## 5. CONFIGURACIÓN DEL WEBHOOK `facturar_ahora`

### **Configuración en HubSpot**

1. **Navegar a:** Settings → Integrations → Webhooks
2. **Crear nuevo webhook:**
   - **Tipo:** Property Change
   - **Objeto:** Line Item
   - **Propiedad:** `facturar_ahora`
   - **URL:** `https://TU-DOMINIO.vercel.app/api/facturar-ahora`
   - **Método:** POST
   - **Authentication:** None (o agregar token si es necesario)

### **Payload esperado (HubSpot envía)**
```json
[
  {
    "objectId": "12345",
    "propertyName": "facturar_ahora",
    "propertyValue": "true",
    "changeSource": "CRM",
    "eventId": "evt_...",
    "subscriptionId": "sub_...",
    "portalId": 123456,
    "occurredAt": 1234567890
  }
]
```

### **Validaciones en el webhook**
1. ✅ Verifica que sea método POST
2. ✅ Valida `objectId` (line item ID)
3. ✅ Valida que `propertyName === 'facturar_ahora'`
4. ✅ Valida que `propertyValue === true`
5. ✅ Verifica que el line item tenga `facturacion_activa=true`
6. ✅ Verifica que el line item tenga `facturacion_automatica=true`
7. ✅ Verifica que NO exista factura previa (`of_invoice_id`)

### **Flujo del webhook**
1. Recibe webhook de HubSpot
2. Obtiene line item completo
3. Valida elegibilidad
4. Obtiene deal asociado
5. Ejecuta Phase 3 solo para ese line item
6. Emite factura automática
7. Resetea flag `facturar_ahora=false`
8. Devuelve respuesta JSON

---

## 6. CAMBIOS MÍNIMOS A PHASE 1

### **Cambios aplicados:**

1. ✅ **Eliminada dependencia de `bagEngine.js`**
   - Removida línea: `import { updateBagFieldsForLineItem } from '../bagEngine.js';`
   - Removido bloque de código que llamaba a `updateBagFieldsForLineItem(li)`
   
2. ✅ **Mantenida toda la lógica existente:**
   - Cálculo de fechas (próxima/última)
   - Contadores de avisos
   - Actualización de cupo
   - Mirrors UY/PY
   - Clasificación de flows (Irregular/Recurrente/Pago Único)

3. ✅ **Compatibilidad con Phase 2 y Phase 3:**
   - Phase 1 se ejecuta PRIMERO (actualiza fechas y cupo)
   - Phase 2 y Phase 3 usan las fechas ya calculadas por Phase 1
   - No hay conflictos entre fases

---

## 7. FLUJO COMPLETO DE EJECUCIÓN

### **Comando CLI:**
```bash
# Procesar un deal específico
node src/runBilling.js --deal 52474135167

# Procesar todos los deals
node src/runBilling.js --allDeals
```

### **Secuencia de ejecución:**

1. **`runBilling.js`** obtiene deal(s) y llama a `runPhasesForDeal`
2. **Phase 1** ejecuta:
   - Actualiza fechas de facturación
   - Calcula contadores de avisos
   - Actualiza cupo del deal
   - Sincroniza mirrors (si aplica)
3. **Phase 2** ejecuta:
   - Filtra line items con `facturacion_automatica=false`
   - Busca próximas fechas dentro de 30 días
   - Crea tickets manuales (con idempotencia)
4. **Phase 3** ejecuta:
   - Filtra line items con `facturacion_automatica=true`
   - Verifica si hoy es día de facturación O si `facturar_ahora=true`
   - Emite facturas automáticas (con idempotencia)
5. **Resumen:** Retorna totales de tickets y facturas creadas

---

## 8. TESTING Y VALIDACIÓN

### **Modo DRY RUN (recomendado para testing)**
```bash
DRY_RUN=true node src/runBilling.js --deal 52474135167
```
- NO crea tickets ni facturas reales
- Muestra logs de lo que HARÍA
- Útil para validar lógica sin afectar HubSpot

### **Casos de prueba sugeridos:**

1. ✅ Deal con mezcla de line items (algunos auto, algunos manuales)
2. ✅ Line item con `facturar_ahora=true` (webhook)
3. ✅ Line item con fecha dentro de 30 días (debe crear ticket)
4. ✅ Line item con fecha hoy (debe crear factura)
5. ✅ Idempotencia: ejecutar 2 veces, verificar que no duplique
6. ✅ Deal sin line items activos (debe pasar sin errores)

---

## 9. PRÓXIMOS PASOS

### **Antes de producción:**
1. ❌ **Crear propiedades faltantes en HubSpot** (ver sección 4)
2. ❌ **Configurar webhook en HubSpot** (ver sección 5)
3. ❌ **Ajustar TICKET_PIPELINE y TICKET_STAGES** en [constants.js](src/config/constants.js) según tu portal
4. ❌ **Testing en DRY_RUN mode** con deals reales
5. ❌ **Validar snapshots** (verificar que se copien correctamente a tickets)

### **Opcionales/mejoras futuras:**
- 📋 Dashboard de monitoreo (tickets pendientes, facturas emitidas)
- 📋 Notificaciones por email cuando se crea ticket/factura
- 📋 Logs estructurados (JSON) para mejor debugging
- 📋 Job scheduler automatizado (cron job diario)

---

## 10. RESUMEN EJECUTIVO

### ✅ **Lo que se mantiene igual:**
- Phase 1 (fechas, calendario, cupo) - **Sin cambios mayores**
- runBilling.js (CLI) - **Compatible**
- hubspotClient.js - **Sin cambios**
- billingEngine.js, cupo.js, dealMirroring.js - **Sin cambios**

### ✨ **Lo que es NUEVO:**
- **Phase 2:** Tickets manuales con lookahead 30 días
- **Phase 3:** Facturas automáticas basadas en `facturacion_automatica`
- **Servicios:** ticketService, invoiceService, snapshotService
- **Utils:** dateUtils, parsers, idempotency
- **Webhook:** api/facturar-ahora.js

### 🗑️ **Lo que se elimina:**
- ❌ Referencia a `bagEngine.js` (bolsa de horas)

### 🎯 **Arquitectura final:**
- ✅ Modular y testeable
- ✅ Idempotencia garantizada
- ✅ Separación clara de responsabilidades
- ✅ Compatible con flujos mixtos (auto + manual)
- ✅ Extensible para futuras mejoras

---

**Fecha de refactor:** 2025-12-25
**Versión:** 2.0.0
