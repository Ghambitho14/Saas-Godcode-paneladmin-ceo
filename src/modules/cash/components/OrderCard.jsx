import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
    Clock, X, Upload, ImageIcon, Printer, Pencil, Copy, Send,
    ChefHat, Banknote, Eye, Loader2, Check,
    AlertTriangle, ShoppingBag, Utensils, Bike, Globe, MapPin,
    Star,
} from 'lucide-react';
import OrderDetailModal from './OrderDetailModal';
import CloseTableModal from './CloseTableModal';
import { supabase, TABLES } from '@/integrations/supabase';
import { useOrderMoney } from '@/modules/cash/hooks/useOrderMoney';
import { formatTimeElapsed, getElapsedMinutes, getTimerUrgencyClass } from '@/shared/utils/formatters';
import {
    buildOrderWhatsAppShareText,
    buildOrderDeliveryDriverPack,
    shareDeliveryPackViaWhatsApp,
    getOrderPaymentDisplayLabel,
    getOrderCouponDiscountMeta,
    getOrderTileKind,
    getOrderFulfillmentDisplayLabel,
    getOrderFulfillmentKind,
    isOrderDelivery,
    isOrderPaymentDeferred,
    isMenuOrder,
    orderDeliveryKanbanSubtitle,
    resolveItemKitchenNote,
    ORDERS_PANEL_SELECT,
    sanitizeOrder,
    getOrderItemLineTotal,
} from '@/shared/utils/orderUtils';
import { isOpenOrderSessionStatus } from '@/modules/cash/hooks/manual-order/manualOrderShared';
import { printOrderTicket } from '@/modules/cash/admin/utils/receiptPrinting';
import ManualOrderModal from './ManualOrderModal';
import OrderCardAnchoredMenu from './OrderCardAnchoredMenu';
import { useAdmin } from '@/modules/cash/admin/pages/AdminProvider';
import { Button } from "@/components/ui/button";
import { isStorageObjectReference } from '@/shared/utils/supabaseStorage';

