import React from 'react';
import { Check, CheckCircle2, ChevronDown, ChevronUp, ShoppingBag, Banknote } from 'lucide-react';
import {
	getLocalFulfillmentMode,
	hasManualOrderPaymentIntent,
	isBlankClientDocument,
	isOpenMesaMeseroMode,
	phoneHasMeaningfulDigits,
	validateManualDeliveryDetails,
} from '../../hooks/manual-order/manualOrderShared';
import {
	validateCheckoutPayment,
	isLocalOpenSessionOrder,
	getPaymentLabel,
} from '@/shared/utils/orderUtils';
import { cn } from '@/lib/utils';
import ClientForm from './ClientForm';
import OrderSummary from './OrderSummary';
import PaymentDetails from './PaymentDetails';
import DualCurrencyAmount from './DualCurrencyAmount';
import { Button } from "@/components/ui/button";
import { primaryActionButtonClass, selectedToggleActiveClass, spacing, textScale, toggleBaseClass } from './manualOrderStyles';
import SectionHeader from './SectionHeader';
import { validatePaymentLines } from '../../domain/payment-methods';
import { requirementsFor } from '../../domain/manual-order-settings';
import { formatMinor, majorToMinor } from '@/lib/money/minor-units';

export const DESKTOP_WIZARD_STEPS = 3;
export const TABLET_WIZARD_STEPS = 3;
export const MOBILE_WIZARD_STEPS = 3;

/** Roles de paso del wizard (números 1-based). */
export function resolveWizardStepRoles({
	openMesaMode = false,
	isEditMode = false,
	openMesaChargeNow = false,
	showClassicPaymentStep = false,
}) {
	const isOpenMesaCreate = Boolean(openMesaMode) && !isEditMode;
	if (isOpenMesaCreate) {
		return {
			isOpenMesaCreate: true,
			floor: 1,
			catalog: 2,
			client: 3,
			payment: openMesaChargeNow ? 4 : null,
		};
	}
	return {
		isOpenMesaCreate: false,
		floor: null,
		catalog: 1,
		client: 2,
		payment: (showClassicPaymentStep || openMesaChargeNow) ? 3 : null,
	};
}

export const stepNavBackClass =
	`flex max-w-[40%] flex-1 items-center justify-center rounded-[4px] border border-gc-border bg-gc-muted px-3.5 py-3 ${textScale.body} font-extrabold uppercase tracking-wide text-gc-text transition-all`;
export const stepNavNextClass = cn(
	primaryActionButtonClass,
	`flex-1 px-6 ${textScale.body} gap-0`,
);
export const confirmBtnClass = cn(
	primaryActionButtonClass,
	'manual-order-checkout-actions__confirm w-full',
);
export const checkoutColBase =
	'manual-order-checkout-col flex min-h-0 min-w-0 flex-col';
export const checkoutColCard =
	'rounded-[18px] border border-gc-border bg-gc-card shadow-sm';
export const openMesaPaymentCardClass =
	'manual-order-step-card flex min-h-0 flex-col overflow-visible rounded-[18px] border border-gc-border bg-gc-card p-4 shadow-sm sm:p-5';
export const openMesaToggleClass = toggleBaseClass;
export const openMesaHintClass =
	`mt-3 rounded-[12px] border border-gc-accent/20 bg-gc-accent/10 px-3 py-2.5 ${textScale.body} leading-relaxed text-gc-text-muted`;
export const checkoutActionsClass =
	`manual-order-checkout-actions flex w-full min-w-0 flex-shrink-0 flex-col ${spacing.compact} border-t border-gc-border bg-gc-card pt-3`;
export const checkoutBackBtnClass =
	`manual-order-checkout-actions__back flex min-h-[44px] w-full min-w-0 items-center justify-center rounded-[12px] border border-gc-border bg-gc-muted px-3 py-3 ${textScale.body} font-extrabold uppercase tracking-wide text-gc-text transition-colors`;

