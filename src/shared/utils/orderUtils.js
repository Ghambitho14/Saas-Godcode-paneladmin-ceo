/** Etiquetas para método de pago específico (coincide con keys del carrito/SaaS). */
import { formatMoney, normalizeCurrencyCode, minorToMajor, majorToMinor, fractionDigitsForCurrency } from '@/shared/utils/money';
import { formatOrderAmountForShare, shareIdLabelFromLocale } from '@/lib/money/order-amount';

export const PAYMENT_METHOD_LABELS = {
	efectivo: 'Efectivo',
	tarjeta: 'Tarjeta',
	pago_movil: 'Pago Móvil',
	zelle: 'Zelle',
	transferencia_bancaria: 'Transferencia',
	stripe: 'Tarjeta (Online)',
	mercadopago: 'MercadoPago',
	paypal: 'PayPal',
	online: 'Transf.',
	tienda: 'En local'
};

/** Métodos de transferencia (comprobante / voucher), no tarjeta procesada online. */
const TRANSFER_SPECIFIC_METHODS = new Set(['pago_movil', 'zelle', 'transferencia_bancaria']);

/** @typedef {{ cash: number; card: number; online: number }} PaymentBreakdown */

function normalizeMajorPaymentAmount(value) {
	const amount = Number(value);
	if (!Number.isFinite(amount)) return 0;
	return Math.max(0, Number(amount.toFixed(6)));
}

/**
 * Normaliza un desglose de pago desde JSONB u objeto parcial.
 * @param {unknown} raw
 * @returns {PaymentBreakdown}
 */
export function normalizePaymentBreakdown(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { cash: 0, card: 0, online: 0 };
	}
	const o = /** @type {Record<string, unknown>} */ (raw);
	return {
		cash: normalizeMajorPaymentAmount(o.cash),
		card: normalizeMajorPaymentAmount(o.card),
		online: normalizeMajorPaymentAmount(o.online),
	};
}

/**
 * @param {PaymentBreakdown | null | undefined} breakdown
 * @returns {number}
 */
export function countActiveBreakdownMethods(breakdown) {
	const b = normalizePaymentBreakdown(breakdown);
	return ['cash', 'card', 'online'].filter((key) => b[key] > 0).length;
}

/**
 * @param {PaymentBreakdown | null | undefined} breakdown
 * @returns {boolean}
 */
export function isMixedPaymentBreakdown(breakdown) {
	return countActiveBreakdownMethods(breakdown) > 1;
}

/**
 * @param {string | null | undefined} paymentType
 * @returns {'cash' | 'card' | 'online' | null}
 */
export function paymentTypeToBreakdownMethod(paymentType) {
	const pt = String(paymentType ?? '').toLowerCase();
	if (pt === 'online' || pt === 'transferencia') return 'online';
	if (pt === 'tarjeta' || pt === 'card') return 'card';
	if (pt === 'tienda' || pt === 'cash' || pt === 'efectivo') return 'cash';
	return null;
}

/**
 * Infiere bucket de caja (cash | card | online) desde payment_type y payment_method_specific.
 * Alineado con getCashMovementPaymentMethod para pedidos del menú digital.
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {'cash' | 'card' | 'online' | null}
 */
export function inferBreakdownMethodFromOrder(order) {
	if (!order) return null;
	const specific = String(order.payment_method_specific ?? '').trim().toLowerCase();
	if (specific.length > 0) {
		if (['efectivo', 'cash', 'tienda'].includes(specific)) return 'cash';
		if (['tarjeta', 'stripe', 'mercadopago', 'paypal', 'card'].includes(specific)) {
			return 'card';
		}
		if (['transferencia_bancaria', 'bank_transfer', 'pago_movil', 'zelle', 'online'].includes(specific)) {
			return 'online';
		}
		return null;
	}
	const pt = String(order.payment_type ?? '').toLowerCase();
	if (pt === 'tarjeta' || pt === 'card') return 'card';
	if (pt === 'online' || pt === 'transferencia') return 'online';
	if (pt === 'tienda' || pt === 'cash' || pt === 'efectivo') return 'cash';
	return null;
}

/**
 * Desglose efectivo para caja: usa payment_breakdown si es mixto; si no, infiere del total.
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {PaymentBreakdown}
 */
export function getOrderPaymentBreakdown(order) {
	if (!order) return { cash: 0, card: 0, online: 0 };

	if (String(order.payment_type ?? '').trim().toLowerCase() === 'pendiente') {
		return { cash: 0, card: 0, online: 0 };
	}

	if (isMenuOrderAwaitingPayment(order)) {
		return { cash: 0, card: 0, online: 0 };
	}

	if (Array.isArray(order.payment_lines) && order.payment_lines.length > 0) {
		const currency = normalizeCurrencyCode(order.currency);
		return order.payment_lines.reduce((totals, line) => {
			const rail = line?.rail;
			if (!['cash', 'card', 'online'].includes(rail)) return totals;
			totals[rail] += minorToMajor(Number(line.amountMinor ?? line.amount_minor) || 0, currency);
			return totals;
		}, { cash: 0, card: 0, online: 0 });
	}

	const stored = normalizePaymentBreakdown(order.payment_breakdown);
	if (countActiveBreakdownMethods(stored) >= 1) {
		return stored;
	}

	const total = normalizeMajorPaymentAmount(order.total);
	const method = inferBreakdownMethodFromOrder(order);
	return {
		cash: method === 'cash' ? total : 0,
		card: method === 'card' ? total : 0,
		online: method === 'online' ? total : 0,
	};
}

/**
 * Arma el JSONB a persistir cuando hay pago mixto.
 * @param {{ payment_mode?: string; payment_type?: string; cash_amount?: number; card_amount?: number; total?: number }} params
 * @returns {PaymentBreakdown | null}
 */
export function buildPaymentBreakdownForOrder({
	payment_mode,
	payment_type,
	cash_amount,
	card_amount,
	total,
}) {
	if (payment_mode === 'mixed') {
		const breakdown = {
			cash: normalizeMajorPaymentAmount(cash_amount),
			card: normalizeMajorPaymentAmount(card_amount),
			online: 0,
		};
		if (isMixedPaymentBreakdown(breakdown)) {
			return breakdown;
		}
	}
	const amount = normalizeMajorPaymentAmount(total);
	const method = paymentTypeToBreakdownMethod(payment_type);
	if (!method || amount <= 0) return null;
	return {
		cash: method === 'cash' ? amount : 0,
		card: method === 'card' ? amount : 0,
		online: method === 'online' ? amount : 0,
	};
}

/**
 * Monto en efectivo que el cliente debe pagar (para calculadora de vuelto).
 * @param {{ payment_mode?: string; payment_type?: string; cash_amount?: number; totalToPay?: number }} params
 * @returns {number}
 */
export function getCashDueAmount({ payment_mode, payment_type, cash_amount, totalToPay }) {
	if (payment_mode === 'mixed') {
		return normalizeMajorPaymentAmount(cash_amount);
	}
	if (payment_type === 'tienda') {
		return normalizeMajorPaymentAmount(totalToPay);
	}
	return 0;
}

/**
 * @param {number | string | null | undefined} cashTendered
 * @param {number | string | null | undefined} cashDue
 * @returns {number}
 */
export function computeChangeDue(cashTendered, cashDue) {
	const tendered = normalizeMajorPaymentAmount(cashTendered);
	const due = normalizeMajorPaymentAmount(cashDue);
	return normalizeMajorPaymentAmount(tendered - due);
}

/**
 * Valida montos de checkout (mixto, vuelto en efectivo).
 * @param {{ payment_mode?: string; payment_type?: string; cash_amount?: number; card_amount?: number; cash_tendered?: number; totalToPay?: number }} params
 * @returns {{ valid: boolean; reason?: string }}
 */
