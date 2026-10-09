// Section 7: low stock banner + dead stock indicator.
// Low stock items are clickable (jumps to that item's category) and the whole
// low-stock list can be exported as a PDF reorder report;
// dead stock answers "what's not moving" with a 30/60/90-day selector.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, TrendingDown, FileDown } from 'lucide-react';
import { getAlerts } from '../../services/stockService';

const DEAD_STOCK_WINDOWS = [30, 60, 90];

export default function AlertsPanel({ onJumpToItem, onExportLowStockPdf }) {
  const [deadDays, setDeadDays] = useState(30);
  const [data, setData] = useState({ lowStock: [], deadStock: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAlerts(deadDays, { refresh: true })
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deadDays]);

  return (
    <div className="space-y-5">
      <LowStockCard data={data} loading={loading} onJumpToItem={onJumpToItem} onExportLowStockPdf={onExportLowStockPdf} />
      <DeadStockCard data={data} loading={loading} deadDays={deadDays} setDeadDays={setDeadDays} onJumpToItem={onJumpToItem} />
    </div>
  );
}

function LowStockCard({ data, loading, onJumpToItem, onExportLowStockPdf }) {
  return (
    <div className={`rounded-2xl border overflow-hidden ${data.lowStock.length > 0 ? 'bg-rose-50/60 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30' : 'bg-white dark:bg-slate-800 border-gray-100 dark:border-slate-800'}`}>
      <div className="px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center flex-wrap">
          <AlertTriangle size={20} className={`mr-2 ${data.lowStock.length > 0 ? 'text-rose-500 dark:text-rose-400' : 'text-emerald-500 dark:text-emerald-400'}`} />
          Low Stock
          {data.lowStock.length > 0 && (
            <span className="ml-2 text-xs font-bold bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 px-2.5 py-1 rounded-full">{data.lowStock.length} at/below threshold</span>
          )}
        </h3>
        {!loading && data.lowStock.length > 0 && onExportLowStockPdf && (
          <button
            onClick={onExportLowStockPdf}
            title="Export all low-stock items to a PDF reorder report"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-sm transition-colors"
          >
            <FileDown size={14} /> Export PDF
          </button>
        )}
      </div>
      {loading ? (
        <p className="px-6 pb-5 text-sm text-gray-400 dark:text-slate-500">Checking stock levels…</p>
      ) : data.lowStock.length === 0 ? (
        <p className="px-6 pb-5 text-sm text-emerald-600 dark:text-emerald-400">All good — nothing is at or below its low-stock threshold.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 px-6 pb-5">
          {data.lowStock.slice(0, 12).map((item) => (
            <button
              key={item.id}
              onClick={() => onJumpToItem(item)}
              title="Open this item"
              className="text-left bg-white dark:bg-slate-800 rounded-xl border border-rose-100 dark:border-rose-500/30 p-4 hover:shadow-md hover:border-rose-200 dark:hover:border-rose-400 transition-all"
            >
              <div className="flex justify-between items-start">
                <div className="min-w-0 pr-2">
                  <p className="font-semibold text-gray-900 dark:text-slate-100 truncate">{item.name}</p>
                  <p className="text-[11px] font-mono text-gray-400 dark:text-slate-500">{item.sku}</p>
                  <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">{item.category}</p>
                </div>
                <span className={`shrink-0 text-xl font-black ${item.quantity === 0 ? 'text-rose-600 dark:text-rose-400' : 'text-orange-500 dark:text-orange-400'}`}>
                  {item.quantity}
                </span>
              </div>
              <div className="mt-2 h-1.5 bg-gray-100 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className={`h-full ${item.quantity === 0 ? 'bg-rose-500' : 'bg-orange-400'}`}
                  style={{ width: `${Math.min(100, (Number(item.quantity) / Math.max(1, item.low_stock_threshold)) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">threshold {item.low_stock_threshold}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DeadStockCard({ data, loading, deadDays, setDeadDays, onJumpToItem }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      <div className="p-6 pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
            <TrendingDown size={20} className="mr-2 text-orange-500 dark:text-orange-400" /> Dead Stock
          </h3>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">Items with no sale in the selected window — trapped capital, not just low counts.</p>
        </div>
        <div className="flex bg-gray-100 dark:bg-slate-700 rounded-xl p-1 self-start">
          {DEAD_STOCK_WINDOWS.map((d) => (
            <button
              key={d}
              onClick={() => setDeadDays(d)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                deadDays === d ? 'bg-white dark:bg-slate-800 shadow text-blue-700 dark:text-blue-300' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-100'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/60 dark:bg-slate-950/60">
            <tr>
              <th className="px-6 py-3 font-medium">Item</th>
              <th className="px-6 py-3 font-medium">Category</th>
              <th className="px-6 py-3 font-medium text-center">Qty sitting</th>
              <th className="px-6 py-3 font-medium">Days without a sale</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
            {loading ? (
              <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-400 dark:text-slate-500">Analyzing sales history…</td></tr>
            ) : data.deadStock.length === 0 ? (
              <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-400 dark:text-slate-500">Nothing idle for {deadDays}+ days — stock is moving.</td></tr>
            ) : data.deadStock.map((item) => (
              <tr key={item.id} className="hover:bg-gray-50/70 dark:hover:bg-slate-700/70 hover:dark:bg-slate-950/70 transition-colors">
                <td className="px-6 py-3">
                  <span className="font-semibold text-gray-900 dark:text-slate-100">{item.name}</span>
                  <span className="block text-[11px] font-mono text-gray-400 dark:text-slate-500">{item.sku}</span>
                </td>
                <td className="px-6 py-3 text-gray-600 dark:text-slate-400">{item.category}</td>
                <td className="px-6 py-3 text-center font-bold">{item.quantity}</td>
                <td className="px-6 py-3">
                  <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-bold ${
                    item.days_in_stock > 90 ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300'
                      : item.days_in_stock > 60 ? 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300'
                      : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300'
                  }`}>
                    {item.days_in_stock >= 9999 ? 'never sold' : `${item.days_in_stock} days`}
                  </span>
                </td>
                <td className="px-6 py-3 text-right">
                  <button onClick={() => onJumpToItem(item)} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 text-xs font-semibold bg-blue-50 dark:bg-blue-500/10 px-3 py-1.5 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors">
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}