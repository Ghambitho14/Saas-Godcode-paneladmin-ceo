import { computeDeliveryFee, effectiveDeliveryPricingMode } from '@/lib/delivery-settings';
import {
	buildPaymentBreakdownForOrder,
	getOrderFulfillmentKind,
	isCajaGenericIdentity,
	isLegacySalonClientName,
} from '@/shared/utils/orderUtils';

/** Defaults CAJA para documento/teléfono en sesiones locales (mesero o valores iniciales). */
export const OPEN_MESA_CAJA_DEFAULTS = {
	client_rut: '',
	client_phone: '',
};

/** Estado inicial del formulario de pedido manual / edición. */
export const MANUAL_ORDER_INITIAL_FORM_STATE = {
	client_name: '',
	client_rut: OPEN_MESA_CAJA_DEFAULTS.client_rut,
	client_phone: OPEN_MESA_CAJA_DEFAULTS.client_phone,
	// No asumir efectivo: tanto venta rápida como el cobro de una sesión
	// requieren que el operador confirme explícitamente el medio de pago.
	payment_type: '',
	payment_mode: 'single',
	cash_amount: 0,
	card_amount: 0,
	cash_tendered: '',
	order_type: 'pickup',
	// Pedido manual (quick_sale) arranca en retiro; Abrir mesa fuerza `mesa` en resetOpenMesaForm.
	local_fulfillment_mode: 'retiro',
	mesa_party_mode: 'cliente',
	delivery_address: '',
	delivery_reference: '',
	delivery_km: '',
	delivery_fee: 0,
	delivery_named_area_id: '',
	note: '',
	coupon_code: '',
	selected_client_id: '',
	charge_now: false,
	payment_lines: [],
	selected_table_id: '',
	selected_table_code: '',
};

/** Compatibilidad de símbolos legacy: V2 no persiste identidades genéricas. */
export const OPEN_MESA_DEFAULT_CLIENT_NAMES = {
	mesa: '',
	/** @deprecated use mesa */
	pickup: '',
	retiro: '',
	delivery: '',
};

/** Modos de fulfillment al abrir sesión local en caja. */
export const LOCAL_FULFILLMENT_MODES = ['mesa', 'retiro', 'delivery'];

/**
 * Detecta una intención de pago explícita sin asumir efectivo por defecto.
 * En V2 la fuente de verdad son las líneas; en legacy, el método seleccionado.
 */
export function hasManualOrderPaymentIntent(form) {
	if (form?.v2Enabled) {
		const lines = Array.isArray(form.payment_lines) ? form.payment_lines : [];
		if (lines.length === 0) return false;
		return lines.every((line) => {
			const trigger = String(line?.settlementTrigger ?? '').toLowerCase();
			if (line?.rail === 'cash' || trigger === 'cash_confirmation') {
				return Number(line?.tenderedAmountMinor ?? form?.cash_tendered) > 0
					|| form?.charge_now === true;
			}
			if (trigger === 'evidence_uploaded') {
				return Boolean(form?.receiptFile || form?.payment_ref);
			}
			if (trigger === 'manual_verification' || trigger === 'gateway_webhook') {
				return false;
			}
			return trigger === 'pos_confirmation' || line?.rail === 'card';
		});
	}
	const type = String(form?.payment_type ?? '').toLowerCase();
	if (form?.payment_mode === 'mixed') {
		const cashDue = Number(form?.cash_amount) || 0;
		const cashConfirmed = cashDue <= 0
			|| Number(form?.cash_tendered) >= cashDue
			|| form?.charge_now === true;
		return cashConfirmed && ((Number(form?.card_amount) || 0) > 0 || cashDue > 0);
	}
	if (type === 'tienda') {
		return Number(form?.cash_tendered) > 0 || form?.charge_now === true;
	}
	if (type === 'online') {
		return Boolean(form?.receiptFile || form?.payment_ref);
	}
	return type === 'tarjeta';
}

/**
 * Detecta si el operador ya eligió un método de pago (sin exigir cobro cerrado).
 * Distinto de hasManualOrderPaymentIntent: aquí basta con la selección.
 */
