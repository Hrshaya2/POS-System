// Stock Management - one cohesive page with internal sections:
//   Items (category-first browser), History, Stock Take, Import, Alerts.
// Offline-first: reads come from the IndexedDB cache; every write mutates the
// cache optimistically and rides the pendingStockOps queue to the server.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes, Search, Plus, Pencil, Trash2, Wrench,
  Barcode as BarcodeIcon, CheckSquare, Square, Printer,
  History, ClipboardCheck, Upload, TrendingDown, LayoutGrid,
  FileSpreadsheet, FileText, AlertTriangle,
  ChevronDown, MoreHorizontal, Layers
} from 'lucide-react';
import { exportToExcelWithTotals, exportToPdf } from '../utils/reportExport';
import { useAuth } from '../context/AuthContext';
import {
  refreshStockData, loadStockData, createCategory, updateCategory,
  deleteCategory, deleteCategories, saveItem, deleteItem, adjustStock,
  resetLocalStockCache, filterDeletedCategories, deleteAllStock
} from '../services/stockService';
import CategoryGrid from '../components/Stock/CategoryGrid';
import ManageCategoriesModal from '../components/Stock/ManageCategoriesModal';
import ProductFormModal from '../components/Stock/ProductFormModal';
import AdjustStockModal from '../components/Stock/AdjustStockModal';
import ItemDetailModal from '../components/Stock/ItemDetailModal';
import BatchPrintModal from '../components/Stock/BatchPrintModal';
import StockHistoryTab from '../components/Stock/StockHistoryTab';
import StockTakeTab from '../components/Stock/StockTakeTab';
import ImportTab from '../components/Stock/ImportTab';
import AlertsPanel from '../components/Stock/AlertsPanel';
// Static (not dynamic) import: `window.open()` must run inside the click handler's
// user-gesture context. A dynamic import() defers it into a promise callback,
// which the browser treats as NOT user-initiated and silently blocks.
import {
  DEFAULT_LABEL_WIDTH_MM, DEFAULT_LABEL_HEIGHT_MM, LABEL_SIZE_VERSION,
  printBarcodeLabel
} from '../utils/barcode';

const PAGE_TABS = [
  { id: 'items', label: 'Items', icon: LayoutGrid },
  { id: 'history', label: 'History', icon: History },
  { id: 'take', label: 'Stock Take', icon: ClipboardCheck },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'alerts', label: 'Alerts', icon: TrendingDown }
];

// How many items to show under one category heading in the global search
// results. Kept short so the category-first structure stays readable; anything
// beyond this collapses into a "click to view all" line that drills into the
// full category list.
const SEARCH_GROUP_LIMIT = 6;

// Saved label sizes from an older build (the original 40x30 default) would
// silently override the intended 35x25 sticker, so they are discarded. The
// version stamp is only added by newer builds, which means "no stamp" is also
// treated as stale. Settings the user changes after this version are kept.
const loadLabelSize = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('pos_label_size'));
    if (saved?.version === LABEL_SIZE_VERSION && saved?.widthMm && saved?.heightMm) {
      return { widthMm: Number(saved.widthMm), heightMm: Number(saved.heightMm) };
    }
  } catch (err) { /* ignore malformed cache */ }
  return { widthMm: DEFAULT_LABEL_WIDTH_MM, heightMm: DEFAULT_LABEL_HEIGHT_MM };
};

// ---- Stock export (Excel / PDF) ----
// Exports the CURRENT filtered list (category + search respected) so what you
// see is what you get — consistent with the Reports page export behaviour.
const STOCK_EXPORT_COLS = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'name', label: 'Item', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'barcode', label: 'Barcode', type: 'text' },
  { key: 'unit', label: 'Unit', type: 'text' },
  { key: 'quantity', label: 'Qty', type: 'number', align: 'center' },
  { key: 'low_stock_threshold', label: 'Low Stock At', type: 'number', align: 'center' },
  { key: 'cost_price', label: 'Unit Cost', type: 'money', align: 'right' },
  { key: 'sell_price', label: 'Unit Price', type: 'money', align: 'right' },
  { key: 'stock_value', label: 'Stock Value (cost)', type: 'money', align: 'right' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'sync', label: 'Sync', type: 'text' }
];

const stockExportRows = (list) => (list || []).map((i) => {
  const qty = Number(i.quantity || 0);
  const threshold = Number(i.low_stock_threshold ?? 5);
  const cost = i.cost_price == null ? 0 : Number(i.cost_price);
  return {
    category: i.category || 'Uncategorised',
    name: i.name || '',
    sku: i.sku || '',
    barcode: Array.isArray(i.barcodes) && i.barcodes.length ? i.barcodes.join(', ') : '',
    unit: i.unit || 'pcs',
    quantity: qty,
    low_stock_threshold: threshold,
    cost_price: cost,
    sell_price: Number(i.sell_price || 0),
    stock_value: Math.round(qty * cost * 100) / 100,
    status: i.is_service ? 'Service' : qty <= 0 ? 'Out of stock' : qty <= threshold ? 'Low stock' : 'OK',
    sync: i.syncStatus === 'pending' ? 'Pending' : 'Synced'
  };
});

