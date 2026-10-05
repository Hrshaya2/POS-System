// Section 2: Product Add/Edit modal - Aronium-style 4-tab form.
//   Tab 1 Details | Tab 2 Price & Tax | Tab 3 Notes | Tab 4 Image & Color
// Save/Cancel stay visible regardless of the active tab; Save is disabled
// until required fields are valid (inline messages under each field).
import React, { useMemo, useState } from 'react';
import { X, Save, Wand2, Plus, Trash2, Upload } from 'lucide-react';
import BarcodePreview from './BarcodePreview';
import { generateInternalSku } from '../../utils/barcode';

const TABS = [
  { id: 'details', label: 'Product Details' },
  { id: 'price', label: 'Price & Tax' },
  { id: 'notes', label: 'Notes' },
  { id: 'image', label: 'Image & Color' }
];

const UNITS = ['pcs', 'box', 'pack', 'meter', 'set'];
const COLOR_PRESETS = [
  { tag: 'blue', class: 'bg-blue-500' },
  { tag: 'green', class: 'bg-emerald-500' },
  { tag: 'red', class: 'bg-rose-500' },
  { tag: 'purple', class: 'bg-purple-500' },
  { tag: 'orange', class: 'bg-orange-500' },
  { tag: 'teal', class: 'bg-teal-500' },
  { tag: 'pink', class: 'bg-pink-500' },
  { tag: 'gray', class: 'bg-gray-500' }
];

export const emptyItemForm = () => ({
  name: '', sku: '', barcodes: [], unit: 'pcs', category: '',
  quantity: 0, low_stock_threshold: 5,
  is_service: false, description: '',
  imei: '', condition_grade: 'New', battery_health: 100, warranty_months: 0,
  tax_rate: 0, cost_price: '', markup_percent: 0, sell_price: '',
  price_includes_tax: false, allow_price_override: true,
  notes: [], image_url: '', color_tag: ''
});

export const itemToForm = (item) => ({
  ...emptyItemForm(),
  ...(item || {}),
  barcodes: Array.isArray(item?.barcodes) ? [...item.barcodes] : [],
  notes: Array.isArray(item?.notes) ? item.notes.map((n) => ({ ...n })) : [],
  quantity: item?.quantity ?? 0
});

export const validateItemForm = (form, existingSkus = [], originalSku = null) => {
  const errors = {};
  const skuNorm = String(form.sku || '').trim().toLowerCase();
  if (!String(form.name || '').trim()) errors.name = 'Name is required';
  if (!skuNorm) {
    errors.sku = 'Code/SKU is required';
  } else if (
    (!originalSku || String(originalSku).toLowerCase() !== skuNorm)
    && existingSkus.some((s) => String(s).toLowerCase() === skuNorm)
  ) {
    errors.sku = 'This SKU already exists';
  }
  if (!form.category) errors.category = 'Pick a category';
  if (!(Number(form.sell_price) > 0)) errors.sell_price = 'Sell price must be greater than 0';
  if (Number(form.quantity) < 0) errors.quantity = 'Quantity cannot be negative';
  return errors;
};