export function hasManualOrderPaymentMethodSelected(form) {
	if (form?.v2Enabled) {
		const lines = Array.isArray(form.payment_lines) ? form.payment_lines : [];
		return lines.length > 0;
	}
	if (form?.payment_mode === 'mixed') return true;
	const type = String(form?.payment_type ?? '').toLowerCase();
	return type === 'tienda' || type === 'tarjeta' || type === 'online';
}

/** Resuelve el modo local desde el formulario de pedido manual. */
export function getLocalFulfillmentMode(form) {
	const explicit = String(form?.local_fulfillment_mode ?? '').trim().toLowerCase();
	if (LOCAL_FULFILLMENT_MODES.includes(explicit)) return explicit;
	if (String(form?.order_type ?? '').toLowerCase() === 'delivery') return 'delivery';
	return 'retiro';
}

/** Reconstruye mesa | retiro | delivery desde un pedido persistido (`orders.channel`). */
export function deriveLocalFulfillmentFromOrder(order) {
	const kind = getOrderFulfillmentKind(order);
	if (kind === 'moto') return 'delivery';
	if (kind === 'mesa') return 'mesa';
	return 'retiro';
}

/** Infiere mesero | cliente al editar una sesión local de mesa. */
export function deriveMesaPartyModeFromOrder(order) {
	if (deriveLocalFulfillmentFromOrder(order) !== 'mesa') return 'cliente';
	if (String(order?.client_id ?? '').trim()) return 'cliente';
	if (isCajaGenericIdentity(order?.client_rut, order?.client_phone)) return 'mesero';
	const name = String(order?.client_name ?? '').trim();
	if (!name || isLegacySalonClientName(name)) return 'mesero';
	return 'cliente';
}

/** ¿Modo mesero en sesión local de mesa? */
export function isOpenMesaMeseroMode(form) {
	return getLocalFulfillmentMode(form) === 'mesa' && form?.mesa_party_mode === 'mesero';
}

function withCajaContactDefaults(fields = {}) {
	return {
		...fields,
		client_rut: OPEN_MESA_CAJA_DEFAULTS.client_rut,
		client_phone: OPEN_MESA_CAJA_DEFAULTS.client_phone,
	};
}

/**
 * Aplica mesa | retiro | delivery al formulario.
 * En venta rápida (`preserveClient`) conserva el cliente elegido; en abrir mesa
 * sigue usando identidad CAJA / mesero.
 */
export function applyLocalFulfillmentMode(prev, mode, options = {}) {
	const preserveClient = Boolean(options?.preserveClient);

	if (mode === 'delivery') {
		const next = {
			...prev,
			local_fulfillment_mode: 'delivery',
			mesa_party_mode: 'cliente',
			order_type: 'delivery',
		};
		if (preserveClient) return next;
		return withCajaContactDefaults({
			...next,
			client_name:
				prev.client_name === OPEN_MESA_DEFAULT_CLIENT_NAMES.mesa ||
				prev.client_name === OPEN_MESA_DEFAULT_CLIENT_NAMES.retiro ||
				!String(prev.client_name ?? '').trim()
					? OPEN_MESA_DEFAULT_CLIENT_NAMES.delivery
					: prev.client_name,
			selected_client_id: '',
		});
	}

	const base = {
		...prev,
		order_type: 'pickup',
		delivery_named_area_id: '',
		delivery_fee: 0,
		delivery_address: '',
		delivery_reference: '',
		delivery_km: '',
	};

	if (mode === 'mesa') {
		const mesaBase = {
			...base,
			local_fulfillment_mode: 'mesa',
			charge_now: false,
			payment_type: 'pendiente',
			payment_mode: 'single',
			cash_amount: 0,
			card_amount: 0,
			cash_tendered: '',
			payment_lines: [],
		};
		if (preserveClient) {
			return {
				...mesaBase,
				mesa_party_mode: prev.mesa_party_mode || 'cliente',
			};
		}
		return withCajaContactDefaults({
			...mesaBase,
			mesa_party_mode: 'mesero',
			client_name: '',
			selected_client_id: '',
		});
	}

	if (preserveClient) {
		return {
			...base,
			local_fulfillment_mode: 'retiro',
			mesa_party_mode: 'cliente',
		};
	}

	const retiroDefault = OPEN_MESA_DEFAULT_CLIENT_NAMES.retiro;
	const prevName = String(prev.client_name ?? '').trim();
	const keepCustomName =
		prevName &&
		prevName !== OPEN_MESA_DEFAULT_CLIENT_NAMES.mesa &&
		prevName !== OPEN_MESA_DEFAULT_CLIENT_NAMES.delivery &&
		prevName !== retiroDefault &&
		prevName !== 'CAJA';
	return withCajaContactDefaults({
		...base,
		local_fulfillment_mode: 'retiro',
		mesa_party_mode: 'cliente',
		client_name: keepCustomName ? prev.client_name : retiroDefault,
		selected_client_id: '',
	});
}

