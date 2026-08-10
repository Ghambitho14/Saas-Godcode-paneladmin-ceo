import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { ChefHat, ShoppingBag, BarChart3, Users, List, LogOut, DollarSign, Store, ChevronDown, ClipboardList, Blocks, SlidersHorizontal, Calculator, FolderTree, CupSoda, Sparkles, Tag, Wallet } from 'lucide-react';
import { getSafeLogoImageSrc } from '@/shared/utils/documentFavicon';
import { ADMIN_PANEL_TAB_IDS } from '@/shared/constants/admin-panel-tabs';
import { resolveSidebarRestrictedHint } from '../admin/utils/tabAccessMessages';

const SidebarIcon = ({ Icon, size }) => (
    <span className="nav-icon-slot">
        <Icon size={size} strokeWidth={1.65} aria-hidden />
    </span>
);

const SIDEBAR_LOGO_PLACEHOLDER = '/favicon.png';

const AdminSidebar = ({ activeTab, setActiveTab, isMobile, kanbanColumns, userRole, onLogout, onStorefrontMissing, userEmail, branchName, logoUrl, canAccessTab, getTabDeniedMessage, onDeniedAccess, tabAccessContext, dynamicModules = [], storefrontMenuUrl = null, tabLabelsById = {} }) => {
    // Estado para evitar SSR mismatch en logo y brand-info
        // SSR mismatch guard removed: logo and brand-info always rendered
    const { pathname } = useLocation();
    const [logoFailed, setLogoFailed] = useState(false);
    const pendingCount = kanbanColumns?.pending?.length || 0;
    const isTabAllowed = useCallback((tabId) => (typeof canAccessTab === 'function' ? canAccessTab(tabId) : true), [canAccessTab]);

    const getDeniedTooltip = useCallback((tabId) => {
        if (typeof getTabDeniedMessage === 'function') {
            const message = getTabDeniedMessage(tabId);
            if (message) return message;
        }
        return 'Necesitás un rol diferente para acceder.';
    }, [getTabDeniedMessage]);

    useEffect(() => {
        setLogoFailed(false);
    }, [logoUrl]);

    const logoSrc = logoFailed ? SIDEBAR_LOGO_PLACEHOLDER : getSafeLogoImageSrc(logoUrl);

    // Estado mounted eliminado, usar isMobile directamente
    const renderMobile = isMobile;

    // [FIX] Aislamiento: Asegurar que el modo oscuro del SaaS NO afecte al Panel Admin
    // Se ejecuta cada vez que cambia la ruta dentro del admin para reforzar el modo claro
    useEffect(() => {
        const classes = ['dark', 'dark-mode'];
        document.documentElement.classList.remove(...classes);
        document.body.classList.remove(...classes);
        document.documentElement.style.colorScheme = 'light';
    }, [pathname]);

    const [logoutBusy, setLogoutBusy] = useState(false);

    const handleOpenStorefront = useCallback(() => {
        const url = String(storefrontMenuUrl || '').trim();
        if (!url) {
            onStorefrontMissing?.();
            return;
        }
        window.open(url, '_blank', 'noopener,noreferrer');
    }, [storefrontMenuUrl, onStorefrontMissing]);

    const handleLogout = useCallback(async () => {
        if (logoutBusy || typeof onLogout !== 'function') return;
        setLogoutBusy(true);
        try {
            await onLogout();
        } finally {
            setLogoutBusy(false);
        }
    }, [logoutBusy, onLogout]);

    const menuItems = useMemo(() => {
        const normalizedRole = String(userRole || '').toLowerCase() === 'staff'
            ? 'cashier'
            : String(userRole || '').toLowerCase();

        const visibleModules = (Array.isArray(dynamicModules) ? dynamicModules : [])
            .filter((module) => module?.isActive)
            .filter((module) => {
                if (!Array.isArray(module.allowedRoles) || module.allowedRoles.length === 0) return true;
                return module.allowedRoles.map((role) => String(role).toLowerCase()).includes(normalizedRole);
            })
            .sort((a, b) => {
                const orderDiff = (Number(a.navOrder) || 100) - (Number(b.navOrder) || 100);
                if (orderDiff !== 0) return orderDiff;
                return String(a.label || '').localeCompare(String(b.label || ''));
            });

        const rootModules = visibleModules.filter((module) => module.navGroup === 'root');
        const salesModules = visibleModules.filter((module) => module.navGroup === 'sales');
        const menuModules = visibleModules.filter((module) => module.navGroup === 'menu');
		const L = tabLabelsById || {};

		const items = [
			{ 
				id: 'orders', 
				label: L.orders || 'Pedidos', 
				icon: ChefHat, 
				badge: pendingCount > 0 ? pendingCount : null 
			},
			{
				id: 'sales-group',
				label: 'Ventas',
				icon: DollarSign,
				isGroup: true,
				children: [
					{ id: 'caja', label: L.caja || 'Caja', icon: Calculator },
					{ id: 'analytics', label: L.analytics || 'Reportes', icon: BarChart3 },
					{ id: 'local_expenses', label: L.local_expenses || 'Gastos del local', icon: Wallet },
					...salesModules.map((module) => ({
						id: module.tabId,
						label: L[module.tabId] || module.label,
						description: module.description,
						icon: Blocks,
					})),
				]
			},
			{
				id: 'menu-group',
				label: 'Menú',
				icon: List,
				isGroup: true,
				children: [
					{ id: 'categories', label: L.categories || 'Categorías', icon: FolderTree },
					{ id: 'products', label: L.products || 'Productos', icon: ShoppingBag },
					{ id: 'inventory', label: L.inventory || 'Inventario', icon: ClipboardList },
					{ id: 'menu_beverages', label: L.menu_beverages || 'Bebidas', icon: CupSoda },
					{ id: 'menu_extras', label: L.menu_extras || 'Extras', icon: Sparkles },
					...menuModules.map((module) => ({
						id: module.tabId,
						label: L[module.tabId] || module.label,
						description: module.description,
						icon: Blocks,
					})),
				]
			},
				{ id: 'clients', label: L.clients || 'Clientes', icon: Users },
			{ id: 'coupons', label: L.coupons || 'Cupones', icon: Tag },
			{ id: 'menu_options', label: L.menu_options || 'Opciones de sucursal', icon: SlidersHorizontal },
		];

        if (rootModules.length > 0) {
            rootModules.forEach((module) => {
                items.push({
                    id: module.tabId,
                    label: L[module.tabId] || module.label,
                    description: module.description,
                    icon: Blocks,
                });
            });
        }
        return items;
    }, [dynamicModules, pendingCount, userRole, tabLabelsById]);

    const hasRestrictedItems = useMemo(() => (
        menuItems.some((item) => {
            if (item.isGroup) {
                return item.children?.some((child) => !isTabAllowed(child.id));
            }
            return !isTabAllowed(item.id);
        })
    ), [menuItems, isTabAllowed]);

    const restrictedHintText = useMemo(() => {
        if (!hasRestrictedItems || !tabAccessContext) return '';
        const dynamicTabIds = (Array.isArray(dynamicModules) ? dynamicModules : [])
            .filter((module) => module?.isActive && module.tabId)
            .map((module) => module.tabId);
        const tabIds = [...new Set([...ADMIN_PANEL_TAB_IDS, ...dynamicTabIds])];
        return resolveSidebarRestrictedHint(tabIds, tabAccessContext);
    }, [hasRestrictedItems, tabAccessContext, dynamicModules]);

    const [expandedGroups, setExpandedGroups] = useState(() => {
        const activeGroup = menuItems.find(item => item.isGroup && item.children?.some(child => child.id === activeTab));
        return activeGroup ? { [activeGroup.id]: true } : {};
    });

    useEffect(() => {
        const activeGroup = menuItems.find(item => item.isGroup && item.children?.some(child => child.id === activeTab));
        if (activeGroup) {
            const timer = setTimeout(() => {
                setExpandedGroups(prev => {
                    if (prev[activeGroup.id]) return prev;
                    return { ...prev, [activeGroup.id]: true };
                });
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [activeTab, menuItems]);

    const toggleGroup = (groupId) => {
        setExpandedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
    };

    return (
        <aside className="admin-sidebar">
            <div className="sidebar-top">
                <div className="logo-circle">
                    <img
                        src={logoSrc}
                        alt="Logo"
                        onError={() => setLogoFailed(true)}
                    />
                </div>
                <div className="brand-info">
                    <h3 className="brand-title">Admin del local</h3>
                    {userEmail && <span className="user-email">{userEmail}</span>}
                    {branchName && <span className="branch-name-badge">{branchName}</span>}
                </div>
            </div>
            
            <nav className="sidebar-menu">
                {renderMobile
                    ? menuItems.flatMap(item => {
                        if (item.isGroup) {
                            return item.children.map(child => {
                                const disabled = !isTabAllowed(child.id);
                                return (
                                    <button
                                        key={child.id}
                                        onClick={() => {
                                            if (disabled) {
                                                onDeniedAccess?.(child.id);
                                                return;
                                            }
                                            setActiveTab(child.id);
                                        }}
                                        className={`nav-item ${activeTab === child.id ? 'active' : ''}`}
                                        title={disabled ? getDeniedTooltip(child.id) : child.description || undefined}
                                        style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                                    >
                                        <SidebarIcon Icon={child.icon} size={20} />
                                        <span className="nav-label-mobile">{child.label}</span>
                                    </button>
                                );
                            });
                        } else {
                            const disabled = !isTabAllowed(item.id);
                            return (
                                <button
                                    key={item.id}
                                    onClick={() => {
                                        if (disabled) {
                                            onDeniedAccess?.(item.id);
                                            return;
                                        }
                                        setActiveTab(item.id);
                                    }}
                                    className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                                    title={disabled ? getDeniedTooltip(item.id) : item.description || undefined}
                                    style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                                >
                                    <SidebarIcon Icon={item.icon} size={20} />
                                    <span className="nav-label-mobile">{item.label}</span>
                                    {item.badge && <span className="badge-count">{item.badge}</span>}
                                </button>
                            );
                        }
                    })
                    : menuItems.map(item => {
                        if (item.isGroup) {
                            const isExpanded = expandedGroups[item.id];
                            const isActiveGroup = item.children.some(child => child.id === activeTab);
                            return (
                                <div key={item.id} className="nav-group-wrapper">
                                    <button 
                                        onClick={() => toggleGroup(item.id)} 
                                        className={`nav-item nav-group-header ${isActiveGroup ? 'active-group' : ''}`}
                                    >
                                        <div className="nav-item-inner">
                                            <SidebarIcon Icon={item.icon} size={20} />
                                            <span className="nav-text">{item.label}</span>
                                        </div>
                                        <ChevronDown 
                                            size={16} 
                                            strokeWidth={1.75}
                                            className={`nav-chevron ${isExpanded ? 'expanded' : ''}`} 
                                        />
                                    </button>
                                    <div className={`nav-sub-menu ${isExpanded ? 'expanded' : ''}`}>
                                        {item.children.map(child => {
                                            const disabled = !isTabAllowed(child.id);
                                            return (
                                                <button 
                                                    key={child.id}
                                                    onClick={() => {
                                                        if (disabled) {
                                                            onDeniedAccess?.(child.id);
                                                            return;
                                                        }
                                                        setActiveTab(child.id);
                                                    }}
                                                    className={`nav-item ${activeTab === child.id ? 'active' : ''}`}
                                                    title={disabled ? getDeniedTooltip(child.id) : child.description || undefined}
                                                    style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                                                >
                                                    <SidebarIcon Icon={child.icon} size={18} />
                                                    <span className="nav-text">{child.label}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        } else {
                            const disabled = !isTabAllowed(item.id);
                            return (
                                <button 
                                    key={item.id}
                                    onClick={() => {
                                        if (disabled) {
                                            onDeniedAccess?.(item.id);
                                            return;
                                        }
                                        setActiveTab(item.id);
                                    }} 
                                    className={`nav-item ${activeTab === item.id ? 'active' : ''}`}
                                    title={disabled ? getDeniedTooltip(item.id) : item.description || undefined}
                                    style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                                >
                                    <SidebarIcon Icon={item.icon} size={20} />
                                    <span className="nav-text">{item.label}</span>
                                    {item.badge && <span className="badge-count">{item.badge}</span>}
                                </button>
                            );
                        }
                    })}

                {renderMobile ? (
                    <>
                        <button
                            type="button"
                            onClick={handleOpenStorefront}
                            className="nav-item sidebar-menu__store"
                            title={storefrontMenuUrl ? 'Abrir menú público en una pestaña nueva' : 'No hay URL de tienda configurada'}
                            disabled={!storefrontMenuUrl}
                        >
                            <SidebarIcon Icon={Store} size={20} />
                            <span className="nav-label-mobile">Tienda</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => { void handleLogout(); }}
                            className="nav-item logout"
                            disabled={logoutBusy}
                            aria-busy={logoutBusy}
                        >
                            <SidebarIcon Icon={LogOut} size={20} />
                            <span className="nav-label-mobile">Salir</span>
                        </button>
                    </>
                ) : null}
            </nav>

            {!renderMobile ? (
                <div className="sidebar-footer">
                    <button
                        type="button"
                        onClick={handleOpenStorefront}
                        className="nav-item sidebar-footer__store"
                        title={storefrontMenuUrl ? 'Abrir menú público en una pestaña nueva' : 'No hay URL de tienda configurada'}
                        disabled={!storefrontMenuUrl}
                    >
                        <SidebarIcon Icon={Store} size={20} />
                        <span className="nav-text">Ver Tienda</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => { void handleLogout(); }}
                        className="nav-item logout"
                        disabled={logoutBusy}
                        aria-busy={logoutBusy}
                    >
                        <SidebarIcon Icon={LogOut} size={20} />
                        <span className="nav-text">Cerrar Sesión</span>
                    </button>
                </div>
            ) : null}

            {hasRestrictedItems && !renderMobile && restrictedHintText && (
                <p className="admin-sidebar-hint">
                    {restrictedHintText}
                </p>
            )}
        </aside>
    );
};

export default AdminSidebar;
