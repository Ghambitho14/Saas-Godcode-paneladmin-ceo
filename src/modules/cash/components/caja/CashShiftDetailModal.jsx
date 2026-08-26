import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Clock, XCircle, Eye } from 'lucide-react';
import { getOrderForMovement, isMovementOrderClickable } from '../../utils/getOrderForMovement';
import { cashService } from '../../services/cashService';
import {
    isManualLocalExpense,
    isCashWithdrawal,
    isOperatingLocalExpense,
} from '../../utils/cashMovementKinds';
import { supabase, TABLES } from '@/integrations/supabase';
import {
    getPaymentLabel,
    getOrderTileKind,
    getOrderFulfillmentDisplayLabel,
    PAYMENT_METHOD_LABELS,
    isMixedPaymentBreakdown,
} from '@/shared/utils/orderUtils';
import { getClosedShiftReconciliation, diffCounted } from '../../utils/shiftCloseReconciliation';
import { isCourierPayoutMovement } from '../../utils/cashTotals';
import { formatShiftDuration } from '../../utils/shiftDuration';
import { useBranchMoney } from '@/modules/cash/hooks/useBranchMoney';
import { useLockBodyScroll } from '@/shared/hooks/useLockBodyScroll';
import PickupBagIcon from '../PickupBagIcon';
import TableRestaurantIcon from '../TableRestaurantIcon';
import DeliveryMotoIcon from '../DeliveryMotoIcon';
import { Button } from "@/components/ui/button";

function movementTypeLabel(m) {
    if (m.type === 'cancel') return 'Cancelado';
    if (m.type === 'sale') return 'Venta';
    if (m.type === 'income') return 'Ingreso';
    if (isCashWithdrawal(m)) return 'Retiro efectivo';
    if (isOperatingLocalExpense(m)) return 'Gasto operativo';
    if (isManualLocalExpense(m)) return 'Gasto local';
    if (isCourierPayoutMovement(m)) return 'Pago repartidor';
    return 'Devolución';
}

function movementTypeClass(m) {
    if (m.type === 'cancel') return 'cancel';
    if (m.type === 'sale') return 'sale';
    if (m.type === 'income') return 'income';
    if (isCashWithdrawal(m) || isOperatingLocalExpense(m) || isManualLocalExpense(m) || isCourierPayoutMovement(m)) {
        return 'expense';
    }
    if (m.type === 'expense') return 'refund';
    return m.type || 'expense';
}

const RAIL_METHOD_LABELS = {
    cash: 'Efectivo',
    card: 'Tarjeta',
    online: 'Transferencia',
    tarjeta: 'Tarjeta',
    tienda: 'Efectivo',
    efectivo: 'Efectivo',
    transferencia: 'Transferencia',
};

function methodKeyToLabel(raw) {
    if (raw == null || raw === '') return null;
    const key = String(raw).trim().toLowerCase();
    if (!key) return null;
    if (RAIL_METHOD_LABELS[key]) return RAIL_METHOD_LABELS[key];
    if (PAYMENT_METHOD_LABELS[key]) {
        const label = PAYMENT_METHOD_LABELS[key];
        if (label === 'Transf.' || label === 'Transferencia') return 'Transferencia';
        if (label === 'En local') return 'Efectivo';
        return label;
    }
    return null;
}

/** Solo nombre del método — nunca montos (getPaymentLabel a veces incluye "$31"). */
function movementPaymentLabel(m, linkedOrder = null) {
    if (m.type === 'cancel') return null;

    const fromMovement = methodKeyToLabel(m.payment_method);
    if (fromMovement) return fromMovement;

    const order = linkedOrder ?? (Array.isArray(m.orders) ? m.orders[0] : m.orders);
    if (!order) return null;

    if (Array.isArray(order.payment_lines) && order.payment_lines.length > 0) {
        if (order.payment_lines.length > 1) return 'Mixto';
        const line = order.payment_lines[0];
        return (
            methodKeyToLabel(line.methodId) ||
            methodKeyToLabel(line.rail) ||
            methodKeyToLabel(line.method_id) ||
            '—'
        );
    }

    if (isMixedPaymentBreakdown(order.payment_breakdown)) return 'Mixto';

    const fromSpecific = methodKeyToLabel(order.payment_method_specific);
    if (fromSpecific) return fromSpecific;

    const fromType = methodKeyToLabel(order.payment_type);
    if (fromType) return fromType;

    return null;
}

