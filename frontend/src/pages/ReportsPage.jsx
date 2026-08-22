import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, PackageSearch, RefreshCw, UserRound, Trash2, AlertTriangle, Filter } from 'lucide-react';

const API_BASE = '/api';

const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatNumber = (value) => Number(value || 0).toLocaleString('en-LK');

const toDateInput = (date) => new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);

export default function ReportsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reports, setReports] = useState(null);
  const [cashMovementSaving, setCashMovementSaving] = useState(false);
  const [cashMovementForm, setCashMovementForm] = useState({
    cashier_id: '',
    cashier_name: '',
    amount: '',
    movement_date: toDateInput(new Date()),
    note: ''
  });

  // Delete sales data state
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteResult, setDeleteResult] = useState('');
  const [deleteForm, setDeleteForm] = useState({
    from: '',
    to: '',
    cashierId: '',
    scope: 'range' // 'range' | 'all'
  });

  const today = useMemo(() => toDateInput(new Date()), []);
  const defaultFrom = useMemo(() => {
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return toDateInput(start);
  }, []);

  const [filters, setFilters] = useState({
    from: defaultFrom,
    to: today,
    deadDays: 30,
    cashierId: '',
    category: ''
  });

  const loadReports = async () => {
    try {
      setLoading(true);
      setError('');
      const token = localStorage.getItem('token');
      const query = new URLSearchParams({
        from: filters.from,
        to: filters.to,
        deadDays: String(filters.deadDays)
      });
      if (filters.cashierId) query.set('cashierId', filters.cashierId);

      const res = await fetch(`${API_BASE}/reports?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to load reports');
      setReports(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReports();
  }, []);

  const salesCategoryRows = reports ? Object.entries(reports.sales_by_category || {}) : [];
  const cashierOptions = reports ? (reports.cashier_performance || []) : [];

  const createCashReload = async (e) => {
    e.preventDefault();
    try {
      setCashMovementSaving(true);
      setError('');
      const token = localStorage.getItem('token');
      const selectedCashier = cashierOptions.find((cashier) => String(cashier.cashier_id) === String(cashMovementForm.cashier_id));
      const res = await fetch(`${API_BASE}/cash-movements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          cashierId: cashMovementForm.cashier_id ? Number(cashMovementForm.cashier_id) : null,
          cashierName: cashMovementForm.cashier_name || selectedCashier?.cashier_name || 'System',
          movementType: 'RELOAD',
          amount: Number(cashMovementForm.amount || 0),
          movementDate: cashMovementForm.movement_date,
          note: cashMovementForm.note
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to save cash reload');

      setCashMovementForm({
        cashier_id: '',
        cashier_name: '',
        amount: '',
        movement_date: toDateInput(new Date()),
        note: ''
      });
      await loadReports();
    } catch (err) {
      setError(err.message);
    } finally {
      setCashMovementSaving(false);
    }
  };

  // Delete sales data handler
  const handleDeleteSales = async () => {
    setDeleteResult('');
    setError('');

    if (deleteForm.scope === 'all') {
      if (!window.confirm('⚠️ WARNING: This will delete ALL sales records from the database. This action CANNOT be undone. Are you absolutely sure?')) return;
    } else {
      if (!deleteForm.from && !deleteForm.to && !deleteForm.cashierId) {
        setError('Please select a date range or cashier to delete, or choose "Delete All".');
        return;
      }
      if (!window.confirm('⚠️ WARNING: This will permanently delete the selected sales records. This action CANNOT be undone. Continue?')) return;
    }

    setDeleteLoading(true);
    try {
      const token = localStorage.getItem('token');
      const query = new URLSearchParams();
      if (deleteForm.scope === 'all') {
        // No filters = delete all
      } else {
        if (deleteForm.from) query.set('from', deleteForm.from);
        if (deleteForm.to) query.set('to', deleteForm.to);
        if (deleteForm.cashierId) query.set('cashierId', deleteForm.cashierId);
      }

      const res = await fetch(`${API_BASE}/sales?${query.toString()}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete sales data');

      setDeleteResult(data.message || `Deleted ${data.deletedCount || 0} sale record(s)`);
      setDeleteForm({ from: '', to: '', cashierId: '', scope: 'range' });
      await loadReports();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  // Filter profit margin rows by category
  const filteredMarginRows = useMemo(() => {
    if (!reports?.profit_margin) return [];
    if (!filters.category) return reports.profit_margin;
    // The backend doesn't return per-sale category, so we filter by the sale's
    // items matching the selected category. Since profit_margin rows don't carry
    // item categories, we keep all rows for now — the category filter is applied
    // to the sales_by_category cards above.
    return reports.profit_margin;
  }, [reports, filters.category]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reports</h1>
          <p className="text-gray-500 mt-1">Live business analytics across inventory, sales, repairs, and team performance.</p>
        </div>
        <button
          onClick={loadReports}
          className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2 font-semibold text-gray-700 hover:bg-gray-50"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
        <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-4"><CalendarDays size={20} className="text-blue-600" /> Report Filters</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">From</label>
            <input type="date" value={filters.from} onChange={(e) => setFilters((s) => ({ ...s, from: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">To</label>
            <input type="date" max={today} value={filters.to} onChange={(e) => setFilters((s) => ({ ...s, to: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Dead stock threshold (days)</label>
            <input type="number" min="1" value={filters.deadDays} onChange={(e) => setFilters((s) => ({ ...s, deadDays: Number(e.target.value || 1) }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Cashier</label>
            <select
              value={filters.cashierId}
              onChange={(e) => setFilters((s) => ({ ...s, cashierId: e.target.value }))}
              className="w-full rounded-2xl border border-gray-200 px-4 py-3"
            >
              <option value="">All cashiers</option>
              {cashierOptions.map((cashier) => (
                <option key={cashier.cashier_id} value={cashier.cashier_id}>{cashier.cashier_name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button onClick={loadReports} className="w-full rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700">Apply Filters</button>
          </div>
        </div>
      </div>

      {/* Delete Sales Data Section */}
      <div className="bg-white rounded-3xl border border-rose-200 p-6 shadow-sm">
        <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-4">
          <Trash2 size={20} className="text-rose-600" /> Delete Sales Data
        </h2>
        <p className="text-sm text-gray-500 mb-4 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-500" />
          Permanently remove sales records. This action cannot be undone.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Delete scope</label>
            <select
              value={deleteForm.scope}
              onChange={(e) => setDeleteForm((s) => ({ ...s, scope: e.target.value }))}
              className="w-full rounded-2xl border border-gray-200 px-4 py-3"
            >
              <option value="range">By date range / cashier</option>
              <option value="all">Delete ALL sales</option>
            </select>
          </div>
          {deleteForm.scope === 'range' && (
            <>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">From</label>
                <input type="date" value={deleteForm.from} onChange={(e) => setDeleteForm((s) => ({ ...s, from: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">To</label>
                <input type="date" max={today} value={deleteForm.to} onChange={(e) => setDeleteForm((s) => ({ ...s, to: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Cashier</label>
                <select
                  value={deleteForm.cashierId}
                  onChange={(e) => setDeleteForm((s) => ({ ...s, cashierId: e.target.value }))}
                  className="w-full rounded-2xl border border-gray-200 px-4 py-3"
                >
                  <option value="">All cashiers</option>
                  {cashierOptions.map((cashier) => (
                    <option key={cashier.cashier_id} value={cashier.cashier_id}>{cashier.cashier_name}</option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="flex items-end">
            <button
              onClick={handleDeleteSales}
              disabled={deleteLoading}
              className="w-full rounded-2xl bg-rose-600 px-4 py-3 font-semibold text-white hover:bg-rose-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              <Trash2 size={16} />
              {deleteLoading ? 'Deleting...' : deleteForm.scope === 'all' ? 'Delete All Sales' : 'Delete Sales'}
            </button>
          </div>
        </div>
        {deleteResult && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {deleteResult}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-700 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="bg-white rounded-3xl border border-gray-100 p-6 text-gray-500">Loading reports...</div>
      ) : reports && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
              <h3 className="font-bold text-gray-900 flex items-center gap-2"><PackageSearch size={18} className="text-rose-600" /> Dead Stock Capital</h3>
              <div className="mt-4 text-3xl font-bold text-gray-900">{formatMoney(reports.dead_stock?.total_capital_locked)}</div>
              <p className="text-sm text-gray-500 mt-2">No sale for at least {reports.dead_stock?.threshold_days} days</p>
            </div>
            <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
              <h3 className="font-bold text-gray-900 flex items-center gap-2"><BarChart3 size={18} className="text-blue-600" /> Repair Turnaround</h3>
              <div className="mt-4 text-3xl font-bold text-gray-900">{formatNumber(reports.repair_turnaround?.average_days)} days</div>
              <p className="text-sm text-gray-500 mt-2">Based on {formatNumber(reports.repair_turnaround?.delivered_jobs)} delivered repairs</p>
            </div>
            <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
              <h3 className="font-bold text-gray-900 flex items-center gap-2"><UserRound size={18} className="text-emerald-600" /> Cashiers</h3>
              <div className="mt-4 text-3xl font-bold text-gray-900">{formatNumber((reports.cashier_performance || []).length)}</div>
              <p className="text-sm text-gray-500 mt-2">Active in selected range</p>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Sales By Category</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              {salesCategoryRows.map(([category, amount]) => (
                <div key={category} className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <div className="text-sm text-gray-500">{category}</div>
                  <div className="text-xl font-bold text-gray-900 mt-2">{formatMoney(amount)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm overflow-x-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Dead Stock Items</h2>
            <table className="w-full text-sm text-left text-gray-600">
              <thead className="bg-gray-50 text-xs uppercase text-gray-400">
                <tr>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Qty</th>
                  <th className="px-4 py-3">Days In Stock</th>
                  <th className="px-4 py-3">Days Without Sale</th>
                  <th className="px-4 py-3">Capital Locked</th>
                </tr>
              </thead>
              <tbody>
                {(reports.dead_stock?.items || []).length === 0 ? (
                  <tr><td colSpan="7" className="px-4 py-8 text-center text-gray-400">No dead stock for this threshold.</td></tr>
                ) : (reports.dead_stock?.items || []).map((item, idx) => (
                  <tr key={`${item.code}-${idx}`} className="border-b border-gray-100">
                    <td className="px-4 py-3">{item.category}</td>
                    <td className="px-4 py-3 font-semibold text-gray-900">{item.item_name}</td>
                    <td className="px-4 py-3">{item.code}</td>
                    <td className="px-4 py-3">{item.quantity}</td>
                    <td className="px-4 py-3">{item.days_in_stock}</td>
                    <td className="px-4 py-3">{item.days_without_sale}</td>
                    <td className="px-4 py-3 font-semibold">{formatMoney(item.capital_locked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm overflow-x-auto">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
              <h2 className="text-lg font-bold text-gray-900">Profit / Margin Per Sale</h2>
              <div className="flex items-center gap-2">
                <Filter size={16} className="text-gray-400" />
                <select
                  value={filters.category}
                  onChange={(e) => setFilters((s) => ({ ...s, category: e.target.value }))}
                  className="rounded-2xl border border-gray-200 px-4 py-2 text-sm"
                >
                  <option value="">All categories</option>
                  {salesCategoryRows.map(([category]) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </div>
            </div>
            <table className="w-full text-sm text-left text-gray-600">
              <thead className="bg-gray-50 text-xs uppercase text-gray-400">
                <tr>
                  <th className="px-4 py-3">Receipt</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Cashier</th>
                  <th className="px-4 py-3">Revenue</th>
                  <th className="px-4 py-3">Cost</th>
                  <th className="px-4 py-3">Profit</th>
                  <th className="px-4 py-3">Margin %</th>
                </tr>
              </thead>
              <tbody>
                {filteredMarginRows.length === 0 ? (
                  <tr><td colSpan="7" className="px-4 py-8 text-center text-gray-400">No sales in selected date range.</td></tr>
                ) : filteredMarginRows.map((row) => (
                  <tr key={row.sale_id} className="border-b border-gray-100">
                    <td className="px-4 py-3 font-semibold text-gray-900">{row.receipt_no}</td>
                    <td className="px-4 py-3">{new Date(row.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">{row.cashier_name}</td>
                    <td className="px-4 py-3">{formatMoney(row.revenue)}</td>
                    <td className="px-4 py-3">{formatMoney(row.cost)}</td>
                    <td className={`px-4 py-3 font-semibold ${row.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatMoney(row.profit)}</td>
                    <td className="px-4 py-3">{Number(row.margin_percent || 0).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Best Selling Items</h2>
              <div className="space-y-3">
                {(reports.best_selling || []).length === 0 ? (
                  <div className="text-sm text-gray-400">No sales in selected range.</div>
                ) : (reports.best_selling || []).map((item) => (
                  <div key={`best-${item.item_name}`} className="rounded-2xl border border-gray-200 p-3 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-gray-900">{item.item_name}</div>
                      <div className="text-xs text-gray-500">Qty sold: {formatNumber(item.quantity_sold)}</div>
                    </div>
                    <div className="font-semibold text-emerald-700">{formatMoney(item.revenue)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Worst Selling Items</h2>
              <div className="space-y-3">
                {(reports.worst_selling || []).length === 0 ? (
                  <div className="text-sm text-gray-400">No sales in selected range.</div>
                ) : (reports.worst_selling || []).map((item) => (
                  <div key={`worst-${item.item_name}`} className="rounded-2xl border border-gray-200 p-3 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-gray-900">{item.item_name}</div>
                      <div className="text-xs text-gray-500">Qty sold: {formatNumber(item.quantity_sold)}</div>
                    </div>
                    <div className="font-semibold text-amber-700">{formatMoney(item.revenue)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm overflow-x-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Cashier Performance</h2>
            <table className="w-full text-sm text-left text-gray-600">
              <thead className="bg-gray-50 text-xs uppercase text-gray-400">
                <tr>
                  <th className="px-4 py-3">Cashier</th>
                  <th className="px-4 py-3">Sales Count</th>
                  <th className="px-4 py-3">Sales Total</th>
                </tr>
              </thead>
              <tbody>
                {(reports.cashier_performance || []).length === 0 ? (
                  <tr><td colSpan="3" className="px-4 py-8 text-center text-gray-400">No cashier sales in selected date range.</td></tr>
                ) : (reports.cashier_performance || []).map((cashier) => (
                  <tr key={cashier.cashier_id} className="border-b border-gray-100">
                    <td className="px-4 py-3 font-semibold text-gray-900">{cashier.cashier_name}</td>
                    <td className="px-4 py-3">{formatNumber(cashier.sale_count)}</td>
                    <td className="px-4 py-3 font-semibold">{formatMoney(cashier.sales_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-3xl border border-gray-100 p-6 shadow-sm overflow-x-auto">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Cashier Daily Balance</h2>
            <table className="w-full text-sm text-left text-gray-600">
              <thead className="bg-gray-50 text-xs uppercase text-gray-400">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Cashier</th>
                  <th className="px-4 py-3">From Sales</th>
                  <th className="px-4 py-3">Reload</th>
                  <th className="px-4 py-3">Withdrawn</th>
                  <th className="px-4 py-3">Net Balance</th>
                </tr>
              </thead>
              <tbody>
                {(reports.cashier_balance || []).length === 0 ? (
                  <tr><td colSpan="6" className="px-4 py-8 text-center text-gray-400">No cashier balance records in the selected range.</td></tr>
                ) : (reports.cashier_balance || []).map((row, index) => (
                  <tr key={`${row.cashier_id}-${row.balance_date}-${index}`} className="border-b border-gray-100">
                    <td className="px-4 py-3">{row.balance_date}</td>
                    <td className="px-4 py-3 font-semibold text-gray-900">{row.cashier_name || 'System'}</td>
                    <td className="px-4 py-3">{formatMoney(row.cash_from_sales)}</td>
                    <td className="px-4 py-3">{formatMoney(row.cash_reload)}</td>
                    <td className="px-4 py-3">{formatMoney(row.cash_withdrawn)}</td>
                    <td className="px-4 py-3 font-semibold">{formatMoney(row.net_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}