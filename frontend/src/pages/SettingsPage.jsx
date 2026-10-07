import React, { useState, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  Settings,
  Upload,
  Trash2,
  Printer,
  Receipt,
  Phone,
  MapPin,
  Mail,
  Globe,
  Type,
  Image as ImageIcon,
  Barcode as BarcodeIcon,
  Check
} from 'lucide-react';
import { getReceiptSettings, saveReceiptSettings, buildReceiptHtml, SAMPLE_RECEIPT, mmToPx } from '../utils/receipt';

const Toggle = ({ checked, onChange, label }) => (
  <button
    type="button"
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-700'}`}
    aria-pressed={checked}
  >
    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    <span className="sr-only">{label}</span>
  </button>
);

const Field = ({ label, children }) => (
  <div>
    <label className="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">{label}</label>
    {children}
  </div>
);

const inputClass = "w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 px-4 py-2.5 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:bg-white dark:focus:bg-slate-800 focus:border-blue-300 dark:focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";

const SETTINGS_API = '/api';
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` });

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'shop_owner';
  const [settings, setSettings] = useState(() => getReceiptSettings());
  const [saved, setSaved] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const fileRef = useRef(null);

  const update = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }, []);

  // Regenerate the live preview every time the settings change.
  React.useEffect(() => {
    setPreviewHtml(buildReceiptHtml(SAMPLE_RECEIPT, settings));
  }, [settings]);

  const handleSave = () => {
    saveReceiptSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // --- Admin-only: refund approval policy (cashier limit / window / PIN) ---
  const [policy, setPolicy] = useState({ maxAmount: 50000, maxDays: 30, sameMethodRequired: true });
  const [adminPin, setAdminPin] = useState('');
  const [pinExists, setPinExists] = useState(false);
  const [rpBusy, setRpBusy] = useState(false);
  const [policyStatus, setPolicyStatus] = useState({ kind: '', msg: '' });

  React.useEffect(() => {
    if (!isAdmin) return undefined;
    let off = false;
    (async () => {
      try {
        const res = await fetch(`${SETTINGS_API}/store-settings/refund_policy`, { headers: authHeaders() });
        if (res.ok && !off) { const v = await res.json(); if (v) setPolicy((p) => ({ ...p, ...v })); }
      } catch (err) { /* fall back to defaults */ }
      try {
        const res2 = await fetch(`${SETTINGS_API}/store-settings/admin_refund_pin`, { headers: authHeaders() });
        if (res2.ok && !off) {
          const v2 = await res2.json();
          const raw = (v2 && typeof v2 === 'object') ? v2.value : v2;
          setPinExists(raw != null && String(raw).trim() !== '');
        }
      } catch (err) { /* ignore */ }
    })();
    return () => { off = true; };
  }, [isAdmin]);

  const saveRefundPolicy = async () => {
    setRpBusy(true);
    setPolicyStatus({ kind: '', msg: '' });
    try {
      const body = {
        maxAmount: Math.max(0, Number(policy.maxAmount) || 0),
        maxDays: Math.max(1, Math.floor(Number(policy.maxDays) || 30)),
        sameMethodRequired: !!policy.sameMethodRequired
      };
      const res = await fetch(`${SETTINGS_API}/store-settings/refund_policy`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save policy');
      const pin = adminPin.trim();
      if (pin) {
        // Body must be an object: body-parser's strict mode rejects bare JSON strings.
        const r2 = await fetch(`${SETTINGS_API}/store-settings/admin_refund_pin`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ value: pin }) });
        if (!r2.ok) throw new Error('Policy saved but the approval PIN could not be saved.');
        setAdminPin('');
        setPinExists(true);
      }
      setPolicyStatus({ kind: 'ok', msg: 'Refund policy saved. New refunds follow these limits immediately.' });
    } catch (e) {
      setPolicyStatus({ kind: 'err', msg: e.message || 'Save failed' });
    } finally {
      setRpBusy(false);
    }
  };

  const handleLogoFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      update({ logo: String(reader.result || ''), showLogo: true });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handlePrintPreview = () => {
    const win = window.open('', '_blank', 'width=420,height=760');
    if (!win) return;
    win.document.write(previewHtml);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 200);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 flex items-center">
            <Settings size={26} className="mr-2.5 text-gray-600 dark:text-slate-400" /> Settings
          </h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Customize how your receipts print — logo, messages and contact details.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handlePrintPreview} className="flex items-center px-4 py-2.5 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50">
            <Printer size={17} className="mr-1.5" /> Print Preview
          </button>
          <button onClick={handleSave} className="flex items-center px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold shadow-md">
            {saved ? <Check size={17} className="mr-1.5" /> : <Receipt size={17} className="mr-1.5" />}
            {saved ? 'Saved' : 'Save Settings'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- Left: editor (logo, shop/header, footer) ---- */}
        <div className="space-y-5">
          {/* Logo */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-4">
              <ImageIcon size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Logo
            </h3>
            <div className="flex items-center gap-4">
              <div className="w-24 h-24 rounded-xl border border-dashed border-gray-300 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 flex items-center justify-center overflow-hidden">
                {settings.logo ? (
                  <img src={settings.logo} alt="Logo" className="max-w-full max-h-full object-contain" />
                ) : (
                  <span className="text-xs text-gray-400 dark:text-slate-500 text-center px-2">No logo</span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <button onClick={() => fileRef.current?.click()} className="flex items-center justify-center px-4 py-2 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-semibold text-gray-700 dark:text-slate-300 hover:bg-gray-50">
                  <Upload size={16} className="mr-1.5" /> Upload Logo
                </button>
                {settings.logo && (
                  <button onClick={() => update({ logo: '', showLogo: false })} className="flex items-center justify-center px-4 py-2 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 rounded-xl text-sm font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-100">
                    <Trash2 size={16} className="mr-1.5" /> Remove
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/*" onChange={handleLogoFile} className="hidden" />
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-slate-400">Show logo on receipt</span>
              <Toggle checked={settings.showLogo} onChange={(v) => update({ showLogo: v })} label="Show logo" />
            </div>
          </div>

          {/* Receipt size */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-1">
              <Printer size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Receipt Size
            </h3>
            <p className="text-sm text-gray-500 dark:text-slate-400">Set the paper/roll width of your receipt printer.</p>
            <div className="flex flex-wrap gap-2">
              {[58, 80].map((mm) => (
                <button
                  key={mm}
                  type="button"
                  onClick={() => update({ widthMm: mm })}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-colors ${settings.widthMm === mm ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border-gray-200 dark:border-slate-700 hover:bg-gray-50'}`}
                >
                  {mm} mm
                </button>
              ))}
            </div>
            <Field label="Custom width (mm)">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="40"
                  max="120"
                  value={settings.widthMm}
                  onChange={(e) => update({ widthMm: Math.max(40, Number(e.target.value) || 58) })}
                  className={inputClass}
                />
                <span className="text-xs text-gray-400 dark:text-slate-500 flex items-center">= {mmToPx(settings.widthMm)} px</span>
              </div>
            </Field>
          </div>

          {/* Receipt barcode (bottom of receipt) */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-1">
              <BarcodeIcon size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Receipt Barcode
            </h3>
            <p className="text-sm text-gray-500 dark:text-slate-400">Print a scannable barcode at the bottom of every receipt. By default it encodes the receipt number.</p>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-slate-400">Show barcode on receipt</span>
              <Toggle checked={settings.showBarcode} onChange={(v) => update({ showBarcode: v })} label="Show barcode" />
            </div>
            <Field label="Barcode value (optional)">
              <input className={inputClass} value={settings.barcodeText}
                onChange={(e) => update({ barcodeText: e.target.value })}
                placeholder="Leave empty to use the receipt number" />
            </Field>
          </div>

          {/* Font size */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-1">
              <Type size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Receipt Font Size
            </h3>
            <p className="text-sm text-gray-500 dark:text-slate-400">Base text size for the whole receipt (all text scales together).</p>
            <div className="flex flex-wrap gap-2">
              {[10, 12, 14, 16].map((px) => (
                <button
                  key={px}
                  type="button"
                  onClick={() => update({ fontSize: px })}
                  className={`px-3 py-2 rounded-xl text-sm font-semibold border transition-colors ${settings.fontSize === px ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 border-gray-200 dark:border-slate-700 hover:bg-gray-50'}`}
                >
                  {px}px
                </button>
              ))}
            </div>
            <Field label="Custom size (px)">
              <input
                type="number"
                min="8"
                max="24"
                value={settings.fontSize}
                onChange={(e) => update({ fontSize: Math.min(24, Math.max(8, Number(e.target.value) || 12)) })}
                className={inputClass}
              />
            </Field>
          </div>

          {/* Shop name + header message */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-1">
              <Type size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Shop & Header
            </h3>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-slate-400">Show shop name</span>
              <Toggle checked={settings.showShopName} onChange={(v) => update({ showShopName: v })} label="Show shop name" />
            </div>
            <Field label="Shop name">
              <input className={inputClass} value={settings.shopName} onChange={(e) => update({ shopName: e.target.value })} placeholder="e.g. Loyal Mobile" />
            </Field>
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm text-gray-600 dark:text-slate-400">Show header message</span>
              <Toggle checked={settings.showHeaderMessage} onChange={(v) => update({ showHeaderMessage: v })} label="Show header message" />
            </div>
            <Field label="Header message (below store name)">
              <textarea className={`${inputClass} resize-none`} rows={2} value={settings.headerMessage} onChange={(e) => update({ headerMessage: e.target.value })} placeholder="e.g. Thank you for shopping with us!" />
            </Field>
          </div>

          {/* Footer message */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-1">
              <Type size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Footer Message
            </h3>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-slate-400">Show footer message</span>
              <Toggle checked={settings.showFooterMessage} onChange={(v) => update({ showFooterMessage: v })} label="Show footer message" />
            </div>
            <Field label="Footer message (bottom of receipt)">
              <textarea className={`${inputClass} resize-none`} rows={2} value={settings.footerMessage} onChange={(e) => update({ footerMessage: e.target.value })} placeholder="e.g. Thank you for your purchase!" />
            </Field>
          </div>
        </div>

        {/* ---- Right: contact details + live preview ---- */}
        <div className="space-y-5">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center mb-1">
              <Phone size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Contact Details
            </h3>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600 dark:text-slate-400">Show contact details</span>
              <Toggle checked={settings.showContact} onChange={(v) => update({ showContact: v })} label="Show contact details" />
            </div>
            <Field label="Phone">
              <div className="relative">
                <Phone size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                <input className={`${inputClass} pl-9`} value={settings.phone} onChange={(e) => update({ phone: e.target.value })} placeholder="e.g. 077 123 4567" />
              </div>
            </Field>
            <Field label="Address">
              <div className="relative">
                <MapPin size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                <input className={`${inputClass} pl-9`} value={settings.address} onChange={(e) => update({ address: e.target.value })} placeholder="e.g. No.12, Main St, Colombo" />
              </div>
            </Field>
            <Field label="Email">
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                <input className={`${inputClass} pl-9`} value={settings.email} onChange={(e) => update({ email: e.target.value })} placeholder="e.g. sales@loyalmobile.lk" />
              </div>
            </Field>
            <Field label="Website">
              <div className="relative">
                <Globe size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500" />
                <input className={`${inputClass} pl-9`} value={settings.website} onChange={(e) => update({ website: e.target.value })} placeholder="e.g. www.loyalmobile.lk" />
              </div>
            </Field>
          </div>

          {/* Live preview */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 overflow-hidden">
            <div className="p-4 border-b border-gray-100 dark:border-slate-800 flex items-center justify-between">
              <h3 className="font-bold text-gray-900 dark:text-slate-100 flex items-center"><Printer size={18} className="mr-2 text-blue-600 dark:text-blue-400" /> Live Preview</h3>
              <span className="text-xs text-gray-400 dark:text-slate-500">Updates as you type</span>
            </div>
            <div className="p-4 bg-gray-100 dark:bg-slate-800 flex justify-center">
              <iframe title="Receipt preview" srcDoc={previewHtml} style={{ width: Math.min(420, mmToPx(settings.widthMm)), minHeight: 420 }} className="bg-white dark:bg-slate-800 max-w-full min-h-[420px] rounded-md shadow-md border border-gray-200 dark:border-slate-700" />
            </div>
          </div>
        </div>
      </div>

      {/* ---- Admin only: Refunds & Approvals policy ---- */}
      {isAdmin && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-bold text-gray-900 dark:text-slate-100">Refunds &amp; Approvals</h3>
            <span className="text-xs font-semibold text-violet-600 bg-violet-50 border border-violet-100 rounded-full px-3 py-1">Admin only</span>
          </div>
          <p className="text-sm text-gray-500 dark:text-slate-400 max-w-3xl">
            Cashiers can refund directly while they stay within these limits. A refund above the amount limit,
            outside the day window, or returned to a different payment method is held in the approval queue until
            an admin / shop owner completes it with the approval PIN.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Cashier limit without approval (Rs.)">
              <input type="number" min="0" step="100" className={inputClass}
                value={policy.maxAmount} onChange={(e) => setPolicy({ ...policy, maxAmount: e.target.value })} />
            </Field>
            <Field label="Max days after the sale">
              <input type="number" min="1" className={inputClass}
                value={policy.maxDays} onChange={(e) => setPolicy({ ...policy, maxDays: e.target.value })} />
            </Field>
            <label className="block">
              <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Same payment method required</span>
              <button type="button" onClick={() => setPolicy({ ...policy, sameMethodRequired: !policy.sameMethodRequired })}
                className={`mt-1.5 w-full rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors ${policy.sameMethodRequired ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 text-gray-500 dark:text-slate-400'}`}>
                {policy.sameMethodRequired ? 'Yes — different method needs approval' : 'No — any method allowed'}
              </button>
            </label>
            <label className="block md:col-span-2">
              <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
                Admin approval PIN {pinExists ? '(one is set)' : ''}
              </span>
              <input type="password" inputMode="numeric" className={inputClass}
                placeholder={pinExists ? 'Type a new PIN to replace it…' : 'Optional — required to approve out-of-limit refunds'}
                value={adminPin} onChange={(e) => setAdminPin(e.target.value)} />
              <span className="mt-1 block text-[11px] text-gray-400 dark:text-slate-500">
                Shop owners bypass the PIN. Cashier-initiated refunds over the limit appear under Reports → Refunds for approval.
              </span>
            </label>
          </div>
          {policyStatus.msg && (
            <div className={`rounded-xl px-4 py-2.5 text-sm border ${policyStatus.kind === 'ok' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30' : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30'}`}>
              {policyStatus.msg}
            </div>
          )}
          <div className="flex items-center justify-end">
            <button type="button" onClick={saveRefundPolicy} disabled={rpBusy}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold shadow-md disabled:opacity-60">
              {rpBusy ? 'Saving…' : 'Save refund policy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
