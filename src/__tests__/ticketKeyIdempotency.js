// src/__tests__/ticketKeyIdempotency.js

import { buildInvoiceKey } from '../utils/invoiceKey.js';
/**
 * Test simple para verificar que buildInvoiceKey genera claves correctas para facturas (no ticket keys)
 */

console.log('\n🧪 === TEST: Invoice Key Idempotency ===\n');

// Test único: buildInvoiceKey debe generar claves correctas para facturas
console.log('Test: buildInvoiceKey() - invoices');
const tests = [
  { dealId: '100', lineItemId: '123', date: '2026-01-14', expected: '100::LI:123::2026-01-14' },
  { dealId: '100', lineItemId: 'LI:123', date: '2026-01-14', expected: '100::LI:123::2026-01-14' },
  { dealId: '100', lineItemId: 'PYLI:456', date: '2026-01-14', expected: '100::PYLI:456::2026-01-14' },
];

let passed = 0;
for (const test of tests) {
  const result = buildInvoiceKey(test.dealId, test.lineItemId, test.date);
  const pass = result === test.expected;
  console.log(`  ${pass ? '✅' : '❌'} buildInvoiceKey("${test.dealId}", "${test.lineItemId}", "${test.date}")`);
  console.log(`      => "${result}" ${pass ? '' : `(expected: "${test.expected}")`}`);
  if (pass) passed++;
}
console.log(`\nTest: ${passed}/${tests.length} passed\n`);

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`TOTAL: ${passed}/${tests.length} tests passed`);
console.log(`${'='.repeat(50)}\n`);

if (passed === tests.length) {
  console.log('✅ All tests passed! Invoice key generation is correct.\n');
  process.exit(0);
} else {
  console.error('❌ Some tests failed. Check invoice key generation.\n');
  process.exit(1);
}
