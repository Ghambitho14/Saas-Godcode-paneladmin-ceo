import React, { useState, useEffect, useMemo, useCallback, createContext, useContext, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase, TABLES, getCurrentUser } from '@/integrations/supabase';
import { useCashSystem } from '../../hooks/useCashSystem';
import { ORDERS_LIST_SELECT, sanitizeOrder, isOrderPaymentDeferred, isOrderPaymentSettled, shouldRegisterPaidOrderAtStatus, buildPaymentBreakdownForOrder, buildSettlementPaymentBreakdown, resolveOrderDueMinor } from '@/shared/utils/orderUtils';
import { useLocation as useBranchLocation } from '../../context/useLocation';
import { resolveReportPeriodRange } from '../../utils/reportPeriodRange';
import { getAppScopedPath } from '@/shared/utils/app-route';
import {
	ADMIN_PANEL_TAB_IDS,
	DEFAULT_ROLE_NAV_PERMISSIONS as SHARED_DEFAULT_ROLE_NAV_PERMISSIONS,
	normalizeStoredNavTabId,
} from '@/shared/constants/admin-panel-tabs';
import { panelNotify } from '../utils/panelNotify';
import { getTabAccessDenialMessageForTab } from '../utils/tabAccessMessages';
import { useAdminAuth } from '../hooks/useAdminAuth';
import { useAdminBranchLoadEffects } from '../hooks/useAdminBranchLoad';
import { useAdminOrdersRealtime } from '../hooks/useAdminOrdersRealtime';
import { useAdminBranchSettings } from '../hooks/useAdminBranchSettings';
import { useAdminPanelLoad } from '../hooks/useAdminPanelLoad';
import { useAdminCatalog } from '../hooks/useAdminCatalog';
import { readStoredBranchId } from '../hooks/ordersPanelSettingsStorage';
import { resolvePanelDataScope } from '../orders/panelDataScopes';
import { invalidateBranchOrders } from '../../services/panelDataCache';
import { ADMIN_MOBILE_MQ } from '../../constants/responsive';
import { OrderMoneyProvider } from '../../context/OrderMoneyContext';
import { clearManualOrderDraftsForUser } from '../../services/manualOrderDrafts';
import { installPaymentEvidenceOnlineRetry, queuePaymentEvidence, uploadQueuedPaymentEvidence } from '../../services/paymentEvidenceOutbox';
import { manualOrderV2Service } from '../../services/manualOrderV2Service';
import { atomicOrderTransactionService } from '../../services/atomicOrderTransactionService';
import { majorToMinor, minorToMajor } from '@/lib/money/minor-units';
import { fractionDigitsForCurrency, normalizeCurrencyCode } from '@/shared/utils/money';
import { createClientUuid } from '@/shared/utils/supabaseStorage';
import { normalizeConfiguredPaymentMethods, normalizePaymentMethods, validatePaymentLines } from '../../domain/payment-methods';
import {
	extractMenuSettingsFromIntegration,
	resolvePanelCapabilities,
	SALES_TAB_IDS,
} from '@/lib/tenant/menu-settings';

const ALL_ADMIN_TABS = ADMIN_PANEL_TAB_IDS;
const DEFAULT_ROLE_NAV_PERMISSIONS = { ...SHARED_DEFAULT_ROLE_NAV_PERMISSIONS };

const EMPTY_DYNAMIC_MODULES = /** @type {any[]} */ ([]);
const EMPTY_TAB_LABELS = /** @type {Record<string, string>} */ ({});

const PRODUCT_PHOTOS_STORAGE_KEY = 'godcode-admin-products-show-photos';

function settlementLinesFromLegacyPatch(order, patch) {
	if (Array.isArray(patch?.payment_lines) && patch.payment_lines.length > 0) return patch.payment_lines;
	const currency = normalizeCurrencyCode(order.currency);
	const digits = fractionDigitsForCurrency(currency);
	const totalMinor = resolveOrderDueMinor(order);
	if (patch?.payment_mode === 'mixed') {
		const cash = majorToMinor(patch.cash_amount, currency, digits);
		const card = majorToMinor(patch.card_amount, currency, digits);
		const tendered = patch.cash_tendered === '' || patch.cash_tendered == null
			? null
			: majorToMinor(patch.cash_tendered, currency, digits);
		return [
			...(cash > 0 ? [{
				id: createClientUuid(),
				methodId: 'efectivo',
				rail: 'cash',
				amountMinor: cash,
				currency,
				evidencePolicy: 'none',
				...(tendered != null ? {
					tenderedAmountMinor: tendered,
					tenderedCurrency: currency,
					changeAmountMinor: Math.max(0, tendered - cash),
				} : {}),
			}] : []),
			...(card > 0 ? [{ id: createClientUuid(), methodId: 'card', rail: 'card', amountMinor: card, currency, evidencePolicy: 'optional' }] : []),
		];
	}
	const rail = patch?.payment_type === 'tarjeta' ? 'card' : patch?.payment_type === 'online' ? 'online' : 'cash';
	const tendered = patch?.cash_tendered === '' || patch?.cash_tendered == null
		? null
		: majorToMinor(patch.cash_tendered, currency, digits);
	return [{
		id: createClientUuid(),
		methodId: rail === 'cash' ? 'efectivo' : rail === 'card' ? 'card' : 'bank_transfer',
		rail,
		amountMinor: totalMinor,
		currency,
		evidencePolicy: rail === 'online' ? 'required' : 'none',
		...(rail === 'cash' && tendered != null ? {
			tenderedAmountMinor: tendered,
			tenderedCurrency: currency,
			changeAmountMinor: Math.max(0, tendered - totalMinor),
		} : {}),
	}];
}

