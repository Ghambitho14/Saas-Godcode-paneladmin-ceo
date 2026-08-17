import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useManualOrderCart } from './manual-order/useManualOrderCart';
import { useManualOrderForm } from './manual-order/useManualOrderForm';
import { useCouponValidation } from './manual-order/useCouponValidation';
import { useReceiptUpload } from './manual-order/useReceiptUpload';
import { createManualOrder } from '../admin/orders/services/orders';
import { resolveEffectiveCountry, resolveEffectiveCurrency } from '@/lib/geo/tenant-locale';
import { getFormStrategy } from '@/lib/geo/country-forms';
import { getCountryProfile, normalizeInternationalPhone, validateProfileDocument } from '@/lib/geo/country-profiles';
import { localeForCurrency, fractionDigitsForCurrency } from '@/shared/utils/money';
import { majorToMinor, minorToMajor, sumMinor } from '@/lib/money/minor-units';
import { buildPaymentBreakdownForOrder } from '@/shared/utils/orderUtils';
import { effectiveDeliveryPricingMode } from '@/lib/delivery-settings';
import { canOverrideDeliveryFee } from '../utils/deliveryFeePermissions';
import { normalizeManualOrderSettings, requirementsFor } from '../domain/manual-order-settings';
import { normalizePaymentMethods, validatePaymentLines } from '../domain/payment-methods';
import { manualOrderV2Service, isManualOrderV2Enabled } from '../services/manualOrderV2Service';
import { queuePaymentEvidence, uploadQueuedPaymentEvidence } from '../services/paymentEvidenceOutbox';
import { maybeSaveClientDefaultDeliveryAddress } from '../services/clientService';
import { createClientUuid } from '@/shared/utils/supabaseStorage';
import {
	sanitizeManualOrderInput,
	buildManualDeliveryPayload,
	computeDeliveryFeeForForm,
	resolveOpenMesaClientName,
	getLocalFulfillmentMode,
	hasManualOrderPaymentIntent,
	isBlankClientDocument,
	isOpenMesaMeseroMode,
	phoneHasMeaningfulDigits,
	validateManualDeliveryDetails,
	OPEN_MESA_CAJA_DEFAULTS,
} from './manual-order/manualOrderShared';

function toV2Fulfillment(form, _openMesaMode) {
	if (form.order_type === 'delivery' || getLocalFulfillmentMode(form) === 'delivery') return 'delivery';
	if (getLocalFulfillmentMode(form) === 'mesa') return 'table';
	return 'pickup';
}

function toV2Mode(openMesaMode, fulfillment) {
	if (openMesaMode || fulfillment === 'table') return 'session';
	return 'quick_sale';
}

function buildItems(items) {
	return (items || []).map((item) => ({
		id: item.id,
		name: String(item.name ?? ''),
		quantity: Math.max(1, Number(item.quantity) || 1),
		price: Number(item.price) || 0,
		has_discount: Boolean(item.has_discount),
		discount_price: item.has_discount && item.discount_price != null ? Number(item.discount_price) : null,
		description: item.description ? String(item.description) : null,
		note: item.note ? sanitizeManualOrderInput(String(item.note)).slice(0, 140) : null,
		manual_order_source: item.manual_order_source || null,
		is_extra: Boolean(item.is_extra),
	}));
}