/** Alterna mesero | cliente dentro de una sesión local de mesa. */
export function applyMesaPartyMode(prev, mode) {
	if (mode === 'mesero') {
		return withCajaContactDefaults({
			...prev,
			local_fulfillment_mode: 'mesa',
			mesa_party_mode: 'mesero',
			order_type: 'pickup',
			client_name: '',
			selected_client_id: '',
		});
	}
	return withCajaContactDefaults({
		...prev,
		local_fulfillment_mode: 'mesa',
		mesa_party_mode: 'cliente',
		order_type: 'pickup',
		client_name: prev.client_name || '',
		selected_client_id: '',
	});
}

/** Resuelve el nombre de sesión en modo abrir mesa (fallback por tipo de pedido). */
export function resolveOpenMesaClientName(orderType, override = '', fulfillmentMode = null) {
	const custom = String(override ?? '').trim();
	if (custom) return custom;
	if (fulfillmentMode === 'retiro') return OPEN_MESA_DEFAULT_CLIENT_NAMES.retiro;
	if (fulfillmentMode === 'delivery') return OPEN_MESA_DEFAULT_CLIENT_NAMES.delivery;
	return OPEN_MESA_DEFAULT_CLIENT_NAMES.mesa;
}

/** Mensajes de error al previsualizar cupones (manual order + edición). */
export const COUPON_PREVIEW_ERR_MSG = {
	empty: '',
	invalid_coupon: 'Código no válido o cupón desactivado.',
	coupon_expired: 'Este cupón no está vigente.',
	coupon_min_subtotal: 'El subtotal no alcanza el mínimo del cupón.',
	coupon_wrong_client: 'Este cupón solo aplica con el teléfono del cliente autorizado.',
	coupon_usage_exhausted: 'Este cupón ya no tiene usos disponibles.',
	coupon_usage_exhausted_client: 'Este cupón ya fue usado con este teléfono.',
};

/** Normaliza order_type del pedido al valor del formulario (`pickup` | `delivery`). */
export function normalizeManualOrderType(raw) {
	const t = String(raw ?? 'pickup').trim().toLowerCase();
	if (t === 'delivery' || t === 'envio' || t === 'envío' || t === 'despacho') {
		return 'delivery';
	}
	return 'pickup';
}

/** Precio unitario efectivo de un ítem (descuento incluido). */
export function getEffectiveItemPrice(item) {
	if (item?.has_discount && item?.discount_price != null && Number(item.discount_price) > 0) {
		return Number(item.discount_price);
	}
	return Number(item?.price) || 0;
}

/**
 * Calcula tarifa de envío según config de sucursal y campos del formulario.
 * @returns {number|null} fee >= 0, null si no aplica o error de pricing (-1..-4)
 */
export function computeDeliveryFeeForForm(branchDeliveryCfg, subtotal, {
	orderType = 'pickup',
	namedAreaId = '',
	deliveryKm = '',
} = {}) {
	if (!branchDeliveryCfg || orderType !== 'delivery') return null;

	const safeSubtotal = Number(subtotal) || 0;
	const pricing = effectiveDeliveryPricingMode(branchDeliveryCfg);
	const zoneId = String(namedAreaId ?? '').trim();

	if (pricing === 'named') {
		if (!zoneId) return null;
		const r = computeDeliveryFee(branchDeliveryCfg, 0, safeSubtotal, { namedAreaId: zoneId });
		return r.fee >= 0 ? Math.round(r.fee * 100) / 100 : null;
	}

	if (pricing === 'external') return 0;

	const kmRaw = deliveryKm === '' || deliveryKm == null ? 0 : Number(String(deliveryKm).replace(',', '.'));
	const safeKm = Number.isFinite(kmRaw) && kmRaw >= 0 ? kmRaw : 0;
	const r = computeDeliveryFee(branchDeliveryCfg, safeKm, safeSubtotal);
	return r.fee >= 0 ? Math.round(r.fee * 100) / 100 : null;
}

