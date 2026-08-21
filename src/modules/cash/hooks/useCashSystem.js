import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase, TABLES } from '@/integrations/supabase';
import { subscribeMonitored, markMonitoredChannelClosing } from '@/shared/subscribeMonitored';
import { isValidBranchId } from '@/shared/utils/safeIds';
import { cashService } from '../services/cashService';
import {
	CASH_SHIFT_ACTIVE_SELECT,
	CASH_SHIFT_META_SELECT,
	CASH_SHIFT_PAST_SELECT,
	isCompleteCashMovementRow,
} from '../services/cashSelects';
import {
	EXPENSE_KIND_CASH_WITHDRAWAL,
} from '../utils/cashMovementKinds';
import { computeShiftTotals } from '../utils/cashTotals';
import { getExpectedByMethod } from '../utils/shiftCloseReconciliation';
import { planSaleMovements, planRefundMovements, planSaleResyncMovements } from '../utils/orderPaymentMovements';
import { countOpenOrderSessions, isOrderPaymentDeferred, isOrderPaymentSettled } from '@/shared/utils/orderUtils';

export const useCashSystem = (showNotify, branchId, orders = [], options = {}) => {
    const { enabled = true } = options;
    const branchIdRef = useRef(branchId);
    branchIdRef.current = branchId;
    const [activeShift, setActiveShift] = useState(null);
    const [loading, setLoading] = useState(true);
    const [movements, setMovements] = useState([]);
    const [loadingMovements, setLoadingMovements] = useState(false);
    /** IDs de movimientos insertados localmente; el realtime los ignora para evitar refetch duplicado. */
    const pendingLocalMovementIdsRef = useRef(new Set());
    const movementsRefreshTimerRef = useRef(null);

    const markLocalMovements = useCallback((rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list) {
            if (row?.id != null) pendingLocalMovementIdsRef.current.add(String(row.id));
        }
    }, []);

    const consumeLocalRealtimeInsert = useCallback((id) => {
        if (id == null) return false;
        const key = String(id);
        if (!pendingLocalMovementIdsRef.current.has(key)) return false;
        pendingLocalMovementIdsRef.current.delete(key);
        return true;
    }, []);

    const prependMovement = useCallback((row) => {
        if (!row?.id) return;
        setMovements((prev) => {
            if (prev.some((m) => m.id === row.id)) return prev;
            return [row, ...prev];
        });
    }, []);

    /**
     * Actualiza solo metadatos del turno abierto (p. ej. expected_balance) sin recargar movimientos.
     */
    const refreshShiftMeta = useCallback(async (shiftId) => {
        const sid = shiftId ?? activeShift?.id;
        if (!sid) return null;
        try {
            const { data, error } = await supabase
                .from(TABLES.cash_shifts)
                .select(CASH_SHIFT_META_SELECT)
                .eq('id', sid)
                .eq('status', 'open')
                .maybeSingle();
            if (error) throw error;
            if (data) {
                setActiveShift((prev) => {
                    if (!prev || prev.id !== data.id) return data;
                    if (Number(prev.expected_balance) === Number(data.expected_balance)) {
                        return prev;
                    }
                    return { ...prev, ...data };
                });
            }
            return data;
        } catch {
            return null;
        }
    }, [activeShift?.id]);

    /**
     * Carga los movimientos de un turno específico
     */
    const loadMovements = useCallback(async (shiftId) => {
        if (!enabled) return;
        setLoadingMovements(true);
        const requestedBranchId = branchIdRef.current;
        try {
            const data = await cashService.getShiftMovements(shiftId);
            if (branchIdRef.current !== requestedBranchId) return;
            setMovements(data || []);
        } catch {
            if (branchIdRef.current !== requestedBranchId) return;
            setMovements([]);
        } finally {
            if (branchIdRef.current === requestedBranchId) {
                setLoadingMovements(false);
            }
        }
    }, [enabled]);

    const debouncedLoadMovements = useCallback((shiftId) => {
        if (!shiftId) return;
        if (movementsRefreshTimerRef.current) clearTimeout(movementsRefreshTimerRef.current);
        movementsRefreshTimerRef.current = setTimeout(() => {
            movementsRefreshTimerRef.current = null;
            void loadMovements(shiftId);
        }, 400);
    }, [loadMovements]);

    const applyLocalMovementInserts = useCallback(async (shiftId, rows) => {
        const created = (Array.isArray(rows) ? rows : [rows]).filter((r) => r?.id);
        if (created.length === 0) {
            await refreshShiftMeta(shiftId);
            return;
        }
        markLocalMovements(created);
        await refreshShiftMeta(shiftId);
        for (const row of created) prependMovement(row);
    }, [markLocalMovements, prependMovement, refreshShiftMeta]);

    /**
     * Carga el turno activo para la sucursal seleccionada
     */
    const loadActiveShift = useCallback(async () => {
        if (!enabled) {
            setActiveShift(null);
            setMovements([]);
            setLoading(false);
            return;
        }
        if (!branchId || branchId === 'all' || !isValidBranchId(branchId)) {
            // [ROBUSTEZ] No llamar API con slug (ej. "san-joaquin") → evita 400 y caja que no carga
            setActiveShift(null);
            setMovements([]);
            setLoading(false);
            return;
        }

        const requestedBranchId = branchId;
        setLoading(true);
        try {
            const { data: shift, error } = await supabase
                .from(TABLES.cash_shifts)
                .select(CASH_SHIFT_ACTIVE_SELECT)
                .eq('status', 'open')
                .eq('branch_id', branchId) // FILTRO CRÍTICO POR SUCURSAL
                .maybeSingle();

            if (error) throw error;
            if (branchIdRef.current !== requestedBranchId) return;

            // [FIX] Actualizar si cambia el ID o el balance esperado (para reflejar ingresos/egresos)
            setActiveShift(prev => {
                if (!prev || !shift) return shift;
                // Usamos Number() para asegurar comparación por valor numérico y no por referencia o tipo (string vs number)
                if (prev.id === shift.id && Number(prev.expected_balance) === Number(shift.expected_balance)) return prev;
                return shift;
            });
            
            if (shift) {
                loadMovements(shift.id);
            } else {
                setMovements([]);
            }
        } catch {
            if (branchIdRef.current !== requestedBranchId) return;
            if (showNotify) showNotify('Error al cargar datos de caja', 'error');
        } finally {
            if (branchIdRef.current === requestedBranchId) {
                setLoading(false);
            }
        }
    }, [showNotify, loadMovements, branchId, enabled]);

    useEffect(() => {
        if (!enabled) {
            setActiveShift(null);
            setMovements([]);
            setLoading(false);
            return;
        }
        loadActiveShift();
    }, [loadActiveShift, enabled]);

    /**
     * Listener Realtime para actualizar movimientos cuando se agreguen nuevos.
     * Depende solo de shiftId para no re-suscribirse cada vez que cambia expected_balance.
     */
    const activeShiftId = activeShift?.id ?? null;

    useEffect(() => {
        if (!enabled || !activeShiftId) return;

        const shiftId = activeShiftId;

        // Subscribe a cambios en cash_movements para este shift
        const channel = subscribeMonitored(
            supabase
                .channel(`cash_movements:shift_id=eq.${shiftId}`)
                .on(
                    'postgres_changes',
                    {
                        event: '*', // Escuchar INSERT, UPDATE, DELETE
                        schema: 'public',
                        table: TABLES.cash_movements,
                        filter: `shift_id=eq.${shiftId}`
                    },
                    (payload) => {
                    if (payload.eventType === 'INSERT') {
                        const newRow = payload.new;
                        if (newRow && consumeLocalRealtimeInsert(newRow.id)) return;
                        // Sin payment_method el balance esperado (efectivo) quedaría mal:
                        // recargar el listado completo en lugar de prepend parcial.
                        if (newRow && isCompleteCashMovementRow(newRow) && newRow.payment_method) {
                            prependMovement(newRow);
                            void refreshShiftMeta(shiftId);
                            return;
                        }
                        debouncedLoadMovements(shiftId);
                        void refreshShiftMeta(shiftId);
                    } else if (payload.eventType === 'DELETE') {
                        const deletedId = payload.old?.id;
                        if (deletedId != null) {
                            setMovements((prev) => prev.filter((m) => m.id !== deletedId));
                            void refreshShiftMeta(shiftId);
                            return;
                        }
                        debouncedLoadMovements(shiftId);
                    } else if (payload.eventType === 'UPDATE') {
                        const updated = payload.new;
                        if (updated?.id) {
                            setMovements((prev) =>
                                prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m))
                            );
                            void refreshShiftMeta(shiftId);
                            return;
                        }
                        debouncedLoadMovements(shiftId);
                    }
                }
            ),
            { name: 'cash_movements', context: { shiftId } },
        );

        return () => {
            if (movementsRefreshTimerRef.current) {
                clearTimeout(movementsRefreshTimerRef.current);
                movementsRefreshTimerRef.current = null;
            }
            markMonitoredChannelClosing(channel);
            channel.unsubscribe();
        };
    }, [enabled, activeShiftId, consumeLocalRealtimeInsert, debouncedLoadMovements, refreshShiftMeta, prependMovement]);

    /**
     * Abre un nuevo turno
     */
    const openShift = useCallback(async (amount) => {
        if (!branchId || branchId === 'all' || !isValidBranchId(branchId)) {
            if (showNotify) showNotify('Error: No se ha detectado la sucursal seleccionada.', 'error');
            return false;
        }
        try {
            const { data: newShift, error } = await supabase.rpc('cash_open_shift', {
                p_branch_id: branchId,
                p_opening_balance: Number(amount) || 0
            });

            if (error) throw error;

            setActiveShift(newShift);
            setMovements([]);
            if (showNotify) showNotify('Caja abierta con éxito');
            return true;
        } catch (error) {
            if (showNotify) {
                let msg = 'Error al abrir caja';
                if (error.message?.includes('Ya existe')) {
                    msg = error.message;
                } else if (error.code === '42501') {
                    msg = 'Error de permisos (RLS). Configura las políticas en Supabase.';
                }
                showNotify(msg, 'error');
            }
            return false;
        }
    }, [branchId, showNotify]);

    const getTotals = useCallback((movementsData = movements) => {
        return computeShiftTotals(movementsData);
    }, [movements]);

    /**
     * Cierra el turno actual con cuadre por método.
     * @param {{ cash: number; card: number; online: number }} payload
     */
    const closeShift = useCallback(async (payload) => {
        if (!activeShift) return false;
        const openCount = countOpenOrderSessions(orders, activeShift.branch_id);
        if (openCount > 0) {
            if (showNotify) {
                showNotify(
                    `No puedes cerrar caja: hay ${openCount} mesa(s) o moto(s) abiertas. Ciérralas antes.`,
                    'error',
                );
            }
            return false;
        }
		try {
			const pendingEvidence = await cashService.getPendingEvidenceCount(activeShift.id);
			if (pendingEvidence > 0 && showNotify) {
				showNotify(
					`Aviso: hay ${pendingEvidence} comprobante(s) pendiente(s). La caja se cerrará igualmente.`,
					'warning',
				);
			}
			const totals = getTotals(movements);
            const expected = getExpectedByMethod(totals, activeShift);
            await cashService.closeShift(activeShift.id, {
                cash: Number(payload.cash),
                card: Number(payload.card),
                online: Number(payload.online),
                expectedCard: expected.card,
                expectedOnline: expected.online,
            });

            setActiveShift(null);
            setMovements([]);
            if (showNotify) showNotify('Caja cerrada correctamente');
            return true;
        } catch (err) {
            if (showNotify) {
                showNotify(err?.message || 'Error al cerrar caja', 'error');
            }
            return false;
        }
    }, [activeShift, movements, getTotals, showNotify, orders]);

    /**
     * [MEJORA MULTI-NEGOCIO]
     * Obtiene el turno objetivo para una transacción.
     * Si estamos en vista "Todas", busca el turno abierto de la sucursal del pedido.
     */
    const getTargetShift = useCallback(async (orderBranchId) => {
        // 1. Escenario ideal: El turno activo en pantalla coincide con la orden
        if (activeShift && activeShift.branch_id === orderBranchId) {
            return activeShift;
        }

        // 2. Escenario Admin Global: Buscar turno abierto específico para esa sucursal
        if (orderBranchId) {
            const { data, error } = await supabase
                .from(TABLES.cash_shifts)
                .select('id, expected_balance, branch_id')
                .eq('status', 'open')
                .eq('branch_id', orderBranchId)
                .maybeSingle();
            if (error) throw error;
            return data;
        }
        return null;
    }, [activeShift]);

    /**
     * Agrega un movimiento manual (Ingreso/Egreso)
     */
    const addManualMovement = useCallback(async (type, amount, description, paymentMethod = 'cash', opts = {}) => {
        if (!activeShift) return false;
        try {
            const numericAmount = Number(amount);
            if (isNaN(numericAmount) || numericAmount <= 0) throw new Error("El monto debe ser un número mayor a 0");

            // Validación estricta para egresos
            if (type === 'expense' && (!description || description.trim().length < 3)) {
                throw new Error("Es obligatorio indicar el motivo del egreso (mínimo 3 letras).");
            }

            const expenseKind =
                type === 'expense' && opts?.expenseKind != null && String(opts.expenseKind).trim() !== ''
                    ? String(opts.expenseKind).trim()
                    : null;

            if (expenseKind === EXPENSE_KIND_CASH_WITHDRAWAL && paymentMethod !== 'cash') {
                throw new Error('Los retiros de efectivo solo pueden registrarse en efectivo.');
            }

            const rpcPayload = {
                p_shift_id: activeShift.id,
                p_type: type,
                p_amount: numericAmount,
                p_description: description,
                p_payment_method: paymentMethod,
                p_order_id: null,
            };
            if (expenseKind) {
                rpcPayload.p_expense_kind = expenseKind;
            }

            const { data, error } = await supabase.rpc('cash_add_movement', rpcPayload);
            if (error) throw error;

            await applyLocalMovementInserts(activeShift.id, data);
            if (showNotify) {
                const custom = opts && typeof opts.successMessage === 'string' && opts.successMessage.trim() !== '';
                showNotify(
                    custom
                        ? opts.successMessage.trim()
                        : type === 'income'
                          ? 'Ingreso registrado'
                          : 'Egreso registrado'
                );
            }
            return true;
        } catch (error) {
            if (showNotify) {
                if (error.code === '42501') {
                    showNotify('Error de permisos (RLS) al registrar movimiento.', 'error');
                } else {
                    showNotify(error.message || 'Error al registrar movimiento', 'error');
                }
            }
            return false;
        }
    }, [activeShift, showNotify, applyLocalMovementInserts]);

    /**
     * Registra una venta automáticamente
     */
    const registerSale = useCallback(async (order) => {
        if (!isOrderPaymentSettled(order)) {
            if (showNotify) showNotify('Selecciona y confirma el método de pago antes de registrar la venta', 'warning');
            return false;
        }
        const targetShift = await getTargetShift(order.branch_id);
        if (!targetShift) {
            if (showNotify) showNotify('No hay caja abierta para esta sucursal', 'error');
            return false;
        }

        try {
            const { data: movements } = await supabase
                .from(TABLES.cash_movements)
				.select('type, amount, amount_minor, currency, payment_method')
                .eq('shift_id', targetShift.id)
                .eq('order_id', order.id);

            const saleAmount = Math.round(Number(order.total) || 0);
            if (saleAmount <= 0) return false;

            const planned = planSaleMovements(order, movements || []);
            if (planned.length === 0) {
                if (isOrderPaymentDeferred(order)) {
                    if (showNotify) {
                        showNotify(
                            'No se registró la venta en caja; revisá que el turno esté abierto',
                            'error',
                        );
                    }
                    return false;
                }
                return true;
            }

            const createdRows = [];
            for (const movement of planned) {
                const { data, error } = await supabase.rpc('cash_add_movement', {
                    p_shift_id: targetShift.id,
                    p_type: movement.type,
                    p_amount: movement.amount,
                    p_description: `Venta #${String(order.id).slice(-4)} - ${order.client_name}`,
                    p_payment_method: movement.payment_method,
                    p_order_id: order.id,
                });
				if (error) throw error;
				if (data?.id && movement.amount_minor != null) {
					await supabase.from(TABLES.cash_movements).update({ amount_minor: movement.amount_minor, currency: movement.currency }).eq('id', data.id);
				}
                if (data) {
                    const deliveryFee = Number(order.delivery_fee) || 0;
                    createdRows.push(
                        deliveryFee > 0 ? { ...data, orders: { delivery_fee: deliveryFee } } : data,
                    );
                }
            }

            if (activeShift && activeShift.id === targetShift.id) {
                await applyLocalMovementInserts(targetShift.id, createdRows);
            }
            return true;
        } catch {
            if (showNotify) showNotify('Error registrando venta en caja', 'error');
            return false;
        }
    }, [activeShift, applyLocalMovementInserts, getTargetShift, showNotify]);

    /**
     * Registra una devolución
     */
    const registerRefund = useCallback(async (order, options = {}) => {
        try {
            const orderBranchId = order?.branch_id;
            if (!orderBranchId) {
                if (showNotify) showNotify('El pedido no tiene una sucursal asociada', 'error');
                return false;
            }
            if (options.expectedBranchId && orderBranchId !== options.expectedBranchId) {
                if (showNotify) showNotify('El pedido no pertenece a la sucursal seleccionada', 'error');
                return false;
            }

            let targetShift = options.targetShift ?? null;
            if (targetShift && targetShift.branch_id !== orderBranchId) {
                if (showNotify) showNotify('La caja abierta no corresponde a la sucursal del pedido', 'error');
                return false;
            }
            if (!targetShift) targetShift = await getTargetShift(orderBranchId);
            if (!targetShift) {
                if (showNotify) showNotify('No hay caja abierta para esta sucursal', 'error');
                return false;
            }

            const { data: movements, error: movementsError } = await supabase
                .from(TABLES.cash_movements)
				.select('type, amount, amount_minor, currency, payment_method')
                .eq('shift_id', targetShift.id)
                .eq('order_id', order.id);
            if (movementsError) throw movementsError;

            const planned = planRefundMovements(order, movements || []);
            if (planned.length === 0) return true;

            const createdRows = [];
            for (const movement of planned) {
                const { data, error } = await supabase.rpc('cash_add_movement', {
                    p_shift_id: targetShift.id,
                    p_type: movement.type,
                    p_amount: movement.amount,
                    p_description: `Devolución #${String(order.id).slice(-4)} - ${order.client_name}`,
                    p_payment_method: movement.payment_method,
                    p_order_id: order.id,
                });
				if (error) throw error;
				if (data?.id && movement.amount_minor != null) {
					await supabase.from(TABLES.cash_movements).update({ amount_minor: movement.amount_minor, currency: movement.currency }).eq('id', data.id);
				}
                if (data) createdRows.push(data);
            }

            if (activeShift && activeShift.id === targetShift.id) {
                await applyLocalMovementInserts(targetShift.id, createdRows);
            }
            if (showNotify) showNotify('Devolución registrada en caja', 'success');
            return true;
        } catch (error) {
            if (showNotify) {
                showNotify(error?.message || 'Error al consultar o registrar la devolución', 'error');
            }
            return false;
        }
    }, [activeShift, showNotify, applyLocalMovementInserts, getTargetShift]);

    /**
     * Re-sincroniza movimientos de venta cuando el pedido editado difiere de lo registrado en caja.
     * @returns {Promise<{ ok: boolean; appliedCount: number }>}
     */
    const resyncOrderSale = useCallback(async (order) => {
        try {
            const { data: movements, error: movErr } = await supabase
                .from(TABLES.cash_movements)
				.select('shift_id, type, amount, amount_minor, currency, payment_method')
                .eq('order_id', order.id);

            if (movErr) throw movErr;

            const existingMovements = movements || [];
            const shiftIdFromMovements = existingMovements.find((m) => m?.shift_id)?.shift_id ?? null;

            let targetShiftId = shiftIdFromMovements;
            if (!targetShiftId) {
                const targetShift = await getTargetShift(order.branch_id);
                targetShiftId = targetShift?.id ?? null;
            }

            if (!targetShiftId) {
                if (showNotify) showNotify('No hay caja abierta para ajustar este pedido', 'error');
                return { ok: false, appliedCount: 0 };
            }

            const shiftMovements = existingMovements.filter((m) => m.shift_id === targetShiftId);
            const planned = planSaleResyncMovements(order, shiftMovements);
            if (planned.length === 0) return { ok: true, appliedCount: 0 };

            const orderLabel = String(order.id).slice(-4);
            const clientName = order.client_name ?? '';

            const createdRows = [];
            for (const movement of planned) {
                const { data, error } = await supabase.rpc('cash_add_movement', {
                    p_shift_id: targetShiftId,
                    p_type: movement.type,
                    p_amount: movement.amount,
                    p_description: `Ajuste venta #${orderLabel} - ${clientName}`,
                    p_payment_method: movement.payment_method,
                    p_order_id: order.id,
                });
				if (error) throw error;
				if (data?.id && movement.amount_minor != null) {
					await supabase.from(TABLES.cash_movements).update({ amount_minor: movement.amount_minor, currency: movement.currency }).eq('id', data.id);
				}
                if (data) createdRows.push(data);
            }

            if (activeShift && activeShift.id === targetShiftId) {
                await applyLocalMovementInserts(targetShiftId, createdRows);
            }
            return { ok: true, appliedCount: planned.length };
        } catch {
            if (showNotify) showNotify('Error ajustando venta en caja', 'error');
            return { ok: false, appliedCount: 0 };
        }
    }, [activeShift, applyLocalMovementInserts, getTargetShift, showNotify]);

    const getPastShifts = useCallback(async (limit = 20) => {
        if (!branchId || !isValidBranchId(branchId)) return [];
        const { data, error } = await supabase
            .from(TABLES.cash_shifts)
            .select(CASH_SHIFT_PAST_SELECT)
            .eq('status', 'closed')
            .eq('branch_id', branchId) // FILTRO POR SUCURSAL
            .neq('orders.status', 'cancelled') // Excluir pedidos cancelados/devueltos del conteo del turno
            .order('closed_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        
        const result = data.map((shift) => {
            const movements = shift.cash_movements || [];
            const totals = computeShiftTotals(movements);
            const deliveryNet = Math.max(
                0,
                (Number(totals.deliveryCollected) || 0) - (Number(totals.deliveryRefunded) || 0),
            );
            const deliveryPending = Math.max(
                0,
                deliveryNet - (Number(totals.deliveryPaidToCourier) || 0),
            );
            const ordersCount = Array.isArray(shift.orders)
                ? Number(shift.orders[0]?.count ?? 0)
                : 0;

            return {
                ...shift,
                total_online: Number(totals.online) || 0,
                orders_count: ordersCount,
                summary: {
                    income: Number(totals.income) || 0,
                    cash: Number(totals.cash) || 0,
                    card: Number(totals.card) || 0,
                    online: Number(totals.online) || 0,
                    deliveryPending,
                    deliveryNet,
                },
            };
        });

        return result;
    }, [branchId]);

    const getShiftMovements = useCallback(async (shiftId) => {
        return cashService.getShiftMovements(shiftId);
    }, []);

    // Memoizar el objeto de retorno para evitar re-renderizados infinitos en consumidores
    return useMemo(() => ({
        activeShift,
        loading,
        movements,
        loadingMovements,
        openShift,
        closeShift,
        addManualMovement,
        registerSale,
        registerRefund,
        resyncOrderSale,
        refresh: loadActiveShift,
        getPastShifts,
        getShiftMovements,
        getTotals
    }), [
        activeShift, loading, movements, loadingMovements,
        openShift, closeShift, addManualMovement, registerSale, registerRefund, resyncOrderSale,
        loadActiveShift, getPastShifts, getShiftMovements, getTotals
    ]);
};
