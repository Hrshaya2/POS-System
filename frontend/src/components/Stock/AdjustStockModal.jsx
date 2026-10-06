// Section 4: per-item stock adjustment.
// +/- amount, reason picker, optional note, live "Current -> New" preview,
// explicit negative-override guard, Confirm gated on validity.
import React, { useState } from 'react';
import { X, AlertTriangle, ArrowRight, Plus, Minus } from 'lucide-react';
import { ADJUSTMENT_REASONS } from './constants';

export default function AdjustStockModal({ item, onClose, onConfirm }) {
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState('in'); // 'in' | 'out'
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [allowNegative, setAllowNegative] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const parsed = Number(amount);
  const magnitude = Number.isFinite(parsed) ? Math.abs(parsed) : 0;
  const delta = direction === 'out' ? -magnitude : magnitude;
  const currentQty = Number(item?.quantity || 0);
  const newQty = currentQty + delta;
  const goesNegative = newQty < 0;

  const errors = {};
  if (!magnitude || magnitude <= 0) errors.amount = 'Enter a non-zero amount';
  if (!reason) errors.reason = 'Pick a reason for this adjustment';
  if (goesNegative && !allowNegative) {
    errors.negative = `This would take stock to ${newQty}. Tick the override below only if that is intended.`;
  }
  const isValid = Object.keys(errors).length === 0;

  const handleConfirm = async () => {
    if (!isValid || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm({ change: delta, reason, note: note.trim(), allowNegative });
      onClose();
    } catch (err) {
      alert(err.message || 'Adjustment failed');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      {/* max-h + overflow-y-auto: keeps the whole modal inside a short mobile
          viewport; the body scrolls instead of spilling off-screen. */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] overflow-y-auto">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Adjust Stock</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{item?.name} · <span className="font-mono">{item?.sku}</span></p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          <AmountDirectionRow
            direction={direction}
            setDirection={setDirection}
            amount={amount}
            setAmount={setAmount}
            hasError={!!errors.amount && amount !== ''}
          />

          <ReasonPicker reason={reason} setReason={setReason} showHint={!reason} />

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. invoice #, shelf reference…"
              className="w-full px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring focus:border-blue-300"
            />
          </div>

          {/* Live Current -> New preview */}
          <PreviewBox currentQty={currentQty} delta={delta} newQty={newQty} goesNegative={goesNegative} />

          {goesNegative && (
            <NegativeOverride
              checked={allowNegative}
              onChange={(e) => setAllowNegative(e.target.checked)}
              hint={errors.negative}
            />
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 flex justify-end space-x-3 bg-gray-50 dark:bg-slate-950 rounded-b-2xl">
          <button onClick={onClose} className="px-5 py-2.5 text-gray-600 dark:text-slate-400 font-medium hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!isValid || submitting}
            title={!isValid ? 'Fix the highlighted fields to continue' : undefined}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold rounded-lg shadow-md transition-colors"
          >
            {submitting ? 'Applying…' : 'Confirm Adjustment'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AmountDirectionRow({ direction, setDirection, amount, setAmount, hasError }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Direction</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('in')}
            className={`py-3 rounded-xl border-2 font-bold flex flex-col items-center transition-colors ${
              direction === 'in'
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 hover:border-gray-300'
            }`}
          >
            <Plus size={20} /> Stock In
          </button>
          <button
            type="button"
            onClick={() => setDirection('out')}
            className={`py-3 rounded-xl border-2 font-bold flex flex-col items-center transition-colors ${
              direction === 'out'
                ? 'border-orange-500 bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300'
                : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 hover:border-gray-300'
            }`}
          >
            <Minus size={20} /> Stock Out
          </button>
        </div>
      </div>
      <ArrowRight size={16} className="text-gray-300 dark:text-slate-600 mb-4" />
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Amount *</label>
        <input
          type="number"
          autoFocus
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          className={`w-full px-3 py-3 text-lg font-bold border rounded-xl focus:outline-none focus:ring focus:border-blue-300 ${
            hasError ? 'border-rose-300 dark:border-rose-500/40 bg-rose-50/40 dark:bg-rose-500/10' : 'border-gray-200 dark:border-slate-700'
          }`}
        />
      </div>
    </div>
  );
}

function ReasonPicker({ reason, setReason, showHint }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">Reason *</label>
      <div className="grid grid-cols-2 gap-2">
        {ADJUSTMENT_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(r)}
            className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors text-left ${
              reason === r
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300'
                : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950'
            }`}
          >
            {r}
          </button>
        ))}
      </div>
      {showHint && <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">Pick a reason for this adjustment</p>}
    </div>
  );
}

function PreviewBox({ currentQty, delta, newQty, goesNegative }) {
  return (
    <div className={`rounded-xl p-4 border-2 transition-colors ${goesNegative ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30' : 'bg-gray-50 dark:bg-slate-950 border-gray-200 dark:border-slate-700'}`}>
      <p className="text-xs font-bold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-2">Current → New</p>
      <div className="flex items-center justify-center space-x-4 text-2xl font-black">
        <span className="text-gray-700 dark:text-slate-300">{currentQty}</span>
        <span className={`font-black ${delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : delta < 0 ? 'text-rose-500 dark:text-rose-400' : 'text-gray-300 dark:text-slate-600'}`}>
          {delta > 0 ? `+${delta}` : delta}
        </span>
        <ArrowRight size={20} className="text-gray-400 dark:text-slate-500" />
        <span className={goesNegative ? 'text-rose-600' : 'text-gray-900 dark:text-slate-100'}>{newQty}</span>
      </div>
    </div>
  );
}

function NegativeOverride({ checked, onChange, hint }) {
  return (
    <div>
      <label className="flex items-start space-x-2.5 cursor-pointer bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-xl p-3">
        <input type="checkbox" checked={checked} onChange={onChange} className="mt-0.5" />
        <span className="text-xs text-rose-700 dark:text-rose-300">
          <span className="font-bold flex items-center"><AlertTriangle size={12} className="mr-1" />Override negative stock</span>
          I understand this takes the recorded quantity below zero (e.g. pending delivery paperwork).
        </span>
      </label>
      {hint && <p className="text-xs text-rose-600 dark:text-rose-400 mt-1.5">{hint}</p>}
    </div>
  );
}