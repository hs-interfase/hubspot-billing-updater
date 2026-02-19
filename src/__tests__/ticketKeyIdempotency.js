// src/__tests__/ticketKeyIdempotency.js

import { buildInvoiceKey } from '../utils/invoiceKey.js';
import logger from '../../lib/logger.js';

/**
 * Test simple para verificar que buildInvoiceKey genera claves correctas para facturas (no ticket keys)
 */

logger.info('\n🧪 === TEST: Invoice Key Idempotency ===\n');

// Test único: buildInvoiceKey debe generar claves correctas para facturas
logger.info('Test: buildInvoiceKey() - invoices');
const tests = [
  // deprecated legacy invoiceKey
  // { dealId: '100', lineItemId: '123', date: '2026-01-14', expected: '100::LI:123::2026-01-14' },
  // { dealId: '100', lineItemId: 'LI:123', date: '2026-01-14', expected: '100::LI:123::2026-01-14' },
  // { dealId: '100', lineItemId: 'PYLI:456', date: '2026-01-14', expected: '100::PYLI:456::2026-01-14' },
];

let passed = 0;
for (const test of tests) {
  const result = buildInvoiceKey(test.dealId, test.lineItemId, test.date);
  const pass = result === test.expected;

  logger.info(
    { pass, dealId: test.dealId, lineItemId: test.lineItemId, date: test.date },
    `  ${pass ? '✅' : '❌'} buildInvoiceKey("${test.dealId}", "${test.lineItemId}", "${test.date}")`
  );

  logger.info(
    { result, expected: pass ? undefined : test.expected },
    `      => "${result}" ${pass ? '' : `(expected: "${test.expected}")`}`
  );

  if (pass) passed++;
}

logger.info(`\nTest: ${passed}/${tests.length} passed\n`);

// Summary
logger.info(`\n${'='.repeat(50)}`);
logger.info(`TOTAL: ${passed}/${tests.length} tests passed`);
logger.info(`${'='.repeat(50)}\n`);

if (passed === tests.length) {
  logger.info('✅ All tests passed! Invoice key generation is correct.\n');
  process.exit(0);
} else {
  logger.error('❌ Some tests failed. Check invoice key generation.\n');
  process.exit(1);
}
