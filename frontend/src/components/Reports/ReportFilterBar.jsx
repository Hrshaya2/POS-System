import React from 'react';
import { Calendar, Filter, Users, Package, UserRound } from 'lucide-react';
import { formatMoney, formatNumber } from '../../utils/reportExport';

export const DATE_PRESETS = [
    { label: 'Today', value: 'today' },
    { label: 'This Week', value: 'week' },
    { label: 'This Month', value: 'month' },
    { label: 'Last 90 days', value: '90' },
    { label: 'Custom', value: 'custom' }
];

const toISO = (d) => d.toISOString().slice(0, 10);
const fromNow = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return toISO(d); };
const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const startOfWeek = (d) => { const dd = new Date(d); dd.setDate(dd.getDate() - dd.getDay()); return toISO(dd); };

export const applyPreset = (preset) => {
    const today = new Date();
    const todayISO = toISO(today);
    switch (preset) {
        case 'today': return { from: todayISO, to: todayISO };
        case 'week': return { from: startOfWeek(today), to: todayISO };
        case 'month': return { from: toISO(startOf(today)), to: todayISO };
        case '90': return { from: fromNow(90), to: todayISO };
        default: return { from: fromNow(30), to: todayISO };
    }
};

export default function ReportFilterBar({ filters, setFilters, extras = [] }) {
    const apply = (patch) => setFilters((f) => ({ ...f, ...patch }));
    const setPreset = (preset) => {
        const r = applyPreset(preset);
        apply({ from: r.from, to: r.to, preset });
    };

    return (
        <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm mb-4">
            <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col">
                    <label className="text-xs text-gray-500 mb-1">Date range</label>
                    <div className="flex gap-1 flex-wrap">
                        {DATE_PRESETS.map((p) => (
                            <button key={p.value}
                                onClick={() => setPreset(p.value)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filters.preset === p.value
                                    ? 'bg-blue-600 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}>
                                {p.label}
                            </button>
                        ))}
                    </div>
                </div>

                {filters.preset === 'custom' && (
                    <>
                        <div className="flex flex-col">
                            <label className="text-xs text-gray-500 mb-1">From</label>
                            <input type="date" value={filters.from || ''} onChange={(e) => apply({ from: e.target.value })} className="px-3 py-2 border rounded-lg text-sm" />
                        </div>
                        <div className="flex flex-col">
                            <label className="text-xs text-gray-500 mb-1">To</label>
                            <input type="date" value={filters.to || ''} onChange={(e) => apply({ to: e.target.value })} className="px-3 py-2 border rounded-lg text-sm" />
                        </div>
                    </>
                )}

                {filters.showCashier && (
                    <div className="flex flex-col">
                        <label className="text-xs text-gray-500 mb-1">Cashier</label>
                        <input type="text" placeholder="All cashiers" value={filters.cashierId || ''} onChange={(e) => apply({ cashierId: e.target.value })} className="px-3 py-2 border rounded-lg text-sm w-44" />
                    </div>
                )}

                {filters.showCategory && (
                    <div className="flex flex-col">
                        <label className="text-xs text-gray-500 mb-1">Category / Group</label>
                        <input type="text" placeholder="All categories" value={filters.category || ''} onChange={(e) => apply({ category: e.target.value })} className="px-3 py-2 border rounded-lg text-sm w-44" />
                    </div>
                )}

                {extras.map((extra) => (
                    <div key={extra.key} className="flex flex-col">
                        <label className="text-xs text-gray-500 mb-1">{extra.label}</label>
                        {extra.render(filters, apply)}
                    </div>
                ))}

                <button onClick={() => apply({})} className="ml-auto px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium">
                    Reset
                </button>
            </div>
        </div>
    );
}

export const SummaryTile = ({ label, value, valueType = 'money', icon: Icon, muted = false }) => (
    <div className={`bg-white rounded-2xl border border-gray-100 p-4 shadow-sm ${muted ? 'opacity-75' : ''}`}>
        <div className="flex items-center gap-2 text-gray-500 text-xs font-semibold mb-1">
            {Icon ? <Icon size={14} /> : null}{label}
        </div>
        <div className={`text-2xl font-bold ${muted ? 'text-gray-400' : 'text-gray-800'}`}>
            {valueType === 'money' ? formatMoney(value) : formatNumber(value)}
        </div>
    </div>
);
