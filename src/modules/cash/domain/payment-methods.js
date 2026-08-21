import { isoFractionDigits, sumMinor } from '@/lib/money/minor-units';

export const PAYMENT_METHOD_REGISTRY = Object.freeze({
	efectivo: { id: 'efectivo', label: 'Efectivo', rail: 'cash', currencyMode: 'accounting', evidencePolicy: 'none', settlementTrigger: 'cash_confirmation' },
	cash: { id: 'efectivo', label: 'Efectivo', rail: 'cash', currencyMode: 'accounting', evidencePolicy: 'none', settlementTrigger: 'cash_confirmation' },
	tienda: { id: 'efectivo', label: 'Efectivo', rail: 'cash', currencyMode: 'accounting', evidencePolicy: 'none', settlementTrigger: 'cash_confirmation' },
	cash_usd: { id: 'cash_usd', label: 'Efectivo USD', rail: 'cash', currency: 'USD', evidencePolicy: 'none', settlementTrigger: 'cash_confirmation' },
	cash_ves: { id: 'cash_ves', label: 'Efectivo VES', rail: 'cash', currency: 'VES', evidencePolicy: 'none', settlementTrigger: 'cash_confirmation' },
	card: { id: 'card', label: 'Tarjeta', rail: 'card', currencyMode: 'accounting', evidencePolicy: 'optional', settlementTrigger: 'pos_confirmation' },
	tarjeta: { id: 'card', label: 'Tarjeta', rail: 'card', currencyMode: 'accounting', evidencePolicy: 'optional', settlementTrigger: 'pos_confirmation' },
	bank_transfer: { id: 'bank_transfer', label: 'Transferencia bancaria', rail: 'online', currencyMode: 'accounting', evidencePolicy: 'required', settlementTrigger: 'evidence_uploaded' },
	transferencia_bancaria: { id: 'bank_transfer', label: 'Transferencia bancaria', rail: 'online', currencyMode: 'accounting', evidencePolicy: 'required', settlementTrigger: 'evidence_uploaded' },
	online: { id: 'bank_transfer', label: 'Transferencia', rail: 'online', currencyMode: 'accounting', evidencePolicy: 'required', settlementTrigger: 'evidence_uploaded' },
	pago_movil: { id: 'pago_movil', label: 'Pago móvil', rail: 'online', currency: 'VES', evidencePolicy: 'required', settlementTrigger: 'evidence_uploaded' },
	zelle: { id: 'zelle', label: 'Zelle', rail: 'online', currency: 'USD', evidencePolicy: 'required', settlementTrigger: 'evidence_uploaded' },
	paypal: { id: 'paypal', label: 'PayPal', rail: 'online', currencyMode: 'accounting', evidencePolicy: 'required', settlementTrigger: 'evidence_uploaded' },
	stripe: { id: 'stripe', label: 'Stripe', rail: 'card', currencyMode: 'accounting', evidencePolicy: 'optional', settlementTrigger: 'gateway_webhook' },
});

function normalizeRawDefinition(raw, accountingCurrency) {
	const source = typeof raw === 'string' ? { id: raw } : (raw && typeof raw === 'object' ? raw : {});
	const key = String(source.id ?? source.key ?? source.method ?? '').trim().toLowerCase();
	const base = PAYMENT_METHOD_REGISTRY[key];
	if (!base) return null;
	const currency = String(source.currency ?? base.currency ?? accountingCurrency).trim().toUpperCase();
	const evidencePolicyRaw = source.evidencePolicy ?? source.evidence_policy;
	const settlementTriggerRaw = source.settlementTrigger ?? source.settlement_trigger;
	return {
		...base,
		id: base.id,
		label: String(source.label ?? base.label),
		currency,
		evidencePolicy: ['none', 'optional', 'required'].includes(evidencePolicyRaw) ? evidencePolicyRaw : base.evidencePolicy,
		settlementTrigger: [
			'cash_confirmation',
			'pos_confirmation',
			'evidence_uploaded',
			'manual_verification',
			'gateway_webhook',
		].includes(settlementTriggerRaw) ? settlementTriggerRaw : base.settlementTrigger,
		allowMixedPayment: source.allowMixedPayment !== false && source.allow_mixed_payment !== false,
		enabled: source.enabled !== false && source.active !== false,
	};
}

export function normalizePaymentMethods(rawMethods, options = {}) {
	const accountingCurrency = String(options.accountingCurrency ?? '').trim().toUpperCase();
	if (!accountingCurrency) throw new Error('Moneda contable requerida.');
	const source = Array.isArray(rawMethods) && rawMethods.length ? rawMethods : ['efectivo', 'card', 'bank_transfer'];
	const seen = new Set();
	return source.map((raw) => normalizeRawDefinition(raw, accountingCurrency)).filter((definition) => {
		if (!definition?.enabled || seen.has(definition.id)) return false;
		seen.add(definition.id);
		return true;
	});
}

/**
 * Normaliza la lista autoritativa configurada para una sucursal.
 * Una lista vacía permanece vacía y no habilita métodos predeterminados.
 */
