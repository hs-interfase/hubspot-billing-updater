// test/buildPagoDisplay.test.js
import { describe, it, expect } from 'vitest';
import { buildPagoDisplay } from '../services/billing/syncBillingState.js';

describe('buildPagoDisplay', () => {
  it('barra parcial al inicio', () => expect(buildPagoDisplay(3, 12)).toBe('███░░░░░░░ 3 / 12'));  it('barra completa',              () => expect(buildPagoDisplay(12, 12)).toBe('██████████ 12 / 12'));
  it('sin pagos emitidos',          () => expect(buildPagoDisplay(0, 12)).toBe('░░░░░░░░░░ 0 / 12'));
  it('auto-renew (total = 0)',      () => expect(buildPagoDisplay(5, 0)).toBe(''));
  it('total undefined',             () => expect(buildPagoDisplay(5, undefined)).toBe(''));
  it('no supera el total',          () => expect(buildPagoDisplay(15, 12)).toBe('██████████ 12 / 12'));
});