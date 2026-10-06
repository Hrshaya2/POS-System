import React from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { getMovements, deleteAdjustmentMovement } from './services/stockService';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Wrench,
  BarChart3,
  Users,
  LogOut,
  TrendingUp,
  AlertTriangle,
  Clock,
  Coins,
  Boxes,
  Trash2,
  Settings,
  Database,
  Menu,
  X
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { CloudOff, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';

import { AuthProvider, useAuth } from './context/AuthContext';
import { SessionProvider, useSession } from './context/SessionContext';
import { SyncProvider, useSync } from './context/SyncContext';
import ErrorBoundary from './components/ErrorBoundary';
import ThemeToggle from './components/ThemeToggle';
import LogoLoader from './components/LogoLoader';
import { ThemeProvider, useTheme } from './hooks/useTheme.jsx';
import OpenSessionModal from './components/CashSession/OpenSessionModal';
import CloseSessionModal from './components/CashSession/CloseSessionModal';
import SyncStatusIndicator from './components/SyncStatusIndicator';
import OfflineBanner from './components/OfflineBanner';
import Login from './pages/Login';
import UsersPage from './pages/UsersPage';
import StockManagementPage from './pages/StockManagementPage';
import SalesPage from './pages/SalesPage';
import RepairPage from './pages/RepairPage';
import ReportsPage from './pages/ReportsPage';
import CashSessionHistoryPage from './pages/CashSessionHistoryPage';
import SettingsPage from './pages/SettingsPage';
import ManageStoragePage from './pages/ManageStoragePage';
import StorageWarningBanner from './components/StorageWarningBanner';
import LocalDbWarningBanner from './components/LocalDbWarningBanner';

// MOCK DATA REMOVED - using live backend API instead

// --- AUTH PROTECTED ROUTE ---
const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user, loading: authLoading } = useAuth();
  const { isOpen, loading: sessionLoading } = useSession();

  if (authLoading || sessionLoading) {
    // First paint of the app: show the brand mark rather than bare text.
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-[#0b1220] flex items-center justify-center">
        <LogoLoader size={88} label="Starting Loyal Mobile…" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />; // Unauthorized
  }
  return (
    <>
      {children}
    </>
  );
};

// --- COMPONENTS ---

const SidebarItem = ({ icon: Icon, label, path }) => {
  const location = useLocation();
  const isActive = location.pathname === path || (path === '/' && location.pathname === '');

  return (
    <Link
      to={path}
      className={`flex items-center space-x-3 px-4 py-3 rounded-xl transition-all duration-200 ${isActive
        ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
        : 'text-gray-400 dark:text-slate-500 hover:bg-gray-800 hover:dark:bg-slate-900 hover:text-white'
        }`}
    >
      <Icon size={20} className={isActive ? "text-white" : "text-gray-400"} />
      <span className="font-medium">{label}</span>
    </Link>
  );
};

