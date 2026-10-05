import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, PackageSearch, Receipt, Landmark, BadgeDollarSign, ClipboardList, FileSpreadsheet, FileText, Clock, TrendingUp, TrendingDown, Users, History, ShieldAlert } from 'lucide-react';
import { useSync } from '../context/SyncContext';
import { useAuth } from '../context/AuthContext';
import ReportTable, { PaginationControls } from '../components/Reports/ReportTable';
import ReportFilterBar, { SummaryTile } from '../components/Reports/ReportFilterBar';
import { exportToExcelWithTotals, exportToPdf } from '../utils/reportExport';
import { buildRefundReceiptHtml, getReceiptSettings } from '../utils/receipt';

const API = '/api';
const L = 50;
const fmt = (v) => `Rs. ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (v) => Number(v || 0).toLocaleString('en-LK');
const H = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });
const Q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, v])).toString();

const REPORTS = [
  { id: 'daily', label: 'Daily Sales', icon: CalendarDays },
  { id: 'profit', label: 'Profit & Margin', icon: TrendingUp },
  { id: 'payments', label: 'Payment Type', icon: Landmark },
  { id: 'refunds', label: 'Refunds', icon: Receipt },
  { id: 'credit', label: 'Credit / Unpaid', icon: BadgeDollarSign },
  { id: 'purchases', label: 'Purchases', icon: PackageSearch },
  { id: 'performance', label: 'Product Performance', icon: TrendingUp },
  { id: 'activity', label: 'User Activity', icon: History }
];

const txnCols = [
  { key: 'date', label: 'Date' }, { key: 'receipt_no', label: 'Receipt' },
  { key: 'cashier_name', label: 'Cashier' }, { key: 'payment_method', label: 'Payment' },
  { key: 'total', label: 'Total', type: 'money', align: 'right' }, { key: 'discount_amount', label: 'Discount', type: 'money', align: 'right' },
  { key: 'refunded', label: 'Refunded', align: 'center', render: (r) => (r.refunded ? 'Yes' : 'No') }
];
const refCols = [
  { key: 'date', label: 'Date', render: (r) => String(r.created_at || r.movement_date || '').slice(0, 10) }, { key: 'refund_reference', label: 'Refund #' }, { key: 'sale_receipt_no', label: 'Receipt' },
  { key: 'items', label: 'Items', render: (r) => `${(r.items || []).length} item(s)` }, { key: 'reason', label: 'Reason' },
  { key: 'initiated_by', label: 'By' }, { key: 'refund_method', label: 'Method' }, { key: 'approval_status', label: 'Status' },
  { key: 'total', label: 'Amount', type: 'money', align: 'right' }
];
const actCols = [
  { key: 'date', label: 'Date' }, { key: 'user_name', label: 'User' }, { key: 'action', label: 'Action' },
  { key: 'type', label: 'Type' }, { key: 'amount', label: 'Amount', type: 'money', align: 'right' }, { key: 'note', label: 'Note' }
];

function Xls({ rows, cols, totals, name }) { return <button onClick={() => exportToExcelWithTotals(rows, name, cols, totals)} className="ml-auto mb-3 flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button>; }
function Pdf({ cols, rows, name, totals }) { return <button onClick={() => exportToPdf(cols, rows, name, totals)} className="ml-auto mb-3 flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-sm font-medium"><FileText size={16} />PDF</button>; }
function TableBox({ cols, rows, total, page, limit, onPage, loading, noData, name, totals }) {
  return (<div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
    <div className="flex justify-end p-3"><Xls rows={rows} cols={cols} totals={totals} name={name} /><Pdf cols={cols} rows={rows} name={name} totals={totals} /></div>
    <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
      <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr>{cols.map((c) => <th key={c.key} className={`px-4 py-3 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'}`}>{c.label}</th>)}</tr></thead>
      <ReportTable columns={cols} rows={rows} total={total} page={page} limit={limit} onPage={onPage} loading={loading} noDataText={noData} />
    </table>
    <PaginationControls page={page} limit={limit} total={total} onPage={onPage} />
  </div>);
}