export function normalizeConfiguredPaymentMethods(rawMethods, options = {}) {
	if (!Array.isArray(rawMethods) || rawMethods.length === 0) return [];
	return normalizePaymentMethods(rawMethods, options);
}

function decimalRatio(value) {
	const text = String(value ?? '').trim();
	if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Tasa de cambio inválida.');
	const [whole, fraction = ''] = text.split('.');
	const numerator = BigInt(`${whole}${fraction}`);
	if (numerator <= 0n) throw new Error('Tasa de cambio inválida.');
	return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/** Convierte settlement minor a moneda contable. rate = settlement units por 1 accounting unit. */
export function settlementToAccountingMinor(settlementMinor, settlementCurrency, accountingCurrency, exchangeRate, options = {}) {
	const settlementDigits = isoFractionDigits(settlementCurrency, options.settlementFractionDigits);
	const accountingDigits = isoFractionDigits(accountingCurrency, options.accountingFractionDigits);
	const rate = decimalRatio(exchangeRate);
	const numerator = BigInt(settlementMinor) * rate.denominator * (10n ** BigInt(accountingDigits));
	const denominator = rate.numerator * (10n ** BigInt(settlementDigits));
	const rounded = (numerator + denominator / 2n) / denominator;
	const number = Number(rounded);
	if (!Number.isSafeInteger(number)) throw new RangeError('Conversión fuera de rango.');
	return number;
}

export function validatePaymentLines(lines, quote, methods) {
	const errors = [];
	const allowed = new Map((methods || []).map((method) => [method.id, method]));
	const normalized = [];
	const selectedMethodIds = new Set((lines || []).map((line) => String(line?.methodId ?? '')));
	if (selectedMethodIds.size > 1) {
		for (const methodId of selectedMethodIds) {
			const method = allowed.get(methodId);
			if (method?.allowMixedPayment === false) {
				errors.push({ methodId, code: 'mixed_payment_not_allowed' });
			}
		}
	}
	for (const raw of lines || []) {
		const method = allowed.get(String(raw?.methodId ?? ''));
		if (!method) {
			errors.push({ lineId: raw?.id, code: 'method_not_allowed' });
			continue;
		}
		const amountMinor = Number(raw.amountMinor);
		if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
			errors.push({ lineId: raw?.id, code: 'invalid_amount' });
			continue;
		}
		const line = {
			id: String(raw.id),
			methodId: method.id,
			rail: method.rail,
			amountMinor,
			currency: String(quote.currency),
			evidencePolicy: method.evidencePolicy,
			settlementTrigger: method.settlementTrigger,
		};
		if (method.currency !== quote.currency) {
			if (!raw.exchangeRate || !Number.isSafeInteger(Number(raw.settlementAmountMinor))) {
				errors.push({ lineId: raw?.id, code: 'exchange_rate_required' });
				continue;
			}
			const converted = settlementToAccountingMinor(
				Number(raw.settlementAmountMinor), method.currency, quote.currency, raw.exchangeRate,
			);
			if (converted !== amountMinor) {
				errors.push({ lineId: raw?.id, code: 'conversion_mismatch', expectedAmountMinor: converted });
				continue;
			}
			line.settlementAmountMinor = Number(raw.settlementAmountMinor);
			line.settlementCurrency = method.currency;
			line.exchangeRate = String(raw.exchangeRate);
		}
		if (method.rail === 'cash') {
			const tenderedCurrency = method.currency;
			const dueMinor = method.currency === quote.currency ? amountMinor : line.settlementAmountMinor;
			const tenderedAmountMinor = raw.tenderedAmountMinor == null ? dueMinor : Number(raw.tenderedAmountMinor);
			if (!Number.isSafeInteger(tenderedAmountMinor) || tenderedAmountMinor < dueMinor) {
				errors.push({ lineId: raw?.id, code: 'insufficient_tender' });
				continue;
			}
			line.tenderedAmountMinor = tenderedAmountMinor;
			line.tenderedCurrency = tenderedCurrency;
			line.changeAmountMinor = tenderedAmountMinor - dueMinor;
		}
		normalized.push(line);
	}
	const paidMinor = sumMinor(normalized.map((line) => line.amountMinor));
	if (paidMinor !== Number(quote.totalMinor)) errors.push({ code: 'total_mismatch', paidMinor, totalMinor: quote.totalMinor });
	return { valid: errors.length === 0, errors, lines: normalized, paidMinor };
}

export function deriveLegacyPaymentFields(lines, currency) {
	const breakdownMinor = { cash: 0, card: 0, online: 0 };
	for (const line of lines || []) breakdownMinor[line.rail] += Number(line.amountMinor) || 0;
	const active = Object.entries(breakdownMinor).filter(([, amount]) => amount > 0);
	const primary = active.length === 1 ? active[0][0] : 'mixed';
	return {
		payment_type: primary === 'cash' ? 'tienda' : primary === 'card' ? 'tarjeta' : primary === 'online' ? 'online' : 'mixto',
		payment_method_specific: lines?.length === 1 ? lines[0].methodId : 'mixed',
		payment_breakdown_minor: breakdownMinor,
		currency,
	};
}
