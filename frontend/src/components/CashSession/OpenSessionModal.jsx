import React, { useState } from 'react';
import { useSession } from '../../context/SessionContext';
import { useAuth } from '../../context/AuthContext';
import { Coins, CreditCard } from 'lucide-react';

export default function OpenSessionModal({ onClose }) {
    const { openSession } = useSession();
    const { user, logout } = useAuth();
    const [cash, setCash] = useState('');
    const [reload, setReload] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            await openSession(cash, reload);
            if (onClose) onClose();
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 flex items-center justify-center z-[9999] p-4 bg-gray-900/60 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden border border-gray-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-6 text-white text-center relative overflow-hidden flex flex-col items-center">
                    {onClose && (
                        <button onClick={onClose} className="absolute top-4 right-4 text-white/70 hover:text-white z-20 font-bold text-xl drop-shadow-md">
                            &times;
                        </button>
                    )}
                    <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-white opacity-10 rounded-full blur-xl"></div>
                    <div className="absolute bottom-0 left-0 -mb-4 -ml-4 w-24 h-24 bg-black opacity-10 rounded-full blur-xl"></div>
                    <h2 className="text-2xl font-bold relative z-10 w-full">Open Day Session</h2>
                    <p className="text-blue-100 mt-1 relative z-10 text-sm">Hello, {user?.name}. Start your day by setting opening balances.</p>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-6">
                    {error && (
                        <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm border border-red-100 font-medium text-center shadow-sm">
                            {error}
                        </div>
                    )}

                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Cash Drawer Opening Balance (Rs.)</label>
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                                    <Coins size={18} className="text-gray-400 group-focus-within:text-blue-500 transition-colors" />
                                </div>
                                <input
                                    type="number"
                                    required
                                    min="0"
                                    value={cash}
                                    onChange={(e) => setCash(e.target.value)}
                                    className="pl-10 block w-full rounded-xl border-gray-200 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 border p-3 transition-all text-gray-800 font-medium"
                                    placeholder="e.g. 5000"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-gray-700 mb-1.5">Reload Machine Opening Balance (Rs.)</label>
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                                    <CreditCard size={18} className="text-gray-400 group-focus-within:text-indigo-500 transition-colors" />
                                </div>
                                <input
                                    type="number"
                                    required
                                    min="0"
                                    value={reload}
                                    onChange={(e) => setReload(e.target.value)}
                                    className="pl-10 block w-full rounded-xl border-gray-200 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 border p-3 transition-all text-gray-800 font-medium"
                                    placeholder="e.g. 2000"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="pt-4 flex flex-col space-y-4 border-t border-gray-100">
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl p-3.5 font-bold shadow-lg shadow-blue-500/30 transition-all flex items-center justify-center disabled:opacity-75 disabled:cursor-wait hover:-translate-y-0.5 active:translate-y-0"
                        >
                            {loading ? 'Opening Session...' : 'Open Session & Continue'}
                        </button>

                        {onClose && (
                            <button
                                type="button"
                                onClick={onClose}
                                className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl p-3.5 font-bold transition-all"
                            >
                                Cancel
                            </button>
                        )}

                        {!onClose && (
                            <button
                                type="button"
                                onClick={logout}
                                className="text-gray-500 hover:text-gray-800 text-sm font-medium transition-colors w-max mx-auto border-b border-transparent hover:border-gray-800"
                            >
                                Log into a different account
                            </button>
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
}
