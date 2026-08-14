import { describe, expect, it } from 'vitest';
import { filterClientsByNameOrPhone } from '@/modules/cash/services/clientService';

const clients = [
	{ id: '1', name: 'Juan Pérez', phone: '+56 9 1234 5678', rut: '12.345.678-9' },
	{ id: '2', name: 'María Soto', phone: '+56 9 8765 4321', rut: '9.876.543-2' },
	{ id: '3', name: 'Pedro Pérez', phone: '+58 412 5551234', document: 'V-12345678' },
	{ id: '4', name: 'Ana', phone: '', rut: '' },
];

describe('filterClientsByNameOrPhone', () => {
	it('encuentra por apellido aunque no esté al inicio', () => {
		const hits = filterClientsByNameOrPhone(clients, 'Pérez');
		expect(hits.map((c) => c.id)).toEqual(['1', '3']);
	});

	it('encuentra por fragmento de teléfono, no solo por prefijo', () => {
		const hits = filterClientsByNameOrPhone(clients, '8765');
		expect(hits.map((c) => c.id)).toEqual(['2']);
	});

	it('encuentra por RUT ignorando puntos y guión', () => {
		const hits = filterClientsByNameOrPhone(clients, '98765432');
		expect(hits.map((c) => c.id)).toEqual(['2']);
	});

	it('no busca teléfono ni documento con menos de 3 caracteres', () => {
		expect(filterClientsByNameOrPhone(clients, '12')).toEqual([]);
		expect(filterClientsByNameOrPhone(clients, 'Ana').map((c) => c.id)).toEqual(['4']);
	});

	it('respeta el tope de sugerencias', () => {
		const many = Array.from({ length: 12 }, (_, i) => ({
			id: String(i),
			name: `Cliente ${i}`,
			phone: '',
			rut: '',
		}));
		expect(filterClientsByNameOrPhone(many, 'cliente')).toHaveLength(8);
		expect(filterClientsByNameOrPhone(many, 'cliente', { limit: 3 })).toHaveLength(3);
	});

	it('devuelve vacío sin query o sin lista', () => {
		expect(filterClientsByNameOrPhone(clients, '  ')).toEqual([]);
		expect(filterClientsByNameOrPhone(null, 'Juan')).toEqual([]);
	});
});
