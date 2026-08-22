import {
  getPendingSales,
  getPendingRepairJobs,
  getPendingRepairStatusUpdates,
  markSaleSynced,
  markRepairJobSynced,
  markRepairStatusUpdateSynced,
  markSaleFailed,
  markRepairJobFailed,
  markRepairStatusUpdateFailed,
  removeSale,
  removeRepairJob,
  removeRepairStatusUpdate,
  getPendingCounts,
  cacheInventory
} from '../db/database';

const SYNC_INTERVAL_MS = 30000; // 30 seconds

let syncInProgress = false;
let listeners = new Set();

// Attach a "permanent" flag to sync errors. Permanent failures (4xx client
// errors such as "item already sold" or "not enough stock") can never succeed
// no matter how many times we retry, so they must not block the sync queue.
const toSyncError = (res, data, fallbackMessage) => {
  const err = new Error(data?.error || fallbackMessage);
  err.status = res.status;
  err.permanent = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429;
  return err;
};

export const subscribeToSyncStatus = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const notifyListeners = (state) => {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (err) {
      console.error('[SyncService] listener error:', err);
    }
  });
};

export const getSyncState = async () => {
  const counts = await getPendingCounts();
  return {
    isOnline: navigator.onLine,
    isSyncing: syncInProgress,
    pendingCounts: counts,
    lastAttemptAt: null,
    lastError: null
  };
};

const checkoutSale = async (sale, token) => {
  // The local record stores items in the server's normalized format
  // (inventory_type / inventory_id), but the checkout endpoint expects
  // the cart format (inventoryType / inventoryId). Map them back.
  const payload = {
    items: (sale.items || []).map((item) => ({
      inventoryType: item.inventory_type,
      inventoryId: item.inventory_id,
      quantity: item.quantity
    })),
    paymentMethod: sale.payment_method,
    cashReceived: sale.cash_received || 0,
    paymentDetails: sale.payment_details || null,
    discountAmount: sale.discount_amount || 0,
    approvalNote: sale.approval_note || null,
    sessionId: sale.session_id || null
  };

  const res = await fetch('/api/sales/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toSyncError(res, data, 'Checkout failed during sync');
  }

  return res.json();
};

// Backup path: records the offline sale exactly as it was created on this
// device (preserving the original sale time) WITHOUT inventory side-effects.
// Used when checkout permanently rejects the sale, e.g. the phone was already
// sold or stock changed on the server while the device was offline.
const importSale = async (sale, token) => {
  const res = await fetch('/api/sales/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      receipt_no: sale.receipt_no,
      cashier_id: sale.cashier_id,
      cashier_name: sale.cashier_name,
      cashier_role: sale.cashier_role,
      items: sale.items || [],
      subtotal: sale.subtotal,
      discount_amount: sale.discount_amount,
      discount_percent: sale.discount_percent,
      total: sale.total,
      payment_method: sale.payment_method,
      payment_details: sale.payment_details || null,
      cash_received: sale.cash_received || 0,
      change_amount: sale.change_amount || 0,
      approval_required: sale.approval_required || false,
      approval_status: sale.approval_status || 'NOT_REQUIRED',
      approval_note: sale.approval_note || null,
      session_id: sale.session_id || null,
      created_at: sale.created_at
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toSyncError(res, data, 'Unable to import offline sale');
  }

  return res.json();
};

const pushSale = async (sale, token) => {
  try {
    // Preferred path: normal checkout (applies inventory updates server-side)
    return await checkoutSale(sale, token);
  } catch (err) {
    if (!err.permanent) throw err;
    // The server rejected the sale permanently (e.g. "already sold" / "not
    // enough stock" because stock changed while offline). Fall back to
    // importing the sale as a historical record so the offline sale is still
    // backed up in the database instead of being stuck forever.
    console.warn('[SyncService] Checkout rejected, importing sale as historical record:', err.message);
    return await importSale(sale, token);
  }
};

const pushRepairJob = async (job, token) => {
  const res = await fetch('/api/repair-jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      customer_name: job.customerName,
      phone_number: job.phoneNumber,
      device_model: job.deviceModel,
      imei: job.imei || '',
      reported_issue: job.reportedIssue,
      items_left: job.itemsLeft || '',
      received_date: job.receivedDate,
      estimated_cost: Number(job.estimatedCost || 0),
      estimated_completion_date: job.estimatedCompletionDate,
      warranty_period_months: Number(job.warrantyPeriodMonths || 3)
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toSyncError(res, data, 'Unable to create repair job during sync');
  }

  return res.json();
};