function formatMovementDateTime(iso) {
    const d = new Date(iso);
    return {
        date: d.toLocaleDateString('es-CL', { dateStyle: 'short' }),
        time: d.toLocaleTimeString('es-CL', { timeStyle: 'short' }),
    };
}

function resolveMovementOrder(movement, ordersList = []) {
    const embedded = movement?.orders;
    if (embedded && !Array.isArray(embedded) && embedded.id) return embedded;
    if (Array.isArray(embedded) && embedded[0]?.id) return embedded[0];
    return getOrderForMovement(movement, ordersList);
}

function FulfillmentTypeIcon({ kind, size = 12 }) {
    if (kind === 'moto') return <DeliveryMotoIcon size={size} aria-hidden />;
    if (kind === 'mesa') return <TableRestaurantIcon size={size} aria-hidden />;
    if (kind === 'retiro') return <PickupBagIcon size={size} aria-hidden />;
    return null;
}

function orderItemsSummary(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const totalUnits = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    if (items.length === 1) {
        const i = items[0];
        return `${i.quantity || 1}× ${(i.name ?? 'Producto').split(' (')[0]}`;
    }
    return `${items.length} productos · ${totalUnits} u.`;
}

function shiftClosedAtMs(shift) {
    if (!shift?.closed_at) return null;
    const ms = new Date(shift.closed_at).getTime();
    return Number.isFinite(ms) ? ms : null;
}

