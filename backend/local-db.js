// =============================================================
// local-db.js — Local SQLite database layer for Nangi POS
// =============================================================
// The backend keeps a local SQLite database (database.sqlite) as a local
// mirror/backup of every important operation, IN ADDITION to the cloud
// MongoDB database. This gives the shop:
//   1) A local copy of activity that survives even when the cloud is down.
//   2) A way to detect "online-only" operation — when the system runs but no
//      local SQLite DB can be opened (e.g. Vercel's read-only filesystem, or
//      an old Node without `node:sqlite`), the backend keeps working against
//      MongoDB alone and the dashboard shows a warning that can be dismissed.
//
// Deliberately zero-dependency on the runtime:
//   - Node 22.5+ provides the built-in `node:sqlite` module (preferred), OR
//   - the optional `sqlite3` npm package is used as a fallback.
// If neither is available the module degrades to `available:false`
// (online-only mode) without ever breaking the MongoDB flow.
//
// If a legacy `database.sqlite` from the old SQLite-based version already
// exists, it is opened as-is (legacy tables preserved) and the new
// `app_meta` / `op_log` tables are added alongside it.
// =============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.LOCAL_DB_PATH
    ? path.resolve(process.env.LOCAL_DB_PATH)
    : path.join(__dirname, 'database.sqlite');

// ---- Runtime detection ------------------------------------------------
let mode = null;          // 'node-sqlite' | 'sqlite3-pkg' | null
let DatabaseSync = null;  // node:sqlite constructor
let sqlite3Pkg = null;    // sqlite3 npm package (optional fallback)
try {
    ({ DatabaseSync } = require('node:sqlite'));
    mode = 'node-sqlite';
} catch (err) {
    // Node < 22.5 (node:sqlite not available)
}
if (!DatabaseSync) {
    try {
        sqlite3Pkg = require('sqlite3').verbose();
        mode = 'sqlite3-pkg';
    } catch (err) {
        // sqlite3 package not installed
    }
}

let db = null;          // open handle
let initPromise = null; // shared lazy init
let lastError = null;

// ---- Low level helpers (both backends resolve promises) ---------------
function runSql(sql, params = []) {
    if (mode === 'node-sqlite') {
        try {
            const stmt = db.prepare(sql);
            const info = stmt.run(...(params || []));
            return Promise.resolve({ lastID: Number(info.lastInsertRowid), changes: Number(info.changes) });
        } catch (err) {
            return Promise.reject(err);
        }
    }
    if (mode === 'sqlite3-pkg') {
        return new Promise((resolve, reject) => {
            db.run(sql, params || [], function (err) {
                if (err) return reject(err);
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }
    return Promise.reject(new Error('Local SQLite database is not available on this runtime'));
}

function queryAll(sql, params = []) {
    if (mode === 'node-sqlite') {
        try {
            const stmt = db.prepare(sql);
            const rows = stmt.all(...(params || []));
            return Promise.resolve(rows);
        } catch (err) {
            return Promise.reject(err);
        }
    }
    if (mode === 'sqlite3-pkg') {
        return new Promise((resolve, reject) => {
            db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows)));
        });
    }
    return Promise.reject(new Error('Local SQLite database is not available on this runtime'));
}

function queryGet(sql, params = []) {
    if (mode === 'node-sqlite') {
        try {
            const stmt = db.prepare(sql);
            const row = stmt.get(...(params || []));
            return Promise.resolve(row || null);
        } catch (err) {
            return Promise.reject(err);
        }
    }
    if (mode === 'sqlite3-pkg') {
        return new Promise((resolve, reject) => {
            db.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row || null)));
        });
    }
    return Promise.reject(new Error('Local SQLite database is not available on this runtime'));
}

