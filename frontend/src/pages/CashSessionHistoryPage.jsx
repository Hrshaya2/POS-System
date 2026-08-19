import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { RefreshCw, Coins, CalendarDays, User } from 'lucide-react';

const API_BASE = '/api';

export default function CashSessionHistoryPage() {
    const { user } = useAuth();
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);

    const loadSessions = async () => {
        setLoading(true);
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE}/sessions`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.ok) {
                setSessions(await res.json());
            }
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSessions();
    }, []);

    const formatMoney = (val) => `Rs. ${Number(val || 0).toLocaleString('en-LK')}`;

    return (
        <div className="space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-center gap-4 lg:justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-gray-900">Cash Sessions History</h1>
                    <p className="text-gray-500 mt-1">Audit log of all daily opening and closing balances and cash variances.</p>
                </div>
                <button onClick={loadSessions} className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 bg-white shadow-sm">
                    <RefreshCw size={16} /> Refresh
                </button>
            </div>

            <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left text-gray-600">
                        <thead className="bg-gray-50/70 text-xs uppercase text-gray-400 border-b border-gray-100">
                            <tr>
                                <th className="px-6 py-4">Date</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Opened By</th>
                                <th className="px-6 py-4">Opening Cash</th>
                                <th className="px-6 py-4 text-center" colSpan="3">Closing Verification (Cash Drawer)</th>
                            </tr>
                            <tr className="bg-gray-50/30 text-[11px]">
                                <th colSpan="4"></th>
                                <th className="px-6 py-2 font-medium border-l border-gray-100">Expected</th>
                                <th className="px-6 py-2 font-medium">Actual</th>
                                <th className="px-6 py-2 font-medium">Variance</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan="7" className="px-6 py-10 text-center text-gray-400">Loading history...</td></tr>
                            ) : sessions.length === 0 ? (
                                <tr><td colSpan="7" className="px-6 py-10 text-center text-gray-400">No sessions recorded yet.</td></tr>
                            ) : sessions.map(s => (
                                <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50/60 transition-colors">
                                    <td className="px-6 py-4 font-semibold text-gray-900 whitespace-nowrap">
                                        <div className="flex items-center gap-2">
                                            <CalendarDays size={16} className="text-blue-500" />
                                            {s.date}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${s.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                                            {s.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <User size={14} className="text-gray-400" /> ID: {s.opened_by}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 font-medium text-gray-900">
                                        {formatMoney(s.opening_cash)}
                                        {s.opening_reload > 0 && <div className="text-xs text-gray-400 text-nowrap">Reload: {formatMoney(s.opening_reload)}</div>}
                                    </td>

                                    {s.status === 'closed' ? (
                                        <>
                                            <td className="px-6 py-4 text-gray-600 border-l border-gray-50 bg-gray-50/30">{formatMoney(s.expected_cash)}</td>
                                            <td className="px-6 py-4 font-semibold text-gray-900 bg-gray-50/30">{formatMoney(s.actual_cash)}</td>
                                            <td className="px-6 py-4 bg-gray-50/30">
                                                <span className={`font-bold inline-flex items-center gap-1.5 px-2 py-1 rounded-lg ${s.variance < 0 ? 'bg-rose-50 text-rose-600' : s.variance > 0 ? 'bg-emerald-50 text-emerald-600' : 'text-gray-500'}`}>
                                                    {s.variance < 0 ? 'SHORT' : s.variance > 0 ? 'OVER' : 'BALANCED'}
                                                    {s.variance !== 0 && ` (${formatMoney(Math.abs(s.variance))})`}
                                                </span>
                                            </td>
                                        </>
                                    ) : (
                                        <td colSpan="3" className="px-6 py-4 text-gray-400 text-center italic border-l border-gray-50 bg-gray-50/20">
                                            Session is still open
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