export default function ProductFormModal({
  item,            // null => create mode
  categories,
  presetCategory,  // pre-fill when opened inside a category
  existingSkus,    // for unique-SKU validation + barcode generation
  canEdit,         // false => read-only (cashier viewing existing item)
  onSave,
  onClose
}) {
  const [activeTab, setActiveTab] = useState('details');
  const [form, setForm] = useState(() => {
    const base = item ? itemToForm(item) : emptyItemForm();
    if (!item && presetCategory) base.category = presetCategory;
    return base;
  });
  const [submitting, setSubmitting] = useState(false);

  const setField = (name, value) => setForm((prev) => ({ ...prev, [name]: value }));

  // Phone-only fields appear when the chosen category is flagged as one.
  const isPhoneCategory = useMemo(
    () => !!categories.find((c) => c.name === form.category)?.is_phone_category,
    [categories, form.category]
  );

  const recalcPrice = (costRaw, markupRaw) =>
    Math.round(((Number(costRaw) || 0) * (1 + (Number(markupRaw) || 0) / 100)) * 100) / 100;

  const handleCostChange = (value) =>
    setForm((prev) => ({ ...prev, cost_price: value, sell_price: recalcPrice(value, prev.markup_percent) }));

  const handleMarkupChange = (value) =>
    setForm((prev) => ({ ...prev, markup_percent: value, sell_price: recalcPrice(prev.cost_price, value) }));

  // Editing price directly re-derives the implied markup.
  const handlePriceChange = (value) => {
    const cost = Number(form.cost_price) || 0;
    const price = Number(value) || 0;
    const markup = cost > 0 ? Math.round(((price - cost) / cost) * 10000) / 100 : form.markup_percent;
    setForm((prev) => ({ ...prev, sell_price: value, markup_percent: markup }));
  };

  const handleGenerateBarcode = () => {
    const code = generateInternalSku([...existingSkus, ...form.barcodes]);
    setForm((prev) => ({ ...prev, barcodes: prev.barcodes.includes(code) ? prev.barcodes : [...prev.barcodes, code] }));
  };

  const errors = validateItemForm(form, existingSkus, item?.sku);
  const isValid = Object.keys(errors).length === 0;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!isValid || submitting || !canEdit) return;
    setSubmitting(true);
    try {
      await onSave(form);
      onClose();
    } catch (err) {
      alert(err.message || 'Could not save the item');
    } finally {
      setSubmitting(false);
    }
  };

  const tabProps = {
    form, setField,
    isPhoneCategory, categories, errors,
    handleCostChange, handleMarkupChange, handlePriceChange,
    handleGenerateBarcode,
    COLOR_PRESETS
  };

  return (
    <ModalShell
      item={item} activeTab={activeTab} setActiveTab={setActiveTab}
      isValid={isValid} submitting={submitting} canEdit={canEdit}
      handleSave={handleSave} onClose={onClose}
    >
      {activeTab === 'details' && <DetailsTab {...tabProps} />}
      {activeTab === 'price' && <PriceTaxTab {...tabProps} />}
      {activeTab === 'notes' && <NotesTab {...tabProps} />}
      {activeTab === 'image' && <ImageColorTab {...tabProps} />}
    </ModalShell>
  );
}

