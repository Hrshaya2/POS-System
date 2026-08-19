import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarDays, ClipboardList, Package, Search, ShieldCheck, Wrench } from 'lucide-react';

const API_BASE = '/api';
const REPAIR_STATUSES = ['Received', 'Diagnosing', 'Awaiting Parts', 'In Repair', 'Ready for Pickup', 'Delivered'];

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
    warranty_period_months: '3'
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
    const res = await fetch(`${API_BASE}/inventory/accessories`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      setSpareParts(data.filter((part) => Number(part.quantity) > 0));
    }
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

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_BASE}/repair-jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          ...form,
          estimated_cost: Number(form.estimated_cost || 0),
          warranty_period_months: Number(form.warranty_period_months || 3)
        })
      });

      const data = await parseApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Unable to create repair job');

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
        warranty_period_months: '3'
      });
      await loadData();
      setSelectedJobId(data.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const advanceStatus = async (jobId, nextStatus) => {
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

  const currentStatusIndex = selectedJob ? REPAIR_STATUSES.indexOf(selectedJob.repair_status) : -1;
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
          <h1 className="text-3xl font-bold text-gray-900">Repair Jobs</h1>
          <p className="text-gray-500 mt-1">Diagnose devices, manage part usage, and close out warranties.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2"><ClipboardList size={20} className="text-blue-600" /> Repair Job Form</h2>
          </div>

          <form onSubmit={handleFormSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">Customer name</label>
                <input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} required className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="e.g. Nimal Silva" />
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">Phone number</label>
                <input value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} required className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="e.g. 0771234567" />
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2 md:col-span-2">
                <label className="text-sm font-semibold text-gray-700">Device model</label>
                <input value={form.device_model} onChange={(e) => setForm({ ...form, device_model: e.target.value })} required className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="e.g. Samsung A14" />
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">IMEI or serial</label>
                <input value={form.imei} onChange={(e) => setForm({ ...form, imei: e.target.value })} className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="Optional if known" />
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">Received date</label>
                <div className="flex items-center gap-2">
                  <input ref={receivedDateRef} value={form.received_date} onChange={(e) => setForm({ ...form, received_date: e.target.value })} type="date" className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
                  <button type="button" onClick={() => openDatePicker(receivedDateRef)} className="h-11 w-11 rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 inline-flex items-center justify-center" aria-label="Open received date picker">
                    <CalendarDays size={18} />
                  </button>
                </div>
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">Estimated completion date</label>
                <div className="flex items-center gap-2">
                  <input ref={completionDateRef} value={form.estimated_completion_date} onChange={(e) => setForm({ ...form, estimated_completion_date: e.target.value })} type="date" min={todayDate} required className="w-full rounded-2xl border border-gray-200 px-4 py-3" />
                  <button type="button" onClick={() => openDatePicker(completionDateRef)} className="h-11 w-11 rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 inline-flex items-center justify-center" aria-label="Open completion date picker">
                    <CalendarDays size={18} />
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2 md:col-span-2">
                <label className="text-sm font-semibold text-gray-700">Reported issue</label>
                <textarea value={form.reported_issue} onChange={(e) => setForm({ ...form, reported_issue: e.target.value })} rows="3" required className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="Describe the complaint in the customer’s words" />
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2 md:col-span-2">
                <label className="text-sm font-semibold text-gray-700">Items left with device</label>
                <textarea value={form.items_left} onChange={(e) => setForm({ ...form, items_left: e.target.value })} rows="2" className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="Charger, SIM, memory card, case, etc." />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">Estimated labor cost</label>
                <input value={form.estimated_cost} onChange={(e) => setForm({ ...form, estimated_cost: e.target.value })} type="number" min="0" step="0.01" className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="0.00" />
              </div>
              <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-2">
                <label className="text-sm font-semibold text-gray-700">Warranty period</label>
                <input value={form.warranty_period_months} onChange={(e) => setForm({ ...form, warranty_period_months: e.target.value })} type="number" min="1" className="w-full rounded-2xl border border-gray-200 px-4 py-3" placeholder="3" />
              </div>
            </div>

            <div>
              <button type="submit" disabled={saving} className="w-full rounded-2xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Saving...' : 'Create Repair Job'}
              </button>
            </div>
          </form>

          {error && (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          )}
        </div>

        <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2"><ShieldCheck size={20} className="text-emerald-600" /> Warranty Lookup</h2>
          <div className="mt-4 flex gap-2">
            <input value={warrantyTerm} onChange={(e) => setWarrantyTerm(e.target.value)} className="flex-1 rounded-2xl border border-gray-200 px-4 py-3" placeholder="IMEI" />
            <button onClick={checkWarranty} className="rounded-2xl bg-emerald-600 px-4 py-3 font-semibold text-white">Check</button>
          </div>

          {warrantyResult && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
              {warrantyResult.found ? (
                <>
                  <div className="font-semibold text-emerald-800">{warrantyResult.status === 'ACTIVE' ? 'Warranty Active' : 'Warranty Expired'}</div>
                  <div className="mt-2 text-emerald-700">Customer: {warrantyResult.customer_name}</div>
                  <div className="text-emerald-700">End date: {warrantyResult.warranty_end_date}</div>
                </>
              ) : (
                <div className="font-semibold text-emerald-800">No matching repair record found.</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2"><Search size={20} className="text-blue-600" /> Repair Jobs List</h2>
          </div>
          <div className="flex flex-col md:flex-row gap-3 w-full lg:w-auto">
            <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="rounded-2xl border border-gray-200 px-4 py-3 min-w-[220px]" placeholder="Search customer or IMEI" />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-2xl border border-gray-200 px-4 py-3">
              <option value="all">All statuses</option>
              {REPAIR_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <div className="mt-6 text-gray-500">Loading repair jobs...</div>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm text-gray-600">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
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
                  <tr><td colSpan="6" className="px-4 py-8 text-center text-gray-400">No matching repair jobs.</td></tr>
                ) : filteredJobs.map((job) => (
                  <tr key={job.id} onClick={() => setSelectedJobId(job.id)} className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${selectedJob && selectedJob.id === job.id ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-3 font-semibold text-gray-900">{job.customer_name}<div className="text-xs text-gray-400">{job.phone_number}</div></td>
                    <td className="px-4 py-3">{job.device_model}</td>
                    <td className="px-4 py-3">{job.imei || 'N/A'}</td>
                    <td className="px-4 py-3"><span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">{job.repair_status}</span></td>
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
        <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900">{selectedJob.customer_name} - {selectedJob.device_model}</h2>
              <p className="text-sm text-gray-500">Phone: {selectedJob.phone_number} · IMEI: {selectedJob.imei || 'Not provided'}</p>
            </div>
            <div className="text-sm text-gray-500">Due: {selectedJob.estimated_completion_date}</div>
          </div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><Activity size={18} className="text-indigo-600" /> Status Pipeline</h3>
              <div className="flex flex-wrap gap-2">
                {REPAIR_STATUSES.map((status, idx) => (
                  <button
                    key={status}
                    onClick={() => advanceStatus(selectedJob.id, status)}
                    disabled={idx < REPAIR_STATUSES.indexOf(selectedJob.repair_status) || idx !== REPAIR_STATUSES.indexOf(selectedJob.repair_status) + 1}
                    className={`rounded-full px-3 py-2 text-xs font-semibold ${selectedJob.repair_status === status ? 'bg-indigo-600 text-white' : idx < REPAIR_STATUSES.indexOf(selectedJob.repair_status) ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'} disabled:opacity-40`}
                  >
                    {status}
                  </button>
                ))}
              </div>

              {nextAvailableStatus && (
                <button onClick={() => advanceStatus(selectedJob.id, nextAvailableStatus)} className="mt-4 rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white">
                  Move to {nextAvailableStatus}
                </button>
              )}
            </div>

            <div>
              <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><Package size={18} className="text-amber-600" /> Spare Parts Used</h3>
              <div className="flex flex-col gap-3">
                <select value={selectedPartId} onChange={(e) => setSelectedPartId(e.target.value)} className="rounded-2xl border border-gray-200 px-4 py-3">
                  <option value="">Select spare part</option>
                  {spareParts.map((part) => (
                    <option key={part.id} value={part.id}>{part.name} ({part.quantity} in stock)</option>
                  ))}
                </select>
                <input value={selectedPartQty} onChange={(e) => setSelectedPartQty(e.target.value)} type="number" min="1" className="rounded-2xl border border-gray-200 px-4 py-3" placeholder="Quantity" />
                <button onClick={() => addPartToRepair(selectedJob.id)} disabled={!selectedPartId} className="rounded-2xl bg-amber-600 px-4 py-3 font-semibold text-white disabled:opacity-50">
                  Add Spare Part
                </button>
              </div>

              <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 p-4">
                {selectedJob.parts && selectedJob.parts.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {selectedJob.parts.map((part) => (
                      <li key={part.id} className="flex justify-between gap-3 border-b border-gray-200 pb-2 last:border-0">
                        <span>{part.part_name} x {part.quantity}</span>
                        <span>{formatMoney(part.total_cost)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-sm text-gray-400">No spare parts assigned yet.</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <h3 className="font-bold text-gray-900 mb-3">Repair Details</h3>
              <p className="text-sm text-gray-600"><strong>Reported issue:</strong> {selectedJob.reported_issue}</p>
              <p className="text-sm text-gray-600 mt-2"><strong>Items left with device:</strong> {selectedJob.items_left || 'None'}</p>
              <p className="text-sm text-gray-600 mt-2"><strong>Warranty:</strong> {selectedJob.warranty_period_months} months</p>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><Wrench size={18} className="text-violet-600" /> Repair Invoice</h3>
              {selectedJob.invoice ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span>Labor</span><span>{formatMoney(selectedJob.invoice.labor_cost)}</span></div>
                  <div className="flex justify-between"><span>Parts</span><span>{formatMoney(selectedJob.invoice.parts_cost)}</span></div>
                  <div className="flex justify-between font-bold text-base text-gray-900"><span>Total</span><span>{formatMoney(selectedJob.invoice.total_cost)}</span></div>
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
