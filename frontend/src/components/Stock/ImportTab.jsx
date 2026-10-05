// Section 6: bulk import from Excel/CSV.
// Downloadable template -> parse & preview (New / Update / Error per row,
// errors flagged and excluded) -> SKU matching (add qty by default, optional
// overwrite) -> apply + movement logging. Hard row cap of 1000.
import React, { useMemo, useRef, useState } from 'react';
import { Upload, FileDown, CheckCircle2, AlertTriangle, SlidersHorizontal, Clock, FileText, Trash2 } from 'lucide-react';
import { downloadCsv, parseCsvTable, applyColumnMapping } from '../../utils/csv';
import { runBulkImport, deleteImportRecords } from '../../services/stockService';
import { IMPORT_ROW_CAP } from './constants';

const TEMPLATE_HEADERS = ['SKU', 'Name', 'Category', 'Quantity', 'Cost', 'Sell Price', 'Low Stock Threshold'];
const TEMPLATE_SAMPLE_ROWS = [
  { SKU: 'LM-000101', Name: 'iPhone 15 Tempered Glass', Category: 'Screen Protectors', Quantity: 10, Cost: 250, 'Sell Price': 500, 'Low Stock Threshold': 3 },
  { SKU: 'ACC-001', Name: '20W Apple Fast Charger', Category: 'Chargers', Quantity: 5, Cost: 3000, 'Sell Price': 4500, 'Low Stock Threshold': 5 }
];

