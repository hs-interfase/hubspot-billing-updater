# Fix: Idempotencia de Tickets - Prevenir duplicación de prefijo LI:

## Problema

Se estaban creando tickets con `of_ticket_key` que contenía prefijo duplicado `LI:LI:xxxx` porque:

1. `stableLineId` se construía con prefijo `LI:` (ej: `LI:123`)
2. `buildInvoiceKey()` agregaba otro prefijo `LI:`, resultando en `dealId::LI:LI:123::date`
3. El cleanup marcaba estos tickets como mismatched (no encontraba `LI:LI:123` en line items)
4. Se creaban tickets duplicados en cada corrida

## Solución

### 1. Nueva función `canonicalLineId()` en `src/utils/invoiceKey.js`

```javascript
/**
 * Normaliza el lineId removiendo prefijos duplicados LI:
 * 
 * Ejemplos:
 *   "123" → "123"
 *   "LI:123" → "123"
 *   "LI:LI:123" → "123"
 *   "PYLI:456" → "PYLI:456" (mantiene prefijo especial)
 */
export function canonicalLineId(raw)
```

### 2. Actualizar `buildInvoiceKey()` para usar `canonicalLineId()`

Ahora normaliza el lineId antes de construir la key:

```javascript
export function buildInvoiceKey(dealId, lineItemId, ymd) {
  const li = canonicalLineId(lineItemId); // ✅ Normalizar
  // ...
  const prefix = li.startsWith('PYLI:') ? '' : 'LI:';
  return `${d}${SEP}${prefix}${li}${SEP}${date}`;
}
```

### 3. Eliminar prefijo `LI:` de `stableLineId` en 3 lugares

**Antes:**
```javascript
const stableLineId = lp.of_line_item_py_origen_id
  ? `PYLI:${String(lp.of_line_item_py_origen_id)}`
  : `LI:${lineItemId}`; // ❌ Duplicaba el prefijo
```

**Después:**
```javascript
const stableLineId = lp.of_line_item_py_origen_id
  ? `PYLI:${String(lp.of_line_item_py_origen_id)}`
  : lineItemId; // ✅ Solo el ID, sin prefijo
```

Archivos modificados:
- `src/services/tickets/ticketService.js` (2 lugares)
- `src/services/tickets/manualTicketService.js` (1 lugar)

### 4. Verificación anti-duplicación en `ensureTicketCanonical()`

Agregado check que lanza error si detecta `LI:LI:`:

```javascript
if (expectedKey.includes('LI:LI:')) {
  throw new Error(`Ticket key inválido con prefijo duplicado: ${expectedKey}`);
}
```

### 5. Mejorar cleanup con `extractLineIdFromTicketKey()`

Nueva función que normaliza el lineId extraído del ticket key antes de comparar:

```javascript
function extractLineIdFromTicketKey(ticketKey) {
  // "dealId::LI:LI:123::date" → "123" (normaliza duplicados)
  // "dealId::PYLI:456::date" → "PYLI:456" (mantiene especial)
}
```

Evita marcar tickets válidos como mismatched.

### 6. Test de idempotencia

Nuevo archivo: `src/__tests__/ticketKeyIdempotency.js`

Verifica que:
- `canonicalLineId()` remueve prefijos duplicados
- `buildInvoiceKey()` NO produce keys con `LI:LI:`
- `generateTicketKey()` usa correctamente `buildInvoiceKey()`

**Ejecutar con:** `npm run test:idempotency`

## Resultado

✅ **Formato canónico único:**
- `dealId::LI:lineItemId::YYYY-MM-DD` (para line items normales)
- `dealId::PYLI:lineItemId::YYYY-MM-DD` (para line items PY)

✅ **Sin duplicación:**
- Misma key en todas las corridas
- No se crean tickets nuevos si ya existe uno canónico
- Cleanup no marca tickets válidos como mismatched

✅ **Tests pasando:**
```
TOTAL: 12/12 tests passed
✅ All tests passed! No LI:LI: duplication detected.
```

## Archivos modificados

1. `src/utils/invoiceKey.js` - Agregado `canonicalLineId()`, actualizado `buildInvoiceKey()`
2. `src/services/tickets/ticketService.js` - Normalizado stableLineId (2 lugares), agregado verificación, mejorado cleanup
3. `src/services/tickets/manualTicketService.js` - Normalizado stableLineId
4. `src/__tests__/ticketKeyIdempotency.js` - Nuevo test
5. `package.json` - Agregado script `test:idempotency`

## Testing

1. **Unit tests:** `npm run test:idempotency` ✅
2. **Integration:** Correr billing en un deal y verificar logs:
   ```bash
   node src/runBilling.js --deal <DEAL_ID>
   ```
   - Verificar que `expectedKey` NO contiene `LI:LI:`
   - Verificar que segunda corrida no crea tickets nuevos (ticketsCreated=0)

## Logs de verificación

El sistema ahora imprime:
```
[ticketService] 🔍 AUTO - stableLineId: 123 (real: 123)
[ticketService] 🔍 ensureTicketCanonical
   dealId: 100
   stableLineId: 123
   expectedKey: 100::LI:123::2026-01-14
```

Si detecta duplicación, lanza error inmediatamente:
```
❌ ERROR: expectedKey contiene prefijo duplicado LI:LI:
   expectedKey: 100::LI:LI:123::2026-01-14
```
