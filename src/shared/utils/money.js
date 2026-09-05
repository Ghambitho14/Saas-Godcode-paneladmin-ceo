import { safeNumber } from '@/shared/utils/numberSafe';
import { resolveEffectiveCurrency } from '@/lib/geo/tenant-locale';
import { isoFractionDigits } from '@/lib/money/minor-units';

export {
	parseMoneyInput,
	majorToMinor,
	minorToMajor,
	sumMinor,
	formatMinor,
	minorAmountsEqual,
} from '@/lib/money/minor-units';

/** @typedef {{ currency?: string | null, country?: string | null }} BranchMoneySource */

const CURRENCY_LOCALE = {
	CLP: 'es-CL',
	ARS: 'es-AR',
	USD: 'en-US',
	VES: 'es-VE',
	MXN: 'es-MX',
};

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeCurrencyCode(raw) {
	const cur = String(raw ?? 'CLP')
		.trim()
		.toUpperCase();
	return /^[A-Z]{3}$/.test(cur) ? cur : 'CLP';
}

/**
 * @param {unknown} currency
 * @returns {string}
 */
export function localeForCurrency(currency) {
	const code = normalizeCurrencyCode(currency);
	return CURRENCY_LOCALE[code] ?? 'es-CL';
}

/**
 * @param {unknown} currency
 * @param {number | undefined} [override]
 * @returns {number}
 */
export function fractionDigitsForCurrency(currency, override) {
	return isoFractionDigits(normalizeCurrencyCode(currency), override);
}

/**
 * Texto para un input de dinero que el usuario edita a mano.
 *
 * Usa el separador decimal del locale (es-VE -> "74,60") y nunca separador de
 * miles, para que `parseMoneyInput` lo relea sin ambiguedad. No escribas el
 * numero crudo: String(74.60000000000001) acaba en el campo tal cual.
 * @param {unknown} amount
 * @param {{ locale?: string, fractionDigits?: number }} [options]
 * @returns {string}
 */
export function toAmountInputValue(amount, options = {}) {
	const digits = Number.isFinite(options.fractionDigits)
		? Math.max(0, Math.trunc(options.fractionDigits))
		: 2;
	const value = safeNumber(amount, 0);
	try {
		return new Intl.NumberFormat(options.locale, {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
			useGrouping: false,
		}).format(value);
	} catch {
		return value.toFixed(digits);
	}
}

/**
 * @param {unknown} amount
 * @param {{ currency?: string, locale?: string, fractionDigits?: number }} [opts]
 * @returns {string}
 */
export function formatMoney(amount, opts = {}) {
	const currency = normalizeCurrencyCode(opts.currency ?? 'CLP');
	const locale = opts.locale ?? localeForCurrency(currency);
	const fractionDigits = fractionDigitsForCurrency(currency, opts.fractionDigits);
	const value = safeNumber(amount, 0);

	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			maximumFractionDigits: fractionDigits,
			minimumFractionDigits: fractionDigits,
		}).format(value);
	} catch {
		return `$${value.toLocaleString(locale)}`;
	}
}

/**
 * @param {unknown} amount
 * @param {string} [locale]
 * @returns {string}
 */
export function formatMoneyPlain(amount, locale = 'es-CL') {
	return safeNumber(amount, 0).toLocaleString(locale);
}

/**
 * @param {unknown} amount
 * @returns {string}
 */
export function formatMoneyCompact(amount) {
	const n = safeNumber(amount, 0);
	const abs = Math.abs(n);
	const sign = n < 0 ? '-' : '';
	if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
	return `${sign}${Math.round(abs)}`;
}

/**
 * @param {unknown} amount
 * @param {string} [freeLabel]
 * @returns {string}
 */
export function formatMoneyOrFree(amount, freeLabel = 'GRATIS') {
	const n = safeNumber(amount, 0);
	if (n <= 0) return freeLabel;
	return formatMoney(n);
}

/**
 * @param {BranchMoneySource | null | undefined} branch
 * @param {{ currency?: string | null; country?: string | null } | null | undefined} [company]
 * @returns {{ currency: string, locale: string, fractionDigits: number, formatMoney: (amount: unknown) => string, formatMoneyPlain: (amount: unknown) => string }}
 */
export function createMoneyFormatter(branch, company) {
	const currency = resolveEffectiveCurrency(branch, company);
	const country = String(branch?.country ?? company?.country ?? '').trim().toUpperCase();
	const locale = country === 'VE' || country === 'VENEZUELA'
		? 'es-VE'
		: country === 'CL' || country === 'CHILE'
			? 'es-CL'
			: localeForCurrency(currency);
	const fractionDigits = fractionDigitsForCurrency(
		currency,
		branch?.manual_order_settings?.currencyFractionDigits,
	);

	return {
		currency,
		locale,
		fractionDigits,
		formatMoney: (amount) => formatMoney(amount, { currency, locale, fractionDigits }),
		formatMoneyPlain: (amount) => formatMoneyPlain(amount, locale),
	};
}

/**
 * @param {BranchMoneySource | null | undefined} branch
 * @param {{ currency?: string | null; country?: string | null } | null | undefined} [company]
 * @returns {string}
 */
export function branchCurrencyCode(branch, company) {
	return resolveEffectiveCurrency(branch, company);
}
