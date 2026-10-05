// Section 4: filterable movement ledger - trace any quantity change
// through its full history (item / type / date range / user filters).
import React, { useEffect, useState } from 'react';
import { Search, History } from 'lucide-react';
import MovementBadge, { formatQtyChange } from './MovementBadge';
import { getMovements } from '../../services/stockService';

const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function StockHistoryTab({ items, onOpenItem }) {
  const [filters, setFilters] = useState({ search: '', type: '', from: '', to: '', user: '' });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      getMovements(filters, { refresh: true })
        .then((r) => { if (!cancelled) setRows(r); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filters]);

  const setF = (name) => (e) => setFilters((prev) => ({ ...prev, [name]: e.target.value }));

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      <div className="p-6 border-b border-gray-100 dark:border-slate-800">
        <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
          <History size={20} className="mr-2 text-purple-500 dark:text-purple-400" /> Stock History
        </h3>
        <p className="text-sm text-gray-500 dark:text-slate-400">Every quantity change is logged — trace any number back to who did what, and when.</p>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 mt-4">
          <div className="relative lg:col-span-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
            <input value={filters.search} onChange={setF('search')} placeholder="Search item, SKU, note…" className="w-full pl-9 pr-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-300" />
          </div>
          <select value={filters.type} onChange={setF('type')} className="px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-300">
            <option value="">All types</option>
            <option value="STOCK_IN">Stock In</option>
            <option value="SALE">Sale</option>
            <option value="REFUND">Refund</option>
            <option value="ADJUSTMENT">Adjustment</option>
            <option value="STOCK_TAKE">Stock Take</option>
            <option value="IMPORT">Import</option>
          </select>
          <input type="date" value={filters.from} onChange={setF('from')} className="px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-300" title="From date" />
          <input type="date" value={filters.to} onChange={setF('to')} className="px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-300" title="To date" />
        </div>
        <input value={filters.user} onChange={setF('user')} placeholder="Filter by user…" className="mt-2.5 w-full sm:w-64 px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:border-blue-300" />
      </div>

      <LedgerTable rows={rows} loading={loading} items={items} onOpenItem={onOpenItem} />
    </div>
  );
}

function LedgerTable({ rows, loading, items, onOpenItem }) {
  return (
    <div className="overflow-x-auto max-h-[62vh] overflow-y-auto">
      <table className="w-full text-sm text-left">
        <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/80 dark:bg-slate-950/80 sticky top-0">
          <tr>
            <th className="px-6 py-3 font-medium">Type</th>
            <th className="px-6 py-3 font-medium">Item</th>
            <th className="px-6 py-3 font-medium text-center">Change</th>
            <th className="px-6 py-3 font-medium text-center">Result</th>
            <th className="px-6 py-3 font-medium">Reason / Note</th>
            <th className="px-6 py-3 font-medium">User</th>
            <th className="px-6 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
          {loading ? (
            <tr><td colSpan="7" className="px-6 py-10 text-center text-gray-400 dark:text-slate-500">Loading movements…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan="7" className="px-6 py-10 text-center text-gray-400 dark:text-slate-500">No stock movements match these filters.</td></tr>
          ) : rows.map((m) => {
            const item = items.find((i) => i.id === m.accessoryId);
            return (
              <tr key={m.local_key || m.id} className="hover:bg-gray-50/70 hover:dark:bg-slate-950/70 transition-colors">
                <td className="px-6 py-3"><MovementBadge type={m.type} /></td>
                <td className="px-6 py-3">
                  <button onClick={() => onOpenItem(item || m)} disabled={!item} className={`text-left ${item ? 'font-semibold text-gray-900 hover:text-blue-600' : 'text-gray-700'}`}>
                    {m.item_name}
                  </button>
                  <div className="text-[11px] font-mono text-gray-400 dark:text-slate-500">{m.sku}</div>
                </td>
                <td className="px-6 py-3 text-center">{formatQtyChange(m)}</td>
                <td className="px-6 py-3 text-center font-semibold text-gray-700 dark:text-slate-300">{m.resulting_quantity}</td>
                <td className="px-6 py-3 max-w-[220px]">
                  <span className="text-gray-600">{m.reason}</span>
                  {m.note && <span className="block text-xs text-gray-400 dark:text-slate-500 truncate">{m.note}</span>}
                  {m.reference && <span className="block text-[10px] font-mono text-gray-400 dark:text-slate-500 truncate">{m.reference}</span>}
                </td>
                <td className="px-6 py-3 text-gray-600 dark:text-slate-400">{m.user_name || '-'}</td>
                <td className="px-6 py-3 text-xs text-gray-500 dark:text-slate-400 whitespace-nowrap">{fmtDate(m.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}