// ---- Schema ------------------------------------------------------------
async function ensureSchema() {
    await runSql(`CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await runSql(`CREATE TABLE IF NOT EXISTS op_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        op TEXT NOT NULL,
        item_key TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced INTEGER NOT NULL DEFAULT 0
    )`);
    await runSql('CREATE INDEX IF NOT EXISTS idx_op_log_created ON op_log(created_at)');
    await runSql('CREATE INDEX IF NOT EXISTS idx_op_log_entity ON op_log(entity)');
}

function openHandle() {
    if (mode === 'node-sqlite') {
        return Promise.resolve(new DatabaseSync(DB_PATH, { enableForeignKeyConstraints: true }));
    }
    return new Promise((resolve, reject) => {
        const handle = new sqlite3Pkg.Database(DB_PATH, (err) => (err ? reject(err) : resolve(handle)));
    });
}

async function init() {
    if (db) return db;
    if (!mode) {
        lastError = 'No SQLite runtime available (needs Node 22.5+ or the sqlite3 package)';
        return null;
    }
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        db = await openHandle();
        await ensureSchema();
        await runSql(
            `INSERT INTO app_meta (key, value, updated_at) VALUES ('init_timestamp', ?, datetime('now'))
             ON CONFLICT(key) DO NOTHING`,
            [new Date().toISOString()]
        );
        lastError = null;
        return db;
    } catch (err) {
        lastError = (err && err.message) ? err.message : String(err);
        console.error('[local-db] Failed to initialize local SQLite database:', lastError);
        try { if (db && typeof db.close === 'function') db.close(); } catch (e) { /* ignore */ }
        db = null;
        return null;
    }
}

// Lazy, shared initialization (safe to call many times).
function ensure() {
    if (!initPromise) initPromise = init().catch(() => null);
    return initPromise;
}

// Record an operation in the local mirror. Never throws — a local DB problem
// is swallowed so the live MongoDB flow is never affected (online-only mode).
async function logOp({ entity, op, itemKey = null, payload = null }) {
    try {
        await ensure();
        if (!db) return { saved: false, reason: lastError || 'local-db-unavailable' };
        const nowIso = new Date().toISOString();
        await runSql(
            'INSERT INTO op_log (entity, op, item_key, payload_json) VALUES (?, ?, ?, ?)',
            [
                String(entity),
                String(op),
                itemKey == null ? null : String(itemKey),
                payload == null ? null : JSON.stringify(payload)
            ]
        );
        const meta = await runSql(
            `UPDATE app_meta SET value = ?, updated_at = datetime('now') WHERE key = 'last_op_at'`,
            [nowIso]
        );
        if (!meta.changes) {
            await runSql(
                `INSERT INTO app_meta (key, value, updated_at) VALUES ('last_op_at', ?, datetime('now'))`,
                [nowIso]
            );
        }
        return { saved: true };
    } catch (err) {
        lastError = (err && err.message) ? err.message : String(err);
        return { saved: false, reason: lastError };
    }
}

// Combined status used by GET /api/system/db-status.
async function getStatus() {
    const exists = fs.existsSync(DB_PATH);
    const out = {
        available: false,
        exists,
        path: DB_PATH,
        sizeBytes: exists ? fs.statSync(DB_PATH).size : 0,
        initialized: false,
        tables: [],
        opCount: 0,
        lastOpAt: null,
        legacy: { detected: false, tables: [] },
        runtime: mode,
        error: lastError
    };
    const handle = await ensure();
    if (!handle) {
        out.error = lastError;
        return out;
    }

    out.available = true;
    out.initialized = true;
    out.exists = fs.existsSync(DB_PATH);
    out.sizeBytes = out.exists ? fs.statSync(DB_PATH).size : 0;
    try {
        out.tables = (await queryAll(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )).map(r => r.name);
        const countRow = await queryGet('SELECT COUNT(*) AS c FROM op_log');
        out.opCount = Number(countRow && countRow.c != null ? countRow.c : 0);
        const lastRow = await queryGet('SELECT created_at FROM op_log ORDER BY id DESC LIMIT 1');
        out.lastOpAt = lastRow ? lastRow.created_at : null;

        const legacyExpected = [
            'inventory_phones', 'inventory_accessories', 'sales', 'repair_jobs',
            'repair_job_parts', 'users', 'daily_sessions', 'day_sessions', 'cash_movements'
        ];
        out.legacy.tables = out.tables.filter(t => legacyExpected.includes(t));
        out.legacy.detected = out.legacy.tables.length > 0;
    } catch (err) {
        out.error = (err && err.message) ? err.message : String(err);
    }
    return out;
}

const getDbPath = () => DB_PATH;

module.exports = { ensure, init, logOp, getStatus, getDbPath };