import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
    ArrowUpRight, ArrowDownRight, Calendar,
    ShoppingBag, Users, DollarSign, CreditCard,
    Smartphone, TrendingUp, Package, Clock, MapPin, Truck,
    BarChart3, AreaChart, Wallet, Banknote, Download, Loader2, Eye, ExternalLink, LineChart,
    Receipt, RotateCcw,
} from 'lucide-react';
import { supabase, TABLES } from '@/integrations/supabase';
import { cashService } from '../services/cashService';
import { expenseBucketKey, expenseBucketKeysForRange, labelForExpenseBucket } from '../utils/cashExpenseBuckets';
import {
    labelForManualExpenseKind,
    isCashWithdrawal,
    isOperatingLocalExpense,
    isOrderLinkedExpense,
    EXPENSE_KIND_OPERATING,
} from '../utils/cashMovementKinds';
import ReportPeriodSelect from './ReportPeriodSelect';
import AdminMenuSelect from './AdminMenuSelect';
import {
    addLocalDays,
    isInReportRange,
    reportPeriodExportSlug,
    resolveReportPeriodRange,
} from '../utils/reportPeriodRange';
import { createMoneyFormatter } from '@/shared/utils/money';
import { resolveEffectiveCountry, resolveEffectiveCurrency } from '@/lib/geo/tenant-locale';
import { getFormStrategy } from '@/lib/geo/country-forms';
import { isMenuOrder, getOrderPaymentBreakdown, getPaymentLabel, ORDERS_EXPORT_SELECT } from '@/shared/utils/orderUtils';
import { fetchTopProducts } from '../services/analyticsService';
import { useAnalyticsData } from '../admin/tabs/analytics/useAnalyticsData';
import {
    countOrdersInRange,
    confirmLargeExport,
    MONTHLY_EXPORT_DISCLAIMER,
} from '../services/analyticsExportUtils';
import { fetchAllPaginated } from '@/shared/utils/fetchAllPaginated';
import { downloadExcel, openSpreadsheetInNewTab } from '@/shared/utils/exportUtils';
import SpreadsheetPreviewModal from './SpreadsheetPreviewModal';
import { isValidBranchId } from '@/shared/utils/safeIds';
import { useAdmin } from '../admin/pages/AdminProvider';
import LocalExpenseModal from './expenses/LocalExpenseModal';
import LocalExpensesToolbar from './expenses/LocalExpensesToolbar';
import LocalExpensesSummaryBar from './expenses/LocalExpensesSummaryBar';
import LocalExpenseCategoryCard from './expenses/LocalExpenseCategoryCard';
import ReportSalesChart from './charts/ReportSalesChart';
import ReportPaymentDonut from './charts/ReportPaymentDonut';
import ReportSparkline from './charts/ReportSparkline';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';

const CHART_KIND_OPTIONS = [
    { value: 'area', label: 'Área', Icon: AreaChart },
    { value: 'bar-solid', label: 'Barras', Icon: BarChart3 },
    { value: 'bar-gradient', label: 'Barras degradado', Icon: BarChart3 },
];

const PAYMENT_META = [
    { key: 'cash', label: 'Efectivo', Icon: DollarSign, color: '#16a34a', bg: 'bg-[#16a34a]/10' },
    { key: 'card', label: 'Tarjeta', Icon: CreditCard, color: '#2563eb', bg: 'bg-[#2563eb]/10' },
    { key: 'online', label: 'Transferencia', Icon: Smartphone, color: '#7c3aed', bg: 'bg-[#7c3aed]/10' },
];

const KPI_META = [
    { key: 'total', label: 'Ventas', Icon: DollarSign, color: '#2563eb' },
    { key: 'count', label: 'Pedidos', Icon: ShoppingBag, color: '#2563eb' },
    { key: 'ticket', label: 'Ticket prom.', Icon: TrendingUp, color: '#7c3aed' },
    { key: 'deliveryTotal', label: 'Delivery', Icon: Truck, color: '#2563eb' },
    { key: 'clients', label: 'Nuevos clientes', Icon: Users, color: '#16a34a' },
    { key: 'expenses', label: 'Gastos', Icon: Wallet, color: '#dc2626' },
];

const FLAT_SPARKLINE = [0, 0, 0];

/** Mínimo de pedidos en el período anterior para considerar significativa la comparación de trends. */
const MIN_SIGNIFICANT_PREV_ORDERS = 5;

function calcTrendPercent(current, prev) {
    const c = Number(current);
    const p = Number(prev);
    if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
    if (p === 0) return c > 0 ? 100 : 0;
    const pct = Math.round(((c - p) / p) * 100);
    return Number.isFinite(pct) ? pct : null;
}

function formatSalesChartLabel(isoDate, dayCount) {
    const d = new Date(`${isoDate}T12:00:00`);
    if (dayCount <= 15) {
        return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
    }
    return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'numeric' });
}

function formatHourLabel(hour) {
    return `${String(hour).padStart(2, '0')}:00`;
}

function buildHourlySalesPoints(orders, range) {
    const buckets = Array.from({ length: 24 }, (_, i) => ({
        key: `h${i}`,
        label: formatHourLabel(i),
        sales: 0,
        expenses: 0,
    }));
    (orders || []).forEach((o) => {
        if (!o) return;
        const d = new Date(o.created_at);
        if (!isInReportRange(d, range)) return;
        const h = d.getHours();
        buckets[h].sales += Number(o.total) || 0;
    });
    return buckets;
}

function buildDailySalesPoints(orders, range, analyticsSource, analyticsSummary) {
    const chartDateKeys = [...range.chartDateKeys];
    if (analyticsSource === 'rpc' && analyticsSummary?.current?.byDay) {
        const byDay = analyticsSummary.current.byDay;
        const hasAny = chartDateKeys.some((k) => Number(byDay[k]) > 0)
            || Object.keys(byDay).length > 0;
        if (hasAny) {
            return chartDateKeys.map((k) => ({
                key: k,
                label: formatSalesChartLabel(k, range.dayCount),
                sales: Number(byDay[k]) || 0,
                expenses: 0,
            }));
        }
    }
    const salesByDate = {};
    chartDateKeys.forEach((key) => { salesByDate[key] = 0; });
    (orders || []).forEach((o) => {
        if (!o) return;
        const localDate = new Date(o.created_at).toLocaleDateString('en-CA');
        if (salesByDate[localDate] !== undefined) {
            salesByDate[localDate] += Number(o.total) || 0;
        }
    });
    return chartDateKeys.map((k) => ({
        key: k,
        label: formatSalesChartLabel(k, range.dayCount),
        sales: salesByDate[k] || 0,
        expenses: 0,
    }));
}

const EXPENSE_AGG_OPTIONS = [
    { value: 'day', label: 'Día' },
    { value: 'week', label: 'Semana' },
    { value: 'month', label: 'Mes' },
];

function getMonthRangeUtc(yyyyMm) {
    const [yearStr, monthStr] = String(yyyyMm).split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
        return null;
    }
    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const nextMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    return {
        startIso: start.toISOString(),
        endIso: nextMonth.toISOString(),
    };
}

function formatCalendarMonthLabel(yyyyMm) {
    const [yearStr, monthStr] = String(yyyyMm).split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
        return yyyyMm;
    }
    const raw = new Date(year, month - 1, 1).toLocaleDateString('es-CL', {
        month: 'long',
        year: 'numeric',
    });
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

