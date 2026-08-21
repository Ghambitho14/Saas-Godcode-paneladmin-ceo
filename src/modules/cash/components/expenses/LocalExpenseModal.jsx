import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    X, ArrowDownCircle, RotateCcw, DollarSign, CreditCard, FileText, Search, Loader2,
} from 'lucide-react';
import { supabase, TABLES } from '@/integrations/supabase';
import { ORDERS_ID_SCAN_SELECT } from '@/shared/utils/orderUtils';
import { useLockBodyScroll } from '@/shared/hooks/useLockBodyScroll';
import { useBranchMoney } from '@/modules/cash/hooks/useBranchMoney';
import { getPaymentLabel } from '@/shared/utils/orderUtils';
import './LocalExpenseModal.css';
import { Button } from "@/components/ui/button";

const EXPENSE_CATEGORIES = [
    { id: 'mercaderia', label: 'Mercadería', prefix: '[Mercadería] ' },
    { id: 'arriendo', label: 'Arriendo', prefix: '[Arriendo] ' },
    { id: 'sueldo', label: 'Sueldo', prefix: '[Sueldo] ' },
    { id: 'servicios', label: 'Servicios', prefix: '[Servicios] ' },
    { id: 'otro', label: 'Otro', prefix: '' },
];

const ORDER_STATUS_LABELS = {
    pending: 'Pendiente',
    active: 'En preparación',
    completed: 'Listo',
    picked_up: 'Entregado',
    cancelled: 'Cancelado',
};

function computeOrderNet(movements) {
    return (movements || []).reduce(
        (acc, m) => acc + (m.type === 'sale' ? Number(m.amount) || 0 : -(Number(m.amount) || 0)),
        0,
    );
}

const ORDER_REFUND_SELECT =
    'id, branch_id, total, status, payment_type, payment_method_specific, payment_breakdown, client_name';

