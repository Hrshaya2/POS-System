// Section 6: bulk import from Excel/CSV.
// Downloadable template -> parse & preview (New / Update / Error per row,
// errors flagged and excluded) -> SKU matching (add qty by default, optional
// overwrite) -> apply + movement logging. Hard row cap of 1000.
import React, { useMemo, useRef, useState } from 'react';
import { Upload, FileDown, CheckCircle2, AlertTriangle, SlidersHorizontal, Clock, FileText } from 'lucide-react';
import { downloadCsv, parseCsvTable, applyColumnMapping } from '../../utils/csv';
import { runBulkImport } from '../../services/stockService';
import { IMPORT_ROW_CAP } from './constants';

const TEMPLATE_HEADERS = ['SKU', 'Name', 'Category', 'Quantity', 'Cost', 'Sell Price', 'Low Stock Threshold'];
const TEMPLATE_SAMPLE_ROWS = [
  { SKU: 'LM-000101', Name: 'iPhone 15 Tempered Glass', Category: 'Screen Protectors', Quantity: 10, Cost: 250, 'Sell Price': 500, 'Low Stock Threshold': 3 },
  { SKU: 'ACC-001', Name: '20W Apple Fast Charger', Category: 'Chargers', Quantity: 5, Cost: 3000, 'Sell Price': 4500, 'Low Stock Threshold': 5 }
];

