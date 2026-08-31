// Dashboard-only banner: warns admins when MongoDB usage crosses the 500MB
// warning threshold of the 512MB Atlas free tier. Cashiers never see it and
// never trigger the check. Runs on mount and re-checks on an interval so a
// growing database is noticed without the admin visiting Manage Storage.
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Database } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const BYTES_PER_MB = 1024 * 1024;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check every 5 minutes

const isAdminRole = (role) => role === 'admin' || role === 'shop_owner';

export default function StorageWarningBanner() {
  const { user } = useAuth();
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    if (!user || !isAdminRole(user.role)) return undefined;

    let cancelled = false;
    const check = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch('/api/storage/usage', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok && !cancelled) {
          setUsage(await res.json());
        }
      } catch (err) {
        console.error('Failed to check MongoDB storage usage', err);
      }
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.id, user?.role]);

  // Hidden for cashiers, for guests, and whenever usage is under the threshold.
  if (!usage || !usage.warning || !isAdminRole(user?.role)) return null;

  const usedMB = Math.round(usage.usedBytes / BYTES_PER_MB);
  const limitMB = Math.round(usage.limitBytes / BYTES_PER_MB);
  // Red once past 90% of the hard limit, orange between the warning
  // threshold and that point.
  const critical = usage.usedBytes > usage.limitBytes * 0.9;

  return (
    <div
      className={`${critical ? 'bg-rose-600 shadow-rose-500/40' : 'bg-amber-500 shadow-amber-500/40'} text-white rounded-2xl px-6 py-4 shadow-lg flex flex-wrap items-center gap-x-4 gap-y-3`}
      role="alert"
      data-testid="storage-warning-banner"
    >
      <AlertTriangle size={24} className="shrink-0" />
      <p className="font-bold flex-1 min-w-[240px]">
        ⚠️ MongoDB storage is nearing its limit ({usedMB} MB / {limitMB} MB). Visit Manage Storage to review.
      </p>
      <Link
        to="/storage"
        className="flex items-center space-x-2 bg-white/15 hover:bg-white/25 border border-white/30 px-4 py-2 rounded-xl text-sm font-bold transition-colors whitespace-nowrap"
      >
        <Database size={16} />
        <span>Manage Storage</span>
      </Link>
    </div>
  );
}