async function attachSettlementEvidence(order, receiptFile) {
	if (!receiptFile || !order?.id) return order;
	const evidenceRows = await manualOrderV2Service.listEvidence(order.id);
	const pendingRows = evidenceRows.filter((row) => row.status !== 'uploaded');
	if (pendingRows.length === 0) return order;
	let evidenceStatus = order.payment_evidence_status ?? null;
	let paymentRef = order.payment_ref ?? null;
	let paymentStatus = order.payment_status ?? null;
	for (const [index, evidence] of pendingRows.entries()) {
		const queued = await queuePaymentEvidence({
			evidenceId: evidence.id,
			companyId: order.company_id,
			branchId: order.branch_id,
			orderId: order.id,
			file: receiptFile,
			previousPath: evidence.storage_path || (index === 0 ? order.payment_ref ?? null : null),
		});
		const upload = await uploadQueuedPaymentEvidence(queued);
		if (upload.ok) {
			paymentRef = upload.path || paymentRef;
			evidenceStatus = upload.evidenceStatus || evidenceStatus || 'uploaded';
			if (upload.paymentStatus) paymentStatus = upload.paymentStatus;
		} else {
			evidenceStatus = 'failed';
		}
	}
	return {
		...order,
		payment_ref: paymentRef,
		payment_evidence_status: evidenceStatus,
		...(paymentStatus ? { payment_status: paymentStatus } : {}),
	};
}

function resolveSettlementPaymentLines(order, patch, branchPaymentMethods = null) {
	const currency = normalizeCurrencyCode(order.currency);
	const digits = fractionDigitsForCurrency(currency);
	const rawLines = settlementLinesFromLegacyPatch(order, patch);
	const methodIds = [...new Set(rawLines.map((line) => line.methodId).filter(Boolean))];
	const methods = Array.isArray(branchPaymentMethods)
		? normalizeConfiguredPaymentMethods(branchPaymentMethods, { accountingCurrency: currency })
		: normalizePaymentMethods(
			methodIds.length ? methodIds : ['efectivo', 'card', 'bank_transfer'],
			{ accountingCurrency: currency },
		);
	const quote = {
		totalMinor: resolveOrderDueMinor(order),
		currency,
		fractionDigits: digits,
	};
	const validated = validatePaymentLines(rawLines, quote, methods);
	if (validated.valid) return validated.lines;
	return rawLines.map((line) => {
		const method = methods.find((entry) => entry.id === line.methodId);
		if (!method) return line;
		return {
			...line,
			rail: method.rail,
			evidencePolicy: method.evidencePolicy,
			settlementTrigger: method.settlementTrigger,
		};
	});
}

function legacyAtomicPaymentPatch(order, patch = null) {
	const source = patch || order || {};
	const currency = normalizeCurrencyCode(order?.currency);
	const digits = fractionDigitsForCurrency(currency);
	const dueMajor = minorToMajor(resolveOrderDueMinor(order), currency, digits);
	const breakdown = patch?.payment_breakdown
		|| buildPaymentBreakdownForOrder({
			...order,
			...source,
			total: dueMajor,
		})
		|| buildSettlementPaymentBreakdown(
			source.payment_type || order?.payment_type,
			dueMajor,
		);
	return {
		...source,
		payment_type: source.payment_type || order?.payment_type,
		payment_method_specific:
			source.payment_method_specific || order?.payment_method_specific || source.payment_type,
		payment_breakdown: breakdown,
	};
}

function readShowProductPhotosPreference() {
	try {
		const stored = localStorage.getItem(PRODUCT_PHOTOS_STORAGE_KEY);
		if (stored === '0' || stored === 'false') return false;
		return true;
	} catch {
		return true;
	}
}

const normalizePanelAccess = (raw) => {
	const allowed = new Set(ALL_ADMIN_TABS);

	if (!Array.isArray(raw)) return null;

	const cleanTabs = [...new Set(
		raw
			.filter((tab) => typeof tab === 'string')
			.map((tab) => normalizeStoredNavTabId(tab))
			.filter((tab) => allowed.has(tab)),
	)];

	if (cleanTabs.length === 0) return null;
	return cleanTabs;
};

export const AdminContext = createContext(null);

export const useAdmin = () => {
	const context = useContext(AdminContext);
	if (!context) throw new Error('useAdmin must be used within an AdminProvider');
	return context;
};

/**
 * @param {Object} props
 * @param {import('react').ReactNode} props.children
 * @param {string} props.companyId
 * @param {string | null | undefined} [props.initialUserRole]
 * @param {string | null | undefined} [props.initialAssignedBranchId]
 * @param {string[] | null | undefined} [props.panelAccess]
 * @param {any[]} [props.dynamicModules]
 */
/**
 * @param {object} root0
 * @param {React.ReactNode} root0.children
 * @param {string} root0.companyId
 * @param {string | null} [root0.initialUserRole]
 * @param {string | null} [root0.initialAssignedBranchId]
 * @param {string[] | null | undefined} [root0.panelAccess]
 * @param {any[]} [root0.dynamicModules]
 * @param {Record<string, string>} [root0.resolvedTabLabels]
 * @param {boolean} [root0.adminShortcutsEnabled]
 * @param {{ country?: string | null; currency?: string | null; integration_settings?: unknown; planFeatures?: unknown } | null} [root0.companyProfile]
 * @param {import('@/lib/tenant/menu-settings').TenantPanelOrderCapabilities | null} [root0.menuCapabilities]
 * @param {string} [root0.companyName]
 * @param {string | null} [root0.logoUrl]
 */
