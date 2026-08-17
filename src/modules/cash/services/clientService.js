import { supabase, TABLES } from '@/integrations/supabase';
import { normalizePhoneDigits } from '@/shared/utils/phoneWhatsApp';

const MAX_ADDRESS_LENGTH = 500;
const MAX_REFERENCE_LENGTH = 300;

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

/**
 * Normaliza el JSON de dirección principal del cliente.
 * Solo conserva `address` y `reference` (zona/km/fee no se persisten).
 * @param {unknown} value
 * @returns {{ address: string, reference: string } | null}
 */
export function normalizeClientDefaultDeliveryAddress(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const address = String(value.address ?? '').replace(/<[^>]*>/g, '').trim().slice(0, MAX_ADDRESS_LENGTH);
	const reference = String(value.reference ?? '').replace(/<[^>]*>/g, '').trim().slice(0, MAX_REFERENCE_LENGTH);
	if (!address && !reference) return null;
	return { address, reference };
}

/**
 * @param {{ address?: unknown, reference?: unknown }} [fields]
 * @returns {{ address: string, reference: string } | null}
 */
export function buildClientDefaultDeliveryAddress(fields = {}) {
	return normalizeClientDefaultDeliveryAddress(fields);
}

/**
 * Campos de formulario a aplicar al seleccionar un cliente con dirección guardada.
 * Limpia zona/km/fee derivados para que la sucursal activa los recalcule.
 * @param {unknown} client
 * @returns {{ delivery_address: string, delivery_reference: string, delivery_named_area_id: string, delivery_km: string, delivery_fee: number } | null}
 */
export function deliveryFieldsFromClientRecord(client) {
	const saved = normalizeClientDefaultDeliveryAddress(client?.default_delivery_address);
	if (!saved) return null;
	return {
		delivery_address: saved.address,
		delivery_reference: saved.reference,
		delivery_named_area_id: '',
		delivery_km: '',
		delivery_fee: 0,
	};
}

/**
 * Actualiza la dirección principal del cliente (tenant-safe: id + company_id).
 * @param {{ clientId: unknown, companyId: unknown, address?: unknown, reference?: unknown }} params
 * @returns {Promise<{ ok: true, data: object } | { ok: false, error: Error|object }>}
 */
export async function updateClientDefaultDeliveryAddress({
	clientId,
	companyId,
	address,
	reference,
}) {
	const clientIdStr = String(clientId ?? '').trim();
	const companyIdStr = String(companyId ?? '').trim();
	if (!clientIdStr || !companyIdStr) {
		return { ok: false, error: new Error('client_id y company_id son obligatorios') };
	}

	const payload = buildClientDefaultDeliveryAddress({ address, reference });
	if (!payload) {
		return { ok: false, error: new Error('Dirección vacía') };
	}

	const { data, error } = await supabase
		.from(TABLES.clients)
		.update({
			default_delivery_address: payload,
			updated_at: new Date().toISOString(),
		})
		.eq('id', clientIdStr)
		.eq('company_id', companyIdStr)
		.select('id, default_delivery_address')
		.maybeSingle();

	if (error) return { ok: false, error };
	if (!data) return { ok: false, error: new Error('Cliente no encontrado') };
	return { ok: true, data };
}

/**
 * Persistencia secundaria tras un pedido/edición delivery exitoso.
 * Solo clientes registrados; no-delivery o sin clientId se omiten sin error.
 * @param {{ orderType?: unknown, clientId?: unknown, companyId?: unknown, address?: unknown, reference?: unknown }} params
 * @returns {Promise<{ ok: true, skipped?: boolean, data?: object } | { ok: false, error: Error|object }>}
 */
export async function maybeSaveClientDefaultDeliveryAddress({
	orderType,
	clientId,
	companyId,
	address,
	reference,
}) {
	if (String(orderType ?? '').toLowerCase() !== 'delivery') {
		return { ok: true, skipped: true };
	}
	if (!String(clientId ?? '').trim()) {
		return { ok: true, skipped: true };
	}
	return updateClientDefaultDeliveryAddress({
		clientId,
		companyId,
		address,
		reference,
	});
}