export function validateCheckoutPayment({
	payment_mode,
	payment_type,
	cash_amount,
	card_amount,
	cash_tendered,
	totalToPay,
}) {
	const total = normalizeMajorPaymentAmount(totalToPay);
	if (total <= 0) return { valid: true };

	if (payment_mode === 'mixed') {
		const cash = normalizeMajorPaymentAmount(cash_amount);
		const card = normalizeMajorPaymentAmount(card_amount);
		if (Math.abs(cash + card - total) > 0.000001) {
			return { valid: false, reason: 'split_mismatch' };
		}
		if (cash > 0) {
			const tendered = normalizeMajorPaymentAmount(cash_tendered);
			if (tendered < cash) {
				return { valid: false, reason: 'insufficient_tender' };
			}
		}
		return { valid: true };
	}

	if (!['tienda', 'tarjeta', 'online'].includes(String(payment_type ?? '').toLowerCase())) {
		return { valid: false, reason: 'payment_method_required' };
	}

	if (payment_type === 'tienda') {
		const tendered = normalizeMajorPaymentAmount(cash_tendered);
		if (tendered < total) {
			return { valid: false, reason: 'insufficient_tender' };
		}
	}

	return { valid: true };
}

/**
 * Devuelve la etiqueta a mostrar para el método de pago (usa payment_method_specific si existe).
 * @param {{ payment_type?: string; payment_method_specific?: string | null; payment_breakdown?: unknown }} order
 * @returns {string}
 */
export function getPaymentLabel(order) {
	if (!order) return '—';
	const currency = normalizeCurrencyCode(order.currency);
	if (Array.isArray(order.payment_lines) && order.payment_lines.length > 0) {
		const parts = order.payment_lines.map((line) => {
			const label = PAYMENT_METHOD_LABELS[line.methodId] ?? line.methodId ?? line.rail;
			return `${label} ${formatMoney(minorToMajor(Number(line.amountMinor ?? line.amount_minor) || 0, currency), { currency })}`;
		});
		return parts.length === 1 ? parts[0] : `Mixto (${parts.join(' + ')})`;
	}

	if (isMixedPaymentBreakdown(order.payment_breakdown)) {
		const b = normalizePaymentBreakdown(order.payment_breakdown);
		const parts = [];
		if (b.cash > 0) parts.push(`Ef. ${formatMoney(b.cash, { currency })}`);
		if (b.card > 0) parts.push(`Tarjeta ${formatMoney(b.card, { currency })}`);
		if (b.online > 0) parts.push(`Transf. ${formatMoney(b.online, { currency })}`);
		return parts.length ? `Mixto (${parts.join(' + ')})` : 'Mixto';
	}

	const specific = order.payment_method_specific;
	if (specific && PAYMENT_METHOD_LABELS[specific]) return PAYMENT_METHOD_LABELS[specific];
	const type = order.payment_type || '';
	if (type === 'online') return 'Transf.';
	if (type === 'tarjeta') return 'Tarjeta';
	if (type === 'tienda') return 'Efectivo';
	if (type === 'pendiente') return 'Pago pendiente';
	return type || '—';
}

/**
 * Etiqueta de pago para UI de sesión abierta: prioriza "Pago pendiente" si aún no se cobró.
 * @param {{ payment_type?: string; payment_method_specific?: string | null; payment_breakdown?: unknown }} order
 * @returns {string}
 */
export function getOrderPaymentDisplayLabel(order) {
	if (!order) return '—';
	if (order.payment_status === 'pending_verification') return 'Pago por verificar';
	if (order.payment_status === 'partial') return 'Pago parcial';
	if (order.payment_status === 'partially_refunded') return 'Pago parcialmente devuelto';
	if (order.payment_status === 'refunded') return 'Pago devuelto';
	if (isOrderPaymentDeferred(order)) return 'Pago pendiente';
	return getPaymentLabel(order);
}

/**
 * Preferencia de pago del menú (no implica cobro real). Solo cuando el cobro sigue pendiente.
 * @param {{ payment_type?: string; payment_method_specific?: string | null; payment_breakdown?: unknown }} order
 * @returns {string | null}
 */
export function getOrderPaymentPreferenceHint(order) {
	if (!order || !isOrderPaymentDeferred(order) || !isMenuOrder(order)) return null;
	const label = getPaymentLabel(order);
	if (!label || label === 'Pago pendiente') return null;
	return `Prefiere ${label.toLowerCase()}`;
}

/**
 * Indica si el pedido es pago online (transferencia, Zelle, etc.) — p. ej. comprobante / voucher.
 * @param {{ payment_type?: string; payment_method_specific?: string | null }} order
 * @returns {boolean}
 */
export function isOnlineOrder(order) {
	if (!order) return false;
	if (order.payment_type === 'online' || order.payment_type === 'transferencia') return true;
	const specific = String(order.payment_method_specific ?? '').trim().toLowerCase();
	return specific.length > 0 && TRANSFER_SPECIFIC_METHODS.has(specific);
}

/**
 * Pedido desde menú digital (el checkout persiste payment_method_specific).
 * @param {{ payment_method_specific?: string | null }} order
 * @returns {boolean}
 */
export function isMenuOrder(order) {
	if (!order) return false;
	if (order.manual_order_mode === 'quick_sale' || order.manual_order_mode === 'session') return false;
	const spec = String(order.payment_method_specific ?? '').trim();
	return spec.length > 0;
}

/** Pedido creado en panel/caja (p. ej. Pedido Manual), no menú público online. */
export function isPanelManualOrder(order) {
	return Boolean(order) && !isMenuOrder(order);
}

/**
 * Extrae el segmento "Nota: ..." de la descripción de un ítem (menú digital).
 * @param {string | null | undefined} description
 * @returns {string | null}
 */
export function extractLineNote(description) {
	if (!description || typeof description !== 'string') return null;
	const segment = description
		.split(' | ')
		.map((p) => p.trim())
		.find((p) => p.startsWith('Nota:'));
	if (!segment) return null;
	const text = segment.replace(/^Nota:\s*/i, '').trim();
	return text || null;
}

/**
 * Parsea líneas "Producto: nota" del resumen en orders.note (menú digital).
 * @param {string | null | undefined} orderNote
 * @returns {Array<{ productName: string, note: string }>}
 */
export function parseAggregatedLineNotes(orderNote) {
	if (!orderNote?.trim()) return [];
	return orderNote
		.split('\n')
		.map((l) => l.trim())
		.filter(
			(l) =>
				l &&
				!l.startsWith('[Sucursal:') &&
				!l.startsWith('[Envio:'),
		)
		.map((line) => {
			const colon = line.indexOf(':');
			if (colon <= 0) return null;
			return {
				productName: line.slice(0, colon).trim(),
				note: line.slice(colon + 1).trim(),
			};
		})
		.filter(Boolean);
}

/**
 * Resuelve la nota de cocina de un ítem: panel manual (item.note), menú (description) o fallback por nombre.
 * @param {Record<string, unknown> | null | undefined} item
 * @param {string | null | undefined} orderNote
 * @returns {string | null}
 */
export function resolveItemKitchenNote(item, orderNote) {
	const rawItemNote = item?.note;
	if (rawItemNote != null) {
		const s = typeof rawItemNote === 'string' ? rawItemNote : String(rawItemNote);
		const trimmed = s.trim();
		if (trimmed) return trimmed;
	}

	const fromDescription = extractLineNote(
		typeof item?.description === 'string' ? item.description : null,
	);
	if (fromDescription) return fromDescription;

	const aggregated = parseAggregatedLineNotes(orderNote);
	const name = String(item?.name ?? '').trim();
	if (!name) return null;
	const match = aggregated.find(
		(row) => row.productName.toLowerCase() === name.toLowerCase(),
	);
	return match?.note ?? null;
}

