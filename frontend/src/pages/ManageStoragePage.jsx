// Manage Storage (admin only): real MongoDB Atlas usage from dbStats, a daily
// usage trend from the StorageSnapshot collection, and a per-collection data
// breakdown — excluding user accounts and inventory/stock product data.
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip
} from 'recharts';
import {
  Database, RefreshCw, AlertTriangle, Lightbulb, TrendingUp,
  Receipt, Wrench, Coins, History, ClipboardList, FileSpreadsheet,
  Tags, Settings, BadgeDollarSign, ExternalLink, Info, HardDrive
} from 'lucide-react';

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_KB = 1024;

// Display metadata per MongoDB collection: friendly name, icon, and the
// existing page where an admin can browse that data (View link omitted when
// there is no page). `users`, `inventoryphones` and `inventoryaccessories`
// never reach this page — the backend excludes them per requirement.
const SECTION_META = {
  sales:            { label: 'Sales / Transactions', icon: Receipt,         viewPath: '/sales' },
  repairjobs:       { label: 'Repair Jobs',          icon: Wrench,          viewPath: '/repairs' },
  repairjobparts:   { label: 'Repair Job Parts',     icon: Wrench,          viewPath: '/repairs' },
  dailysessions:    { label: 'Daily Cash Sessions',  icon: Coins,           viewPath: '/sessions' },
  cashmovements:    { label: 'Cash Movements',       icon: Coins,           viewPath: '/sessions' },
  refunds:          { label: 'Refunds',              icon: Receipt,         viewPath: '/reports' },
  creditnotes:      { label: 'Credit Notes / Unpaid', icon: BadgeDollarSign, viewPath: '/reports' },
  stockmovements:   { label: 'Stock Movement Logs',  icon: History,         viewPath: '/stock' },
  stocktakes:       { label: 'Stock Take Sessions',  icon: ClipboardList,   viewPath: '/stock' },
  stockimports:     { label: 'Stock Imports',        icon: FileSpreadsheet, viewPath: '/stock' },
  stockcategories:  { label: 'Categories',           icon: Tags,            viewPath: '/stock' },
  storesettings:    { label: 'Store Settings',       icon: Settings,        viewPath: '/settings' },
  taxrates:         { label: 'Tax Rates',            icon: Settings,        viewPath: '/settings' },
  storagesnapshots: { label: 'Storage Snapshots',    icon: Database,        viewPath: null }
};

const ICON_COLORS = [
  'bg-blue-50 text-blue-600',
  'bg-indigo-50 text-indigo-600',
  'bg-emerald-50 text-emerald-600',
  'bg-amber-50 text-amber-600',
  'bg-rose-50 text-rose-600',
  'bg-violet-50 text-violet-600',
  'bg-cyan-50 text-cyan-600',
  'bg-orange-50 text-orange-600'
];

const prettifyCollectionName = (name) =>
  String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const formatBytes = (bytes) => {
  const n = Number(bytes || 0);
  if (n >= BYTES_PER_MB) return `${(n / BYTES_PER_MB).toFixed(1)} MB`;
  if (n <= 0) return '0 KB';
  return `${Math.max(1, Math.round(n / BYTES_PER_KB))} KB`;
};

const formatCount = (n) => Number(n || 0).toLocaleString('en-LK');

