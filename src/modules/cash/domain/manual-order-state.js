import { normalizeInternationalPhone, validateProfileDocument } from '@/lib/geo/country-profiles';
import { requirementsFor } from './manual-order-settings';
import { validatePaymentLines } from './payment-methods';

export const MANUAL_ORDER_PHASES = Object.freeze([
	'config', 'catalog', 'context', 'quote', 'payment', 'confirm', 'submitting', 'success', 'recoverable_error',
]);

export function createManualOrderState(options = {}) {
	const mode = options.mode === 'session' ? 'session' : 'quick_sale';
	return {
		version: 2,
		mode,
		phase: 'config',
		fulfillment: mode === 'session' ? 'table' : 'pickup',
		paymentTiming: 'deferred',
		items: [],
		customer: { name: '', phone: '', document: '', clientId: null },
		operatorReference: '',
		delivery: { address: '', reference: '', zoneId: null, km: null },
		couponCode: '',
		note: '',
		quote: null,
		paymentLines: [],
		evidence: {},
		configuration: null,
		dirty: false,
		error: null,
		clientRequestId: options.clientRequestId ?? crypto.randomUUID(),
		createdAt: options.createdAt ?? new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function dirty(state, patch) {
	return { ...state, ...patch, dirty: true, updatedAt: new Date().toISOString(), error: null };
}

export function manualOrderReducer(state, action) {
	switch (action.type) {
		case 'CONFIG_LOADED':
			return { ...state, configuration: action.configuration, phase: 'catalog', error: null };
		case 'CONFIG_FAILED':
			return { ...state, configuration: null, phase: 'recoverable_error', error: action.error ?? 'No se pudo cargar la configuración.' };
		case 'SET_MODE': {
			const mode = action.mode === 'session' ? 'session' : 'quick_sale';
			return dirty(state, {
				mode,
				fulfillment: mode === 'session' ? 'table' : state.fulfillment,
				paymentTiming: 'deferred',
				quote: null,
				paymentLines: [],
			});
		}
		case 'SET_FULFILLMENT': {
			const fulfillment = action.fulfillment;
			const paymentTiming = fulfillment === 'table' ? 'deferred' : state.paymentTiming;
			return dirty(state, { fulfillment, paymentTiming, quote: null, paymentLines: [] });
		}
		case 'SET_PAYMENT_TIMING':
			if (state.fulfillment === 'table') return state;
			return dirty(state, { paymentTiming: action.timing === 'immediate' ? 'immediate' : 'deferred', paymentLines: [] });
		case 'SET_ITEMS':
			return dirty(state, { items: action.items ?? [], quote: null, paymentLines: [] });
		case 'SET_CUSTOMER':
			return dirty(state, { customer: { ...state.customer, ...action.customer } });
		case 'SET_OPERATOR_REFERENCE':
			return dirty(state, { operatorReference: String(action.value ?? '') });
		case 'SET_DELIVERY':
			return dirty(state, { delivery: { ...state.delivery, ...action.delivery }, quote: null, paymentLines: [] });
		case 'SET_COUPON':
			return dirty(state, { couponCode: String(action.value ?? ''), quote: null, paymentLines: [] });
		case 'QUOTE_STARTED':
			return { ...state, phase: 'quote', error: null };
		case 'QUOTE_RECEIVED':
			return { ...state, quote: action.quote, paymentLines: [], phase: state.paymentTiming === 'immediate' ? 'payment' : 'confirm', error: null };
		case 'QUOTE_INVALIDATED':
			return dirty(state, { quote: null, paymentLines: [], phase: 'quote', error: action.reason ?? null });
		case 'SET_PAYMENT_LINES':
			return dirty(state, { paymentLines: action.lines ?? [] });
		case 'SUBMIT_STARTED':
			return state.phase === 'submitting' ? state : { ...state, phase: 'submitting', error: null };
		case 'SUBMIT_SUCCEEDED':
			return { ...state, phase: 'success', dirty: false, order: action.order, error: null };
		case 'SUBMIT_FAILED':
			return { ...state, phase: 'recoverable_error', error: action.error ?? 'No se pudo confirmar el pedido.' };
		case 'RESTORE_DRAFT':
			return { ...state, ...action.draft, phase: 'config', quote: null, paymentLines: [], error: null };
		case 'MARK_CLEAN':
			return { ...state, dirty: false };
		default:
			return state;
	}
}

export function validateManualOrderState(state, context = {}) {
	const errors = {};
	const settings = context.settings ?? state.configuration?.settings;
	const profile = context.profile ?? state.configuration?.profile;
	const requirements = requirementsFor(settings, state.fulfillment);
	if (!state.items?.length) errors.items = 'Agrega al menos un producto.';
	if (requirements.name && String(state.customer?.name ?? '').trim().length < 2) errors.name = 'Indica el nombre del cliente.';
	if (requirements.operatorReference && String(state.operatorReference ?? '').trim().length < 2) errors.operatorReference = 'Indica la mesa o referencia del mesero.';
	if (requirements.phone) {
		const phone = normalizeInternationalPhone(state.customer?.phone, profile?.countryCode);
		if (!phone.valid) errors.phone = 'Ingresa un teléfono válido con código de país.';
	}
	if (requirements.document && !validateProfileDocument(state.customer?.document, profile, true)) {
		errors.document = `${profile?.document?.label ?? 'Documento'} inválido.`;
	}
	if (state.fulfillment === 'delivery') {
		if (requirements.address && String(state.delivery?.address ?? '').trim().length < 5) errors.address = 'Indica una dirección válida.';
		if (requirements.zone && context.deliveryUsesZones && !state.delivery?.zoneId) errors.zone = 'Selecciona una zona de entrega.';
		if (context.configurationLoading) errors.configuration = 'Espera mientras validamos la configuración de delivery.';
		if (context.configurationError) errors.configuration = 'No se pudo validar el delivery. Reintenta antes de continuar.';
	}
	if (context.requireQuote !== false && !state.quote?.quoteHash) errors.quote = 'Actualiza la cotización antes de confirmar.';
	if (state.paymentTiming === 'immediate' && state.quote?.quoteHash) {
		const payment = validatePaymentLines(state.paymentLines, state.quote, context.paymentMethods ?? []);
		if (!payment.valid) errors.payment = payment.errors;
	}
	return { valid: Object.keys(errors).length === 0, errors };
}

export function firstManualOrderError(validation) {
	const values = Object.values(validation?.errors ?? {});
	const first = values[0];
	if (typeof first === 'string') return first;
	if (Array.isArray(first)) {
		const code = first[0]?.code;
		return code === 'total_mismatch' ? 'Los pagos deben sumar exactamente el total.' : 'Revisa las líneas de pago.';
	}
	return null;
}
