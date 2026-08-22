import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  attemptSync,
  subscribeToSyncStatus,
  registerBackgroundSync
} from '../services/syncService';
import { getPendingCounts } from '../db/database';

const SyncContext = createContext(null);

export const SyncProvider = ({ children }) => {
  const [status, setStatus] = useState({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    isSyncing: false,
    pendingCounts: { sales: 0, repairs: 0, repairUpdates: 0, total: 0 },
    lastSyncAt: null,
    lastError: null
  });
  const [checked, setChecked] = useState(false);
  const initializedRef = useRef(false);

  // Initialize sync engine once
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    // Start the sync engine (immediate attempt + 30s interval + online event)
    import('../services/syncService').then(({ initializeSync }) => {
      initializeSync();
    });

    // Register background sync with the service worker once it's active
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(() => {
        registerBackgroundSync();
      }).catch(() => {});
    }

    const refreshCounts = async () => {
      try {
        const counts = await getPendingCounts();
        setStatus((prev) => ({
          ...prev,
          pendingCounts: counts,
          isOnline: navigator.onLine,
          checked: true
        }));
      } catch (err) {
        console.error('[SyncContext] Failed to refresh counts:', err);
        setStatus((prev) => ({ ...prev, checked: true }));
      }
    };

    refreshCounts();

    const unsubscribe = subscribeToSyncStatus((state) => {
      setStatus((prev) => ({
        ...prev,
        isSyncing: state.status === 'syncing',
        lastSyncAt: state.lastSyncAt || prev.lastSyncAt,
        lastError: state.lastError || prev.lastError
      }));
      // Refresh counts when sync finishes
      if (state.status === 'idle') {
        refreshCounts();
      }
    });

    const handleOnline = () => {
      setStatus((prev) => ({ ...prev, isOnline: true }));
      refreshCounts();
    };
    const handleOffline = () => {
      setStatus((prev) => ({ ...prev, isOnline: false }));
      refreshCounts();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unsubscribe();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const syncNow = useCallback(async () => {
    setStatus((prev) => ({ ...prev, isSyncing: true }));
    try {
      const result = await attemptSync();
      const counts = await getPendingCounts();
      setStatus({
        isOnline: navigator.onLine,
        isSyncing: false,
        pendingCounts: counts,
        lastSyncAt: new Date().toISOString(),
        lastError: result?.lastError || null
      });
      return result;
    } catch (err) {
      setStatus((prev) => ({
        ...prev,
        isSyncing: false,
        lastError: err.message || 'Sync failed'
      }));
      return null;
    }
  }, []);

  return (
    <SyncContext.Provider value={{ status, checked, syncNow }}>
      {children}
    </SyncContext.Provider>
  );
};

export const useSync = () => {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
};