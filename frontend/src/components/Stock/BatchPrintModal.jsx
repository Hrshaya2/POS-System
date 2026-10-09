// Section 3: batch label printing.
// Pick items (pre-selected from the table), set a quantity per item and the
// label size; prints ONE job containing one page per label.
import React, { useState } from 'react';
import { X, Printer, CheckSquare, Square } from 'lucide-react';
import { printBarcodeLabelsBatch } from '../../utils/barcode';
import BarcodePreview from './BarcodePreview';

export default function BatchPrintModal({ items, labelSize, updateLabelSizeField, onClose }) {
  const [selected, setSelected] = useState(() => new Set(items.map((i) => i.id)));
  const [copiesPerItem, setCopiesPerItem] = useState(1);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));
  };

  const selectedCount = selected.size;
  const totalLabels = selectedCount * Math.max(1, Number(copiesPerItem) || 1);

  const handlePrint = () => {
    const chosen = items
      .filter((i) => selected.has(i.id))
      .map((i) => ({
        code: i.sku,
        name: i.name,
        price: i.sell_price
      }));
    if (!chosen.length) return;
    printBarcodeLabelsBatch({
      items: chosen,
      widthMm: labelSize.widthMm,
      heightMm: labelSize.heightMm,
      copiesPerItem
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] flex flex-col">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Batch Print Labels</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 hover:dark:bg-slate-800 rounded-lg transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {/* Options */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Qty of labels per item</label>
              <input
                type="number" min="1" max="1000" value={copiesPerItem}
                onChange={(e) => setCopiesPerItem(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-300 dark:focus:border-blue-500/60"
              />
            </div>
            <div className="bg-gray-50 dark:bg-slate-950 border border-gray-200 dark:border-slate-700 rounded-xl px-4 py-2 self-end text-sm">
              <label className="flex flex-wrap items-center gap-1.5 text-gray-500 dark:text-slate-400" title="Label printer paper size in mm">
                <span>Label size:</span>
                <input
                  type="number" min="15" max="200" value={labelSize.widthMm}
                  onChange={(e) => updateLabelSizeField('widthMm', e.target.value)}
                  className="w-16 px-2 py-1 border border-gray-200 dark:border-slate-700 rounded-lg text-xs bg-white dark:bg-slate-800 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500/60"
                />
                <span>×</span>
                <input
                  type="number" min="10" max="200" value={labelSize.heightMm}
                  onChange={(e) => updateLabelSizeField('heightMm', e.target.value)}
                  className="w-16 px-2 py-1 border border-gray-200 dark:border-slate-700 rounded-lg text-xs bg-white dark:bg-slate-800 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500/60"
                />
                <span>mm</span>
              </label>
              <span className="block text-[10px] text-gray-400 dark:text-slate-500">saved and used for every label you print</span>
            </div>
          </div>

          {/* Item picker */}
          <div>
            <button onClick={toggleAll} className="flex items-center space-x-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 mb-2">
              {selectedCount === items.length ? <CheckSquare size={16} /> : <Square size={16} />}
              <span>{selectedCount === items.length ? 'Unselect all' : 'Select all'}</span>
            </button>
            <div className="border border-gray-100 dark:border-slate-800 rounded-xl divide-y divide-gray-50 dark:divide-slate-800 max-h-64 overflow-y-auto">
              {items.length === 0 && <p className="text-sm text-gray-400 dark:text-slate-500 p-4">No items to print.</p>}
              {items.map((item) => (
                <button key={item.id} onClick={() => toggle(item.id)} className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-700 hover:dark:bg-slate-950 text-left transition-colors">
                  <div className="flex items-center space-x-3 min-w-0">
                    {selected.has(item.id)
                      ? <CheckSquare size={17} className="text-blue-600 dark:text-blue-400 shrink-0" />
                      : <Square size={17} className="text-gray-300 dark:text-slate-600 shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-slate-100 truncate">{item.name}</p>
                      <p className="text-[11px] font-mono text-gray-400 dark:text-slate-500">{item.sku}</p>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 shrink-0 ml-2">Rs. {Number(item.sell_price).toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Preview of first selection */}
          {selectedCount > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-1.5">Label preview</p>
              <BarcodePreview code={items.find((i) => selected.has(i.id))?.sku || ''} height={40} />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 flex justify-between items-center bg-gray-50 dark:bg-slate-950 rounded-b-2xl">
          <span className="text-xs text-gray-500 dark:text-slate-400">{selectedCount} item(s) → <strong>{totalLabels}</strong> labels in one job</span>
          <div className="flex space-x-3">
            <button onClick={onClose} className="px-5 py-2.5 text-gray-600 dark:text-slate-400 font-medium hover:bg-gray-100 dark:hover:bg-slate-700 hover:dark:bg-slate-800 rounded-lg transition-colors">Cancel</button>
            <button
              onClick={handlePrint}
              disabled={selectedCount === 0}
              className="flex items-center px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-semibold rounded-lg shadow-md transition-colors"
            >
              <Printer size={16} className="mr-2" /> Print {totalLabels} Label{totalLabels === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}