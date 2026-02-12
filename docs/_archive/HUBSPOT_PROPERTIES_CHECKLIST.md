# ✅ CHECKLIST DE PROPIEDADES HUBSPOT

Este documento lista todas las propiedades custom que deben existir en tu portal de HubSpot para que el sistema funcione correctamente.

## 📊 ESTADO DE PROPIEDADES

**Leyenda:**
- ✅ = Ya existe (confirmado por ti)
- ⚠️ = Debe verificarse si existe
- ❌ = Debe crearse

---

## 1. LINE ITEM (Partida)

### Tracking de Facturas (NUEVAS - CREAR)

| Propiedad | Tipo | Estado | Descripción |
|-----------|------|--------|-------------|
| `of_invoice_id` | Text | ❌ | ID de la factura emitida (idempotencia) |
| `of_invoice_key` | Text | ❌ | Clave única de factura (dealId::lineItemId::fecha) |
| `of_invoice_status` | Text/Enum | ❌ | Estado de factura (draft, open, paid, cancelled) |

**Instrucciones de creación:**
1. Ir a Settings → Properties → Line Items
2. Crear cada propiedad como "Single-line text"
3. Marcar como "Field type: Text"
4. No marcar como "Required"

### Snapshots (VERIFICAR - pueden ya existir)

| Propiedad | Tipo | Estado | Descripción |
|-----------|------|--------|-------------|
| `precio_hora_snapshot` | Number | ⚠️ | Precio por hora al momento de facturar |
| `horas_previstas_snapshot` | Number | ⚠️ | Horas previstas al momento de facturar |
| `monto_original_snapshot` | Number | ⚠️ | Monto total original (precio × cantidad) |

**Instrucciones de creación (si no existen):**
1. Ir a Settings → Properties → Line Items
2. Crear como "Number"
3. Field type: "Unformatted number" (o "Currency" para monto_original_snapshot)

---

## 2. TICKET (Orden de Facturación)

### Idempotencia (NUEVA - CREAR)

| Propiedad | Tipo | Estado | Descripción |
|-----------|------|--------|-------------|
| `of_ticket_key` | Text | ❌ | Clave única de ticket (dealId::lineItemId::fecha) |

**Instrucciones de creación:**
1. Ir a Settings → Properties → Tickets
2. Crear como "Single-line text"
3. Marcar como "Unique" si está disponible

### Snapshots para Tickets (VERIFICAR - pueden ya existir)

| Propiedad | Tipo | Estado | Descripción |
|-----------|------|--------|-------------|
| `precio_hora_snapshot` | Number | ⚠️ | Precio por hora copiado del line item |
| `horas_previstas_snapshot` | Number | ⚠️ | Horas previstas copiadas del line item |
| `monto_original_snapshot` | Number | ⚠️ | Monto original (precio × horas) |
| `of_producto_nombres` | Text | ⚠️ | Nombre del producto/servicio |
| `of_pais_operativo` | Text | ⚠️ | País operativo (UY, PY, MIXTO) |
| `of_rubro` | Text | ⚠️ | Rubro del negocio |
| `of_aplica_cupo` | Boolean | ⚠️ | Si este item aplica para cupo |

**Instrucciones de creación (si no existen):**
1. Ir a Settings → Properties → Tickets
2. Crear snapshots numéricos como "Number"
3. Crear texto como "Single-line text"
4. Crear `of_aplica_cupo` como "Single checkbox"

---

## 3. INVOICE (Factura)

### Tracking Custom (NUEVAS - CREAR)

| Propiedad | Tipo | Estado | Descripción |
|-----------|------|--------|-------------|
| `of_invoice_key` | Text | ❌ | Clave única de factura (idempotencia) |
| `of_invoice_status` | Dropdown | ❌ | Estado: draft, open, paid, cancelled |

**Instrucciones de creación:**
1. Ir a Settings → Properties → Invoices
2. `of_invoice_key`: crear como "Single-line text"
3. `of_invoice_status`: crear como "Dropdown select"
   - Opciones: draft, open, paid, cancelled
   - Valor por defecto: draft

---

## 4. VERIFICACIÓN RÁPIDA

### Comando para verificar en código:

```javascript
// Ejecutar esto en node para ver propiedades de un line item real
import { hubspotClient } from './src/hubspotClient.js';

const lineItemId = 'TU_LINE_ITEM_ID';
const li = await hubspotClient.crm.lineItems.basicApi.getById(
  lineItemId,
  ['of_invoice_id', 'of_invoice_key', 'of_invoice_status', 'precio_hora_snapshot']
);

console.log('Propiedades encontradas:', Object.keys(li.properties));
```

---

## 5. CONFIGURACIÓN DE PIPELINE DE TICKETS

### Verificar/Ajustar en `src/config/constants.js`

```javascript
// Ajustar según tu portal:
export const TICKET_PIPELINE = '0'; // ID de tu pipeline de tickets
export const TICKET_STAGES = {
  NEW: '1',           // Nueva orden de facturación
  IN_REVIEW: '2',     // En revisión
  READY: '3',         // Lista para facturar
  INVOICED: '4',      // Facturada
  CANCELLED: '999',   // Cancelada
};
```

**Cómo obtener IDs reales:**
1. Ir a Settings → Objects → Tickets → Pipelines
2. Click en tu pipeline de "Orden de Facturación"
3. Anotar el ID del pipeline (aparece en la URL)
4. Anotar los IDs de cada stage

---

## 6. WEBHOOK CONFIGURATION

### Configurar en HubSpot:

1. **Ir a:** Settings → Integrations → Private Apps (o Webhooks)
2. **Crear webhook:**
   - Event Type: **Property Change**
   - Object: **Line Item**
   - Property: **facturar_ahora**
   - Webhook URL: `https://TU-DOMINIO.vercel.app/api/facturar-ahora`
   - Method: **POST**
   - Authentication: None (o agregar token si es necesario)

3. **Activar webhook**

4. **Testing:**
   ```bash
   # En un line item de prueba, cambiar manualmente:
   facturar_ahora = true
   
   # Verificar logs en Vercel:
   vercel logs --follow
   ```

---

## 7. RESUMEN DE TAREAS

### Propiedades a CREAR (obligatorias):
- [ ] Line Item: `of_invoice_id`, `of_invoice_key`, `of_invoice_status`
- [ ] Ticket: `of_ticket_key`
- [ ] Invoice: `of_invoice_key`, `of_invoice_status`

### Propiedades a VERIFICAR (recomendadas):
- [ ] Line Item: snapshots (precio_hora_snapshot, horas_previstas_snapshot, monto_original_snapshot)
- [ ] Ticket: snapshots (mismo conjunto + of_producto_nombres, of_pais_operativo, of_rubro, of_aplica_cupo)

### Configuración:
- [ ] Ajustar IDs de pipeline/stages en `src/config/constants.js`
- [ ] Configurar webhook `facturar_ahora` en HubSpot
- [ ] Desplegar `api/facturar-ahora.js` en Vercel (si no está ya)

### Testing:
- [ ] Ejecutar en DRY_RUN mode: `DRY_RUN=true node src/runBilling.js --deal <ID>`
- [ ] Verificar que NO se crean duplicados (idempotencia)
- [ ] Probar webhook manualmente cambiando `facturar_ahora=true`

---

**Fecha:** 2025-12-25  
**Versión:** 2.0.0
