import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Store, Truck, MapPin, User, CheckCircle2, Loader2, Banknote } from 'lucide-react';
import { useAdmin } from '@/modules/cash/admin/pages/AdminProvider';
import { useBranchMoney } from '@/modules/cash/hooks/useBranchMoney';
import { getFormStrategy } from '@/lib/geo/country-forms';
import { geocodeAddress } from '../../services/geocodeService';
import { geocodeToCoords, reverseGeocodeLocality } from '../../services/placesService';
import { haversineKm, isValidLatLng } from '@/lib/geo';
import {
    effectiveDeliveryPricingMode,
} from '@/lib/delivery-settings';
import { filterClientsByNameOrPhone } from '../../services/clientService';
import {
    getLocalFulfillmentMode,
    isManualNamedDeliveryMode,
    isOpenMesaMeseroMode,
    LOCAL_FULFILLMENT_MODES,
    phoneHasMeaningfulDigits,
    validateManualDeliveryDetails,
} from '../../hooks/manual-order/manualOrderShared';
import { listRecentWaiters } from '../../utils/recentWaitersStorage';
import DeliveryPlaceSuggestInput from '../DeliveryPlaceSuggestInput';
import TableRestaurantIcon from '../TableRestaurantIcon';
import DeliveryMotoIcon from '../DeliveryMotoIcon';
import PickupBagIcon from '../PickupBagIcon';
import { cn } from '@/lib/utils';
import { Button } from "@/components/ui/button";
import { selectedToggleActiveClass, spacing, textScale, toggleBaseClass } from './manualOrderStyles';
import SectionHeader from './SectionHeader';
import { requirementsFor } from '../../domain/manual-order-settings';
import { resolveEffectiveCountry, isVenezuelaCountry } from '@/lib/geo/tenant-locale';

const sectionCardClass = 'manual-order-step-card flex min-h-0 flex-col overflow-visible rounded-[18px] border border-gc-border bg-gc-card p-4 shadow-sm sm:p-5';
const inputClass =
    `w-full rounded-[12px] border border-gc-border bg-gc-page px-3.5 py-3 ${textScale.body} text-gc-text placeholder:text-gc-text-muted focus:border-gc-accent focus:outline-none focus:ring-2 focus:ring-gc-accent/15`;
const hintClass =
    `mt-3 rounded-[12px] border border-gc-accent/20 bg-gc-accent/10 px-3 py-2.5 ${textScale.body} leading-relaxed text-gc-text-muted`;
const inlineActionClass =
    `inline-flex min-h-[42px] items-center gap-1.5 self-start rounded-[12px] border border-gc-border bg-gc-card px-3.5 py-2 ${textScale.body} font-semibold text-gc-text transition-colors hover:border-gc-accent/30 disabled:cursor-not-allowed disabled:opacity-50`;
const fieldLabelClass = `flex flex-col ${spacing.compact} ${textScale.micro} font-semibold text-gc-text-muted`;

const fieldSwitchTrackClass = (on, locked) => cn(
	'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
	on ? 'border-gc-accent bg-gc-accent' : 'border-gc-border bg-gc-muted',
	locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
);

const FieldIncludeSwitch = ({
	id,
	label,
	checked,
	onCheckedChange,
	locked = false,
	required = false,
}) => (
	<div className="flex items-center justify-between gap-3">
		<label htmlFor={id} className={`${textScale.micro} font-semibold text-gc-text-muted`}>
			{label}
			{required
				? <span className="text-gc-danger"> *</span>
				: <span className="font-normal text-gc-text-muted"> (opcional)</span>}
		</label>
		<button
			id={id}
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={locked}
			className={fieldSwitchTrackClass(checked, locked)}
			onClick={() => {
				if (locked) return;
				onCheckedChange?.(!checked);
			}}
		>
			<span
				className={cn(
					'pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform',
					checked ? 'translate-x-[22px]' : 'translate-x-0.5',
				)}
			/>
		</button>
	</div>
);

const highlightClientMatch = (text, query) => {
    const value = String(text ?? '');
    const q = String(query ?? '').trim();
    if (!value || !q) return value;
    const idx = value.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return value;
    return (
        <>
            {value.slice(0, idx)}
            <mark className="manual-order-client-suggestion__match">{value.slice(idx, idx + q.length)}</mark>
            {value.slice(idx + q.length)}
        </>
    );
};

const fulfillmentActiveClass = {
    mesa: 'border-[var(--fulfillment-mesa-border)] bg-[var(--fulfillment-mesa-bg)] text-[var(--fulfillment-mesa-fg)]',
    retiro: 'border-[var(--fulfillment-retiro-border)] bg-[var(--fulfillment-retiro-bg)] text-[var(--fulfillment-retiro-fg)]',
    delivery: 'border-[var(--fulfillment-delivery-border)] bg-[var(--fulfillment-delivery-bg)] text-[var(--fulfillment-delivery-fg)]',
};

const sanitizeInputLive = (text) => {
    if (text == null || text === '') return '';
    return text.replace(/[<>]/g, '');
};

const normalizeSearch = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Paso Cliente: dos columnas (datos cliente | retiro/delivery).
 */
