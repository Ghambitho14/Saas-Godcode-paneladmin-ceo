import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { formatRut, validateRut } from './country-forms';

const COUNTRY_ALIASES = {
	CHILE: 'CL',
	VENEZUELA: 'VE',
	'REPUBLICA BOLIVARIANA DE VENEZUELA': 'VE',
};

function normalizeCountryCode(value) {
	const normalized = String(value ?? '').trim().toUpperCase();
	return COUNTRY_ALIASES[normalized] ?? (/^[A-Z]{2}$/.test(normalized) ? normalized : 'GLOBAL');
}

function formatVeDocument(value) {
	const raw = String(value ?? '').trim().toUpperCase();
	const prefix = /^[VJEGP]/.test(raw) ? raw[0] : 'V';
	const digits = raw.replace(/\D/g, '').slice(0, 9);
	return digits ? `${prefix}-${digits}` : '';
}

function validateVeDocument(value) {
	return /^[VJEGP]-\d{6,9}$/i.test(String(value ?? '').trim());
}

function optionalDocument(value) {
	return !String(value ?? '').trim() || String(value).trim().length <= 40;
}

export const COUNTRY_PROFILES = Object.freeze({
	CL: Object.freeze({
		countryCode: 'CL',
		locale: 'es-CL',
		defaultCurrency: 'CLP',
		phonePrefix: '+56',
		document: Object.freeze({
			label: 'RUT',
			placeholder: '12.345.678-5',
			requiredByDefault: false,
			format: formatRut,
			validate: validateRut,
		}),
		cashDenominations: Object.freeze({ CLP: Object.freeze([1000, 2000, 5000, 10000, 20000]) }),
		suggestedPaymentMethods: Object.freeze(['efectivo', 'card', 'bank_transfer']),
	}),
	VE: Object.freeze({
		countryCode: 'VE',
		locale: 'es-VE',
		defaultCurrency: 'USD',
		phonePrefix: '+58',
		document: Object.freeze({
			label: 'Cédula / RIF',
			placeholder: 'V-12345678',
			requiredByDefault: false,
			format: formatVeDocument,
			validate: validateVeDocument,
		}),
		cashDenominations: Object.freeze({
			USD: Object.freeze([1, 5, 10, 20, 50, 100]),
			VES: Object.freeze([10, 20, 50, 100, 200, 500]),
		}),
		suggestedPaymentMethods: Object.freeze(['cash_usd', 'cash_ves', 'pago_movil', 'zelle', 'bank_transfer']),
	}),
	GLOBAL: Object.freeze({
		countryCode: null,
		locale: 'en',
		defaultCurrency: null,
		phonePrefix: '+',
		document: Object.freeze({
			label: 'Documento',
			placeholder: 'Documento (opcional)',
			requiredByDefault: false,
			format: (value) => String(value ?? '').trim().slice(0, 40),
			validate: optionalDocument,
		}),
		cashDenominations: Object.freeze({}),
		suggestedPaymentMethods: Object.freeze(['efectivo', 'card', 'bank_transfer']),
	}),
});

export function getCountryProfile(country, options = {}) {
	const code = normalizeCountryCode(country);
	const known = Object.prototype.hasOwnProperty.call(COUNTRY_PROFILES, code) && code !== 'GLOBAL';
	const profile = known ? COUNTRY_PROFILES[code] : COUNTRY_PROFILES.GLOBAL;
	const currency = String(options.currency ?? profile.defaultCurrency ?? '').trim().toUpperCase();
	if (!currency && options.requireCurrency !== false) {
		throw new Error('La sucursal debe configurar una moneda ISO para pedidos manuales.');
	}
	return { ...profile, countryCode: known ? code : null, currency: currency || null };
}

export function normalizeInternationalPhone(value, country) {
	const raw = String(value ?? '').trim();
	if (!raw) return { valid: false, e164: '', reason: 'required' };
	const code = normalizeCountryCode(country);
	const parsed = parsePhoneNumberFromString(raw, code === 'GLOBAL' ? undefined : code);
	if (!parsed?.isValid()) return { valid: false, e164: raw, reason: 'invalid' };
	return { valid: true, e164: parsed.number, reason: null };
}

export function validateProfileDocument(value, profile, required = false) {
	const text = String(value ?? '').trim();
	if (!text) return !required;
	return profile.document.validate(text);
}

export { normalizeCountryCode };
