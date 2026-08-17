/** Selects explícitos para catálogo y clientes del panel (sin `*`). */

export const CATEGORIES_PANEL_SELECT = 'id, name, company_id, order, is_active';

export const PRODUCTS_PANEL_SELECT =
	'id, name, description, image_url, category_id, company_id, is_active, is_special, dish_kind';

export const PRODUCT_PRICES_BRANCH_SELECT =
	'id, product_id, price, has_discount, discount_price';

export const PRODUCT_BRANCH_SELECT =
	'id, product_id, is_active, is_special, category_id, inventory_pause_reason, inventory_paused_at';

export const CLIENTS_PANEL_SELECT =
	'id, name, phone, phone_normalized, rut, total_orders, total_spent, is_frequent, first_order_at, last_order_at, created_at, updated_at, company_id, default_delivery_address';

export const COMPANY_ADMIN_SELECT = 'id, name, legal_rut, address, phone, email';

export const DISCOUNT_COUPONS_PANEL_SELECT =
	'id, company_id, code, discount_type, discount_value, scope, restricted_client_id, ' +
	'min_order_subtotal, max_redemptions, redemptions_count, max_redemptions_per_client, ' +
	'valid_from, valid_until, is_active, created_at';
