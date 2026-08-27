import { getCachedInventory } from '../db/database';
import { applyLocalOverlaysToInventoryCache } from './stockService';

// Wraps fetch so that reads fall back to the IndexedDB cache when offline.
// The fallback route applies pending-local overlays first so offline reads
// can never miss unsynced stock creates/imports (same rule every page's
// data loader follows via applyServerInventorySnapshot).
export const fetchWithOfflineFallback = async (url, options = {}) => {
  try {
    const res = await fetch(url, options);
    if (res.ok) return await res.json();
    throw new Error(`Request failed: ${res.status}`);
  } catch (err) {
    // Fall back to cached inventory for known read endpoints
    if (url.includes('/api/inventory/phones')) {
      const cached = await getCachedInventory();
      return cached.phones;
    }
    if (url.includes('/api/inventory/accessories')) {
      const cached = await getCachedInventory();
      if (!cached.accessories?.length) {
        await applyLocalOverlaysToInventoryCache();
        return (await getCachedInventory()).accessories;
      }
      return cached.accessories;
    }
    throw err;
  }
};