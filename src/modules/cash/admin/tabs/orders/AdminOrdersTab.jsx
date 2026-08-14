import React from 'react';
import AdminErrorBoundary from '../../../components/AdminErrorBoundary';
import AdminTabFallback from '../../../components/AdminTabFallback';
import AdminTablesGrid from '../../../components/AdminTablesGrid';
import AdminKanban from '../../../components/AdminKanban';
import { useAdmin } from '../../pages/AdminProvider';

const AdminHistoryTable = React.lazy(() => import('../../../components/AdminHistoryTable'));

export default function AdminOrdersTab({ logoUrl, companyName }) {
	const {
		orders,
		moveOrder,
		closeOrderSession,
		markOrderSessionPaid,
		selectedBranch,
		clients,
		showNotify,
		products,
		categories,
		localOrderChannels,
		upsertOrder,
		refreshClients,
		refreshOrders,
		isHistoryView,
		ordersViewMode,
		ordersPanelSettingsReady,
		kanbanColumns,
		isMobile,
		mobileTab,
		setMobileTab,
		setReceiptModalOrder,
		historyOrders,
		historyLoading,
		historyPeriod,
		setHistoryPeriod,
		resolvedTabLabels,
	} = useAdmin();

	const tabLabels = resolvedTabLabels || {};
	const ordersLabel = tabLabels.orders || 'Pedidos';
	const handleOrderSaved = React.useCallback((savedOrder) => {
		upsertOrder(savedOrder);
		void refreshClients();
	}, [upsertOrder, refreshClients]);

	if (isHistoryView) {
		return (
			<AdminErrorBoundary tabLabel={ordersLabel} onRetry={() => refreshOrders()}>
				<React.Suspense fallback={<AdminTabFallback />}>
					<AdminHistoryTable
						orders={historyOrders}
						historyLoading={historyLoading}
						historyPeriod={historyPeriod}
						onPeriodChange={setHistoryPeriod}
						setReceiptModalOrder={setReceiptModalOrder}
					/>
				</React.Suspense>
			</AdminErrorBoundary>
		);
	}

	if (!ordersPanelSettingsReady) {
		return <AdminTabFallback />;
	}

	if (ordersViewMode === 'mesas') {
		return (
			<AdminErrorBoundary tabLabel={ordersLabel} onRetry={() => refreshOrders()}>
				<AdminTablesGrid
					orders={orders}
					moveOrder={moveOrder}
					closeOrderSession={closeOrderSession}
					markOrderSessionPaid={markOrderSessionPaid}
					branch={selectedBranch}
					clients={clients}
					logoUrl={logoUrl}
					companyName={companyName}
					showNotify={showNotify}
					products={products}
					categories={categories}
					localOrderChannels={localOrderChannels}
					onOrderSaved={handleOrderSaved}
				/>
			</AdminErrorBoundary>
		);
	}

	return (
		<AdminErrorBoundary tabLabel={ordersLabel} onRetry={() => refreshOrders()}>
			<AdminKanban
				columns={kanbanColumns}
				isMobile={isMobile}
				mobileTab={mobileTab}
				setMobileTab={setMobileTab}
				moveOrder={moveOrder}
				setReceiptModalOrder={setReceiptModalOrder}
				branch={selectedBranch}
				clients={clients}
				logoUrl={logoUrl}
				companyName={companyName}
				showNotify={showNotify}
				products={products}
				categories={categories}
				localOrderChannels={localOrderChannels}
				onOrderSaved={handleOrderSaved}
			/>
		</AdminErrorBoundary>
	);
}
