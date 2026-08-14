import { normalizePhoneDigits } from '@/shared/utils/phoneWhatsApp';

/**
 * Normaliza teléfono chileno al formato canónico del panel: +56 9 XXXX XXXX
 * @param {unknown} phone
 * @returns {string}
 */
export function normalizeManualPhone(phone) {
	const raw = phone == null ? '' : String(phone).trim();
	if (!raw) return '';

	let digits = normalizePhoneDigits(raw);
	if (!digits) return raw;

	if (digits.length === 9 && digits.startsWith('9')) {
		digits = `56${digits}`;
	} else if (digits.length === 8 && digits.startsWith('9')) {
		digits = `569${digits}`;
	} else if (digits.length > 11 && digits.startsWith('56')) {
		digits = digits.slice(0, 11);
	}

	if (digits.length < 11 || !digits.startsWith('56')) {
		return raw;
	}

	const local9 = digits.slice(2, 11);
	if (local9.length < 9) return raw;

	return `+56 ${local9.slice(0, 1)} ${local9.slice(1, 5)} ${local9.slice(5, 9)}`;
}

/**
 * @param {unknown} phone
 * @returns {string}
 */
export function normalizePhoneForSearch(phone) {
	return normalizePhoneDigits(phone);
}

const normalizeSearch = (value) => String(value ?? '').trim().toLowerCase();
const normalizeDocForSearch = (value) => String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Autocomplete de clientes del pedido manual: coincidencia parcial por nombre, teléfono o documento.
 * @param {unknown[]} clients
 * @param {unknown} query
 * @param {{ limit?: number }} [options]
 * @returns {unknown[]}
 */
export function filterClientsByNameOrPhone(clients, query, options = {}) {
	const q = normalizeSearch(query);
	const qDigits = normalizePhoneForSearch(query);
	const qDoc = normalizeDocForSearch(query);
	const limit = Number.isFinite(options.limit) ? Math.max(0, options.limit) : 8;
	if (!q || !Array.isArray(clients)) return [];
	return clients
		.filter((c) => {
			const name = normalizeSearch(c?.name);
			const rut = normalizeDocForSearch(c?.rut ?? c?.document);
			const phoneDigits = normalizePhoneForSearch(c?.phone);
			const nameMatch = name.includes(q);
			const rutMatch = qDoc.length >= 3 && rut.includes(qDoc);
			const phoneMatch = qDigits.length >= 3 && phoneDigits.includes(qDigits);
			return nameMatch || rutMatch || phoneMatch;
		})
		.slice(0, limit);
}