const stockExportTotals = (rows) => ({
  quantity: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
  stock_value: Math.round(rows.reduce((s, r) => s + Number(r.stock_value || 0), 0) * 100) / 100
});

const exportStock = (rows, format) => {
  const date = new Date().toISOString().slice(0, 10);
  const name = `stock_export_${date}`;
  if (format === 'excel') exportToExcelWithTotals(rows, name, STOCK_EXPORT_COLS, stockExportTotals(rows));
  else exportToPdf(STOCK_EXPORT_COLS, rows, `Stock Export ${date}`, stockExportTotals(rows));
};

// ---- Low-stock export (PDF reorder report) ----
// Slimmer column set than the full stock export: just what a reorder decision
// needs. Reuses the shared stock row mapper so the figures match exactly.
const LOW_STOCK_EXPORT_COLS = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'name', label: 'Item', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'quantity', label: 'Qty', type: 'number', align: 'center' },
  { key: 'low_stock_threshold', label: 'Low Stock At', type: 'number', align: 'center' },
  { key: 'cost_price', label: 'Unit Cost', type: 'money', align: 'right' },
  { key: 'stock_value', label: 'Stock Value (cost)', type: 'money', align: 'right' },
  { key: 'status', label: 'Status', type: 'text' }
];

const exportLowStockPdf = (list) => {
  const rows = stockExportRows(list || []);
  if (!rows.length) {
    alert('Nothing to export — no items are at or below their low-stock threshold.');
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  exportToPdf(LOW_STOCK_EXPORT_COLS, rows, `Low Stock Export ${date}`, stockExportTotals(rows));
};

export default function StockManagementPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';

  const [pageTab, setPageTab] = useState('items');
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [takes, setTakes] = useState([]);
  const [imports, setImports] = useState([]);
  const [loading, setLoading] = useState(true);

  // Section 1 state
  const [activeCategory, setActiveCategory] = useState(null); // null = grid view
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Modals / flows
  const [showManageCategories, setShowManageCategories] = useState(false);
  const [productFormState, setProductFormState] = useState(null); // { item|null }
  const [adjustItem, setAdjustItem] = useState(null);
  const [detailItem, setDetailItem] = useState(null);
  const [batchPrintOpen, setBatchPrintOpen] = useState(false);
  const [labelSize, setLabelSize] = useState(loadLabelSize);

  const applyData = useCallback((data) => {
    // Deleted categories are filtered HERE, at the one place all page data
    // enters. Previously only CategoryGrid filtered them, so a deleted category
    // kept showing in the item form's dropdown, stock-take, exports and import.
    setCategories(filterDeletedCategories(data.categories));
    setItems(data.items);
    setTakes(data.takes);
    setImports(data.imports || []);
  }, []);

  const reload = useCallback(async () => {
    applyData(await refreshStockData());
  }, [applyData]);

  // Clears this device's stock cache + queued writes, then reloads from the
  // server. Guarded because it discards anything not yet uploaded.
  const handleResetLocal = useCallback(async () => {
    const ok = window.confirm(
      'Clear the stock data saved on THIS device and reload from the database?\n\n' +
      'Use this if categories or items appear here that are not in the database.\n\n' +
      'WARNING: any changes still waiting to upload will be discarded.'
    );
    if (!ok) return;
    try {
      await resetLocalStockCache();
      await reload();
    } catch (err) {
      alert(err.message || 'Could not reset the local stock data');
    }
  }, [reload]);

  // Removes EVERY item and category. Two confirms because this is not
  // recoverable - the rows are deleted from the database, not just hidden.
  const handleDeleteAllStock = useCallback(async () => {
    const count = `${items.length} item(s) and ${categories.length} category(ies)`;
    if (!window.confirm(`Permanently delete ALL ${count} from stock?\n\nThis removes them from the database and cannot be undone.`)) return;
    if (!window.confirm('Are you sure? All stock items and categories will be deleted.')) return;
    try {
      const res = await deleteAllStock();
      setActiveCategory(null);
      setSelectedIds(new Set());
      await reload();
      alert(`Deleted ${res.items} item(s) and ${res.categories} category(ies).`);
    } catch (err) {
      alert(err.message || 'Could not delete all stock data');
    }
  }, [items.length, categories.length, reload]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Cache paint must never wedge the page: any failure (corrupt IndexedDB
      // record, storage denied, etc.) falls back to empty arrays, we still
      // clear the loading flag, and the server refresh below tries again.
      let data;
      try {
        data = await loadStockData();
      } catch (err) {
        console.error('[stock] Local cache load failed:', err);
        data = { categories: [], items: [], takes: [], movements: [] };
      }
      if (!cancelled) {
        applyData(data);
        setLoading(false);
        try {
          await reload();
        } catch (err) {
          console.warn('[stock] Server refresh failed:', err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [applyData, reload]);

  const existingSkus = useMemo(() => items.map((i) => i.sku), [items]);

  // Search: global across all categories at grid level; local inside one.
  //
  // Searching a CATEGORY NAME must return that category, even when it holds no
  // matching item - otherwise typing a category name looks like a dead search.
  // Tombstoned categories stay hidden so deleted ones can't reappear via search.
  const matchingCategories = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q || activeCategory) return [];
    return filterDeletedCategories(categories).filter((c) =>
      String(c?.name || '').toLowerCase().includes(q)
    );
  }, [categories, searchTerm, activeCategory]);

  // Categories hit by NAME. Their items are pulled into the results even when the
  // item text itself doesn't contain the query - searching "Chargers" must show
  // the chargers, not only items with "Chargers" written in their name.
  const matchedCategoryNames = useMemo(
    () => new Set(matchingCategories.map((c) => String(c?.name || '').trim())),
    [matchingCategories]
  );

  const filteredItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return items.filter((i) => {
      if (activeCategory && i.category !== activeCategory) return false;
      if (!q) return true;
      // Belongs to a category whose name matched -> always include.
      if (matchedCategoryNames.has(String(i.category || '').trim())) return true;
      return (
        String(i.name || '').toLowerCase().includes(q)
        || String(i.sku || '').toLowerCase().includes(q)
        || String(i.category || '').toLowerCase().includes(q)
        || String(i.description || '').toLowerCase().includes(q)
        || String(i.barcode || '').toLowerCase().includes(q)
        || (Array.isArray(i.barcodes) && i.barcodes.some((b) => String(b).toLowerCase().includes(q)))
      );
    });
  }, [items, activeCategory, searchTerm, matchedCategoryNames]);

  // All non-service items at/below their own low-stock threshold — the same
  // rule as the Alerts tab. Sorted most-critical first (out of stock on top),
  // this backs the tab badge count and the low-stock PDF export.
  const lowStockItems = useMemo(
    () => items
      .filter((i) => !i.is_service && Number(i.quantity || 0) <= Number(i.low_stock_threshold ?? 5))
      .sort((a, b) =>
        (Number(a.quantity) || 0) - (Number(b.quantity) || 0)
        || String(a.name || '').localeCompare(String(b.name || ''))
      ),
    [items]
  );
  const lowStockCount = lowStockItems.length;

  const handleExportLowStockPdf = () => exportLowStockPdf(lowStockItems);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const updateLabelSizeField = (key, value) => {
    const num = Math.max(10, Math.min(200, Number(value) || 0));
    setLabelSize((prev) => {
      // Stamp the version so loadLabelSize keeps this choice on future loads.
      const next = { ...prev, [key]: num, version: LABEL_SIZE_VERSION };
      try { localStorage.setItem('pos_label_size', JSON.stringify(next)); } catch (err) { /* ignore */ }
      return next;
    });
  };

  // ---- Write handlers (local-first + queued sync via stockService) ----

  const handleSaveProductForm = async (form) => {
    const existing = productFormState?.item || null;
    const saved = await saveItem(form, existing, user);
    setProductFormState(null);
    await reload();
    setDetailItem(saved); // show the saved item incl. its generated barcode
  };

  const handleDeleteItem = async (item) => {
    if (!isAdmin) return;
    if (!window.confirm(`Delete "${item.name}" (${item.sku})? This cannot be undone.`)) return;
    try {
      await deleteItem(item);
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(item.id); return n; });
      await reload();
    } catch (err) {
      alert(err.message || 'Could not delete the item');
    }
  };

  const handleAdjustConfirm = async ({ change, reason, note, allowNegative }) => {
    await adjustStock({ item: adjustItem, change, reason, note, allowNegative }, user);
    setAdjustItem(null);
    await reload();
  };

  // `printBarcodeLabel` is imported statically at the top of this file. It MUST
  // NOT be loaded with a dynamic `import()` here: that defers `window.open()`
  // into a promise callback, outside the click's user-gesture context, so the
  // browser silently blocks the popup and the button appears to do nothing.
  const printSingleLabel = (item) => {
    printBarcodeLabel({
      code: item.sku, name: item.name, price: item.sell_price,
      widthMm: labelSize.widthMm, heightMm: labelSize.heightMm
    });
  };

  const handleBulkCreateCategories = async (names) => {
    let ok = 0;
    let fail = 0;
    for (const name of names) {
      try {
        await createCategory({ name }, user);
        ok += 1;
      } catch (err) {
        console.warn('[stock] legacy category import failed:', name, err);
        fail += 1;
      }
    }
    await reload();
    return { ok, fail };
  };

  const jumpToItem = async (alertItem) => {
    setPageTab('items');
    setActiveCategory(alertItem.category);
    setSearchTerm(String(alertItem.sku || alertItem.name || '').trim());
    const full = items.find((i) => i.id === alertItem.id);
    if (full) setTimeout(() => setDetailItem(full), 50);
  };

  return (
    <PageShell
      pageTab={pageTab} setPageTab={setPageTab}
      isAdmin={isAdmin}
      lowStockCount={lowStockCount}
      loading={loading}
      labelSize={labelSize}
      updateLabelSizeField={updateLabelSizeField}
      onManageCategories={() => setShowManageCategories(true)}
      onAddItem={() => setProductFormState({ item: null })}
      onResetLocal={handleResetLocal}
      onDeleteAllStock={handleDeleteAllStock}
      categories={categories} items={items} takes={takes} user={user}
      imports={imports}
      existingSkus={existingSkus} filteredItems={filteredItems}
      matchingCategories={matchingCategories}
      activeCategory={activeCategory} setActiveCategory={setActiveCategory}
      searchTerm={searchTerm} setSearchTerm={setSearchTerm}
      selectedIds={selectedIds} toggleSelect={toggleSelect}
      detailItem={detailItem} setDetailItem={setDetailItem}
      productFormState={productFormState} setProductFormState={setProductFormState}
      adjustItem={adjustItem} setAdjustItem={setAdjustItem}
      batchPrintOpen={batchPrintOpen} setBatchPrintOpen={setBatchPrintOpen}
      showManageCategories={showManageCategories} setShowManageCategories={setShowManageCategories}
      reload={reload}
      onSaveForm={handleSaveProductForm}
      onDeleteItem={handleDeleteItem}
      onAdjustConfirm={handleAdjustConfirm}
      onPrintLabel={printSingleLabel}
      onExportLowStockPdf={handleExportLowStockPdf}
      onJumpToItem={jumpToItem}
      onBulkCreateCategories={handleBulkCreateCategories}
    />
  );
}