export function useManualOrderCheckoutFlow({
	manualOrder,
	couponPreview,
	branchDeliveryCfg,
	branchDeliveryCfgLoading,
	branchConfigError,
	effectiveOpenMesaMode,
	openMesaMode = false,
	openMesaChargeNow,
	isEditMode,
	editOrder,
	rutValid,
	phoneValid,
	orderStep,
	setOrderStep,
	wizardStepCount,
	isCompactNav,
	showClassicPaymentStep,
	showNotify,
}) {
	const deliveryFeeAmt =
		manualOrder.order_type === 'delivery' ? (Number(manualOrder.delivery_fee) || 0) : 0;
	const couponDiscountApplied =
		couponPreview?.variant === 'success' && Number(couponPreview.discount) > 0
			? Math.min(manualOrder.total ?? 0, Number(couponPreview.discount))
			: 0;
	const totalToPay = manualOrder.v2Enabled && manualOrder.quote
		? manualOrder.checkout_total
		: Math.max(0, (manualOrder.total ?? 0) - couponDiscountApplied + deliveryFeeAmt);

	const stepRoles = resolveWizardStepRoles({
		openMesaMode,
		isEditMode,
		openMesaChargeNow,
		showClassicPaymentStep,
	});

	const openMesaFulfillment = effectiveOpenMesaMode ? getLocalFulfillmentMode(manualOrder) : null;
	const openMesaSubmitLabel = ({
		loading,
		isEditMode: edit,
		openMesaFulfillment: fulfillment,
	}) => {
		if (loading) return edit ? 'GUARDANDO…' : 'ABRIENDO…';
		if (edit) return 'GUARDAR CAMBIOS';
		if (fulfillment === 'mesa') return 'ABRIR MESA';
		if (openMesaChargeNow) return fulfillment === 'delivery' ? 'COBRAR Y ABRIR DELIVERY' : 'COBRAR Y ABRIR RETIRO';
		return fulfillment === 'delivery' ? 'ABRIR DELIVERY PENDIENTE' : 'ABRIR RETIRO PENDIENTE';
	};

	const isOpenMesaMesero = () =>
		effectiveOpenMesaMode && isOpenMesaMeseroMode(manualOrder);

	const hasOpenMesaClientName = () => {
		if (isOpenMesaMesero()) {
			return String(manualOrder.client_name ?? '').trim().length >= 2;
		}
		const name = String(manualOrder.client_name ?? '').trim();
		return (
			Boolean(String(manualOrder.selected_client_id ?? '').trim())
			|| name.length >= 2
		);
	};

	const isDeliveryValidForOrder = () => {
		if (manualOrder.order_type !== 'delivery') return true;
		if (branchConfigError) return false;
		if (branchDeliveryCfgLoading) return false;
		return validateManualDeliveryDetails(manualOrder, branchDeliveryCfg) == null;
	};

	const fulfillmentForValidation = () => (
		manualOrder.order_type === 'delivery' || getLocalFulfillmentMode(manualOrder) === 'delivery'
			? 'delivery'
			: getLocalFulfillmentMode(manualOrder) === 'mesa'
				? 'table'
				: 'pickup'
	);

	const isContextCustomerValid = () => {
		const requirements = requirementsFor(manualOrder.manualOrderSettings, fulfillmentForValidation());
		const name = String(manualOrder.client_name ?? '').trim();
		const phone = String(manualOrder.client_phone ?? '').trim();
		const document = isBlankClientDocument(manualOrder.client_rut) ? '' : String(manualOrder.client_rut ?? '').trim();
		const phoneMeaningful = phoneHasMeaningfulDigits(phone);
		return (
			(!requirements.name || name.length >= 2)
			&& (!requirements.operatorReference || name.length >= 2)
			&& ((!requirements.phone && !phoneMeaningful) || (phoneMeaningful && phoneValid === true))
			&& ((!requirements.document && !document) || rutValid === true)
		);
	};

	const isPaymentValid = () => {
		if (totalToPay <= 0) return true;
		if (manualOrder.v2Enabled) {
			if (manualOrder.quoteRevisionPending) return false;
			if (!manualOrder.quote?.quoteHash) return false;
			return validatePaymentLines(
				manualOrder.payment_lines ?? [],
				manualOrder.quote,
				manualOrder.paymentMethods ?? [],
			).valid;
		}
		return validateCheckoutPayment({
			payment_mode: manualOrder.payment_mode,
			payment_type: manualOrder.payment_type,
			cash_amount: manualOrder.cash_amount,
			card_amount: manualOrder.card_amount,
			cash_tendered: manualOrder.cash_tendered,
			totalToPay,
		}).valid;
	};
	const hasPaymentIntent = () => hasManualOrderPaymentIntent(manualOrder);

	const isFormValid = () => {
		if (branchDeliveryCfgLoading || branchConfigError) return false;
		const hasItems = manualOrder.items && manualOrder.items.length > 0;
		const hasClientName = hasOpenMesaClientName();
		const hasPaymentType = !!manualOrder.payment_type;
		const paymentOk = effectiveOpenMesaMode
			? (openMesaChargeNow ? isPaymentValid() && manualOrder.payment_type !== 'pendiente' : true)
			: isPaymentValid();

		if (manualOrder.v2Enabled) {
			const fulfillment = fulfillmentForValidation();
			const immediate = fulfillment !== 'table' && (
				effectiveOpenMesaMode ? Boolean(manualOrder.charge_now) : hasPaymentIntent()
			);
			return hasItems && isContextCustomerValid() && isDeliveryValidForOrder()
				&& Boolean(manualOrder.quote?.quoteHash) && (!immediate || isPaymentValid());
		}

		if (isEditMode) {
			if (effectiveOpenMesaMode) {
				return hasItems && hasClientName && isContextCustomerValid() && isDeliveryValidForOrder();
			}
			// Pedidos web suelen llegar como pago pendiente; al editar no revalidamos cobro.
			return hasItems && isContextCustomerValid() && isDeliveryValidForOrder();
		}

		if (effectiveOpenMesaMode) {
			const hasTable = !openMesaMode || Boolean(String(manualOrder.selected_table_id ?? '').trim()) || isEditMode;
			const base = hasItems && hasClientName && hasTable && isContextCustomerValid() && isDeliveryValidForOrder();
			return openMesaChargeNow ? base && hasPaymentType && paymentOk : base;
		}

		const base = hasItems && isContextCustomerValid() && isDeliveryValidForOrder();
		return hasPaymentIntent() ? base && hasPaymentType && paymentOk : base;
	};

	const isClientStepValid = () => {
		if (branchDeliveryCfgLoading || branchConfigError) return false;
		if (effectiveOpenMesaMode) {
			return hasOpenMesaClientName() && isContextCustomerValid() && isDeliveryValidForOrder();
		}
		return Boolean(isContextCustomerValid() && isDeliveryValidForOrder());
	};

	const hasCartItems = (manualOrder.items?.length ?? 0) > 0;
	const cartItemCount = (manualOrder.items ?? []).reduce((acc, i) => acc + (Number(i.quantity) || 1), 0);
	const hasSelectedTable = Boolean(String(manualOrder.selected_table_id ?? '').trim());

	const goNextStep = () => {
		if (orderStep >= wizardStepCount) return;

		if (stepRoles.floor != null && orderStep === stepRoles.floor) {
			if (!hasSelectedTable) {
				showNotify?.('Selecciona una mesa disponible para continuar.', 'warning');
				return;
			}
			setOrderStep(stepRoles.catalog);
			return;
		}

		if (orderStep === stepRoles.catalog) {
			if (!hasCartItems) {
				showNotify?.('Agrega al menos un producto al carrito.', 'warning');
				return;
			}
			setOrderStep(stepRoles.client);
			return;
		}

		if (orderStep === stepRoles.client && stepRoles.payment != null) {
			if (!isClientStepValid()) {
				const deliveryError = validateManualDeliveryDetails(manualOrder, branchDeliveryCfg);
				showNotify?.(
					deliveryError || 'Completa el nombre del cliente y los datos requeridos.',
					'warning',
				);
				return;
			}
			setOrderStep(stepRoles.payment);
		}
	};

	const goPrevStep = () => {
		setOrderStep((prev) => (prev > 1 ? prev - 1 : prev));
	};

	const stepLabels = stepRoles.isOpenMesaCreate
		? (openMesaChargeNow
			? ['Mesa', 'Productos', 'Confirmar', 'Cobro']
			: ['Mesa', 'Productos', 'Confirmar'])
		: (effectiveOpenMesaMode
			? (isEditMode
				? (isCompactNav ? ['Productos', 'Sesión'] : ['Productos', 'Editar sesión'])
				: (openMesaChargeNow
					? ['Productos', 'Entrega', 'Cobro inicial']
					: ['Productos', 'Abrir mesa']))
			: (isEditMode
				? ['Productos', 'Cliente']
				: (showClassicPaymentStep
					? ['Productos', 'Entrega', 'Pago opcional']
					: ['Productos', 'Entrega'])));

	return {
		totalToPay,
		couponDiscountApplied,
		deliveryFeeAmt,
		openMesaFulfillment,
		openMesaSubmitLabel,
		isFormValid,
		isClientStepValid,
		hasCartItems,
		cartItemCount,
		hasSelectedTable,
		goNextStep,
		goPrevStep,
		stepLabels,
		stepRoles,
	};
}

