// src/__tests__/invoiceValidation.test.js

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isInvoiceIdValidForLineItem } from '../utils/invoiceValidation.js';
import { hubspotClient } from '../hubspotClient.js';

vi.mock('../hubspotClient.js', () => ({
  hubspotClient: {
    crm: {
      objects: {
        basicApi: {
          getById: vi.fn(),
        },
      },
    },
  },
}));

describe('isInvoiceIdValidForLineItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return invalid when invoiceId is empty', async () => {
    const result = await isInvoiceIdValidForLineItem({
      dealId: '123',
      lik: 'lik-abc',
      invoiceId: '',
      billDateYMD: '2024-01-15',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_invoice_id');
    expect(hubspotClient.crm.objects.basicApi.getById).not.toHaveBeenCalled();
  });

  it('should return invalid when invoiceId is null', async () => {
    const result = await isInvoiceIdValidForLineItem({
      dealId: '123',
      lik: 'lik-abc',
      invoiceId: null,
      billDateYMD: '2024-01-15',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('no_invoice_id');
  });

  it('should return valid when invoice_key matches expected key', async () => {
    const expectedKey = '123::LIK:lik-abc::2024-01-15';

    hubspotClient.crm.objects.basicApi.getById.mockResolvedValue({
      properties: { of_invoice_key: expectedKey },
    });

    const result = await isInvoiceIdValidForLineItem({
      dealId: '123',
      lik: 'lik-abc',
      invoiceId: '789',
      billDateYMD: '2024-01-15',
    });

    expect(result.valid).toBe(true);
    expect(result.reason).toBe('key_match');
    expect(result.expectedKey).toBe(expectedKey);
    expect(result.foundKey).toBe(expectedKey);
    expect(hubspotClient.crm.objects.basicApi.getById).toHaveBeenCalledWith('invoices', '789', ['of_invoice_key']);
  });

  it('should return invalid when invoice_key does not match', async () => {
    const expectedKey = '123::LIK:lik-abc::2024-01-15';
    const wrongKey = '999::LIK:lik-xyz::2024-01-15';

    hubspotClient.crm.objects.basicApi.getById.mockResolvedValue({
      properties: { of_invoice_key: wrongKey },
    });

    const result = await isInvoiceIdValidForLineItem({
      dealId: '123',
      lik: 'lik-abc',
      invoiceId: '789',
      billDateYMD: '2024-01-15',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invoice_id_inherited_or_mismatch');
    expect(result.expectedKey).toBe(expectedKey);
    expect(result.foundKey).toBe(wrongKey);
  });

  it('should return invalid when invoice not found (404)', async () => {
    const error = new Error('Not Found');
    error.response = { status: 404 };

    hubspotClient.crm.objects.basicApi.getById.mockRejectedValue(error);

    const result = await isInvoiceIdValidForLineItem({
      dealId: '123',
      lik: 'lik-abc',
      invoiceId: '789',
      billDateYMD: '2024-01-15',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invoice_not_found');
    expect(result.expectedKey).toBe('123::LIK:lik-abc::2024-01-15');
  });

  it('should return invalid when API error occurs', async () => {
    const error = new Error('API Error');

    hubspotClient.crm.objects.basicApi.getById.mockRejectedValue(error);

    const result = await isInvoiceIdValidForLineItem({
      dealId: '123',
      lik: 'lik-abc',
      invoiceId: '789',
      billDateYMD: '2024-01-15',
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('validation_error');
    expect(result.reason).toContain('API Error');
  });
});