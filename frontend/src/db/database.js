import Dexie from 'dexie';

// Loyal Mobile POS - Local IndexedDB database
// Stores offline-first sales, repair jobs, and a read-only inventory cache.
// All records carry a `syncStatus`: 'pending' (not yet synced) or 'synced'.
// Pending records are pushed to the Vercel backend when the network returns.

export const db = new Dexie('LoyalMobilePOS');

db.version(1).stores({
  // Offline-first writes
  pendingSales: '++id, receiptNo, syncStatus, created_at',
  pendingRepairJobs: '++id, syncStatus, created_at',
  pendingRepairStatusUpdates: '++id, repairJobId, targetStatus, syncStatus, created_at',

  // Read-only cache of current inventory (refreshed whenever online)
  inventoryPhones: 'id, imei, status',
  inventoryAccessories: 'id, sku',

  // App metadata (e.g. last inventory sync timestamp, session snapshot)
  meta: 'key'
});

// v2 - Stock Management: categories, movement ledger, stock takes and a
// generic queue for offline stock writes (adjustments, takes, imports...).
db.version(2).stores({
  stockCategories: 'id, name, syncStatus',
  stockMovements: 'id, localKey, accessoryId, sku, type, userId, createdAt, syncStatus',
  stockTakes: 'id, status, syncStatus',
  // Queue of offline stock writes: { entityType, opType, payload, ... }
  pendingStockOps: '++id, entityType, opType, syncStatus, createdAt'
});

// v3 - Import upload history so users can always see exactly which files came
// into the system (plus their sync status) even before the server confirms.
db.version(3).stores({
  stockImports: 'id, localKey, syncStatus, createdAt'
});

// Ensure a local receipt number unique to this browser/device.
export const generateLocalReceiptNo = () => {
  const now = new Date();
  const ts = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `OFFLINE-${ts}-${rand}`;
};

// ---- Inventory cache helpers ----

export const cacheInventory = async ({ phones = [], accessories = [] }) => {
  await db.transaction('rw', db.inventoryPhones, db.inventoryAccessories, db.meta, async () => {
    await db.inventoryPhones.clear();
    await db.inventoryPhones.bulkPut(phones);
    await db.inventoryAccessories.clear();
    await db.inventoryAccessories.bulkPut(accessories);
    await db.meta.put({ key: 'inventoryLastSyncedAt', value: new Date().toISOString() });
  });
};

export const getCachedInventory = async () => {
  const [phones, accessories, metaRow] = await Promise.all([
    db.inventoryPhones.toArray(),
    db.inventoryAccessories.toArray(),
    db.meta.get('inventoryLastSyncedAt')
  ]);
  return {
    phones,
    accessories,
    lastSyncedAt: metaRow?.value || null
  };
};

// ---- Pending sales helpers ----

export const addPendingSale = async (sale) => {
  const record = {
    ...sale,
    syncStatus: 'pending',
    createdAt: new Date().toISOString()
  };
  // Use the synthetic local id as Dexie's key
  delete record.id;
  return db.pendingSales.add(record);
};

export const getPendingSales = async () => {
  return db.pendingSales.where('syncStatus').equals('pending').sortBy('createdAt');
};

export const markSaleSynced = async (localKey, serverId) => {
  return db.pendingSales.update(localKey, {
    syncStatus: 'synced',
    serverId: serverId || null,
    syncedAt: new Date().toISOString()
  });
};

export const markSaleFailed = async (localKey, reason) => {
  return db.pendingSales.update(localKey, {
    syncStatus: 'failed',
    syncError: reason || null,
    failedAt: new Date().toISOString()
  });
};

export const removeSale = async (localKey) => {
  return db.pendingSales.delete(localKey);
};

// ---- Pending repair jobs helpers ----

export const addPendingRepairJob = async (job) => {
  const record = {
    ...job,
    syncStatus: 'pending',
    createdAt: new Date().toISOString()
  };
  delete record.id;
  return db.pendingRepairJobs.add(record);
};

export const getPendingRepairJobs = async () => {
  return db.pendingRepairJobs.where('syncStatus').equals('pending').sortBy('createdAt');
};

export const markRepairJobSynced = async (localKey, serverId) => {
  return db.pendingRepairJobs.update(localKey, {
    syncStatus: 'synced',
    serverId: serverId || null,
    syncedAt: new Date().toISOString()
  });
};

