import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
    Unlock, Lock, History, 
    Clock, Calendar, TrendingUp, TrendingDown,
    ArrowUpCircle, ArrowDownCircle, Eye, XCircle,
    DollarSign, CreditCard, ChevronRight, Truck,
    MapPin,
} from 'lucide-react';
import { useAdmin } from '@/modules/cash/admin/pages/AdminProvider';
import { isValidBranchId } from '@/shared/utils/safeIds';
import CashShiftModal from './CashShiftModal';
import CashMovementModal from './CashMovementModal';
import CashShiftDetailModal from './CashShiftDetailModal';
import CashOrderDetailPanel from './CashOrderDetailPanel';
import { useBranchMoney } from '@/modules/cash/hooks/useBranchMoney';
import { useOrderMoney } from '@/modules/cash/hooks/useOrderMoney';
import { getPaymentLabel, getOrderTileKind } from '@/shared/utils/orderUtils';
import AdminIconSlot from '../AdminIconSlot';
import PickupBagIcon from '../PickupBagIcon';
import TableRestaurantIcon from '../TableRestaurantIcon';
import DeliveryMotoIcon from '../DeliveryMotoIcon';
import ReportPeriodSelect from '../ReportPeriodSelect';
import {
    getCashShiftHistoryPeriodOptions,
    isInReportRange,
    resolveReportPeriodRange,
} from '../../utils/reportPeriodRange';
import { getOrderForMovement } from '../../utils/getOrderForMovement';
import {
    formatShiftDuration,
    formatShiftHoursRange,
    formatShiftOpenedDay,
} from '../../utils/shiftDuration';
import { Button } from "@/components/ui/button";

const CASH_SHIFT_HISTORY_PERIOD_OPTIONS = getCashShiftHistoryPeriodOptions();

function RecentMovementIcon({ type, order, isCancel }) {
    if (isCancel) return <XCircle size={16} aria-hidden />;

    const linkedOrder = order && (type === 'sale' || type === 'cancel' || type === 'expense');
    if (linkedOrder) {
        const kind = getOrderTileKind(order);
        if (kind === 'moto') return <DeliveryMotoIcon size={16} aria-hidden />;
        if (kind === 'mesa') return <TableRestaurantIcon size={16} aria-hidden />;
        return <PickupBagIcon size={16} aria-hidden />;
    }

    if (type === 'expense') return <ArrowDownCircle size={16} aria-hidden />;
    if (type === 'income') return <ArrowUpCircle size={16} aria-hidden />;
    return <ArrowUpCircle size={16} aria-hidden />;
}

const ElapsedTime = ({ since }) => {
    const [elapsed, setElapsed] = useState('');
    useEffect(() => {
        const calc = () => setElapsed(formatShiftDuration(since));
        calc();
        const id = setInterval(calc, 60000);
        return () => clearInterval(id);
    }, [since]);
    return <span>{elapsed}</span>;
};

