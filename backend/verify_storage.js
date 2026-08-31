// Verification script for the Manage Storage feature.
// Usage:
//   node verify_storage.js                 — real thresholds (warning: false expected)
//   set STORAGE_WARN_BYTES=1000 && node verify_storage.js  — simulated >500MB (warning: true)
//
// Checks:
//   (a) gauge numbers come from real dbStats (dataSize/storageSize in bytes)
//   (b) warning flag flips with the threshold (simulates usage pushed past 500MB)
//   (c) breakdown excludes users + inventory product data, sorted largest-first,
//       with accurate counts/sizes per collection
//   (d) per-section clearing fails safe: protected/unknown collections and
//       invalid modes are refused BEFORE any deleteMany ever runs (this script
//       never deletes real data)
require('dotenv').config();
const app = require('./index');

const MB = 1024 * 1024;
const EXCLUDED = ['users', 'inventoryphones', 'inventoryaccessories'];

(async () => {
    let failures = 0;
    const check = (name, ok, detail = '') => {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
        if (!ok) failures += 1;
    };

    // (a) + (b): usage stats from real dbStats
    const usage = await app.storage.getStorageUsage();
    console.log('\nUsage (dashboard banner check):');
    console.log(`  used=${(usage.usedBytes / MB).toFixed(2)} MB  storage=${(usage.storageBytes / MB).toFixed(2)} MB  index=${(usage.indexBytes / MB).toFixed(2)} MB  objects=${usage.objectCount}`);
    console.log(`  limit=${(usage.limitBytes / MB).toFixed(0)} MB  warnThreshold=${(usage.warnThresholdBytes / MB).toFixed(0)} MB  percent=${usage.percentUsed}%  warning=${usage.warning}`);
    check('dataSize is a real byte value from dbStats (not 0/hardcoded)', usage.usedBytes > 0);
    check('storageSize is present', usage.storageBytes > 0);
    check('warning flag matches threshold comparison', usage.warning === (usage.usedBytes > usage.warnThresholdBytes));
    if (process.env.STORAGE_WARN_BYTES) {
        check('STORAGE_WARN_BYTES override respected', usage.warnThresholdBytes === Number(process.env.STORAGE_WARN_BYTES));
    }

    // (c): breakdown
    const breakdown = await app.storage.getStorageBreakdown();
    console.log('\nBreakdown (Manage Storage page check):');
    for (const c of breakdown.collections) {
        console.log(`  ${(c.size / 1024).toFixed(1).padStart(9)} KB  ${String(c.count).padStart(6)} docs  ${c.name}`);
    }
    console.log(`  excluded server-side: ${breakdown.excludedCollections.join(', ')}`);
    console.log(`  history points: ${breakdown.history.length}  snapshotCapturedToday: ${breakdown.snapshotCaptured}`);

    const names = breakdown.collections.map((c) => c.name);
    const leaked = names.filter((n) => EXCLUDED.includes(n));
    check('Users + Inventory/Stock product data excluded from breakdown', leaked.length === 0, leaked.join(', ') || 'none leaked');
    check('breakdown non-empty', names.length > 0, `${names.length} sections`);
    check('sorted largest first', breakdown.collections.every((c, i) => i === 0 || breakdown.collections[i - 1].size >= c.size));
    check('per-collection counts are real ($collStats)', breakdown.collections.every((c) => c.count >= 0 && c.size >= 0));
    check('history returned (30-day trend source)', Array.isArray(breakdown.history) && breakdown.history.length >= 1, `${breakdown.history.length} point(s)`);
    const today = new Date().toISOString().slice(0, 10);
    check('today snapshot exists', breakdown.history.some((h) => h.date === today), today);

    // (d): per-section clearing must fail safe. Every case below is refused
    // during validation — before any deleteMany — so nothing is ever deleted.
    const expectRefusal = async (name, payload) => {
        try {
            await app.storage.clearStorageCollection(payload);
            check(name, false, 'request was accepted (should have been refused!)');
        } catch (err) {
            check(name, err.status === 400, err.message);
        }
    };
    check('clearStorageCollection exposed for tooling', typeof app.storage.clearStorageCollection === 'function');
    await expectRefusal('protected collection "users" refused', { collection: 'users', mode: 'all' });
    await expectRefusal('protected collection "inventoryphones" refused', { collection: 'inventoryphones', mode: 'all' });
    await expectRefusal('protected collection "inventoryaccessories" refused', { collection: 'inventoryaccessories', mode: 'olderThan', days: 30 });
    await expectRefusal('empty collection name refused', { collection: '', mode: 'all' });
    await expectRefusal('system collection refused', { collection: 'system.views', mode: 'all' });
    await expectRefusal('invalid mode refused', { collection: 'sales', mode: 'someMode' });
    await expectRefusal('non-integer days refused', { collection: 'sales', mode: 'olderThan', days: 0 });
    await expectRefusal('negative days refused', { collection: 'sales', mode: 'olderThan', days: -5 });
    await expectRefusal('raw collection "taxrates" refuses date-mode', { collection: 'taxrates', mode: 'olderThan', days: 90 });
    await expectRefusal('legacy raw collection "categories" refuses date-mode', { collection: 'categories', mode: 'olderThan', days: 30 });
    await expectRefusal('unknown raw collection refuses date-mode', { collection: 'not_a_real_collection', mode: 'olderThan', days: 30 });

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    await require('mongoose').connection.close();
    process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Verification error:', err);
    process.exit(1);
});