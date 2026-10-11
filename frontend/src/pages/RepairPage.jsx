import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarDays, ClipboardList, Package, Printer, Search, ShieldCheck, Wrench } from 'lucide-react';
import { addPendingRepairJob, addPendingRepairStatusUpdate, getCachedInventory } from '../db/database';
import { mergeAccessoriesIntoCache } from '../services/stockService';
import { openRepairBillPrint } from '../utils/repairReceipt';

const API_BASE = '/api';
// Must match backend REPAIR_STATUS_FLOW exactly ('Identifying', not
// 'Diagnosing') — any mismatch makes indexOf return -1, which disables every
// pipeline button and gets rejected by PUT /:id/status.
const REPAIR_STATUSES = ['Received', 'Identifying', 'Awaiting Parts', 'In Repair', 'Ready for Pickup', 'Delivered'];

const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const toDateInputValue = (date) => new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);

const parseApiResponse = async (res) => {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }

  const raw = await res.text();
  if (raw.trim().startsWith('<!DOCTYPE') || raw.trim().startsWith('<html')) {
    return { error: 'Repair API endpoint not found. Restart backend server and try again.' };
  }
  return { error: raw || 'Unexpected server response' };
};

export default function RepairPage() {
  const receivedDateRef = useRef(null);
  const completionDateRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [spareParts, setSpareParts] = useState([]);
  const [offlineMode, setOfflineMode] = useState(!navigator.onLine);

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
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [warrantyTerm, setWarrantyTerm] = useState('');
  const [warrantyResult, setWarrantyResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedPartId, setSelectedPartId] = useState('');
  const [selectedPartQty, setSelectedPartQty] = useState('1');
  const todayDate = useMemo(() => toDateInputValue(new Date()), []);
  const defaultDueDate = useMemo(() => {
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 3);
    return toDateInputValue(nextDate);
  }, []);
  const [form, setForm] = useState({
    customer_name: '',
    phone_number: '',
    device_model: '',
    imei: '',
    reported_issue: '',
    items_left: '',
    received_date: todayDate,
    estimated_cost: '0',
    estimated_completion_date: defaultDueDate,
    warranty_period_months: '3',
    advance_amount: '',
    payment_method: 'CASH'
  });

  useEffect(() => {
    setForm((current) => ({
      ...current,
      received_date: current.received_date || todayDate,
      estimated_completion_date: current.estimated_completion_date || defaultDueDate
    }));
  }, [defaultDueDate, todayDate]);

  const loadJobs = async () => {
    const token = localStorage.getItem('token');
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (searchTerm.trim()) params.set('q', searchTerm.trim());

    const res = await fetch(`${API_BASE}/repair-jobs?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error('Unable to load repair jobs');
    }

    const data = await res.json();
    setJobs(data);
    if (data.length && !selectedJobId) setSelectedJobId(data[0].id);
    if (data.length && selectedJobId && !data.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(data[0].id);
    }
  };

  const loadSpareParts = async () => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_BASE}/inventory/accessories`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        // Shared stock-service merge: accepts server truth into the cache
        // while keeping items created/adjusted in Stock Management whose ops
        // are still queued, so the parts picker matches what the user sees there.
        await mergeAccessoriesIntoCache(await res.json());
      }
    } catch (_err) { /* offline — serve cache below */ }
    const cached = await getCachedInventory();
    setSpareParts(cached.accessories.filter((part) => Number(part.quantity) > 0));
  };

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadJobs(), loadSpareParts()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [statusFilter, searchTerm]);

  const filteredJobs = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return jobs.filter((job) => {
      if (!term) return true;
      return (job.customer_name || '').toLowerCase().includes(term) || (job.imei || '').toLowerCase().includes(term);
    });
  }, [jobs, searchTerm]);

  const selectedJob = filteredJobs.find((job) => job.id === selectedJobId) || filteredJobs[0] || null;

  useEffect(() => {
    if (selectedJob && !filteredJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(selectedJob.id);
    }
  }, [filteredJobs, selectedJob, selectedJobId]);

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    setError('');

    const missingFields = [];
    if (!form.customer_name.trim()) missingFields.push('customer name');
    if (!form.phone_number.trim()) missingFields.push('phone number');
    if (!form.device_model.trim()) missingFields.push('device model');
    if (!form.reported_issue.trim()) missingFields.push('reported issue');
    if (!form.estimated_completion_date) missingFields.push('estimated completion date');

    if (missingFields.length > 0) {
      setError(`Please fill in: ${missingFields.join(', ')}.`);
      return;
    }

    setSaving(true);

    // Single optional advance at intake. Empty = no advance. When given, a
    // payment method is required (backend enforces the same rule).
    const advance = form.advance_amount === '' ? 0 : Number(form.advance_amount);
    if (!Number.isFinite(advance) || advance < 0) {
      setError('Advance amount must be a non-negative number.');
      setSaving(false);
      return;
    }

    try {
      // Build the local repair job record
      const localJob = {
        customerName: form.customer_name.trim(),
        phoneNumber: form.phone_number.trim(),
        deviceModel: form.device_model.trim(),
        imei: form.imei?.trim() || '',
        reportedIssue: form.reported_issue.trim(),
        itemsLeft: form.items_left?.trim() || '',
        receivedDate: form.received_date,
        estimatedCost: Number(form.estimated_cost || 0),
        estimatedCompletionDate: form.estimated_completion_date,
        warrantyPeriodMonths: Number(form.warranty_period_months || 3),
        advanceAmount: advance,
        paymentMethod: advance > 0 ? form.payment_method : '',
        paymentStatus: advance > 0 ? 'PARTIAL' : 'UNPAID',
        repair_status: 'Received',
        created_at: new Date().toISOString()
      };

      // Local-first: persist to IndexedDB first
      const localKey = await addPendingRepairJob(localJob);

      // Save the form immediately
      setForm({
        customer_name: '',
        phone_number: '',
        device_model: '',
        imei: '',
        reported_issue: '',
        items_left: '',
        received_date: todayDate,
        estimated_cost: '0',
        estimated_completion_date: defaultDueDate,
        warranty_period_months: '3',
        advance_amount: '',
        payment_method: 'CASH'
      });

      // Add the local job to the list so it shows immediately
      const displayJob = {
        id: `local-${localKey}`,
        customer_name: localJob.customerName,
        phone_number: localJob.phoneNumber,
        device_model: localJob.deviceModel,
        imei: localJob.imei || null,
        reported_issue: localJob.reportedIssue,
        items_left: localJob.itemsLeft,
        received_date: localJob.receivedDate,
        estimated_cost: localJob.estimatedCost,
        estimated_completion_date: localJob.estimatedCompletionDate,
        repair_status: 'Received',
        warranty_period_months: localJob.warrantyPeriodMonths,
        warranty_end_date: null,
        advance_amount: localJob.advanceAmount,
        payment_method: localJob.paymentMethod,
        payment_status: localJob.paymentStatus,
        created_at: localJob.created_at,
        parts: [],
        invoice: {
          job_id: `local-${localKey}`,
          invoice_no: `REPAIR-LOCAL-${localKey}`,
          labor_cost: localJob.estimatedCost,
          parts_cost: 0,
          total_cost: localJob.estimatedCost,
          advance_amount: localJob.advanceAmount,
          balance_due: Math.max(0, localJob.estimatedCost - localJob.advanceAmount),
          payment_method: localJob.paymentMethod,
          payment_status: localJob.paymentStatus,
          status: 'Received',
          created_at: localJob.created_at
        }
      };
      setJobs((current) => [displayJob, ...current]);
      setSelectedJobId(displayJob.id);
      // Advance receipt goes to the customer right away when an advance was taken.
      if (localJob.advanceAmount > 0) openRepairBillPrint(displayJob, 'ADVANCE');

      // If online, also push to the server in the background (never block the user)
      const token = localStorage.getItem('token');
      if (navigator.onLine && token) {
        (async () => {
          try {
            const res = await fetch(`${API_BASE}/repair-jobs`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({
                ...form,
                estimated_cost: Number(form.estimated_cost || 0),
                warranty_period_months: Number(form.warranty_period_months || 3),
                advance_amount: advance,
                payment_method: advance > 0 ? form.payment_method : ''
              })
            });

            const data = await parseApiResponse(res);
            if (res.ok) {
              const { markRepairJobSynced, removeRepairJob } = await import('../db/database');
              await markRepairJobSynced(localKey, data.id);
              setJobs((current) => current.map((job) =>
                job.id === displayJob.id ? { ...job, id: data.id } : job
              ));
              setSelectedJobId(data.id);
              await loadData();
            } else {
              console.warn('Repair job server push failed, keeping local record pending:', data.error);
            }
          } catch (err) {
            // Network dropped mid-push — record stays pending and background sync handles it
            console.warn('Network push failed, repair job saved locally and will sync later:', err);
          }
        })();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const advanceStatus = async (jobId, nextStatus) => {
    // Local-first status update
    const isLocalJob = String(jobId).startsWith('local-');

    if (!navigator.onLine || isLocalJob) {
      // Offline (or the job is a local-only pending record): update UI and queue the status change
      setJobs((current) => current.map((job) =>
        job.id === jobId ? { ...job, repair_status: nextStatus } : job
      ));
      if (!isLocalJob) {
        // Only queue server-targeted updates for server-known jobs
        await addPendingRepairStatusUpdate({ repairJobId: jobId, targetStatus: nextStatus })
          .catch((err) => console.warn('Failed to queue offline status update:', err));
      }
      setSelectedJobId(jobId);
      return;
    }

    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}/repair-jobs/${jobId}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ status: nextStatus })
    });

    const data = await parseApiResponse(res);
    if (!res.ok) {
      setError(data.error || 'Status update failed');
      return;
    }

    await loadData();
    setSelectedJobId(jobId);
  };

  const addPartToRepair = async (jobId) => {
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}/repair-jobs/${jobId}/parts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ inventoryId: Number(selectedPartId), quantity: Number(selectedPartQty || 1) })
    });

    const data = await parseApiResponse(res);
    if (!res.ok) {
      setError(data.error || 'Unable to add spare part');
      return;
    }

    setSelectedPartId('');
    setSelectedPartQty('1');
    await loadData();
    setSelectedJobId(jobId);
  };

  const collectBalance = async (jobId) => {
    if (String(jobId).startsWith('local-')) {
      setError('This job is still syncing. Please wait for it to sync, then collect the balance.');
      return;
    }
    const job = jobs.find((j) => String(j.id) === String(jobId));
    const balance = Number(job?.invoice?.balance_due ?? 0);
    const method = window.prompt(
      `Collect balance ${formatMoney(balance)}.\nEnter payment method: CASH, CARD, or BANK_TRANSFER`,
      job?.payment_method || 'CASH'
    );
    if (method === null) return;
    const normalized = String(method).trim().toUpperCase();
    if (!['CASH', 'CARD', 'BANK_TRANSFER'].includes(normalized)) {
      setError('Payment method must be CASH, CARD, or BANK_TRANSFER.');
      return;
    }
    setError('');
    const token = localStorage.getItem('token');
    const res = await fetch(`${API_BASE}/repair-jobs/${jobId}/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ payment_method: normalized })
    });
    const data = await parseApiResponse(res);
    if (!res.ok) {
      setError(data.error || 'Unable to collect balance');
      return;
    }
    await loadData();
    setSelectedJobId(jobId);
    openRepairBillPrint({ ...job, payment_method: normalized, payment_status: 'PAID', invoice: data }, 'FINAL');
  };

  const checkWarranty = async () => {
    const token = localStorage.getItem('token');
    let url = `${API_BASE}/repair-warranty`;
    if (warrantyTerm.trim()) {
      url += `?imei=${encodeURIComponent(warrantyTerm.trim())}`;
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await parseApiResponse(res);
    setWarrantyResult(data);
  };

  // Legacy rows saved with the old 'Diagnosing' label resolve to step 0 so the
  // pipeline (and Move button) stay clickable instead of freezing at index -1.
  const currentStatusIndex = selectedJob ? Math.max(0, REPAIR_STATUSES.indexOf(selectedJob.repair_status)) : -1;
  const nextAvailableStatus = currentStatusIndex >= 0 && currentStatusIndex < REPAIR_STATUSES.length - 1
    ? REPAIR_STATUSES[currentStatusIndex + 1]
    : null;

  const openDatePicker = (inputRef) => {
    if (!inputRef?.current) return;
    if (typeof inputRef.current.showPicker === 'function') {
      inputRef.current.showPicker();
      return;
    }
    inputRef.current.focus();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-slate-100">Repair Jobs</h1>
          <p className="text-gray-500 dark:text-slate-400 mt-1">Diagnose devices, manage part usage, and close out warranties.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-white dark:bg-slate-800 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><ClipboardList size={20} className="text-blue-600" /> Repair Job Form</h2>
          </div>

          <form onSubmit={handleFormSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Customer name</label>
                <input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="e.g. Nimal Silva" />
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Phone number</label>
                <input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} required className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="e.g. 0771234567" />
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2 md:col-span-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Device model</label>
                <input value={form.device_model} onChange={(e) => setForm({ ...form, device_model: e.target.value })} required className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="e.g. Samsung A14" />
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">IMEI or serial</label>
                <input value={form.imei} onChange={(e) => setForm({ ...form, imei: e.target.value })} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="Optional if known" />
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Received date</label>
                <div className="flex items-center gap-2">
                  <input ref={receivedDateRef} value={form.received_date} onChange={(e) => setForm({ ...form, received_date: e.target.value })} type="date" className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" />
                  <button type="button" onClick={() => openDatePicker(receivedDateRef)} className="h-11 w-11 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 inline-flex items-center justify-center" aria-label="Open received date picker">
                    <CalendarDays size={18} />
                  </button>
                </div>
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Estimated completion date</label>
                <div className="flex items-center gap-2">
                  <input ref={completionDateRef} value={form.estimated_completion_date} onChange={(e) => setForm({ ...form, estimated_completion_date: e.target.value })} type="date" min={todayDate} required className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" />
                  <button type="button" onClick={() => openDatePicker(completionDateRef)} className="h-11 w-11 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 inline-flex items-center justify-center" aria-label="Open completion date picker">
                    <CalendarDays size={18} />
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2 md:col-span-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Reported issue</label>
                <textarea value={form.reported_issue} onChange={(e) => setForm({ ...form, reported_issue: e.target.value })} rows="3" required className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="Describe the complaint in the customer’s words" />
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2 md:col-span-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Items left with device</label>
                <textarea value={form.items_left} onChange={(e) => setForm({ ...form, items_left: e.target.value })} rows="2" className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="Charger, SIM, memory card, case, etc." />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Estimated labor cost</label>
                <input value={form.estimated_cost} onChange={(e) => setForm({ ...form, estimated_cost: e.target.value })} type="number" min="0" step="0.01" className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="0.00" />
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Warranty period</label>
                <input value={form.warranty_period_months} onChange={(e) => setForm({ ...form, warranty_period_months: e.target.value })} type="number" min="1" className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="3" />
              </div>
              <div className="rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Advance amount (optional, one-time)</label>
                <input value={form.advance_amount} onChange={(e) => setForm({ ...form, advance_amount: e.target.value })} type="number" min="0" step="0.01" className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="Leave empty if no advance" />
                <p className="text-xs text-gray-500 dark:text-slate-400">Taken once at intake. An advance receipt prints automatically.</p>
              </div>
              <div className="rounded-2xl border border-gray-100 dark:border-slate-800 bg-gray-50/70 dark:bg-slate-950/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700 dark:text-slate-300">Advance payment method</label>
                <select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="w-full rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3 bg-white dark:bg-slate-800">
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </select>
              </div>
            </div>

            <div>
              <button type="submit" disabled={saving} className="w-full rounded-2xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving...' : 'Create Repair Job'}
              </button>
            </div>
          </form>

          {error && (
            <div className="mt-4 rounded-2xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">{error}</div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><ShieldCheck size={20} className="text-emerald-600" /> Warranty Lookup</h2>
          <div className="mt-4 flex gap-2">
            <input value={warrantyTerm} onChange={(e) => setWarrantyTerm(e.target.value)} className="flex-1 rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="IMEI" />
            <button onClick={checkWarranty} className="rounded-2xl bg-emerald-600 px-4 py-3 font-semibold text-white">Check</button>
          </div>

          {warrantyResult && (
            <div className="mt-4 rounded-2xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 p-4 text-sm">
              {warrantyResult.found ? (
                <>
                  <div className="font-semibold text-emerald-800 dark:text-emerald-200">{warrantyResult.status === 'ACTIVE' ? 'Warranty Active' : 'Warranty Expired'}</div>
                  <div className="mt-2 text-emerald-700 dark:text-emerald-300">Customer: {warrantyResult.customer_name}</div>
                  <div className="text-emerald-700">End date: {warrantyResult.warranty_end_date}</div>
                </>
              ) : (
                <div className="font-semibold text-emerald-800 dark:text-emerald-200">No matching repair record found.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100 flex items-center gap-2"><Search size={20} className="text-blue-600" /> Repair Jobs List</h2>
          </div>
          <div className="flex flex-col md:flex-row gap-3 w-full lg:w-auto">
            <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3 min-w-[220px]" placeholder="Search customer or IMEI" />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3 bg-white dark:bg-slate-800">
              <option value="all">All statuses</option>
              {REPAIR_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="mt-6 text-gray-500 dark:text-slate-400">Loading repair jobs...</div>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-600 dark:text-slate-400">
              <thead className="bg-gray-50 dark:bg-slate-950 text-xs uppercase text-gray-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Device</th>
                  <th className="px-4 py-3">IMEI</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Estimated</th>
                  <th className="px-4 py-3">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 ? (
                  <tr><td colSpan="6" className="px-4 py-8 text-center text-gray-400 dark:text-slate-500">No matching repair jobs.</td></tr>
                ) : filteredJobs.map((job) => (
                  <tr key={job.id} onClick={() => setSelectedJobId(job.id)} className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 dark:hover:bg-slate-700 ${selectedJob && selectedJob.id === job.id ? 'bg-blue-50 dark:bg-blue-500/10' : ''}`}>
                    <td className="px-4 py-3 font-semibold text-gray-900 dark:text-slate-100">{job.customer_name}<div className="text-xs text-gray-400 dark:text-slate-500">{job.phone_number}</div></td>
                    <td className="px-4 py-3">{job.device_model}</td>
                    <td className="px-4 py-3">{job.imei || 'N/A'}</td>
                    <td className="px-4 py-3"><span className="rounded-full bg-blue-100 dark:bg-blue-500/20 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300">{job.repair_status}</span></td>
                    <td className="px-4 py-3">{formatMoney(job.estimated_cost)}</td>
                    <td className="px-4 py-3">{job.invoice ? formatMoney(job.invoice.total_cost) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedJob && (
        <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm p-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-slate-100">{selectedJob.customer_name} - {selectedJob.device_model}</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {selectedJob.job_no ? `${selectedJob.job_no} · ` : ''}Phone: {selectedJob.phone_number} · IMEI: {selectedJob.imei || 'Not provided'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {Number(selectedJob.advance_amount || 0) > 0 && (
                <button onClick={() => openRepairBillPrint(selectedJob, 'ADVANCE')} className="inline-flex items-center gap-2 rounded-2xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20">
                  <Printer size={15} /> Advance Receipt
                </button>
              )}
              <button onClick={() => openRepairBillPrint(selectedJob, 'FINAL')} className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 dark:bg-slate-100 px-4 py-2.5 text-sm font-semibold text-white dark:text-slate-900 hover:opacity-90">
                <Printer size={15} /> Final Bill
              </button>
              {selectedJob.payment_status !== 'PAID' && (
                <button onClick={() => collectBalance(selectedJob.id)} className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">
                  Collect Balance
                </button>
              )}
            </div>
          </div>
          <div className="text-sm text-gray-500 dark:text-slate-400 mt-2">Due: {selectedJob.estimated_completion_date}</div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="font-bold text-gray-900 dark:text-slate-100 mb-3 flex items-center gap-2"><Activity size={18} className="text-indigo-600" /> Status Pipeline</h3>
              <div className="flex flex-wrap gap-2">
                {REPAIR_STATUSES.map((status, idx) => (
                  <button
                    key={status}
                    onClick={() => advanceStatus(selectedJob.id, status)}
                    disabled={(() => { const ci = Math.max(0, REPAIR_STATUSES.indexOf(selectedJob.repair_status)); return idx !== ci + 1; })()}
                    title={(() => { const ci = Math.max(0, REPAIR_STATUSES.indexOf(selectedJob.repair_status)); return idx === ci + 1 ? `Move to ${status}` : 'Complete previous step first'; })()}
                    className={`rounded-full px-3 py-2 text-xs font-semibold ${selectedJob.repair_status === status ? 'bg-indigo-600 text-white' : idx < REPAIR_STATUSES.indexOf(selectedJob.repair_status) ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400'} disabled:opacity-40`}
                  >
                    {status}
                  </button>
                ))}
              </div>

            {selectedJob && !selectedJob.id.startsWith('local-') && nextAvailableStatus && (
                <button onClick={() => advanceStatus(selectedJob.id, nextAvailableStatus)} className="mt-4 rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700">
                  Move to {nextAvailableStatus}
                </button>
              )}
            </div>

            <div>
              <h3 className="font-bold text-gray-900 dark:text-slate-100 mb-3 flex items-center gap-2"><Package size={18} className="text-amber-600" /> Spare Parts Used</h3>
              <div className="flex flex-col gap-3">
                <select value={selectedPartId} onChange={(e) => setSelectedPartId(e.target.value)} className="rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3 bg-white dark:bg-slate-800">
                  <option value="">Select spare part</option>
                  {spareParts.map((part) => (
                    <option key={part.id} value={part.id}>{part.name} ({part.quantity} in stock)</option>
                  ))}
                </select>
                <input value={selectedPartQty} onChange={(e) => setSelectedPartQty(e.target.value)} type="number" min="1" className="rounded-2xl border border-gray-200 dark:border-slate-700 px-4 py-3" placeholder="Quantity" />
                <button onClick={() => addPartToRepair(selectedJob.id)} disabled={!selectedPartId} className="rounded-2xl bg-amber-600 px-4 py-3 font-semibold text-white disabled:opacity-50">
                  Add Spare Part
                </button>
              </div>

              <div className="mt-4 rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4">
                {selectedJob.parts && selectedJob.parts.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {selectedJob.parts.map((part) => (
                      <li key={part.id} className="flex justify-between gap-3 border-b border-gray-200 dark:border-slate-700 pb-2 last:border-0">
                        <span>{part.part_name} x {part.quantity}</span>
                        <span>{formatMoney(part.total_cost)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-sm text-gray-400 dark:text-slate-500">No spare parts assigned yet.</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4">
              <h3 className="font-bold text-gray-900 dark:text-slate-100 mb-3">Repair Details</h3>
              <p className="text-sm text-gray-600 dark:text-slate-400"><strong>Reported issue:</strong> {selectedJob.reported_issue}</p>
              <p className="text-sm text-gray-600 dark:text-slate-400 mt-2"><strong>Items left with device:</strong> {selectedJob.items_left || 'None'}</p>
              <p className="text-sm text-gray-600 dark:text-slate-400 mt-2"><strong>Warranty:</strong> {selectedJob.warranty_period_months} months</p>
            </div>

            <div className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 p-4">
              <h3 className="font-bold text-gray-900 dark:text-slate-100 mb-3 flex items-center gap-2"><Wrench size={18} className="text-violet-600" /> Repair Invoice</h3>
              {selectedJob.invoice ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span>Labor</span><span>{formatMoney(selectedJob.invoice.labor_cost)}</span></div>
                  <div className="flex justify-between"><span>Parts</span><span>{formatMoney(selectedJob.invoice.parts_cost)}</span></div>
                  <div className="flex justify-between"><span>Total</span><span>{formatMoney(selectedJob.invoice.total_cost)}</span></div>
                  <div className="flex justify-between text-emerald-700 dark:text-emerald-300"><span>Advance paid</span><span>- {formatMoney(selectedJob.invoice.advance_amount ?? selectedJob.advance_amount)}</span></div>
                  <div className="flex justify-between font-bold text-base text-gray-900 dark:text-slate-100 border-t border-gray-200 dark:border-slate-700 pt-2"><span>Balance due</span><span>{formatMoney(selectedJob.invoice.balance_due ?? 0)}</span></div>
                  <div className="flex justify-between text-xs text-gray-500 dark:text-slate-400">
                    <span>{String(selectedJob.payment_method || '').replace('_', ' ') || 'No payment method'} · {selectedJob.payment_status || 'UNPAID'}</span>
                  </div>
                </div>
              ) : (
                <div className="text-gray-400">Invoice not generated yet.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
