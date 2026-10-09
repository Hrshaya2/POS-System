// Section 4: item detail view with inline movement history
// (info + actions: adjust / edit / print label + movement ledger).
import React, { useEffect, useState } from 'react';
import { X, Wrench, Pencil, Barcode as BarcodeIcon } from 'lucide-react';
import MovementBadge, { formatQtyChange } from './MovementBadge';
import BarcodePreview from './BarcodePreview';
import { getMovements } from '../../services/stockService';

const COLOR_MAP = {
  blue: '#3b82f6', green: '#10b981', red: '#f43f5e', purple: '#a855f7',
  orange: '#f97316', teal: '#14b8a6', pink: '#ec4899', gray: '#6b7280'
};
const colorStyle = (tag) => ({ backgroundColor: COLOR_MAP[tag] || '#9ca3af' });
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const fmtMoney = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString());

export default function ItemDetailModal({ item, isAdmin, onClose, onAdjust, onEdit, onPrintLabel }) {
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMovements({ itemId: item.id }, { refresh: true })
      .then((rows) => { if (!cancelled) setMovements(rows); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [item.id]);

  const rows = typeFilter ? movements.filter((m) => m.type === typeFilter) : movements;
  const isService = !!item.is_service;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex justify-between items-start px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center">
              {item.color_tag && <span className="inline-block w-3 h-3 rounded-full mr-2" style={colorStyle(item.color_tag)} />}
              {item.name}
              {isService && <span className="ml-2 text-[10px] font-bold uppercase bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded">Service</span>}
            </h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 font-mono">{item.sku}{item.barcodes?.length ? ` · +${item.barcodes.length} barcode(s)` : ''}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 hover:dark:bg-slate-800 rounded-lg transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          <InfoGrid item={item} isAdmin={isAdmin} isService={isService} />

          {(item.imei || item.condition_grade || item.battery_health || item.warranty_months) && (
            <div className="bg-indigo-50/50 border border-indigo-100 dark:border-indigo-500/20 rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {item.imei && <InfoTile small label="IMEI" value={item.imei} />}
              {item.condition_grade && <InfoTile small label="Condition" value={item.condition_grade} />}
              {!!item.battery_health && <InfoTile small label="Battery" value={`${item.battery_health}%`} />}
              {!!item.warranty_months && <InfoTile small label="Warranty" value={`${item.warranty_months} mo`} />}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {!isService && (
              <button onClick={() => onAdjust(item)} className="flex items-center space-x-1.5 px-4 py-2 bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/30 text-orange-700 dark:text-orange-300 rounded-xl text-sm font-semibold hover:bg-orange-100 dark:hover:bg-orange-500/20 transition-colors">
                <Wrench size={15} /> Adjust Stock
              </button>
            )}
            {isAdmin && (
              <button onClick={() => onEdit(item)} className="flex items-center space-x-1.5 px-4 py-2 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-300 rounded-xl text-sm font-semibold hover:bg-blue-100 dark:hover:bg-blue-500/20 transition-colors">
                <Pencil size={15} /> Edit Details
              </button>
            )}
            <button onClick={() => onPrintLabel(item)} className="flex items-center space-x-1.5 px-4 py-2 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-300 rounded-xl text-sm font-semibold hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors">
              <BarcodeIcon size={15} /> Print Label
            </button>
          </div>

          <BarcodePreview code={item.sku} height={44} />

          <HistoryList movements={rows} loading={loading} typeFilter={typeFilter} setTypeFilter={setTypeFilter} />
        </div>
      </div>
    </div>
  );
}

function InfoTile({ label, value, strong = false, small = false }) {
  return (
    <div className="bg-gray-50 dark:bg-slate-950 rounded-xl px-3 py-2 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-slate-500 font-semibold">{label}</p>
      <p className={`${small ? 'text-xs' : 'text-sm'} ${strong ? 'font-bold text-gray-900 dark:text-slate-100' : 'text-gray-700 dark:text-slate-300'} truncate`}>{value}</p>
    </div>
  );
}

function InfoGrid({ item, isAdmin, isService }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <InfoTile label="Category" value={item.category} />
      {!isService ? (
        <>
          <InfoTile label="In stock" value={Number(item.quantity).toLocaleString()} strong />
          <InfoTile label="Low threshold" value={item.low_stock_threshold ?? 5} />
        </>
      ) : (
        <InfoTile label="Tracking" value="Not tracked (service)" />
      )}
      <InfoTile label="Sell price" value={`Rs. ${fmtMoney(item.sell_price)}`} strong />
      {isAdmin && <InfoTile label="Cost" value={`Rs. ${fmtMoney(item.cost_price)}`} />}
      {isAdmin && Number(item.tax_rate) > 0 && <InfoTile label="Tax" value={`${item.tax_rate}%`} />}
    </div>
  );
}

function HistoryList({ movements, loading, typeFilter, setTypeFilter }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-2">
        <h4 className="font-bold text-gray-900 dark:text-slate-100 text-sm">Stock History</h4>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="text-xs border border-gray-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 px-2 py-1.5 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500/60"
        >
          <option value="">All types</option>
          <option value="STOCK_IN">Stock In</option>
          <option value="SALE">Sale</option>
          <option value="REFUND">Refund</option>
          <option value="ADJUSTMENT">Adjustment</option>
          <option value="STOCK_TAKE">Stock Take</option>
          <option value="IMPORT">Import</option>
        </select>
      </div>

      <div className="border border-gray-100 dark:border-slate-800 rounded-xl divide-y divide-gray-50 dark:divide-slate-800 max-h-72 overflow-y-auto">
        {loading ? (
          <p className="text-sm text-gray-400 dark:text-slate-500 p-4">Loading history…</p>
        ) : movements.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-slate-500 p-4">No movements recorded yet for this item.</p>
        ) : movements.map((m) => (
          <div key={m.local_key || m.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-50/60 dark:hover:bg-slate-700/60 hover:dark:bg-slate-950/60">
            <div className="min-w-0">
              <MovementBadge type={m.type} />
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 truncate">
                {m.note || m.reason}
                {m.reference ? ` · ${m.reference}` : ''}
              </p>
            </div>
            <div className="text-right shrink-0 ml-3">
              {formatQtyChange(m)}
              <p className="text-[10px] text-gray-400 dark:text-slate-500">{fmtDate(m.created_at)}</p>
              <p className="text-[10px] text-gray-500 dark:text-slate-400">{m.user_name}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}