const CashShiftDetailModal = ({ isOpen, onClose, shift, getTotals, orders = [], onMovementClick }) => {
    const { formatMoney: fmtHist } = useBranchMoney();
    const [movements, setMovements] = useState([]);
    const [loading, setLoading] = useState(false);
    const [openedByLabel, setOpenedByLabel] = useState('');

    const shiftRowId = shift?.id ?? shift?.shift_id;
    const openedById = shift?.opened_by ?? null;
    const closedAtMs = shiftClosedAtMs(shift);
    const isShiftClosed = closedAtMs != null;

    // Cancelaciones no generan cash_movements: se sintetizan desde `orders`.
    // En turno abierto (p. ej. "Ver todos") no hay closed_at → ventana hasta ahora.
    const cancelledOrdersInShift = useMemo(() => {
        if (!shift?.opened_at) return [];
        const branchId = shift.branch_id;
        if (branchId == null || branchId === '') return [];
        const openedAt = new Date(shift.opened_at).getTime();
        if (!Number.isFinite(openedAt)) return [];
        const windowEnd = closedAtMs ?? Date.now();
        return (orders || [])
            .filter(
                (o) =>
                    o?.status === 'cancelled' &&
                    String(o.branch_id) === String(branchId) &&
                    new Date(o.created_at).getTime() >= openedAt &&
                    new Date(o.created_at).getTime() <= windowEnd
            )
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }, [shift, orders, closedAtMs]);

    const movementsWithCancellations = useMemo(() => {
        const synthetic = (cancelledOrdersInShift || []).map((order) => ({
            id: `cancel-${order.id}`,
            type: 'cancel',
            order_id: order.id,
            description: `Pedido #${String(order.id).slice(-4)} cancelado`,
            created_at: order.created_at,
            amount: 0,
            payment_method: null,
            orders: order,
        }));
        const base = movements || [];
        return [...base, ...synthetic].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
    }, [movements, cancelledOrdersInShift]);

    const loadMovements = useCallback(async () => {
        if (shiftRowId == null || shiftRowId === '') return;
        setLoading(true);
        try {
            const data = await cashService.getShiftMovements(shiftRowId);
            setMovements(data || []);
        } catch {
            setMovements([]);
        } finally {
            setLoading(false);
        }
    }, [shiftRowId]);

    useEffect(() => {
        if (isOpen && shift) {
            loadMovements();
        }
    }, [isOpen, shift, loadMovements]);

    useEffect(() => {
        let cancelled = false;
        if (!isOpen || !openedById) {
            setOpenedByLabel('');
            return undefined;
        }

        (async () => {
            const fallback = `Usuario ${String(openedById).slice(0, 8)}`;
            try {
                // 1. Buscar en tabla users (por id o auth_user_id)
                let { data: userRow } = await supabase
                    .from(TABLES.users)
                    .select('id, email, auth_user_id')
                    .eq('id', openedById)
                    .maybeSingle();

                if (!userRow?.email) {
                    const byAuth = await supabase
                        .from(TABLES.users)
                        .select('id, email, auth_user_id')
                        .eq('auth_user_id', openedById)
                        .maybeSingle();
                    if (byAuth.data?.email) userRow = byAuth.data;
                }

                // 2. Si no se encuentra en users, buscar en admin_users
                if (!userRow?.email) {
                    const { data: adminRow } = await supabase
                        .from(TABLES.admin_users)
                        .select('id, email, auth_user_id')
                        .eq('id', openedById)
                        .maybeSingle();
                    if (adminRow?.email) userRow = adminRow;
                    else {
                        const byAdminAuth = await supabase
                            .from(TABLES.admin_users)
                            .select('id, email, auth_user_id')
                            .eq('auth_user_id', openedById)
                            .maybeSingle();
                        if (byAdminAuth.data?.email) userRow = byAdminAuth.data;
                    }
                }

                if (cancelled) return;

                const email = userRow?.email ? String(userRow.email).trim() : '';
                setOpenedByLabel(email || fallback);
            } catch {
                if (!cancelled) {
                    setOpenedByLabel(fallback);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [isOpen, openedById]);

    useLockBodyScroll(isOpen && !!shift);

    if (!isOpen || !shift) return null;

    const totals = getTotals
        ? getTotals(movements)
        : {
            income: 0,
            expense: 0,
            cash: 0,
            card: 0,
            online: 0,
            manualExpenses: 0,
            manualExpenseCount: 0,
            cashWithdrawals: 0,
            cashWithdrawalCount: 0,
            operatingExpenses: 0,
            operatingExpenseCount: 0,
            refundExpenses: 0,
            refundExpenseCount: 0,
            deliveryCollected: 0,
            deliveryRefunded: 0,
            deliveryPaidToCourier: 0,
        };

    const deliveryNet = Math.max(
        0,
        (Number(totals.deliveryCollected) || 0) - (Number(totals.deliveryRefunded) || 0)
    );
    const deliveryPendingToPay = Math.max(
        0,
        deliveryNet - (Number(totals.deliveryPaidToCourier) || 0)
    );

    const shiftOrdersCount = (() => {
        if (Number.isFinite(Number(shift?.orders_count))) {
            return Number(shift.orders_count);
        }
        if (Array.isArray(shift?.orders) && Number.isFinite(Number(shift.orders[0]?.count))) {
            return Number(shift.orders[0].count);
        }
        const saleMovements = (movements || []).filter((m) => m.type === 'sale').length;
        const cancelled = Array.isArray(cancelledOrdersInShift) ? cancelledOrdersInShift.length : 0;
        return Math.max(0, saleMovements - cancelled);
    })();

    const cashDiff = (shift.actual_balance || 0) - (shift.expected_balance || 0);
    const isSurplus = cashDiff >= 0;
    const reconciliation = isShiftClosed ? getClosedShiftReconciliation(shift, totals) : null;
    const headerDateSource = isShiftClosed ? shift.closed_at : shift.opened_at;

    const reconcileRows = [
        { key: 'cash', label: 'Efectivo' },
        { key: 'card', label: 'Tarjeta (punto)' },
        { key: 'online', label: 'Transferencia' },
    ];

    const methodMetrics = [
        { key: 'cash', label: 'Efectivo', value: totals.cash },
        { key: 'card', label: 'Tarjeta', value: totals.card },
        { key: 'online', label: 'Transferencia', value: totals.online },
    ];

    return (
        <div
            className="modal-overlay"
            onClick={onClose}
            role="presentation"
        >
            <div
                className="modal-content cash-dialog cash-shift-detail-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="cash-shift-detail-title"
            >
                <header className="modal-header cash-dialog__header cash-shift-detail-modal__header">
                    <div className="cash-shift-detail-modal__title-block">
                        <h3 id="cash-shift-detail-title" className="cash-dialog__title cash-shift-detail-modal__title">
                            {isShiftClosed ? 'Turno cerrado' : 'Turno activo'}
                        </h3>
                        <div className="cash-shift-detail-modal__meta">
                            <span>
                                {headerDateSource
                                    ? new Date(headerDateSource).toLocaleDateString('es-CL', {
                                            weekday: 'short',
                                            day: '2-digit',
                                            month: 'long',
                                            year: 'numeric',
                                        })
                                    : '—'}
                            </span>
                            <span className="cash-shift-detail-modal__badge">
                                {shiftOrdersCount} {shiftOrdersCount === 1 ? 'pedido' : 'pedidos'}
                            </span>
                            <span className="cash-shift-detail-modal__badge cash-shift-detail-modal__badge--muted">
                                {movementsWithCancellations.length}{' '}
                                {movementsWithCancellations.length === 1 ? 'movimiento' : 'movimientos'}
                            </span>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} className="cash-dialog__dismiss" aria-label="Cerrar">
                        <X size={16} strokeWidth={2} />
                    </button>
                </header>

                <div className="cash-shift-detail-modal__body">
                    <aside className="cash-shift-detail-summary">
                        <section className="cash-shift-detail-card">
                            <h4 className="cash-shift-detail-section-title">Información del turno</h4>
                            <div className="cash-shift-detail-info-grid">
                                <div className="cash-shift-detail-info-item">
                                    <span className="cash-shift-detail-info-item__label">Apertura</span>
                                    <span className="cash-shift-detail-info-item__value">
                                        {new Date(shift.opened_at).toLocaleString('es-CL', {
                                            dateStyle: 'short',
                                            timeStyle: 'short',
                                        })}
                                    </span>
                                </div>
                                <div className="cash-shift-detail-info-item">
                                    <span className="cash-shift-detail-info-item__label">Cierre</span>
                                    <span className="cash-shift-detail-info-item__value">
                                        {isShiftClosed
                                            ? new Date(shift.closed_at).toLocaleString('es-CL', {
                                                    dateStyle: 'short',
                                                    timeStyle: 'short',
                                                })
                                            : 'En curso'}
                                    </span>
                                </div>
                                <div className="cash-shift-detail-info-item">
                                    <span className="cash-shift-detail-info-item__label">Duración</span>
                                    <span className="cash-shift-detail-info-item__value">
                                        <Clock size={13} aria-hidden />
                                        {formatShiftDuration(shift.opened_at, shift.closed_at)}
                                    </span>
                                </div>
                                <div className="cash-shift-detail-info-item cash-shift-detail-info-item--wide">
                                    <span className="cash-shift-detail-info-item__label">Responsable</span>
                                    <span className="cash-shift-detail-info-item__value">
                                        {openedByLabel || (openedById ? 'Cargando…' : 'Sin registrar')}
                                    </span>
                                </div>
                            </div>
                        </section>

                        <section className="cash-shift-detail-card">
                            <h4 className="cash-shift-detail-section-title">Resumen de caja</h4>
                            <div className="cash-shift-detail-kpi-grid">
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Base caja</span>
                                    <span className="cash-shift-detail-kpi__value">{fmtHist(shift.opening_balance)}</span>
                                </div>
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Efectivo final</span>
                                    <span className="cash-shift-detail-kpi__value cash-shift-detail-kpi__value--income">
                                        {fmtHist(shift.actual_balance)}
                                    </span>
                                </div>
                                <div
                                    className={`cash-shift-detail-kpi cash-shift-detail-kpi--highlight${isSurplus ? ' cash-shift-detail-kpi--surplus' : ' cash-shift-detail-kpi--shortage'}`}
                                >
                                    <span className="cash-shift-detail-kpi__label">
                                        {isSurplus ? 'Sobrante' : 'Faltante'}
                                    </span>
                                    <span
                                        className={
                                            isSurplus
                                                ? 'cash-shift-detail-kpi__value cash-shift-detail-kpi__value--income'
                                                : 'cash-shift-detail-kpi__value cash-shift-detail-kpi__value--expense'
                                        }
                                    >
                                        {fmtHist(Math.abs(cashDiff))}
                                    </span>
                                </div>
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Ingresos</span>
                                    <span className="cash-shift-detail-kpi__value cash-shift-detail-kpi__value--income">
                                        +{fmtHist(totals.income)}
                                    </span>
                                </div>
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Gastos del local</span>
                                    <span className="cash-shift-detail-kpi__value cash-shift-detail-kpi__value--expense">
                                        −{fmtHist(totals.manualExpenses)}
                                    </span>
                                    <span className="cash-shift-detail-kpi__sub">
                                        {totals.manualExpenseCount ?? 0} mov.
                                    </span>
                                </div>
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Devoluciones</span>
                                    <span className="cash-shift-detail-kpi__value cash-shift-detail-kpi__value--warn">
                                        −{fmtHist(totals.refundExpenses)}
                                    </span>
                                    <span className="cash-shift-detail-kpi__sub">
                                        {totals.refundExpenseCount ?? 0} mov.
                                    </span>
                                </div>
                            </div>
                        </section>

                        <section className="cash-shift-detail-card">
                            <h4 className="cash-shift-detail-section-title">Resumen delivery</h4>
                            <div className="cash-shift-detail-kpi-grid">
                                <div className="cash-shift-detail-kpi cash-shift-detail-kpi--highlight cash-shift-detail-kpi--delivery">
                                    <span className="cash-shift-detail-kpi__label">Delivery a pagar</span>
                                    <span className="cash-shift-detail-kpi__value">{fmtHist(deliveryPendingToPay)}</span>
                                    <span className="cash-shift-detail-kpi__sub">
                                        Neto cobrado: {fmtHist(deliveryNet)}
                                    </span>
                                </div>
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Cobrado en envíos</span>
                                    <span className="cash-shift-detail-kpi__value">{fmtHist(totals.deliveryCollected || 0)}</span>
                                </div>
                                <div className="cash-shift-detail-kpi">
                                    <span className="cash-shift-detail-kpi__label">Pagado a repartidor</span>
                                    <span className="cash-shift-detail-kpi__value">{fmtHist(totals.deliveryPaidToCourier || 0)}</span>
                                </div>
                                {(Number(totals.deliveryRefunded) || 0) > 0 ? (
                                    <div className="cash-shift-detail-kpi">
                                        <span className="cash-shift-detail-kpi__label">Envíos devueltos</span>
                                        <span className="cash-shift-detail-kpi__value cash-shift-detail-kpi__value--warn">
                                            −{fmtHist(totals.deliveryRefunded)}
                                        </span>
                                    </div>
                                ) : null}
                            </div>
                        </section>

                        {reconciliation ? (
                            <section className="cash-shift-detail-card">
                                <h4 className="cash-shift-detail-section-title">Cuadre al cierre</h4>
                                <div className="cash-shift-detail-reconcile">
                                    {reconcileRows.map(({ key, label }) => {
                                        const { expected, actual } = reconciliation[key];
                                        const hasActual = actual != null && !Number.isNaN(actual);
                                        const diff = hasActual ? diffCounted(expected, actual) : null;
                                        return (
                                            <div key={key} className="cash-shift-detail-reconcile__row">
                                                <span className="cash-shift-detail-reconcile__label">{label}</span>
                                                <div className="cash-shift-detail-reconcile__nums">
                                                    <span>
                                                        Esp. <strong>{fmtHist(expected)}</strong>
                                                    </span>
                                                    <span className="cash-shift-detail-reconcile__sep" aria-hidden>
                                                        ·
                                                    </span>
                                                    <span>
                                                        Cont. <strong>{hasActual ? fmtHist(actual) : '—'}</strong>
                                                    </span>
                                                    {hasActual && diff ? (
                                                        <span
                                                            className={`cash-shift-detail-reconcile__status cash-shift-detail-reconcile__status--${diff.status}`}
                                                        >
                                                            {diff.status === 'match'
                                                                ? 'Cuadrado'
                                                                : `${diff.status === 'surplus' ? 'Sobrante' : 'Faltante'} ${fmtHist(Math.abs(diff.diff))}`}
                                                        </span>
                                                    ) : null}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>
                        ) : null}

                        <section className="cash-shift-detail-card">
                            <h4 className="cash-shift-detail-section-title">Cobros por método</h4>
                            <div className="cash-shift-detail-methods-row">
                                {methodMetrics.map(({ key, label, value }) => (
                                    <div key={key} className="cash-shift-detail-method-metric">
                                        <span className="cash-shift-detail-method-metric__label">{label}</span>
                                        <strong className="cash-shift-detail-method-metric__value">
                                            {fmtHist(value)}
                                        </strong>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </aside>

                    <section className="cash-shift-detail-movements-panel">
                        <div className="cash-shift-detail-movements-head">
                            <h4 className="cash-shift-detail-section-title cash-shift-detail-section-title--lg">
                                Movimientos del turno
                            </h4>
                            {!loading ? (
                                <span className="cash-shift-detail-movements-count">
                                    {movementsWithCancellations.length} en total
                                </span>
                            ) : null}
                        </div>

                        {loading ? (
                            <div className="cash-shift-detail-movements-empty">Cargando transacciones…</div>
                        ) : movementsWithCancellations.length === 0 ? (
                            <div className="cash-shift-detail-movements-empty">
                                No hay movimientos registrados para este turno.
                            </div>
                        ) : (
                            <div className="cash-shift-detail-movements">
                                <table className="cash-shift-detail-movements-table cash-movements-table">
                                    <colgroup>
                                        <col className="cash-shift-detail-movements-col-time" />
                                        <col className="cash-shift-detail-movements-col-detail" />
                                    </colgroup>
                                    <thead>
                                        <tr>
                                            <th>Fecha / hora</th>
                                            <th>Detalle</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {movementsWithCancellations.map((m) => {
                                            const movementDatetime = formatMovementDateTime(m.created_at);
                                            const linkedOrder = resolveMovementOrder(m, orders);
                                            const isSale = m.type === 'sale';
                                            const fulfillmentKind =
                                                linkedOrder && isSale ? getOrderTileKind(linkedOrder) : null;
                                            const typeClass = movementTypeClass(m);
                                            const paymentLabel = movementPaymentLabel(m, linkedOrder);
                                            const paymentTitle =
                                                linkedOrder && m.type !== 'cancel'
                                                    ? getPaymentLabel(linkedOrder)
                                                    : paymentLabel || undefined;
                                            const clickable =
                                                Boolean(onMovementClick) &&
                                                isMovementOrderClickable(m, orders);
                                            const orderForRow = clickable
                                                ? (linkedOrder ?? getOrderForMovement(m, orders))
                                                : null;
                                            const clientName = linkedOrder
                                                ? (linkedOrder.display_name || linkedOrder.client_name || 'Cliente casual')
                                                : null;
                                            const itemsSummary = linkedOrder
                                                ? orderItemsSummary(linkedOrder.items)
                                                : null;
                                            const metaLine = [clientName, itemsSummary].filter(Boolean).join(' · ');
                                            const handleRowActivate = () => {
                                                if (clickable && onMovementClick) onMovementClick(m);
                                            };
                                            return (
                                            <tr
                                                key={m.id}
                                                className={`movement-row cash-shift-detail-movements__row${m.type === 'cancel' ? ' movement-row--cancelled' : ''}${clickable ? ' movement-row--clickable' : ''}${fulfillmentKind ? ` movement-row--fulfillment-${fulfillmentKind}` : ''}${typeClass === 'refund' ? ' movement-row--refund' : ''}`}
                                                onClick={clickable ? handleRowActivate : undefined}
                                                onKeyDown={
                                                    clickable
                                                        ? (e) => {
                                                              if (e.key === 'Enter' || e.key === ' ') {
                                                                  e.preventDefault();
                                                                  handleRowActivate();
                                                              }
                                                          }
                                                        : undefined
                                                }
                                                role={clickable ? 'button' : undefined}
                                                tabIndex={clickable ? 0 : undefined}
                                                aria-label={
                                                    clickable && orderForRow
                                                        ? `Ver detalle del pedido ${orderForRow.id}`
                                                        : undefined
                                                }
                                            >
                                                <td className="cash-shift-detail-movements-table__time">
                                                    <div className="cash-shift-detail-movement-datetime">
                                                        <span className="cash-shift-detail-movement-datetime__date">
                                                            {movementDatetime.date}
                                                        </span>
                                                        <span className="cash-shift-detail-movement-datetime__time">
                                                            {movementDatetime.time}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="cash-shift-detail-movements-table__detail">
                                                    <div className="cash-shift-detail-movement-row">
                                                        <div className="cash-shift-detail-movement-main">
                                                            <span
                                                                className={`movement-type type-${typeClass}${fulfillmentKind ? ` movement-type--fulfillment-${fulfillmentKind}` : ''}`}
                                                            >
                                                                {m.type === 'cancel' ? (
                                                                    <>
                                                                        <XCircle size={10} aria-hidden />
                                                                        Cancelado
                                                                    </>
                                                                ) : fulfillmentKind && isSale ? (
                                                                    <>
                                                                        <FulfillmentTypeIcon kind={fulfillmentKind} size={10} />
                                                                        {getOrderFulfillmentDisplayLabel(linkedOrder)}
                                                                    </>
                                                                ) : (
                                                                    movementTypeLabel(m)
                                                                )}
                                                            </span>
                                                            <div className="cash-shift-detail-movement-main__body">
                                                                <div className="cash-shift-detail-movement-desc">
                                                                    <span className="cash-shift-detail-movement-desc__text">
                                                                        {m.description || '—'}
                                                                    </span>
                                                                    {clickable ? (
                                                                        <span className="cash-shift-detail-movement-view-hint" aria-hidden>
                                                                            <Eye size={12} strokeWidth={1.75} />
                                                                        </span>
                                                                    ) : null}
                                                                </div>
                                                                {metaLine ? (
                                                                    <div className="cash-shift-detail-movement-order">
                                                                        <span
                                                                            className="cash-shift-detail-movement-order__client"
                                                                            title={metaLine}
                                                                        >
                                                                            {metaLine}
                                                                        </span>
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                        <div
                                                            className="cash-shift-detail-movement-pay"
                                                            title={paymentTitle}
                                                        >
                                                            {m.type === 'cancel' ? (
                                                                <span className="cash-shift-detail-amount-cancel">—</span>
                                                            ) : (
                                                                <span
                                                                    className={
                                                                        m.type === 'expense'
                                                                            ? 'movement-amount amount-minus'
                                                                            : 'movement-amount amount-plus'
                                                                    }
                                                                >
                                                                    {m.type === 'expense' ? '−' : '+'}
                                                                    {fmtHist(m.amount)}
                                                                </span>
                                                            )}
                                                            {paymentLabel ? (
                                                                <span className="cash-shift-detail-movement-pay__method">
                                                                    {paymentLabel}
                                                                </span>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </div>

                <footer className="cash-dialog__footer cash-shift-detail-modal__footer">
                    <Button
                        variant="outline"
                        type="button"
                        className="cash-dialog__btn cash-dialog__btn--ghost"
                        onClick={onClose}
                    >
                        Cerrar
                    </Button>
                </footer>
            </div>
        </div>
    );
};

export default CashShiftDetailModal;