// Small self-contained dropdown. Closes on outside click and Escape, and closes
// after any item is chosen, so keyboard and mouse users get the same behaviour.
function ActionMenu({ label, icon: Icon, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Closes the menu first, then runs the action, so the dialog that opens
  // (confirm/print) never renders underneath a leftover overlay.
  const pick = (fn) => () => { setOpen(false); if (typeof fn === 'function') fn(); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-300 text-sm font-semibold shadow-sm transition-colors"
      >
        {Icon && <Icon size={16} />}
        <span>{label}</span>
        <ChevronDown size={15} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 min-w-[250px] bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 shadow-xl py-1 overflow-hidden"
        >
          {React.Children.map(children, (child) => (
            React.isValidElement(child) && typeof child.props.onClick === 'function'
              ? React.cloneElement(child, { onClick: pick(child.props.onClick) })
              : child
          ))}
        </div>
      )}
    </div>
  );
}

// NOTE: the hover variants are written as `dark:hover:` (NOT `hover:dark:`).
// Tailwind stacks variants outermost-first, so `hover:dark:bg-slate-950` is not a
// valid utility and is dropped by the compiler - which silently left this menu's
// hover state unchanged in dark mode.
const MENU_ITEM = 'w-full text-left px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-white transition-colors flex items-center gap-2.5 disabled:opacity-40 disabled:hover:bg-transparent';