/**
 * Pedido antiguo con una sola nota global en orders.note (sin notas por ítem del menú nuevo).
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {boolean}
 */
export function isLegacyGlobalKitchenNote(order) {
	if (!order) return false;
	const items = Array.isArray(order.items) ? order.items : [];
	const anyLineNote = items.some((it) => resolveItemKitchenNote(it, null) != null);
	if (anyLineNote) return false;
	const aggregated = parseAggregatedLineNotes(
		typeof order.note === 'string' ? order.note : null,
	);
	if (aggregated.length > 0) return false;
	return Boolean(order.note && String(order.note).trim());
}

/**
 * Texto plano para pegar en WhatsApp o compartir el pedido.
 * @param {Record<string, unknown>} order
 * @param {string | null | undefined} branchName
 * @param {{ branch?: object | null; company?: object | null; exchangeRate?: unknown }} [shareLocale]
 * @returns {string}
 */
export function buildOrderWhatsAppShareText(order, branchName, shareLocale = {}) {
	if (!order) return '';
	const idPart = order.display_id ?? order.order_number ?? order.id;
	const header = idPart != null && idPart !== '' ? `Pedido ${idPart}` : 'Pedido';
	const lines = [String(header)];
	if (branchName) lines.push(`Local: ${branchName}`);
	lines.push(`Cliente: ${order.client_name || '—'}`);
	if (order.client_phone) lines.push(`Tel: ${order.client_phone}`);
	if (order.client_rut && String(order.client_rut).trim()) {
		const idLabel = shareIdLabelFromLocale(shareLocale);
		lines.push(`${idLabel}: ${String(order.client_rut).trim()}`);
	}
	lines.push(`Pago: ${getPaymentLabel(order)}`);
	const total = Number(order.total);
	if (Number.isFinite(total) && total > 0) {
		lines.push(`Total: ${formatOrderAmountForShare(order, shareLocale.branch, shareLocale.company, shareLocale.exchangeRate, total)}`);
	}
	const items = order.items;
	if (Array.isArray(items) && items.length > 0) {
		lines.push('Productos:');
		for (const it of items) {
			const qty = it.quantity ?? 1;
			const name = it.name ?? 'Ítem';
			const lineNote = resolveItemKitchenNote(it, order.note);
			lines.push(
				lineNote ? `• ${qty}x ${name} — Nota: ${lineNote}` : `• ${qty}x ${name}`,
			);
		}
	}
	if (isLegacyGlobalKitchenNote(order)) {
		lines.push(`Nota: ${String(order.note).trim()}`);
	}
	if (isOrderDelivery(order)) {
		const handoff =
			order.handoff_code != null && String(order.handoff_code).trim() !== ''
				? String(order.handoff_code).trim()
				: null;
		const fee = Number(order.delivery_fee);
		lines.push('');
		lines.push('— Envío —');
		if (handoff) {
			lines.push(`Código verificación (pedir al cliente): ${handoff}`);
		}
		if (Number.isFinite(fee) && fee > 0) {
			lines.push(`Cargo envío: ${formatOrderAmountForShare(order, shareLocale.branch, shareLocale.company, shareLocale.exchangeRate, fee)}`);
		}
		const addr = order.delivery_address;
		const addrLines = deliveryAddressLines(addr);
		if (addrLines.length > 0) {
			lines.push('Dirección:');
			for (const al of addrLines) {
				lines.push(al);
			}
		}
		const mapsUrl =
			addr && typeof addr === 'object' && !Array.isArray(addr) && addr.maps_url
				? String(addr.maps_url).trim()
				: '';
		if (mapsUrl) {
			lines.push(`Mapa: ${mapsUrl}`);
		}
	}
	return lines.join('\n');
}

/**
 * Texto listo para pegar al repartidor: dirección, mapa, contacto, código de verificación, totales.
 * @param {Record<string, unknown>} order
 * @param {string | null | undefined} branchName
 * @param {string | null | undefined} branchAddress Dirección del local (origen), opcional
 * @param {{ branch?: object | null; company?: object | null; exchangeRate?: unknown }} [shareLocale]
 * @returns {string}
 */
export function buildOrderDeliveryDriverPack(order, branchName, branchAddress = null, shareLocale = {}) {
	if (!order || !isOrderDelivery(order)) return '';
	const idPart = order.display_id ?? order.order_number ?? order.id;
	const lines = [];
	lines.push('ENTREGA A DOMICILIO');
	lines.push(`Pedido: ${idPart != null && idPart !== '' ? idPart : order.id}`);
	const handoff =
		order.handoff_code != null && String(order.handoff_code).trim() !== ''
			? String(order.handoff_code).trim()
			: null;
	if (handoff) {
		lines.push(`Código verificación (validar con el cliente): ${handoff}`);
	}
	if (branchName) {
		lines.push(`Local: ${branchName}`);
	}
	if (branchAddress && String(branchAddress).trim()) {
		lines.push(`Sale de: ${String(branchAddress).trim()}`);
	}
	lines.push('');
	lines.push('Dónde llevar');
	const addr = order.delivery_address;
	const addrLines = deliveryAddressLines(addr);
	if (addrLines.length > 0) {
		for (const al of addrLines) {
			lines.push(al);
		}
	} else {
		lines.push('(Sin dirección guardada en el pedido)');
	}
	const mapsUrl =
		addr && typeof addr === 'object' && !Array.isArray(addr) && addr.maps_url
			? String(addr.maps_url).trim()
			: '';
	if (mapsUrl) {
		lines.push('');
		lines.push(`Abrir en mapas: ${mapsUrl}`);
	}
	const lat =
		addr && typeof addr === 'object' && !Array.isArray(addr) && addr.lat != null
			? Number(addr.lat)
			: NaN;
	const lng =
		addr && typeof addr === 'object' && !Array.isArray(addr) && addr.lng != null
			? Number(addr.lng)
			: NaN;
	if (Number.isFinite(lat) && Number.isFinite(lng)) {
		lines.push(`Coordenadas: ${lat}, ${lng}`);
	}
	lines.push('');
	lines.push('Contacto');
	lines.push(`Nombre: ${order.client_name || '—'}`);
	if (order.client_phone) {
		const digits = String(order.client_phone).replace(/\D/g, '');
		lines.push(`Tel: ${order.client_phone}`);
		if (digits) {
			lines.push(`WhatsApp: https://wa.me/${digits}`);
		}
	}
	if (order.client_rut && String(order.client_rut).trim()) {
		const idLabel = shareIdLabelFromLocale(shareLocale);
		lines.push(`${idLabel}: ${String(order.client_rut).trim()}`);
	}
	lines.push('');
	lines.push('Pago y montos');
	lines.push(`Método: ${getPaymentLabel(order)}`);
	const fee = Number(order.delivery_fee);
	if (Number.isFinite(fee) && fee > 0) {
		lines.push(`Cargo envío: ${formatOrderAmountForShare(order, shareLocale.branch, shareLocale.company, shareLocale.exchangeRate, fee)}`);
	}
	const total = Number(order.total);
	if (Number.isFinite(total) && total > 0) {
		lines.push(`Total pedido: ${formatOrderAmountForShare(order, shareLocale.branch, shareLocale.company, shareLocale.exchangeRate, total)}`);
	}
	const items = order.items;
	if (Array.isArray(items) && items.length > 0) {
		lines.push('');
		lines.push('Qué lleva');
		for (const it of items) {
			const qty = it.quantity ?? 1;
			const name = it.name ?? 'Ítem';
			const lineNote = resolveItemKitchenNote(it, order.note);
			lines.push(
				lineNote ? `• ${qty}x ${name} — Nota: ${lineNote}` : `• ${qty}x ${name}`,
			);
		}
	}
	if (isLegacyGlobalKitchenNote(order)) {
		lines.push('');
		lines.push(`Nota: ${String(order.note).trim()}`);
	}
	return lines.join('\n');
}

