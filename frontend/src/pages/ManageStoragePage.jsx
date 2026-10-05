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
  Tags, Settings, BadgeDollarSign, ExternalLink, Info, HardDrive, Trash2, X, CheckCircle2
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme.jsx';
import LogoLoader from '../components/LogoLoader';

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_KB = 1024;

// Display metadata per MongoDB collection: friendly name, icon, the
// existing page where an admin can browse that data (View link omitted when
// there is no page), and an extra warning shown in the Clear confirmation
// modal for sections that hold configuration rather than logs. `users`,
// `inventoryphones` and `inventoryaccessories` never reach this page — the
// backend excludes them per requirement (and refuses to clear them).
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
  stockcategories:  {
    label: 'Categories', icon: Tags, viewPath: '/stock',
    warn: 'Categories are shared configuration used to group stock items. Clearing them affects how products are organised.'
  },
  storesettings:    {
    label: 'Store Settings', icon: Settings, viewPath: '/settings',
    warn: 'Store Settings holds configuration such as the refund policy and the approval PIN. Clearing it removes that configuration.'
  },
  taxrates:         {
    label: 'Tax Rates', icon: Settings, viewPath: '/settings',
    warn: 'Tax Rates is configuration data — clearing it removes your tax setup.'
  },
  storagesnapshots: {
    label: 'Storage Snapshots', icon: Database, viewPath: null,
    warn: 'Snapshots power the 30-day trend chart. Clearing them resets the history; today\'s snapshot is re-captured automatically.'
  }
};

// Collections without a reliable schema date field cannot be cleared by date
// (the backend only accepts "all" for these — must match STORAGE_CLEARABLE).
const DATE_FILTER_UNSUPPORTED = ['taxrates'];
const CLEAR_DAY_OPTIONS = [30, 90, 180, 365];

