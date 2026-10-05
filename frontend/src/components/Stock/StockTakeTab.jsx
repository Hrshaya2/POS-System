// Section 5: physical stock take.
// Start (category or all) -> count checklist with BLANK inputs (forces a
// real count; system quantities hidden) -> live progress -> variance summary
// (color-coded) -> explicit "Apply Corrections". Large tap targets.
import React, { useMemo, useRef, useState } from 'react';
import { ClipboardCheck, Play, CheckCircle2, AlertTriangle } from 'lucide-react';
import { startStockTake, saveTakeProgress, applyTakeCorrections } from '../../services/stockService';

const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function StockTakeTab({ categories, items, takes, user, isAdmin, onDataChanged }) {
  // Track the active take by its stable localKey - the record's id swaps to
  // the server ObjectId once the start op syncs, but localKey never changes.
  const [activeTakeKey, setActiveTakeKey] = useState(null);
  const activeTake = useMemo(
    () => takes.find((t) => (t.localKey || t.id) === activeTakeKey && t.status === 'in_progress') || null,
    [takes, activeTakeKey]
  );

  const handleStart = async ({ scopeType, scopeCategory }) => {
    const take = await startStockTake({ scopeType, scopeCategory }, items, user);
    onDataChanged?.();
    setActiveTakeKey(take.localKey || take.id);
  };

  if (activeTake) {
    return (
      <CountingView
        key={activeTake.localKey || activeTake.id}
        take={activeTake}
        user={user}
        isAdmin={isAdmin}
        onDataChanged={onDataChanged}
        onExit={() => { setActiveTakeKey(null); onDataChanged?.(); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <StartCard categories={categories} itemCount={items.filter((i) => !i.is_service).length} onStart={handleStart} />
      <HistoryList takes={takes} />
    </div>
  );
}

function StartCard({ categories, itemCount, onStart }) {
  const [scopeType, setScopeType] = useState('all');
  const [scopeCategory, setScopeCategory] = useState('');
  const canStart = scopeType === 'all' || !!scopeCategory;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
      <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
        <ClipboardCheck size={20} className="mr-2 text-purple-500 dark:text-purple-400" /> Start Stock Take
      </h3>
      <p className="text-sm text-gray-500 mt-1 mb-4">
        Generates a counting checklist with system quantities hidden — count what's actually on the shelf. Choose one category or everything.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_auto] gap-3 items-end">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Count</label>
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value)} className="px-4 py-3 border border-gray-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-300">
            <option value="all">All Items ({itemCount})</option>
            <option value="category">One category…</option>
          </select>
        </div>
        {scopeType === 'category' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Category</label>
            <select value={scopeCategory} onChange={(e) => setScopeCategory(e.target.value)} className="w-full px-4 py-3 border border-gray-200 dark:border-slate-700 rounded-xl focus:outline-none focus:border-blue-300">
              <option value="">Select category…</option>
              {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        )}
        <button
          onClick={() => onStart({ scopeType, scopeCategory })}
          disabled={!canStart}
          className="flex items-center justify-center px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-bold rounded-xl shadow-md transition-colors"
        >
          <Play size={18} className="mr-2" /> Start Counting
        </button>
      </div>
    </div>
  );
}

