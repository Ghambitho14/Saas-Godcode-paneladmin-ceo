import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, TABLES } from '@/integrations/supabase';
import {
	ORDERS_LIST_SELECT,
	sanitizeOrder,
	mergeOrderInMemory,
} from '@/shared/utils/orderUtils';
import { fetchOrderWithItems } from '../../services/analyticsService';
import {
	CATEGORIES_PANEL_SELECT,
	CLIENTS_PANEL_SELECT,
	PRODUCT_BRANCH_SELECT,
	PRODUCT_PRICES_BRANCH_SELECT,
	PRODUCTS_PANEL_SELECT,
} from '../../services/panelCatalogSelects';
import { INVENTORY_BRANCH_WITH_ITEM_SELECT } from '../../services/inventorySelects';
import { fetchAllPaginated, PANEL_PAGINATION_PAGE_SIZE } from '@/shared/utils/fetchAllPaginated';
import { mergeOrdersFromServer } from '../orders/mergeOrdersFromServer';
import { mergeCatalogForBranch } from '../catalog/mergeCatalogForBranch';
import { bumpLoadGeneration, createLoadGenerationRef, isLoadGenerationCurrent } from './loadGeneration';
import {
	initialBranchLoadScope,
	resolveStaleRefreshScope,
} from '../orders/panelDataScopes';
import { runPanelDataLoad, runStalePanelRefresh } from '../orders/panelDataLoader';
import {
	getBranchOverlay,
	getCompanyCatalog,
	invalidateAll,
	invalidateBranchOverlay,
	invalidateCompanyCatalog,
} from '../../services/panelCatalogCache';
import {
	getBranchOrders,
	getCompanyClients,
	invalidateAllPanelData,
	invalidateBranchOrders,
	invalidateCompanyClients,
	getBranchInventory,
	invalidateBranchInventory,
} from '../../services/panelDataCache';
import { monitor } from '@/shared/monitor';

/** Mínimo entre refrescos automáticos al volver al tab del navegador. */
const DATA_STALE_MS = 60_000;

/**
 * Carga y refresco de datos del panel (pedidos, clientes, catálogo, inventario).
 */
