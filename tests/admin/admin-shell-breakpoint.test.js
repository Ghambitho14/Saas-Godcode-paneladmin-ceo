import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	ADMIN_MOBILE_MAX,
	ADMIN_SHELL_COMPACT_MAX,
} from '@/modules/cash/constants/responsive';

const stylesDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../src/modules/cash/styles',
);

const readStyle = (name) => readFileSync(path.join(stylesDir, name), 'utf8');

/**
 * El shell del admin (barra inferior + pestañas de etapa) lo decide el CSS con
 * `@media (max-width: 1024px)` y lo decide el JS con `isMobile`. Si los dos
 * valores se separan, la franja intermedia pinta el shell compacto mientras la
 * lógica sigue creyendo que es escritorio: las pestañas dejan de filtrar y las
 * tres columnas del kanban se apilan.
 */
describe('breakpoint del shell admin', () => {
	it('el CSS del sidebar usa ADMIN_SHELL_COMPACT_MAX', () => {
		expect(readStyle('AdminSidebar.css')).toContain(
			`@media (max-width: ${ADMIN_SHELL_COMPACT_MAX}px)`,
		);
	});

	it('el CSS del kanban usa ADMIN_SHELL_COMPACT_MAX', () => {
		expect(readStyle('AdminKanban.css')).toContain(
			`@media (max-width: ${ADMIN_SHELL_COMPACT_MAX}px)`,
		);
	});

	it('el breakpoint de teléfono es más estrecho que el del shell compacto', () => {
		expect(ADMIN_MOBILE_MAX).toBeLessThan(ADMIN_SHELL_COMPACT_MAX);
	});
});
