// "Manage Categories" modal.
// Everyone can ADD a category; only admin/shop_owner can EDIT or DELETE
// (shop rule: entered details are immutable for cashiers).
import React, { useMemo, useState } from 'react';
import { X, Plus, Pencil, Trash2, Check, AlertTriangle, Lock, ToggleLeft } from 'lucide-react';

const emptyForm = { name: '', description: '', is_phone_category: false };

export default function ManageCategoriesModal({ categories, items = [], isAdmin, onClose, onCreate, onUpdate, onDelete, onBulkCreate }) {
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [editFields, setEditFields] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [error, setError] = useState('');

  // Product-group labels present on existing items but missing from the
  // managed category list (typical for data imported before this feature).
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState('');
  const legacyLabels = useMemo(() => {
    const managed = new Set(categories.map((c) => String(c.name || '').trim().toLowerCase()));
    const pending = new Map();
    for (const item of items) {
      const label = String(item.category || '').trim();
      if (label && !managed.has(label.toLowerCase()) && !pending.has(label.toLowerCase())) {
        pending.set(label.toLowerCase(), label);
      }
    }
    return Array.from(pending.values()).sort((a, b) => a.localeCompare(b));
  }, [categories, items]);

  const runBackfill = async () => {
    if (!legacyLabels.length || backfilling) return;
    setBackfilling(true);
    setBackfillMsg('');
    try {
      const result = await onBulkCreate(legacyLabels);
      setBackfillMsg(
        result.fail > 0
          ? `${result.ok} imported, ${result.fail} failed — reopen to retry`
          : `All ${result.ok} categories imported`
      );
    } catch (err) {
      setBackfillMsg(err.message || 'Import failed');
    } finally {
      setBackfilling(false);
    }
  };


  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('Category name is required'); return; }
    setError('');
    try {
      await onCreate(form);
      setForm(emptyForm);
    } catch (err) {
      setError(err.message || 'Could not create category');
    }
  };

  const startEdit = (cat) => {
    setEditingId(cat.id);
    setEditFields({ name: cat.name, description: cat.description || '', is_phone_category: cat.is_phone_category });
    setConfirmDeleteId(null);
  };

  const saveEdit = async () => {
    if (!String(editFields.name).trim()) { setError('Category name is required'); return; }
    setError('');
    try {
      await onUpdate(categories.find((c) => c.id === editingId), {
        ...editFields,
        propagateRename: true,
        originalName: categories.find((c) => c.id === editingId)?.name
      });
      setEditingId(null);
    } catch (err) {
      setError(err.message || 'Could not update category');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">Manage Categories</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors"><X size={18} /></button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          {/* Add - allowed for every role */}
          <form onSubmit={handleCreate} className="bg-blue-50/60 border border-blue-100 rounded-xl p-4">
            <label className="block text-sm font-semibold text-gray-700 mb-2">Add new category</label>
            <div className="flex space-x-2">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Phone Cases"
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring focus:border-blue-300"
              />
              <button
                type="submit"
                disabled={!form.name.trim()}
                className="px-4 py-2 bg-blue-600 disabled:opacity-40 text-white rounded-lg font-semibold text-sm hover:bg-blue-700 transition-colors flex items-center"
              >
                <Plus size={16} className="mr-1" /> Add
              </button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <label className="flex items-center space-x-2 text-xs text-gray-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_phone_category}
                  onChange={(e) => setForm({ ...form, is_phone_category: e.target.checked })}
                  className="rounded"
                />
                <span>Phone category (IMEI-tracked)</span>
              </label>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional description"
                className="w-48 px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring focus:border-blue-300"
              />
            </div>
            {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
          </form>

          {/* One-click import of product-group labels already used by items */}
          {legacyLabels.length > 0 && (
            <div className="bg-teal-50/70 border border-teal-100 rounded-xl p-4">
              <label className="block text-sm font-semibold text-gray-700">
                Import existing product groups
              </label>
              <p className="text-xs text-gray-500 mt-1">
                {legacyLabels.length} group(s) your items already use but that have no managed
                category yet — e.g. {legacyLabels.slice(0, 3).join(', ')}
                {legacyLabels.length > 3 ? '…' : ''}. Importing makes them editable/renamable here.
              </p>
              <button
                onClick={runBackfill}
                disabled={backfilling}
                className="mt-2 px-4 py-2 bg-teal-600 disabled:opacity-50 text-white rounded-lg text-sm font-bold hover:bg-teal-700 transition-colors flex items-center"
              >
                <Plus size={15} className="mr-1.5" />
                {backfilling ? 'Importing…' : `Create all ${legacyLabels.length} categories`}
              </button>
              {backfillMsg && <p className="text-xs font-semibold text-teal-700 mt-2">{backfillMsg}</p>}
            </div>
          )}

          <CategoryList
            categories={categories}
            isAdmin={isAdmin}
            editingId={editingId}
            editFields={editFields}
            confirmDeleteId={confirmDeleteId}
            setEditFields={setEditFields}
            setConfirmDeleteId={setConfirmDeleteId}
            setEditingId={setEditingId}
            startEdit={startEdit}
            saveEdit={saveEdit}
            onDelete={onDelete}
          />

          {!isAdmin && (
            <p className="text-[11px] text-gray-400 flex items-start space-x-1.5 bg-amber-50 border border-amber-100 rounded-lg p-2.5">
              <ToggleLeft size={14} className="shrink-0 mt-0.5 text-amber-500" />
              <span>You can create categories, but once created they cannot be edited or deleted from your account — only an admin or shop owner can manage them.</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryList({
  categories, isAdmin, editingId, editFields, confirmDeleteId,
  setEditFields, setConfirmDeleteId, setEditingId, startEdit, saveEdit, onDelete
}) {
  return (
    <div className="space-y-2">
      {categories.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-4">No categories yet.</p>
      )}
      {categories.map((cat) => {
        const isPending = cat.syncStatus === 'pending';
        if (editingId === cat.id) {
          return (
            <div key={cat.id} className="border border-blue-200 bg-blue-50/40 rounded-xl p-3">
              <div className="flex space-x-2">
                <input
                  value={editFields.name}
                  onChange={(e) => setEditFields({ ...editFields, name: e.target.value })}
                  className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring focus:border-blue-300"
                />
                <button onClick={saveEdit} className="p-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700" title="Save"><Check size={16} /></button>
                <button onClick={() => setEditingId(null)} className="p-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200" title="Cancel"><X size={16} /></button>
              </div>
              <label className="flex items-center space-x-2 text-xs text-gray-600 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editFields.is_phone_category}
                  onChange={(e) => setEditFields({ ...editFields, is_phone_category: e.target.checked })}
                />
                <span>Phone category (renames will update existing items)</span>
              </label>
            </div>
          );
        }

        return (
          <div key={cat.id} className="flex items-center justify-between bg-white border border-gray-100 rounded-xl px-4 py-2.5 shadow-sm">
            <div className="min-w-0">
              <div className="font-semibold text-gray-900 text-sm truncate">{cat.name}</div>
              <div className="text-[11px] text-gray-400 truncate">
                {cat.is_phone_category ? 'Phone category' : 'Accessory / part'}
                {isPending && ' · pending sync'}
              </div>
            </div>
            <div className="flex items-center space-x-1.5 shrink-0 ml-2">
              {isAdmin ? (
                <>
                  {confirmDeleteId === cat.id ? (
                    <div className="flex items-center space-x-1.5">
                      <span className="text-[11px] font-semibold text-rose-600 flex items-center"><AlertTriangle size={12} className="mr-1" />Sure?</span>
                      <button onClick={() => onDelete(cat)} className="px-2.5 py-1.5 bg-rose-600 text-white rounded-lg text-xs font-bold hover:bg-rose-700">Delete</button>
                      <button onClick={() => setConfirmDeleteId(null)} className="px-2.5 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs">No</button>
                    </div>
                  ) : (
                    <>
                      <button onClick={() => startEdit(cat)} className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Edit category"><Pencil size={15} /></button>
                      <button onClick={() => setConfirmDeleteId(cat.id)} className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors" title="Delete category"><Trash2 size={15} /></button>
                    </>
                  )}
                </>
              ) : (
                <span className="flex items-center text-[11px] text-gray-400" title="Only admins and shop owners can edit or delete categories">
                  <Lock size={12} className="mr-1" /> Read-only
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}