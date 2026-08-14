import { normalizeCurrencyCode } from '@/shared/utils/money';
import { formatOrderAmount } from '@/lib/money/order-amount';
import { escapeHtml } from './thermalUtils';
import {
	deliveryAddressLines,
	getFulfillmentKindLabel,
	getOrderFulfillmentKind,
	getPaymentLabel,
	isMenuOrder,
	isOrderDelivery,
	isOrderPaymentDeferred,
	isLegacyGlobalKitchenNote,
	resolveItemKitchenNote,
} from '@/shared/utils/orderUtils';

export function orderCurrency(order) {
	return normalizeCurrencyCode(order?.currency);
}

/**
 * @param {{
 *   branch?: object | null;
 *   company?: object | null;
 *   exchangeRate?: unknown;
 * }} [printOptions]
 */
export function createFmtOrder(printOptions = {}) {
	const branch = printOptions.branch ?? null;
	const company = printOptions.company ?? null;
	const exchangeRate = printOptions.exchangeRate;
	return (order, amount) => formatOrderAmount({
		order,
		branch,
		company,
		exchangeRate,
		amountUsd: amount,
		paymentMethod: order?.payment_method_specific,
		context: 'ticket',
	});
}

/**
 * @param {Record<string, unknown>} order
 * @returns {string}
 */
