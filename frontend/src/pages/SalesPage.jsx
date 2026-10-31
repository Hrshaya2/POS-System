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
    WifiOff
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

const buildLocalReceipt = ({ user, session, cart, paymentMethod, cashReceived, discountValue, paymentDetails }) => {
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
        clientLocalId: crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    };
};

const printWithHiddenFrame = async (receipt, mode = 'receipt') => {
    const baseHtml = buildReceiptHtml(receipt, getReceiptSettings());
    const title = mode === 'invoice' ? 'Invoice' : 'Receipt';
    const html = baseHtml.replace(/<title>.*<\/title>/, `<title>${title} - ${receipt.receipt_no}</title>`);

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

        const printRefundWithHiddenFrame = async (refund) => {
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
                        reject(new Error('Unable to initialize refund print frame.'));
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
                            setTimeout(finish, 1600);
                        }, 120);
                    } catch (err) {
                        cleanup();
                        reject(err);
                    }
                };

                iframe.srcdoc = html;
                document.body.appendChild(iframe);
            });
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
};

export default function SalesPage() {
    const { user } = useAuth();
    const { session } = useSession();
    const { syncNow } = useSync();

    const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';
    const hasCustomerAttachFeature = false;

    const searchInputRef = useRef(null);
    const discountInputRef = useRef(null);
    const cashInputRef = useRef(null);
    const splitInputRefs = useRef([]);
    const itemPriceInputRef = useRef(null);
    const itemQtyInputRef = useRef(null);

    const [activeTab, setActiveTab] = useState('billing');
    const [phones, setPhones] = useState([]);
    const [accessories, setAccessories] = useState([]);
    const [sales, setSales] = useState([]);
    const [config, setConfig] = useState({ discountApprovalLimitPercent: 10 });
    const [inventoryLoading, setInventoryLoading] = useState(true);
    const [salesLoading, setSalesLoading] = useState(true);
    const [salesError, setSalesError] = useState('');
    const [offlineMode, setOfflineMode] = useState(!navigator.onLine);

    const [productSearch, setProductSearch] = useState('');
    const [selectedProductIndex, setSelectedProductIndex] = useState(0);
    const [focusArea, setFocusArea] = useState('search');
    const [selectedCartIndex, setSelectedCartIndex] = useState(0);

    const [cart, setCart] = useState([]);
    const [discountAmount, setDiscountAmount] = useState('0');
    const [approvalNote, setApprovalNote] = useState('');
    const [checkoutError, setCheckoutError] = useState('');
    const [checkoutLoading, setCheckoutLoading] = useState(false);

    const [billingStep, setBillingStep] = useState('cart');
    const [paymentMethod, setPaymentMethod] = useState('CASH');
    const [cashReceived, setCashReceived] = useState('');
    const [paymentSplit, setPaymentSplit] = useState({ cash: '', card: '', bankTransfer: '' });
    const [receiptOptionIndex, setReceiptOptionIndex] = useState(0);
    const [completedReceipt, setCompletedReceipt] = useState(null);

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
                stock: safeNumber(accessory.quantity),
                trackedBy: 'QTY',
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
    const discountValue = Math.min(Math.max(safeNumber(discountAmount), 0), subtotal);
    const total = Math.max(0, subtotal - discountValue);
    const effectiveDiscount = Math.max(0, listSubtotal - total);
    const effectiveDiscountPercent = listSubtotal > 0 ? (effectiveDiscount / listSubtotal) * 100 : 0;
    const approvalRequired = effectiveDiscountPercent > config.discountApprovalLimitPercent && !isAdmin;
    const splitTotal = safeNumber(paymentSplit.cash) + safeNumber(paymentSplit.card) + safeNumber(paymentSplit.bankTransfer);
    const cashChange = paymentMethod === 'CASH' ? Math.max(0, safeNumber(cashReceived) - total) : 0;
    const cashDue = paymentMethod === 'CASH' ? Math.max(0, total - safeNumber(cashReceived)) : 0;

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
            setCashReceived(total > 0 ? total.toFixed(2) : '0.00');
            setTimeout(() => {
                if (cashInputRef.current) {
                    cashInputRef.current.focus();
                    cashInputRef.current.select();
                }
            }, 0);
        }
    }, [billingStep, paymentMethod, total]);

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
        setDiscountAmount('0');
        setCashReceived('');
        setPaymentSplit({ cash: '', card: '', bankTransfer: '' });
        setApprovalNote('');
        setCheckoutError('');
        setBillingStep('cart');
        setPaymentMethod('CASH');
        setCompletedReceipt(null);
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
        if (paymentMethod === 'CASH' && safeNumber(cashReceived) < total - 0.01) {
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
                change: Math.max(0, safeNumber(cashReceived) - total),
                change_amount: Math.max(0, safeNumber(cashReceived) - total)
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
            discountValue,
            paymentDetails
        });
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
            discountAmount: effectiveDiscount,
            approvalNote: approvalNote.trim() || (approvalRequired ? 'Price/discount exceeded approval limit.' : null),
            sessionId: session?.id || null,
            clientLocalId: localReceipt.clientLocalId
        };

        setCheckoutLoading(true);
        try {
            const localKey = await addPendingSale(localReceipt);
            setReceipt({ ...localReceipt, id: localKey });

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
                            const { markSaleSynced } = await import('../db/database');
                            await markSaleSynced(localKey, data?.sale?.id || data?.receipt?.id || null);
                            setReceipt((current) => current?.id === localKey
                                ? {
                                    ...current,
                                    pending_sync: false,
                                    receipt_no: data?.receipt?.receipt_no || current.receipt_no,
                                    id: data?.receipt?.id || current.id
                                }
                                : current);
                            await refreshInventoryCache();
                            loadSales();
                            syncNow();
                        } else {
                            setReceipt((current) => current?.id === localKey ? { ...current, pending_sync: true } : current);
                        }
                    } catch (err) {
                        setReceipt((current) => current?.id === localKey ? { ...current, pending_sync: true } : current);
                    }
                })();
            }

            await loadInventory();
            return { ...localReceipt, id: localKey };
        } catch (err) {
            console.error('Checkout failed:', err);
            setCheckoutError(err.message || 'Checkout failed');
            return null;
        } finally {
            setCheckoutLoading(false);
        }
    };

    const handleConfirmPayment = async () => {
        if (checkoutLoading || completedReceipt) return;
        const savedReceipt = await persistSale();
        if (!savedReceipt) return;
        setCompletedReceipt(savedReceipt);
        setReceiptOptionIndex(0);
        setBillingStep('receipt-options');
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
            const key = event.key;
            const lower = String(key || '').toLowerCase();
            const targetTag = event.target?.tagName;
            const isInputLike = targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT' || event.target?.isContentEditable;
            const modalOpen = itemModal.open || newSaleConfirmOpen;

            // Leave browser/OS combos (Ctrl+F3, Alt+F4, ...) alone.
            if (event.ctrlKey || event.metaKey) return;

            // Plain character/digit keys and +- must never act when typing in any input.
            if (isInputLike) {
                // Escape and Delete keep native behaviour; F-keys are ignored while an input has focus.
                if (key === 'Escape' || (key === 'Delete' && !isInputLike)) {
                    event.preventDefault();
                }
                return;
            }

            // Alt+1-4 / page numbers select a method while NOT in a modal (handled here).
            if (event.altKey && ['1', '2', '3', '4'].includes(key)) {
                event.preventDefault();
                const method = PAYMENT_METHODS[Number(key) - 1].value;
                setPaymentMethod(method);
                return;
            }

            // F-keys are always ours; Delete/Escape must keep native behaviour inside inputs
            // (Escape is still handled later, but Delete must edit text).
            if (['F2', 'F3', 'F4', 'F7', 'F8', 'F10'].includes(key)) {
                event.preventDefault();
                if (event.repeat) return;
            }
            if (key === 'Escape' || (key === 'Delete' && !isInputLike)) {
                event.preventDefault();
            }

            // While a modal is open, only Escape is handled here (modals own the rest).
            if (modalOpen && key !== 'Escape') return;

            if (key === 'F3') {
                // Never leave the payment / receipt steps with F3 (would orphan a saved sale).
                if (billingStep !== 'cart') return;
                setFocusArea('search');
                focusSearch();
                return;
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
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            const next = (paymentIndex + 1) % PAYMENT_METHODS.length;
            setPaymentMethod(PAYMENT_METHODS[next].value);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = (paymentIndex - 1 + PAYMENT_METHODS.length) % PAYMENT_METHODS.length;
            setPaymentMethod(PAYMENT_METHODS[next].value);
            return;
        }
        // Alt+1-4 selects a payment method directly (use code so numpad and main row both work).
        if (event.altKey && ['1', '2', '3', '4'].includes(event.code)) {
            event.preventDefault();
            const method = PAYMENT_METHODS[Number(event.code.at(-1)) - 1].value;
            setPaymentMethod(method);
            return;
        }
        // 1-4 (main row or numpad) select a method directly from the method row (not an input).
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target?.tagName === 'SELECT') {
            // While typing in the Cash received input, digits must type normally (no method switch).
            return;
        }
        if (['1', '2', '3', '4'].includes(event.key)) {
            event.preventDefault();
            setPaymentMethod(PAYMENT_METHODS[Number(event.key) - 1].value);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            handleConfirmPayment();
        }
    };

    const handleReceiptOptionKeyDown = (event) => {
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
                                No matching products found.
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
                                            <span className="text-gray-500 dark:text-slate-400">Discount</span>
                                            <strong className="text-gray-500 dark:text-slate-400">-{formatMoney(discountValue)}</strong>
                                        </div>
                                        <div className="flex items-center justify-between text-lg pt-3 border-t border-gray-100 dark:border-slate-800">
                                            <span className="font-semibold text-gray-900 dark:text-slate-100">Total</span>
                                            <strong className="text-blue-600 dark:text-blue-400">{formatMoney(total)}</strong>
                                        </div>
                                    </div>

                                    <div className="space-y-2 mb-6">
                                        <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Discount amount</label>
                                        <input
                                            ref={discountInputRef}
                                            type="text"
                                            inputMode="decimal"
                                            min="0"
                                            step="0.01"
                                            value={discountAmount}
                                            onChange={(e) => setDiscountAmount(e.target.value)}
                                            className="w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-3.5 py-2.5 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                                            placeholder="0.00"
                                        />
                                        <div className={`text-xs ${approvalRequired ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-slate-400'}`}>
                                            Discount approval limit: {config.discountApprovalLimitPercent}%
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
                                        onClick={openPaymentStep}
                                        disabled={cart.length === 0}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-600 shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    >
                                        <Printer size={16} />
                                        Proceed to Payment (F10)
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

                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-6">
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
                            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Use arrow keys and Enter. Default is Print receipt.</p>
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
                            {completedReceipt && (
                                <div className="mt-6 rounded-2xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-3 text-sm">
                                    <div className="text-gray-600 dark:text-slate-400">Saved sale</div>
                                    <div className="font-semibold text-gray-900 dark:text-slate-100">{completedReceipt.receipt_no} • {formatMoney(completedReceipt.total)}</div>
                                </div>
                            )}
                        </div>
                    )}
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
                        <span><strong>F2</strong> Discount</span>
                        <span><strong>F4</strong> Edit qty</span>
                        {hasCustomerAttachFeature && <span><strong>F7</strong> Attach customer</span>}
                        <span><strong>F8</strong> New sale</span>
                        <span><strong>F10</strong> Payment</span>
                        <span><strong>Esc</strong> Back/Cancel</span>
                        <span><strong>Delete</strong> Remove line</span>
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
        </div>
    );
}