export const markRepairJobFailed = async (localKey, reason) => {
  return db.pendingRepairJobs.update(localKey, {
    syncStatus: 'failed',
    syncError: reason || null,
    failedAt: new Date().toISOString()
  });
};

export const removeRepairJob = async (localKey) => {
  return db.pendingRepairJobs.delete(localKey);
};

// ---- Pending repair status updates ----

export const addPendingRepairStatusUpdate = async (payload) => {
  const record = {
    ...payload,
    syncStatus: 'pending',
    createdAt: new Date().toISOString()
  };
  return db.pendingRepairStatusUpdates.add(record);
};

export const getPendingRepairStatusUpdates = async () => {
  return db.pendingRepairStatusUpdates.where('syncStatus').equals('pending').sortBy('createdAt');
};

export const markRepairStatusUpdateSynced = async (localKey) => {
  return db.pendingRepairStatusUpdates.update(localKey, {
    syncStatus: 'synced',
    syncedAt: new Date().toISOString()
  });
};

export const markRepairStatusUpdateFailed = async (localKey, reason) => {
  return db.pendingRepairStatusUpdates.update(localKey, {
    syncStatus: 'failed',
    syncError: reason || null,
    failedAt: new Date().toISOString()
  });
};

export const removeRepairStatusUpdate = async (localKey) => {
  return db.pendingRepairStatusUpdates.delete(localKey);
};

// ---- Sync status counting ----

export const getPendingCounts = async () => {
  const [sales, repairs, repairUpdates, stockOps, stockFailed] = await Promise.all([
    db.pendingSales.where('syncStatus').equals('pending').count(),
    db.pendingRepairJobs.where('syncStatus').equals('pending').count(),
    db.pendingRepairStatusUpdates.where('syncStatus').equals('pending').count(),
    db.pendingStockOps.where('syncStatus').equals('pending').count(),
    // Failed stock ops must NEVER be silent - the badge stays red until
    // they're rescued/uploaded, so data can't sit local-only unnoticed.
    db.pendingStockOps.where('syncStatus').equals('failed').count()
  ]);
  return {
    sales,
    repairs,
    repairUpdates,
    stockOps,
    stockFailed,
    total: sales + repairs + repairUpdates + stockOps + stockFailed
  };
};

// ---- Offline record retrieval for receipt reprocessing ----

export const getSaleByLocalKey = async (localKey) => {
  return db.pendingSales.get(localKey);
};

export const getRecentOfflineSales = async (limit = 50) => {
  // The pendingSales store indexes created_at (snake_case), but rows carry a
  // createdAt camelCase field. Dexie's orderBy() needs an index and throws on
  // a non-indexed key, so sort in memory instead. (Same pattern as movements.)
  const all = await db.pendingSales.toArray();
  const ts = (r) => new Date(r.created_at || r.createdAt || 0).getTime() || 0;
  return all.sort((a, b) => ts(b) - ts(a)).slice(0, limit);
};

export const getAllLocalSales = async () => {
  return db.pendingSales.toArray();
};

// =============================================
// Stock Management (v2 tables)
// =============================================