const ICON_COLORS = [
  'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400',
  'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400',
  'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400',
  'bg-violet-50 text-violet-600',
  'bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400'
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

// Gauge palette: green under 70%, orange 70-90%, red above 90% of the 512MB tier.
// `track` is the unused remainder of the donut. It MUST follow the theme or the
// ring reads as a bright white blob against the dark card, so it comes from
// useTheme() rather than a hardcoded #e5e7eb.
const usageTone = (percent, track) => (percent > 90
  ? { color: '#e11d48', track, text: 'text-rose-600', bg: 'bg-rose-50 dark:bg-rose-500/10', border: 'border-rose-200 dark:border-rose-500/30', chip: 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300' }
  : percent >= 70
    ? { color: '#f59e0b', track, text: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-500/10', border: 'border-amber-200 dark:border-amber-500/30', chip: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300' }
    : { color: '#10b981', track, text: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-500/10', border: 'border-emerald-200 dark:border-emerald-500/30', chip: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' });

const SectionCard = ({ section, totalBytes, index, onClear }) => {
  const meta = SECTION_META[section.name]
    || { label: prettifyCollectionName(section.name), icon: Database, viewPath: null };
  const Icon = meta.icon;
  const sharePct = totalBytes > 0 ? Math.max(1, Math.round((section.size / totalBytes) * 100)) : 0;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-xl ${ICON_COLORS[index % ICON_COLORS.length]} shrink-0`}>
          <Icon size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-bold text-gray-900 dark:text-slate-100 truncate">{meta.label}</h4>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            {formatCount(section.count)} record{section.count === 1 ? '' : 's'} · {formatBytes(section.size)}
            <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">({sharePct}% of data)</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {meta.viewPath && (
            <Link
              to={meta.viewPath}
              className="flex items-center gap-1.5 text-sm font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-800 bg-blue-50 dark:bg-blue-500/10 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
            >
              View <ExternalLink size={13} />
            </Link>
          )}
          <button
            onClick={() => onClear(section)}
            disabled={section.count === 0}
            title={section.count === 0 ? 'Nothing to clear' : `Clear records from ${meta.label}`}
            className="flex items-center gap-1.5 text-sm font-semibold text-rose-600 dark:text-rose-400 hover:text-rose-800 bg-rose-50 dark:bg-rose-500/10 hover:bg-rose-100 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={13} /> Clear
          </button>
        </div>
      </div>
      <div className="mt-3 h-1.5 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500"
          style={{ width: `${sharePct}%` }}
        />
      </div>
    </div>
  );
};

// Confirmation modal for clearing one storage section. Offers "all records"
// or "older than N days" (where the collection has a schema-backed date), an
// explicit per-section warning for configuration data, and a red destructive
// confirm button. onConfirm throws on failure — the modal stays open.
function ClearStorageModal({ section, onClose, onConfirm }) {
  const meta = SECTION_META[section.name]
    || { label: prettifyCollectionName(section.name), icon: Database };
  // Date-based cleanup needs a schema-backed createdAt — only known
  // model-backed sections offer it (legacy/raw ones are "all" only).
  const supportsDateFilter = !!SECTION_META[section.name]
    && !DATE_FILTER_UNSUPPORTED.includes(section.name);
  const [mode, setMode] = useState('all');
  const [days, setDays] = useState(90);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({
        collection: section.name,
        mode,
        days: mode === 'olderThan' ? days : null
      });
      onClose();
    } catch (err) {
      alert(err.message || 'Failed to clear this section');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
              <Trash2 size={18} className="text-rose-600" /> Clear Data
            </h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{meta.label}</p>
          </div>
          <button onClick={onClose} disabled={submitting} className="p-2 hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className={`rounded-xl border px-4 py-3 text-sm ${meta.warn ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-200' : 'border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}>
            <p className="font-semibold flex items-center gap-2 mb-1">
              <AlertTriangle size={15} className="shrink-0" />
              This permanently deletes records from {meta.label}.
            </p>
            {meta.warn && <p className="mt-1">{meta.warn}</p>}
            <p className="mt-1">
              Currently holding {formatCount(section.count)} record{section.count === 1 ? '' : 's'} ({formatBytes(section.size)}).
              Deletion cannot be undone — export from Reports first if you need an archive.
            </p>
          </div>

          {supportsDateFilter ? (
            <ClearModePicker mode={mode} setMode={setMode} days={days} setDays={setDays} />
          ) : (
            <p className="text-sm text-gray-500 dark:text-slate-400">
              This section can only be cleared entirely (date-based cleanup is not available for it).
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 flex justify-end space-x-3 bg-gray-50 dark:bg-slate-950 rounded-b-2xl">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-5 py-2.5 text-gray-600 dark:text-slate-400 font-medium hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting}
            className="px-6 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-semibold rounded-lg shadow-md transition-colors"
          >
            {submitting ? 'Deleting…' : mode === 'olderThan' ? `Delete Records Older Than ${days} Days` : 'Delete All Records'}
          </button>
        </div>
      </div>
    </div>
  );
}

// "All records" vs "Older than N days" selection with the age threshold picker.
function ClearModePicker({ mode, setMode, days, setDays }) {
  const optionClass = (active) => `py-2.5 px-3 rounded-xl border-2 font-semibold text-sm text-left transition-colors ${
    active ? 'border-rose-500 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'
  }`;
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">What to delete</label>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setMode('all')} className={optionClass(mode === 'all')}>
          All records
        </button>
        <button type="button" onClick={() => setMode('olderThan')} className={optionClass(mode === 'olderThan')}>
          Older than N days
        </button>
      </div>
      {mode === 'olderThan' && (
        <div className="mt-3">
          <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 mb-1">Age threshold</label>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring focus:border-rose-300 bg-white dark:bg-slate-800"
          >
            {CLEAR_DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>Older than {d} days</option>
            ))}
          </select>
          <p className="text-xs text-gray-400 dark:text-slate-500 mt-1.5">
            Recent records are kept — only records created before the cutoff are removed.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ManageStoragePage() {
  const { isDark } = useTheme();
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

  // Per-section clearing: which section's confirmation modal is open, plus the
  // outcome banner shown after a successful clear.
  const [clearTarget, setClearTarget] = useState(null);
  const [clearResult, setClearResult] = useState(null);

  const handleClearConfirm = async ({ collection, mode, days }) => {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/storage/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ collection, mode, days })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Include the HTTP status: a 404 here almost always means the backend
      // server is running old code and needs a restart to expose the endpoint.
      throw new Error(result.error || `Clear failed (HTTP ${res.status})`);
    }
    setClearResult({ message: result.message || `Deleted ${result.deletedCount} record(s)`, collection });
    await load(true); // re-read dbStats so the gauge and cards reflect the deletion
  };

  if (loading) {
    return (
      <div className="h-[60vh]">
        <LogoLoader size={80} label="Loading storage stats…" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-lg mx-auto mt-12 bg-white dark:bg-slate-800 rounded-2xl border border-rose-200 dark:border-rose-500/30 shadow-sm p-8 text-center">
        <AlertTriangle size={40} className="mx-auto text-rose-400 dark:text-rose-400 mb-4" />
        <h2 className="text-xl font-bold text-gray-900 dark:text-slate-100 mb-2">Storage stats unavailable</h2>
        <p className="text-gray-500 dark:text-slate-400 mb-6">{error || 'No data returned.'}</p>
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
  const tone = usageTone(percent, isDark ? '#1e293b' : '#e5e7eb');
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
            <HardDrive className="text-blue-600" size={24} /> Manage Storage
          </h1>
          <p className="text-gray-500 dark:text-slate-400 mt-1">
            MongoDB Atlas usage vs the 512MB free-tier limit · database <span className="font-mono text-gray-700 dark:text-slate-300">{db.name}</span>
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm transition-colors disabled:opacity-60"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Outcome banner after a successful section clear */}
      {clearResult && (
        <div
          className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-200 rounded-2xl px-5 py-4 flex items-center gap-3"
          role="status"
          data-testid="storage-clear-result"
        >
          <CheckCircle2 size={20} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-sm font-semibold flex-1">{clearResult.message}</p>
          <button
            onClick={() => setClearResult(null)}
            className="text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 p-1 rounded-lg hover:bg-emerald-100 hover:dark:bg-emerald-500/20 transition-colors"
            title="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Gauge + live numbers */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
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
                  <Cell fill={tone.track} />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className={`text-5xl font-extrabold ${tone.text}`}>{Math.round(percent)}%</span>
              <span className="text-sm text-gray-600 dark:text-slate-400 font-semibold mt-1 text-center px-10">
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
                <p className="text-xs font-semibold text-gray-500 dark:text-slate-400 mb-1">{s.label}</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-slate-100">{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 30-day trend */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
        <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2 mb-4">
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
          <div className="flex items-center gap-3 text-gray-500 dark:text-slate-400 bg-gray-50 dark:bg-slate-950 border border-gray-100 dark:border-slate-800 rounded-xl px-4 py-6">
            <Info size={18} className="shrink-0 text-gray-400 dark:text-slate-500" />
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
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Data Breakdown — largest first</h3>
          <p className="text-xs text-gray-400 dark:text-slate-500">
            Excludes user accounts and inventory/stock product data · sizes from MongoDB $collStats
          </p>
        </div>
        {collections.length === 0 ? (
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm p-8 text-center text-gray-400 dark:text-slate-500">
            No collections to show.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {collections.map((c, i) => (
              <SectionCard key={c.name} section={c} totalBytes={totalSectionBytes} index={i} onClear={setClearTarget} />
            ))}
          </div>
        )}
      </div>

      {/* Static guidance */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
        <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2 mb-4">
          <Lightbulb size={20} className="text-amber-500" /> Tips to Keep Storage Healthy
        </h3>
        <ul className="space-y-3 text-sm text-gray-600 dark:text-slate-400">
          <li className="flex gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 shrink-0" />
            <span>Stock Movement Logs and snapshot data grow continuously — use the Clear button on those sections above to remove records older than 90 days.</span>
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

      {/* Per-section clear confirmation */}
      {clearTarget && (
        <ClearStorageModal
          section={clearTarget}
          onClose={() => setClearTarget(null)}
          onConfirm={handleClearConfirm}
        />
      )}
    </div>
  );
}