export default function ImportTab({ items, user, imports = [], onDataChanged }) {
  // Removing an upload-history record is an admin action, matching the rule
  // used for deleting categories and items elsewhere on the page.
  const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';
  // Raw parsed file + the column mapping that turns foreign exports (other
  // POS systems) into our canonical row shape. `rows` is always derived from
  // (rawRows, mapping), so adjusting the mapping live-refreshes the preview.
  const [rawRows, setRawRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState(null);
  const rows = useMemo(() => (mapping ? applyColumnMapping(rawRows, mapping) : []), [rawRows, mapping]);
  const [filename, setFilename] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  // Row classification against the current cache + known categories.
  const analyzed = useMemo(() => {
    const skuMap = new Map(items.map((i) => [String(i.sku).toUpperCase(), i]));

    return rows.map((row, index) => {
      const errors = [];
      const sku = String(row.sku || '').trim();
      const name = String(row.name || '').trim();
      const category = String(row.category || '').trim();
      const quantity = row.quantity === '' ? null : Number(row.quantity);
      const sell = row.sell_price === '' ? null : Number(row.sell_price);

      if (!sku) errors.push('Missing SKU');
      else if (!name && !skuMap.has(sku.toUpperCase())) errors.push('New item needs a name');
      // Any non-empty category string is accepted - unknown ones simply show
      // up as a new category card after the import (migration-friendly).
      if (!category) errors.push('Missing category');
      if (quantity !== null && (Number.isNaN(quantity) || quantity < 0)) errors.push(`Invalid quantity "${row.quantity}"`);
      if (sell !== null && Number.isNaN(sell)) errors.push('Invalid sell price');
      if (!skuMap.has(sku.toUpperCase()) && !(Number(sell) > 0)) errors.push('New item needs a sell price');

      const existing = sku ? skuMap.get(sku.toUpperCase()) : null;
      return {
        ...row,
        index,
        status: errors.length ? 'error' : existing ? 'update' : 'new',
        existing,
        errorText: errors.join('; ')
      };
    });
  }, [rows, items]);

  const validRows = analyzed.filter((r) => r.status !== 'error');
  const errorRows = analyzed.filter((r) => r.status === 'error');
  const newCount = validRows.filter((r) => r.status === 'new').length;
  const updateCount = validRows.filter((r) => r.status === 'update').length;
  const capExceeded = rows.length > IMPORT_ROW_CAP;

  // Handlers + JSX below.
  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseCsvTable(String(reader.result || ''));
        if (!parsed.rawRows.length) {
          setError('No data rows found in the file.');
          setRawRows([]); setHeaders([]); setMapping(null);
          return;
        }
        setFilename(file.name);
        setHeaders(parsed.headers);
        setMapping(parsed.mapping); // auto-guessed; adjustable in Map Columns
        setRawRows(parsed.rawRows);
      } catch (err) {
        setError(`Could not read the file: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = async () => {
    if (capExceeded || !validRows.length || importing) return;
    setImporting(true);
    try {
      const summary = await runBulkImport(
        {
          filename,
          overwrite,
          rows: validRows.map((r) => ({
            sku: r.sku, name: r.name, category: r.category, quantity: r.quantity,
            cost_price: r.cost_price, sell_price: r.sell_price, low_stock_threshold: r.low_stock_threshold
          }))
        },
        user
      );
      setResult({ ...summary, filename, errorCount: errorRows.length });
      setRawRows([]); setHeaders([]); setMapping(null);
      setFilename('');
      onDataChanged?.();
    } catch (err) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
        <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
          <Upload size={20} className="mr-2 text-teal-600 dark:text-teal-400" /> Import from Excel / CSV
        </h3>
        <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
          Match by SKU: existing items get their quantity <strong>added</strong> by default (or overwritten — your choice below); unknown SKUs become new items.
          Max <strong>{IMPORT_ROW_CAP}</strong> rows per import.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mt-4">
          <button onClick={() => downloadCsv('stock-import-template.csv', TEMPLATE_SAMPLE_ROWS, TEMPLATE_HEADERS)} className="flex items-center justify-center px-5 py-3 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors">
            <FileDown size={16} className="mr-2" /> Download Template
          </button>
          <button onClick={() => fileRef.current?.click()} className="flex items-center justify-center px-5 py-3 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm font-bold shadow-md transition-colors">
            <Upload size={16} className="mr-2" /> Choose CSV File
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
        </div>

        {capExceeded && (
          <p className="mt-3 text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg px-3 py-2 flex items-center">
            <AlertTriangle size={15} className="mr-2 shrink-0" />
            This file has {rows.length} rows — the cap is {IMPORT_ROW_CAP}. Please split it into smaller files.
          </p>
        )}
        {error && (
          <p className="mt-3 text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>

      {rawRows.length > 0 && !capExceeded && mapping && (
        <ColumnMapper headers={headers} mapping={mapping} setMapping={setMapping} rawRows={rawRows} />
      )}

      {result && (
        <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-2xl p-5 flex items-start space-x-3">
          <CheckCircle2 size={22} className="text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-bold text-emerald-800 dark:text-emerald-200">Import complete — {result.filename}</p>
            <p className="text-sm text-emerald-700 dark:text-emerald-300 mt-0.5">
              {result.created} new item(s) · {result.updated} updated · {result.movementsLogged} stock movement(s) logged referencing this file.
              {result.errorCount > 0 && ` ${result.errorCount} error row(s) were excluded.`}
            </p>
          </div>
        </div>
      )}

      {rows.length > 0 && !capExceeded && (
        <PreviewPanel
          validRows={validRows}
          errorRows={errorRows}
          filename={filename}
          newCount={newCount}
          updateCount={updateCount}
          overwrite={overwrite}
          setOverwrite={setOverwrite}
          importing={importing}
          onImport={handleImport}
          onClear={() => { setRawRows([]); setHeaders([]); setMapping(null); setFilename(''); }}
        />
      )}

      {imports.length > 0 && (
        <RecentImportsPanel
          imports={imports}
          isAdmin={isAdmin}
          onChanged={onDataChanged}
        />
      )}
    </div>
  );
}

// Upload history: every imported file, newest first. Each row's status pill
// says exactly where its data lives right now: "Saved to database" = confirmed
// by the server; "Waiting to sync..." = queued locally (kept visible on every
// refresh until the connection returns); "Sync failed" = rejected, with the
// server's reason shown on hover / when expanded.
// Mandatory preview step: clean migration view - only importable rows are
// listed; rows that would fail collapse into one expandable "skipped" line
// so nothing disappears silently. Overwrite toggle + confirm button.
function PreviewPanel({ validRows, errorRows, filename, newCount, updateCount, overwrite, setOverwrite, importing, onImport, onClear }) {
  const [showSkipped, setShowSkipped] = useState(false);
  const errorCount = errorRows.length;
  const reasons = Array.from(new Set(errorRows.map((r) => r.errorText)));
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      {/* Header with summary + options */}
      <div className="p-6 border-b border-gray-100 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Preview: {filename}</h3>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs font-semibold">
            <span className="px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30">{newCount} new</span>
            <span className="px-2.5 py-1 rounded-full bg-teal-50 dark:bg-teal-500/10 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-500/30">{updateCount} updates</span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <label className="flex items-center space-x-2 text-sm text-gray-700 dark:text-slate-300 bg-gray-50 dark:bg-slate-950 border border-gray-200 dark:border-slate-700 rounded-xl px-3 py-2 cursor-pointer" title="When off, imported quantity is ADDED to current stock">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            <span>Overwrite quantity instead of adding</span>
          </label>
          <button onClick={onClear} className="px-4 py-2.5 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors">
            Cancel
          </button>
          <button
            onClick={onImport}
            disabled={importing || newCount + updateCount === 0}
            className="px-6 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-40 text-white rounded-xl text-sm font-bold shadow-md transition-colors whitespace-nowrap"
          >
            {importing ? 'Importing…' : `Confirm Import (${newCount + updateCount} rows)`}
          </button>
        </div>
      </div>

      {/* Row table */}
      <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/80 dark:bg-slate-950/80 sticky top-0">
            <tr>
              <th className="px-6 py-3 font-medium">#</th>
              <th className="px-6 py-3 font-medium">SKU</th>
              <th className="px-6 py-3 font-medium">Name</th>
              <th className="px-6 py-3 font-medium">Category</th>
              <th className="px-6 py-3 font-medium text-center">Qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {validRows.length === 0 ? (
              <tr><td colSpan="5" className="px-6 py-10 text-center text-sm text-gray-400 dark:text-slate-500">No importable rows in this file.</td></tr>
            ) : validRows.slice(0, 300).map((r) => (
              <tr key={r.index}>
                <td className="px-6 py-2.5 text-gray-400 dark:text-slate-500">{r.index + 1}</td>
                <td className="px-6 py-2.5 font-mono text-xs">{r.sku || '—'}</td>
                <td className="px-6 py-2.5">{r.name || '—'}</td>
                <td className="px-6 py-2.5">{r.category || '—'}</td>
                <td className="px-6 py-2.5 text-center">
                  {overwrite ? <span className="font-bold">{r.quantity}</span> : r.existing ? (
                    <span>{Number(r.existing.quantity || 0)} → <strong>{Number(r.existing.quantity || 0) + (Number(r.quantity) || 0)}</strong></span>
                  ) : Number(r.quantity) || 0}
                </td>
              </tr>
            ))}
            {validRows.length > 300 && (
              <tr><td colSpan="5" className="px-6 py-3 text-center text-xs text-gray-400 dark:text-slate-500">Showing first 300 of {validRows.length} rows…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {errorCount > 0 && (
        <div className="border-t border-gray-100 dark:border-slate-800">
          <button onClick={() => setShowSkipped((s) => !s)} className="w-full px-6 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 hover:text-gray-700 hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors flex items-center gap-2">
            <AlertTriangle size={13} className={showSkipped ? 'text-amber-500 dark:text-amber-400 shrink-0' : 'text-gray-400 dark:text-slate-500 shrink-0'} />
            <span className="truncate">
              {errorCount} row{errorCount === 1 ? '' : 's'} will be skipped
              {reasons.length > 0 && ` — ${reasons.slice(0, 2).join('; ')}${reasons.length > 2 ? '…' : ''}`}
            </span>
            <span className="ml-auto pl-2 text-gray-400 dark:text-slate-500 shrink-0">{showSkipped ? 'Hide' : 'Show'}</span>
          </button>
          {showSkipped && (
            <div className="max-h-56 overflow-y-auto border-t border-gray-50 dark:border-slate-800 bg-rose-50/40">
              {errorRows.slice(0, 200).map((r) => (
                <div key={r.index} className="px-6 py-1.5 text-xs text-rose-700 dark:text-rose-300 flex gap-3 items-baseline">
                  <span className="text-gray-400 dark:text-slate-500 w-8 shrink-0 text-right">{r.index + 1}</span>
                  <span className="font-mono w-28 shrink-0 truncate">{r.sku || '—'}</span>
                  <span className="truncate">{r.errorText}</span>
                </div>
              ))}
              {errorRows.length > 200 && (
                <p className="px-6 py-1.5 text-[11px] text-gray-400 dark:text-slate-500">…and {errorRows.length - 200} more</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Our canonical import fields and which ones matter for validation.
const FIELD_LABELS = [
  { key: 'sku', label: 'SKU / Code', required: true, hint: 'Matching key — required' },
  { key: 'name', label: 'Product Name', required: true, hint: 'Required for new items' },
  { key: 'category', label: 'Category', required: true, hint: 'New categories are created automatically' },
  { key: 'quantity', label: 'Quantity', required: false, hint: 'Stock count to add (or overwrite)' },
  { key: 'cost_price', label: 'Cost', required: false, hint: 'Optional' },
  { key: 'sell_price', label: 'Sell Price', required: true, hint: 'Required for new items' },
  { key: 'low_stock_threshold', label: 'Low Stock Threshold', required: false, hint: 'Optional (default 5)' }
];

// Column mapping UI for files exported from other systems. Auto-guessed on
// file load; every select updates the live preview below instantly.
function ColumnMapper({ headers, mapping, setMapping, rawRows }) {
  const usedBy = {};
  for (const [fieldKey, headerText] of Object.entries(mapping || {})) {
    if (headerText) usedBy[headerText] = fieldKey;
  }
  const sampleFor = (headerText) => {
    for (const r of rawRows) {
      const v = String(r[headerText] ?? '').trim();
      if (v !== '') return v;
    }
    return null;
  };
  const matched = FIELD_LABELS.filter((f) => mapping?.[f.key]).length;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
      <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
        <SlidersHorizontal size={20} className="mr-2 text-amber-600 dark:text-amber-400" /> Map Columns
        <span className="ml-3 text-xs font-semibold text-gray-400 dark:text-slate-500">from your file's headers to our fields</span>
      </h3>
      <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
        We auto-matched <strong>{matched} of {FIELD_LABELS.length}</strong> columns. Adjust any that look wrong —
        the preview below updates instantly. Extra columns (totals, UOM, tax…) can simply be left unmapped.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
        {FIELD_LABELS.map((f) => {
          const selected = mapping?.[f.key] || '';
          const sample = selected ? sampleFor(selected) : null;
          const unmapped = !selected;
          return (
            <div key={f.key} className={`rounded-xl border p-3 transition-colors ${unmapped ? 'border-amber-300 dark:border-amber-500/40 bg-amber-50/60 dark:bg-amber-500/10' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800'}`}>
              <label className="block text-xs font-bold text-gray-700 dark:text-slate-300">
                {f.label}
                {f.required && <span className="text-rose-500"> *</span>}
              </label>
              <select
                value={selected}
                onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                className={`mt-1.5 w-full px-2.5 py-2 border rounded-lg text-sm bg-white dark:bg-slate-900 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500 ${unmapped ? 'border-amber-300 dark:border-amber-500/40' : 'border-gray-200 dark:border-slate-700'}`}
              >
                <option value="">— not imported —</option>
                {headers.map((h) => (
                  <option key={h} value={h} disabled={!!usedBy[h] && usedBy[h] !== f.key}>{h}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1 truncate" title={sample ?? f.hint}>
                {sample !== null ? `e.g. ${sample}` : f.hint}
              </p>
            </div>
          );
        })}
      </div>

      {!mapping?.sku && (
        <p className="mt-3 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg px-3 py-2">
          No SKU column mapped — every row needs a code to match against existing items.
        </p>
      )}
      {!mapping?.sell_price && (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg px-3 py-2">
          No sell price column mapped — new items can't be created without one. Existing items still import fine
          (their stock updates), or add a "Sell Price" column to the file and re-import.
        </p>
      )}
    </div>
  );
}

// Upload-history panel body. Kept ASCII-simple for reliability of edits.
function RecentImportsPanel({ imports = [], isAdmin = false, onChanged }) {
  const [openId, setOpenId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState('');
  const rows = useMemo(
    () => [...imports].sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0)),
    [imports]
  );

  // Rows still syncing have no server record to delete yet, so they must be
  // excluded from selection - otherwise "Remove all" would report failures.
  const removableIds = useMemo(
    () => new Set(rows
      .filter((r) => r.syncStatus !== 'pending' && r.syncStatus !== 'failed' && r.id)
      .map((r) => String(r.id))),
    [rows]
  );

  const allSelected = removableIds.size > 0 && [...removableIds].every((id) => selected.has(id));
  const selectedRows = rows.filter((r) => selected.has(String(r.id)));

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(removableIds));
    setConfirmAll(false);
  };

  const runDelete = async (records) => {
    if (!records.length) return;
    setBusy(true);
    setError('');
    try {
      const res = await deleteImportRecords(records);
      setSelected(new Set());
      setConfirmAll(false);
      if (res.failed) {
        setError(
          `Removed ${res.ok}, but ${res.failed} could not be removed. `
          + res.errors.slice(0, 3).map((e) => `${e.filename}: ${e.error}`).join('; ')
        );
      }
      await onChanged?.();
    } catch (err) {
      setError(err.message || 'Could not remove the file record');
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (record) => {
    if (!window.confirm(
      `Remove "${record.filename}" from the uploaded files list?\n\n`
      + 'This clears the history entry only. The items and stock it added are not affected.'
    )) return;
    await runDelete([record]);
  };

  const fmtDate = (iso) => {
    try { return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-'; }
    catch (_err) { return String(iso || '-'); }
  };

  const pill = (r) =>
    r.syncStatus === 'pending'
      ? <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-500/30 whitespace-nowrap">Waiting to sync...</span>
      : r.syncStatus === 'failed'
        ? <span className="px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30 whitespace-nowrap cursor-help" title={r.syncError || 'Rejected by server'}>Sync failed</span>
        : <span className="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30 whitespace-nowrap">Saved to database</span>;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      <div className="p-6 pb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center flex-wrap gap-x-3">
              <Clock size={20} className="text-blue-600" /> Uploaded Files
              <span className="text-xs font-semibold text-gray-400 dark:text-slate-500">{rows.length} on record · click a file for details</span>
            </h3>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
              Every file ever imported into stock - who uploaded it, when, and exactly what it changed.
            </p>
          </div>

          {isAdmin && removableIds.size > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={toggleAll}
                disabled={busy}
                className="px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-xl text-xs font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors disabled:opacity-50"
              >
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>

              {selectedRows.length > 0 && (
                !confirmAll ? (
                  <button
                    onClick={() => setConfirmAll(true)}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold shadow-md transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={14} /> Remove selected ({selectedRows.length})
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => { runDelete(selectedRows); }}
                      disabled={busy}
                      className="flex items-center gap-1.5 px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold shadow-md transition-colors disabled:opacity-50"
                    >
                      {busy ? 'Removing…' : `Yes, remove ${selectedRows.length}`}
                    </button>
                    <button
                      onClick={() => setConfirmAll(false)}
                      disabled={busy}
                      className="px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-xl text-xs font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                )
              )}
            </div>
          )}
        </div>

        {confirmAll && (
          <p className="mt-3 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg px-3 py-2 flex items-center">
            <AlertTriangle size={14} className="mr-2 shrink-0" />
            This removes {selectedRows.length} file record(s) from the list. The items and stock they added are NOT affected.
          </p>
        )}
        {error && (
          <p className="mt-3 text-xs text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>

      <ul className="divide-y divide-gray-50 dark:divide-slate-800 max-h-[430px] overflow-y-auto border-t border-gray-50 dark:border-slate-800">
        {rows.map((r) => {
          const isOpen = openId === r.id;
          const errs = r.errors?.length || 0;
          const skipped = (r.skipped || 0) + errs;
          return (
            <li key={r.id}>
              <div className="flex items-stretch hover:bg-gray-50/70 hover:dark:bg-slate-950/70 transition-colors">
              <div className="px-6 py-3.5 flex items-center gap-3 text-left flex-1 min-w-0">
                {isAdmin && removableIds.has(String(r.id)) ? (
                  <input
                    type="checkbox"
                    checked={selected.has(String(r.id))}
                    onChange={() => toggleOne(r.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${r.filename}`}
                    className="w-4 h-4 rounded border-gray-300 dark:border-slate-700 text-blue-600 dark:text-blue-400 focus:ring-blue-500 shrink-0 cursor-pointer"
                  />
                ) : isAdmin ? (
                  <span
                    title="This file has not finished syncing yet"
                    className="w-4 h-4 rounded border border-dashed border-gray-300 dark:border-slate-700 shrink-0"
                  />
                ) : null}

                <button
                  onClick={() => setOpenId(isOpen ? null : r.id)}
                  className="flex items-center gap-3 text-left flex-1 min-w-0"
                >
                <FileText size={18} className={`shrink-0 ${isOpen ? 'text-blue-500 dark:text-blue-400' : 'text-gray-300 dark:text-slate-600'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900 dark:text-slate-100 truncate">{r.filename}</span>
                  <span className="block text-xs text-gray-400 dark:text-slate-500 mt-0.5 truncate">
                    {fmtDate(r.created_at)} · by {r.imported_by_name || 'unknown'}
                  </span>
                </span>
                <span className="hidden md:flex items-center gap-1.5 text-xs font-bold shrink-0">
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400 border border-gray-200 dark:border-slate-700">{r.row_count || 0} rows</span>
                  <span className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-500/30">+{r.created || 0} new</span>
                  <span className="px-2 py-0.5 rounded-full bg-teal-50 dark:bg-teal-500/10 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-500/30">{r.updated || 0} updated</span>
                  {skipped > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30">{skipped} skipped</span>
                  )}
                </span>
                {pill(r)}
                </button>
              </div>

              {isAdmin && (
                <div className="pr-5 pl-1 flex items-center">
                  <button
                    onClick={() => removeOne(r)}
                    disabled={busy}
                    title={removableIds.has(String(r.id))
                      ? 'Remove this file record'
                      : 'This file has not finished syncing yet'}
                    className="p-2 rounded-lg text-gray-300 dark:text-slate-600 hover:text-rose-600 hover:dark:text-rose-400 hover:bg-rose-50 hover:dark:bg-rose-500/10 transition-colors disabled:opacity-40 disabled:hover:text-gray-300 dark:disabled:hover:text-slate-600"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
              </div>

              {isOpen && (
                <div className="px-6 pb-4 pt-2 bg-gray-50/40 dark:bg-slate-950/40 border-b border-gray-100 dark:border-slate-800 text-sm">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 font-bold">
                    <span className="text-gray-900 dark:text-slate-100">{r.row_count || 0} total rows</span>
                    <span className="text-sky-700">+{r.created || 0} new items</span>
                    <span className="text-teal-700">{r.updated || 0} updated</span>
                    <span className={skipped > 0 ? 'text-rose-600' : 'text-gray-900 dark:text-slate-100'}>{skipped} skipped</span>
                  </div>

                  {errs > 0 && (
                    <div className="mt-3">
                      <p className="text-[11px] font-bold text-rose-700 dark:text-rose-300 uppercase tracking-wide mb-1.5">Skipped rows ({errs})</p>
                      <ul className="space-y-1 max-h-40 overflow-y-auto">
                        {r.errors.map((e, i) => (
                          <li key={i} className="text-xs text-gray-600 dark:text-slate-400">
                            <span className="font-mono font-bold text-gray-800 dark:text-slate-200">{e.sku || '(no SKU)'}</span> - {e.error}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {errs === 0 && r.syncStatus === 'failed' && (
                    <p className="mt-3 text-xs text-rose-700 dark:text-rose-300">
                      Could not be saved to the database: {r.syncError || 'unknown error'}.
                      The data stays safely on this device and will retry automatically when online.
                    </p>
                  )}

                  {errs === 0 && r.syncStatus !== 'failed' && (
                    <p className="mt-3 text-xs text-gray-400 dark:text-slate-500">No skipped rows - every line in the file was applied.</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}