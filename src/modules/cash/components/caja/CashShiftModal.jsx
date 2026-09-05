import React, { useEffect, useMemo, useState } from 'react';
import {
	X,
	AlertTriangle,
	CheckCircle2,
	Clock,
	DollarSign,
	CreditCard,
	Smartphone,
	ChevronDown,
	ChevronUp,
} from 'lucide-react';
import { useBranchMoney } from '@/modules/cash/hooks/useBranchMoney';
import { useOrderMoney } from '@/modules/cash/hooks/useOrderMoney';
import {
	getExpectedByMethod,
	diffCounted,
	buildShiftSalesRows,
	buildShiftOtherMovementRows,
} from '../../utils/shiftCloseReconciliation';
import { useLockBodyScroll } from '@/shared/hooks/useLockBodyScroll';
import { filterOpenOrderSessions, getOrderTileKind } from '@/shared/utils/orderUtils';
import DeliveryMotoIcon from '../DeliveryMotoIcon';
import { formatShiftDuration } from '../../utils/shiftDuration';
import { Button } from '@/components/ui/button';
import { parseMoneyInput, minorToMajor, toAmountInputValue } from '@/shared/utils/money';

function DiffBadge({ expected, counted, fmt }) {
	const { diff, status } = diffCounted(expected, counted);
	if (status === 'match') {
		return (
			<span className="cash-shift-close-diff cash-shift-close-diff--match">
				<CheckCircle2 size={14} aria-hidden />
				Cuadrado
			</span>
		);
	}
	const isSurplus = status === 'surplus';
	return (
		<span className={`cash-shift-close-diff cash-shift-close-diff--${status}`}>
			<AlertTriangle size={14} aria-hidden />
			{isSurplus ? 'Sobrante' : 'Faltante'}: {fmt(Math.abs(diff))}
		</span>
	);
}

function MethodCountRow({ id, label, Icon, expected, value, counted, onChange, onUseExpected, fmt, currency }) {
	const hasValue = counted != null;
	return (
		<div className={`cash-shift-close-method${hasValue ? ' is-filled' : ''}`}>
			<div className="cash-shift-close-method__head">
				<span className="cash-shift-close-method__label">
					<Icon size={15} strokeWidth={1.75} aria-hidden />
					{label}
				</span>
				<span className="cash-shift-close-method__expected">
					Esperado <strong>{fmt(expected)}</strong>
				</span>
			</div>
			<div className="cash-shift-close-method__count">
				<label htmlFor={id} className="cash-shift-close-method__count-label">
					Contado
				</label>
				<div className="cash-dialog__amount-wrap">
					<span className="cash-dialog__currency" aria-hidden>
						{currency}
					</span>
					<input
						id={id}
						type="text"
						inputMode="decimal"
						autoComplete="off"
						className="form-input cash-dialog__amount-input"
						placeholder="0"
						value={value}
						onChange={(e) => onChange(e.target.value)}
					/>
				</div>
				<button
					type="button"
					className="cash-shift-close-method__use-expected"
					onClick={onUseExpected}
					title={`Copiar el monto esperado de ${label}`}
					aria-label={`Usar el esperado de ${label}: ${fmt(expected)}`}
				>
					Usar esperado
				</button>
			</div>
			{hasValue ? <DiffBadge expected={expected} counted={counted} fmt={fmt} /> : null}
		</div>
	);
}