async function findOrderByQuery({ companyId, branchId, query }) {
    const raw = String(query || '').trim().replace(/^#/, '');
    if (!raw || !companyId) return null;

    let base = supabase.from(TABLES.orders).select(ORDERS_ID_SCAN_SELECT).eq('company_id', companyId);
    if (branchId) base = base.eq('branch_id', branchId);

    let exactQuery = supabase
        .from(TABLES.orders)
        .select(ORDER_REFUND_SELECT)
        .eq('company_id', companyId)
        .eq('id', raw);
    if (branchId) exactQuery = exactQuery.eq('branch_id', branchId);

    const { data: exact, error: exactErr } = await exactQuery.maybeSingle();
    if (exactErr) throw exactErr;
    if (exact) return exact;

    const { data: rows, error } = await base.order('created_at', { ascending: false }).limit(2000);
    if (error) throw error;

    const num = raw.replace(/^0+/, '') || '0';
    const matchedId = (rows || []).find((o) => {
        const sid = String(o.id);
        return (
            sid === raw ||
            sid.replace(/^0+/, '') === num ||
            sid.slice(-4).replace(/^0+/, '') === num
        );
    })?.id;
    if (!matchedId) return null;

    const { data: full, error: fullErr } = await (branchId
        ? supabase
            .from(TABLES.orders)
            .select(ORDER_REFUND_SELECT)
            .eq('id', matchedId)
            .eq('company_id', companyId)
            .eq('branch_id', branchId)
        : supabase
            .from(TABLES.orders)
            .select(ORDER_REFUND_SELECT)
            .eq('id', matchedId)
            .eq('company_id', companyId)
    ).maybeSingle();
    if (fullErr) throw fullErr;
    return full;
}

/**
 * Modal dedicado para gastos operativos y devoluciones de pedido (Gastos del local).
 */
const LocalExpenseModal = ({
    isOpen,
    onClose,
    branchId,
    branchName,
    activeShift,
    onConfirmOperating,
    registerRefund,
    moveOrder,
    showNotify,
    companyId,
    onAfterSuccess,
}) => {
    const { formatMoney: fmt } = useBranchMoney();
    const [activeTab, setActiveTab] = useState('operating');
    const [categoryId, setCategoryId] = useState('mercaderia');
    const [amount, setAmount] = useState('');
    const [description, setDescription] = useState('');
    const [paymentMethod, setPaymentMethod] = useState('cash');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const [orderQuery, setOrderQuery] = useState('');
    const [searchLoading, setSearchLoading] = useState(false);
    const [foundOrder, setFoundOrder] = useState(null);
    const [orderMovements, setOrderMovements] = useState([]);
    const [refundError, setRefundError] = useState('');

    useLockBodyScroll(isOpen);

    useEffect(() => {
        if (!isOpen) return;
        setActiveTab('operating');
        setCategoryId('mercaderia');
        setAmount('');
        setDescription('');
        setPaymentMethod('cash');
        setError('');
        setSubmitting(false);
        setOrderQuery('');
        setSearchLoading(false);
        setFoundOrder(null);
        setOrderMovements([]);
        setRefundError('');
    }, [isOpen]);

    const selectedCategory = useMemo(
        () => EXPENSE_CATEGORIES.find((c) => c.id === categoryId) || EXPENSE_CATEGORIES[0],
        [categoryId],
    );

    const orderNet = useMemo(() => computeOrderNet(orderMovements), [orderMovements]);

    const loadOrderPreview = useCallback(async (order) => {
        if (!order?.id || !activeShift?.id) {
            setOrderMovements([]);
            return;
        }
        const { data, error: movErr } = await supabase
            .from(TABLES.cash_movements)
            .select('type, amount, payment_method')
            .eq('shift_id', activeShift.id)
            .eq('order_id', order.id);
        if (movErr) throw movErr;
        setOrderMovements(data || []);
    }, [activeShift?.id]);

    const handleSearchOrder = async (e) => {
        e?.preventDefault?.();
        if (searchLoading) return;
        setRefundError('');
        setFoundOrder(null);
        setOrderMovements([]);

        const q = orderQuery.trim();
        if (!q) {
            setRefundError('Ingresa el número de pedido');
            return;
        }
        if (!activeShift?.id) {
            setRefundError('No hay caja abierta en esta sucursal');
            return;
        }

        setSearchLoading(true);
        try {
            const order = await findOrderByQuery({ companyId, branchId, query: q });
            if (!order) {
                setRefundError('No se encontró el pedido en esta sucursal');
                return;
            }
            setFoundOrder(order);
            await loadOrderPreview(order);
        } catch {
            setRefundError('Error al buscar el pedido');
        } finally {
            setSearchLoading(false);
        }
    };

    const buildOperatingDescription = () => {
        const desc = description.trim();
        const prefix = selectedCategory.prefix;
        if (!prefix || desc.startsWith(prefix.trim())) return desc;
        return `${prefix}${desc}`;
    };

    const handleSubmitOperating = async (e) => {
        e.preventDefault();
        if (submitting) return;

        const numAmount = parseFloat(amount);
        if (Number.isNaN(numAmount) || numAmount <= 0) {
            setError('Ingresa un monto válido');
            return;
        }
        if (!description.trim()) {
            setError('La descripción es obligatoria');
            return;
        }

        setSubmitting(true);
        setError('');
        try {
            const ok = await onConfirmOperating(
                'expense',
                numAmount,
                buildOperatingDescription(),
                paymentMethod,
            );
            if (ok) {
                if (typeof onAfterSuccess === 'function') await onAfterSuccess();
                onClose();
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleSubmitRefund = async () => {
        if (submitting || !foundOrder) return;

        if (!branchId || foundOrder.branch_id !== branchId) {
            setRefundError('El pedido no pertenece a la sucursal seleccionada');
            return;
        }
        if (!activeShift?.id || activeShift.branch_id !== branchId) {
            setRefundError('No hay caja abierta en esta sucursal');
            return;
        }

        if (orderNet <= 5) {
            if (showNotify) {
                showNotify('Este pedido ya no tiene saldo neto en caja para devolver', 'info');
            }
            return;
        }

        setSubmitting(true);
        setRefundError('');
        try {
            const shouldCancel = foundOrder.status !== 'cancelled'
                && typeof moveOrder === 'function'
                && window.confirm(
                    `¿También cancelar el pedido #${String(foundOrder.id).slice(-4)}?\n\n`
                    + 'Al aceptar, la cancelación registrará la devolución automáticamente.',
                );

            if (shouldCancel) {
                const cancelled = await moveOrder(foundOrder.id, 'cancelled');
                if (!cancelled) {
                    setRefundError('No se pudo cancelar ni devolver el pedido');
                    return;
                }
                if (typeof onAfterSuccess === 'function') await onAfterSuccess();
                onClose();
                return;
            }

            const ok = await registerRefund(foundOrder, {
                expectedBranchId: branchId,
                targetShift: activeShift,
            });
            if (!ok) return;

            if (typeof onAfterSuccess === 'function') await onAfterSuccess();
            onClose();
        } finally {
            setSubmitting(false);
        }
    };

    if (!isOpen) return null;

    const methodLabel = paymentMethod === 'cash' ? 'Efectivo' : 'Tarjeta';
    const canRefund = foundOrder && orderNet > 5;

    return (
        <div
            className="admin-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Registrar movimiento del local"
            onClick={onClose}
        >
            <div className="local-expense-modal-panel" onClick={(ev) => ev.stopPropagation()}>
                <header className="local-expense-modal-header">
                    <div className="local-expense-modal-header-main">
                        <ArrowDownCircle size={24} className="local-expense-modal-icon" aria-hidden />
                        <div>
                            <h2 className="local-expense-modal-title">Registrar movimiento</h2>
                            <p className="local-expense-modal-subtitle">
                                {branchName ? `Sucursal: ${branchName}` : 'Gastos operativos o devolución de pedido'}
                            </p>
                        </div>
                    </div>
                    <Button variant="default" type="button" className="local-expense-modal-close" onClick={onClose} aria-label="Cerrar">
                        <X size={22} />
                    </Button>
                </header>

                <div className="local-expense-modal-tabs" role="tablist" aria-label="Tipo de movimiento">
                    <Button variant="default"
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'operating'}
                        className={`local-expense-modal-tab${activeTab === 'operating' ? ' active' : ''}`}
                        onClick={() => setActiveTab('operating')}
                    >
                        Gasto operativo
                    </Button>
                    <Button variant="default"
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'refund'}
                        className={`local-expense-modal-tab${activeTab === 'refund' ? ' active' : ''}`}
                        onClick={() => setActiveTab('refund')}
                    >
                        Devolución pedido
                    </Button>
                </div>

                <div className="local-expense-modal-body">
                    {activeTab === 'operating' ? (
                        <form onSubmit={handleSubmitOperating}>
                            <p className="local-expense-modal-hint">
                                Mercadería, arriendo, sueldo y otros gastos operativos del negocio.
                            </p>

                            <div className="local-expense-modal-field">
                                <span className="local-expense-modal-label">Categoría</span>
                                <div className="local-expense-modal-categories">
                                    {EXPENSE_CATEGORIES.map((cat) => (
                                        <Button variant="default"
                                            key={cat.id}
                                            type="button"
                                            className={`local-expense-modal-chip${categoryId === cat.id ? ' active' : ''}`}
                                            onClick={() => setCategoryId(cat.id)}
                                        >
                                            {cat.label}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <div className="local-expense-modal-field">
                                <label className="local-expense-modal-label" htmlFor="local-expense-amount">
                                    Monto
                                </label>
                                <div className="local-expense-modal-amount-wrap">
                                    <span className="local-expense-modal-amount-prefix">$</span>
                                    <input
                                        id="local-expense-amount"
                                        type="number"
                                        className="local-expense-modal-input local-expense-modal-input--amount"
                                        placeholder="0"
                                        autoFocus
                                        value={amount}
                                        onChange={(ev) => setAmount(ev.target.value)}
                                        required
                                    />
                                </div>
                            </div>

                            <div className="local-expense-modal-field">
                                <label className="local-expense-modal-label" htmlFor="local-expense-desc">
                                    Descripción
                                </label>
                                <textarea
                                    id="local-expense-desc"
                                    className="local-expense-modal-textarea"
                                    placeholder="Ej: Compra de artículos, pago arriendo..."
                                    value={description}
                                    onChange={(ev) => setDescription(ev.target.value)}
                                    required
                                />
                            </div>

                            <div className="local-expense-modal-field">
                                <span className="local-expense-modal-label">Método de pago</span>
                                <div className="local-expense-modal-methods">
                                    <Button variant="default"
                                        type="button"
                                        className={`local-expense-modal-method${paymentMethod === 'cash' ? ' active' : ''}`}
                                        onClick={() => setPaymentMethod('cash')}
                                    >
                                        <DollarSign size={16} aria-hidden /> Efectivo
                                    </Button>
                                    <Button variant="default"
                                        type="button"
                                        className={`local-expense-modal-method${paymentMethod === 'card' ? ' active' : ''}`}
                                        onClick={() => setPaymentMethod('card')}
                                    >
                                        <CreditCard size={16} aria-hidden /> Tarjeta
                                    </Button>
                                </div>
                                <p className="local-expense-modal-note">
                                    Solo los movimientos en <strong>Efectivo</strong> afectan el arqueo de caja física.
                                </p>
                            </div>

                            {amount && description.trim() ? (
                                <div className="local-expense-modal-summary">
                                    <p className="local-expense-modal-summary-title">Resumen</p>
                                    <div className="local-expense-modal-summary-row">
                                        <span>Monto</span>
                                        <strong>{fmt(parseFloat(amount) || 0)}</strong>
                                    </div>
                                    <div className="local-expense-modal-summary-row">
                                        <span>Categoría</span>
                                        <strong>{selectedCategory.label}</strong>
                                    </div>
                                    <div className="local-expense-modal-summary-row">
                                        <span>Método</span>
                                        <strong>{methodLabel}</strong>
                                    </div>
                                </div>
                            ) : null}

                            {error ? <p className="local-expense-modal-error">{error}</p> : null}

                            <div className="local-expense-modal-actions">
                                <Button variant="secondary" type="button" className="admin-btn secondary" onClick={onClose} disabled={submitting}>
                                    Cancelar
                                </Button>
                                <Button variant="default" type="submit" className="admin-btn" disabled={submitting}>
                                    {submitting ? <Loader2 size={16} className="rpt-expenses-spin" aria-hidden /> : <FileText size={16} aria-hidden />}
                                    Guardar gasto
                                </Button>
                            </div>
                        </form>
                    ) : (
                        <div>
                            <p className="local-expense-modal-hint">
                                Busca un pedido de esta sucursal y registra la devolución en el turno de caja abierto.
                            </p>

                            <form onSubmit={handleSearchOrder}>
                                <div className="local-expense-modal-field">
                                    <label className="local-expense-modal-label" htmlFor="local-expense-order-query">
                                        Número de pedido
                                    </label>
                                    <div className="local-expense-modal-search-row">
                                        <input
                                            id="local-expense-order-query"
                                            type="text"
                                            className="local-expense-modal-input"
                                            placeholder="Últimos 4 dígitos o ID completo"
                                            value={orderQuery}
                                            onChange={(ev) => setOrderQuery(ev.target.value)}
                                            autoFocus
                                        />
                                        <Button variant="secondary" type="submit" className="admin-btn secondary" disabled={searchLoading}>
                                            {searchLoading ? (
                                                <Loader2 size={16} className="rpt-expenses-spin" aria-hidden />
                                            ) : (
                                                <Search size={16} aria-hidden />
                                            )}
                                            Buscar
                                        </Button>
                                    </div>
                                </div>
                            </form>

                            {foundOrder ? (
                                <div className="local-expense-modal-preview">
                                    <h3 className="local-expense-modal-preview-title">
                                        Pedido #{String(foundOrder.id).slice(-4)}
                                    </h3>
                                    <div className="local-expense-modal-preview-grid">
                                        <div className="local-expense-modal-preview-item">
                                            <span className="local-expense-modal-preview-label">Cliente</span>
                                            <span className="local-expense-modal-preview-value">{foundOrder.client_name || '—'}</span>
                                        </div>
                                        <div className="local-expense-modal-preview-item">
                                            <span className="local-expense-modal-preview-label">Total pedido</span>
                                            <span className="local-expense-modal-preview-value">{fmt(foundOrder.total)}</span>
                                        </div>
                                        <div className="local-expense-modal-preview-item">
                                            <span className="local-expense-modal-preview-label">Estado</span>
                                            <span className="local-expense-modal-preview-value">
                                                {ORDER_STATUS_LABELS[foundOrder.status] || foundOrder.status || '—'}
                                            </span>
                                        </div>
                                        <div className="local-expense-modal-preview-item">
                                            <span className="local-expense-modal-preview-label">Pago</span>
                                            <span className="local-expense-modal-preview-value">{getPaymentLabel(foundOrder)}</span>
                                        </div>
                                        <div className="local-expense-modal-preview-item local-expense-modal-preview-item--full">
                                            <span className="local-expense-modal-preview-label">Neto en caja (turno actual)</span>
                                            <span className="local-expense-modal-preview-value local-expense-modal-preview-value--net">
                                                {fmt(Math.max(0, Math.round(orderNet)))}
                                            </span>
                                        </div>
                                    </div>

                                    {orderNet <= 5 ? (
                                        <div className="local-expense-modal-alert local-expense-modal-alert--warn">
                                            {orderMovements.some((m) => m.type === 'sale')
                                                ? 'Este pedido ya fue reembolsado o no tiene saldo neto en el turno actual.'
                                                : 'No hay venta registrada en caja para este pedido en el turno actual.'}
                                        </div>
                                    ) : (
                                        <div className="local-expense-modal-alert local-expense-modal-alert--info">
                                            Se registrará una devolución por {fmt(Math.round(orderNet))} en caja.
                                        </div>
                                    )}
                                </div>
                            ) : null}

                            {refundError ? <p className="local-expense-modal-error">{refundError}</p> : null}

                            <div className="local-expense-modal-actions">
                                <Button variant="secondary" type="button" className="admin-btn secondary" onClick={onClose} disabled={submitting}>
                                    Cancelar
                                </Button>
                                <Button variant="default"
                                    type="button"
                                    className="admin-btn"
                                    onClick={handleSubmitRefund}
                                    disabled={submitting || !canRefund}
                                >
                                    {submitting ? (
                                        <Loader2 size={16} className="rpt-expenses-spin" aria-hidden />
                                    ) : (
                                        <RotateCcw size={16} aria-hidden />
                                    )}
                                    Registrar devolución
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LocalExpenseModal;
