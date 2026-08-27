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
  db,
  // Stock management queue
  getPendingStockOps,
  markStockOpSynced,
  markStockOpFailed,
  incrementStockOpAttempt,
  remapLocalItemId,
  putCachedMovements,
  upsertCachedCategory,
  putCachedTake,
  getCachedTake,
  findCachedTakeByLocalKey,
  putCachedImport,
  findCachedImportByLocalKey,
  removeCachedImportByLocalKey
} from '../db/database';
import { applyServerInventorySnapshot } from './stockService';

const SYNC_INTERVAL_MS = 30000; // 30 seconds

// Throttles stranded-op revival so "Retry" clicks re-arm attempts without
// letting genuinely bad ops spin on every 30s cycle forever.
let lastStrandedRevivalAt = 0;

let syncInProgress = false;
let listeners = new Set();

// Attach a "permanent" flag to sync errors. Permanent failures (4xx client
// errors such as "item already sold" or "not enough stock") can never succeed
// no matter how many times we retry, so they must not block the sync queue.
const toSyncError = (res, data, fallbackMessage) => {
  let message = data?.error || fallbackMessage;
  // Payload-size rejections arrive as HTML/empty bodies from Express's body
  // parser - translate them into something actionable, not a generic error.
  if (res.status === 413) message = 'Import payload too large - please split the file into smaller batches.';
  const err = new Error(message);
  err.status = res.status;
  // 413 depends on the server's configured body limit, not on bad data -
  // classify it as retriable instead of permanently failed.
  err.permanent = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429 && res.status !== 413;
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
    sessionId: sale.session_id || null,
    // Idempotency token so a background-sync retry can never double-record a
    // sale that the immediate post-checkout push already created on the server.
    clientLocalId: sale.clientLocalId || (sale.id !== undefined ? `sale-${String(sale.id)}-${String(sale.cashier_id || '')}` : undefined)
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

// =============================================
// Stock Management offline write queue
// =============================================

const stockApi = async (path, { method = 'GET', body } = {}, token) => {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw toSyncError(res, data, data?.error || 'Stock request failed during sync');
  return data;
};

const isLocalId = (id) => String(id || '').startsWith('loc-') || String(id || '').startsWith('local:');

// Server-confirmed movements replace their optimistic offline twins
// (matched via the client-generated local_key correlation id).
const reconcileMovements = async (movements) => {
  if (!Array.isArray(movements)) return;
  const confirmed = movements.filter((m) => m?.local_key);
  for (const m of confirmed) {
    await db.stockMovements.where('localKey').equals(m.local_key).delete();
  }
  await putCachedMovements(movements.map((m) => ({ ...m, syncStatus: 'synced' })));
};

// Ops queued before an offline-created item synced still carry its local id.
// Resolve the current (server) id via the immutable SKU at flush time.
const resolveAccessoryServerId = async (payload) => {
  let id = payload.accessoryId || payload.id;
  if (!isLocalId(id)) return id;
  if (payload.sku || payload.item?.sku) {
    const sku = payload.sku || payload.item.sku;
    const item = await db.inventoryAccessories.where('sku').equals(String(sku).trim()).first();
    if (item && !isLocalId(item.id)) return item.id;
  }
  return null;
};

const pushStockOp = async (op, token) => {
  const { entityType, opType, payload } = op;

  switch (`${entityType}:${opType}`) {
    case 'category:create': {
      const created = await stockApi('/api/stock/categories', { method: 'POST', body: payload }, token);
      if (created?.id && payload.localKey) {
        // Merge under the server id, preserving nothing else from the local row.
        await db.stockCategories.delete(payload.localKey);
        await upsertCachedCategory({ ...created, localKey: payload.localKey, syncStatus: 'synced' });
      }
      return created;
    }
    case 'category:update':
      return stockApi(`/api/stock/categories/${payload.id}`, { method: 'PUT', body: payload }, token);
    case 'category:delete':
      return stockApi(`/api/stock/categories/${payload.id}`, { method: 'DELETE' }, token);

    case 'item:create': {
      const created = await stockApi('/api/inventory/accessories', { method: 'POST', body: payload.item }, token);
      const serverId = created?.id || created?.accessory?.id;
      if (serverId && payload.localId) {
        await remapLocalItemId(payload.localId, serverId);
      }
      return created;
    }
    case 'item:update': {
      const serverId = await resolveAccessoryServerId(payload);
      if (!serverId) throw Object.assign(new Error('Item not synced yet'), { permanent: false });
      return stockApi(`/api/inventory/accessories/${serverId}`, { method: 'PUT', body: payload.item }, token);
    }
    case 'item:delete': {
      const serverId = await resolveAccessoryServerId(payload);
      if (!serverId) throw Object.assign(new Error('Item not synced yet'), { permanent: false });
      return stockApi(`/api/inventory/accessories/${serverId}`, { method: 'DELETE' }, token);
    }

    case 'movement:delete':
      return stockApi(`/api/stock/movements/${payload.movementId}`, { method: 'DELETE' }, token);

    case 'adjustment:apply': {
      const serverId = await resolveAccessoryServerId(payload);
      if (!serverId) throw Object.assign(new Error('Item not synced yet'), { permanent: false });
      const result = await stockApi('/api/stock/adjust', {
        method: 'POST',
        body: { ...payload, accessoryId: serverId }
      }, token);
      if (result?.movement) {
        await reconcileMovements([result.movement]);
      }
      return result;
    }

    case 'take:start': {
      const take = await stockApi('/api/stock/takes/start', { method: 'POST', body: payload }, token);
      if (take?.id && payload.localTakeId) {
        const local = await getCachedTake(payload.localTakeId);
        const merged = {
          ...take,
          counts: local?.counts || {},
          localKey: payload.localTakeId,
          syncStatus: 'synced'
        };
        await putCachedTake(merged);
        if (payload.localTakeId !== take.id) {
          await db.stockTakes.delete(payload.localTakeId);
        }
      }
      return take;
    }
    case 'take:save': {
      const take = await findCachedTakeByLocalKey(payload.localTakeId);
      const serverId = take?.serverId || (take && !isLocalId(take.id) ? take.id : null) || (!isLocalId(payload.localTakeId) ? payload.localTakeId : null);
      if (!serverId) throw Object.assign(new Error('Stock take not synced yet'), { permanent: false });
      return stockApi(`/api/stock/takes/${serverId}`, { method: 'PUT', body: { counts: payload.counts } }, token);
    }
    case 'take:apply': {
      const take = await findCachedTakeByLocalKey(payload.localTakeId);
      const serverId = take?.serverId || (take && !isLocalId(take.id) ? take.id : null) || (!isLocalId(payload.localTakeId) ? payload.localTakeId : null);
      if (!serverId) throw Object.assign(new Error('Stock take not synced yet'), { permanent: false });
      const result = await stockApi(`/api/stock/takes/${serverId}/apply`, { method: 'POST', body: { lines: payload.lines } }, token);
      await reconcileMovements(result?.movements || []);
      if (result?.take) {
        await db.stockTakes.delete(payload.localTakeId).catch(() => {});
        await putCachedTake({ ...result.take, counts: take?.counts || {}, localKey: payload.localTakeId, syncStatus: 'synced' });
      }
      return result;
    }

    case 'import:run': {
      const result = await stockApi('/api/stock/import', { method: 'POST', body: payload }, token);
      await reconcileMovements(result?.movements || []);
      // Persist the authoritative upload-history record so the file flips
      // from "Waiting to sync" to "Saved to database" immediately.
      const serverImport = result?.import;
      if (serverImport?.id) {
        if (payload.localKey) await removeCachedImportByLocalKey(payload.localKey);
        await putCachedImport({ ...serverImport, localKey: payload.localKey || null, syncStatus: 'synced' });
      } else if (payload.localKey) {
        // Older backend without history support - still confirm our record.
        const twin = await findCachedImportByLocalKey(payload.localKey);
        if (twin) await putCachedImport({ ...twin, syncStatus: 'synced' });
      }
      return result;
    }

    default:
      // Unknown combo - drop it rather than blocking the queue forever.
      console.warn('[SyncService] Unknown stock op:', entityType, opType);
      return { ignored: true };
  }
};

export const flushPendingStockOps = async (token) => {
  let syncedOps = 0;
  let lastError = null;

  // One-shot rescue: earlier builds misclassified oversized-import rejections
  // (HTTP 413 from the server's default body limit) as permanent failures,
  // stranding real data marked "failed". Give stranded first-attempt ops
  // exactly one more chance per session; bounded, so genuinely bad ops
  // still stop retrying after this.
  if (Date.now() - lastStrandedRevivalAt > 60000) {
    lastStrandedRevivalAt = Date.now();
    try {
      const stranded = await db.pendingStockOps.where('syncStatus').equals('failed').toArray();
      // Bounded revival: ops keep re-attempting up to 10 tries total so a
      // restarted backend picks them up automatically, but genuinely bad
      // payloads stop spinning after that.
      const rescueable = stranded.filter((op) => (op.attempts || 0) <= 10);
      for (const op of rescueable) {
        await db.pendingStockOps.update(op.id, { syncStatus: 'pending', syncError: null });
        if (op.entityType === 'import' && op.payload?.localKey) {
          const twin = await findCachedImportByLocalKey(op.payload.localKey).catch(() => null);
          if (twin) await putCachedImport({ ...twin, syncStatus: 'waiting', syncError: null });
        }
      }
      if (rescueable.length) console.info(`[SyncService] Revived ${rescueable.length} failed stock op(s) for retry.`);
    } catch (revErr) {
      console.warn('[SyncService] Stranded-op revival skipped:', revErr);
    }
  }

  const ops = await getPendingStockOps();
  for (const op of ops) {
    if (!navigator.onLine) break;
    try {
      await incrementStockOpAttempt(op.id);
      await pushStockOp(op, token);
      await markStockOpSynced(op.id);
      syncedOps++;
    } catch (err) {
      lastError = err.message;
      console.warn('[SyncService] Failed to sync stock op:', err);
      // A 404/501 here almost always means the backend process predates the
      // Stock Management feature ("route not found") - not bad data - and
      // 502/503 are transient gateway errors. Marking those permanent would
      // fail the op AND let the post-sync inventory refresh wipe its still-
      // unsaved items from the local cache. Keep them pending instead: they
      // apply automatically once the backend is restarted/up to date.
      const staleBackend = err.status === 404 || err.status === 501 || err.status === 502 || err.status === 503;
      if (err.status === 404 && !String(err.message || '').includes('out of date')) {
        err.message = `${err.message} — server out of date (restart/redeploy the backend)`;
      }
      if (err.permanent && !staleBackend) {
        await markStockOpFailed(op.id, err.message);
        // Surface permanent failures on the corresponding upload-history row.
        if (op.entityType === 'import' && op.payload?.localKey) {
          try {
            const twin = await findCachedImportByLocalKey(op.payload.localKey);
            if (twin) await putCachedImport({ ...twin, syncStatus: 'failed', syncError: err.message });
          } catch (_histErr) { /* never block the queue */ }
        }
        continue;
      }
      break; // transient failure - retry on the next cycle
    }
  }

  return { syncedOps, lastError };
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

    // Push pending stock management writes (adjustments, takes, imports...)
    try {
      await flushPendingStockOps(token);
    } catch (err) {
      lastError = err.message;
      console.warn('[SyncService] Stock ops flush failed:', err);
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
      // Unified reconcile path (stockService): preserves pending local
      // creates/imports instead of clobbering them after every sale.
      await applyServerInventorySnapshot({ phones, accessories });
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