const CashShiftModal = ({
	isOpen,
	onClose,
	type,
	onConfirm,
	activeShift,
	movements = [],
	getTotals,
	orders = [],
}) => {
	const { formatMoney: fmt, currency, locale, fractionDigits } = useBranchMoney();
	/* "Usar esperado" escribe con el separador decimal del país y los decimales de
	   la moneda, para que el campo muestre lo mismo que la etiqueta "Esperado". */
	const toInputValue = (amount) => toAmountInputValue(amount, { locale, fractionDigits });
	/* El cajero teclea a mano, así que acepta coma o punto según su país
	   ("15,20" y "15.20" valen lo mismo). parseFloat no sirve aquí: se come los
	   centavos en silencio (parseFloat('15,20') === 15). Devuelve null si el
	   texto no es un importe válido o si es negativo. */
	const parseAmount = (raw) => {
		if (raw === '' || raw == null) return null;
		const parsed = parseMoneyInput(raw, { currency, fractionDigits, locale });
		if (!parsed.valid) return null;
		return minorToMajor(parsed.minor, currency, fractionDigits);
	};
	const { formatOrderAmount } = useOrderMoney();
	/* autoFocus solo donde hay teclado físico: en móvil levantaba el teclado
	   virtual nada más abrir y tapaba medio diálogo. */
	const prefersPointerFocus = typeof window !== 'undefined'
		&& typeof window.matchMedia === 'function'
		&& window.matchMedia('(pointer: fine)').matches;
	/* Fechas y horas con el locale de la sucursal. Estaban fijadas a 'es-CL',
	   así que un local de otro país veía el formato chileno. */
	const dateTimeFmt = useMemo(
		() => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }),
		[locale],
	);
	const timeFmt = useMemo(
		() => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
		[locale],
	);
	/* Intl.format lanza RangeError con una fecha invalida (toLocaleString solo
	   devolvia "Invalid Date"), y una fila sin fecha no debe tumbar el dialogo. */
	const formatWith = (formatter, value) => {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
	};
	const [amount, setAmount] = useState('');
	const [countedCash, setCountedCash] = useState('');
	const [countedCard, setCountedCard] = useState('');
	const [countedOnline, setCountedOnline] = useState('');
	const [error, setError] = useState('');
	const [showOtherMovements, setShowOtherMovements] = useState(false);
	const [showSales, setShowSales] = useState(true);

	const isOpening = type === 'open';

	const totals = useMemo(() => {
		if (isOpening || !getTotals) return null;
		return getTotals(movements);
	}, [isOpening, getTotals, movements]);

	const expectedByMethod = useMemo(() => {
		if (!totals || !activeShift) return { cash: 0, card: 0, online: 0 };
		return getExpectedByMethod(totals, activeShift);
	}, [totals, activeShift]);

	const salesRows = useMemo(() => buildShiftSalesRows(movements, orders), [movements, orders]);
	const otherRows = useMemo(() => buildShiftOtherMovementRows(movements), [movements]);

	const openSessions = useMemo(() => {
		if (!activeShift?.branch_id) return [];
		return filterOpenOrderSessions(
			(orders || []).filter((o) => o?.branch_id === activeShift.branch_id),
		);
	}, [orders, activeShift?.branch_id]);

	const openCount = openSessions.length;

	const cashNum = parseAmount(countedCash);
	const cardNum = parseAmount(countedCard);
	const onlineNum = parseAmount(countedOnline);
	const countsFilled = cashNum !== null && cardNum !== null && onlineNum !== null;
	const canClose = countsFilled && openCount === 0;

	const reconcileStatus = useMemo(() => {
		if (!countsFilled) return null;
		const methods = [
			diffCounted(expectedByMethod.cash, cashNum),
			diffCounted(expectedByMethod.card, cardNum),
			diffCounted(expectedByMethod.online, onlineNum),
		];
		const allMatch = methods.every((m) => m.status === 'match');
		const totalDiff =
			(cashNum - expectedByMethod.cash) +
			(cardNum - expectedByMethod.card) +
			(onlineNum - expectedByMethod.online);
		return { allMatch, totalDiff, methods };
	}, [countsFilled, cashNum, cardNum, onlineNum, expectedByMethod]);

	useEffect(() => {
		if (isOpen) {
			setAmount('');
			setCountedCash('');
			setCountedCard('');
			setCountedOnline('');
			setError('');
			setShowOtherMovements(false);
			setShowSales(true);
		}
	}, [isOpen]);

	useLockBodyScroll(isOpen);

	/* Cerrar con Escape: hasta ahora el diálogo solo se cerraba con el ratón
	   (clic en el fondo o en la X), inaccesible por teclado. */
	useEffect(() => {
		if (!isOpen) return undefined;
		const onKeyDown = (event) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	const fillAllExpected = () => {
		setCountedCash(toInputValue(expectedByMethod.cash));
		setCountedCard(toInputValue(expectedByMethod.card));
		setCountedOnline(toInputValue(expectedByMethod.online));
		setError('');
	};

	const handleSubmit = (e) => {
		e.preventDefault();
		if (isOpening) {
			const numAmount = parseAmount(amount);
			if (numAmount === null) {
				setError('Ingresa un monto válido');
				return;
			}
			onConfirm(numAmount);
			onClose();
			return;
		}

		const cash = parseAmount(countedCash);
		const card = parseAmount(countedCard);
		const online = parseAmount(countedOnline);
		if (cash === null) {
			setError('Ingresa el efectivo físico contado');
			return;
		}
		if (card === null || online === null) {
			setError('Ingresa montos válidos para tarjeta y transferencia (pueden ser 0)');
			return;
		}
		setError('');
		onConfirm({ cash, card, online });
		onClose();
	};

	const describeOpenSession = (order) => {
		const n = order.shift_sequence ?? '?';
		const kind = getOrderTileKind(order);
		const prefix = kind === 'moto' ? `Moto #${n}` : `#${n}`;
		const statusLabel =
			{
				pending: 'pendiente',
				active: 'cocina',
				completed: 'listo',
			}[String(order.status ?? '')] || String(order.status ?? '');
		return `${prefix} ${statusLabel}`;
	};

	return (
		<div className="modal-overlay" onClick={onClose} role="presentation">
			<div
				className={`modal-content cash-dialog cash-shift-modal${!isOpening ? ' cash-shift-modal--close' : ' cash-shift-modal--open'}`}
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-labelledby="cash-shift-modal-title"
			>
				<header className="modal-header cash-dialog__header">
					<h3 id="cash-shift-modal-title" className="cash-dialog__title">
						{isOpening ? 'Apertura de caja' : 'Cierre de caja'}
					</h3>
					<button type="button" onClick={onClose} className="cash-dialog__dismiss" aria-label="Cerrar">
						<X size={16} strokeWidth={2} />
					</button>
				</header>

				<form onSubmit={handleSubmit} className="cash-dialog__form">
					<div className="modal-form cash-dialog__body cash-shift-modal__body">
						{isOpening ? (
							<div className="form-group">
								<label htmlFor="cash-shift-open-amount">Monto inicial</label>
								<div className="cash-dialog__amount-wrap">
									<span className="cash-dialog__currency" aria-hidden>
										{currency}
									</span>
									<input
										id="cash-shift-open-amount"
										type="text"
										inputMode="decimal"
										autoComplete="off"
										className="form-input cash-dialog__amount-input"
										placeholder="0"
										autoFocus={prefersPointerFocus}
										value={amount}
										onChange={(e) => setAmount(e.target.value)}
										required
									/>
								</div>
							</div>
						) : (
							<>
								{activeShift ? (
									<div className="cash-shift-close-summary">
										<div className="cash-shift-close-summary__item">
											<span className="cash-shift-close-summary__label">Abierto</span>
											<span className="cash-shift-close-summary__value">
												<Clock size={13} aria-hidden />
												{formatWith(dateTimeFmt, activeShift.opened_at)}
											</span>
										</div>
										<div className="cash-shift-close-summary__item">
											<span className="cash-shift-close-summary__label">Duración</span>
											<span className="cash-shift-close-summary__value">
												{formatShiftDuration(activeShift.opened_at)}
											</span>
										</div>
										<div className="cash-shift-close-summary__item">
											<span className="cash-shift-close-summary__label">Base</span>
											<span className="cash-shift-close-summary__value">
												{fmt(activeShift.opening_balance || 0)}
											</span>
										</div>
									</div>
								) : null}

								{openCount > 0 ? (
									<div className="cash-shift-close-open-sessions" role="alert">
										<AlertTriangle size={16} aria-hidden />
										<div>
											<strong>
												{openCount} mesa{openCount === 1 ? '' : 's'} o moto
												{openCount === 1 ? '' : 's'} abiertas
											</strong>
											<ul className="cash-shift-close-open-sessions__list">
												{openSessions.map((order) => (
													<li key={order.id}>
														{getOrderTileKind(order) === 'moto' ? (
															<DeliveryMotoIcon size={14} aria-hidden />
														) : null}
														{describeOpenSession(order)}
													</li>
												))}
											</ul>
											<p className="cash-shift-close-open-sessions__hint">
												Cierra todas las sesiones antes de cerrar el turno.
											</p>
										</div>
									</div>
								) : null}

								<div className="cash-shift-close-section-head">
									<h4 className="cash-shift-close-section-title">Cuadre por método</h4>
									<button
										type="button"
										className="cash-shift-close-fill-all"
										onClick={fillAllExpected}
									>
										Rellenar con esperado
									</button>
								</div>
								<p className="cash-shift-close-section-hint">
									Ingresa lo contado en efectivo, punto y transferencias.
								</p>

								<div className="cash-shift-close-methods">
									<MethodCountRow
										id="counted-cash"
										label="Efectivo físico"
										Icon={DollarSign}
										expected={expectedByMethod.cash}
										value={countedCash}
										counted={cashNum}
										onChange={setCountedCash}
										onUseExpected={() => setCountedCash(toInputValue(expectedByMethod.cash))}
										fmt={fmt}
										currency={currency}
									/>
									<MethodCountRow
										id="counted-card"
										label="Tarjeta (punto)"
										Icon={CreditCard}
										expected={expectedByMethod.card}
										value={countedCard}
										counted={cardNum}
										onChange={setCountedCard}
										onUseExpected={() => setCountedCard(toInputValue(expectedByMethod.card))}
										fmt={fmt}
										currency={currency}
									/>
									<MethodCountRow
										id="counted-online"
										label="Transferencia"
										Icon={Smartphone}
										expected={expectedByMethod.online}
										value={countedOnline}
										counted={onlineNum}
										onChange={setCountedOnline}
										onUseExpected={() => setCountedOnline(toInputValue(expectedByMethod.online))}
										fmt={fmt}
										currency={currency}
									/>
								</div>

								{reconcileStatus ? (
									<div
										className={`cash-shift-close-status cash-shift-close-status--${reconcileStatus.allMatch ? 'ok' : 'diff'}`}
										role="status"
									>
										{reconcileStatus.allMatch ? (
											<>
												<CheckCircle2 size={16} aria-hidden />
												<span>Todo cuadrado. Listo para cerrar.</span>
											</>
										) : (
											<>
												<AlertTriangle size={16} aria-hidden />
												<span>
													Hay diferencias · neto{' '}
													{reconcileStatus.totalDiff >= 0 ? '+' : '−'}
													{fmt(Math.abs(reconcileStatus.totalDiff))}
												</span>
											</>
										)}
									</div>
								) : null}

								<div className="cash-shift-close-section-head">
									<h4 className="cash-shift-close-section-title">
										Ventas del turno ({salesRows.length})
									</h4>
									{salesRows.length > 0 ? (
										<button
											type="button"
											className="cash-shift-close-fill-all"
											onClick={() => setShowSales((v) => !v)}
											aria-expanded={showSales}
										>
											{showSales ? (
												<>
													Ocultar <ChevronUp size={14} aria-hidden />
												</>
											) : (
												<>
													Ver <ChevronDown size={14} aria-hidden />
												</>
											)}
										</button>
									) : null}
								</div>

								{showSales ? (
									<div className="cash-shift-close-sales-scroll">
										{salesRows.length === 0 ? (
											<p className="cash-shift-close-empty">
												Sin ventas registradas en este turno.
											</p>
										) : (
											<table className="cash-movements-table cash-shift-close-sales-table">
												<thead>
													<tr>
														<th>Hora</th>
														<th>Pedido</th>
														<th>Método</th>
														<th className="cash-shift-close-sales-table__num">Monto</th>
													</tr>
												</thead>
												<tbody>
													{salesRows.map((row) => (
														<tr key={row.id}>
															<td className="cash-shift-close-sales-table__time">
																{formatWith(timeFmt, row.at)}
															</td>
															<td>{row.label}</td>
															<td>{row.methodLabel}</td>
															<td className="cash-shift-close-sales-table__num">
																{row.order
																	? formatOrderAmount({
																			amountUsd: row.amount,
																			order: row.order,
																			paymentMethod: row.order.payment_method_specific,
																		})
																	: fmt(row.amount)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										)}
									</div>
								) : null}

								{otherRows.length > 0 ? (
									<div className="cash-shift-close-other">
										<Button
											variant="ghost"
											type="button"
											className="cash-shift-close-other-toggle"
											onClick={() => setShowOtherMovements((v) => !v)}
										>
											{showOtherMovements ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
											Otros movimientos ({otherRows.length})
										</Button>
										{showOtherMovements ? (
											<ul className="cash-shift-close-other-list">
												{otherRows.map((row) => (
													<li key={row.id}>
														<span className="cash-shift-close-other-list__time">
															{formatWith(timeFmt, row.at)}
														</span>
														<span>{row.label}</span>
														<span className="cash-shift-close-other-list__method">
															{row.methodLabel}
														</span>
														<span className="cash-shift-close-other-list__amount">
															{fmt(row.amount)}
														</span>
													</li>
												))}
											</ul>
										) : null}
									</div>
								) : null}
							</>
						)}

						{error ? (
							<p className="cash-dialog__error" role="alert">
								{error}
							</p>
						) : null}
					</div>

					<div className="cash-dialog__footer">
						<Button
							variant="outline"
							type="button"
							onClick={onClose}
							className="cash-dialog__btn cash-dialog__btn--ghost"
						>
							Cancelar
						</Button>
						<Button
							variant="default"
							type="submit"
							className={`cash-dialog__btn ${isOpening ? 'cash-dialog__btn--primary' : 'cash-dialog__btn--close'}`}
							disabled={!isOpening && !canClose}
						>
							{isOpening ? 'Abrir turno' : 'Cerrar turno'}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
};

export default CashShiftModal;
