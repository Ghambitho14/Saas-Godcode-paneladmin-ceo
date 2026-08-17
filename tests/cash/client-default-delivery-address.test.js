import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, eqMock, selectMock, maybeSingleMock, fromMock } = vi.hoisted(() => {
	const maybeSingleMock = vi.fn();
	const selectMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }));
	const eqMock = vi.fn(() => ({ eq: eqMock, select: selectMock }));
	const updateMock = vi.fn(() => ({ eq: eqMock }));
	const fromMock = vi.fn(() => ({ update: updateMock }));
	return { updateMock, eqMock, selectMock, maybeSingleMock, fromMock };
});

vi.mock('@/integrations/supabase', () => ({
	supabase: { from: fromMock },
	TABLES: { clients: 'clients' },
}));

import {
	buildClientDefaultDeliveryAddress,
	deliveryFieldsFromClientRecord,
	filterClientsByNameOrPhone,
	maybeSaveClientDefaultDeliveryAddress,
	normalizeClientDefaultDeliveryAddress,
	updateClientDefaultDeliveryAddress,
} from '@/modules/cash/services/clientService';

describe('normalizeClientDefaultDeliveryAddress', () => {
	it('conserva address y reference normalizados', () => {
		expect(normalizeClientDefaultDeliveryAddress({
			address: '  Calle 1 <b>x</b> ',
			reference: ' Casa 2 ',
			named_area_id: 'zone-1',
			km: 3,
		})).toEqual({
			address: 'Calle 1 x',
			reference: 'Casa 2',
		});
	});

	it('devuelve null si no hay contenido útil', () => {
		expect(normalizeClientDefaultDeliveryAddress(null)).toBeNull();
		expect(normalizeClientDefaultDeliveryAddress({})).toBeNull();
		expect(normalizeClientDefaultDeliveryAddress({ address: '   ', reference: '' })).toBeNull();
		expect(normalizeClientDefaultDeliveryAddress([{ address: 'x' }])).toBeNull();
	});
});

describe('buildClientDefaultDeliveryAddress', () => {
	it('arma el payload principal reemplazable', () => {
		expect(buildClientDefaultDeliveryAddress({
			address: 'Av. Siempre Viva 742',
			reference: 'Depto 3',
		})).toEqual({
			address: 'Av. Siempre Viva 742',
			reference: 'Depto 3',
		});
	});
});

describe('deliveryFieldsFromClientRecord', () => {
	it('precarga dirección y limpia derivados de zona/tarifa', () => {
		expect(deliveryFieldsFromClientRecord({
			id: 'c1',
			default_delivery_address: {
				address: 'Calle Falsa 123',
				reference: 'Portón azul',
				named_area_id: 'stale-zone',
			},
		})).toEqual({
			delivery_address: 'Calle Falsa 123',
			delivery_reference: 'Portón azul',
			delivery_named_area_id: '',
			delivery_km: '',
			delivery_fee: 0,
		});
	});

	it('no aplica nada si el cliente no tiene dirección', () => {
		expect(deliveryFieldsFromClientRecord({ id: 'c1' })).toBeNull();
	});
});

describe('maybeSaveClientDefaultDeliveryAddress', () => {
	beforeEach(() => {
		fromMock.mockClear();
		updateMock.mockClear();
		eqMock.mockClear();
		selectMock.mockClear();
		maybeSingleMock.mockReset();
		eqMock.mockImplementation(() => ({ eq: eqMock, select: selectMock }));
		updateMock.mockImplementation(() => ({ eq: eqMock }));
		fromMock.mockImplementation(() => ({ update: updateMock }));
		selectMock.mockImplementation(() => ({ maybeSingle: maybeSingleMock }));
	});

	it('omite pedidos que no son delivery', async () => {
		const result = await maybeSaveClientDefaultDeliveryAddress({
			orderType: 'pickup',
			clientId: 'client-1',
			companyId: 'co-1',
			address: 'Calle 1',
		});
		expect(result).toEqual({ ok: true, skipped: true });
		expect(fromMock).not.toHaveBeenCalled();
	});

	it('omite clientes no registrados', async () => {
		const result = await maybeSaveClientDefaultDeliveryAddress({
			orderType: 'delivery',
			clientId: '',
			companyId: 'co-1',
			address: 'Calle 1',
		});
		expect(result).toEqual({ ok: true, skipped: true });
		expect(fromMock).not.toHaveBeenCalled();
	});

	it('reemplaza la dirección principal del cliente registrado', async () => {
		maybeSingleMock.mockResolvedValue({
			data: {
				id: 'client-1',
				default_delivery_address: { address: 'Nueva 1', reference: 'Ref' },
			},
			error: null,
		});

		const result = await maybeSaveClientDefaultDeliveryAddress({
			orderType: 'delivery',
			clientId: 'client-1',
			companyId: 'co-1',
			address: 'Nueva 1',
			reference: 'Ref',
		});

		expect(fromMock).toHaveBeenCalledWith('clients');
		expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
			default_delivery_address: { address: 'Nueva 1', reference: 'Ref' },
		}));
		expect(eqMock).toHaveBeenCalledWith('id', 'client-1');
		expect(eqMock).toHaveBeenCalledWith('company_id', 'co-1');
		expect(result.ok).toBe(true);
		expect(result.data.id).toBe('client-1');
	});

	it('devuelve error controlado si falla el update', async () => {
		maybeSingleMock.mockResolvedValue({
			data: null,
			error: { message: 'rls' },
		});

		const result = await updateClientDefaultDeliveryAddress({
			clientId: 'client-1',
			companyId: 'co-1',
			address: 'Calle 9',
		});

		expect(result.ok).toBe(false);
		expect(result.error).toEqual({ message: 'rls' });
	});
});

describe('filterClientsByNameOrPhone sigue disponible', () => {
	it('no rompe la búsqueda existente', () => {
		const hits = filterClientsByNameOrPhone(
			[{ id: '1', name: 'Juan', phone: '', rut: '' }],
			'Juan',
		);
		expect(hits.map((c) => c.id)).toEqual(['1']);
	});
});
