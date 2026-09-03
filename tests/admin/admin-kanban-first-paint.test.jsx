import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminKanban from '@/modules/cash/components/AdminKanban';

vi.mock('@/modules/cash/components/OrderCard', () => ({
	default: () => <div className="kanban-card" />,
}));

const emptyColumns = { pending: [], active: [], completed: [] };

let container;
let root;

beforeEach(() => {
	container = document.createElement('div');
	container.className = 'admin-layout';
	document.body.appendChild(container);
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	act(() => root?.unmount());
	container.remove();
	localStorage.clear();
});

const boardClass = () => container.querySelector('.kanban-board').className;

/**
 * El tablero debe pintar su layout definitivo en el primer frame. Cuando el
 * modo de vista se leía desde un useEffect, el primer paint salía como
 * cuadrícula de tres columnas y un tick después saltaba a una columna: ese
 * doble salto es el parpadeo que se ve al abrir la pestaña de pedidos.
 */
describe('AdminKanban: primer paint', () => {
	it('pinta la vista una columna ya en el primer frame', () => {
		localStorage.setItem('tenant-admin-kanban-view', 'single');
		root = createRoot(container);

		// flushSync commita el render pero NO los efectos pasivos: esto es el DOM
		// tal y como lo ve el usuario en el primer frame.
		flushSync(() => {
			root.render(
				<AdminKanban
					columns={emptyColumns}
					isMobile={false}
					mobileTab="pending"
					setMobileTab={() => {}}
				/>,
			);
		});

		expect(boardClass()).toContain('kanban-board--focus-desktop');
	});

	it('no cambia de layout cuando corren los efectos', () => {
		localStorage.setItem('tenant-admin-kanban-view', 'single');
		root = createRoot(container);
		flushSync(() => {
			root.render(
				<AdminKanban
					columns={emptyColumns}
					isMobile={false}
					mobileTab="pending"
					setMobileTab={() => {}}
				/>,
			);
		});
		const firstFrame = boardClass();

		act(() => {});

		expect(boardClass()).toBe(firstFrame);
	});

	it('en móvil oculta las columnas no activas desde el primer frame', () => {
		root = createRoot(container);
		flushSync(() => {
			root.render(
				<AdminKanban
					columns={emptyColumns}
					isMobile
					mobileTab="pending"
					setMobileTab={() => {}}
				/>,
			);
		});

		expect(container.querySelector('.col-active').className).toContain('kanban-column--hidden');
		expect(container.querySelector('.col-pending').className).not.toContain('kanban-column--hidden');
	});
});