const OrderCard = ({
    order, queueIndex, moveOrder, setReceiptModalOrder, branch, clients,
    logoUrl, companyName, showNotify, products, categories, onOrderSaved,
    localOrderChannels = null,
    gridTile = false,
}) => {
    const { cashSystem, markOrderSessionPaid, closeOrderSession, orders, hydrateOrderItems, companyProfile } = useAdmin();
    const orderMoney = useOrderMoney();
    const shareLocale = useMemo(() => ({
        branch,
        company: companyProfile,
        exchangeRate: orderMoney.exchangeRate,
    }), [branch, companyProfile, orderMoney.exchangeRate]);
    const formatMoney = orderMoney.formatMoney;
    const formatOrderTotal = useCallback(
        (orderRow) => orderMoney.formatOrderAmount({
            amountUsd: orderRow?.total,
            paymentMethod: orderRow?.payment_method_specific,
            order: orderRow,
        }),
        [orderMoney],
    );
    const formatLinePrice = useCallback(
        (item) => formatMoney(getOrderItemLineTotal(item)),
        [formatMoney],
    );
    const liveOrder = useMemo(
        () => (orders || []).find((o) => o.id === order.id) ?? order,
        [orders, order],
    );
	const evidenceState = liveOrder.payment_evidence_status;
	const hasReceiptFile = isStorageObjectReference(liveOrder.payment_ref, 'receipts');
	const supportsEvidence = liveOrder.payment_type === 'online'
		|| hasReceiptFile
		|| Boolean(evidenceState)
		|| liveOrder.payment_lines?.some((line) => line.evidencePolicy && line.evidencePolicy !== 'none');
    const [editWizardOpen, setEditWizardOpen] = useState(false);
    const [ticketMenuOpen, setTicketMenuOpen] = useState(false);
    const [detailOpen, setDetailOpen] = useState(false);
    const [paymentModalIntent, setPaymentModalIntent] = useState(null);
    const [showAllItems, setShowAllItems] = useState(false);
    const [itemsHydrating, setItemsHydrating] = useState(false);
    const [editPreparing, setEditPreparing] = useState(false);
    const [preparedItemIds, setPreparedItemIds] = useState(new Set());
    const [localItems, setLocalItems] = useState(null);
    const [itemsHydrated, setItemsHydrated] = useState(false);
    const ticketMenuRef = useRef(null);
    const prevUpdatedAtRef = useRef(undefined);
    const isDelivery = isOrderDelivery(order);
    const deliverySubtitle = isDelivery ? orderDeliveryKanbanSubtitle(order) : '';

    const ticketPrintOpts = (variant) => ({
        variant,
        branchAddress: branch?.address ?? null,
        companyName: companyName ?? null,
        branch,
        company: companyProfile,
        exchangeRate: orderMoney.exchangeRate,
    });

    const menuOpen = ticketMenuOpen;

    const handleMoveToKitchen = (e) => {
        e.stopPropagation();
        printOrderTicket(order, branch?.name, logoUrl ?? null, ticketPrintOpts('kitchen'));
        moveOrder(order.id, 'active');
    };

    const handleCancelOrder = (e) => {
        e?.stopPropagation?.();
        const refundNote = '\n\nSi el pedido tiene venta registrada en caja, se aplicará una devolución automática.';
        const ok = typeof window !== 'undefined'
            ? window.confirm(`¿Cancelar pedido #${String(order.id).slice(-4)}?${refundNote}`)
            : true;
        if (!ok) return;
        moveOrder(order.id, 'cancelled');
    };

    const printKitchenAgain = (e) => {
        e.stopPropagation();
        printOrderTicket(order, branch?.name, logoUrl ?? null, ticketPrintOpts('kitchen'));
        setTicketMenuOpen(false);
    };

    const printTicketCaja = (e) => {
        e.stopPropagation();
        printOrderTicket(order, branch?.name, logoUrl ?? null, ticketPrintOpts('cashier'));
        setTicketMenuOpen(false);
    };

    const handleCopyShare = async (e) => {
        e.stopPropagation();
        const text = buildOrderWhatsAppShareText(order, branch?.name, shareLocale);
        try {
            await navigator.clipboard.writeText(text);
            showNotify?.(
                isDelivery
                    ? 'Resumen copiado (productos, totales y datos de envío).'
                    : 'Resumen del pedido copiado.',
            );
        } catch {
            showNotify?.('No se pudo copiar. Copia manualmente el texto del pedido.', 'error');
        }
    };

    const handleDeliveryWhatsApp = async (e) => {
        e.stopPropagation();
        const text = buildOrderDeliveryDriverPack(order, branch?.name ?? null, branch?.address ?? null, shareLocale);
        await shareDeliveryPackViaWhatsApp(text, {
            onError: (msg) => showNotify?.(msg, 'error'),
        });
    };

    const clientData = useMemo(
        () => clients?.find((c) => c.id === order.client_id),
        [clients, order.client_id],
    );
    const isVip = clientData?.total_orders >= 5;
    const displayItems = localItems ?? liveOrder.items;
    const hasLoadedItems = Array.isArray(displayItems);
    const itemsCount = displayItems?.length ?? 0;
    const loadOrderItems = useCallback(async (orderId) => {
        if (!orderId) return;
        setItemsHydrating(true);
        try {
            if (hydrateOrderItems) {
                const result = await hydrateOrderItems(orderId);
                if (result?.items && result.items.length > 0) {
                    setLocalItems(result.items);
                    return;
                }
            }
            const { data, error } = await supabase
                .from(TABLES.orders)
                .select(ORDERS_PANEL_SELECT)
                .eq('id', orderId)
                .maybeSingle();
            if (error) throw error;
            if (data) {
                const hydrated = sanitizeOrder(data);
                if (Array.isArray(hydrated.items) && hydrated.items.length > 0) {
                    setLocalItems(hydrated.items);
                }
            }
        } catch (err) {
            console.error('Error loading order items:', err);
            showNotify?.('No se pudieron cargar los productos del pedido', 'error');
        } finally {
            setItemsHydrating(false);
        }
    }, [hydrateOrderItems, showNotify]);

    useEffect(() => {
        prevUpdatedAtRef.current = undefined;
        setLocalItems(null);
        setPreparedItemIds(new Set());
        setShowAllItems(false);
        setItemsHydrated(false);
    }, [order.id]);

    useEffect(() => {
        if (!liveOrder.id || itemsHydrated) return;
        setItemsHydrated(true);
        if (Array.isArray(liveOrder.items) && liveOrder.items.length > 0) {
            setLocalItems(liveOrder.items);
            return;
        }
        loadOrderItems(liveOrder.id);
    }, [liveOrder.id, liveOrder.items, itemsHydrated, loadOrderItems]);

    // Keep card items in sync when the order is edited (upsert/realtime updates total
    // via liveOrder but localItems would otherwise stay on the pre-edit hydrate).
    useEffect(() => {
        if (!liveOrder.id) return;
        if (prevUpdatedAtRef.current === undefined) {
            prevUpdatedAtRef.current = liveOrder.updated_at;
            return;
        }
        if (prevUpdatedAtRef.current === liveOrder.updated_at) return;
        prevUpdatedAtRef.current = liveOrder.updated_at;
        if (Array.isArray(liveOrder.items) && liveOrder.items.length > 0) {
            setLocalItems(liveOrder.items);
            return;
        }
        setLocalItems(null);
        setItemsHydrated(false);
    }, [liveOrder.id, liveOrder.updated_at, liveOrder.items]);

    useEffect(() => {
        if (liveOrder.status === 'completed' && Array.isArray(displayItems) && displayItems.length > 0) {
            setPreparedItemIds((prev) => {
                const allIndices = new Set(displayItems.map((_, idx) => idx));
                if (prev.size === allIndices.size) return prev;
                return allIndices;
            });
        }
    }, [liveOrder.status, displayItems]);

    const togglePrepared = useCallback((idx) => {
        setPreparedItemIds((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    }, []);



    const handleOpenEdit = useCallback(async (e) => {
        e.stopPropagation();
        setTicketMenuOpen(false);
        if (!hasLoadedItems && liveOrder.id) {
            setEditPreparing(true);
            try {
                await loadOrderItems(liveOrder.id);
            } catch (err) {
                console.error('Error hydrating order items for edit:', err);
                showNotify?.('No se pudieron cargar los productos del pedido', 'error');
                return;
            } finally {
                setEditPreparing(false);
            }
        }
        setEditWizardOpen(true);
    }, [hasLoadedItems, liveOrder.id, loadOrderItems, showNotify]);

    const discountMeta = useMemo(() => getOrderCouponDiscountMeta(order), [order]);
    const paymentDeferred = isOrderPaymentDeferred(liveOrder);
    const paymentMethodLabel = getOrderPaymentDisplayLabel(liveOrder);
    const fulfillmentKind = getOrderTileKind(liveOrder);
    const fulfillmentLabel = getOrderFulfillmentDisplayLabel(liveOrder);
    const TypeIcon = useMemo(() => {
        switch (fulfillmentKind) {
            case 'mesa': return Utensils;
            case 'retiro': return ShoppingBag;
            case 'moto': return isMenuOrder(liveOrder) ? Globe : Bike;
            default: return ShoppingBag;
        }
    }, [fulfillmentKind, liveOrder]);
    const deliveryZone = useMemo(() => {
        if (fulfillmentKind !== 'moto') return '';
        const addr = liveOrder.delivery_address;
        if (addr && typeof addr === 'object') {
            return addr.named_area_label || addr.formatted_address || addr.address || '';
        }
        return deliverySubtitle;
    }, [fulfillmentKind, liveOrder.delivery_address, deliverySubtitle]);
    const canMarkPaid =
        Boolean(markOrderSessionPaid) &&
        paymentDeferred &&
        isOpenOrderSessionStatus(liveOrder.status);

    const openMarkPaidModal = (eOrOrder) => {
        if (eOrOrder?.stopPropagation) eOrOrder.stopPropagation();
        setTicketMenuOpen(false);
        setPaymentModalIntent('pay');
    };

    const handleDeliverClick = (e) => {
        e.stopPropagation();
        if (paymentDeferred && closeOrderSession) {
            setPaymentModalIntent('close');
            return;
        }
        moveOrder(order.id, 'picked_up');
    };

    const handlePaymentModalConfirm = async (targetOrder, paymentPatch) => {
        if (paymentModalIntent === 'pay') {
            const result = await markOrderSessionPaid(targetOrder, paymentPatch);
            if (result) setPaymentModalIntent(null);
            return Boolean(result);
        }
        if (paymentModalIntent === 'close') {
            const ok = await closeOrderSession(targetOrder, paymentPatch);
            if (ok) setPaymentModalIntent(null);
            return ok;
        }
        return false;
    };

    const openDetailModal = (e) => {
        e.stopPropagation();
        setDetailOpen(true);
        setTicketMenuOpen(false);
    };

    const paymentMeta = paymentDeferred ? (
        <span className="order-card-unpaid-badge" title="Pago pendiente de cobro en caja">
            <AlertTriangle size={10} aria-hidden />
            Sin pagar
        </span>
    ) : paymentMethodLabel && paymentMethodLabel !== 'Pago pendiente' ? (
        <span className="order-payment-method">{paymentMethodLabel}</span>
    ) : null;

    const timerMinutes = getElapsedMinutes(order.created_at);
    const timerColorClass = getTimerUrgencyClass(order.created_at);

    const orderTimeEl = (
        <span
            className={`order-time${timerColorClass ? ` ${timerColorClass}` : ''}`}
            title={new Date(order.created_at).toLocaleString()}
            data-timer-minutes={timerMinutes ?? ''}
            data-timer-class={timerColorClass || 'neutral'}
        >
            {!gridTile && queueIndex != null ? (
                <span className="order-queue-badge" title={`Pedido ${queueIndex} en la cola (más antiguo primero)`}>
                    {queueIndex}
                </span>
            ) : null}
            <Clock size={12} />
            <span className="order-time__text">{formatTimeElapsed(order.created_at)}</span>
        </span>
    );

    const headerTools = (
        <>
            <Button variant="default"
                type="button"
                onClick={handleCopyShare}
                className="admin-icon-btn--sm order-card-tool-btn"
                title="Copiar resumen del pedido"
            >
                <Copy size={16} aria-hidden />
            </Button>
            {isDelivery ? (
                <Button variant="default"
                    type="button"
                    onClick={handleDeliveryWhatsApp}
                    className="admin-icon-btn--sm order-card-tool-btn"
                    title="WhatsApp envío"
                    aria-label="Enviar datos de delivery por WhatsApp"
                >
                    <Send size={16} aria-hidden />
                </Button>
            ) : null}
            <div className="order-ticket-menu" ref={ticketMenuRef}>
                <Button variant="default"
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        setTicketMenuOpen((v) => !v);
                    }}
                    className={`admin-icon-btn admin-icon-btn--sm order-card-tool-btn${ticketMenuOpen ? ' is-active' : ''}`}
                    title="Imprimir tickets"
                    aria-expanded={ticketMenuOpen}
                    aria-haspopup="menu"
                    aria-label="Menú imprimir tickets"
                >
                    <Printer size={16} aria-hidden />
                </Button>
                {ticketMenuOpen ? (
                    <OrderCardAnchoredMenu
                        anchorRef={ticketMenuRef}
                        isOpen={ticketMenuOpen}
                        onClose={() => setTicketMenuOpen(false)}
                        menuWidth={200}
                        menuHeight={120}
                    >
                        <Button variant="default" type="button" className="order-ticket-menu-item" role="menuitem" onClick={printKitchenAgain}>
                            <ChefHat size={16} aria-hidden />
                            Ticket cocina
                        </Button>
                        <Button variant="default" type="button" className="order-ticket-menu-item" role="menuitem" onClick={printTicketCaja}>
                            <Banknote size={16} aria-hidden />
                            Ticket caja
                        </Button>
                    </OrderCardAnchoredMenu>
                ) : null}
            </div>
            {gridTile ? (
                <Button variant="default"
                    type="button"
                    onClick={openDetailModal}
                    className="admin-icon-btn--sm order-card-tool-btn"
                    title="Ver detalle del pedido"
                    aria-label="Ver detalle del pedido"
                >
                    <Eye size={16} aria-hidden />
                </Button>
            ) : null}
        </>
    );

    return (
        <div className={`kanban-card glass animate-slide-up${menuOpen ? ' kanban-card--menu-open' : ''}${gridTile ? ' kanban-card--grid-tile kanban-card--receipt-clean' : ''} ${order.status === 'pending' ? 'urgent-pulse' : ''}`}>
            <div className="kanban-card-top">
                {gridTile ? (
                    <>
                        <div className="kanban-card-receipt-head">
                            <div className="kanban-card-receipt-head__main">
                                <div className="kanban-card-receipt-title-row">
                                    {queueIndex != null ? (
                                        <span
                                            className="kanban-card-receipt-code"
                                            title={`Pedido ${queueIndex} en la cola (más antiguo primero)`}
                                        >
                                            {queueIndex}
                                        </span>
                                    ) : null}
                                    <TypeIcon size={18} className="order-type-icon" aria-label={fulfillmentLabel} />
									<h4 className="card-client-name">{order.display_name || order.client_name}</h4>
                                    {isVip ? (
                                        <span className="order-vip-icon" title={`Cliente habitual · ${clientData.total_orders} pedidos`}>
                                            <Star size={14} aria-hidden />
                                        </span>
                                    ) : null}
                                    <span className="order-short-id" title={`Pedido #${String(order.id).slice(-4)}`}>
                                        #{String(order.id).slice(-4)}
                                    </span>
                                </div>
                                {deliveryZone ? (
                                    <div className="order-delivery-zone" title={deliverySubtitle || deliveryZone}>
                                        <MapPin size={11} aria-hidden />
                                        {deliveryZone}
                                    </div>
                                ) : null}
                                <div className="kanban-card-receipt-meta">
                                    {orderTimeEl}
                                    {paymentMeta}
                                    <div className="order-card-header-tools order-card-header-tools--receipt-meta">{headerTools}</div>
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        {deliverySubtitle ? (
                            <div className="order-delivery-mini" title={deliverySubtitle}>
                                {deliverySubtitle}
                            </div>
                        ) : null}

                        <div className="card-client">
                            <div className="card-client-name-row">
                                <TypeIcon size={18} className="order-type-icon order-type-icon--normal" aria-label={fulfillmentLabel} />
								<h4 className="card-client-name">{order.display_name || order.client_name}</h4>
                                {isVip ? (
                                    <span className="order-vip-icon" title={`Cliente habitual · ${clientData.total_orders} pedidos`}>
                                        <Star size={14} aria-hidden />
                                    </span>
                                ) : null}
                                <span className="order-short-id" title={`Pedido #${String(order.id).slice(-4)}`}>
                                    #{String(order.id).slice(-4)}
                                </span>
                            </div>
                            <div className="card-kanban-meta-row">
                                {orderTimeEl}
                                {paymentMeta}
                                <button
                                    type="button"
                                    className="order-detail-link"
                                    onClick={openDetailModal}
                                    title="Ver todo el detalle del pedido"
                                >
                                    Ver detalle
                                </button>
                                <div className="order-card-header-tools">{headerTools}</div>
                            </div>
                        </div>

                        <hr className="kanban-card-divider" />
                    </>
                )}
            </div>

            <div className="kanban-card-scroll">
                {gridTile ? (
                    <div className="card-items card-items--grid-tile">
                        {itemsHydrating ? (
                            <div className="card-items-hydrating">
                                <Loader2 size={16} className="animate-spin" aria-hidden />
                                <span>Cargando productos…</span>
                            </div>
                        ) : !hasLoadedItems || itemsCount === 0 ? (
                            <p className="card-items-empty">Sin productos</p>
                        ) : (
                            <>
                                {displayItems.slice(0, 3).map((item, idx) => {
                                    const itemNote = resolveItemKitchenNote(item, liveOrder.note) ?? '';
                                    const hasExtras = Array.isArray(item.extras) && item.extras.length > 0;
                                    return (
                                        <div key={idx} className="order-item-row order-item-row--grid-tile">
                                            <span className="qty-circle">{item.quantity}</span>
                                            <span className="item-name" title={item.name}>{item.name}</span>
                                            <span className="order-item-price order-item-price--grid">{formatLinePrice(item)}</span>
                                            {(hasExtras || itemNote) ? (
                                                <span className="order-item-detail-dot" title={itemNote || 'Con modificadores'}>!</span>
                                            ) : null}
                                        </div>
                                    );
                                })}
                                {itemsCount > 3 ? (
                                    <button
                                        type="button"
                                        className="order-items-expand-link"
                                        onClick={() => setDetailOpen(true)}
                                    >
                                        +{itemsCount - 3} más
                                    </button>
                                ) : null}
                            </>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="card-items card-items--always-visible">
                            {itemsHydrating ? (
                                <div className="card-items-hydrating">
                                    <Loader2 size={16} className="animate-spin" aria-hidden />
                                    <span>Cargando productos…</span>
                                </div>
                            ) : !hasLoadedItems || itemsCount === 0 ? (
                                <p className="card-items-empty">Sin productos</p>
                            ) : (
                                <>
                                    {(showAllItems ? displayItems : displayItems.slice(0, 6)).map((item, idx) => {
                                        const itemNote = resolveItemKitchenNote(item, liveOrder.note) ?? '';
                                        const isPrepared = preparedItemIds.has(idx);
                                        const extrasText = Array.isArray(item.extras) && item.extras.length > 0
                                            ? item.extras.map((extra) => `${extra.quantity || 1}x ${extra.name}`).join(', ')
                                            : '';
                                        return (
                                            <div key={idx} className={`order-item-row${isPrepared ? ' order-item-row--prepared' : ''}`}>
                                                <label className="order-item-checkbox-label" title={isPrepared ? 'Marcar como pendiente' : 'Marcar como preparado'}>
                                                    <input
                                                        type="checkbox"
                                                        className="order-item-checkbox"
                                                        checked={isPrepared}
                                                        onChange={() => togglePrepared(idx)}
                                                    />
                                                    <span className={`order-item-checkbox-visual${isPrepared ? ' order-item-checkbox-visual--checked' : ''}`}>
                                                        {isPrepared ? <Check size={11} strokeWidth={3} aria-hidden /> : null}
                                                    </span>
                                                </label>
                                                <div className="order-item-content">
                                                    <div className="order-item-main">
                                                        <span className="order-item-qty">{item.quantity ?? 1}x</span>
                                                        <span className="order-item-name">{item.name ?? 'Producto'}</span>
                                                        <span className="order-item-price">{formatLinePrice(item)}</span>
                                                    </div>
                                                    {(extrasText || itemNote) ? (
                                                        <div className="order-item-meta">
                                                            {extrasText ? <span>{extrasText}</span> : null}
                                                            {itemNote ? <span>{itemNote}</span> : null}
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {itemsCount > 6 && !showAllItems ? (
                                        <button
                                            type="button"
                                            className="order-items-expand-link"
                                            onClick={() => setShowAllItems(true)}
                                        >
                                            +{itemsCount - 6} más
                                        </button>
                                    ) : null}
                                </>
                            )}
                        </div>

						{supportsEvidence ? (
                            <div className="receipt-container receipt-container--kanban">
								<Button variant="default" type="button" onClick={() => setReceiptModalOrder?.(liveOrder)} className="receipt-link receipt-link--optional">
									{evidenceState === 'failed' ? <AlertTriangle size={14} aria-hidden /> : hasReceiptFile ? <ImageIcon size={14} aria-hidden /> : <Upload size={14} aria-hidden />}
									{evidenceState === 'failed' ? 'Comprobante fallido · reintentar' : evidenceState === 'uploading' ? 'Subiendo comprobante…' : evidenceState === 'pending' ? 'Comprobante pendiente' : hasReceiptFile ? 'Ver/cambiar comprobante' : 'Adjuntar comprobante'}
								</Button>
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            <div className={`kanban-card-foot${gridTile ? ' kanban-card-receipt-foot' : ''}`}>
                <div className={`card-total${gridTile ? ' kanban-card-receipt-total kanban-card-receipt-total--final' : ''}`}>
                    <span className="total-label">{gridTile ? 'Total' : 'TOTAL'}</span>
                    <div className="card-total-amounts">
                        <span className="total-amount">{formatOrderTotal(liveOrder)}</span>
                        {discountMeta ? (
                            <span
                                className="card-total-before"
                                aria-label={`Precio antes del descuento: ${formatMoney(discountMeta.originalTotal)}, ${discountMeta.discountPercent}% de descuento`}
                            >
                                <span className="card-total-before-price">
                                    {formatMoney(discountMeta.originalTotal)}
                                </span>
                                <span className="card-total-before-pct">-{discountMeta.discountPercent}%</span>
                            </span>
                        ) : null}
                    </div>
                </div>

                <div className="card-actions">
                    {order.status === 'pending' ? (
                        <>
                            <Button variant="default" type="button" onClick={handleCancelOrder} className="btn-icon-action cancel" title="Cancelar Pedido">
                                <X size={16} />
                            </Button>
                            <Button variant="default" type="button" onClick={handleMoveToKitchen} className="btn-action primary">
                                A Cocina
                            </Button>
                        </>
                    ) : null}
                    {order.status === 'active' ? (
                        <>
                            <Button variant="default" type="button" onClick={handleCancelOrder} className="btn-icon-action cancel" title="Cancelar Pedido">
                                <X size={16} />
                            </Button>
                            <Button variant="default" type="button" onClick={() => moveOrder(order.id, 'completed')} className="btn-action success">
                                Pedido Listo
                            </Button>
                        </>
                    ) : null}
                    {order.status === 'completed' ? (
                        <>
                            <Button variant="default" type="button" onClick={handleCancelOrder} className="btn-icon-action cancel" title="Cancelar Pedido">
                                <X size={16} />
                            </Button>
                            <Button variant="default"
                                type="button"
                                onClick={handleDeliverClick}
                                className="btn-action btn-action--deliver"
                            >
                                {paymentDeferred ? 'Cobrar y entregar' : 'Entregado al Cliente'}
                            </Button>
                        </>
                    ) : null}
                    {canMarkPaid ? (
                        <Button
                            variant="default"
                            type="button"
                            onClick={openMarkPaidModal}
                            className="btn-action btn-action--pay-now"
                            title="Registrar el pago sin cerrar el pedido"
                        >
                            <Banknote size={16} aria-hidden />
                            Cobrar
                        </Button>
                    ) : null}
                    <Button variant="default"
                        type="button"
                        onClick={handleOpenEdit}
                        className="btn-icon-action"
                        title="Editar pedido"
                        aria-label="Editar pedido"
                        disabled={editPreparing}
                    >
                        {editPreparing ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Pencil size={16} />}
                    </Button>
                </div>
            </div>

            {detailOpen ? (
                <OrderDetailModal
                    order={liveOrder}
                    onClose={() => setDetailOpen(false)}
                    branch={branch}
                    logoUrl={logoUrl ?? null}
                    companyName={companyName}
                    showNotify={showNotify}
                    setReceiptModalOrder={setReceiptModalOrder}
                    onMarkPaid={canMarkPaid ? openMarkPaidModal : null}
                />
            ) : null}

            {paymentModalIntent ? (
                <CloseTableModal
                    isOpen
                    intent={paymentModalIntent}
                    onClose={() => setPaymentModalIntent(null)}
                    order={liveOrder}
                    branch={branch}
                    showNotify={showNotify}
                    onConfirm={handlePaymentModalConfirm}
                />
            ) : null}

            {editWizardOpen ? (
                <ManualOrderModal
                    isOpen={editWizardOpen}
                    editOrder={liveOrder}
                    moveOrder={moveOrder}
                    onClose={() => setEditWizardOpen(false)}
                    products={products}
                    categories={categories}
                    clients={clients}
                    branch={branch}
                    logoUrl={logoUrl ?? null}
                    companyName={companyName}
                    showNotify={showNotify}
                    onOrderSaved={(saved) => {
                        if (Array.isArray(saved?.items)) {
                            setLocalItems(saved.items);
                            if (saved.updated_at) prevUpdatedAtRef.current = saved.updated_at;
                        } else {
                            setLocalItems(null);
                            setItemsHydrated(false);
                        }
                        onOrderSaved?.(saved);
                        setEditWizardOpen(false);
                    }}
                    resyncOrderSale={cashSystem?.resyncOrderSale ?? null}
                    localOrderChannels={localOrderChannels}
                />
            ) : null}
        </div>
    );
};

export default React.memo(OrderCard);
