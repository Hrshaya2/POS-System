const mongoose = require('mongoose');

// =============================================
// MongoDB Models for Nangi POS (Vercel Migration)
// =============================================

// --- USERS ---
const userSchema = new mongoose.Schema({
    local_id: Number,
    name: { type: String, required: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'cashier' },
    lastLogin: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// --- INVENTORY: PHONES (IMEI tracked) ---
const phoneSchema = new mongoose.Schema({
    local_id: Number,
    imei: { type: String, unique: true, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    condition: { type: String, required: true },
    purchase_price: Number,
    selling_price: { type: Number, required: true },
    warranty: String,
    status: { type: String, default: 'In Stock' },
    category: { type: String, required: true },
    added_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- INVENTORY_ACCESSORIES ---
const accessorySchema = new mongoose.Schema({
    local_id: Number,
    sku: { type: String, unique: true, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, default: 0 },
    cost_price: Number,
    sell_price: { type: Number, required: true },
    low_stock_threshold: { type: Number, default: 5 },
    category: { type: String, required: true },
    // Stock Management extensions
    barcodes: { type: [String], default: [] },          // multiple barcodes per product
    unit: { type: String, default: 'pcs' },
    is_service: { type: Boolean, default: false },      // service items skip stock tracking
    description: { type: String, default: '' },
    tax_rate: { type: Number, default: 0 },
    markup_percent: { type: Number, default: 0 },
    price_includes_tax: { type: Boolean, default: false },
    allow_price_override: { type: Boolean, default: true },
    notes: {
        type: [{
            text: { type: String, required: true },
            user_name: String,
            created_at: { type: Date, default: Date.now }
        }],
        default: []
    },
    image_url: { type: String, default: '' },
    color_tag: { type: String, default: '' },
    added_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- STOCK CATEGORIES (accessory/part categories; phones stay IMEI-based) ---
const stockCategorySchema = new mongoose.Schema({
    local_id: Number,
    name: { type: String, unique: true, required: true },
    description: { type: String, default: '' },
    color_tag: { type: String, default: '' },
    is_phone_category: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    created_by: String,
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- STOCK MOVEMENTS (immutable audit trail of every quantity change) ---
const stockMovementSchema = new mongoose.Schema({
    local_key: String,
    accessory_id: { type: String, required: true },
    sku: { type: String, required: true },
    item_name: { type: String, required: true },
    type: {
        type: String,
        required: true,
        enum: ['STOCK_IN', 'SALE', 'REFUND', 'ADJUSTMENT', 'STOCK_TAKE', 'IMPORT']
    },
    quantity_change: { type: Number, required: true },
    resulting_quantity: { type: Number, required: true },
    reason: { type: String, default: '' },
    note: { type: String, default: '' },
    reference: { type: String, default: '' },
    user_id: { type: String, default: '' },
    user_name: { type: String, default: '' },
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });
stockMovementSchema.index({ accessory_id: 1, created_at: -1 });
stockMovementSchema.index({ type: 1, created_at: -1 });

// --- STOCK TAKES (physical counts) ---
const stockTakeLineSchema = new mongoose.Schema({
    accessory_id: { type: String, required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    system_qty: { type: Number, default: 0 },
    counted_qty: { type: Number, default: null },   // null until actually counted
    difference: { type: Number, default: null },
    applied: { type: Boolean, default: false }
}, { _id: false });

const stockTakeSchema = new mongoose.Schema({
    local_id: Number,
    status: { type: String, default: 'in_progress', enum: ['in_progress', 'completed'] },
    scope_type: { type: String, default: 'all', enum: ['all', 'category'] },
    scope_category: { type: String, default: '' },
    started_by_id: String,
    started_by_name: String,
    started_at: { type: Date, default: Date.now },
    completed_by_id: String,
    completed_by_name: String,
    completed_at: Date,
    lines: { type: [stockTakeLineSchema], default: [] },
    items_counted: { type: Number, default: 0 },
    total_variance: { type: Number, default: 0 }
}, { timestamps: true });

// --- SALES ---
const saleSchema = new mongoose.Schema({
    local_id: Number,
    client_local_id: { type: String },
    receipt_no: { type: String, unique: true, required: true },
    cashier_id: { type: String, required: true },
    cashier_name: { type: String, required: true },
    cashier_role: { type: String, required: true },
    items: [{ type: mongoose.Schema.Types.Mixed }],
    subtotal: { type: Number, required: true },
    discount_amount: { type: Number, default: 0 },
    discount_percent: { type: Number, default: 0 },
    total: { type: Number, required: true },
    payment_method: { type: String, required: true },
    payment_details: { type: mongoose.Schema.Types.Mixed },
    cash_received: { type: Number, default: 0 },
    change_amount: { type: Number, default: 0 },
    approval_required: { type: Boolean, default: false },
    approval_status: { type: String, default: 'NOT_REQUIRED' },
    approval_note: String,
    session_id: String,
    refunded: { type: Boolean, default: false },
    refunded_at: Date,
    refund_reason: String,
    refunded_by_id: String,
    refunded_by_name: String,
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Idempotency: at most one Sale per device-generated token. This stops exactly
// two things from ever double-creating a sale: a background-sync + immediate
// push racing on the same pending sale, or a network-retry of the same checkout.
saleSchema.index({ client_local_id: 1 }, { unique: true, sparse: true });

// --- REPAIR_JOBS ---
const repairJobSchema = new mongoose.Schema({
    local_id: Number,
    customer_name: { type: String, required: true },
    phone_number: { type: String, required: true },
    device_model: { type: String, required: true },
    imei: String,
    reported_issue: { type: String, required: true },
    items_left: String,
    received_date: String,
    estimated_cost: { type: Number, default: 0 },
    estimated_completion_date: String,
    repair_status: { type: String, default: 'Received' },
    warranty_period_months: { type: Number, default: 3 },
    warranty_end_date: String,
    // Single optional advance taken once at intake. No partial top-ups:
    // advance is fixed at creation; final bill deducts it from the total.
    job_no: { type: String, unique: true, sparse: true },
    advance_amount: { type: Number, default: 0 },
    payment_method: { type: String, default: '' }, // CASH | CARD | BANK_TRANSFER
    payment_status: { type: String, default: 'UNPAID', enum: ['UNPAID', 'PARTIAL', 'PAID'] },
    advance_received_at: Date,
    advance_received_by: String,
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- REPAIR_JOB_PARTS ---
const repairJobPartSchema = new mongoose.Schema({
    local_id: Number,
    repair_job_id: { type: String, required: true },
    inventory_id: { type: String, required: true },
    part_name: { type: String, required: true },
    sku: String,
    quantity: { type: Number, default: 1 },
    unit_cost: { type: Number, default: 0 },
    total_cost: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- CASH_MOVEMENTS ---
const cashMovementSchema = new mongoose.Schema({
    local_id: Number,
    cashier_id: String,
    cashier_name: String,
    movement_type: { type: String, required: true },
    amount: { type: Number, required: true },
    note: String,
    movement_date: { type: String, required: true },
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- DAILY_SESSIONS ---
const dailySessionSchema = new mongoose.Schema({
    local_id: Number,
    date: { type: String, required: true },
    opening_cash: { type: Number, default: 0 },
    opening_reload: { type: Number, default: 0 },
    closing_cash: Number,
    closing_reload: Number,
    expected_cash: Number,
    actual_cash: Number,
    variance: Number,
    status: { type: String, default: 'open' },
    opened_by: { type: String, required: true },
    closed_by: String,
    closed_at: Date,
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- STOCK_IMPORTS (permanent record of every uploaded file) ---
const stockImportSchema = new mongoose.Schema({
    local_key: String,
    filename: { type: String, required: true },
    row_count: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    errors: [{ sku: String, error: String }],
    imported_by_id: String,
    imported_by_name: String,
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- REFUNDS (immutable audit trail of every sale reversal) ---
const refundItemSchema = new mongoose.Schema({
    inventory_type: { type: String, required: true },   // 'phone' | 'accessory' | 'service'
    inventory_id: { type: String, required: true },
    name: String,
    sku: String,
    imei: String,
    unit_price: { type: Number, default: 0 },
    quantity: { type: Number, required: true },          // how many of THIS item were returned
    line_total: { type: Number, default: 0 }
}, { _id: false });

const refundSchema = new mongoose.Schema({
    sale_id: { type: String, required: true },
    sale_receipt_no: { type: String, required: true },
    refund_reference: { type: String, required: true, unique: true }, // RFS-xxxx
    items: { type: [refundItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },            // sum of returned item totals
    total: { type: Number, required: true },           // total amount being returned to the customer
    reason: { type: String, required: true },
    reason_note: String,
    refund_method: { type: String, required: true },   // CASH | CARD | BANK_TRANSFER | SPLIT
    original_payment_method: String,
    initiated_by_id: String,
    initiated_by_name: String,
    initiated_at: { type: Date, default: Date.now },
    // Approval workflow:
    requires_approval: { type: Boolean, default: false },
    approval_status: { type: String, default: 'DIRECT', enum: ['PENDING', 'APPROVED', 'REJECTED', 'DIRECT'] },
    approved_by_id: String,
    approved_by_name: String,
    approved_at: Date,
    rejection_reason: String,
    // Cash session linkage:
    session_id: String,
    movement_date: { type: String, required: true },
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });
refundSchema.index({ sale_id: 1 });
refundSchema.index({ movement_date: 1 });
refundSchema.index({ approval_status: 1 });

// --- STORE SETTINGS (key/value config, e.g. refund policy, kept simple/on-prem) ---
const storeSettingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed
}, { timestamps: true });

// --- PARTIAL / CREDIT PAYMENTS (additive; legacy sales keep using payment_* fields) ---
const paymentLineSchema = new mongoose.Schema({
    method: { type: String, required: true },          // CASH | CARD | BANK_TRANSFER
    amount: { type: Number, required: true },
    reference: String,
    recorded_at: { type: Date, default: Date.now }
}, { _id: false });

const creditNoteSchema = new mongoose.Schema({
    note_no: { type: String, required: true, unique: true },
    customer_name: String,
    customer_phone: String,
    amount: { type: Number, required: true },
    balance: { type: Number, required: true },
    status: { type: String, default: 'OPEN', enum: ['OPEN', 'PAID', 'CANCELLED'] },
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- STORAGE SNAPSHOTS (daily MongoDB usage readings for the Manage Storage page) ---
// One document per UTC day so the Manage Storage page can draw a 30-day usage
// trend. Snapshots start collecting from the day this feature ships; the trend
// chart fills in gradually as days pass. Sizes are bytes straight from dbStats.
const storageSnapshotSchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true }, // UTC 'YYYY-MM-DD'
    total_data_size: { type: Number, default: 0 },        // dbStats.dataSize in bytes
    total_storage_size: { type: Number, default: 0 },     // dbStats.storageSize in bytes
    captured_at: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = {
    User: mongoose.model('User', userSchema),
    Phone: mongoose.model('InventoryPhone', phoneSchema),
    Accessory: mongoose.model('InventoryAccessory', accessorySchema),
    Sale: mongoose.model('Sale', saleSchema),
    RepairJob: mongoose.model('RepairJob', repairJobSchema),
    RepairJobPart: mongoose.model('RepairJobPart', repairJobPartSchema),
    CashMovement: mongoose.model('CashMovement', cashMovementSchema),
    DailySession: mongoose.model('DailySession', dailySessionSchema),
    StockCategory: mongoose.model('StockCategory', stockCategorySchema),
    StockMovement: mongoose.model('StockMovement', stockMovementSchema),
    StockTake: mongoose.model('StockTake', stockTakeSchema),
    StockImport: mongoose.model('StockImport', stockImportSchema),
    Refund: mongoose.model('Refund', refundSchema),
    StoreSetting: mongoose.model('StoreSetting', storeSettingSchema),
    CreditNote: mongoose.model('CreditNote', creditNoteSchema),
    StorageSnapshot: mongoose.model('StorageSnapshot', storageSnapshotSchema)
};
