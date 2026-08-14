import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ManualOrderCheckout from '../components/manual-order/ManualOrderCheckout';
import ManualOrderCloseConfirm from '../components/manual-order/ManualOrderCloseConfirm';
import ManualOrderCatalog from '../components/manual-order/ManualOrderCatalog';
import { AdminContext } from '../admin/pages/AdminProvider';
import { LocationContext } from '../context/LocationContext';
import { OrderMoneyContext } from '../context/OrderMoneyContext';
import { createOrderMoneyFormatter } from '@/lib/money/order-amount';
import { getCountryProfile } from '@/lib/geo/country-profiles';
import { normalizeManualOrderSettings } from '../domain/manual-order-settings';
import '../styles/ManualOrderModal.css';

const branch = {
	id: 'visual-ve-branch',
	company_id: 'visual-company',
	name: 'Sucursal Venezuela',
	country: 'VE',
	currency: 'USD',
};

const companyProfile = { id: 'visual-company', country: 'VE', currency: 'USD' };
const profile = getCountryProfile('VE', { currency: 'USD' });
const settings = normalizeManualOrderSettings({ version: 1, enabled: false });
const catalogCategories = [{ id: 'catalog-food', name: 'Comidas', order: 1, is_active: true }];
const catalogProducts = Array.from({ length: 60 }, (_, index) => ({
	id: `catalog-product-${index + 1}`,
	name: `Producto ${String(index + 1).padStart(2, '0')}`,
	price: 10 + index,
	is_active: true,
	category_id: 'catalog-food',
	category_name: 'Comidas',
	image_url: '',
}));

const initialOrder = {
	items: [
		{ id: 'normal', name: 'Tumbarrancho normal', price: 4500, quantity: 2, note: '' },
		{ id: 'especial', name: 'Tumbarrancho especial', price: 5990, quantity: 2, note: '' },
	],
	total: 20980,
	items_subtotal: 20980,
	checkout_total: 20980,
	order_type: 'pickup',
	client_name: '',
	client_rut: '',
	client_phone: '',
	delivery_address: '',
	delivery_reference: '',
	delivery_named_area_id: '',
	delivery_km: '',
	delivery_fee: 0,
	coupon_code: '',
	payment_type: 'tienda',
	payment_mode: 'single',
	cash_amount: 0,
	card_amount: 0,
	cash_tendered: '',
	payment_lines: [],
	currency: 'USD',
	locale: profile.locale,
	fractionDigits: 2,
	cashDenominations: profile.cashDenominations,
	manualOrderSettings: settings,
	v2Enabled: false,
	quote: null,
	quoteLoading: false,
	quoteError: null,
	quoteRevisionPending: false,
};

function useCompactViewport() {
	const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 767px)').matches);
	useEffect(() => {
		const media = window.matchMedia('(max-width: 767px)');
		const update = () => setCompact(media.matches);
		media.addEventListener('change', update);
		return () => media.removeEventListener('change', update);
	}, []);
	return compact;
}

