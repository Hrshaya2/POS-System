import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Printer, RotateCcw, Search, ShieldAlert, Smartphone, Barcode, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { buildRefundReceiptHtml, getReceiptSettings } from '../utils/receipt';

const API_BASE = '/api';
const REASONS = ['', 'Defective', 'Wrong Item', 'Customer Changed Mind', 'Damaged', 'Warranty Return', 'Other'];
const RECEIPT_OPTIONS = [
  { key: 'PRINT_REFUND', label: 'Print refund receipt' },
  { key: 'SAVE_PDF', label: 'Save as PDF' },
  { key: 'NO_RECEIPT', label: 'No receipt' }
];

const fmtMoney = (v) => `Rs. ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const safeNumber = (v) => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

const conditionDefaultForReason = (reason) => (['Defective', 'Damaged', 'Warranty Return'].includes(reason) ? 'DAMAGED' : 'RESELLABLE');

const tokenHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${localStorage.getItem('token')}`
});

const printRefundFrame = async (refund) => {
  const html = buildRefundReceiptHtml(refund, getReceiptSettings());
  await new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.style.border = '0';
    iframe.setAttribute('aria-hidden', 'true');

    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };
    const finish = () => {
      cleanup();
      resolve();
    };

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        reject(new Error('Unable to prepare print frame.'));
        return;
      }
      win.onafterprint = finish;
      try {
        win.focus();
        setTimeout(() => {
          try {
            win.print();
          } catch (err) {
            cleanup();
            reject(err);
          }
          setTimeout(finish, 1500);
        }, 100);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
};