function PageShell(props) {
  const {
    pageTab, setPageTab, isAdmin, lowStockCount, loading,
    onManageCategories, onAddItem,
    categories, items, takes, user, filteredItems,
    matchingCategories,
    imports,
    activeCategory, setActiveCategory, searchTerm, setSearchTerm,
    selectedIds, toggleSelect, setDetailItem,
    setProductFormState, setAdjustItem, setBatchPrintOpen,
    reload, onJumpToItem, onDeleteItem, onPrintLabel, onExportLowStockPdf,
    onResetLocal, onDeleteAllStock
  } = props;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center">
            <Boxes size={26} className="mr-2.5 text-blue-600 dark:text-blue-400" /> Stock Management
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Categories, products, movements and counts — everything inventory in one place.
            {!isAdmin && <span className="ml-1 text-gray-400 dark:text-slate-500">You can add items &amp; categories; edits/deletes need admin.</span>}
          </p>
        </div>
        {/* Primary actions only. Secondary/destructive actions live in the two
            menus beside them so the header stays readable on smaller screens -
            the header used to render six full-width buttons that wrapped onto
            three lines on a laptop.
            The lead button is Add Category: the page is category-first, so a
            new category has to exist before items can be filed under it. Adding
            an item still happens inside a category ("Add Item here"), and is
            also kept in the More menu for the grid level. */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            onClick={onManageCategories}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-sm transition-colors"
          >
            <Plus size={16} /> Add Category
          </button>

          <ActionMenu label="Export" icon={FileSpreadsheet}>
            <button
              type="button"
              onClick={() => exportStock(stockExportRows(filteredItems), 'excel')}
              className={MENU_ITEM}
            >
              <FileSpreadsheet size={15} className="text-emerald-600" /> Export stock list (Excel)
            </button>
            <button
              type="button"
              onClick={() => exportStock(stockExportRows(filteredItems), 'pdf')}
              className={MENU_ITEM}
            >
              <FileText size={15} className="text-rose-600" /> Export stock list (PDF)
            </button>
            <button
              type="button"
              onClick={onExportLowStockPdf}
              disabled={lowStockCount === 0}
              title={lowStockCount === 0 ? 'No items are at or below their low-stock threshold' : `Export ${lowStockCount} low-stock item(s)`}
              className={MENU_ITEM}
            >
              <AlertTriangle size={15} className="text-amber-500" />
              Low-stock report (PDF){lowStockCount > 0 ? ` (${lowStockCount})` : ''}
            </button>
          </ActionMenu>

          <ActionMenu label="More" icon={MoreHorizontal}>
            <button
              type="button"
              onClick={onAddItem}
              title="Add a product item (items belong inside a category)"
              className={MENU_ITEM}
            >
              <Plus size={15} className="text-blue-500" /> Add item
            </button>
            <button
              type="button"
              onClick={onManageCategories}
              className={MENU_ITEM}
            >
              <Layers size={15} className="text-gray-500 dark:text-slate-400" /> Manage categories
            </button>
            <button
              type="button"
              onClick={onResetLocal}
              title="Clear stock data saved on this device and reload from the database"
              className={MENU_ITEM}
            >
              <Trash2 size={15} className="text-gray-500 dark:text-slate-400 " /> Reset local cache
            </button>
            {isAdmin && onDeleteAllStock && (
              <>
                <div className="my-1 border-t border-gray-100 dark:border-slate-800" />
                <button
                  type="button"
                  onClick={onDeleteAllStock}
                  className={`${MENU_ITEM} text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-700 dark:hover:text-rose-300`}
                >
                  <Trash2 size={15} /> Delete all items &amp; categories
                </button>
              </>
            )}
          </ActionMenu>
        </div>
      </div>

      {/* Internal section tabs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-100 dark:border-slate-800 p-1.5 inline-flex flex-wrap gap-1 shadow-sm sticky top-0 z-20">
        {PAGE_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = pageTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setPageTab(tab.id)}
              className={`flex items-center space-x-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                isActive ? 'bg-blue-600 text-white shadow' : 'text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-slate-700 '
              }`}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
              {tab.id === 'alerts' && lowStockCount > 0 && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white dark:bg-slate-800 text-rose-600 dark:text-rose-400' : 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300'}`}>
                  {lowStockCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Section bodies */}
      {loading ? (
        <p className="text-gray-400 dark:text-slate-500 p-8 text-center">Loading stock data…</p>
      ) : pageTab === 'history' ? (
        <StockHistoryTab
          items={items}
          onOpenItem={(m) => { const full = items.find((i) => i.id === m.accessoryId); if (full) setDetailItem(full); }}
        />
      ) : pageTab === 'take' ? (
        <StockTakeTab
          categories={categories} items={items} takes={takes}
          user={user} isAdmin={isAdmin} onDataChanged={reload}
        />
      ) : pageTab === 'import' ? (
        <ImportTab items={items} categories={categories} imports={imports} user={user} onDataChanged={reload} />
      ) : pageTab === 'alerts' ? (
        <AlertsPanel onJumpToItem={onJumpToItem} onExportLowStockPdf={onExportLowStockPdf} />
      ) : (
        <ItemsSection
          activeCategory={activeCategory} setActiveCategory={setActiveCategory}
          searchTerm={searchTerm} setSearchTerm={setSearchTerm}
          items={items} categories={categories} filteredItems={filteredItems} isAdmin={isAdmin}
          matchingCategories={matchingCategories}
          selectedIds={selectedIds} toggleSelect={toggleSelect}
          onManageCategories={onManageCategories}
          onAddItem={onAddItem}
          onAdd={() => setProductFormState({ item: null })}
          onView={(item) => setDetailItem(item)}
          onEdit={(item) => setProductFormState({ item })}
          onDelete={onDeleteItem}
          onAdjust={(item) => setAdjustItem(item)}
          onPrintLabel={onPrintLabel}
          onBatchPrint={() => setBatchPrintOpen(true)}
        />
      )}

      <PageModals {...props} />
    </div>
  );
}