export function formatTicketDateTime(order) {
	const d = order?.created_at ? new Date(order.created_at) : new Date();
	if (Number.isNaN(d.getTime())) {
		return new Date().toLocaleString('es-CL', {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
	return d.toLocaleString('es-CL', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

/**
 * Fecha y hora con guión (estilo ticket cocina / Oishi): «29/03/2026 - 17:47».
 * @param {Record<string, unknown>} order
 * @returns {string}
 */
export function formatTicketDateTimeDash(order) {
	const d = order?.created_at ? new Date(order.created_at) : new Date();
	if (Number.isNaN(d.getTime())) {
		const n = new Date();
		return formatDateDashFromDate(n);
	}
	return formatDateDashFromDate(d);
}

/**
 * @param {Date} d
 */
export function formatDateDashFromDate(d) {
	const datePart = d.toLocaleDateString('es-CL', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	});
	const timePart = d.toLocaleTimeString('es-CL', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	return `${datePart} - ${timePart}`;
}

/**
 * @param {Record<string, unknown>} order
 * @returns {string}
 */
export function formatOrderNumberForTicket(order) {
	const raw =
		order?.shift_sequence ??
		order?.display_id ??
		order?.order_number ??
		order?.id;
	if (raw == null || raw === '') return '—';
	return String(raw);
}

/** Texto central del ticket cliente: Mesa / En el local / Domicilio. */
export function whereLabelForClientTicket(order) {
	const kind = getOrderFulfillmentKind(order);
	if (kind === 'moto') return 'Domicilio';
	if (kind === 'mesa') return 'Mesa';
	return 'En el local';
}

/** Fulfillment en ticket cocina: Mesa / Retiro / Delivery (mayúsculas para banda térmica). */
export function whereLabelForKitchenTicket(order) {
	return getFulfillmentKindLabel(getOrderFulfillmentKind(order)).toUpperCase();
}

/** Bloque compacto dirección/envío para tickets térmicos. */
export function deliveryShipmentSectionHtml(order, fmt) {
	if (!isOrderDelivery(order)) return '';
	const feeNum = Number(order?.delivery_fee);
	const feeLbl =
		Number.isFinite(feeNum) && feeNum > 0
			? fmt(order, feeNum)
			: 'GRATIS';
	const hc = order?.handoff_code;
	const codeLine =
		hc != null && String(hc).trim() !== ''
			? `<p class="c-delivery-meta">COD. VERIF: ${escapeHtml(String(hc).trim())}</p>`
			: '';
	const lines = deliveryAddressLines(order?.delivery_address);
	const addrInner = lines.length
		? lines
				.map((line) => `<p class="c-delivery-line">${escapeHtml(line)}</p>`)
				.join('')
		: '<p class="c-delivery-line">(Sin texto de ubicación guardado)</p>';
	return `
			<div class="c-delivery-box">
				<p class="c-delivery-heading">DATOS ENVÍO</p>
				<p class="c-delivery-meta">Cargo envío: ${escapeHtml(feeLbl)}</p>
				${codeLine}
				${addrInner}
			</div>`;
}

/**
 * Limpia los prefijos `[Sucursal: ...]` y `[Envío: $...]` que `createOrder`
 * inyecta en `note`. Esa metadata se usa internamente (asignacion de sucursal
 * + auditoria del envio) pero contamina la lectura del ticket:
 *   - Cocina ya sabe en que sucursal esta y no le importa el monto.
 *   - Caja muestra la sucursal en el header (h1) y el envio en la fila "Envío"
 *     del bloque de totales; repetirlo en la nota es ruido para el cliente.
 *
 * Se aplica al ticket de cocina y al ticket de caja, dejando intacta la
 * "nota real" que escribio el cajero.
 */
export function stripInternalNoteHints(rawNote) {
	if (!rawNote) return '';
	return String(rawNote)
		.replace(/^\s*\[Sucursal:[^\]]*\]\s*\n?/i, '')
		.replace(/\n?\[Envío:[^\]]*\]\s*$/i, '')
		.trim();
}

/** Nota por línea: panel manual (item.note), menú (description / orders.note). */
export function plainItemNote(item, order) {
	const note = resolveItemKitchenNote(item, order?.note);
	return note ?? '';
}

/**
 * Canal mostrado en «#n - En el local - WEB» (override opcional desde options).
 * @param {Record<string, unknown>} order
 * @param {string | null | undefined} override
 */
export function orderChannelForTicket(order, override) {
	const o = override != null ? String(override).trim() : '';
	if (o) return o;
	const ch = order?.order_channel != null ? String(order.order_channel).trim() : '';
	if (ch) return ch;
	return isMenuOrder(order) ? 'WEB' : 'PDV';
}

/**
 * @param {Record<string, unknown>} order
 * @returns {string} HTML escapado
 */
export function clientReferenceLineHtml(order) {
	const h = order?.handoff_code;
	if (h != null && String(h).trim() !== '') {
		return escapeHtml(`CL-${String(h).trim()}`);
	}
	const raw = order?.display_id ?? order?.order_number ?? order?.id;
	if (raw == null || raw === '') return '—';
	const compact = String(raw).replace(/-/g, '');
	return escapeHtml(compact.length > 12 ? `REF-${compact.slice(-10)}` : `REF-${compact}`);
}

/** Teléfono del cliente para ticket de caja (sin formatear de más: ya viene canonizado en BD). */
export function clientPhoneForTicket(order) {
	const raw = order?.client_phone;
	if (raw == null || raw === '') return '';
	return String(raw).trim();
}

/**
 * @param {Record<string, unknown>} order
 * @returns {{ itemsSubtotal: number, deliveryFee: number, grandTotal: number }}
 */
export function summarizeAmounts(order) {
	const items = order?.items || [];
	let itemsSubtotal = 0;
	for (const it of items) {
		const price = (it.has_discount && it.discount_price > 0)
			? Number(it.discount_price)
			: Number(it.price);
		if (!Number.isFinite(price)) continue;
		itemsSubtotal += price * (Number(it.quantity) || 1);

		// Agregar precio de extras
		if (Array.isArray(it.extras) && it.extras.length > 0) {
			for (const extra of it.extras) {
				const extraPrice = Number(extra.price) || 0;
				if (!Number.isFinite(extraPrice)) continue;
				itemsSubtotal += extraPrice * (Number(extra.quantity) || 1);
			}
		}
	}
	const deliveryFee = Number(order?.delivery_fee);
	const fee = Number.isFinite(deliveryFee) && deliveryFee > 0 ? deliveryFee : 0;
	const grandTotal = Number(order?.total) || 0;
	const discountTotal = Number(order?.discount_total) || 0;
	return { itemsSubtotal, deliveryFee: fee, grandTotal, discountTotal };
}

/**
 * @param {Record<string, unknown>} order
 * @returns {string}
 */
export function ticketPaymentStatusLabel(order) {
	if (isOrderPaymentDeferred(order)) {
		return 'pendiente';
	}
	if (order?.payment_type === 'online') {
		const ref = order?.payment_ref;
		if (!(typeof ref === 'string' && ref.startsWith('http'))) {
			return 'pendiente';
		}
	}
	return `pagado con ${getPaymentLabel(order)}`;
}

/**
 * Estilos base compartidos: negrita en todo el cuerpo (legible en térmicas).
 * @param {number} contentMm
 */
export function cssThermalBase(contentMm) {
	return `
		/* PDF / impresora de hoja: página estándar; el ticket ocupa todo el ancho útil. */
		@page {
			size: A4 portrait;
			margin: 12mm 14mm;
		}
		html {
			-webkit-text-size-adjust: 100%;
			text-size-adjust: 100%;
		}
		body {
			font-family: 'Courier New', 'Courier Prime', 'Liberation Mono', Consolas, monospace;
			font-size: 11pt;
			font-weight: 700;
			line-height: 1.38;
			width: 100%;
			max-width: min(100%, ${contentMm}mm);
			margin: 0 auto;
			padding: 3mm 2mm 4mm;
			color: #000;
			background: #fff;
			box-sizing: border-box;
			-webkit-print-color-adjust: exact;
			print-color-adjust: exact;
		}
		/* Sin itálica ni pesos livianos: en térmicas casi no se ven */
		body, body p, body span, body div, body h1, body h2, body small {
			font-style: normal !important;
			font-weight: 700 !important;
		}
		.ticket-brand {
			font-family: 'Arial Black', 'Helvetica Neue', Helvetica, Arial, sans-serif;
			font-weight: 900 !important;
			font-style: normal !important;
			letter-spacing: 0.06em;
			line-height: 1.15;
		}
		.rule-thick {
			border: none;
			border-top: 2px solid #000;
			margin: 3mm 0;
		}
		.rule-dots {
			border: none;
			border-top: 1px dotted #000;
			margin: 2.5mm 0;
		}
		@media print {
			body {
				max-width: 100% !important;
				width: 100% !important;
				margin: 0 !important;
				padding: 0 0 4mm !important;
				font-size: 12pt !important;
				-webkit-font-smoothing: none;
				font-smooth: never;
				text-rendering: geometricPrecision;
			}
			.c-logo {
				max-width: 52% !important;
			}
		}
	`;
}
