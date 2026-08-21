import React, { useEffect, useMemo, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

import { CheckCircle2 } from 'lucide-react';

import { useOrderMoney } from '@/modules/cash/hooks/useOrderMoney';

import {
	buildPaymentBreakdownForOrder,
	getOrderTileKind,
	getOrderPaymentDisplayLabel,
	isOrderPaymentSettled,
	resolveOrderDueMinor,
	validateCheckoutPayment,
} from '@/shared/utils/orderUtils';

import PaymentDetails from './manual-order/PaymentDetails';

import { useLockBodyScroll } from '@/shared/hooks/useLockBodyScroll';

import TableSessionReceipt from './TableSessionReceipt';
import { Button } from "@/components/ui/button";
import { isoFractionDigits, minorToMajor } from '@/lib/money/minor-units';
import { normalizeConfiguredPaymentMethods, validatePaymentLines } from '../domain/payment-methods';
import { useReceiptUpload } from '../hooks/manual-order/useReceiptUpload';



const DEFAULT_FORM = {

	payment_mode: 'single',

	payment_type: '',

	cash_amount: 0,

	card_amount: 0,

	cash_tendered: 0,
	payment_lines: [],

};



export default function CloseTableModal({

	isOpen,

	onClose,

	order,

	branch,

	onConfirm,

	showNotify,

	intent = 'close',

	stackAboveManualOrder = false,

}) {

	const isPayIntent = intent === 'pay';

	const confirmOnly = useMemo(
		() => !isPayIntent && isOrderPaymentSettled(order),
		[order, isPayIntent],
	);

	const kind = useMemo(() => getOrderTileKind(order), [order]);

	const orderMoney = useOrderMoney();
	const { formatMoney, formatOrderAmount } = orderMoney;
	const formatOrderTotal = (amount, orderRow) => formatOrderAmount({
		amountUsd: amount,
		order: orderRow,
		paymentMethod: orderRow?.payment_method_specific,
	});

	const [form, setForm] = useState(DEFAULT_FORM);

	const [loading, setLoading] = useState(false);
	const dueMinorBaselineRef = useRef(null);
	const {
		receiptFile,
		receiptPreview,
		handleFileChange,
		removeReceipt,
		resetReceipt,
	} = useReceiptUpload(showNotify);

	useEffect(() => {
		if (!isOpen || !order) return;
		setForm({
			...DEFAULT_FORM,
			// Un pedido pendiente no hereda "efectivo". El cajero debe confirmar
			// el método real antes de registrar o cerrar el cobro.
			payment_type: order.payment_type && order.payment_type !== 'pendiente' ? order.payment_type : '',
		});
		resetReceipt();
		dueMinorBaselineRef.current = resolveOrderDueMinor(order);
		// Solo al abrir o cambiar de pedido — no cuando el padre pasa un nuevo objeto (realtime).
		// resetReceipt es estable en intención; no va en deps para evitar resetear el formulario en cada render.
		// eslint-disable-next-line react-hooks/exhaustive-deps -- order?.id / isOpen
	}, [isOpen, order?.id]);

	useEffect(() => {
		if (!isOpen || !order || confirmOnly) return;
		const nextDue = resolveOrderDueMinor(order);
		if (dueMinorBaselineRef.current == null) {
			dueMinorBaselineRef.current = nextDue;
			return;
		}
		if (dueMinorBaselineRef.current === nextDue) return;
		dueMinorBaselineRef.current = nextDue;
		setForm((prev) => ({
			...prev,
			payment_lines: [],
			cash_amount: 0,
			card_amount: 0,
			cash_tendered: 0,
		}));
	}, [
		isOpen,
		confirmOnly,
		order?.id,
		order?.payment_balance_minor,
		order?.total_minor,
		order?.total,
		order?.currency,
	]);


	useLockBodyScroll(isOpen);



	useEffect(() => {

		if (!isOpen) return undefined;

		const onKeyDown = (event) => {

			if (event.key === 'Escape') onClose();

		};

		window.addEventListener('keydown', onKeyDown);

		return () => window.removeEventListener('keydown', onKeyDown);

	}, [isOpen, onClose]);



	if (!isOpen || !order) return null;

	const currency = String(order.currency || branch?.currency || 'CLP').toUpperCase();
	const fractionDigits = isoFractionDigits(currency, branch?.manual_order_settings?.currencyFractionDigits);
	const isV2Order = order.manual_order_mode === 'session' || order.manual_order_mode === 'quick_sale';
	const paymentMethods = normalizeConfiguredPaymentMethods(branch?.payment_methods, { accountingCurrency: currency });
	const dueMinor = resolveOrderDueMinor(order);
	const total = !confirmOnly
		? minorToMajor(dueMinor, currency, fractionDigits)
		: (Number(order.total) || 0);

	const confirmLabel = isPayIntent
		? 'Registrar pago'
		: confirmOnly
			? 'Confirmar entrega'
			: ({
				mesa: 'Confirmar y cerrar mesa',
				retiro: 'Confirmar y cerrar retiro',
				moto: 'Confirmar y cerrar delivery',
			}[kind] ?? 'Confirmar y cerrar');

	const statusLabel = isPayIntent ? 'Cobro' : 'Lista';

	const manualOrderShape = {
		...form,
		total,
		order_type: order.order_type,
		delivery_fee: order.delivery_fee,
		items: order.items,
		coupon_code: order.coupon_code,
		v2Enabled: isV2Order,
		currency,
		fractionDigits,
		quote: isV2Order ? { totalMinor: dueMinor, currency, fractionDigits, quoteHash: 'settlement' } : null,
		paymentMethods,
		payment_lines: form.payment_lines,
		cashDenominations: branch?.manual_order_settings?.cashDenominations || {},
	};

	const requiresEvidence = isV2Order
		? (form.payment_lines || []).some((line) => line?.evidencePolicy === 'required')
		: form.payment_type === 'online';

	const isFormValid = () => {
		if (confirmOnly) return true;
		if (dueMinor <= 0) return false;
		if (requiresEvidence && !receiptFile) return false;
		if (isV2Order) return validatePaymentLines(manualOrderShape.payment_lines, manualOrderShape.quote, paymentMethods).valid;

		return validateCheckoutPayment({
			payment_mode: form.payment_mode,
			payment_type: form.payment_type,
			cash_amount: form.cash_amount,
			card_amount: form.card_amount,
			cash_tendered: form.cash_tendered,
			totalToPay: total,
		}).valid;
	};



	const handleConfirm = async () => {

		if (!isFormValid()) {
			showNotify?.(
				requiresEvidence && !receiptFile
					? 'Adjuntá el comprobante antes de confirmar el pago.'
					: 'Revisa el método de pago',
				'warning',
			);
			return;
		}

		setLoading(true);

		try {

			const paymentPatch = confirmOnly

				? null

				: {

					...form,

					receiptFile: receiptFile || null,

					branchPaymentMethods: branch?.payment_methods || null,

					payment_breakdown: buildPaymentBreakdownForOrder({

						payment_mode: form.payment_mode,

						payment_type: form.payment_type,

						cash_amount: form.cash_amount,

						card_amount: form.card_amount,

						total,

					}),

				};

			const ok = await onConfirm(order, paymentPatch);

			if (ok) {
				resetReceipt();
				onClose();
			}

		} finally {

			setLoading(false);

		}

	};



	const modal = (

		<div className={`table-session-modal-portal tenant-theme-vars${isPayIntent ? ' table-session-modal-portal--pay-intent' : ''}${stackAboveManualOrder ? ' table-session-modal-portal--above-manual-order' : ''}`}>

			<div className="table-session-modal-overlay" role="presentation" onClick={onClose}>

				<div className="admin-layout table-session-modal-portal-host">

					<div

						className={`table-session-modal close-table-modal table-session-modal--receipt table-session-modal--completed table-session-modal--${kind}${isPayIntent ? ' close-table-modal--pay' : ''}`}

						role="dialog"

						aria-modal="true"

						aria-labelledby="close-table-modal-title"

						onClick={(event) => event.stopPropagation()}

					>

						<TableSessionReceipt

							order={order}

							formatMoney={formatMoney}

							formatOrderTotal={formatOrderTotal}

							kind={kind}

							mode="checkout"

							titleId="close-table-modal-title"

							statusLabel={statusLabel}

							onClose={onClose}

							children={

								confirmOnly ? (

									<div className="close-table-modal__confirm-only">

										<CheckCircle2 size={20} aria-hidden />

										<div>

											<strong>Pago registrado</strong>

											<p>{getOrderPaymentDisplayLabel(order)} — confirma la entrega para cerrar.</p>

										</div>

									</div>

								) : (

									<PaymentDetails

										variant="receipt"

										manualOrder={manualOrderShape}

										branch={branch}

										branchDeliveryCfg={branch?.delivery_settings || null}

										updateCouponCode={() => {}}

										couponPreview={null}

										updatePaymentType={(type) => setForm((f) => ({ ...f, payment_type: type }))}

										updatePaymentMode={(mode) => setForm((f) => ({ ...f, payment_mode: mode }))}

										updateCashAmount={(v) => setForm((f) => ({ ...f, cash_amount: v }))}

										updateCardAmount={(v) => setForm((f) => ({ ...f, card_amount: v }))}

										updateCashTendered={(v) => setForm((f) => ({ ...f, cash_tendered: v }))}

										updatePaymentLines={(lines) => setForm((f) => ({ ...f, payment_lines: lines }))}

										receiptFile={receiptFile}

										receiptPreview={receiptPreview}

										handleFileChange={handleFileChange}

										removeReceipt={removeReceipt}

										submitOrder={handleConfirm}

										loading={loading}

										isFormValid={isFormValid}

										hideCouponSection

										hideTotalBreakdown

										hideCheckoutActions

									/>

								)

							}

							footer={

								<Button variant="default"

									type="button"

									className="table-session-receipt__cta"

									onClick={handleConfirm}

									disabled={loading || !isFormValid()}

								>

									{loading ? (isPayIntent ? 'Registrando…' : 'Cerrando…') : confirmLabel}

								</Button>

							}

						/>

					</div>

				</div>

			</div>

		</div>

	);



	if (typeof document === 'undefined') return null;

	return createPortal(modal, document.body);

}

