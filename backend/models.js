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
    added_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- SALES ---
const saleSchema = new mongoose.Schema({
    local_id: Number,
    receipt_no: { type: String, unique: true, required: true },
    cashier_id: { type: Number, required: true },
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
    session_id: Number,
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

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
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
}, { timestamps: true });

// --- REPAIR_JOB_PARTS ---
const repairJobPartSchema = new mongoose.Schema({
    local_id: Number,
    repair_job_id: { type: Number, required: true },
    inventory_id: { type: Number, required: true },
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
    cashier_id: Number,
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
    opened_by: { type: Number, required: true },
    closed_by: Number,
    closed_at: Date,
    created_at: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = {
    User: mongoose.model('User', userSchema),
    Phone: mongoose.model('InventoryPhone', phoneSchema),
    Accessory: mongoose.model('InventoryAccessory', accessorySchema),
    Sale: mongoose.model('Sale', saleSchema),
    RepairJob: mongoose.model('RepairJob', repairJobSchema),
    RepairJobPart: mongoose.model('RepairJobPart', repairJobPartSchema),
    CashMovement: mongoose.model('CashMovement', cashMovementSchema),
    DailySession: mongoose.model('DailySession', dailySessionSchema)
};