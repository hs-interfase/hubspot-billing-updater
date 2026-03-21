# Resumen de Implementación - Property Fixes & Robustness
22/02/2026 -- Tiene algunas cosas que no fueron actualizadas. como line item key. fuente nueva de idempotencialidad que se integra en tickets y facturas
## Cambios Implementados

### A) Deal: cupo_estado actualizado automáticamente

**Archivos modificados:**
- `src/phases/phase1.js` (función `activateCupoIfNeeded`)
- `src/services/cupo/consumeCupo.js` (después de consumir cupo)

**Lógica:**
```javascript
// Reglas de cupo_estado:
- cupo_activo=false OR cupo_restante <= 0 → "SIN_CUPO"
- cupo_restante <= cupo_umbral → "BAJO_UMBRAL"  
- cupo_restante > cupo_umbral → "OK"
```

**Prevención de updates vacíos:**
- Solo actualiza si el valor cambió (`newCupoEstado !== currentCupoEstado`)
- Logs claros: `cupo_estado: (null) → OK`

---

### B) Ticket: fecha_esperada_de_resolucion desde billDateYMD

**Archivos modificados:**
- `src/services/snapshotService.js` (función `createTicketSnapshots`)

**Cambios:**
1. **fecha_de_resolucion_esperada**: Convertida a timestamp ms usando `toHubSpotDateOnly(billDateYMD)`
2. **of_fecha_de_facturacion**: Solo se setea cuando aplica (urgente), convertida a timestamp ms

**Formato:**
```javascript
// ANTES (❌):
fecha_de_resolucion_esperada: "2026-01-14"  // String

// DESPUÉS (✅):
fecha_de_resolucion_esperada: 1736812800000  // timestamp ms (midnight UTC)
```

**Propiedades NO existentes:**
- Si una propiedad no existe en el schema de HubSpot, se loguea `MISSING_PROPERTY` y se continúa sin error

---

### C) Invoice: propiedades corregidas y defaults mejorados

**Archivos modificados:**
- `src/services/invoiceService.js` (funciones `createAutoInvoiceFromLineItem` y `createInvoiceFromTicket`)

**C.1) Nombre de Invoice mejorado:**
```javascript
// Formato: "<DealName> - <li_short> - <billDateYMD>"
hs_title: "Acme Corp - Hosting Mensual - 2026-01-14"
```

**C.2) createdate NO se toca:**
- HubSpot lo setea automáticamente
- No incluido en el payload de creación

**C.3) Monto total facturado calculado:**
```javascript
// Cálculo con descuentos e IVA:
1. Base = quantity × price
2. Aplicar descuento (% o $)
3. Aplicar IVA (22% si hs_tax_rate_group_id === '16912720')
4. Guardar en: of_monto_total_facturado

// Validación NaN:
if (isNaN(totalWithTax)) {
  console.error('❌ ERROR_CALC_TOTAL');
  // NO setea el campo
}
```

**C.4) Fecha de vencimiento:**
```javascript
// billDate (from of_fecha_de_facturacion or billDateYMD) + 10 días
hs_due_date: toHubSpotDateOnly(dueDateYMD)
```

---

### D) Robustez: evitar updates vacíos y logging mejorado

**Nuevo archivo:**
- `src/utils/propertyHelpers.js`

**Funciones agregadas:**

1. **`buildUpdateProps(props)`**
   - Remueve: `null`, `undefined`, `""`, `NaN`
   - Retorna `{}` si no queda nada

2. **`getPropertySchema(objectType)`**
   - Cache de schemas de HubSpot
   - Evita múltiples llamadas API
   - Tipos: `'deals'`, `'tickets'`, `'invoices'`, `'line_items'`

3. **`validateProperties(objectType, props)`**
   - Separa propiedades válidas vs missing
   - Retorna: `{ valid: {}, missing: [] }`

4. **`buildValidatedUpdateProps(objectType, props, options)`**
   - Combina limpieza + validación
   - Logs automáticos:
     - `SET_PROPS (invoices): hs_title, hs_currency, of_invoice_key`
     - `MISSING_PROPS (invoices): campo_inexistente`
     - `SKIP_EMPTY_UPDATE` si no hay nada válido

5. **`calculateCupoEstado(dealProps)`**
   - Centraliza lógica de estado de cupo
   - Usado en Phase1 y consumeCupo

**Ejemplo de uso:**
```javascript
const validatedProps = await buildValidatedUpdateProps('invoices', invoiceProps, {
  logPrefix: '[createAutoInvoice]'
});

if (Object.keys(validatedProps).length === 0) {
  console.log('SKIP_EMPTY_UPDATE');
  return;
}
```

---

### E) Validación de existencia de propiedades (schema check)

**Implementado en:**
- `src/utils/propertyHelpers.js`

