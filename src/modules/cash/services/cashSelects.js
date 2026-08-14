/** Selects explícitos para caja del panel (sin `*`). */

export const CASH_SHIFT_META_SELECT =
	'id, status, branch_id, company_id, opening_balance, expected_balance, ' +
	'actual_balance, actual_card_balance, actual_online_balance, ' +
	'expected_card_balance, expected_online_balance, opened_at, closed_at';

export const CASH_SHIFT_ACTIVE_SELECT = `${CASH_SHIFT_META_SELECT}, cash_movements(count)`;

export const CASH_SHIFT_PAST_SELECT =
	`${CASH_SHIFT_META_SELECT}, ` +
	'cash_movements(amount, type, payment_method, description, expense_kind, order_id, orders(delivery_fee)), ' +
	'orders(count)';

export const CASH_MOVEMENTS_SELECT =
	'id, shift_id, type, amount, amount_minor, currency, created_at, description, payment_method, order_id, expense_kind';

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {boolean}
 */
export function isCompleteCashMovementRow(row) {
	return !!(
		row?.id &&
		row?.shift_id != null &&
		row?.type &&
		row?.amount != null &&
		row?.created_at
	);
}
