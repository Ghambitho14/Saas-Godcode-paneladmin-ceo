import { describe, expect, it } from 'vitest';
import {
	normalizePaymentMethods,
	normalizeConfiguredPaymentMethods,
	settlementToAccountingMinor,
	validatePaymentLines,
	deriveLegacyPaymentFields,
} from '../../src/modules/cash/domain/payment-methods';

describe('manual order payment lines', () => {
	it('normalizes branch methods and combines arbitrary rails', () => {
		const methods = normalizePaymentMethods(['efectivo', 'card', 'zelle'], { accountingCurrency: 'USD' });
		const lines = [
			{ id: 'a', methodId: 'efectivo', amountMinor: 400, currency: 'USD' },
			{ id: 'b', methodId: 'card', amountMinor: 600, currency: 'USD' },
		];
		const result = validatePaymentLines(lines, { totalMinor: 1000, currency: 'USD' }, methods);
		expect(result.valid).toBe(true);
		expect(deriveLegacyPaymentFields(result.lines, 'USD')).toMatchObject({ payment_type: 'mixto', payment_method_specific: 'mixed' });
	});

	it('canonicalizes legacy aliases without duplicating a configured method', () => {
		const methods = normalizePaymentMethods(['tienda', 'cash', 'tarjeta'], { accountingCurrency: 'CLP' });
		expect(methods.map((method) => method.id)).toEqual(['efectivo', 'card']);
	});

	it('does not invent defaults when the authoritative branch configuration is empty', () => {
		expect(normalizeConfiguredPaymentMethods([], { accountingCurrency: 'CLP' })).toEqual([]);
		expect(normalizeConfiguredPaymentMethods(null, { accountingCurrency: 'CLP' })).toEqual([]);
	});

	it('normalizes only methods persisted for the branch', () => {
		const methods = normalizeConfiguredPaymentMethods(['efectivo', 'zelle'], { accountingCurrency: 'CLP' });
		expect(methods.map((method) => method.id)).toEqual(['efectivo', 'zelle']);
	});

	it('canonicalizes legacy cash identifiers to efectivo while preserving the cash rail', () => {
		const methods = normalizePaymentMethods(['cash', 'tienda', 'efectivo'], { accountingCurrency: 'CLP' });
		expect(methods).toHaveLength(1);
		expect(methods[0]).toMatchObject({ id: 'efectivo', rail: 'cash' });
	});

	it('converts VES settlement using persisted decimal rate', () => {
		expect(settlementToAccountingMinor(36500, 'VES', 'USD', '36.5')).toBe(1000);
	});

	it('rejects a mismatch of one minor unit', () => {
		const methods = normalizePaymentMethods(['cash'], { accountingCurrency: 'USD' });
		const result = validatePaymentLines([{ id: 'a', methodId: 'efectivo', amountMinor: 999, currency: 'USD' }], { totalMinor: 1000, currency: 'USD' }, methods);
		expect(result.valid).toBe(false);
		expect(result.errors.at(-1)).toMatchObject({ code: 'total_mismatch', paidMinor: 999 });
	});

	it('computes cash change in the tender currency', () => {
		const methods = normalizePaymentMethods(['cash'], { accountingCurrency: 'USD' });
		const result = validatePaymentLines([
			{ id: 'efectivo', methodId: 'efectivo', amountMinor: 1050, currency: 'USD', tenderedAmountMinor: 2000 },
		], { totalMinor: 1050, currency: 'USD' }, methods);
		expect(result.valid).toBe(true);
		expect(result.lines[0]).toMatchObject({ tenderedAmountMinor: 2000, changeAmountMinor: 950, tenderedCurrency: 'USD' });
	});

	it('preserves settlement policy and rejects a method excluded from mixed payments', () => {
		const methods = normalizePaymentMethods([
			{ id: 'efectivo', allowMixedPayment: true },
			{ id: 'zelle', allowMixedPayment: false },
		], { accountingCurrency: 'USD' });
		expect(methods[1]).toMatchObject({
			id: 'zelle',
			evidencePolicy: 'required',
			settlementTrigger: 'evidence_uploaded',
			allowMixedPayment: false,
		});
		const result = validatePaymentLines([
			{ id: 'efectivo', methodId: 'efectivo', amountMinor: 500, currency: 'USD' },
			{ id: 'zelle', methodId: 'zelle', amountMinor: 500, currency: 'USD' },
		], { totalMinor: 1000, currency: 'USD' }, methods);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual({
			methodId: 'zelle',
			code: 'mixed_payment_not_allowed',
		});
	});
});
