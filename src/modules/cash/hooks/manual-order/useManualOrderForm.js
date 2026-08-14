import { useState, useCallback, useMemo } from 'react';
import { getFormStrategy } from '@/lib/geo/country-forms';
import { parseLocalOrderChannels } from '@/lib/delivery-settings';
import { normalizeManualPhone } from '../../services/clientService';
import {
    MANUAL_ORDER_INITIAL_FORM_STATE,
    OPEN_MESA_CAJA_DEFAULTS,
    applyLocalFulfillmentMode,
    applyMesaPartyMode,
    isBlankClientDocument,
    phoneHasMeaningfulDigits,
} from './manualOrderShared';
import { parseMoneyInput, minorToMajor } from '@/lib/money/minor-units';

const initialFormState = MANUAL_ORDER_INITIAL_FORM_STATE;

/**
 * Hook especializado en gestionar todos los estados del formulario del pedido manual:
 * nombre del cliente, RUT (formateo y validación), teléfono, notas del pedido, tipo de despacho,
 * dirección de entrega, kilómetros, tarifas y comprobantes de pago.
 */
export const useManualOrderForm = (enabledLocalChannels = null, formCountry = 'CL', moneyOptions = {}, openMesaMode = false) => {
    const strategy = useMemo(() => getFormStrategy(formCountry), [formCountry]);
    const resolvedChannels = useMemo(
        () => parseLocalOrderChannels(enabledLocalChannels),
        [
            enabledLocalChannels?.mesa,
            enabledLocalChannels?.retiro,
            enabledLocalChannels?.delivery,
        ],
    );
    const [form, setForm] = useState(() => ({ ...initialFormState }));
    const [rutValid, setRutValid] = useState(true);
    const [phoneValid, setPhoneValid] = useState(true);
    const [includeDocument, setIncludeDocumentState] = useState(false);
    const [includePhone, setIncludePhoneState] = useState(false);

    const setIncludeDocument = useCallback((enabled) => {
        const next = Boolean(enabled);
        setIncludeDocumentState(next);
        if (!next) {
            setForm((prev) => ({ ...prev, client_rut: '' }));
            setRutValid(true);
        }
    }, []);

    const setIncludePhone = useCallback((enabled) => {
        const next = Boolean(enabled);
        setIncludePhoneState(next);
        if (!next) {
            setForm((prev) => ({ ...prev, client_phone: '' }));
            setPhoneValid(true);
        } else {
            setForm((prev) => {
                const current = String(prev.client_phone ?? '').trim();
                if (current) return prev;
                return { ...prev, client_phone: strategy.phonePrefix };
            });
            setPhoneValid(true);
        }
    }, [strategy.phonePrefix]);

    const updateClientName = useCallback((val, opts = {}) => {
        setForm((prev) => {
            const next = { ...prev, client_name: val };
            if (!opts.fromClientSelect && prev.selected_client_id) {
                next.selected_client_id = '';
            }
            return next;
        });
    }, []);

    const updateCouponCode = useCallback((val) => {
        setForm(prev => ({ ...prev, coupon_code: typeof val === 'string' ? val : '' }));
    }, []);

    const updateNote = useCallback((val) => {
        setForm(prev => ({ ...prev, note: val }));
    }, []);

    const updateOrderType = useCallback((val) => {
        if (val === 'delivery') setIncludePhone(true);
        setForm((prev) => {
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
    }, [setIncludePhone]);

    const updateLocalFulfillmentMode = useCallback((mode) => {
        if (mode === 'delivery') setIncludePhone(true);
        setForm((prev) => applyLocalFulfillmentMode(prev, mode, { preserveClient: !openMesaMode }));
    }, [openMesaMode, setIncludePhone]);

    const updateMesaPartyMode = useCallback((mode) => {
        setForm((prev) => applyMesaPartyMode(prev, mode));
    }, []);

    const updateDeliveryAddress = useCallback((val) => {
        setForm(prev => ({ ...prev, delivery_address: val }));
    }, []);

    const updateDeliveryReference = useCallback((val) => {
        setForm((prev) => ({
            ...prev,
            delivery_reference: typeof val === 'string' ? val : '',
        }));
    }, []);

    const updateDeliveryKm = useCallback((val) => {
        setForm((prev) => ({
            ...prev,
            delivery_km: val === '' || val == null ? '' : String(val),
        }));
    }, []);

    const updateDeliveryFee = useCallback((val) => {
        setForm(prev => ({ ...prev, delivery_fee: Number(val) || 0 }));
    }, []);

    const updateDeliveryNamedAreaId = useCallback((val) => {
        setForm((prev) => ({
            ...prev,
            delivery_named_area_id: typeof val === 'string' ? val : '',
        }));
    }, []);

    const updatePaymentType = useCallback((type) => {
        const normalizedType = ['tienda', 'tarjeta', 'online', 'pendiente'].includes(type)
            ? type
            : '';
        setForm(prev => ({
            ...prev,
            payment_type: normalizedType,
            payment_mode: 'single',
            cash_amount: 0,
            card_amount: 0,
            cash_tendered: '',
            payment_lines: [],
        }));
    }, []);

    const updatePaymentMode = useCallback((mode) => {
        setForm(prev => ({
            ...prev,
            payment_mode: mode === 'mixed' ? 'mixed' : 'single',
            cash_amount: mode === 'mixed' ? prev.cash_amount : 0,
            card_amount: mode === 'mixed' ? prev.card_amount : 0,
            cash_tendered: '',
            ...(mode === 'mixed' ? { payment_type: 'tienda' } : {}),
        }));
    }, []);

	const updateCashAmount = useCallback((val) => {
		const parsed = parseMoneyInput(val, { currency: moneyOptions.currency ?? 'CLP', locale: moneyOptions.locale, fractionDigits: moneyOptions.fractionDigits });
		setForm(prev => ({ ...prev, cash_amount: parsed.valid ? minorToMajor(parsed.minor, moneyOptions.currency ?? 'CLP', moneyOptions.fractionDigits) : 0, cash_tendered: '' }));
	}, [moneyOptions.currency, moneyOptions.locale, moneyOptions.fractionDigits]);

	const updateCardAmount = useCallback((val) => {
		const parsed = parseMoneyInput(val, { currency: moneyOptions.currency ?? 'CLP', locale: moneyOptions.locale, fractionDigits: moneyOptions.fractionDigits });
		setForm(prev => ({ ...prev, card_amount: parsed.valid ? minorToMajor(parsed.minor, moneyOptions.currency ?? 'CLP', moneyOptions.fractionDigits) : 0 }));
	}, [moneyOptions.currency, moneyOptions.locale, moneyOptions.fractionDigits]);

    const updateCashTendered = useCallback((val) => {
        if (val === '' || val == null) {
            setForm(prev => ({ ...prev, cash_tendered: '' }));
            return;
        }
		const parsed = parseMoneyInput(val, { currency: moneyOptions.currency ?? 'CLP', locale: moneyOptions.locale, fractionDigits: moneyOptions.fractionDigits });
		setForm(prev => ({ ...prev, cash_tendered: parsed.valid ? minorToMajor(parsed.minor, moneyOptions.currency ?? 'CLP', moneyOptions.fractionDigits) : '' }));
	}, [moneyOptions.currency, moneyOptions.locale, moneyOptions.fractionDigits]);

	const updateChargeNow = useCallback((enabled) => {
        setForm((prev) => ({
            ...prev,
            charge_now: Boolean(enabled),
            payment_type: enabled
                ? (prev.payment_type === 'pendiente' ? '' : prev.payment_type)
                : 'pendiente',
            payment_mode: 'single',
            cash_amount: 0,
            card_amount: 0,
            cash_tendered: '',
        }));
	}, []);

	const updatePaymentLines = useCallback((lines) => {
		setForm((prev) => ({ ...prev, payment_lines: Array.isArray(lines) ? lines : [] }));
	}, []);

    const handleRutChange = useCallback((e) => {
        const rawValue = e.target.value;
        const formatted = strategy.formatId(rawValue);
        setForm(prev => ({ ...prev, client_rut: formatted }));
        setRutValid(strategy.validateId(formatted));
    }, [strategy]);

    const handlePhoneChange = useCallback((e) => {
        let input = e.target.value;
        const prefix = strategy.phonePrefix;
        const prefixTrim = prefix.trim();
        if (!input.startsWith(prefixTrim)) {
            if (input.length < prefixTrim.length + 2) input = prefix;
        }
        const cleaned = input;
        const prefixDigits = prefixTrim.replace(/\D/g, '');
        const valueDigits = cleaned.replace(/\D/g, '');
        const isPrefixOnly = !valueDigits || valueDigits === prefixDigits;

        setForm((prev) => ({
            ...prev,
            client_phone: cleaned,
            ...(prev.selected_client_id ? {
                selected_client_id: '',
            } : {}),
        }));

        // Prefijo solo (+58) no cuenta como error; el campo sigue siendo opcional.
        setPhoneValid(isPrefixOnly || strategy.validatePhone(cleaned));
    }, [strategy]);

    const applyClientRecord = useCallback(async (client) => {
        if (!client || typeof client !== 'object') return;

        const name = String(client.name ?? '').trim();
        const rutRaw = String(client.rut ?? client.document ?? '').trim();
        const rut = rutRaw && !isBlankClientDocument(rutRaw) ? strategy.formatId(rutRaw) : '';
        const phone = normalizeManualPhone(client.phone) || strategy.phonePrefix;
        const clientId = client.id != null ? String(client.id) : '';

        setForm((prev) => ({
            ...prev,
            client_name: name || prev.client_name,
            client_rut: rut || prev.client_rut,
            client_phone: phone || prev.client_phone,
            selected_client_id: clientId,
        }));

        if (rut) setIncludeDocumentState(true);
        if (phoneHasMeaningfulDigits(phone, strategy.phonePrefix)) {
            setIncludePhoneState(true);
        }

        setRutValid(rut ? strategy.validateId(rut) : true);
        setPhoneValid(
            !phoneHasMeaningfulDigits(phone, strategy.phonePrefix) || strategy.validatePhone(phone),
        );
    }, [strategy]);

	const resetForm = useCallback(() => {
        setForm({ ...initialFormState });
        setRutValid(true);
        setPhoneValid(true);
        setIncludeDocumentState(false);
        setIncludePhoneState(false);
	}, []);

	const restoreForm = useCallback((nextForm) => {
		if (!nextForm || typeof nextForm !== 'object') return;
		const rut = isBlankClientDocument(nextForm.client_rut) ? '' : String(nextForm.client_rut ?? '');
		const phone = String(nextForm.client_phone ?? '');
		const isDelivery =
			String(nextForm.order_type ?? '').toLowerCase() === 'delivery'
			|| String(nextForm.local_fulfillment_mode ?? '').toLowerCase() === 'delivery';
		setForm({ ...initialFormState, ...nextForm, client_rut: rut });
		setRutValid(!rut || strategy.validateId(rut));
		setPhoneValid(!phoneHasMeaningfulDigits(phone, strategy.phonePrefix) || strategy.validatePhone(phone));
		setIncludeDocumentState(Boolean(rut));
		setIncludePhoneState(isDelivery || phoneHasMeaningfulDigits(phone, strategy.phonePrefix));
	}, [strategy]);

    const resetOpenMesaForm = useCallback(() => {
        setForm({
            ...initialFormState,
            client_name: '',
            client_rut: OPEN_MESA_CAJA_DEFAULTS.client_rut,
            client_phone: OPEN_MESA_CAJA_DEFAULTS.client_phone,
            order_type: 'pickup',
            local_fulfillment_mode: 'mesa',
            mesa_party_mode: 'mesero',
            payment_type: 'pendiente',
            charge_now: false,
            selected_table_id: '',
            selected_table_code: '',
        });
        setRutValid(true);
        setPhoneValid(true);
        setIncludeDocumentState(false);
        setIncludePhoneState(false);
    }, []);

	const selectTable = useCallback((table) => {
		const id = table?.id ? String(table.id) : '';
		const code = String(table?.label || table?.code || '').trim();
		setForm((prev) => {
			const prevName = String(prev.client_name ?? '').trim();
			const prevCode = String(prev.selected_table_code ?? '').trim();
			const keepMeseroName =
				prev.mesa_party_mode === 'mesero'
				&& prevName.length >= 2
				&& prevName !== prevCode
				&& prevName !== code;
			return {
				...prev,
				selected_table_id: id,
				selected_table_code: code,
				client_name: keepMeseroName ? prevName : '',
				local_fulfillment_mode: 'mesa',
				order_type: 'pickup',
				mesa_party_mode: 'mesero',
				charge_now: false,
				payment_type: 'pendiente',
			};
		});
	}, []);

    const getInputStyle = useCallback((isValid) => {
        if (isValid === true) return { borderColor: '#4f5bff', boxShadow: '0 0 0 1px #4f5bff' };
        if (isValid === false) return { borderColor: '#c31d2d', boxShadow: '0 0 0 1px #c31d2d' };
        return {};
    }, []);

    return {
        form,
        rutValid,
        phoneValid,
        includeDocument,
        includePhone,
        setIncludeDocument,
        setIncludePhone,
        updateClientName,
        updateCouponCode,
        updateNote,
        updateOrderType,
        updateLocalFulfillmentMode,
        updateMesaPartyMode,
        updateDeliveryAddress,
        updateDeliveryReference,
        updateDeliveryKm,
        updateDeliveryFee,
        updateDeliveryNamedAreaId,
        updatePaymentType,
        updatePaymentMode,
        updateCashAmount,
        updateCardAmount,
        updateCashTendered,
		updateChargeNow,
		updatePaymentLines,
        handleRutChange,
        handlePhoneChange,
        applyClientRecord,
        resetForm,
		resetOpenMesaForm,
		selectTable,
		restoreForm,
        getInputStyle
    };
};
