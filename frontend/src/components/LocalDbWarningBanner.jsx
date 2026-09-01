// Dashboard banner shown when the system is running ONLINE-ONLY — MongoDB
// (cloud) is connected but no local SQLite database is available on this host
// (e.g. Vercel's read-only filesystem, or a Node runtime without node:sqlite).
// Users can remove the message; the choice is remembered per browser.
import React, { useState, useEffect } from 'react';
import { AlertTriangle, X, RefreshCw, Database } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const DISMISS_KEY = 'pos_local_db_warning_dismissed';
const CHECK_INTERVAL_MS = 60 * 1000; // re-check every minute

export default function LocalDbWarningBanner() {
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (err) {
      return false;
    }
  });
  const [creating, setCreating] = useState(false);
  const [initError, setInitError] = useState(null);

  const fetchStatus = async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      const res = await fetch('/api/system/db-status', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setStatus(await res.json());
    } catch (err) {
      console.error('Failed to check local SQLite database status', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const handleRemoveMessage = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (err) { /* ignore */ }
    setDismissed(true);
  };

  const isAdmin = user && (user.role === 'admin' || user.role === 'shop_owner');

  const handleInit = async () => {
    setCreating(true);
    setInitError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/system/local-db/init', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInitError((body && body.error) || 'Could not create the local SQLite database');
        return;
      }
      // Success — refresh status; the banner disappears automatically when the
      // local database becomes available.
      await fetchStatus();
    } catch (err) {
      setInitError(err.message || 'Could not create the local SQLite database');
    } finally {
      setCreating(false);
    }
  };

  // Show only to authenticated users, when online (MongoDB) is connected but
  // the local SQLite database is NOT available, and the user hasn't dismissed it.
  if (dismissed || !user) return null;
  if (!status || !status.onlineOnly || !status.mongo?.connected) return null;

  const local = status.local || {};
  const message = local.exists || local.initialized
    ? 'A local SQLite database file was found but could not be opened on this runtime.'
    : 'No local SQLite database found — all data is stored in the cloud (MongoDB) only.';

  return (
    <div
      className="bg-rose-600 text-white rounded-2xl px-6 py-4 shadow-lg shadow-rose-500/30 flex flex-wrap items-center gap-x-4 gap-y-3"
      role="alert"
      data-testid="local-db-warning-banner"
    >
      <AlertTriangle size={24} className="shrink-0" />
      <div className="flex-1 min-w-[260px]">
        <p className="font-bold">⚠️ System is running online-only — local SQLite database not in use.</p>
        <p className="text-sm text-rose-100 mt-0.5">
          {message}
          {local.error ? <span className="block text-xs text-rose-200/90 mt-1">Reason: {local.error}</span> : null}
          {initError ? <span className="block text-xs text-rose-200/90 mt-1">Could not initialize: {initError}</span> : null}
        </p>
      </div>
      {isAdmin && (
        <button
          onClick={handleInit}
          disabled={creating}
          title="Create/open the local SQLite database on this server"
          className="flex items-center space-x-2 bg-white/15 hover:bg-white/25 border border-white/30 px-4 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap disabled:opacity-50"
        >
          <Database size={16} />
          <span>{creating ? 'Creating...' : 'Create local DB'}</span>
        </button>
      )}
      <button
        onClick={fetchStatus}
        title="Re-check local database status"
        className="flex items-center space-x-2 bg-white/15 hover:bg-white/25 border border-white/30 px-4 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap"
      >
        <RefreshCw size={16} />
        <span>Re-check</span>
      </button>
      <button
        onClick={handleRemoveMessage}
        title="Remove this message"
        className="flex items-center space-x-2 bg-white/15 hover:bg-white/25 border border-white/30 px-4 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap"
      >
        <X size={16} />
        <span>Remove message</span>
      </button>
    </div>
  );
}