/**
 * Slug de método de pago para CSS y desglose: 'cash' | 'card' | 'transfer'.
 * @param {{ payment_type?: string; payment_method_specific?: string | null }} order
 * @returns {'cash' | 'card' | 'transfer'}
 */
export function getPaymentSlug(order) {
	if (!order) return 'cash';
	const specific = String(order.payment_method_specific ?? '').trim().toLowerCase();
	if (specific.length > 0) {
		if (specific === 'efectivo') return 'cash';
		if (['tarjeta', 'stripe', 'mercadopago', 'paypal', 'card'].includes(specific)) {
			return 'card';
		}
		if (['transferencia_bancaria', 'pago_movil', 'zelle'].includes(specific)) {
			return 'transfer';
		}
		return 'cash';
	}
	const pt = String(order.payment_type ?? '').toLowerCase();
	if (pt === 'tarjeta' || pt === 'card') return 'card';
	if (pt === 'online' || pt === 'transferencia') return 'transfer';
	return 'cash';
}

/**
 * Método de pago para movimientos de caja (`cash` | `card` | `online`).
 * Si ya hay venta registrada, usa el mismo método para que venta y devolución cuadren.
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Array<{ type?: string; payment_method?: string | null }>} [existingMovements]
 * @returns {'cash' | 'card' | 'online'}
 */
export function getCashMovementPaymentMethod(order, existingMovements = []) {
	const sale = (existingMovements || []).find((m) => m?.type === 'sale');
	const fromSale = sale?.payment_method;
	if (fromSale === 'cash' || fromSale === 'card' || fromSale === 'online') {
		return fromSale;
	}
	if (!order) return 'cash';
	const specific = String(order.payment_method_specific ?? '').trim().toLowerCase();
	if (specific.length > 0) {
		if (specific === 'efectivo') return 'cash';
		if (['tarjeta', 'stripe', 'mercadopago', 'paypal', 'card'].includes(specific)) {
			return 'card';
		}
		if (['transferencia_bancaria', 'pago_movil', 'zelle'].includes(specific)) {
			return 'online';
		}
		return 'cash';
	}
	const pt = String(order.payment_type ?? '').toLowerCase();
	if (pt === 'online' || pt === 'transferencia') return 'online';
	if (pt === 'tarjeta' || pt === 'card') return 'card';
	return 'cash';
}

/**
 * Aplana delivery_address JSONB a campos del formulario (sin usar formatted_address como calle).
 * @param {unknown} addr
 * @returns {{ delivery_address: string; delivery_reference: string; delivery_named_area_id: string }}
 */
export function flattenDeliveryAddress(addr) {
	if (!addr || typeof addr !== 'object' || Array.isArray(addr)) {
		const line = typeof addr === 'string' ? addr.replace(/<[^>]*>?/gm, '').trim() : '';
		return {
			delivery_address: line,
			delivery_reference: '',
			delivery_named_area_id: '',
		};
	}
	const o = /** @type {Record<string, unknown>} */ (addr);
	const line =
		(typeof o.address === 'string' && o.address.trim()) ? o.address.trim()
			: (typeof o.street === 'string' && o.street.trim()) ? o.street.trim()
				: (typeof o.line1 === 'string' && o.line1.trim()) ? o.line1.trim()
					: (typeof o.line_1 === 'string' && o.line_1.trim()) ? o.line_1.trim()
						: '';
	const ref =
		(typeof o.reference === 'string' && o.reference.trim()) ? o.reference.trim()
			: (typeof o.street_detail === 'string' && o.street_detail.trim()) ? o.street_detail.trim()
				: (typeof o.referencia === 'string' && o.referencia.trim()) ? o.referencia.trim()
					: '';
	const nid =
		typeof o.named_area_id === 'string' ? o.named_area_id.trim() : '';
	return {
		delivery_address: line,
		delivery_reference: ref,
		delivery_named_area_id: nid,
	};
}

/** @param {string} line */
function looksPreformattedDeliveryLine(line) {
	if (!line) return false;
	return /\bzona\s*:/i.test(line) || /\bref\s*:/i.test(line) || line.includes(' · ');
}

/**
 * Objeto JSON persistido en orders.delivery_address para panel / tickets.
 * @param {{
 *   rawAddress?: unknown;
 *   deliveryReference?: unknown;
 *   namedAreaId?: string | null;
 *   namedAreaLabel?: string | null;
 * }} p
 * @returns {Record<string, unknown>}
 */
export function buildDeliveryAddressRecord(p) {
	const ref =
		typeof p.deliveryReference === 'string'
			? p.deliveryReference.replace(/<[^>]*>?/gm, '').trim()
			: '';
	const raw = p.rawAddress;
	if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
		const base = { ...(/** @type {Record<string, unknown>} */ (raw)) };
		const lineAddr =
			typeof base.address === 'string' ? base.address.trim() : '';
		if (ref) {
			base.reference = ref;
			base.street_detail = ref;
		}
		const nid =
			p.namedAreaId && String(p.namedAreaId).trim()
				? String(p.namedAreaId).trim()
				: typeof base.named_area_id === 'string'
					? base.named_area_id.trim()
					: '';
		const nlab =
			p.namedAreaLabel && String(p.namedAreaLabel).trim()
				? String(p.namedAreaLabel).trim()
				: typeof base.named_area_label === 'string'
					? base.named_area_label.trim()
					: '';
		if (nid) base.named_area_id = nid;
		if (nlab) base.named_area_label = nlab;

		const compound = looksPreformattedDeliveryLine(lineAddr);
		const parts = [];
		if (!compound) {
			if (nlab || base.named_area_label) {
				parts.push(`Zona: ${String(base.named_area_label ?? nlab ?? '').trim()}`);
			}
			if (lineAddr) parts.push(lineAddr);
			if (ref) parts.push(`Ref: ${ref}`);
		}
		const formatted = compound
			? lineAddr
			: parts.filter(Boolean).join(' · ') ||
				(typeof base.formatted_address === 'string' && String(base.formatted_address).trim()
					? String(base.formatted_address).trim()
					: lineAddr || ref || 'Delivery');
		base.formatted_address = formatted;
		if (!base.address || !String(base.address).trim()) {
			base.address = compound ? lineAddr : (lineAddr || formatted);
		} else if (lineAddr) {
			base.address = lineAddr;
		}
		if (ref) {
			base.reference = ref;
			base.street_detail = ref;
		}
		if (nid) base.named_area_id = nid;
		if (nlab) base.named_area_label = nlab;
		return base;
	}

	const lineAddr = typeof raw === 'string' ? raw.replace(/<[^>]*>?/gm, '').trim() : '';
	const nid =
		p.namedAreaId && String(p.namedAreaId).trim()
			? String(p.namedAreaId).trim()
			: '';
	const nlab =
		p.namedAreaLabel && String(p.namedAreaLabel).trim()
			? String(p.namedAreaLabel).trim()
			: '';

	const compound = looksPreformattedDeliveryLine(lineAddr);
	const parts = [];
	if (!compound) {
		if (nlab) parts.push(`Zona: ${nlab}`);
		if (lineAddr) parts.push(lineAddr);
		if (ref) parts.push(`Ref: ${ref}`);
	}
	const formatted = compound
		? lineAddr
		: parts.length > 0
			? parts.join(' · ')
			: lineAddr || nlab || ref || 'Delivery';

	/** @type {Record<string, unknown>} */
	const out = {
		formatted_address: formatted,
		address: lineAddr || formatted,
	};
	if (nid) out.named_area_id = nid;
	if (nlab) out.named_area_label = nlab;
	if (ref) {
		out.reference = ref;
		out.street_detail = ref;
	}
	return out;
}