const ClientForm = ({
    manualOrder,
    branchDeliveryCfg,
    clients = [],
    updateOrderType,
    updateLocalFulfillmentMode,
    updateMesaPartyMode,
    updateDeliveryAddress,
    updateDeliveryReference,
    updateDeliveryKm,
    updateDeliveryFee,
    updateDeliveryNamedAreaId,
    updateClientName,
    applyClientRecord,
    handleRutChange,
    handlePhoneChange,
    rutValid,
    phoneValid,
    includeDocument = false,
    includePhone = false,
    setIncludeDocument,
    setIncludePhone,
    getInputStyle,
    branch,
    showNotify,
    canOverrideDeliveryFee = false,
    openMesaMode = false,
    branchDeliveryCfgLoading = false,
    enabledLocalChannels = null,
    isEditMode = false,
	showQuickSalePaymentChoice = false,
	quickSalePaymentActive = false,
	quickSalePaymentHint = null,
	onSelectQuickSaleUnpaid = null,
	onSelectQuickSalePaid = null,
}) => {
    const { formatMoney } = useBranchMoney();
    const { companyProfile, companyId } = useAdmin();
    const formStrategy = useMemo(() => {
        const country = resolveEffectiveCountry(branch, companyProfile);
        return getFormStrategy(country);
    }, [branch, companyProfile]);
    const [detectingZone, setDetectingZone] = useState(false);
    const [calculatingDistance, setCalculatingDistance] = useState(false);
    const [clientSuggestionsOpen, setClientSuggestionsOpen] = useState(false);
	const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
	const [recentWaiters, setRecentWaiters] = useState([]);
    const clientSearchRef = useRef(null);
	const autofilledWaiterForTableRef = useRef(null);

    const isPickup = manualOrder.order_type !== 'delivery';
    const isDelivery = manualOrder.order_type === 'delivery';
	const companyKey = companyId || branch?.company_id || companyProfile?.id || null;
	const branchKey = branch?.id || null;

	useEffect(() => {
		if (!openMesaMode || !companyKey || !branchKey || branchKey === 'all') {
			setRecentWaiters([]);
			return;
		}
		setRecentWaiters(listRecentWaiters(companyKey, branchKey));
	}, [openMesaMode, companyKey, branchKey, manualOrder.mesa_party_mode]);

	useEffect(() => {
		if (!openMesaMode || !isOpenMesaMeseroMode(manualOrder)) return;
		const tableId = String(manualOrder.selected_table_id ?? '').trim();
		if (!tableId || !recentWaiters.length) return;
		if (String(manualOrder.client_name ?? '').trim()) return;
		if (autofilledWaiterForTableRef.current === tableId) return;
		autofilledWaiterForTableRef.current = tableId;
		updateClientName?.(recentWaiters[0]);
	}, [
		openMesaMode,
		manualOrder.mesa_party_mode,
		manualOrder.selected_table_id,
		manualOrder.client_name,
		recentWaiters,
		updateClientName,
	]);

    const clientSuggestions = useMemo(
        () => filterClientsByNameOrPhone(clients, manualOrder.client_name),
        [clients, manualOrder.client_name],
    );

    const clientSelectOpts = useMemo(
        () => ({
            branchDeliveryCfg,
            subtotal: Number(manualOrder.total) || 0,
        }),
        [branchDeliveryCfg, manualOrder.total],
    );

    const showClientSuggestions =
        clientSuggestionsOpen &&
        clientSuggestions.length > 0 &&
        normalizeSearch(manualOrder.client_name).length >= 1;

    useEffect(() => {
        const onDocClick = (e) => {
            if (!clientSearchRef.current?.contains(e.target)) {
                setClientSuggestionsOpen(false);
            }
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, []);

	const settingsFulfillments = manualOrder.manualOrderSettings?.enabledFulfillments ?? { table: true, pickup: true, delivery: true };
    const resolvedLocalChannels = useMemo(
		() => {
			const channels = enabledLocalChannels ?? { mesa: true, retiro: true, delivery: true };
			return {
				mesa: channels.mesa !== false && settingsFulfillments.table !== false,
				retiro: channels.retiro !== false && settingsFulfillments.pickup !== false,
				delivery: channels.delivery !== false && settingsFulfillments.delivery !== false,
			};
		},
		[
            enabledLocalChannels?.mesa,
            enabledLocalChannels?.retiro,
            enabledLocalChannels?.delivery,
			settingsFulfillments.table,
			settingsFulfillments.pickup,
			settingsFulfillments.delivery,
        ],
    );
    const localFulfillmentMode = getLocalFulfillmentMode(manualOrder);
    const openMesaFulfillmentMode = openMesaMode ? localFulfillmentMode : null;
	const isQuickSaleMesa = !openMesaMode && localFulfillmentMode === 'mesa';
	const contextualFulfillment = isDelivery || localFulfillmentMode === 'delivery'
		? 'delivery'
		: localFulfillmentMode === 'mesa'
			? 'table'
			: 'pickup';
	const customerRequirements = requirementsFor(manualOrder.manualOrderSettings, contextualFulfillment);
	const phoneLockedOn = Boolean(customerRequirements.phone) || contextualFulfillment === 'delivery';
	const showDocumentField = Boolean(includeDocument);
	const showPhoneField = Boolean(includePhone) || phoneLockedOn;
	const requiredMark = (required) => required
		? <span className="text-gc-danger"> *</span>
		: <span className="font-normal text-gc-text-muted"> (opcional)</span>;

    const showNamedZonePicker = Boolean(
        branchDeliveryCfg &&
        isDelivery &&
        effectiveDeliveryPricingMode(branchDeliveryCfg) === 'named' &&
        (branchDeliveryCfg.namedAreas?.length ?? 0) > 0,
    );

    const namedAreaAutoMode = showNamedZonePicker &&
        String(branchDeliveryCfg?.namedAreaResolution ?? '').toLowerCase() === 'address_matched';
    const manualNamedAreaMode = isDelivery && isManualNamedDeliveryMode(branchDeliveryCfg);

    const deliveryValidationError = useMemo(() => {
        if (!isDelivery || branchDeliveryCfgLoading) return null;
        return validateManualDeliveryDetails(manualOrder, branchDeliveryCfg);
    }, [
        isDelivery,
        branchDeliveryCfgLoading,
        branchDeliveryCfg,
        manualOrder.order_type,
        manualOrder.delivery_address,
        manualOrder.delivery_reference,
        manualOrder.delivery_named_area_id,
        manualOrder.delivery_km,
        manualOrder.total,
        manualOrder.items_subtotal,
    ]);

    const showDistancePricing = Boolean(
        branchDeliveryCfg &&
        isDelivery &&
        effectiveDeliveryPricingMode(branchDeliveryCfg) === 'distance',
    );

    const isExternalDeliveryPricing = Boolean(
        branchDeliveryCfg &&
        isDelivery &&
        effectiveDeliveryPricingMode(branchDeliveryCfg) === 'external',
    );

    const distanceAutoMode = showDistancePricing &&
        isValidLatLng(branchDeliveryCfg?.originLat, branchDeliveryCfg?.originLng);

    const placesRegion = useMemo(() => {
        const country = resolveEffectiveCountry(branch, companyProfile);
        return isVenezuelaCountry(country) ? 've' : 'cl';
    }, [branch, companyProfile]);

    const placesBias = useMemo(() => {
        if (!isValidLatLng(branchDeliveryCfg?.originLat, branchDeliveryCfg?.originLng)) {
            return { lat: undefined, lng: undefined };
        }
        return {
            lat: Number(branchDeliveryCfg.originLat),
            lng: Number(branchDeliveryCfg.originLng),
        };
    }, [branchDeliveryCfg?.originLat, branchDeliveryCfg?.originLng]);

    const placesMaxKm = useMemo(() => {
        const maxKm = Number(branchDeliveryCfg?.maxDeliveryKm);
        return Number.isFinite(maxKm) && maxKm > 0 ? maxKm : undefined;
    }, [branchDeliveryCfg?.maxDeliveryKm]);

    const [localPlaceState, setLocalPlaceState] = useState('');

    useEffect(() => {
        if (!isValidLatLng(placesBias.lat, placesBias.lng)) {
            setLocalPlaceState('');
            return undefined;
        }
        const ac = new AbortController();
        void reverseGeocodeLocality({
            lat: placesBias.lat,
            lng: placesBias.lng,
            signal: ac.signal,
        })
            .then((place) => {
                if (ac.signal.aborted) return;
                setLocalPlaceState(String(place?.state ?? '').trim());
            })
            .catch(() => {
                if (!ac.signal.aborted) setLocalPlaceState('');
            });
        return () => ac.abort();
    }, [placesBias.lat, placesBias.lng]);

    const applyDistanceFromCoords = (lat, lng, label, { silent = false } = {}) => {
        if (!isValidLatLng(branchDeliveryCfg?.originLat, branchDeliveryCfg?.originLng)) return false;
        if (!isValidLatLng(lat, lng)) return false;
        const km = haversineKm(
            { lat: Number(branchDeliveryCfg.originLat), lng: Number(branchDeliveryCfg.originLng) },
            { lat: Number(lat), lng: Number(lng) },
        );
        const safeKm = Number.isFinite(km) && km >= 0 ? km : 0;
        updateDeliveryKm(safeKm.toFixed(2));
        if (!silent) {
            showNotify?.(
                `Distancia desde el local: ${safeKm.toFixed(2)} km${label ? ` (${label})` : ''}`,
                'success',
            );
        }
        return true;
    };

    const handleDetectZone = async (addressOverride) => {
        if (detectingZone) return;
        const branchId = String(branch?.id ?? '').trim();
        const address = String(addressOverride ?? manualOrder.delivery_address ?? '').trim();
        if (!branchId) {
            showNotify?.('Selecciona una sucursal primero.', 'warning');
            return;
        }
        if (!address) {
            showNotify?.('Escribe una dirección para detectar la zona.', 'warning');
            return;
        }
        setDetectingZone(true);
        try {
            const result = await geocodeAddress({ branchId, address });
            if (result.ok) {
                updateDeliveryNamedAreaId(result.namedAreaId);
                showNotify?.(`Zona detectada: ${result.label}`, 'success');
            } else {
                showNotify?.(result.message, 'warning');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Error al detectar la zona';
            showNotify?.(msg, 'error');
        } finally {
            setDetectingZone(false);
        }
    };

    const handleCalculateDistance = async ({
        addressOverride,
        silent = false,
    } = {}) => {
        if (calculatingDistance) return false;
        const address = String(addressOverride ?? manualOrder.delivery_address ?? '').trim();
        if (!address) {
            if (!silent) showNotify?.('Escribe una dirección para calcular la distancia.', 'warning');
            return false;
        }
        if (address.length < 8) {
            if (!silent) {
                showNotify?.('Escribe una dirección más completa para calcular la distancia.', 'warning');
            }
            return false;
        }
        if (!isValidLatLng(branchDeliveryCfg?.originLat, branchDeliveryCfg?.originLng)) {
            if (!silent) {
                showNotify?.(
                    'Configura la ubicación del local en Settings → Delivery para autocalcular distancia.',
                    'warning',
                );
            }
            return false;
        }
        setCalculatingDistance(true);
        try {
            const result = await geocodeToCoords({
                address,
                region: placesRegion,
                lat: placesBias.lat,
                lng: placesBias.lng,
                maxKm: placesMaxKm,
                state: localPlaceState || undefined,
            });
            if (!result.ok) {
                if (!silent) showNotify?.(result.message, 'warning');
                return false;
            }
            if (Number.isFinite(result.km)) {
                updateDeliveryKm(Number(result.km).toFixed(2));
                if (!silent) {
                    showNotify?.(
                        `Distancia desde el local: ${Number(result.km).toFixed(2)} km (${result.label})`,
                        'success',
                    );
                }
                return true;
            }
            return applyDistanceFromCoords(result.lat, result.lng, result.label, { silent });
        } catch (err) {
            if (!silent) {
                const msg = err instanceof Error ? err.message : 'Error al calcular la distancia';
                showNotify?.(msg, 'error');
            }
            return false;
        } finally {
            setCalculatingDistance(false);
        }
    };

    const lastAutoDistanceAddressRef = useRef('');

    useEffect(() => {
        if (!distanceAutoMode || !isDelivery) return undefined;
        const address = String(manualOrder.delivery_address ?? '').trim();
        if (address.length < 8) return undefined;
        if (address === lastAutoDistanceAddressRef.current) return undefined;
        if (!isValidLatLng(branchDeliveryCfg?.originLat, branchDeliveryCfg?.originLng)) return undefined;

        const ac = new AbortController();
        const timer = window.setTimeout(() => {
            void (async () => {
                setCalculatingDistance(true);
                try {
                    const result = await geocodeToCoords({
                        address,
                        region: placesRegion,
                        lat: placesBias.lat,
                        lng: placesBias.lng,
                        maxKm: placesMaxKm,
                        state: localPlaceState || undefined,
                        signal: ac.signal,
                    });
                    if (ac.signal.aborted) return;
                    if (!result.ok) return;
                    if (Number.isFinite(result.km)) {
                        updateDeliveryKm(Number(result.km).toFixed(2));
                        lastAutoDistanceAddressRef.current = address;
                        return;
                    }
                    const applied = applyDistanceFromCoords(result.lat, result.lng, result.label, { silent: true });
                    if (applied) lastAutoDistanceAddressRef.current = address;
                } catch (err) {
                    if (err?.name === 'AbortError' || ac.signal.aborted) return;
                } finally {
                    if (!ac.signal.aborted) setCalculatingDistance(false);
                }
            })();
        }, 700);

        return () => {
            window.clearTimeout(timer);
            ac.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- solo reacciona a dirección/origen
    }, [
        distanceAutoMode,
        isDelivery,
        manualOrder.delivery_address,
        placesBias.lat,
        placesBias.lng,
        placesMaxKm,
        localPlaceState,
        placesRegion,
    ]);

    const handleAddressSuggestionPick = async (item) => {
        if (distanceAutoMode && item?.lat != null && item?.lng != null) {
            lastAutoDistanceAddressRef.current = String(item.label ?? '').trim();
            applyDistanceFromCoords(item.lat, item.lng, item.label, { silent: true });
            return;
        }
        if (distanceAutoMode && String(item?.label ?? '').trim()) {
            const label = String(item.label).trim();
            const ok = await handleCalculateDistance({ addressOverride: label, silent: true });
            if (ok) lastAutoDistanceAddressRef.current = label;
            return;
        }
        if (namedAreaAutoMode && String(item?.label ?? '').trim()) {
            void handleDetectZone(item.label);
        }
    };

    const deliveryAddressSuggest = (
        <DeliveryPlaceSuggestInput
            id="manual-order-delivery-address"
            variant="manual"
            placeholder="DIRECCIÓN DE ENTREGA *"
            value={manualOrder.delivery_address}
            onChange={updateDeliveryAddress}
            onPick={handleAddressSuggestionPick}
            region={placesRegion}
            biasLat={placesBias.lat}
            biasLng={placesBias.lng}
            maxKm={placesMaxKm}
            state={localPlaceState || undefined}
            ariaRequired
            aria-label="Dirección de entrega"
            inputClassName={cn(inputClass, 'pl-10 font-semibold')}
            wrapClassName="w-full"
        />
    );

    const handleSelectClient = (client) => {
        applyClientRecord?.(client, clientSelectOpts);
        setClientSuggestionsOpen(false);
		setActiveSuggestionIndex(-1);
    };

    const handleClientNameChange = (value) => {
        updateClientName(sanitizeInputLive(value), { fromClientSelect: false });
        setClientSuggestionsOpen(true);
		setActiveSuggestionIndex(-1);
    };

	const handleClientComboboxKeyDown = (event) => {
		if (!showClientSuggestions && event.key === 'ArrowDown') setClientSuggestionsOpen(true);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActiveSuggestionIndex((index) => Math.min(clientSuggestions.length - 1, index + 1));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActiveSuggestionIndex((index) => Math.max(0, index - 1));
		} else if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
			event.preventDefault();
			handleSelectClient(clientSuggestions[activeSuggestionIndex]);
		} else if (event.key === 'Escape') {
			setClientSuggestionsOpen(false);
			setActiveSuggestionIndex(-1);
		}
	};

    const handleOrderTypeChange = (type) => {
        updateOrderType(type, branchDeliveryCfg, Number(manualOrder.total) || 0);
    };

	useEffect(() => {
		if (openMesaMode) {
			const current = getLocalFulfillmentMode(manualOrder);
			if (resolvedLocalChannels[current]) return;
			const fallback = ['mesa', 'retiro', 'delivery'].find((mode) => resolvedLocalChannels[mode]);
			if (fallback) updateLocalFulfillmentMode?.(fallback);
			return;
		}
		const current = getLocalFulfillmentMode(manualOrder);
		if (current === 'mesa' && resolvedLocalChannels.mesa) return;
		if (current === 'delivery' && resolvedLocalChannels.delivery) return;
		if (current === 'retiro' && resolvedLocalChannels.retiro) return;
		const fallback = ['retiro', 'delivery', 'mesa'].find((mode) => resolvedLocalChannels[mode]);
		if (fallback) updateLocalFulfillmentMode?.(fallback);
	}, [openMesaMode, manualOrder.local_fulfillment_mode, isDelivery, resolvedLocalChannels, updateLocalFulfillmentMode]);

    const validationIcon = (
        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
            <CheckCircle2 size={16} className="text-gc-accent/75" aria-hidden />
        </div>
    );

    const clientSuggestionsList = (suggestionsId) => showClientSuggestions ? (
        <ul
            id={suggestionsId}
            className="manual-order-client-suggestions"
            role="listbox"
        >
            {clientSuggestions.map((client, index) => {
                const isActive = index === activeSuggestionIndex;
                return (
                    <li key={client.id} role="presentation">
                        <button
                            type="button"
                            id={`${suggestionsId}-option-${index}`}
                            role="option"
                            aria-selected={isActive}
                            className={cn('manual-order-client-suggestion', isActive && 'is-active')}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setActiveSuggestionIndex(index)}
                            onClick={() => handleSelectClient(client)}
                        >
                            <span className="manual-order-client-suggestion__name">
                                {highlightClientMatch(client.name, manualOrder.client_name)}
                            </span>
                            <span className="manual-order-client-suggestion__meta">
                                {[client.rut, client.phone].filter(Boolean).join(' · ') || 'Sin documento ni teléfono'}
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    ) : null;

    const registeredClientSearchField = (placeholder, suggestionsId = 'manual-order-client-suggestions') => (
        <div className="grid gap-3">
            <div className="manual-order-client-search relative z-10 w-full" ref={clientSearchRef}>
                <input
                    type="text"
                    placeholder={placeholder}
                    className={inputClass}
                    value={manualOrder.client_name}
                    onChange={(e) => handleClientNameChange(e.target.value)}
                    onFocus={() => setClientSuggestionsOpen(true)}
					onKeyDown={handleClientComboboxKeyDown}
                    autoComplete="off"
					role="combobox"
					aria-autocomplete="list"
                    aria-label="Buscar cliente registrado"
                    aria-expanded={showClientSuggestions}
                    aria-controls={suggestionsId}
					aria-activedescendant={activeSuggestionIndex >= 0 ? `${suggestionsId}-option-${activeSuggestionIndex}` : undefined}
                    style={{
                        paddingRight:
                            manualOrder.selected_client_id || manualOrder.client_name.trim().length >= 2
                                ? '40px'
                                : undefined,
                    }}
                />
                {(manualOrder.selected_client_id || manualOrder.client_name.trim().length >= 2) && validationIcon}
                {clientSuggestionsList(suggestionsId)}
            </div>
        </div>
    );

    const openMesaContactFields = ({
        namePlaceholder,
        suggestionsId = 'manual-order-open-mesa-client-suggestions',
        lockIdentityFields = false,
        allowClientSearch = true,
    }) => (
        <div className="mt-3 grid gap-3">
            {allowClientSearch ? (
                registeredClientSearchField(namePlaceholder, suggestionsId)
            ) : (
                <div className="relative w-full">
                    <input
                        type="text"
                        placeholder={namePlaceholder}
                        className={inputClass}
                        value={manualOrder.client_name}
                        onChange={(e) => handleClientNameChange(e.target.value)}
                        autoComplete="off"
                        aria-label={namePlaceholder}
                    />
					{recentWaiters.length > 0 ? (
						<div className="mt-2 flex flex-wrap gap-2" role="list" aria-label="Meseros recientes">
							{recentWaiters.map((name) => {
								const selected = String(manualOrder.client_name ?? '').trim().toLowerCase() === name.toLowerCase();
								return (
									<Button
										key={name}
										type="button"
										variant="outline"
										size="sm"
										role="listitem"
										className={cn(
											'h-9 rounded-[10px] px-3 text-xs font-semibold',
											selected && selectedToggleActiveClass,
										)}
										onClick={() => updateClientName?.(name)}
									>
										{name}
									</Button>
								);
							})}
						</div>
					) : null}
                </div>
            )}

			{!lockIdentityFields ? (
				<>
					<div className="grid gap-2">
						<FieldIncludeSwitch
							id="open-mesa-include-document"
							label={formStrategy.idName}
							checked={showDocumentField}
							onCheckedChange={setIncludeDocument}
							required={customerRequirements.document}
						/>
						{showDocumentField ? (
							<div className="relative w-full">
								<input
									type="text"
									placeholder={`Ingresa ${formStrategy.idName}`}
									className={inputClass}
									value={manualOrder.client_rut}
									onChange={handleRutChange}
									style={{
										...(manualOrder.client_rut ? getInputStyle(rutValid) : {}),
										paddingRight: manualOrder.client_rut && rutValid ? '40px' : undefined,
									}}
								/>
								{manualOrder.client_rut && rutValid ? validationIcon : null}
							</div>
						) : null}
					</div>

					<div className="grid gap-2">
						<FieldIncludeSwitch
							id="open-mesa-include-phone"
							label="Teléfono"
							checked={showPhoneField}
							onCheckedChange={setIncludePhone}
							locked={phoneLockedOn}
							required={customerRequirements.phone || phoneLockedOn}
						/>
						{showPhoneField ? (
							<div className="relative w-full">
								<input
									type="tel"
									placeholder={`${formStrategy.phonePrefix}…`}
									className={inputClass}
									value={manualOrder.client_phone}
									onChange={handlePhoneChange}
									style={{
										...(phoneHasMeaningfulDigits(manualOrder.client_phone, formStrategy.phonePrefix)
											? getInputStyle(phoneValid)
											: {}),
										paddingRight:
											phoneHasMeaningfulDigits(manualOrder.client_phone, formStrategy.phonePrefix) && phoneValid
												? '40px'
												: undefined,
									}}
								/>
								{phoneHasMeaningfulDigits(manualOrder.client_phone, formStrategy.phonePrefix) && phoneValid
									? validationIcon
									: null}
							</div>
						) : null}
					</div>
				</>
			) : null}

            {lockIdentityFields ? (
                <p className={hintClass}>
					Elegí un mesero reciente o escribí el nombre. Se recuerda en esta sucursal para la próxima vez.
                </p>
            ) : null}
        </div>
    );

    const inputWithIcon = (icon, children, muted = false) => (
        <div className="relative w-full">
            <span className={cn(
                'pointer-events-none absolute left-3 top-1/2 z-[1] -translate-y-1/2 text-gc-text-muted',
                muted && 'opacity-70',
            )}>
                {icon}
            </span>
            {children}
        </div>
    );

    const deliveryFields = isDelivery ? (
        <div className={`mt-3 flex flex-col ${spacing.normal}`}>
            {namedAreaAutoMode ? (
                <>
                    {inputWithIcon(
                        <MapPin size={14} aria-hidden />,
                        deliveryAddressSuggest,
                    )}
                    {placesBias.lat != null ? (
                        <p className={`${textScale.micro} leading-relaxed text-gc-text-muted`}>
                            Sugerencias cerca del local
                            {localPlaceState ? ` · ${localPlaceState}` : ''}
                            {placesMaxKm != null ? ` · hasta ${placesMaxKm} km` : ''}
                            .
                        </p>
                    ) : null}
                    <Button variant="outline"
                        type="button"
                        className={inlineActionClass}
                        onClick={() => handleDetectZone()}
                        disabled={detectingZone || !manualOrder.delivery_address}
                    >
                        {detectingZone ? (
                            <>
                                <Loader2 size={14} className="animate-spin" />
                                Detectando...
                            </>
                        ) : (
                            <>
                                <MapPin size={14} />
                                Detectar zona
                            </>
                        )}
                    </Button>
                </>
            ) : null}

            {showNamedZonePicker ? (
                inputWithIcon(
                    <MapPin size={14} aria-hidden />,
                    <select
                        id="manual-order-delivery-zone"
                        aria-label="Zona de entrega"
                        className={cn(inputClass, 'pl-10 font-semibold')}
                        value={manualOrder.delivery_named_area_id || ''}
                        onChange={(e) => updateDeliveryNamedAreaId(e.target.value)}
                    >
                        <option value="">{namedAreaAutoMode ? 'ZONA DETECTADA / SELECCIÓN MANUAL' : 'ZONA DE ENTREGA *'}</option>
                        {(branchDeliveryCfg?.namedAreas ?? []).map((z) => (
                            <option key={z.id} value={z.id}>
                                {z.name} — {formatMoney(z.feeFlat)}
                            </option>
                        ))}
                    </select>,
                )
            ) : null}

            {showNamedZonePicker ? (
                inputWithIcon(
                    <MapPin size={14} className="opacity-70" aria-hidden />,
                    <input
                        type="text"
                        aria-label={manualNamedAreaMode ? 'Referencia dentro de la zona' : 'Referencia de entrega'}
                        placeholder={
                            manualNamedAreaMode
                                ? 'CALLE, NÚMERO, CASA O PUNTO DE REFERENCIA *'
                                : 'REFERENCIA DE ENTREGA (OPC.)'
                        }
                        className={cn(inputClass, 'pl-10')}
                        value={manualOrder.delivery_reference}
                        onChange={(e) => updateDeliveryReference(e.target.value)}
                        aria-required={manualNamedAreaMode}
                    />,
                    true,
                )
            ) : null}

            {!showNamedZonePicker ? (
                <>
                    {inputWithIcon(
                        <MapPin size={14} aria-hidden />,
                        deliveryAddressSuggest,
                    )}
                    {distanceAutoMode || placesBias.lat != null ? (
                        <p className={`${textScale.micro} leading-relaxed text-gc-text-muted`}>
                            Sugerencias cerca del local
                            {localPlaceState ? ` · ${localPlaceState}` : ''}
                            {placesMaxKm != null ? ` · hasta ${placesMaxKm} km` : ''}
                            .
                        </p>
                    ) : null}
                </>
            ) : null}

            {distanceAutoMode ? (
                <div className="flex flex-wrap items-center gap-2">
                    <p className={`${textScale.micro} leading-relaxed text-gc-text-muted`}>
                        {calculatingDistance
                            ? 'Calculando distancia desde el local…'
                            : manualOrder.delivery_km
                                ? `Distancia desde el local: ${manualOrder.delivery_km} km`
                                : 'La distancia se calcula sola desde la ubicación del local.'}
                    </p>
                    <Button
                        variant="outline"
                        type="button"
                        className={cn(inlineActionClass, 'min-h-[34px] py-1.5')}
                        onClick={() => {
                            lastAutoDistanceAddressRef.current = '';
                            void handleCalculateDistance({ silent: false });
                        }}
                        disabled={calculatingDistance || !manualOrder.delivery_address}
                    >
                        {calculatingDistance ? (
                            <>
                                <Loader2 size={14} className="animate-spin" />
                                Calculando...
                            </>
                        ) : (
                            <>
                                <MapPin size={14} />
                                Recalcular
                            </>
                        )}
                    </Button>
                </div>
            ) : null}

            {showDistancePricing ? (
                inputWithIcon(
                    <MapPin size={14} className="opacity-70" aria-hidden />,
                    <input
                        type="text"
                        inputMode="decimal"
                        placeholder={
                            distanceAutoMode
                                ? 'KM DESDE EL LOCAL (auto)'
                                : 'DISTANCIA APROX. (KM) — OPC.'
                        }
                        className={cn(inputClass, 'pl-10')}
                        value={manualOrder.delivery_km}
                        onChange={(e) => updateDeliveryKm(e.target.value)}
                        aria-label="Distancia desde el local en kilómetros"
                    />,
                    true,
                )
            ) : null}

            {showDistancePricing && !distanceAutoMode && (
                <p className={`${textScale.micro} italic leading-relaxed text-gc-text-muted`}>
                    Configura la ubicación del local en Settings → Delivery para calcular la distancia automáticamente desde el local.
                </p>
            )}

            {isExternalDeliveryPricing ? (
                <p className={`${textScale.micro} leading-relaxed text-gc-text-muted`}>
                    El costo de envío lo define el proveedor externo (p. ej. Uber Direct).
                </p>
            ) : null}

            {inputWithIcon(
                <Banknote size={14} aria-hidden />,
                <input
                    type="number"
                    placeholder={
                        canOverrideDeliveryFee
                            ? (showNamedZonePicker || showDistancePricing
                                ? 'COSTO ENVÍO (calculado; puedes ajustar)'
                                : 'COSTO DE ENVÍO (OPCIONAL)')
                            : (showNamedZonePicker || showDistancePricing
                                ? 'COSTO ENVÍO (calculado automáticamente)'
                                : 'COSTO DE ENVÍO')
                    }
                    className={cn(inputClass, 'pl-10 font-semibold')}
                    value={manualOrder.delivery_fee || ''}
                    onChange={(e) => updateDeliveryFee(e.target.value)}
                    readOnly={!canOverrideDeliveryFee || isExternalDeliveryPricing}
                    aria-readonly={!canOverrideDeliveryFee || isExternalDeliveryPricing}
                />,
            )}

            {deliveryValidationError ? (
                <p className={`${hintClass} !border-gc-danger/30 !bg-gc-danger/10 !text-gc-danger`} role="alert">
                    {deliveryValidationError}
                </p>
            ) : null}
        </div>
    ) : (
        <p className={hintClass}>
            El cliente retira en el local. No se requieren datos de despacho.
        </p>
    );

    if (openMesaMode) {
        const channels = resolvedLocalChannels;
        const fulfillmentMode = openMesaFulfillmentMode;
        const isMesa = fulfillmentMode === 'mesa';
        const isRetiro = fulfillmentMode === 'retiro';
        const isMesero = isOpenMesaMeseroMode(manualOrder);
        const visibleModes = LOCAL_FULFILLMENT_MODES.filter((mode) => channels[mode]);
		const lockedTableCode = String(manualOrder.selected_table_code ?? '').trim();
		const lockedToFloorTable = Boolean(String(manualOrder.selected_table_id ?? '').trim());

        return (
            <div className="w-full">
				<div className={`manual-order-client-form-grid grid grid-cols-1 ${spacing.normal} lg:grid-cols-2 lg:items-start`}>
					<div className={sectionCardClass}>
						<SectionHeader icon={Store} tone="accent">
							{lockedToFloorTable ? 'Mesa seleccionada' : 'Tipo de pedido local'}
						</SectionHeader>
						{lockedToFloorTable ? (
							<>
								<p className={`mb-3 ${textScale.micro} leading-relaxed text-gc-text-muted`}>
									Consumo en salón vinculado al plano del local.
								</p>
								<div className={hintClass}>
									<strong>{lockedTableCode || 'Mesa'}</strong>
									{' · '}El cobro se registra al cerrar la mesa.
								</div>
							</>
						) : visibleModes.length > 0 ? (
							<>
								<p className={`mb-3 ${textScale.micro} leading-relaxed text-gc-text-muted`}>
									Elige cómo se atenderá este pedido local.
								</p>
								<div className={cn(
									`grid ${spacing.normal}`,
									visibleModes.length === 1
										? 'grid-cols-1'
										: visibleModes.length === 2
											? 'grid-cols-1 min-[400px]:grid-cols-2'
											: 'grid-cols-1 min-[400px]:grid-cols-3',
								)}>
									{channels.mesa ? (
										<Button variant="outline"
											type="button"
											className={cn(
												'manual-order-toggle',
												toggleBaseClass,
												isMesa ? fulfillmentActiveClass.mesa : null,
											)}
											onClick={() => updateLocalFulfillmentMode?.('mesa')}
										>
											<TableRestaurantIcon size={18} />
											Mesa
										</Button>
									) : null}
									{channels.retiro ? (
										<Button variant="outline"
											type="button"
											className={cn(
												'manual-order-toggle',
												toggleBaseClass,
												isRetiro ? fulfillmentActiveClass.retiro : null,
											)}
											onClick={() => updateLocalFulfillmentMode?.('retiro')}
										>
											<PickupBagIcon size={18} />
											Retiro
										</Button>
									) : null}
									{channels.delivery ? (
										<Button variant="outline"
											type="button"
											className={cn(
												'manual-order-toggle',
												toggleBaseClass,
												isDelivery ? fulfillmentActiveClass.delivery : null,
											)}
											onClick={() => updateLocalFulfillmentMode?.('delivery')}
										>
											<DeliveryMotoIcon size={18} />
											Delivery
										</Button>
									) : null}
								</div>
								{isMesa ? (
									<p className={hintClass}>
										Consumo en salón. Las mesas siempre se abren pendientes; el cobro se registra al cerrar.
									</p>
								) : null}
								{isRetiro ? (
									<p className={hintClass}>
										{manualOrder.charge_now
											? 'Retiro en local. El pago se registra al abrir el retiro.'
											: 'Retiro en local. El pago se registra al cerrar el retiro.'}
									</p>
								) : null}
								{isDelivery ? (
									<p className={hintClass}>
										{manualOrder.charge_now
											? 'Delivery. El pago se registra al abrir el delivery.'
											: 'Delivery. El pago se registra al cerrar el delivery.'}
									</p>
								) : null}
							</>
						) : (
							<p className={hintClass}>
								No hay tipos de pedido local habilitados para esta sucursal.
							</p>
						)}
					</div>

					<div className={sectionCardClass}>
						<SectionHeader icon={User} tone="accent">
							{isMesa ? (isMesero ? 'Mesero' : 'Cliente') : 'Datos cliente'}
						</SectionHeader>
						<p className={`mb-3 ${textScale.micro} leading-relaxed text-gc-text-muted`}>
							{isMesa && isMesero
								? 'Referencia del mesero para identificar la sesión en salón.'
								: 'Busca un cliente registrado o completa sus datos de contacto.'}
						</p>

						{isMesa ? (
							<div className={`mb-3 grid grid-cols-1 ${spacing.normal} min-[400px]:grid-cols-2`}>
								<Button variant="outline"
									type="button"
									className={cn('manual-order-toggle', toggleBaseClass, isMesero && selectedToggleActiveClass)}
									onClick={() => updateMesaPartyMode?.('mesero')}
								>
									<User size={16} />
									Mesero
								</Button>
								<Button variant="outline"
									type="button"
									className={cn('manual-order-toggle', toggleBaseClass, !isMesero && selectedToggleActiveClass)}
									onClick={() => updateMesaPartyMode?.('cliente')}
								>
									<User size={16} />
									Cliente
								</Button>
							</div>
						) : null}

						{isMesa && isMesero
							? openMesaContactFields({
								namePlaceholder: 'NOMBRE DEL MESERO *',
								lockIdentityFields: true,
								allowClientSearch: false,
							})
							: openMesaContactFields({
								namePlaceholder: 'BUSCAR CLIENTE O NOMBRE *',
								lockIdentityFields: false,
								allowClientSearch: true,
							})}
					</div>

					{isDelivery ? (
						<div className={cn(sectionCardClass, 'lg:col-span-2')}>
							<SectionHeader icon={Truck} tone="accent">Datos de delivery</SectionHeader>
							{branchDeliveryCfgLoading ? (
								<p className={`flex items-center gap-2 ${textScale.micro} text-gc-text-muted`} role="status">
									<Loader2 size={14} className="animate-spin" aria-hidden />
									Cargando zonas y tarifas de delivery…
								</p>
							) : (
								deliveryFields
							)}
							<p className={hintClass}>
								{manualOrder.charge_now
									? 'El pago se registra al abrir el delivery.'
									: 'El pago se registra al cerrar el delivery.'}
							</p>
						</div>
					) : null}
				</div>
            </div>
        );
    }

    return (
        <div className="w-full">
            <div className={`manual-order-client-form-grid grid grid-cols-1 ${spacing.normal} lg:grid-cols-2 lg:items-start`}>
            <div className={sectionCardClass}>
                <SectionHeader icon={User} tone="accent">
					{isQuickSaleMesa ? 'Referencia de mesa' : 'Datos cliente'}
				</SectionHeader>
                <p className={`mb-3 ${textScale.micro} leading-relaxed text-gc-text-muted`}>
					{isQuickSaleMesa
						? 'Indica el número o nombre de mesa para que cocina identifique el pedido.'
						: 'Busca un cliente registrado o completa sus datos de contacto.'}
                </p>

                <div className="grid gap-3">
                    <div className={cn(fieldLabelClass, 'manual-order-client-search')}>
                        <label htmlFor="manual-order-client-name">
							{isQuickSaleMesa
								? <>Nº mesa o referencia{requiredMark(true)}</>
								: <>Nombre completo{requiredMark(customerRequirements.name)}</>}
						</label>
                        <div className="relative z-10 w-full" ref={clientSearchRef}>
                            <input
                                id="manual-order-client-name"
                                type="text"
                                placeholder={isQuickSaleMesa ? 'Ej. 3 o Mesa 2' : 'Buscar o escribir nombre'}
                                className={inputClass}
                                value={manualOrder.client_name}
                                onChange={(e) => handleClientNameChange(e.target.value)}
                                onFocus={() => {
									if (!isQuickSaleMesa) setClientSuggestionsOpen(true);
								}}
								onKeyDown={isQuickSaleMesa ? undefined : handleClientComboboxKeyDown}
                                autoComplete="off"
								role={isQuickSaleMesa ? undefined : 'combobox'}
								aria-autocomplete={isQuickSaleMesa ? undefined : 'list'}
                                aria-label={isQuickSaleMesa ? 'Número o referencia de mesa' : 'Nombre completo del cliente'}
                                aria-expanded={isQuickSaleMesa ? undefined : showClientSuggestions}
                                aria-controls={isQuickSaleMesa ? undefined : 'manual-order-client-suggestions'}
								aria-activedescendant={
									isQuickSaleMesa || activeSuggestionIndex < 0
										? undefined
										: `manual-order-client-suggestions-option-${activeSuggestionIndex}`
								}
                                style={{
                                    paddingRight: manualOrder.client_name.length >= 2 ? '40px' : undefined,
                                }}
                            />
                            {manualOrder.client_name.length >= 2 && validationIcon}
                            {!isQuickSaleMesa ? clientSuggestionsList('manual-order-client-suggestions') : null}
                        </div>
                    </div>

					{!isQuickSaleMesa ? (
						<>
					<div className="grid gap-2">
						<FieldIncludeSwitch
							id="manual-order-include-document"
							label={formStrategy.idName}
							checked={showDocumentField}
							onCheckedChange={setIncludeDocument}
							required={customerRequirements.document}
						/>
						{showDocumentField ? (
							<div className="relative w-full">
								<input
									type="text"
									placeholder={`Ingresa ${formStrategy.idName}`}
									className={inputClass}
									value={manualOrder.client_rut}
									onChange={handleRutChange}
									style={{
										...(manualOrder.client_rut ? getInputStyle(rutValid) : {}),
										paddingRight: manualOrder.client_rut && rutValid ? '40px' : undefined,
									}}
								/>
								{manualOrder.client_rut && rutValid ? validationIcon : null}
							</div>
						) : null}
					</div>

					<div className="grid gap-2">
						<FieldIncludeSwitch
							id="manual-order-include-phone"
							label="Teléfono"
							checked={showPhoneField}
							onCheckedChange={setIncludePhone}
							locked={phoneLockedOn}
							required={customerRequirements.phone || phoneLockedOn}
						/>
						{showPhoneField ? (
							<div className="relative w-full">
								<input
									type="tel"
									placeholder={`${formStrategy.phonePrefix}…`}
									className={inputClass}
									value={manualOrder.client_phone}
									onChange={handlePhoneChange}
									style={{
										...(phoneHasMeaningfulDigits(manualOrder.client_phone, formStrategy.phonePrefix)
											? getInputStyle(phoneValid)
											: {}),
										paddingRight:
											phoneHasMeaningfulDigits(manualOrder.client_phone, formStrategy.phonePrefix) && phoneValid
												? '40px'
												: undefined,
									}}
								/>
								{phoneHasMeaningfulDigits(manualOrder.client_phone, formStrategy.phonePrefix) && phoneValid
									? validationIcon
									: null}
							</div>
						) : null}
					</div>
						</>
					) : null}
                    </div>
                </div>

                <div className={sectionCardClass}>
                    <SectionHeader icon={Truck} tone="accent">Tipo de entrega</SectionHeader>
                    <p className={`mb-3 ${textScale.micro} leading-relaxed text-gc-text-muted`}>
                        Elige cómo recibirá el cliente este pedido.
                    </p>

					{(() => {
						const visibleModes = [
							resolvedLocalChannels.mesa ? 'mesa' : null,
							resolvedLocalChannels.retiro ? 'retiro' : null,
							resolvedLocalChannels.delivery ? 'delivery' : null,
						].filter(Boolean);
						const isMesa = localFulfillmentMode === 'mesa';
						const isRetiro = localFulfillmentMode === 'retiro';
						return (
							<>
                    <div className={cn(
						`grid ${spacing.normal}`,
						visibleModes.length <= 1
							? 'grid-cols-1'
							: visibleModes.length === 2
								? 'grid-cols-1 min-[400px]:grid-cols-2'
								: 'grid-cols-1 min-[400px]:grid-cols-3',
					)}>
						{resolvedLocalChannels.mesa ? (
							<Button variant="outline"
								type="button"
								className={cn(
									'manual-order-toggle',
									toggleBaseClass,
									isMesa ? fulfillmentActiveClass.mesa : null,
								)}
								onClick={() => updateLocalFulfillmentMode?.('mesa')}
							>
								<TableRestaurantIcon size={18} />
								Mesa
							</Button>
						) : null}
						{resolvedLocalChannels.retiro ? (
							<Button variant="outline"
								type="button"
								className={cn(
									'manual-order-toggle',
									toggleBaseClass,
									isRetiro ? fulfillmentActiveClass.retiro : null,
								)}
								onClick={() => (
									localFulfillmentMode === 'mesa'
										? updateLocalFulfillmentMode?.('retiro')
										: handleOrderTypeChange('pickup')
								)}
							>
								<Store size={16} />
								Local / Retiro
							</Button>
						) : null}
						{resolvedLocalChannels.delivery ? (
							<Button variant="outline"
								type="button"
								className={cn(
									'manual-order-toggle',
									toggleBaseClass,
									isDelivery ? fulfillmentActiveClass.delivery : null,
								)}
								onClick={() => (
									localFulfillmentMode === 'mesa'
										? updateLocalFulfillmentMode?.('delivery')
										: handleOrderTypeChange('delivery')
								)}
							>
								<Truck size={16} />
								Delivery
							</Button>
						) : null}
                    </div>

                    <div className="mt-auto pt-1">
					{isMesa ? (
						<p className={hintClass}>
							Para que cocina identifique el pedido en salón. El cobro se registra al cerrar.
						</p>
					) : (
						<>
                    {deliveryFields}

					{showQuickSalePaymentChoice ? (
						<div className="mt-3">
							<p className={`mb-2 ${textScale.micro} font-semibold uppercase tracking-wide text-gc-text-muted`}>
								Pago
							</p>
							<div className={`grid grid-cols-1 ${spacing.normal} min-[400px]:grid-cols-2`}>
								<Button
									variant="outline"
									type="button"
									className={cn('manual-order-toggle', toggleBaseClass, !quickSalePaymentActive && selectedToggleActiveClass)}
									onClick={() => onSelectQuickSaleUnpaid?.()}
								>
									No pagado
								</Button>
								<Button
									variant="outline"
									type="button"
									className={cn('manual-order-toggle', toggleBaseClass, quickSalePaymentActive && selectedToggleActiveClass)}
									onClick={() => onSelectQuickSalePaid?.()}
								>
									<Banknote size={16} aria-hidden />
									Pago
								</Button>
							</div>
							{quickSalePaymentHint ? (
								<p className={hintClass} role="status">{quickSalePaymentHint}</p>
							) : (
								<p className={hintClass} role="status">
									Por defecto el pedido queda pendiente. Elige Pago para registrar el método.
								</p>
							)}
						</div>
					) : null}
						</>
					)}
                    </div>
							</>
						);
					})()}
                </div>
            </div>
        </div>
    );
};

export default React.memo(ClientForm);