function currentMonthYyyyMm(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Opciones YYYY-MM para el selector de mes (mismo AdminMenuSelect que el período). */
function buildRecentMonthOptions(monthsBack = 24, selectedValue = null) {
    const now = new Date();
    const seen = new Set();
    const options = [];
    for (let i = 0; i < monthsBack; i += 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const value = currentMonthYyyyMm(d);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({ value, label: formatCalendarMonthLabel(value) });
    }
    if (selectedValue && !seen.has(selectedValue)) {
        options.unshift({
            value: selectedValue,
            label: formatCalendarMonthLabel(selectedValue),
        });
    }
    return options;
}

function getCalendarYearRangeLocal(year) {
    if (!Number.isFinite(year)) return null;
    return {
        start: new Date(year, 0, 1),
        end: new Date(year + 1, 0, 1),
    };
}

function resolveExpenseReferenceYear(analyticsDate, reportRange) {
    if (reportRange.end instanceof Date && !Number.isNaN(reportRange.end.getTime())) {
        const probe = addLocalDays(reportRange.end, -1);
        return probe.getFullYear();
    }
    if (reportRange.chartDateKeys?.length) {
        const last = reportRange.chartDateKeys[reportRange.chartDateKeys.length - 1];
        const year = Number(String(last).split('-')[0]);
        if (Number.isFinite(year)) return year;
    }
    if (reportRange.start instanceof Date && !Number.isNaN(reportRange.start.getTime())) {
        return reportRange.start.getFullYear();
    }
    const year = Number(String(analyticsDate).split('-')[0]);
    if (Number.isFinite(year)) return year;
    return new Date().getFullYear();
}

const TrendBadge = ({ value, isSignificant = true }) => {
    if (value == null || !Number.isFinite(value)) {
        return <Badge variant="outline" className="text-[10px] font-bold text-[#6b7280]">—</Badge>;
    }
    if (value === 0) return <Badge variant="outline" className="gap-0.5 text-[10px] font-bold">0%</Badge>;
    if (!isSignificant) {
        return (
            <Badge
                variant="outline"
                className="gap-0.5 text-[10px] font-bold text-[#6b7280]"
                title="Período anterior con pocos datos. Comparar con precaución."
            >
                {Math.abs(value)}%
            </Badge>
        );
    }
    const pos = value > 0;
    return (
        <Badge variant={pos ? 'success' : 'danger'} className="gap-0.5 text-[10px] font-bold">
            {pos ? <ArrowUpRight size={12} aria-hidden /> : <ArrowDownRight size={12} aria-hidden />}
            {Math.abs(value)}%
        </Badge>
    );
};

function formatKpiValue(metaKey, value, fmt) {
    if (metaKey === 'count') {
        return Math.round(Number(value) || 0).toLocaleString('es-CL');
    }
    return fmt(value);
}

function formatSparklineValue(metaKey, value, fmt) {
    if (metaKey === 'count' || metaKey === 'deliveryCount') {
        return `${Math.round(Number(value) || 0).toLocaleString('es-CL')} pedidos`;
    }
    if (metaKey === 'clients') {
        return `${Math.round(Number(value) || 0).toLocaleString('es-CL')} clientes`;
    }
    return fmt(value);
}

function formatPeakHourLabel(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return '—';
    const start = `${String(h).padStart(2, '0')}:00`;
    const end = `${String((h + 1) % 24).padStart(2, '0')}:00`;
    return `${start} – ${end}`;
}

function buildHourCountsFromAnalytics({ analyticsSource, analyticsSummary, ordersForAnalytics, reportRange }) {
    const hourCounts = {};
    if (analyticsSource === 'rpc' && analyticsSummary?.current?.byHour) {
        Object.entries(analyticsSummary.current.byHour).forEach(([h, count]) => {
            const hour = Number(h);
            if (!Number.isFinite(hour)) return;
            hourCounts[hour] = Number(count) || 0;
        });
        return hourCounts;
    }
    for (const o of ordersForAnalytics || []) {
        if (!o || o.status === 'cancelled') continue;
        const d = new Date(o.created_at);
        if (!isInReportRange(d, reportRange)) continue;
        const h = d.getHours();
        hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
    return hourCounts;
}

function resolveKpiTrendKey(metaKey) {
    if (metaKey === 'deliveryTotal') return 'delivery';
    return metaKey;
}

function resolveKpiSparkKey(metaKey) {
    if (metaKey === 'deliveryTotal') return 'delivery';
    if (metaKey === 'clients') return 'clients';
    return metaKey;
}

function buildExpenseChartData(rows, expenseAgg, bucketKeys) {
    const acc = new Map();
    for (const row of rows || []) {
        const iso = row.created_at;
        if (!iso) continue;
        const key = expenseBucketKey(iso, expenseAgg);
        acc.set(key, (acc.get(key) || 0) + (Number(row.amount) || 0));
    }
    const keys = bucketKeys?.length ? bucketKeys : [...acc.keys()].sort();
    return {
        expenseBucketsOrdered: keys.map((k) => ({
            key: k,
            label: labelForExpenseBucket(k, expenseAgg),
            total: acc.get(k) || 0,
        })),
        expenseBarPoints: keys.map((k) => ({
            key: k,
            label: labelForExpenseBucket(k, expenseAgg),
            value: Number(acc.get(k)) || 0,
        })),
        periodTotal: keys.reduce((sum, k) => sum + (Number(acc.get(k)) || 0), 0),
    };
}

function resolveFromReportRange(reportRange) {
    let start = reportRange.start;
    let end = reportRange.end;

    if (!start && reportRange.chartDateKeys?.length) {
        const [y, mo, d] = reportRange.chartDateKeys[0].split('-').map(Number);
        if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
            start = new Date(y, mo - 1, d);
        }
    }

    if (!end && reportRange.chartDateKeys?.length) {
        const last = reportRange.chartDateKeys[reportRange.chartDateKeys.length - 1];
        const [y, mo, d] = last.split('-').map(Number);
        if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
            end = addLocalDays(new Date(y, mo - 1, d), 1);
        }
    }

    if (!start || !end) {
        return null;
    }

    return { start, end };
}

function resolveExpenseChartRange(reportRange, expenseAgg, analyticsDate) {
    if (expenseAgg === 'month') {
        const year = resolveExpenseReferenceYear(analyticsDate, reportRange);
        return getCalendarYearRangeLocal(year);
    }
    return resolveFromReportRange(reportRange);
}

function resolveTopProductsRange(reportRange) {
    if (reportRange?.start) {
        return {
            startIso: reportRange.start.toISOString(),
            endIso: reportRange.end ? reportRange.end.toISOString() : new Date().toISOString(),
        };
    }
    const keys = reportRange?.chartDateKeys;
    if (keys?.length) {
        const start = new Date(`${keys[0]}T00:00:00`);
        const end = new Date(`${keys[keys.length - 1]}T23:59:59.999`);
        end.setDate(end.getDate() + 1);
        return {
            startIso: start.toISOString(),
            endIso: end.toISOString(),
        };
    }
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 364);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
}

const KpiCard = memo(({ meta, value, trend, sparklineValues, loading, fmt, subtitle, showTrend, trendSignificant = true }) => {
    return (
        <Card className="@container flex min-w-0 flex-col p-3 transition-all duration-150 hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)] sm:p-5">
            <div className="flex items-start justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af] sm:text-[11px]">{meta.label}</p>
                {showTrend ? <TrendBadge value={trend} isSignificant={trendSignificant} /> : null}
            </div>
            <div className="mt-1 min-w-0">
                {loading ? <Skeleton className="h-8 w-28" /> : (
                    <p className="text-[clamp(16px,11.5cqi,28px)] font-bold leading-tight tracking-tight tabular-nums text-[#14161a] [overflow-wrap:anywhere]">{formatKpiValue(meta.key, value, fmt)}</p>
                )}
            </div>
            {subtitle && <p className="mt-1 text-[11px] font-medium text-[#6b7280] sm:text-xs">{subtitle}</p>}
            <div className="mt-auto flex h-8 items-end pt-2 sm:h-12 sm:pt-4">
                <ReportSparkline
                    values={sparklineValues}
                    trend={trend}
                    showTrend={showTrend}
                    height={28}
                    showDots
                    color="#2563eb"
                    valueFormatter={(v) => formatSparklineValue(meta.key, v, fmt)}
                />
            </div>
        </Card>
    );
});

