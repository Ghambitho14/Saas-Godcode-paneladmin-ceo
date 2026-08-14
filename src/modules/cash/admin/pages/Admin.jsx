import React, { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Loader2, Search, Filter,
  Package, PlusCircle, X, Trash2, Plus, Edit, RefreshCw, List, ShoppingBag, Tag, LayoutGrid, ArrowUpDown, Eye, EyeOff, Upload, HelpCircle, Store, Image, ImageOff,
} from 'lucide-react';
import AdminSidebar from '../../components/AdminSidebar';
import OrderDetailModal from '../../components/OrderDetailModal';
import ScopeSelectionModal from '../../components/ScopeSelectionModal';
import TenantTicketsPanel from '../../components/TenantTicketsPanel';
import AdminErrorBoundary from '../../components/AdminErrorBoundary';
import AdminCommandPalette from '../../components/AdminCommandPalette';
import AdminShortcutsModal from '../../components/AdminShortcutsModal';
import AdminTabFallback from '../../components/AdminTabFallback';
import AdminBroadcastsBanner from '../../components/AdminBroadcastsBanner';
import AdminMenuChannelBanner from '../../components/AdminMenuChannelBanner';
import AdminTopBar from '../../components/AdminTopBar';
import AdminNotificationCenter from '../../components/AdminNotificationCenter';
import AdminBranchSelector from '../../components/AdminBranchSelector';
import AdminHeaderClock from '../../components/AdminHeaderClock';
import OrderIntakePauseControl from '../../components/OrderIntakePauseControl';
import OrderNotificationSoundControl from '../../components/OrderNotificationSoundControl';
import PaymentReceiptPanel from '../../components/PaymentReceiptPanel';
import { isModKey, isTypingContext } from '../utils/keyboardAdmin';
import { ADMIN_PANEL_TAB_IDS } from '@/shared/constants/admin-panel-tabs';
import { listBroadcasts, acknowledgeBroadcast as acknowledgeBroadcastService } from '../../services/broadcastsService';

const AdminAnalyticsTab = React.lazy(() => import('../tabs/analytics'));
const AdminClients = React.lazy(() => import('../../components/AdminClients'));
const AdminInventory = React.lazy(() => import('../tabs/inventory'));
const CashManager = React.lazy(() => import('../../components/caja/CashManager'));
const AdminCoupons = React.lazy(() => import('../../components/AdminCoupons'));
const AdminMenuOptions = React.lazy(() => import('../../components/AdminMenuOptions'));
const AdminMenuBeverages = React.lazy(() => import('../../components/AdminMenuBeverages'));
const AdminMenuExtras = React.lazy(() => import('../../components/AdminMenuExtras'));
const AdminOrdersTab = React.lazy(() => import('../tabs/orders'));
const AdminProductsTab = React.lazy(() => import('../tabs/products'));
const AdminCategoriesTab = React.lazy(() => import('../tabs/categories'));
const AdminLocalExpensesTab = React.lazy(() => import('../tabs/local-expenses'));
const ManualOrderModal = React.lazy(() => import('../../components/ManualOrderModal'));
const ProductModal = React.lazy(() => import('../products/components/ProductModal'));
const CategoryModal = React.lazy(() => import('../products/components/CategoryModal'));
const ClientDetailsPanel = React.lazy(() => import('../../components/ClientDetailsPanel'));
import { supabase, TABLES } from '@/integrations/supabase';
import { AdminProvider, useAdmin } from './AdminProvider';
import { Toaster } from 'sileo';
import 'sileo/styles.css';
import '../../styles/AdminSileo.css';
import { Button } from "@/components/ui/button";
import { resolveEffectiveCountry } from '@/lib/geo/tenant-locale';