/**
 * Una línea corta para Kanban (zona + referencia / dirección).
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {string}
 */
export function orderDeliveryKanbanSubtitle(order) {
	if (!order) return '';
	const lines = deliveryAddressLines(order.delivery_address);
	if (lines.length === 0) return '';
	return lines.slice(0, 2).join(' · ');
}

/**
 * Pedido con envío a domicilio (tabla orders: channel, delivery_address, delivery_fee).
 * `order_type` sale|refund es tipo de transacción, no fulfillment.
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {boolean}
 */
function parseDeliveryAddressField(addr) {
	if (addr == null) return null;
	if (typeof addr === 'object' && !Array.isArray(addr)) {
		return /** @type {Record<string, unknown>} */ (addr);
	}
	if (typeof addr === 'string') {
		const trimmed = addr.trim();
		if (!trimmed) return null;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return /** @type {Record<string, unknown>} */ (parsed);
			}
		} catch {
			return { address: trimmed };
		}
	}
	return null;
}

const TRANSACTION_ORDER_TYPES = new Set(['sale', 'refund']);

export function isOrderDelivery(order) {
	if (!order) return false;
	const ch = String(order.channel ?? '')
		.trim()
		.toLowerCase();
	if (ch === 'delivery') return true;
	if (ch === 'salon' || ch === 'mesa') return false;

	const t = String(order.order_type ?? '')
		.trim()
		.toLowerCase();
	if (!TRANSACTION_ORDER_TYPES.has(t)) {
		if (t === 'delivery' || t === 'envio' || t === 'envío' || t === 'despacho') {
			return true;
		}
	}

	const fee = Number(order.delivery_fee);
	if (Number.isFinite(fee) && fee > 0) {
		return true;
	}
	const addr = parseDeliveryAddressField(order.delivery_address);
	if (addr) {
		const vals = Object.values(addr).filter(
			(v) => v != null && String(v).trim() !== '',
		);
		if (vals.length > 0) return true;
	}
	if (typeof order.delivery_address === 'string' && order.delivery_address.trim() !== '') {
		return true;
	}
	if (order.handoff_code != null && String(order.handoff_code).trim() !== '') {
		return true;
	}

	const name = String(order.client_name ?? '')
		.trim()
		.toLowerCase();
	if (name === 'delivery') return true;

	if (ch === 'pickup') return false;
	return false;
}

export const ORDER_OPEN_STATUSES = ['pending', 'active', 'completed'];

/** Sesión local de caja aún abierta (mesa/retiro/delivery), excluye menú web online. */
export function isLocalOpenSessionOrder(order) {
	if (!order) return false;
	const status = String(order.status ?? '').trim().toLowerCase();
	if (!ORDER_OPEN_STATUSES.includes(status)) return false;
	const ch = String(order.channel ?? '').trim().toLowerCase();
	if (ch === 'online') return false;
	return true;
}

/**
 * Comprobante de transferencia subido (menú web).
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {boolean}
 */
function hasMenuOnlinePaymentReceipt(order) {
	const ref = order?.payment_ref;
	return typeof ref === 'string' && ref.startsWith('http');
}

/**
 * Pedido del menú web que aún no fue cobrado en caja (o sin comprobante de transferencia).
 * `payment_method_specific` y `payment_type` del menú son solo la preferencia del cliente,
 * no un cobro real: el pedido sigue pendiente hasta que caja registre el `payment_breakdown`.
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {boolean}
 */
export function isMenuOrderAwaitingPayment(order) {
	if (!isMenuOrder(order)) return false;

	if (isOnlineOrder(order)) {
		return !hasMenuOnlinePaymentReceipt(order);
	}

	const stored = order?.payment_breakdown;
	if (stored != null && typeof stored === 'object' && !Array.isArray(stored)) {
		const b = normalizePaymentBreakdown(stored);
		if (b.cash > 0 || b.card > 0 || b.online > 0) {
			return false;
		}
	}

	return true;
}

/** @param {unknown} raw @returns {number | null} */
function parseOptionalMinor(raw) {
	if (raw == null || raw === '') return null;
	const n = Number(raw);
	return Number.isSafeInteger(n) ? n : null;
}

/** @param {{ payment_type?: string }} order */
export function isOrderPaymentDeferred(order) {
	if (!order) return false;
	const balance = parseOptionalMinor(order.payment_balance_minor);
	if (balance != null) return balance > 0;
	if (['pending', 'pending_verification', 'partial'].includes(order.payment_status)) return true;
	if (order.payment_status === 'paid') return false;
	if (order.payment_timing === 'deferred') return true;
	if (order.payment_timing === 'immediate') return false;
	if (String(order.payment_type ?? '').trim().toLowerCase() === 'pendiente') return true;
	return isMenuOrderAwaitingPayment(order);
}

/** @param {Record<string, unknown>} order */
export function getOrderFulfillmentKind(order) {
	if (!order) return 'mesa';
	if (isOrderDelivery(order)) return 'moto';
	const ch = String(order.channel ?? '')
		.trim()
		.toLowerCase();
	if (ch === 'salon' || ch === 'mesa') return 'mesa';
	const name = String(order.client_name ?? '')
		.trim()
		.toLowerCase();
	if (name === 'salón' || name === 'salon') return 'mesa';
	// Mesa mesero: identidad CAJA genérica sin nombre "Retiro" (p. ej. channel pickup por regresión SQL).
	if (
		isLocalOpenSessionOrder(order) &&
		isCajaGenericIdentity(order?.client_rut, order?.client_phone) &&
		name !== 'retiro'
	) {
		return 'mesa';
	}
	return 'retiro';
}

/** @param {'mesa' | 'retiro' | 'moto'} kind */
export function getFulfillmentKindLabel(kind) {
	switch (kind) {
		case 'moto':
			return 'Delivery';
		case 'retiro':
			return 'Retiro';
		default:
			return 'Mesa';
	}
}

/**
 * Etiqueta visible en UI para delivery/retiro: origen del pedido (Web menú / PDV manual).
 * Mesa siempre devuelve "Mesa".
 * @param {Record<string, unknown>} order
 * @returns {'Mesa' | 'Web' | 'PDV'}
 */
export function getOrderFulfillmentDisplayLabel(order) {
	const kind = getOrderFulfillmentKind(order);
	if (kind === 'mesa') return 'Mesa';
	return isMenuOrder(order) ? 'Web' : 'PDV';
}

/** Defaults CAJA usados en UI de detalle (mismo valor que open mesa). */
const CAJA_GENERIC_RUT = '1-9';
const CAJA_GENERIC_PHONE = '+56 9 0000 0000';

function normalizePhoneDigitsForCompare(phone) {
	return String(phone ?? '').replace(/\D/g, '');
}

/** @param {string | null | undefined} rut @param {string | null | undefined} phone */
export function isCajaGenericIdentity(rut, phone) {
	const rutTrim = String(rut ?? '').trim();
	if (rutTrim !== CAJA_GENERIC_RUT) return false;
	const phoneDigits = normalizePhoneDigitsForCompare(phone);
	const cajaDigits = normalizePhoneDigitsForCompare(CAJA_GENERIC_PHONE);
	return phoneDigits.length > 0 && phoneDigits === cajaDigits;
}

