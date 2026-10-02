// Stock Management - one cohesive page with internal sections:
//   Items (category-first browser), History, Stock Take, Import, Alerts.
// Offline-first: reads come from the IndexedDB cache; every write mutates the
// cache optimistically and rides the pendingStockOps queue to the server.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes, Search, Plus, Pencil, Trash2, Wrench,
  Barcode as BarcodeIcon, CheckSquare, Square, Printer,
  History, ClipboardCheck, Upload, TrendingDown, LayoutGrid,
  FileSpreadsheet, FileText, AlertTriangle
} from 'lucide-react';
import { exportToExcelWithTotals, exportToPdf } from '../utils/reportExport';
import { useAuth } from '../context/AuthContext';
import {
  refreshStockData, loadStockData, createCategory, updateCategory,
  deleteCategory, deleteCategories, saveItem, deleteItem, adjustStock
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

const PAGE_TABS = [
  { id: 'items', label: 'Items', icon: LayoutGrid },
  { id: 'history', label: 'History', icon: History },
  { id: 'take', label: 'Stock Take', icon: ClipboardCheck },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'alerts', label: 'Alerts', icon: TrendingDown }
];

const loadLabelSize = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('pos_label_size'));
    if (saved?.widthMm && saved?.heightMm) return saved;
  } catch (err) { /* ignore malformed cache */ }
  return { widthMm: 40, heightMm: 30 };
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
    setCategories(data.categories);
    setItems(data.items);
    setTakes(data.takes);
    setImports(data.imports || []);
  }, []);

  const reload = useCallback(async () => {
    applyData(await refreshStockData());
  }, [applyData]);

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
  const filteredItems = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return items.filter((i) => {
      if (activeCategory && i.category !== activeCategory) return false;
      if (!q) return true;
      return (
        String(i.name || '').toLowerCase().includes(q)
        || String(i.sku || '').toLowerCase().includes(q)
        || String(i.category || '').toLowerCase().includes(q)
        || (Array.isArray(i.barcodes) && i.barcodes.some((b) => String(b).toLowerCase().includes(q)))
      );
    });
  }, [items, activeCategory, searchTerm]);

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
      const next = { ...prev, [key]: num };
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

  const printSingleLabel = (item) => {
    import('../utils/barcode').then(({ printBarcodeLabel }) => {
      printBarcodeLabel({
        code: item.sku, name: item.name, price: item.sell_price,
        widthMm: labelSize.widthMm, heightMm: labelSize.heightMm
      });
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
      categories={categories} items={items} takes={takes} user={user}
      imports={imports}
      existingSkus={existingSkus} filteredItems={filteredItems}
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

function PageShell(props) {
  const {
    pageTab, setPageTab, isAdmin, lowStockCount, loading,
    onManageCategories, onAddItem,
    categories, items, takes, user, filteredItems,
    imports,
    activeCategory, setActiveCategory, searchTerm, setSearchTerm,
    selectedIds, toggleSelect, setDetailItem,
    setProductFormState, setAdjustItem, setBatchPrintOpen,
    reload, onJumpToItem, onDeleteItem, onPrintLabel, onExportLowStockPdf
  } = props;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center">
            <Boxes size={26} className="mr-2.5 text-blue-600" /> Stock Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Categories, products, movements and counts — everything inventory in one place.
            {!isAdmin && <span className="ml-1 text-gray-400">You can add items &amp; categories; edits/deletes need admin.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => exportStock(stockExportRows(filteredItems), 'excel')}
            title="Export the current filtered stock list to Excel"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium shadow-sm"
          >
            <FileSpreadsheet size={16} /> Export Excel
          </button>
          <button
            onClick={() => exportStock(stockExportRows(filteredItems), 'pdf')}
            title="Export the current filtered stock list to PDF"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium shadow-sm"
          >
            <FileText size={16} /> Export PDF
          </button>
          <button
            onClick={onExportLowStockPdf}
            disabled={lowStockCount === 0}
            title={lowStockCount === 0
              ? 'No items are at or below their low-stock threshold'
              : `Export all ${lowStockCount} low-stock item${lowStockCount === 1 ? '' : 's'} to PDF`}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <AlertTriangle size={16} /> Low Stock PDF
          </button>
        </div>
      </div>

      {/* Internal section tabs */}
      <div className="bg-white rounded-xl border border-gray-100 p-1.5 inline-flex flex-wrap gap-1 shadow-sm sticky top-0 z-20">
        {PAGE_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = pageTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setPageTab(tab.id)}
              className={`flex items-center space-x-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                isActive ? 'bg-blue-600 text-white shadow' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
              {tab.id === 'alerts' && lowStockCount > 0 && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${isActive ? 'bg-white text-rose-600' : 'bg-rose-100 text-rose-700'}`}>
                  {lowStockCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Section bodies */}
      {loading ? (
        <p className="text-gray-400 p-8 text-center">Loading stock data…</p>
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
    items, categories, filteredItems, isAdmin,
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

  return (
    <div className="space-y-4">
      {/* Search — global at grid level, local inside a category */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={activeCategory ? `Search within ${activeCategory}…` : 'Search all items across categories…'}
            className="w-full pl-10 pr-10 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-blue-300 shadow-sm"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700">
              ×
            </button>
          )}
        </div>
      </div>

      {!activeCategory ? (
        /* ---- Grid level: category cards + global search results ---- */
        <>
          {searchTerm.trim() && filteredItems.length > 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <p className="px-5 py-2.5 text-xs font-semibold text-gray-500 border-b border-gray-50">
                {filteredItems.length} result(s) across all categories
              </p>
              <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
                {filteredItems.slice(0, 30).map((item) => (
                  <button key={item.id} onClick={() => onView(item)} className="w-full flex items-center justify-between px-5 py-2.5 hover:bg-blue-50/40 text-left transition-colors">
                    <div className="min-w-0">
                      <span className="text-sm font-semibold text-gray-900">{item.name}</span>
                      <span className="ml-2 text-[11px] font-mono text-gray-400">{item.sku}</span>
                      <span className="ml-2 text-[11px] text-gray-400">· {item.category}</span>
                    </div>
                    <span className={`text-sm font-bold ${Number(item.quantity) <= Number(item.low_stock_threshold ?? 5) ? 'text-rose-600' : 'text-gray-600'}`}>
                      {item.quantity}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <CategoryGrid
            categories={categories}
            items={items}
            onOpenCategory={(name) => { setActiveCategory(name); setSearchTerm(''); }}
            onManageCategories={onManageCategories}
            onAddItem={onAddItem}
            isAdmin={isAdmin}
          />
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
    categoryName, stat, items, isAdmin,
    selectedIds, toggleSelect,
    onBack, onAdd, onBatchPrint,
    selectedCount, onView, onEdit, onDelete, onAdjust, onPrintLabel
  } = props;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Breadcrumb + toolbar */}
      <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center text-sm text-gray-400">
            <button onClick={onBack} className="hover:text-blue-600 font-medium">Categories</button>
            <span className="mx-1.5">/</span>
            <span className="font-bold text-gray-900">{categoryName}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
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
        onView={onView} onEdit={onEdit} onDelete={onDelete} onAdjust={onAdjust} onPrintLabel={onPrintLabel} />
    </div>
  );
}

// Rows implemented below.
function ItemRows({ items, isAdmin, selectedIds, toggleSelect, onView, onEdit, onDelete, onAdjust, onPrintLabel }) {
  const fmt = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString());

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-400 uppercase bg-gray-50/70">
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
        <tbody className="divide-y divide-gray-50">
          {items.length === 0 ? (
            <tr><td colSpan={isAdmin ? 8 : 7} className="px-6 py-10 text-center text-gray-400">
              No items here yet — use "Add Item here".
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
    <tr className={`transition-colors ${isSelected ? 'bg-indigo-50/50' : 'hover:bg-gray-50/70'}`}>
      <td className="pl-6 pr-2 py-3">
        {!item.is_service && (
          <button onClick={() => toggleSelect(item.id)} title="Select for batch label printing">
            {isSelected ? <CheckSquare size={17} className="text-indigo-600" /> : <Square size={17} className="text-gray-300 hover:text-gray-500" />}
          </button>
        )}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-gray-900 whitespace-nowrap">{item.sku}</td>
      <td className="px-3 py-3 max-w-[260px]">
        <button onClick={() => onView(item)} className="font-semibold text-gray-900 hover:text-blue-600 text-left truncate block max-w-full">
          {item.name}
        </button>
        {item.is_service && <span className="ml-0 text-[9px] font-bold uppercase bg-amber-100 text-amber-700 px-1 py-0.5 rounded">Service</span>}
      </td>
      <td className={`px-3 py-3 text-center font-bold ${low ? 'text-rose-600' : 'text-gray-800'}`}>
        {item.is_service ? '—' : qty}
      </td>
      {isAdmin && <td className="px-3 py-3 text-right text-gray-500">{fmt(item.cost_price)}</td>}
      <td className="px-3 py-3 text-right font-semibold text-gray-900">{fmt(item.sell_price)}</td>
      <td className="px-3 py-3 text-center">
        {item.is_service
          ? <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">N/A</span>
          : qty <= 0 ? <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-rose-100 text-rose-700 border border-rose-200">OUT</span>
          : low ? <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-orange-100 text-orange-700 border border-orange-200">LOW</span>
          : <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">OK</span>}
      </td>
      <td className="px-6 py-3">
        <div className="flex justify-end space-x-1">
          <button onClick={() => onAdjust(item)} disabled={item.is_service} title="Adjust stock" className="p-2 text-orange-600 hover:bg-orange-50 rounded-lg transition-colors disabled:opacity-30">
            <Wrench size={16} />
          </button>
          <button onClick={() => onPrintLabel(item)} title="Print barcode label" className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
            <BarcodeIcon size={16} />
          </button>
          {isAdmin && (
            <>
              <button onClick={() => onEdit(item)} title="Edit details" className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                <Pencil size={16} />
              </button>
              <button onClick={() => onDelete(item)} title="Delete item" className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors">
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
      className="flex items-center px-3 py-2 border border-gray-200 rounded-xl text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
    >
      {allSelected ? <CheckSquare size={15} className="mr-1.5 text-indigo-600" /> : <Square size={15} className="mr-1.5 text-gray-400" />}
      Select all
    </button>
  );
}