# Invoice Creation Paths - Idempotency Documentation

## ✅ Authoritative Invoice Creation Path

**File:** `src/services/invoiceService.js`

### Primary Function: `createInvoiceFromTicket(ticket, modoGeneracion, usuarioDisparador)`

**Purpose:** Create invoices from billing tickets with strict idempotency and no backend money calculations.

**Idempotency Strategy:**
- Uses `of_invoice_key` for strict deduplication
- Format: `{dealId}::{lineItemId}::{billingDate}` (canonical)
- Checks existing `of_invoice_id` in ticket before creating
- Validates `of_invoice_key` matches expected value to prevent dirty clones

**Money Calculation Strategy (FREEZE RULE):**
- ❌ Backend does NOT calculate: `qty * price`, discounts, IVA, subtotals
- ✅ Uses HubSpot-calculated values: `total_real_a_facturar` from Ticket
- ✅ Copies RAW input flags: `cantidad_real`, `descuento_en_porcentaje`, `of_iva`
- ✅ Uses `buildValidatedUpdateProps` for schema validation

**Empty Update Guard:**
```javascript
if (Object.keys(validatedProps).length === 0) {
  console.error('❌ SKIP_EMPTY_UPDATE: No hay propiedades válidas para crear invoice');
  return { invoiceId: null, created: false };
}
```

**Usage:**
```javascript
import { createInvoiceFromTicket } from './services/invoiceService.js';

// From ticket (main path)
const result = await createInvoiceFromTicket(ticket, 'AUTO_LINEITEM');

// Manual trigger
const result = await createInvoiceFromTicket(ticket, 'MANUAL_TICKET', userId);
```

---

### Legacy Function: `createAutoInvoiceFromLineItem(deal, lineItem, billingPeriodDate, invoiceDate)`

**Status:** LEGACY - Maintained for backward compatibility only

**Purpose:** Create invoices directly from Line Item (bypasses ticket creation)

**When to use:**
- Only for special cases where ticket creation is not feasible
- Prefer `createInvoiceFromTicket` in all standard billing flows

**Idempotency:**
- Uses same `of_invoice_key` strategy
- Checks `invoice_id` in line item properties
- Same validation and guards as primary function

---

## ❌ Deprecated Invoice Creation Paths

### File: `src/invoices.js` - **DEPRECATED**

**Status:** ⚠️ DO NOT USE - Not imported anywhere in codebase

**Functions:**
- `createInvoiceForTicket(ticket)` - DEPRECATED
- `createInvoiceForLineItem(deal, lineItem, invoiceDate)` - DEPRECATED

**Why deprecated:**
- Does NOT use `buildValidatedUpdateProps` (no schema validation)
- Does NOT enforce FREEZE RULE properly
- Uses old HubSpot SDK methods
- Lacks comprehensive empty update guards
- No cupo integration

**Migration:**
```javascript
// OLD (deprecated):
import { createInvoiceForTicket } from './invoices.js';
await createInvoiceForTicket(ticket);

// NEW (current):
import { createInvoiceFromTicket } from './services/invoiceService.js';
await createInvoiceFromTicket(ticket, 'AUTO_LINEITEM');
```

---

## Idempotency Best Practices

### 1. Always Use `of_invoice_key`

```javascript
// Generate canonical key
const invoiceKey = generateInvoiceKey(dealId, lineItemId, billingDate);

// Check existing invoice
if (ticket.properties.of_invoice_id) {
  const existingKey = ticket.properties.of_invoice_key;
  if (existingKey === invoiceKey) {
    return { invoiceId: ticket.properties.of_invoice_id, created: false };
  }
}
```

### 2. Validate Props Before Create/Update

```javascript
const validatedProps = await buildValidatedUpdateProps('invoices', invoicePropsRaw, {
  logPrefix: '[createInvoice]'
});

if (Object.keys(validatedProps).length === 0) {
  console.error('❌ SKIP_EMPTY_UPDATE');
  return { invoiceId: null, created: false };
}
```

### 3. Use Direct API for Invoices

```javascript
// Use axios directly (not SDK) for invoices
const response = await axios.post(
  `${HUBSPOT_API_BASE}/crm/v3/objects/invoices`,
  { properties: validatedProps },
  { headers: { 'Authorization': `Bearer ${accessToken}` } }
);
```

### 4. Update Related Objects

```javascript
// Update ticket with invoice reference
await hubspotClient.crm.tickets.basicApi.update(ticketId, {
  properties: {
    of_invoice_id: invoiceId,
    of_invoice_key: invoiceKey,
    fecha_real_de_facturacion: invoiceDateMs,
  },
});

// Update line item with invoice reference
await hubspotClient.crm.lineItems.basicApi.update(lineItemId, {
  properties: {
    invoice_id: invoiceId,
    invoice_key: invoiceKey,
  },
});
```

---

## Common Pitfalls to Avoid

### ❌ DON'T: Calculate money in backend
```javascript
// WRONG - violates FREEZE RULE
const total = quantity * price;
const withDiscount = total * (1 - discount/100);
const withIVA = withDiscount * 1.22;
```

### ✅ DO: Use HubSpot-calculated values
```javascript
// CORRECT - copy from HubSpot
const totalFinal = parseNumber(ticket.properties.total_real_a_facturar, 0);
```

### ❌ DON'T: Skip empty update guards
```javascript
// WRONG - might create invoice with no valid properties
await createInvoiceDirect(invoiceProps);
```

### ✅ DO: Always validate and guard
```javascript
// CORRECT
const validated = await buildValidatedUpdateProps('invoices', invoiceProps);
if (Object.keys(validated).length === 0) {
  return { invoiceId: null, created: false };
}
await createInvoiceDirect(validated);
```

### ❌ DON'T: Use multiple invoice keys
```javascript
// WRONG - inconsistent idempotency
const key1 = `ticket::${ticketId}`;
const key2 = `${dealId}::${lineItemId}`;
```

### ✅ DO: Use canonical invoice key
```javascript
// CORRECT - one authoritative format
const invoiceKey = generateInvoiceKey(dealId, lineItemId, billingDate);
// Format: "1234567::9876543::2025-01-15"
```

---

## Summary

| Aspect | Authoritative Path | Legacy Path (Deprecated) |
|--------|-------------------|-------------------------|
| **File** | `services/invoiceService.js` | `invoices.js` |
| **Function** | `createInvoiceFromTicket` | `createInvoiceForTicket` |
| **Idempotency** | ✅ Strict `of_invoice_key` | ⚠️ Basic check only |
| **Money Calc** | ✅ FREEZE RULE enforced | ❌ Backend calculations |
| **Validation** | ✅ `buildValidatedUpdateProps` | ❌ No schema validation |
| **Empty Guards** | ✅ Comprehensive | ⚠️ Partial |
| **Cupo Integration** | ✅ Full support | ❌ None |
| **Status** | ✅ ACTIVE | ❌ DEPRECATED |

**Recommendation:** Always use `createInvoiceFromTicket()` from `services/invoiceService.js` for all invoice creation needs.
