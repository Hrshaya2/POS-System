// Stock Management service - local-first data access for the Stock page.
//
// Reads always come from the IndexedDB cache (instant, offline-capable).
// When online, refreshStockData() flushes any queued stock writes FIRST and
// only then pulls authoritative lists from the server, so freshly-synced
// offline creations are never clobbered by a stale fetch.
import {
  db,
  newLocalKey,
  cacheInventory,
  cacheStockCategories,
  getCachedStockCategories,
  upsertCachedCategory,
  removeCachedCategory,
  getCachedInventory,
  upsertCachedAccessory,
  putCachedMovements,
  getCachedMovements,
  getCachedTakes,
  putCachedTake,
  putCachedImport,
  getCachedImports,
  removeCachedImport,
  removeCachedImportByLocalKey,
  enqueueStockOp
} from '../db/database';

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` });

export const isInternalItemId = (id) => String(id || '').startsWith('loc-');

// Fire-and-forget immediate sync attempt after each local write.
export const attemptImmediateFlush = async () => {
  try {
    const { attemptSync } = await import('./syncService');
    await attemptSync();
  } catch (err) {
    console.warn('[stockService] Immediate flush failed:', err);
  }
};

// =============================================
// Reads
// =============================================

export const loadStockData = async () => {
  const [categories, accessories, takes, imports] = await Promise.all([
    getCachedStockCategories(),
    db.inventoryAccessories.toArray(),
    getCachedTakes(),
    getCachedImports()
  ]);
  return { categories, items: accessories, takes, imports };
};

// Re-apply queued-but-unsynced bulk imports onto freshly fetched server
// inventory. Without this overlay, an import still waiting in the sync queue
// (offline, transient failure, backend restart pending) would visually vanish
// the moment the authoritative server cache replaced the optimistic one.
const overlayPendingImports = async () => {
  try {
    const ops = await db.pendingStockOps
      .where('syncStatus').equals('pending')
      .and((op) => op.entityType === 'import')
      .toArray();
    if (!ops.length) return;

    const items = await db.inventoryAccessories.toArray();
    const bySku = new Map(items.map((i) => [String(i.sku || '').trim().toUpperCase(), i]));
    const dirty = new Map();

    for (const op of ops) {
      for (const row of op.payload?.rows || []) {
        const sku = String(row.sku || '').trim();
        if (!sku) continue;
        const qty = row.quantity === '' || row.quantity === undefined ? null : Number(row.quantity);
        const existing = bySku.get(sku.toUpperCase());

        if (existing) {
          if (qty === null || existing.is_service) continue;
          const prevQty = Number(existing.quantity || 0);
          existing.quantity = op.payload.overwrite ? qty : prevQty + qty;
          dirty.set(existing.id, existing);
        } else {
          const localRow = {
            id: row.localKey || newLocalKey(),
            sku,
            name: String(row.name || '').trim(),
            category: String(row.category || '').trim(),
            quantity: Math.max(0, qty || 0),
            cost_price: row.cost_price === '' || row.cost_price === undefined ? null : Number(row.cost_price),
            sell_price: Number(row.sell_price) || 0,
            low_stock_threshold: row.low_stock_threshold === '' || row.low_stock_threshold === undefined ? 5 : Number(row.low_stock_threshold),
            barcodes: [], unit: 'pcs', is_service: false, description: '',
            tax_rate: 0, markup_percent: 0, price_includes_tax: false, allow_price_override: true,
            notes: [], image_url: '', color_tag: '',
            added_at: new Date().toISOString(),
            syncStatus: 'pending'
          };
          bySku.set(sku.toUpperCase(), localRow);
          dirty.set(localRow.id, localRow);
        }
      }
    }

    if (dirty.size) {
      await Promise.all([...dirty.values()].map((item) => upsertCachedAccessory(item)));
    }
  } catch (err) {
    console.warn('[stockService] Pending-import overlay failed:', err);
  }
};

// Never hide rows the user created locally whose create-op hasn't reached
// the server yet (or whose op is currently queued/failed): without this
// overlay, the next successful refresh would make offline-added categories
// and items vanish from the UI until their sync completes.
const overlayLocalCreates = async () => {
  try {
    const [cats, accs] = await Promise.all([
      db.stockCategories.toArray(),
      db.inventoryAccessories.toArray()
    ]);
    const delOps = await db.pendingStockOps
      .where('syncStatus').equals('pending')
      .and((op) => (op.entityType === 'category' || op.entityType === 'item') && op.opType === 'delete')
      .toArray();
    // Split per entity so a category id can never be matched against an item.
    const doomedFor = (entityType) => new Set(
      delOps
        .filter((o) => o.entityType === entityType)
        .map((o) => String(o.payload?.localKey || o.payload?.id || ''))
        .filter(Boolean)
    );
    const doomedCats = doomedFor('category');
    const doomedAccs = doomedFor('item');
    const matches = (keys, row) => keys.has(String(row?.id || '')) || (!!row?.localKey && keys.has(String(row.localKey)));

    const aliveCat = (row) => String(row?.id || '').startsWith('loc-') && !matches(doomedCats, row);
    const aliveAcc = (row) => String(row?.id || '').startsWith('loc-') && !matches(doomedAccs, row);
    const keepCats = cats.filter(aliveCat);
    const keepAccs = accs.filter(aliveAcc);

    // A delete op still sitting in the queue has NOT reached the server yet, so
    // the snapshot merged above still contains that row. Drop it here, otherwise
    // the freshly-deleted category/item reappears in the UI on the next refresh
    // and the delete looks like it silently did nothing.
    const deadCats = cats.filter((row) => !aliveCat(row) && matches(doomedCats, row));
    const deadAccs = accs.filter((row) => !aliveAcc(row) && matches(doomedAccs, row));
    if (deadCats.length) {
      await db.transaction('rw', db.stockCategories, async () => {
        for (const c of deadCats) await db.stockCategories.delete(c.id);
      });
    }
    if (deadAccs.length) {
      await db.transaction('rw', db.inventoryAccessories, async () => {
        for (const a of deadAccs) await db.inventoryAccessories.delete(a.id);
      });
    }

    if (keepCats.length) {
      await db.transaction('rw', db.stockCategories, async () => {
        for (const c of keepCats) await db.stockCategories.put(c);
      });
    }
    if (keepAccs.length) await db.inventoryAccessories.bulkPut(keepAccs);
  } catch (err) {
    console.warn('[stockService] Local-create overlay failed:', err);
  }
};

// Preserve still-unsynced local state on top of fresh server data.
export const applyLocalOverlaysToInventoryCache = async () => {
  await overlayLocalCreates();
  await overlayPendingImports();
};

// Single source of truth for accepting authoritative server inventory data
// into the local cache WITHOUT losing pending local creates/imports. Stock
// Management, Sales/Billing, Repairs and the post-sale cache refresh all
// route through here, so an item can never vanish or show stale quantity in
// one page while being correct in another just because its write op hasn't
// finished syncing. Either list may be omitted to keep the cached copy.
const evictStaleCachedItems = async (serverIds) => {
  const cached = await db.inventoryAccessories.toArray();
  const serverIdSet = new Set(serverIds.map((id) => String(id)));

  // Any queued item/import op still references these rows; they must survive
  // until their op is applied server-side.
  const pendingOps = await db.pendingStockOps
    .where('syncStatus').equals('pending')
    .and((op) => op.entityType === 'item' || op.entityType === 'import')
    .toArray();
  const protectedIds = new Set();
  const protectedSkus = new Set();
  for (const op of pendingOps) {
    const id = String(op.payload?.localKey || op.payload?.id || '');
    if (id) protectedIds.add(id);
    // Import ops address rows by SKU, and create brand-new items the server has
    // never seen - those are re-created by overlayPendingImports anyway.
    for (const row of op.payload?.rows || []) {
      const sku = String(row?.sku || '').trim().toUpperCase();
      if (sku) protectedSkus.add(sku);
    }
    if (op.opType !== 'run') {
      const sku = String(op.payload?.sku || '').trim().toUpperCase();
      if (sku) protectedSkus.add(sku);
    }
  }

  const stale = cached.filter((row) => {
    const id = String(row?.id || '');
    if (protectedIds.has(id) || protectedIds.has(String(row?.localKey || ''))) return false;
    if (id.startsWith('loc-')) return false;
    if (protectedSkus.has(String(row?.sku || '').trim().toUpperCase())) return false;
    return !serverIdSet.has(id);
  });

  if (stale.length) {
    await db.transaction('rw', db.inventoryAccessories, async () => {
      for (const row of stale) await db.inventoryAccessories.delete(row.id);
    });
    console.warn('[stockService] Evicted stale cached items:', stale.map((s) => s.sku || s.id));
  }
  return stale.length;
};

export const applyServerInventorySnapshot = async ({ phones = null, accessories = null } = {}) => {
  const prev = await getCachedInventory();
  const nextPhones = Array.isArray(phones) ? phones : (Array.isArray(prev?.phones) ? prev.phones : []);
  const nextAccessories = Array.isArray(accessories) ? accessories : (Array.isArray(prev?.accessories) ? prev.accessories : []);
  if (Array.isArray(accessories)) await evictStaleCachedItems(accessories.map((a) => a.id));
  await cacheInventory({ phones: nextPhones, accessories: nextAccessories });
  await applyLocalOverlaysToInventoryCache();
};

export const mergeAccessoriesIntoCache = async (serverItems) => {
  await applyServerInventorySnapshot({ accessories: serverItems });
};

export const refreshStockData = async () => {
  if (!navigator.onLine) return loadStockData();
  try {
    // Flush queued writes first (see file header comment).
    const { attemptSync } = await import('./syncService');
    await attemptSync();

    const [catsRes, accRes, takesRes, importsRes] = await Promise.all([
      fetch('/api/stock/categories', { headers: authHeaders() }),
      fetch('/api/inventory/accessories', { headers: authHeaders() }),
      fetch('/api/stock/takes', { headers: authHeaders() }),
      fetch('/api/stock/imports', { headers: authHeaders() })
    ]);

    if (catsRes.ok && accRes.ok) {
      const categories = await catsRes.json();
      const items = await accRes.json();
      // Drop cached rows the server no longer knows about BEFORE the overlays
      // re-add genuinely-pending local work on top of the fresh snapshot.
      await evictStaleCachedCategories(categories.map((c) => c.id));
      await cacheStockCategories(categories);
      // Phones untouched here; accessories merged through the shared
      // reconcile path that preserves pending local writes.
      await mergeAccessoriesIntoCache(items);
      if (takesRes.ok) {
        const takes = await takesRes.json();
        // Preserve locally-typed counts on an in-progress take.
        const locals = await getCachedTakes();
        for (const t of takes) {
          const local = locals.find((l) => l.localKey === t.localKey || l.id === t.id);
          if (local?.counts && Object.keys(local.counts).length) t.counts = local.counts;
        }
        await db.transaction('rw', db.stockTakes, async () => {
          await db.stockTakes.clear();
          await db.stockTakes.bulkPut(takes);
        });
      }

      // Upload history: the server's permanent record supersedes any local
      // twin carrying the same local_key, then is cached authoritatively.
      if (importsRes.ok) {
        const serverImports = await importsRes.json();
        for (const r of serverImports) {
          if (r?.local_key) await removeCachedImportByLocalKey(r.local_key);
        }
        if (serverImports.length) {
          await db.transaction('rw', db.stockImports, async () => {
            for (const r of serverImports) await putCachedImport({ ...r, syncStatus: 'synced' });
          });
        }
      }
      return loadStockData();
    }
  } catch (err) {
    console.warn('[stockService] Refresh failed, serving cache:', err);
  }
  return loadStockData();
};

// Movement ledger with filters. Reads from the cache union (offline parity),
// refreshing from the server in the background when online.
export const getMovements = async (filters = {}, { refresh = true } = {}) => {
  if (refresh && navigator.onLine) {
    try {
      const params = new URLSearchParams();
      if (filters.itemId) params.set('itemId', filters.itemId);
      if (filters.type) params.set('type', filters.type);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.user) params.set('user', filters.user);
      const res = await fetch(`/api/stock/movements?${params.toString()}`, { headers: authHeaders() });
      if (res.ok) {
        const movements = await res.json();
        // Authoritative server rows replace any optimistic offline twins
        // (correlated via local_key), then land in the cache as-is.
        for (const m of movements) {
          if (m?.local_key) {
            await db.stockMovements.where('localKey').equals(m.local_key).delete();
          }
        }
        await putCachedMovements(movements.map((m) => ({ ...m, syncStatus: 'synced' })));
      }
    } catch (err) {
      console.warn('[stockService] Movement refresh failed:', err);
    }
  }

  let rows = await getCachedMovements();

  if (filters.itemId) rows = rows.filter((m) => m.accessoryId === filters.itemId);
  if (filters.sku) rows = rows.filter((m) => String(m.sku || '').toLowerCase().includes(String(filters.sku).toLowerCase()));
  if (filters.type) rows = rows.filter((m) => m.type === filters.type);
  if (filters.user) {
    const q = String(filters.user).toLowerCase();
    rows = rows.filter((m) => String(m.user_name || '').toLowerCase().includes(q));
  }
  if (filters.from) {
    const from = new Date(`${filters.from}T00:00:00`).getTime();
    rows = rows.filter((m) => new Date(m.created_at).getTime() >= from);
  }
  if (filters.to) {
    const to = new Date(`${filters.to}T23:59:59.999`).getTime();
    rows = rows.filter((m) => new Date(m.created_at).getTime() <= to);
  }
  if (filters.search) {
    const q = String(filters.search).toLowerCase();
    rows = rows.filter((m) =>
      String(m.item_name || '').toLowerCase().includes(q)
      || String(m.sku || '').toLowerCase().includes(q)
      || String(m.note || '').toLowerCase().includes(q)
      || String(m.reference || '').toLowerCase().includes(q)
    );
  }
  return rows.slice(0, filters.limit || 500);
};

// Low-stock + dead-stock alerts. Server-computed when online, mirrored by a
// local computation over cached items/movements when offline.
export const getAlerts = async (deadDays = 30, { refresh = true } = {}) => {
  if (refresh && navigator.onLine) {
    try {
      const res = await fetch(`/api/stock/alerts?deadDays=${deadDays}`, { headers: authHeaders() });
      if (res.ok) return res.json();
    } catch (err) {
      console.warn('[stockService] Alerts refresh failed:', err);
    }
  }

  const items = (await db.inventoryAccessories.toArray()).filter((i) => !i.is_service);
  const lowStock = items
    .filter((i) => Number(i.quantity || 0) <= Number(i.low_stock_threshold ?? 5))
    .map((i) => ({
      id: i.id, sku: i.sku, name: i.name, category: i.category,
      quantity: Number(i.quantity || 0), low_stock_threshold: Number(i.low_stock_threshold ?? 5)
    }));

  const lastSaleMap = new Map();
  const saleMoves = await db.stockMovements.where('type').equals('SALE').toArray();
  for (const m of saleMoves) {
    const prev = lastSaleMap.get(m.accessoryId);
    if (!prev || new Date(m.created_at) > new Date(prev)) lastSaleMap.set(m.accessoryId, m.created_at);
  }
  const now = Date.now();
  const deadStock = items
    .filter((i) => Number(i.quantity || 0) > 0)
    .map((i) => {
      const lastSale = lastSaleMap.get(i.id) || i.added_at;
      const days = lastSale ? Math.floor((now - new Date(lastSale).getTime()) / 86400000) : 9999;
      return { id: i.id, sku: i.sku, name: i.name, category: i.category, quantity: Number(i.quantity || 0), days_in_stock: days };
    })
    .filter((a) => a.days_in_stock >= deadDays)
    .sort((x, y) => y.days_in_stock - x.days_in_stock);

  return { lowStock, deadStock, deadDays, generatedAt: new Date().toISOString(), offline: !navigator.onLine };
};

// =============================================
// Writes (local-first + queued sync)
// =============================================

// Find and rewrite the queued create op of a still-unsynced entity, so later
// edits fold into the original create instead of stacking update ops that
// reference a server id that doesn't exist yet.
const amendPendingCreate = async (entityType, localKey, patch) => {
  const ops = await db.pendingStockOps
    .where('syncStatus').equals('pending')
    .and((op) => op.entityType === entityType && op.opType === 'create')
    .toArray();
  const op = ops.find((o) => o.payload?.localKey === localKey);
  if (!op) return false;
  const payload = { ...op.payload };
  if (entityType === 'item') payload.item = { ...payload.item, ...patch };
  else Object.assign(payload, patch);
  await db.pendingStockOps.update(op.id, { payload });
  return true;
};

const cancelPendingCreate = async (entityType, localKey) => {
  const ops = await db.pendingStockOps
    .where('syncStatus').equals('pending')
    .and((op) => op.entityType === entityType && op.opType === 'create')
    .toArray();
  const op = ops.find((o) => o.payload?.localKey === localKey || o.payload?.localId === localKey);
  if (!op) return false;
  await db.pendingStockOps.delete(op.id);
  return true;
};

// ---- Categories ----

// A successful server fetch is AUTHORITATIVE: any cached row the server no
// longer returns is stale (deleted directly in the DB, wiped, or restored from
// an old backup) and must be evicted, otherwise the Stock page keeps rendering
// items/categories the database does not contain.
// Local work that hasn't reached the server yet is preserved - those rows are
// protected by the pending-op checks below.
const evictStaleCachedCategories = async (serverIds) => {
  const cached = await db.stockCategories.toArray();
  const serverIdSet = new Set(serverIds.map((id) => String(id)));

  const pendingOps = await db.pendingStockOps
    .where('syncStatus').equals('pending')
    .and((op) => op.entityType === 'category')
    .toArray();
  // Ids referenced by any queued category op (create OR delete) must survive:
  // a queued create hasn't been applied server-side yet, and a queued delete is
  // still in flight.
  const protectedIds = new Set(
    pendingOps
      .map((op) => String(op.payload?.localKey || op.payload?.id || ''))
      .filter(Boolean)
  );

  const stale = cached.filter((row) => {
    const id = String(row?.id || '');
    if (protectedIds.has(id) || protectedIds.has(String(row?.localKey || ''))) return false;
    // Locally-created rows aren't on the server yet; overlayLocalCreates owns them.
    if (id.startsWith('loc-')) return false;
    return !serverIdSet.has(id);
  });

  if (stale.length) {
    await db.transaction('rw', db.stockCategories, async () => {
      for (const row of stale) await db.stockCategories.delete(row.id);
    });
    console.warn('[stockService] Evicted stale cached categories:', stale.map((s) => s.name));
  }
  return stale.length;
};

// Deleting a category row is not enough to make it disappear from the grid:
// the item list still carries `category: "<name>"` text labels, and CategoryGrid
// synthesises a card for any label that has no matching category row (legacy
// data support). That resurrects the deleted category as a "ghost" card.
// So we keep a tombstone of explicitly-deleted names and filter them out of the
// grid. Re-creating a category with the same name clears its tombstone.
const DELETED_CATS_KEY = 'pos_deleted_categories';

const readDeletedCats = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_CATS_KEY));
    return new Set(Array.isArray(raw) ? raw.map((n) => String(n)) : []);
  } catch {
    return new Set();
  }
};

const writeDeletedCats = (set) => {
  try { localStorage.setItem(DELETED_CATS_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
};

export const getDeletedCategoryNames = () => [...readDeletedCats()];

const tombstoneCategory = (name) => {
  const n = String(name || '').trim();
  if (!n) return;
  const set = readDeletedCats();
  set.add(n);
  writeDeletedCats(set);
};

const clearCategoryTombstone = (name) => {
  const n = String(name || '').trim();
  if (!n) return;
  const set = readDeletedCats();
  if (set.delete(n)) writeDeletedCats(set);
};

export const createCategory = async ({ name, description = '', color_tag = '', is_phone_category = false }, user) => {
  const localKey = newLocalKey();
  const row = {
    id: localKey,
    localKey,
    name: String(name).trim(),
    description,
    color_tag,
    is_phone_category,
    active: true,
    created_by: user?.name || '',
    created_at: new Date().toISOString(),
    syncStatus: 'pending'
  };
  clearCategoryTombstone(row.name);
  await upsertCachedCategory(row);
  await enqueueStockOp({
    entityType: 'category',
    opType: 'create',
    payload: { localKey, name: row.name, description, color_tag, is_phone_category }
  });
  attemptImmediateFlush();
  return row;
};

export const updateCategory = async (category, fields) => {
  const pending = category.syncStatus === 'pending' || isInternalItemId(category.id);
  const next = { ...category, ...fields, name: String(fields.name ?? category.name).trim() };

  // A rename leaves the old name behind on any item that wasn't propagated.
  // Tombstone it so it can't come back as a ghost card, and clear the new name
  // in case the user is restoring a previously deleted category.
  if (next.name !== category.name) {
    tombstoneCategory(category.name);
    clearCategoryTombstone(next.name);
  }

  if (pending) {
    // Not on the server yet - fold into the queued create.
    await amendPendingCreate('category', category.localKey || category.id, {
      name: next.name,
      description: next.description ?? '',
      color_tag: next.color_tag ?? '',
      is_phone_category: !!next.is_phone_category
    });
    await upsertCachedCategory(next);
  } else {
    await upsertCachedCategory({ ...next, syncStatus: 'pending' });
    await enqueueStockOp({
      entityType: 'category',
      opType: 'update',
      payload: {
        id: category.id,
        name: next.name,
        description: next.description ?? '',
        color_tag: next.color_tag ?? '',
        is_phone_category: !!next.is_phone_category,
        active: next.active !== false,
        propagateRename: !!fields.propagateRename,
        originalName: fields.originalName || undefined
      }
    });
    attemptImmediateFlush();
  }
  return next;
};

// Queue the removal of one category: cancel its create op if it never reached
// the server, otherwise enqueue a delete op. Either way the cached row goes.
const queueCategoryDelete = async (category) => {
  const pending = category.syncStatus === 'pending' || isInternalItemId(category.id);
  if (pending) {
    await cancelPendingCreate('category', category.localKey || category.id);
  } else {
    await enqueueStockOp({
      entityType: 'category',
      opType: 'delete',
      payload: { id: category.id }
    });
  }
  tombstoneCategory(category.name);
  await removeCachedCategory(category.id);
};

export const deleteCategory = async (category) => {
  await queueCategoryDelete(category);
  // Awaited, not fire-and-forget: a caller that reloads immediately after must
  // not race an in-flight flush. attemptSync() is guarded by a `syncInProgress`
  // flag and returns early when busy, so a fire-and-forget call would often be
  // skipped and the follow-up refresh would pull a server snapshot that still
  // lists the category, overwriting the cache and resurrecting the row.
  await attemptImmediateFlush();
};

// Bulk variant behind "select all / delete selected" in Manage Categories.
export const deleteCategories = async (categories) => {
  const list = (categories || []).filter((c) => c && c.id);
  if (!list.length) return;
  for (const category of list) await queueCategoryDelete(category);
  await attemptImmediateFlush();
};

// ---- Items (accessories / spare parts) ----

export const buildItemPayload = (form) => ({
  sku: String(form.sku || '').trim(),
  name: String(form.name || '').trim(),
  quantity: Math.max(0, Number(form.quantity) || 0),
  cost_price: form.cost_price === '' || form.cost_price === null || form.cost_price === undefined ? null : Number(form.cost_price),
  sell_price: Number(form.sell_price) || 0,
  low_stock_threshold: Number(form.low_stock_threshold ?? 5) || 0,
  category: String(form.category || '').trim(),
  barcodes: Array.isArray(form.barcodes) ? form.barcodes.map((b) => String(b).trim()).filter(Boolean) : [],
  unit: String(form.unit || 'pcs').trim() || 'pcs',
  is_service: !!form.is_service,
  description: String(form.description || ''),
  tax_rate: Number(form.tax_rate) || 0,
  markup_percent: Number(form.markup_percent) || 0,
  price_includes_tax: !!form.price_includes_tax,
  allow_price_override: form.allow_price_override === undefined ? true : !!form.allow_price_override,
  notes: Array.isArray(form.notes) ? form.notes.filter((n) => n && String(n.text || '').trim()) : [],
  image_url: String(form.image_url || ''),
  color_tag: String(form.color_tag || '')
});

export const saveItem = async (form, existingItem, _user) => {
  const payload = buildItemPayload(form);

  if (!existingItem) {
    const localId = newLocalKey();
    const row = {
      id: localId,
      ...payload,
      added_at: new Date().toISOString(),
      syncStatus: 'pending'
    };
    await upsertCachedAccessory(row);
    await enqueueStockOp({ entityType: 'item', opType: 'create', payload: { localId, item: payload } });
    attemptImmediateFlush();
    return row;
  }

  const pending = existingItem.syncStatus === 'pending' || isInternalItemId(existingItem.id);

  if (pending) {
    await amendPendingCreate('item', existingItem.localKey || existingItem.id, payload);
    await upsertCachedAccessory({ ...existingItem, ...payload });
  } else {
    await upsertCachedAccessory({ ...existingItem, ...payload, syncStatus: 'pending' });
    await enqueueStockOp({
      entityType: 'item',
      opType: 'update',
      payload: { id: existingItem.id, sku: existingItem.sku, item: payload }
    });
    attemptImmediateFlush();
  }
  return { ...existingItem, ...payload };
};

export const deleteItem = async (item) => {
  const pending = item.syncStatus === 'pending' || isInternalItemId(item.id);
  if (pending) {
    await cancelPendingCreate('item', item.localKey || item.id);
  } else {
    await enqueueStockOp({
      entityType: 'item',
      opType: 'delete',
      payload: { id: item.id, sku: item.sku }
    });
  }
  await db.inventoryAccessories.delete(item.id);
  if (!pending) attemptImmediateFlush();
};

// ---- Manual stock adjustment ----

export const adjustStock = async ({ item, change, reason, note = '', allowNegative = false }, user) => {
  const delta = Number(change);
  if (!delta) throw new Error('Adjustment amount must be a non-zero number');

  const currentQty = Number(item.quantity || 0);
  const newQty = currentQty + delta;
  const localKey = newLocalKey();

  // Optimistic quantity + immediate ledger entry so the change is visible
  // even while fully offline. The server copy replaces this row on sync.
  const movementRow = {
    id: localKey,
    localKey,
    accessoryId: item.id,
    sku: item.sku,
    item_name: item.name,
    type: 'ADJUSTMENT',
    quantity_change: delta,
    resulting_quantity: newQty,
    reason,
    note,
    reference: '',
    user_id: user?.id || '',
    user_name: user?.name || '',
    created_at: new Date().toISOString(),
    syncStatus: 'pending'
  };

  await putCachedMovements([movementRow]);
  await upsertCachedAccessory({ ...item, quantity: newQty });
  await enqueueStockOp({
    entityType: 'adjustment',
    opType: 'apply',
    payload: { accessoryId: item.id, sku: item.sku, change: delta, reason, note, allowNegative, localKey }
  });
  attemptImmediateFlush();
  return { newQty, movement: movementRow };
};

// Admin/owner only: delete an ADJUSTMENT movement record. Reverses the
// quantity locally in real time and syncs the deletion (or cancels the still-
// unsent adjustment op when the row hasn't reached the server yet).
export const deleteAdjustmentMovement = async (movement, user) => {
  const role = user?.role;
  if (role !== 'admin' && role !== 'shop_owner') {
    throw new Error('Only admins and shop owners can delete adjustment records');
  }
  const movementId = movement?.id;
  const localKey = movement?.localKey;
  const quantityChange = Number(movement?.quantity_change || 0);
  const stillLocal = String(movementId || '').startsWith('loc-') || String(localKey || '').startsWith('loc-');

  // Reverse the item's quantity locally to keep the dashboard honest.
  const itemRow = await db.inventoryAccessories.get(movement?.accessoryId || movement?.accessory_id).catch(() => null);
  if (itemRow && !itemRow.is_service) {
    await upsertCachedAccessory({ ...itemRow, quantity: Math.max(0, Number(itemRow.quantity || 0) - quantityChange) });
  }

  // Remove the row from the local ledger.
  if (movementId) await db.stockMovements.where('id').equals(movementId).delete();
  if (localKey) await db.stockMovements.where('localKey').equals(localKey).delete();

  if (stillLocal) {
    // The adjustment never reached the server — cancel its queued apply op.
    const pending = await db.pendingStockOps.where('syncStatus').equals('pending').toArray();
    for (const op of pending) {
      if (op.entityType === 'adjustment' && op.opType === 'apply' && op.payload?.localKey && op.payload.localKey === localKey) {
        await db.pendingStockOps.delete(op.id);
      }
    }
    return { deleted: true, queuedForSync: false };
  }

  await enqueueStockOp({ entityType: 'movement', opType: 'delete', payload: { movementId } });
  attemptImmediateFlush();
  return { deleted: true, queuedForSync: true };
};

// ---- Stock take ----

export const startStockTake = async ({ scopeType, scopeCategory }, items, user) => {
  const localKey = newLocalKey();
  const lines = (items || [])
    .filter((i) => !i.is_service)
    .filter((i) => (scopeType === 'category' ? i.category === scopeCategory : true))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((i) => ({
      accessory_id: i.id,
      sku: i.sku,
      name: i.name,
      system_qty: Number(i.quantity || 0),
      counted_qty: null,
      difference: null,
      applied: false
    }));

  const take = {
    id: localKey,
    localKey,
    status: 'in_progress',
    scope_type: scopeType === 'category' ? 'category' : 'all',
    scope_category: scopeType === 'category' ? scopeCategory : '',
    started_by_id: user?.id || '',
    started_by_name: user?.name || '',
    started_at: new Date().toISOString(),
    completed_at: null,
    completed_by_name: '',
    lines,
    counts: {},
    items_counted: 0,
    total_variance: 0,
    syncStatus: 'pending'
  };

  await putCachedTake(take);
  await enqueueStockOp({
    entityType: 'take',
    opType: 'start',
    payload: { scopeType: take.scope_type, scopeCategory: take.scope_category, localTakeId: localKey }
  });
  attemptImmediateFlush();
  return take;
};

export const saveTakeProgress = async (take, counts) => {
  const countedIds = Object.keys(counts).filter((k) => counts[k] !== '' && counts[k] !== null && counts[k] !== undefined);
  const next = {
    ...take,
    counts,
    items_counted: countedIds.length,
    syncStatus: take.status === 'completed' ? take.syncStatus : 'pending'
  };
  await putCachedTake(next);

  if (next.status !== 'completed') {
    await enqueueStockOp({
      entityType: 'take',
      opType: 'save',
      payload: {
        localTakeId: take.localKey || take.id,
        counts: countedIds.map((accessoryId) => ({ accessoryId, countedQty: Number(counts[accessoryId]) }))
      }
    });
    attemptImmediateFlush();
  }
  return next;
};

// Apply corrections locally (optimistic) and queue the server application.
export const applyTakeCorrections = async (take, user) => {
  const items = await db.inventoryAccessories.toArray();
  const itemMap = new Map(items.map((i) => [i.id, i]));

  const lines = [];
  let totalVariance = 0;
  const movementsToCache = [];

  for (const line of take.lines) {
    const raw = take.counts?.[line.accessory_id];
    if (raw === '' || raw === null || raw === undefined) continue;

    const countedQty = Math.max(0, Number(raw) || 0);
    const difference = countedQty - line.system_qty;
    totalVariance += difference;

    const linePayload = { accessoryId: line.accessory_id, countedQty };
    if (difference !== 0) linePayload.localKey = newLocalKey();
    lines.push(linePayload);

    if (difference !== 0) {
      const item = itemMap.get(line.accessory_id);
      if (item) {
        await upsertCachedAccessory({ ...item, quantity: countedQty });
        movementsToCache.push({
          id: linePayload.localKey,
          localKey: linePayload.localKey,
          accessoryId: item.id,
          sku: item.sku,
          item_name: item.name,
          type: 'STOCK_TAKE',
          quantity_change: difference,
          resulting_quantity: countedQty,
          reason: difference > 0 ? 'Miscount' : 'Missing stock',
          note: `Stock take correction (${take.scope_type === 'category' ? take.scope_category : 'All items'})`,
          reference: `TAKE-${(take.localKey || take.id).slice(-6).toUpperCase()}`,
          user_id: user?.id || '',
          user_name: user?.name || '',
          created_at: new Date().toISOString(),
          syncStatus: 'pending'
        });
      }
    }
  }

  if (movementsToCache.length) await putCachedMovements(movementsToCache);

  const completedTake = {
    ...take,
    status: 'completed',
    completed_by_id: user?.id || '',
    completed_by_name: user?.name || '',
    completed_at: new Date().toISOString(),
    items_counted: lines.length,
    total_variance: totalVariance,
    lines: take.lines.map((l) => {
      const sub = lines.find((x) => x.accessoryId === l.accessory_id);
      return sub
        ? { ...l, counted_qty: sub.countedQty, difference: sub.countedQty - l.system_qty, applied: true }
        : l;
    }),
    syncStatus: 'pending'
  };
  await putCachedTake(completedTake);

  await enqueueStockOp({
    entityType: 'take',
    opType: 'apply',
    payload: { localTakeId: take.localKey || take.id, lines }
  });
  attemptImmediateFlush();

  return { take: completedTake, correctedItems: lines.filter((l) => l.localKey).length, totalVariance };
};

// ---- Bulk import (CSV rows) ----
// Applies valid rows optimistically to the cache (with immediate movement
// entries) and queues the authoritative server application.
export const runBulkImport = async ({ filename, rows, overwrite = false }, user) => {
  if (!rows?.length) throw new Error('No rows to import');
  if (rows.length > 1000) throw new Error('Row cap exceeded (max 1000 rows per import)');

  const items = await db.inventoryAccessories.toArray();
  const itemMap = new Map(items.map((i) => [i.sku?.toUpperCase(), i]));
  const movementsToCache = [];
  const queuedRows = [];
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const skuUpper = String(row.sku || '').trim().toUpperCase();
    const localKey = newLocalKey();
    const rowOut = { ...row, sku: String(row.sku || '').trim(), localKey };
    queuedRows.push(rowOut);

    const existing = itemMap.get(skuUpper);
    const quantity = row.quantity === '' || row.quantity === undefined ? null : Number(row.quantity);

    // Optimistic mirror of the server logic so counts update instantly.
    if (existing) {
      const prevQty = Number(existing.quantity || 0);
      const newQty = quantity === null ? prevQty : (overwrite ? quantity : prevQty + quantity);
      await upsertCachedAccessory({
        ...existing,
        name: row.name || existing.name,
        category: row.category || existing.category,
        cost_price: row.cost_price !== '' && row.cost_price !== undefined ? Number(row.cost_price) : existing.cost_price,
        sell_price: row.sell_price !== '' && row.sell_price !== undefined && Number(row.sell_price) > 0 ? Number(row.sell_price) : existing.sell_price,
        low_stock_threshold: row.low_stock_threshold !== '' && row.low_stock_threshold !== undefined ? Number(row.low_stock_threshold) : existing.low_stock_threshold,
        quantity: newQty
      });
      updated++;
      if (newQty !== prevQty) {
        movementsToCache.push({
          id: localKey,
          localKey,
          accessoryId: existing.id,
          sku: existing.sku,
          item_name: row.name || existing.name,
          type: 'IMPORT',
          quantity_change: newQty - prevQty,
          resulting_quantity: newQty,
          reason: 'Bulk import',
          note: `Quantity ${overwrite ? 'overwritten' : 'added'} via ${filename}`,
          reference: filename,
          user_id: user?.id || '',
          user_name: user?.name || '',
          created_at: new Date().toISOString(),
          syncStatus: 'pending'
        });
      }
    } else {
      const localId = newLocalKey();
      const newRow = {
        id: localId,
        sku: rowOut.sku,
        name: String(row.name || '').trim(),
        category: String(row.category || '').trim(),
        quantity: Math.max(0, quantity || 0),
        cost_price: row.cost_price === '' || row.cost_price === undefined ? null : Number(row.cost_price),
        sell_price: Number(row.sell_price) || 0,
        low_stock_threshold: row.low_stock_threshold === '' || row.low_stock_threshold === undefined ? 5 : Number(row.low_stock_threshold),
        barcodes: [], unit: 'pcs', is_service: false, description: '',
        tax_rate: 0, markup_percent: 0, price_includes_tax: false, allow_price_override: true,
        notes: [], image_url: '', color_tag: '',
        added_at: new Date().toISOString(),
        syncStatus: 'pending'
      };
      await upsertCachedAccessory(newRow);
      created++;
      if (Number(newRow.quantity) > 0) {
        movementsToCache.push({
          id: localKey,
          localKey,
          accessoryId: localId,
          sku: newRow.sku,
          item_name: newRow.name,
          type: 'IMPORT',
          quantity_change: Number(newRow.quantity),
          resulting_quantity: Number(newRow.quantity),
          reason: 'Bulk import',
          note: `New item created via ${filename}`,
          reference: filename,
          user_id: user?.id || '',
          user_name: user?.name || '',
          created_at: new Date().toISOString(),
          syncStatus: 'pending'
        });
      }
    }
  }

  if (movementsToCache.length) await putCachedMovements(movementsToCache);

  // Permanent upload-history row (local-first): which file, who uploaded it,
  // when, how many rows and what happened - rendered under "Recent Imports".
  // Flips to "Saved to database" once the queued op confirms on the server.
  const batchKey = newLocalKey();
  await putCachedImport({
    id: batchKey,
    localKey: batchKey,
    filename,
    row_count: rows.length,
    created,
    updated,
    skipped: 0,
    errors: [],
    imported_by_id: user?.id || '',
    imported_by_name: user?.name || 'unknown',
    created_at: new Date().toISOString(),
    syncStatus: 'pending'
  });

  await enqueueStockOp({
    entityType: 'import',
    opType: 'run',
    payload: { filename, overwrite, rows: queuedRows, localKey: batchKey }
  });
  attemptImmediateFlush();

  return { created, updated, movementsLogged: movementsToCache.length, importId: batchKey };
};

// ---- Uploaded-file history ----

// Removes ONE row from the "Uploaded Files" list. This deletes the history
// record ONLY - the items, quantities and stock movements the file created are
// deliberately left untouched, so removing an entry can never roll back or
// corrupt real stock data.
export const deleteImportRecord = async (record) => {
  const id = String(record?.id || '').trim();
  if (!id) throw new Error('This file record has no id');

  // A row that never reached the server has no id to delete server-side, and its
  // queued op is what actually applies the stock changes - cancelling that would
  // lose the imported data. Those must sync first.
  if (isInternalItemId(id) || record?.syncStatus === 'pending') {
    throw new Error('This file is still uploading. Wait for it to finish syncing, then remove it.');
  }

  if (navigator.onLine) {
    const res = await fetch(`/api/stock/imports/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Could not remove the file record');
    }
  }

  // Drop both the server-id copy and any local twin carrying the same localKey.
  await removeCachedImport(id);
  if (record?.localKey) await removeCachedImportByLocalKey(record.localKey);
  return { success: true, id };
};

// Bulk variant behind "Remove all" in the Uploaded Files panel. Deletes the
// history rows only, one server call each, continuing past individual failures
// so one bad record can't block the rest.
export const deleteImportRecords = async (records) => {
  const list = (records || []).filter((r) => r && r.id);
  if (!list.length) return { ok: 0, failed: 0, errors: [] };
  let ok = 0;
  const errors = [];
  for (const r of list) {
    try {
      await deleteImportRecord(r);
      ok += 1;
    } catch (err) {
      errors.push({ filename: r.filename, error: err.message || 'Could not remove' });
    }
  }
  return { ok, failed: list.length - ok, errors };
};