// src/__tests__/ticketKeyIdempotency.js

import { buildInvoiceKey, canonicalLineId } from '../utils/invoiceKey.js';
import { generateTicketKey } from '../utils/idempotency.js';

/**
 * Test simple para verificar que no se duplique el prefijo LI: en ticket keys
 */

console.log('\n🧪 === TEST: Ticket Key Idempotency ===\n');

// Test 1: canonicalLineId debe remover prefijos duplicados
console.log('Test 1: canonicalLineId()');
const tests1 = [
  { input: '123', expected: '123' },
  { input: 'LI:123', expected: '123' },
  { input: 'LI:LI:123', expected: '123' },
  { input: 'LI:LI:LI:123', expected: '123' },
  { input: 'PYLI:456', expected: 'PYLI:456' },
];

let passed1 = 0;
for (const test of tests1) {
  const result = canonicalLineId(test.input);
  const pass = result === test.expected;
  console.log(`  ${pass ? '✅' : '❌'} canonicalLineId("${test.input}") => "${result}" ${pass ? '' : `(expected: "${test.expected}")`}`);
  if (pass) passed1++;
}
console.log(`\nTest 1: ${passed1}/${tests1.length} passed\n`);

// Test 2: buildInvoiceKey debe producir keys sin LI:LI:
console.log('Test 2: buildInvoiceKey()');
const tests2 = [
  { dealId: '100', lineItemId: '123', date: '2026-01-14', shouldNotContain: 'LI:LI:' },
  { dealId: '100', lineItemId: 'LI:123', date: '2026-01-14', shouldNotContain: 'LI:LI:' },
  { dealId: '100', lineItemId: 'LI:LI:123', date: '2026-01-14', shouldNotContain: 'LI:LI:' },
  { dealId: '100', lineItemId: 'PYLI:456', date: '2026-01-14', shouldContain: 'PYLI:' },
];

let passed2 = 0;
for (const test of tests2) {
  const result = buildInvoiceKey(test.dealId, test.lineItemId, test.date);
  const passNotContain = test.shouldNotContain ? !result.includes(test.shouldNotContain) : true;
  const passContain = test.shouldContain ? result.includes(test.shouldContain) : true;
  const pass = passNotContain && passContain;
  
  console.log(`  ${pass ? '✅' : '❌'} buildInvoiceKey("${test.dealId}", "${test.lineItemId}", "${test.date}")`);
  console.log(`      => "${result}"`);
  if (!pass) {
    if (!passNotContain) console.log(`      ❌ Contains "${test.shouldNotContain}"`);
    if (!passContain) console.log(`      ❌ Does not contain "${test.shouldContain}"`);
  }
  if (pass) passed2++;
}
console.log(`\nTest 2: ${passed2}/${tests2.length} passed\n`);

// Test 3: generateTicketKey debe usar buildInvoiceKey correctamente
console.log('Test 3: generateTicketKey()');
const tests3 = [
  { dealId: '100', lineItemId: '123', date: '2026-01-14', expected: '100::LI:123::2026-01-14' },
  { dealId: '100', lineItemId: 'LI:123', date: '2026-01-14', expected: '100::LI:123::2026-01-14' },
  { dealId: '100', lineItemId: 'PYLI:456', date: '2026-01-14', expected: '100::PYLI:456::2026-01-14' },
];

let passed3 = 0;
for (const test of tests3) {
  const result = generateTicketKey(test.dealId, test.lineItemId, test.date);
  const pass = result === test.expected;
  console.log(`  ${pass ? '✅' : '❌'} generateTicketKey("${test.dealId}", "${test.lineItemId}", "${test.date}")`);
  console.log(`      => "${result}" ${pass ? '' : `(expected: "${test.expected}")`}`);
  if (pass) passed3++;
}
console.log(`\nTest 3: ${passed3}/${tests3.length} passed\n`);

// Summary
const totalPassed = passed1 + passed2 + passed3;
const totalTests = tests1.length + tests2.length + tests3.length;
console.log(`\n${'='.repeat(50)}`);
console.log(`TOTAL: ${totalPassed}/${totalTests} tests passed`);
console.log(`${'='.repeat(50)}\n`);

if (totalPassed === totalTests) {
  console.log('✅ All tests passed! No LI:LI: duplication detected.\n');
  process.exit(0);
} else {
  console.error('❌ Some tests failed. Check ticket key generation.\n');
  process.exit(1);
}
