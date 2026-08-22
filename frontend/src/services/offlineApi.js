import { getCachedInventory } from '../db/database';

// Wraps fetch so that reads fall back to the IndexedDB cache when offline.
// The UI calls this instead of raw fetch for inventory/list reads.

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
      return cached.accessories;
    }
    throw err;
  }
};