function deriveV2PaymentLines(form, quote, methods, currency, fractionDigits) {
	if (Array.isArray(form.payment_lines) && form.payment_lines.length > 0) return form.payment_lines;
	if (!quote || form.payment_type === 'pendiente') return [];
	const byRail = (rail) => methods.find((method) => method.rail === rail && method.currency === currency);
	if (form.payment_mode === 'mixed') {
		const cashMinor = majorToMinor(form.cash_amount, currency, fractionDigits);
		const cardMinor = majorToMinor(form.card_amount, currency, fractionDigits);
		return [
			...(cashMinor > 0 && byRail('cash') ? [{ id: createClientUuid(), methodId: byRail('cash').id, rail: 'cash', amountMinor: cashMinor, currency, evidencePolicy: byRail('cash').evidencePolicy, settlementTrigger: byRail('cash').settlementTrigger }] : []),
			...(cardMinor > 0 && byRail('card') ? [{ id: createClientUuid(), methodId: byRail('card').id, rail: 'card', amountMinor: cardMinor, currency, evidencePolicy: byRail('card').evidencePolicy, settlementTrigger: byRail('card').settlementTrigger }] : []),
		];
	}
	const rail = form.payment_type === 'tienda' ? 'cash' : form.payment_type === 'tarjeta' ? 'card' : 'online';
	const method = byRail(rail) ?? methods.find((candidate) => candidate.rail === rail);
	if (!method || method.currency !== currency) return [];
	return [{ id: createClientUuid(), methodId: method.id, rail, amountMinor: Number(quote.totalMinor), currency, evidencePolicy: method.evidencePolicy, settlementTrigger: method.settlementTrigger }];
}