/** Mensaje accionable para códigos de error de computeDeliveryFee (-1..-4). */
export function describeDeliveryFeeError(feeCode, branchDeliveryCfg) {
	const code = Number(feeCode);
	if (code === -1) {
		const maxKm = branchDeliveryCfg?.maxDeliveryKm;
		return maxKm != null
			? `La distancia supera el máximo permitido (${maxKm} km).`
			: 'La distancia supera el máximo permitido para delivery.';
	}
	if (code === -2) {
		const minOrder = branchDeliveryCfg?.minOrderSubtotal;
		return minOrder != null
			? `El pedido no alcanza el mínimo para delivery (${minOrder}).`
			: 'El pedido no alcanza el mínimo para delivery.';
	}
	if (code === -3) return 'Selecciona la zona de entrega.';
	if (code === -4) return 'La zona seleccionada ya no está disponible. Elige otra zona.';
	return null;
}

/** Resultado crudo de cotización (fee >= 0 o código de error). */
export function quoteDeliveryFeeRaw(branchDeliveryCfg, subtotal, {
	orderType = 'pickup',
	namedAreaId = '',
	deliveryKm = '',
} = {}) {
	if (!branchDeliveryCfg || orderType !== 'delivery') {
		return { fee: 0, waivedFreeShipping: false };
	}
	const safeSubtotal = Number(subtotal) || 0;
	const pricing = effectiveDeliveryPricingMode(branchDeliveryCfg);
	if (pricing === 'external') return { fee: 0, waivedFreeShipping: false };
	const zoneId = String(namedAreaId ?? '').trim();
	if (pricing === 'named') {
		return computeDeliveryFee(branchDeliveryCfg, 0, safeSubtotal, { namedAreaId: zoneId || null });
	}
	const kmRaw = deliveryKm === '' || deliveryKm == null ? 0 : Number(String(deliveryKm).replace(',', '.'));
	const safeKm = Number.isFinite(kmRaw) && kmRaw >= 0 ? kmRaw : 0;
	return computeDeliveryFee(branchDeliveryCfg, safeKm, safeSubtotal);
}

/** La zona se elige explícitamente y representa el destino tarifario completo. */
export function isManualNamedDeliveryMode(branchDeliveryCfg) {
	return Boolean(
		branchDeliveryCfg
		&& effectiveDeliveryPricingMode(branchDeliveryCfg) === 'named'
		&& (branchDeliveryCfg.namedAreas?.length ?? 0) > 0
		&& String(branchDeliveryCfg.namedAreaResolution ?? 'manual_select').toLowerCase() !== 'address_matched',
	);
}

/** Busca únicamente zonas habilitadas por la configuración actual de la sucursal. */
export function resolveSelectedNamedArea(branchDeliveryCfg, namedAreaId) {
	const zoneId = String(namedAreaId ?? '').trim();
	if (!zoneId || !Array.isArray(branchDeliveryCfg?.namedAreas)) return null;
	return branchDeliveryCfg.namedAreas.find((area) => String(area?.id ?? '').trim() === zoneId) ?? null;
}

/**
 * Construye el contrato de delivery para cotización y persistencia.
 * En selección manual no inventamos una segunda dirección: zona + referencia
 * forman una dirección canónica compatible con RPC, caja y tickets.
 */