/** RUT visible en detalle de pedido; oculta placeholders de sanitizeOrder y autogenerados. */
export function resolveOrderClientRutForDisplay(order) {
	const raw = order?.client_rut ?? order?.client_document ?? '';
	const trimmed = String(raw).trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (lower === 'sin rut') return null;
	if (/^sin-rut-/i.test(trimmed)) return null;
	return trimmed;
}

/** Teléfono visible en detalle de pedido. */
export function resolveOrderClientPhoneForDisplay(order) {
	const trimmed = String(order?.client_phone ?? '').trim();
	return trimmed || null;
}

function normalizeClientNameToken(name) {
	return String(name ?? '')
		.trim()
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '');
}

/** ¿Nombre legacy "Salón" de mesas abiertas antes del flujo mesero/cliente? */
export function isLegacySalonClientName(name) {
	return normalizeClientNameToken(name) === 'salon';
}

/**
 * Nombre de cliente/mesero para UI de detalle.
 * @returns {{ name: string, subtitle: string | null, isLegacySalon: boolean }}
 */
export function resolveOrderClientNameForDisplay(order, kind) {
	const raw = String(order?.client_name ?? '').trim();
	if (!raw) {
		if (kind === 'mesa') {
			return {
				name: 'Sin mesero asignado',
				subtitle: 'Mesa abierta sin nombre registrado',
				isLegacySalon: false,
			};
		}
		return { name: 'Sin nombre', subtitle: null, isLegacySalon: false };
	}
	if (kind === 'mesa' && isLegacySalonClientName(raw)) {
		return {
			name: 'Mesa en salón',
			subtitle: 'Pedido anterior sin mesero ni cliente registrado',
			isLegacySalon: true,
		};
	}
	return { name: raw, subtitle: null, isLegacySalon: false };
}

/**
 * Identidad del tile en vista Mesas.
 * Distingue pedido manual vs mesa abierta (mismo card, chrome distinto).
 * Regla: mesa solo si hay mesa física (table_id / table_number); PDV local sin mesa = manual.
 * @param {Record<string, unknown>} order
 * @param {{ tableCode?: string | null }} [opts]
 * @returns {{
 *   title: string,
 *   subtitle: string | null,
 *   kind: string,
 *   chromeKind: 'mesa' | 'manual' | 'retiro' | 'moto'
 * }}
 */
export function resolveTablesViewTileIdentity(order, opts = {}) {
	const kind = getOrderTileKind(order);
	const tableCode = String(opts.tableCode || order?.table_number || '').trim();
	const tableId = String(order?.table_id ?? '').trim();
	const clientName = String(order?.client_name ?? '').trim();
	const operatorRef = String(order?.operator_reference ?? '').trim();
	const displayName = String(order?.display_name ?? '').trim();
	const sameText = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

	const hasPhysicalTable = Boolean(tableCode || tableId);
	/** @type {'mesa' | 'manual' | 'retiro' | 'moto'} */
	let chromeKind;
	if (kind === 'moto') {
		chromeKind = 'moto';
	} else if (hasPhysicalTable) {
		chromeKind = 'mesa';
	} else if (isMenuOrder(order)) {
		chromeKind = kind === 'mesa' ? 'mesa' : 'retiro';
	} else {
		// Pedido manual / sesión local sin mesa física → no usar kind==='mesa'
		chromeKind = 'manual';
	}

	if (chromeKind === 'mesa' && hasPhysicalTable) {
		const code = tableCode || operatorRef || 'Mesa';
		const person =
			(clientName && !sameText(clientName, code) ? clientName : null)
			|| (operatorRef && !sameText(operatorRef, code) ? operatorRef : null)
			|| (displayName && !sameText(displayName, code) && !sameText(displayName, clientName) ? displayName : null);
		return {
			title: code,
			subtitle: person || 'Mesa',
			kind,
			chromeKind,
		};
	}

	const title =
		(chromeKind === 'manual' ? (clientName || displayName || operatorRef) : null)
		|| displayName
		|| clientName
		|| operatorRef
		|| (chromeKind === 'manual' ? 'Pedido manual' : getFulfillmentKindLabel(kind));

	const subtitle =
		chromeKind === 'manual'
			? 'Pedido manual'
			: chromeKind === 'retiro'
				? (isMenuOrder(order) ? 'Retiro web' : 'Retiro')
				: chromeKind === 'moto'
					? (isMenuOrder(order) ? 'Delivery web' : 'Delivery')
					: 'Mesa';

	return {
		title,
		subtitle: sameText(subtitle, title) ? null : subtitle,
		kind,
		chromeKind,
	};
}

/**
 * Progreso de entrega a partir de order_lines (quantity_served vs ordered - voided).
 * @param {Array<Record<string, unknown>> | null | undefined} lines
 * @returns {{ ordered: number, served: number, pending: number }}
 */
export function summarizeOrderLinesDelivery(lines) {
	let ordered = 0;
	let served = 0;
	for (const line of lines || []) {
		const voided = Number(line?.quantity_voided) || 0;
		const qtyOrdered = Math.max(0, (Number(line?.quantity_ordered) || 0) - voided);
		if (qtyOrdered <= 0) continue;
		ordered += qtyOrdered;
		if (String(line?.status ?? '').toLowerCase() === 'served') {
			served += qtyOrdered;
			continue;
		}
		served += Math.min(qtyOrdered, Math.max(0, Number(line?.quantity_served) || 0));
	}
	const pending = Math.max(0, ordered - served);
	return { ordered, served, pending };
}

/**
 * Leyenda del tile en vista Mesas: prioriza progreso de entrega sobre status de cocina.
 * @param {Record<string, unknown> | null | undefined} order
 * @param {{ ordered?: number, served?: number, pending?: number } | null | undefined} deliveryProgress
 * @returns {{ key: 'pending' | 'active' | 'completed' | 'parcial' | 'entregado', label: string }}
 */
export function resolveTableTileServiceBadge(order, deliveryProgress = null) {
	const ordered = Number(deliveryProgress?.ordered) || 0;
	const served = Number(deliveryProgress?.served) || 0;
	const pending = Number(deliveryProgress?.pending) || 0;

	if (ordered > 0) {
		if (pending === 0 && served > 0) {
			return { key: 'entregado', label: 'Entregado' };
		}
		if (served > 0 && pending > 0) {
			return { key: 'parcial', label: 'Parcial' };
		}
	}

	const status = String(order?.status ?? '').trim().toLowerCase();
	if (status === 'active') return { key: 'active', label: 'En cocina' };
	if (status === 'completed') return { key: 'completed', label: 'Listo' };
	return { key: 'pending', label: 'Nuevo' };
}

/** @param {Record<string, unknown>} order */
export function getOrderTileKind(order) {
	return getOrderFulfillmentKind(order);
}

/**
 * Desglose a persistir al cobrar un pedido del menú en caja (método único).
 * @param {string | null | undefined} paymentType
 * @param {number | string | null | undefined} total
 * @returns {PaymentBreakdown | null}
 */
export function buildSettlementPaymentBreakdown(paymentType, total) {
	const amount = normalizeMajorPaymentAmount(total);
	if (amount <= 0) return null;
	const method = paymentTypeToBreakdownMethod(paymentType);
	if (!method) return null;
	return {
		cash: method === 'cash' ? amount : 0,
		card: method === 'card' ? amount : 0,
		online: method === 'online' ? amount : 0,
	};
}

/**
 * Saldo a cobrar en minor units. Nunca trata `null`/`undefined` como 0 pendiente.
 * Un `payment_balance_minor` explícito (incluido 0 = liquidado) tiene prioridad.
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {number}
 */
