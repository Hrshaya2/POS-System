import React from 'react';
import { useSync } from '../context/SyncContext';
import { CloudOff, Wifi } from 'lucide-react';

export default function OfflineBanner() {
  const { status } = useSync();

  if (status.isOnline) return null;

  return (
    <div className="sticky top-0 z-50 w-full bg-rose-600 text-white px-4 py-2 text-center text-sm font-semibold shadow-md flex items-center justify-center gap-2">
      <CloudOff size={16} />
      <span>You are offline. Sales and repairs will be saved locally and sync automatically when internet returns.</span>
      {status.pendingCounts?.total > 0 && (
        <span className="bg-white/20 rounded-full px-2.5 py-0.5 text-xs font-bold">
          {status.pendingCounts.total} pending
        </span>
      )}
    </div>
  );
}