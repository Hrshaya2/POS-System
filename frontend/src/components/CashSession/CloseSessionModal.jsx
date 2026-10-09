import React, { useState, useEffect } from 'react';
import { useSession } from '../../context/SessionContext';
import { Coins, CheckCircle2, AlertTriangle, Printer } from 'lucide-react';

export default function CloseSessionModal({ onClose }) {
    const { session, closeSession } = useSession();
    const [actualCash, setActualCash] = useState('');
    const [actualReload, setActualReload] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [liveSessionData, setLiveSessionData] = useState(null);
    const [loadingLive, setLoadingLive] = useState(true);

    const actualReloadNum = Number(actualReload) || 0;
    const reloadsSold = liveSessionData ? Math.max(0, (liveSessionData.opening_reload || 0) - actualReloadNum) : 0;
    const expectedCashWithReloads = liveSessionData ? (liveSessionData.summary?.expectedCash || 0) + reloadsSold : 0;

    useEffect(() => {
        const fetchLiveSessionData = async () => {
            try {
                const token = localStorage.getItem('token');
                if (!token) return;
                const res = await fetch('/api/sessions/current', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    setLiveSessionData(data);
                }
            } catch (err) {
                console.error("Failed to fetch live session data:", err);
            } finally {
                setLoadingLive(false);
            }
        };
        fetchLiveSessionData();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        try {
            const data = await closeSession(actualCash, actualReload);
            setResult(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handlePrint = () => {
        window.print();
        onClose();
    };

    if (result) {
        return (
            <div className="fixed inset-0 bg-gray-900/60 dark:bg-slate-950/60 backdrop-blur-sm z-[999] flex justify-center p-6 print:bg-white print:p-0 overflow-y-auto">
                <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden my-auto print:shadow-none print:max-w-full">
                    <div className="p-6 print:p-0">
                        <div className="text-center mb-6 border-b pb-4 print:border-black print:pb-2">
                            <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100 print:text-black">Z-Report / End of Day</h2>
                            <p className="text-gray-500 dark:text-slate-400 text-sm print:text-black">Session ID: {result.id}</p>
                            <p className="text-gray-500 dark:text-slate-400 text-sm print:text-black">Date: {result.date}</p>
                        </div>

                        <div className="space-y-3 mb-6 font-mono text-sm print:text-black">
                            <div className="flex justify-between"><span className="text-gray-600 dark:text-slate-400 print:text-black">Opening Cash:</span> <span>Rs. {result.opening_cash?.toLocaleString()}</span></div>
                            <div className="flex justify-between"><span className="text-gray-600 dark:text-slate-400 print:text-black">Total Cash Sales:</span> <span>Rs. {result.summary?.totalCashSales?.toLocaleString()}</span></div>
                            <div className="flex border-t pt-2 mt-2 justify-between font-bold text-gray-900 dark:text-slate-100 print:text-black"><span className="text-gray-700 dark:text-slate-300 print:text-black">Expected Cash (Drawer):</span> <span>Rs. {result.expected_cash?.toLocaleString()}</span></div>
                            <div className="flex justify-between text-blue-700 dark:text-blue-300 font-bold"><span className="print:text-black">Actual Cash Counted:</span> <span className="print:text-black">Rs. {result.actual_cash?.toLocaleString()}</span></div>
                            <div className={`flex justify-between font-bold ${result.variance < 0 ? 'text-red-600 dark:text-red-400' : result.variance > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-slate-400'} print:text-black`}>
                                <span className="print:text-black">Variance:</span>
                                <span className="print:text-black">{result.variance < 0 ? 'Short' : result.variance > 0 ? 'Over' : 'Balanced'} (Rs. {Math.abs(result.variance || 0).toLocaleString()})</span>
                            </div>
                        </div>

                        <div className="flex space-x-3 print:hidden">
                            <button onClick={handlePrint} className="flex-1 bg-gray-900 dark:bg-slate-950 text-white rounded-xl p-3 flex items-center justify-center space-x-2 font-medium hover:bg-black transition-colors">
                                <Printer size={18} /><span>Print Report</span>
                            </button>
                            <button onClick={onClose} className="flex-1 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 rounded-xl p-3 font-medium hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors">
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 bg-gray-900/60 dark:bg-slate-950/60 backdrop-blur-sm z-[999] flex justify-center p-6 overflow-y-auto items-center">
            <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
                <div className="bg-gray-50 dark:bg-slate-950 border-b p-5 flex justify-between items-center">
                    <h3 className="text-xl font-bold flex items-center text-gray-800 dark:text-slate-200"><CheckCircle2 className="mr-2 text-emerald-500 dark:text-emerald-400" /> Close Day Session</h3>
                    <button onClick={onClose} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 p-2 text-xl font-bold rounded-lg">&times;</button>
                </div>

                <form onSubmit={handleSubmit} className="p-6">
                    {error && <div className="bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 p-3 rounded-xl text-sm border border-red-100 dark:border-red-500/20 mb-4">{error}</div>}

                    <div className="bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-200 p-4 rounded-xl text-sm border border-blue-100 dark:border-blue-500/20 mb-6 flex space-x-3 items-start">
                        <AlertTriangle className="flex-shrink-0 text-blue-500 dark:text-blue-400 mt-0.5" size={18} />
                        <div>Please count the physical cash in the drawer and record the exact amount below. The system will calculate variances automatically.</div>
                    </div>

                    {!loadingLive && liveSessionData && liveSessionData.summary && (
                        <div className="mb-6 bg-gray-50 dark:bg-slate-950 p-4 rounded-xl border border-gray-100 dark:border-slate-800 space-y-2 text-sm text-gray-700 dark:text-slate-300">
                            <h4 className="font-bold text-gray-900 dark:text-slate-100 border-b border-gray-200 dark:border-slate-700 pb-2 mb-2">Current Session Overview</h4>
                            <div className="flex justify-between"><span>Opening Cash:</span> <strong>Rs. {liveSessionData.opening_cash?.toLocaleString()}</strong></div>
                            <div className="flex justify-between"><span>Total Cash Sales:</span> <strong>Rs. {liveSessionData.summary?.totalCashSales?.toLocaleString()}</strong></div>
                            <div className="flex justify-between"><span>Opening Reload:</span> <strong>Rs. {liveSessionData.opening_reload?.toLocaleString()}</strong></div>

                            {reloadsSold > 0 && (
                                <div className="flex justify-between text-emerald-700 dark:text-emerald-300">
                                    <span>Reloads Sold (Adds to Cash):</span> <strong>+ Rs. {reloadsSold.toLocaleString()}</strong>
                                </div>
                            )}

                            <div className="flex justify-between text-blue-700 dark:text-blue-300 font-bold border-t border-gray-200 dark:border-slate-700 pt-2 mt-2">
                                <span>Expected Cash (Drawer):</span> <span>Rs. {expectedCashWithReloads.toLocaleString()}</span>
                            </div>
                        </div>
                    )}

                    <div className="space-y-5 mb-8">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">Actual Cash in Drawer</label>
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                                    <Coins size={18} className="text-gray-400 dark:text-slate-500 group-focus-within:text-emerald-500 group-focus-within:dark:text-emerald-400 transition-colors" />
                                </div>
                                <input type="number" required min="0" value={actualCash} onChange={e => setActualCash(e.target.value)}
                                    className="pl-10 block w-full rounded-xl border-gray-200 dark:border-slate-700 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 border p-3"
                                    placeholder="Enter actual counted cash" />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-gray-700 dark:text-slate-300 mb-1.5">Actual Reload Machine Balance</label>
                            <input type="number" required min="0" value={actualReload} onChange={e => setActualReload(e.target.value)}
                                className="block w-full rounded-xl border-gray-200 dark:border-slate-700 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 border p-3"
                                placeholder="Enter actual reload balance" />
                        </div>
                    </div>

                    <div className="flex space-x-3">
                        <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 font-medium hover:bg-gray-50 dark:hover:bg-slate-700 hover:dark:bg-slate-950 flex-1 transition-colors relative">Cancel</button>
                        <button type="submit" disabled={loading} className="px-5 py-3 rounded-xl bg-emerald-600 text-white font-bold shadow-lg shadow-emerald-500/30 hover:bg-emerald-700 flex-1 transition-all disabled:opacity-75 disabled:cursor-wait">
                            {loading ? 'Closing...' : 'Confirm & Close Day'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