const pushRepairStatusUpdate = async (update, token) => {
  const res = await fetch(`/api/repair-jobs/${update.repairJobId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ status: update.targetStatus })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw toSyncError(res, data, 'Status update failed during sync');
  }

  return res.json();
};

export const attemptSync = async () => {
  if (syncInProgress) return { skipped: true };
  if (!navigator.onLine) return { skipped: true, reason: 'offline' };

  const token = localStorage.getItem('token');
  if (!token) return { skipped: true, reason: 'no-auth' };

  syncInProgress = true;
  notifyListeners({ status: 'syncing', pendingCounts: await getPendingCounts() });

  let syncedSales = 0;
  let syncedRepairs = 0;
  let syncedStatusUpdates = 0;
  let lastError = null;

  try {
    // Push pending repair jobs (first, as status updates may depend on them)
    const pendingRepairs = await getPendingRepairJobs();
    for (const job of pendingRepairs) {
      if (!navigator.onLine) break;
      try {
        const result = await pushRepairJob(job, token);
        if (result?.id) {
          const serverId = result.id;
          await markRepairJobSynced(job.id, serverId);
          syncedRepairs++;
        } else {
          await removeRepairJob(job.id);
          syncedRepairs++;
        }
      } catch (err) {
        lastError = err.message;
        console.warn('[SyncService] Failed to sync repair job:', err);
        if (err.permanent) {
          // This job can never be accepted by the server (e.g. validation error).
          // Mark it failed so it doesn't block the rest of the queue forever.
          await markRepairJobFailed(job.id, err.message);
          continue;
        }
        break; // transient failure - retry later
      }
    }

    // Push pending sales in order
    const pendingSales = await getPendingSales();
    for (const sale of pendingSales) {
      if (!navigator.onLine) break;
      try {
        const result = await pushSale(sale, token);
        const serverId = result?.sale?.id || result?.receipt?.id || null;
        if (serverId) {
          await markSaleSynced(sale.id, serverId);
        } else {
          // Server accepted but gave no id — remove local pending marker
          await removeSale(sale.id);
        }
        syncedSales++;
      } catch (err) {
        lastError = err.message;
        console.warn('[SyncService] Failed to sync sale:', err);
        if (err.permanent) {
          // Even the import backup failed permanently — mark it failed so it
          // doesn't block every newer sale behind it.
          await markSaleFailed(sale.id, err.message);
          continue;
        }
        break; // transient failure - retry later
      }
    }

    // Push pending repair status updates
    const pendingStatusUpdates = await getPendingRepairStatusUpdates();
    for (const update of pendingStatusUpdates) {
      if (!navigator.onLine) break;
      try {
        await pushRepairStatusUpdate(update, token);
        await markRepairStatusUpdateSynced(update.id);
        syncedStatusUpdates++;
      } catch (err) {
        lastError = err.message;
        console.warn('[SyncService] Failed to sync status update:', err);
        if (err.permanent) {
          await markRepairStatusUpdateFailed(update.id, err.message);
          continue;
        }
        break; // transient failure - retry later
      }
    }

    // Refresh inventory cache after a successful sync
    const counts = await getPendingCounts();
    if (counts.total === 0 && navigator.onLine) {
      try {
        await refreshInventoryCache();
      } catch (err) {
        console.warn('[SyncService] Inventory refresh failed, using cached copy:', err);
      }
    }

    return {
      status: 'idle',
      syncedSales,
      syncedRepairs,
      syncedStatusUpdates,
      lastError
    };
  } catch (err) {
    console.error('[SyncService] Sync failed:', err);
    lastError = err.message;
    return { status: 'idle', lastError };
  } finally {
    syncInProgress = false;
    notifyListeners({ status: 'idle', pendingCounts: await getPendingCounts(), lastSyncAt: new Date().toISOString(), lastError });
  }
};

// Refresh the read-only inventory cache from the server (best effort)
export const refreshInventoryCache = async () => {
  if (!navigator.onLine) return;
  const token = localStorage.getItem('token');
  if (!token) return;

  try {
    const [phonesRes, accessoriesRes] = await Promise.all([
      fetch('/api/inventory/phones', { headers: { Authorization: `Bearer ${token}` } }),
      fetch('/api/inventory/accessories', { headers: { Authorization: `Bearer ${token}` } })
    ]);

    if (phonesRes.ok && accessoriesRes.ok) {
      const [phones, accessories] = await Promise.all([phonesRes.json(), accessoriesRes.json()]);
      await cacheInventory({ phones, accessories });
      return { cachedAt: new Date().toISOString() };
    }
  } catch (err) {
    console.warn('[SyncService] Failed to refresh inventory cache:', err);
  }
  return null;
};

// Register a background sync if the API is available; also used by the SW on 'sync' events
export const registerBackgroundSync = async () => {
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'REGISTER_SYNC' });
    }
  } catch (err) {
    console.warn('[SyncService] Background sync registration failed:', err);
  }
};

let intervalId = null;

export const startSyncEngine = () => {
  if (intervalId) return;

  // Immediate attempt on startup (if online)
  attemptSync();

  // Periodic fallback: check every 30s
  intervalId = setInterval(() => {
    if (navigator.onLine) {
      attemptSync();
    }
  }, SYNC_INTERVAL_MS);

  // Online event fallback
  window.addEventListener('online', () => {
    registerBackgroundSync();
    attemptSync();
  });

  // Listen for service worker "sync" messages
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'POS_SYNC_TRIGGERED') {
        attemptSync();
      }
    });
  }

  return () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
};

// Expose a React-friendly hook state getter
export const initializeSync = () => {
  startSyncEngine();
};