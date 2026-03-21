// src/__tests__/ticketKeyIdempotency.js

import { buildInvoiceKey } from '../utils/invoiceKey.js';
import logger from '../../lib/logger.js';

logger.info('\n🧪 === TEST: Invoice Key Idempotency ===\n');

// ─── Happy path ───────────────────────────────────────────────────────────────
logger.info('Test: buildInvoiceKey() - happy path');

const happyTests = [
  {
    label: 'lik simple',
    dealId: '100', lik: 'abc123', date: '2026-01-14',
    expected: '100::LIK:abc123::2026-01-14',
  },
  {
    label: 'lik con prefijo regional PY:',
    dealId: '100', lik: 'PY:abc123', date: '2026-01-14',
    expected: '100::LIK:PY:abc123::2026-01-14',
  },
  {
    label: 'lik con espacios (trim)',
    dealId: '100', lik: '  abc123  ', date: '2026-01-14',
    expected: '100::LIK:abc123::2026-01-14',
  },
  {
    label: 'case sensitive: py: != PY:',
    dealId: '100', lik: 'py:abc123', date: '2026-01-14',
    expected: '100::LIK:py:abc123::2026-01-14', // distinta a PY:
  },
];

let passed = 0;
let total = 0;

for (const test of happyTests) {
  total++;
  let result, pass;
  try {
    result = buildInvoiceKey(test.dealId, test.lik, test.date);
    pass = result === test.expected;
  } catch (err) {
    result = `[threw] ${err.message}`;
    pass = false;
  }

  logger.info(
    { pass, label: test.label },
    `  ${pass ? '✅' : '❌'} ${test.label}`
  );
  if (!pass) {
    logger.info({ result, expected: test.expected }, `      => got: "${result}" | expected: "${test.expected}"`);
  }

  if (pass) passed++;
}

// ─── Should throw ─────────────────────────────────────────────────────────────
logger.info('\nTest: buildInvoiceKey() - should throw');

const throwTests = [
  {
    label: 'dealId vacío',
    fn: () => buildInvoiceKey('', 'abc123', '2026-01-14'),
    expectMsg: 'dealId requerido',
  },
  {
    label: 'lik vacío',
    fn: () => buildInvoiceKey('100', '', '2026-01-14'),
    expectMsg: 'lik requerido',
  },
  {
    label: 'lik null',
    fn: () => buildInvoiceKey('100', null, '2026-01-14'),
    expectMsg: 'lik requerido',
  },
  {
    label: 'ymd vacío',
    fn: () => buildInvoiceKey('100', 'abc123', ''),
    expectMsg: 'ymd requerido',
  },
  {
    label: 'ymd formato inválido (DD-MM-YYYY)',
    fn: () => buildInvoiceKey('100', 'abc123', '14-01-2026'),
    expectMsg: 'ymd inválido',
  },
  {
    label: 'opts.idType = LI (legacy disabled)',
    fn: () => buildInvoiceKey('100', 'abc123', '2026-01-14', { idType: 'LI' }),
    expectMsg: 'legacy disabled',
  },
];

for (const test of throwTests) {
  total++;
  let pass = false;
  let detail = '';
  try {
    test.fn();
    detail = '[no lanzó error]';
    pass = false;
  } catch (err) {
    pass = err.message.includes(test.expectMsg);
    if (!pass) detail = `mensaje fue: "${err.message}" | esperado incluir: "${test.expectMsg}"`;
  }

  logger.info(
    { pass, label: test.label },
    `  ${pass ? '✅' : '❌'} throws: ${test.label}`
  );
  if (!pass) {
    logger.info({ detail }, `      => ${detail}`);
  }

  if (pass) passed++;
}

// ─── Summary ──────────────────────────────────────────────────────────────────
logger.info(`\n${'='.repeat(50)}`);
logger.info(`TOTAL: ${passed}/${total} tests passed`);
logger.info(`${'='.repeat(50)}\n`);

if (passed === total) {
  logger.info('✅ All tests passed! Invoice key generation is correct.\n');
  process.exit(0);
} else {
  logger.error('❌ Some tests failed. Check invoice key generation.\n');
  process.exit(1);
}