export function resolveOrderDueMinor(order) {
	if (!order) return 0;
	const balance = parseOptionalMinor(order.payment_balance_minor);
	if (balance != null) return Math.max(0, balance);
	const totalMinor = parseOptionalMinor(order.total_minor);
	if (totalMinor != null && totalMinor > 0) return totalMinor;
	const currency = normalizeCurrencyCode(order.currency);
	const digits = fractionDigitsForCurrency(currency);
	try {
		return majorToMinor(order.total, currency, digits);
	} catch {
		return 0;
	}
}

/** Pedido con pago ya definido y listo para confirmar al cerrar. */
export function isOrderPaymentSettled(order) {
	const balance = parseOptionalMinor(order?.payment_balance_minor);
	if (balance != null) return balance === 0;
	if (order?.payment_status) return order.payment_status === 'paid';
	if (!order || isOrderPaymentDeferred(order)) return false;
	const breakdown = getOrderPaymentBreakdown(order);
	const total = breakdown.cash + breakdown.card + breakdown.online;
	return total > 0 || Boolean(order.payment_type && order.payment_type !== 'pendiente');
}

/**
 * Compatibilidad legacy: estados operativos en los que una venta ya pagada
 * debe comprobar que existe en caja. `registerSale` es idempotente por pedido.
 */
export function shouldRegisterPaidOrderAtStatus(order, nextStatus) {
	const status = String(nextStatus ?? '').trim().toLowerCase();
	return ['active', 'completed', 'picked_up'].includes(status) && isOrderPaymentSettled(order);
}

/** @param {Array<{ status?: string; branch_id?: string }>} orders @param {string | null | undefined} branchId */
export function countOpenOrderSessions(orders, branchId) {
	if (!branchId || branchId === 'all') return 0;
	return (orders || []).filter(
		(o) => o?.branch_id === branchId && ORDER_OPEN_STATUSES.includes(String(o?.status ?? '')),
	).length;
}

const TILE_KIND_SORT = { mesa: 0, retiro: 1, moto: 2 };

/** @param {Array<Record<string, unknown>>} orders */
export function filterOpenOrderSessions(orders) {
	return (orders || [])
		.filter((o) => ORDER_OPEN_STATUSES.includes(String(o?.status ?? '')))
		.sort((a, b) => {
			const ka = getOrderTileKind(a);
			const kb = getOrderTileKind(b);
			if (ka !== kb) return (TILE_KIND_SORT[ka] ?? 9) - (TILE_KIND_SORT[kb] ?? 9);
			return (Number(a.shift_sequence) || 0) - (Number(b.shift_sequence) || 0);
		});
}

/**
 * Texto legible de delivery_address (JSONB).
 * @param {unknown} addr
 * @returns {string[]}
 */
export function deliveryAddressLines(addr) {
	if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return [];
	const o = /** @type {Record<string, unknown>} */ (addr);
	const prefer = [
		'named_area_label',
		'zone_label',
		'formatted_address',
		'label',
		'address',
		'street',
		'line1',
		'line_1',
		'description',
		'reference',
		'street_detail',
		'referencia',
		'comuna',
		'commune',
		'city',
		'ciudad',
	];
	const lines = [];
	for (const k of prefer) {
		if (o[k] != null && String(o[k]).trim() !== '') {
			lines.push(`${String(o[k]).trim()}`);
		}
	}
	if (lines.length > 0) {
		const unique = [...new Set(lines)];
		return unique.filter((line, idx) => {
			const lower = line.toLowerCase();
			return !unique.some((other, j) => j !== idx && other.length > lower.length && other.toLowerCase().includes(lower));
		});
	}
	try {
		return [JSON.stringify(o, null, 2)];
	} catch {
		return [];
	}
}

/**
 * Saneamiento de pedidos desde la BD (items JSONB, total, client_*, status, etc.)
 * Usado en Admin y en hooks que parsean órdenes.
 */
/**
 * Abre WhatsApp con el mensaje listo para que quien envía elija al destinatario **dentro de WhatsApp**
 * (compartir nativo en móvil, o enlace sin número que abre la app / Web).
 *
 * @param {string} text
 * @param {{ onError?: (msg: string) => void }} [options]
 * @returns {Promise<boolean>}
 */
