/**
 * Hook de edicion de pedidos existentes.
 *
 * Clona la API publica de `useManualOrder` pero arranca con un pedido ya
 * creado en la tabla `orders`. Al guardar llama `ordersService.updateOrder`
 * (UPDATE via RLS) en lugar de `createManualOrder`.
 *
 * Convenciones:
 * - `initialOrder.items` ya viene en formato carrito (id, name, price, quantity).
 * - `initialOrder.delivery_address` puede ser objeto JSONB con `address`,
 *   `reference`, `named_area_id`, `named_area_label`. Lo aplanamos para que el
 *   formulario lo edite como strings simples (igual que `useManualOrder`).
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { validateImageFile } from '@/shared/utils/supabaseStorage';
import { getFormStrategy } from '@/lib/geo/country-forms';
import { getCountryProfile, normalizeInternationalPhone } from '@/lib/geo/country-profiles';
import { majorToMinor, minorToMajor, parseMoneyInput, sumMinor, isoFractionDigits, formatMinor } from '@/lib/money/minor-units';
import { flattenDeliveryAddress, isOrderDelivery, isLocalOpenSessionOrder, resolveOrderCouponCode, isMixedPaymentBreakdown, normalizePaymentBreakdown, buildPaymentBreakdownForOrder } from '@/shared/utils/orderUtils';
import { ordersService } from '../admin/orders/services/orders';
import { manualOrderV2Service } from '../services/manualOrderV2Service';
import { orderLifecycleV3Service } from '../services/orderLifecycleV3Service';
import { normalizeManualOrderSettings } from '../domain/manual-order-settings';
import { queuePaymentEvidence, uploadQueuedPaymentEvidence } from '../services/paymentEvidenceOutbox';
import { supabase, TABLES } from '@/integrations/supabase';
import { buildCouponPreview } from '@/lib/discount-coupon';
import { canOverrideDeliveryFee } from '../utils/deliveryFeePermissions';
import {
	COUPON_PREVIEW_ERR_MSG,
	getEffectiveItemPrice,
	OPEN_MESA_CAJA_DEFAULTS,
	applyLocalFulfillmentMode,
	applyMesaPartyMode,
	deriveLocalFulfillmentFromOrder,
	deriveMesaPartyModeFromOrder,
	getLocalFulfillmentMode,
	isBlankClientDocument,
	isOpenMesaMeseroMode,
	normalizeManualOrderType,
	phoneHasMeaningfulDigits,
	resolveOpenMesaClientName,
	buildManualDeliveryPayload,
	sanitizeManualOrderInput,
	validateManualDeliveryDetails,
} from './manual-order/manualOrderShared';

function hasMesaSessionClientName(manualOrder) {
	if (isOpenMesaMeseroMode(manualOrder)) {
		return String(manualOrder.client_name ?? '').trim().length >= 2;
	}
	return (
		Boolean(String(manualOrder.selected_client_id ?? '').trim())
		|| String(manualOrder.client_name ?? '').trim().length >= 2
	);
}

/** Mismo mapeo de fulfillment que create V2 (`useManualOrder`). */
function toV2Fulfillment(form, isLocalSession) {
	if (form.order_type === 'delivery') return 'delivery';
	if (!isLocalSession) return 'pickup';
	return getLocalFulfillmentMode(form) === 'mesa' ? 'table' : 'pickup';
}

/** Payload de delivery para V3: null al salir de delivery (evitar `{}` ambiguo). */
function buildV3DeliveryPatch(form, branchDeliveryCfg, fulfillment) {
	if (fulfillment !== 'delivery') return null;
	const base = buildManualDeliveryPayload(form, branchDeliveryCfg);
	return {
		...base,
		fee: Number(form.delivery_fee) || 0,
	};
}

function totalItemsMajor(items, currency, fractionDigits) {
	return minorToMajor(sumMinor((items || []).map((item) => (
		majorToMinor(getEffectiveItemPrice(item), currency, fractionDigits) * (Number(item.quantity) || 1)
	))), currency, fractionDigits);
}