export default function ManualOrderCheckout({
	orderStep,
	setOrderStep,
	wizardStepCount,
	isCompactNav,
	isEditMode,
	effectiveOpenMesaMode,
	openMesaMode = false,
	showClassicPaymentStep,
	showOpenMesaPaymentChoice,
	openMesaChargeNow,
	loading,
	manualOrder,
	liveEditOrder,
	clients,
	branch,
	branchDeliveryCfg,
	branchDeliveryCfgLoading,
	branchConfigError,
	retryBranchConfig,
	localOrderChannels,
	canEditDeliveryFee,
	showNotify,
	catalogBlock,
	floorPlanBlock = null,
	checkoutFlow,
	hookActions,
	printManualKitchen,
	printManualCaja,
	submitOrder,
	canCancelOrder,
	handleCancelOrder,
	sessionPaymentDeferred,
	canMarkPaidSession,
	setPayModalOpen,
}) {
	const {
		totalToPay,
		openMesaFulfillment,
		openMesaSubmitLabel: getOpenMesaSubmitLabel,
		isFormValid,
		isClientStepValid,
		hasCartItems,
		cartItemCount,
		hasSelectedTable = false,
		goNextStep,
		goPrevStep,
		stepLabels,
		stepRoles = resolveWizardStepRoles({
			openMesaMode,
			isEditMode,
			openMesaChargeNow,
			showClassicPaymentStep,
		}),
	} = checkoutFlow;
	const isFloorStep = stepRoles.floor != null && orderStep === stepRoles.floor;
	const isCatalogStep = orderStep === stepRoles.catalog;
	const isClientStep = orderStep === stepRoles.client;
	const isPaymentStep = stepRoles.payment != null && orderStep === stepRoles.payment;
	const formatAccountingMoney = React.useCallback((amount) => formatMinor(
		majorToMinor(amount, manualOrder.currency, manualOrder.fractionDigits),
		{
			currency: manualOrder.currency,
			locale: manualOrder.locale,
			fractionDigits: manualOrder.fractionDigits,
		},
	), [manualOrder.currency, manualOrder.locale, manualOrder.fractionDigits]);
	const dualMoneyProps = React.useMemo(() => ({
		currency: manualOrder.currency || 'USD',
		locale: manualOrder.locale,
		formatPrimary: formatAccountingMoney,
		exchangeRate: branchDeliveryCfg?.exchangeRate,
	}), [manualOrder.currency, manualOrder.locale, formatAccountingMoney, branchDeliveryCfg?.exchangeRate]);
	const canSubmitOrder = isFormValid();
	const [cartSheetOpen, setCartSheetOpen] = React.useState(false);
	const [cartSheetDragY, setCartSheetDragY] = React.useState(0);
	const cartSheetPanelRef = React.useRef(null);
	const cartSheetDragRef = React.useRef({ active: false, startY: 0, dy: 0 });

	React.useEffect(() => {
		if (!isCatalogStep) setCartSheetOpen(false);
	}, [isCatalogStep]);

	React.useEffect(() => {
		if (!cartSheetOpen) setCartSheetDragY(0);
	}, [cartSheetOpen]);

	React.useEffect(() => {
		if (!cartSheetOpen) return undefined;
		const onKeyDown = (event) => {
			if (event.key === 'Escape') setCartSheetOpen(false);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [cartSheetOpen]);

	const toggleCartSheet = React.useCallback(() => {
		setCartSheetOpen((open) => !open);
	}, []);

	const closeCartSheet = React.useCallback(() => {
		setCartSheetOpen(false);
	}, []);

	const onCartSheetTouchStart = React.useCallback((event) => {
		if (!cartSheetOpen) return;
		const panel = cartSheetPanelRef.current;
		if (panel && panel.scrollTop > 2) return;
		const touch = event.touches?.[0];
		if (!touch) return;
		cartSheetDragRef.current = { active: true, startY: touch.clientY, dy: 0 };
	}, [cartSheetOpen]);

	const onCartSheetTouchMove = React.useCallback((event) => {
		const drag = cartSheetDragRef.current;
		if (!drag.active) return;
		const touch = event.touches?.[0];
		if (!touch) return;
		const dy = Math.max(0, touch.clientY - drag.startY);
		drag.dy = dy;
		setCartSheetDragY(dy);
	}, []);

	const onCartSheetTouchEnd = React.useCallback(() => {
		const drag = cartSheetDragRef.current;
		if (!drag.active) return;
		const shouldClose = drag.dy > 72;
		drag.active = false;
		drag.dy = 0;
		setCartSheetDragY(0);
		if (shouldClose) setCartSheetOpen(false);
	}, []);

	const openMesaSubmitLabel = getOpenMesaSubmitLabel({
		loading,
		isEditMode,
		openMesaFulfillment,
	});
	const submitLabel = isEditMode
		? 'GUARDAR CAMBIOS'
		: effectiveOpenMesaMode
			? openMesaSubmitLabel
			: (getLocalFulfillmentMode(manualOrder) === 'mesa' ? 'ABRIR MESA' : 'CREAR PEDIDO');
	const quickSaleHasPayment = !effectiveOpenMesaMode
		&& getLocalFulfillmentMode(manualOrder) !== 'mesa'
		&& hasManualOrderPaymentIntent(manualOrder);
	const tableMustDeferPayment = effectiveOpenMesaMode && openMesaFulfillment === 'mesa';
	const immediateSessionAllowed = !effectiveOpenMesaMode ? true : tableMustDeferPayment ? false
		: manualOrder.manualOrderSettings?.allowImmediateSessionPayment?.[
			openMesaFulfillment === 'delivery' ? 'delivery' : 'pickup'
		] !== false;

	const {
		updateClientName,
		updateCouponCode,
		couponPreview,
		updatePaymentType,
		updatePaymentMode,
		updateCashAmount,
		updateCardAmount,
		updateCashTendered,
		updateChargeNow,
		updatePaymentLines,
		acknowledgeQuoteRevision,
		handleRutChange,
		handlePhoneChange,
		handleFileChange,
		removeReceipt,
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
		applyClientRecord,
		getInputStyle,
		rutValid,
		phoneValid,
		includeDocument = false,
		includePhone = false,
		setIncludeDocument,
		setIncludePhone,
		receiptFile,
		receiptPreview,
	} = hookActions;

	React.useEffect(() => {
		if (showOpenMesaPaymentChoice && !immediateSessionAllowed && manualOrder.charge_now) {
			updateChargeNow?.(false);
		}
	}, [showOpenMesaPaymentChoice, immediateSessionAllowed, manualOrder.charge_now, updateChargeNow]);

	const clientSection = (
		<ClientForm
			manualOrder={manualOrder}
			branchDeliveryCfg={branchDeliveryCfg}
			clients={clients}
			updateOrderType={updateOrderType}
			updateLocalFulfillmentMode={updateLocalFulfillmentMode}
			updateMesaPartyMode={updateMesaPartyMode}
			updateDeliveryAddress={updateDeliveryAddress}
			updateDeliveryReference={updateDeliveryReference}
			updateDeliveryKm={updateDeliveryKm}
			updateDeliveryFee={updateDeliveryFee}
			updateDeliveryNamedAreaId={updateDeliveryNamedAreaId}
			updateClientName={updateClientName}
			applyClientRecord={applyClientRecord}
			handleRutChange={handleRutChange}
			handlePhoneChange={handlePhoneChange}
			rutValid={rutValid}
			phoneValid={phoneValid}
			includeDocument={includeDocument}
			includePhone={includePhone}
			setIncludeDocument={setIncludeDocument}
			setIncludePhone={setIncludePhone}
			getInputStyle={getInputStyle}
			branch={branch}
			showNotify={showNotify}
			canOverrideDeliveryFee={canEditDeliveryFee}
			openMesaMode={effectiveOpenMesaMode}
			branchDeliveryCfgLoading={branchDeliveryCfgLoading}
			enabledLocalChannels={localOrderChannels}
			isEditMode={isEditMode}
		/>
	);

	const configurationErrorBanner = branchConfigError ? (
		<div className="m-3 rounded-[12px] border border-gc-danger/40 bg-gc-danger/10 p-3 text-sm text-gc-danger" role="alert">
			<p>No se pudo validar la configuración de la sucursal. El pedido está bloqueado para evitar precios o delivery incorrectos.</p>
			<p className="mt-1 font-semibold">{branchConfigError}</p>
			<Button variant="outline" type="button" className="mt-2 min-h-[44px]" onClick={retryBranchConfig}>Reintentar</Button>
		</div>
	) : null;
	const configurationLoadingBanner = branchDeliveryCfgLoading ? (
		<div className="m-3 rounded-[12px] border border-gc-border bg-gc-muted/60 p-3 text-sm text-gc-text-muted" role="status" aria-live="polite">
			Validando configuración, moneda, pagos y tarifas de la sucursal…
		</div>
	) : null;

	const showEditSaveOnFooter = isEditMode && isCatalogStep;
	const nextStepLabel = hasCartItems
		? `Siguiente · ${formatAccountingMoney(manualOrder.total ?? 0)}`
		: 'Siguiente';

	const wizardNavButtons = (
		<div
			className={`manual-order-footer-nav${showEditSaveOnFooter ? ' manual-order-footer-nav--edit' : ''}`}
			role="group"
			aria-label="Navegación del pedido"
		>
			{orderStep > 1 ? (
				<Button variant="default"
					type="button"
					className={stepNavBackClass}
					onClick={goPrevStep}
				>
					ATRÁS
				</Button>
			) : null}
			{showEditSaveOnFooter ? (
				<>
					<Button variant="secondary"
						type="button"
						className="manual-order-steps-nav__btn manual-order-steps-nav__btn--next-secondary"
						onClick={goNextStep}
						disabled={!hasCartItems}
					>
						{nextStepLabel}
					</Button>
					<Button variant="default"
						type="button"
						className="manual-order-steps-nav__btn manual-order-steps-nav__btn--save"
						onClick={submitOrder}
						disabled={loading || branchDeliveryCfgLoading || Boolean(branchConfigError)}
					>
						{loading ? 'GUARDANDO...' : 'Guardar cambios'}
					</Button>
				</>
			) : isFloorStep ? (
				<Button variant="default"
					type="button"
					className="manual-order-steps-nav__btn manual-order-steps-nav__btn--next manual-order-steps-nav__btn--next-step1 w-full"
					onClick={goNextStep}
					disabled={!hasSelectedTable}
				>
					Continuar
				</Button>
			) : isCatalogStep ? (
				<Button variant="default"
					type="button"
					className="manual-order-steps-nav__btn manual-order-steps-nav__btn--next manual-order-steps-nav__btn--next-step1 w-full"
					onClick={goNextStep}
					disabled={!hasCartItems}
				>
					{nextStepLabel}
				</Button>
			) : null}
		</div>
	);

	const orderSummaryProps = {
		manualOrder,
		updateQuantity,
		removeItem,
		updateItemNote,
		printManualKitchen,
		printManualCaja,
		showCheckoutTotals: effectiveOpenMesaMode,
		exchangeRate: branchDeliveryCfg?.exchangeRate,
	};

	const paymentDetailsProps = {
		manualOrder,
		branch,
		branchDeliveryCfg,
		updateCouponCode,
		couponPreview,
		updatePaymentType,
		updatePaymentMode,
		updateCashAmount,
		updateCardAmount,
		updateCashTendered,
		updatePaymentLines,
		acknowledgeQuoteRevision,
		receiptFile,
		receiptPreview,
		handleFileChange,
		removeReceipt,
		submitOrder,
		loading,
		isFormValid,
		goPrevStep,
		confirmLabel: submitLabel,
		onCancelOrder: canCancelOrder ? handleCancelOrder : null,
		isEditMode,
		hideCheckoutActions: false,
		paymentOptional: !effectiveOpenMesaMode && !isEditMode,
	};

	const paymentDetailsMobileProps = {
		...paymentDetailsProps,
		goPrevStep: null,
		hideCheckoutActions: true,
		embedded: true,
	};
	const isClientOnlyStep = isClientStep;

	const checkoutOverview = (
		<div className="manual-order-checkout-overview">
			<div className="manual-order-checkout-overview__copy">
				<h2>
					{isClientOnlyStep
						? (stepRoles.isOpenMesaCreate
							? `Confirmar ${manualOrder.selected_table_code || 'mesa'}`
							: 'Cliente y entrega')
						: (effectiveOpenMesaMode ? 'Cobro' : 'Pago (opcional)')}
				</h2>
				<p>
					{isClientOnlyStep
						? (stepRoles.isOpenMesaCreate
							? 'Revisá los productos y abrí la sesión. El cobro se registra al cerrar la mesa.'
							: (effectiveOpenMesaMode
								? 'Completa solo los datos requeridos para esta atención.'
								: 'Elige retiro o delivery y completa los datos necesarios antes del cobro.'))
						: (effectiveOpenMesaMode
							? 'Registra el método de pago para abrir la sesión cobrada.'
							: 'Elige un método para cobrar ahora, o crea el pedido pendiente y cobra después.')}
				</p>
			</div>
			<div className="manual-order-checkout-overview__meta" aria-label="Resumen rápido del pedido">
				{stepRoles.isOpenMesaCreate && manualOrder.selected_table_code ? (
					<span className="manual-order-checkout-overview__meta-items">
						Mesa {manualOrder.selected_table_code}
					</span>
				) : null}
				<span className="manual-order-checkout-overview__meta-items">
					<ShoppingBag size={15} aria-hidden />
					{cartItemCount} {cartItemCount === 1 ? 'ítem' : 'ítems'}
				</span>
				<span className="manual-order-checkout-overview__meta-total">
					<DualCurrencyAmount
						amount={totalToPay}
						{...dualMoneyProps}
						layout="stack"
						size="sm"
						align="end"
						primaryClassName="!text-gc-price"
					/>
				</span>
			</div>
		</div>
	);

	const openMesaPaymentChoiceSection = showOpenMesaPaymentChoice && !tableMustDeferPayment ? (
			<div className={openMesaPaymentCardClass}>
			<SectionHeader icon={Banknote} tone="accent">Pago</SectionHeader>
			<div className={`grid grid-cols-1 ${spacing.normal} min-[400px]:grid-cols-2`}>
				<Button variant="outline"
					type="button"
					className={cn(
						'manual-order-toggle',
						openMesaToggleClass,
						!manualOrder.charge_now && selectedToggleActiveClass,
					)}
					onClick={() => updateChargeNow?.(false)}
				>
					Crear pendiente
				</Button>
				<Button variant="outline"
					type="button"
					className={cn(
						'manual-order-toggle',
						openMesaToggleClass,
						manualOrder.charge_now && selectedToggleActiveClass,
					)}
					onClick={() => updateChargeNow?.(true)}
					disabled={!immediateSessionAllowed}
					title={!immediateSessionAllowed ? 'El cobro inmediato está deshabilitado para este tipo de sesión.' : undefined}
				>
					Cobrar ahora
				</Button>
			</div>
			<p className={openMesaHintClass}>
				{tableMustDeferPayment
					? 'Las mesas siempre se abren pendientes; el cobro se registra al cerrar.'
					: manualOrder.charge_now
					? effectiveOpenMesaMode
						? 'Registra el método de pago al abrir la sesión.'
						: 'Confirma el método de pago y registra la venta en caja ahora.'
					: effectiveOpenMesaMode
						? 'El cobro puede registrarse en cualquier momento antes de cerrar la mesa, retiro o delivery.'
						: 'No se requiere un método ahora. El pedido no podrá entregarse hasta registrar el pago.'}
			</p>
		</div>
	) : null;

	const isLocalSessionEdit = isEditMode && isLocalOpenSessionOrder(liveEditOrder);

	const openMesaSessionPaymentSection = isEditMode && isLocalSessionEdit ? (
				<div className={openMesaPaymentCardClass}>
					<SectionHeader icon={Banknote} tone="accent">Pago</SectionHeader>
					{sessionPaymentDeferred ? (
				<p className={openMesaHintClass}>
					El cobro se registra al cerrar la mesa, retiro o delivery.
				</p>
			) : (
				<p className={openMesaHintClass}>
					{getPaymentLabel(liveEditOrder)}
				</p>
			)}
			{canMarkPaidSession ? (
				<Button variant="default"
					type="button"
					className={`mt-3 flex min-h-[44px] w-full items-center justify-center rounded-[4px] bg-gc-accent px-4 ${textScale.body} font-bold text-white transition-colors hover:bg-gc-accent-hover disabled:cursor-not-allowed disabled:opacity-55`}
					onClick={(e) => {
						e.stopPropagation();
						setPayModalOpen(true);
					}}
				>
					Marcar pagado
				</Button>
			) : null}
		</div>
	) : null;

	const mobileDock = isCompactNav ? (
		<div className={cn('manual-order-mobile-dock', isCatalogStep && cartSheetOpen && 'manual-order-mobile-dock--cart-open')} role="group" aria-label="Navegación del pedido">
			{isFloorStep ? (
				<div className="manual-order-mobile-dock__actions">
					<Button variant="default"
						type="button"
						className="manual-order-steps-nav__btn manual-order-steps-nav__btn--next manual-order-steps-nav__btn--next-step1 w-full"
						onClick={goNextStep}
						disabled={!hasSelectedTable}
					>
						Continuar
					</Button>
				</div>
			) : null}
			{isCatalogStep ? (
				<>
					{cartSheetOpen ? (
						<button
							type="button"
							className="manual-order-mobile-cart-backdrop"
							aria-label="Cerrar carrito"
							onClick={closeCartSheet}
						/>
					) : null}

					<div
						id="manual-order-mobile-cart-sheet"
						className={cn(
							'manual-order-mobile-cart-sheet',
							cartSheetOpen && 'is-open',
							cartSheetDragY > 0 && 'is-dragging',
						)}
						aria-hidden={!cartSheetOpen}
						style={cartSheetOpen && cartSheetDragY > 0
							? { transform: `translateY(${cartSheetDragY}px) scale(1)`, opacity: Math.max(0.45, 1 - cartSheetDragY / 280) }
							: undefined}
						onTouchStart={onCartSheetTouchStart}
						onTouchMove={onCartSheetTouchMove}
						onTouchEnd={onCartSheetTouchEnd}
						onTouchCancel={onCartSheetTouchEnd}
					>
						<div className="manual-order-mobile-cart-sheet__handle" aria-hidden />
						<div ref={cartSheetPanelRef} className="manual-order-mobile-cart-sheet__panel">
							<OrderSummary {...orderSummaryProps} variant="sheet" />
						</div>
					</div>

					<Button
						variant="default"
						type="button"
						className="manual-order-mobile-cart-fab"
						onClick={toggleCartSheet}
						aria-expanded={cartSheetOpen}
						aria-controls="manual-order-mobile-cart-sheet"
						title={cartSheetOpen ? 'Cerrar carrito' : 'Ver carrito'}
						aria-label={cartSheetOpen
							? 'Cerrar carrito'
							: hasCartItems
								? `Ver y editar carrito, ${cartItemCount} ${cartItemCount === 1 ? 'ítem' : 'ítems'}`
								: 'Ver y editar carrito'}
					>
						{cartSheetOpen ? <ChevronDown size={20} strokeWidth={2.5} aria-hidden /> : <ChevronUp size={20} strokeWidth={2.5} aria-hidden />}
						{!cartSheetOpen && hasCartItems ? (
							<span className="manual-order-mobile-cart-fab__badge" aria-hidden>
								{cartItemCount > 99 ? '99+' : cartItemCount}
							</span>
						) : null}
					</Button>

					<button
						type="button"
						className="manual-order-mobile-cart-bar"
						aria-live="polite"
						aria-expanded={cartSheetOpen}
						aria-controls="manual-order-mobile-cart-sheet"
						onClick={toggleCartSheet}
					>
						<ShoppingBag size={18} aria-hidden />
						<span className="manual-order-mobile-cart-bar__text">
							{hasCartItems ? (
								<span className="manual-order-mobile-cart-bar__stack">
									<span className="manual-order-mobile-cart-bar__line-main">
										{cartItemCount} {cartItemCount === 1 ? 'ítem' : 'ítems'}
										<span className="manual-order-mobile-cart-bar__dot" aria-hidden>·</span>
										<span className="manual-order-mobile-cart-bar__usd">
											{formatAccountingMoney(manualOrder.total ?? 0)}
										</span>
									</span>
									<DualCurrencyAmount
										amount={manualOrder.total ?? 0}
										{...dualMoneyProps}
										hidePrimary
										layout="stack"
										size="sm"
										align="start"
										className="manual-order-mobile-cart-bar__ves"
										secondaryClassName="!text-gc-text-muted/70 !font-medium"
									/>
								</span>
							) : (
								'Carrito vacío'
							)}
						</span>
					</button>
					{showEditSaveOnFooter ? (
						<div className="manual-order-mobile-dock__actions manual-order-mobile-dock__actions--edit">
							{stepRoles.isOpenMesaCreate ? (
								<Button variant="default"
									type="button"
									className={stepNavBackClass}
									onClick={goPrevStep}
								>
									ATRÁS
								</Button>
							) : null}
							<Button variant="secondary"
								type="button"
								className="manual-order-steps-nav__btn manual-order-steps-nav__btn--next-secondary"
								onClick={goNextStep}
								disabled={!hasCartItems}
							>
								Siguiente
							</Button>
							<Button variant="default"
								type="button"
								className="manual-order-steps-nav__btn manual-order-steps-nav__btn--save"
								onClick={submitOrder}
								disabled={loading}
							>
								{loading ? 'GUARDANDO...' : 'Guardar'}
							</Button>
						</div>
					) : (
						<div className="manual-order-mobile-dock__actions">
							{stepRoles.isOpenMesaCreate ? (
								<Button variant="default"
									type="button"
									className={stepNavBackClass}
									onClick={goPrevStep}
								>
									ATRÁS
								</Button>
							) : null}
							<Button variant="default"
								type="button"
								className="manual-order-steps-nav__btn manual-order-steps-nav__btn--next manual-order-steps-nav__btn--next-step1 w-full transition-all duration-200 hover:!-translate-y-0.5 active:!translate-y-0"
								onClick={goNextStep}
								disabled={!hasCartItems}
							>
								{nextStepLabel}
							</Button>
						</div>
					)}
				</>
			) : null}
			{isClientStep ? (
				<div className="manual-order-mobile-dock__actions">
					<Button variant="default"
						type="button"
						className={stepNavBackClass}
						onClick={goPrevStep}
					>
						ATRÁS
					</Button>
					{showClassicPaymentStep || openMesaChargeNow ? (
						<Button variant="default"
							type="button"
							className={stepNavNextClass}
							onClick={goNextStep}
							disabled={!isClientStepValid()}
						>
							Siguiente
						</Button>
					) : (
						<Button variant="default"
							type="button"
							className={cn(confirmBtnClass, 'manual-order-mobile-dock__confirm')}
							onClick={submitOrder}
							disabled={loading || !isFormValid()}
						>
							{submitLabel}
						</Button>
					)}
				</div>
			) : null}
			{isPaymentStep ? (
				<div className="manual-order-mobile-dock__actions manual-order-mobile-dock__actions--confirm">
					<Button variant="default"
						type="button"
						className={stepNavBackClass}
						onClick={goPrevStep}
					>
						ATRÁS
					</Button>
					{canCancelOrder ? (
						<Button variant="default"
							type="button"
						className={cn(
							stepNavBackClass,
							`max-w-[36%] ${textScale.micro} text-gc-danger`,
						)}
							onClick={handleCancelOrder}
							disabled={loading}
						>
							Cancelar
						</Button>
					) : null}
					<Button variant="default"
						type="button"
						className={cn(confirmBtnClass, 'manual-order-mobile-dock__confirm')}
						onClick={submitOrder}
						disabled={loading || !isFormValid()}
					>
						{loading ? 'PROCESANDO...' : submitLabel}
					</Button>
				</div>
			) : null}
		</div>
	) : null;

	const classicCheckoutRailActions = (
		<div className="manual-order-checkout-rail-actions" role="group" aria-label="Confirmación del pedido">
			<div className="manual-order-checkout-rail-actions__total">
				<span className="manual-order-checkout-rail-actions__total-label">
					{effectiveOpenMesaMode
						? (openMesaChargeNow ? 'Total a cobrar' : 'Total de la mesa')
						: (quickSaleHasPayment ? 'Total a cobrar' : 'Total del pedido')}
				</span>
				<DualCurrencyAmount
					amount={totalToPay}
					{...dualMoneyProps}
					layout="stack"
					size="lg"
					align="end"
					className="manual-order-checkout-rail-actions__total-amount"
					primaryClassName="!text-gc-price"
				/>
			</div>
			<p
				className={cn(
					'manual-order-checkout-rail-actions__status',
					canSubmitOrder ? 'is-ready' : 'is-pending',
				)}
				role="status"
				aria-live="polite"
			>
				{canSubmitOrder
					? (effectiveOpenMesaMode
						? (openMesaChargeNow
							? 'El pago está completo; la sesión se abrirá cobrada.'
							: 'Listo para abrir la mesa pendiente de cobro.')
						: (quickSaleHasPayment
							? 'El pago está completo; el pedido se creará pagado.'
							: 'Sin método de pago; el pedido se creará pendiente.'))
					: (effectiveOpenMesaMode
						? (openMesaChargeNow
							? 'Completa correctamente la información del pago.'
							: 'Completa los datos obligatorios para abrir la mesa.')
						: (quickSaleHasPayment
							? 'Completa correctamente la información del pago.'
							: 'Completa los datos obligatorios del cliente y la entrega.'))}
			</p>
			<div className="manual-order-checkout-rail-actions__buttons">
				<Button variant="outline" type="button" className={checkoutBackBtnClass} onClick={goPrevStep} disabled={loading}>
					ATRÁS
				</Button>
				<Button
					variant="default"
					type="button"
					className={confirmBtnClass}
					onClick={submitOrder}
					disabled={loading || !canSubmitOrder}
				>
					<CheckCircle2 size={19} aria-hidden />
					{loading ? 'PROCESANDO…' : submitLabel}
				</Button>
			</div>
			{canCancelOrder ? (
				<Button variant="ghost" type="button" className="manual-order-checkout-rail-actions__cancel" onClick={handleCancelOrder} disabled={loading}>
					Cancelar pedido
				</Button>
			) : null}
		</div>
	);

	const clientStepRailActions = (
		<div className="manual-order-checkout-rail-actions manual-order-checkout-rail-actions--client" role="group" aria-label="Continuar con el pedido">
			<p
				className={cn(
					'manual-order-checkout-rail-actions__status',
					isClientStepValid() ? 'is-ready' : 'is-pending',
				)}
				role="status"
				aria-live="polite"
			>
				{isClientStepValid()
					? (showClassicPaymentStep || openMesaChargeNow
						? 'Datos listos; continúa al cobro.'
						: 'Datos listos para confirmar.')
					: 'Completa los campos obligatorios para continuar.'}
			</p>
			<div className="manual-order-checkout-rail-actions__buttons">
				<Button variant="outline" type="button" className={checkoutBackBtnClass} onClick={goPrevStep} disabled={loading}>
					ATRÁS
				</Button>
				{showClassicPaymentStep || openMesaChargeNow ? (
					<Button
						variant="default"
						type="button"
						className={confirmBtnClass}
						onClick={goNextStep}
						disabled={!isClientStepValid()}
					>
						Siguiente
					</Button>
				) : (
					<Button
						variant="default"
						type="button"
						className={confirmBtnClass}
						onClick={submitOrder}
						disabled={loading || !canSubmitOrder}
					>
						<CheckCircle2 size={19} aria-hidden />
						{loading ? 'PROCESANDO…' : submitLabel}
					</Button>
				)}
			</div>
		</div>
	);

	const checkoutClientColumn = (
		<div className={cn(checkoutColBase, 'manual-order-checkout-col--client')}>
			<div className={`manual-order-client-stage flex w-full flex-col ${spacing.normal}`}>
				{clientSection}
				{openMesaPaymentChoiceSection}
				{openMesaSessionPaymentSection}
			</div>
		</div>
	);

	const checkoutSummaryColumn = (
		<div className={cn(checkoutColBase, 'manual-order-checkout-col--summary overflow-hidden')}>
			<OrderSummary {...orderSummaryProps} />
			{isClientStep ? clientStepRailActions : classicCheckoutRailActions}
		</div>
	);

	const checkoutPaymentColumn = (
		<div className={cn(checkoutColBase, `manual-order-checkout-col--payment min-h-0 ${spacing.normal}`)}>
			<PaymentDetails {...paymentDetailsProps} hideCheckoutActions embedded />
		</div>
	);

	const desktopCheckoutShell = (
		<div className="manual-order-checkout-shell">
			{checkoutOverview}
			<div className={cn(
				`manual-order-checkout-stage manual-order-checkout-stage--classic grid w-full flex-1 grid-cols-1 ${spacing.normal} items-start`,
				isClientStep && 'manual-order-checkout-stage--client',
				isPaymentStep && 'manual-order-checkout-stage--payment',
			)}>
				{isClientStep ? (
					<>
						<div className="manual-order-checkout-main">
							{checkoutClientColumn}
						</div>
						{checkoutSummaryColumn}
					</>
				) : (
					<>
						<div className="manual-order-checkout-main">
							{checkoutPaymentColumn}
						</div>
						{checkoutSummaryColumn}
					</>
				)}
			</div>
		</div>
	);

	const sidebarSection = (
		<div className={cn(
			'manual-order-sidebar flex min-h-0 min-w-0 flex-col !bg-gc-page',
			isCatalogStep
				? `w-full flex-shrink-0 overflow-hidden ${spacing.normal} lg:w-80`
				: 'w-full flex-1 overflow-y-auto',
			!isCatalogStep && !isFloorStep && '!border-gc-border',
		)}>
			{isCatalogStep ? (
				<>
					<OrderSummary {...orderSummaryProps} />
					<div className="manual-order-footer relative z-10 flex-shrink-0">
						{showEditSaveOnFooter ? (
							<p className="manual-order-footer-edit-hint" role="status">
								Puedes guardar aquí sin pasar por los otros pasos.
							</p>
						) : null}
						{wizardNavButtons}
					</div>
				</>
			) : (
				desktopCheckoutShell
			)}
		</div>
	);

	return (
		<>
			<header className="manual-order-wizard-header">
				<div className="manual-order-wizard-header__identity">
					<span className="manual-order-wizard-header__icon" aria-hidden="true">
						<ShoppingBag size={15} strokeWidth={2.25} />
					</span>
					<span className="manual-order-wizard-header__title">
						{openMesaMode || effectiveOpenMesaMode ? 'Abrir mesa' : 'Pedido manual'}
					</span>
				</div>

				<nav
					className={`manual-order-steps-progress${isEditMode ? ' manual-order-steps-progress--editable' : ''}`}
					aria-label={`Paso ${orderStep} de ${wizardStepCount}`}
				>
					{stepLabels.map((label, idx) => {
						const n = idx + 1;
						const isActive = orderStep === n;
						const isDone = orderStep > n;
						const connectorComplete = orderStep > n;
						const itemClassName = cn(
							'manual-order-steps-progress__item',
							isActive && 'is-active',
							isDone && 'is-done',
							isEditMode && 'manual-order-steps-progress__item--clickable',
						);
						const node = (
							<>
								<span className="manual-order-steps-progress__node">
									<span className="manual-order-steps-progress__dot">
										{isDone ? (
											<Check size={11} strokeWidth={2.75} aria-hidden />
										) : (
											<span className="manual-order-steps-progress__num">{n}</span>
										)}
									</span>
								</span>
								<span className="manual-order-steps-progress__label">{label}</span>
							</>
						);

						return (
							<React.Fragment key={label}>
								{isEditMode ? (
									<Button
										variant="default"
										type="button"
										className={itemClassName}
										onClick={() => setOrderStep(n)}
										aria-current={isActive ? 'step' : undefined}
										aria-label={`Ir a ${label}`}
									>
										{node}
									</Button>
								) : (
									<div className={itemClassName} aria-current={isActive ? 'step' : undefined}>
										{node}
									</div>
								)}
								{idx < stepLabels.length - 1 ? (
									<span
										className={cn(
											'manual-order-steps-progress__connector',
											connectorComplete && 'is-complete',
										)}
										aria-hidden
									/>
								) : null}
							</React.Fragment>
						);
					})}
				</nav>
		</header>
		{configurationLoadingBanner}
		{configurationErrorBanner}

			{isCompactNav ? (
				<div className="manual-order-mobile-scene">
					{isFloorStep ? (
						<div className="manual-order-stage manual-order-mobile-stage--floor">
							{floorPlanBlock}
						</div>
					) : null}
					{isCatalogStep ? (
						<div className="manual-order-stage manual-order-mobile-stage--catalog">
							{catalogBlock}
						</div>
					) : null}
					{isClientStep ? (
						<div className={`manual-order-mobile-panel manual-order-mobile-panel--client flex flex-col ${spacing.normal}`}>
							{checkoutOverview}
							{clientSection}
							{openMesaPaymentChoiceSection}
							{openMesaSessionPaymentSection}
							{!isClientStepValid() ? (
								<p className="manual-order-client-step-hint" role="status">
									Completa los campos obligatorios para continuar.
								</p>
							) : null}
						</div>
					) : null}
					{isPaymentStep ? (
						<div className="manual-order-mobile-panel manual-order-mobile-panel--payment">
							<OrderSummary {...orderSummaryProps} variant="compact" />
							<PaymentDetails {...paymentDetailsMobileProps} />
						</div>
					) : null}
				</div>
			) : isFloorStep ? (
				<div className={cn(
					`manual-order-body manual-order-body--floor flex min-h-0 flex-1 flex-col ${spacing.normal} p-5 !bg-gc-page`,
				)}>
					<div className="manual-order-stage manual-order-stage--floor min-h-0 flex-1 overflow-hidden">
						{floorPlanBlock}
					</div>
					<div className="manual-order-footer relative z-10 flex-shrink-0">
						{wizardNavButtons}
					</div>
				</div>
			) : (
				<div className={cn(
					`manual-order-body flex min-h-0 flex-1 ${spacing.normal} p-5 !bg-gc-page`,
				)}>
					{isCatalogStep ? (
						<div className="manual-order-stage min-h-0 flex-1 overflow-hidden">
							{catalogBlock}
						</div>
					) : null}
					{sidebarSection}
				</div>
			)}

			{mobileDock}
		</>
	);
}
