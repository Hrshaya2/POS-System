import React from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
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
  Coins
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
import OpenSessionModal from './components/CashSession/OpenSessionModal';
import CloseSessionModal from './components/CashSession/CloseSessionModal';
import Login from './pages/Login';
import UsersPage from './pages/UsersPage';
import InventoryPage from './pages/InventoryPage';
import SalesPage from './pages/SalesPage';
import RepairPage from './pages/RepairPage';
import ReportsPage from './pages/ReportsPage';
import CashSessionHistoryPage from './pages/CashSessionHistoryPage';

// MOCK DATA REMOVED - using live backend API instead

// --- AUTH PROTECTED ROUTE ---
const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user, loading: authLoading } = useAuth();
  const { isOpen, loading: sessionLoading } = useSession();

  if (authLoading || sessionLoading) return <div>Loading...</div>;
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
        : 'text-gray-400 hover:bg-gray-800 hover:text-white'
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

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 h-full flex flex-col shadow-2xl z-10 border-r border-gray-800">
        <div className="p-6 flex items-center space-x-3">
          <div className="p-0">
            <img src="frontend/logo.png" alt="Loyal Mobile" className="w-14 12 object-cover rounded-full border-3 order-white shadow-md" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            LOYAL <span className="text-blue-300">MOBILE</span>
          </h1>
        </div>

        <nav className="flex-1 px-4 space-y-2 mt-4 overflow-y-auto">
          <SidebarItem icon={LayoutDashboard} label="Dashboard" path="/" />
          <SidebarItem icon={ShoppingCart} label="Sales / Billing" path="/sales" />
          <SidebarItem icon={Package} label="Inventory" path="/inventory" />
          <SidebarItem icon={Wrench} label="Repairs" path="/repairs" />

          {(user?.role === 'admin' || user?.role === 'shop_owner') && (
            <>
              <SidebarItem icon={BarChart3} label="Reports" path="/reports" />
              <SidebarItem icon={Coins} label="Sessions" path="/sessions" />
              <SidebarItem icon={Users} label="Users" path="/users" />
            </>
          )}
        </nav>

        <div className="p-4 border-t border-gray-800">
          <button onClick={logout} className="flex items-center space-x-3 px-4 py-3 w-full text-left text-gray-400 hover:bg-gray-800 hover:text-white rounded-xl transition-colors">
            <LogOut size={20} />
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 h-full overflow-y-auto bg-[#f8fafc]">
        {/* Top Header */}
        <header className="bg-white/80 backdrop-blur-md sticky top-0 z-10 border-b border-gray-200 px-8 py-4 flex justify-between items-center shadow-sm">
          <h2 className="text-xl font-semibold text-gray-800">Branch: Main Store (Colombo)</h2>
          <div className="flex items-center space-x-4">
            {isOpen ? (
              <button
                onClick={() => setShowCloseModal(true)}
                className="bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 px-4 py-2 rounded-xl text-sm font-bold transition-all shadow-sm flex items-center space-x-2"
              >
                <span>End Day</span>
              </button>
            ) : (
              <button
                onClick={() => setShowOpenModal(true)}
                className="bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 px-4 py-2 rounded-xl text-sm font-bold transition-all shadow-sm flex items-center space-x-2"
              >
                <span>Open Day</span>
              </button>
            )}
            <div className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 flex items-center justify-center text-white font-bold shadow-md uppercase">
              {user?.name?.charAt(0) || 'U'}
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700">{user?.name || 'User'}</p>
              <p className="text-xs text-gray-500 uppercase">{user?.role || 'Guest'}</p>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="p-8">
          {children}
        </div>
      </main>

      {showCloseModal && <CloseSessionModal onClose={() => setShowCloseModal(false)} />}
      {showOpenModal && <OpenSessionModal onClose={() => setShowOpenModal(false)} />}
    </div>
  );
};

