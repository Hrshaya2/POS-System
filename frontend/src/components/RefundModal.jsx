import React, { useEffect, useMemo, useState } from 'react';
import { X, ShieldAlert, Printer, CheckCircle2, RotateCcw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { buildRefundReceiptHtml, getReceiptSettings } from '../utils/receipt';

const API_BASE = '/api';
const fmtMoney = (v) => `Rs. ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const REASONS = ['Defective', 'Wrong Item', 'Customer Changed Mind', 'Damaged', 'Other'];

const methodLabel = (m) => String(m || '').replace(/_/g, ' ');

const token = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` });

// Print a refund receipt using the same offline-capable window.print() approach as sales.
const printRefund = (refund) => {
  const html = buildRefundReceiptHtml(refund, getReceiptSettings());
  const win = window.open('', '_blank', 'width=420,height=760');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 200);
};

export default function RefundModal({ sale, onClose, onApplied }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';

  const [selected, setSelected] = useState({});
  const [reason, setReason] = useState(REASONS[0]);
  const [reasonNote, setReasonNote] = useState('');
  const [refundMethod, setRefundMethod] = useState('');
  const [policy, setPolicy] = useState({ maxAmount: null, maxDays: null, sameMethodRequired: false });
  const [alreadyRefunded, setAlreadyRefunded] = useState(() => new Map());
  const [flow, setFlow] = useState('select');
  const [submitting, setSubmitting] = useState(false);
  const [approverPin, setApproverPin] = useState('');
  const [pendingRefund, setPendingRefund] = useState(null);
  const [completed, setCompleted] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const policyRes = await fetch(`${API_BASE}/refunds/policy`, { headers: token() });
        if (policyRes.ok) setPolicy(await policyRes.json());
      } catch { /* keep defaults */ }
      try {
        const refundsRes = await fetch(`${API_BASE}/refunds?saleId=${encodeURIComponent(sale.id)}`, { headers: token() });
        if (refundsRes.ok) {
          const data = await refundsRes.json();
          const totals = new Map();
          (data.refunds || []).filter((r) => ['APPROVED', 'DIRECT'].includes(r.approval_status)).forEach((r) => {
            (r.items || []).forEach((it) => {
              const key = `${it.inventory_type}:${it.inventory_id}`;
              totals.set(key, (totals.get(key) || 0) + Number(it.quantity || 0));
            });
          });
          if (!cancelled) setAlreadyRefunded(totals);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [sale.id]);

  const items = useMemo(() => (sale?.items || []).map((it) => ({
    key: `${it.inventory_type}:${it.inventory_id}`,
    originalQty: Number(it.quantity || 0),
    remaining: Math.max(0, Number(it.quantity || 0) - Number(alreadyRefunded.get(`${it.inventory_type}:${it.inventory_id}`) || 0)),
    unit_price: Number(it.unit_price || 0),
    ...it
  })), [sale, alreadyRefunded]);

  const toggle = (item) => {
    if (item.remaining <= 0) return;
    setSelected((cur) => {
      const next = { ...cur };
      if (next[item.key]) delete next[item.key];
      else next[item.key] = { ...item, quantity: item.remaining };
      return next;
    });
  };

  const setQty = (key, qty) => {
    setSelected((cur) => {
      const item = cur[key];
      if (!item) return cur;
      const capped = Math.min(Math.max(1, Number(qty) || 1), item.remaining);
      return { ...cur, [key]: { ...item, quantity: capped } };
    });
  };

  const calc = useMemo(() => {
    const records = Object.values(selected);
    const subtotal = records.reduce((s, r) => s + r.unit_price * r.quantity, 0);
    const count = records.reduce((s, r) => s + r.quantity, 0);
    return { records, subtotal: Math.round(subtotal * 100) / 100, count };
  }, [selected]);

  // Client-side mirror of the server-side refund policy so cashiers see the
  // limits up-front. The final decision always comes from the server.
  const originalMethod = String(sale.payment_method || '').toUpperCase();
  const withinAmount = policy?.maxAmount == null ? true : calc.subtotal <= Number(policy.maxAmount);
  const daysOld = Math.floor((Date.now() - new Date(sale.created_at || Date.now()).getTime()) / 86400000);
  const withinDays = policy?.maxDays == null ? true : daysOld <= Number(policy.maxDays);
  const sameMethodOk = !policy?.sameMethodRequired || (refundMethod || originalMethod) === originalMethod;
  const needsApproval = !isAdmin && (!withinAmount || !withinDays || !sameMethodOk);

  const submit = async () => {
    setError('');
    if (calc.records.length === 0) { setError('Select at least one item to refund.'); return; }
    if (reason === 'Other' && !reasonNote.trim()) { setError('Please add a short note explaining the reason.'); return; }
    setSubmitting(true);
    setNotice('');
    try {
      const body = {
        saleId: sale.id,
        items: calc.records.map((r) => ({
          inventory_type: r.inventory_type,
          inventory_id: r.inventory_id,
          quantity: r.quantity,
          unit_price: r.unit_price
        })),
        reason,
        reason_note: reasonNote.trim(),
        refund_method: refundMethod || String(sale.payment_method || 'CASH').toUpperCase(),
        movement_date: new Date().toISOString().slice(0, 10)
      };
      const res = await fetch(`${API_BASE}/refunds`, { method: 'POST', headers: token(), body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to initiate refund');
      if (data.status === 'PENDING') {
        setPendingRefund(data.refund);
        if (isAdmin) {
          setNotice('This refund needs admin approval. Enter the admin approval PIN to complete it.');
          setFlow('approve');
        } else {
          setNotice(`This refund (${fmtMoney(data.refund?.total)}) is above the cashier limit and was sent to an admin for approval.`);
          setFlow('sent');
        }
      } else {
        finish(data.refund);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const approve = async () => {
    if (!pendingRefund) return;
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/refunds/${pendingRefund.id}/approve`, {
        method: 'POST', headers: token(), body: JSON.stringify({ approver_pin: approverPin })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Approval failed');
      finish(data.refund);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const finish = (refund) => {
    setCompleted(refund);
    setFlow('done');
    printRefund(refund);       // print the refund receipt immediately
    onApplied && onApplied(refund);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex justify-between items-start px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
              <RotateCcw size={18} className="text-violet-600" /> Refund — {sale.receipt_no}
            </h3>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              {new Date(sale.created_at).toLocaleString()} · {methodLabel(sale.payment_method)} · Total {fmtMoney(sale.total)}
            </p>
          </div>
          {flow !== 'done' && <button onClick={onClose} className="p-2 hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors"><X size={18} /></button>}
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          {error && <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
          {notice && flow !== 'done' && <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">{notice}</div>}

          {flow === 'select' && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-slate-400">
                <span>Select items and quantities to refund. You cannot refund more than what was bought.</span>
                {needsApproval && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 px-2.5 py-1 font-semibold">
                    <ShieldAlert size={13} /> Needs admin approval
                  </span>
                )}
              </div>

              {/* overflow-x-auto: the item table scrolls sideways on narrow
                  screens instead of being clipped by overflow-hidden. */}
              <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-x-auto">
                <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
                  <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500">
                    <tr>
                      <th className="px-4 py-3 w-10"></th>
                      <th className="px-4 py-3">Item</th>
                      <th className="px-4 py-3 text-center">Bought</th>
                      <th className="px-4 py-3 text-center">Refunded</th>
                      <th className="px-4 py-3 text-center">Qty to refund</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {items.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No refundable items on this sale.</td></tr>}
                    {items.map((it) => {
                      const sel = selected[it.key];
                      const totalLine = sel ? sel.unit_price * sel.quantity : 0;
                      return (
                        <tr key={it.key} className={it.remaining <= 0 ? 'opacity-50' : ''}>
                          <td className="px-4 py-2.5">
                            <input type="checkbox" disabled={it.remaining <= 0} checked={!!sel} onChange={() => toggle(it)} className="w-4 h-4 accent-violet-600" />
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-gray-900 dark:text-slate-100">{it.name}</div>
                            <div className="text-xs text-gray-400 dark:text-slate-500 font-mono">
                              {it.tracked_by === 'IMEI' || it.inventory_type === 'phone' ? `IMEI ${it.imei || ''}` : `SKU ${it.sku || ''}`}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-center">{it.originalQty}</td>
                          <td className="px-4 py-2.5 text-center text-gray-400 dark:text-slate-500">{it.originalQty - it.remaining}</td>
                          <td className="px-4 py-2.5 text-center">
                            <input type="number" min="1" max={it.remaining} value={sel ? sel.quantity : ''} disabled={!sel}
                              onChange={(e) => setQty(it.key, e.target.value)}
                              className="w-16 text-center rounded-lg border border-gray-200 dark:border-slate-700 py-1 disabled:opacity-40 disabled:bg-gray-50 disabled:dark:bg-slate-950" />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-medium text-gray-900 dark:text-slate-100">{totalLine ? fmtMoney(totalLine) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {calc.count > 0 && (
                    <tfoot className="bg-gray-50">
                      <tr>
                        <td colSpan={5}></td>
                        <td className="px-4 py-3 text-right font-bold text-gray-900 dark:text-slate-100 tabular-nums">{fmtMoney(calc.subtotal)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Reason *</span>
                  <select value={reason} onChange={(e) => { setReason(e.target.value); if (e.target.value !== 'Other') setReasonNote(''); }}
                    className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500">
                    {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Refund method</span>
                  <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500">
                    {[originalMethod, ...['CASH', 'CARD', 'BANK_TRANSFER'].filter((m) => m !== originalMethod)].map((m) => (
                      <option key={m} value={m}>{methodLabel(m)}</option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[11px] text-gray-400 dark:text-slate-500">Defaults to the original payment method.</span>
                </label>
                {reason === 'Other' && (
                  <label className="block md:col-span-2">
                    <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Explain (required for “Other”) *</span>
                    <textarea rows={2} value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Short note for the audit trail…"
                      className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500" />
                  </label>
                )}
              </div>

              {needsApproval && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
                  <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                  <span>Cashier limit is <strong>{fmtMoney(policy.maxAmount)}</strong>. This refund goes to an admin for approval before stock, cash and reports are updated.</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" onClick={onClose} disabled={submitting}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950 disabled:opacity-50">Cancel</button>
                <button type="button" onClick={submit} disabled={submitting || calc.records.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold shadow-md disabled:opacity-60">
                  <RotateCcw size={15} className={submitting ? 'animate-spin' : ''} />
                  {submitting ? 'Processing…' : needsApproval ? 'Send for approval' : `Refund ${fmtMoney(calc.subtotal)}`}
                </button>
              </div>
            </>
          )}

          {flow === 'approve' && pendingRefund && (
            <>
              <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
                <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                <span>This refund exceeds the cashier approval limit. An admin / shop owner must approve it with the store approval PIN before it completes.</span>
              </div>

              <div className="border border-gray-200 dark:border-slate-700 rounded-xl divide-y divide-gray-100 dark:divide-slate-800">
                {(pendingRefund.items || []).map((it, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-gray-700">{it.name}{Number(it.quantity) > 1 ? ` × ${it.quantity}` : ''}</span>
                    <span className="tabular-nums text-gray-900 dark:text-slate-100 font-medium">-{fmtMoney(it.line_total)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-slate-950 text-sm font-bold text-gray-900 dark:text-slate-100">
                  <span>Refund total ({methodLabel(pendingRefund.refund_method)})</span>
                  <span className="tabular-nums text-violet-700">-{fmtMoney(pendingRefund.total)}</span>
                </div>
              </div>

              <label className="block max-w-xs">
                <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Admin approval PIN</span>
                <input type="password" inputMode="numeric" autoFocus value={approverPin}
                  onChange={(e) => setApproverPin(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') approve(); }}
                  placeholder="••••"
                  className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-lg tracking-widest focus:bg-white focus:outline-none focus:ring-2 focus:ring-violet-500" />
              </label>

              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" onClick={() => { setFlow('select'); setPendingRefund(null); }} disabled={submitting}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950 disabled:opacity-50">Back</button>
                <button type="button" onClick={approve} disabled={submitting || !approverPin.trim()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold shadow-md disabled:opacity-60">
                  <ShieldAlert size={15} /> {submitting ? 'Verifying…' : 'Approve & refund'}
                </button>
              </div>
            </>
          )}

          {flow === 'sent' && pendingRefund && (
            <>
              <div className="text-center py-6 space-y-3">
                <div className="mx-auto w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-500/20 flex items-center justify-center"><ShieldAlert size={26} className="text-amber-600" /></div>
                <h4 className="text-base font-bold text-gray-900 dark:text-slate-100">Sent for admin approval</h4>
                <p className="text-sm text-gray-500 dark:text-slate-400 max-w-md mx-auto">
                  Refund <span className="font-mono">{pendingRefund.refund_reference}</span> for{' '}
                  <strong>-{fmtMoney(pendingRefund.total)}</strong> was recorded and is waiting for an admin / shop owner.
                  Stock, the cash session and reports update once it is approved.
                </p>
              </div>
              <div className="flex justify-end pt-1">
                <button type="button" onClick={onClose} className="px-5 py-2.5 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950">Close</button>
              </div>
            </>
          )}

          {flow === 'done' && completed && (
            <>
              <div className="text-center py-6 space-y-3">
                <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center"><CheckCircle2 size={28} className="text-emerald-600" /></div>
                <h4 className="text-base font-bold text-gray-900 dark:text-slate-100">Refund completed</h4>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  <span className="font-mono">{completed.refund_reference}</span> · Receipt <span className="font-mono">{completed.sale_receipt_no}</span><br />
                  Stock restored · Cash session adjusted · Reports updated
                </p>
                <div className="text-2xl font-extrabold text-violet-700 tabular-nums">-{fmtMoney(completed.total)}</div>
                <p className="text-xs text-gray-400 dark:text-slate-500">Processed by {user?.name || '—'} · {new Date().toLocaleString()}</p>
              </div>
              <div className="flex items-center justify-between gap-3 pt-1">
                <button type="button" onClick={() => printRefund(completed)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950">
                  <Printer size={15} /> Print again
                </button>
                <button type="button" onClick={onClose} className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold shadow-md">Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