/** Orquesta creación manual V2 y conserva el contrato público usado por el modal legacy. */
export const useManualOrder = (
	showNotify,
	onOrderSaved,
	onClose,
	branch,
	branchDeliveryCfg = null,
	userRole = null,
	openMesaMode = false,
	localOrderChannels = null,
	companyProfile = null,
	manualSettingsRaw = null,
	branchPaymentMethods = null,
	branchConfigError = null,
) => {
	const formCountry = useMemo(() => resolveEffectiveCountry(branch, companyProfile), [branch, companyProfile]);
	const currency = useMemo(() => resolveEffectiveCurrency(branch, companyProfile), [branch, companyProfile]);
	const manualOrderSettings = useMemo(() => normalizeManualOrderSettings(manualSettingsRaw ?? branch?.manual_order_settings, localOrderChannels), [manualSettingsRaw, branch?.manual_order_settings, localOrderChannels]);
	const fractionDigits = useMemo(() => fractionDigitsForCurrency(currency, manualOrderSettings.currencyFractionDigits), [currency, manualOrderSettings.currencyFractionDigits]);
	const formStrategy = useMemo(() => getFormStrategy(formCountry), [formCountry]);
	const countryProfile = useMemo(() => getCountryProfile(formCountry, { currency }), [formCountry, currency]);
	const locale = useMemo(() => countryProfile.locale || localeForCurrency(currency), [countryProfile.locale, currency]);
	const v2Enabled = isManualOrderV2Enabled({ ...branch, manual_order_settings: manualOrderSettings });
	const effectiveBranchConfigError = branchConfigError || (
		v2Enabled
		&& countryProfile.countryCode == null
		&& !/^[A-Z]{3}$/.test(String(branch?.currency ?? companyProfile?.currency ?? '').trim().toUpperCase())
			? 'La sucursal o empresa debe configurar una moneda ISO para este país.'
			: null
	);
	const paymentMethods = useMemo(
		() => {
			const configured = branchPaymentMethods || branch?.payment_methods || [];
			return normalizePaymentMethods(configured.length ? configured : countryProfile.suggestedPaymentMethods, { accountingCurrency: currency });
		},
		[branchPaymentMethods, branch?.payment_methods, countryProfile.suggestedPaymentMethods, currency],
	);
	const clientRequestIdRef = useRef(createClientUuid());
	const submitInFlightRef = useRef(false);

	const {
		items, total, totalMinor, addItem, updateQuantity, removeItem, updateItemNote, resetCart, restoreCart,
	} = useManualOrderCart([], {
		currency,
		fractionDigits,
		onLimitReached: (item) => showNotify?.(`${item.name}: máximo 20 unidades por pedido.`, 'warning'),
	});

	const {
		form, rutValid, phoneValid, includeDocument, includePhone, setIncludeDocument, setIncludePhone,
		updateClientName, updateCouponCode, updateNote, updateOrderType,
		updateLocalFulfillmentMode, updateMesaPartyMode, updateDeliveryAddress, updateDeliveryReference,
		updateDeliveryKm, updateDeliveryFee, updateDeliveryNamedAreaId, updatePaymentType, updatePaymentMode,
		updateCashAmount, updateCardAmount, updateCashTendered, updateChargeNow, updatePaymentLines,
		handleRutChange, handlePhoneChange, applyClientRecord, resetForm, resetOpenMesaForm,
		selectTable, getInputStyle, restoreForm,
	} = useManualOrderForm(localOrderChannels, formCountry, { currency, locale, fractionDigits }, openMesaMode);

	const { couponPreview, resetCoupon } = useCouponValidation(branch?.company_id, form.coupon_code, total, form.client_phone);
	const { receiptFile, receiptPreview, handleFileChange, removeReceipt, resetReceipt, restoreReceipt } = useReceiptUpload(showNotify);
	const [loading, setLoading] = useState(false);
	const [quote, setQuote] = useState(null);
	const [quoteLoading, setQuoteLoading] = useState(false);
	const [quoteError, setQuoteError] = useState(null);
	const [quoteRevisionPending, setQuoteRevisionPending] = useState(false);
	const lastQuoteRef = useRef(null);

	const resetOrder = useCallback(() => {
		resetCart();
		if (openMesaMode) resetOpenMesaForm(); else resetForm();
		resetCoupon();
		resetReceipt();
		setQuote(null);
		setQuoteError(null);
		setQuoteRevisionPending(false);
		lastQuoteRef.current = null;
		clientRequestIdRef.current = createClientUuid();
	}, [resetCart, resetForm, resetOpenMesaForm, resetCoupon, resetReceipt, openMesaMode]);

	const handlePaymentTypeChange = useCallback((type) => {
		updatePaymentType(type);
		updatePaymentLines([]);
		if (type !== 'online') resetReceipt();
	}, [updatePaymentType, updatePaymentLines, resetReceipt]);

	const handleChargeNowChange = useCallback((enabled) => {
		updateChargeNow(enabled);
		if (!enabled) resetReceipt();
	}, [updateChargeNow, resetReceipt]);

	const syncDeliveryFeeFromForm = useCallback((formState, itemsSubtotal) => {
		if (!branchDeliveryCfg || formState.order_type !== 'delivery') return null;
		return computeDeliveryFeeForForm(branchDeliveryCfg, itemsSubtotal, {
			orderType: formState.order_type,
			namedAreaId: formState.delivery_named_area_id,
			deliveryKm: formState.delivery_km,
		});
	}, [branchDeliveryCfg]);

	useEffect(() => {
		if (form.order_type !== 'delivery' || !branchDeliveryCfg) return;
		const nextFee = syncDeliveryFeeFromForm(form, total);
		if (nextFee != null && Number(form.delivery_fee) !== nextFee) updateDeliveryFee(nextFee);
	}, [form, total, branchDeliveryCfg, syncDeliveryFeeFromForm, updateDeliveryFee]);

	const handleUpdateLocalFulfillmentMode = useCallback((mode) => {
		updateLocalFulfillmentMode(mode, branchDeliveryCfg, total);
		if (mode === 'delivery' && branchDeliveryCfg) {
			const fee = computeDeliveryFeeForForm(branchDeliveryCfg, total, { orderType: 'delivery', namedAreaId: form.delivery_named_area_id, deliveryKm: form.delivery_km });
			if (fee != null) updateDeliveryFee(fee);
		}
	}, [updateLocalFulfillmentMode, updateDeliveryFee, branchDeliveryCfg, total, form.delivery_named_area_id, form.delivery_km]);

	const handleUpdateOrderType = useCallback((value, config = branchDeliveryCfg, subtotal = total) => {
		updateOrderType(value, config, subtotal);
		if (openMesaMode && !String(form.selected_client_id ?? '').trim()) updateClientName(resolveOpenMesaClientName(value));
	}, [updateOrderType, branchDeliveryCfg, total, openMesaMode, form.selected_client_id, updateClientName]);

	const handleUpdateDeliveryNamedAreaId = useCallback((value) => {
		updateDeliveryNamedAreaId(value);
		if (!branchDeliveryCfg || form.order_type !== 'delivery') return;
		const fee = computeDeliveryFeeForForm(branchDeliveryCfg, total, {
			orderType: 'delivery',
			namedAreaId: value,
			deliveryKm: form.delivery_km,
		});
		// No forzar 0 cuando la cotización falla (mínimo, zona inválida, etc.):
		// se deja el fee previo y validateManualDeliveryDetails bloquea el avance.
		if (fee != null) updateDeliveryFee(fee);
		else if (!String(value ?? '').trim()) updateDeliveryFee(0);
	}, [updateDeliveryNamedAreaId, updateDeliveryFee, branchDeliveryCfg, form.order_type, form.delivery_km, total]);

	const handleUpdateDeliveryKm = useCallback((value) => {
		updateDeliveryKm(value);
		if (!branchDeliveryCfg || form.order_type !== 'delivery' || effectiveDeliveryPricingMode(branchDeliveryCfg) !== 'distance') return;
		const fee = computeDeliveryFeeForForm(branchDeliveryCfg, total, { orderType: 'delivery', namedAreaId: form.delivery_named_area_id, deliveryKm: value });
		if (fee != null) updateDeliveryFee(fee);
	}, [updateDeliveryKm, updateDeliveryFee, branchDeliveryCfg, form.order_type, form.delivery_named_area_id, total]);

	const fulfillment = toV2Fulfillment(form, openMesaMode);
	const deliveryPayload = useMemo(
		() => buildManualDeliveryPayload(form, branchDeliveryCfg),
		[
			form.delivery_address,
			form.delivery_reference,
			form.delivery_named_area_id,
			form.delivery_km,
			branchDeliveryCfg,
		],
	);

	useEffect(() => {
		if (!v2Enabled || !branch?.id || items.length === 0 || effectiveBranchConfigError) {
			setQuote(null);
			return;
		}
		if (
			fulfillment === 'delivery'
			&& validateManualDeliveryDetails(form, branchDeliveryCfg)
		) {
			setQuote(null);
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(async () => {
			setQuoteLoading(true);
			setQuoteError(null);
			try {
				const next = await manualOrderV2Service.quote({ branchId: branch.id, items: buildItems(items), fulfillment, delivery: deliveryPayload, couponCode: form.coupon_code, clientPhone: form.client_phone });
				if (!cancelled) {
					const previous = lastQuoteRef.current;
					if (previous?.quoteHash && previous.quoteHash !== next?.quoteHash) {
						setQuoteRevisionPending(true);
						void manualOrderV2Service.recordMetric({
							branchId: branch.id,
							eventName: 'requote',
							mode: toV2Mode(openMesaMode, fulfillment),
							fulfillment,
						});
					}
					lastQuoteRef.current = next;
					setQuote(next);
				}
			} catch (error) {
				if (!cancelled) { setQuote(null); setQuoteError(error?.message ?? 'No se pudo cotizar.'); }
			} finally {
				if (!cancelled) setQuoteLoading(false);
			}
		}, 350);
		return () => { cancelled = true; window.clearTimeout(timer); };
	}, [v2Enabled, branch?.id, items, fulfillment, deliveryPayload, form, form.coupon_code, form.client_phone, form.payment_lines?.length, effectiveBranchConfigError, paymentMethods, branchDeliveryCfg, openMesaMode]);

	const acknowledgeQuoteRevision = useCallback(() => setQuoteRevisionPending(false), []);

	const manualOrder = useMemo(() => {
		const deliveryFee = quote ? minorToMajor(Number(quote.deliveryFeeMinor), currency, fractionDigits) : (form.order_type === 'delivery' ? Number(form.delivery_fee) || 0 : 0);
		const checkoutTotal = quote ? minorToMajor(Number(quote.totalMinor), currency, fractionDigits) : minorToMajor(totalMinor + majorToMinor(deliveryFee, currency, fractionDigits), currency, fractionDigits);
		return {
			...form, items, total, total_minor: totalMinor, items_subtotal: total,
			delivery_fee: deliveryFee, checkout_total: checkoutTotal, quote, quoteLoading, quoteError, quoteRevisionPending,
			v2Enabled, paymentMethods, manualOrderSettings, currency, locale, fractionDigits, branchConfigError: effectiveBranchConfigError,
			cashDenominations: { ...countryProfile.cashDenominations, ...manualOrderSettings.cashDenominations },
		};
	}, [form, items, total, totalMinor, quote, currency, locale, fractionDigits, quoteLoading, quoteError, quoteRevisionPending, v2Enabled, paymentMethods, manualOrderSettings, countryProfile.cashDenominations, effectiveBranchConfigError]);

	const validateContext = useCallback(() => {
		if (!branch) return 'No hay sucursal seleccionada.';
		if (effectiveBranchConfigError) return `No se pudo validar la configuración: ${effectiveBranchConfigError}`;
		if (items.length === 0) return 'Agrega al menos un producto.';
		if (quoteRevisionPending) return 'La cotización cambió. Revisa el nuevo total y confírmalo antes de continuar.';
		const requirements = requirementsFor(manualOrderSettings, fulfillment);
		if (openMesaMode && fulfillment === 'table' && !String(form.selected_table_id ?? '').trim()) {
			return 'Selecciona una mesa del plano.';
		}
		if (requirements.operatorReference && String(form.client_name ?? '').trim().length < 2) {
			return openMesaMode
				? 'Indica el nombre del mesero o la referencia.'
				: 'Indica el número de mesa o referencia.';
		}
		if (requirements.name && String(form.client_name ?? '').trim().length < 2) return 'Indica el nombre del cliente.';
		if (requirements.phone || includePhone) {
			const phone = normalizeInternationalPhone(form.client_phone, countryProfile.countryCode);
			const meaningful = phoneHasMeaningfulDigits(form.client_phone, countryProfile.phonePrefix);
			if (requirements.phone && !phone.valid) {
				return 'Ingresa un teléfono válido con código de país.';
			}
			if (includePhone && meaningful && !phone.valid) {
				return 'Ingresa un teléfono válido con código de país.';
			}
		}
		const documentRaw = includeDocument ? String(form.client_rut ?? '').trim() : '';
		const hasDocument = !isBlankClientDocument(documentRaw);
		if ((requirements.document || hasDocument) && !validateProfileDocument(documentRaw, countryProfile, requirements.document)) {
			return `${countryProfile.document.label} inválido.`;
		}
		if (fulfillment === 'delivery') {
			const deliveryError = validateManualDeliveryDetails(form, branchDeliveryCfg);
			if (deliveryError) return deliveryError;
		}
		return null;
	}, [branch, effectiveBranchConfigError, items.length, quoteRevisionPending, manualOrderSettings, fulfillment, form.client_name, form.client_phone, form.client_rut, form.selected_table_id, countryProfile, branchDeliveryCfg, deliveryPayload, openMesaMode, includePhone, includeDocument]);

	const submitOrder = useCallback(async () => {
		if (submitInFlightRef.current) return;
		const contextError = validateContext();
		if (contextError) { showNotify?.(contextError, 'error'); return; }
		submitInFlightRef.current = true;
		setLoading(true);
		try {
			const itemsForOrder = buildItems(items);
			let result;
			let evidencePending = false;
			if (v2Enabled) {
				if (!quote?.quoteHash) throw new Error(quoteError || 'Espera una cotización válida antes de confirmar.');
				const createMode = toV2Mode(openMesaMode, fulfillment);
				const paymentTiming = form.charge_now ? 'immediate' : 'deferred';
				const candidateLines = deriveV2PaymentLines(form, quote, paymentMethods, currency, fractionDigits);
				const quickSaleHasPayment = createMode === 'quick_sale' && hasManualOrderPaymentIntent({
					...form,
					payment_lines: candidateLines,
					receiptFile,
					v2Enabled: true,
				});
				const effectiveTiming = fulfillment === 'table'
					? 'deferred'
					: (openMesaMode ? paymentTiming : quickSaleHasPayment ? 'immediate' : 'deferred');
				const lines = effectiveTiming === 'immediate' ? candidateLines : [];
				if (effectiveTiming === 'immediate') {
					const validation = validatePaymentLines(lines, quote, paymentMethods);
					if (!validation.valid) throw new Error('Los métodos de pago deben sumar exactamente el total y usar una tasa válida.');
				}
				const phone = includePhone && form.client_phone
					? normalizeInternationalPhone(form.client_phone, countryProfile.countryCode)
					: { valid: false, e164: '' };
				const tableRef = String(form.selected_table_code || '').trim();
				const hasFloorTable = Boolean(String(form.selected_table_id ?? '').trim());
				const meseroName = isOpenMesaMeseroMode(form) ? sanitizeManualOrderInput(form.client_name) : '';
				const mesaReference = sanitizeManualOrderInput(form.client_name);
				result = await manualOrderV2Service.create({
					branchId: branch.id,
					clientRequestId: clientRequestIdRef.current,
					mode: createMode,
					fulfillment,
					paymentTiming: effectiveTiming,
					customer: {
						name: fulfillment === 'table'
							? (hasFloorTable ? meseroName : '')
							: sanitizeManualOrderInput(form.client_name),
						phone: phone.valid ? phone.e164 : '',
						document: includeDocument && !isBlankClientDocument(form.client_rut)
							? sanitizeManualOrderInput(form.client_rut)
							: '',
						clientId: String(form.selected_client_id ?? '').trim() || null,
					},
					operatorReference: fulfillment === 'table'
						? sanitizeManualOrderInput(tableRef || mesaReference)
						: '',
					tableId: fulfillment === 'table' ? (String(form.selected_table_id ?? '').trim() || null) : null,
					delivery: deliveryPayload,
					items: itemsForOrder,
					couponCode: sanitizeManualOrderInput(form.coupon_code),
					note: sanitizeManualOrderInput(form.note),
					paymentLines: lines,
					quoteHash: quote.quoteHash,
				});
				if (fulfillment === 'table' && openMesaMode && meseroName) {
					const { rememberWaiter } = await import('../utils/recentWaitersStorage');
					rememberWaiter(branch.company_id, branch.id, meseroName);
				}
				if (fulfillment === 'table' && result?.id && form.selected_table_id) {
					const { branchTablesService } = await import('../services/branchTablesService');
					await branchTablesService.linkOrderToTable(result.id, {
						tableId: form.selected_table_id,
						tableCode: tableRef,
					}).catch(() => {});
				}
				if (result?.idempotentReplay) {
					void manualOrderV2Service.recordMetric({ branchId: branch.id, eventName: 'duplicate_prevented', mode: createMode, fulfillment });
				}
				evidencePending = result?.payment_evidence_status === 'pending';
				if (effectiveTiming === 'immediate' && receiptFile) {
					evidencePending = false;
					const evidenceRows = await manualOrderV2Service.listEvidence(result.id);
					const pendingRows = evidenceRows.filter((row) => row.status !== 'uploaded');
					for (const [index, evidence] of pendingRows.entries()) {
						const queued = await queuePaymentEvidence({ evidenceId: evidence.id, companyId: branch.company_id, branchId: branch.id, orderId: result.id, file: receiptFile, previousPath: index === 0 ? evidence.storage_path ?? null : null });
						const upload = await uploadQueuedPaymentEvidence(queued);
						if (!upload.ok) evidencePending = true;
					}
				}
			} else {
				const createMode = toV2Mode(openMesaMode, getLocalFulfillmentMode(form) === 'mesa' ? 'table' : form.order_type === 'delivery' ? 'delivery' : 'pickup');
				const openMesaMesero = openMesaMode && isOpenMesaMeseroMode(form);
				const tableRef = String(form.selected_table_code || '').trim();
				const meseroName = openMesaMesero ? sanitizeManualOrderInput(form.client_name) : '';
				const clientName = openMesaMode
					? sanitizeManualOrderInput(
						openMesaMesero
							? (meseroName || tableRef || resolveOpenMesaClientName(form.order_type, form.client_name, getLocalFulfillmentMode(form)))
							: (tableRef || resolveOpenMesaClientName(form.order_type, form.client_name, getLocalFulfillmentMode(form))),
					)
					: sanitizeManualOrderInput(form.client_name);
				const totalForOrderMinor = sumMinor(itemsForOrder.map((item) => majorToMinor(item.has_discount && Number(item.discount_price) > 0 ? item.discount_price : item.price, currency, fractionDigits) * item.quantity));
				const couponMinor = couponPreview?.variant === 'success' ? Math.min(totalForOrderMinor, majorToMinor(couponPreview.discount, currency, fractionDigits)) : 0;
				const deliveryFee = form.order_type === 'delivery'
					? (syncDeliveryFeeFromForm(form, minorToMajor(totalForOrderMinor, currency, fractionDigits)) ?? (Number(form.delivery_fee) || 0))
					: 0;
				const checkoutMinor = Math.max(0, totalForOrderMinor - couponMinor) + majorToMinor(deliveryFee, currency, fractionDigits);
				const checkoutTotal = minorToMajor(checkoutMinor, currency, fractionDigits);
				const sanitizedOrder = {
					...form, items: itemsForOrder, total: checkoutTotal, client_name: clientName,
					client_request_id: clientRequestIdRef.current,
					manual_order_mode: createMode,
					client_phone: openMesaMesero
						? OPEN_MESA_CAJA_DEFAULTS.client_phone
						: (includePhone
							? (normalizeInternationalPhone(sanitizeManualOrderInput(form.client_phone), countryProfile.countryCode).e164 || sanitizeManualOrderInput(form.client_phone))
							: ''),
					client_rut: openMesaMesero
						? OPEN_MESA_CAJA_DEFAULTS.client_rut
						: (includeDocument && !isBlankClientDocument(form.client_rut)
							? sanitizeManualOrderInput(form.client_rut)
							: ''),
					local_fulfillment_mode: getLocalFulfillmentMode(form), note: sanitizeManualOrderInput(form.note),
					branch_id: branch.id, company_id: branch.company_id, branch_name: branch.name, order_type: form.order_type,
					delivery_address: form.order_type === 'delivery' ? deliveryPayload.address : null,
					delivery_reference: deliveryPayload.reference, delivery_km: deliveryPayload.km, delivery_named_area_id: deliveryPayload.zoneId,
					caller_role: userRole, coupon_code: sanitizeManualOrderInput(form.coupon_code), delivery_fee: deliveryFee,
					...(canOverrideDeliveryFee(userRole) && form.order_type === 'delivery' ? { manual_delivery_fee: deliveryFee } : {}),
				};
				const quickSaleHasPayment = createMode === 'quick_sale' && hasManualOrderPaymentIntent({
					...form,
					receiptFile,
					v2Enabled: false,
				});
				const shouldSettleImmediately = openMesaMode ? form.charge_now : quickSaleHasPayment;
				if (shouldSettleImmediately) {
					sanitizedOrder.payment_timing = 'immediate';
					sanitizedOrder.payment_breakdown = buildPaymentBreakdownForOrder({ ...form, total: checkoutTotal });
				} else {
					sanitizedOrder.payment_timing = 'deferred';
					sanitizedOrder.payment_type = 'pendiente';
					sanitizedOrder.payment_method_specific = null;
					sanitizedOrder.payment_breakdown = null;
				}
				result = await createManualOrder(sanitizedOrder, shouldSettleImmediately ? receiptFile : null);
				evidencePending = Boolean(result?.receiptUploadFailed);
				result = result?.order ?? result;
				if (getLocalFulfillmentMode(form) === 'mesa' && result?.id && form.selected_table_id) {
					const { branchTablesService } = await import('../services/branchTablesService');
					await branchTablesService.linkOrderToTable(result.id, {
						tableId: form.selected_table_id,
						tableCode: tableRef || String(form.selected_table_code || '').trim(),
					}).catch(() => {});
				}
				if (openMesaMesero && meseroName) {
					const { rememberWaiter } = await import('../utils/recentWaitersStorage');
					rememberWaiter(branch.company_id, branch.id, meseroName);
				}
			}

			const notifyMode = toV2Mode(openMesaMode, fulfillment);
			let addressSaveFailed = false;
			if (fulfillment === 'delivery') {
				const addressSave = await maybeSaveClientDefaultDeliveryAddress({
					orderType: 'delivery',
					clientId: String(form.selected_client_id ?? '').trim(),
					companyId: branch.company_id,
					address: form.delivery_address,
					reference: form.delivery_reference,
				});
				addressSaveFailed = Boolean(addressSave && addressSave.ok === false);
			}

			const baseSuccessMessage = evidencePending
				? 'Pedido creado · comprobante pendiente. Puedes reintentar desde el pedido.'
				: notifyMode === 'session'
					? ({ mesa: 'Mesa abierta', retiro: 'Retiro abierto', delivery: 'Delivery abierto' }[getLocalFulfillmentMode(form)] ?? 'Sesión abierta')
					: (!openMesaMode && hasManualOrderPaymentIntent({ ...form, receiptFile, v2Enabled }))
						|| (openMesaMode && form.charge_now)
						? 'Pedido cobrado y creado'
						: 'Pedido creado pendiente de pago';
			const successMessage = addressSaveFailed
				? `${baseSuccessMessage} · No se pudo guardar la dirección del cliente.`
				: baseSuccessMessage;
			showNotify?.(
				successMessage,
				evidencePending || addressSaveFailed ? 'warning' : 'success',
			);
			if (v2Enabled && evidencePending) {
				void manualOrderV2Service.recordMetric({ branchId: branch.id, eventName: 'evidence_pending', mode: notifyMode, fulfillment });
			}
			resetOrder();
			await onOrderSaved?.(result);
			onClose?.();
			return result;
		} catch (error) {
			if (v2Enabled && error?.code === 'quote_changed') {
				void manualOrderV2Service.recordMetric({ branchId: branch?.id, eventName: 'requote', mode: toV2Mode(openMesaMode, fulfillment), fulfillment });
			}
			showNotify?.(error?.message || 'Error al crear pedido', 'error');
			return null;
		} finally {
			submitInFlightRef.current = false;
			setLoading(false);
		}
	}, [validateContext, showNotify, items, v2Enabled, quote, quoteError, openMesaMode, form, fulfillment, paymentMethods, currency, fractionDigits, countryProfile.countryCode, branch, deliveryPayload, receiptFile, couponPreview, syncDeliveryFeeFromForm, userRole, resetOrder, onOrderSaved, onClose, includePhone, includeDocument]);

	const restoreOrder = useCallback((draft) => {
		if (!draft || typeof draft !== 'object') return;
		restoreCart(draft.items);
		restoreForm(draft.form);
		if (draft.clientRequestId) clientRequestIdRef.current = draft.clientRequestId;
		setQuote(null);
		setQuoteError(null);
		setQuoteRevisionPending(false);
		lastQuoteRef.current = draft.quote ?? null;
	}, [restoreCart, restoreForm]);

	return {
		manualOrder, loading, rutValid, phoneValid, includeDocument, includePhone, setIncludeDocument, setIncludePhone,
		receiptFile, receiptPreview,
		updateClientName, updateCouponCode, couponPreview, updateNote, updatePaymentType: handlePaymentTypeChange,
		updatePaymentMode, updateCashAmount, updateCardAmount, updateCashTendered, updateChargeNow: handleChargeNowChange, updatePaymentLines,
		handleRutChange, handlePhoneChange, applyClientRecord, handleFileChange, removeReceipt,
		addItem, updateQuantity, removeItem, updateItemNote, updateOrderType: handleUpdateOrderType,
		updateLocalFulfillmentMode: handleUpdateLocalFulfillmentMode, updateMesaPartyMode, updateDeliveryAddress,
		updateDeliveryReference, updateDeliveryKm: handleUpdateDeliveryKm, updateDeliveryFee,
		updateDeliveryNamedAreaId: handleUpdateDeliveryNamedAreaId, submitOrder, resetOrder, selectTable,
		isValid: Boolean(items.length && (form.client_name || form.selected_table_id || fulfillment === 'delivery')),
		getInputStyle, quote, quoteLoading, quoteError, paymentMethods, manualOrderSettings, v2Enabled,
		restoreOrder, restoreReceipt,
		acknowledgeQuoteRevision,
		draftSnapshot: { version: 2, items, form, quote, clientRequestId: clientRequestIdRef.current, savedAt: Date.now() },
	};
};
