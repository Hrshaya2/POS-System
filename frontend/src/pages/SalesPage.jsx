import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    BadgeCheck,
    Banknote,
    Barcode,
    CloudUpload,
    CreditCard,
    History,
    PackageSearch,
    Printer,
    Search,
    ShoppingCart,
    Smartphone,
    Trash2,
    Warehouse,
    WifiOff,
    Phone,
    Bell,
    ClipboardList
    , Plus, X
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSession } from '../context/SessionContext';
import { useSync } from '../context/SyncContext';
import { addPendingSale, generateLocalReceiptNo, getCachedInventory } from '../db/database';
import { refreshInventoryCache } from '../services/syncService';
import { applyServerInventorySnapshot } from '../services/stockService';
import { buildReceiptHtml, buildRefundReceiptHtml, getReceiptSettings } from '../utils/receipt';
import RefundModal from '../components/RefundModal';

const API_BASE = '/api';

const PAYMENT_METHODS = [
    { value: 'CASH', label: 'Cash', icon: Banknote },
    { value: 'CARD', label: 'Card', icon: CreditCard },
    { value: 'BANK_TRANSFER', label: 'Bank Transfer', icon: Warehouse },
    { value: 'SPLIT', label: 'Split Payment', icon: BadgeCheck }
];

const RECEIPT_OPTIONS = [
    { key: 'PRINT_RECEIPT', label: 'Print receipt' },
    { key: 'PRINT_INVOICE', label: 'Print invoice' },
    { key: 'SAVE_PDF', label: 'Save as PDF' },
    { key: 'NO_RECEIPT', label: 'No receipt' }
];

const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const safeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const unitCostOf = (item) => (
    item?.inventoryType === 'phone'
        ? safeNumber(item.source?.purchase_price)
        : safeNumber(item.source?.cost_price)
);

const getCashSummary = (receipt) => {
    const total = Number(receipt?.total || 0);
    const paymentDetails = receipt?.payment_details || {};
    const storedCash = Number(receipt?.cash_received ?? paymentDetails.cash ?? paymentDetails.cashReceived ?? 0);
    const storedChange = Number(receipt?.change_amount ?? paymentDetails.change ?? paymentDetails.change_amount ?? 0);
    const cashTendered = receipt?.payment_method === 'CASH' ? Math.max(0, storedCash) : 0;
    const computedChange = receipt?.payment_method === 'CASH' ? Math.max(0, cashTendered - total) : 0;

    return {
        cashTendered: receipt?.payment_method === 'CASH' ? Math.max(0, cashTendered) : 0,
        changeAmount: receipt?.payment_method === 'CASH' ? Math.max(0, storedChange || computedChange) : 0
    };
};

const buildLocalReceipt = ({ user, session, cart, paymentMethod, cashReceived, paymentDetails }) => {
    const items = cart.map((item) => ({
        inventory_type: item.inventoryType,
        inventory_id: item.inventoryId,
        imei: item.trackedBy === 'IMEI' ? item.code : null,
        sku: item.trackedBy === 'IMEI' ? null : item.code,
        name: item.name,
        quantity: item.quantity,
        // List price, exactly like the saved sale shown in Sales History (the server stores list prices
        // and puts every price reduction into the discount line).
        unit_price: item.listPrice ?? item.unitPrice,
        line_total: (item.listPrice ?? item.unitPrice) * item.quantity,
        tracked_by: item.trackedBy
    }));

    // The cashier enters the final selling price in the item popup.
    const listSubtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const soldSubtotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const total = Math.max(0, soldSubtotal);
    // The automatic discount is the difference between list and entered prices.
    const totalDiscount = Math.max(0, listSubtotal - total);
    const cashTendered = paymentMethod === 'CASH' ? safeNumber(cashReceived) : 0;
    const changeAmount = paymentMethod === 'CASH' ? Math.max(0, cashTendered - total) : 0;
    const now = new Date().toISOString();

    return {
        receipt_no: generateLocalReceiptNo(),
        cashier_id: user?.id,
        cashier_name: user?.name,
        cashier_role: user?.role,
        items,
        subtotal: listSubtotal,
        discount_amount: totalDiscount,
        discount_percent: listSubtotal > 0 ? (totalDiscount / listSubtotal) * 100 : 0,
        total,
        payment_method: paymentMethod,
        payment_details: paymentDetails,
        cash_received: cashTendered,
        change_amount: changeAmount,
        approval_required: false,
        approval_status: 'NOT_REQUIRED',
        approval_note: null,
        session_id: session?.id || null,
        created_at: now,
        clientLocalId: crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    };
};

// Prints an HTML document through a hidden iframe (no new window/tab).
const printHtmlInHiddenFrame = (html) => new Promise((resolve, reject) => {
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

    const finalize = () => {
        cleanup();
        resolve();
    };

    iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) {
            cleanup();
            reject(new Error('Print frame failed to initialize.'));
            return;
        }
        win.onafterprint = finalize;
        try {
            win.focus();
            setTimeout(() => {
                try {
                    win.print();
                } catch (err) {
                    cleanup();
                    reject(err);
                    return;
                }
                setTimeout(finalize, 1800);
            }, 120);
        } catch (err) {
            cleanup();
            reject(err);
        }
    };

    iframe.srcdoc = html;
    document.body.appendChild(iframe);
});

const printWithHiddenFrame = async (receipt, mode = 'receipt') => {
    const baseHtml = buildReceiptHtml(receipt, getReceiptSettings());
    const title = mode === 'invoice' ? 'Invoice' : 'Receipt';
    const html = baseHtml.replace(/<title>.*<\/title>/, `<title>${title} - ${receipt.receipt_no}</title>`);
    await printHtmlInHiddenFrame(html);
};

// Module-level so the Sales History "Refund receipt" button can reach it.
const printRefundWithHiddenFrame = async (refund) => {
    const html = buildRefundReceiptHtml(refund, getReceiptSettings());
    await printHtmlInHiddenFrame(html);
};

function ServicesModal({ services, isAdmin, standalone = false, onClose, onAdd }) {
    const searchRef = useRef(null);
    const [search, setSearch] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selected, setSelected] = useState(null);
    const [quantity, setQuantity] = useState('1');
    const [price, setPrice] = useState('');
    const [cost, setCost] = useState('0');
    const [note, setNote] = useState('');
    const [lines, setLines] = useState([]);
    const [error, setError] = useState('');
    const matches = useMemo(() => {
        const q = search.trim().toLowerCase();
        return services.filter((service) => !q || `${service.displayName} ${service.code} ${service.meta}`.toLowerCase().includes(q)).slice(0, 12);
    }, [services, search]);

    useEffect(() => { searchRef.current?.focus(); }, []);
    useEffect(() => { setSelectedIndex(0); }, [search]);

    const selectService = (service) => {
        setSelected(service);
        setQuantity('1');
        setPrice(String(service.price || 0));
        setCost(String(service.source?.cost_price || 0));
        setNote('');
        setError('');
    };
    const addLine = () => {
        if (!selected) return;
        if (!String(selected.displayName || '').trim()) return setError('Enter a service name.');
        const qty = Math.max(1, Math.floor(Number(quantity) || 0));
        const value = Number(price);
        if (!Number.isFinite(value) || value < 0) return setError('Enter a valid service price.');
        if (selected.allowPriceOverride === false && Math.abs(value - selected.price) > 0.001) return setError('Price changes are disabled for this service.');
        const line = {
            ...selected,
            inventoryType: 'service',
            inventoryId: selected.inventoryId,
            name: selected.displayName,
            unitPrice: value,
            listPrice: selected.price,
            quantity: qty,
            trackedBy: 'SERVICE',
            note,
            source: { ...selected.source, cost_price: isAdmin ? Number(cost) || 0 : 0 }
        };
        setLines((current) => [...current, line]);
        setSelected(null);
        setSearch('');
        setTimeout(() => searchRef.current?.focus(), 0);
    };
    const addCustom = () => selectService({
        inventoryType: 'service',
        inventoryId: `custom-${Date.now()}`,
        code: 'CUSTOM',
        displayName: '',
        price: 0,
        category: 'Services',
        meta: '',
        allowPriceOverride: true,
        source: { is_service: true, cost_price: 0 },
        custom: true
    });
    const removeLine = (index) => setLines((current) => current.filter((_, i) => i !== index));
    const handleKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            if (selected) setSelected(null);
            else onClose();
            return;
        }
        if (!selected && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setSelectedIndex((index) => Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
            return;
        }
        if (event.key === 'Enter' && !event.repeat) {
            event.preventDefault();
            if (selected) addLine();
            else if (matches[selectedIndex]) selectService(matches[selectedIndex]);
        }
        if (event.key === 'F10') {
            event.preventDefault();
            if (lines.length) onAdd(lines);
            else setError('Add at least one service.');
        }
    };
    return (
        <div className="fixed inset-0 z-50 bg-slate-950/60 p-4 md:p-8" onKeyDown={handleKeyDown}>
            <div className="mx-auto max-w-5xl max-h-[92vh] overflow-y-auto rounded-3xl bg-white dark:bg-slate-800 shadow-2xl p-6">
                <div className="flex items-center justify-between mb-5">
                    <div><h2 className="text-2xl font-bold">Services</h2><p className="text-sm text-gray-500">Enter selects/adds · F10 {standalone ? 'saves & pays' : 'adds to cart'} · Esc closes</p></div>
                    <button type="button" onClick={onClose} aria-label="Close services"><X /></button>
                </div>
                <div className="grid lg:grid-cols-2 gap-5">
                    <div>
                        <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search service..." className="w-full rounded-xl border px-3 py-3 dark:bg-slate-900" />
                        <div className="mt-2 rounded-xl border overflow-hidden">
                            {matches.map((service, index) => (
                                <button key={service.inventoryId} type="button" onClick={() => selectService(service)} className={`w-full px-3 py-3 text-left border-b last:border-b-0 ${index === selectedIndex ? 'bg-blue-50 dark:bg-blue-500/20' : ''}`}>
                                    <b>{service.displayName}</b><span className="block text-xs text-gray-500">{formatMoney(service.price)} · {service.code || 'Service'}</span>
                                </button>
                            ))}
                            <button type="button" onClick={addCustom} className="w-full px-3 py-3 text-left text-blue-600 hover:bg-blue-50">+ Custom service...</button>
                        </div>
                        {selected && (
                            <div className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 dark:bg-blue-500/10 p-4 space-y-3">
                                <input autoFocus={!selected.custom} value={selected.displayName} onChange={(event) => setSelected((current) => ({ ...current, displayName: event.target.value }))} placeholder="Service name" className="w-full rounded-xl border px-3 py-2 dark:bg-slate-900" />
                                <input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" placeholder="Quantity" className="w-full rounded-xl border px-3 py-2 dark:bg-slate-900" />
                                <input value={price} onChange={(event) => setPrice(event.target.value)} readOnly={!selected.custom && selected.allowPriceOverride === false} inputMode="decimal" placeholder="Price" className="w-full rounded-xl border px-3 py-2 dark:bg-slate-900" />
                                {isAdmin && <input value={cost} onChange={(event) => setCost(event.target.value)} inputMode="decimal" placeholder="Cost (admin only)" className="w-full rounded-xl border px-3 py-2 dark:bg-slate-900" />}
                                <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note (never enter customer passwords)" className="w-full rounded-xl border px-3 py-2 dark:bg-slate-900" />
                                <button type="button" onClick={addLine} className="w-full rounded-xl bg-blue-600 text-white py-2 font-semibold">Add service (Enter)</button>
                            </div>
                        )}
                    </div>
                    <div>
                        <h3 className="font-bold mb-2">Service lines</h3>
                        <div className="rounded-xl border divide-y">
                            {lines.map((line, index) => <div key={`${line.inventoryId}-${index}`} className="p-3 flex items-center justify-between gap-3"><span>{line.quantity} × {line.name}</span><span>{formatMoney(line.unitPrice * line.quantity)} <button type="button" onClick={() => removeLine(index)} className="ml-2 text-rose-600">×</button></span></div>)}
                            {!lines.length && <div className="p-6 text-center text-sm text-gray-400">No services added.</div>}
                        </div>
                        <div className="mt-4 flex justify-between font-bold"><span>Total</span><span>{formatMoney(lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0))}</span></div>
                    </div>
                </div>
                {error && <div className="mt-4 text-sm text-rose-600">{error}</div>}
                <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="rounded-xl border px-4 py-2">Cancel</button><button type="button" onClick={() => lines.length ? onAdd(lines) : setError('Add at least one service.')} className="rounded-xl bg-blue-600 px-5 py-2 text-white font-semibold">{standalone ? 'Save & pay' : 'Add to cart'}</button></div>
            </div>
        </div>
    );
}

