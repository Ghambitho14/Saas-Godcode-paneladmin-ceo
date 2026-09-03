import React, { useMemo, useState, useCallback } from 'react';
import { Columns3, Maximize2 } from 'lucide-react';
import AdminIconSlot from './AdminIconSlot';
import OrderCard from './OrderCard';
import { Button } from "@/components/ui/button";

const KANBAN_VIEW_STORAGE_KEY = 'tenant-admin-kanban-view';

/** Vista guardada, leida de forma sincrona: la app es 100% cliente (createRoot,
 *  sin SSR ni hidratacion), asi que el primer render ya puede pintar el layout
 *  definitivo. Leerla desde un efecto hacia que el tablero pintase primero como
 *  tres columnas y saltase a una columna en el tick siguiente. */
function readStoredKanbanView() {
    if (typeof window === 'undefined') return 'split';
    try {
        const v = localStorage.getItem(KANBAN_VIEW_STORAGE_KEY);
        return v === 'single' || v === 'split' ? v : 'split';
    } catch {
        return 'split';
    }
}

const AdminKanban = ({ columns, isMobile, mobileTab, setMobileTab, moveOrder, setReceiptModalOrder, branch, clients, logoUrl, companyName, showNotify, products, categories, onOrderSaved, localOrderChannels = null }) => {

    /** 'split' = tres columnas; 'single' = una etapa a pantalla completa (solo escritorio; móvil sigue en pestañas) */
    const [kanbanViewMode, setKanbanViewModeState] = useState(readStoredKanbanView);

    const setKanbanViewMode = useCallback((mode) => {
        setKanbanViewModeState(mode);
        try {
            localStorage.setItem(KANBAN_VIEW_STORAGE_KEY, mode);
        } catch {
            /* ignore */
        }
    }, []);

    // 1. CONFIGURACIÓN CENTRALIZADA
    // Aquí defines tus columnas. Si quieres agregar una, solo la pones aquí y listo.
    const columnConfig = useMemo(() => [
        { 
            id: 'pending', 
            title: 'ENTRANTES', 
            shortTitle: 'Entrantes', // Para el botón móvil
            dotClass: 'dot-orange', 
            emptyMsg: 'Sin pedidos' 
        },
        { 
            id: 'active', 
            title: 'COCINANDO', 
            shortTitle: 'Cocina', 
            dotClass: 'dot-red', 
            emptyMsg: 'Cocina libre' 
        },
        { 
            id: 'completed', 
            title: 'LISTOS', 
            shortTitle: 'Listos', 
            dotClass: 'dot-green', 
            emptyMsg: 'Nada listo' 
        }
    ], []);

    const showDesktopSingle = !isMobile && kanbanViewMode === 'single';
    const showDesktopSplit = !isMobile && kanbanViewMode === 'split';

    const isColumnHidden = (colId) => {
        if (isMobile && mobileTab !== colId) return true;
        if (showDesktopSingle && mobileTab !== colId) return true;
        return false;
    };

    return (
        <>
            {!isMobile && (
                <div className="kanban-view-toolbar" role="group" aria-label="Vista del tablero de pedidos">
                    <span className="kanban-view-toolbar-label">Vista</span>
                    <div className="kanban-view-toggle">
                        <Button variant="default"
                            type="button"
                            className={kanbanViewMode === 'split' ? 'active' : ''}
                            onClick={() => setKanbanViewMode('split')}
                            aria-pressed={kanbanViewMode === 'split'}
                            title="Ver entrantes, cocinando y listos a la vez"
                        >
                            <Columns3 size={16} strokeWidth={2.25} aria-hidden />
                            Tres columnas
                        </Button>
                        <Button variant="default"
                            type="button"
                            className={kanbanViewMode === 'single' ? 'active' : ''}
                            onClick={() => setKanbanViewMode('single')}
                            aria-pressed={kanbanViewMode === 'single'}
                            title="Una etapa a la vez, ancho completo"
                        >
                            <AdminIconSlot Icon={Maximize2} slotSize="sm" />
                            Una columna
                        </Button>
                    </div>
                </div>
            )}

            {/* Pestañas: móvil siempre; escritorio solo en vista una columna */}
            <div className={`mobile-tabs ${showDesktopSingle ? 'kanban-tabs-desktop' : ''}`}>
                {columnConfig.map(col => (
                    <Button variant="default"
                        key={col.id}
                        type="button"
                        onClick={() => setMobileTab(col.id)}
                        className={mobileTab === col.id ? 'active' : ''}
                    >
                        {col.shortTitle} ({columns[col.id]?.length || 0})
                    </Button>
                ))}
            </div>

            {/* Tablero */}
            <div
                className={[
                    'kanban-board',
                    showDesktopSingle ? 'kanban-board--focus-desktop' : '',
                    showDesktopSplit ? 'kanban-board--split-desktop' : '',
                ].filter(Boolean).join(' ')}
            >
                {columnConfig.map((col) => {
                    const rawList = columns[col.id] || [];
                    /* En vista una etapa las fichas van en una cuadrícula que se lee
                       por filas, así que el orden del DOM ya es el orden de cola. */
                    const ordersInColumn = showDesktopSingle
                        ? [...rawList].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                        : rawList;
                    const hidden = isColumnHidden(col.id);

                    return (
                        <div
                            key={col.id}
                            className={`kanban-column col-${col.id} ${hidden ? 'kanban-column--hidden' : ''}`}
                        >
                            {/* Header */}
                            <div className="column-header">
                                <span className={`dot ${col.dotClass}`}></span>
                                <h3>{col.title}</h3>
                                <span className="count">{ordersInColumn.length}</span>
                            </div>

                            {/* Body */}
                            <div
                                className={[
                                    'column-body',
                                    ordersInColumn.length === 0 ? 'column-body--empty' : '',
                                ].filter(Boolean).join(' ')}
                            >
                                {ordersInColumn.length === 0 ? (
                                    <div className="empty-zone">{col.emptyMsg}</div>
                                ) : (
                                    ordersInColumn.map((order, idx) => (
                                        <OrderCard
                                            key={order.id}
                                            order={order}
                                            queueIndex={idx + 1}
                                            moveOrder={moveOrder}
                                            setReceiptModalOrder={setReceiptModalOrder}
                                            branch={branch}
                                            clients={clients}
                                            logoUrl={logoUrl}
                                            companyName={companyName}
                                            showNotify={showNotify}
                                            products={products}
                                            categories={categories}
                                            onOrderSaved={onOrderSaved}
                                            localOrderChannels={localOrderChannels}
                                            gridTile={showDesktopSingle}
                                        />
                                    ))
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
};

export default React.memo(AdminKanban);
