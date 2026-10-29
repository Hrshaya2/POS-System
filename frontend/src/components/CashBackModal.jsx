import React, { useState } from 'react';
import { X, Banknote, Printer, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { buildReceiptHtml, getReceiptSettings } from '../utils/receipt';

const API_BASE = '/api';
const fmtMoney = (v) => `Rs. ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const token = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` });

export default function CashBackModal({ amount, sale, onClose, onApplied }) {
  const { user } = useAuth();
  const [cashTendered, setCashTendered] = useState('');
  const [changeGiven, setChangeGiven] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(null);

  const cashbackAmount = Number(amount || 0);

  const handleConfirm = async () => {
    if (submitting) return;
    const tendered = Number(cashTendered || 0);
    if (tendered < cashbackAmount) {
      setError(`Cash tendered must be at least ${fmtMoney(cashbackAmount)}`);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const body = {
        saleId: sale?.id,
        amount: cashbackAmount,
        cash_tendered: tendered,
        change_given: tendered - cashbackAmount,
        cashier_id: user?.id,
        cashier_name: user?.name,
        movement_date: new Date().toISOString().slice(0, 10)
      };
      const res = await fetch(`${API_BASE}/cash-movements`, {
        method: 'POST',
        headers: token(),
        body: JSON.stringify({ ...body, movementType: 'CASH_OUT', note: `Cashback for sale ${sale?.receipt_no || sale?.id}` })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to record cashback');
      setCompleted({ ...data, amount: cashbackAmount, cash_tendered: tendered, change_given: tendered - cashbackAmount });
      if (onApplied) onApplied();
    } catch (err) {
      setError(err.message || 'Network error - please try again');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <Banknote size={20} className="text-emerald-600" />
            <h3 className="text-base font-bold text-gray-900 dark:text-slate-100">Cashback Payout</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 dark:text-slate-500">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {completed ? (
            <div className="text-center py-6 space-y-3">
              <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center">
                <CheckCircle2 size={28} className="text-emerald-600" />
              </div>
              <h4 className="text-base font-bold text-gray-900 dark:text-slate-100">Cashback paid</h4>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {fmtMoney(completed.amount)} paid to customer.
              </p>
              <div className="text-2xl font-extrabold text-emerald-700 tabular-nums">{fmtMoney(completed.amount)}</div>
              <div className="flex items-center justify-center gap-3 pt-2">
                <button type="button" onClick={onClose}
                  className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold shadow-md">
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 p-4 text-center">
                <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Cashback amount</p>
                <p className="text-3xl font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums mt-1">{fmtMoney(cashbackAmount)}</p>
                {sale?.receipt_no && (
                  <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">Original receipt: {sale.receipt_no}</p>
                )}
              </div>
              <label className="block">
                <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Cash tendered (Rs.)</span>
                <input
                  type="number"
                  min={cashbackAmount}
                  step="0.01"
                  value={cashTendered}
                  onChange={(e) => {
                    setCashTendered(e.target.value);
                    const t = Number(e.target.value || 0);
                    setChangeGiven(Math.max(0, t - cashbackAmount));
                  }}
                  className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder={fmtMoney(cashbackAmount)}
                />
              </label>
              {Number(cashTendered || 0) > 0 && (
                <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-gray-50 dark:bg-slate-950 text-sm">
                  <span className="text-gray-600 dark:text-slate-400">Change to give back</span>
                  <span className="font-bold text-gray-900 dark:text-slate-100 tabular-nums">{fmtMoney(changeGiven)}</span>
                </div>
              )}
              {error && (
                <div className="rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-300 flex items-center gap-2">
                  <AlertTriangle size={16} /> {error}
                </div>
              )}
              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" onClick={onClose}
                  className="px-4 py-2.5 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700">
                  Cancel
                </button>
                <button type="button" onClick={handleConfirm} disabled={submitting}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold shadow-md disabled:opacity-60">
                  <Banknote size={15} /> {submitting ? 'Processing...' : 'Confirm payout'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}