function PageModals(props) {
  const {
    isAdmin, categories, items, user, existingSkus,
    activeCategory, setActiveCategory, detailItem, setDetailItem,
    productFormState, setProductFormState, adjustItem, setAdjustItem,
    batchPrintOpen, setBatchPrintOpen, labelSize, updateLabelSizeField,
    selectedIds, filteredItems, reload,
    onSaveForm, onAdjustConfirm, onPrintLabel,
    showManageCategories, setShowManageCategories, onBulkCreateCategories
  } = props;

  return (
    <>
      {showManageCategories && (
        <ManageCategoriesModal
          categories={categories}
          items={items}
          isAdmin={isAdmin}
          onClose={() => setShowManageCategories(false)}
          onCreate={async (data) => { await createCategory(data, user); await reload(); }}
          onBulkCreate={onBulkCreateCategories}
          onUpdate={async (cat, fields) => { await updateCategory(cat, fields); await reload(); }}
          onDelete={async (cat) => {
            await deleteCategory(cat);
            setActiveCategory((c) => (c === cat.name ? null : c));
            await reload();
          }}
          onBulkDelete={async (cats) => {
            const names = new Set(cats.map((c) => c.name));
            await deleteCategories(cats);
            // Drop the grid filter if it pointed at a category just removed.
            setActiveCategory((c) => (names.has(c) ? null : c));
            await reload();
          }}
        />
      )}

      {productFormState && (
        <ProductFormModal
          item={productFormState.item}
          categories={categories}
          presetCategory={activeCategory}
          existingSkus={existingSkus}
          canEdit={isAdmin || !productFormState.item}
          onSave={onSaveForm}
          onClose={() => setProductFormState(null)}
        />
      )}

      {adjustItem && (
        <AdjustStockModal item={adjustItem} onClose={() => setAdjustItem(null)} onConfirm={onAdjustConfirm} />
      )}

      {detailItem && !adjustItem && (
        <ItemDetailModal
          item={items.find((i) => i.id === detailItem.id) || detailItem}
          isAdmin={isAdmin}
          onClose={() => setDetailItem(null)}
          onAdjust={(item) => setAdjustItem(item)}
          onEdit={(item) => setProductFormState({ item })}
          onPrintLabel={onPrintLabel}
        />
      )}

      {batchPrintOpen && (
        <BatchPrintModal
          items={filteredItems.filter((i) => selectedIds.has(i.id))}
          labelSize={labelSize}
          updateLabelSizeField={updateLabelSizeField}
          onClose={() => setBatchPrintOpen(false)}
        />
      )}
    </>
  );
}