export async function shareDeliveryPackViaWhatsApp(text, options = {}) {
	const { onError } = options;
	const body = String(text ?? "").trim();
	if (!body) {
		onError?.("No hay datos de envío para enviar.");
		return false;
	}
	if (typeof window === "undefined") return false;

	try {
		if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
			await navigator.share({ text: body });
			return true;
		}
	} catch (err) {
		const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
		if (name === "AbortError") {
			return true;
		}
	}

	const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(body)}`;
	window.open(url, "_blank", "noopener,noreferrer");
	return true;
}

/** Código legible del cupón desde join embebido o campo legacy en memoria. */
export function resolveOrderCouponCode(rawOrder) {
	if (!rawOrder || typeof rawOrder !== 'object') return '';
	const joined = rawOrder.discount_coupons;
	if (joined && typeof joined === 'object' && !Array.isArray(joined)) {
		const code = joined.code;
		if (code != null && String(code).trim()) return String(code).trim();
	}
	if (rawOrder.coupon_code != null && String(rawOrder.coupon_code).trim()) {
		return String(rawOrder.coupon_code).trim();
	}
	return '';
}

/** Columnas escalares + JSON usadas por kanban, detalle e impresión. */
const ORDERS_PANEL_COLUMNS =
	'id, company_id, branch_id, client_id, client_name, client_rut, client_phone, status, created_at, updated_at, items, total, subtotal, tax_total, discount_total, currency, delivery_fee, delivery_address, channel, order_type, payment_type, payment_method_specific, payment_breakdown, payment_ref, discount_coupon_id, shift_id, shift_sequence, note, client_request_id, subtotal_minor, discount_total_minor, delivery_fee_minor, total_minor, payment_lines, manual_order_mode, payment_timing, payment_status, payment_balance_minor, payment_evidence_status, operator_reference, table_id, table_number';

/** Lista kanban / carga inicial: incluye items JSONB para mostrar productos sin expandir. */
const ORDERS_LIST_COLUMNS =
	'id, company_id, branch_id, client_id, client_name, client_rut, client_phone, status, created_at, updated_at, items, total, subtotal, tax_total, discount_total, currency, delivery_fee, delivery_address, channel, order_type, payment_type, payment_method_specific, payment_breakdown, payment_ref, discount_coupon_id, shift_id, shift_sequence, note, client_request_id, subtotal_minor, discount_total_minor, delivery_fee_minor, total_minor, payment_lines, manual_order_mode, payment_timing, payment_status, payment_balance_minor, payment_evidence_status, operator_reference, table_id, table_number';

/** Detalle de un pedido (single-row): incluye items JSONB. */
export const ORDERS_PANEL_SELECT = `${ORDERS_PANEL_COLUMNS}, discount_coupons(code)`;

/** Lista bulk sin items (kanban, historial, clientes). */
export const ORDERS_LIST_SELECT = `${ORDERS_LIST_COLUMNS}, discount_coupons(code)`;

/** Alias histórico para lecturas bulk; sin items JSONB. */
export const ORDERS_SELECT_WITH_COUPON = ORDERS_LIST_SELECT;

/** Analytics: métricas escalares sin items (hasta 5000 filas). */
export const ORDERS_ANALYTICS_METRICS_SELECT =
	'id, company_id, branch_id, status, created_at, total, total_minor, currency, delivery_fee, delivery_fee_minor, payment_type, payment_method_specific, payment_breakdown, payment_lines';

/** @deprecated Usar ORDERS_ANALYTICS_METRICS_SELECT */
export const ORDERS_ANALYTICS_SELECT = ORDERS_ANALYTICS_METRICS_SELECT;

/** Export Excel: solo columnas del reporte. */
export const ORDERS_EXPORT_SELECT =
	'created_at, client_name, client_rut, client_phone, items, total, payment_type, payment_method_specific, payment_breakdown, payment_ref';

/** Join embebido en movimientos de caja. */
export const ORDERS_MOVEMENT_JOIN_SELECT =
	'id, payment_type, payment_method_specific, payment_breakdown, payment_lines, client_name, total, total_minor, currency, status, shift_sequence, channel, delivery_fee, delivery_fee_minor, manual_order_mode, payment_timing, payment_status, payment_balance_minor, payment_evidence_status';

/** Relectura tras mover pedido en kanban (registro de venta en caja). */
export const ORDERS_CASH_REGISTER_SELECT =
	'id, total, total_minor, currency, payment_type, payment_breakdown, payment_lines, payment_method_specific, client_name, branch_id, status, delivery_fee, delivery_fee_minor, manual_order_mode, payment_timing, payment_status, payment_balance_minor, payment_evidence_status';

/** Búsqueda fuzzy por número de pedido (scan liviano). */
export const ORDERS_ID_SCAN_SELECT = 'id';

/** @param {{ has_discount?: boolean; discount_price?: number | null; price?: number; quantity?: number }} item */
export function getOrderItemLineTotal(item) {
	const unit =
		item?.has_discount && item?.discount_price != null && Number(item.discount_price) > 0
			? Number(item.discount_price)
			: Number(item?.price) || 0;
	
	let extrasTotal = 0;
	if (Array.isArray(item?.extras)) {
		for (const extra of item.extras) {
			const extraPrice = Number(extra?.price) || 0;
			const extraQty = Number(extra?.quantity) || 1;
			extrasTotal += extraPrice * extraQty;
		}
	}
	
	return (unit + extrasTotal) * Math.max(1, Number(item?.quantity) || 1);
}

function computeOrderItemsSubtotal(items) {
	const list = Array.isArray(items) ? items : [];
	return Math.round(list.reduce((sum, item) => sum + getOrderItemLineTotal(item), 0));
}

/** Meta de descuento por cupón para badges compactos (p. ej. OrderCard). */
export function getOrderCouponDiscountMeta(order) {
	if (!order || typeof order !== 'object') return null;

	const total = Number(order.total) || 0;
	const deliveryFee = isOrderDelivery(order) ? Number(order.delivery_fee) || 0 : 0;

	let discountTotal = Number(order.discount_total) || 0;
	if (discountTotal <= 0 && order.discount_coupon_id) {
		const subtotal = Number(order.subtotal) || computeOrderItemsSubtotal(order.items);
		if (subtotal > 0) {
			discountTotal = Math.max(0, subtotal + deliveryFee - total);
		}
	}
	if (discountTotal <= 0) return null;

	const originalTotal = Math.round((total + discountTotal) * 100) / 100;
	const discountPercent =
		originalTotal > 0 ? Math.round((discountTotal / originalTotal) * 100) : 0;

	if (discountPercent <= 0) return null;

	return { originalTotal, discountTotal, discountPercent };
}

export function sanitizeOrder(rawOrder) {
	if (!rawOrder) return null;

	let cleanItems = [];
	if (rawOrder.items) {
		if (Array.isArray(rawOrder.items)) {
			cleanItems = rawOrder.items;
		} else if (typeof rawOrder.items === 'string') {
			try {
				const parsed = JSON.parse(rawOrder.items);
				cleanItems = Array.isArray(parsed) ? parsed : [];
			} catch {
				cleanItems = [];
			}
		}
	}

	let deliveryAddress = rawOrder.delivery_address;
	if (typeof deliveryAddress === 'string') {
		const trimmed = deliveryAddress.trim();
		if (trimmed) {
			try {
				const parsed = JSON.parse(trimmed);
				deliveryAddress =
					parsed && typeof parsed === 'object' && !Array.isArray(parsed)
						? parsed
						: { address: trimmed };
			} catch {
				deliveryAddress = { address: trimmed };
			}
		} else {
			deliveryAddress = null;
		}
	}

	const normalized = {
		...rawOrder,
		items: cleanItems,
		delivery_address: deliveryAddress,
		channel: rawOrder.channel ?? null,
		total: Number(rawOrder.total) || 0,
		subtotal: Number(rawOrder.subtotal) || 0,
		tax_total: Number(rawOrder.tax_total) || 0,
		discount_total: Number(rawOrder.discount_total) || 0,
		currency: normalizeCurrencyCode(rawOrder.currency),
		discount_coupon_id: rawOrder.discount_coupon_id ?? null,
		coupon_code: resolveOrderCouponCode(rawOrder),
		delivery_fee: Number(rawOrder.delivery_fee) || 0,
		client_name: rawOrder.client_name || 'Cliente Desconocido',
		display_name: rawOrder.operator_reference || rawOrder.table_number || rawOrder.client_name || (rawOrder.manual_order_mode === 'session' ? 'Sesión sin referencia' : 'Cliente desconocido'),
		operator_reference: rawOrder.operator_reference ?? null,
		table_id: rawOrder.table_id ?? null,
		table_number: rawOrder.table_number ?? null,
		client_rut: rawOrder.client_rut || 'Sin RUT',
		client_phone: rawOrder.client_phone || '',
		status: rawOrder.status || 'pending',
		created_at: rawOrder.created_at || new Date().toISOString(),
		payment_type: rawOrder.payment_type || 'unknown',
		payment_method_specific: rawOrder.payment_method_specific ?? null,
		payment_breakdown: rawOrder.payment_breakdown
			? normalizePaymentBreakdown(rawOrder.payment_breakdown)
			: null,
		payment_lines: Array.isArray(rawOrder.payment_lines) ? rawOrder.payment_lines : [],
		subtotal_minor: parseOptionalMinor(rawOrder.subtotal_minor),
		discount_total_minor: parseOptionalMinor(rawOrder.discount_total_minor),
		delivery_fee_minor: parseOptionalMinor(rawOrder.delivery_fee_minor),
		total_minor: parseOptionalMinor(rawOrder.total_minor),
		payment_balance_minor: parseOptionalMinor(rawOrder.payment_balance_minor),
		payment_status: rawOrder.payment_status ?? null,
		payment_evidence_status: rawOrder.payment_evidence_status ?? null,
	};

	if (!normalized.channel && isOrderDelivery(normalized)) {
		normalized.channel = 'delivery';
	}

	return normalized;
}

/** @param {unknown} raw */
function rowIncludesItems(raw) {
	if (!raw || typeof raw !== 'object') return false;
	const items = /** @type {{ items?: unknown }} */ (raw).items;
	if (items == null) return false;
	if (Array.isArray(items)) return items.length > 0;
	if (typeof items === 'string') {
		const trimmed = items.trim();
		if (!trimmed || trimmed === '[]') return false;
		try {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) && parsed.length > 0;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Fusiona un row Realtime/RPC en el pedido ya cargado en memoria.
 * Conserva `items` hidratados cuando el payload no trae JSONB (publicación Realtime).
 *
 * @param {object | null | undefined} prevOrder
 * @param {object | null | undefined} rawRow
 * @returns {object | null}
 */
export function mergeOrderInMemory(prevOrder, rawRow) {
	const next = sanitizeOrder(rawRow);
	if (!next) return prevOrder ?? null;
	if (!prevOrder) return next;

	if (
		!rowIncludesItems(rawRow) &&
		Array.isArray(prevOrder.items) &&
		prevOrder.items.length > 0
	) {
		next.items = prevOrder.items;
	}

	if (
		!next.coupon_code &&
		prevOrder.coupon_code &&
		next.discount_coupon_id === prevOrder.discount_coupon_id
	) {
		next.coupon_code = prevOrder.coupon_code;
	}

	return next;
}
