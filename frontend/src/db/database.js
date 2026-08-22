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
  const [sales, repairs, repairUpdates] = await Promise.all([
    db.pendingSales.where('syncStatus').equals('pending').count(),
    db.pendingRepairJobs.where('syncStatus').equals('pending').count(),
    db.pendingRepairStatusUpdates.where('syncStatus').equals('pending').count()
  ]);
  return { sales, repairs, repairUpdates, total: sales + repairs + repairUpdates };
};

// ---- Offline record retrieval for receipt reprocessing ----

export const getSaleByLocalKey = async (localKey) => {
  return db.pendingSales.get(localKey);
};

export const getRecentOfflineSales = async (limit = 50) => {
  const all = await db.pendingSales.orderBy('createdAt').reverse().limit(limit).toArray();
  return all;
};

export const getAllLocalSales = async () => {
  return db.pendingSales.orderBy('createdAt').toArray();
};