export default function ManualOrderCheckoutVisualHarness() {
	const [manualOrder, setManualOrder] = useState(initialOrder);
	const [closePromptOpen, setClosePromptOpen] = useState(() => new URLSearchParams(window.location.search).get('confirm') === '1');
	const catalogMode = new URLSearchParams(window.location.search).get('catalog') === '1';
	const closeButtonRef = useRef(null);
	const closePromptRef = useRef(null);
	const continueButtonRef = useRef(null);
	const compact = useCompactViewport();
	const requestedStep = Number(new URLSearchParams(window.location.search).get('step'));
	const orderStep = Number.isFinite(requestedStep) && requestedStep >= 1 && requestedStep <= 3
		? requestedStep
		: (compact ? 3 : 2);
	const money = useMemo(() => createOrderMoneyFormatter({ branch, company: companyProfile }), []);
	const setField = (key) => (value) => setManualOrder((current) => ({ ...current, [key]: value }));
	const clientValid = manualOrder.client_name.trim().length >= 2;
	const paymentValid = Number(manualOrder.cash_tendered || 0) >= manualOrder.checkout_total;
	const dismissClosePrompt = () => {
		setClosePromptOpen(false);
		window.setTimeout(() => closeButtonRef.current?.focus(), 0);
	};

	useEffect(() => {
		if (!closePromptOpen) return undefined;
		const timer = window.setTimeout(() => continueButtonRef.current?.focus(), 0);
		const handleKeyDown = (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				dismissClosePrompt();
				return;
			}
			if (event.key !== 'Tab' || !closePromptRef.current) return;
			const focusable = [...closePromptRef.current.querySelectorAll('button:not([disabled])')];
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [closePromptOpen]);

	const hookActions = {
		updateClientName: setField('client_name'),
		updateCouponCode: setField('coupon_code'),
		couponPreview: null,
		updatePaymentType: (type) => setManualOrder((current) => ({ ...current, payment_type: type, payment_mode: 'single' })),
		updatePaymentMode: setField('payment_mode'),
		updateCashAmount: setField('cash_amount'),
		updateCardAmount: setField('card_amount'),
		updateCashTendered: setField('cash_tendered'),
		updateChargeNow: () => {},
		updatePaymentLines: setField('payment_lines'),
		acknowledgeQuoteRevision: () => {},
		handleRutChange: (event) => setField('client_rut')(event.target.value),
		handlePhoneChange: (event) => setField('client_phone')(event.target.value),
		handleFileChange: () => {},
		removeReceipt: () => {},
		updateQuantity: () => {},
		removeItem: () => {},
		updateItemNote: () => {},
		updateOrderType: (type) => setField('order_type')(type),
		updateLocalFulfillmentMode: () => {},
		updateMesaPartyMode: () => {},
		updateDeliveryAddress: setField('delivery_address'),
		updateDeliveryReference: setField('delivery_reference'),
		updateDeliveryKm: setField('delivery_km'),
		updateDeliveryFee: setField('delivery_fee'),
		updateDeliveryNamedAreaId: setField('delivery_named_area_id'),
		applyClientRecord: () => {},
		getInputStyle: () => ({}),
		rutValid: true,
		phoneValid: true,
		includeDocument: false,
		includePhone: false,
		setIncludeDocument: () => {},
		setIncludePhone: () => {},
		receiptFile: null,
		receiptPreview: null,
	};

	const checkoutFlow = {
		totalToPay: manualOrder.checkout_total,
		openMesaFulfillment: null,
		openMesaSubmitLabel: () => 'COBRAR Y CREAR',
		isFormValid: () => clientValid && paymentValid,
		isClientStepValid: () => clientValid,
		hasCartItems: true,
		cartItemCount: 4,
		hasSelectedTable: false,
		goNextStep: () => {},
		goPrevStep: () => {},
		stepLabels: ['Productos', 'Entrega', 'Pago opcional'],
		stepRoles: {
			isOpenMesaCreate: false,
			floor: null,
			catalog: 1,
			client: 2,
			payment: 3,
		},
	};

	return (
		<AdminContext.Provider value={{ companyProfile, userRole: 'owner' }}>
			<LocationContext.Provider value={{ selectedBranch: branch }}>
				<OrderMoneyContext.Provider value={money}>
					{catalogMode ? (
						<div className="manual-order-portal-scope" data-testid="manual-order-catalog-visual-harness">
							<div className="manual-order-overlay">
								<div className="manual-order-container p-4 sm:p-6">
									<ManualOrderCatalog
										products={catalogProducts}
										categories={catalogCategories}
										addItem={() => {}}
										updateQuantity={() => {}}
										removeItem={() => {}}
										getQty={() => 0}
									/>
								</div>
							</div>
						</div>
					) : (
					<div className={`manual-order-portal-scope${closePromptOpen ? ' manual-order-portal-scope--confirming' : ''}`}>
						<div className="manual-order-overlay" aria-hidden={closePromptOpen ? 'true' : undefined} inert={closePromptOpen ? true : undefined}>
						<div className={`manual-order-container manual-order-wizard manual-order-step-${orderStep}${compact ? ' manual-order--mobile' : ''} flex h-full flex-col overflow-hidden`} style={{ height: '100dvh', maxHeight: '100dvh', width: '100%' }}>
							<Button
								ref={closeButtonRef}
								type="button"
								className="manual-order-floating-close"
								aria-label="Cerrar pedido manual"
								onClick={() => setClosePromptOpen(true)}
								disabled={closePromptOpen}
							>
								<X aria-hidden="true" />
								<span className="manual-order-floating-close__label">Cerrar</span>
							</Button>
							<ManualOrderCheckout
								orderStep={orderStep}
								setOrderStep={() => {}}
								wizardStepCount={3}
								isCompactNav={compact}
								isEditMode={false}
								effectiveOpenMesaMode={false}
								showClassicPaymentStep
								showOpenMesaPaymentChoice={false}
								openMesaChargeNow={false}
								loading={false}
								manualOrder={manualOrder}
								liveEditOrder={null}
								clients={[]}
								branch={branch}
								branchDeliveryCfg={{ enabled: true, pricingMode: 'flat', feeFlat: 5 }}
								branchDeliveryCfgLoading={false}
								branchConfigError={null}
								retryBranchConfig={() => {}}
								localOrderChannels={null}
								canEditDeliveryFee
								showNotify={() => {}}
								catalogBlock={null}
								checkoutFlow={checkoutFlow}
								hookActions={hookActions}
								printManualKitchen={() => {}}
								printManualCaja={() => {}}
								submitOrder={() => {}}
								canCancelOrder={false}
								handleCancelOrder={() => {}}
								sessionPaymentDeferred={false}
								canMarkPaidSession={false}
								setPayModalOpen={() => {}}
							/>
						</div>
						</div>
						{closePromptOpen ? (
							<ManualOrderCloseConfirm
								ref={closePromptRef}
								continueButtonRef={continueButtonRef}
								onContinue={dismissClosePrompt}
								onSaveDraft={dismissClosePrompt}
								onDiscard={dismissClosePrompt}
							/>
						) : null}
					</div>
					)}
				</OrderMoneyContext.Provider>
			</LocationContext.Provider>
		</AdminContext.Provider>
	);
}