function buildInitialState(initialOrder, currency = 'CLP', fractionDigits = isoFractionDigits(currency)) {
	if (!initialOrder || typeof initialOrder !== 'object') {
		return {
			client_name: '',
			client_rut: '',
			client_phone: '',
			items: [],
			total: 0,
			payment_type: 'tienda',
			order_type: 'pickup',
			delivery_address: '',
			delivery_reference: '',
			delivery_km: '',
			delivery_fee: 0,
			delivery_named_area_id: '',
			note: '',
			coupon_code: '',
			selected_client_id: '',
		};
	}
	const items = Array.isArray(initialOrder.items) ? initialOrder.items.map((it) => ({
		...it,
		id: String(it.id ?? ''),
		line_id: it.line_id ?? it.lineId ?? null,
		name: String(it.name ?? ''),
		price: Number(it.price) || 0,
		has_discount: Boolean(it.has_discount),
		discount_price: it.discount_price ?? null,
		image_url: it.image_url ?? null,
		description: it.description ?? null,
		quantity: Math.max(1, Number(it.quantity) || 1),
		// Preservamos el comentario del item para que aparezca poblado cuando
		// reabren el pedido (originado en manual order o en una edicion previa).
		note: typeof it.note === 'string' ? it.note : '',
		manual_order_source: it.manual_order_source ?? null,
		is_extra: Boolean(it.is_extra),
	})) : [];

	const computedTotal = totalItemsMajor(items, currency, fractionDigits);

	const orderType = isOrderDelivery(initialOrder)
		? 'delivery'
		: normalizeManualOrderType(initialOrder.channel ?? 'pickup');
	const localFulfillmentMode = deriveLocalFulfillmentFromOrder(initialOrder);
	const mesaPartyMode = deriveMesaPartyModeFromOrder(initialOrder);
	const flatAddr = flattenDeliveryAddress(initialOrder.delivery_address);
	const storedBreakdown = isMixedPaymentBreakdown(initialOrder.payment_breakdown)
		? normalizePaymentBreakdown(initialOrder.payment_breakdown)
		: null;

	const rawRut = String(initialOrder.client_rut ?? '');
	return {
		client_name: String(localFulfillmentMode === 'mesa' ? (initialOrder.operator_reference ?? initialOrder.client_name ?? '') : (initialOrder.client_name ?? '')),
		client_rut: isBlankClientDocument(rawRut) ? '' : rawRut,
		client_phone: String(initialOrder.client_phone ?? ''),
		items,
		total: computedTotal,
		payment_type: String(initialOrder.payment_type ?? 'tienda'),
		payment_mode: storedBreakdown ? 'mixed' : 'single',
		cash_amount: storedBreakdown?.cash ?? 0,
		card_amount: storedBreakdown?.card ?? 0,
		cash_tendered: '',
		order_type: orderType,
		local_fulfillment_mode: localFulfillmentMode,
		mesa_party_mode: mesaPartyMode,
		delivery_address: orderType === 'delivery' ? flatAddr.delivery_address : '',
		delivery_reference: orderType === 'delivery' ? flatAddr.delivery_reference : '',
		delivery_km: '',
		delivery_fee: orderType === 'delivery' ? Number(initialOrder.delivery_fee) || 0 : 0,
		delivery_named_area_id: orderType === 'delivery' ? flatAddr.delivery_named_area_id : '',
		note: String(initialOrder.note ?? '').replace(/^\[Sucursal: [^\]]+\]\s*\n?/i, '').replace(/\n?\[Envío: [^\]]+\]/i, ''),
		coupon_code: resolveOrderCouponCode(initialOrder),
		selected_client_id: initialOrder.client_id != null ? String(initialOrder.client_id) : '',
	};
}