**Cómo funciona:**
1. Primera llamada: fetch schema desde HubSpot API
2. Cachea en memoria (`schemaCache Map`)
3. Llamadas subsiguientes: usa cache
4. Propiedades inexistentes: se logean pero NO rompen el flujo

**Logs generados:**
```
[PropertySchema] Fetching schema for invoices...
[PropertySchema] ✅ Cached 47 properties for invoices

[createAutoInvoice] ⚠️ MISSING_PROPS (invoices): campo_custom_viejo
[createAutoInvoice] ✅ SET_PROPS (invoices): hs_title, hs_currency, hs_due_date, of_invoice_key
```

---

## Archivos Modificados

### Nuevos archivos:
1. `src/utils/propertyHelpers.js` - Helpers de validación y limpieza

### Archivos modificados:
1. `src/phases/phase1.js` - Actualiza `cupo_estado` al activar/inicializar cupo
2. `src/services/cupo/consumeCupo.js` - Actualiza `cupo_estado` al consumir cupo
3. `src/services/snapshotService.js` - Convierte fechas a timestamp ms
4. `src/services/invoiceService.js` - Mejora propiedades, cálculo de totales, validación
5. `IMPLEMENTATION_SUMMARY.md` - Este archivo

---

## Logs Agregados

### Deal (cupo_estado):
```
[cupo:activate] cupo_estado: (null) → OK
[cupo:activate] Updating deal 123 with: cupo_activo, cupo_restante, cupo_estado
[consumeCupo] 📊 cupo_estado → BAJO_UMBRAL
```

### Ticket (fechas):
```
[ticketService] 🔍 AUTO - fecha_de_resolucion_esperada: 1736812800000
[ticketService] 🔍 AUTO - of_fecha_de_facturacion: 1736899200000
```

### Invoice (validación y cálculo):
```
💰 Cálculo de monto total:
   Cantidad: 10
   Precio unitario: 100
   Base (qty × price): 1000
   Descuento %: 10
   Después de descuento: 900
   IVA aplicado: 22%
   ✅ TOTAL FINAL: 1098

📋 Invoice metadata:
   hs_title: Acme Corp - Hosting Mensual - 2026-01-14
   hs_invoice_date: 2026-01-14
   hs_due_date: 2026-01-24 (+10 días)

[createAutoInvoice] ✅ SET_PROPS (invoices): hs_title, hs_currency, hs_due_date, of_invoice_key, of_monto_total_facturado
[createAutoInvoice] ⚠️ MISSING_PROPS (invoices): campo_custom_obsoleto
```

### Property Validation:
```
[PropertySchema] Fetching schema for tickets...
[PropertySchema] ✅ Cached 89 properties for tickets
[createTicket] ✅ SET_PROPS (tickets): subject, of_ticket_key, fecha_de_resolucion_esperada
[createTicket] ⊘ SKIP_EMPTY_UPDATE - No properties to set
```

---

## Testing

### Tests manuales recomendados:

1. **Deal con cupo:**
   ```bash
   node src/runBilling.js --deal <DEAL_ID>
   # Verificar logs: cupo_estado actualizado
   ```

2. **Ticket creation:**
   ```bash
   # Verificar en logs:
   # - fecha_de_resolucion_esperada es timestamp ms
   # - of_fecha_de_facturacion solo aparece si facturar_ahora=true
   ```

3. **Invoice creation:**
   ```bash
   # Verificar en HubSpot:
   # - hs_title tiene formato correcto
   # - hs_due_date = fecha esperada + 10 días
   # - of_monto_total_facturado está calculado
   ```

4. **Property validation:**
   ```bash
   # Agregar temporalmente una propiedad inexistente en el código
   # Verificar que se loguea MISSING_PROPS pero no falla
   ```

---

## Restricciones Respetadas

✅ **NO refactor general** - Solo cambios mínimos en funciones específicas  
✅ **NO cambios en formato de keys** - `of_ticket_key` y `of_invoice_key` intactos  
✅ **NO cambios en idempotencia** - Solo mejorados los logs  
✅ **NO cambios en flujo de fases** - Solo mapping de props + defaults  
✅ **NO rename/move** - Archivos y carpetas en su lugar original  

---

## TODOs identificados

```javascript
// TODO: Para generar "Flota N" en invoice title, necesitamos 
// el índice del LI en el deal. Por ahora usa fallback simple.
liShort = `Line Item ${lineItemId}`;
```

---

## Próximos pasos

1. **Monitorear logs** en producción para verificar:
   - No más `SKIP_EMPTY_UPDATE` inesperados
   - `MISSING_PROPS` solo para campos legacy/deprecados
   - `cupo_estado` transiciona correctamente

2. **Ajustar schemas** si aparecen propiedades faltantes recurrentes

3. **Documentar propiedades custom** en portal de HubSpot

---

**Fecha de implementación:** 2026-01-14  
**Desarrollador:** GitHub Copilot (Claude Sonnet 4.5)
