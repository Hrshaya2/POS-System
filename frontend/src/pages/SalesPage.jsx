import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSession } from '../context/SessionContext';
import { useSync } from '../context/SyncContext';
import { BadgeCheck, Banknote, Barcode, CreditCard, History, PackageSearch, Printer, Search, ShieldAlert, ShoppingCart, Smartphone, RefreshCw, Trash2, Warehouse, WifiOff, CloudUpload } from 'lucide-react';
import { addPendingSale, generateLocalReceiptNo } from '../db/database';
import { refreshInventoryCache } from '../services/syncService';
import { getCachedInventory } from '../db/database';
import { applyServerInventorySnapshot } from '../services/stockService';
import { getReceiptSettings, buildReceiptHtml } from '../utils/receipt';
import RefundModal from '../components/RefundModal';

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

// Unit cost (what the shop paid) for a cart line item. Phones record cost as
// purchase_price, accessories as cost_price. Used only by the on-screen
// profit/loss indicator — never stored on the sale or printed on receipts.
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

const buildReceiptWindow = (receipt) => {
    // Build the printable HTML from the shared settings-aware template
    // (logo, shop name, messages, contact details — all customizable in
    // Settings and rendered identically in the Settings live preview).
    const html = buildReceiptHtml(receipt, getReceiptSettings());

    const win = window.open('', '_blank', 'width=420,height=760');
    if (!win) return;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 200);
};

// Builds a complete receipt object from the cart + payment info without needing a server response.
const buildLocalReceipt = ({ user, session, cart, paymentMethod, cashReceived, paymentSplit, discountValue, paymentDetails }) => {
    const items = cart.map((item) => ({
        inventory_type: item.inventoryType,
        inventory_id: item.inventoryId,
        imei: item.trackedBy === 'IMEI' ? item.code : null,
        sku: item.trackedBy === 'IMEI' ? null : item.code,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        line_total: item.unitPrice * item.quantity,
        tracked_by: item.trackedBy
    }));

    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
    const total = Math.max(0, subtotal - discountValue);
    const cashTendered = paymentMethod === 'CASH' ? safeNumber(cashReceived) : 0;
    const changeAmount = paymentMethod === 'CASH' ? Math.max(0, cashTendered - total) : 0;
    const now = new Date().toISOString();

    return {
        receipt_no: generateLocalReceiptNo(),
        cashier_id: user?.id,
        cashier_name: user?.name,
        cashier_role: user?.role,
        items,
        subtotal,
        discount_amount: discountValue,
        discount_percent: subtotal > 0 ? (discountValue / subtotal) * 100 : 0,
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
        // Local-only fields the sync service understands
        clientLocalId: crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    };
};

