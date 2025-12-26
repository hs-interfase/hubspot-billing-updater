# 🚀 GUÍA DE MIGRACIÓN RÁPIDA

Esta guía te ayudará a poner en producción el nuevo sistema de facturación v2.0.

## ⏱️ Tiempo estimado: 30-45 minutos

---

## PASO 1: Crear Propiedades en HubSpot (15 min)

### Line Items

1. Ir a **Settings → Properties → Line Items → Create property**

2. Crear las siguientes propiedades:

| Nombre Interno | Label | Tipo | Descripción |
|----------------|-------|------|-------------|
| `of_invoice_id` | Invoice ID | Single-line text | ID de factura emitida |
| `of_invoice_key` | Invoice Key | Single-line text | Clave única (idempotencia) |
| `of_invoice_status` | Invoice Status | Single-line text | Estado: draft/open/paid |

### Tickets

1. Ir a **Settings → Properties → Tickets → Create property**

2. Crear:

| Nombre Interno | Label | Tipo | Descripción |
|----------------|-------|------|-------------|
| `of_ticket_key` | Ticket Key | Single-line text | Clave única (idempotencia) |

**Opcional (recomendado):** Si no existen, crear snapshots:
- `precio_hora_snapshot` (Number)
- `horas_previstas_snapshot` (Number)
- `monto_original_snapshot` (Number)
- `of_producto_nombres` (Single-line text)
- `of_pais_operativo` (Single-line text)
- `of_rubro` (Single-line text)
- `of_aplica_cupo` (Single checkbox)

### Invoices

1. Ir a **Settings → Properties → Invoices → Create property**

2. Crear:

| Nombre Interno | Label | Tipo | Opciones |
|----------------|-------|------|----------|
| `of_invoice_key` | Invoice Key | Single-line text | - |
| `of_invoice_status` | Invoice Status | Dropdown select | draft, open, paid, cancelled |

---

## PASO 2: Configurar Pipeline de Tickets (5 min)

1. Ir a **Settings → Objects → Tickets → Pipelines**

2. Identificar tu pipeline de "Orden de Facturación" (o crear uno nuevo)

3. Anotar los IDs:
   - **Pipeline ID:** (aparece en la URL)
   - **Stage IDs:** NEW, IN_REVIEW, READY, INVOICED, CANCELLED

4. Editar `src/config/constants.js`:

```javascript
export const TICKET_PIPELINE = 'TU_PIPELINE_ID';
export const TICKET_STAGES = {
  NEW: 'TU_STAGE_ID_1',
  IN_REVIEW: 'TU_STAGE_ID_2',
  READY: 'TU_STAGE_ID_3',
  INVOICED: 'TU_STAGE_ID_4',
  CANCELLED: 'TU_STAGE_ID_5',
};
```

---

## PASO 3: Configurar Webhook (10 min)

### Opción A: HubSpot Webhooks Subscription

1. Ir a **Settings → Integrations → Private Apps** (o Webhooks si tienes)

2. Si usas Private App:
   - Crear/editar tu app
   - Activar scope: `crm.objects.line_items.read`
   - Copiar token

3. Configurar webhook:
   - Event type: **Property Change**
   - Object: **Line Item**
   - Property: `facturar_ahora`
   - Webhook URL: `https://TU-DOMINIO.vercel.app/api/facturar-ahora`
   - Method: **POST**

### Opción B: Workflows (alternativa)

Si no tienes acceso a webhooks directos:

1. Crear workflow en HubSpot
2. Trigger: "Line Item property changed: facturar_ahora is true"
3. Action: "Send webhook" a tu endpoint Vercel

---

## PASO 4: Desplegar en Vercel (5 min)

### Si ya tienes el proyecto en Vercel:

```bash
# Commit los cambios nuevos
git add .
git commit -m "Refactor v2.0: sistema de facturación modular"
git push origin main

# Vercel desplegará automáticamente
```

### Si es primera vez:

```bash
# Instalar Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

### Configurar variables de entorno en Vercel:

1. Ir a tu proyecto en Vercel Dashboard
2. Settings → Environment Variables
3. Agregar:
   - `HUBSPOT_PRIVATE_TOKEN`: tu token de HubSpot
   - `DRY_RUN`: `false` (para producción)

---

## PASO 5: Testing Inicial (10 min)

### Test 1: DRY_RUN con un deal real

```bash
# Local (no afecta HubSpot)
DRY_RUN=true node src/runBilling.js --deal 52474135167
```

**Verificar en logs:**
- ✅ Phase 1 ejecutada sin errores
- ✅ Phase 2 detecta line items manuales
- ✅ Phase 3 detecta line items automáticos
- ✅ No se crean recursos reales (DRY_RUN)

### Test 2: Crear UN ticket manual (sin DRY_RUN)

1. En HubSpot, elegir un Line Item de prueba:
   - `facturacion_activa = true`
   - `facturacion_automatica = false`
   - `hs_recurring_billing_start_date = [fecha dentro de 30 días]`

2. Ejecutar:
```bash
node src/runBilling.js --deal <ID_DEL_DEAL>
```

3. **Verificar en HubSpot:**
   - Se creó 1 ticket nuevo
   - Tiene `of_ticket_key` populated
   - Tiene snapshots correctos (precio, horas, monto)
   - Está asociado al Deal

4. **Ejecutar de nuevo (idempotencia):**
```bash
node src/runBilling.js --deal <ID_DEL_DEAL>
```

5. **Verificar:**
   - NO se creó ticket duplicado
   - Logs muestran "Ticket ya existe"

### Test 3: Emitir UNA factura automática

1. En HubSpot, elegir un Line Item de prueba:
   - `facturacion_activa = true`
   - `facturacion_automatica = true`
   - `facturar_ahora = true` (disparo manual)

2. El webhook debería dispararse automáticamente

3. **Verificar en Vercel logs:**
```bash
vercel logs --follow
```

4. **Verificar en HubSpot:**
   - Se creó 1 factura (Invoice)
   - Line Item tiene `of_invoice_id` populated
   - Factura asociada a Deal y Line Item
   - `facturar_ahora` reseteado a `false`

---

## PASO 6: Programar Ejecución Automática (OPCIONAL)

### Opción A: Vercel Cron Jobs

Crear `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron-daily-billing",
      "schedule": "0 6 * * *"
    }
  ]
}
```

Crear `api/cron-daily-billing.js`:

```javascript
import { runBilling } from '../src/runBilling.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await runBilling({ allDeals: true });
    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('[cron] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

### Opción B: GitHub Actions

Crear `.github/workflows/daily-billing.yml`:

```yaml
name: Daily Billing Job

on:
  schedule:
    - cron: '0 6 * * *'  # 6 AM UTC diariamente
  workflow_dispatch:

jobs:
  billing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: node src/runBilling.js --allDeals
        env:
          HUBSPOT_PRIVATE_TOKEN: ${{ secrets.HUBSPOT_PRIVATE_TOKEN }}
```

---

## ✅ CHECKLIST FINAL

Antes de ir a producción, verificar:

- [ ] Propiedades creadas en HubSpot (Line Item, Ticket, Invoice)
- [ ] Pipeline/Stages configurados en `constants.js`
- [ ] Webhook configurado y funcionando
- [ ] Proyecto desplegado en Vercel con variables de entorno
- [ ] DRY_RUN testeado sin errores
- [ ] Ticket manual creado correctamente (test real)
- [ ] Factura automática emitida correctamente (test real)
- [ ] Idempotencia verificada (no duplicados)
- [ ] Snapshots copiados correctamente a tickets
- [ ] (Opcional) Cron job configurado

---

## 🆘 TROUBLESHOOTING

### Error: "Property of_ticket_key does not exist"
**Solución:** Crear la propiedad en HubSpot (Paso 1)

### Error: "Cannot find module './bagEngine.js'"
**Solución:** Ya está resuelto en v2.0, asegurate de tener el código actualizado

### Webhook no se dispara
**Solución:** 
1. Verificar configuración en HubSpot (propiedad correcta: `facturar_ahora`)
2. Verificar URL del webhook (debe ser https)
3. Ver logs en HubSpot → Settings → Webhooks → History

### Se crean tickets/facturas duplicados
**Solución:**
1. Verificar que `of_ticket_key` y `of_invoice_key` estén creadas
2. Verificar que el código esté en v2.0 (tiene idempotencia)
3. Ejecutar solo UNA VEZ por día (o usar cron)

### Snapshots vacíos en tickets
**Solución:** Crear propiedades de snapshot en Ticket (ver Paso 1 opcional)

---

## 📞 SOPORTE

Si algo falla:

1. Revisar logs:
   - Local: consola
   - Vercel: `vercel logs`
   - HubSpot: Webhooks History

2. Modo debug:
```bash
DRY_RUN=true node src/runBilling.js --deal <ID>
```

3. Consultar documentación:
   - [REFACTOR_DOCUMENTATION.md](REFACTOR_DOCUMENTATION.md)
   - [HUBSPOT_PROPERTIES_CHECKLIST.md](HUBSPOT_PROPERTIES_CHECKLIST.md)

---

**¡Listo!** Tu sistema de facturación v2.0 está en producción 🎉

**Fecha:** 2025-12-25  
**Versión:** 2.0.0