export const AdminProvider = ({
	children,
	companyId,
	initialUserRole = null,
	initialAssignedBranchId = null,
	panelAccess,
	dynamicModules = EMPTY_DYNAMIC_MODULES,
	resolvedTabLabels = EMPTY_TAB_LABELS,
	adminShortcutsEnabled = true,
	companyProfile = null,
	menuCapabilities: menuCapabilitiesProp = null,
	companyName = null,
	logoUrl = null,
}) => {
	const navigateFn = useNavigate();
	const { pathname } = useLocation();
	const navigate = useCallback((path) => navigateFn(getAppScopedPath(pathname || '/', path)), [pathname, navigateFn]);

	const [activeTab, setActiveTab] = useState('orders');
	const [products, setProducts] = useState([]);
	const [categories, setCategories] = useState([]);
	const [orders, setOrders] = useState([]);
	const [clients, setClients] = useState([]);
	const {
		selectedBranch: locationSelectedBranch,
		allBranches,
		loadingBranches,
		selectBranch,
		refetchBranches,
	} = useBranchLocation();
	const [isAllBranchView, setIsAllBranchView] = useState(false);
	const [isHistoryView, setIsHistoryView] = useState(false);
	const [historyPeriod, setHistoryPeriod] = useState('week');
	const [historyOrders, setHistoryOrders] = useState([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [isOpenMesaModal, setIsOpenMesaModal] = useState(false);
	const [manualOrderMode, setManualOrderMode] = useState('quick_sale');
	const [pendingTableSessionOrderId, setPendingTableSessionOrderId] = useState(null);
	/** @type {[null | { id: string, table_id?: string | null, table_code?: string | null, guest_name?: string, party_size?: number }, Function]} */
	const [pendingSeatReservation, setPendingSeatReservation] = useState(null);
	const [mobileTab, setMobileTab] = useState('pending');
	const [searchQuery, setSearchQuery] = useState('');
	const [filterCategory, setFilterCategory] = useState('all');
	const [filterStatus, setFilterStatus] = useState('all');
	const [viewMode, setViewMode] = useState('grid');
	const [showProductPhotos, setShowProductPhotosState] = useState(readShowProductPhotosPreference);
	const setShowProductPhotos = useCallback((next) => {
		setShowProductPhotosState((prev) => {
			const value = typeof next === 'function' ? next(prev) : next;
			try {
				localStorage.setItem(PRODUCT_PHOTOS_STORAGE_KEY, value ? '1' : '0');
			} catch {
				/* ignore quota / private mode */
			}
			return value;
		});
	}, []);
	const [sortOrder, setSortOrder] = useState('name-asc');
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const sessionRestoredRef = useRef(false);
	const isModalOpenRef = useRef(false);
	const editingProductRef = useRef(/** @type {unknown} */ (null));
	const [isMobile, setIsMobile] = useState(() => {
		if (typeof window === 'undefined') return false;
		return window.matchMedia(ADMIN_MOBILE_MQ).matches;
	});
	const [selectedClient, setSelectedClient] = useState(null);
	const [selectedClientOrders, setSelectedClientOrders] = useState([]);
	const [clientHistoryLoading, setClientHistoryLoading] = useState(false);

	/** Lista de sucursales: única fuente es LocationContext (sin segundo fetch). */
	const branches = allBranches;
	/** Sucursal virtual "todas" (solo vista admin: analytics / gastos). Nunca se persiste. */
	const allBranchesOption = useMemo(() => ({ id: 'all', name: 'Todas las sucursales' }), []);
	/** Sucursal efectiva: la virtual "todas" o la real de LocationContext. */
	const selectedBranch = isAllBranchView ? allBranchesOption : locationSelectedBranch;
	/** Compat: el botón "actualizar" y reintentos siguen llamando refreshBranches(). */
	const refreshBranches = refetchBranches;

	const normalizedPanelAccess = useMemo(
		() => normalizePanelAccess(panelAccess),
		[panelAccess]
	);

	const menuCapabilities = useMemo(() => {
		if (menuCapabilitiesProp) return menuCapabilitiesProp;
		const menuSettings = extractMenuSettingsFromIntegration(companyProfile?.integration_settings);
		return resolvePanelCapabilities(menuSettings, companyProfile?.planFeatures);
	}, [menuCapabilitiesProp, companyProfile]);

	const menuRestrictedTabs = useMemo(() => {
		const hidden = new Set();
		if (menuCapabilities.hideSalesTabs) {
			hidden.add('orders');
			for (const tab of SALES_TAB_IDS) hidden.add(tab);
		} else if (!menuCapabilities.showOnlineOrdersQueue) {
			hidden.add('orders');
		}
		return hidden;
	}, [menuCapabilities]);

	const normalizedDynamicModules = useMemo(() => (
		Array.isArray(dynamicModules)
			? dynamicModules
				.filter((module) => module && typeof module.tabId === 'string' && module.tabId.startsWith('module:'))
				.map((module) => ({
					id: module.id,
					tabId: module.tabId,
					label: module.label,
					description: module.description || '',
					navGroup: module.navGroup || 'root',
					navOrder: Number.isFinite(Number(module.navOrder)) ? Number(module.navOrder) : 100,
					allowedRoles: Array.isArray(module.allowedRoles) ? module.allowedRoles : ['admin', 'ceo'],
					isActive: Boolean(module.isActive),
				}))
			: []
	), [dynamicModules]);

	const showNotify = useCallback((msg, type = 'success') => {
		panelNotify(msg, type);
	}, []);

	const forcePanelReloadRef = useRef(/** @type {() => Promise<void>} */ (async () => {}));
	const onForceReloadAfterLogin = useCallback(() => {
		void forcePanelReloadRef.current();
	}, []);

	const {
		userRole,
		userEmail,
		assignedBranchId,
		signOut,
	} = useAdminAuth({
		companyId,
		initialUserRole,
		initialAssignedBranchId,
		navigate,
		showNotify,
		onForceReloadAfterLogin,
	});

	useEffect(() => installPaymentEvidenceOnlineRetry(), []);

	const signOutAndClearDrafts = useCallback(async () => {
		try {
			// Con accessToken del BFF, supabase.auth.getUser() no está disponible.
			const userId = getCurrentUser()?.id;
			const identities = [...new Set([userEmail, userId].filter(Boolean))];
			await Promise.allSettled(identities.map(clearManualOrderDraftsForUser));
		} finally {
			await signOut();
		}
	}, [signOut, userEmail]);

	const allowedTabs = useMemo(() => {
		const rawRoleKey = (userRole || '').toLowerCase();
		const roleKey = rawRoleKey === 'staff' ? 'cashier' : rawRoleKey;
		const companyAllowedTabs = new Set(normalizedPanelAccess ?? ALL_ADMIN_TABS);
		/*
		 * Sin rol aún: no usar el fallback del cajero (bloqueaba CEO/productos hasta verifyAdminAccess).
		 * Tras verify, si el rol es inválido, verify redirige; aquí damos acceso amplio solo mientras roleKey está vacío.
		 */
		if (!roleKey) {
			return new Set([...companyAllowedTabs].filter((tab) => !menuRestrictedTabs.has(tab)));
		}

		const fallbackForRole = DEFAULT_ROLE_NAV_PERMISSIONS[roleKey] ?? DEFAULT_ROLE_NAV_PERMISSIONS.cashier;
		const roleAllowedTabs = Array.isArray(fallbackForRole) ? fallbackForRole : DEFAULT_ROLE_NAV_PERMISSIONS.cashier;

		return new Set(
			roleAllowedTabs.filter((tab) => companyAllowedTabs.has(tab) && !menuRestrictedTabs.has(tab)),
		);
	}, [normalizedPanelAccess, userRole, menuRestrictedTabs]);

	const dynamicModuleTabs = useMemo(() => {
		const roleKey = String(userRole || '').toLowerCase() === 'staff'
			? 'cashier'
			: String(userRole || '').toLowerCase();

		return new Set(
			normalizedDynamicModules
				.filter((module) => module.isActive)
				.filter((module) => {
					if (!roleKey) return false;
					if (!Array.isArray(module.allowedRoles) || module.allowedRoles.length === 0) return true;
					return module.allowedRoles.map((role) => String(role).toLowerCase()).includes(roleKey);
				})
				.map((module) => module.tabId)
		);
	}, [normalizedDynamicModules, userRole]);

	const canAccessTab = useCallback((tabId) => (
		allowedTabs.has(tabId) || dynamicModuleTabs.has(tabId)
	), [allowedTabs, dynamicModuleTabs]);
	const isBranchLocked = Boolean(assignedBranchId);

	useEffect(() => {
		sessionRestoredRef.current = false;
	}, [companyId]);

	useEffect(() => {
		if (!userRole || typeof window === 'undefined') return;
		if (sessionRestoredRef.current) return;
		if (branches.length === 0) return;
		try {
			const storedTab = localStorage.getItem(`godcode-panel:${companyId}:activeTab`);
			if (storedTab && canAccessTab(storedTab)) {
				setActiveTab(storedTab);
			}
			// Migración one-shot: si existe la key legacy del panel y LocationContext
			// todavía no tiene sucursal, la trasladamos al contexto unificado.
			if (!isBranchLocked && !locationSelectedBranch) {
				const bid = readStoredBranchId(companyId);
				if (bid) {
					const b = branches.find((branch) => branch.id === bid);
					if (b) {
						selectBranch(b);
					}
				}
			}
		} catch (error) {
			/* ignore */
		}
		sessionRestoredRef.current = true;
	}, [userRole, branches, companyId, canAccessTab, isBranchLocked, locationSelectedBranch, selectBranch]);

	useEffect(() => {
		if (!userRole || typeof window === 'undefined') return;
		try {
			localStorage.setItem(`godcode-panel:${companyId}:activeTab`, activeTab);
		} catch {
			/* ignore */
		}
	}, [activeTab, companyId, userRole]);

	useEffect(() => {
		const mq = window.matchMedia(ADMIN_MOBILE_MQ);
		const sync = () => setIsMobile(mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	}, []);

	const tabAccessContext = useMemo(() => ({
		userRole,
		normalizedPanelAccess,
		menuCapabilities,
		dynamicModules: normalizedDynamicModules,
	}), [userRole, normalizedPanelAccess, menuCapabilities, normalizedDynamicModules]);

	const getTabAccessDeniedMessage = useCallback((tabId) => (
		getTabAccessDenialMessageForTab({ ...tabAccessContext, tabId })
	), [tabAccessContext]);

	const setActiveTabWithGuard = useCallback((tabId) => {
		if (canAccessTab(tabId)) {
			setActiveTab(tabId);
			return;
		}

		const message = getTabAccessDeniedMessage(tabId);
		showNotify(message || 'Necesitás un rol diferente para acceder a esta sección.', 'error');
	}, [canAccessTab, showNotify, getTabAccessDeniedMessage]);

	const setSelectedBranchWithGuard = useCallback((nextBranch) => {
		const nextBranchId = nextBranch?.id || null;
		if (isBranchLocked && nextBranchId !== assignedBranchId) {
			showNotify('Tu correo está asignado a un local específico y no puedes cambiar de sucursal.', 'error');
			return;
		}
		if (nextBranchId === 'all') {
			setIsAllBranchView(true);
			return;
		}
		setIsAllBranchView(false);
		selectBranch(nextBranch);
	}, [assignedBranchId, isBranchLocked, showNotify, selectBranch]);

	const cashScopeEnabled = useMemo(
		() => resolvePanelDataScope(activeTab, { isManualOrderOpen: isOpenMesaModal }).cash,
		[activeTab, isOpenMesaModal],
	);
	const cashSystem = useCashSystem(showNotify, selectedBranch?.id, orders, { enabled: cashScopeEnabled });

	// Sin sucursales disponibles loadData() no corre; evitamos el spinner infinito.
	useEffect(() => {
		if (!loadingBranches && allBranches.length === 0) {
			setLoading(false);
		}
	}, [loadingBranches, allBranches.length]);

	useEffect(() => {
		if (branches.length === 0) return;
		if (assignedBranchId) {
			if (isAllBranchView) setIsAllBranchView(false);
			const assignedBranch = branches.find((branch) => branch.id === assignedBranchId);
			if (assignedBranch && locationSelectedBranch?.id !== assignedBranch.id) {
				selectBranch(assignedBranch);
			}
			return;
		}
		// Fuera de analytics la vista "todas" no aplica: volvemos a una sucursal concreta.
		if (activeTab !== 'analytics' && isAllBranchView) {
			setIsAllBranchView(false);
			return;
		}
		// Garantiza una sucursal concreta por defecto (el panel nunca arranca sin selección).
		if (!isAllBranchView && !locationSelectedBranch) {
			selectBranch(branches[0]);
		}
	}, [activeTab, assignedBranchId, branches, locationSelectedBranch, isAllBranchView, selectBranch]);

	useEffect(() => {
		if (!userRole) return;
		if (canAccessTab(activeTab)) return;

		const [firstAllowedTab] = Array.from(new Set([...allowedTabs, ...dynamicModuleTabs]));
		const targetTab = firstAllowedTab || 'products';
		if (targetTab === activeTab || !canAccessTab(targetTab)) return;
		setActiveTab(targetTab);
	}, [activeTab, allowedTabs, canAccessTab, dynamicModuleTabs, userRole]);

	const selectedBranchId = selectedBranch?.id ?? null;

	const {
		ordersViewMode,
		ordersViewModeSaving,
		localOrderChannels,
		ordersPanelSettingsReady,
		branchExchangeRate,
		inventoryEnforceOnSale,
		saveOrdersPanelSettings,
	} = useAdminBranchSettings({ companyId, selectedBranch, showNotify });

	const {
		lastDataRefreshAt,
		inventoryBranchRows,
		loadGenerationRef,
		loadedPanelScopeRef,
		loadDataRef,
		fetchOrdersRef,
		orderMoveInFlightRef,
		loadPanelData,
		loadData,
		refreshAllData,
		refreshOrders,
		refreshClients,
		refreshCatalog,
		refreshCatalogAndInventory,
		refreshInventoryBranch,
		refreshCatalogInner,
		upsertOrder,
		hydrateOrderItems,
	} = useAdminPanelLoad({
		companyId,
		selectedBranchId,
		selectedBranch,
		activeTab,
		showNotify,
		setOrders,
		setClients,
		setCategories,
		setProducts,
		setLoading,
		setRefreshing,
		setHistoryOrders,
		setSelectedClientOrders,
		refetchBranches,
		cashSystem,
		isModalOpenRef,
		editingProductRef,
		forcePanelReloadRef,
	});

	const catalog = useAdminCatalog({
		companyId,
		selectedBranch,
		showNotify,
		setRefreshing,
		setOrders,
		setProducts,
		setCategories,
		setSelectedClientOrders,
		selectedClient,
		refreshCatalogInner,
		isModalOpenRef,
		editingProductRef,
	});

	const {
		isModalOpen,
		setIsModalOpen,
		editingProduct,
		setEditingProduct,
		isCategoryModalOpen,
		setIsCategoryModalOpen,
		editingCategory,
		setEditingCategory,
		receiptModalOrder,
		setReceiptModalOrder,
		receiptPreview,
		setReceiptPreview,
		uploadingReceipt,
		setUploadingReceipt,
		scopeModal,
		setScopeModal,
		productToDelete,
		setProductToDelete,
		categoryToDelete,
		setCategoryToDelete,
		uploadReceiptToOrder,
		handleReceiptFileChange,
		handleSaveProduct,
		deleteProduct,
		confirmDeleteProduct,
		toggleProductActive,
		handleScopeConfirm,
		handleSaveCategory,
		reorderCategories,
		toggleCategoryActive,
		deleteCategory,
		confirmDeleteCategory,
	} = catalog;

	const loadClientHistory = useCallback(async (client) => {
		if (!client) return;
		if (!companyId) return;
		setClientHistoryLoading(true);
		try {
			const { data, error } = await supabase
				.from(TABLES.orders)
				.select(ORDERS_LIST_SELECT)
				.eq('client_id', client.id)
				.eq('company_id', companyId)
				.order('created_at', { ascending: false })
				.limit(100);
			if (error) throw error;
			setSelectedClientOrders((data || []).map(sanitizeOrder));
		} catch {
			showNotify('Error al cargar historial', 'error');
		} finally {
			setClientHistoryLoading(false);
		}
	}, [showNotify, companyId]);

	const handleSelectClient = useCallback((client) => {
		setSelectedClient(client);
		loadClientHistory(client);
	}, [loadClientHistory]);

	useAdminOrdersRealtime({
		selectedBranchId,
		companyId,
		showOnlineOrdersQueue: menuCapabilities.showOnlineOrdersQueue,
		branches,
		showNotify,
		refreshInventoryBranch,
		setOrders,
		fetchOrdersRef,
		activeTab,
		logoUrl,
		companyName,
		selectedBranch,
		companyProfile,
		branchExchangeRate,
	});

	useAdminBranchLoadEffects({
		selectedBranchId,
		companyId,
		activeTab,
		isOpenMesaModal,
		loadGenerationRef,
		loadedPanelScopeRef,
		loadDataRef,
		loadPanelData,
		setSelectedClient,
		setSelectedClientOrders,
		setHistoryOrders,
	});

	const moveOrder = useCallback(async (orderId, nextStatus) => {
		if (orderMoveInFlightRef.current.has(orderId)) return false;
		orderMoveInFlightRef.current.add(orderId);
		invalidateBranchOrders(companyId, selectedBranchId);
		const previousRow = orders.find((o) => o.id === orderId);
		setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: nextStatus } : o)));
		try {
			const isV2Order = previousRow?.manual_order_mode === 'quick_sale' || previousRow?.manual_order_mode === 'session';
			if (isV2Order) {
				if (nextStatus === 'picked_up' && !isOrderPaymentSettled(previousRow)) {
					throw new Error('Este pedido sigue pendiente de pago. Registra el cobro antes de cerrarlo.');
				}
				const transitioned = await manualOrderV2Service.transition(orderId, nextStatus, previousRow?.updated_at ?? null);
				setOrders((prev) => prev.map((order) => order.id === orderId ? sanitizeOrder(transitioned) : order));
				if (nextStatus === 'cancelled') {
					void cashSystem.refresh?.();
				}
				showNotify('Pedido actualizado');
				return true;
			}
			const targetOrder = previousRow;

			// En legacy la venta y el cambio operativo no son atómicos. Registrar
			// caja antes evita dejar un pedido entregado sin movimiento contable.
			if (nextStatus === 'picked_up') {
				if (targetOrder && !isOrderPaymentSettled(targetOrder)) {
					throw new Error('Este pedido sigue pendiente de pago. Registra el cobro antes de entregarlo.');
				}
			}
			if (targetOrder && shouldRegisterPaidOrderAtStatus(targetOrder, nextStatus)) {
				const updated = sanitizeOrder(await atomicOrderTransactionService.settleAndTransition(
					targetOrder,
					legacyAtomicPaymentPatch(targetOrder),
					nextStatus,
				));
				setOrders((prev) => prev.map((o) => (o.id === orderId ? updated : o)));
				void cashSystem.refresh?.();
				showNotify('Pedido y caja actualizados');
				return true;
			}

			const { error } = await supabase.from(TABLES.orders).update({ status: nextStatus }).eq('id', orderId).eq('company_id', companyId);
			if (error) throw error;

			if (nextStatus === 'cancelled') {
				if (targetOrder) {
					const ok = await cashSystem.registerRefund(targetOrder);
					if (!ok) {
						showNotify(
							'Pedido cancelado, pero no se pudo registrar la devolución en caja. Revisa el turno y ajusta manualmente.',
							'error',
						);
						return false;
					}
				}
			}
			showNotify('Pedido actualizado');
			return true;
		} catch (error) {
			if (previousRow) {
				setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...previousRow } : o)));
			}
			showNotify(error?.message || 'Error al actualizar', 'error');
			return false;
		} finally {
			orderMoveInFlightRef.current.delete(orderId);
		}
	}, [orders, cashSystem, showNotify, companyId, selectedBranchId]);

	const loadHistoryOrders = useCallback(async () => {
		if (!companyId || !selectedBranch?.id || selectedBranch.id === 'all') {
			setHistoryOrders([]);
			return;
		}
		setHistoryLoading(true);
		try {
			const range = resolveReportPeriodRange(historyPeriod);
			let query = supabase
				.from(TABLES.orders)
				.select(ORDERS_LIST_SELECT)
				.eq('company_id', companyId)
				.eq('branch_id', selectedBranch.id)
				.in('status', ['picked_up', 'cancelled'])
				.order('updated_at', { ascending: false });
			if (range.fetchStartIso) {
				query = query.gte('updated_at', range.fetchStartIso);
			}
			if (range.fetchEndIso) {
				query = query.lt('updated_at', range.fetchEndIso);
			}
			const { data, error } = await query.limit(500);
			if (error) throw error;
			setHistoryOrders((data || []).map(sanitizeOrder));
		} catch {
			showNotify('No se pudo cargar el historial', 'error');
			setHistoryOrders([]);
		} finally {
			setHistoryLoading(false);
		}
	}, [companyId, selectedBranch, historyPeriod, showNotify]);

	useEffect(() => {
		if (!isHistoryView) return;
		void loadHistoryOrders();
	}, [isHistoryView, loadHistoryOrders]);

	const markOrderSessionPaid = useCallback(async (order, paymentPatch = null) => {
		if (!order?.id) return false;
		try {
			const isV2Order = order.manual_order_mode === 'quick_sale' || order.manual_order_mode === 'session';
			if (isV2Order) {
				if (!paymentPatch) { showNotify('Selecciona un método de pago', 'warning'); return false; }
				const lines = resolveSettlementPaymentLines(
					order,
					paymentPatch,
					paymentPatch.branchPaymentMethods,
				);
				let settled = sanitizeOrder(await manualOrderV2Service.settle(order.id, lines));
				try {
					settled = sanitizeOrder(await attachSettlementEvidence(settled, paymentPatch.receiptFile));
				} catch (evidenceError) {
					showNotify(evidenceError?.message || 'Pago registrado, pero falló el comprobante.', 'warning');
				}
				setOrders((prev) => prev.map((row) => row.id === order.id ? settled : row));
				setHistoryOrders((prev) => prev.map((row) => row.id === order.id ? settled : row));
				void cashSystem.refresh?.();
				showNotify(
					settled.payment_evidence_status === 'failed'
						? 'Pago registrado · comprobante pendiente'
						: 'Pago registrado',
					settled.payment_evidence_status === 'failed' ? 'warning' : 'success',
				);
				return settled;
			}
			let nextOrder = order;
			if (!paymentPatch && !isOrderPaymentSettled(order)) {
				showNotify('Selecciona un método de pago', 'warning');
				return false;
			}
			nextOrder = sanitizeOrder(await atomicOrderTransactionService.settleAndTransition(
				order,
				legacyAtomicPaymentPatch(order, paymentPatch),
			));
			setOrders((prev) => prev.map((row) => row.id === order.id ? nextOrder : row));
			setHistoryOrders((prev) => prev.map((row) => row.id === order.id ? nextOrder : row));
			void cashSystem.refresh?.();
			showNotify('Pago registrado', 'success');
			return nextOrder;
		} catch (err) {
			showNotify(err?.message || 'Error al registrar el pago', 'error');
			return false;
		}
	}, [cashSystem, showNotify]);

	const closeOrderSession = useCallback(async (order, paymentPatch = null) => {
		if (!order?.id) return false;
		try {
			const isV2Order = order.manual_order_mode === 'quick_sale' || order.manual_order_mode === 'session';
			if (isV2Order) {
				if (isOrderPaymentDeferred(order)) {
					if (!paymentPatch) { showNotify('Selecciona un método de pago', 'warning'); return false; }
					const lines = resolveSettlementPaymentLines(
						order,
						paymentPatch,
						paymentPatch.branchPaymentMethods,
					);
					let closed = sanitizeOrder(await manualOrderV2Service.settleAndTransition(
						order.id,
						lines,
						'picked_up',
					));
					try {
						closed = sanitizeOrder(await attachSettlementEvidence(closed, paymentPatch.receiptFile));
					} catch (evidenceError) {
						showNotify(evidenceError?.message || 'Mesa cerrada, pero falló el comprobante.', 'warning');
					}
					setOrders((prev) => prev.map((row) => row.id === order.id ? closed : row));
					void cashSystem.refresh?.();
					showNotify(
						closed.payment_evidence_status === 'failed'
							? 'Sesión cerrada · comprobante pendiente'
							: 'Sesión cerrada correctamente',
						closed.payment_evidence_status === 'failed' ? 'warning' : 'success',
					);
					return true;
				}
				const closed = sanitizeOrder(await manualOrderV2Service.transition(order.id, 'picked_up', order.updated_at ?? null));
				setOrders((prev) => prev.map((row) => row.id === order.id ? closed : row));
				showNotify('Sesión cerrada correctamente');
				return true;
			}
			let nextOrder = order;
			if (!paymentPatch && !isOrderPaymentSettled(order)) {
				showNotify('Selecciona un método de pago', 'warning');
				return false;
			}
			nextOrder = sanitizeOrder(await atomicOrderTransactionService.settleAndTransition(
				order,
				legacyAtomicPaymentPatch(order, paymentPatch),
				'picked_up',
			));
			setOrders((prev) => prev.map((o) => (o.id === order.id ? nextOrder : o)));
			void cashSystem.refresh?.();
			showNotify('Mesa cerrada correctamente');
			return true;
		} catch (err) {
			showNotify(err?.message || 'Error al cerrar la mesa', 'error');
			return false;
		}
	}, [cashSystem, showNotify]);

	const kanbanColumns = useMemo(() => {
		const byCreatedAsc = (a, b) =>
			new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
		const pending = [];
		const active = [];
		const completed = [];
		const cancelled = [];
		const history = [];
		for (const o of orders) {
			switch (o.status) {
				case 'pending':
					pending.push(o);
					break;
				case 'active':
					active.push(o);
					break;
				case 'completed':
					completed.push(o);
					break;
				case 'cancelled':
					cancelled.push(o);
					history.push(o);
					break;
				case 'picked_up':
					history.push(o);
					break;
				default:
					break;
			}
		}
		pending.sort(byCreatedAsc);
		active.sort(byCreatedAsc);
		completed.sort(byCreatedAsc);
		return { pending, active, completed, cancelled, history };
	}, [orders]);

	const processedProducts = useMemo(() => {
		let result = products.filter(p =>
			p.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
			(filterCategory === 'all' || p.category_id === filterCategory) &&
			(filterStatus === 'all' || (filterStatus === 'active' ? p.is_active : !p.is_active))
		);
		return result.sort((a, b) => {
			if (filterStatus === 'all' && a.is_active !== b.is_active) return a.is_active ? -1 : 1;
			if (sortOrder === 'name-asc') return a.name.localeCompare(b.name);
			if (sortOrder === 'price-asc') return a.price - b.price;
			if (sortOrder === 'price-desc') return b.price - a.price;
			return 0;
		});
	}, [products, searchQuery, filterCategory, filterStatus, sortOrder]);

	const productStats = useMemo(() => ({
		total: products.length,
		active: products.filter(p => p.is_active).length,
		paused: products.filter(p => !p.is_active).length
	}), [products]);

	const value = useMemo(() => ({
		companyId,
		companyProfile,
		menuCapabilities,
		navigate,
		activeTab, setActiveTab: setActiveTabWithGuard,
		products, setProducts,
		categories, setCategories,
		orders, setOrders,
		clients, setClients,
		branches,
		selectedBranch, setSelectedBranch: setSelectedBranchWithGuard,
		assignedBranchId,
		isBranchLocked,
		isHistoryView, setIsHistoryView,
		historyPeriod, setHistoryPeriod,
		historyOrders, historyLoading, loadHistoryOrders,
		ordersViewMode, saveOrdersPanelSettings, ordersViewModeSaving, localOrderChannels, ordersPanelSettingsReady,
		isOpenMesaModal, setIsOpenMesaModal, manualOrderMode, setManualOrderMode,
		pendingTableSessionOrderId, setPendingTableSessionOrderId,
		pendingSeatReservation, setPendingSeatReservation,
		mobileTab, setMobileTab,
		searchQuery, setSearchQuery,
		filterCategory, setFilterCategory,
		filterStatus, setFilterStatus,
		viewMode, setViewMode,
		showProductPhotos, setShowProductPhotos,
		sortOrder, setSortOrder,
		loading, setLoading,
		refreshing, setRefreshing,
		isMobile, setIsMobile,
		isModalOpen, setIsModalOpen,
		editingProduct, setEditingProduct,
		isCategoryModalOpen, setIsCategoryModalOpen,
		editingCategory, setEditingCategory,
		receiptModalOrder, setReceiptModalOrder,
		receiptPreview, setReceiptPreview,
		uploadingReceipt, setUploadingReceipt,
		selectedClient, setSelectedClient,
		selectedClientOrders, setSelectedClientOrders,
		clientHistoryLoading, setClientHistoryLoading,
		userRole,
		showNotify,
		signOut: signOutAndClearDrafts,
		cashSystem,
		loadData,
		refreshAllData,
		refreshOrders,
		upsertOrder,
		refreshClients,
		refreshCatalog,
		refreshCatalogAndInventory,
		refreshBranches,
		hydrateOrderItems,
		handleSelectClient,
		moveOrder,
		closeOrderSession,
		markOrderSessionPaid,
		uploadReceiptToOrder,
		handleReceiptFileChange,
		handleSaveProduct,
		deleteProduct,
		toggleProductActive,
		scopeModal,
		handleScopeConfirm,
		setScopeModal,
		handleSaveCategory,
		deleteCategory,
		categoryToDelete,
		setCategoryToDelete,
		confirmDeleteCategory,
		toggleCategoryActive,
		reorderCategories,
		canAccessTab,
		getTabAccessDeniedMessage,
		panelAccess: normalizedPanelAccess,
		kanbanColumns,
		processedProducts,
		productStats,
		inventoryBranchRows,
		refreshInventoryBranch,
		branchExchangeRate,
		inventoryEnforceOnSale,
		dynamicModules: normalizedDynamicModules,
		resolvedTabLabels,
		adminShortcutsEnabled,
		lastDataRefreshAt,
		userEmail,
		productToDelete,
		setProductToDelete,
		confirmDeleteProduct,
	}), [
		companyId,
		companyProfile,
		menuCapabilities,
		navigate, activeTab, setActiveTabWithGuard, products, categories, orders, clients, branches, selectedBranch,
		isHistoryView, mobileTab, searchQuery, filterCategory, filterStatus, viewMode, showProductPhotos, setShowProductPhotos, sortOrder,
		historyPeriod, historyOrders, historyLoading, ordersViewMode, ordersViewModeSaving, saveOrdersPanelSettings, localOrderChannels, ordersPanelSettingsReady, isOpenMesaModal, manualOrderMode, pendingTableSessionOrderId, setPendingTableSessionOrderId, pendingSeatReservation, setPendingSeatReservation,
		loading, refreshing, isMobile, isModalOpen, editingProduct, isCategoryModalOpen, editingCategory,
		receiptModalOrder, receiptPreview, uploadingReceipt,
		selectedClient, selectedClientOrders, clientHistoryLoading, userRole, showNotify, signOutAndClearDrafts, cashSystem,
		loadData, refreshAllData, refreshOrders, upsertOrder, refreshClients, refreshCatalog, refreshCatalogAndInventory, refreshBranches, hydrateOrderItems, handleSelectClient, moveOrder, closeOrderSession, markOrderSessionPaid, uploadReceiptToOrder, handleReceiptFileChange,
		handleSaveProduct, deleteProduct, toggleProductActive, scopeModal, handleScopeConfirm, handleSaveCategory,
		deleteCategory, categoryToDelete, confirmDeleteCategory, toggleCategoryActive, reorderCategories,
		assignedBranchId, isBranchLocked, setSelectedBranchWithGuard, 		canAccessTab, getTabAccessDeniedMessage, normalizedPanelAccess, kanbanColumns, processedProducts, productStats, inventoryBranchRows, refreshInventoryBranch, branchExchangeRate, inventoryEnforceOnSale, normalizedDynamicModules,
		resolvedTabLabels, adminShortcutsEnabled, lastDataRefreshAt, userEmail, productToDelete, confirmDeleteProduct,
	]);

	return (
		<AdminContext.Provider value={value}>
			<OrderMoneyProvider>
				{children}
			</OrderMoneyProvider>
		</AdminContext.Provider>
	);
};