// Gauge palette: green under 70%, orange 70–90%, red above 90% of the 512MB tier.
const usageTone = (percent) => (percent > 90
  ? { color: '#e11d48', text: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200', chip: 'bg-rose-100 text-rose-700' }
  : percent >= 70
    ? { color: '#f59e0b', text: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', chip: 'bg-amber-100 text-amber-700' }
    : { color: '#10b981', text: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', chip: 'bg-emerald-100 text-emerald-700' });

const SectionCard = ({ section, totalBytes, index }) => {
  const meta = SECTION_META[section.name]
    || { label: prettifyCollectionName(section.name), icon: Database, viewPath: null };
  const Icon = meta.icon;
  const sharePct = totalBytes > 0 ? Math.max(1, Math.round((section.size / totalBytes) * 100)) : 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-xl ${ICON_COLORS[index % ICON_COLORS.length]} shrink-0`}>
          <Icon size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-gray-900 truncate">{meta.label}</h4>
          <p className="text-sm text-gray-500">
            {formatCount(section.count)} record{section.count === 1 ? '' : 's'} · {formatBytes(section.size)}
            <span className="ml-2 text-xs text-gray-400">({sharePct}% of data)</span>
          </p>
        </div>
        {meta.viewPath && (
          <Link
            to={meta.viewPath}
            className="flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            View <ExternalLink size={13} />
          </Link>
        )}
      </div>
      <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
          style={{ width: `${sharePct}%` }}
        />
      </div>
    </div>
  );
};

export default function ManageStoragePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/storage', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // Include the HTTP status: a 404 here almost always means the backend
        // server is running old code and needs a restart to expose /api/storage.
        throw new Error(errData.error || `Failed to load storage stats (HTTP ${res.status})`);
      }
      setData(await res.json());
    } catch (err) {
      console.error('Failed to load storage breakdown', err);
      setError(err.message || 'Failed to load storage stats');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Real dbStats are fetched fresh on every page load; the button re-fetches.
  useEffect(() => { load(false); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh] text-gray-500">
        <RefreshCw size={20} className="animate-spin mr-3" /> Loading storage stats...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-lg mx-auto mt-12 bg-white rounded-2xl border border-rose-200 shadow-sm p-8 text-center">
        <AlertTriangle size={40} className="mx-auto text-rose-400 mb-4" />
        <h2 className="text-xl font-bold text-gray-900 mb-2">Storage stats unavailable</h2>
        <p className="text-gray-500 mb-6">{error || 'No data returned.'}</p>
        <button
          onClick={() => load(false)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-medium transition-colors"
        >
          Try Again
        </button>
      </div>
    );
  }

  const { db, limitBytes, collections, history } = data;
  const usedBytes = Number(db.dataSize || 0);
  const limitMB = limitBytes / BYTES_PER_MB;
  const usedMB = usedBytes / BYTES_PER_MB;
  const percent = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  const tone = usageTone(percent);
  const remainingMB = Math.max(0, limitMB - usedMB);

  const gaugeData = [
    { name: 'Used', value: Number(usedMB.toFixed(2)) },
    { name: 'Free', value: Number(remainingMB.toFixed(2)) }
  ];

  const trendData = (history || [])
    .filter((h) => h && h.date)
    .map((h) => ({
      date: String(h.date).slice(5), // MM-DD
      mb: Number((Number(h.totalDataSize || 0) / BYTES_PER_MB).toFixed(2))
    }));

  const totalSectionBytes = collections.reduce((sum, c) => sum + Number(c.size || 0), 0);

  const miniStats = [
    { label: 'Data Size (gauge source)', value: formatBytes(db.dataSize) },
    { label: 'On-Disk (compressed)', value: formatBytes(db.storageSize) },
    { label: 'Index Size', value: formatBytes(db.indexSize) },
    { label: 'Documents', value: formatCount(db.objects) }
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap justify-between items-end gap-4 mb-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <HardDrive className="text-blue-600" size={24} /> Manage Storage
          </h1>
          <p className="text-gray-500 mt-1">
            MongoDB Atlas usage vs the 512MB free-tier limit · database <span className="font-mono text-gray-700">{db.name}</span>
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm transition-colors disabled:opacity-60"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      {/* Gauge + live numbers */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-center">
          <div className="relative h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={gaugeData}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                  innerRadius="74%"
                  outerRadius="94%"
                  stroke="none"
                  cornerRadius={6}
                >
                  <Cell fill={tone.color} />
                  <Cell fill="#e5e7eb" />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className={`text-5xl font-extrabold ${tone.text}`}>{Math.round(percent)}%</span>
              <span className="text-sm text-gray-600 font-semibold mt-1 text-center px-10">
                {usedMB.toFixed(1)} MB / {limitMB} MB used
              </span>
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full mt-2 ${tone.chip}`}>
                {percent > 90 ? 'Critical — upgrade soon' : percent >= 70 ? 'Getting full' : 'Healthy'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {miniStats.map((s) => (
              <div key={s.label} className={`rounded-xl border ${tone.border} ${tone.bg} p-4`}>
                <p className="text-xs font-semibold text-gray-500 mb-1">{s.label}</p>
                <p className="text-2xl font-bold text-gray-900">{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 30-day trend */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-4">
          <TrendingUp size={20} className="text-blue-600" /> Storage Usage — Last 30 Days
        </h3>
        {trendData.length >= 2 ? (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 10, right: 24, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorStorage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={tone.color} stopOpacity={0.7} />
                    <stop offset="95%" stopColor={tone.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} dx={-6} />
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  formatter={(value) => [`${value} MB`, 'Data size']}
                />
                <Area type="monotone" dataKey="mb" stroke={tone.color} strokeWidth={3} fill="url(#colorStorage)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-4 py-6">
            <Info size={18} className="shrink-0 text-gray-400" />
            <p className="text-sm">
              {trendData.length === 1
                ? `First snapshot captured on ${trendData[0].date}. The trend line appears once a few days of daily snapshots have collected.`
                : 'No history yet — a daily snapshot starts collecting today, and the trend line appears after a few days.'}
            </p>
          </div>
        )}
      </div>

      {/* Data breakdown (Users + Inventory/Stock product data excluded server-side) */}
      <div>
        <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
          <h3 className="text-lg font-bold text-gray-900">Data Breakdown — largest first</h3>
          <p className="text-xs text-gray-400">
            Excludes user accounts and inventory/stock product data · sizes from MongoDB $collStats
          </p>
        </div>
        {collections.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center text-gray-400">
            No collections to show.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {collections.map((c, i) => (
              <SectionCard key={c.name} section={c} totalBytes={totalSectionBytes} index={i} />
            ))}
          </div>
        )}
      </div>

      {/* Static guidance */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-4">
          <Lightbulb size={20} className="text-amber-500" /> Tips to Keep Storage Healthy
        </h3>
        <ul className="space-y-3 text-sm text-gray-600">
          <li className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
            <span>Stock Movement Logs and snapshot data grow continuously — consider cleaning up log entries older than 90 days from Stock History.</span>
          </li>
          <li className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
            <span>Old transactions, refunds, and sessions can be exported to Excel/PDF from Reports for archiving before being removed.</span>
          </li>
          <li className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
            <span>Keep product photos as external image links rather than embedding files inside product records.</span>
          </li>
          <li className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
            <span>Consider upgrading your MongoDB Atlas plan if usage keeps growing toward the 512MB free-tier cap.</span>
          </li>
        </ul>
      </div>
    </div>
  );
}