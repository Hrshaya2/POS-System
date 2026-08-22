import React from 'react';
import { useSync } from '../context/SyncContext';
import { CloudOff, RefreshCw, CheckCircle2, AlertCircle, UploadCloud } from 'lucide-react';

export default function SyncStatusIndicator({ compact = false }) {
  const { status, syncNow } = useSync();
  const { isOnline, isSyncing, pendingCounts, lastError } = status;
  const totalPending = pendingCounts?.total || 0;
  const salesPending = pendingCounts?.sales || 0;
  const repairsPending = pendingCounts?.repairs || 0;
  const repairUpdatesPending = pendingCounts?.repairUpdates || 0;

  if (isSyncing) {
    return (
      <div className={`flex items-center space-x-2 bg-blue-50 border border-blue-200 text-blue-700 rounded-xl px-3 py-1.5 text-sm font-bold ${compact ? '' : 'shadow-sm'}`}>
        <RefreshCw size={16} className="animate-spin" />
        <span>Syncing...</span>
      </div>
    );
  }

  if (!isOnline) {
    return (
      <div className={`flex items-center space-x-2 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-3 py-1.5 text-sm font-bold ${compact ? '' : 'shadow-sm'}`}>
        <CloudOff size={16} />
        <span>Offline mode</span>
        {totalPending > 0 && <span className="text-xs font-semibold bg-rose-100 rounded-full px-2 py-0.5">{totalPending} pending</span>}
      </div>
    );
  }

  if (totalPending > 0) {
    let pendingText = `${totalPending} items pending sync`;
    if (salesPending > 0 && repairsPending === 0 && repairUpdatesPending === 0) {
      pendingText = `${salesPending} sales pending sync`;
    } else if (salesPending === 0 && (repairsPending > 0 || repairUpdatesPending > 0)) {
      pendingText = `${repairsPending + repairUpdatesPending} repairs pending sync`;
    }

    return (
      <button
        onClick={syncNow}
        title="Click to sync now"
        className={`flex items-center space-x-2 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-xl px-3 py-1.5 text-sm font-bold transition-colors ${compact ? '' : 'shadow-sm'}`}
      >
        <UploadCloud size={16} />
        <span>{pendingText}</span>
        <RefreshCw size={14} className="ml-1" />
      </button>
    );
  }

  return (
    <div className={`flex items-center space-x-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-3 py-1.5 text-sm font-bold ${compact ? '' : 'shadow-sm'}`}>
      <CheckCircle2 size={16} />
      <span>All synced</span>
      {lastError && <AlertCircle size={14} className="text-amber-500" />}
    </div>
  );
}