const CashManager = ({
    showNotify,
    selectedBranchId,
    selectedBranch = null,
    orders = [],
    logoUrl = null,
    companyName = null,
}) => {
    const { cashSystem, companyProfile } = useAdmin();
    const { formatMoney: fmt } = useBranchMoney();
    const { formatOrderAmount } = useOrderMoney();
    const {
        activeShift, loading: loadingSystem, movements,
        openShift, closeShift, addManualMovement,
        getPastShifts, getTotals,
    } = cashSystem;

    const [pastShifts, setPastShifts] = useState([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [viewingShift, setViewingShift] = useState(null);
    const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
    const [isMovementModalOpen, setIsMovementModalOpen] = useState(false);
    /** @type {'income' | 'cash_withdrawal'} */
    const [movementModalVariant, setMovementModalVariant] = useState('income');
    const [filterPeriod, setFilterPeriod] = useState('30');
    const [selectedMovementOrder, setSelectedMovementOrder] = useState(null);

    const loadHistory = useCallback(async () => {
        setLoadingHistory(true);
        try {
            const data = await getPastShifts();
            setPastShifts(data || []);
        } catch {
            showNotify('Error al cargar historial', 'error');
        } finally {
            setLoadingHistory(false);
        }
    }, [getPastShifts, showNotify]);

    useEffect(() => { loadHistory(); }, [loadHistory, activeShift]);

    const totals = useMemo(() => getTotals(movements), [movements, getTotals]);
    const expectedCashBalance =
        (Number(activeShift?.opening_balance) || 0)
        + (Number(totals.cashBalanceDelta) || 0);
    const deliveryNet = Math.max(
        0,
        (Number(totals.deliveryCollected) || 0) - (Number(totals.deliveryRefunded) || 0)
    );
    const deliveryPendingToPay = Math.max(
        0,
        deliveryNet - (Number(totals.deliveryPaidToCourier) || 0)
    );

    const salesCount = useMemo(() => movements.filter(m => m.type === 'sale').length, [movements]);
    const movementCount = movements.length;

    const [shiftHistoryAnchorDate] = useState(() => new Date());
    const shiftHistoryRange = useMemo(
        () => resolveReportPeriodRange(filterPeriod, shiftHistoryAnchorDate),
        [filterPeriod, shiftHistoryAnchorDate],
    );

    const filteredShifts = useMemo(() => {
        return pastShifts.filter((s) => {
            if (!s?.closed_at) return false;
            return isInReportRange(new Date(s.closed_at), shiftHistoryRange);
        });
    }, [pastShifts, shiftHistoryRange]);

    const cancelledOrdersInShift = useMemo(() => {
        if (!activeShift || !selectedBranchId || selectedBranchId === 'all') return [];
        const openedAt = activeShift.opened_at ? new Date(activeShift.opened_at).getTime() : null;
        if (!openedAt) return [];
        return (orders || [])
            .filter((o) => o?.status === 'cancelled' && o?.branch_id === selectedBranchId && new Date(o.created_at).getTime() >= openedAt)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }, [activeShift, selectedBranchId, orders]);

    const recentMovements = useMemo(() => {
        const cancelled = (cancelledOrdersInShift || []).map((order) => ({
            id: `cancel-${order.id}`,
            type: 'cancel',
            orderId: order.id,
            description: `Pedido #${String(order.id).slice(-4)} cancelado`,
            created_at: order.created_at,
            amount: 0,
        }));
        return [...(movements || []), ...cancelled]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 8);
    }, [movements, cancelledOrdersInShift]);

    const handleMovementClick = useCallback((m) => {
        const order = getOrderForMovement(m, orders);
        if (order) setSelectedMovementOrder(order);
    }, [orders]);

    if (loadingSystem) return (
        <div className="cash-loading">
            <div className="cash-spinner" />
            <span>Cargando caja...</span>
        </div>
    );

    if (!selectedBranchId || selectedBranchId === 'all' || !isValidBranchId(selectedBranchId)) {
        return (
            <div className="cash-empty-state">
                <div className="cash-empty-icon"><MapPin size={48} /></div>
                <h3>Selecciona una sucursal</h3>
                <p>Elige una sucursal en el menú superior para gestionar la caja de ese local.</p>
            </div>
        );
    }

    return (
        <div className="cash-container animate-fade">
            {/* HEADER — solo con turno activo */}
            {activeShift ? (
                <header className="cash-header">
                    <div className="cash-header-brand">
                        <div className="cash-header-titles">
                            <div className="cash-shift-heading" role="status">
                                <span className="cash-pulse" aria-hidden />
                                <h1 className="cash-page-title">Turno activo</h1>
                            </div>
                            <p className="cash-shift-meta">
                                <Clock size={14} aria-hidden />
                                <span>
                                    <ElapsedTime since={activeShift.opened_at} />
                                    {' · desde '}
                                    {new Date(activeShift.opened_at).toLocaleTimeString('es-CL', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}
                                </span>
                            </p>
                        </div>
                    </div>
                    <div className="cash-header-actions" role="group" aria-label="Acciones del turno">
                        <Button
                            variant="outline"
                            type="button"
                            className="cash-action-btn cash-action-btn--income"
                            onClick={() => {
                                setMovementModalVariant('income');
                                setIsMovementModalOpen(true);
                            }}
                        >
                            <ArrowUpCircle size={16} aria-hidden className="cash-action-icon" /> Ingreso
                        </Button>
                        <Button
                            variant="outline"
                            type="button"
                            className="cash-action-btn cash-action-btn--withdraw"
                            onClick={() => {
                                setMovementModalVariant('cash_withdrawal');
                                setIsMovementModalOpen(true);
                            }}
                            title="Retiro de efectivo del turno (compras menores, vuelto). Gastos grandes: Ventas → Gastos del local."
                        >
                            <ArrowDownCircle size={16} aria-hidden className="cash-action-icon" /> Sacar efectivo
                        </Button>
                        <Button
                            variant="outline"
                            type="button"
                            className="cash-action-btn cash-action-btn--close"
                            onClick={() => setIsShiftModalOpen(true)}
                        >
                            <Lock size={16} aria-hidden className="cash-action-icon" /> Cerrar turno
                        </Button>
                    </div>
                </header>
            ) : null}

            {/* TURNO ACTIVO: KPI DASHBOARD */}
            {activeShift ? (
                <section className="cash-section cash-section--active">
                    <div className="cash-kpi-grid">
                        <div className="cash-kpi">
                            <div className="cash-kpi-header">
                                <AdminIconSlot Icon={DollarSign} slotSize="sm" tone="accent" />
                                <span>Balance esperado</span>
                            </div>
                            <div className="cash-kpi-value">{fmt(expectedCashBalance)}</div>
                            <div className="cash-kpi-sub">
                                Base: {fmt(activeShift.opening_balance || 0)} · solo efectivo
                            </div>
                        </div>

                        <div className="cash-kpi">
                            <div className="cash-kpi-header">
                                <AdminIconSlot Icon={TrendingUp} slotSize="sm" tone="success" />
                                <span>Ingresos</span>
                            </div>
                            <div className="cash-kpi-value">{fmt(totals.income)}</div>
                            <div className="cash-kpi-sub">{salesCount} ventas · {movementCount - salesCount > 0 ? `${movements.filter(m => m.type === 'income').length} manuales` : 'sin manuales'}</div>
                        </div>

                        <div className="cash-kpi">
                            <div className="cash-kpi-header">
                                <AdminIconSlot Icon={TrendingDown} slotSize="sm" tone="danger" />
                                <span>Retiros de efectivo</span>
                            </div>
                            <div className="cash-kpi-value">{fmt(Number(totals.cashWithdrawals) || 0)}</div>
                            <div className="cash-kpi-sub">
                                {Number(totals.cashWithdrawalCount) || 0} retiro
                                {(Number(totals.cashWithdrawalCount) || 0) === 1 ? '' : 's'}
                                {(totals.operatingExpenseCount ?? 0) > 0
                                    ? ` · Gastos operativos: ${totals.operatingExpenseCount} (${fmt(totals.operatingExpenses ?? 0)})`
                                    : ''}
                                {(totals.refundExpenseCount ?? 0) > 0
                                    ? ` · Devoluciones: ${totals.refundExpenseCount} (${fmt(totals.refundExpenses ?? 0)})`
                                    : ''}
                            </div>
                        </div>

                        <div className="cash-kpi">
                            <div className="cash-kpi-header">
                                <AdminIconSlot Icon={Truck} slotSize="sm" tone="accent" />
                                <span>Delivery a pagar</span>
                            </div>
                            <div className="cash-kpi-value">{fmt(deliveryPendingToPay)}</div>
                            <div className="cash-kpi-sub">
                                Cobrado: {fmt(deliveryNet)} · Pagado: {fmt(totals.deliveryPaidToCourier || 0)}
                            </div>
                        </div>
                    </div>

                    <div className="cash-methods-panel">
                        <div className="cash-methods-panel-header">
                            <AdminIconSlot Icon={CreditCard} slotSize="sm" />
                            <div className="cash-methods-panel-titles">
                                <span className="cash-methods-panel-title">Cobros por método</span>
                                <span className="cash-kpi-sub">Solo ventas de pedidos</span>
                            </div>
                        </div>
                        <div className="cash-methods-metrics">
                            <div className="cash-method-metric">
                                <span className="cash-method-metric-label">Efectivo</span>
                                <strong className="cash-method-metric-value">{fmt(totals.cash)}</strong>
                            </div>
                            <div className="cash-method-metric">
                                <span className="cash-method-metric-label">Tarjeta</span>
                                <strong className="cash-method-metric-value">{fmt(totals.card)}</strong>
                            </div>
                            <div className="cash-method-metric">
                                <span className="cash-method-metric-label">Transf.</span>
                                <strong className="cash-method-metric-value">{fmt(totals.online)}</strong>
                            </div>
                        </div>
                    </div>

                    {/* ÚLTIMOS MOVIMIENTOS */}
                    {recentMovements.length > 0 && (
                        <div className="cash-recent">
                            <div className="cash-recent-header">
                                <h2 className="cash-block-title">
                                    <AdminIconSlot Icon={Clock} slotSize="sm" tone="accent" />
                                    Últimos movimientos
                                </h2>
                                <Button variant="ghost" type="button" className="btn-text" onClick={() => setViewingShift(activeShift)}>
                                    Ver todos <ChevronRight size={14} aria-hidden />
                                </Button>
                            </div>
                            <div className="cash-recent-list">
                                {recentMovements.map(m => {
                                    const order = getOrderForMovement(m, orders);
                                    const clickable = Boolean(order);
                                    const isCancel = m.type === 'cancel';
                                    const paymentMethod = m.payment_method ?? order?.payment_type;
                                    const fulfillmentKind = order && !isCancel ? getOrderTileKind(order) : null;
                                    const paymentLabel = order ? getPaymentLabel(order) : (paymentMethod === 'cash' ? 'Efectivo' : paymentMethod === 'card' || paymentMethod === 'tarjeta' ? 'Tarjeta' : 'Transf.');
                                    return (
                                        <div
                                            key={m.id}
                                            className={`cash-recent-item ${clickable ? 'cash-recent-item-clickable' : ''} ${isCancel ? 'cash-recent-item--cancelled' : ''}${fulfillmentKind ? ` cash-recent-item--fulfillment-${fulfillmentKind}` : ''}`}
                                            onClick={clickable ? () => handleMovementClick(m) : undefined}
                                            onKeyDown={
                                                clickable
                                                    ? (e) => {
                                                            if (e.key === 'Enter' || e.key === ' ') {
                                                                e.preventDefault();
                                                                handleMovementClick(m);
                                                            }
                                                        }
                                                    : undefined
                                            }
                                            role={clickable ? 'button' : undefined}
                                            tabIndex={clickable ? 0 : -1}
                                        >
                                            <div
                                                className={`cash-recent-icon ${m.type}${fulfillmentKind ? ` cash-recent-icon--${fulfillmentKind}` : ''}${isCancel ? ' cash-recent-icon--cancel' : ''}`}
                                            >
                                                <RecentMovementIcon type={m.type} order={order} isCancel={isCancel} />
                                            </div>
                                            <div className="cash-recent-info">
                                                <span className="cash-recent-desc">{m.description || (m.type === 'sale' ? 'Venta' : m.type === 'income' ? 'Ingreso' : m.type === 'cancel' ? 'Cancelado' : 'Egreso')}</span>
                                                <span className="cash-recent-time">
                                                    {new Date(m.created_at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}
                                                    {isCancel ? ' · Cancelado' : ''}
                                                    {!isCancel && order && Number(order.delivery_fee) > 0
                                                        ? ` · Envío ${formatOrderAmount({
                                                            amountUsd: Number(order.delivery_fee),
                                                            order,
                                                            paymentMethod: order.payment_method_specific,
                                                        })}`
                                                        : ''}
                                                </span>
                                            </div>
                                            {m.type === 'cancel' ? (
                                                <span className="cash-recent-amount cash-recent-amount-cancel">Cancelado</span>
                                            ) : (
                                                <div className="cash-recent-amount-col">
                                                    <span className={`cash-recent-amount ${m.type === 'expense' ? 'negative' : 'positive'}`}>
                                                        {m.type === 'expense' ? '-' : '+'}
                                                        {order && m.type === 'sale'
                                                            ? formatOrderAmount({
                                                                amountUsd: m.amount,
                                                                order,
                                                                paymentMethod: order.payment_method_specific,
                                                            })
                                                            : fmt(m.amount)}
                                                    </span>
                                                    {paymentLabel ? (
                                                        <span className="cash-recent-pay-method">{paymentLabel}</span>
                                                    ) : null}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </section>
            ) : (
                <section className="cash-empty-state cash-empty-state--cta" aria-label="Sin turno abierto">
                    <div className="cash-empty-icon" aria-hidden>
                        <Lock size={32} />
                    </div>
                    <h1 className="cash-page-title cash-page-title--muted">Sin turno abierto</h1>
                    <p className="cash-shift-meta">Abre un turno para registrar movimientos</p>
                    <Button
                        variant="default"
                        type="button"
                        className="btn-open-shift"
                        onClick={() => setIsShiftModalOpen(true)}
                    >
                        <Unlock size={18} aria-hidden /> Abrir turno
                    </Button>
                </section>
            )}

            {/* HISTORIAL DE TURNOS */}
            <section className="cash-section">
                <div className="cash-section-header">
                    <h2 className="cash-block-title">
                        <AdminIconSlot Icon={History} slotSize="sm" tone="accent" />
                        Historial de turnos
                    </h2>
                    <div className="cash-filters-inline">
                        <ReportPeriodSelect
                            value={filterPeriod}
                            onChange={setFilterPeriod}
                            options={CASH_SHIFT_HISTORY_PERIOD_OPTIONS}
                            aria-label="Período del historial de turnos"
                            dateInputAriaLabel="Fecha del historial de turnos"
                            icon={<Calendar size={18} strokeWidth={1.65} className="text-accent" />}
                        />
                    </div>
                </div>

                {loadingHistory ? (
                    <div className="cash-history-loading">Cargando historial...</div>
                ) : filteredShifts.length === 0 ? (
                    <div className="cash-history-empty">
                        <Calendar size={32} />
                        <span>No hay turnos cerrados en este período.</span>
                    </div>
                ) : (
                    <div className="cash-history-list">
                        {filteredShifts.map(shift => {
                            const durationStr = formatShiftDuration(shift.opened_at, shift.closed_at);
                            const hoursRange = formatShiftHoursRange(shift.opened_at, shift.closed_at);
                            const ordersCount = Number(shift.orders_count ?? 0);
                            const summary = shift.summary || {
                                income: 0,
                                cash: 0,
                                card: 0,
                                online: 0,
                                deliveryPending: 0,
                            };

                            return (
                                <div key={shift.id} className="cash-history-card" onClick={() => setViewingShift(shift)}>
                                    <div className="cash-history-date">
                                        <span className="cash-history-day">
                                            {formatShiftOpenedDay(shift.opened_at)}
                                        </span>
                                        <span className="cash-history-hours">{hoursRange}</span>
                                        <div className="cash-history-meta">
                                            <span className="cash-history-duration">
                                                <Clock size={12} aria-hidden /> {durationStr}
                                            </span>
                                            <span className="cash-history-orders">
                                                {ordersCount} {ordersCount === 1 ? 'pedido' : 'pedidos'}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="cash-history-amounts">
                                        <div className="cash-history-col">
                                            <label>Ingresos</label>
                                            <span className="cash-history-col__income">+{fmt(summary.income)}</span>
                                        </div>
                                        <div className="cash-history-col">
                                            <label>Delivery</label>
                                            <span className="cash-history-col__delivery">{fmt(summary.deliveryPending)}</span>
                                        </div>
                                        <div className="cash-history-col">
                                            <label>Efectivo</label>
                                            <span>{fmt(summary.cash)}</span>
                                        </div>
                                        <div className="cash-history-col">
                                            <label>Tarjeta</label>
                                            <span>{fmt(summary.card)}</span>
                                        </div>
                                        <div className="cash-history-col">
                                            <label>Transf.</label>
                                            <span>{fmt(summary.online)}</span>
                                        </div>
                                    </div>

                                    <div className="cash-history-arrow" aria-hidden>
                                        <Eye size={16} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* MODALES */}
            <CashShiftModal
                isOpen={isShiftModalOpen}
                onClose={() => setIsShiftModalOpen(false)}
                type={activeShift ? 'close' : 'open'}
                activeShift={activeShift}
                movements={movements}
                orders={orders}
                getTotals={getTotals}
                onConfirm={activeShift ? closeShift : openShift}
            />

            <CashMovementModal
                isOpen={isMovementModalOpen}
                onClose={() => setIsMovementModalOpen(false)}
                variant={movementModalVariant}
                onConfirm={async (type, amount, description, paymentMethod) => {
                    const opts =
                        movementModalVariant === 'cash_withdrawal'
                            ? {
                                  expenseKind: 'cash_withdrawal',
                                  successMessage: 'Retiro de efectivo registrado',
                              }
                            : {};
                    return addManualMovement(type, amount, description, paymentMethod, opts);
                }}
            />

            <CashShiftDetailModal
                isOpen={!!viewingShift}
                onClose={() => setViewingShift(null)}
                shift={viewingShift}
                getTotals={getTotals}
                orders={orders}
                onMovementClick={handleMovementClick}
            />

            <CashOrderDetailPanel
                order={selectedMovementOrder}
                branch={selectedBranch}
                showNotify={showNotify}
                logoUrl={logoUrl}
                companyName={companyName}
                companyProfile={companyProfile}
                onClose={() => setSelectedMovementOrder(null)}
            />
        </div>
    );
};

export default CashManager;
