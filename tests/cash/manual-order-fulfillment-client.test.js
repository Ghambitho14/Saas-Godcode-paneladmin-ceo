import { describe, expect, it } from 'vitest';
import { applyLocalFulfillmentMode } from '@/modules/cash/hooks/manual-order/manualOrderShared';

const selectedClientForm = {
	client_name: 'Juan Pérez',
	client_rut: '12.345.678-9',
	client_phone: '+56 9 1234 5678',
	selected_client_id: 'client-1',
	order_type: 'pickup',
	local_fulfillment_mode: 'retiro',
	mesa_party_mode: 'cliente',
	delivery_address: 'Calle 1',
	delivery_fee: 1500,
	charge_now: true,
	payment_type: 'tienda',
};

describe('applyLocalFulfillmentMode preserveClient', () => {
	it('en venta rápida conserva el cliente al cambiar a delivery', () => {
		const next = applyLocalFulfillmentMode(selectedClientForm, 'delivery', { preserveClient: true });
		expect(next.selected_client_id).toBe('client-1');
		expect(next.client_name).toBe('Juan Pérez');
		expect(next.client_phone).toBe('+56 9 1234 5678');
		expect(next.client_rut).toBe('12.345.678-9');
		expect(next.order_type).toBe('delivery');
		expect(next.local_fulfillment_mode).toBe('delivery');
	});

	it('en venta rápida conserva el cliente al cambiar a mesa', () => {
		const next = applyLocalFulfillmentMode(selectedClientForm, 'mesa', { preserveClient: true });
		expect(next.selected_client_id).toBe('client-1');
		expect(next.client_name).toBe('Juan Pérez');
		expect(next.client_phone).toBe('+56 9 1234 5678');
		expect(next.local_fulfillment_mode).toBe('mesa');
		expect(next.payment_type).toBe('pendiente');
		expect(next.charge_now).toBe(false);
	});

	it('en abrir mesa sigue limpiando identidad al cambiar fulfillment', () => {
		const next = applyLocalFulfillmentMode(selectedClientForm, 'delivery');
		expect(next.selected_client_id).toBe('');
		expect(next.client_phone).toBe('');
		expect(next.client_rut).toBe('');
		expect(next.local_fulfillment_mode).toBe('delivery');
	});
});