const Layout = ({ children }) => {
  const { user, logout } = useAuth();
  const { isOpen } = useSession();
  const [showCloseModal, setShowCloseModal] = React.useState(false);
  const [showOpenModal, setShowOpenModal] = React.useState(false);
  // Mobile drawer state. The sidebar is a fixed panel on desktop (>=lg) and an
  // overlay drawer below that breakpoint. `useLocation` is imported at the top
  // of this module, so we can read the current path directly and close the
  // drawer on navigation without threading a callback through SidebarItem.
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // Close the drawer whenever the route changes, so tapping a nav item
  // navigates and dismisses the menu in one action.
  React.useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the drawer is open so the page behind it cannot
  // scroll on touch devices.
  React.useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  // Escape closes the drawer (keyboard parity with the backdrop / close button).
  React.useEffect(() => {
    if (!sidebarOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSidebarOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-slate-950 dark:bg-[#0b1220] text-gray-900 dark:text-slate-100 font-sans overflow-hidden">
      {/* Mobile drawer backdrop. Only rendered below the lg breakpoint while open. */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      {/* Desktop (>=lg): static w-64 panel as before. Mobile: fixed overlay drawer
          that slides in from the left and sits above the backdrop. */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 bg-gray-900 dark:bg-slate-950 h-full flex flex-col shadow-2xl border-r border-gray-800 dark:border-slate-800 transition-transform duration-200 ease-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className="p-6 flex items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
          <div className="p-0">
            <img src="/logo.png" alt="Loyal Mobile" className="w-14 12 object-cover rounded-full border-3 order-white shadow-md" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            LOYAL <span className="text-blue-300">MOBILE</span>
          </h1>
        </div>
          {/* Close button — drawer only, visible below lg. */}
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
            className="lg:hidden p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4 overflow-y-auto">
          <SidebarItem icon={LayoutDashboard} label="Dashboard" path="/" />
          <SidebarItem icon={ShoppingCart} label="Sales / Billing" path="/sales" />
          <SidebarItem icon={Boxes} label="Stock Management" path="/stock" />
          <SidebarItem icon={Wrench} label="Repairs" path="/repairs" />

          {(user?.role === 'admin' || user?.role === 'shop_owner') && (
            <>
              <SidebarItem icon={BarChart3} label="Reports" path="/reports" />
              <SidebarItem icon={Coins} label="Sessions" path="/sessions" />
              <SidebarItem icon={Users} label="Users" path="/users" />
              <SidebarItem icon={Settings} label="Settings" path="/settings" />
              <SidebarItem icon={Database} label="Manage Storage" path="/storage" />
            </>
          )}
        </nav>

        <div className="p-4 border-t border-gray-800 dark:border-slate-700">
          <button onClick={logout} className="flex items-center space-x-3 px-4 py-3 w-full text-left text-gray-400 dark:text-slate-500 hover:bg-gray-800 hover:dark:bg-slate-900 hover:text-white rounded-xl transition-colors">
            <LogOut size={20} />
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 h-full overflow-y-auto bg-[#f8fafc] dark:bg-[#0b1220]">
        {/* Offline Banner (only shows when offline) */}
        <OfflineBanner />

        {/* Top Header */}
        <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-md sticky top-0 z-10 border-b border-gray-200 dark:border-slate-800 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 flex justify-between items-center gap-3 shadow-sm">
          {/* Hamburger — opens the sidebar drawer. Desktop (>=lg) keeps the
              always-visible sidebar, so this is hidden there. */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="lg:hidden shrink-0 -ml-1 p-2 rounded-xl text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100 transition-colors"
          >
            <Menu size={22} />
          </button>

          <h2 className="text-base sm:text-xl font-semibold text-gray-800 dark:text-slate-100 truncate min-w-0">Branch: Main Store (Colombo)</h2>
          <div className="flex items-center gap-2 sm:gap-4 flex-wrap justify-end min-w-0">
            <SyncStatusIndicator />
            {isOpen ? (
              <button
                onClick={() => setShowCloseModal(true)}
                className="bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 hover:bg-rose-100 px-4 py-2 rounded-xl text-sm font-bold transition-all shadow-sm flex items-center space-x-2"
              >
                <span>End Day</span>
              </button>
            ) : (
              <button
                onClick={() => setShowOpenModal(true)}
                className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 px-4 py-2 rounded-xl text-sm font-bold transition-all shadow-sm flex items-center space-x-2"
              >
                <span>Open Day</span>
              </button>
            )}
            {/* Light/Dark toggle sits immediately left of the admin profile. */}
            <ThemeToggle />
            <div className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 flex items-center justify-center text-white font-bold shadow-md uppercase">
              {user?.name?.charAt(0) || 'U'}
            </div>
            {/* Role/name text is hidden below sm — the avatar + menu remain. */}
            <div className="hidden sm:block">
              <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">{user?.name || 'User'}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 uppercase">{user?.role || 'Guest'}</p>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="p-4 sm:p-6 lg:p-8">
          {children}
        </div>
      </main>

      {showCloseModal && <CloseSessionModal onClose={() => setShowCloseModal(false)} />}
      {showOpenModal && <OpenSessionModal onClose={() => setShowOpenModal(false)} />}
    </div>
  );
};

const StatCard = ({ title, value, subtitle, icon: Icon, colorClass, bgClass }) => (
  <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-gray-100 dark:border-slate-800 hover:shadow-md transition-shadow">
    <div className="flex justify-between items-start">
      <div>
        <p className="text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">{title}</p>
        <h3 className="text-3xl font-bold text-gray-900 dark:text-slate-100">{value}</h3>
      </div>
      <div className={`p-3 rounded-xl ${bgClass}`}>
        <Icon size={24} className={colorClass} />
      </div>
    </div>
    <div className="mt-4 flex items-center space-x-2 text-sm">
      <TrendingUp size={16} className="text-emerald-500" />
      <span className="text-emerald-500 dark:text-emerald-400 font-medium">{subtitle}</span>
      <span className="text-gray-400">vs last month</span>
    </div>
  </div>
);

// --- SYNC STATUS BADGE (kept for backward compat with backend polling) ---
const SyncStatusBadge = () => {
  const { status: localStatus } = useSync();
  const [status, setStatus] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const fetchSyncStatus = React.useCallback(async () => {
    // If offline, prefer the local IndexedDB status
    if (!navigator.onLine) {
      setLoading(false);
      return;
    }
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/sync-status', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch sync status", err);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchSyncStatus();
    // Poll every 15 seconds to keep status fresh
    const interval = setInterval(fetchSyncStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchSyncStatus]);

  // Local IndexedDB status takes priority
  if (localStatus?.pendingCounts?.total > 0) {
    return <SyncStatusIndicator />;
  }

  if (loading) {
    return (
      <div className="bg-gray-50 dark:bg-slate-950 border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2">
        <RefreshCw size={16} className="animate-spin" />
        <span>Checking sync...</span>
      </div>
    );
  }

  if (!status?.mongoConfigured) {
    return (
      <div className="bg-gray-50 dark:bg-slate-950 border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2">
        <CloudOff size={16} />
        <span>Sync not configured</span>
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <div className="bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
        <AlertCircle size={16} />
        <span>MongoDB Not Connected</span>
      </div>
    );
  }

  return (
    <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300 px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
      <CheckCircle2 size={16} />
      <span>Cloud Synced</span>
      {status.lastSyncAt && (
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 opacity-80">
          {new Date(status.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
};

const Dashboard = () => {
  const { user } = useAuth();
  const { status: syncStatus } = useSync();
  // Charts take colours as props, not classes, so their axis/grid/tooltip
  // colours are read from the active theme rather than left hardcoded light.
  const { isDark } = useTheme();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`/api/dashboard?tzOffset=${new Date().getTimezoneOffset()}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          setData(await res.json());
        }
      } catch (err) {
        console.error("Failed to fetch dashboard", err);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboard();

    // Poll every 15 seconds so Today's Sales and the chart stay fresh
    const interval = setInterval(fetchDashboard, 15000);
    return () => clearInterval(interval);
  }, []);

  // Refresh when a background sync completes (pending count drops to 0)
  const prevPendingRef = React.useRef(syncStatus?.pendingCounts?.total);
  React.useEffect(() => {
    const prev = prevPendingRef.current;
    const current = syncStatus?.pendingCounts?.total;
    prevPendingRef.current = current;

    // If we had pending items and now they're all synced, refresh the dashboard
    if (prev > 0 && current === 0) {
      const token = localStorage.getItem('token');
      fetch(`/api/dashboard?tzOffset=${new Date().getTimezoneOffset()}`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then((res) => res.ok ? res.json() : null)
        .then((fresh) => { if (fresh) setData(fresh); })
        .catch((err) => console.error("Failed to refresh dashboard after sync", err));
    }
  }, [syncStatus?.pendingCounts?.total]);

  // Staff Stock Adjustments — admin/owner oversight of cashier stock edits.
  const [adjustments, setAdjustments] = React.useState([]);
  const loadAdjustments = React.useCallback(async () => {
    try {
      setAdjustments(await getMovements({ type: 'ADJUSTMENT', limit: 50 }));
    } catch (err) {
      console.error('Failed to load adjustments', err);
    }
  }, []);
  React.useEffect(() => { loadAdjustments(); }, [loadAdjustments]);

  const handleDeleteAdjustment = async (m) => {
    if (!window.confirm(`Delete ${m.user_name || 'this staff member'}'s ${Number(m.quantity_change) > 0 ? '+' : ''}${m.quantity_change} adjustment for "${m.item_name}"? The stock change will be reversed.`)) return;
    try {
      await deleteAdjustmentMovement(m, user);
      setAdjustments((prev) => prev.filter((x) => x.id !== m.id && x.localKey !== m.localKey));
      await loadAdjustments();
      const token = localStorage.getItem('token');
      fetch(`/api/dashboard?tzOffset=${new Date().getTimezoneOffset()}`, { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => res.ok ? res.json() : null)
        .then((fresh) => { if (fresh) setData(fresh); })
        .catch((err) => console.error('Failed to refresh dashboard after delete', err));
    } catch (err) {
      alert(err.message || 'Could not delete the adjustment record');
    }
  };

  if (loading) return <div className="p-8 text-gray-500 dark:text-slate-400">Loading dashboard...</div>;
  if (!data) return <div className="p-8 text-gray-500 dark:text-slate-400">Failed to load dashboard data.</div>;

  const { stats, repairStatusCounts, recentSales, deadStockList, salesTrend } = data;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Dashboard Overview</h1>
          <p className="text-gray-500 dark:text-slate-400 mt-1">Welcome back, {user?.name}! Here's what's happening today.</p>
        </div>
        <div className="flex items-center space-x-3">
          <SyncStatusBadge />
          <Link to="/sales" className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-medium shadow-lg shadow-blue-500/30 transition-all flex items-center space-x-2">
            <ShoppingCart size={18} />
            <span>New Sale</span>
          </Link>
        </div>
      </div>

      {/* MongoDB storage warning — admins only, appears automatically above 500MB */}
      <StorageWarningBanner />

      {/* Local SQLite warning — appears when running online-only (no local DB) */}
      <LocalDbWarningBanner />

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Today's Sales"
          value={`Rs. ${stats.todaySales.toLocaleString('en-LK')}`}
          subtitle={`${stats.salesGrowth >= 0 ? '+' : ''}${Math.round(stats.salesGrowth)}%`}
          icon={ShoppingCart}
          colorClass="text-blue-600"
          bgClass="bg-blue-50"
        />
        <StatCard
          title="Repairs In Progress"
          value={stats.repairsInProgress}
          subtitle="active"
          icon={Wrench}
          colorClass="text-indigo-600"
          bgClass="bg-indigo-50"
        />
        <StatCard
          title="Low Stock Alerts"
          value={stats.lowStockCount}
          subtitle="items low"
          icon={AlertTriangle}
          colorClass="text-orange-500"
          bgClass="bg-orange-50"
        />
        <StatCard
          title="Dead Stock Items"
          value={stats.deadStockCount}
          subtitle="> 30 days"
          icon={Package}
          colorClass="text-rose-500"
          bgClass="bg-rose-50"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-gray-100 dark:border-slate-800">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Sales Trend (Last 7 Days)</h3>
            <select className="bg-gray-50 dark:bg-slate-950 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2">
              <option>Last 7 days</option>
              <option>This Month</option>
            </select>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={salesTrend} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#1e293b' : '#f1f5f9'} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: isDark ? '#94a3b8' : '#64748b', fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: isDark ? '#94a3b8' : '#64748b', fontSize: 12 }} dx={-10} />
                <Tooltip
                  contentStyle={{
                    borderRadius: '12px',
                    border: 'none',
                    backgroundColor: isDark ? '#1e293b' : '#ffffff',
                    color: isDark ? '#e2e8f0' : '#0f172a',
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.3)'
                  }}
                  labelStyle={{ color: isDark ? '#e2e8f0' : '#0f172a' }}
                  itemStyle={{ color: isDark ? '#e2e8f0' : '#0f172a' }}
                  formatter={(value) => [`Rs. ${value}`, 'Sales']}
                />
                <Area type="monotone" dataKey="sales" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Repair Jobs Status */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-gray-100 dark:border-slate-800 flex flex-col">
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 mb-6 flex items-center">
            <Wrench className="mr-2 text-indigo-500 dark:text-indigo-400" size={20} /> Repair Status
          </h3>
          <div className="flex-1 flex flex-col justify-center space-y-6">
            <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-500/10 rounded-xl border border-amber-100 dark:border-amber-500/20">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                <span className="font-medium text-amber-900 dark:text-amber-100">Received</span>
              </div>
              <span className="text-xl font-bold text-amber-700 dark:text-amber-300">{repairStatusCounts.Received || 0}</span>
            </div>

            <div className="flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-500/10 rounded-xl border border-blue-100 dark:border-blue-500/20">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></div>
                <span className="font-medium text-blue-900 dark:text-blue-100">In Repair</span>
              </div>
              <span className="text-xl font-bold text-blue-700 dark:text-blue-300">{repairStatusCounts['In Repair'] || 0}</span>
            </div>

            <div className="flex items-center justify-between p-4 bg-emerald-50 dark:bg-emerald-500/10 rounded-xl border border-emerald-100 dark:border-emerald-500/20">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                <span className="font-medium text-emerald-900 dark:text-emerald-100">Ready for Pickup</span>
              </div>
              <span className="text-xl font-bold text-emerald-700 dark:text-emerald-300">{repairStatusCounts['Ready for Pickup'] || 0}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Recent Sales Table */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
          <div className="p-6 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
              <Clock className="mr-2 text-blue-500 dark:text-blue-400" size={20} /> Recent Sales
            </h3>
            <button className="text-sm text-blue-600 dark:text-blue-400 font-medium hover:text-blue-700">View All</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-gray-500 dark:text-slate-400">
              <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/50 dark:bg-slate-950/50">
                <tr>
                  <th scope="col" className="px-6 py-3 font-medium">Txn ID</th>
                  <th scope="col" className="px-6 py-3 font-medium">Item</th>
                  <th scope="col" className="px-6 py-3 font-medium">Amount</th>
                  <th scope="col" className="px-6 py-3 font-medium">Cashier</th>
                  <th scope="col" className="px-6 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {recentSales.length === 0 ? (
                  <tr><td colSpan="5" className="px-6 py-6 text-center text-gray-400 dark:text-slate-500">No sales recorded yet today.</td></tr>
                ) : recentSales.map((sale) => (
                  <tr key={sale.id} className="bg-white dark:bg-slate-800 border-b border-gray-50 dark:border-slate-800 hover:bg-gray-50/80 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-slate-100 whitespace-nowrap">{sale.id}</td>
                    <td className="px-6 py-4">{sale.item}</td>
                    <td className="px-6 py-4 font-semibold text-gray-900 dark:text-slate-100">{sale.amount}</td>
                    <td className="px-6 py-4">
                      <span className="bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 px-2.5 py-1 rounded-md text-xs font-medium">{sale.cashier}</span>
                    </td>
                    <td className="px-6 py-4 text-gray-400 dark:text-slate-500">{sale.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Dead Stock Alert */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
          <div className="p-6 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
              <AlertTriangle className="mr-2 text-rose-500 dark:text-rose-400" size={20} /> Dead Stock Alert
            </h3>
            <span className="bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 text-xs font-semibold px-2.5 py-1 rounded-full">{'30+ Days'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-gray-500 dark:text-slate-400">
              <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/50 dark:bg-slate-950/50">
                <tr>
                  <th scope="col" className="px-6 py-3 font-medium">Item Name</th>
                  <th scope="col" className="px-6 py-3 font-medium">Days Unsold</th>
                  <th scope="col" className="px-6 py-3 font-medium">Qty</th>
                  <th scope="col" className="px-6 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {deadStockList.length === 0 ? (
                  <tr><td colSpan="4" className="px-6 py-4 text-center text-gray-500 dark:text-slate-400">No dead stock found!</td></tr>
                ) : deadStockList.map((item) => (
                  <tr key={item.id} className="bg-white dark:bg-slate-800 border-b border-gray-50 dark:border-slate-800 hover:bg-gray-50/80 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-slate-100">{item.name}</td>
                    <td className="px-6 py-4">
                      <span className={`font-medium ${item.days > 90 ? 'text-rose-600 dark:text-rose-400' : 'text-orange-500 dark:text-orange-400'}`}>
                        {item.days} days
                      </span>
                    </td>
                    <td className="px-6 py-4">{item.qty}</td>
                    <td className="px-6 py-4">
                      {(user?.role === 'admin' || user?.role === 'shop_owner') ? (
                        <button className="text-blue-600 dark:text-blue-400 hover:text-blue-800 text-xs font-medium bg-blue-50 dark:bg-blue-500/10 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors">
                          View
                        </button>
                      ) : (
                        <span className="text-gray-400 dark:text-slate-500 text-xs">No Access</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Staff Stock Adjustments — oversight of cashier stock edits */}
      {(user?.role === 'admin' || user?.role === 'shop_owner') && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
          <div className="p-6 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
              <Wrench className="mr-2 text-orange-500 dark:text-orange-400" size={20} /> Staff Stock Adjustments
            </h3>
            <span className="bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 text-xs font-semibold px-2.5 py-1 rounded-full">
              {adjustments.length} record{adjustments.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-gray-500 dark:text-slate-400">
              <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/50 dark:bg-slate-950/50">
                <tr>
                  <th scope="col" className="px-6 py-3 font-medium">Item</th>
                  <th scope="col" className="px-6 py-3 font-medium">Cashier</th>
                  <th scope="col" className="px-6 py-3 font-medium">Change</th>
                  <th scope="col" className="px-6 py-3 font-medium">Reason</th>
                  <th scope="col" className="px-6 py-3 font-medium">Note</th>
                  <th scope="col" className="px-6 py-3 font-medium">Time</th>
                  <th scope="col" className="px-6 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.length === 0 ? (
                  <tr><td colSpan="7" className="px-6 py-6 text-center text-gray-400 dark:text-slate-500">No stock adjustments recorded yet.</td></tr>
                ) : adjustments.map((m) => (
                  <tr key={m.id || m.localKey} className="bg-white dark:bg-slate-800 border-b border-gray-50 dark:border-slate-800 hover:bg-gray-50/80 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900 dark:text-slate-100">
                      {m.item_name}
                      <span className="block text-[11px] text-gray-400 dark:text-slate-500 font-mono">{m.sku}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 px-2.5 py-1 rounded-md text-xs font-medium">{m.user_name || '—'}</span>
                    </td>
                    <td className={`px-6 py-4 font-bold ${Number(m.quantity_change) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {Number(m.quantity_change) > 0 ? '+' : ''}{m.quantity_change}
                    </td>
                    <td className="px-6 py-4">{m.reason || '—'}</td>
                    <td className="px-6 py-4 max-w-[180px] truncate" title={m.note}>{m.note || '—'}</td>
                    <td className="px-6 py-4 text-gray-400 dark:text-slate-500 whitespace-nowrap">{new Date(m.created_at).toLocaleString()}</td>
                    <td className="px-6 py-4">
                      <button onClick={() => handleDeleteAdjustment(m)} className="flex items-center text-rose-600 dark:text-rose-400 hover:text-rose-800 text-xs font-medium bg-rose-50 dark:bg-rose-500/10 px-3 py-1.5 rounded-lg hover:bg-rose-100 transition-colors">
                        <Trash2 size={13} className="mr-1" /> Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// Placeholder pages
const PlaceholderPage = ({ title }) => (
  <div className="flex flex-col items-center justify-center h-[60vh] text-center">
    <div className="bg-white dark:bg-slate-800 p-8 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 max-w-md w-full">
      <Package size={48} className="mx-auto text-blue-200 mb-4" />
      <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100 mb-2">{title}</h2>
      <p className="text-gray-500">This module is under construction.</p>
    </div>
  </div>
);

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><Layout><Dashboard /></Layout></ProtectedRoute>} />
      <Route path="/sales" element={<ProtectedRoute><Layout><SalesPage /></Layout></ProtectedRoute>} />
      <Route path="/inventory" element={<Navigate to="/stock" replace />} />
      <Route path="/stock" element={<ProtectedRoute><Layout><StockManagementPage /></Layout></ProtectedRoute>} />
      <Route path="/repairs" element={<ProtectedRoute><Layout><RepairPage /></Layout></ProtectedRoute>} />

      {/* Admin Only Routes */}
      <Route path="/reports" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><ReportsPage /></Layout></ProtectedRoute>} />
      <Route path="/sessions" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><CashSessionHistoryPage /></Layout></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><UsersPage /></Layout></ProtectedRoute>} />
      <Route path="/settings" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><SettingsPage /></Layout></ProtectedRoute>} />
      <Route path="/storage" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><ManageStoragePage /></Layout></ProtectedRoute>} />

      {/* 404 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <SessionProvider>
            <SyncProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </SyncProvider>
          </SessionProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;