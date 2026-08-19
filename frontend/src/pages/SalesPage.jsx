import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSession } from '../context/SessionContext';
import { BadgeCheck, Banknote, Barcode, CreditCard, History, PackageSearch, Printer, Search, ShieldAlert, ShoppingCart, Smartphone, RefreshCw, Trash2, Warehouse } from 'lucide-react';

const API_BASE = '/api';

const PAYMENT_METHODS = [
    { value: 'CASH', label: 'Cash', icon: Banknote },
    { value: 'CARD', label: 'Card', icon: CreditCard },
    { value: 'BANK_TRANSFER', label: 'Bank Transfer', icon: Warehouse },
    { value: 'SPLIT', label: 'Split Payment', icon: BadgeCheck }
];

const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const safeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

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

const buildReceiptWindow = (receipt) => {
    const win = window.open('', '_blank', 'width=420,height=760');
    if (!win) return;

    const { cashTendered, changeAmount } = getCashSummary(receipt);
    const itemsMarkup = receipt.items.map((item) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;">
          <div style="font-weight:700;">${item.name}</div>
          <div style="font-size:11px;color:#666;">${item.tracked_by === 'IMEI' ? `IMEI ${item.imei}` : `SKU ${item.sku}`}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(item.unit_price)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(item.line_total)}</td>
      </tr>
    `).join('');

    win.document.write(`
            <!doctype html>
            <html>
                <head>
                    <title>${receipt.receipt_no} - Loyal Mobile</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #111; }
            .sheet { max-width: 360px; margin: 0 auto; }
            h1 { margin: 0 0 6px; font-size: 22px; }
            .muted { color: #666; font-size: 12px; }
            table { width: 100%; border-collapse: collapse; margin-top: 16px; }
            .summary { margin-top: 16px; border-top: 1px dashed #aaa; padding-top: 12px; }
            .row { display: flex; justify-content: space-between; margin: 6px 0; }
            .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #f3f4f6; font-size: 11px; margin-top: 8px; }
          </style>
        </head>
        <body>
          <div class="sheet">
            <h1>Loyal Mobile Receipt</h1>
            <div class="muted">Receipt ${receipt.receipt_no}</div>
            <div class="muted">Cashier: ${receipt.cashier_name}</div>
            <div class="muted">${new Date(receipt.created_at).toLocaleString()}</div>
            <span class="badge">${receipt.pending_sync ? 'Pending sync' : 'Synced'}</span>
            <table>
              <thead>
                <tr>
                  <th style="text-align:left;padding-top:12px;">Item</th>
                  <th style="padding-top:12px;">Qty</th>
                  <th style="padding-top:12px;text-align:right;">Price</th>
                  <th style="padding-top:12px;text-align:right;">Total</th>
                </tr>
              </thead>
              <tbody>${itemsMarkup}</tbody>
            </table>
            <div class="summary">
              <div class="row"><span>Subtotal</span><strong>${formatMoney(receipt.subtotal)}</strong></div>
              <div class="row"><span>Discount</span><strong>- ${formatMoney(receipt.discount_amount)}</strong></div>
              <div class="row"><span>Payment</span><strong>${receipt.payment_method.replace('_', ' ')}</strong></div>
              ${receipt.payment_method === 'CASH' ? `<div class="row"><span>Cash</span><strong>${formatMoney(cashTendered)}</strong></div><div class="row"><span>Change</span><strong>${formatMoney(changeAmount)}</strong></div>` : ''}
              <div class="row" style="font-size:18px;"><span>Total</span><strong>${formatMoney(receipt.total)}</strong></div>
            </div>
            <p class="muted" style="margin-top:16px;">Thank you for your purchase.</p>
          </div>
        </body>
      </html>
    `);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 200);
};

export default function SalesPage() {
    const { user } = useAuth();
    const { session } = useSession();

    const [activeTab, setActiveTab] = useState('billing');
    const [phones, setPhones] = useState([]);
    const [accessories, setAccessories] = useState([]);
    const [sales, setSales] = useState([]);
    const [config, setConfig] = useState({ discountApprovalLimitPercent: 10 });
    const [productSearch, setProductSearch] = useState('');
    const [historySearch, setHistorySearch] = useState('');
    const [historyCashierFilter, setHistoryCashierFilter] = useState('all');
    const [cart, setCart] = useState([]);
    const [paymentMethod, setPaymentMethod] = useState('CASH');
    const [cashReceived, setCashReceived] = useState('');
    const [paymentSplit, setPaymentSplit] = useState({ cash: '', card: '', bankTransfer: '' });
    const [discountAmount, setDiscountAmount] = useState('0');
    const [approvalNote, setApprovalNote] = useState('');
    const [checkoutLoading, setCheckoutLoading] = useState(false);
    const [inventoryLoading, setInventoryLoading] = useState(true);
    const [salesLoading, setSalesLoading] = useState(true);
    const [receipt, setReceipt] = useState(null);
    const [checkoutError, setCheckoutError] = useState('');

    const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';

    const catalog = useMemo(() => [
        ...phones.map((phone) => ({
            inventoryType: 'phone',
            inventoryId: phone.id,
            code: phone.imei,
            displayName: `${phone.brand} ${phone.model}`,
            price: safeNumber(phone.selling_price),
            stock: phone.status === 'In Stock' ? 1 : 0,
            trackedBy: 'IMEI',
            meta: `${phone.brand} · ${phone.condition}`,
            source: phone
        })),
        ...accessories.map((accessory) => ({
            inventoryType: 'accessory',
            inventoryId: accessory.id,
            code: accessory.sku,
            displayName: accessory.name,
            price: safeNumber(accessory.sell_price),
            stock: safeNumber(accessory.quantity),
            trackedBy: 'QTY',
            meta: accessory.category,
            source: accessory
        }))
    ], [phones, accessories]);

    const visibleProducts = useMemo(() => {
        const term = productSearch.trim().toLowerCase();
        if (!term) return catalog.slice(0, 12);

        return catalog.filter((item) =>
            item.code.toLowerCase().includes(term) ||
            item.displayName.toLowerCase().includes(term) ||
            item.meta.toLowerCase().includes(term)
        ).slice(0, 12);
    }, [catalog, productSearch]);

    const subtotal = useMemo(() => cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0), [cart]);
    const discountValue = Math.min(Math.max(safeNumber(discountAmount), 0), subtotal);
    const total = Math.max(0, subtotal - discountValue);
    const discountPercent = subtotal > 0 ? (discountValue / subtotal) * 100 : 0;
    const approvalRequired = discountPercent > config.discountApprovalLimitPercent && !isAdmin;
    const splitTotal = safeNumber(paymentSplit.cash) + safeNumber(paymentSplit.card) + safeNumber(paymentSplit.bankTransfer);
    const cashChange = paymentMethod === 'CASH' ? Math.max(0, safeNumber(cashReceived) - total) : 0;
    const cashDue = paymentMethod === 'CASH' ? Math.max(0, total - safeNumber(cashReceived)) : 0;

    const loadInventory = async () => {
        try {
            const token = localStorage.getItem('token');
            const [phoneRes, accessoryRes, configRes] = await Promise.all([
                fetch(`${API_BASE}/inventory/phones`, { headers: { Authorization: `Bearer ${token}` } }),
                fetch(`${API_BASE}/inventory/accessories`, { headers: { Authorization: `Bearer ${token}` } }),
                fetch(`${API_BASE}/sales/config`, { headers: { Authorization: `Bearer ${token}` } })
            ]);

            if (phoneRes.ok) setPhones(await phoneRes.json());
            if (accessoryRes.ok) setAccessories(await accessoryRes.json());
            if (configRes.ok) setConfig(await configRes.json());
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

            if (res.ok) setSales(await res.json());
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

    const addItemToCart = (product) => {
        if (product.inventoryType === 'phone' && cart.some((item) => item.inventoryId === product.inventoryId && item.inventoryType === 'phone')) {
            return;
        }

        setCart((current) => {
            const existingIndex = current.findIndex((item) => item.inventoryType === product.inventoryType && item.inventoryId === product.inventoryId);

            if (existingIndex >= 0) {
                const next = [...current];
                const existing = next[existingIndex];
                const nextQuantity = product.inventoryType === 'accessory' ? Math.min(existing.quantity + 1, product.stock) : 1;
                next[existingIndex] = { ...existing, quantity: nextQuantity };
                return next;
            }

            return [...current, {
                inventoryType: product.inventoryType,
                inventoryId: product.inventoryId,
                code: product.code,
                name: product.displayName,
                unitPrice: product.price,
                quantity: 1,
                trackedBy: product.trackedBy,
                stock: product.stock,
                source: product.source
            }];
        });
        setProductSearch('');
    };

    const updateCartQuantity = (inventoryId, inventoryType, quantity) => {
        setCart((current) => current.map((item) => {
            if (item.inventoryId !== inventoryId || item.inventoryType !== inventoryType) return item;
            if (item.inventoryType === 'phone') return item;
            const nextQuantity = Math.min(Math.max(1, quantity), item.stock);
            return { ...item, quantity: nextQuantity };
        }));
    };

    const removeCartItem = (inventoryId, inventoryType) => {
        setCart((current) => current.filter((item) => !(item.inventoryId === inventoryId && item.inventoryType === inventoryType)));
    };

    const handleProductSearchKeyDown = (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const firstMatch = visibleProducts[0];
        if (firstMatch) addItemToCart(firstMatch);
    };

    const handlePrintReceipt = (saleReceipt) => {
        buildReceiptWindow(saleReceipt);
    };

    const handleCheckout = async () => {
        setCheckoutError('');
        if (!session) {
            setCheckoutError('You must Open a Day Session before completing sales.');
            return;
        }
        if (cart.length === 0) {
            setCheckoutError('Add at least one item before checkout.');
            return;
        }

        const payload = {
            items: cart.map((item) => ({
                inventoryType: item.inventoryType,
                inventoryId: item.inventoryId,
                quantity: item.inventoryType === 'phone' ? 1 : item.quantity
            })),
            paymentMethod,
            cashReceived: paymentMethod === 'CASH' ? safeNumber(cashReceived) : 0,
            paymentDetails: paymentMethod === 'CASH'
                ? { cash: safeNumber(cashReceived), cashReceived: safeNumber(cashReceived), change: Math.max(0, safeNumber(cashReceived) - total), change_amount: Math.max(0, safeNumber(cashReceived) - total) }
                : paymentMethod === 'SPLIT' ? {
                    cash: safeNumber(paymentSplit.cash),
                    card: safeNumber(paymentSplit.card),
                    bankTransfer: safeNumber(paymentSplit.bankTransfer)
                } : null,
            discountAmount: discountValue,
            approvalNote: approvalNote.trim() || null,
            sessionId: session?.id
        };

        if (paymentMethod === 'CASH' && safeNumber(cashReceived) < total - 0.01) {
            setCheckoutError('Cash received must cover the total amount.');
            return;
        }

        if (paymentMethod === 'SPLIT' && Math.abs(splitTotal - total) > 0.01) {
            setCheckoutError('Split payment amounts must match the sale total.');
            return;
        }

        setCheckoutLoading(true);
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE}/sales/checkout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Checkout failed');
            }

            setReceipt(data.receipt);
            setCart([]);
            setDiscountAmount('0');
            setCashReceived('');
            setPaymentSplit({ cash: '', card: '', bankTransfer: '' });
            setApprovalNote('');
            setProductSearch('');
            await Promise.all([loadInventory(), loadSales()]);
            handlePrintReceipt(data.receipt);
        } catch (err) {
            setCheckoutError(err.message);
        } finally {
            setCheckoutLoading(false);
        }
    };

    const uniqueCashiers = useMemo(() => {
        const seen = new Map();
        sales.forEach((sale) => {
            if (!seen.has(sale.cashier_id)) {
                seen.set(sale.cashier_id, sale.cashier_name);
            }
        });
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
    }, [sales]);

    const currentReceiptCash = receipt && receipt.payment_method === 'CASH'
        ? getCashSummary(receipt)
        : { cashTendered: 0, changeAmount: 0 };

    return (
        <div className="space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-900">Sales / Billing</h1>
                    <p className="text-gray-500 mt-1">Scan products, build the cart, and complete checkout against the local store first.</p>
                </div>
                <div className="flex gap-2 bg-white p-1 rounded-2xl shadow-sm border border-gray-100">
                    <button onClick={() => setActiveTab('billing')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${activeTab === 'billing' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 hover:text-gray-800'}`}>
                        Billing
                    </button>
                    <button onClick={() => setActiveTab('history')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 ${activeTab === 'history' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 hover:text-gray-800'}`}>
                        <History size={16} />
                        History
                    </button>
                </div>
            </div>

            {activeTab === 'billing' ? (
                <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
                    <div className="xl:col-span-3 space-y-6">
                        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
                            <div className="flex items-center justify-between gap-3 mb-4">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2"><PackageSearch size={20} className="text-blue-600" /> Search / Scan Product</h2>
                                    <p className="text-sm text-gray-500">Search by name, SKU, or IMEI. Press Enter to add the top result.</p>
                                </div>
                                <div className="text-xs text-gray-500 bg-gray-50 rounded-full px-3 py-1 border border-gray-200">
                                    {visibleProducts.length} matches
                                </div>
                            </div>
                            <div className="relative">
                                <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input
                                    value={productSearch}
                                    onChange={(e) => setProductSearch(e.target.value)}
                                    onKeyDown={handleProductSearchKeyDown}
                                    className="w-full pl-11 pr-4 py-3 rounded-2xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Scan IMEI, type SKU, or search product name"
                                />
                            </div>
                            <div className="grid md:grid-cols-2 gap-3 mt-4 max-h-[22rem] overflow-y-auto pr-1">
                                {(inventoryLoading ? Array.from({ length: 6 }) : visibleProducts).map((product, index) => (
                                    inventoryLoading ? (
                                        <div key={index} className="h-24 rounded-2xl bg-gray-100 animate-pulse" />
                                    ) : (
                                        <button
                                            key={`${product.inventoryType}-${product.inventoryId}`}
                                            onClick={() => addItemToCart(product)}
                                            className="text-left rounded-2xl border border-gray-200 p-4 bg-white hover:border-blue-300 hover:shadow-sm transition-all"
                                        >
                                            <div className="flex items-start justify-between gap-4">
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        {product.inventoryType === 'phone' ? <Smartphone size={16} className="text-indigo-600" /> : <Barcode size={16} className="text-amber-600" />}
                                                        <span className="text-xs uppercase tracking-wide text-gray-500">{product.inventoryType}</span>
                                                    </div>
                                                    <h3 className="font-bold text-gray-900 mt-2">{product.displayName}</h3>
                                                    <p className="text-sm text-gray-500">{product.code} · {product.meta}</p>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-sm font-semibold text-gray-900">{formatMoney(product.price)}</div>
                                                    <div className="text-xs text-gray-500 mt-1">Stock {product.stock}</div>
                                                </div>
                                            </div>
                                        </button>
                                    )
                                ))}
                            </div>
                        </div>

                        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
                                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2"><ShoppingCart size={20} className="text-blue-600" /> Cart</h2>
                                <span className="text-sm text-gray-500">{cart.length} line items</span>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left text-gray-600">
                                    <thead className="text-xs uppercase text-gray-400 bg-gray-50/60">
                                        <tr>
                                            <th className="px-6 py-3">Item</th>
                                            <th className="px-6 py-3">Price</th>
                                            <th className="px-6 py-3">Qty</th>
                                            <th className="px-6 py-3 text-right">Total</th>
                                            <th className="px-6 py-3 text-right">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {cart.length === 0 ? (
                                            <tr>
                                                <td colSpan="5" className="px-6 py-10 text-center text-gray-400">Cart is empty</td>
                                            </tr>
                                        ) : cart.map((item) => (
                                            <tr key={`${item.inventoryType}-${item.inventoryId}`} className="border-b border-gray-100">
                                                <td className="px-6 py-4">
                                                    <div className="font-semibold text-gray-900">{item.name}</div>
                                                    <div className="text-xs text-gray-400">{item.code} · {item.trackedBy === 'IMEI' ? 'IMEI tracked phone' : 'Quantity tracked accessory'}</div>
                                                </td>
                                                <td className="px-6 py-4 font-medium text-gray-900">{formatMoney(item.unitPrice)}</td>
                                                <td className="px-6 py-4">
                                                    {item.inventoryType === 'phone' ? (
                                                        <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold">Locked to 1</span>
                                                    ) : (
                                                        <div className="flex items-center gap-2">
                                                            <button onClick={() => updateCartQuantity(item.inventoryId, item.inventoryType, item.quantity - 1)} className="w-8 h-8 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">-</button>
                                                            <span className="w-10 text-center font-semibold text-gray-900">{item.quantity}</span>
                                                            <button onClick={() => updateCartQuantity(item.inventoryId, item.inventoryType, item.quantity + 1)} className="w-8 h-8 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">+</button>
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4 font-semibold text-gray-900 text-right">{formatMoney(item.unitPrice * item.quantity)}</td>
                                                <td className="px-6 py-4 text-right">
                                                    <button onClick={() => removeCartItem(item.inventoryId, item.inventoryType)} className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-800 text-xs font-semibold">
                                                        <Trash2 size={14} /> Remove
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div className="xl:col-span-2 space-y-6">
                        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6 sticky top-6">
                            <h2 className="text-lg font-bold text-gray-900 mb-4">Checkout</h2>

                            <div className="space-y-3 mb-5">
                                <div className="flex items-center justify-between text-sm text-gray-500">
                                    <span>Subtotal</span>
                                    <strong className="text-gray-900">{formatMoney(subtotal)}</strong>
                                </div>
                                <div className="flex items-center justify-between text-sm text-gray-500">
                                    <span>Discount</span>
                                    <strong className="text-gray-900">{formatMoney(discountValue)}</strong>
                                </div>
                                <div className="flex items-center justify-between text-base text-gray-900 pt-3 border-t border-gray-100">
                                    <span className="font-semibold">Total</span>
                                    <strong>{formatMoney(total)}</strong>
                                </div>
                            </div>

                            <div className="space-y-2 mb-5">
                                <label className="text-sm font-semibold text-gray-700">Discount amount</label>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={discountAmount}
                                    onChange={(e) => setDiscountAmount(e.target.value)}
                                    className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="0.00"
                                />
                                <div className={`text-xs ${approvalRequired ? 'text-amber-700' : 'text-gray-500'}`}>
                                    Discount approval limit: {config.discountApprovalLimitPercent}%
                                    {approvalRequired ? ' - admin approval flag will be recorded.' : ''}
                                </div>
                            </div>

                            <div className="space-y-3 mb-5">
                                <label className="text-sm font-semibold text-gray-700">Payment method</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {PAYMENT_METHODS.map(({ value, label, icon: Icon }) => (
                                        <button
                                            key={value}
                                            onClick={() => setPaymentMethod(value)}
                                            className={`rounded-2xl border px-3 py-3 text-left transition-all ${paymentMethod === value ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}
                                        >
                                            <Icon size={16} />
                                            <div className="mt-2 text-sm font-semibold">{label}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {paymentMethod === 'CASH' && (
                                <div className="space-y-3 mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                                    <label className="text-sm font-semibold text-gray-700">Cash received</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={cashReceived}
                                        onChange={(e) => setCashReceived(e.target.value)}
                                        className="w-full rounded-2xl border border-emerald-200 bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                        placeholder="Enter cash tendered"
                                    />
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-gray-600">Change due</span>
                                        <strong className={`${cashChange > 0 ? 'text-emerald-700' : 'text-gray-800'}`}>
                                            {formatMoney(cashChange)}
                                        </strong>
                                    </div>
                                    <div className="flex items-center justify-between text-xs text-gray-600">
                                        <span>Amount due</span>
                                        <span>{formatMoney(cashDue)}</span>
                                    </div>
                                </div>
                            )}

                            {paymentMethod === 'SPLIT' && (
                                <div className="space-y-3 mb-5">
                                    <label className="text-sm font-semibold text-gray-700">Split amounts</label>
                                    <input type="number" min="0" step="0.01" placeholder="Cash" value={paymentSplit.cash} onChange={(e) => setPaymentSplit((current) => ({ ...current, cash: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
                                    <input type="number" min="0" step="0.01" placeholder="Card" value={paymentSplit.card} onChange={(e) => setPaymentSplit((current) => ({ ...current, card: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
                                    <input type="number" min="0" step="0.01" placeholder="Bank transfer" value={paymentSplit.bankTransfer} onChange={(e) => setPaymentSplit((current) => ({ ...current, bankTransfer: e.target.value }))} className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
                                    <div className={`text-xs ${Math.abs(splitTotal - total) > 0.01 ? 'text-rose-600' : 'text-emerald-700'}`}>
                                        Split total: {formatMoney(splitTotal)} · Expected: {formatMoney(total)}
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2 mb-5">
                                <label className="text-sm font-semibold text-gray-700">Approval note</label>
                                <textarea
                                    value={approvalNote}
                                    onChange={(e) => setApprovalNote(e.target.value)}
                                    rows="3"
                                    className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Optional note for large discounts or supervisor review"
                                />
                            </div>

                            {checkoutError && (
                                <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                    {checkoutError}
                                </div>
                            )}

                            <button
                                onClick={handleCheckout}
                                disabled={checkoutLoading || cart.length === 0}
                                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white shadow-lg shadow-blue-500/25 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Printer size={18} />
                                {checkoutLoading ? 'Completing sale...' : 'Checkout & Print Receipt'}
                            </button>
                        </div>

                        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
                            <h2 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2"><ShieldAlert size={18} className="text-blue-600" /> Latest Receipt</h2>
                            {receipt ? (
                                <div className="space-y-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <div className="font-bold text-gray-900">{receipt.receipt_no}</div>
                                            <div className="text-sm text-gray-500">{receipt.cashier_name} · {new Date(receipt.created_at).toLocaleString()}</div>
                                        </div>
                                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${receipt.pending_sync ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                            {receipt.pending_sync ? 'Pending sync' : 'Synced'}
                                        </span>
                                    </div>
                                    <div className="space-y-2 max-h-64 overflow-y-auto">
                                        {receipt.items.map((item) => (
                                            <div key={`${item.inventory_type}-${item.inventory_id}`} className="flex items-center justify-between text-sm border-b border-gray-100 pb-2">
                                                <div>
                                                    <div className="font-semibold text-gray-900">{item.name}</div>
                                                    <div className="text-xs text-gray-400">{item.quantity} x {formatMoney(item.unit_price)}</div>
                                                </div>
                                                <strong>{formatMoney(item.line_total)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="pt-4 border-t border-gray-100 space-y-1 text-sm">
                                        <div className="flex justify-between"><span>Subtotal</span><span>{formatMoney(receipt.subtotal)}</span></div>
                                        <div className="flex justify-between"><span>Discount</span><span>- {formatMoney(receipt.discount_amount)}</span></div>
                                        <div className="flex justify-between"><span>Payment</span><span>{receipt.payment_method.replace('_', ' ')}</span></div>
                                        {receipt.payment_method === 'CASH' && (
                                            <>
                                                <div className="flex justify-between"><span>Cash received</span><span>{formatMoney(currentReceiptCash.cashTendered)}</span></div>
                                                <div className="flex justify-between"><span>Change</span><span>{formatMoney(currentReceiptCash.changeAmount)}</span></div>
                                            </>
                                        )}
                                        <div className="flex justify-between text-base font-bold pt-2"><span>Total</span><span>{formatMoney(receipt.total)}</span></div>
                                    </div>
                                    <button onClick={() => handlePrintReceipt(receipt)} className="w-full rounded-2xl border border-gray-200 px-4 py-3 font-semibold text-gray-700 hover:bg-gray-50 inline-flex items-center justify-center gap-2">
                                        <Printer size={16} /> Print again
                                    </button>
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-6 text-center text-gray-500">
                                    Complete a sale to generate the printable receipt here.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
                        <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:justify-between">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2"><History size={20} className="text-blue-600" /> Sales History</h2>
                                <p className="text-sm text-gray-500">Search receipts, items, and cashiers. Pending badges clear when the background sync marks a sale as synced.</p>
                            </div>
                            <button onClick={loadSales} className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                                <RefreshCw size={16} /> Refresh
                            </button>
                        </div>

                        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
                            <div className="lg:col-span-2 relative">
                                <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} className="w-full rounded-2xl border border-gray-200 bg-gray-50 pl-11 pr-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Search receipt, item, cashier, payment method" />
                            </div>
                            {isAdmin && (
                                <select value={historyCashierFilter} onChange={(e) => setHistoryCashierFilter(e.target.value)} className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                                    <option value="all">All cashiers</option>
                                    {uniqueCashiers.map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}
                                </select>
                            )}
                        </div>
                    </div>

                    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left text-gray-600">
                                <thead className="bg-gray-50/70 text-xs uppercase text-gray-400">
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
                                        <tr><td colSpan="8" className="px-6 py-10 text-center text-gray-400">Loading sales history...</td></tr>
                                    ) : sales.length === 0 ? (
                                        <tr><td colSpan="8" className="px-6 py-10 text-center text-gray-400">No sales found.</td></tr>
                                    ) : sales.map((sale) => (
                                        <tr key={sale.id} className="border-b border-gray-100 hover:bg-gray-50/60">
                                            <td className="px-6 py-4 font-semibold text-gray-900 whitespace-nowrap">{sale.receipt_no}</td>
                                            <td className="px-6 py-4 max-w-[240px]">
                                                <div className="font-medium text-gray-900 truncate">
                                                    {sale.items.map((item) => item.name).join(', ')}
                                                </div>
                                                <div className="text-xs text-gray-400">{sale.items.length} line items</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">{sale.cashier_name}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">{sale.payment_method.replace('_', ' ')}</td>
                                            <td className="px-6 py-4 font-semibold text-gray-900 whitespace-nowrap">{formatMoney(sale.total)}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${sale.pending_sync ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                                    {sale.pending_sync ? 'Pending sync' : 'Synced'}
                                                </span>
                                                {sale.approval_required ? (
                                                    <div className="mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold bg-rose-100 text-rose-700">
                                                        Admin approval flag
                                                    </div>
                                                ) : null}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-gray-500">{new Date(sale.created_at).toLocaleString()}</td>
                                            <td className="px-6 py-4">
                                                <button onClick={() => handlePrintReceipt(sale)} className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                                                    <Printer size={14} /> Print
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}