const StatCard = ({ title, value, subtitle, icon: Icon, colorClass, bgClass }) => (
  <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
    <div className="flex justify-between items-start">
      <div>
        <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
        <h3 className="text-3xl font-bold text-gray-900">{value}</h3>
      </div>
      <div className={`p-3 rounded-xl ${bgClass}`}>
        <Icon size={24} className={colorClass} />
      </div>
    </div>
    <div className="mt-4 flex items-center space-x-2 text-sm">
      <TrendingUp size={16} className="text-emerald-500" />
      <span className="text-emerald-500 font-medium">{subtitle}</span>
      <span className="text-gray-400">vs last month</span>
    </div>
  </div>
);

// --- SYNC STATUS BADGE ---
const SyncStatusBadge = () => {
  const [status, setStatus] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  const fetchSyncStatus = React.useCallback(async () => {
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

  if (loading) {
    return (
      <div className="bg-gray-50 border border-gray-200 text-gray-500 px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2">
        <RefreshCw size={16} className="animate-spin" />
        <span>Checking sync...</span>
      </div>
    );
  }

  if (!status?.mongoConfigured) {
    return (
      <div className="bg-gray-50 border border-gray-200 text-gray-500 px-4 py-2 rounded-xl text-sm font-medium flex items-center space-x-2">
        <CloudOff size={16} />
        <span>Sync not configured</span>
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
        <AlertCircle size={16} />
        <span>MongoDB Not Connected</span>
      </div>
    );
  }

  const pending = status.totalPending || 0;

  if (pending > 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
        <RefreshCw size={16} className="animate-spin" />
        <span>Syncing... {pending} items pending</span>
      </div>
    );
  }

  return (
    <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-2 rounded-xl text-sm font-bold flex items-center space-x-2">
      <CheckCircle2 size={16} />
      <span>Cloud Synced</span>
      {status.lastSyncAt && (
        <span className="text-xs font-medium text-emerald-600 opacity-80">
          {new Date(status.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
};

const Dashboard = () => {
  const { user } = useAuth();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/dashboard', {
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
  }, []);

  if (loading) return <div className="p-8 text-gray-500">Loading dashboard...</div>;
  if (!data) return <div className="p-8 text-gray-500">Failed to load dashboard data.</div>;

  const { stats, repairStatusCounts, recentSales, deadStockList, salesTrend } = data;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard Overview</h1>
          <p className="text-gray-500 mt-1">Welcome back, {user?.name}! Here's what's happening today.</p>
        </div>
        <div className="flex items-center space-x-3">
          <SyncStatusBadge />
          <Link to="/sales" className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-medium shadow-lg shadow-blue-500/30 transition-all flex items-center space-x-2">
            <ShoppingCart size={18} />
            <span>New Sale</span>
          </Link>
        </div>
      </div>

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
        <div className="lg:col-span-2 bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-bold text-gray-900">Sales Trend (Last 7 Days)</h3>
            <select className="bg-gray-50 border border-gray-200 text-gray-700 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2">
              <option>Last 7 days</option>
              <option>This Month</option>
            </select>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={salesTrend.reverse()} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 12 }} dx={-10} />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  formatter={(value) => [`Rs. ${value}`, 'Sales']}
                />
                <Area type="monotone" dataKey="sales" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Repair Jobs Status */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 flex flex-col">
          <h3 className="text-lg font-bold text-gray-900 mb-6 flex items-center">
            <Wrench className="mr-2 text-indigo-500" size={20} /> Repair Status
          </h3>
          <div className="flex-1 flex flex-col justify-center space-y-6">
            <div className="flex items-center justify-between p-4 bg-amber-50 rounded-xl border border-amber-100">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                <span className="font-medium text-amber-900">Received</span>
              </div>
              <span className="text-xl font-bold text-amber-700">{repairStatusCounts.Received || 0}</span>
            </div>

            <div className="flex items-center justify-between p-4 bg-blue-50 rounded-xl border border-blue-100">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></div>
                <span className="font-medium text-blue-900">In Repair</span>
              </div>
              <span className="text-xl font-bold text-blue-700">{repairStatusCounts['In Repair'] || 0}</span>
            </div>

            <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-xl border border-emerald-100">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                <span className="font-medium text-emerald-900">Ready for Pickup</span>
              </div>
              <span className="text-xl font-bold text-emerald-700">{repairStatusCounts['Ready for Pickup'] || 0}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Recent Sales Table */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="p-6 border-b border-gray-100 flex justify-between items-center">
            <h3 className="text-lg font-bold text-gray-900 flex items-center">
              <Clock className="mr-2 text-blue-500" size={20} /> Recent Sales
            </h3>
            <button className="text-sm text-blue-600 font-medium hover:text-blue-700">View All</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-gray-500">
              <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
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
                  <tr><td colSpan="5" className="px-6 py-6 text-center text-gray-400">No sales recorded yet today.</td></tr>
                ) : recentSales.map((sale) => (
                  <tr key={sale.id} className="bg-white border-b border-gray-50 hover:bg-gray-50/80 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">{sale.id}</td>
                    <td className="px-6 py-4">{sale.item}</td>
                    <td className="px-6 py-4 font-semibold text-gray-900">{sale.amount}</td>
                    <td className="px-6 py-4">
                      <span className="bg-gray-100 text-gray-700 px-2.5 py-1 rounded-md text-xs font-medium">{sale.cashier}</span>
                    </td>
                    <td className="px-6 py-4 text-gray-400">{sale.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Dead Stock Alert */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="p-6 border-b border-gray-100 flex justify-between items-center">
            <h3 className="text-lg font-bold text-gray-900 flex items-center">
              <AlertTriangle className="mr-2 text-rose-500" size={20} /> Dead Stock Alert
            </h3>
            <span className="bg-rose-100 text-rose-700 text-xs font-semibold px-2.5 py-1 rounded-full">{'30+ Days'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-gray-500">
              <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
                <tr>
                  <th scope="col" className="px-6 py-3 font-medium">Item Name</th>
                  <th scope="col" className="px-6 py-3 font-medium">Days Unsold</th>
                  <th scope="col" className="px-6 py-3 font-medium">Qty</th>
                  <th scope="col" className="px-6 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {deadStockList.length === 0 ? (
                  <tr><td colSpan="4" className="px-6 py-4 text-center text-gray-500">No dead stock found!</td></tr>
                ) : deadStockList.map((item) => (
                  <tr key={item.id} className="bg-white border-b border-gray-50 hover:bg-gray-50/80 transition-colors">
                    <td className="px-6 py-4 font-medium text-gray-900">{item.name}</td>
                    <td className="px-6 py-4">
                      <span className={`font-medium ${item.days > 90 ? 'text-rose-600' : 'text-orange-500'}`}>
                        {item.days} days
                      </span>
                    </td>
                    <td className="px-6 py-4">{item.qty}</td>
                    <td className="px-6 py-4">
                      {(user?.role === 'admin' || user?.role === 'shop_owner') ? (
                        <button className="text-blue-600 hover:text-blue-800 text-xs font-medium bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors">
                          View
                        </button>
                      ) : (
                        <span className="text-gray-400 text-xs">No Access</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

// Placeholder pages
const PlaceholderPage = ({ title }) => (
  <div className="flex flex-col items-center justify-center h-[60vh] text-center">
    <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 max-w-md w-full">
      <Package size={48} className="mx-auto text-blue-200 mb-4" />
      <h2 className="text-2xl font-bold text-gray-900 mb-2">{title}</h2>
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
      <Route path="/inventory" element={<ProtectedRoute><Layout><InventoryPage /></Layout></ProtectedRoute>} />
      <Route path="/repairs" element={<ProtectedRoute><Layout><RepairPage /></Layout></ProtectedRoute>} />

      {/* Admin Only Routes */}
      <Route path="/reports" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><ReportsPage /></Layout></ProtectedRoute>} />
      <Route path="/sessions" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><CashSessionHistoryPage /></Layout></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute allowedRoles={['admin', 'shop_owner']}><Layout><UsersPage /></Layout></ProtectedRoute>} />

      {/* 404 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <SessionProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </SessionProvider>
    </AuthProvider>
  );
}

export default App;
