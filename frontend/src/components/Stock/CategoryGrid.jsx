// Section 1: category-first navigation grid.
// Each card: name, item count, total stock qty. Click drills into the list.
import React from 'react';
import { Package, Smartphone, Plus } from 'lucide-react';
import { getDeletedCategoryNames } from '../../services/stockService';

// onAddItem / onManageCategories are intentionally unused: those actions moved
// to the page header toolbar so they aren't duplicated inside the grid.

const CARD_COLORS = [
  'from-blue-500 to-indigo-500',
  'from-emerald-500 to-teal-500',
  'from-orange-500 to-amber-500',
  'from-purple-500 to-fuchsia-500',
  'from-rose-500 to-pink-500',
  'from-cyan-500 to-sky-500'
];

const colorForIndex = (i) => CARD_COLORS[i % CARD_COLORS.length];

export default function CategoryGrid({ categories, items, onOpenCategory, onManageCategories, onAddItem, isAdmin }) {
  // Categories the user explicitly deleted. Item rows keep their plain-text
  // category label, so without this the grid would immediately re-synthesise a
  // card for a category that was just removed.
  // categories/items are listed as deps on purpose: the tombstones live in
  // localStorage, which React cannot observe, so a change in either list is what
  // tells us to re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deletedNames = React.useMemo(() => new Set(getDeletedCategoryNames()), [categories, items]);

  const visibleCategories = React.useMemo(
    () => (categories || []).filter((c) => !deletedNames.has(String(c?.name || '').trim())),
    [categories, deletedNames]
  );

  const stats = React.useMemo(() => {
    const map = new Map();
    for (const cat of visibleCategories) {
      map.set(cat.name, { count: 0, qty: 0 });
    }
    for (const item of items) {
      if (deletedNames.has(String(item?.category || '').trim())) continue;
      const entry = map.get(item.category);
      if (entry) {
        entry.count += 1;
        entry.qty += Number(item.quantity || 0);
      } else {
        // Items whose category row is missing still deserve a card.
        map.set(item.category, { count: 1, qty: Number(item.quantity || 0) });
      }
    }
    return map;
  }, [visibleCategories, items, deletedNames]);

  // Merge in categories that only exist as item labels (legacy data).
  const allNames = Array.from(new Set([
    ...visibleCategories.filter((c) => c.active !== false).map((c) => c.name),
    ...Array.from(stats.keys())
  ])).sort((a, b) => a.localeCompare(b));

  const phoneCategoryNames = new Set(visibleCategories.filter((c) => c.is_phone_category).map((c) => c.name));

  return (
    <div>
      {/* Add Item / Manage Categories now live in the page header toolbar, so
          they are not repeated here. */}
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Product Categories</h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">Pick a category to view and manage its items</p>
        </div>
      </div>

      {allNames.length === 0 ? (
        <div className="bg-white dark:bg-slate-800 border border-dashed border-gray-300 dark:border-slate-700 rounded-2xl p-10 text-center">
          <Package size={40} className="mx-auto text-gray-300 dark:text-slate-600 mb-3" />
          <p className="text-gray-500 dark:text-slate-400 font-medium">No categories yet</p>
          <p className="text-sm text-gray-400 dark:text-slate-500">Create your first category to start adding items.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {allNames.map((name, i) => {
            const stat = stats.get(name) || { count: 0, qty: 0 };
            const isPhone = phoneCategoryNames.has(name);
            return (
              <button
                key={name}
                onClick={() => onOpenCategory(name)}
                className="group bg-white dark:bg-slate-800 rounded-2xl p-5 border border-gray-100 dark:border-slate-800 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all text-left"
              >
                <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${colorForIndex(i)} flex items-center justify-center text-white shadow-md mb-3`}>
                  {isPhone ? <Smartphone size={20} /> : <Package size={20} />}
                </div>
                <div className="font-bold text-gray-900 dark:text-slate-100 group-hover:text-blue-600 group-hover:dark:text-blue-400 transition-colors truncate">{name}</div>
                <div className="flex items-center space-x-3 mt-1.5 text-xs text-gray-500 dark:text-slate-400">
                  <span>{stat.count} items</span>
                  <span className="text-gray-300">|</span>
                  <span>{stat.qty.toLocaleString()} in stock</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!isAdmin && (
        <p className="text-xs text-gray-400 dark:text-slate-500 mt-3 flex items-center">
          <Plus size={12} className="mr-1" />
          You can add new items and categories; editing or deleting existing records requires admin access.
        </p>
      )}
    </div>
  );
}