function PayLaterModal({ cart, total, session, user, config, onClose, onCompleted }) {
    const [customer, setCustomer] = useState({ phone: '', name: '', idNumber: '', address: '', note: '' });
    const [advance, setAdvance] = useState('0');
    const [method, setMethod] = useState('CASH');
    const [dueDate, setDueDate] = useState('');
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const balance = Math.max(0, total - safeNumber(advance));
    const setQuickDate = (days) => {
        const date = new Date();
        date.setDate(date.getDate() + days);
        setDueDate(date.toISOString().slice(0, 10));
    };
    const lookup = async (phone) => {
        setCustomer((current) => ({ ...current, phone }));
        if (phone.trim().length < 3) return;
        try {
            const res = await fetch(`${API_BASE}/customers/lookup?phone=${encodeURIComponent(phone)}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
            const rows = await res.json();
            if (rows[0]) setCustomer((current) => ({ ...current, ...rows[0], idNumber: rows[0].id_number || '' }));
        } catch {
            // Lookup is optional; the required phone remains available for saving.
        }
    };
    const submit = async () => {
        setError('');
        if (!customer.phone.trim()) return setError('Customer phone is required.');
        if (!dueDate) return setError('Promised pay-by date is required.');
        if (safeNumber(advance) > total) return setError('Advance cannot exceed the total.');
        const normalizedMethod = String(method || 'CASH').trim().toUpperCase().replace(/[\s-]+/g, '_');
        if (!['CASH', 'CARD', 'BANK_TRANSFER'].includes(normalizedMethod)) {
            return setError('Choose Cash, Card, or Bank Transfer for the advance.');
        }
        if (!navigator.onLine) return setError('Pay Later requires a connection to sync the credit record safely.');
        if (!localStorage.getItem('token')) return setError('Your session has expired. Please sign in again.');
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/sales/checkout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
                body: JSON.stringify({
                    items: cart.map((item) => ({ inventoryType: item.inventoryType, inventoryId: item.inventoryId, quantity: item.quantity, unitPrice: item.unitPrice, name: item.name })),
                    paymentMethod: 'CREDIT',
                    discountAmount: 0,
                    sessionId: session?.id || null,
                    customer,
                    payLater: { advance: safeNumber(advance), advanceMethod: normalizedMethod, dueDate, total, adminPin: pin }
                })
            });
            const responseText = await res.text();
            let data;
            try {
                data = responseText ? JSON.parse(responseText) : {};
            } catch {
                data = { error: responseText || `Request failed (${res.status})` };
            }
            if (!res.ok) throw new Error(data.error || 'Unable to save Pay Later sale');
            onCompleted(data.receipt || data.sale);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div
                className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-800 rounded-3xl shadow-2xl p-6"
                role="dialog"
                aria-modal="true"
                aria-labelledby="pay-later-title"
                tabIndex={-1}
                autoFocus
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        onClose();
                    } else if (event.key === 'Enter' && !event.repeat && event.target?.tagName !== 'BUTTON') {
                        event.preventDefault();
                        submit();
                    }
                }}
            >
                <div className="flex items-center justify-between mb-5"><div><h2 id="pay-later-title" className="text-xl font-bold text-gray-900 dark:text-slate-100">Pay Later</h2><p className="text-sm text-gray-500 dark:text-slate-400">Enter confirms · Esc closes</p></div><button type="button" onClick={onClose} className="text-gray-400 text-2xl" aria-label="Close Pay Later">×</button></div>
                <div className="grid md:grid-cols-2 gap-3">
                    <label className="text-sm font-semibold">Phone *<input autoFocus value={customer.phone} onChange={(e) => lookup(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                    <label className="text-sm font-semibold">Name<input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                    <label className="text-sm font-semibold">ID / NIC<input value={customer.idNumber} onChange={(e) => setCustomer({ ...customer, idNumber: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                    <label className="text-sm font-semibold">Address<input value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                </div>
                <div className="mt-5 grid md:grid-cols-3 gap-3">
                    <label className="text-sm font-semibold">Advance now<input type="number" min="0" value={advance} onChange={(e) => setAdvance(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                    <label className="text-sm font-semibold">Method<select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"><option value="CASH">Cash</option><option value="CARD">Card</option><option value="BANK_TRANSFER">Bank Transfer</option></select></label>
                    <label className="text-sm font-semibold">Promised pay-by *<input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                </div>
                <div className="flex gap-2 mt-3 flex-wrap"><button onClick={() => setQuickDate(1)} className="px-3 py-1.5 rounded-lg border text-xs">Tomorrow</button><button onClick={() => setQuickDate(3)} className="px-3 py-1.5 rounded-lg border text-xs">3 days</button><button onClick={() => setQuickDate(7)} className="px-3 py-1.5 rounded-lg border text-xs">1 week</button></div>
                {config.payLaterLimit > 0 && balance > config.payLaterLimit && !isAdminRole(user?.role) && <label className="block mt-4 text-sm font-semibold">Admin PIN<input type="password" value={pin} onChange={(e) => setPin(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>}
                <div className="mt-5 rounded-2xl bg-gray-50 dark:bg-slate-950 p-4 text-sm"><div className="font-semibold mb-2">Items being given</div>{cart.map((item) => <div key={`${item.inventoryType}-${item.inventoryId}`} className="flex justify-between"><span>{item.quantity} × {item.name}</span><span>{formatMoney(item.unitPrice * item.quantity)}</span></div>)}<div className="border-t mt-3 pt-3 flex justify-between"><strong>Total</strong><strong>{formatMoney(total)}</strong></div><div className="flex justify-between text-amber-700"><span>Balance due</span><strong>{formatMoney(balance)}</strong></div></div>
                {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
                <div className="mt-5 flex justify-end gap-3"><button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border">Back (Esc)</button><button type="button" onClick={submit} disabled={busy} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-semibold">{busy ? 'Saving…' : 'Confirm (Enter)'}</button></div>
            </div>
        </div>
    );
}

const isAdminRole = (role) => role === 'admin' || role === 'shop_owner';

function RequestsPanel({ catalog, user, session, onComplete }) {
    const [mode, setMode] = useState('list');
    const [rows, setRows] = useState([]);
    const [reminders, setReminders] = useState([]);
    const [paybackList, setPaybackList] = useState([]);
    const [paymentDialog, setPaymentDialog] = useState(null);
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState('all');
    const [customer, setCustomer] = useState({ phone: '', name: '', idNumber: '', address: '', note: '' });
    const [requestLines, setRequestLines] = useState([]);
    const [lineSearch, setLineSearch] = useState('');
    const [advance, setAdvance] = useState('0');
    const [advanceMethod, setAdvanceMethod] = useState('CASH');
    const [expectedDate, setExpectedDate] = useState('');
    const [error, setError] = useState('');
    const [receipt, setReceipt] = useState(null);
    const [busy, setBusy] = useState(false);
    const token = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });
    const load = async () => {
        try {
            const query = new URLSearchParams({ q: search, status }).toString();
            const res = await fetch(`${API_BASE}/requests?${query}`, { headers: token() });
            if (!res.ok) throw new Error('Unable to load requests');
            setRows(await res.json());
        } catch (err) { setError(err.message); }
    };
    const loadReminders = async () => {
        try {
            const res = await fetch(`${API_BASE}/receivables/reminders`, { headers: token() });
            if (res.ok) setReminders(await res.json());
        } catch { /* reminders are best-effort while offline */ }
    };
    const loadPaybackList = async () => {
        try {
            const res = await fetch(`${API_BASE}/credits?status=OPEN`, { headers: token() });
            if (!res.ok) throw new Error('Unable to load Pay Later balances');
            setPaybackList(await res.json());
        } catch (err) {
            setError(err.message);
        }
    };
    useEffect(() => { load(); loadReminders(); loadPaybackList(); }, [search, status]);
    const lookupCustomer = async (phone) => {
        setCustomer((current) => ({ ...current, phone }));
        if (phone.trim().length < 3) return;
        try {
            const res = await fetch(`${API_BASE}/customers/lookup?phone=${encodeURIComponent(phone)}`, { headers: token() });
            const found = (await res.json())[0];
            if (found) setCustomer({ phone: found.phone, name: found.name || '', idNumber: found.id_number || '', address: found.address || '', note: found.note || '' });
        } catch { /* request can still be saved with a new customer */ }
    };
    const matchingLines = lineSearch.trim()
        ? catalog.filter((item) => `${item.displayName} ${item.code} ${item.meta}`.toLowerCase().includes(lineSearch.trim().toLowerCase())).slice(0, 8)
        : [];
    const addLine = (item) => {
        setRequestLines((current) => {
            const existing = current.find((line) => line.inventoryId === item.inventoryId && line.inventoryType === item.inventoryType);
            if (existing && item.trackedBy !== 'IMEI') return current.map((line) => line === existing ? { ...line, quantity: line.quantity + 1 } : line);
            return [...current, { inventoryType: item.inventoryType, inventoryId: item.inventoryId, name: item.displayName, code: item.code, quantity: 1, unit_price: item.price, tracked_by: item.trackedBy }];
        });
        setLineSearch('');
    };
    const addCustom = () => {
        const name = lineSearch.trim();
        if (!name) return;
        const price = window.prompt(`Price for "${name}"`, '0');
        if (price === null || Number(price) < 0) return;
        setRequestLines((current) => [...current, { inventoryType: 'custom', inventoryId: `custom-${Date.now()}`, name, code: '', quantity: 1, unit_price: Number(price), tracked_by: 'NONE' }]);
        setLineSearch('');
    };
    const saveRequest = async () => {
        setError('');
        if (!customer.phone.trim()) return setError('Customer phone is required.');
        if (!requestLines.length) return setError('Add at least one line.');
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/requests`, { method: 'POST', headers: { ...token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ...customer, id_number: customer.idNumber, items: requestLines, advance_amount: Number(advance || 0), advance_method: advanceMethod, expected_ready_date: expectedDate }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Unable to save request');
            setReceipt(data);
            setMode('receipt');
            await load();
        } catch (err) { setError(err.message); } finally { setBusy(false); }
    };
    const updateStatus = async (row, next) => {
        let body = { status: next };
        if (next === 'Cancelled') {
            const reason = window.prompt('Cancellation reason');
            if (!reason) return;
            const refund = window.confirm('Refund the advance? Cancel to keep it (admin only).');
            body = { status: next, reason, mode: refund ? 'refund' : 'keep' };
        }
        try {
            const res = await fetch(`${API_BASE}/requests/${row.id}/status`, { method: 'PATCH', headers: { ...token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Unable to update request');
            setRows((current) => current.map((item) => item.id === row.id ? data : item));
        } catch (err) { setError(err.message); }
    };
    const recordPayment = async (credit) => {
        setPaymentDialog({ credit, amount: String(credit.balance), method: 'CASH', error: '' });
    };
    const submitPayment = async () => {
        if (!paymentDialog) return;
        const amount = Number(paymentDialog.amount);
        if (!(amount > 0) || amount > Number(paymentDialog.credit.balance) + 0.01) {
            setPaymentDialog((current) => ({ ...current, error: 'Enter an amount greater than zero and no more than the outstanding balance.' }));
            return;
        }
        const res = await fetch(`${API_BASE}/credits/${paymentDialog.credit.id}/payments`, { method: 'POST', headers: { ...token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, method: paymentDialog.method, sessionId: session?.id }) });
        const data = await res.json();
        if (!res.ok) {
            setPaymentDialog((current) => ({ ...current, error: data.error || 'Unable to record payment' }));
            return;
        }
        setPaymentDialog(null);
        setReminders((current) => current.filter((item) => item.id !== data.id || data.balance > 0));
        setPaybackList((current) => data.balance > 0
            ? current.map((item) => item.id === data.id ? data : item)
            : current.filter((item) => item.id !== data.id));
    };
    const addCreditHistory = async (credit, type) => {
        const note = window.prompt(type === 'extend' ? 'New due date and note (YYYY-MM-DD | note)' : 'Call note');
        if (!note) return;
        const [date, ...parts] = note.split('|');
        const body = type === 'extend' ? { type, due_date: date.trim(), note: parts.join('|').trim() } : { type, note };
        const res = await fetch(`${API_BASE}/credits/${credit.id}/history`, { method: 'POST', headers: { ...token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) setError(data.error || 'Unable to update credit');
        else loadReminders();
    };
    const printRequest = async () => {
        if (!receipt) return;
        await printWithHiddenFrame({
            receipt_no: receipt.request_no,
            cashier_name: user?.name,
            customer_name: receipt.customer_name,
            customer_phone: receipt.customer_phone,
            items: receipt.items.map((item) => ({ name: item.name, quantity: item.quantity, unit_price: item.unit_price, line_total: item.unit_price * item.quantity })),
            subtotal: receipt.total,
            total: receipt.total,
            payment_method: receipt.advance_method || 'CASH',
            payment_details: { cash: receipt.advance_amount },
            amount_paid: receipt.advance_amount,
            balance_due: receipt.balance
        });
        setMode('list');
        setReceipt(null);
        setRequestLines([]);
        setCustomer({ phone: '', name: '', idNumber: '', address: '', note: '' });
    };
    if (mode === 'receipt') return <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border p-6"><h2 className="text-2xl font-bold">Request receipt</h2><p className="mt-2">{receipt.request_no} · {receipt.customer_name || 'Customer'} · {receipt.customer_phone}</p><p className="mt-2">Total {formatMoney(receipt.total)} · Advance {formatMoney(receipt.advance_amount)} · Balance {formatMoney(receipt.balance)}</p><p className="text-sm text-gray-500 mt-1">Expected: {receipt.expected_ready_date || 'Not set'}</p><div className="mt-6 flex gap-3"><button onClick={printRequest} className="px-4 py-2 rounded-xl bg-blue-600 text-white">Print receipt</button><button onClick={() => { setMode('list'); setReceipt(null); }} className="px-4 py-2 rounded-xl border">No receipt</button></div></div>;
    if (mode === 'create') return (
        <div className="space-y-5">
            <div className="flex items-center justify-between"><div><h2 className="text-xl font-bold">New request</h2><p className="text-sm text-gray-500">Phone is required. Other customer fields are optional.</p></div><button onClick={() => setMode('list')} className="px-3 py-2 rounded-xl border">Back</button></div>
            <div className="bg-white dark:bg-slate-800 rounded-3xl border p-5 grid md:grid-cols-2 gap-3">
                <label className="text-sm font-semibold">Phone *<input autoFocus value={customer.phone} onChange={(e) => lookupCustomer(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                <label className="text-sm font-semibold">Name<input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                <label className="text-sm font-semibold">ID / NIC<input value={customer.idNumber} onChange={(e) => setCustomer({ ...customer, idNumber: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                <label className="text-sm font-semibold">Address<input value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label>
                <label className="text-sm font-semibold md:col-span-2">Note<textarea value={customer.note} onChange={(e) => setCustomer({ ...customer, note: e.target.value })} className="mt-1 w-full rounded-xl border px-3 py-2.5" rows="2" /></label>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-3xl border p-5">
                <div className="relative"><Search className="absolute left-3 top-3 text-gray-400" size={17} /><input value={lineSearch} onChange={(e) => setLineSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setLineSearch(''); if (e.key === 'Enter' && matchingLines[0]) addLine(matchingLines[0]); }} placeholder="Search item, service, or requested item" className="w-full rounded-xl border pl-10 pr-3 py-2.5" />{lineSearch && <div className="absolute z-10 mt-1 w-full bg-white dark:bg-slate-800 rounded-xl border shadow-lg">{matchingLines.map((item) => <button key={`${item.inventoryType}-${item.inventoryId}`} onClick={() => addLine(item)} className="block w-full text-left px-3 py-2 hover:bg-blue-50">{item.displayName} · {formatMoney(item.price)}</button>)}{matchingLines.length === 0 && <button onClick={addCustom} className="block w-full text-left px-3 py-2 text-blue-600">Add as requested item / custom service…</button>}</div>}</div>
                <div className="mt-4 divide-y">{requestLines.map((line, index) => <div key={line.inventoryId} className="py-2 flex justify-between"><span>{line.quantity} × {line.name}</span><span>{formatMoney(line.unit_price * line.quantity)} <button onClick={() => setRequestLines((current) => current.filter((_, i) => i !== index))} className="ml-2 text-rose-600">×</button></span></div>)}</div>
                <div className="mt-4 flex justify-between font-bold"><span>Total</span><span>{formatMoney(requestLines.reduce((sum, line) => sum + line.unit_price * line.quantity, 0))}</span></div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-3xl border p-5 grid md:grid-cols-3 gap-3"><label className="text-sm font-semibold">Advance<input type="number" min="0" value={advance} onChange={(e) => setAdvance(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label><label className="text-sm font-semibold">Method<select value={advanceMethod} onChange={(e) => setAdvanceMethod(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5"><option value="CASH">Cash</option><option value="CARD">Card</option><option value="BANK_TRANSFER">Bank Transfer</option></select></label><label className="text-sm font-semibold">Expected ready date<input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className="mt-1 w-full rounded-xl border px-3 py-2.5" /></label></div>
            {error && <div className="text-sm text-rose-600">{error}</div>}<button onClick={saveRequest} disabled={busy} className="px-5 py-3 rounded-xl bg-blue-600 text-white font-semibold">{busy ? 'Saving…' : 'Save request (F10)'}</button>
        </div>
    );
    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-bold flex items-center gap-2"><ClipboardList size={20} /> Payback</h2><p className="text-sm text-gray-500">Track all Pay Later balances and collect payments.</p></div></div>
            {reminders.length > 0 && <div className="bg-amber-50 dark:bg-amber-500/10 rounded-3xl border border-amber-200 dark:border-amber-500/30 p-4"><h3 className="font-bold flex items-center gap-2"><Bell size={17} /> Due reminders ({reminders.length})</h3><div className="mt-3 space-y-2">{reminders.map((credit) => <div key={credit.id} className="bg-white dark:bg-slate-800 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2"><div><strong>{credit.customer_name || 'Customer'}</strong> · <a href={`tel:${credit.customer_phone}`} className="text-blue-600">{credit.customer_phone}</a><div className="text-xs text-gray-500">{credit.sale_receipt_no} · {formatMoney(credit.balance)} · due {credit.due_date} · {credit.days_overdue} days overdue</div></div><div className="flex gap-1"><button onClick={() => recordPayment(credit)} className="px-2 py-1 rounded-lg bg-blue-600 text-white text-xs">Record payment</button><button onClick={() => addCreditHistory(credit, 'extend')} className="px-2 py-1 rounded-lg border text-xs">Extend</button><button onClick={() => addCreditHistory(credit, 'call')} className="px-2 py-1 rounded-lg border text-xs">Call note</button></div></div>)}</div></div>}
            <div className="bg-white dark:bg-slate-800 rounded-3xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 className="font-bold">Pay Later / Payback list</h3>
                        <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">All customers with an outstanding balance.</p>
                    </div>
                    <strong className="text-amber-700 dark:text-amber-300">
                        Total due: {formatMoney(paybackList.reduce((sum, credit) => sum + Number(credit.balance || 0), 0))}
                    </strong>
                </div>
                <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 dark:bg-slate-950">
                            <tr>
                                <th className="px-3 py-2 text-left">Customer</th>
                                <th className="px-3 py-2 text-left">Receipt</th>
                                <th className="px-3 py-2 text-right">Original</th>
                                <th className="px-3 py-2 text-right">Paid</th>
                                <th className="px-3 py-2 text-right">Balance</th>
                                <th className="px-3 py-2 text-left">Due date</th>
                                <th className="px-3 py-2 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {paybackList.map((credit) => {
                                const overdue = credit.due_date && new Date(`${credit.due_date}T23:59:59`) < new Date();
                                return (
                                    <tr key={credit.id} className="border-t">
                                        <td className="px-3 py-2">
                                            <div className="font-semibold">{credit.customer_name || 'Customer'}</div>
                                            <a href={`tel:${credit.customer_phone}`} className="text-xs text-blue-600">{credit.customer_phone}</a>
                                        </td>
                                        <td className="px-3 py-2">{credit.sale_receipt_no || credit.note_no}</td>
                                        <td className="px-3 py-2 text-right">{formatMoney(credit.amount)}</td>
                                        <td className="px-3 py-2 text-right">{formatMoney(credit.amount_paid)}</td>
                                        <td className="px-3 py-2 text-right font-semibold text-amber-700 dark:text-amber-300">{formatMoney(credit.balance)}</td>
                                        <td className={`px-3 py-2 ${overdue ? 'text-rose-600 font-semibold' : ''}`}>{credit.due_date || '—'}{overdue ? ' · overdue' : ''}</td>
                                        <td className="px-3 py-2 text-right"><button onClick={() => recordPayment(credit)} className="px-2 py-1 rounded-lg bg-blue-600 text-white text-xs">Record payment</button></td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {paybackList.length === 0 && <div className="p-5 text-center text-sm text-gray-400">No outstanding Pay Later balances.</div>}
                </div>
            </div>
            {error && <div className="text-sm text-rose-600">{error}</div>}
            {paymentDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="presentation">
                    <div className="w-full max-w-md rounded-3xl bg-white dark:bg-slate-800 p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="record-payment-title">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h3 id="record-payment-title" className="text-xl font-bold">Record payment</h3>
                                <p className="mt-1 text-sm text-gray-500">{paymentDialog.credit.customer_name || 'Customer'} · {paymentDialog.credit.customer_phone}</p>
                            </div>
                            <button type="button" onClick={() => setPaymentDialog(null)} className="text-2xl text-gray-400" aria-label="Close">×</button>
                        </div>
                        <div className="mt-5 rounded-2xl bg-gray-50 dark:bg-slate-950 p-4 text-sm">
                            <div className="flex justify-between"><span>Receipt</span><strong>{paymentDialog.credit.sale_receipt_no || paymentDialog.credit.note_no}</strong></div>
                            <div className="mt-2 flex justify-between"><span>Outstanding balance</span><strong className="text-amber-700 dark:text-amber-300">{formatMoney(paymentDialog.credit.balance)}</strong></div>
                        </div>
                        <div className="mt-5 grid gap-3">
                            <label className="text-sm font-semibold">Payment amount
                                <input
                                    autoFocus
                                    type="text"
                                    inputMode="decimal"
                                    value={paymentDialog.amount}
                                    onChange={(event) => setPaymentDialog((current) => ({ ...current, amount: event.target.value, error: '' }))}
                                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitPayment(); } }}
                                    className="mt-1 w-full rounded-xl border px-3 py-2.5 dark:bg-slate-900"
                                />
                            </label>
                            <label className="text-sm font-semibold">Payment method
                                <select value={paymentDialog.method} onChange={(event) => setPaymentDialog((current) => ({ ...current, method: event.target.value }))} className="mt-1 w-full rounded-xl border px-3 py-2.5 dark:bg-slate-900">
                                    <option value="CASH">Cash</option>
                                    <option value="CARD">Card</option>
                                    <option value="BANK_TRANSFER">Bank Transfer</option>
                                </select>
                            </label>
                        </div>
                        {paymentDialog.error && <p className="mt-3 text-sm text-rose-600">{paymentDialog.error}</p>}
                        <div className="mt-6 flex justify-end gap-3">
                            <button type="button" onClick={() => setPaymentDialog(null)} className="rounded-xl border px-4 py-2 font-semibold">Cancel</button>
                            <button type="button" onClick={submitPayment} className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700">Confirm payment</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function SalesPage() {
    const { user } = useAuth();
    const { session } = useSession();
    const { syncNow } = useSync();

    const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';
    const hasCustomerAttachFeature = false;

    const searchInputRef = useRef(null);
    const cashInputRef = useRef(null);
    const splitInputRefs = useRef([]);
    const itemPriceInputRef = useRef(null);
    const itemQtyInputRef = useRef(null);

    const [activeTab, setActiveTab] = useState('billing');
    const [phones, setPhones] = useState([]);
    const [accessories, setAccessories] = useState([]);
    const [sales, setSales] = useState([]);
    const [config, setConfig] = useState({ discountApprovalLimitPercent: 10, payLaterLimit: 0 });
    const [inventoryLoading, setInventoryLoading] = useState(true);
    const [salesLoading, setSalesLoading] = useState(true);
    const [salesError, setSalesError] = useState('');
    const [offlineMode, setOfflineMode] = useState(!navigator.onLine);

    const [productSearch, setProductSearch] = useState('');
    const [selectedProductIndex, setSelectedProductIndex] = useState(0);
    const [focusArea, setFocusArea] = useState('search');
    const [selectedCartIndex, setSelectedCartIndex] = useState(0);

    const [cart, setCart] = useState([]);
    const [approvalNote, setApprovalNote] = useState('');
    const [checkoutError, setCheckoutError] = useState('');
    const [checkoutLoading, setCheckoutLoading] = useState(false);

    const [billingStep, setBillingStep] = useState('cart');
    const [paymentMethod, setPaymentMethod] = useState('CASH');
    const [cashReceived, setCashReceived] = useState('');
    const [paymentSplit, setPaymentSplit] = useState({ cash: '', card: '', bankTransfer: '' });
    const [receiptOptionIndex, setReceiptOptionIndex] = useState(0);
    const [completedReceipt, setCompletedReceipt] = useState(null);
    const [payLaterOpen, setPayLaterOpen] = useState(false);
    const [activeRequest, setActiveRequest] = useState(null);
    const [servicesModalOpen, setServicesModalOpen] = useState(false);
    const [standaloneServices, setStandaloneServices] = useState(false);

    const [historySearch, setHistorySearch] = useState('');
    const [historyCashierFilter, setHistoryCashierFilter] = useState('all');
    const [historySelectedIndex, setHistorySelectedIndex] = useState(0);
    const [refundMetaBySale, setRefundMetaBySale] = useState({});
    const [receipt, setReceipt] = useState(null);

    const [refundSale, setRefundSale] = useState(null);

    const [itemModal, setItemModal] = useState({
        open: false,
        mode: 'add',
        item: null,
        price: '',
        quantity: '1',
        error: '',
        focusQuantity: false
    });
    const [newSaleConfirmOpen, setNewSaleConfirmOpen] = useState(false);

    const focusSearch = () => {
        setTimeout(() => {
            if (searchInputRef.current) {
                searchInputRef.current.focus();
                searchInputRef.current.select();
            }
        }, 0);
    };

    useEffect(() => {
        const handleOnline = () => setOfflineMode(false);
        const handleOffline = () => setOfflineMode(true);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const catalog = useMemo(() => [
        ...phones.map((phone) => {
            const allCodes = [phone.imei, ...(phone.barcodes || [])];
            const primary = allCodes.find((c) => c && String(c).trim()) || phone.imei;
            return {
                inventoryType: 'phone',
                inventoryId: phone.id,
                code: primary,
                displayName: `${phone.brand} ${phone.model}`,
                price: safeNumber(phone.selling_price),
                listPrice: safeNumber(phone.selling_price),
                stock: phone.status === 'In Stock' ? 1 : 0,
                trackedBy: 'IMEI',
                category: phone.category || 'Phones',
                meta: `${phone.brand} ${phone.model} ${phone.imei}`,
                barcodes: allCodes,
                allowPriceOverride: true,
                source: phone
            };
        }),
        ...accessories.map((accessory) => {
            const allCodes = [accessory.sku, ...(accessory.barcodes || [])];
            const primary = allCodes.find((c) => c && String(c).trim()) || accessory.sku;
            return {
                inventoryType: 'accessory',
                inventoryId: accessory.id,
                code: primary,
                displayName: accessory.name,
                price: safeNumber(accessory.sell_price),
                listPrice: safeNumber(accessory.sell_price),
                stock: accessory.is_service ? Number.MAX_SAFE_INTEGER : safeNumber(accessory.quantity),
                trackedBy: accessory.is_service ? 'SERVICE' : 'QTY',
                category: accessory.category || 'Accessories',
                meta: `${accessory.name} ${accessory.sku} ${accessory.category}`,
                barcodes: allCodes,
                allowPriceOverride: accessory.allow_price_override !== false,
                source: accessory
            };
        })
    ], [phones, accessories]);

    const visibleProducts = useMemo(() => {
        const term = productSearch.trim().toLowerCase();
        if (!term) return catalog.slice(0, 12);

        return catalog
            .map((item) => {
                const codePool = (item.barcodes || []).concat([item.code]).map((c) => String(c || '').toLowerCase());
                let score = -1;
                if (codePool.includes(term)) score = 0;
                else if (codePool.some((c) => c.startsWith(term))) score = 1;
                else if (
                    codePool.some((c) => c.includes(term)) ||
                    item.displayName.toLowerCase().includes(term) ||
                    item.meta.toLowerCase().includes(term)
                ) score = 2;
                return { item, score };
            })
            .filter((entry) => entry.score >= 0)
            .sort((a, b) => a.score - b.score)
            .map((entry) => entry.item)
            .slice(0, 12);
    }, [catalog, productSearch]);
    const serviceCatalog = useMemo(() => catalog.filter((item) => item.source?.is_service), [catalog]);
    const serviceSales = useMemo(
        () => sales.filter((sale) => (sale.items || []).some((item) => item.inventory_type === 'service' || item.tracked_by === 'SERVICE')),
        [sales]
    );

    useEffect(() => {
        if (selectedProductIndex >= visibleProducts.length) setSelectedProductIndex(0);
    }, [visibleProducts, selectedProductIndex]);

    const listSubtotal = useMemo(
        () => cart.reduce((sum, item) => sum + (item.listPrice * item.quantity), 0),
        [cart]
    );
    const subtotal = useMemo(
        () => cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0),
        [cart]
    );
    const total = subtotal;
    const effectiveDiscount = Math.max(0, listSubtotal - total);
    const effectiveDiscountPercent = listSubtotal > 0 ? (effectiveDiscount / listSubtotal) * 100 : 0;
    const approvalRequired = effectiveDiscountPercent > config.discountApprovalLimitPercent && !isAdmin;
    const splitTotal = safeNumber(paymentSplit.cash) + safeNumber(paymentSplit.card) + safeNumber(paymentSplit.bankTransfer);
    const requestBalance = Math.max(0, total - Number(activeRequest?.advance_amount || 0));
    const cashChange = paymentMethod === 'CASH' ? Math.max(0, safeNumber(cashReceived) - requestBalance) : 0;

    const totalCost = useMemo(() => cart.reduce((sum, item) => sum + unitCostOf(item) * item.quantity, 0), [cart]);
    const costKnown = useMemo(
        () => cart.length > 0 && cart.every((item) => {
            const cost = item.inventoryType === 'phone' ? item.source?.purchase_price : item.source?.cost_price;
            return cost !== undefined && cost !== null && cost !== '';
        }),
        [cart]
    );
    const expectedProfit = total - totalCost;

    const uniqueCashiers = useMemo(() => {
        const seen = new Map();
        sales.forEach((sale) => {
            if (!seen.has(sale.cashier_id)) seen.set(sale.cashier_id, sale.cashier_name);
        });
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    }, [sales]);

    const currentReceiptCash = receipt && receipt.payment_method === 'CASH'
        ? getCashSummary(receipt)
        : { cashTendered: 0, changeAmount: 0 };

    const loadInventory = async () => {
        try {
            const token = localStorage.getItem('token');
            if (!navigator.onLine) {
                const cached = await getCachedInventory();
                setPhones(cached.phones);
                setAccessories(cached.accessories);
                setConfig({ discountApprovalLimitPercent: 10 });
                setOfflineMode(true);
                return;
            }

            const [phoneRes, accessoryRes, configRes] = await Promise.all([
                fetch(`${API_BASE}/inventory/phones`, { headers: { Authorization: `Bearer ${token}` } }),
                fetch(`${API_BASE}/inventory/accessories`, { headers: { Authorization: `Bearer ${token}` } }),
                fetch(`${API_BASE}/sales/config`, { headers: { Authorization: `Bearer ${token}` } })
            ]);

            if (phoneRes.ok && accessoryRes.ok) {
                const [serverPhones, serverAccessories] = await Promise.all([phoneRes.json(), accessoryRes.json()]);
                await applyServerInventorySnapshot({ phones: serverPhones, accessories: serverAccessories });
                const cached = await getCachedInventory();
                setPhones(cached.phones);
                setAccessories(cached.accessories);
            } else {
                if (phoneRes.ok) setPhones(await phoneRes.json());
                if (accessoryRes.ok) {
                    await applyServerInventorySnapshot({ accessories: await accessoryRes.json() });
                    setAccessories((await getCachedInventory()).accessories);
                }
            }
            if (configRes.ok) setConfig(await configRes.json());
        } catch (err) {
            try {
                const cached = await getCachedInventory();
                setPhones(cached.phones);
                setAccessories(cached.accessories);
                setOfflineMode(true);
            } catch (cacheErr) {
                console.error('Both network and local inventory failed:', cacheErr);
            }
        } finally {
            setInventoryLoading(false);
        }
    };

    const loadSales = async () => {
        try {
            const token = localStorage.getItem('token');
            const query = new URLSearchParams();
            if (historySearch.trim()) query.set('q', historySearch.trim());
            if (isAdmin && historyCashierFilter !== 'all') query.set('cashierId', historyCashierFilter);

            const res = await fetch(`${API_BASE}/sales?${query.toString()}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (res.ok) {
                const serverSales = await res.json();
                const { getRecentOfflineSales } = await import('../db/database');
                const localSales = await getRecentOfflineSales(100);
                const pendingLocalSales = localSales.filter((local) => local.syncStatus !== 'synced');
                const merged = [
                    ...pendingLocalSales.map((local) => ({
                        id: local.id,
                        receipt_no: local.receipt_no,
                        cashier_id: local.cashier_id,
                        cashier_name: local.cashier_name,
                        items: local.items,
                        subtotal: local.subtotal,
                        discount_amount: local.discount_amount,
                        total: local.total,
                        payment_method: local.payment_method,
                        created_at: local.created_at,
                        pending_sync: local.syncStatus === 'pending',
                        syncStatus: local.syncStatus || 'pending',
                        approval_required: local.approval_required || false
                    })),
                    ...serverSales
                ];
                const seen = new Set();
                const deduped = merged.filter((sale) => {
                    const key = sale.receipt_no || sale.id;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                setSales(deduped);
                setSalesError('');
            } else if (res.status === 401) {
                setSalesError('Your session has expired. Please sign in again to load sales history.');
            } else {
                const errData = await res.json().catch(() => ({}));
                setSalesError(errData.error || 'Unable to load sales history from the server.');
            }
        } catch (err) {
            setSalesError('You appear to be offline - showing locally saved sales only.');
            try {
                const { getRecentOfflineSales } = await import('../db/database');
                const localSales = await getRecentOfflineSales(100);
                setSales(localSales.map((local) => ({
                    id: local.id,
                    receipt_no: local.receipt_no,
                    cashier_id: local.cashier_id,
                    cashier_name: local.cashier_name,
                    items: local.items,
                    subtotal: local.subtotal,
                    discount_amount: local.discount_amount,
                    total: local.total,
                    payment_method: local.payment_method,
                    created_at: local.created_at,
                    pending_sync: local.syncStatus === 'pending',
                    syncStatus: local.syncStatus || 'pending',
                    approval_required: local.approval_required || false
                })));
            } catch (cacheErr) {
                console.error('Failed to load local sales:', cacheErr);
            }
        } finally {
            setSalesLoading(false);
        }
    };

    useEffect(() => {
        loadInventory();
    }, []);

    useEffect(() => {
        loadSales();
        const timer = setInterval(loadSales, 15000);
        return () => clearInterval(timer);
    }, [historySearch, historyCashierFilter, isAdmin]);

    useEffect(() => {
        if (!receipt) return;
        setSales((current) => [receipt, ...current.filter((sale) => sale.id !== receipt.id)]);
    }, [receipt]);

    useEffect(() => {
        if (activeTab !== 'history' || sales.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const token = localStorage.getItem('token');
                const targets = sales.slice(0, 60);
                const requests = targets.map((sale) =>
                    fetch(`${API_BASE}/refunds?saleId=${encodeURIComponent(sale.id)}&limit=100`, {
                        headers: { Authorization: `Bearer ${token}` }
                    })
                        .then((res) => res.ok ? res.json() : { refunds: [] })
                        .then((data) => ({ saleId: sale.id, refunds: Array.isArray(data.refunds) ? data.refunds : [] }))
                        .catch(() => ({ saleId: sale.id, refunds: [] }))
                );
                const results = await Promise.all(requests);
                if (cancelled) return;
                const next = {};
                results.forEach(({ saleId, refunds }) => {
                    const applied = refunds.filter((r) => ['DIRECT', 'APPROVED'].includes(r.approval_status));
                    const totalQty = applied.reduce((sum, r) => sum + (r.items || []).reduce((acc, it) => acc + Number(it.quantity || 0), 0), 0);
                    const latest = applied.length > 0 ? applied[0] : null;
                    next[saleId] = {
                        count: applied.length,
                        totalQty,
                        latest
                    };
                });
                setRefundMetaBySale(next);
            } catch (err) {
                if (!cancelled) setRefundMetaBySale({});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTab, sales]);

    useEffect(() => {
        if (activeTab === 'billing' && billingStep === 'cart' && !itemModal.open && !newSaleConfirmOpen) {
            focusSearch();
        }
    }, [activeTab, billingStep, itemModal.open, newSaleConfirmOpen]);

    useEffect(() => {
        if (!itemModal.open) return;
        const target = itemModal.focusQuantity ? itemQtyInputRef.current : itemPriceInputRef.current;
        setTimeout(() => {
            if (target) {
                target.focus();
                target.select();
            }
        }, 0);
    }, [itemModal.open, itemModal.focusQuantity]);

    useEffect(() => {
        if (billingStep !== 'payment') return;
        if (paymentMethod === 'CASH') {
            const due = Math.max(0, total - Number(activeRequest?.advance_amount || 0));
            setCashReceived(due > 0 ? due.toFixed(2) : '0.00');
            setTimeout(() => {
                if (cashInputRef.current) {
                    cashInputRef.current.focus();
                    cashInputRef.current.select();
                }
            }, 0);
        }
    }, [billingStep, paymentMethod, total, activeRequest]);

    const openItemModal = (baseItem, mode = 'add', focusQuantity = false) => {
        const line = mode === 'edit' ? baseItem : null;
        const product = mode === 'edit'
            ? {
                ...baseItem,
                displayName: baseItem.name,
                price: baseItem.listPrice,
                listPrice: baseItem.listPrice,
                allowPriceOverride: baseItem.allowPriceOverride,
                category: baseItem.category
            }
            : baseItem;
        setItemModal({
            open: true,
            mode,
            item: {
                inventoryType: product.inventoryType,
                inventoryId: product.inventoryId,
                code: product.code,
                displayName: product.displayName,
                listPrice: product.listPrice,
                stock: product.stock,
                trackedBy: product.trackedBy,
                category: product.category,
                allowPriceOverride: product.allowPriceOverride !== false,
                source: product.source
            },
            price: mode === 'edit' ? String(line.unitPrice) : String(product.price),
            quantity: mode === 'edit' ? String(line.quantity) : '1',
            error: '',
            focusQuantity
        });
    };

    const closeItemModal = () => {
        setItemModal((current) => ({ ...current, open: false, error: '' }));
        focusSearch();
    };

    const exactCodeMatch = (term) => {
        const lower = term.trim().toLowerCase();
        if (!lower) return null;
        return catalog.find((product) => {
            const codes = (product.barcodes || []).concat([product.code]).map((c) => String(c || '').trim().toLowerCase());
            return codes.includes(lower);
        }) || null;
    };

    const handleSelectProduct = (product) => {
        if (!product) return;
        openItemModal(product, 'add');
    };

    const addCustomService = () => {
        const name = productSearch.trim();
        if (!name) return;
        const price = window.prompt(`Price for "${name}"`, '0');
        if (price === null || Number(price) < 0) return;
        setCart((current) => [...current, {
            inventoryType: 'service',
            inventoryId: `custom-${Date.now()}`,
            code: 'CUSTOM',
            name,
            unitPrice: Number(price),
            listPrice: Number(price),
            quantity: 1,
            trackedBy: 'SERVICE',
            stock: Number.MAX_SAFE_INTEGER,
            category: 'Services',
            allowPriceOverride: true,
            source: { is_service: true, cost_price: 0 }
        }]);
        setProductSearch('');
        setSelectedProductIndex(0);
    };

    const updateCartQuantity = (line, nextQuantity) => {
        if (!line || line.trackedBy === 'IMEI') return;
        const normalized = Math.min(Math.max(1, nextQuantity), line.stock);
        setCart((current) => current.map((item) => (
            item.inventoryId === line.inventoryId && item.inventoryType === line.inventoryType
                ? { ...item, quantity: normalized }
                : item
        )));
    };

    const removeCartItem = (line) => {
        if (!line) return;
        setCart((current) => current.filter((item) => !(item.inventoryId === line.inventoryId && item.inventoryType === line.inventoryType)));
        setSelectedCartIndex((prev) => Math.max(0, Math.min(prev, cart.length - 2)));
    };

    const applyItemModal = () => {
        const item = itemModal.item;
        if (!item) return;

        const quantity = item.trackedBy === 'IMEI' ? 1 : Math.max(1, Math.floor(Number(itemModal.quantity || 1)));
        const enteredPrice = safeNumber(itemModal.price);
        const listPrice = safeNumber(item.listPrice);
        const allowPriceOverride = item.allowPriceOverride !== false;
        const costPrice = unitCostOf(item);
        const dropPercent = listPrice > 0 ? ((listPrice - enteredPrice) / listPrice) * 100 : 0;

        if (!allowPriceOverride && Math.abs(enteredPrice - listPrice) > 0.0001) {
            setItemModal((current) => ({ ...current, error: 'Price override is disabled for this item.' }));
            return;
        }
        if (enteredPrice < 0) {
            setItemModal((current) => ({ ...current, error: 'Price must be zero or higher.' }));
            return;
        }
        if (enteredPrice > listPrice + 0.0001) {
            setItemModal((current) => ({ ...current, error: 'Price cannot be higher than the listed selling price.' }));
            return;
        }
        if (item.trackedBy === 'QTY' && quantity > item.stock) {
            setItemModal((current) => ({ ...current, error: `Only ${item.stock} in stock.` }));
            return;
        }
        if (item.trackedBy === 'IMEI') {
            const duplicate = cart.some((line) => line.inventoryType === item.inventoryType && line.inventoryId === item.inventoryId);
            const editingSame = itemModal.mode === 'edit' && cart[selectedCartIndex]?.inventoryId === item.inventoryId && cart[selectedCartIndex]?.inventoryType === item.inventoryType;
            if (duplicate && !editingSame) {
                setItemModal((current) => ({ ...current, error: 'This IMEI item is already in the cart.' }));
                return;
            }
        }

        if (dropPercent > config.discountApprovalLimitPercent && !isAdmin && enteredPrice < listPrice) {
            setApprovalNote((prev) => prev || 'Price reduction above approval limit.');
        }
        if (enteredPrice < costPrice && !isAdmin) {
            setItemModal((current) => ({ ...current, error: 'Price not allowed, needs admin approval.' }));
            return;
        }

        const linePayload = {
            inventoryType: item.inventoryType,
            inventoryId: item.inventoryId,
            code: item.code,
            name: item.displayName,
            unitPrice: allowPriceOverride ? enteredPrice : listPrice,
            listPrice,
            quantity,
            trackedBy: item.trackedBy,
            stock: item.stock,
            category: item.category,
            allowPriceOverride,
            source: item.source
        };

        setCart((current) => {
            const existingIndex = current.findIndex((line) => line.inventoryType === item.inventoryType && line.inventoryId === item.inventoryId);
            const next = [...current];
            if (itemModal.mode === 'edit') {
                if (existingIndex >= 0) {
                    const merged = { ...next[existingIndex], ...linePayload };
                    if (merged.trackedBy === 'QTY' && merged.quantity > merged.stock) {
                        setItemModal((prev) => ({ ...prev, error: `Only ${merged.stock} in stock.` }));
                        return current;
                    }
                    next[existingIndex] = merged;
                    return next;
                }
                return current;
            }

            if (existingIndex >= 0 && linePayload.trackedBy === 'QTY') {
                const existing = next[existingIndex];
                const mergedQty = existing.quantity + linePayload.quantity;
                if (mergedQty > existing.stock) {
                    setItemModal((prev) => ({ ...prev, error: `Only ${existing.stock} in stock.` }));
                    return current;
                }
                next[existingIndex] = { ...existing, quantity: mergedQty, unitPrice: linePayload.unitPrice, listPrice: linePayload.listPrice };
                return next;
            }
            next.push(linePayload);
            return next;
        });

        setProductSearch('');
        closeItemModal();
    };

    const clearSale = () => {
        setCart([]);
        setCashReceived('');
        setPaymentSplit({ cash: '', card: '', bankTransfer: '' });
        setApprovalNote('');
        setCheckoutError('');
        setBillingStep('cart');
        setPaymentMethod('CASH');
        setCompletedReceipt(null);
        setActiveRequest(null);
        setSelectedCartIndex(0);
        setFocusArea('search');
        setProductSearch('');
        focusSearch();
    };

    const persistSale = async () => {
        setCheckoutError('');
        if (!session && navigator.onLine) {
            setCheckoutError('You must Open a Day Session before completing sales.');
            return null;
        }
        if (cart.length === 0) {
            setCheckoutError('Add at least one item before checkout.');
            return null;
        }
        if (paymentMethod === 'CASH' && safeNumber(cashReceived) < requestBalance - 0.01) {
            setCheckoutError('Cash received must cover the total amount.');
            return null;
        }
        if (paymentMethod === 'SPLIT' && Math.abs(splitTotal - total) > 0.01) {
            setCheckoutError('Split payment amounts must match the sale total.');
            return null;
        }

        const paymentDetails = paymentMethod === 'CASH'
            ? {
                cash: safeNumber(cashReceived),
                cashReceived: safeNumber(cashReceived),
                change: Math.max(0, safeNumber(cashReceived) - requestBalance),
                change_amount: Math.max(0, safeNumber(cashReceived) - requestBalance)
            }
            : paymentMethod === 'SPLIT'
                ? {
                    cash: safeNumber(paymentSplit.cash),
                    card: safeNumber(paymentSplit.card),
                    bankTransfer: safeNumber(paymentSplit.bankTransfer)
                }
                : null;

        const localReceipt = buildLocalReceipt({
            user,
            session,
            cart,
            paymentMethod,
            cashReceived,
            paymentDetails
        });
        localReceipt.pending_sync = !navigator.onLine;

        const payloadForServer = {
            items: cart.map((item) => ({
                inventoryType: item.inventoryType,
                inventoryId: item.inventoryId,
                quantity: item.inventoryType === 'phone' ? 1 : item.quantity,
                unitPrice: item.unitPrice,
                costPrice: isAdmin ? safeNumber(item.source?.cost_price) : 0,
                name: item.name
            })),
            paymentMethod,
            cashReceived: paymentMethod === 'CASH' ? safeNumber(cashReceived) : 0,
            paymentDetails,
            discountAmount: effectiveDiscount,
            approvalNote: approvalNote.trim() || (approvalRequired ? 'Price/discount exceeded approval limit.' : null),
            sessionId: session?.id || null,
            clientLocalId: localReceipt.clientLocalId,
            requestId: activeRequest?.id || ''
        };

        setCheckoutLoading(true);
        try {
            const localKey = await addPendingSale(localReceipt);
            let savedReceipt = { ...localReceipt, id: localKey };
            setReceipt(savedReceipt);

            const token = localStorage.getItem('token');
            if (navigator.onLine && token) {
                    try {
                        const res = await fetch(`${API_BASE}/sales/checkout`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${token}`
                            },
                            body: JSON.stringify(payloadForServer)
                        });
                        const responseText = await res.text();
                        let data = {};
                        try {
                            data = responseText ? JSON.parse(responseText) : {};
                        } catch {
                            data = { error: responseText };
                        }
                        if (!res.ok) throw new Error(data.error || 'Unable to save sale');
                        const { markSaleSynced } = await import('../db/database');
                        const serverReceipt = data?.receipt || data?.sale;
                        await markSaleSynced(localKey, serverReceipt?.id || null);
                        savedReceipt = { ...serverReceipt, id: serverReceipt?.id || localKey, pending_sync: false };
                        setReceipt(savedReceipt);
                        await refreshInventoryCache();
                        loadSales();
                        syncNow();
                    } catch (err) {
                        console.warn('Online checkout failed; keeping the sale pending for sync:', err);
                        savedReceipt = { ...savedReceipt, pending_sync: true };
                        setReceipt(savedReceipt);
                    }
            }

            await loadInventory();
            return savedReceipt;
        } catch (err) {
            console.error('Checkout failed:', err);
            setCheckoutError(err.message || 'Checkout failed');
            return null;
        } finally {
            setCheckoutLoading(false);
        }
    };

    // Ref guard: a held Enter key can fire several keydown events before React state updates.
    const confirmingRef = useRef(false);

    const handleConfirmPayment = async () => {
        if (confirmingRef.current || checkoutLoading || completedReceipt) return;
        confirmingRef.current = true;
        try {
            const savedReceipt = await persistSale();
            if (!savedReceipt) return;
            setCompletedReceipt(savedReceipt);
            setReceiptOptionIndex(0);
            setBillingStep('receipt-options');
        } finally {
            confirmingRef.current = false;
        }
    };

    const executeReceiptOption = async (optionKey) => {
        if (!completedReceipt) return;
        try {
            // "Save as PDF" uses the browser print dialog's PDF destination.
            if (optionKey === 'PRINT_RECEIPT' || optionKey === 'SAVE_PDF') {
                await printWithHiddenFrame(completedReceipt, 'receipt');
            } else if (optionKey === 'PRINT_INVOICE') {
                await printWithHiddenFrame(completedReceipt, 'invoice');
            }
        } catch (err) {
            // Sale is already saved: tell the cashier and let them retry or choose "No receipt".
            console.warn('Printing failed, sale is already saved:', err);
            setCheckoutError('Printing failed. The sale is saved - try again or choose "No receipt".');
            return;
        }
        clearSale();
    };

    const openPaymentStep = () => {
        if (cart.length === 0) {
            setCheckoutError('Add at least one item before payment.');
            return;
        }
        setCheckoutError('');
        setPaymentMethod('CASH');
        setBillingStep('payment');
    };

    const openPayLater = () => {
        if (cart.length === 0) {
            setCheckoutError('Add at least one item before payment.');
            return;
        }
        setCheckoutError('');
        setPayLaterOpen(true);
    };

    const openServices = (standalone = false) => {
        setStandaloneServices(standalone);
        setServicesModalOpen(true);
    };

    const acceptServiceLines = (lines) => {
        setServicesModalOpen(false);
        if (standaloneServices) {
            setCart(lines);
            setActiveTab('billing');
            setBillingStep('payment');
            setPaymentMethod('CASH');
            setCashReceived('');
        } else {
            setCart((current) => [...current, ...lines]);
        }
    };

    const completePayLater = (savedReceipt) => {
        setPayLaterOpen(false);
        setReceipt(savedReceipt);
        setCompletedReceipt(savedReceipt);
        setReceiptOptionIndex(0);
        setBillingStep('receipt-options');
        loadInventory();
        loadSales();
    };

    const completeRequest = (request) => {
        const lines = (request.items || []).map((item) => {
            const catalogItem = catalog.find((candidate) => String(candidate.inventoryId) === String(item.inventoryId));
            return catalogItem ? {
                ...catalogItem,
                name: item.name || catalogItem.displayName,
                unitPrice: Number(item.unit_price || catalogItem.price),
                listPrice: Number(item.unit_price || catalogItem.price),
                quantity: Number(item.quantity || 1)
            } : {
                inventoryType: item.inventoryType || 'service',
                inventoryId: item.inventoryId || `custom-${Date.now()}`,
                code: item.code || 'CUSTOM',
                name: item.name,
                unitPrice: Number(item.unit_price || 0),
                listPrice: Number(item.unit_price || 0),
                quantity: Number(item.quantity || 1),
                trackedBy: 'SERVICE',
                stock: Number.MAX_SAFE_INTEGER,
                allowPriceOverride: true,
                source: { is_service: true, cost_price: 0 }
            };
        });
        setCart(lines);
        setActiveRequest(request);
        setActiveTab('billing');
        setBillingStep('cart');
        setCheckoutError(`Completing ${request.request_no}. Advance already paid: ${formatMoney(request.advance_amount)}.`);
    };

    const handleSearchKeyDown = (event) => {
        if (event.key === 'Escape') {
            if (productSearch) {
                event.preventDefault();
                event.stopPropagation();
                setProductSearch('');
                setSelectedProductIndex(0);
            }
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!productSearch.trim() && cart.length > 0) {
                searchInputRef.current?.blur(); // otherwise the search input keeps swallowing the cart keys
                setFocusArea('cart');
                setSelectedCartIndex(0);
                return;
            }
            if (visibleProducts.length > 0) {
                setSelectedProductIndex((prev) => Math.min(prev + 1, visibleProducts.length - 1));
            }
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (visibleProducts.length > 0) {
                setSelectedProductIndex((prev) => Math.max(0, prev - 1));
            }
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (event.repeat || inventoryLoading) return;
            const now = Date.now();
            if (now - lastSearchEnterRef.current < 300) return;
            lastSearchEnterRef.current = now;
            const exact = exactCodeMatch(productSearch);
            if (exact) {
                handleSelectProduct(exact);
                return;
            }
            const index = Math.min(selectedProductIndex, visibleProducts.length - 1);
            const selected = visibleProducts[index];
            if (selected) handleSelectProduct(selected);
        }
    };

    const lastSearchEnterRef = useRef(0);
    const productListRef = useRef(null);

    // Keep the highlighted result visible and the index inside the list.
    useEffect(() => {
        if (selectedProductIndex > 0 && selectedProductIndex >= visibleProducts.length) {
            setSelectedProductIndex(Math.max(0, visibleProducts.length - 1));
            return;
        }
        productListRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [selectedProductIndex, visibleProducts]);

    const selectedCartLine = cart[selectedCartIndex] || null;

    useEffect(() => {
        if (selectedCartIndex >= cart.length) setSelectedCartIndex(Math.max(0, cart.length - 1));
    }, [cart, selectedCartIndex]);

    const handleRefund = (sale) => {
        if (sale.refunded) return;
        if (sale.pending_sync || sale.syncStatus === 'pending') {
            alert('This sale has not finished syncing yet. Wait for it to sync before refunding.');
            return;
        }
        if (!navigator.onLine) {
            alert('Refunds require an online connection.');
            return;
        }
        setSalesError('');
        setRefundSale(sale);
    };

    // Always points at the newest handler so the single window listener never
    // runs with stale cart/step state.
    const globalKeyHandlerRef = useRef(null);

    useEffect(() => {
        if (activeTab !== 'billing') return undefined;
        const listener = (event) => globalKeyHandlerRef.current?.(event);
        window.addEventListener('keydown', listener);
        return () => window.removeEventListener('keydown', listener);
    }, [activeTab]);

    globalKeyHandlerRef.current = (event) => {
        // A more specific handler (modal inputs, payment row, search box ...) already handled this key.
        if (event.defaultPrevented) return;
        // Leave browser/OS combos alone (Ctrl+F3, Cmd+..., ...).
        if (event.ctrlKey || event.metaKey) return;

        const key = event.key;
        const target = event.target;
        const tag = target?.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
        const focusIsOnPage = target === document.body || target === document.documentElement;
        const isFKey = ['F2', 'F3', 'F4', 'F7', 'F8', 'F9', 'F10'].includes(key);

        // 1) "Start a new sale?" dialog: Enter clears, Esc cancels
        if (newSaleConfirmOpen) {
            if (isFKey) event.preventDefault();
            if (key === 'Enter') {
                event.preventDefault();
                if (event.repeat) return;
                setNewSaleConfirmOpen(false);
                clearSale();
            } else if (key === 'Escape') {
                event.preventDefault();
                setNewSaleConfirmOpen(false);
                focusSearch();
            }
            return;
        }

        // 2) Add/Edit item popup (its inputs handle Enter/Esc themselves; this covers lost focus)
        if (itemModal.open) {
            if (isFKey) event.preventDefault();
            if (key === 'Escape') {
                event.preventDefault();
                closeItemModal();
            } else if (key === 'Enter' && focusIsOnPage && !event.repeat) {
                event.preventDefault();
                applyItemModal();
            }
            return;
        }

        // 3) Payment step
        if (billingStep === 'payment') {
            if (isFKey) {
                event.preventDefault();
                return;
            }
            if (key === 'Escape') {
                event.preventDefault();
                setCheckoutError('');
                setBillingStep('cart');
                setFocusArea('search');
                return;
            }
            // Focus can fall back to <body> (e.g. after Alt+2 hides the cash input): keep the keys alive.
            if (focusIsOnPage && !(event.repeat && key === 'Enter')) handlePaymentKeyDown(event);
            return;
        }

        // 4) Receipt options step (Esc = "No receipt")
        if (billingStep === 'receipt-options') {
            if (isFKey) {
                event.preventDefault();
                return;
            }
            if (event.repeat) return;
            if (key === 'Escape') {
                event.preventDefault();
                executeReceiptOption('NO_RECEIPT');
                return;
            }
            if (focusIsOnPage) handleReceiptOptionKeyDown(event);
            return;
        }

        // 5) Cart step
        if (event.altKey) return;

        // Function keys work everywhere on this step, even while typing in the search box.
        if (isFKey) {
            event.preventDefault(); // stops the browser's own F-key action (F3 = find, ...)
            if (event.repeat) return;

            if (key === 'F10') {
                openPaymentStep();
                return;
            }
            if (key === 'F9') {
                openServices(false);
                return;
            }
            if (key === 'F3') {
                setFocusArea('search');
                focusSearch();
                return;
            }
            if (key === 'F4') {
                if (!selectedCartLine) return;
                setFocusArea('cart');
                document.activeElement?.blur?.();
                openItemModal(selectedCartLine, 'edit', selectedCartLine.trackedBy !== 'IMEI');
                return;
            }
            if (key === 'F8') {
                if (cart.length === 0) {
                    clearSale();
                    return;
                }
                document.activeElement?.blur?.();
                setNewSaleConfirmOpen(true);
                return;
            }
            return; // F7 (attach customer) is not available yet
        }

        if (key === 'Escape') {
            // Esc inside the discount box (or any input except search) goes back to search.
            if (typing && target !== searchInputRef.current) {
                event.preventDefault();
                target.blur();
                setFocusArea('search');
                focusSearch();
                return;
            }
            if (focusArea === 'cart') {
                event.preventDefault();
                setFocusArea('search');
                focusSearch();
            }
            return;
        }

        // Cart navigation: only when focus is in the cart (search box is blurred) and nothing is being typed.
        if (focusArea === 'cart' && !typing && cart.length > 0) {
            if (key === 'ArrowDown') {
                event.preventDefault();
                setSelectedCartIndex((prev) => Math.min(prev + 1, cart.length - 1));
                return;
            }
            if (key === 'ArrowUp') {
                event.preventDefault();
                if (selectedCartIndex === 0) {
                    setFocusArea('search');
                    focusSearch();
                } else {
                    setSelectedCartIndex((prev) => Math.max(0, prev - 1));
                }
                return;
            }
            if (key === 'Enter') {
                event.preventDefault();
                if (!event.repeat && selectedCartLine) openItemModal(selectedCartLine, 'edit', false);
                return;
            }
            if (key === 'Delete') {
                event.preventDefault();
                if (!selectedCartLine) return;
                removeCartItem(selectedCartLine);
                if (cart.length <= 1) {
                    setFocusArea('search');
                    focusSearch();
                }
                return;
            }
            if ((key === '+' || key === '=') && selectedCartLine) {
                event.preventDefault();
                updateCartQuantity(selectedCartLine, selectedCartLine.quantity + 1);
                return;
            }
            if ((key === '-' || key === '_') && selectedCartLine) {
                event.preventDefault();
                updateCartQuantity(selectedCartLine, selectedCartLine.quantity - 1);
            }
        }
    };

    useEffect(() => {
        if (activeTab !== 'history' || refundSale) return undefined;
        const onHistoryKey = (event) => {
            const key = event.key;
            const tag = event.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            if (['F2', 'F3', 'F4', 'F8', 'F10'].includes(key)) {
                event.preventDefault();
                return;
            }
            if (key === 'ArrowDown') {
                event.preventDefault();
                setHistorySelectedIndex((prev) => Math.min(prev + 1, Math.max(0, sales.length - 1)));
                return;
            }
            if (key === 'ArrowUp') {
                event.preventDefault();
                setHistorySelectedIndex((prev) => Math.max(0, prev - 1));
                return;
            }
            if (key === 'Enter') {
                const selectedSale = sales[historySelectedIndex];
                if (selectedSale && !selectedSale.refunded && !(selectedSale.pending_sync || selectedSale.syncStatus === 'pending')) {
                    event.preventDefault();
                    handleRefund(selectedSale);
                }
            }
        };
        window.addEventListener('keydown', onHistoryKey);
        return () => window.removeEventListener('keydown', onHistoryKey);
    }, [activeTab, refundSale, sales, historySelectedIndex]);

    const paymentIndex = PAYMENT_METHODS.findIndex((method) => method.value === paymentMethod);

    const handlePaymentKeyDown = (event) => {
        const typingInInput = event.target instanceof HTMLInputElement
            || event.target instanceof HTMLTextAreaElement
            || event.target?.tagName === 'SELECT';

        // Down/Right = next method, Up/Left = previous method.
        // While typing in an input, Left/Right must keep moving the text cursor, so only Up/Down cycle there.
        if (event.key === 'ArrowDown' || (!typingInInput && event.key === 'ArrowRight')) {
            event.preventDefault();
            const next = (paymentIndex + 1) % PAYMENT_METHODS.length;
            setPaymentMethod(PAYMENT_METHODS[next].value);
            return;
        }
        if (event.key === 'ArrowUp' || (!typingInInput && event.key === 'ArrowLeft')) {
            event.preventDefault();
            const next = (paymentIndex - 1 + PAYMENT_METHODS.length) % PAYMENT_METHODS.length;
            setPaymentMethod(PAYMENT_METHODS[next].value);
            return;
        }
        // Alt+1-4 selects a payment method directly (use code so numpad and main row both work).
        if (event.altKey && ['1', '2', '3', '4'].includes(event.code.at(-1))) {
            event.preventDefault();
            const method = PAYMENT_METHODS[Number(event.code.at(-1)) - 1].value;
            setPaymentMethod(method);
            return;
        }
        // Enter confirms from every payment field, including Cash received
        // and Split Payment inputs. Do this before the typing guard below.
        if (event.key === 'Enter') {
            event.preventDefault();
            if (!event.repeat) handleConfirmPayment();
            return;
        }
        // 1-4 (main row or numpad) select a method directly from the method row (not an input).
        if (typingInInput) {
            // While typing in the Cash received input, digits must type normally (no method switch).
            return;
        }
        if (event.key === '5') {
            event.preventDefault();
            openPayLater();
            return;
        }
        if (['1', '2', '3', '4'].includes(event.key)) {
            event.preventDefault();
            setPaymentMethod(PAYMENT_METHODS[Number(event.key) - 1].value);
            return;
        }
    };

    const handleReceiptOptionKeyDown = (event) => {
        if (event.repeat) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            setReceiptOptionIndex((prev) => (prev + 1) % RECEIPT_OPTIONS.length);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            setReceiptOptionIndex((prev) => (prev - 1 + RECEIPT_OPTIONS.length) % RECEIPT_OPTIONS.length);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            executeReceiptOption(RECEIPT_OPTIONS[receiptOptionIndex].key);
        }
    };

    return (
        <div className="space-y-6 pb-20">
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Sales / Billing</h1>
                    <p className="text-gray-500 dark:text-slate-400 mt-1">Scan products, build the cart, and complete checkout against the local store first.</p>
                </div>
                <div className="flex gap-2 bg-white dark:bg-slate-800 p-1 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800">
                    <button onClick={() => setActiveTab('billing')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${activeTab === 'billing' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-300'}`}>
                        Billing
                    </button>
                    <button onClick={() => setActiveTab('history')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${activeTab === 'history' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-300'}`}>
                        <History size={16} />
                        History
                    </button>
                    <button onClick={() => setActiveTab('requests')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${activeTab === 'requests' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-300'}`}>
                        <ClipboardList size={16} />
                                Payback
                    </button>
                    <button onClick={() => setActiveTab('services')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${activeTab === 'services' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-300'}`}>
                        <Plus size={16} />
                        Services
                    </button>
                </div>
            </div>

            {offlineMode && (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm">
                    <WifiOff size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div>
                        <p className="font-bold text-amber-800 dark:text-amber-200">Offline billing is active.</p>
                        <p className="text-amber-700 dark:text-amber-300 mt-1">Sales are saved locally first and sync to the cloud when internet returns.</p>
                    </div>
                </div>
            )}

            {activeTab === 'billing' ? (
                <div className="space-y-6">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                        <div className="mb-3">
                            <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
                                <PackageSearch size={20} className="text-blue-600" />
                                Search &amp; Scan Product
                            </h2>
                            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Name, SKU, barcode, or IMEI. Enter selects, Down enters cart when search is empty.</p>
                        </div>
                        <div className="relative">
                            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                            <input
                                ref={searchInputRef}
                                value={productSearch}
                                onChange={(e) => {
                                    setProductSearch(e.target.value);
                                    setSelectedProductIndex(0);
                                }}
                                onKeyDown={handleSearchKeyDown}
                                className="w-full pl-10 pr-4 py-3.5 rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 text-lg"
                                placeholder="Scan barcode or type product name..."
                            />
                        </div>
                        {productSearch.trim() !== '' && visibleProducts.length > 0 && (
                            <div ref={productListRef} role="listbox" className="mt-3 max-h-[24rem] overflow-y-auto border border-gray-100 dark:border-slate-700 rounded-2xl bg-white dark:bg-slate-800 shadow-lg">
                                {(inventoryLoading ? Array.from({ length: 4 }) : visibleProducts).map((product, index) => (
                                    inventoryLoading ? (
                                        <div key={`skeleton-${index}`} className="h-12 px-4 py-2 bg-gray-100 dark:bg-slate-800 animate-pulse" />
                                    ) : (
                                        <button
                                            key={`${product.inventoryType}-${product.inventoryId}`}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => handleSelectProduct(product)}
                                            role="option"
                                            aria-selected={selectedProductIndex === index}
                                            data-selected={selectedProductIndex === index ? 'true' : 'false'}
                                            tabIndex={-1}
                                            className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left border-b border-gray-50 dark:border-slate-800/50 last:border-b-0 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${selectedProductIndex === index ? 'bg-blue-50 dark:bg-blue-500/10' : 'hover:bg-blue-50 dark:hover:bg-blue-500/5'}`}
                                        >
                                            <div className="flex items-center gap-3 min-w-0">
                                                {product.inventoryType === 'phone' ? (
                                                    <Smartphone size={16} className="text-indigo-600" />
                                                ) : (
                                                    <Barcode size={16} className="text-amber-600" />
                                                )}
                                                <div className="min-w-0">
                                                    <div className="text-sm font-medium text-gray-900 dark:text-slate-100 truncate">{product.displayName}</div>
                                                    <div className="text-xs text-gray-400 dark:text-slate-500">{product.code} • {product.stock} in stock</div>
                                                </div>
                                            </div>
                                            <span className="text-sm font-semibold text-gray-900 dark:text-slate-100">{formatMoney(product.price)}</span>
                                        </button>
                                    )
                                ))}
                            </div>
                        )}
                        {productSearch.trim() !== '' && visibleProducts.length === 0 && !inventoryLoading && (
                            <div className="mt-3 p-4 rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 text-sm text-amber-800 dark:text-amber-200 text-center">
                                <div>No matching products found.</div>
                                <button onClick={addCustomService} className="mt-2 px-3 py-2 rounded-xl bg-blue-600 text-white font-semibold">Add custom service…</button>
                            </div>
                        )}
                    </div>

                    {billingStep === 'cart' && (
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                            <div className="lg:col-span-8 bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2">
                                        <ShoppingCart size={20} className="text-blue-600" />
                                        Cart ({cart.length})
                                    </h2>
                                    {cart.length > 0 && (
                                        <button onClick={() => setCart([])} className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-800 dark:hover:text-rose-300 font-medium focus:outline-none focus:ring-2 focus:ring-rose-500 rounded">
                                            Clear All
                                        </button>
                                    )}
                                </div>
                                {cart.length === 0 ? (
                                    <div className="h-48 flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 text-center">
                                        <PackageSearch size={32} className="text-gray-300 dark:text-slate-600 mb-2" />
                                        <p className="text-gray-500 dark:text-slate-400 text-sm">Cart is empty</p>
                                        <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">Search and add products above</p>
                                    </div>
                                ) : (
                                    <div className="max-h-[28rem] overflow-y-auto pr-2">
                                        <table className="w-full text-sm text-left border-collapse">
                                            <thead>
                                                <tr className="text-xs uppercase text-gray-400 dark:text-slate-500">
                                                    <th className="px-3 py-2 text-left">Item</th>
                                                    <th className="px-3 py-2 text-right w-16">Qty</th>
                                                    <th className="px-3 py-2 text-right w-24">Price</th>
                                                    <th className="px-3 py-2 text-right w-24">Total</th>
                                                    <th className="px-3 py-2 text-right w-10" />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {cart.map((item, index) => (
                                                    <tr
                                                        key={`${item.inventoryType}-${item.inventoryId}`}
                                                        onClick={() => {
                                                            setFocusArea('cart');
                                                            setSelectedCartIndex(index);
                                                        }}
                                                        className={`border-b border-gray-50 dark:border-slate-800/50 transition-colors ${focusArea === 'cart' && selectedCartIndex === index ? 'bg-blue-50 dark:bg-blue-500/10' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}
                                                    >
                                                        <td className="px-3 py-3">
                                                            <div className="font-medium text-gray-900 dark:text-slate-100">{item.name}</div>
                                                            <div className="text-xs text-gray-400 dark:text-slate-500">{item.code}</div>
                                                        </td>
                                                        <td className="px-3 py-3 text-right font-semibold text-gray-900 dark:text-slate-100">{item.quantity}</td>
                                                        <td className="px-3 py-3 text-right font-semibold text-gray-900 dark:text-slate-100">{formatMoney(item.unitPrice)}</td>
                                                        <td className="px-3 py-3 text-right font-bold text-gray-900 dark:text-slate-100">{formatMoney(item.unitPrice * item.quantity)}</td>
                                                        <td className="px-3 py-3 text-right">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    removeCartItem(item);
                                                                }}
                                                                className="text-rose-600 dark:text-rose-400 hover:text-rose-800 dark:hover:text-rose-200 text-xs focus:outline-none focus:ring-2 focus:ring-rose-500 rounded"
                                                            >
                                                                <Trash2 size={12} />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                            <div className="lg:col-span-4">
                                <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 lg:sticky lg:top-6">
                                    <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 mb-6">Checkout</h2>
                                    <div className="space-y-3 mb-6">
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-gray-500 dark:text-slate-400">Subtotal</span>
                                            <strong className="text-gray-900 dark:text-slate-100">{formatMoney(subtotal)}</strong>
                                        </div>
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-gray-500 dark:text-slate-400">Automatic discount</span>
                                            <strong className="text-gray-500 dark:text-slate-400">-{formatMoney(effectiveDiscount)}</strong>
                                        </div>
                                        <div className="flex items-center justify-between text-lg pt-3 border-t border-gray-100 dark:border-slate-800">
                                            <span className="font-semibold text-gray-900 dark:text-slate-100">Total</span>
                                            <strong className="text-blue-600 dark:text-blue-400">{formatMoney(total)}</strong>
                                        </div>
                                    </div>

                                    <div className="space-y-2 mb-6">
                                        <div className={`text-xs ${approvalRequired ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-slate-400'}`}>
                                            Automatic discount from entered prices. Approval limit: {config.discountApprovalLimitPercent}%
                                            {approvalRequired ? ' - admin approval flag will be recorded.' : ''}
                                        </div>
                                    </div>

                                    {isAdmin && (
                                        <div className={`rounded-xl border px-3.5 py-3 mb-6 ${expectedProfit >= 0 ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10' : 'border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10'}`}>
                                            <div className="flex items-center justify-between text-xs sm:text-sm">
                                                <span className="text-gray-600 dark:text-slate-400 font-medium">Total cost (what we paid)</span>
                                                <span className="font-semibold text-gray-800 dark:text-slate-200">{formatMoney(totalCost)}</span>
                                            </div>
                                            <div className="flex items-center justify-between text-xs sm:text-sm mt-1">
                                                <span className="text-gray-600 dark:text-slate-400 font-medium">Profit vs cost</span>
                                                <strong className={`font-bold ${expectedProfit >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                                                    {expectedProfit > 0 ? 'Profit' : expectedProfit < 0 ? 'Loss' : 'Break even'} {formatMoney(Math.abs(expectedProfit))}
                                                </strong>
                                            </div>
                                            {!costKnown && <p className="text-[10px] text-gray-500 dark:text-slate-400 mt-1">Some items have no unit cost recorded.</p>}
                                        </div>
                                    )}

                                    {checkoutError && (
                                        <div className="mb-4 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                            {checkoutError}
                                        </div>
                                    )}

                                    <button
                                        onClick={() => openServices(false)}
                                        className="mb-3 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        <Plus size={16} />
                                        Add service (F9)
                                    </button>
                                    <button
                                        onClick={openPaymentStep}
                                        disabled={cart.length === 0}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-600 shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        <Printer size={16} />
                                        Proceed to Payment (F10)
                                    </button>
                                    <button
                                        onClick={openPayLater}
                                        disabled={cart.length === 0}
                                        className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500"
                                    >
                                        <Bell size={16} />
                                        Pay Later (cashier available)
                                    </button>
                                    {offlineMode && (
                                        <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                                            <CloudUpload size={14} />
                                            <span>Saved locally - syncs when online.</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {billingStep === 'payment' && (
                        <div onKeyDown={handlePaymentKeyDown} className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
                                <div>
                                    <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Payment</h2>
                                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Esc to return to cart without losing anything.</p>
                                    <div className="mt-4 space-y-1 text-sm text-gray-600 dark:text-slate-300">
                                        {cart.map((line) => (
                                            <div key={`${line.inventoryType}-${line.inventoryId}`}>{line.quantity} x {line.name}</div>
                                        ))}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm text-gray-500 dark:text-slate-400">Total</p>
                                    <p className="text-4xl font-bold text-blue-600 dark:text-blue-400">{formatMoney(total)}</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mt-6">
                                {PAYMENT_METHODS.map(({ value, label, icon: Icon }, index) => (
                                    <button
                                        key={value}
                                        onClick={() => setPaymentMethod(value)}
                                        className={`rounded-2xl border px-4 py-4 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${paymentMethod === value ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-500'}`}
                                    >
                                        <div className="text-xs opacity-70 mb-1">Alt+{index + 1}</div>
                                        <div className="flex items-center gap-2">
                                            <Icon size={16} />
                                            <span className="font-semibold">{label}</span>
                                        </div>
                                    </button>
                                ))}
                                <button
                                    onClick={openPayLater}
                                    className="rounded-2xl border px-4 py-4 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                >
                                    <div className="text-xs opacity-70 mb-1">5</div>
                                    <div className="flex items-center gap-2"><Bell size={16} /><span className="font-semibold">Pay Later</span></div>
                                </button>
                            </div>

                            <div className="mt-6">
                                {paymentMethod === 'CASH' && (
                                    <div className="space-y-3 rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4">
                                        <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Cash received</label>
                                        <input
                                            ref={cashInputRef}
                                            type="text"
                                            inputMode="decimal"
                                            min="0"
                                            step="0.01"
                                            value={cashReceived}
                                            onChange={(e) => setCashReceived(e.target.value)}
                                            className="w-full rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-white dark:bg-slate-800 px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                                        />
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-gray-600">Change due</span>
                                            <strong className={`${cashChange > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-800 dark:text-slate-200'}`}>{formatMoney(cashChange)}</strong>
                                        </div>
                                    </div>
                                )}
                                {paymentMethod === 'SPLIT' && (
                                    <div className="space-y-2">
                                        <input
                                            ref={(el) => { splitInputRefs.current[0] = el; }}
                                            type="text"
                                            inputMode="decimal"
                                            min="0"
                                            step="0.01"
                                            placeholder="Cash"
                                            value={paymentSplit.cash}
                                            onChange={(e) => setPaymentSplit((current) => ({ ...current, cash: e.target.value }))}
                                            className="w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3.5 py-2.5 text-sm"
                                        />
                                        <input
                                            ref={(el) => { splitInputRefs.current[1] = el; }}
                                            type="text"
                                            inputMode="decimal"
                                            min="0"
                                            step="0.01"
                                            placeholder="Card"
                                            value={paymentSplit.card}
                                            onChange={(e) => setPaymentSplit((current) => ({ ...current, card: e.target.value }))}
                                            className="w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3.5 py-2.5 text-sm"
                                        />
                                        <input
                                            ref={(el) => { splitInputRefs.current[2] = el; }}
                                            type="text"
                                            inputMode="decimal"
                                            min="0"
                                            step="0.01"
                                            placeholder="Bank Transfer"
                                            value={paymentSplit.bankTransfer}
                                            onChange={(e) => setPaymentSplit((current) => ({ ...current, bankTransfer: e.target.value }))}
                                            className="w-full rounded-xl border border-gray-200 dark:border-slate-700 px-3.5 py-2.5 text-sm"
                                        />
                                        <div className="flex items-center justify-between text-xs sm:text-sm mt-1">
                                            <span className="text-gray-600 dark:text-slate-400">Split total</span>
                                            <strong className="text-gray-900 dark:text-slate-100">{formatMoney(splitTotal)}</strong>
                                        </div>
                                    </div>
                                )}
                                {(paymentMethod === 'CARD' || paymentMethod === 'BANK_TRANSFER') && (
                                    <p className="text-sm text-gray-500 dark:text-slate-400">Press Enter to confirm payment.</p>
                                )}
                            </div>

                            {checkoutError && (
                                <div className="mt-4 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                    {checkoutError}
                                </div>
                            )}

                            <div className="mt-6 flex justify-end gap-3">
                                <button onClick={() => setBillingStep('cart')} className="px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    Back (Esc)
                                </button>
                                <button
                                    onClick={handleConfirmPayment}
                                    disabled={checkoutLoading}
                                    className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                    {checkoutLoading ? 'Saving…' : 'Confirm (Enter)'}
                                </button>
                            </div>
                        </div>
                    )}

                    {billingStep === 'receipt-options' && (
                        <div onKeyDown={handleReceiptOptionKeyDown} className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                            <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Receipt Options</h2>
                            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Use arrow keys and Enter. Default is Print receipt. Esc = No receipt.</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                                {RECEIPT_OPTIONS.map((option, index) => (
                                    <button
                                        key={option.key}
                                        onClick={() => executeReceiptOption(option.key)}
                                        className={`rounded-2xl border px-5 py-6 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${receiptOptionIndex === index ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:border-gray-300 dark:hover:border-slate-500'}`}
                                    >
                                        <div className="text-lg font-bold">{option.label}</div>
                                        <div className="text-xs mt-2 opacity-75">Enter</div>
                                    </button>
                                ))}
                            </div>
                            {checkoutError && (
                                <div className="mt-4 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                    {checkoutError}
                                </div>
                            )}
                            {completedReceipt && (
                                <div className="mt-6 rounded-2xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-3 text-sm">
                                    <div className="text-gray-600 dark:text-slate-400">Saved sale</div>
                                    <div className="font-semibold text-gray-900 dark:text-slate-100">{completedReceipt.receipt_no} • {formatMoney(completedReceipt.total)}</div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ) : activeTab === 'requests' ? (
                <RequestsPanel catalog={catalog} user={user} session={session} onComplete={completeRequest} />
            ) : activeTab === 'services' ? (
                <div className="space-y-5">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                            <div>
                                <h2 className="text-xl font-bold">Services</h2>
                                <p className="text-sm text-gray-500">Bill non-stock services using the normal payment, receipt, cash-session, and refund flow.</p>
                            </div>
                            <button onClick={() => openServices(true)} className="rounded-xl bg-blue-600 px-4 py-3 text-white font-semibold">New service sale</button>
                        </div>
                        <div className="mt-5 grid md:grid-cols-2 gap-3">
                            <div className="rounded-2xl border p-4">
                                <h3 className="font-bold">Service catalog</h3>
                                <p className="text-xs text-gray-500 mt-1">Add or edit service items from Stock Management using the Service toggle.</p>
                                <div className="mt-3 space-y-2">{serviceCatalog.slice(0, 8).map((service) => <div key={service.inventoryId} className="flex justify-between text-sm"><span>{service.displayName}</span><span>{formatMoney(service.price)}</span></div>)}</div>
                            </div>
                            <div className="rounded-2xl border p-4">
                                <h3 className="font-bold">Recent service sales</h3>
                                <div className="mt-3 space-y-2">{serviceSales.slice(0, 8).map((sale) => <div key={sale.id || sale.receipt_no} className="flex justify-between text-sm"><span>{sale.receipt_no}</span><span>{formatMoney(sale.total)}</span></div>)}{serviceSales.length === 0 && <p className="text-sm text-gray-500">No service sales yet.</p>}</div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                        <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:justify-between">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><History size={20} className="text-blue-600" /> Sales History</h2>
                                <p className="text-sm text-gray-500 dark:text-slate-400">Search receipts, items, and cashiers. Pending badges clear when background sync marks a sale as synced.</p>
                            </div>
                        </div>
                        {salesError && (
                            <div className="mt-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                                {salesError}
                            </div>
                        )}
                        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
                            <div className="lg:col-span-2 relative">
                                <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                                <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 pl-11 pr-4 py-3 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Search receipt, item, cashier, payment method" />
                            </div>
                            {isAdmin && (
                                <select value={historyCashierFilter} onChange={(e) => setHistoryCashierFilter(e.target.value)} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-3 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    <option value="all">All cashiers</option>
                                    {uniqueCashiers.map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}
                                </select>
                            )}
                        </div>
                    </div>

                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
                                <thead className="bg-gray-50/70 dark:bg-slate-950/70 text-xs uppercase text-gray-400 dark:text-slate-500">
                                    <tr>
                                        <th className="px-6 py-3">Receipt</th>
                                        <th className="px-6 py-3">Items</th>
                                        <th className="px-6 py-3">Cashier</th>
                                        <th className="px-6 py-3">Payment</th>
                                        <th className="px-6 py-3">Total</th>
                                        <th className="px-6 py-3">Sync</th>
                                        <th className="px-6 py-3">Time</th>
                                        <th className="px-6 py-3">Receipt</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {salesLoading ? (
                                        <tr><td colSpan="8" className="px-6 py-10 text-center text-gray-400 dark:text-slate-500">Loading sales history...</td></tr>
                                    ) : sales.length === 0 ? (
                                        <tr><td colSpan="8" className="px-6 py-10 text-center text-gray-400 dark:text-slate-500">No sales found.</td></tr>
                                    ) : sales.map((sale, idx) => {
                                        const refundMeta = refundMetaBySale[sale.id] || { count: 0, totalQty: 0, latest: null };
                                        const soldQty = (sale.items || []).reduce((sum, it) => sum + Number(it.quantity || 0), 0);
                                        const partiallyRefunded = refundMeta.totalQty > 0 && refundMeta.totalQty < soldQty;
                                        const fullyRefunded = sale.refunded || (soldQty > 0 && refundMeta.totalQty >= soldQty);
                                        return (
                                        <tr
                                            key={sale.id}
                                            onClick={() => setHistorySelectedIndex(idx)}
                                            className={`border-b border-gray-100 dark:border-slate-800 hover:bg-gray-50/60 dark:hover:bg-slate-700/60 hover:dark:bg-slate-950/60 ${historySelectedIndex === idx ? 'bg-blue-50/60 dark:bg-blue-500/10' : ''}`}
                                        >
                                            <td className="px-6 py-4 font-semibold text-gray-900 dark:text-slate-100 whitespace-nowrap">{sale.receipt_no}</td>
                                            <td className="px-6 py-4 max-w-[240px]">
                                                <div className="font-medium text-gray-900 dark:text-slate-100 truncate">{(sale.items || []).map((item) => item.name).join(', ')}</div>
                                                <div className="text-xs text-gray-400 dark:text-slate-500">{(sale.items || []).length} line items</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">{sale.cashier_name}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">{sale.payment_method.replace('_', ' ')}</td>
                                            <td className="px-6 py-4 font-semibold text-gray-900 dark:text-slate-100 whitespace-nowrap">{formatMoney(sale.total)}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${sale.pending_sync || sale.syncStatus === 'pending' ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300' : sale.syncStatus === 'failed' ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300' : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'}`}>
                                                    {sale.pending_sync || sale.syncStatus === 'pending' ? 'Pending sync' : sale.syncStatus === 'failed' ? 'Sync failed' : 'Synced'}
                                                </span>
                                                {fullyRefunded ? (
                                                    <span className="mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold bg-violet-100 text-violet-700">
                                                        Refunded{sale.refunded_by_name ? ` by ${sale.refunded_by_name}` : ''}
                                                    </span>
                                                ) : null}
                                                {partiallyRefunded ? (
                                                    <span className="mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold bg-indigo-100 text-indigo-700">
                                                        Partially refunded
                                                    </span>
                                                ) : null}
                                                {sale.approval_required ? (
                                                    <div className="mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300">
                                                        Admin approval flag
                                                    </div>
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-gray-500 dark:text-slate-400">{new Date(sale.created_at).toLocaleString()}</td>
                                            <td className="px-6 py-4">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => printWithHiddenFrame(sale)}
                                                        className="inline-flex items-center gap-1 rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 hover:dark:bg-slate-950"
                                                    >
                                                        <Printer size={14} /> Print
                                                    </button>
                                                    {refundMeta.latest && (
                                                        <button
                                                            onClick={() => printRefundWithHiddenFrame(refundMeta.latest)}
                                                            className="inline-flex items-center gap-1 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-100 dark:hover:bg-violet-500/20"
                                                        >
                                                            <Printer size={14} /> Refund receipt
                                                        </button>
                                                    )}
                                                    {!fullyRefunded && !(sale.pending_sync || sale.syncStatus === 'pending') && (
                                                        <button onClick={() => handleRefund(sale)} className="inline-flex items-center gap-1 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-100 dark:hover:bg-violet-500/20">
                                                            <Banknote size={14} /> Refund
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )})}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {payLaterOpen && (
                <PayLaterModal
                    cart={cart}
                    total={total}
                    session={session}
                    user={user}
                    config={config}
                    onClose={() => setPayLaterOpen(false)}
                    onCompleted={completePayLater}
                />
            )}

            {itemModal.open && (
                <div className="fixed inset-0 z-40 bg-black/45 flex items-center justify-center p-4">
                    <div className="w-full max-w-lg bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 shadow-2xl p-6">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h3 className="text-xl font-bold text-gray-900 dark:text-slate-100">{itemModal.mode === 'edit' ? 'Edit item' : 'Add item'}</h3>
                                <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{itemModal.item?.displayName}</p>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
                            <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2"><span className="text-gray-500 dark:text-slate-400">Category</span><div className="font-semibold text-gray-900 dark:text-slate-100">{itemModal.item?.category}</div></div>
                            <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2"><span className="text-gray-500 dark:text-slate-400">Stock available</span><div className="font-semibold text-gray-900 dark:text-slate-100">{itemModal.item?.stock}</div></div>
                            <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2"><span className="text-gray-500 dark:text-slate-400">Selling price</span><div className="font-semibold text-gray-900 dark:text-slate-100">{formatMoney(itemModal.item?.listPrice)}</div></div>
                            <div className="rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2"><span className="text-gray-500 dark:text-slate-400">Code</span><div className="font-semibold text-gray-900 dark:text-slate-100">{itemModal.item?.code}</div></div>
                        </div>

                        <div className="mt-4 space-y-3">
                            <label className="block text-sm font-semibold text-gray-700 dark:text-slate-300">Price</label>
                            <input
                                ref={itemPriceInputRef}
                                type="text"
                                inputMode="decimal"
                                value={itemModal.price}
                                readOnly={itemModal.item?.allowPriceOverride === false}
                                onChange={(e) => setItemModal((current) => ({ ...current, price: e.target.value }))}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applyItemModal();
                                    }
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        closeItemModal();
                                    }
                                }}
                                className="w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3.5 py-2.5 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-75"
                            />

                            <label className="block text-sm font-semibold text-gray-700 dark:text-slate-300">Quantity</label>
                            <input
                                ref={itemQtyInputRef}
                                type="text"
                                inputMode="numeric"
                                value={itemModal.quantity}
                                readOnly={itemModal.item?.trackedBy === 'IMEI'}
                                onChange={(e) => setItemModal((current) => ({ ...current, quantity: e.target.value }))}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        applyItemModal();
                                    }
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        closeItemModal();
                                    }
                                }}
                                className="w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3.5 py-2.5 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:opacity-75"
                            />
                        </div>

                        {isAdmin && itemModal.item && (
                            <div className="mt-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3 py-2 text-sm space-y-1">
                                <div className="flex justify-between"><span className="text-gray-500 dark:text-slate-400">Cost price</span><span className="font-semibold text-gray-900 dark:text-slate-100">{formatMoney(unitCostOf(itemModal.item))}</span></div>
                                <div className="flex justify-between"><span className="text-gray-500 dark:text-slate-400">Profit</span><span className="font-semibold text-gray-900 dark:text-slate-100">{formatMoney(Math.max(0, safeNumber(itemModal.price) - unitCostOf(itemModal.item)))}</span></div>
                                <div className="flex justify-between"><span className="text-gray-500 dark:text-slate-400">Margin %</span><span className="font-semibold text-gray-900 dark:text-slate-100">{safeNumber(itemModal.price) > 0 ? (((safeNumber(itemModal.price) - unitCostOf(itemModal.item)) / safeNumber(itemModal.price)) * 100).toFixed(2) : '0.00'}%</span></div>
                            </div>
                        )}

                        {!isAdmin && itemModal.item && safeNumber(itemModal.price) < unitCostOf(itemModal.item) && (
                            <div className="mt-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                                Price not allowed, needs admin approval.
                            </div>
                        )}

                        {isAdmin && itemModal.item && safeNumber(itemModal.price) < unitCostOf(itemModal.item) && (
                            <div className="mt-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                                Price is below cost ({formatMoney(unitCostOf(itemModal.item))}). Admin approval note will be recorded.
                            </div>
                        )}

                        {itemModal.error && (
                            <div className="mt-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                                {itemModal.error}
                            </div>
                        )}

                        <div className="mt-5 flex justify-end gap-3">
                            <button onClick={closeItemModal} className="px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500">Esc Cancel</button>
                            <button onClick={applyItemModal} className="px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">Enter Add</button>
                        </div>
                    </div>
                </div>
            )}

            {newSaleConfirmOpen && (
                <div className="fixed inset-0 z-40 bg-black/45 flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 shadow-2xl p-6">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Start a new sale?</h3>
                        <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">Current cart will be cleared.</p>
                        <div className="mt-5 flex justify-end gap-3">
                            <button onClick={() => { setNewSaleConfirmOpen(false); focusSearch(); }} className="px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-300">Esc Cancel</button>
                            <button onClick={() => { setNewSaleConfirmOpen(false); clearSale(); }} className="px-4 py-2 rounded-xl text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700">Enter Clear</button>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'billing' && (
                <div className="fixed bottom-0 left-0 right-0 z-20 bg-white/95 dark:bg-slate-900/95 border-t border-gray-200 dark:border-slate-700 px-4 py-2 text-xs text-gray-600 dark:text-slate-300">
                    <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span><strong>F3</strong> Search</span>
                        <span><strong>F4</strong> Edit qty</span>
                        {hasCustomerAttachFeature && <span><strong>F7</strong> Attach customer</span>}
                        <span><strong>F8</strong> New sale</span>
                        <span><strong>F10</strong> Payment</span>
                        <span><strong>Esc</strong> Back/Cancel</span>
                        <span><strong>Delete</strong> Remove line</span>
                        {billingStep === 'payment' && (
                            <span className="text-xs text-blue-600 dark:text-blue-400">
                                <kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">Alt</kbd>
                                <kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">1</kbd>-<kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">4</kbd>
                                method
                            </span>
                        )}
                        {billingStep === 'payment' && (
                            <span className="text-xs text-blue-600 dark:text-blue-400">
                                <kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">↑</kbd>/<kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800">↓</kbd> change method, Enter confirm
                            </span>
                        )}
                    </div>
                </div>
            )}

            {refundSale && (
                <RefundModal
                    sale={refundSale}
                    onClose={() => setRefundSale(null)}
                    onApplied={() => loadSales()}
                />
            )}
            {servicesModalOpen && (
                <ServicesModal
                    services={serviceCatalog}
                    isAdmin={isAdmin}
                    standalone={standaloneServices}
                    onClose={() => setServicesModalOpen(false)}
                    onAdd={acceptServiceLines}
                />
            )}
        </div>
    );
}