const fmtM = (v) => `Rs. ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Admin-only queue: refunds started by cashiers above the policy limits wait
// here until an admin / shop owner completes them with the approval PIN.
function PendingRefundApprovals({ onChanged }) {
  const [rows, setRows] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const d = await fetch(`${API}/refunds?status=PENDING&limit=50`, { headers: H() }).then((x) => x.json());
      setRows(Array.isArray(d.refunds) ? d.refunds : []);
    } catch (e) { setErr('Could not load pending refunds.'); setRows([]); }
  };
  useEffect(() => { load(); }, []);

  const act = async (row, action) => {
    let body = {};
    if (action === 'approve') {
      const pin = window.prompt(`Admin approval PIN for ${row.refund_reference} (-${fmtM(row.total)}):`);
      if (pin === null) return;
      if (!pin.trim()) { alert('The approval PIN is required.'); return; }
      body = { approver_pin: pin.trim() };
    } else {
      const reason = window.prompt(`Reject ${row.refund_reference}? Optional reason:`);
      if (reason === null) return;
      body = { reason };
    }
    setBusyId(row.id);
    try {
      const res = await fetch(`${API}/refunds/${row.id}/${action}`, { method: 'POST', headers: H(), body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `${action} failed`);
      await load();
      onChanged && onChanged();
      alert(action === 'approve'
        ? `Approved. Stock restored and the cash session updated.\n${row.refund_reference}: -${fmtM(row.total)}`
        : `Rejected ${row.refund_reference}. No changes were applied.`);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId('');
    }
  };

  if (rows === null) return <div className="text-sm text-gray-400 dark:text-slate-500">Loading approvals…</div>;
  if (err) return <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-4 py-2.5 text-sm text-rose-700 dark:text-rose-300">{err}</div>;
  if (rows.length === 0) return null;

  return (
    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-2xl p-4 space-y-3">
      <h3 className="font-bold text-amber-900 dark:text-amber-100 flex items-center gap-2 text-sm"><ShieldAlert size={16} /> Pending refund approvals ({rows.length})</h3>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="bg-white dark:bg-slate-800 rounded-xl border border-amber-100 dark:border-amber-500/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 dark:text-slate-100 text-sm truncate">-{fmtM(row.total)} · {(row.items || []).length} item(s) · {row.reason}</div>
              <div className="text-xs text-gray-400 dark:text-slate-500 truncate">
                Refund {row.refund_reference} of {row.sale_receipt_no} · initiated by {row.initiated_by || '—'} · {String(row.created_at || '').slice(0, 10)}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button disabled={busyId === row.id} onClick={() => act(row, 'approve')}
                className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-bold">Approve (PIN)</button>
              <button disabled={busyId === row.id} onClick={() => act(row, 'reject')}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 text-xs font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950 disabled:opacity-60">Reject</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const { status } = useSync();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';
  const [active, setActive] = useState('daily');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null);
  const [txn, setTxn] = useState({ rows: [], total: 0, page: 1, loading: false });
  const [ref, setRef] = useState({ rows: [], total: 0, page: 1 });
  const [act, setAct] = useState({ rows: [], total: 0, page: 1 });

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defFrom = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }, []);
  const [filters, setFilters] = useState({ from: defFrom, to: today, preset: 'month', cashierId: '', category: '', customerPhone: '', supplier: '' });

  const q = () => Q({ from: filters.from, to: filters.to, deadDays: '30', cashierId: filters.cashierId, category: filters.category });
  const load = async () => {
    try { setLoading(true); setError(''); const r = await fetch(`${API}/reports?${q()}`, { headers: H() }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Unable to load reports'); setReport(d); }
    catch (e) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filters]);

  const loadPage = async (url, setter, page) => {
    setter((s) => ({ ...s, loading: true }));
    try {
      const u = new URLSearchParams({ from: filters.from, to: filters.to, page, limit: L }).toString();
      const r = await fetch(`${API}${url}?${u}`, { headers: H() }); const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      const key = url.includes('activity') ? 'activity' : url.includes('refunds') ? 'refunds' : 'transactions';
      setter({ rows: d[key] || d.transactions || d.refunds || d.activity || [], total: d.total || 0, page: Number(page), loading: false });
    } catch (e) { setError(e.message); setter((s) => ({ ...s, loading: false })); }
  };
  useEffect(() => {
    if (active === 'daily') loadPage('/reports/transactions', setTxn, 1);
    if (active === 'refunds') loadPage('/reports/refunds', setRef, 1);
    if (active === 'activity') loadPage('/reports/user-activity', setAct, 1);
  }, [active, filters]);

  const stale = !status.isOnline || status.isSyncing || (status.pendingCounts && status.pendingCounts.total > 0) || !status.lastSyncAt;
  const r = report || {};
  const pb = r.payment_breakdown || { cash: 0, card: 0, bank_transfer: 0, split: 0 };
  const sales = (pb.cash || 0) + (pb.card || 0) + (pb.bank_transfer || 0) + (pb.split || 0);
  const pm = r.profit_margin || [];
  const rev = pm.reduce((s, x) => s + Number(x.revenue || 0), 0);
  const cost = pm.reduce((s, x) => s + Number(x.cost || 0), 0);
  const profit = rev - cost;
  const refundList = r.refunds || [];

  return (<div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><BarChart3 size={24} /> Reports</h1>
        <p className="text-sm text-gray-500 dark:text-slate-400">Admin &amp; shop owner reporting. Filters apply across every tab.</p></div>
      {stale && (<div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl px-3 py-1.5 flex items-center gap-2"><Clock size={14} /><span>Data may be stale — {status.isSyncing ? 'syncing…' : status.lastSyncAt ? `last sync ${new Date(status.lastSyncAt).toLocaleTimeString()}` : 'not yet synced'}.</span></div>)}
    </div>
        <div className="flex gap-2 flex-wrap">{REPORTS.map((rep) => { const Icon = rep.icon; return (<button key={rep.id} onClick={() => setActive(rep.id)} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition ${active === rep.id ? 'bg-blue-600 text-white shadow' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}><Icon size={16} /> {rep.label}</button>); })}</div>

    <ReportFilterBar filters={filters} setFilters={setFilters} extras={[
      { key: 'cashier', render: (f, set) => ['daily','profit','payments','refunds','activity'].includes(active) && (<input type="text" placeholder="Cashier id" value={f.cashierId || ''} onChange={(e) => set((p) => ({ ...p, cashierId: e.target.value }))} className="px-3 py-2 border rounded-lg text-sm w-36" />) },
      { key: 'category', render: (f, set) => ['profit','purchases'].includes(active) && (<input type="text" placeholder="Category" value={f.category || ''} onChange={(e) => set((p) => ({ ...p, category: e.target.value }))} className="px-3 py-2 border rounded-lg text-sm w-36" />) },
      { key: 'customer', render: (f, set) => active === 'credit' && (<input type="text" placeholder="Customer phone" value={f.customerPhone || ''} onChange={(e) => set((p) => ({ ...p, customerPhone: e.target.value }))} className="px-3 py-2 border rounded-lg text-sm w-36" />) },
      { key: 'supplier', render: (f, set) => active === 'purchases' && (<input type="text" placeholder="Supplier" value={f.supplier || ''} onChange={(e) => set((p) => ({ ...p, supplier: e.target.value }))} className="px-3 py-2 border rounded-lg text-sm w-36" />) }
    ]} />

    {loading && <div className="text-center py-10 text-gray-400 dark:text-slate-500">Loading report…</div>}
    {error && <div className="text-rose-600 dark:text-rose-400 text-center py-6">{error}</div>}
    {!loading && !error && (
      <>
        {active === 'daily' && (<div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <SummaryTile label="Total Sales" value={sales} icon={BadgeDollarSign} />
            <SummaryTile label="Cash" value={pb.cash} icon={Landmark} />
            <SummaryTile label="Card" value={pb.card} icon={Landmark} />
            <SummaryTile label="Bank Transfer" value={pb.bank_transfer} icon={Landmark} />
            <SummaryTile label="Split" value={pb.split} icon={Landmark} />
          </div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100">Transactions</h2>
          <TableBox cols={txnCols} rows={txn.rows} total={txn.total} page={txn.page} limit={L} onPage={(p) => loadPage('/reports/transactions', setTxn, p)} loading={txn.loading} noData="No sales in the selected date range." name="Daily Sales Transactions" totals={{ total: sales }} />
          <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 mt-6">Daily Breakdown</h2>
          <DailyBreakdown daily={r.daily_sales || []} />
        </div>)}

        {active === 'profit' && (<div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryTile label="Revenue" value={rev} icon={TrendingUp} />
            <SummaryTile label="Cost" value={cost} icon={PackageSearch} />
            <SummaryTile label="Profit" value={profit} icon={BadgeDollarSign} />
            <SummaryTile label="Margin %" value={rev ? (profit / rev) * 100 : 0} valueType="number" icon={TrendingUp} />
          </div>
          <ProfitMargin pm={pm} rev={rev} cost={cost} />
        </div>)}

        {active === 'payments' && (<PaymentType pb={pb} total={sales} />)}

        {active === 'refunds' && (<div className="space-y-4">
          {isAdmin && <PendingRefundApprovals onChanged={() => { load(); loadPage('/reports/refunds', setRef, ref.page || 1); }} />}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryTile label="Total Refunded" value={r.total_refunds} icon={Receipt} />
            <SummaryTile label="Count" value={ref.rows.length} valueType="number" icon={Receipt} />
            <SummaryTile label="Approved" value={refundList.filter(x => x.approval_status === 'APPROVED' || x.approval_status === 'DIRECT').length} valueType="number" icon={Receipt} />
            <SummaryTile label="Pending" value={refundList.filter(x => x.approval_status === 'PENDING').length} valueType="number" icon={Clock} />
          </div>
          <TableBox cols={refCols} rows={ref.rows} total={ref.total} page={ref.page} limit={L} onPage={(p) => loadPage('/reports/refunds', setRef, p)} loading={false} noData="No refunds in the selected range." name="Refunds Report" totals={{ total: r.total_refunds }} />
          {ref.rows.find((x) => x.approval_status === 'APPROVED' || x.approval_status === 'DIRECT') && (<button onClick={async () => { const rr = ref.rows.find((x) => x.approval_status === 'APPROVED' || x.approval_status === 'DIRECT'); const html = buildRefundReceiptHtml(rr, getReceiptSettings()); const w = window.open(''); w.document.write(html); w.document.close(); setTimeout(() => w.print(), 200); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium"><Receipt size={16} />Print refund receipt</button>)}
        </div>)}

        {active === 'credit' && (<Credit credits={r.credit_notes || []} outstanding={r.total_credit_outstanding} />)}
        {active === 'purchases' && (<Purchases p={r.purchases || []} ss={r.supplier_spend || []} sup={filters.supplier} />)}
        {active === 'performance' && (<Performance best={r.best_selling || []} worst={r.worst_selling || []} dead={r.dead_stock} />)}

        {active === 'activity' && (<div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryTile label="Total Events" value={act.total} valueType="number" icon={ClipboardList} />
            <SummaryTile label="Refunds" value={(r.user_activity_log || []).filter(a => a.action === 'refund').length} valueType="number" icon={Receipt} />
            <SummaryTile label="Cash Moves" value={(r.user_activity_log || []).filter(a => a.action === 'cash_movement').length} valueType="number" icon={Landmark} />
            <SummaryTile label="Sessions" value={(r.user_activity_log || []).filter(a => a.action === 'session_open' || a.action === 'session_close').length} valueType="number" icon={Clock} />
          </div>
          <TableBox cols={actCols} rows={act.rows} total={act.total} page={act.page} limit={L} onPage={(p) => loadPage('/reports/user-activity', setAct, p)} loading={false} noData="No activity in the selected range." name="User Activity Audit" totals={{}} />
        </div>)}
      </>)}
  </div>);

function DailyBreakdown({ daily }) {
  const cols = [{ k: 'date', l: 'Date' }, { k: 'orders', l: 'Orders', t: 'n' }, { k: 'sales', l: 'Sales' }, { k: 'cash', l: 'Cash' }, { k: 'card', l: 'Card' }, { k: 'bank_transfer', l: 'Bank' }, { k: 'split', l: 'Split' }, { k: 'reload_sales', l: 'Reload' }, { k: 'withdrawals', l: 'Refunds/Wd' }];
  const t = daily.reduce((a, d) => { a.orders += d.orders; ['sales','cash','card','bank_transfer','split','reload_sales','withdrawals'].forEach((k) => a[k] += d[k] || 0); return a; }, { orders: 0, sales: 0, cash: 0, card: 0, bank_transfer: 0, split: 0, reload_sales: 0, withdrawals: 0 });
  const xcols = cols.map((c) => ({ key: c.k, label: c.l, type: c.t === 'n' ? 'number' : 'money', align: 'right' }));
  return (<div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
    <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(daily, 'Daily Sales Breakdown', xcols, t)} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
    <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
      <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr>{cols.map((c) => <th key={c.k} className="px-4 py-3">{c.l}</th>)}</tr></thead>
      <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
        {daily.length === 0 ? <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No sales in the selected date range.</td></tr> : daily.map((d) => (<tr key={d.date} className="odd:bg-gray-50/40"><td className="px-4 py-2.5 font-medium">{d.date}</td><td className="px-4 py-2.5">{d.orders}</td>{cols.slice(2).map((c) => <td key={c.k} className="px-4 py-2.5 tabular-nums text-right">{fmt(d[c.k])}</td>)}</tr>))}
        <tr className="bg-gray-50 dark:bg-slate-950 font-bold"><td className="px-4 py-2.5">TOTAL</td><td className="px-4 py-2.5">{t.orders}</td>{cols.slice(2).map((c) => <td key={c.k} className="px-4 py-2.5 tabular-nums text-right">{fmt(t[c.k])}</td>)}</tr>
      </tbody>
    </table>
  </div>);
}

}


function ProfitMargin({ pm, rev, cost }) {
  const cols = [
    { key: 'item_name', label: 'Item' }, { key: 'category', label: 'Category' },
    { key: 'quantity_sold', label: 'Qty Sold', type: 'number', align: 'right' }, { key: 'revenue', label: 'Revenue', type: 'money', align: 'right' },
    { key: 'cost', label: 'Cost', type: 'money', align: 'right' }, { key: 'profit', label: 'Profit', type: 'money', align: 'right' },
    { key: 'margin_percent', label: 'Margin %', type: 'number', align: 'right' }
  ];
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
      <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(pm, 'Profit Margin', cols, { revenue: rev, cost, profit: rev - cost })} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
      <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
        <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr>{cols.map((c) => <th key={c.key} className={`px-4 py-3 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
          {pm.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No product sales in the selected date range.</td></tr> :
            pm.map((row, i) => (<tr key={row.sale_id || i} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{row.item_name}</td><td className="px-4 py-2.5">{row.category}</td>
              <td className="px-4 py-2.5 tabular-nums text-right">{fmtN(row.quantity_sold)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(row.revenue)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(row.cost)}</td>
              <td className="px-4 py-2.5 tabular-nums text-right">{fmt(row.profit)}</td><td className="px-4 py-2.5 tabular-nums text-right">{row.margin_percent.toFixed(2)}%</td></tr>))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentType({ pb, total }) {
  const rows = Object.entries(pb || {}).map(([k, v]) => ({ method: k.toUpperCase(), total: v }));
  const cols = [{ key: 'method', label: 'Payment Method' }, { key: 'total', label: 'Total', type: 'money', align: 'right' }];
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
      <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(rows, 'Payment Type', cols, { total })} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
      <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
        <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr><th className="px-4 py-3">Payment Method</th><th className="px-4 py-3 text-right">Total</th></tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
          {rows.map((r) => <tr key={r.method} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{r.method}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(r.total)}</td></tr>)}
          <tr className="bg-gray-50 dark:bg-slate-950 font-bold"><td className="px-4 py-2.5">TOTAL</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(total)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}