export const AdminPage = ({ companyName, logoUrl, userEmail: initialEmail, primaryColor, storefrontMenuUrl = null }) => {
  const {
    navigate,
    activeTab, setActiveTab,
    products,
    categories,
    orders,
    clients,
    branches,
    selectedBranch, setSelectedBranch,
    isBranchLocked,
    isHistoryView, setIsHistoryView,
    ordersViewMode,
    ordersPanelSettingsReady,
    localOrderChannels,
    historyPeriod, setHistoryPeriod,
    historyOrders, historyLoading,
    isOpenMesaModal, setIsOpenMesaModal, manualOrderMode, setManualOrderMode,
    pendingSeatReservation, setPendingSeatReservation,
    mobileTab, setMobileTab,
    searchQuery, setSearchQuery,
    filterCategory, setFilterCategory,
    filterStatus, setFilterStatus,
    viewMode, setViewMode,
    showProductPhotos, setShowProductPhotos,
    sortOrder, setSortOrder,
    refreshing,
    isMobile,
    isModalOpen, setIsModalOpen,
    editingProduct, setEditingProduct,
    isCategoryModalOpen, setIsCategoryModalOpen,
    editingCategory, setEditingCategory,
    receiptModalOrder, setReceiptModalOrder,
    receiptPreview, setReceiptPreview,
    uploadingReceipt,
    selectedClient, setSelectedClient,
    selectedClientOrders,
    clientHistoryLoading,
    showNotify,
    loadData,
    refreshAllData,
    refreshOrders,
    upsertOrder,
    refreshClients,
    refreshCatalog,
    refreshCatalogAndInventory,
    refreshBranches,
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
    kanbanColumns,
    processedProducts,
    productStats,
    userRole,
    userEmail,
    signOut,
    dynamicModules,
    canAccessTab,
    getTabAccessDeniedMessage,
    panelAccess,
    productToDelete,
    setProductToDelete,
    confirmDeleteProduct,
    reorderCategories,
    toggleCategoryActive,
    resolvedTabLabels,
    adminShortcutsEnabled,
    menuCapabilities,
    companyProfile,
    lastDataRefreshAt,
    loading,
    inventoryBranchRows,
    companyId,
    cashSystem,
  } = useAdmin();

  const tabLabels = React.useMemo(() => resolvedTabLabels || {}, [resolvedTabLabels]);
  const sidebarTabAccessContext = React.useMemo(() => ({
    userRole,
    normalizedPanelAccess: panelAccess,
    menuCapabilities,
    dynamicModules,
  }), [userRole, panelAccess, menuCapabilities, dynamicModules]);
  const [clientOrderDetail, setClientOrderDetail] = React.useState(null);
  const [manualOrderOpeningMode, setManualOrderOpeningMode] = React.useState(null);

  const openManualOrder = React.useCallback(async (mode) => {
    if (manualOrderOpeningMode) return;
    setManualOrderOpeningMode(mode);
    try {
      // Evita montar el modal con un catálogo parcial o todavía vacío.
      await refreshCatalog();
      setManualOrderMode(mode);
      setIsOpenMesaModal(true);
    } finally {
      setManualOrderOpeningMode(null);
    }
  }, [manualOrderOpeningMode, refreshCatalog, setManualOrderMode, setIsOpenMesaModal]);

  const handleManualOrderSaved = React.useCallback(async (savedOrder) => {
    upsertOrder(savedOrder);
    void refreshClients();
    if (pendingSeatReservation?.id && savedOrder?.id) {
      try {
        const { tableReservationsService } = await import('../../services/tableReservationsService');
        await tableReservationsService.seat(pendingSeatReservation.id, { orderId: savedOrder.id });
        showNotify?.('Reserva marcada como sentada', 'success');
      } catch (e) {
        showNotify?.(e instanceof Error ? e.message : 'Pedido creado, pero no se pudo actualizar la reserva', 'warning');
      } finally {
        setPendingSeatReservation(null);
      }
    }
    // Pedido, inventario, pago y caja ya fueron confirmados por la misma RPC.
    void cashSystem?.refresh?.();
    return true;
  }, [cashSystem, upsertOrder, refreshClients, pendingSeatReservation, setPendingSeatReservation, showNotify]);

  React.useEffect(() => {
    if (!selectedClient) setClientOrderDetail(null);
  }, [selectedClient]);

  const nextCategoryOrder = React.useMemo(() => {
    const maxOrder = categories.reduce((maxValue, cat) => {
      const value = Number(cat.order);
      if (!Number.isFinite(value)) return maxValue;
      return Math.max(maxValue, value);
    }, 0);
    return maxOrder + 1;
  }, [categories]);

  const companyIdForClients = React.useMemo(() => {
    if (selectedBranch && selectedBranch.id !== 'all' && selectedBranch.company_id) {
      return selectedBranch.company_id;
    }
    const fallback = (branches || []).find(b => b.id !== 'all' && b.company_id);
    return fallback?.company_id || null;
  }, [selectedBranch, branches]);

  const [broadcasts, setBroadcasts] = React.useState([]);
  const [broadcastsLoading, setBroadcastsLoading] = React.useState(false);
  const [ackingId, setAckingId] = React.useState(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = React.useState(false);

  const dynamicModuleByTab = React.useMemo(() => {
    const map = new Map();
    (dynamicModules || []).forEach((module) => {
      if (module?.tabId) {
        map.set(module.tabId, module);
      }
    });
    return map;
  }, [dynamicModules]);

  const activeDynamicModule = dynamicModuleByTab.get(activeTab) || null;

  const hideOrdersHeaderTitle = activeTab === 'orders' && !isHistoryView;

  const pageTitle = React.useMemo(() => {
    if (activeTab === 'orders') return isHistoryView ? 'Historial' : (tabLabels.orders || 'Pedidos');
    if (activeTab === 'caja') {
      const c = tabLabels.caja || 'Caja';
      return `${c} y Turnos`;
    }
    if (activeTab === 'analytics') return tabLabels.analytics || 'Reportes';
    if (activeTab === 'local_expenses') return tabLabels.local_expenses || 'Gastos del local';
    if (activeDynamicModule) return tabLabels[activeTab] || activeDynamicModule.label;
    return tabLabels[activeTab] || activeTab;
  }, [activeTab, activeDynamicModule, isHistoryView, tabLabels]);

  const lastSyncLabel = React.useMemo(() => {
    if (!lastDataRefreshAt) return null;
    try {
      return new Date(lastDataRefreshAt).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'medium' });
    } catch {
      return null;
    }
  }, [lastDataRefreshAt]);

  const paletteItems = React.useMemo(() => {
    const core = ADMIN_PANEL_TAB_IDS.filter((id) => canAccessTab(id)).map((id) => ({
      id,
      label: tabLabels[id] || id,
      group: 'Panel',
    }));
    const mods = (dynamicModules || [])
      .filter((m) => canAccessTab(m.tabId))
      .map((m) => ({
        id: m.tabId,
        label: tabLabels[m.tabId] || m.label,
        group: 'Módulos',
      }));
    return [...core, ...mods];
  }, [canAccessTab, dynamicModules, tabLabels]);

  const shortcutRows = React.useMemo(() => {
    if (!adminShortcutsEnabled) return [];
    const base = [
      { keys: 'Mod + K', description: 'Buscar sección', group: 'General' },
      { keys: 'Mod + Shift + R', description: 'Actualizar datos del panel', group: 'General' },
      { keys: '?', description: 'Mostrar atajos', group: 'General' },
      { keys: 'Esc', description: 'Cerrar ventanas emergentes', group: 'General' },
    ];
    if (activeTab === 'inventory' && canAccessTab('inventory')) {
      base.push(
        { keys: '1 · 2 · 3 · 4', description: 'Resumen, Artículos, Movimientos, Recetas / Consumo', group: 'Inventario' },
      );
    }
    return base;
  }, [adminShortcutsEnabled, activeTab, canAccessTab]);

  const loadBroadcasts = React.useCallback(async () => {
    setBroadcastsLoading(true);
    try {
      const items = await listBroadcasts();
      setBroadcasts(Array.isArray(items) ? items : []);
    } catch {
      setBroadcasts([]);
    } finally {
      setBroadcastsLoading(false);
    }
  }, []);

  const handleRefreshAll = React.useCallback(() => {
    void refreshAllData();
    void loadBroadcasts();
  }, [refreshAllData, loadBroadcasts]);

  React.useEffect(() => {
    if (!adminShortcutsEnabled) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setCommandPaletteOpen(false);
        setShortcutsHelpOpen(false);
        return;
      }
      if (isTypingContext(e.target)) return;
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShortcutsHelpOpen((open) => !open);
        setCommandPaletteOpen(false);
        return;
      }
      if (isModKey(e) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
        setShortcutsHelpOpen(false);
        return;
      }
      if (isModKey(e) && e.shiftKey && String(e.key).toLowerCase() === 'r') {
        e.preventDefault();
        handleRefreshAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [adminShortcutsEnabled, handleRefreshAll]);

  React.useEffect(() => {
    void loadBroadcasts();
  }, [loadBroadcasts]);

  const acknowledgeBroadcast = async (broadcastId) => {
    if (!broadcastId) return;

    setAckingId(broadcastId);
    try {
      await acknowledgeBroadcastService(broadcastId);
      setBroadcasts((prev) => prev.map((item) => (
        item.id === broadcastId
          ? { ...item, readAt: new Date().toISOString() }
          : item
      )));
      showNotify('Comunicado marcado como leído.');
    } catch (err) {
      showNotify(err instanceof Error ? err.message : 'No se pudo registrar el acuse', 'error');
    } finally {
      setAckingId(null);
    }
  };

  const [toastPortal, setToastPortal] = useState(null);
  useEffect(() => {
    setToastPortal(document.body);
  }, []);

  return (
    <>
      {toastPortal &&
        createPortal(
          <Toaster
            position="top-center"
            options={{
              fill: '#ffffff',
              roundness: 14,
            }}
          />,
          toastPortal,
        )}

      <div className="admin-layout">
        {productToDelete && (
        <div className="admin-modal-overlay" onClick={() => setProductToDelete(null)}>
          <div className="admin-confirm-modal" onClick={e => e.stopPropagation()}>
            <p>¿Eliminar producto?</p>
            <div className="admin-confirm-modal__actions">
              <Button variant="secondary" type="button" className="admin-btn secondary" onClick={() => setProductToDelete(null)}>Cancelar</Button>
              <Button variant="destructive" type="button" className="admin-btn danger" onClick={confirmDeleteProduct}>Eliminar</Button>
            </div>
          </div>
        </div>
      )}

      {categoryToDelete && (
        <div className="admin-modal-overlay" onClick={() => setCategoryToDelete(null)}>
          <div className="admin-confirm-modal" onClick={e => e.stopPropagation()}>
            <p>¿Eliminar categoría &quot;{categoryToDelete.name}&quot;? Los productos quedarán sin categoría.</p>
            <div className="admin-confirm-modal__actions">
              <Button variant="secondary" type="button" className="admin-btn secondary" onClick={() => setCategoryToDelete(null)}>Cancelar</Button>
              <Button variant="destructive" type="button" className="admin-btn danger" onClick={confirmDeleteCategory}>Eliminar</Button>
            </div>
          </div>
        </div>
      )}

      <AdminSidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isMobile={isMobile}
        kanbanColumns={kanbanColumns}
        userRole={userRole}
        canAccessTab={canAccessTab}
        getTabDeniedMessage={getTabAccessDeniedMessage}
        tabAccessContext={sidebarTabAccessContext}
        onDeniedAccess={(tabId) => showNotify(getTabAccessDeniedMessage(tabId) || 'Necesitás un rol diferente para acceder a esta sección.', 'error')}
        userEmail={userEmail || initialEmail}
        branchName={selectedBranch?.name}
        logoUrl={logoUrl}
        dynamicModules={dynamicModules}
        storefrontMenuUrl={storefrontMenuUrl}
        tabLabelsById={tabLabels}
        onStorefrontMissing={() => showNotify('No encontramos la URL del menú público. Revisá el slug de la empresa en GodCode.', 'error')}
        onLogout={signOut}
      />

      <main className="admin-content">
        <AdminTopBar
          title={pageTitle}
          hideTitleVisual={hideOrdersHeaderTitle}
          clusterClassName={activeTab === 'orders' ? 'header-actions-cluster--orders' : ''}
        >
            <div className="header-actions-toolbar-row">
              <AdminNotificationCenter
                broadcasts={broadcasts}
                broadcastsLoading={broadcastsLoading}
                ackingId={ackingId}
                onAcknowledge={acknowledgeBroadcast}
                inventoryBranchRows={inventoryBranchRows}
                products={products}
                selectedBranch={selectedBranch}
                setActiveTab={setActiveTab}
                setEditingProduct={setEditingProduct}
                setIsModalOpen={setIsModalOpen}
                canAccessInventory={canAccessTab('inventory')}
                canAccessProducts={canAccessTab('products')}
              />
              <OrderNotificationSoundControl />
              {adminShortcutsEnabled ? (
                <Button variant="default"
                  type="button"
                  className="btn-icon-refresh header-action-shortcuts"
                  onClick={() => { setShortcutsHelpOpen(true); setCommandPaletteOpen(false); }}
                  title="Atajos de teclado (?)"
                  aria-label="Atajos de teclado"
                >
                  <HelpCircle size={24} strokeWidth={1.65} aria-hidden />
                </Button>
              ) : null}
              <Button variant="default"
                type="button"
                onClick={handleRefreshAll}
                className="btn-icon-refresh header-action-refresh"
                disabled={refreshing}
                title="Actualizar datos (Mod+Shift+R)"
                aria-label="Actualizar datos"
              >
                <RefreshCw size={24} strokeWidth={1.65} className={refreshing ? 'animate-spin' : ''} />
              </Button>
            </div>

            <AdminHeaderClock dataSyncedAtLabel={lastSyncLabel} className="header-action-clock" />

            <AdminBranchSelector
              branches={branches}
              selectedBranch={selectedBranch}
              onSelectBranch={setSelectedBranch}
              disabled={isBranchLocked}
              allowAllOption={activeTab === 'analytics' || activeTab === 'local_expenses'}
              lockTitle="Tu correo está bloqueado a una sucursal específica."
              className="header-action-branch"
            />

            {activeTab === 'orders' && (
              <div className="header-actions-orders-row">
                <OrderIntakePauseControl
                  branchId={selectedBranch?.id}
                  showNotify={showNotify}
                  disabled={!selectedBranch || selectedBranch.id === 'all'}
                  disabledReason={
                    selectedBranch?.id === 'all'
                      ? 'Selecciona una sucursal concreta para pausar pedidos online'
                      : !selectedBranch
                        ? 'Selecciona una sucursal'
                        : ''
                  }
                />
                <Button variant="default"
                  type="button"
                  className={`btn header-action-orders-history ${isHistoryView ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setIsHistoryView(!isHistoryView)}
                >
                  {isHistoryView ? 'Ver Tablero' : 'Ver Historial'}
                </Button>
                <Button variant="default"
                  type="button"
                  onClick={() => { void openManualOrder('quick_sale'); }}
                  className="btn header-action-orders-manual"
                  disabled={selectedBranch?.id === 'all' || !selectedBranch || Boolean(manualOrderOpeningMode)}
                  title={selectedBranch?.id === 'all' ? 'Selecciona una sucursal' : undefined}
                >
                  {manualOrderOpeningMode === 'quick_sale'
                    ? <Loader2 size={18} className="animate-spin" />
                    : <PlusCircle size={18} />}
                  {manualOrderOpeningMode === 'quick_sale' ? ' Cargando…' : ' Pedido manual'}
                </Button>
                {ordersViewMode === 'mesas' ? (
                  <Button variant="secondary"
                    type="button"
                    onClick={() => { void openManualOrder('session'); }}
                    className="btn header-action-orders-session"
                    disabled={selectedBranch?.id === 'all' || !selectedBranch || Boolean(manualOrderOpeningMode)}
                    title={selectedBranch?.id === 'all' ? 'Selecciona una sucursal' : undefined}
                  >
                    {manualOrderOpeningMode === 'session'
                      ? <Loader2 size={18} className="animate-spin" />
                      : <Store size={18} />}
                    {manualOrderOpeningMode === 'session' ? ' Cargando…' : ' Abrir mesa'}
                  </Button>
                ) : null}
              </div>
            )}
            {activeTab === 'products' && (
              <Button variant="default"
                type="button"
                onClick={() => { setEditingProduct(null); setIsModalOpen(true); }}
                className="btn header-action-generic"
                disabled={!selectedBranch || selectedBranch.id === 'all'}
                title={selectedBranch?.id === 'all' ? 'Selecciona una sucursal' : undefined}
              >
                <Plus size={18} /> Nuevo Producto
              </Button>
            )}
            {activeTab === 'categories' && (
              <Button variant="default"
                type="button"
                onClick={() => { setEditingCategory(null); setIsCategoryModalOpen(true); }}
                className="btn header-action-generic"
                disabled={!selectedBranch || selectedBranch.id === 'all'}
                title={selectedBranch?.id === 'all' ? 'Selecciona una sucursal' : undefined}
              >
                <Plus size={18} /> Nueva Categ.
              </Button>
            )}
        </AdminTopBar>

        <AdminBroadcastsBanner
          broadcasts={broadcasts}
          broadcastsLoading={broadcastsLoading}
          ackingId={ackingId}
          onAcknowledge={acknowledgeBroadcast}
        />

        <AdminMenuChannelBanner menuCapabilities={menuCapabilities} />

        {branches.length === 0 && !loading ? (
          <div className="admin-empty-branches glass animate-fade" role="status">
            <div className="admin-empty-branches__icon" aria-hidden>
              <Store size={40} strokeWidth={1.5} />
            </div>
            <h2 className="admin-empty-branches__title">No hay sucursales</h2>
            <p className="admin-empty-branches__text">
              Esta empresa aún no tiene locales configurados en el sistema, o no pudimos cargarlos.
              Las sucursales se crean desde el panel de administración SaaS; cuando existan, podrás gestionar pedidos, menú y caja por local.
            </p>
            <Button variant="default"
              type="button"
              className="admin-btn primary admin-empty-branches__retry"
              onClick={() => void refreshBranches()}
            >
              <RefreshCw size={18} strokeWidth={1.65} />
              Reintentar carga
            </Button>
          </div>
        ) : branches.length === 0 ? (
          <AdminTabFallback />
        ) : (
        <>
        {activeTab === 'orders' && (
          <React.Suspense fallback={<AdminTabFallback />}>
            <AdminOrdersTab logoUrl={logoUrl} companyName={companyName} />
          </React.Suspense>
        )}

        {activeTab === 'products' && (
          <React.Suspense fallback={<AdminTabFallback />}>
            <AdminProductsTab />
          </React.Suspense>
        )}

        {/* 2.5 NUEVO INVENTARIO (INSUMOS) */}
        {activeTab === 'inventory' && (
          <AdminErrorBoundary tabLabel={tabLabels.inventory || 'Inventario'} onRetry={() => refreshCatalogAndInventory()}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminInventory
                showNotify={showNotify}
                branchId={selectedBranch?.id}
                branches={branches}
                companyId={companyIdForClients}
                products={products}
                categories={categories}
                prefetchedBranchStock={inventoryBranchRows}
                onRefreshCatalog={() => refreshCatalogAndInventory()}
              />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'menu_options' && (
          <AdminErrorBoundary tabLabel={tabLabels.menu_options || 'Opciones de sucursal'} onRetry={() => void refreshBranches()}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminMenuOptions
                showNotify={showNotify}
                selectedBranch={selectedBranch}
                companyId={companyIdForClients}
                onDeliverySaved={() => void refreshBranches()}
              />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'menu_beverages' && (
          <AdminErrorBoundary tabLabel={tabLabels.menu_beverages || 'Bebidas'} onRetry={() => void refreshBranches()}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminMenuBeverages
                showNotify={showNotify}
                selectedBranch={selectedBranch}
                companyId={companyIdForClients}
                onSaved={() => void refreshBranches()}
              />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'menu_extras' && (
          <AdminErrorBoundary tabLabel={tabLabels.menu_extras || 'Extras'} onRetry={() => void refreshBranches()}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminMenuExtras
                showNotify={showNotify}
                selectedBranch={selectedBranch}
                companyId={companyIdForClients}
                onSaved={() => void refreshBranches()}
              />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'analytics' && (
          <AdminErrorBoundary
            tabLabel={tabLabels.analytics || 'Reportes'}
            onRetry={() => loadData(true)}
          >
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminAnalyticsTab />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'local_expenses' && (
          <React.Suspense fallback={<AdminTabFallback />}>
            <AdminLocalExpensesTab logoUrl={logoUrl} companyName={companyName} />
          </React.Suspense>
        )}

        {/* 4. CLIENTES */}
        {activeTab === 'clients' && (
          <AdminErrorBoundary tabLabel={tabLabels.clients || 'Clientes'} onRetry={() => refreshClients()}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminClients
                clients={clients}
                orders={orders}
                onSelectClient={handleSelectClient}
                onClientCreated={() => refreshClients()}
                onClientDeleted={() => refreshClients()}
                showNotify={showNotify}
                companyId={companyIdForClients}
              />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'coupons' && (
          <AdminErrorBoundary tabLabel={tabLabels.coupons || 'Cupones'} onRetry={() => refreshAllData()}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <AdminCoupons showNotify={showNotify} companyId={companyIdForClients} clients={clients} />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeDynamicModule && activeDynamicModule.tabId === 'module:tickets' && (
          <AdminErrorBoundary tabLabel={tabLabels['module:tickets'] || activeDynamicModule.label || 'Soporte'} onRetry={() => refreshAllData()}>
            <TenantTicketsPanel showNotify={showNotify} />
          </AdminErrorBoundary>
        )}

        {activeDynamicModule && activeDynamicModule.tabId !== 'module:tickets' && (
          <AdminErrorBoundary tabLabel={tabLabels[activeDynamicModule.tabId] || activeDynamicModule.label || 'Módulo'} onRetry={() => refreshAllData()}>
          <div className="glass admin-dynamic-module">
            <div>
              <p className="admin-dynamic-module__desc">
                {activeDynamicModule.description || 'Módulo agregado desde SaaS. Aquí vivirá la nueva funcionalidad del panel admin.'}
              </p>
            </div>
            <div className="admin-dynamic-module__placeholder">
              <p>
                Este espacio está listo para implementar la lógica del módulo <strong>{activeDynamicModule.label}</strong>.
              </p>
            </div>
          </div>
          </AdminErrorBoundary>
        )}

        {/* 4.5 CAJA */}
        {activeTab === 'caja' && (
          <AdminErrorBoundary tabLabel={tabLabels.caja || 'Caja'} onRetry={handleRefreshAll}>
            <React.Suspense fallback={<AdminTabFallback />}>
              <CashManager
                showNotify={showNotify}
                selectedBranchId={selectedBranch?.id}
                selectedBranch={selectedBranch}
                orders={orders}
                logoUrl={logoUrl}
                companyName={companyName}
              />
            </React.Suspense>
          </AdminErrorBoundary>
        )}

        {activeTab === 'categories' && (
          <React.Suspense fallback={<AdminTabFallback />}>
            <AdminCategoriesTab />
          </React.Suspense>
        )}
        </>
        )}

        <AdminCommandPalette
          open={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
          items={paletteItems}
          onSelect={(id) => setActiveTab(id)}
        />
        <AdminShortcutsModal
          open={shortcutsHelpOpen}
          onClose={() => setShortcutsHelpOpen(false)}
          rows={shortcutRows}
        />
      </main>

      {/* PANEL CLIENTE LATERAL (MODULARIZADO) */}
      {selectedClient && (
        <React.Suspense fallback={null}>
          <ClientDetailsPanel
            selectedClient={selectedClient}
            setSelectedClient={setSelectedClient}
            clientHistoryLoading={clientHistoryLoading}
            selectedClientOrders={selectedClientOrders}
            setReceiptModalOrder={setReceiptModalOrder}
            onOrderClick={(order) => setClientOrderDetail(order)}
            orderDetailOpen={Boolean(clientOrderDetail)}
            formCountry={resolveEffectiveCountry(selectedBranch, companyProfile)}
          />
        </React.Suspense>
      )}

      {clientOrderDetail ? (
        <OrderDetailModal
          order={clientOrderDetail}
          onClose={() => setClientOrderDetail(null)}
          branch={selectedBranch}
          logoUrl={logoUrl}
          companyName={companyName}
          showNotify={showNotify}
          setReceiptModalOrder={setReceiptModalOrder}
        />
      ) : null}



      {/* VISOR Y CARGA DE COMPROBANTES */}
      {receiptModalOrder && (
        <PaymentReceiptPanel
          order={receiptModalOrder}
          preview={receiptPreview}
          uploading={uploadingReceipt}
          onFileChange={handleReceiptFileChange}
          onClearPreview={() => {
            if (receiptPreview) URL.revokeObjectURL(receiptPreview);
            setReceiptPreview(null);
          }}
          onSave={(file) => uploadReceiptToOrder(receiptModalOrder.id, file)}
          onClose={() => {
            if (receiptPreview) URL.revokeObjectURL(receiptPreview);
            setReceiptModalOrder(null);
            setReceiptPreview(null);
          }}
        />
      )}


      {isOpenMesaModal && (
        <React.Suspense fallback={null}>
          <ManualOrderModal
            isOpen={isOpenMesaModal}
            onClose={() => {
              setIsOpenMesaModal(false);
              setPendingSeatReservation(null);
            }}
            products={products}
            categories={categories}
            clients={clients}
            onOrderSaved={handleManualOrderSaved}
            showNotify={showNotify}
            branch={selectedBranch}
            logoUrl={logoUrl}
            companyName={companyName}
            openMesaMode={manualOrderMode === 'session'}
            localOrderChannels={localOrderChannels}
          />
        </React.Suspense>
      )}

      {isModalOpen && (
        <React.Suspense fallback={null}>
          <ProductModal
            key={`product-modal-${editingProduct?.id ?? 'new'}`}
            onClose={() => setIsModalOpen(false)}
            onSave={handleSaveProduct}
            product={editingProduct}
            categories={categories}
            saving={refreshing}
          />
        </React.Suspense>
      )}

      {/* MODAL DE SELECCIÓN DE ALCANCE */}
      <ScopeSelectionModal
        isOpen={scopeModal.isOpen}
        onClose={() => setScopeModal({ ...scopeModal, isOpen: false })}
        onConfirm={handleScopeConfirm}
        branchName={selectedBranch?.name || 'Sucursal'}
        actionType={scopeModal.item?.is_active ? 'deactivate' : 'activate'}
      />

      {isCategoryModalOpen && (
        <React.Suspense fallback={null}>
          <CategoryModal
            isOpen={isCategoryModalOpen}
            onClose={() => setIsCategoryModalOpen(false)}
            onSave={handleSaveCategory}
            category={editingCategory}
            defaultOrder={editingCategory ? editingCategory.order : nextCategoryOrder}
          />
        </React.Suspense>
      )}
    </div>
  </>
  );
};

const Admin = () => (
  <AdminProvider companyName={companyName} logoUrl={logoUrl}>
    <AdminPage />
  </AdminProvider>
);

export default Admin;