function ModalShell({ item, activeTab, setActiveTab, isValid, submitting, canEdit, handleSave, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <form onSubmit={handleSave} className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100 dark:border-slate-800">
          <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">
            {item ? `Edit Item — ${item.name}` : 'Add New Item'}
            {!canEdit && <span className="ml-2 text-xs font-medium text-gray-400 dark:text-slate-500">(read-only)</span>}
          </h3>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors"><X size={18} /></button>
        </div>

        <div className="px-6 pt-4 border-b border-gray-100 dark:border-slate-800 flex space-x-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'text-blue-700 bg-blue-50 border-x border-t border-blue-200 -mb-px'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">{children}</div>

        {/* Persistent footer - identical on every tab */}
        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-800 flex justify-between items-center bg-gray-50 dark:bg-slate-950 rounded-b-2xl">
          <span className="text-xs text-gray-400 dark:text-slate-500 hidden sm:block">Fields marked * are required</span>
          <div className="flex space-x-3 ml-auto">
            <button type="button" onClick={onClose} className="px-5 py-2.5 text-gray-600 dark:text-slate-400 font-medium hover:bg-gray-100 hover:dark:bg-slate-800 rounded-lg transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || submitting || !canEdit}
              title={!canEdit ? 'Only admins and shop owners can edit existing items' : undefined}
              className="flex items-center px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold rounded-lg shadow-md transition-colors"
            >
              <Save size={16} className="mr-2" />
              {submitting ? 'Saving…' : item ? 'Update Item' : 'Save Item'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

const inputClass = (hasError) =>
  `w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-300 ${hasError ? 'border-rose-300 bg-rose-50/40' : 'border-gray-200'}`;
const ErrText = ({ msg }) => (msg ? <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">{msg}</p> : null);
const Label = ({ children }) => <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">{children}</label>;

function DetailsTab({ form, setField, isPhoneCategory, categories, errors, handleGenerateBarcode }) {
  const [barcodeInput, setBarcodeInput] = React.useState('');
  const primaryBarcode = form.barcodes[0] || '';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <div>
          <Label>Item Name *</Label>
          <input value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. iPhone 15 Tempered Glass" className={inputClass(errors.name)} />
          <ErrText msg={errors.name} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Code / SKU *</Label>
            <div className="flex space-x-2">
              <input value={form.sku} onChange={(e) => setField('sku', e.target.value)} placeholder="LM-000123" className={`${inputClass(errors.sku)} font-mono`} />
              <button
                type="button"
                onClick={() => setField('sku', generateInternalSku(form.barcodes))}
                title="Generate internal SKU"
                className="px-3 py-2 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 rounded-lg hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors whitespace-nowrap"
              >
                <Wand2 size={16} />
              </button>
            </div>
            <ErrText msg={errors.sku} />
          </div>
          <div>
            <Label>Unit</Label>
            <select value={form.unit} onChange={(e) => setField('unit', e.target.value)} className={inputClass(false)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>

        {/* Multiple manufacturer/internal barcodes */}
        <div>
          <Label>Barcodes (multiple allowed)</Label>
          <div className="flex flex-wrap gap-2 mb-2">
            {form.barcodes.length === 0 && (
              <span className="text-xs text-gray-400 dark:text-slate-500">No extra barcodes — the SKU above acts as the primary code.</span>
            )}
            {form.barcodes.map((code) => (
              <span key={code} className="inline-flex items-center bg-gray-100 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg pl-2.5 pr-1 py-1 font-mono text-xs">
                {code}
                <button type="button" onClick={() => setField('barcodes', form.barcodes.filter((b) => b !== code))} className="p-1 text-gray-400 dark:text-slate-500 hover:text-rose-500 hover:dark:text-rose-400">
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <DetailsExtraRows
            barcodeInput={barcodeInput}
            setBarcodeInput={setBarcodeInput}
            existing={form.barcodes}
            onAddBarcode={(code) => setField('barcodes', [...form.barcodes, code])}
            onGenerate={handleGenerateBarcode}
          />
          <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">Generate creates a unique internal LM-code for items without a manufacturer barcode.</p>
        </div>

        <CategoryQtyFields form={form} setField={setField} categories={categories} errors={errors} />
        <PhoneFields form={form} setField={setField} visible={isPhoneCategory} />
        <ServiceToggle form={form} setField={setField} />

        <div>
          <Label>Description</Label>
          <textarea value={form.description || ''} onChange={(e) => setField('description', e.target.value)} rows={2} className={inputClass(false)} placeholder="Optional product description…" />
        </div>
      </div>

      {/* Live barcode preview (Section 3) */}
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-1">Live Barcode Preview</p>
        <BarcodePreview code={primaryBarcode || form.sku} height={56} />
        <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-2">CODE128 · rendered exactly as printed on labels.</p>
      </div>
    </div>
  );
}

// Remaining tab implementations appended below.
function NotesTab({ form, setField }) {
  const [noteInput, setNoteInput] = React.useState('');

  const addNote = () => {
    const text = String(noteInput).trim();
    if (!text) return;
    setField('notes', [...(form.notes || []), { text, user_name: '', created_at: new Date().toISOString() }]);
    setNoteInput('');
  };

  return (
    <div className="space-y-3 max-w-xl">
      <p className="text-sm text-gray-500 dark:text-slate-400">Freeform notes for this item — condition notes, handling instructions, supplier remarks…</p>

      {(form.notes || []).length > 0 && (
        <ul className="space-y-2">
          {form.notes.map((note, idx) => (
            <li key={`${idx}-${String(note.text).slice(0, 8)}`} className="flex items-start justify-between bg-amber-50/70 border border-amber-100 dark:border-amber-500/20 rounded-xl px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm text-gray-800 dark:text-slate-200 whitespace-pre-wrap break-words">{note.text}</p>
                <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">
                  {note.user_name ? `${note.user_name} · ` : ''}{note.created_at ? new Date(note.created_at).toLocaleString() : ''}
                </p>
              </div>
              <button type="button" onClick={() => setField('notes', form.notes.filter((_, i) => i !== idx))} className="p-1.5 text-gray-400 dark:text-slate-500 hover:text-rose-500 hover:dark:text-rose-400 shrink-0 ml-2">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex space-x-2">
        <input
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } }}
          placeholder="Type a note and press Enter…"
          className={inputClass(false)}
        />
        <button
          type="button"
          onClick={addNote}
          disabled={!noteInput.trim()}
          className="px-4 py-2 bg-blue-600 disabled:opacity-40 text-white rounded-lg font-semibold text-sm hover:bg-blue-700 transition-colors flex items-center"
        >
          <Plus size={16} className="mr-1" /> Add Note
        </button>
      </div>
    </div>
  );
}

function ImageColorTab({ form, setField, COLOR_PRESETS }) {
  const activePreset = COLOR_PRESETS.find((c) => c.tag === form.color_tag);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Image upload */}
      <div>
        <Label>Item image</Label>
        {form.image_url ? (
          <div className="relative">
            <img src={form.image_url} alt="Item" className="w-full max-w-[220px] h-[160px] object-cover rounded-xl border border-gray-200 dark:border-slate-700" />
            <button
              type="button"
              onClick={() => setField('image_url', '')}
              className="absolute top-2 right-2 p-1.5 bg-white/90 border border-gray-200 dark:border-slate-700 text-rose-500 dark:text-rose-400 rounded-lg hover:bg-white hover:dark:bg-slate-800 shadow-sm"
              title="Remove image"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center w-full max-w-[220px] h-[160px] border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl cursor-pointer hover:border-blue-300 hover:bg-blue-50/40 transition-colors">
            <Upload size={24} className="text-gray-400 dark:text-slate-500 mb-2" />
            <span className="text-xs text-gray-500 dark:text-slate-400 font-medium">Click to upload</span>
            <span className="text-[10px] text-gray-400 dark:text-slate-500">JPG / PNG / WebP</span>
            <input type="file" accept="image/*" onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => setField('image_url', String(reader.result || ''));
              reader.readAsDataURL(file);
            }} className="hidden" />
          </label>
        )}
      </div>

      {/* Preset color tag - used by visual grid displays like Quick Sale mode */}
      <div>
        <Label>Color tag (for Quick Sale grid)</Label>
        <div className="flex flex-wrap gap-2.5 mt-1">
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset.tag}
              type="button"
              onClick={() => setField('color_tag', form.color_tag === preset.tag ? '' : preset.tag)}
              title={preset.tag}
              className={`w-10 h-10 rounded-xl ${preset.class} transition-all ${
                form.color_tag === preset.tag
                  ? 'ring-4 ring-offset-2 ring-gray-300 scale-105'
                  : 'opacity-70 hover:opacity-100'
              }`}
            />
          ))}
        </div>
        {form.color_tag && (
          <p className="text-xs text-gray-500 dark:text-slate-400 mt-2">
            Tagged as <span className="inline-flex items-center"><span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${activePreset?.class}`} />{form.color_tag}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function PhoneFields({ form, setField, visible }) {
  if (!visible) return null;
  return (
    <div className="border border-indigo-100 dark:border-indigo-500/20 bg-indigo-50/50 rounded-xl p-4 space-y-3">
      <p className="text-xs font-bold text-indigo-700 dark:text-indigo-300 uppercase tracking-wide">Phone details (IMEI-tracked)</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>IMEI</Label>
          <input value={form.imei || ''} onChange={(e) => setField('imei', e.target.value)} className={`${inputClass(false)} font-mono`} />
        </div>
        <div>
          <Label>Condition grade</Label>
          <select value={form.condition_grade || 'New'} onChange={(e) => setField('condition_grade', e.target.value)} className={inputClass(false)}>
            {['New', 'Like New', 'Good', 'Fair', 'Refurbished'].map((g) => <option key={g}>{g}</option>)}
          </select>
        </div>
        <div>
          <Label>Battery health (%)</Label>
          <input type="number" min="0" max="100" value={form.battery_health ?? 100} onChange={(e) => setField('battery_health', e.target.value)} className={inputClass(false)} />
        </div>
        <div>
          <Label>Warranty (months)</Label>
          <input type="number" min="0" value={form.warranty_months ?? 0} onChange={(e) => setField('warranty_months', e.target.value)} className={inputClass(false)} />
        </div>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center justify-between sm:justify-start sm:space-x-3 cursor-pointer select-none">
      <span className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300'}`}>
        <input type="checkbox" checked={!!checked} onChange={onChange} className="sr-only" />
        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-0.5 ${checked ? 'translate-x-5 ml-0.5' : 'translate-x-0.5'}`} />
      </span>
      <span className="text-sm text-gray-700 dark:text-slate-300">{label}</span>
    </label>
  );
}

function ServiceToggle({ form, setField }) {
  return (
    <Toggle
      checked={form.is_service}
      onChange={(e) => setField('is_service', e.target.checked)}
      label="Service item (no stock tracking)"
    />
  );
}

function PriceTaxTab({ form, setField, handleCostChange, handleMarkupChange, handlePriceChange }) {
  const cost = Number(form.cost_price) || 0;
  const price = Number(form.sell_price) || 0;
  const taxAmount = form.price_includes_tax
    ? price - price / (1 + (Number(form.tax_rate) || 0) / 100)
    : price * ((Number(form.tax_rate) || 0) / 100);

  return (
    <div className="space-y-4 max-w-xl">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <Label>Tax rate (%)</Label>
          <input type="number" min="0" step="0.01" value={form.tax_rate ?? 0} onChange={(e) => setField('tax_rate', e.target.value)} className={inputClass(false)} />
        </div>
        <div>
          <Label>Cost price (Rs.)</Label>
          <input type="number" min="0" step="0.01" value={form.cost_price ?? ''} onChange={(e) => handleCostChange(e.target.value)} className={inputClass(false)} placeholder="0.00" />
        </div>
        <div>
          <Label>Markup %</Label>
          <input type="number" step="0.01" value={form.markup_percent ?? 0} onChange={(e) => handleMarkupChange(e.target.value)} className={inputClass(false)} />
        </div>
      </div>

      <div>
        <Label>Sell Price (Rs.) *</Label>
        <div className="flex items-center space-x-3">
          <input type="number" min="0" step="0.01" value={form.sell_price ?? ''} onChange={(e) => handlePriceChange(e.target.value)} className={`${inputClass(false)} max-w-[180px] text-lg font-bold`} placeholder="0.00" />
          {cost > 0 && (
            <span className="text-xs text-gray-400 dark:text-slate-500">
              auto-calculated from Cost + Markup — still editable
            </span>
          )}
        </div>
      </div>

      <div className="bg-blue-50/60 border border-blue-100 dark:border-blue-500/20 rounded-xl p-4 grid grid-cols-2 gap-3 text-sm">
        <div className="flex items-center justify-between"><span className="text-gray-500">Cost</span><span className="font-semibold">Rs. {cost.toLocaleString()}</span></div>
        <div className="flex items-center justify-between"><span className="text-gray-500">Markup</span><span className="font-semibold">{Number(form.markup_percent) || 0}%</span></div>
        <div className="flex items-center justify-between"><span className="text-gray-500">Tax ({Number(form.tax_rate) || 0}%)</span><span className="font-semibold">Rs. {Math.round(taxAmount * 100) / 100}</span></div>
        <div className="flex items-center justify-between"><span className="text-gray-500">Margin / unit</span><span className={`font-semibold ${price - cost >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>Rs. {(price - cost).toLocaleString()}</span></div>
      </div>

      <div className="space-y-3 pt-1">
        <Toggle
          checked={form.price_includes_tax}
          onChange={(e) => setField('price_includes_tax', e.target.checked)}
          label="Price includes tax"
        />
        <Toggle
          checked={form.allow_price_override}
          onChange={(e) => setField('allow_price_override', e.target.checked)}
          label="Allow price override at sale"
        />
      </div>
    </div>
  );
}

function DetailsExtraRows({ barcodeInput, setBarcodeInput, existing, onAddBarcode, onGenerate }) {
  const tryAdd = () => {
    const code = String(barcodeInput).trim();
    if (!code || existing.includes(code)) { setBarcodeInput(''); return; }
    onAddBarcode(code);
    setBarcodeInput('');
  };
  return (
    <div className="flex space-x-2">
      <input
        value={barcodeInput}
        onChange={(e) => setBarcodeInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); tryAdd(); } }}
        placeholder="Scan or type a manufacturer barcode"
        className={`${inputClass(false)} font-mono`}
      />
      <button type="button" onClick={tryAdd} className="px-3 py-2 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 rounded-lg hover:bg-gray-50 hover:dark:bg-slate-950 transition-colors">
        <Plus size={16} />
      </button>
      <button type="button" onClick={onGenerate} className="px-3 py-2 bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-300 rounded-lg hover:bg-indigo-100 transition-colors text-sm font-semibold whitespace-nowrap">
        Generate Barcode
      </button>
    </div>
  );
}

function CategoryQtyFields({ form, setField, categories, errors }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <Label>Category *</Label>
        <select value={form.category} onChange={(e) => setField('category', e.target.value)} className={inputClass(errors.category)}>
          <option value="">Select category…</option>
          {categories.filter((c) => c.active !== false).map((c) => (
            <option key={c.id} value={c.name}>{c.name}</option>
          ))}
        </select>
        <ErrText msg={errors.category} />
      </div>
      {!form.is_service && (
        <>
          <div>
            <Label>Quantity in stock</Label>
            <input type="number" min="0" value={form.quantity ?? 0} onChange={(e) => setField('quantity', e.target.value)} className={inputClass(!!errors.quantity)} />
            <ErrText msg={errors.quantity} />
          </div>
          <div>
            <Label>Low Stock Threshold</Label>
            <input type="number" min="0" value={form.low_stock_threshold ?? 5} onChange={(e) => setField('low_stock_threshold', e.target.value)} className={inputClass(false)} />
          </div>
        </>
      )}
    </div>
  );
}