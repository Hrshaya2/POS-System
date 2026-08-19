const mongoose = require('mongoose');

// Mongoose Schemas representing Cloud DB structure
const UserSchema = new mongoose.Schema({
    local_id: Number,
    name: String,
    email: { type: String, unique: true },
    role: String,
    created_at: Date
}, { timestamps: true });

const PhoneSchema = new mongoose.Schema({
    local_id: Number,
    imei: { type: String, unique: true },
    brand: String,
    model: String,
    condition: String,
    purchase_price: Number,
    selling_price: Number,
    warranty: String,
    status: String,
    category: String
}, { timestamps: true });

const AccessorySchema = new mongoose.Schema({
    local_id: Number,
    sku: { type: String, unique: true },
    name: String,
    quantity: Number,
    cost_price: Number,
    sell_price: Number,
    low_stock_threshold: Number,
    category: String
}, { timestamps: true });

const SaleSchema = new mongoose.Schema({
    local_id: Number,
    receipt_no: { type: String, unique: true },
    cashier_id: Number,
    cashier_name: String,
    cashier_role: String,
    items: Array,
    subtotal: Number,
    discount_amount: Number,
    discount_percent: Number,
    total: Number,
    payment_method: String,
    payment_details: mongoose.Schema.Types.Mixed,
    approval_required: Boolean,
    approval_status: String,
    approval_note: String,
    created_at: Date
}, { timestamps: true });

// Models
const User = mongoose.model('User', UserSchema);
const Phone = mongoose.model('InventoryPhone', PhoneSchema);
const Accessory = mongoose.model('InventoryAccessory', AccessorySchema);
const Sale = mongoose.model('Sale', SaleSchema);

const SYNC_INTERVAL_MS = 30000; // 30 seconds

// Sync status tracking
let syncStatus = {
    connected: false,
    lastSyncAt: null,
    lastSyncError: null,
    pendingCounts: {
        users: 0,
        inventory_phones: 0,
        inventory_accessories: 0,
        sales: 0
    },
    totalPending: 0
};

const getSyncStatus = () => syncStatus;

const parseJsonSafe = (value, fallback) => {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch (err) {
        return fallback;
    }
};

async function syncTable(db, tableName, MongooseModel, mappingFn) {
    return new Promise((resolve) => {
        db.all(`SELECT * FROM ${tableName} WHERE sync_status != 'SYNCED'`, [], async (err, rows) => {
            if (err || !rows || rows.length === 0) {
                syncStatus.pendingCounts[tableName] = 0;
                return resolve();
            }

            syncStatus.pendingCounts[tableName] = rows.length;
            console.log(`[MongoSync] Found ${rows.length} pending items in ${tableName} to sync.`);

            for (const row of rows) {
                try {
                    if (row.sync_status === 'PENDING_INSERT' || row.sync_status === 'PENDING_UPDATE') {
                        const docData = mappingFn(row);

                        // Upsert based on local_id or unique field like imei/email/sku
                        const uniqueField = docData.imei ? { imei: docData.imei } : (docData.sku ? { sku: docData.sku } : (docData.receipt_no ? { receipt_no: docData.receipt_no } : (docData.email ? { email: docData.email } : { local_id: row.id })));

                        const savedDoc = await MongooseModel.findOneAndUpdate(
                            uniqueField,
                            { ...docData, local_id: row.id },
                            { upsert: true, returnDocument: 'after' }
                        );

                        // Mark as synced locally
                        db.run(`UPDATE ${tableName} SET sync_status = 'SYNCED', cloud_id = ? WHERE id = ?`, [savedDoc._id.toString(), row.id]);
                        console.log(`[MongoSync] Synced ${tableName} local_id ${row.id}`);

                    } else if (row.sync_status === 'PENDING_DELETE') {
                        await MongooseModel.findOneAndDelete({ local_id: row.id });
                        db.run(`DELETE FROM ${tableName} WHERE id = ?`, [row.id]);
                    }
                } catch (syncErr) {
                    console.error(`[MongoSync] Error syncing ${tableName} row ${row.id}:`, syncErr.message);
                    syncStatus.lastSyncError = syncErr.message;
                }
            }
            resolve();
        });
    });
}

function startSyncService(db) {
    console.log('[MongoSync] Starting Sync Service...');

    mongoose.connect(process.env.MONGO_URI).then(() => {
        console.log('[MongoSync] Connected to MongoDB Cloud (Atlas)');
        syncStatus.connected = true;
        syncStatus.lastSyncError = null;

        const runSync = async () => {
            try {
                await syncTable(db, 'users', User, (r) => ({
                    name: r.name, email: r.email, role: r.role, created_at: r.created_at
                }));

                await syncTable(db, 'inventory_phones', Phone, (r) => ({
                    imei: r.imei, brand: r.brand, model: r.model, condition: r.condition,
                    purchase_price: r.purchase_price, selling_price: r.selling_price,
                    warranty: r.warranty, status: r.status, category: r.category
                }));

                await syncTable(db, 'inventory_accessories', Accessory, (r) => ({
                    sku: r.sku, name: r.name, quantity: r.quantity, cost_price: r.cost_price,
                    sell_price: r.sell_price, low_stock_threshold: r.low_stock_threshold, category: r.category
                }));

                await syncTable(db, 'sales', Sale, (r) => ({
                    receipt_no: r.receipt_no,
                    cashier_id: r.cashier_id,
                    cashier_name: r.cashier_name,
                    cashier_role: r.cashier_role,
                    items: parseJsonSafe(r.items_json, []),
                    subtotal: r.subtotal,
                    discount_amount: r.discount_amount,
                    discount_percent: r.discount_percent,
                    total: r.total,
                    payment_method: r.payment_method,
                    payment_details: parseJsonSafe(r.payment_details_json, null),
                    approval_required: r.approval_required === 1,
                    approval_status: r.approval_status,
                    approval_note: r.approval_note,
                    created_at: r.created_at
                }));

                syncStatus.lastSyncAt = new Date().toISOString();
                syncStatus.totalPending = Object.values(syncStatus.pendingCounts).reduce((sum, count) => sum + count, 0);
                syncStatus.lastSyncError = null;

            } catch (err) {
                console.error('[MongoSync] Sync iteration error:', err.message);
                syncStatus.lastSyncError = err.message;
            }
        };

        // Run initial sync immediately, then on interval
        runSync();
        setInterval(runSync, SYNC_INTERVAL_MS);

    }).catch(err => {
        console.error('[MongoSync] MongoDB Connection Error:', err.message);
        console.log('[MongoSync] Will retry connecting on next service start...');
        syncStatus.connected = false;
        syncStatus.lastSyncError = err.message;
    });
}

module.exports = { startSyncService, getSyncStatus };