export function useAdminPanelLoad({
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
	forcePanelReloadRef: externalForcePanelReloadRef,
}) {
	const [lastDataRefreshAt, setLastDataRefreshAt] = useState(/** @type {number | null} */ (null));
	const [inventoryBranchRows, setInventoryBranchRows] = useState(/** @type {any[]} */ ([]));

	const lastDataRefreshAtRef = useRef(/** @type {number | null} */ (null));
	const loadGenerationRef = useRef(createLoadGenerationRef()).current;
	const orderMoveInFlightRef = useRef(/** @type {Set<string>} */ (new Set()));
	const fetchOrdersRef = useRef(/** @type {(opts?: { force?: boolean }) => Promise<void>} */ (async () => {}));
	const loadDataRef = useRef(/** @type {(isRefresh?: boolean, scope?: string) => Promise<void>} */ (async () => {}));
	const internalForcePanelReloadRef = useRef(/** @type {() => Promise<void>} */ (async () => {}));
	const forcePanelReloadRef = externalForcePanelReloadRef || internalForcePanelReloadRef;
	const loadedPanelScopeRef = useRef({
		orders: false,
		clients: false,
		catalog: false,
		inventorySummary: false,
	});
	const prevCompanyIdRef = useRef(null);

	const touchLastRefresh = useCallback(() => {
		const refreshedAt = Date.now();
		setLastDataRefreshAt(refreshedAt);
		lastDataRefreshAtRef.current = refreshedAt;
	}, []);

	const fetchCompanyCatalog = useCallback(async (options = {}) => {
		if (!companyId) return { categories: [], products: [] };
		return getCompanyCatalog(
			companyId,
			async () => {
				const [categories, products] = await Promise.all([
					fetchAllPaginated(supabase.from(TABLES.categories).select(CATEGORIES_PANEL_SELECT).eq('company_id', companyId).order('order'), { pageSize: PANEL_PAGINATION_PAGE_SIZE }),
					fetchAllPaginated(supabase.from(TABLES.products).select(PRODUCTS_PANEL_SELECT).eq('company_id', companyId).order('name'), { pageSize: PANEL_PAGINATION_PAGE_SIZE }),
				]);
				return { categories, products };
			},
			{ force: options.force },
		);
	}, [companyId]);

	const fetchBranchOverlay = useCallback(async (branchId, options = {}) => {
		if (!branchId || branchId === 'all' || !companyId) {
			return { categoryBranchRows: [], branchPrices: [], branchStatuses: [] };
		}
		return getBranchOverlay(
			branchId,
			async () => {
				const [categoryBranchRows, branchPrices, branchStatuses] = await Promise.all([
					fetchAllPaginated(supabase.from(TABLES.category_branch).select('category_id, order, is_active').eq('branch_id', branchId), { pageSize: PANEL_PAGINATION_PAGE_SIZE }),
					fetchAllPaginated(supabase.from(TABLES.product_prices).select(PRODUCT_PRICES_BRANCH_SELECT).eq('company_id', companyId).eq('branch_id', branchId), { pageSize: PANEL_PAGINATION_PAGE_SIZE }),
					fetchAllPaginated(supabase.from(TABLES.product_branch).select(PRODUCT_BRANCH_SELECT).eq('company_id', companyId).eq('branch_id', branchId), { pageSize: PANEL_PAGINATION_PAGE_SIZE }),
				]);
				return { categoryBranchRows, branchPrices, branchStatuses };
			},
			{ force: options.force },
		);
	}, [companyId]);

	const applyCatalogToState = useCallback((companyRaw, branchRaw, isAllBranches) => {
		const { categoriesData, mergedProducts } = mergeCatalogForBranch({
			companyRaw,
			branchRaw,
			isAllBranches,
		});
		console.log('[useAdminPanelLoad] applyCatalogToState categories=%s products=%s', categoriesData?.length, mergedProducts?.length);
		setCategories(categoriesData);
		setProducts(mergedProducts);
	}, [setCategories, setProducts]);

	const fetchOrders = useCallback(async ({ force = false, generation } = {}) => {
		if (!selectedBranchId || !companyId) return;
		console.log('[useAdminPanelLoad] fetchOrders start selectedBranchId=%s force=%s', selectedBranchId, force);
		const gen = generation ?? loadGenerationRef.current;
		const isAllBranches = selectedBranchId === 'all';
		const cleanOrders = await getBranchOrders(companyId, selectedBranchId, async () => {
			let query = supabase
				.from(TABLES.orders)
				.select(ORDERS_LIST_SELECT)
				.eq('company_id', companyId)
				.order('created_at', { ascending: false })
				.limit(100);
			if (!isAllBranches) {
				query = query.eq('branch_id', selectedBranchId);
			}
			const { data, error } = await query;
			if (error) throw error;
			return (data || []).map(sanitizeOrder);
		}, { force });
		if (!isLoadGenerationCurrent(loadGenerationRef, gen)) {
			console.log('[useAdminPanelLoad] fetchOrders aborted stale gen');
			return;
		}
		console.log('[useAdminPanelLoad] fetchOrders setting orders length=%s', cleanOrders?.length);
		setOrders((prev) =>
			orderMoveInFlightRef.current.size > 0
				? mergeOrdersFromServer(prev, cleanOrders, selectedBranchId)
				: cleanOrders,
		);
	}, [selectedBranchId, companyId, setOrders]);

	const hydrateOrderItems = useCallback(async (orderId) => {
		if (orderId == null || orderId === '' || !companyId) return null;
		const hydrated = await fetchOrderWithItems({ orderId, companyId });
		if (!hydrated) return null;
		const mergeHydrated = (prev) =>
			prev.map((o) => (o.id === hydrated.id ? { ...o, ...hydrated, items: hydrated.items } : o));
		setOrders(mergeHydrated);
		setHistoryOrders(mergeHydrated);
		setSelectedClientOrders(mergeHydrated);
		return hydrated;
	}, [companyId, setOrders, setHistoryOrders, setSelectedClientOrders]);

	const fetchClients = useCallback(async ({ force = false } = {}) => {
		if (!companyId) return;
		const data = await getCompanyClients(companyId, async () => {
			return fetchAllPaginated(
				supabase
					.from(TABLES.clients)
					.select(CLIENTS_PANEL_SELECT)
					.eq('company_id', companyId)
					.order('last_order_at', { ascending: false, nullsFirst: false }),
				{ pageSize: PANEL_PAGINATION_PAGE_SIZE },
			);
		}, { force });
		setClients(data || []);
	}, [companyId, setClients]);

	const refreshCatalogInner = useCallback(async ({ force = true } = {}) => {
		if (!selectedBranchId || !companyId) return;
		if (force) {
			invalidateCompanyCatalog(companyId);
			invalidateBranchOverlay(selectedBranchId);
		}
		const isAllBranches = selectedBranchId === 'all';
		const [companyRaw, branchRaw] = await Promise.all([
			fetchCompanyCatalog({ force }),
			fetchBranchOverlay(selectedBranchId, { force }),
		]);
		applyCatalogToState(companyRaw, branchRaw, isAllBranches);
	}, [selectedBranchId, companyId, fetchCompanyCatalog, fetchBranchOverlay, applyCatalogToState]);

	const refreshInventoryBranch = useCallback(async ({ force = false } = {}) => {
		if (!selectedBranchId || selectedBranchId === 'all' || !companyId) {
			setInventoryBranchRows([]);
			return;
		}
		if (force) {
			invalidateBranchInventory(selectedBranchId);
		}
		try {
			const rows = await getBranchInventory(selectedBranchId, async () => {
				return fetchAllPaginated(
					supabase
						.from(TABLES.inventory_branch)
						.select(INVENTORY_BRANCH_WITH_ITEM_SELECT)
						.eq('branch_id', selectedBranchId),
					{ pageSize: PANEL_PAGINATION_PAGE_SIZE },
				);
			}, { force });
			setInventoryBranchRows(rows);
		} catch (error) {
			console.warn('inventory_branch load:', error);
			setInventoryBranchRows([]);
		}
	}, [selectedBranchId, companyId]);

	const mergeLoadedScope = useCallback((prev, scope) => ({
		orders: prev.orders || scope.orders,
		clients: prev.clients || scope.clients,
		catalog: prev.catalog || scope.catalog,
		inventorySummary: prev.inventorySummary || scope.inventorySummary,
	}), []);

	const loadPanelData = useCallback(async (scopeOverride) => {
		if (!selectedBranchId || !companyId) return;
		const gen = loadGenerationRef.current;
		const scope = scopeOverride ?? initialBranchLoadScope(activeTab);
		const isAllBranches = selectedBranchId === 'all';

		await runPanelDataLoad({
			scope,
			isAllBranches,
			branchId: selectedBranchId,
			fetchCompanyCatalog: () => fetchCompanyCatalog(),
			fetchBranchOverlay: () => fetchBranchOverlay(selectedBranchId),
			applyCatalogToState: (companyRaw, branchRaw, isAll) => {
				if (!isLoadGenerationCurrent(loadGenerationRef, gen)) return;
				applyCatalogToState(companyRaw, branchRaw, isAll);
			},
			fetchOrders: () => fetchOrders({ generation: gen }),
			fetchClients: async () => {
				if (!isLoadGenerationCurrent(loadGenerationRef, gen)) return;
				await fetchClients();
			},
			refreshInventoryBranch: async () => {
				if (!isLoadGenerationCurrent(loadGenerationRef, gen)) return;
				await refreshInventoryBranch();
			},
		});

		if (!isLoadGenerationCurrent(loadGenerationRef, gen)) return;
		loadedPanelScopeRef.current = mergeLoadedScope(loadedPanelScopeRef.current, scope);
		touchLastRefresh();
	}, [
		activeTab,
		selectedBranchId,
		companyId,
		fetchCompanyCatalog,
		fetchBranchOverlay,
		applyCatalogToState,
		fetchOrders,
		fetchClients,
		refreshInventoryBranch,
		touchLastRefresh,
		mergeLoadedScope,
	]);

	const runPartialRefresh = useCallback(async (fn) => {
		if (!selectedBranch || !companyId) return;
		setRefreshing(true);
		try {
			await fn();
			touchLastRefresh();
		} catch {
			showNotify('Error de conexión', 'error');
		} finally {
			setRefreshing(false);
		}
	}, [selectedBranch, companyId, showNotify, touchLastRefresh, setRefreshing]);

	const refreshOrders = useCallback(
		() => runPartialRefresh(() => fetchOrders({ force: true })),
		[runPartialRefresh, fetchOrders],
	);

	const upsertOrder = useCallback((saved) => {
		if (selectedBranchId && companyId) {
			invalidateBranchOrders(companyId, selectedBranchId);
		}
		if (!saved?.id) {
			void refreshOrders();
			return;
		}
		setOrders((prev) => {
			const idx = prev.findIndex((o) => o.id === saved.id);
			const merged = mergeOrderInMemory(idx >= 0 ? prev[idx] : null, saved);
			if (idx === -1) return [merged, ...prev];
			return prev.map((o, i) => (i === idx ? merged : o));
		});
	}, [refreshOrders, companyId, selectedBranchId, setOrders]);

	useEffect(() => {
		fetchOrdersRef.current = fetchOrders;
	}, [fetchOrders]);

	const refreshClients = useCallback(
		() => runPartialRefresh(async () => {
			if (companyId) invalidateCompanyClients(companyId);
			await fetchClients({ force: true });
		}),
		[runPartialRefresh, fetchClients, companyId],
	);

	const refreshCatalog = useCallback(
		() => runPartialRefresh(() => refreshCatalogInner({ force: true })),
		[runPartialRefresh, refreshCatalogInner],
	);

	const refreshCatalogAndInventory = useCallback(
		() => runPartialRefresh(async () => {
			await refreshCatalogInner({ force: true });
			await refreshInventoryBranch({ force: true });
		}),
		[runPartialRefresh, refreshCatalogInner, refreshInventoryBranch],
	);

	const loadData = useCallback(async (isRefresh = false, scope = 'all') => {
		if (!selectedBranchId) return;
		if (!companyId) return;
		if (isRefresh) setRefreshing(true);
		else setLoading(true);
		try {
			switch (scope) {
				case 'orders':
					await fetchOrders();
					touchLastRefresh();
					break;
				case 'clients':
					await fetchClients();
					touchLastRefresh();
					break;
				case 'catalog':
					await refreshCatalogInner({ force: true });
					touchLastRefresh();
					break;
				case 'branch':
					await loadPanelData(initialBranchLoadScope(activeTab));
					break;
				default:
					await loadPanelData({
						orders: true,
						clients: true,
						catalog: true,
						inventorySummary: selectedBranchId !== 'all',
					});
			}
		} catch {
			monitor.error('data', 'load_failed', { scope, isRefresh });
			showNotify('Error de conexión', 'error');
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, [
		showNotify,
		selectedBranchId,
		companyId,
		loadPanelData,
		fetchOrders,
		fetchClients,
		refreshCatalogInner,
		touchLastRefresh,
		activeTab,
		setLoading,
		setRefreshing,
	]);

	useEffect(() => {
		loadDataRef.current = loadData;
		forcePanelReloadRef.current = async () => {
			bumpLoadGeneration(loadGenerationRef);
			loadedPanelScopeRef.current = {
				orders: false,
				clients: false,
				catalog: false,
				inventorySummary: false,
			};
			await loadPanelData({
				orders: true,
				clients: true,
				catalog: true,
				inventorySummary: selectedBranchId !== 'all',
			});
		};
	}, [loadData, loadPanelData, selectedBranchId]);

	const refreshStaleData = useCallback(async ({ force = false } = {}) => {
		if (!selectedBranchId || !companyId) return;
		const isAllBranches = selectedBranchId === 'all';
		const scope = resolveStaleRefreshScope(activeTab);
		await runStalePanelRefresh({
			scope,
			force,
			companyId,
			branchId: selectedBranchId,
			isAllBranches,
			fetchOrders,
			fetchClients,
			refreshCatalogInner,
			refreshInventoryBranch,
			invalidateCompanyCatalog,
			invalidateBranchOverlay,
		});
		touchLastRefresh();
	}, [
		activeTab,
		selectedBranchId,
		companyId,
		fetchOrders,
		fetchClients,
		refreshCatalogInner,
		refreshInventoryBranch,
		touchLastRefresh,
	]);

	const refreshAllData = useCallback(async () => {
		if (!selectedBranch || !companyId) return;
		setRefreshing(true);
		try {
			await Promise.all([
				refreshStaleData({ force: true }),
				refetchBranches?.() ?? Promise.resolve(),
				cashSystem?.refresh?.() ?? Promise.resolve(),
			]);
		} catch {
			monitor.error('data', 'refresh_all_failed', {});
			showNotify('Error de conexión', 'error');
		} finally {
			setRefreshing(false);
		}
	}, [selectedBranch, companyId, refreshStaleData, refetchBranches, cashSystem, showNotify, setRefreshing]);

	useEffect(() => {
		if (prevCompanyIdRef.current && prevCompanyIdRef.current !== companyId) {
			invalidateAll();
			invalidateAllPanelData();
		}
		prevCompanyIdRef.current = companyId;
	}, [companyId]);

	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState !== 'visible') return;
			if (isModalOpenRef?.current || editingProductRef?.current) return;
			void refreshOrders().catch(() => {
				showNotify('Error de conexión', 'error');
			});
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	}, [refreshOrders, showNotify, isModalOpenRef, editingProductRef]);

	return useMemo(() => ({
		lastDataRefreshAt,
		inventoryBranchRows,
		loadGenerationRef,
		loadedPanelScopeRef,
		loadDataRef,
		fetchOrdersRef,
		forcePanelReloadRef,
		orderMoveInFlightRef,
		lastDataRefreshAtRef,
		loadPanelData,
		loadData,
		refreshAllData,
		refreshOrders,
		refreshClients,
		refreshCatalog,
		refreshCatalogAndInventory,
		refreshInventoryBranch,
		refreshCatalogInner,
		refreshStaleData,
		upsertOrder,
		hydrateOrderItems,
		fetchOrders,
	}), [
		lastDataRefreshAt,
		inventoryBranchRows,
		loadGenerationRef,
		loadedPanelScopeRef,
		loadDataRef,
		fetchOrdersRef,
		forcePanelReloadRef,
		orderMoveInFlightRef,
		lastDataRefreshAtRef,
		loadPanelData,
		loadData,
		refreshAllData,
		refreshOrders,
		refreshClients,
		refreshCatalog,
		refreshCatalogAndInventory,
		refreshInventoryBranch,
		refreshCatalogInner,
		refreshStaleData,
		upsertOrder,
		hydrateOrderItems,
		fetchOrders,
	]);
}
