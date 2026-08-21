import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('@/integrations/supabase', () => ({
    TABLES: { orders: 'orders', cash_movements: 'cash_movements' },
    supabase: { from: mocks.from },
}));

vi.mock('@/modules/cash/hooks/useBranchMoney', () => ({
    useBranchMoney: () => ({ formatMoney: (value) => `$${Number(value || 0)}` }),
}));

import LocalExpenseModal from '@/modules/cash/components/expenses/LocalExpenseModal';

function queryReturning(response, singleResponse = response) {
    const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => singleResponse),
        then: (resolve) => Promise.resolve(response).then(resolve),
    };
    return query;
}

describe('devolución desde Gastos del local', () => {
    beforeEach(() => {
        mocks.from.mockReset();
        vi.restoreAllMocks();
    });

    it('al cancelar usa solo la devolución automática de la cancelación', async () => {
        const foundOrder = {
            id: '975',
            branch_id: 'branch-a',
            total: 8500,
            status: 'picked_up',
            payment_type: 'efectivo',
            client_name: 'Cliente',
        };
        mocks.from.mockImplementation((table) => table === 'orders'
            ? queryReturning({ data: foundOrder, error: null }, { data: foundOrder, error: null })
            : queryReturning({
                data: [{ type: 'sale', amount: 8500, payment_method: 'cash' }],
                error: null,
            }));
        const registerRefund = vi.fn().mockResolvedValue(true);
        const moveOrder = vi.fn().mockResolvedValue(true);
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        render(
            <LocalExpenseModal
                isOpen
                onClose={vi.fn()}
                branchId="branch-a"
                branchName="Sucursal A"
                activeShift={{ id: 'shift-a', branch_id: 'branch-a' }}
                onConfirmOperating={vi.fn()}
                registerRefund={registerRefund}
                moveOrder={moveOrder}
                showNotify={vi.fn()}
                companyId="company-a"
                onAfterSuccess={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('tab', { name: 'Devolución pedido' }));
        fireEvent.change(screen.getByLabelText('Número de pedido'), { target: { value: '975' } });
        fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
        await screen.findByText('Neto en caja (turno actual)');
        fireEvent.click(screen.getByRole('button', { name: 'Registrar devolución' }));

        await waitFor(() => expect(moveOrder).toHaveBeenCalledWith('975', 'cancelled'));
        expect(registerRefund).not.toHaveBeenCalled();
    });
});