export function buildManualDeliveryPayload(form, branchDeliveryCfg) {
	const zoneId = String(form?.delivery_named_area_id ?? '').trim();
	const reference = sanitizeManualOrderInput(form?.delivery_reference);
	const selectedArea = resolveSelectedNamedArea(branchDeliveryCfg, zoneId);
	const manualNamed = isManualNamedDeliveryMode(branchDeliveryCfg);
	let address = sanitizeManualOrderInput(form?.delivery_address);

	if (manualNamed) {
		const zoneLabel = sanitizeManualOrderInput(selectedArea?.name);
		address = zoneLabel
			? [`Zona: ${zoneLabel}`, reference ? `Ref: ${reference}` : ''].filter(Boolean).join(' · ')
			: '';
	}

	return {
		address,
		reference,
		zoneId: zoneId || null,
		km:
			form?.delivery_km === '' || form?.delivery_km == null
				? null
				: Number(String(form.delivery_km).replace(',', '.')),
	};
}

/** Error específico y accionable para el bloque de entrega. */
export function validateManualDeliveryDetails(form, branchDeliveryCfg) {
	if (String(form?.order_type ?? '').toLowerCase() !== 'delivery') return null;
	if (!branchDeliveryCfg) {
		return 'No se pudo validar la configuración de delivery. Reintenta.';
	}

	const pricing = effectiveDeliveryPricingMode(branchDeliveryCfg);
	const zoneId = String(form?.delivery_named_area_id ?? '').trim();
	const address = sanitizeManualOrderInput(form?.delivery_address);
	const reference = sanitizeManualOrderInput(form?.delivery_reference);
	const subtotal = Number(form?.total ?? form?.items_subtotal ?? 0) || 0;

	if (pricing === 'named') {
		if (!zoneId) return 'Selecciona la zona de entrega.';
		if (!resolveSelectedNamedArea(branchDeliveryCfg, zoneId)) {
			return 'La zona seleccionada ya no está disponible. Elige otra zona.';
		}
		if (isManualNamedDeliveryMode(branchDeliveryCfg)) {
			if (reference.length < 3) {
				return 'Indica una referencia dentro de la zona: calle, número, casa o punto de referencia.';
			}
		} else if (address.length < 5) {
			return 'La dirección de delivery es obligatoria.';
		}
	} else if (address.length < 5) {
		return 'La dirección de delivery es obligatoria.';
	}

	const quote = quoteDeliveryFeeRaw(branchDeliveryCfg, subtotal, {
		orderType: 'delivery',
		namedAreaId: zoneId,
		deliveryKm: form?.delivery_km,
	});
	const feeError = describeDeliveryFeeError(quote.fee, branchDeliveryCfg);
	if (feeError) return feeError;

	return null;
}

/** Estados de sesión local aún abiertos (no entregados ni cancelados). */
export const OPEN_ORDER_SESSION_STATUSES = new Set(['pending', 'active', 'completed']);

export function isOpenOrderSessionStatus(status) {
	return OPEN_ORDER_SESSION_STATUSES.has(String(status ?? '').toLowerCase());
}

/** Pago al abrir sesión local: pendiente o cobro inmediato (charge_now). */
export function resolveOpenMesaCheckoutPayment(form, checkoutTotal) {
	if (!form?.charge_now) {
		return { payment_type: 'pendiente', payment_breakdown: null };
	}
	return {
		payment_type: form.payment_type,
		payment_breakdown: buildPaymentBreakdownForOrder({
			payment_mode: form.payment_mode,
			payment_type: form.payment_type,
			cash_amount: form.cash_amount,
			card_amount: form.card_amount,
			total: checkoutTotal,
		}),
	};
}

/** Sanitiza texto libre del formulario de pedido manual. */
export function sanitizeManualOrderInput(text) {
	return text ? String(text).replace(/<[^>]*>/g, '').trim() : '';
}

/**
 * Documento vacío o placeholder de display (p. ej. sanitizeOrder → "Sin RUT").
 * No debe tratarse como valor editable ni bloquear validación.
 */
export function isBlankClientDocument(value) {
	const v = String(value ?? '').trim();
	if (!v) return true;
	return /^sin\s+rut$/i.test(v);
}

/** Teléfono con dígitos más allá del prefijo de país (p. ej. +56). */
export function phoneHasMeaningfulDigits(phone, prefix = '') {
	const valueDigits = String(phone ?? '').replace(/\D/g, '');
	const prefixDigits = String(prefix ?? '').replace(/\D/g, '');
	if (!valueDigits) return false;
	if (!prefixDigits) return valueDigits.length > 0;
	return valueDigits.length > prefixDigits.length;
}