export const useOrderEdit = (
	showNotify,
	onSaved,
	onClose,
	branch,
	branchDeliveryCfg,
	initialOrder,
	resyncOrderSale = null,
	userRole = null,
	formCountry = 'CL',
) => {
	const strategy = useMemo(() => getFormStrategy(formCountry), [formCountry]);
	const currency = String(branch?.currency ?? initialOrder?.currency ?? 'CLP').toUpperCase();
	const fractionDigits = isoFractionDigits(currency, branch?.manual_order_settings?.currencyFractionDigits);
	const countryProfile = useMemo(() => getCountryProfile(formCountry, { currency }), [formCountry, currency]);
	const manualOrderSettings = useMemo(() => normalizeManualOrderSettings(branch?.manual_order_settings), [branch?.manual_order_settings]);
	const initialState = useMemo(
		() => buildInitialState(initialOrder, currency, fractionDigits),
		[initialOrder, currency, fractionDigits],
	);

	const initialIncludeDocument = !isBlankClientDocument(initialState.client_rut);
	const initialIncludePhone =
		initialState.order_type === 'delivery'
		|| initialState.local_fulfillment_mode === 'delivery'
		|| phoneHasMeaningfulDigits(initialState.client_phone, strategy.phonePrefix);

	const [manualOrder, setManualOrder] = useState(() => ({
		...initialState,
		client_rut: initialIncludeDocument ? initialState.client_rut : '',
		client_phone: initialIncludePhone ? initialState.client_phone : '',
	}));
	const [loading, setLoading] = useState(false);
	const [couponPreview, setCouponPreview] = useState(() => ({
		loading: false,
		discount: 0,
		message: '',
		variant: 'neutral',
	}));

	const [rutValid, setRutValid] = useState(() => {
		if (!initialIncludeDocument) return true;
		const rut = String(initialState.client_rut ?? '');
		return isBlankClientDocument(rut) || strategy.validateId(rut);
	});
	const [phoneValid, setPhoneValid] = useState(() => {
		if (!initialIncludePhone) return true;
		const phone = String(initialState.client_phone ?? '');
		if (!phoneHasMeaningfulDigits(phone, strategy.phonePrefix)) return true;
		return strategy.validatePhone(phone);
	});
	const [includeDocument, setIncludeDocumentState] = useState(() => initialIncludeDocument);
	const [includePhone, setIncludePhoneState] = useState(() => initialIncludePhone);

	const setIncludeDocument = useCallback((enabled) => {
		const next = Boolean(enabled);
		setIncludeDocumentState(next);
		if (!next) {
			setManualOrder((prev) => ({ ...prev, client_rut: '' }));
			setRutValid(true);
		}
	}, []);

	const setIncludePhone = useCallback((enabled) => {
		const next = Boolean(enabled);
		setIncludePhoneState(next);
		if (!next) {
			setManualOrder((prev) => ({ ...prev, client_phone: '' }));
			setPhoneValid(true);
		} else {
			setManualOrder((prev) => {
				const current = String(prev.client_phone ?? '').trim();
				if (current) return prev;
				return { ...prev, client_phone: strategy.phonePrefix };
			});
			setPhoneValid(true);
		}
	}, [strategy.phonePrefix]);

	const [receiptFile, setReceiptFile] = useState(null);
	const [receiptPreview, setReceiptPreview] = useState(null);

	const initialItemsSnapshot = useMemo(
		() => JSON.stringify(initialState.items),
		[initialState],
	);

	useEffect(() => {
		return () => {
			if (receiptPreview) URL.revokeObjectURL(receiptPreview);
		};
	}, [receiptPreview]);

	// Realtime u otros payloads pueden traer discount_coupon_id sin join del código.
	useEffect(() => {
		const couponId = initialOrder?.discount_coupon_id;
		const existingCode = resolveOrderCouponCode(initialOrder);
		if (!couponId || existingCode) return undefined;

		let cancelled = false;
		(async () => {
			const { data, error } = await supabase
				.from(TABLES.discount_coupons)
				.select('code')
				.eq('id', couponId)
				.maybeSingle();
			if (cancelled || error || !data?.code) return;
			setManualOrder((prev) => ({
				...prev,
				coupon_code: String(data.code).trim(),
			}));
		})();

		return () => {
			cancelled = true;
		};
	}, [initialOrder?.id, initialOrder?.discount_coupon_id, initialOrder?.discount_coupons, initialOrder?.coupon_code]);

	const getPrice = useCallback((product) => getEffectiveItemPrice(product), []);

	const applyClientRecord = useCallback(async (client) => {
		if (!client || typeof client !== 'object') return;

		const name = String(client.name ?? '').trim();
		const rutRaw = String(client.rut ?? client.document ?? '').trim();
		const rut = rutRaw ? strategy.formatId(rutRaw) : '';
		const normalizedPhone = normalizeInternationalPhone(client.phone, countryProfile.countryCode);
		const phone = normalizedPhone.valid ? normalizedPhone.e164 : String(client.phone ?? '').trim();
		const clientId = client.id != null ? String(client.id) : '';

		setManualOrder((prev) => ({
			...prev,
			client_name: name || prev.client_name,
			client_rut: rut || prev.client_rut,
			client_phone: phone || prev.client_phone,
			selected_client_id: clientId,
		}));

		if (rut) setIncludeDocumentState(true);
		if (phone && phoneHasMeaningfulDigits(phone, strategy.phonePrefix)) {
			setIncludePhoneState(true);
		}

		setRutValid(rut ? strategy.validateId(rut) : false);
		setPhoneValid(strategy.validatePhone(phone));
	}, [strategy, countryProfile.countryCode]);

	const updateClientName = (val, opts = {}) =>
		setManualOrder((prev) => {
			const next = { ...prev, client_name: val };
			if (!opts.fromClientSelect && prev.selected_client_id) {
				next.selected_client_id = '';
			}
			return next;
		});
	const updateCouponCode = (val) =>
		setManualOrder((prev) => ({ ...prev, coupon_code: typeof val === 'string' ? val : '' }));
	const updateNote = (val) => setManualOrder((prev) => ({ ...prev, note: val }));
	const updateOrderType = (val) => {
		if (val === 'delivery') setIncludePhone(true);
		setManualOrder((prev) => {
			if (val === 'pickup') {
				return {
					...prev,
					order_type: val,
					local_fulfillment_mode: 'retiro',
					delivery_named_area_id: '',
					delivery_fee: 0,
					delivery_address: '',
					delivery_reference: '',
					delivery_km: '',
				};
			}

			return {
				...prev,
				order_type: val,
				...(val === 'delivery' ? { local_fulfillment_mode: 'delivery' } : {}),
			};
		});
	};
	const updateLocalFulfillmentMode = (mode) => {
		if (mode === 'delivery') setIncludePhone(true);
		setManualOrder((prev) => applyLocalFulfillmentMode(prev, mode, { preserveClient: true }));
	};
	const updateMesaPartyMode = (mode) =>
		setManualOrder((prev) => applyMesaPartyMode(prev, mode));
	const updateDeliveryAddress = (val) =>
		setManualOrder((prev) => ({ ...prev, delivery_address: val }));
	const updateDeliveryReference = (val) =>
		setManualOrder((prev) => ({
			...prev,
			delivery_reference: typeof val === 'string' ? val : '',
		}));
	const updateDeliveryKm = (val) =>
		setManualOrder((prev) => ({
			...prev,
			delivery_km: val === '' || val == null ? '' : String(val),
		}));
	const updateDeliveryFee = useCallback(
		(val) => setManualOrder((prev) => ({ ...prev, delivery_fee: Number(val) || 0 })),
		[],
	);
	const updateDeliveryNamedAreaId = useCallback(
		(val) =>
			setManualOrder((prev) => ({
				...prev,
				delivery_named_area_id: typeof val === 'string' ? val : '',
			})),
		[],
	);

	const updatePaymentType = (type) => {
		setManualOrder((prev) => ({
			...prev,
			payment_type: type,
			payment_mode: 'single',
			cash_amount: 0,
			card_amount: 0,
			cash_tendered: '',
		}));
		if (type !== 'online') {
			setReceiptFile(null);
			setReceiptPreview((prev) => {
				if (prev) URL.revokeObjectURL(prev);
				return null;
			});
		}
	};

	const updatePaymentMode = (mode) => {
		setManualOrder((prev) => ({
			...prev,
			payment_mode: mode === 'mixed' ? 'mixed' : 'single',
			cash_amount: mode === 'mixed' ? prev.cash_amount : 0,
			card_amount: mode === 'mixed' ? prev.card_amount : 0,
			cash_tendered: '',
			...(mode === 'mixed' ? { payment_type: 'tienda' } : {}),
		}));
	};

	const updateCashAmount = (val) => {
		const parsed = val === '' || val == null ? { valid: true, minor: 0 } : parseMoneyInput(val, { currency, fractionDigits, locale: countryProfile.locale });
		if (parsed.valid) setManualOrder((prev) => ({ ...prev, cash_amount: minorToMajor(parsed.minor, currency, fractionDigits), cash_tendered: '' }));
	};

	const updateCardAmount = (val) => {
		const parsed = val === '' || val == null ? { valid: true, minor: 0 } : parseMoneyInput(val, { currency, fractionDigits, locale: countryProfile.locale });
		if (parsed.valid) setManualOrder((prev) => ({ ...prev, card_amount: minorToMajor(parsed.minor, currency, fractionDigits) }));
	};

	const updateCashTendered = (val) => {
		if (val === '' || val == null) {
			setManualOrder((prev) => ({ ...prev, cash_tendered: '' }));
			return;
		}
		const parsed = parseMoneyInput(val, { currency, fractionDigits, locale: countryProfile.locale });
		if (parsed.valid) setManualOrder((prev) => ({ ...prev, cash_tendered: minorToMajor(parsed.minor, currency, fractionDigits) }));
	};

	const handleRutChange = (e) => {
		const rawValue = e.target.value;
		const formatted = strategy.formatId(rawValue);
		setManualOrder((prev) => ({ ...prev, client_rut: formatted }));
		setRutValid(strategy.validateId(formatted));
	};

	const handlePhoneChange = (e) => {
		let cleaned = e.target.value;
		const prefix = strategy.phonePrefix;
		const prefixTrim = String(prefix ?? '').trim();
		if (prefixTrim && !cleaned.startsWith(prefixTrim) && cleaned.length < prefixTrim.length + 2) {
			cleaned = prefix;
		}
		const prefixDigits = prefixTrim.replace(/\D/g, '');
		const valueDigits = cleaned.replace(/\D/g, '');
		const isPrefixOnly = !valueDigits || valueDigits === prefixDigits;

		setManualOrder((prev) => ({
			...prev,
			client_phone: cleaned,
			...(prev.selected_client_id ? {
				selected_client_id: '',
			} : {}),
		}));
		setPhoneValid(isPrefixOnly || normalizeInternationalPhone(cleaned, countryProfile.countryCode).valid);
	};

	const handleFileChange = (e) => {
		const file = e.target.files[0];
		if (file) {
			const { valid, error: validationError } = validateImageFile(file);
			if (!valid) {
				showNotify?.(validationError || 'Archivo no válido', 'error');
				e.target.value = '';
				return;
			}
			if (receiptPreview) URL.revokeObjectURL(receiptPreview);
			setReceiptFile(file);
			setReceiptPreview(URL.createObjectURL(file));
		}
	};

	const removeReceipt = () => {
		setReceiptFile(null);
		setReceiptPreview((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
	};

	const addItem = useCallback(
		(product) => {
			setManualOrder((prev) => {
				const currentItems = prev.items || [];
				const exists = currentItems.find((i) => i.id === product.id);
				let newItems;
				if (exists) {
					if (exists.quantity >= 20) return prev;
					newItems = currentItems.map((i) =>
						i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i,
					);
				} else {
					newItems = [
						...currentItems,
						{
							id: product.id,
							name: product.name,
							price: product.price,
							has_discount: product.has_discount,
							discount_price: product.discount_price,
							image_url: product.image_url,
							description: product.description,
							quantity: 1,
							note: '',
							manual_order_source: product.manual_order_source || null,
							is_extra: product.manual_order_source === 'extras',
						},
					];
				}
				const newTotal = totalItemsMajor(newItems, currency, fractionDigits);
				return { ...prev, items: newItems, total: newTotal };
			});
		},
		[getPrice, currency, fractionDigits],
	);

	const updateQuantity = useCallback(
		(itemId, change) => {
			setManualOrder((prev) => {
				const item = prev.items.find((i) => i.id === itemId);
				if (!item) return prev;
				if (change > 0 && item.quantity >= 20) return prev;
				let newItems;
				if (item.quantity + change < 1) {
					newItems = prev.items.map((i) => (i.id === itemId ? { ...i, quantity: 1 } : i));
				} else {
					newItems = prev.items.map((i) =>
						i.id === itemId ? { ...i, quantity: i.quantity + change } : i,
					);
				}
				const newTotal = totalItemsMajor(newItems, currency, fractionDigits);
				return { ...prev, items: newItems, total: newTotal };
			});
		},
		[getPrice, currency, fractionDigits],
	);

	const removeItem = useCallback(
		(itemId) => {
			setManualOrder((prev) => {
				const newItems = prev.items.filter((i) => i.id !== itemId);
				const newTotal = totalItemsMajor(newItems, currency, fractionDigits);
				return { ...prev, items: newItems, total: newTotal };
			});
		},
		[getPrice, currency, fractionDigits],
	);

	// Comentario por item: nota corta destinada al ticket de cocina.
	// Limitada a 140 chars para que no rompa el ancho del ticket termico.
	const updateItemNote = useCallback((itemId, note) => {
		const next = typeof note === 'string' ? note.slice(0, 140) : '';
		setManualOrder((prev) => ({
			...prev,
			items: prev.items.map((i) => (i.id === itemId ? { ...i, note: next } : i)),
		}));
	}, []);

	/** No reseteamos a defaults: el modal de edicion no se reusa con otro pedido. */
	const resetOrder = useCallback(() => {
		const rut = String(initialState.client_rut ?? '');
		const phone = String(initialState.client_phone ?? '');
		const nextIncludeDocument = !isBlankClientDocument(rut);
		const nextIncludePhone =
			initialState.order_type === 'delivery'
			|| initialState.local_fulfillment_mode === 'delivery'
			|| phoneHasMeaningfulDigits(phone, strategy.phonePrefix);
		setManualOrder({
			...initialState,
			client_rut: nextIncludeDocument ? rut : '',
			client_phone: nextIncludePhone ? phone : '',
		});
		setReceiptFile(null);
		setReceiptPreview((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
		setRutValid(!nextIncludeDocument || isBlankClientDocument(rut) || strategy.validateId(rut));
		setPhoneValid(
			!nextIncludePhone
			|| !phoneHasMeaningfulDigits(phone, strategy.phonePrefix)
			|| normalizeInternationalPhone(phone, countryProfile.countryCode).valid,
		);
		setIncludeDocumentState(nextIncludeDocument);
		setIncludePhoneState(nextIncludePhone);
	}, [initialState, strategy, countryProfile.countryCode]);

	useEffect(() => {
		if (!branch?.company_id) {
			setCouponPreview((p) =>
				p.variant === 'neutral' && p.discount === 0 && !p.message && !p.loading
					? p
					: { loading: false, discount: 0, message: '', variant: 'neutral' },
			);
			return undefined;
		}
		const rawCode = String(manualOrder.coupon_code ?? '').trim();
		if (!rawCode) {
			setCouponPreview({ loading: false, discount: 0, message: '', variant: 'neutral' });
			return undefined;
		}
		let cancelled = false;
		const subtotalPreview = manualOrder.total;
		setCouponPreview({ loading: true, discount: 0, message: '', variant: 'neutral' });
		const tid = setTimeout(async () => {
			try {
				const pv = await buildCouponPreview({
					supabase,
					companyId: String(branch.company_id),
					rawCode,
					itemsSubtotal: subtotalPreview,
					clientPhone: String(manualOrder.client_phone ?? '').trim(),
					tablesCoupons: TABLES.discount_coupons,
					tablesClients: TABLES.clients,
					tablesRedemptions: TABLES.discount_coupon_redemptions,
					excludeOrderId: initialOrder?.id,
				});
				if (cancelled) return;
				if (!pv.ok) {
					setCouponPreview({
						loading: false,
						discount: 0,
						message: COUPON_PREVIEW_ERR_MSG[pv.key] || 'No se pudo validar el cupón.',
						variant: 'error',
					});
					return;
				}
				setCouponPreview({
					loading: false,
					discount: pv.discount,
					message: pv.discount > 0 ? 'Cupón válido (estimado; confirma al guardar).' : '',
					variant: pv.discount > 0 ? 'success' : 'neutral',
				});
			} catch {
				if (!cancelled) {
					setCouponPreview({
						loading: false,
						discount: 0,
						message: 'No se pudo validar el cupón.',
						variant: 'error',
					});
				}
			}
		}, 420);
		return () => {
			cancelled = true;
			clearTimeout(tid);
		};
	}, [branch?.company_id, initialOrder?.id, manualOrder.coupon_code, manualOrder.total, manualOrder.client_phone]);

	const submitOrder = async () => {
		if (!initialOrder?.id) {
			showNotify?.('Pedido inválido (sin id).', 'error');
			return;
		}
		if (!branch) {
			showNotify?.('Error: No hay sucursal seleccionada', 'error');
			return;
		}

		// En edicion las reglas son mas laxas que en creacion: hay pedidos
		// (sobre todo los que entran desde la web publica) que se crearon sin
		// RUT o con telefono incompleto. Solo exigimos nombre + items; RUT y
		// telefono se validan SOLO si el cajero los llena.
		const isLocalSession = isLocalOpenSessionOrder(initialOrder);
		if (isLocalSession) {
			if (!hasMesaSessionClientName(manualOrder) || manualOrder.items.length === 0) {
				showNotify?.('Faltan datos obligatorios (cliente/mesa o items).', 'error');
				return;
			}
		} else if (
			!manualOrder.client_name ||
			manualOrder.client_name.trim().length < 2 ||
			manualOrder.items.length === 0
		) {
			showNotify?.('Faltan datos obligatorios (nombre o items).', 'error');
			return;
		}
		if (manualOrder.order_type === 'delivery') {
			const deliveryError = validateManualDeliveryDetails(manualOrder, branchDeliveryCfg);
			if (deliveryError) {
				showNotify?.(deliveryError, 'error');
				return;
			}
		}
		const phoneRequired =
			includePhone
			|| manualOrder.order_type === 'delivery'
			|| getLocalFulfillmentMode(manualOrder) === 'delivery';
		const phoneRaw = phoneRequired ? String(manualOrder.client_phone || '').trim() : '';
		if (
			phoneRaw
			&& phoneHasMeaningfulDigits(phoneRaw, strategy.phonePrefix)
			&& !normalizeInternationalPhone(phoneRaw, countryProfile.countryCode).valid
		) {
			showNotify?.(`Teléfono inválido. Usa formato internacional ${countryProfile.phonePrefix}… o déjalo vacío si es opcional.`, 'error');
			return;
		}
		if (phoneRequired && !phoneHasMeaningfulDigits(phoneRaw, strategy.phonePrefix)) {
			// Delivery (y switch ON) exigen teléfono real; mesa/retiro con switch OFF ya limpiaron.
			if (manualOrder.order_type === 'delivery' || getLocalFulfillmentMode(manualOrder) === 'delivery') {
				showNotify?.(`Ingresa un teléfono válido con formato ${countryProfile.phonePrefix}…`, 'error');
				return;
			}
		}
		const rutRaw = includeDocument ? String(manualOrder.client_rut || '').trim() : '';
		if (rutRaw && !isBlankClientDocument(rutRaw) && !strategy.validateId(rutRaw)) {
			showNotify?.(`El ${strategy.idName} ingresado no es válido. Borralo o corrigelo.`, 'error');
			return;
		}

		const couponRaw = sanitizeManualOrderInput(manualOrder.coupon_code);
		if (couponRaw && couponPreview.loading) {
			showNotify?.('Espera a que se valide el cupón.', 'error');
			return;
		}
		if (couponRaw && couponPreview.variant === 'error') {
			showNotify?.(couponPreview.message || 'El cupón no es válido.', 'error');
			return;
		}

		setLoading(true);
		try {
			const openMesaMesero = isLocalSession && isOpenMesaMeseroMode(manualOrder);
			const clientName = isLocalSession
				? sanitizeManualOrderInput(
					resolveOpenMesaClientName(
						manualOrder.order_type,
						manualOrder.client_name,
						getLocalFulfillmentMode(manualOrder),
					),
				)
				: sanitizeManualOrderInput(manualOrder.client_name);
			const itemsForOrder = (manualOrder.items || []).map((item) => ({
				...item,
				id: item.id,
				line_id: item.line_id ?? item.lineId ?? null,
				name: String(item.name ?? ''),
				quantity: Number(item.quantity) || 1,
				price: Number(item.price) || 0,
				has_discount: Boolean(item.has_discount),
				discount_price:
					item.has_discount && item.discount_price != null
						? Number(item.discount_price)
						: null,
				description: item.description ? String(item.description) : null,
				// Persistimos `note` en el items jsonb. Lo lee SOLO el ticket
				// de cocina; el resync de inventario no lo usa.
				note: item.note ? sanitizeManualOrderInput(String(item.note)).slice(0, 140) : null,
				manual_order_source: item.manual_order_source || null,
				is_extra: Boolean(item.is_extra),
			}));

			const deliveryFeeAmt =
				manualOrder.order_type === 'delivery' ? (Number(manualOrder.delivery_fee) || 0) : 0;
			const couponDisc =
				couponPreview?.variant === 'success' && Number(couponPreview.discount) > 0
					? Math.min(manualOrder.total, Number(couponPreview.discount))
					: 0;
			const checkoutMinor = Math.max(0, majorToMinor(manualOrder.total, currency, fractionDigits) - majorToMinor(couponDisc, currency, fractionDigits))
				+ majorToMinor(deliveryFeeAmt, currency, fractionDigits);
			const checkoutTotal = minorToMajor(checkoutMinor, currency, fractionDigits);

			const initialBreakdown = isMixedPaymentBreakdown(initialOrder.payment_breakdown)
				? normalizePaymentBreakdown(initialOrder.payment_breakdown)
				: null;

			const deliveryPayload = buildManualDeliveryPayload(manualOrder, branchDeliveryCfg);
			const resolvedPhone = (() => {
				if (isLocalSession && openMesaMesero) return OPEN_MESA_CAJA_DEFAULTS.client_phone;
				if (!phoneRequired) return '';
				const raw = sanitizeManualOrderInput(manualOrder.client_phone);
				if (!phoneHasMeaningfulDigits(raw, strategy.phonePrefix)) return '';
				return normalizeInternationalPhone(raw, countryProfile.countryCode).e164 || raw;
			})();
			const resolvedRut = (() => {
				if (isLocalSession && openMesaMesero) return OPEN_MESA_CAJA_DEFAULTS.client_rut;
				if (!includeDocument || isBlankClientDocument(manualOrder.client_rut)) return '';
				return sanitizeManualOrderInput(manualOrder.client_rut);
			})();
			const sanitizedPatch = {
				client_name: clientName,
				client_phone: resolvedPhone,
				client_rut: resolvedRut,
				note: sanitizeManualOrderInput(manualOrder.note),
				order_type: manualOrder.order_type,
				local_fulfillment_mode: getLocalFulfillmentMode(manualOrder),
				items: itemsForOrder,
				payment_type: isLocalSession
					? String(initialOrder.payment_type ?? 'pendiente')
					: manualOrder.payment_type,
				delivery_address_base:
					manualOrder.order_type === 'delivery' ? initialOrder.delivery_address : null,
				delivery_address:
					manualOrder.order_type === 'delivery' ? (deliveryPayload.address || '') : '',
				delivery_reference:
					manualOrder.order_type === 'delivery' ? (deliveryPayload.reference || '') : '',
				delivery_named_area_id:
					manualOrder.order_type === 'delivery' ? deliveryPayload.zoneId : null,
				delivery_fee: manualOrder.order_type === 'delivery' ? Number(manualOrder.delivery_fee) || 0 : 0,
				delivery_km:
					manualOrder.order_type === 'delivery' ? deliveryPayload.km : null,
				coupon_code: sanitizeManualOrderInput(manualOrder.coupon_code) || '',
				payment_breakdown: isLocalSession
					? initialBreakdown
					: buildPaymentBreakdownForOrder({
						payment_mode: manualOrder.payment_mode,
						payment_type: manualOrder.payment_type,
						cash_amount: manualOrder.cash_amount,
						card_amount: manualOrder.card_amount,
						total: checkoutTotal,
					}),
			};

			const itemsChanged = JSON.stringify(itemsForOrder) !== initialItemsSnapshot;

			const isV2Order = initialOrder.manual_order_mode === 'quick_sale' || initialOrder.manual_order_mode === 'session';
			const hasLifecycleLines = itemsForOrder.some((item) => Boolean(item.line_id));
			const useLifecycleV3 = isV2Order || hasLifecycleLines;
			const v2Fulfillment = toV2Fulfillment(manualOrder, isLocalSession);
			const v2Delivery = buildV3DeliveryPatch(manualOrder, branchDeliveryCfg, v2Fulfillment);
			let updated;
			if (useLifecycleV3) {
				const previousTotalMinor = Number(initialOrder.total_minor ?? majorToMinor(initialOrder.total, currency, fractionDigits));
				let expectedTotalMinor = checkoutMinor;
				if (branch?.id) {
					try {
						const quote = await manualOrderV2Service.quote({
							branchId: branch.id,
							items: itemsForOrder,
							fulfillment: v2Fulfillment,
							delivery: v2Delivery,
							couponCode: sanitizedPatch.coupon_code,
							clientPhone: sanitizedPatch.client_phone,
						});
						const quotedMinor = Number(quote?.totalMinor);
						if (Number.isFinite(quotedMinor)) {
							expectedTotalMinor = quotedMinor;
						}
					} catch {
						// Si la cotización falla, seguimos con el total local; el RPC revalida igual.
					}
				}
				if (
					expectedTotalMinor !== previousTotalMinor
					&& !window.confirm(
						`El nuevo total es ${formatMinor(expectedTotalMinor, { currency, fractionDigits })}. ¿Confirmas el cambio?`,
					)
				) {
					return;
				}
				const lifecycleResult = await orderLifecycleV3Service.updateOrder({
					orderId: initialOrder.id,
					expectedUpdatedAt: initialOrder.updated_at,
					patch: {
						clientName: sanitizedPatch.client_name,
						clientPhone: sanitizedPatch.client_phone,
						clientDocument: sanitizedPatch.client_rut,
						items: itemsForOrder,
						note: sanitizedPatch.note,
						fulfillment: v2Fulfillment,
						operatorReference: v2Fulfillment === 'table' ? sanitizedPatch.client_name : null,
						delivery: v2Delivery,
						couponCode: sanitizedPatch.coupon_code,
						expectedTotalMinor,
					},
				});
				updated = lifecycleResult?.order ?? lifecycleResult;
			} else {
				updated = await ordersService.updateOrder(initialOrder.id, sanitizedPatch, {
				itemsChanged,
				prevTotal: Number(initialOrder.total) || 0,
				prevStatus: String(initialOrder.status ?? ''),
				prevCouponCode: initialOrder.coupon_code,
				companyId: branch.company_id,
				branchSettings: branchDeliveryCfg,
				branchName: branch.name,
				logoUrl: null,
				showNotify,
				callerRole: userRole,
				});
			}

			let evidencePending = false;
			if (receiptFile) {
				if (isV2Order) {
					const evidenceRows = await manualOrderV2Service.listEvidence(initialOrder.id);
					if (evidenceRows.length === 0) {
						const receipt = await ordersService.replaceOrderReceipt(initialOrder, receiptFile);
						updated = {
							...updated,
							payment_ref: receipt.path,
							payment_evidence_status: receipt.attachment?.status ?? 'uploaded',
							payment_status: receipt.attachment?.paymentStatus ?? updated.payment_status,
						};
					} else {
						for (const [index, evidence] of evidenceRows.entries()) {
							const queued = await queuePaymentEvidence({
								evidenceId: evidence.id,
								companyId: branch.company_id,
								branchId: branch.id,
								orderId: initialOrder.id,
								file: receiptFile,
								previousPath: evidence.storage_path ?? (index === 0 ? initialOrder.payment_ref ?? null : null),
							});
							const upload = await uploadQueuedPaymentEvidence(queued);
							if (!upload.ok) evidencePending = true;
						}
					}
				} else {
					const receipt = await ordersService.replaceOrderReceipt(initialOrder, receiptFile);
					updated = {
						...updated,
						payment_ref: receipt.path,
						payment_evidence_status: receipt.attachment?.status ?? 'uploaded',
						payment_status: receipt.attachment?.paymentStatus ?? updated.payment_status,
					};
				}
			}

			const status = String(updated?.status ?? '').toLowerCase();
			let cashSynced = false;
			if (!isV2Order &&
				['active', 'completed', 'picked_up'].includes(status) &&
				typeof resyncOrderSale === 'function'
			) {
				const { ok, appliedCount } = await resyncOrderSale(updated);
				if (!ok) {
					showNotify?.(
						'Pedido guardado, pero no se pudo ajustar la caja. Revisa manualmente.',
						'warning',
					);
				} else if (appliedCount > 0) {
					showNotify?.('Pedido y caja actualizados.', 'success');
					cashSynced = true;
				}
			}

			if (!cashSynced) {
				showNotify?.(evidencePending ? 'Pedido actualizado · comprobante pendiente.' : 'Pedido actualizado.', evidencePending ? 'warning' : 'success');
			}
			if (onSaved) onSaved(updated);
			if (onClose) onClose();
		} catch (error) {
			if (error?.code === 'order_changed') {
				void manualOrderV2Service.recordMetric({
					branchId: branch?.id,
					eventName: 'edit_conflict',
					mode: initialOrder?.manual_order_mode ?? 'session',
					fulfillment: initialOrder?.operator_reference ? 'table' : initialOrder?.order_type === 'delivery' ? 'delivery' : 'pickup',
				});
			}
			showNotify?.(error?.message || 'Error al guardar pedido', 'error');
		} finally {
			setLoading(false);
		}
	};

	const isValid = useMemo(() => {
		return manualOrder.client_name && manualOrder.items.length > 0;
	}, [manualOrder]);
	const manualOrderView = useMemo(() => ({
		...manualOrder,
		manualOrderSettings,
		currency,
		fractionDigits,
		locale: countryProfile.locale,
		cashDenominations: { ...countryProfile.cashDenominations, ...manualOrderSettings.cashDenominations },
	}), [manualOrder, manualOrderSettings, currency, fractionDigits, countryProfile.locale, countryProfile.cashDenominations]);

	const getInputStyle = (isValid) => {
		if (isValid === true) return { borderColor: '#4f5bff', boxShadow: '0 0 0 1px #4f5bff' };
		if (isValid === false) return { borderColor: '#c31d2d', boxShadow: '0 0 0 1px #c31d2d' };
		return {};
	};

	return {
		manualOrder: manualOrderView,
		loading,
		rutValid,
		phoneValid,
		includeDocument,
		includePhone,
		setIncludeDocument,
		setIncludePhone,
		receiptFile,
		receiptPreview,
		updateClientName,
		updateCouponCode,
		couponPreview,
		updateNote,
		updatePaymentType,
		updatePaymentMode,
		updateCashAmount,
		updateCardAmount,
		updateCashTendered,
		handleRutChange,
		handlePhoneChange,
		applyClientRecord,
		handleFileChange,
		removeReceipt,
		addItem,
		updateQuantity,
		removeItem,
		updateItemNote,
		updateOrderType,
		updateLocalFulfillmentMode,
		updateMesaPartyMode,
		updateDeliveryAddress,
		updateDeliveryReference,
		updateDeliveryKm,
		updateDeliveryFee,
		updateDeliveryNamedAreaId,
		submitOrder,
		resetOrder,
		isValid,
		getInputStyle,
	};
};