function Credit({ credits, outstanding }) {
  const cols = [
    { key: 'note_no', label: 'Note #' }, { key: 'customer_name', label: 'Customer' }, { key: 'customer_phone', label: 'Phone' },
    { key: 'amount', label: 'Amount', type: 'money', align: 'right' }, { key: 'balance', label: 'Balance', type: 'money', align: 'right' }, { key: 'status', label: 'Status' }
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <SummaryTile label="Total Outstanding" value={outstanding} icon={BadgeDollarSign} />
        <SummaryTile label="Open Credit Notes" value={credits.length} valueType="number" icon={Receipt} />
        <SummaryTile label="Avg Balance" value={credits.length ? outstanding / credits.length : 0} icon={BadgeDollarSign} />
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
        <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(credits, 'Credit Notes', cols, { amount: credits.reduce((s, c) => s + Number(c.amount), 0), balance: outstanding })} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
        <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
          <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr><th className="px-4 py-3">Note #</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Phone</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-right">Balance</th><th className="px-4 py-3">Status</th></tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {credits.length === 0 ? <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No outstanding credit notes.</td></tr> :
              credits.map((c) => <tr key={c.note_no} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{c.note_no}</td><td className="px-4 py-2.5">{c.customer_name || ''}</td><td className="px-4 py-2.5">{c.customer_phone || ''}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(c.amount)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(c.balance)}</td><td className="px-4 py-2.5">{c.status}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function Purchases({ p, ss, sup }) {
  const cols = [
    { key: 'date', label: 'Date' }, { key: 'item_name', label: 'Item' }, { key: 'sku', label: 'SKU' },
    { key: 'quantity', label: 'Qty', type: 'number', align: 'right' }, { key: 'unit_cost', label: 'Unit Cost', type: 'money', align: 'right' },
    { key: 'total_cost', label: 'Total', type: 'money', align: 'right' }, { key: 'supplier', label: 'Supplier' }
  ];
  const rows = p.filter((x) => !sup || !x.supplier || x.supplier.includes(sup));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryTile label="Total Spend" value={rows.reduce((s, x) => s + Number(x.total_cost || 0), 0)} icon={Landmark} />
        <SummaryTile label="Purchases" value={rows.length} valueType="number" icon={PackageSearch} />
        <SummaryTile label="Suppliers" value={(ss || []).length} valueType="number" icon={Users} />
      </div>
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
        <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(rows, 'Purchases Report', cols, {})} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
        <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
          <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr>{cols.map((c) => <th key={c.key} className="px-4 py-3">{c.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {rows.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No purchases in the selected date range.</td></tr> :
              rows.map((x, i) => <tr key={x.date + i} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{x.date}</td><td className="px-4 py-2.5">{x.item_name}</td><td className="px-4 py-2.5">{x.sku}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmtN(x.quantity)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(x.unit_cost)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(x.total_cost)}</td><td className="px-4 py-2.5">{x.supplier}</td></tr>)}
          </tbody>
        </table>
      </div>
      <SupplierSpend ss={ss} />
    </div>
  );
}

function SupplierSpend({ ss }) {
  const cols = [{ key: 'supplier', label: 'Supplier' }, { key: 'quantity', label: 'Qty', type: 'number', align: 'right' }, { key: 'total_spend', label: 'Total Spend', type: 'money', align: 'right' }];
  if (!(ss || []).length) return <p className="text-gray-400">No supplier spend in the selected range.</p>;
  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
      <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(ss, 'Supplier Spend', cols, { total_spend: ss.reduce((s, x) => s + Number(x.total_spend || 0), 0) })} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
      <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
        <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr><th className="px-4 py-3">Supplier</th><th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Total Spend</th></tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
          {ss.map((r) => <tr key={r.supplier} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{r.supplier}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmtN(r.quantity)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(r.total_spend)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}


function Performance({ best, worst, dead = {} }) {
  const cols = [
    { key: 'item_name', label: 'Item' }, { key: 'category', label: 'Category' },
    { key: 'quantity_sold', label: 'Qty Sold', type: 'number', align: 'right' }, { key: 'revenue', label: 'Revenue', type: 'money', align: 'right' }, { key: 'days_without_sale', label: 'Days No Sale', type: 'number', align: 'right' }
  ];
  const rows = [...(best || []), ...(worst || [])];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryTile label="Best Sellers" value={best.length} valueType="number" icon={TrendingUp} />
        <SummaryTile label="Worst Sellers" value={worst.length} valueType="number" icon={TrendingDown} />
        <SummaryTile label="Dead Stock Items" value={dead.items?.length || 0} valueType="number" icon={PackageSearch} />
      </div>
      <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100">Dead Stock (no sale in threshold days)</h2>
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto mb-4">
        <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
          <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr><th className="px-4 py-3">Category</th><th className="px-4 py-3">Item</th><th className="px-4 py-3">Code</th><th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Days In Stock</th><th className="px-4 py-3 text-right">Days No Sale</th><th className="px-4 py-3 text-right">Capital Locked</th></tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {(dead.items || []).length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No dead stock items found.</td></tr> :
              (dead.items || []).map((d, i) => <tr key={d.item_name + d.code + i} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{d.category}</td><td className="px-4 py-2.5">{d.item_name}</td><td className="px-4 py-2.5">{d.code}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmtN(d.quantity)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmtN(d.days_in_stock)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmtN(d.days_without_sale)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(d.capital_locked)}</td></tr>)}
          </tbody>
        </table>
      </div>
      <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100">Best &amp; Worst Sellers</h2>
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm overflow-x-auto">
        <div className="flex justify-end p-3"><button onClick={() => exportToExcelWithTotals(rows, 'Product Performance', cols, {})} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium"><FileSpreadsheet size={16} />Excel</button></div>
        <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
          <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500"><tr>{cols.map((c) => <th key={c.key} className="px-4 py-3">{c.label}</th>)}</tr></thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
            {rows.length === 0 ? <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No product sales in the selected date range.</td></tr> :
              rows.map((row, i) => <tr key={row.sale_id || i} className="odd:bg-gray-50/40"><td className="px-4 py-2.5">{row.item_name}</td><td className="px-4 py-2.5">{row.category}</td><td className="px-4 py-2.5 tabular-nums">{fmtN(row.quantity_sold)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmt(row.revenue)}</td><td className="px-4 py-2.5 tabular-nums text-right">{fmtN(row.days_without_sale || 0)}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