export default function RefundModal({ sale, onClose, onApplied }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';
  const modalRef = useRef(null);
  const firstStepFocusRef = useRef(null);
  const replacementSearchRef = useRef(null);
  const receiptOptionRefs = useRef([]);

  const [step, setStep] = useState(1); // 1 items, 2 replacement, 3 review, 4 receipt
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [policy, setPolicy] = useState({ maxAmount: null, maxDays: null, sameMethodRequired: false });
  const [alreadyRefunded, setAlreadyRefunded] = useState(new Map());
  const [selected, setSelected] = useState({});
  const [reason, setReason] = useState('');
  const [reasonNote, setReasonNote] = useState('');
  const [resolutionType, setResolutionType] = useState('CASH_REFUND');
  const [conditionsByKey, setConditionsByKey] = useState({});
  const [approverPin, setApproverPin] = useState('');

  const [phones, setPhones] = useState([]);
  const [accessories, setAccessories] = useState([]);
  const [replacementSearch, setReplacementSearch] = useState('');
  const [replacementIndex, setReplacementIndex] = useState(0);
  const [replacementCart, setReplacementCart] = useState([]);
  const [replacementModal, setReplacementModal] = useState({ open: false, item: null, price: '', quantity: '1', error: '' });

  const [differenceMethod, setDifferenceMethod] = useState('CASH');
  const [differenceCashReceived, setDifferenceCashReceived] = useState('');

  const [completedRefund, setCompletedRefund] = useState(null);
  const [receiptOptionIndex, setReceiptOptionIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [policyRes, refundsRes, phoneRes, accessoryRes] = await Promise.all([
          fetch(`${API_BASE}/refunds/policy`, { headers: tokenHeaders() }),
          fetch(`${API_BASE}/refunds?saleId=${encodeURIComponent(sale.id)}`, { headers: tokenHeaders() }),
          fetch(`${API_BASE}/inventory/phones`, { headers: tokenHeaders() }),
          fetch(`${API_BASE}/inventory/accessories`, { headers: tokenHeaders() })
        ]);

        if (policyRes.ok && !cancelled) setPolicy(await policyRes.json());

        if (refundsRes.ok && !cancelled) {
          const data = await refundsRes.json();
          const totals = new Map();
          (data.refunds || [])
            .filter((r) => ['APPROVED', 'DIRECT'].includes(r.approval_status))
            .forEach((r) => {
              (r.items || []).forEach((it) => {
                const key = `${it.inventory_type}:${it.inventory_id}`;
                totals.set(key, (totals.get(key) || 0) + Number(it.quantity || 0));
              });
            });
          setAlreadyRefunded(totals);
        }

        if (phoneRes.ok && !cancelled) setPhones(await phoneRes.json());
        if (accessoryRes.ok && !cancelled) setAccessories(await accessoryRes.json());
      } catch (err) {
        if (!cancelled) setNotice('Some data could not be loaded. You can still proceed with available sale details.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sale.id]);

  const soldSubtotal = safeNumber(sale.subtotal);
  const soldDiscount = safeNumber(sale.discount_amount);
  const discountRatio = soldSubtotal > 0 ? Math.min(1, Math.max(0, soldDiscount / soldSubtotal)) : 0;

  const saleItems = useMemo(() => (sale?.items || []).map((it) => {
    const key = `${it.inventory_type}:${it.inventory_id}`;
    const originalQty = Number(it.quantity || 0);
    const refundedQty = Number(alreadyRefunded.get(key) || 0);
    const remaining = Math.max(0, originalQty - refundedQty);
    const soldUnitPrice = safeNumber(it.unit_price);
    const paidUnitPrice = Math.round((soldUnitPrice * (1 - discountRatio)) * 100) / 100;
    return {
      ...it,
      key,
      originalQty,
      refundedQty,
      remaining,
      paidUnitPrice
    };
  }), [sale, alreadyRefunded, discountRatio]);

  const selectedRows = useMemo(() => Object.values(selected), [selected]);
  const refundSubtotal = useMemo(
    () => Math.round(selectedRows.reduce((sum, row) => sum + (safeNumber(row.paidUnitPrice) * safeNumber(row.quantity)), 0) * 100) / 100,
    [selectedRows]
  );

  const replacementCatalog = useMemo(() => [
    ...phones.map((phone) => {
      const barcodes = [phone.imei, ...(phone.barcodes || [])].filter(Boolean);
      return {
        inventoryType: 'phone',
        inventoryId: phone.id,
        displayName: `${phone.brand} ${phone.model}`,
        code: phone.imei,
        barcodes,
        trackedBy: 'IMEI',
        stock: phone.status === 'In Stock' ? 1 : 0,
        listPrice: safeNumber(phone.selling_price),
        allowPriceOverride: true,
        source: phone
      };
    }),
    ...accessories.map((acc) => {
      const barcodes = [acc.sku, ...(acc.barcodes || [])].filter(Boolean);
      return {
        inventoryType: 'accessory',
        inventoryId: acc.id,
        displayName: acc.name,
        code: acc.sku,
        barcodes,
        trackedBy: 'QTY',
        stock: safeNumber(acc.quantity),
        listPrice: safeNumber(acc.sell_price),
        allowPriceOverride: acc.allow_price_override !== false,
        source: acc
      };
    })
  ], [phones, accessories]);

  const visibleReplacement = useMemo(() => {
    const term = replacementSearch.trim().toLowerCase();
    if (!term) return replacementCatalog.slice(0, 10);
    return replacementCatalog.filter((item) => {
      const codes = (item.barcodes || []).concat([item.code]).map((c) => String(c || '').toLowerCase());
      return (
        item.displayName.toLowerCase().includes(term) ||
        codes.some((c) => c.includes(term))
      );
    }).slice(0, 10);
  }, [replacementCatalog, replacementSearch]);

  const replacementTotal = useMemo(
    () => Math.round(replacementCart.reduce((sum, row) => sum + safeNumber(row.unitPrice) * safeNumber(row.quantity), 0) * 100) / 100,
    [replacementCart]
  );
  const netDifference = Math.round((replacementTotal - refundSubtotal) * 100) / 100;
  const cashDueForDifference = Math.max(0, netDifference);
  const cashChangeForDifference = differenceMethod === 'CASH'
    ? Math.max(0, safeNumber(differenceCashReceived) - cashDueForDifference)
    : 0;

  const daysOld = Math.floor((Date.now() - new Date(sale.created_at || Date.now()).getTime()) / 86400000);
  const withinAmount = policy?.maxAmount == null ? true : refundSubtotal <= Number(policy.maxAmount);
  const withinDays = policy?.maxDays == null ? true : daysOld <= Number(policy.maxDays);
  const needsApproval = !isAdmin && (!withinAmount || !withinDays);

  const setInitialFocus = () => {
    setTimeout(() => {
      if (step === 1 && firstStepFocusRef.current) firstStepFocusRef.current.focus();
      if (step === 2 && replacementSearchRef.current) replacementSearchRef.current.focus();
      if (step === 4 && receiptOptionRefs.current[receiptOptionIndex]) receiptOptionRefs.current[receiptOptionIndex].focus();
    }, 0);
  };

  useEffect(() => {
    setInitialFocus();
  }, [step, receiptOptionIndex]);

  useEffect(() => {
    const root = modalRef.current;
    if (!root) return undefined;
    const trap = (event) => {
      if (event.key !== 'Tab') return;
      const nodes = root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const focusables = Array.from(nodes).filter((el) => !el.disabled && !el.getAttribute('aria-hidden'));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener('keydown', trap);
    return () => root.removeEventListener('keydown', trap);
  }, []);

  const markDirty = () => setDirty(true);

  const toggleRow = (item) => {
    if (item.remaining <= 0) return;
    markDirty();
    setSelected((current) => {
      const next = { ...current };
      if (next[item.key]) {
        delete next[item.key];
      } else {
        next[item.key] = {
          key: item.key,
          inventory_type: item.inventory_type,
          inventory_id: item.inventory_id,
          name: item.name,
          sku: item.sku,
          imei: item.imei,
          paidUnitPrice: item.paidUnitPrice,
          quantity: item.remaining
        };
      }
      return next;
    });
    setConditionsByKey((current) => ({
      ...current,
      [item.key]: current[item.key] || conditionDefaultForReason(reason)
    }));
  };

  const setRowQty = (item, qtyValue) => {
    markDirty();
    setSelected((current) => {
      const row = current[item.key];
      if (!row) return current;
      const qty = Math.min(item.remaining, Math.max(1, Math.floor(Number(qtyValue) || 1)));
      return { ...current, [item.key]: { ...row, quantity: qty } };
    });
  };

  const openReplacementPopup = (product) => {
    if (!product || product.stock <= 0) {
      setError('Replacement item is out of stock.');
      return;
    }
    setReplacementModal({
      open: true,
      item: product,
      price: String(product.listPrice),
      quantity: '1',
      error: ''
    });
  };

  const applyReplacementModal = () => {
    if (!replacementModal.item) return;
    const product = replacementModal.item;
    const qty = product.trackedBy === 'IMEI' ? 1 : Math.max(1, Math.floor(Number(replacementModal.quantity || 1)));
    const unitPrice = safeNumber(replacementModal.price);
    if (unitPrice < 0) {
      setReplacementModal((s) => ({ ...s, error: 'Price must be zero or higher.' }));
      return;
    }
    if (product.allowPriceOverride === false && Math.abs(unitPrice - product.listPrice) > 0.0001) {
      setReplacementModal((s) => ({ ...s, error: 'Price override is disabled for this item.' }));
      return;
    }
    if (qty > product.stock) {
      setReplacementModal((s) => ({ ...s, error: `Only ${product.stock} in stock.` }));
      return;
    }

    markDirty();
    setReplacementCart((current) => {
      const key = `${product.inventoryType}:${product.inventoryId}`;
      const idx = current.findIndex((line) => `${line.inventoryType}:${line.inventoryId}` === key);
      const next = [...current];
      if (idx >= 0) {
        const old = next[idx];
        const mergedQty = old.trackedBy === 'IMEI' ? 1 : old.quantity + qty;
        if (mergedQty > old.stock) {
          setReplacementModal((s) => ({ ...s, error: `Only ${old.stock} in stock.` }));
          return current;
        }
        next[idx] = { ...old, quantity: mergedQty, unitPrice };
      } else {
        next.push({
          inventoryType: product.inventoryType,
          inventoryId: product.inventoryId,
          name: product.displayName,
          sku: product.inventoryType === 'accessory' ? product.code : null,
          imei: product.inventoryType === 'phone' ? product.code : null,
          trackedBy: product.trackedBy,
          stock: product.stock,
          unitPrice,
          quantity: qty
        });
      }
      return next;
    });
    setReplacementSearch('');
    setReplacementModal({ open: false, item: null, price: '', quantity: '1', error: '' });
  };

  const selectReplacementFromSearch = () => {
    const match = visibleReplacement[replacementIndex] || visibleReplacement[0];
    if (match) openReplacementPopup(match);
  };

  const canProceedStep1 = selectedRows.length > 0 && reason && (!reasonNote || reason !== 'Other' || reasonNote.trim());
  const step1Hint = !selectedRows.length
    ? 'Select at least one item.'
    : (!reason ? 'Choose a reason.' : (reason === 'Other' && !reasonNote.trim() ? 'Add a note for "Other".' : ''));

  const canProceedStep2 = resolutionType === 'CASH_REFUND'
    ? true
    : replacementCart.length > 0 && (netDifference <= 0 || differenceMethod !== 'CASH' || safeNumber(differenceCashReceived) >= cashDueForDifference - 0.01);

  const moveNext = () => {
    setError('');
    if (step === 1) {
      if (!canProceedStep1) {
        setError(step1Hint || 'Complete required fields.');
        return;
      }
      if (resolutionType === 'ITEM_EXCHANGE') {
        setStep(2);
        return;
      }
      setStep(3);
      return;
    }
    if (step === 2) {
      if (!canProceedStep2) {
        setError('Add replacement item(s) and collect required difference payment.');
        return;
      }
      setStep(3);
    }
  };

  const closeWithGuard = () => {
    if (!dirty) {
      onClose();
      return;
    }
    const ok = window.confirm('You have unsaved refund changes. Close this modal?');
    if (ok) onClose();
  };

  const moveBack = () => {
    setError('');
    if (step === 4) return;
    if (step === 3) {
      setStep(resolutionType === 'ITEM_EXCHANGE' ? 2 : 1);
      return;
    }
    if (step === 2) {
      setStep(1);
      return;
    }
    closeWithGuard();
  };

  const submitRefund = async () => {
    setError('');
    if (saving) return;
    if (!canProceedStep1) {
      setError(step1Hint || 'Complete required fields.');
      setStep(1);
      return;
    }
    if (resolutionType === 'ITEM_EXCHANGE' && !canProceedStep2) {
      setError('Complete replacement details before confirming.');
      setStep(2);
      return;
    }

    const payload = {
      saleId: sale.id,
      items: selectedRows.map((row) => ({
        inventory_type: row.inventory_type,
        inventory_id: row.inventory_id,
        quantity: row.quantity,
        condition: conditionsByKey[row.key] || conditionDefaultForReason(reason)
      })),
      reason,
      reason_note: reasonNote.trim(),
      resolution_type: resolutionType,
      replacement_items: replacementCart.map((line) => ({
        inventory_type: line.inventoryType,
        inventory_id: line.inventoryId,
        quantity: line.quantity,
        unit_price: line.unitPrice
      })),
      settlement_payment_method: netDifference > 0 ? differenceMethod : sale.payment_method,
      settlement_cash_received: netDifference > 0 && differenceMethod === 'CASH' ? safeNumber(differenceCashReceived) : 0,
      movement_date: new Date().toISOString().slice(0, 10),
      approver_pin: needsApproval ? approverPin.trim() : ''
    };

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/refunds`, {
        method: 'POST',
        headers: tokenHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save refund.');

      if (data.status === 'PENDING') {
        setNotice('Refund sent for admin approval.');
        onApplied && onApplied();
        onClose();
        return;
      }
      const refund = data.refund;
      setCompletedRefund(refund);
      setStep(4);
      setReceiptOptionIndex(0);
      onApplied && onApplied(refund);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const executeReceiptOption = async (optionKey) => {
    if (!completedRefund) return;
    try {
      if (optionKey === 'PRINT_REFUND' || optionKey === 'SAVE_PDF') {
        await printRefundFrame(completedRefund);
      }
    } catch (err) {
      setNotice('Refund saved, but printing failed.');
    } finally {
      onClose();
    }
  };

  const handleModalKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      moveBack();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      const tag = event.target?.tagName;
      if (tag === 'TEXTAREA') return;
      if (replacementModal.open) return;
      event.preventDefault();
      if (step === 4) {
        executeReceiptOption(RECEIPT_OPTIONS[receiptOptionIndex].key);
      } else if (step === 3) {
        submitRefund();
      } else {
        moveNext();
      }
      return;
    }
    if (step === 4 && (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      const delta = (event.key === 'ArrowDown' || event.key === 'ArrowRight') ? 1 : -1;
      setReceiptOptionIndex((prev) => (prev + delta + RECEIPT_OPTIONS.length) % RECEIPT_OPTIONS.length);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div ref={modalRef} onKeyDown={handleModalKeyDown} className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-6xl max-h-[94vh] flex flex-col">
        <div className="flex justify-between items-start px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <div>
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
              <RotateCcw size={18} className="text-violet-600" /> Refund — {sale.receipt_no}
            </h3>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              {new Date(sale.created_at).toLocaleString()} · {String(sale.payment_method || '').replace(/_/g, ' ')} · Total {fmtMoney(sale.total)}
            </p>
            <div className="mt-3 flex items-center gap-2 text-xs">
              {['1 Items', '2 Replacement', '3 Review', '4 Receipt'].map((label, idx) => {
                const n = idx + 1;
                const active = step === n;
                const done = step > n;
                return (
                  <span key={label} className={`px-2.5 py-1 rounded-full border ${active ? 'bg-blue-50 border-blue-300 text-blue-700' : done ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
                    {label}
                  </span>
                );
              })}
            </div>
          </div>
          <button onClick={closeWithGuard} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          {error && <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>}
          {notice && <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">{notice}</div>}

          {step === 1 && (
            <>
              <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-x-auto">
                <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
                  <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500">
                    <tr>
                      <th className="px-4 py-3 w-10"></th>
                      <th className="px-4 py-3">Item</th>
                      <th className="px-4 py-3 text-center">Bought</th>
                      <th className="px-4 py-3 text-center">Already refunded</th>
                      <th className="px-4 py-3 text-right">Paid/unit</th>
                      <th className="px-4 py-3 text-center">Qty to refund</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                      <th className="px-4 py-3 text-center">Condition</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {saleItems.map((it, idx) => {
                      const sel = selected[it.key];
                      const amount = sel ? safeNumber(sel.quantity) * safeNumber(it.paidUnitPrice) : 0;
                      const disabled = it.remaining <= 0;
                      return (
                        <tr key={it.key} className={disabled ? 'opacity-55' : ''}>
                          <td className="px-4 py-2.5">
                            <input
                              ref={idx === 0 ? firstStepFocusRef : undefined}
                              type="checkbox"
                              checked={!!sel}
                              disabled={disabled}
                              onChange={() => toggleRow(it)}
                              className="w-4 h-4 accent-violet-600"
                            />
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-gray-900 dark:text-slate-100">{it.name}</div>
                            <div className="text-xs text-gray-400 dark:text-slate-500">{it.inventory_type === 'phone' ? `IMEI ${it.imei || ''}` : `SKU ${it.sku || ''}`}</div>
                            {disabled && <div className="text-[11px] text-amber-600 mt-0.5">Fully refunded</div>}
                          </td>
                          <td className="px-4 py-2.5 text-center">{it.originalQty}</td>
                          <td className="px-4 py-2.5 text-center">{it.refundedQty}</td>
                          <td className="px-4 py-2.5 text-right font-semibold text-gray-900 dark:text-slate-100">{fmtMoney(it.paidUnitPrice)}</td>
                          <td className="px-4 py-2.5 text-center">
                            <input
                              type="number"
                              min="1"
                              max={it.remaining}
                              value={sel ? sel.quantity : ''}
                              disabled={!sel}
                              onChange={(e) => setRowQty(it, e.target.value)}
                              className="w-16 text-center rounded-lg border border-gray-200 dark:border-slate-700 py-1 disabled:opacity-40"
                            />
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold text-gray-900 dark:text-slate-100">{sel ? fmtMoney(amount) : '—'}</td>
                          <td className="px-4 py-2.5 text-center">
                            <select
                              value={conditionsByKey[it.key] || conditionDefaultForReason(reason)}
                              disabled={!sel}
                              onChange={(e) => {
                                markDirty();
                                setConditionsByKey((current) => ({ ...current, [it.key]: e.target.value }));
                              }}
                              className="rounded-lg border border-gray-200 dark:border-slate-700 px-2 py-1 text-xs disabled:opacity-40"
                            >
                              <option value="RESELLABLE">Resellable</option>
                              <option value="DAMAGED">Damaged</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <label className="block">
                  <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Reason *</span>
                  <select
                    value={reason}
                    onChange={(e) => {
                      markDirty();
                      const nextReason = e.target.value;
                      setReason(nextReason);
                      setConditionsByKey((current) => {
                        const updated = { ...current };
                        const defaultCondition = conditionDefaultForReason(nextReason);
                        Object.keys(selected).forEach((key) => {
                          updated[key] = defaultCondition;
                        });
                        return updated;
                      });
                    }}
                    className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm"
                  >
                    {REASONS.map((r) => <option key={r || 'blank'} value={r}>{r || 'Select reason'}</option>)}
                  </select>
                </label>

                <label className="block">
                  <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Refund the customer as</span>
                  <select value={resolutionType} onChange={(e) => { markDirty(); setResolutionType(e.target.value); }} className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm">
                    <option value="CASH_REFUND">Cash refund</option>
                    <option value="ITEM_EXCHANGE">Exchange</option>
                  </select>
                </label>

                <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5">
                  <div className="text-xs text-gray-500 dark:text-slate-400">Refund total</div>
                  <div className="text-lg font-bold text-violet-700">{fmtMoney(refundSubtotal)}</div>
                </div>
              </div>

              {reason === 'Other' && (
                <label className="block">
                  <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Reason note *</span>
                  <textarea rows={2} value={reasonNote} onChange={(e) => { markDirty(); setReasonNote(e.target.value); }} className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2.5 text-sm" />
                </label>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500 dark:text-slate-400">{step1Hint || 'Press Enter to continue.'}</p>
                <button onClick={moveNext} disabled={!canProceedStep1} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold disabled:opacity-60">
                  Next <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-7 space-y-4">
                  <div className="relative">
                    <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                    <input
                      ref={replacementSearchRef}
                      value={replacementSearch}
                      onChange={(e) => { setReplacementSearch(e.target.value); setReplacementIndex(0); }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setReplacementIndex((prev) => Math.min(prev + 1, visibleReplacement.length - 1));
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setReplacementIndex((prev) => Math.max(0, prev - 1));
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          selectReplacementFromSearch();
                        }
                      }}
                      className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950"
                      placeholder="Search replacement by name / SKU / barcode / IMEI"
                    />
                  </div>
                  {replacementSearch.trim() !== '' && visibleReplacement.length > 0 && (
                    <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                      {visibleReplacement.map((item, idx) => (
                        <button
                          key={`${item.inventoryType}-${item.inventoryId}`}
                          onClick={() => openReplacementPopup(item)}
                          className={`w-full text-left px-4 py-2.5 border-b last:border-b-0 border-gray-100 dark:border-slate-800 ${replacementIndex === idx ? 'bg-blue-50 dark:bg-blue-500/10' : 'hover:bg-gray-50 dark:hover:bg-slate-700/40'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              {item.inventoryType === 'phone' ? <Smartphone size={14} className="text-indigo-600" /> : <Barcode size={14} className="text-amber-600" />}
                              <span className="font-medium text-gray-900 dark:text-slate-100">{item.displayName}</span>
                            </div>
                            <span className="text-sm font-semibold text-gray-900 dark:text-slate-100">{fmtMoney(item.listPrice)}</span>
                          </div>
                          <div className="text-xs text-gray-400 dark:text-slate-500">{item.code} • {item.stock} in stock</div>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-400 dark:text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Item</th>
                          <th className="px-3 py-2 text-center">Qty</th>
                          <th className="px-3 py-2 text-right">Price</th>
                          <th className="px-3 py-2 text-right">Total</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {replacementCart.length === 0 ? (
                          <tr><td colSpan={5} className="px-3 py-5 text-center text-gray-400">No replacement items yet.</td></tr>
                        ) : replacementCart.map((line, idx) => (
                          <tr key={`${line.inventoryType}-${line.inventoryId}`} className="border-t border-gray-100 dark:border-slate-800">
                            <td className="px-3 py-2">{line.name}</td>
                            <td className="px-3 py-2 text-center">{line.quantity}</td>
                            <td className="px-3 py-2 text-right">{fmtMoney(line.unitPrice)}</td>
                            <td className="px-3 py-2 text-right font-semibold">{fmtMoney(line.unitPrice * line.quantity)}</td>
                            <td className="px-3 py-2 text-right">
                              <button onClick={() => { markDirty(); setReplacementCart((current) => current.filter((_, i) => i !== idx)); }} className="text-rose-600 text-xs">Remove</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="lg:col-span-5 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4 space-y-3">
                  <div className="flex items-center justify-between"><span className="text-sm text-gray-500 dark:text-slate-400">Refunded value</span><strong>{fmtMoney(refundSubtotal)}</strong></div>
                  <div className="flex items-center justify-between"><span className="text-sm text-gray-500 dark:text-slate-400">Replacement value</span><strong>{fmtMoney(replacementTotal)}</strong></div>
                  <div className="flex items-center justify-between border-t border-gray-200 dark:border-slate-700 pt-2">
                    <span className="text-sm font-semibold text-gray-700 dark:text-slate-300">Difference</span>
                    <strong className={netDifference > 0 ? 'text-rose-700 dark:text-rose-300' : netDifference < 0 ? 'text-emerald-700 dark:text-emerald-300' : ''}>
                      {netDifference > 0 ? `${fmtMoney(netDifference)} customer pays` : netDifference < 0 ? `${fmtMoney(Math.abs(netDifference))} shop pays back` : 'No payment'}
                    </strong>
                  </div>

                  {netDifference > 0 && (
                    <div className="space-y-2 pt-2 border-t border-gray-200 dark:border-slate-700">
                      <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Payment method</label>
                      <select value={differenceMethod} onChange={(e) => { markDirty(); setDifferenceMethod(e.target.value); }} className="w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-2 text-sm">
                        <option value="CASH">Cash</option>
                        <option value="CARD">Card</option>
                        <option value="BANK_TRANSFER">Bank transfer</option>
                      </select>
                      {differenceMethod === 'CASH' && (
                        <>
                          <label className="block text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">Cash received</label>
                          <input value={differenceCashReceived} onChange={(e) => { markDirty(); setDifferenceCashReceived(e.target.value); }} className="w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-2 text-sm" />
                          <div className="text-xs text-gray-500 dark:text-slate-400">Change due: {fmtMoney(cashChangeForDifference)}</div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button onClick={() => setStep(1)} className="px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold">Back</button>
                <button onClick={moveNext} disabled={!canProceedStep2} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold disabled:opacity-60">
                  Next <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4">
                  <h4 className="font-semibold text-gray-900 dark:text-slate-100 mb-2">Refunded items</h4>
                  <div className="space-y-1 text-sm">
                    {selectedRows.map((row) => (
                      <div key={row.key} className="flex items-center justify-between">
                        <span>{row.name} × {row.quantity}</span>
                        <span className="font-semibold">{fmtMoney(row.quantity * row.paidUnitPrice)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-200 dark:border-slate-700 font-bold">Refund value: {fmtMoney(refundSubtotal)}</div>
                </div>

                <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4">
                  <h4 className="font-semibold text-gray-900 dark:text-slate-100 mb-2">Replacement items</h4>
                  <div className="space-y-1 text-sm">
                    {replacementCart.length === 0 ? <div className="text-gray-400">None</div> : replacementCart.map((row) => (
                      <div key={`${row.inventoryType}:${row.inventoryId}`} className="flex items-center justify-between">
                        <span>{row.name} × {row.quantity}</span>
                        <span className="font-semibold">{fmtMoney(row.quantity * row.unitPrice)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-200 dark:border-slate-700 font-bold">Replacement value: {fmtMoney(replacementTotal)}</div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4 text-sm space-y-2">
                <div><strong>Reason:</strong> {reason}{reason === 'Other' && reasonNote ? ` — ${reasonNote}` : ''}</div>
                <div><strong>Resolution:</strong> {resolutionType === 'ITEM_EXCHANGE' ? 'Exchange' : 'Cash refund'}</div>
                <div><strong>Net amount:</strong> {netDifference > 0 ? `${fmtMoney(netDifference)} received from customer` : netDifference < 0 ? `${fmtMoney(Math.abs(netDifference))} paid to customer` : 'No payment'}</div>
                <div><strong>Stock effect:</strong> Returned items marked Resellable increase stock; Damaged items do not. Replacement items reduce stock.</div>
                <div><strong>Cash drawer effect:</strong> Cash refund decreases expected cash; cash difference collection increases expected cash.</div>
              </div>

              {needsApproval && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 space-y-2">
                  <div className="flex items-center gap-2"><ShieldAlert size={16} /> This refund exceeds cashier limits. Enter admin PIN to approve now.</div>
                  <input value={approverPin} onChange={(e) => setApproverPin(e.target.value)} type="password" className="w-full max-w-xs rounded-xl border border-amber-200 dark:border-amber-500/30 bg-white dark:bg-slate-800 px-3 py-2 text-sm" placeholder="Admin PIN" />
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button onClick={moveBack} className="px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold">Back</button>
                <button onClick={submitRefund} disabled={saving || (needsApproval && !approverPin.trim())} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold disabled:opacity-60">
                  {saving ? 'Saving…' : 'Confirm refund'}
                </button>
              </div>
            </>
          )}

          {step === 4 && completedRefund && (
            <>
              <div className="text-center py-4 space-y-2">
                <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center"><CheckCircle2 size={28} className="text-emerald-600" /></div>
                <h4 className="text-base font-bold text-gray-900 dark:text-slate-100">Refund saved</h4>
                <p className="text-sm text-gray-500 dark:text-slate-400">
                  {completedRefund.refund_reference} · {completedRefund.sale_receipt_no}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {RECEIPT_OPTIONS.map((option, index) => (
                  <button
                    key={option.key}
                    ref={(el) => { receiptOptionRefs.current[index] = el; }}
                    onClick={() => executeReceiptOption(option.key)}
                    className={`rounded-xl border px-4 py-4 text-left transition-all ${receiptOptionIndex === index ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300'}`}
                  >
                    <div className="font-bold">{option.label}</div>
                    <div className="text-xs mt-1">Enter</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 flex items-center justify-between text-xs text-gray-500 dark:text-slate-400">
          <span>Esc: back/cancel · Enter: next/confirm</span>
          <span>Keyboard and mouse both supported</span>
        </div>
      </div>

      {replacementModal.open && (
        <div className="fixed inset-0 z-[60] bg-black/45 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 shadow-2xl p-6">
            <h4 className="text-lg font-bold text-gray-900 dark:text-slate-100">Add replacement item</h4>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{replacementModal.item?.displayName}</p>

            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-sm font-semibold text-gray-700 dark:text-slate-300">Price</span>
                <input value={replacementModal.price} readOnly={replacementModal.item?.allowPriceOverride === false} onChange={(e) => setReplacementModal((s) => ({ ...s, price: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-2.5 text-sm" />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-gray-700 dark:text-slate-300">Quantity</span>
                <input value={replacementModal.quantity} readOnly={replacementModal.item?.trackedBy === 'IMEI'} onChange={(e) => setReplacementModal((s) => ({ ...s, quantity: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-2.5 text-sm" />
              </label>
              {replacementModal.error && <div className="rounded-lg border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{replacementModal.error}</div>}
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setReplacementModal({ open: false, item: null, price: '', quantity: '1', error: '' })} className="px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold">Cancel</button>
              <button onClick={applyReplacementModal} className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold">Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