const AdminAnalytics = ({ orders, clients, branches, showNotify, companyId, selectedBranch, view = 'full' }) => {
    const { cashSystem, moveOrder, companyProfile } = useAdmin();

    const safeBranches = useMemo(
        () => (branches || []).filter((b) => b && typeof b === 'object'),
        [branches],
    );

    const { formatMoney: fmt, currency } = useMemo(
        () => createMoneyFormatter(selectedBranch, companyProfile),
        [selectedBranch, companyProfile],
    );

    const multiCurrencyWarning = useMemo(() => {
        if (selectedBranch?.id !== 'all') return null;
        const realBranches = safeBranches.filter((b) => b.id && b.id !== 'all');
        if (realBranches.length < 2) return null;
        const currencies = new Set(realBranches.map((b) => resolveEffectiveCurrency(b, companyProfile)));
        if (currencies.size <= 1) return null;
        return `Las sucursales usan monedas distintas (${[...currencies].join(', ')}). Los totales no convierten entre monedas.`;
    }, [selectedBranch?.id, safeBranches, companyProfile]);

    const exportIdLabel = useMemo(() => {
        const country = selectedBranch?.id === 'all'
            ? companyProfile?.country
            : resolveEffectiveCountry(selectedBranch, companyProfile);
        return getFormStrategy(country).idName;
    }, [selectedBranch, companyProfile]);

    const [filterPeriod, setFilterPeriod] = useState(() => (view === 'expensesOnly' ? 'month' : '7'));
    const [chartTab, setChartTab] = useState('all');
    const [chartKind, setChartKind] = useState('area');
    const [expensesData, setExpensesData] = useState({ total: 0, prevTotal: 0 });
    const [loadingExpenses, setLoadingExpenses] = useState(false);
    const [manualExpenseRows, setManualExpenseRows] = useState([]);
    const [refundExpenseRows, setRefundExpenseRows] = useState([]);
    const [expenseAgg, setExpenseAgg] = useState('day');
    const [exportExpensesLoading, setExportExpensesLoading] = useState(false);
    const [analyticsDate, setAnalyticsDate] = useState(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
    const [exportLoading, setExportLoading] = useState(false);
    const [topProductsFromRpc, setTopProductsFromRpc] = useState([]);
    const [loadingTopProducts, setLoadingTopProducts] = useState(false);
    const [expenseRefreshNonce, setExpenseRefreshNonce] = useState(0);
    const [isAddExpenseModalOpen, setIsAddExpenseModalOpen] = useState(false);
    const [expensePreviewState, setExpensePreviewState] = useState(null);
    const [expenseKindFilter, setExpenseKindFilter] = useState('all');

    const [reportAnchorDate] = useState(() => new Date());
    const reportRange = useMemo(
        () => resolveReportPeriodRange(filterPeriod, reportAnchorDate),
        [filterPeriod, reportAnchorDate],
    );

    const expenseChartRange = useMemo(
        () => resolveExpenseChartRange(reportRange, expenseAgg, analyticsDate),
        [reportRange, expenseAgg, analyticsDate],
    );

    const expenseReferenceYear = useMemo(
        () => resolveExpenseReferenceYear(analyticsDate, reportRange),
        [analyticsDate, reportRange],
    );

    const monthlyExportMonthOptions = useMemo(
        () => buildRecentMonthOptions(24, analyticsDate),
        [analyticsDate],
    );

    const currentMonthBucketKey = currentMonthYyyyMm();

    const expenseBucketKeys = useMemo(() => {
        if (!expenseChartRange) return [];
        return expenseBucketKeysForRange(expenseChartRange.start, expenseChartRange.end, expenseAgg);
    }, [expenseChartRange, expenseAgg]);

    const {
        analyticsSummary,
        analyticsSource,
        analyticsOrders,
        loadingAnalyticsOrders,
    } = useAnalyticsData({
        companyId,
        selectedBranch,
        reportRange,
        chartTab,
        view,
        showNotify,
    });

    useEffect(() => {
        if (!companyId) {
            setTopProductsFromRpc([]);
            return;
        }
        let cancelled = false;
        setLoadingTopProducts(true);
        const { startIso, endIso } = resolveTopProductsRange(reportRange);
        (async () => {
            try {
                const rows = await fetchTopProducts({
                    companyId,
                    branchId: selectedBranch?.id,
                    startIso,
                    endIso,
                    limit: 5,
                    showNotify,
                });
                if (!cancelled) setTopProductsFromRpc(rows);
            } catch (e) {
                console.error('Error fetching top products:', e);
                if (!cancelled) setTopProductsFromRpc([]);
            } finally {
                if (!cancelled) setLoadingTopProducts(false);
            }
        })();
        return () => { cancelled = true; };
    }, [
        companyId,
        selectedBranch?.id,
        reportRange.start?.getTime(),
        reportRange.end?.getTime(),
        reportRange.chartDateKeys?.join(','),
        showNotify,
    ]);

    const ordersForAnalytics = useMemo(() => {
        if (!companyId) return Array.isArray(orders) ? orders : [];
        if (analyticsSource === 'none') return [];
        if (loadingAnalyticsOrders && analyticsOrders.length === 0 && Array.isArray(orders) && orders.length > 0) {
            return orders;
        }
        return analyticsOrders;
    }, [companyId, analyticsSource, loadingAnalyticsOrders, analyticsOrders, orders]);

    const branchNameById = useMemo(() => {
        const map = {};
        safeBranches.forEach((b) => {
            if (b?.id != null) map[String(b.id)] = b.name || b.label || String(b.id);
        });
        return map;
    }, [safeBranches]);

    const operatingExpenseRows = useMemo(
        () => (manualExpenseRows || []).filter((r) => isOperatingLocalExpense(r)),
        [manualExpenseRows],
    );

    const withdrawalExpenseRows = useMemo(
        () => (manualExpenseRows || []).filter((r) => isCashWithdrawal(r)),
        [manualExpenseRows],
    );

    const operatingChartData = useMemo(
        () => buildExpenseChartData(operatingExpenseRows, expenseAgg, expenseBucketKeys),
        [operatingExpenseRows, expenseAgg, expenseBucketKeys],
    );

    const withdrawalChartData = useMemo(
        () => buildExpenseChartData(withdrawalExpenseRows, expenseAgg, expenseBucketKeys),
        [withdrawalExpenseRows, expenseAgg, expenseBucketKeys],
    );

    const refundChartData = useMemo(
        () => buildExpenseChartData(refundExpenseRows, expenseAgg, expenseBucketKeys),
        [refundExpenseRows, expenseAgg, expenseBucketKeys],
    );

    const operatingChartPoints = useMemo(
        () => operatingChartData.expenseBarPoints.map((p) => ({ ...p, sales: p.value, expenses: 0 })),
        [operatingChartData.expenseBarPoints],
    );

    const withdrawalChartPoints = useMemo(
        () => withdrawalChartData.expenseBarPoints.map((p) => ({ ...p, sales: p.value, expenses: 0 })),
        [withdrawalChartData.expenseBarPoints],
    );

    const refundChartPoints = useMemo(
        () => refundChartData.expenseBarPoints.map((p) => ({ ...p, sales: p.value, expenses: 0 })),
        [refundChartData.expenseBarPoints],
    );

    const manualExpenseBreakdown = useMemo(() => {
        const rows = manualExpenseRows || [];
        let operating = 0;
        let operatingCount = 0;
        let withdrawals = 0;
        let withdrawalCount = 0;
        for (const row of rows) {
            const amount = Number(row.amount) || 0;
            if (isCashWithdrawal(row)) {
                withdrawals += amount;
                withdrawalCount += 1;
            } else if (isOperatingLocalExpense(row)) {
                operating += amount;
                operatingCount += 1;
            }
        }
        return { operating, operatingCount, withdrawals, withdrawalCount };
    }, [manualExpenseRows]);

    const refundBreakdown = useMemo(() => {
        const rows = refundExpenseRows || [];
        let total = 0;
        for (const row of rows) {
            total += Number(row.amount) || 0;
        }
        return { total, count: rows.length };
    }, [refundExpenseRows]);

    const filteredManualExpenseRows = useMemo(() => {
        if (expenseKindFilter === 'order_refund') return refundExpenseRows || [];
        const rows = manualExpenseRows || [];
        if (expenseKindFilter === 'cash_withdrawal') return rows.filter((r) => isCashWithdrawal(r));
        if (expenseKindFilter === 'operating') return rows.filter((r) => isOperatingLocalExpense(r));
        return [...rows, ...(refundExpenseRows || [])];
    }, [manualExpenseRows, refundExpenseRows, expenseKindFilter]);

    const showOperatingExpenseBlock = expenseKindFilter === 'all' || expenseKindFilter === 'operating';
    const showWithdrawalExpenseBlock = expenseKindFilter === 'all' || expenseKindFilter === 'cash_withdrawal';
    const showRefundExpenseBlock = expenseKindFilter === 'all' || expenseKindFilter === 'order_refund';

    const expenseKindFilterOptions = useMemo(
        () => [
            {
                value: 'all',
                label: 'Todos',
                count: (manualExpenseRows?.length || 0) + (refundExpenseRows?.length || 0),
            },
            {
                value: 'operating',
                label: 'Gastos operativos',
                count: manualExpenseBreakdown.operatingCount,
            },
            {
                value: 'cash_withdrawal',
                label: 'Retiros caja',
                count: manualExpenseBreakdown.withdrawalCount,
            },
            {
                value: 'order_refund',
                label: 'Devoluciones',
                count: refundBreakdown.count,
            },
        ],
        [manualExpenseRows, refundExpenseRows, manualExpenseBreakdown, refundBreakdown],
    );

    const handleExportManualExpensesExcel = async () => {
        if (exportExpensesLoading) return;
        const exportRows = [...(manualExpenseRows || []), ...(refundExpenseRows || [])];
        if (!exportRows.length) {
            if (showNotify) showNotify('No hay gastos del local en este período', 'info');
            return;
        }
        setExportExpensesLoading(true);
        try {
            const rows = [...exportRows].sort(
                (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
            );
            const dataToExport = rows.map((row) => {
                const sh = row[TABLES.cash_shifts] || row.cash_shifts;
                const bid = sh?.branch_id;
                const branchName = bid != null ? (branchNameById[String(bid)] || String(bid)) : '';
                const d = new Date(row.created_at);
                const pm = row.payment_method;
                const metodo =
                    pm === 'cash' ? 'Efectivo' : pm === 'card' ? 'Tarjeta' : pm === 'online' ? 'Transferencia' : String(pm || '');
                return {
                    Fecha: d.toLocaleDateString('es-CL'),
                    Hora: d.toLocaleTimeString('es-CL'),
                    Tipo: labelForManualExpenseKind(row),
                    Sucursal: branchName,
                    Monto: row.amount,
                    Metodo: metodo,
                    Descripcion: row.description || '',
                };
            });
            const tag = reportPeriodExportSlug(filterPeriod);
            downloadExcel(dataToExport, `Gastos_local_${tag}.xls`);
            if (showNotify) showNotify('Excel de gastos generado', 'success');
        } catch {
            if (showNotify) showNotify('Error al exportar gastos', 'error');
        } finally {
            setExportExpensesLoading(false);
        }
    };

    const buildMonthlyManualExpensesExportData = useCallback(async () => {
        if (!companyId) return null;
        const range = getMonthRangeUtc(analyticsDate);
        if (!range) {
            if (showNotify) showNotify('Mes inválido', 'error');
            return null;
        }
        const rows = await cashService.getManualExpenseMovementsInRange({
            companyId,
            branchId: selectedBranch?.id,
            startIso: range.startIso,
            endIso: range.endIso,
        });
        if (!rows.length) {
            if (showNotify) showNotify('No hay gastos del local en ese mes', 'info');
            return null;
        }
        const sorted = [...rows].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        const dataToExport = sorted.map((row) => {
            const sh = row[TABLES.cash_shifts] || row.cash_shifts;
            const bid = sh?.branch_id;
            const branchName = bid != null ? (branchNameById[String(bid)] || String(bid)) : '';
            const d = new Date(row.created_at);
            const pm = row.payment_method;
            const metodo =
                pm === 'cash' ? 'Efectivo' : pm === 'card' ? 'Tarjeta' : pm === 'online' ? 'Transferencia' : String(pm || '');
            return {
                Fecha: d.toLocaleDateString('es-CL'),
                Hora: d.toLocaleTimeString('es-CL'),
                Tipo: labelForManualExpenseKind(row),
                Sucursal: branchName,
                Monto: row.amount,
                Metodo: metodo,
                Descripcion: row.description || '',
            };
        });
        const [year, month] = String(analyticsDate).split('-');
        return {
            rows: dataToExport,
            filename: `Gastos_local_${year || '0000'}_${month || '00'}.xls`,
            title: `Gastos del local — ${analyticsDate}`,
        };
    }, [companyId, analyticsDate, selectedBranch?.id, branchNameById, showNotify]);

    const runMonthlyManualExpensesExport = useCallback(async (action) => {
        if (exportExpensesLoading || !companyId) return;
        setExportExpensesLoading(true);
        try {
            const result = await buildMonthlyManualExpensesExportData();
            if (!result) return;
            const { rows, filename, title } = result;
            if (action === 'modal') {
                setExpensePreviewState({ rows, filename, title });
            } else if (action === 'tab') {
                const opened = openSpreadsheetInNewTab(rows);
                if (!opened && showNotify) {
                    showNotify('Permite ventanas emergentes para ver en pestaña', 'info');
                }
            } else if (action === 'download') {
                downloadExcel(rows, filename);
                if (showNotify) showNotify('Excel de gastos del mes generado', 'success');
            }
        } catch {
            if (showNotify) showNotify('Error al exportar gastos del mes', 'error');
        } finally {
            setExportExpensesLoading(false);
        }
    }, [exportExpensesLoading, companyId, buildMonthlyManualExpensesExportData, showNotify]);

    const tryOpenRegisterExpenseModal = useCallback(() => {
        if (!selectedBranch?.id || selectedBranch.id === 'all' || !isValidBranchId(selectedBranch.id)) {
            if (showNotify) showNotify('Selecciona una sucursal para registrar un movimiento.', 'info');
            return;
        }
        if (!cashSystem?.activeShift) {
            if (showNotify) showNotify('Abre la caja en esta sucursal para registrar movimientos del local.', 'info');
            return;
        }
        setIsAddExpenseModalOpen(true);
    }, [selectedBranch, cashSystem?.activeShift, showNotify]);

    const handleAfterExpenseMovement = useCallback(async () => {
        setExpenseRefreshNonce((n) => n + 1);
        if (typeof cashSystem.refresh === 'function') {
            await cashSystem.refresh();
        }
    }, [cashSystem]);

    const handleConfirmRegisterLocalExpense = useCallback(
        async (type, amount, description, paymentMethod) => {
            return cashSystem.addManualMovement(type, amount, description, paymentMethod, {
                expenseKind: EXPENSE_KIND_OPERATING,
                successMessage: 'Gasto del local registrado',
            });
        },
        [cashSystem],
    );

    const buildMonthlyOrdersExportData = useCallback(async () => {
        const range = getMonthRangeUtc(analyticsDate);
        if (!range) {
            if (showNotify) showNotify('Mes inválido', 'error');
            return null;
        }

        const orderCount = await countOrdersInRange({
            companyId,
            branchId: selectedBranch?.id,
            startIso: range.startIso,
            endIso: range.endIso,
        });
        if (orderCount === 0) {
            if (showNotify) showNotify('No hay datos para exportar en este período', 'info');
            return null;
        }
        if (!confirmLargeExport(orderCount)) {
            return null;
        }

        let query = supabase
            .from(TABLES.orders)
            .select(ORDERS_EXPORT_SELECT)
            .gte('created_at', range.startIso)
            .lt('created_at', range.endIso)
            .order('created_at', { ascending: true });

        if (companyId) {
            query = query.eq('company_id', companyId);
        }

        if (selectedBranch && selectedBranch.id && selectedBranch.id !== 'all') {
            query = query.eq('branch_id', selectedBranch.id);
        }

        const fullMonthOrders = await fetchAllPaginated(query);

        if (!fullMonthOrders || fullMonthOrders.length === 0) {
            if (showNotify) showNotify('No hay datos para exportar en este período', 'info');
            return null;
        }

        const branchById = Object.fromEntries(
            (branches || [])
                .filter((b) => b?.id && b.id !== 'all')
                .map((b) => [String(b.id), b]),
        );

        const rows = fullMonthOrders.map(order => {
            const d = new Date(order.created_at);
            let items = Array.isArray(order.items) ? order.items : [];
            if (typeof order.items === 'string') {
                try { items = JSON.parse(order.items); } catch {}
            }
            const itemsText = items.map(i => `${i.quantity}x ${i.name}`).join(' | ');
            const orderBranch = branchById[String(order.branch_id)] ?? null;
            const orderCurrency = resolveEffectiveCurrency(orderBranch, companyProfile);
            return {
                Fecha: d.toLocaleDateString('es-CL'),
                Hora: d.toLocaleTimeString('es-CL'),
                Cliente: order.client_name,
                [exportIdLabel]: order.client_rut,
                Teléfono: order.client_phone,
                Items: itemsText,
                Total: order.total,
                Moneda: orderCurrency,
                'Método Pago': getPaymentLabel(order) || '',
                'Ref. Pago': order.payment_ref || ''
            };
        });

        const [year, month] = String(analyticsDate).split('-');
        return {
            rows,
            filename: `Reporte_${year || '0000'}_${month || '00'}.xls`,
            title: `Reporte mensual — ${analyticsDate}`,
        };
    }, [analyticsDate, companyId, selectedBranch?.id, branches, companyProfile, exportIdLabel, showNotify]);

    const runMonthlyOrdersExport = useCallback(async (action) => {
        if (exportLoading || !companyId) return;
        setExportLoading(true);
        try {
            const result = await buildMonthlyOrdersExportData();
            if (!result) return;
            const { rows, filename, title } = result;
            if (action === 'modal') {
                setExpensePreviewState({ rows, filename, title });
            } else if (action === 'tab') {
                const opened = openSpreadsheetInNewTab(rows);
                if (!opened && showNotify) {
                    showNotify('Permite ventanas emergentes para ver en pestaña', 'info');
                }
            } else if (action === 'download') {
                downloadExcel(rows, filename);
                if (showNotify) showNotify('Reporte Excel generado', 'success');
            }
        } catch (err) {
            if (showNotify) showNotify('Error al generar reporte: ' + (err instanceof Error ? err.message : String(err)), 'error');
        } finally {
            setExportLoading(false);
        }
    }, [exportLoading, companyId, buildMonthlyOrdersExportData, showNotify]);

    useEffect(() => {
        let cancelled = false;

        const fetchExpenses = async () => {
            setLoadingExpenses(true);
            try {
                let startIso;
                let endIso;
                let prevStartIso;
                let prevEndIso;

                if (expenseAgg === 'month') {
                    const year = resolveExpenseReferenceYear(analyticsDate, reportRange);
                    const yearRange = getCalendarYearRangeLocal(year);
                    if (!yearRange) {
                        if (!cancelled) {
                            setManualExpenseRows([]);
                            setRefundExpenseRows([]);
                            setExpensesData({ total: 0, prevTotal: 0 });
                        }
                        return;
                    }
                    startIso = yearRange.start.toISOString();
                    endIso = yearRange.end.toISOString();
                    const prevYearRange = getCalendarYearRangeLocal(year - 1);
                    if (prevYearRange) {
                        prevStartIso = prevYearRange.start.toISOString();
                        prevEndIso = prevYearRange.end.toISOString();
                    }
                } else {
                    startIso = reportRange.start?.toISOString();
                    endIso = reportRange.end?.toISOString();
                    if (reportRange.hasComparison && reportRange.prevStart && reportRange.prevEnd) {
                        prevStartIso = reportRange.prevStart.toISOString();
                        prevEndIso = reportRange.prevEnd.toISOString();
                    }
                }

                const fetchParams = {
                    companyId: companyId || null,
                    branchId: selectedBranch?.id,
                    startIso,
                    endIso,
                };

                const currentRows = await cashService.getManualExpenseMovementsInRange(fetchParams);
                const currentRefunds = await cashService.getOrderRefundMovementsInRange(fetchParams);
                if (cancelled) return;

                let prevRows = [];
                let prevRefunds = [];
                if (prevStartIso != null && prevEndIso != null) {
                    const prevParams = {
                        companyId: companyId || null,
                        branchId: selectedBranch?.id,
                        startIso: prevStartIso,
                        endIso: prevEndIso,
                    };
                    [prevRows, prevRefunds] = await Promise.all([
                        cashService.getManualExpenseMovementsInRange(prevParams),
                        cashService.getOrderRefundMovementsInRange(prevParams),
                    ]);
                }
                if (cancelled) return;

                const total = currentRows.reduce((acc, m) => acc + (Number(m.amount) || 0), 0)
                    + currentRefunds.reduce((acc, m) => acc + (Number(m.amount) || 0), 0);
                const prevTotal = prevRows.reduce((acc, m) => acc + (Number(m.amount) || 0), 0)
                    + prevRefunds.reduce((acc, m) => acc + (Number(m.amount) || 0), 0);
                setManualExpenseRows(currentRows);
                setRefundExpenseRows(currentRefunds);
                setExpensesData({ total, prevTotal });
            } catch (err) {
                console.error('Error fetching expenses for analytics:', err);
                if (!cancelled) {
                    setManualExpenseRows([]);
                    setRefundExpenseRows([]);
                    setExpensesData({ total: 0, prevTotal: 0 });
                }
            } finally {
                if (!cancelled) setLoadingExpenses(false);
            }
        };

        fetchExpenses();
        return () => { cancelled = true; };
	}, [
		reportRange.start?.getTime(),
		reportRange.end?.getTime(),
		reportRange.prevStart?.getTime(),
		reportRange.prevEnd?.getTime(),
		reportRange.hasComparison,
		reportRange.chartDateKeys?.join(','),
		reportRange.fetchStartIso,
		reportRange.fetchEndIso,
		companyId,
		selectedBranch?.id,
		analyticsDate,
		expenseRefreshNonce,
		expenseAgg,
	]);

    const reportChartData = useMemo(() => {
        const emptyResult = {
            salesChartPoints: [],
            kpis: { total: 0, count: 0, ticket: 0, deliveryTotal: 0, deliveryCount: 0, net: -(expensesData.total || 0) },
            trends: { total: 0, count: 0, ticket: 0, delivery: 0, expenses: 0, net: 0 },
            paymentBreakdown: { cash: 0, card: 0, online: 0 },
            branchStats: [],
        };

        const buildExpensesByDate = (chartDateKeys) => {
            const expensesByDate = {};
            chartDateKeys.forEach((k) => { expensesByDate[k] = 0; });
            for (const row of manualExpenseRows || []) {
                if (!row) continue;
                const iso = row.created_at;
                if (!iso) continue;
                const localDate = new Date(iso).toLocaleDateString('en-CA');
                if (expensesByDate[localDate] !== undefined) {
                    expensesByDate[localDate] += Number(row.amount) || 0;
                }
            }
            return expensesByDate;
        };

        const range = reportRange;
        const prevRange = { start: range.prevStart, end: range.prevEnd };

        const filterByTab = (o) => {
            if (chartTab === 'all') return true;
            if (chartTab === 'online') return isMenuOrder(o);
            if (chartTab === 'store') return !isMenuOrder(o);
            return true;
        };

        const valid = (ordersForAnalytics || []).filter((o) => o && o.status !== 'cancelled');
        const validBranchIds = new Set(safeBranches.map((b) => b.id));

        const current = valid.filter((o) => {
            if (!o) return false;
            const d = new Date(o.created_at);
            return isInReportRange(d, range) && filterByTab(o);
        });

        const prev = valid.filter((o) => {
            if (!o) return false;
            const d = new Date(o.created_at);
            return range.hasComparison && isInReportRange(d, prevRange) && filterByTab(o) && o.branch_id && validBranchIds.has(o.branch_id);
        });

        if (current.length === 0 && !(analyticsSource === 'rpc' && analyticsSummary?.current)) {
            return emptyResult;
        }

        // Para filtros de un solo día mostramos el transcurso por hora.
        const salesChartPoints = range.dayCount === 1
            ? buildHourlySalesPoints(current, range)
            : buildDailySalesPoints(current, range, analyticsSource, analyticsSummary);

        // Los gastos solo tienen desglose diario; para la vista horaria quedan en 0.
        if (range.dayCount !== 1) {
            const expensesByDate = buildExpensesByDate([...range.chartDateKeys]);
            salesChartPoints.forEach((p) => { p.expenses = expensesByDate[p.key] || 0; });
        }

        let totalSales;
        let count;
        let ticket;
        let prevSales;
        let prevCount;
        let prevTicket;
        let deliveryTotal;
        let deliveryCount;
        let paymentBreakdown;
        let branchStats;

        if (analyticsSource === 'rpc' && analyticsSummary?.current && analyticsSummary?.prev) {
            const cur = analyticsSummary.current;
            const prevSummary = analyticsSummary.prev;
            totalSales = cur.totalSales;
            count = cur.orderCount;
            ticket = count > 0 ? totalSales / count : 0;
            prevSales = prevSummary.totalSales;
            prevCount = prevSummary.orderCount;
            prevTicket = prevCount > 0 ? prevSales / prevCount : 0;
            deliveryTotal = cur.deliveryTotal;
            deliveryCount = cur.deliveryCount;
            paymentBreakdown = { ...cur.paymentBreakdown };
            const realBranches = safeBranches.filter((b) => b.id && b.id !== 'all');
            const branchNameLookup = {};
            realBranches.forEach((b) => { branchNameLookup[b.id] = b.name || 'Sucursal sin nombre'; });
            branchStats = (Array.isArray(cur.byBranch) ? cur.byBranch : [])
                .map((b) => ({
                    id: b.branchId,
                    name: branchNameLookup[b.branchId] || (b.branchId === '_sin_asignar_' ? 'Sin asignar' : 'Sucursal eliminada'),
                    total: b.total,
                    count: b.count,
                }))
                .filter((b) => b.total > 0 || b.count > 0)
                .sort((a, b) => b.total - a.total);
        } else {
            totalSales = current.reduce((a, o) => a + Number(o.total), 0);
            count = current.length;
            ticket = count > 0 ? totalSales / count : 0;
            prevSales = prev.reduce((a, o) => a + Number(o.total), 0);
            prevCount = prev.length;
            prevTicket = prevCount > 0 ? prevSales / prevCount : 0;

            const deliveryOrdersCurrent = current.filter((o) => {
                const fee = Number(o?.delivery_fee);
                return Number.isFinite(fee) && fee > 0;
            });
            deliveryCount = deliveryOrdersCurrent.length;
            deliveryTotal = deliveryOrdersCurrent.reduce((a, o) => a + Number(o.delivery_fee), 0);

            paymentBreakdown = { cash: 0, card: 0, online: 0 };
            current.forEach((o) => {
                if (!o) return;
                const breakdown = getOrderPaymentBreakdown(o);
                paymentBreakdown.cash += breakdown.cash;
                paymentBreakdown.card += breakdown.card;
                paymentBreakdown.online += breakdown.online;
            });

            const bStats = {};
            const realBranches = safeBranches.filter((b) => b.id && b.id !== 'all');
            realBranches.forEach((b) => { bStats[b.id] = { id: b.id, name: b.name || 'Sucursal sin nombre', total: 0, count: 0 }; });

            current.forEach((o) => {
                if (!o) return;
                const bid = o.branch_id || '_sin_asignar_';
                if (!bStats[bid]) {
                    const branchName = realBranches.find((b) => b.id === bid)?.name || (bid === '_sin_asignar_' ? 'Sin asignar' : 'Sucursal eliminada');
                    bStats[bid] = { id: bid, name: branchName, total: 0, count: 0 };
                }
                bStats[bid].total += Number(o.total);
                bStats[bid].count += 1;
            });

            branchStats = Object.values(bStats)
                .filter((b) => b.total > 0 || b.count > 0)
                .sort((a, b) => b.total - a.total);
        }

        const totalNet = totalSales - (expensesData.total || 0);
        const prevNet = prevSales - (expensesData.prevTotal || 0);

        const prevTotalDeliveryFees = prev
            .filter((o) => {
                const fee = Number(o?.delivery_fee);
                return Number.isFinite(fee) && fee > 0;
            })
            .reduce((a, o) => a + Number(o.delivery_fee), 0);
        const trendDelivery = prevTotalDeliveryFees === 0
            ? deliveryTotal > 0 ? 100 : 0
            : Math.round(((deliveryTotal - prevTotalDeliveryFees) / prevTotalDeliveryFees) * 100);

        const prevCountForSignificance = analyticsSource === 'rpc' && analyticsSummary?.prev
            ? analyticsSummary.prev.orderCount
            : prevCount;

        return {
            salesChartPoints,
            kpis: {
                total: totalSales,
                count,
                ticket,
                deliveryTotal,
                deliveryCount,
                net: totalNet,
            },
            trends: {
                total: calcTrendPercent(totalSales, prevSales),
                count: calcTrendPercent(count, prevCount),
                ticket: calcTrendPercent(ticket, prevTicket),
                delivery: trendDelivery,
                expenses: !expensesData.prevTotal
                    ? expensesData.total > 0 ? 100 : 0
                    : Math.round(((expensesData.total - expensesData.prevTotal) / expensesData.prevTotal) * 100),
                net: calcTrendPercent(totalNet, prevNet),
            },
            trendSignificance: {
                total: prevCountForSignificance >= MIN_SIGNIFICANT_PREV_ORDERS,
                count: prevCountForSignificance >= MIN_SIGNIFICANT_PREV_ORDERS,
                ticket: prevCountForSignificance >= MIN_SIGNIFICANT_PREV_ORDERS,
                delivery: prevCountForSignificance >= MIN_SIGNIFICANT_PREV_ORDERS,
                expenses: prevCountForSignificance >= MIN_SIGNIFICANT_PREV_ORDERS,
                net: prevCountForSignificance >= MIN_SIGNIFICANT_PREV_ORDERS,
            },
            paymentBreakdown,
            branchStats,
        };
    }, [analyticsSource, analyticsSummary, ordersForAnalytics, reportRange, chartTab, safeBranches, expensesData, manualExpenseRows]);

    const { salesChartPoints, kpis, trends, paymentBreakdown, branchStats, trendSignificance } = reportChartData;

    const paymentDonutData = useMemo(
        () => PAYMENT_META.map((m) => ({ label: m.label, value: paymentBreakdown[m.key] || 0 })),
        [paymentBreakdown.cash, paymentBreakdown.card, paymentBreakdown.online],
    );

    const paymentMethodsTotal = useMemo(
        () => PAYMENT_META.reduce((sum, m) => sum + (Number(paymentBreakdown[m.key]) || 0), 0),
        [paymentBreakdown.cash, paymentBreakdown.card, paymentBreakdown.online],
    );

    const newClientsInfo = useMemo(() => {
        if (!clients) return { count: 0, trend: 0, total: 0 };
        const range = reportRange;
        const prevRange = { start: range.prevStart, end: range.prevEnd };
        const currentNew = clients.filter((c) => c && isInReportRange(new Date(c.created_at || new Date()), range)).length;
        const prevNew = range.hasComparison
            ? clients.filter((c) => c && isInReportRange(new Date(c.created_at || new Date()), prevRange)).length
            : 0;

        return {
            count: currentNew,
            trend: !range.hasComparison
                ? null
                : prevNew === 0
                    ? (currentNew > 0 ? 100 : 0)
                    : Math.round(((currentNew - prevNew) / prevNew) * 100),
            total: clients.length,
        };
    }, [clients, reportRange]);

    const topProducts = topProductsFromRpc;

    const kpiSparklines = useMemo(() => {
        const isHourly = reportRange.dayCount === 1;
        const keys = isHourly
            ? Array.from({ length: 24 }, (_, i) => i)
            : reportRange.chartDateKeys || [];
        if (!keys.length) {
            return {
                total: FLAT_SPARKLINE,
                count: FLAT_SPARKLINE,
                ticket: FLAT_SPARKLINE,
                delivery: FLAT_SPARKLINE,
                clients: FLAT_SPARKLINE,
                expenses: FLAT_SPARKLINE,
                net: FLAT_SPARKLINE,
            };
        }

        const bucket = () => Object.fromEntries(keys.map((k) => [k, 0]));
        const ordersByKey = bucket();
        const deliveryByKey = bucket();
        const clientsByKey = bucket();

        const inRange = (d) => isInReportRange(d, reportRange);
        const tabMatch = (o) => {
            if (chartTab === 'all') return true;
            if (chartTab === 'online') return isMenuOrder(o);
            if (chartTab === 'store') return !isMenuOrder(o);
            return true;
        };

        for (const o of ordersForAnalytics || []) {
            if (!o) continue;
            if (o.status === 'cancelled') continue;
            const d = new Date(o.created_at);
            if (!inRange(d) || !tabMatch(o)) continue;
            const key = isHourly ? d.getHours() : d.toLocaleDateString('en-CA');
            if (ordersByKey[key] === undefined) continue;
            ordersByKey[key] += 1;
            const fee = Number(o.delivery_fee);
            if (Number.isFinite(fee) && fee > 0) deliveryByKey[key] += fee;
        }

        for (const c of clients || []) {
            if (!c) continue;
            const d = new Date(c.created_at || Date.now());
            if (!inRange(d)) continue;
            const key = isHourly ? d.getHours() : d.toLocaleDateString('en-CA');
            if (clientsByKey[key] !== undefined) clientsByKey[key] += 1;
        }

        const toSeries = (obj) => keys.map((k) => obj[k] || 0);
        const salesSeries = salesChartPoints.map((p) => Number(p.sales) || 0);
        const expensesSeries = salesChartPoints.map((p) => Number(p.expenses) || 0);
        const ordersSeries = toSeries(ordersByKey);

        return {
            total: salesSeries,
            count: ordersSeries,
            ticket: keys.map((_, i) => (ordersSeries[i] > 0 ? salesSeries[i] / ordersSeries[i] : 0)),
            delivery: toSeries(deliveryByKey),
            clients: toSeries(clientsByKey),
            expenses: expensesSeries,
            net: salesSeries.map((v, i) => v - expensesSeries[i]),
        };
    }, [reportRange, salesChartPoints, ordersForAnalytics, clients, chartTab]);

    const peakHour = useMemo(() => {
        const hourCounts = buildHourCountsFromAnalytics({
            analyticsSource,
            analyticsSummary,
            ordersForAnalytics,
            reportRange,
        });
        const sorted = Object.entries(hourCounts)
            .map(([h, count]) => ({ hour: Number(h), count: Number(count) || 0 }))
            .filter((row) => row.count > 0)
            .sort((a, b) => b.count - a.count || a.hour - b.hour);
        if (sorted.length === 0) return null;
        const top = sorted[0];
        return {
            hour: formatPeakHourLabel(top.hour),
            count: top.count,
        };
    }, [analyticsSource, analyticsSummary, ordersForAnalytics, reportRange]);

    const peakHourDistribution = useMemo(() => {
        const hourCounts = buildHourCountsFromAnalytics({
            analyticsSource,
            analyticsSummary,
            ordersForAnalytics,
            reportRange,
        });
        const total = Object.values(hourCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
        if (total <= 0) return [];

        const bands = [
            { label: 'Madrugada', hours: [0, 1, 2, 3, 4, 5] },
            { label: 'Mañana', hours: [6, 7, 8, 9, 10, 11] },
            { label: 'Tarde', hours: [12, 13, 14, 15, 16, 17] },
            { label: 'Noche', hours: [18, 19, 20, 21, 22, 23] },
        ].map((b) => {
            const count = b.hours.reduce((sum, h) => sum + (hourCounts[h] || 0), 0);
            return {
                label: b.label,
                count,
                pctOfTotal: Math.round((count / total) * 100),
            };
        });

        const max = Math.max(...bands.map((b) => b.count), 1);
        return bands.map((b) => ({
            ...b,
            pct: Math.round((b.count / max) * 100),
        }));
    }, [analyticsSource, analyticsSummary, ordersForAnalytics, reportRange]);

    const topPeakHours = useMemo(() => {
        const hourCounts = buildHourCountsFromAnalytics({
            analyticsSource,
            analyticsSummary,
            ordersForAnalytics,
            reportRange,
        });
        const rows = Object.entries(hourCounts)
            .map(([h, count]) => ({ hour: Number(h), count: Number(count) || 0 }))
            .filter((row) => row.count > 0)
            .sort((a, b) => b.count - a.count || a.hour - b.hour)
            .slice(0, 5);
        const max = Math.max(...rows.map((r) => r.count), 1);
        return rows.map((row) => ({
            ...row,
            label: formatPeakHourLabel(row.hour),
            pct: Math.round((row.count / max) * 100),
        }));
    }, [analyticsSource, analyticsSummary, ordersForAnalytics, reportRange]);

    const hasSalesChartData = useMemo(
        () => (salesChartPoints || []).some((p) => Number(p.sales) > 0),
        [salesChartPoints],
    );

    const salesChartTitle = reportRange.dayCount === 1 ? 'Ventas por hora' : 'Ventas por día';

    const activeChartKind =
        chartKind === 'bar-gradient'
            ? 'bar-gradient'
            : chartKind === 'bar-solid' || chartKind === 'bar'
              ? 'bar-solid'
              : 'area';

    const reportPeriodHeader = (
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-black tracking-tight text-[#1a1a1a] sm:text-2xl">Reportes</h1>
                    <p className="text-xs font-medium text-[#6b7280] sm:text-sm">
                        Resumen de ventas, pedidos y métricas clave
                    </p>
                </div>
                <div className="sm:hidden">
                    <ReportPeriodSelect
                        className="rpt-period-select--compact w-[150px]"
                        value={filterPeriod}
                        onChange={setFilterPeriod}
                        aria-label="Rango de fechas del informe"
                        icon={<Calendar size={16} strokeWidth={1.65} className="text-[#2563eb]" />}
                    />
                </div>
            </div>
            <div className="hidden sm:flex sm:w-auto">
                <ReportPeriodSelect
                    className="w-full sm:w-[260px]"
                    value={filterPeriod}
                    onChange={setFilterPeriod}
                    aria-label="Rango de fechas del informe"
                    icon={<Calendar size={18} strokeWidth={1.65} className="text-[#2563eb]" />}
                />
            </div>
        </header>
    );

    const gastosLocalSection = (
        <Card className="overflow-hidden">
            <CardContent className="space-y-4 p-4 sm:p-6">
                <LocalExpensesToolbar
                    filterPeriod={filterPeriod}
                    onFilterPeriodChange={setFilterPeriod}
                    expenseAgg={expenseAgg}
                    onExpenseAggChange={setExpenseAgg}
                    aggOptions={EXPENSE_AGG_OPTIONS}
                    expenseKindFilter={expenseKindFilter}
                    onExpenseKindFilterChange={setExpenseKindFilter}
                    kindOptions={expenseKindFilterOptions}
                    expenseReferenceYear={expenseReferenceYear}
                    onRegisterClick={tryOpenRegisterExpenseModal}
                    onExportClick={handleExportManualExpensesExcel}
                    exportLoading={exportExpensesLoading}
                    exportDisabled={!(manualExpenseRows.length || refundExpenseRows.length)}
                />
                <LocalExpensesSummaryBar
                    total={expensesData.total}
                    operating={manualExpenseBreakdown.operating}
                    operatingCount={manualExpenseBreakdown.operatingCount}
                    withdrawals={manualExpenseBreakdown.withdrawals}
                    withdrawalCount={manualExpenseBreakdown.withdrawalCount}
                    refunds={refundBreakdown.total}
                    refundCount={refundBreakdown.count}
                    formatMoney={fmt}
                />
                <p className="text-xs font-medium text-[#6b7280] sm:text-sm">
                    Mercadería, arriendo, sueldo y gastos operativos. Los retiros de efectivo hechos en Caja también
                    aparecen aquí para control del CEO.
                </p>

                <div className="space-y-4">
                    {showOperatingExpenseBlock ? (
                        <LocalExpenseCategoryCard
                            title="Gastos operativos"
                            icon={Receipt}
                            accent="#2563eb"
                            total={manualExpenseBreakdown.operating}
                            count={manualExpenseBreakdown.operatingCount}
                            points={operatingChartPoints}
                            buckets={operatingChartData.expenseBucketsOrdered}
                            periodTotal={operatingChartData.periodTotal}
                            fmt={fmt}
                            currency={currency}
                            loading={loadingExpenses}
                            emptyLabel="Sin gastos operativos en este período."
                            highlightBucketKey={expenseAgg === 'month' ? currentMonthBucketKey : null}
                        />
                    ) : null}

                    {showWithdrawalExpenseBlock ? (
                        <LocalExpenseCategoryCard
                            title="Retiros de caja"
                            icon={Banknote}
                            accent="#0d9488"
                            total={manualExpenseBreakdown.withdrawals}
                            count={manualExpenseBreakdown.withdrawalCount}
                            points={withdrawalChartPoints}
                            buckets={withdrawalChartData.expenseBucketsOrdered}
                            periodTotal={withdrawalChartData.periodTotal}
                            fmt={fmt}
                            currency={currency}
                            loading={loadingExpenses}
                            emptyLabel="Sin retiros de caja en este período."
                            highlightBucketKey={expenseAgg === 'month' ? currentMonthBucketKey : null}
                        />
                    ) : null}

                    {showRefundExpenseBlock ? (
                        <LocalExpenseCategoryCard
                            title="Devoluciones"
                            icon={RotateCcw}
                            accent="#7c3aed"
                            total={refundBreakdown.total}
                            count={refundBreakdown.count}
                            points={refundChartPoints}
                            buckets={refundChartData.expenseBucketsOrdered}
                            periodTotal={refundChartData.periodTotal}
                            fmt={fmt}
                            currency={currency}
                            loading={loadingExpenses}
                            emptyLabel="Sin devoluciones en este período."
                            highlightBucketKey={expenseAgg === 'month' ? currentMonthBucketKey : null}
                        />
                    ) : null}
                </div>

                <div className="space-y-2">
                    <div className="flex items-baseline justify-between gap-3">
                        <h4 className="text-sm font-bold text-[#1a1a1a]">Movimientos recientes</h4>
                        <span className="text-xs font-semibold text-[#6b7280]">Últimos 80</span>
                    </div>
                    <div className="max-h-[280px] overflow-auto rounded-xl border border-[#e5e5ea]">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-[#f5f5f7]">
                                <tr>
                                    <th className="px-4 py-2 text-left text-xs font-bold uppercase text-[#6b7280]">Fecha</th>
                                    <th className="px-4 py-2 text-left text-xs font-bold uppercase text-[#6b7280]">Tipo</th>
                                    <th className="px-4 py-2 text-left text-xs font-bold uppercase text-[#6b7280]">Sucursal</th>
                                    <th className="px-4 py-2 text-left text-xs font-bold uppercase text-[#6b7280]">Método</th>
                                    <th className="px-4 py-2 text-left text-xs font-bold uppercase text-[#6b7280]">Detalle</th>
                                    <th className="px-4 py-2 text-right text-xs font-bold uppercase text-[#6b7280]">Monto</th>
                                </tr>
                            </thead>
                            <tbody>
                                {!filteredManualExpenseRows || filteredManualExpenseRows.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="px-4 py-6 text-center text-sm text-[#6b7280]">
                                            {loadingExpenses
                                                ? 'Cargando…'
                                                : manualExpenseRows.length || refundExpenseRows.length
                                                  ? 'Sin movimientos para este filtro.'
                                                  : 'Sin movimientos.'}
                                        </td>
                                    </tr>
                                ) : (
                                    [...filteredManualExpenseRows]
                                        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                                        .slice(0, 80)
                                        .map((row) => {
                                            const sh = row[TABLES.cash_shifts] || row.cash_shifts;
                                            const bid = sh?.branch_id;
                                            const branchName = bid != null ? (branchNameById[String(bid)] || String(bid)) : '—';
                                            const d = new Date(row.created_at);
                                            const pm = row.payment_method;
                                            const metodo =
                                                pm === 'cash'
                                                    ? 'Efectivo'
                                                    : pm === 'card'
                                                      ? 'Tarjeta'
                                                      : pm === 'online'
                                                        ? 'Transf.'
                                                        : String(pm || '—');
                                            const kindLabel = labelForManualExpenseKind(row);
                                            const isRefund = isOrderLinkedExpense(row);
                                            const isWithdrawal = isCashWithdrawal(row);
                                            const kindBadgeClass = isWithdrawal
                                                ? 'border-transparent bg-teal-50 text-teal-700 hover:bg-teal-50'
                                                : isRefund
                                                  ? 'border-transparent bg-violet-50 text-violet-700 hover:bg-violet-50'
                                                  : 'border-transparent bg-blue-50 text-blue-700 hover:bg-blue-50';
                                            return (
                                                <tr key={row.id} className="border-t border-[#e5e5ea]">
                                                    <td className="px-4 py-2 whitespace-nowrap text-[#1a1a1a]">
                                                        {d.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })}
                                                    </td>
                                                    <td className="px-4 py-2">
                                                        <Badge
                                                            variant="secondary"
                                                            className={`w-[118px] justify-center text-[10px] ${kindBadgeClass}`}
                                                        >
                                                            {kindLabel}
                                                        </Badge>
                                                    </td>
                                                    <td className="px-4 py-2 text-[#1a1a1a]">{branchName}</td>
                                                    <td className="px-4 py-2 text-[#1a1a1a]">{metodo}</td>
                                                    <td className="max-w-[200px] truncate px-4 py-2 text-[#1a1a1a]">{row.description || '—'}</td>
                                                    <td className="px-4 py-2 text-right font-bold tabular-nums text-[#1a1a1a]">{fmt(row.amount)}</td>
                                                </tr>
                                            );
                                        })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </CardContent>
        </Card>
    );

    const monthlyExportBlock = (
        <Card>
            <CardHeader>
                <CardTitle className="text-lg">Descargar Reporte Mensual</CardTitle>
                <CardDescription>{MONTHLY_EXPORT_DISCLAIMER}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="grid items-end gap-3 sm:grid-cols-[auto_1fr]">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-bold uppercase tracking-wider text-[#6b7280]">Seleccionar mes</label>
                        <AdminMenuSelect
                            className="rpt-export-month-select min-w-[200px]"
                            value={analyticsDate}
                            onChange={setAnalyticsDate}
                            options={monthlyExportMonthOptions}
                            icon={<Calendar size={18} strokeWidth={1.65} className="text-[#2563eb]" />}
                            aria-label="Seleccionar mes del reporte"
                            menuMinWidth={220}
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        {[
                            { action: 'download', label: 'Descargar Excel', Icon: Download, variant: 'default' },
                            { action: 'modal', label: 'Ver (modal)', Icon: Eye, variant: 'outline' },
                            { action: 'tab', label: 'Ver (pestaña)', Icon: ExternalLink, variant: 'outline' },
                        ].map(({ action, label, Icon, variant }) => (
                            <Button
                                key={action}
                                variant={variant}
                                onClick={() => runMonthlyOrdersExport(action === 'download-raw' ? 'download' : action)}
                                disabled={exportLoading || !companyId}
                                className="w-full gap-2 sm:w-auto"
                            >
                                {exportLoading ? (
                                    <Loader2 size={16} className="animate-spin" aria-hidden />
                                ) : (
                                    <Icon size={16} aria-hidden />
                                )}
                                <span>{exportLoading ? 'Generando...' : label}</span>
                            </Button>
                        ))}
                    </div>
                </div>
            </CardContent>
        </Card>
    );

    if (view === 'expensesOnly') {
        return (
            <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-6 p-4 sm:p-6 animate-fade">
                {gastosLocalSection}
                {monthlyExportBlock}
                <LocalExpenseModal
                    isOpen={isAddExpenseModalOpen}
                    onClose={() => setIsAddExpenseModalOpen(false)}
                    branchId={selectedBranch?.id}
                    branchName={selectedBranch?.name || selectedBranch?.label}
                    activeShift={cashSystem?.activeShift}
                    onConfirmOperating={handleConfirmRegisterLocalExpense}
                    registerRefund={cashSystem?.registerRefund}
                    moveOrder={moveOrder}
                    showNotify={showNotify}
                    companyId={companyId}
                    onAfterSuccess={handleAfterExpenseMovement}
                />
                <SpreadsheetPreviewModal
                    isOpen={!!expensePreviewState}
                    onClose={() => setExpensePreviewState(null)}
                    title={expensePreviewState?.title ?? 'Vista previa'}
                    rows={expensePreviewState?.rows ?? []}
                    filename={expensePreviewState?.filename ?? 'reporte.xls'}
                />
            </div>
        );
    }

    return (
        <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-6 p-4 sm:p-6 animate-fade">
            {reportPeriodHeader}

            {multiCurrencyWarning ? (
                <p className="rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs font-semibold text-[#6b7280]">
                    {multiCurrencyWarning}
                </p>
            ) : null}
            {analyticsSource === 'fallback' && (
                <p className="rounded-xl border border-[#e5e5ea] bg-white p-3 text-xs font-semibold text-[#6b7280]">
                    Mostrando hasta 2000 pedidos; las métricas pueden estar truncadas.
                </p>
            )}

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
                {KPI_META.map((meta) => {
                    const value = meta.key === 'clients' ? newClientsInfo.count : meta.key === 'expenses' ? expensesData.total : kpis[meta.key];
                    const trendKey = meta.key === 'clients' ? null : resolveKpiTrendKey(meta.key);
                    const trend = meta.key === 'clients' ? newClientsInfo.trend : trends[trendKey];
                    const spark = kpiSparklines[resolveKpiSparkKey(meta.key)] ?? FLAT_SPARKLINE;
                    const loading = meta.key === 'clients' ? false : loadingAnalyticsOrders && kpis.count === 0;
                    const subtitle = meta.key === 'deliveryTotal'
                        ? `${(kpis.deliveryCount ?? 0).toLocaleString('es-CL')} pedido${(kpis.deliveryCount ?? 0) === 1 ? '' : 's'} · solo tarifas`
                        : undefined;
                    const trendSignificant = meta.key === 'clients'
                        ? true
                        : trendSignificance?.[resolveKpiTrendKey(meta.key)] ?? true;
                    return (
                        <KpiCard
                            key={meta.key}
                            meta={meta}
                            value={value}
                            trend={trend}
                            sparklineValues={spark}
                            loading={loading}
                            fmt={fmt}
                            subtitle={subtitle}
                            showTrend={reportRange.hasComparison}
                            trendSignificant={trendSignificant}
                        />
                    );
                })}
            </div>

            <div className="grid min-w-0 items-start gap-5 md:grid-cols-1 lg:grid-cols-[1fr_minmax(280px,320px)] xl:grid-cols-[1fr_minmax(300px,380px)]">
                <div className="flex min-w-0 flex-col gap-5">
                    <Card className="flex h-fit min-w-0 flex-col">
                        <CardHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
                            <CardTitle className="text-base font-semibold text-[#14161a]">{salesChartTitle}</CardTitle>
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:justify-end">
                                <div className="rpt-chart-kind">
                                    {CHART_KIND_OPTIONS.map(({ value, label, Icon }) => (
                                        <Button variant="default"
                                            key={value}
                                            type="button"
                                            className={`rpt-chart-kind-btn ${activeChartKind === value ? 'active' : ''}`}
                                            onClick={() => setChartKind(value)}
                                            title={label}
                                            aria-pressed={activeChartKind === value}
                                        >
                                            <Icon size={14} strokeWidth={1.75} aria-hidden />
                                            <span className="rpt-chart-kind-label">{label}</span>
                                        </Button>
                                    ))}
                                </div>
                                <Tabs value={chartTab} onValueChange={setChartTab}>
                                    <TabsList className="h-8 sm:h-9">
                                        <TabsTrigger value="all" className="px-2 text-[11px] sm:px-3 sm:text-xs">Todos</TabsTrigger>
                                        <TabsTrigger value="store" className="px-2 text-[11px] sm:px-3 sm:text-xs">Tienda</TabsTrigger>
                                        <TabsTrigger value="online" className="px-2 text-[11px] sm:px-3 sm:text-xs">Online</TabsTrigger>
                                    </TabsList>
                                </Tabs>
                            </div>
                        </CardHeader>
                        <CardContent className="p-4 pt-2">
                            {hasSalesChartData ? (
                                <ReportSalesChart
                                    points={salesChartPoints}
                                    kind={activeChartKind}
                                    filter={chartTab}
                                    currency={currency}
                                    height={260}
                                />
                            ) : (
                                <div className="flex h-[260px] flex-col items-center justify-center gap-3 text-center text-[#6b7280]">
                                    <LineChart size={44} strokeWidth={1.5} className="text-[#2563eb]/55" aria-hidden />
                                    <p className="text-base font-bold text-[#1a1a1a]">Sin datos de ventas</p>
                                    <span className="max-w-[28ch] text-sm">No hay ventas en este período. Probá otro rango o canal.</span>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {peakHour && (
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="flex items-center gap-2 text-base font-semibold text-[#14161a]">
                                    <Clock size={18} className="text-[#2563eb]" />
                                    Hora pico
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div>
                                    <p className="text-2xl font-bold text-[#14161a]">{peakHour.hour}</p>
                                    <p className="text-xs font-medium text-[#6b7280]">{peakHour.count} pedidos en este horario</p>
                                </div>
                                {topPeakHours.length > 0 ? (
                                    <div className="space-y-2">
                                        <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">Top horarios</p>
                                        {topPeakHours.map((row, idx) => (
                                            <div key={`${row.label}-${row.count}`} className="flex items-center gap-3">
                                                <span className="w-[4.5rem] shrink-0 text-xs font-medium text-[#6b7280]">{row.label}</span>
                                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#f5f5f7]">
                                                    <div
                                                        className="h-full rounded-full bg-[#2563eb] rpt-animate-bar"
                                                        style={{
                                                            '--rpt-bar-width': `${row.pct}%`,
                                                            opacity: 0.3 + (row.pct / 100) * 0.7,
                                                            animationDelay: `${idx * 60}ms`,
                                                        }}
                                                    />
                                                </div>
                                                <span className="w-8 text-right text-xs font-semibold text-[#14161a]">{row.count}</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                                {peakHourDistribution.length > 0 ? (
                                    <div className="space-y-2 border-t border-[#ededf0] pt-3">
                                        <p className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">Por franja</p>
                                        {peakHourDistribution.map((b, idx) => (
                                            <div key={`${b.label}-${b.pct}`} className="flex items-center gap-3">
                                                <span className="w-20 text-xs font-medium text-[#6b7280]">{b.label}</span>
                                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#f5f5f7]">
                                                    <div
                                                        className="h-full rounded-full bg-[#93c5fd] rpt-animate-bar"
                                                        style={{ '--rpt-bar-width': `${b.pct}%`, animationDelay: `${idx * 60}ms` }}
                                                    />
                                                </div>
                                                <span className="w-10 text-right text-xs font-semibold text-[#14161a]">{b.pctOfTotal}%</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base font-semibold text-[#14161a]">
                                <Package size={20} className="text-[#2563eb]" />
                                Top productos vendidos
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {loadingTopProducts ? (
                                <div className="py-8 text-center text-sm text-[#6b7280]">Cargando top productos…</div>
                            ) : topProducts.length === 0 ? (
                                <div className="py-8 text-center text-sm text-[#6b7280]">No hay datos de productos en este período.</div>
                            ) : (
                                <div className="space-y-3">
                                    {topProducts.map((p, i) => {
                                        const maxQty = topProducts[0]?.qty || 1;
                                        const pct = Math.round((p.qty / maxQty) * 100);
                                        const opacity = Math.max(0.25, pct / 100);
                                        return (
                                            <div key={`${p.name}-${i}`} className="flex items-center gap-4">
                                                <span className="w-7 text-sm font-black text-[#2563eb]">#{i + 1}</span>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-sm font-semibold text-[#14161a]">{p.name}</p>
                                                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[#f5f5f7]">
                                                        <div
                                                            className="h-full rounded-full rpt-animate-bar"
                                                            style={{ '--rpt-bar-width': `${pct}%`, background: '#2563eb', opacity, animationDelay: `${i * 80}ms` }}
                                                        />
                                                    </div>
                                                </div>
                                                <div className="shrink-0 text-right">
                                                    <p className="text-sm font-bold text-[#1a1a1a]">{fmt(p.revenue)}</p>
                                                    <p className="text-xs font-medium text-[#6b7280]">{p.qty} uds</p>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                <div className="flex min-w-0 flex-col gap-5">
                    <Card className="min-w-0">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                <CreditCard size={18} className="text-[#2563eb]" />
                                Métodos de pago
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <ReportPaymentDonut
                                data={paymentDonutData}
                                currency={currency}
                            />
                            <div className="space-y-2.5">
                                {PAYMENT_META.map((pm, idx) => {
                                    const value = paymentBreakdown[pm.key] || 0;
                                    const pct = paymentMethodsTotal > 0
                                        ? Math.round((value / paymentMethodsTotal) * 100)
                                        : 0;
                                    const Icon = pm.Icon;
                                    return (
                                        <div key={`${pm.key}-${pct}`} className="space-y-1.5">
                                            <div className="flex items-center justify-between gap-3 text-sm">
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${pm.bg}`}>
                                                        <Icon size={14} style={{ color: pm.color }} />
                                                    </div>
                                                    <span className="truncate font-semibold text-[#1a1a1a]">{pm.label}</span>
                                                </div>
                                                <div className="shrink-0 text-right">
                                                    <p className="font-bold text-[#1a1a1a]">{fmt(value)}</p>
                                                    <p className="text-xs font-medium text-[#6b7280]">{pct}%</p>
                                                </div>
                                            </div>
                                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f5f5f7]">
                                                <div
                                                    className="h-full rounded-full rpt-animate-bar"
                                                    style={{ '--rpt-bar-width': `${pct}%`, background: pm.color, animationDelay: `${idx * 80}ms` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center justify-between gap-2 text-base font-semibold text-[#14161a]">
                                <span className="inline-flex items-center gap-2">
                                    <Users size={18} className="text-[#2563eb]" />
                                    Clientes nuevos
                                </span>
                                {reportRange.hasComparison ? (
                                    <TrendBadge
                                        value={newClientsInfo.trend}
                                        isSignificant
                                    />
                                ) : null}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div>
                                <p className="text-[28px] font-bold leading-none tracking-tight text-[#14161a]">
                                    {newClientsInfo.count.toLocaleString('es-CL')}
                                </p>
                                <p className="mt-1 text-xs font-medium text-[#6b7280]">
                                    altas en {reportRange.displayLabel}
                                </p>
                            </div>
                            <div className="h-16 w-full">
                                <ReportSparkline
                                    values={kpiSparklines.clients}
                                    trend={newClientsInfo.trend}
                                    showTrend={reportRange.hasComparison}
                                    height={64}
                                    color="#16a34a"
                                    valueFormatter={(v) => `${Math.round(Number(v) || 0).toLocaleString('es-CL')} clientes`}
                                />
                            </div>
                            <div className="border-t border-[#ededf0] pt-3 text-sm">
                                <p className="font-bold text-[#14161a]">
                                    {newClientsInfo.total.toLocaleString('es-CL')} registrados en total
                                </p>
                                <p className="text-xs font-medium text-[#6b7280]">
                                    Base acumulada de clientes (no es % del periodo)
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    {branchStats.length > 0 && (
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="flex items-center gap-2 text-base font-semibold text-[#14161a]">
                                    <MapPin size={18} className="text-[#2563eb]" />
                                    Ventas por Sucursal
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {branchStats.map((b, idx) => {
                                    const pct = kpis.total > 0 ? Math.round((b.total / kpis.total) * 100) : 0;
                                    return (
                                    <div key={`${b.id}-${pct}`} className="space-y-1.5">
                                        <div className="flex items-center justify-between gap-3 text-sm">
                                            <span className="min-w-0 truncate font-medium text-[#14161a]">{b.name}</span>
                                            <div className="shrink-0 text-right">
                                                    <p className="font-bold text-[#14161a]">{fmt(b.total)}</p>
                                                    <p className="text-xs font-medium text-[#6b7280]">{pct}%</p>
                                                </div>
                                            </div>
                                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#f5f5f7]">
                                                <div
                                                    className="h-full rounded-full bg-[#2563eb] rpt-animate-bar"
                                                    style={{ '--rpt-bar-width': `${pct}%`, opacity: 0.25 + (pct / 100) * 0.75, animationDelay: `${idx * 80}ms` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>

            {monthlyExportBlock}

            <LocalExpenseModal
                isOpen={isAddExpenseModalOpen}
                onClose={() => setIsAddExpenseModalOpen(false)}
                branchId={selectedBranch?.id}
                branchName={selectedBranch?.name || selectedBranch?.label}
                activeShift={cashSystem?.activeShift}
                onConfirmOperating={handleConfirmRegisterLocalExpense}
                registerRefund={cashSystem?.registerRefund}
                moveOrder={moveOrder}
                showNotify={showNotify}
                companyId={companyId}
                onAfterSuccess={handleAfterExpenseMovement}
            />
            <SpreadsheetPreviewModal
                isOpen={!!expensePreviewState}
                onClose={() => setExpensePreviewState(null)}
                title={expensePreviewState?.title ?? 'Vista previa'}
                rows={expensePreviewState?.rows ?? []}
                filename={expensePreviewState?.filename ?? 'reporte.xls'}
            />
        </div>
    );
};

export default AdminAnalytics;