function ItemsSection(props) {
  const {
    activeCategory, setActiveCategory, searchTerm, setSearchTerm,
    items, categories, filteredItems, isAdmin, matchingCategories = [],
    selectedIds, toggleSelect,
    onManageCategories, onAddItem,
    onAdd, onView, onEdit, onDelete, onAdjust, onPrintLabel, onBatchPrint
  } = props;

  const categoryStats = useMemo(() => {
    const map = new Map();
    for (const i of items) {
      if (!map.has(i.category)) map.set(i.category, { count: 0, qty: 0 });
      const s = map.get(i.category);
      s.count += 1;
      s.qty += Number(i.quantity || 0);
    }
    return map;
  }, [items]);

  const selectedCount = filteredItems.filter((i) => selectedIds.has(i.id)).length;

  const searchInputRef = useRef(null);

  // Hardware barcode scanners "type" the code and then send Enter. Focus the box
  // on mount so a scan lands here straight after the page loads - otherwise the
  // digits go nowhere and it looks like the reader isn't working.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // A scan ends with Enter. If that single scan matched exactly one item, open it
  // immediately - this is what makes the reader feel instant. Multiple matches
  // keep the list so the user can pick.
  const handleSearchKeyDown = (e) => {
    if (e.key !== 'Enter' || !searchTerm.trim()) return;
    if (filteredItems.length === 1) {
      e.preventDefault();
      onView(filteredItems[0]);
    }
  };

  // Search results are grouped by category so related items stay together
  // instead of arriving as one long mixed list. Categories are sorted
  // alphabetically, then items by name within each group.
  const searchGroups = useMemo(() => {
    const groups = new Map();
    for (const item of filteredItems) {
      const name = String(item.category || '').trim() || 'Uncategorised';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(item);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, list]) => ({
        name,
        items: [...list].sort((x, y) =>
          String(x.name || '').localeCompare(String(y.name || ''))
          || String(x.sku || '').localeCompare(String(y.sku || ''))
        )
      }));
  }, [filteredItems]);

  return (
    <div className="space-y-4">
      {/* Search — global at grid level, local inside a category */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={activeCategory ? `Search within ${activeCategory}…` : 'Search items, SKUs, barcodes or categories…'}
            className="w-full pl-10 pr-10 py-2.5 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:border-blue-300 shadow-sm"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 dark:text-slate-500 hover:text-gray-700">
              ×
            </button>
          )}
        </div>
      </div>

      {!activeCategory ? (
        /* ---- Grid level: category cards + global search results ---- */
        <>
          {searchTerm.trim() && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-800 overflow-hidden shadow-sm">
              {filteredItems.length === 0 && matchingCategories.length === 0 ? (
                /* No matches: the filter produced nothing, so say so explicitly.
                   Without this the results panel vanished and the untouched
                   CategoryGrid below looked like the search had done nothing. */
                <div className="px-5 py-8 text-center">
                  <p className="text-sm font-semibold text-gray-700 dark:text-slate-300">
                    No items or categories match “{searchTerm.trim()}”
                  </p>
                  <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">
                    Searched category names, item names, SKUs and manufacturer barcodes.
                  </p>
                </div>
              ) : (
                <>
                  {matchingCategories.length > 0 && (
                    /* Matching CATEGORIES first - typing a category name is a
                       legitimate search that previously returned nothing at all
                       unless an item also happened to match. */
                    <div className="px-5 py-3 border-b border-gray-50 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-950/50">
                      <p className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-2">
                        {matchingCategories.length} categor{matchingCategories.length === 1 ? 'y' : 'ies'}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {matchingCategories.map((c) => (
                          <button
                            key={c.id || c.name}
                            type="button"
                            onClick={() => { setActiveCategory(c.name); setSearchTerm(''); }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-300 rounded-lg text-xs font-semibold hover:bg-blue-50 hover:dark:bg-blue-500/10 transition-colors"
                          >
                            <Layers size={12} />
                            {c.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {filteredItems.length > 0 && (
                    <>
                  <p className="px-5 py-2.5 text-xs font-semibold text-gray-500 dark:text-slate-400 border-b border-gray-50 dark:border-slate-800">
                    {filteredItems.length} result{filteredItems.length === 1 ? '' : 's'} in {searchGroups.length} categor{searchGroups.length === 1 ? 'y' : 'ies'}
                  </p>

              <div className="max-h-[26rem] overflow-y-auto">
                {searchGroups.map((group) => (
                  <section key={group.name} className="border-b border-gray-100 dark:border-slate-800 last:border-b-0">
                    {/* Clicking the header drills into that category with the
                        search term kept, so you land on the full list. */}
                    <button
                      type="button"
                      onClick={() => { setActiveCategory(group.name); setSearchTerm(''); }}
                      title={`Open the ${group.name} category`}
                      className="w-full flex items-center justify-between gap-3 px-5 py-2 bg-gray-50/80 dark:bg-slate-950/80 hover:bg-blue-50/70 transition-colors text-left"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-gray-700 dark:text-slate-300 uppercase tracking-wide truncate">
                          {group.name}
                        </span>
                        <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-white dark:bg-slate-800 text-gray-500 dark:text-slate-400 border border-gray-200 dark:border-slate-700">
                          {group.items.length}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-blue-600 dark:text-blue-400 font-medium">View all</span>
                    </button>

                    <div className="divide-y divide-gray-50 dark:divide-slate-800">
                      {group.items.slice(0, SEARCH_GROUP_LIMIT).map((item) => (
                        <button key={item.id} onClick={() => onView(item)} className="w-full flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-blue-50/40 text-left transition-colors">
                          <div className="min-w-0">
                            <span className="text-sm font-semibold text-gray-900 dark:text-slate-100">{item.name}</span>
                            <span className="ml-2 text-[11px] font-mono text-gray-400 dark:text-slate-500">{item.sku}</span>
                          </div>
                          <span className={`shrink-0 text-sm font-bold ${Number(item.quantity) <= Number(item.low_stock_threshold ?? 5) ? 'text-rose-600 dark:text-rose-400' : 'text-gray-600 dark:text-slate-400'}`}>
                            {item.quantity}
                          </span>
                        </button>
                      ))}
                      {group.items.length > SEARCH_GROUP_LIMIT && (
                        <button
                          type="button"
                          onClick={() => { setActiveCategory(group.name); setSearchTerm(''); }}
                          className="w-full px-5 py-2 text-left text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50/50 transition-colors"
                        >
                          +{group.items.length - SEARCH_GROUP_LIMIT} more in {group.name} — click to view all
                        </button>
                      )}
                    </div>
                  </section>
                ))}
              </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* The full grid is hidden while a search is active: leaving it on
              screen underneath the results made it look like the search had
              done nothing. Clear the box (or the x) to get the grid back. */}
          {!searchTerm.trim() && (
            <CategoryGrid
              categories={categories}
              items={items}
              onOpenCategory={(name) => { setActiveCategory(name); setSearchTerm(''); }}
              onManageCategories={onManageCategories}
              onAddItem={onAddItem}
              isAdmin={isAdmin}
            />
          )}
        </>
      ) : (
        /* ---- Drill-in: item table for this category ---- */
        <CategoryTable
          categoryName={activeCategory}
          stat={categoryStats.get(activeCategory)}
          items={filteredItems}
          searchTerm={searchTerm}
          isAdmin={isAdmin}
          selectedIds={selectedIds}
          toggleSelect={toggleSelect}
          onBack={() => { setActiveCategory(null); setSearchTerm(''); }}
          onAdd={onAdd}
          onView={onView}
          onEdit={onEdit}
          onDelete={onDelete}
          onAdjust={onAdjust}
          onPrintLabel={onPrintLabel}
          onBatchPrint={onBatchPrint}
          selectedCount={selectedCount}
          totalCount={items.filter((i) => i.category === activeCategory).length}
        />
      )}
    </div>
  );
}

function CategoryTable(props) {
  const {
    categoryName, stat, items, isAdmin, searchTerm = '',
    selectedIds, toggleSelect,
    onBack, onAdd, onBatchPrint,
    selectedCount, onView, onEdit, onDelete, onAdjust, onPrintLabel
  } = props;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
      {/* Breadcrumb + toolbar */}
      <div className="px-6 py-4 border-b border-gray-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center text-sm text-gray-400 dark:text-slate-500">
            <button onClick={onBack} className="hover:text-blue-600 hover:dark:text-blue-400 font-medium">Categories</button>
            <span className="mx-1.5">/</span>
            <span className="font-bold text-gray-900 dark:text-slate-100">{categoryName}</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
            {items.length} item(s) · {Number(stat?.qty || 0).toLocaleString()} units in stock
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedCount > 0 && (
            <button onClick={onBatchPrint} className="flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-bold shadow transition-colors">
              <Printer size={15} className="mr-1.5" /> Print {selectedCount} Label{selectedCount === 1 ? '' : 's'}
            </button>
          )}
          <SelectAllButton items={items} selectedIds={selectedIds} toggleSelect={toggleSelect} />
          <button onClick={onAdd} className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow transition-colors">
            <Plus size={15} className="mr-1" /> Add Item here
          </button>
        </div>
      </div>

      <ItemRows items={items} isAdmin={isAdmin} selectedIds={selectedIds} toggleSelect={toggleSelect}
        searchTerm={searchTerm}
        onView={onView} onEdit={onEdit} onDelete={onDelete} onAdjust={onAdjust} onPrintLabel={onPrintLabel} />
    </div>
  );
}

// Rows implemented below.
function ItemRows({ items, isAdmin, selectedIds, toggleSelect, onView, onEdit, onDelete, onAdjust, onPrintLabel, searchTerm = '' }) {
  const fmt = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString());

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-400 dark:text-slate-500 uppercase bg-gray-50/70 dark:bg-slate-950/70">
          <tr>
            <th className="pl-6 pr-2 py-3 w-10"></th>
            <th className="px-3 py-3 text-left font-medium">SKU</th>
            <th className="px-3 py-3 text-left font-medium">Name</th>
            <th className="px-3 py-3 text-center font-medium">Qty</th>
            {isAdmin && <th className="px-3 py-3 text-right font-medium">Cost (Rs.)</th>}
            <th className="px-3 py-3 text-right font-medium">Sell Price (Rs.)</th>
            <th className="px-3 py-3 text-center font-medium">Status</th>
            <th className="px-6 py-3 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
          {items.length === 0 ? (
            /* A failed search and a genuinely empty category are different states
               and must not share one message - claiming "no items here yet"
               after a search wrongly implies the category is empty. */
            <tr><td colSpan={isAdmin ? 8 : 7} className="px-6 py-10 text-center text-gray-400 dark:text-slate-500">
              {searchTerm.trim()
                ? <>No items in this category match “{searchTerm.trim()}”.</>
                : 'No items here yet — use "Add Item here".'}
            </td></tr>
          ) : items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              isAdmin={isAdmin}
              isSelected={selectedIds.has(item.id)}
              toggleSelect={toggleSelect}
              onView={onView} onEdit={onEdit} onDelete={onDelete}
              onAdjust={onAdjust} onPrintLabel={onPrintLabel}
              fmt={fmt}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemRow({ item, isAdmin, isSelected, toggleSelect, onView, onEdit, onDelete, onAdjust, onPrintLabel, fmt }) {
  const qty = Number(item.quantity || 0);
  const low = !item.is_service && qty <= Number(item.low_stock_threshold ?? 5);

  return (
    <tr className={`transition-colors ${isSelected ? 'bg-indigo-50/50' : 'hover:bg-gray-50/70 hover:dark:bg-slate-950/70'}`}>
      <td className="pl-6 pr-2 py-3">
        {!item.is_service && (
          <button onClick={() => toggleSelect(item.id)} title="Select for batch label printing">
            {isSelected ? <CheckSquare size={17} className="text-indigo-600" /> : <Square size={17} className="text-gray-300 dark:text-slate-600 hover:text-gray-500" />}
          </button>
        )}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-gray-900 dark:text-slate-100 whitespace-nowrap">{item.sku}</td>
      <td className="px-3 py-3 max-w-[260px]">
        <button onClick={() => onView(item)} className="font-semibold text-gray-900 dark:text-slate-100 hover:text-blue-600 hover:dark:text-blue-400 text-left truncate block max-w-full">
          {item.name}
        </button>
        {item.is_service && <span className="ml-0 text-[9px] font-bold uppercase bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 px-1 py-0.5 rounded">Service</span>}
      </td>
      <td className={`px-3 py-3 text-center font-bold ${low ? 'text-rose-600 dark:text-rose-400' : 'text-gray-800 dark:text-slate-200'}`}>
        {item.is_service ? '—' : qty}
      </td>
      {isAdmin && <td className="px-3 py-3 text-right text-gray-500 dark:text-slate-400">{fmt(item.cost_price)}</td>}
      <td className="px-3 py-3 text-right font-semibold text-gray-900 dark:text-slate-100">{fmt(item.sell_price)}</td>
      <td className="px-3 py-3 text-center">
        {item.is_service
          ? <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30">N/A</span>
          : qty <= 0 ? <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30">OUT</span>
          : low ? <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-500/30">LOW</span>
          : <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/30">OK</span>}
      </td>
      <td className="px-6 py-3">
        <div className="flex justify-end space-x-1">
          <button onClick={() => onAdjust(item)} disabled={item.is_service} title="Adjust stock" className="p-2 text-orange-600 dark:text-orange-400 hover:bg-orange-50 hover:dark:bg-orange-500/10 rounded-lg transition-colors disabled:opacity-30">
            <Wrench size={16} />
          </button>
          <button onClick={() => onPrintLabel(item)} title="Print barcode label" className="p-2 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 hover:dark:bg-indigo-500/10 rounded-lg transition-colors">
            <BarcodeIcon size={16} />
          </button>
          {isAdmin && (
            <>
              <button onClick={() => onEdit(item)} title="Edit details" className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 hover:dark:bg-blue-500/10 rounded-lg transition-colors">
                <Pencil size={16} />
              </button>
              <button onClick={() => onDelete(item)} title="Delete item" className="p-2 text-rose-500 dark:text-rose-400 hover:bg-rose-50 hover:dark:bg-rose-500/10 rounded-lg transition-colors">
                <Trash2 size={16} />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function SelectAllButton({ items, selectedIds, toggleSelect }) {
  const selectable = items.filter((i) => !i.is_service);
  const allSelected = selectable.length > 0 && selectable.every((i) => selectedIds.has(i.id));
  return (
    <button
      onClick={() => selectable.forEach((i) => {
        if (allSelected === selectedIds.has(i.id)) toggleSelect(i.id);
      })}
      disabled={selectable.length === 0}
      className="flex items-center px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-gray-600 dark:text-slate-400 hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors disabled:opacity-40"
    >
      {allSelected ? <CheckSquare size={15} className="mr-1.5 text-indigo-600 dark:text-indigo-400" /> : <Square size={15} className="mr-1.5 text-gray-400 dark:text-slate-500" />}
      Select all
    </button>
  );
}