export default function SalesPage() {
    const { user } = useAuth();
    const { session } = useSession();
    const { syncNow } = useSync();

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
    const [offlineMode, setOfflineMode] = useState(!navigator.onLine);
    const [salesError, setSalesError] = useState('');

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

        // Barcode-scan friendly ordering: an EXACT code match (manufacturer
        // barcode or internally generated LM-XXXXXX) always sorts first, so
        // "scan + Enter" adds precisely that item with no extra clicks.
        const scored = catalog
            .map((item) => {
                const code = item.code.toLowerCase();
                let score;
                if (code === term) score = 0;
                else if (code.startsWith(term)) score = 1;
                else if (
                    code.includes(term) ||
                    item.displayName.toLowerCase().includes(term) ||
                    item.meta.toLowerCase().includes(term)
                ) score = 2;
                else score = -1;
                return { item, score };
            })
            .filter((x) => x.score >= 0)
            .sort((a, b) => a.score - b.score)
            .map((x) => x.item);

        return scored.slice(0, 12);
    }, [catalog, productSearch]);

    const subtotal = useMemo(() => cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0), [cart]);
    const discountValue = Math.min(Math.max(safeNumber(discountAmount), 0), subtotal);
    const total = Math.max(0, subtotal - discountValue);
    const discountPercent = subtotal > 0 ? (discountValue / subtotal) * 100 : 0;
    const approvalRequired = discountPercent > config.discountApprovalLimitPercent && !isAdmin;
    const splitTotal = safeNumber(paymentSplit.cash) + safeNumber(paymentSplit.card) + safeNumber(paymentSplit.bankTransfer);
    const cashChange = paymentMethod === 'CASH' ? Math.max(0, safeNumber(cashReceived) - total) : 0;
    const cashDue = paymentMethod === 'CASH' ? Math.max(0, total - safeNumber(cashReceived)) : 0;

    // Live profit/loss vs what the shop paid for the items (checkout screen
    // only — this is a cashier aid and is NEVER sent to the receipt/printer).
    const totalCost = useMemo(() => cart.reduce((sum, item) => sum + unitCostOf(item) * item.quantity, 0), [cart]);
    const costKnown = useMemo(
        () => cart.length > 0 && cart.every((item) => {
            const cost = item.inventoryType === 'phone' ? item.source?.purchase_price : item.source?.cost_price;
            return cost !== undefined && cost !== null && cost !== '';
        }),
        [cart]
    );
    const expectedProfit = total - totalCost;
    const profitMarginPercent = totalCost > 0 ? (expectedProfit / totalCost) * 100 : (subtotal > 0 ? 100 : 0);

    const loadInventory = async () => {
        try {
            const token = localStorage.getItem('token');

            if (!navigator.onLine) {
                // Offline: serve from IndexedDB cache
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
                // Unified stock-data path (stockService): fresh server data is
                // reconciled with pending offline writes in the shared cache,
                // then the catalog mirrors it - identical to Stock Management.
                const [phones, accessories] = await Promise.all([phoneRes.json(), accessoryRes.json()]);
                await applyServerInventorySnapshot({ phones, accessories });
                const cached = await getCachedInventory();
                setPhones(cached.phones);
                setAccessories(cached.accessories);
            } else {
                // Partial success: update only what arrived, never the other list.
                if (phoneRes.ok) setPhones(await phoneRes.json());
                if (accessoryRes.ok) {
                    await applyServerInventorySnapshot({ accessories: await accessoryRes.json() });
                    setAccessories((await getCachedInventory()).accessories);
                }
            }
            if (configRes.ok) setConfig(await configRes.json());
        } catch (err) {
            // Network error: fall back to cached inventory
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
                // Merge with local sales so offline-created records still show.
                // Already-synced local rows are excluded — their server copy is in serverSales.
                const { getRecentOfflineSales } = await import('../db/database');
                const localSales = await getRecentOfflineSales(100);
                const localIsPending = (local) => local.syncStatus !== 'synced';
                const pendingLocalSales = localSales.filter((local) => localIsPending(local));
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
                // Deduplicate by receipt_no (local prefix won't clash with server)
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
            console.warn('Offline - sales history unavailable from server. Showing local pending sales only.');
            setSalesError('You appear to be offline - showing locally saved sales only.');
            try {
                const { getRecentOfflineSales } = await import('../db/database');
                const localSales = await getRecentOfflineSales(100);
                const localIsPending = (local) => local.syncStatus === 'pending';
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
                    pending_sync: localIsPending(local),
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

    // Start a refund from Sales History (never a free-standing form).
    // Any signed-in user may open the flow: the backend refund policy decides
    // whether it applies directly (within limits, same payment method) or
    // routes to the admin approval queue. Requires a live connection because
    // refunds restore server-side stock and adjust the cash session.
    const [refundSale, setRefundSale] = useState(null);
    const handleRefund = (sale) => {
        if (sale.refunded) return;
        if (sale.pending_sync || sale.syncStatus === 'pending') {
            alert('This sale has not finished syncing yet. Wait for it to sync before refunding.');
            return;
        }
        if (!navigator.onLine) { alert('Refunds require an online connection.'); return; }
        setSalesError('');
        setRefundSale(sale);
    };

    // Local-first checkout:
    // 1. Build the receipt locally
    // 2. Write to IndexedDB FIRST (status: pending unless network confirms)
    // 3. Show success + print receipt immediately
    // 4. In parallel, push to the server. On success mark synced.
    const handleCheckout = async () => {
        setCheckoutError('');
        if (!session && !navigator.onLine) {
            // Allow offline checkout without an active session, but warn
            // (session is only enforced online)
        } else if (!session) {
            setCheckoutError('You must Open a Day Session before completing sales.');
            return;
        }
        if (cart.length === 0) {
            setCheckoutError('Add at least one item before checkout.');
            return;
        }

        const paymentDetails = paymentMethod === 'CASH'
            ? { cash: safeNumber(cashReceived), cashReceived: safeNumber(cashReceived), change: Math.max(0, safeNumber(cashReceived) - total), change_amount: Math.max(0, safeNumber(cashReceived) - total) }
            : paymentMethod === 'SPLIT' ? {
                cash: safeNumber(paymentSplit.cash),
                card: safeNumber(paymentSplit.card),
                bankTransfer: safeNumber(paymentSplit.bankTransfer)
            } : null;

        // Build the local receipt FIRST so both the server payload (which needs
        // the idempotency token) and the on-screen receipt use the same object.
        // (Declared before payloadForServer to avoid a temporal-dead-zone error.)
        const localReceipt = buildLocalReceipt({
            user,
            session,
            cart,
            paymentMethod,
            cashReceived,
            paymentSplit,
            discountValue,
            paymentDetails
        });
        // Mark as pending sync initially (will flip to synced if the network push succeeds)
        localReceipt.pending_sync = !navigator.onLine;

        const payloadForServer = {
            items: cart.map((item) => ({
                inventoryType: item.inventoryType,
                inventoryId: item.inventoryId,
                quantity: item.inventoryType === 'phone' ? 1 : item.quantity
            })),
            paymentMethod,
            cashReceived: paymentMethod === 'CASH' ? safeNumber(cashReceived) : 0,
            paymentDetails,
            discountAmount: discountValue,
            approvalNote: approvalNote.trim() || null,
            sessionId: session?.id || null,
            clientLocalId: localReceipt.clientLocalId
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
            // STEP 1: the local receipt was built above (covers cart + payment).
            // STEP 2: Persist to IndexedDB FIRST
            const localKey = await addPendingSale(localReceipt);

            // STEP 3: Clear the cart and show the receipt instantly
            setReceipt({ ...localReceipt, id: localKey });
            setCart([]);
            setDiscountAmount('0');
            setCashReceived('');
            setPaymentSplit({ cash: '', card: '', bankTransfer: '' });
            setApprovalNote('');
            setProductSearch('');

            handlePrintReceipt({ ...localReceipt, pending_sync: !navigator.onLine });

            // STEP 4: Async push to server if online (never block the cashier)
            const token = localStorage.getItem('token');
            if (navigator.onLine && token) {
                (async () => {
                    try {
                        const res = await fetch(`${API_BASE}/sales/checkout`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${token}`
                            },
                            body: JSON.stringify(payloadForServer)
                        });
                        const data = await res.json();
                        if (res.ok) {
                            // Mark the local record as synced
                            const { markSaleSynced } = await import('../db/database');
                            await markSaleSynced(localKey, data?.sale?.id || data?.receipt?.id || null);
                            // Update the on-screen receipt to reflect synced state
                            setReceipt((current) => current?.id === localKey
                                ? { ...current, pending_sync: false, receipt_no: data?.receipt?.receipt_no || current.receipt_no, id: data?.receipt?.id || current.id }
                                : current);
                            await refreshInventoryCache();
                            loadSales();
                            // Refresh the sync status indicator immediately
                            syncNow();
                        } else {
                            // Server rejected (e.g. duplicate from a retry) — keep local copy as pending
                            console.warn('Checkout push failed, keeping local record pending:', data.error);
                            setReceipt((current) => current?.id === localKey
                                ? { ...current, pending_sync: true }
                                : current);
                        }
                    } catch (err) {
                        // Network dropped mid-push — keep local record pending for background sync
                        console.warn('Network push failed, record saved locally and will sync later:', err);
                        setReceipt((current) => current?.id === localKey
                            ? { ...current, pending_sync: true }
                            : current);
                    }
                })();
            }

            // Refresh inventory (network or cached)
            loadInventory();
        } catch (err) {
            console.error('Checkout failed:', err);
            setCheckoutError(err.message || 'Checkout failed');
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
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center">Sales / Billing</h1>
                    <p className="text-gray-500 dark:text-slate-400 mt-1">Scan products, build the cart, and complete checkout against the local store first.</p>
                </div>
                <div className="flex gap-2 bg-white dark:bg-slate-800 p-1 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800">
                    <button onClick={() => setActiveTab('billing')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${activeTab === 'billing' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800'}`}>
                        Billing
                    </button>
                    <button onClick={() => setActiveTab('history')} className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 ${activeTab === 'history' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800'}`}>
                        <History size={16} />
                        History
                    </button>
                </div>
            </div>

            {offlineMode && (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-sm">
                    <WifiOff size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div>
                        <p className="font-bold text-amber-800 dark:text-amber-200">Offline billing is active.</p>
                        <p className="text-amber-700 dark:text-amber-300 mt-1">
                            Sales are saved to this browser's local database first and will sync to the cloud automatically when the internet returns.
                        </p>
                    </div>
                </div>
            )}

            {activeTab === 'billing' ? (
                <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
                    <div className="xl:col-span-3 space-y-6">
                        <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                            <div className="flex items-center justify-between gap-3 mb-4">
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><PackageSearch size={20} className="text-blue-600" /> Search / Scan Product</h2>
                                    <p className="text-sm text-gray-500 dark:text-slate-400">Search by name, SKU, or IMEI. Press Enter to add the top result.</p>
                                </div>
                                <div className="text-xs text-gray-500 dark:text-slate-400 bg-gray-50 dark:bg-slate-950 rounded-full px-3 py-1 border border-gray-200 dark:border-slate-700">
                                    {visibleProducts.length} matches
                                </div>
                            </div>
                            <div className="relative">
                                <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                                <input
                                    value={productSearch}
                                    onChange={(e) => setProductSearch(e.target.value)}
                                    onKeyDown={handleProductSearchKeyDown}
                                    className="w-full pl-11 pr-4 py-3 rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Scan IMEI, type SKU, or search product name"
                                />
                            </div>
                            <div className="grid md:grid-cols-2 gap-3 mt-4 max-h-[22rem] overflow-y-auto pr-1">
                                {(inventoryLoading ? Array.from({ length: 6 }) : visibleProducts).map((product, index) => (
                                    inventoryLoading ? (
                                        <div key={index} className="h-24 rounded-2xl bg-gray-100 dark:bg-slate-800 animate-pulse" />
                                    ) : (
                                        <button
                                            key={`${product.inventoryType}-${product.inventoryId}`}
                                            onClick={() => addItemToCart(product)}
                                            className="text-left rounded-2xl border border-gray-200 dark:border-slate-700 p-4 bg-white dark:bg-slate-800 hover:border-blue-300 hover:shadow-sm transition-all"
                                        >
                                            <div className="flex items-start justify-between gap-4">
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        {product.inventoryType === 'phone' ? <Smartphone size={16} className="text-indigo-600" /> : <Barcode size={16} className="text-amber-600" />}
                                                        <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-slate-400">{product.inventoryType}</span>
                                                    </div>
                                                    <h3 className="font-bold text-gray-900 dark:text-slate-100 mt-2">{product.displayName}</h3>
                                                    <p className="text-sm text-gray-500 dark:text-slate-400">{product.code} · {product.meta}</p>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-sm font-semibold text-gray-900 dark:text-slate-100">{formatMoney(product.price)}</div>
                                                    <div className="text-xs text-gray-500 dark:text-slate-400 mt-1">Stock {product.stock}</div>
                                                </div>
                                            </div>
                                        </button>
                                    )
                                ))}
                            </div>
                        </div>

                        <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
                            <div className="p-6 border-b border-gray-100 dark:border-slate-800 flex items-center justify-between">
                                <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><ShoppingCart size={20} className="text-blue-600" /> Cart</h2>
                                <span className="text-sm text-gray-500 dark:text-slate-400">{cart.length} line items</span>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left text-gray-600 dark:text-slate-400">
                                    <thead className="text-xs uppercase text-gray-400 dark:text-slate-500 bg-gray-50/60 dark:bg-slate-950/60">
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
                                                <td colSpan="5" className="px-6 py-10 text-center text-gray-400 dark:text-slate-500">Cart is empty</td>
                                            </tr>
                                        ) : cart.map((item) => (
                                            <tr key={`${item.inventoryType}-${item.inventoryId}`} className="border-b border-gray-100 dark:border-slate-800">
                                                <td className="px-6 py-4">
                                                    <div className="font-semibold text-gray-900 dark:text-slate-100">{item.name}</div>
                                                    <div className="text-xs text-gray-400 dark:text-slate-500">{item.code} · {item.trackedBy === 'IMEI' ? 'IMEI tracked phone' : 'Quantity tracked accessory'}</div>
                                                </td>
                                                <td className="px-6 py-4 font-medium text-gray-900 dark:text-slate-100">{formatMoney(item.unitPrice)}</td>
                                                <td className="px-6 py-4">
                                                    {item.inventoryType === 'phone' ? (
                                                        <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 text-xs font-semibold">Locked to 1</span>
                                                    ) : (
                                                        <div className="flex items-center gap-2">
                                                            <button onClick={() => updateCartQuantity(item.inventoryId, item.inventoryType, item.quantity - 1)} className="w-8 h-8 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950">-</button>
                                                            <span className="w-10 text-center font-semibold text-gray-900 dark:text-slate-100">{item.quantity}</span>
                                                            <button onClick={() => updateCartQuantity(item.inventoryId, item.inventoryType, item.quantity + 1)} className="w-8 h-8 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950">+</button>
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4 font-semibold text-gray-900 dark:text-slate-100 text-right">{formatMoney(item.unitPrice * item.quantity)}</td>
                                                <td className="px-6 py-4 text-right">
                                                    <button onClick={() => removeCartItem(item.inventoryId, item.inventoryType)} className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 hover:text-rose-800 text-xs font-semibold">
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
                        <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 sticky top-6">
                            <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 mb-4">Checkout</h2>

                            <div className="space-y-3 mb-5">
                                <div className="flex items-center justify-between text-sm text-gray-500 dark:text-slate-400">
                                    <span>Subtotal</span>
                                    <strong className="text-gray-500">{formatMoney(subtotal)}</strong>
                                </div>
                                <div className="flex items-center justify-between text-sm text-gray-500 dark:text-slate-400">
                                    <span>Discount</span>
                                    <strong className="text-gray-500">{formatMoney(discountValue)}</strong>
                                </div>
                                <div className="flex items-center justify-between text-base text-gray-900 dark:text-slate-100 pt-3 border-t border-gray-100 dark:border-slate-800">
                                    <span className="font-semibold">Total</span>
                                    <strong>{formatMoney(total)}</strong>
                                </div>
                            </div>

                            <div className="space-y-2 mb-5">
                                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Discount amount</label>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={discountAmount}
                                    onChange={(e) => setDiscountAmount(e.target.value)}
                                    className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="0.00"
                                />
                                <div className={`text-xs ${approvalRequired ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-slate-400'}`}>
                                    Discount approval limit: {config.discountApprovalLimitPercent}%
                                    {approvalRequired ? ' - admin approval flag will be recorded.' : ''}
                                </div>
                            </div>

                            {/* Live profit/loss vs item cost — checkout screen only, never printed */}
                            {cart.length > 0 && (
                                <div className={`rounded-2xl border px-4 py-3 mb-5 ${expectedProfit >= 0 ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10' : 'border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10'}`}>
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-gray-600 dark:text-slate-400 font-medium">Total cost (what we paid)</span>
                                        <span className="font-semibold text-gray-800 dark:text-slate-200">{formatMoney(totalCost)}</span>
                                    </div>
                                    <div className="flex items-center justify-between text-sm mt-1.5">
                                        <span className="text-gray-600 dark:text-slate-400 font-medium">Profit vs cost</span>
                                        <strong className={`font-bold ${expectedProfit >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                                            {expectedProfit > 0 ? 'Profit' : expectedProfit < 0 ? 'Loss' : 'Break even'}
                                            &nbsp;{formatMoney(Math.abs(expectedProfit))}
                                            {totalCost > 0 && (
                                                <span className="ml-1 text-xs font-semibold opacity-60">
                                                    ({profitMarginPercent >= 0 ? '+' : ''}{profitMarginPercent.toFixed(1)}%)
                                                </span>
                                            )}
                                        </strong>
                                    </div>
                                    {!costKnown && (
                                        <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-1.5">
                                            Some items have no unit cost recorded - profit shown is an estimate.
                                        </p>
                                    )}
                                </div>
                            )}

                            <div className="space-y-3 mb-5">
                                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Payment method</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {PAYMENT_METHODS.map(({ value, label, icon: Icon }) => (
                                        <button
                                            key={value}
                                            onClick={() => setPaymentMethod(value)}
                                            className={`rounded-2xl border px-3 py-3 text-left transition-all ${paymentMethod === value ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:border-gray-300'}`}
                                        >
                                            <Icon size={16} />
                                            <div className="mt-2 text-sm font-semibold">{label}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {paymentMethod === 'CASH' && (
                                <div className="space-y-3 mb-5 rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4">
                                    <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Cash received</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        value={cashReceived}
                                        onChange={(e) => setCashReceived(e.target.value)}
                                        className="w-full rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-white dark:bg-slate-800 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                        placeholder="Enter cash tendered"
                                    />
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-gray-600">Change due</span>
                                        <strong className={`${cashChange > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-800 dark:text-slate-200'}`}>
                                            {formatMoney(cashChange)}
                                        </strong>
                                    </div>
                                    <div className="flex items-center justify-between text-xs text-gray-600 dark:text-slate-400">
                                        <span>Amount due</span>
                                        <span>{formatMoney(cashDue)}</span>
                                    </div>
                                </div>
                            )}

                            {paymentMethod === 'SPLIT' && (
                                <div className="space-y-3 mb-5">
                                    <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Split amounts</label>
                                    <input type="number" min="0" step="0.01" placeholder="Cash" value={paymentSplit.cash} onChange={(e) => setPaymentSplit((current) => ({ ...current, cash: e.target.value }))} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" />
                                    <input type="number" min="0" step="0.01" placeholder="Card" value={paymentSplit.card} onChange={(e) => setPaymentSplit((current) => ({ ...current, card: e.target.value }))} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" />
                                    <input type="number" min="0" step="0.01" placeholder="Bank transfer" value={paymentSplit.bankTransfer} onChange={(e) => setPaymentSplit((current) => ({ ...current, bankTransfer: e.target.value }))} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" />
                                    <div className={`text-xs ${Math.abs(splitTotal - total) > 0.01 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-300'}`}>
                                        Split total: {formatMoney(splitTotal)} · Expected: {formatMoney(total)}
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2 mb-5">
                                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Approval note</label>
                                <textarea
                                    value={approvalNote}
                                    onChange={(e) => setApprovalNote(e.target.value)}
                                    rows="3"
                                    className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Optional note for large discounts or supervisor review"
                                />
                            </div>

                            {checkoutError && (
                                <div className="mb-4 rounded-2xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
                                    {checkoutError}
                                </div>
                            )}

                            <button
                                onClick={handleCheckout}
                                disabled={checkoutLoading || cart.length === 0}
                                className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white shadow-lg shadow-blue-500/25 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Printer size={18} />
                                {checkoutLoading ? 'Saving locally...' : 'Checkout & Print Receipt'}
                            </button>
                            {offlineMode && (
                                <div className="mt-3 flex items-center gap-2 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
                                    <CloudUpload size={16} />
                                    <span>Will be saved to this device and synced when online.</span>
                                </div>
                            )}
                        </div>

                        <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                            <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 mb-4 flex items-center gap-2"><ShieldAlert size={18} className="text-blue-600" /> Latest Receipt</h2>
                            {receipt ? (
                                <div className="space-y-4">
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <div className="font-bold text-gray-900 dark:text-slate-100">{receipt.receipt_no}</div>
                                            <div className="text-sm text-gray-500 dark:text-slate-400">{receipt.cashier_name} · {new Date(receipt.created_at).toLocaleString()}</div>
                                        </div>
                                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${receipt.pending_sync ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'}`}>
                                            {receipt.pending_sync ? 'Pending sync' : 'Synced'}
                                        </span>
                                    </div>
                                    <div className="space-y-2 max-h-64 overflow-y-auto">
                                        {receipt.items.map((item) => (
                                            <div key={`${item.inventory_type}-${item.inventory_id}`} className="flex items-center justify-between text-sm border-b border-gray-100 dark:border-slate-800 pb-2">
                                                <div>
                                                    <div className="font-semibold text-gray-900 dark:text-slate-100">{item.name}</div>
                                                    <div className="text-xs text-gray-400 dark:text-slate-500">{item.quantity} x {formatMoney(item.unit_price)}</div>
                                                </div>
                                                <strong>{formatMoney(item.line_total)}</strong>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="pt-4 border-t border-gray-100 dark:border-slate-800 space-y-1 text-sm">
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
                                    <button onClick={() => handlePrintReceipt(receipt)} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3 font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950 inline-flex items-center justify-center gap-2">
                                        <Printer size={16} /> Print again
                                    </button>
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-dashed border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-6 text-center text-gray-500 dark:text-slate-400">
                                    Complete a sale to generate the printable receipt here.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="space-y-6">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
                        <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:justify-between">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><History size={20} className="text-blue-600" /> Sales History</h2>
                                <p className="text-sm text-gray-500 dark:text-slate-400">Search receipts, items, and cashiers. Pending badges clear when the background sync marks a sale as synced.</p>
                            </div>
                            <button onClick={loadSales} className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-2 text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950">
                                <RefreshCw size={16} /> Refresh
                            </button>
                        </div>

                        {salesError && (
                            <div className="mt-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                                {salesError}
                            </div>
                        )}

                        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3">
                            <div className="lg:col-span-2 relative">
                                <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                                <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 pl-11 pr-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="Search receipt, item, cashier, payment method" />
                            </div>
                            {isAdmin && (
                                <select value={historyCashierFilter} onChange={(e) => setHistoryCashierFilter(e.target.value)} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-3 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
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
                                    ) : sales.map((sale) => (
                                        <tr key={sale.id} className="border-b border-gray-100 dark:border-slate-800 hover:bg-gray-50/60 hover:dark:bg-slate-950/60">
                                            <td className="px-6 py-4 font-semibold text-gray-900 dark:text-slate-100 whitespace-nowrap">{sale.receipt_no}</td>
                                            <td className="px-6 py-4 max-w-[240px]">
                                                <div className="font-medium text-gray-900 dark:text-slate-100 truncate">
                                                    {(sale.items || []).map((item) => item.name).join(', ')}
                                                </div>
                                                <div className="text-xs text-gray-400 dark:text-slate-500">{(sale.items || []).length} line items</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">{sale.cashier_name}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">{sale.payment_method.replace('_', ' ')}</td>
                                            <td className="px-6 py-4 font-semibold text-gray-900 dark:text-slate-100 whitespace-nowrap">{formatMoney(sale.total)}</td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${sale.pending_sync || sale.syncStatus === 'pending' ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300' : sale.syncStatus === 'failed' ? 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300' : 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'}`}>
                                                    {sale.pending_sync || sale.syncStatus === 'pending' ? 'Pending sync' : sale.syncStatus === 'failed' ? 'Sync failed' : 'Synced'}
                                                </span>
                                                {sale.refunded ? (
                                                    <span className="mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold bg-violet-100 text-violet-700">
                                                        Refunded{ sale.refunded_by_name ? ` by ${sale.refunded_by_name}` : '' }
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
                                                    <button onClick={() => handlePrintReceipt(sale)} className="inline-flex items-center gap-1 rounded-xl border border-gray-200 dark:border-slate-700 px-3 py-2 text-xs font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50 hover:dark:bg-slate-950">
                                                        <Printer size={14} /> Print
                                                    </button>
                                                    {!sale.refunded && !(sale.pending_sync || sale.syncStatus === 'pending') && (
                                                        <button onClick={() => handleRefund(sale)} className="inline-flex items-center gap-1 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-100">
                                                            <Banknote size={14} /> Refund
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* Full / partial refund flow starting from the selected sale */}
            {refundSale && (
                <RefundModal
                    sale={refundSale}
                    onClose={() => setRefundSale(null)}
                    onApplied={() => loadSales()}
                />
            )}
        </div>
    );
}