// Unique local key used to correlate offline-created records with the server
// copies created when the op finally syncs. Always carries the 'loc-'
// prefix - isLocalId()/isInternalItemId() rely on it to tell unsynced
// records apart from real server ObjectIds.
export const newLocalKey = () => {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return `loc-${crypto.randomUUID()}`;
  } catch (_err) { /* older browsers */ }
  return `loc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// ---- Cached stock categories ----

export const cacheStockCategories = async (categories) => {
  await db.transaction('rw', db.stockCategories, async () => {
    await db.stockCategories.clear();
    await db.stockCategories.bulkPut(categories);
  });
};

export const getCachedStockCategories = async () => {
  return db.stockCategories.orderBy('name').toArray();
};

export const upsertCachedCategory = async (category) => {
  return db.stockCategories.put(category);
};

export const removeCachedCategory = async (id) => {
  return db.stockCategories.delete(id);
};

// ---- Cached accessory items (extends the read-only inventory cache) ----

export const upsertCachedAccessory = async (item) => {
  return db.inventoryAccessories.put(item);
};

export const removeCachedAccessory = async (id) => {
  return db.inventoryAccessories.delete(id);
};

// After an offline-created item syncs, swap its local id for the server id.
export const remapLocalItemId = async (oldId, newId) => {
  if (!oldId || !newId || oldId === newId) return;
  await db.transaction('rw', db.inventoryAccessories, db.stockMovements, async () => {
    const item = await db.inventoryAccessories.get(oldId);
    if (item) {
      await db.inventoryAccessories.delete(oldId);
      await db.inventoryAccessories.put({ ...item, id: newId });
    }
    const movements = await db.stockMovements.where('accessoryId').equals(oldId).toArray();
    for (const m of movements) {
      await db.stockMovements.update(m.id, { accessoryId: newId });
    }
  });
};

// ---- Stock movement ledger cache ----

export const putCachedMovements = async (movements) => {
  if (!movements?.length) return;
  return db.stockMovements.bulkPut(movements);
};

export const getCachedMovements = async () => {
  // Records carry created_at (server shape); createdAt index stays unused,
  // so sort in memory instead of orderBy (which needs populated keys).
  const all = await db.stockMovements.toArray();
  const ts = (m) => new Date(m.created_at || m.createdAt || 0).getTime() || 0;
  return all.sort((a, b) => ts(b) - ts(a)).slice(0, 2000);
};

export const markMovementSyncedByLocalKey = async (localKey) => {
  const rows = await db.stockMovements.where('localKey').equals(localKey).toArray();
  for (const row of rows) {
    await db.stockMovements.update(row.id, { syncStatus: 'synced' });
  }
};

// ---- Stock takes cache ----

export const putCachedTake = async (take) => {
  return db.stockTakes.put(take);
};

export const getCachedTakes = async () => {
  // started_at is not an indexed keypath, so sort in memory (orderBy would throw).
  const all = await db.stockTakes.toArray();
  const ts = (t) => new Date(t.started_at || t.startedAt || 0).getTime() || 0;
  return all.sort((a, b) => ts(b) - ts(a)).slice(0, 100);
};

export const getCachedTake = async (id) => {
  return db.stockTakes.get(id);
};

// Find a cached take by its client-generated correlation key (used while the
// take's start op is still queued or mid-flush).
export const findCachedTakeByLocalKey = async (localKey) => {
  const all = await db.stockTakes.toArray();
  return all.find((t) => t.localKey === localKey) || null;
};

export const removeCachedTake = async (id) => {
  return db.stockTakes.delete(id);
};

// ---- Pending stock ops queue (offline-first writes) ----

// entityType+opType combos handled by syncService.flushPendingStockOps:
//   category: create | update | delete
//   item:     create | update | delete
//   adjustment: apply          -> POST /api/stock/adjust
//   take:     start | save | apply
//   import:   run              -> POST /api/stock/import
export const enqueueStockOp = async ({ entityType, opType, payload }) => {
  return db.pendingStockOps.add({
    entityType,
    opType,
    payload,
    syncStatus: 'pending',
    attempts: 0,
    createdAt: new Date().toISOString()
  });
};

export const getPendingStockOps = async () => {
  return db.pendingStockOps.where('syncStatus').equals('pending').sortBy('createdAt');
};

export const markStockOpSynced = async (opId) => {
  return db.pendingStockOps.delete(opId);
};

export const markStockOpFailed = async (opId, reason) => {
  return db.pendingStockOps.update(opId, {
    syncStatus: 'failed',
    syncError: reason || null,
    failedAt: new Date().toISOString()
  });
};

export const incrementStockOpAttempt = async (opId) => {
  const op = await db.pendingStockOps.get(opId);
  if (op) return db.pendingStockOps.update(opId, { attempts: (op.attempts || 0) + 1 });
};

// ---- Stock import upload history (local cache of server records) ----

export const putCachedImport = async (record) => {
  return db.stockImports.put(record);
};

export const getCachedImports = async () => {
  const all = await db.stockImports.toArray();
  const ts = (r) => new Date(r.created_at || r.createdAt || 0).getTime() || 0;
  return all.sort((a, b) => ts(b) - ts(a)).slice(0, 50);
};

export const findCachedImportByLocalKey = async (localKey) => {
  const rows = await db.stockImports.where('localKey').equals(localKey).toArray();
  return rows[0] || null;
};

export const removeCachedImport = async (id) => {
  return db.stockImports.delete(id);
};

export const removeCachedImportByLocalKey = async (localKey) => {
  return db.stockImports.where('localKey').equals(localKey).delete();
};