export default function ImportTab({ items, user, imports = [], onDataChanged }) {
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
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-lg font-bold text-gray-900 flex items-center">
          <Upload size={20} className="mr-2 text-teal-600" /> Import from Excel / CSV
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          Match by SKU: existing items get their quantity <strong>added</strong> by default (or overwritten — your choice below); unknown SKUs become new items.
          Max <strong>{IMPORT_ROW_CAP}</strong> rows per import.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mt-4">
          <button onClick={() => downloadCsv('stock-import-template.csv', TEMPLATE_SAMPLE_ROWS, TEMPLATE_HEADERS)} className="flex items-center justify-center px-5 py-3 border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
            <FileDown size={16} className="mr-2" /> Download Template
          </button>
          <button onClick={() => fileRef.current?.click()} className="flex items-center justify-center px-5 py-3 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm font-bold shadow-md transition-colors">
            <Upload size={16} className="mr-2" /> Choose CSV File
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
        </div>

        {capExceeded && (
          <p className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 flex items-center">
            <AlertTriangle size={15} className="mr-2 shrink-0" />
            This file has {rows.length} rows — the cap is {IMPORT_ROW_CAP}. Please split it into smaller files.
          </p>
        )}
        {error && (
          <p className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</p>
        )}
      </div>

      {rawRows.length > 0 && !capExceeded && mapping && (
        <ColumnMapper headers={headers} mapping={mapping} setMapping={setMapping} rawRows={rawRows} />
      )}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 flex items-start space-x-3">
          <CheckCircle2 size={22} className="text-emerald-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-bold text-emerald-800">Import complete — {result.filename}</p>
            <p className="text-sm text-emerald-700 mt-0.5">
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

      {imports.length > 0 && <RecentImportsPanel imports={imports} />}
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
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header with summary + options */}
      <div className="p-6 border-b border-gray-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900">Preview: {filename}</h3>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs font-semibold">
            <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200">{newCount} new</span>
            <span className="px-2.5 py-1 rounded-full bg-teal-50 text-teal-700 border border-teal-200">{updateCount} updates</span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <label className="flex items-center space-x-2 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 cursor-pointer" title="When off, imported quantity is ADDED to current stock">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            <span>Overwrite quantity instead of adding</span>
          </label>
          <button onClick={onClear} className="px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
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
          <thead className="text-xs text-gray-400 uppercase bg-gray-50/80 sticky top-0">
            <tr>
              <th className="px-6 py-3 font-medium">#</th>
              <th className="px-6 py-3 font-medium">SKU</th>
              <th className="px-6 py-3 font-medium">Name</th>
              <th className="px-6 py-3 font-medium">Category</th>
              <th className="px-6 py-3 font-medium text-center">Qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {validRows.length === 0 ? (
              <tr><td colSpan="5" className="px-6 py-10 text-center text-sm text-gray-400">No importable rows in this file.</td></tr>
            ) : validRows.slice(0, 300).map((r) => (
              <tr key={r.index}>
                <td className="px-6 py-2.5 text-gray-400">{r.index + 1}</td>
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
              <tr><td colSpan="5" className="px-6 py-3 text-center text-xs text-gray-400">Showing first 300 of {validRows.length} rows…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {errorCount > 0 && (
        <div className="border-t border-gray-100">
          <button onClick={() => setShowSkipped((s) => !s)} className="w-full px-6 py-2.5 text-left text-xs font-semibold text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2">
            <AlertTriangle size={13} className={showSkipped ? 'text-amber-500 shrink-0' : 'text-gray-400 shrink-0'} />
            <span className="truncate">
              {errorCount} row{errorCount === 1 ? '' : 's'} will be skipped
              {reasons.length > 0 && ` — ${reasons.slice(0, 2).join('; ')}${reasons.length > 2 ? '…' : ''}`}
            </span>
            <span className="ml-auto pl-2 text-gray-400 shrink-0">{showSkipped ? 'Hide' : 'Show'}</span>
          </button>
          {showSkipped && (
            <div className="max-h-56 overflow-y-auto border-t border-gray-50 bg-rose-50/40">
              {errorRows.slice(0, 200).map((r) => (
                <div key={r.index} className="px-6 py-1.5 text-xs text-rose-700 flex gap-3 items-baseline">
                  <span className="text-gray-400 w-8 shrink-0 text-right">{r.index + 1}</span>
                  <span className="font-mono w-28 shrink-0 truncate">{r.sku || '—'}</span>
                  <span className="truncate">{r.errorText}</span>
                </div>
              ))}
              {errorRows.length > 200 && (
                <p className="px-6 py-1.5 text-[11px] text-gray-400">…and {errorRows.length - 200} more</p>
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
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <h3 className="text-lg font-bold text-gray-900 flex items-center">
        <SlidersHorizontal size={20} className="mr-2 text-amber-600" /> Map Columns
        <span className="ml-3 text-xs font-semibold text-gray-400">from your file's headers to our fields</span>
      </h3>
      <p className="text-sm text-gray-500 mt-1">
        We auto-matched <strong>{matched} of {FIELD_LABELS.length}</strong> columns. Adjust any that look wrong —
        the preview below updates instantly. Extra columns (totals, UOM, tax…) can simply be left unmapped.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
        {FIELD_LABELS.map((f) => {
          const selected = mapping?.[f.key] || '';
          const sample = selected ? sampleFor(selected) : null;
          const unmapped = !selected;
          return (
            <div key={f.key} className={`rounded-xl border p-3 transition-colors ${unmapped ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white'}`}>
              <label className="block text-xs font-bold text-gray-700">
                {f.label}
                {f.required && <span className="text-rose-500"> *</span>}
              </label>
              <select
                value={selected}
                onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}
                className={`mt-1.5 w-full px-2.5 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:border-blue-300 ${unmapped ? 'border-amber-300' : 'border-gray-200'}`}
              >
                <option value="">— not imported —</option>
                {headers.map((h) => (
                  <option key={h} value={h} disabled={!!usedBy[h] && usedBy[h] !== f.key}>{h}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1 truncate" title={sample ?? f.hint}>
                {sample !== null ? `e.g. ${sample}` : f.hint}
              </p>
            </div>
          );
        })}
      </div>

      {!mapping?.sku && (
        <p className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          No SKU column mapped — every row needs a code to match against existing items.
        </p>
      )}
      {!mapping?.sell_price && (
        <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          No sell price column mapped — new items can't be created without one. Existing items still import fine
          (their stock updates), or add a "Sell Price" column to the file and re-import.
        </p>
      )}
    </div>
  );
}

// Upload-history panel body. Kept ASCII-simple for reliability of edits.
function RecentImportsPanel({ imports = [] }) {
  const [openId, setOpenId] = useState(null);
  const rows = useMemo(
    () => [...imports].sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0)),
    [imports]
  );

  const fmtDate = (iso) => {
    try { return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '-'; }
    catch (_err) { return String(iso || '-'); }
  };

  const pill = (r) =>
    r.syncStatus === 'pending'
      ? <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 whitespace-nowrap">Waiting to sync...</span>
      : r.syncStatus === 'failed'
        ? <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200 whitespace-nowrap cursor-help" title={r.syncError || 'Rejected by server'}>Sync failed</span>
        : <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 whitespace-nowrap">Saved to database</span>;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="p-6 pb-4">
        <h3 className="text-lg font-bold text-gray-900 flex items-center flex-wrap gap-x-3">
          <Clock size={20} className="text-blue-600" /> Uploaded Files
          <span className="text-xs font-semibold text-gray-400">{rows.length} on record · click a file for details</span>
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          Every file ever imported into stock - who uploaded it, when, and exactly what it changed.
        </p>
      </div>

      <ul className="divide-y divide-gray-50 max-h-[430px] overflow-y-auto border-t border-gray-50">
        {rows.map((r) => {
          const isOpen = openId === r.id;
          const errs = r.errors?.length || 0;
          const skipped = (r.skipped || 0) + errs;
          return (
            <li key={r.id}>
              <button
                onClick={() => setOpenId(isOpen ? null : r.id)}
                className="w-full px-6 py-3.5 hover:bg-gray-50/70 flex items-center gap-3 text-left transition-colors"
              >
                <FileText size={18} className={`shrink-0 ${isOpen ? 'text-blue-500' : 'text-gray-300'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900 truncate">{r.filename}</span>
                  <span className="block text-xs text-gray-400 mt-0.5 truncate">
                    {fmtDate(r.created_at)} · by {r.imported_by_name || 'unknown'}
                  </span>
                </span>
                <span className="hidden md:flex items-center gap-1.5 text-xs font-bold shrink-0">
                  <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">{r.row_count || 0} rows</span>
                  <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">+{r.created || 0} new</span>
                  <span className="px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">{r.updated || 0} updated</span>
                  {skipped > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">{skipped} skipped</span>
                  )}
                </span>
                {pill(r)}
              </button>

              {isOpen && (
                <div className="px-6 pb-4 pt-2 bg-gray-50/40 border-b border-gray-100 text-sm">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 font-bold">
                    <span className="text-gray-900">{r.row_count || 0} total rows</span>
                    <span className="text-sky-700">+{r.created || 0} new items</span>
                    <span className="text-teal-700">{r.updated || 0} updated</span>
                    <span className={skipped > 0 ? 'text-rose-600' : 'text-gray-900'}>{skipped} skipped</span>
                  </div>

                  {errs > 0 && (
                    <div className="mt-3">
                      <p className="text-[11px] font-bold text-rose-700 uppercase tracking-wide mb-1.5">Skipped rows ({errs})</p>
                      <ul className="space-y-1 max-h-40 overflow-y-auto">
                        {r.errors.map((e, i) => (
                          <li key={i} className="text-xs text-gray-600">
                            <span className="font-mono font-bold text-gray-800">{e.sku || '(no SKU)'}</span> - {e.error}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {errs === 0 && r.syncStatus === 'failed' && (
                    <p className="mt-3 text-xs text-rose-700">
                      Could not be saved to the database: {r.syncError || 'unknown error'}.
                      The data stays safely on this device and will retry automatically when online.
                    </p>
                  )}

                  {errs === 0 && r.syncStatus !== 'failed' && (
                    <p className="mt-3 text-xs text-gray-400">No skipped rows - every line in the file was applied.</p>
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