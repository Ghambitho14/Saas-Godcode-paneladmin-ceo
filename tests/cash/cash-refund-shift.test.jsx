import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase', () => ({
    TABLES: {
        cash_shifts: 'cash_shifts',
        cash_movements: 'cash_movements',
    },
    supabase: {
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

import { useCashSystem } from '@/modules/cash/hooks/useCashSystem';

function queryReturning(response, singleResponse = response) {
    const query = {
        select: vi.fn(() => query),
        update: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => singleResponse),
        then: (resolve) => Promise.resolve(response).then(resolve),
    };
    return query;
}

const order = {
    id: 'order-1234',
    branch_id: 'branch-a',
    client_name: 'Cliente',
    currency: 'CLP',
    total: 1000,
    total_minor: 1000,
};
const shift = { id: 'shift-a', branch_id: 'branch-a', expected_balance: 1000 };

function renderCash(showNotify = vi.fn()) {
    const hook = renderHook(() => useCashSystem(showNotify, 'branch-a', [], { enabled: false }));
    return { ...hook, showNotify };
}

describe('devoluciones y turno de caja', () => {
    beforeEach(() => {
        mocks.from.mockReset();
        mocks.rpc.mockReset();
    });

    it('registra el saldo de la venta en el turno abierto indicado', async () => {
        mocks.from.mockImplementation(() => queryReturning({
            data: [{ type: 'sale', amount: 1000, amount_minor: 1000, currency: 'CLP', payment_method: 'cash' }],
            error: null,
        }));
        mocks.rpc.mockResolvedValue({
            data: { id: 'refund-1', type: 'expense', amount: 1000, payment_method: 'cash' },
            error: null,
        });
        const { result, showNotify } = renderCash();

        let ok;
        await act(async () => {
            ok = await result.current.registerRefund(order, { expectedBranchId: 'branch-a', targetShift: shift });
        });

        expect(ok).toBe(true);
        expect(mocks.rpc).toHaveBeenCalledWith('cash_add_movement', expect.objectContaining({
            p_shift_id: 'shift-a',
            p_type: 'expense',
            p_amount: 1000,
            p_order_id: 'order-1234',
        }));
        expect(showNotify).toHaveBeenCalledWith('Devolución registrada en caja', 'success');
    });

    it('no duplica una devolución que ya cubre la venta', async () => {
        mocks.from.mockImplementation(() => queryReturning({
            data: [
                { type: 'sale', amount: 1000, amount_minor: 1000, currency: 'CLP', payment_method: 'cash' },
                { type: 'expense', amount: 1000, amount_minor: 1000, currency: 'CLP', payment_method: 'cash' },
            ],
            error: null,
        }));
        const { result } = renderCash();

        let ok;
        await act(async () => {
            ok = await result.current.registerRefund(order, { expectedBranchId: 'branch-a', targetShift: shift });
        });

        expect(ok).toBe(true);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('rechaza pedidos de otra sucursal', async () => {
        const { result, showNotify } = renderCash();

        let ok;
        await act(async () => {
            ok = await result.current.registerRefund(
                { ...order, branch_id: 'branch-b' },
                { expectedBranchId: 'branch-a', targetShift: shift },
            );
        });

        expect(ok).toBe(false);
        expect(mocks.from).not.toHaveBeenCalled();
        expect(showNotify).toHaveBeenCalledWith('El pedido no pertenece a la sucursal seleccionada', 'error');
    });

    it('distingue una caja cerrada de un error al consultar Supabase', async () => {
        mocks.from.mockImplementationOnce(() => queryReturning(
            { data: null, error: null },
            { data: null, error: null },
        ));
        const closed = renderCash();
        let closedOk;
        await act(async () => {
            closedOk = await closed.result.current.registerRefund(order);
        });
        expect(closedOk).toBe(false);
        expect(closed.showNotify).toHaveBeenCalledWith('No hay caja abierta para esta sucursal', 'error');

        mocks.from.mockImplementationOnce(() => queryReturning(
            { data: null, error: { message: 'Fallo de lectura de caja' } },
            { data: null, error: { message: 'Fallo de lectura de caja' } },
        ));
        const failed = renderCash();
        let failedOk;
        await act(async () => {
            failedOk = await failed.result.current.registerRefund(order);
        });
        expect(failedOk).toBe(false);
        expect(failed.showNotify).toHaveBeenCalledWith('Fallo de lectura de caja', 'error');
    });
});