function HistoryList({ takes }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      <div className="p-6 pb-3"><h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Stock Take History</h3></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/60 dark:bg-slate-950/60">
            <tr>
              <th className="px-6 py-3 font-medium">Started</th>
              <th className="px-6 py-3 font-medium">Scope</th>
              <th className="px-6 py-3 font-medium">By</th>
              <th className="px-6 py-3 font-medium text-center">Counted</th>
              <th className="px-6 py-3 font-medium text-center">Variance</th>
              <th className="px-6 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {takes.length === 0 ? (
              <tr><td colSpan="6" className="px-6 py-8 text-center text-gray-400 dark:text-slate-500">No stock takes recorded yet.</td></tr>
            ) : takes.slice(0, 20).map((t) => (
              <tr key={t.id} className="hover:bg-gray-50/70">
                <td className="px-6 py-3 whitespace-nowrap">{fmtDateTime(t.started_at)}</td>
                <td className="px-6 py-3">{t.scope_type === 'category' ? t.scope_category : 'All items'}</td>
                <td className="px-6 py-3">{t.started_by_name}</td>
                <td className="px-6 py-3 text-center">{t.items_counted}/{(t.lines || []).length}</td>
                <td className={`px-6 py-3 text-center font-semibold ${
                  Number(t.total_variance) === 0 ? 'text-gray-500' : Number(t.total_variance) > 0 ? 'text-emerald-600' : 'text-rose-600'
                }`}>
                  {Number(t.total_variance) > 0 ? `+${t.total_variance}` : t.total_variance}
                </td>
                <td className="px-6 py-3">
                  {t.status === 'completed'
                    ? <span className="inline-flex items-center text-xs font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={14} className="mr-1" />Completed{t.completed_by_name ? ` · ${t.completed_by_name}` : ''}</span>
                    : <span className="inline-flex items-center text-xs font-semibold text-amber-600 dark:text-amber-400"><AlertTriangle size={14} className="mr-1" />In progress</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Large tap-target counting row for phone/tablet use.
function CountRow({ line, value, onChange, onBump }) {
  const counted = value !== '' && value !== undefined && value !== null;
  const diff = counted ? Number(value) - line.system_qty : null;

  let statusChip = null;
  if (counted) {
    if (diff === 0) statusChip = <span className="font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">MATCH</span>;
    else if (diff > 0) statusChip = <span className="font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">+{diff}</span>;
    else statusChip = <span className="font-bold px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300">{diff}</span>;
  }

  return (
    <div className={`flex items-center justify-between gap-4 px-5 py-4 ${counted ? 'bg-blue-50/30' : 'bg-white'}`}>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-gray-900 dark:text-slate-100 truncate">{line.name}</p>
        <p className="text-[11px] font-mono text-gray-400 dark:text-slate-500 truncate">{line.sku}{statusChip && <> · {statusChip}</>}</p>
      </div>
      <div className="flex items-center space-x-2 shrink-0">
        {/* Big steppers for fast tapping while walking the shelf */}
        <button onClick={() => onBump(-1)} className="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-slate-800 active:bg-gray-200 text-gray-600 dark:text-slate-400 text-2xl font-black flex items-center justify-center transition-transform active:scale-95" aria-label="decrement">−</button>
        <input
          type="number"
          inputMode="numeric"
          min="0"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="—"
          className="w-20 h-14 text-center text-2xl font-black border-2 rounded-2xl focus:outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-100 focus:dark:ring-purple-500/20 placeholder:text-gray-300 placeholder:dark:text-slate-600"
        />
        <button onClick={() => onBump(1)} className="w-12 h-12 rounded-2xl bg-purple-100 dark:bg-purple-500/20 active:bg-purple-200 text-purple-700 dark:text-purple-300 text-2xl font-black flex items-center justify-center transition-transform active:scale-95" aria-label="increment">+</button>
      </div>
    </div>
  );
}

// Color-coded variance review + explicit apply confirmation.
function VarianceSummary({ counts, lines, isAdmin, applying, applyResult, onBack, onApply, onDone }) {
  if (applyResult) {
    const v = applyResult.totalVariance;
    return (
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-8 text-center">
        <CheckCircle2 size={48} className="mx-auto text-emerald-500 dark:text-emerald-400 mb-3" />
        <h3 className="text-xl font-bold text-gray-900 dark:text-slate-100">Stock take applied</h3>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
          {applyResult.correctedItems} item(s) corrected · total variance{' '}
          <span className={`font-bold ${v === 0 ? 'text-gray-600' : v > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {v > 0 ? `+${v}` : v}
          </span>
          . Every correction was written to Stock History.
        </p>
        <button onClick={onDone} className="mt-5 px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl shadow-md transition-colors">
          Back to Stock Take
        </button>
      </div>
    );
  }

  const reviewed = lines
    .map((l) => ({ ...l, counted: counts[l.accessory_id] }))
    .filter((l) => l.counted !== '' && l.counted !== undefined && l.counted !== null);

  const variances = reviewed.filter((l) => Number(l.counted) !== l.system_qty);
  const totalVariance = reviewed.reduce((sum, l) => sum + (Number(l.counted) - l.system_qty), 0);

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Variance Summary</h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            {reviewed.length} counted · {variances.length} with differences · total variance{' '}
            <span className={`font-bold ${totalVariance === 0 ? 'text-gray-600' : totalVariance > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              {totalVariance > 0 ? `+${totalVariance}` : totalVariance}
            </span>
          </p>
        </div>
        <button onClick={onBack} className="px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-semibold hover:bg-gray-50 hover:dark:bg-slate-950">← Keep counting</button>
      </div>

      <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/80 dark:bg-slate-950/80 sticky top-0">
            <tr>
              <th className="px-6 py-3 font-medium">Item</th>
              <th className="px-6 py-3 font-medium text-center">System</th>
              <th className="px-6 py-3 font-medium text-center">Counted</th>
              <th className="px-6 py-3 font-medium text-center">Difference</th>
              <th className="px-6 py-3 font-medium">Action on apply</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {reviewed.map((l) => {
              const diff = Number(l.counted) - l.system_qty;
              const color = diff === 0 ? '' : diff > 0 ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-50/60' : 'text-rose-700 dark:text-rose-300 bg-rose-50/60';
              return (
                <tr key={l.accessory_id} className={color}>
                  <td className="px-6 py-3">
                    <span className="font-semibold text-gray-900 dark:text-slate-100">{l.name}</span>
                    <span className="block text-[11px] font-mono text-gray-400 dark:text-slate-500">{l.sku}</span>
                  </td>
                  <td className="px-6 py-3 text-center">{l.system_qty}</td>
                  <td className="px-6 py-3 text-center font-bold">{l.counted}</td>
                  <td className={`px-6 py-3 text-center font-black ${diff === 0 ? 'text-gray-400' : diff > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {diff > 0 ? `+${diff}` : diff}
                  </td>
                  <td className="px-6 py-3 text-xs text-gray-500 dark:text-slate-400">
                    {diff === 0 ? 'No change' : `Set quantity to ${l.counted} + log STOCK_TAKE movement`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-950 flex flex-col sm:flex-row justify-between items-center gap-3">
        {!isAdmin && (
          <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 rounded-lg px-3 py-2 w-full sm:w-auto flex-1">
            Applying corrections requires an admin or shop owner account.
          </p>
        )}
        <button
          onClick={onApply}
          disabled={!isAdmin || applying || variances.length === 0}
          title={variances.length === 0 ? 'No differences to apply' : undefined}
          className="w-full sm:w-auto px-6 py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-bold rounded-xl shadow-md transition-colors"
        >
          {applying ? 'Applying…' : `Apply Corrections (${variances.length})`}
        </button>
      </div>
    </div>
  );
}

function CountingView({ take, user, isAdmin, onExit, onDataChanged }) {
  const [counts, setCounts] = useState(() => ({ ...(take.counts || {}) }));
  const [showVariance, setShowVariance] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  // Mirror of counts for the debounced autosave (keeps side-effects out of
  // the state updater so StrictMode double-invokes can't double-enqueue ops).
  const countsRef = useRef({ ...(take.counts || {}) });
  const saveTimer = useRef(null);

  const lines = take.lines || [];
  const countedIds = lines.filter((l) => {
    const v = counts[l.accessory_id];
    return v !== '' && v !== undefined && v !== null;
  });
  const matches = countedIds.filter((l) => Number(counts[l.accessory_id]) === l.system_qty).length;
  const variances = countedIds.length - matches;

  const scheduleSave = () => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTakeProgress(take, { ...countsRef.current }).catch((err) =>
        console.warn('[stockTake] progress save failed:', err)
      );
    }, 350);
  };

  const setCount = (accessoryId, raw) => {
    const v = raw === '' ? '' : Math.max(0, Number(raw) || 0);
    countsRef.current = { ...countsRef.current, [accessoryId]: v };
    setCounts(countsRef.current);
    scheduleSave();
  };
  const bump = (line, step) => {
    const cur = Number(countsRef.current[line.accessory_id] ?? 0) || 0;
    setCount(line.accessory_id, Math.max(0, cur + step));
  };

  const handleApply = async () => {
    if (!isAdmin) {
      alert('Only admins and shop owners can apply stock take corrections.');
      return;
    }
    if (!window.confirm('Apply corrections now? Quantities will be updated and every variance logged in Stock History. This cannot be undone.')) return;
    setApplying(true);
    try {
      // Merge the latest typed counts into the take before applying.
      const takeWithCounts = { ...take, counts: { ...countsRef.current } };
      const result = await applyTakeCorrections(takeWithCounts, user);
      setApplying(false);
      setApplyResult(result);
      onDataChanged?.();
    } catch (err) {
      alert(err.message || 'Could not apply corrections');
      setApplying(false);
    }
  };

  if (showVariance || applyResult) {
    return (
      <VarianceSummary
        take={take}
        counts={counts}
        lines={lines}
        isAdmin={isAdmin}
        applying={applying}
        applyResult={applyResult}
        onBack={() => setShowVariance(false)}
        onApply={handleApply}
        onDone={() => { setShowVariance(false); setApplyResult(null); onExit(); }}
      />
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-purple-100 dark:border-purple-500/20 overflow-hidden">
      {/* Sticky progress header */}
      <div className="bg-purple-600 text-white px-6 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold flex items-center"><ClipboardCheck size={20} className="mr-2" /> Counting: {take.scope_type === 'category' ? take.scope_category : 'All Items'}</h3>
            <p className="text-xs text-purple-200 mt-0.5">System quantities are hidden — enter what you actually count.</p>
          </div>
          <button onClick={onExit} className="px-4 py-2 bg-white/15 hover:bg-white/25 rounded-xl text-sm font-semibold transition-colors">Exit</button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="bg-white/10 rounded-xl py-2">
            <p className="text-xl font-black">{countedIds.length}/{lines.length}</p>
            <p className="text-[10px] uppercase tracking-wide text-purple-200">Counted</p>
          </div>
          <div className="bg-white/10 rounded-xl py-2">
            <p className="text-xl font-black text-emerald-300">{matches}</p>
            <p className="text-[10px] uppercase tracking-wide text-purple-200">Match</p>
          </div>
          <div className="bg-white/10 rounded-xl py-2">
            <p className={`text-xl font-black ${variances > 0 ? 'text-rose-300' : ''}`}>{variances}</p>
            <p className="text-[10px] uppercase tracking-wide text-purple-200">Variance</p>
          </div>
        </div>
      </div>

      {/* Checklist */}
      <div className="divide-y divide-gray-100 dark:divide-slate-800 max-h-[58vh] overflow-y-auto">
        {lines.map((line) => (
          <CountRow
            key={line.accessory_id}
            line={line}
            value={counts[line.accessory_id]}
            onChange={(v) => setCount(line.accessory_id, v)}
            onBump={(step) => bump(line, step)}
          />
        ))}
      </div>

      {/* Finish */}
      <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-950 flex justify-end">
        <button
          onClick={() => setShowVariance(true)}
          disabled={countedIds.length === 0}
          className="px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-bold rounded-xl shadow-md transition-colors"
        >
          Review & Finish ({countedIds.length} counted)
        </button>
      </div>
    </div>
  );
}