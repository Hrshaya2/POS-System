require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const localDb = require('./local-db');

const {
    User,
    Phone,
    Accessory,
    Sale,
    RepairJob,
    RepairJobPart,
    CashMovement,
    DailySession,
    StockCategory,
    StockMovement,
    StockTake,
    StockImport,
    Refund,
    StoreSetting,
    CreditNote,
    StorageSnapshot
} = require('./models');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretposkey123';
const SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT = Number(process.env.SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT || 10);
const MONGO_URI = process.env.MONGO_URI || '';

// =============================================
// Helpers
// =============================================

const parseJsonSafe = (value, fallback) => {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch (err) {
        return fallback;
    }
};

const toSqlDateTimeStart = (value) => {
    if (!value) return null;
    return `${value} 00:00:00`;
};

const toSqlDateTimeEnd = (value) => {
    if (!value) return null;
    return `${value} 23:59:59`;
};

const diffDays = (fromDate, toDate = new Date()) => {
    if (!fromDate) return 0;
    const from = new Date(fromDate);
    if (Number.isNaN(from.getTime())) return 0;
    const delta = toDate.getTime() - from.getTime();
    return Math.max(0, Math.floor(delta / (1000 * 60 * 60 * 24)));
};

// Calendar-day helpers that respect the client's timezone.
// tzOffsetMinutes follows JavaScript's Date#getTimezoneOffset convention
// (minutes to ADD to local time to get UTC; e.g. -330 for UTC+05:30 Colombo).
const localDateStr = (tzOffsetMinutes, base = new Date()) =>
    new Date(base.getTime() - tzOffsetMinutes * 60 * 1000).toISOString().slice(0, 10);

const localDayRange = (dateStr, tzOffsetMinutes) => {
    const offsetMs = tzOffsetMinutes * 60 * 1000;
    return {
        start: new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() + offsetMs),
        end: new Date(new Date(`${dateStr}T23:59:59.999Z`).getTime() + offsetMs)
    };
};

const formatLocalTime = (date, tzOffsetMinutes) =>
    new Date(date.getTime() - tzOffsetMinutes * 60 * 1000).toISOString().slice(11, 16);

const formatReceiptNo = () => `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const formatRefundRef = () => `RFS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const formatRepairJobNo = () => `REP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

// Shared repair invoice math: labor (estimated_cost) + parts - single intake
// advance = balance due. Used by list/detail/invoice responses so the frontend
// never computes money differently from the server.
const buildRepairInvoice = (job, jobParts) => {
    const parts = Array.isArray(jobParts) ? jobParts : [];
    const partsTotal = parts.reduce((sum, part) => sum + Number(part.total_cost || 0), 0);
    const laborCost = Number(job.estimated_cost || 0);
    const total = laborCost + partsTotal;
    const advance = Math.max(0, Number(job.advance_amount || 0));
    return {
        job_id: job._id.toString(),
        job_no: job.job_no || null,
        invoice_no: job.job_no || `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
        labor_cost: laborCost,
        parts_cost: partsTotal,
        total_cost: total,
        advance_amount: advance,
        balance_due: Math.max(0, total - advance),
        payment_method: job.payment_method || '',
        payment_status: job.payment_status || (advance > 0 ? 'PARTIAL' : 'UNPAID'),
        status: job.repair_status,
        created_at: job.created_at
    };
};

// Record a business operation into the local SQLite mirror (backend/database.sqlite).
// Fire-and-forget: the local DB is optional and must NEVER slow down or break
// the MongoDB flow. When the local DB is unavailable (online-only mode) the
// dashboard shows a dismissible warning instead of an error.
const recordLocalOp = (entity, op, itemKey, payload) => {
    localDb.logOp({ entity, op, itemKey, payload }).catch(() => { });
};

// Default refund approval policy (overridable per-store via StoreSetting 'refund_policy').
const DEFAULT_REFUND_POLICY = {
    maxDays: 30,            // allow refund within N days of the original sale
    maxAmount: 50000,       // allow direct refund up to this amount (Rs.)
    sameMethodRequired: true // cash refunds to a different payment method need approval
};

const REFUND_REASONS = ['Defective', 'Wrong Item', 'Customer Changed Mind', 'Damaged', 'Warranty Return', 'Other'];
const REFUND_METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'SPLIT'];

// Resolve the refund policy, falling back to defaults. Stored as StoreSetting({ key: 'refund_policy' }).
const getRefundPolicy = async () => {
    try {
        await connectDB();
        const doc = await StoreSetting.findOne({ key: 'refund_policy' });
        return { ...DEFAULT_REFUND_POLICY, ...(doc?.value || {}) };
    } catch (err) {
        console.error('[refund policy] failed, using defaults', err);
        return { ...DEFAULT_REFUND_POLICY };
    }
};

// =============================================
// Stock Management helpers
// =============================================

const MOVEMENT_TYPES = ['STOCK_IN', 'SALE', 'REFUND', 'ADJUSTMENT', 'STOCK_TAKE', 'IMPORT'];
const ADJUSTMENT_REASONS = ['Damaged', 'Lost/Theft', 'Miscount', 'Returned to Supplier', 'Other'];

// Write an immutable audit-trail row for every accessory quantity change.
const logStockMovement = async ({ accessory, type, quantityChange, resultingQuantity, reason = '', note = '', reference = '', user = {}, localKey = null }) => {
    const doc = await StockMovement.create({
        local_key: localKey || crypto.randomBytes(8).toString('hex'),
        accessory_id: String(accessory._id),
        sku: accessory.sku,
        item_name: accessory.name,
        type,
        quantity_change: Number(quantityChange) || 0,
        resulting_quantity: Number(resultingQuantity),
        reason,
        note,
        reference,
        user_id: user.id ? String(user.id) : '',
        user_name: user.name || ''
    });
    return doc;
};

const normalizeMovement = (m) => ({
    id: m._id.toString(),
    local_key: m.local_key || m._id.toString(),
    accessory_id: m.accessory_id,
    sku: m.sku,
    item_name: m.item_name,
    type: m.type,
    quantity_change: m.quantity_change,
    resulting_quantity: m.resulting_quantity,
    reason: m.reason || '',
    note: m.note || '',
    reference: m.reference || '',
    user_id: m.user_id || '',
    user_name: m.user_name || '',
    created_at: m.created_at
});

const normalizeCategory = (c) => ({
    id: c._id.toString(),
    name: c.name,
    description: c.description || '',
    color_tag: c.color_tag || '',
    is_phone_category: !!c.is_phone_category,
    active: c.active !== false,
    created_by: c.created_by || '',
    created_at: c.created_at
});

const normalizeStockTake = (t) => ({
    id: t._id.toString(),
    status: t.status,
    scope_type: t.scope_type,
    scope_category: t.scope_category || '',
    started_by_id: t.started_by_id || '',
    started_by_name: t.started_by_name || '',
    started_at: t.started_at,
    completed_by_name: t.completed_by_name || '',
    completed_at: t.completed_at || null,
    lines: (t.lines || []).map((l) => ({
        accessory_id: l.accessory_id,
        sku: l.sku,
        name: l.name,
        system_qty: l.system_qty,
        counted_qty: l.counted_qty === null || l.counted_qty === undefined ? null : l.counted_qty,
        difference: l.difference === null || l.difference === undefined ? null : l.difference,
        applied: !!l.applied
    })),
    items_counted: t.items_counted || 0,
    total_variance: t.total_variance || 0
});

// Full-shape accessory payload used by the Stock Management page.
const normalizeAccessoryFull = (a) => ({
    id: a._id.toString(),
    sku: a.sku,
    name: a.name,
    quantity: a.quantity,
    cost_price: a.cost_price,
    sell_price: a.sell_price,
    low_stock_threshold: a.low_stock_threshold,
    category: a.category,
    barcodes: a.barcodes || [],
    unit: a.unit || 'pcs',
    is_service: !!a.is_service,
    description: a.description || '',
    tax_rate: a.tax_rate || 0,
    markup_percent: a.markup_percent || 0,
    price_includes_tax: !!a.price_includes_tax,
    allow_price_override: a.allow_price_override !== false,
    notes: (a.notes || []).map((n, i) => ({
        id: `${a._id.toString()}_n${i}`,
        text: n.text,
        user_name: n.user_name || '',
        created_at: n.created_at
    })),
    image_url: a.image_url || '',
    color_tag: a.color_tag || '',
    added_at: a.added_at || a.created_at
});

// Pick only the known editable fields from a product form payload.
const pickAccessoryFields = (body) => {
    const out = {};
    if (body.sku !== undefined) out.sku = String(body.sku).trim();
    if (body.name !== undefined) out.name = String(body.name).trim();
    if (body.quantity !== undefined) out.quantity = Math.max(0, Number(body.quantity) || 0);
    if (body.cost_price !== undefined) out.cost_price = body.cost_price === '' || body.cost_price === null ? null : Number(body.cost_price);
    if (body.sell_price !== undefined) out.sell_price = Number(body.sell_price);
    if (body.low_stock_threshold !== undefined) out.low_stock_threshold = Number(body.low_stock_threshold) || 0;
    if (body.category !== undefined) out.category = String(body.category).trim();
    if (body.barcodes !== undefined) out.barcodes = Array.isArray(body.barcodes) ? body.barcodes.map((b) => String(b).trim()).filter(Boolean) : [];
    if (body.unit !== undefined) out.unit = String(body.unit || '').trim() || 'pcs';
    if (body.is_service !== undefined) out.is_service = !!body.is_service;
    if (body.description !== undefined) out.description = String(body.description || '');
    if (body.tax_rate !== undefined) out.tax_rate = Number(body.tax_rate) || 0;
    if (body.markup_percent !== undefined) out.markup_percent = Number(body.markup_percent) || 0;
    if (body.price_includes_tax !== undefined) out.price_includes_tax = !!body.price_includes_tax;
    if (body.allow_price_override !== undefined) out.allow_price_override = !!body.allow_price_override;
    if (body.notes !== undefined) {
        out.notes = Array.isArray(body.notes)
            ? body.notes.filter((n) => n && String(n.text || '').trim()).map((n) => ({
                text: String(n.text).trim(),
                user_name: n.user_name || '',
                created_at: n.created_at ? new Date(n.created_at) : new Date()
            }))
            : [];
    }
    if (body.image_url !== undefined) out.image_url = String(body.image_url || '');
    if (body.color_tag !== undefined) out.color_tag = String(body.color_tag || '');
    return out;
};

// --- Refund helpers ---
// Total already-refunded quantity per item of a sale (for over-refund prevention).
const getRefundedTotals = async (saleId) => {
    const refunds = await Refund.find({ sale_id: saleId, approval_status: { $in: ['APPROVED', 'DIRECT'] } });
    const totals = new Map();
    refunds.forEach((r) => {
        (r.items || []).forEach((it) => {
            const key = `${it.inventory_type}:${it.inventory_id}`;
            totals.set(key, (totals.get(key) || 0) + Number(it.quantity || 0));
        });
    });
    return totals;
};

const normalizeRefund = (refund, opts = {}) => ({
    id: refund._id.toString(),
    refund_reference: refund.refund_reference,
    sale_id: refund.sale_id,
    sale_receipt_no: refund.sale_receipt_no,
    items: refund.items || [],
    subtotal: refund.subtotal,
    total: refund.total,
    reason: refund.reason,
    reason_note: refund.reason_note,
    refund_method: refund.refund_method,
    original_payment_method: refund.original_payment_method,
    requires_approval: refund.requires_approval,
    approval_status: refund.approval_status,
    approved_by_id: refund.approved_by_id,
    approved_by_name: refund.approved_by_name,
    approved_at: refund.approved_at,
    initiated_by: refund.initiated_by_name,
    initiated_at: refund.initiated_at,
    session_id: refund.session_id,
    movement_date: refund.movement_date,
    created_at: refund.created_at || refund.initiated_at
});

const normalizeSale = (sale) => {
    if (!sale) return null;
    return {
        id: sale._id.toString(),
        client_local_id: sale.client_local_id || '',
        receipt_no: sale.receipt_no,
        cashier_id: sale.cashier_id,
        cashier_name: sale.cashier_name,
        cashier_role: sale.cashier_role,
        items: sale.items || [],
        subtotal: sale.subtotal,
        discount_amount: sale.discount_amount,
        discount_percent: sale.discount_percent,
        total: sale.total,
        payment_method: sale.payment_method,
        payment_details: sale.payment_details || {},
        cash_received: sale.cash_received || 0,
        change_amount: sale.change_amount || 0,
        approval_required: sale.approval_required,
        approval_status: sale.approval_status,
        approval_note: sale.approval_note,
        session_id: sale.session_id,
        created_at: sale.created_at || sale.createdAt,
        refunded: !!sale.refunded,
        refunded_at: sale.refunded_at || null,
        refund_reason: sale.refund_reason || '',
        refunded_by_id: sale.refunded_by_id || '',
        refunded_by_name: sale.refunded_by_name || '',
        pending_sync: false
    };
};

// MongoDB connection (cached for serverless)
let cachedDb = null;
const connectDB = async () => {
    if (cachedDb) return cachedDb;
    if (!MONGO_URI) throw new Error('MONGO_URI is not configured');
    const conn = await mongoose.connect(MONGO_URI);
    cachedDb = conn;
    return conn;
};

// =============================================
// Middleware
// =============================================

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return res.sendStatus(403);
    }

    // Reject tokens belonging to users that no longer exist (e.g. the account
    // was deleted). Without this check, a stale token silently passes auth but
    // every user-scoped query (like a cashier's sales history) returns nothing,
    // making pages appear mysteriously empty.
    try {
        await connectDB();
        const userExists = await User.exists({ _id: payload.id });
        if (!userExists) return res.sendStatus(401);
    } catch (dbErr) {
        console.error('Auth DB check failed:', dbErr);
        return res.status(500).json({ error: 'Authentication check failed' });
    }

    req.user = payload;
    next();
};

const isAdminOrShopOwner = (role) => role === 'admin' || role === 'shop_owner';

const requireAdmin = (req, res, next) => {
    if (req.user && isAdminOrShopOwner(req.user.role)) {
        next();
    } else {
        res.status(403).json({ error: 'Admin or Shop Owner access required' });
    }
};

const ALLOWED_ROLES = ['admin', 'shop_owner', 'cashier'];

// =============================================
// AUTH ROUTES
// =============================================

app.post('/api/auth/seed', async (req, res) => {
    try {
        await connectDB();
        const adminHash = await bcrypt.hash('admin123', 10);
        const shopOwnerHash = await bcrypt.hash('shop123', 10);
        const cashierHash = await bcrypt.hash('cashier123', 10);

        const seedUsers = [
            { name: 'Main Admin', email: 'admin@nangi.com', password: adminHash, role: 'admin' },
            { name: 'Shop Owner', email: 'shop@nangi.com', password: shopOwnerHash, role: 'shop_owner' },
            { name: 'Amali Cashier', email: 'cashier@nangi.com', password: cashierHash, role: 'cashier' }
        ];

        for (const u of seedUsers) {
            await User.updateOne(
                { email: u.email },
                { $setOnInsert: u },
                { upsert: true }
            );
        }

        res.json({ message: 'Seeded admin (admin@nangi.com/admin123), shop_owner (shop@nangi.com/shop123) and cashier (cashier@nangi.com/cashier123)' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error adding seed users' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        await connectDB();
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

        // Record the login time so admins can see each user's last activity
        user.lastLogin = new Date();
        await user.save();

        const token = jwt.sign(
            { id: user._id.toString(), role: user.role, name: user.name, email: user.email },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        res.json({ token, user: { id: user._id.toString(), name: user.name, email: user.email, role: user.role } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// =============================================
// USERS ROUTES (Admin Only)
// =============================================

app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        let users = await User.find({});
        users = users.map(u => ({
            id: u._id.toString(),
            name: u.name,
            email: u.email,
            role: u.role,
            created_at: u.createdAt,
            last_login: u.lastLogin || null
        }));

        if (req.user.role === 'shop_owner') {
            users = users.filter(u => u.role === 'cashier' || u.id === req.user.id);
        }

        res.json(users);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { name, email, password, role } = req.body;
        if (!name || !email || !password || !role) return res.status(400).json({ error: 'Missing fields' });

        if (req.user.role === 'shop_owner' && role !== 'cashier') {
            return res.status(403).json({ error: 'Shop owners can only create cashier accounts' });
        }

        if (role === 'admin' && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only the admin can create admin accounts' });
        }

        const hash = await bcrypt.hash(password, 10);
        const newUser = await User.create({ name, email: email.toLowerCase(), password: hash, role });
        recordLocalOp('users', 'create', newUser._id.toString(), { name, email, role });
        res.status(201).json({ id: newUser._id.toString(), name, email, role });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { name, email, role, password } = req.body;
        const id = req.params.id;

        const targetUser = await User.findById(id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        if (req.user.role === 'shop_owner') {
            if (targetUser._id.toString() !== req.user.id && targetUser.role !== 'cashier') {
                return res.status(403).json({ error: 'Shop owners can only manage cashiers' });
            }
            if (role !== targetUser.role) {
                return res.status(403).json({ error: 'You do not have permission to change roles' });
            }
        }

        if (role === 'admin' && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only the admin can assign the admin role' });
        }

        if (targetUser.role === 'admin' && targetUser._id.toString() !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Cannot modify admin accounts' });
        }

        targetUser.name = name || targetUser.name;
        targetUser.email = email || targetUser.email;
        targetUser.role = role || targetUser.role;
        if (password) {
            targetUser.password = await bcrypt.hash(password, 10);
        }
        await targetUser.save();
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const id = req.params.id;

        const targetUser = await User.findById(id);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });

        if (targetUser.role === 'admin') {
            return res.status(403).json({ error: 'Admin accounts cannot be deleted' });
        }

        if (req.user.role === 'shop_owner' && targetUser.role !== 'cashier') {
            return res.status(403).json({ error: 'Shop owners can only delete cashiers' });
        }

        if (id === req.user.id) {
            return res.status(403).json({ error: 'You cannot delete your own account' });
        }

        await User.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// =============================================
// INVENTORY: PHONES
// =============================================

app.get('/api/inventory/phones', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const phones = await Phone.find({}).sort({ created_at: -1 });
        res.json(phones.map(p => ({
            id: p._id.toString(),
            imei: p.imei,
            brand: p.brand,
            model: p.model,
            condition: p.condition,
            purchase_price: p.purchase_price,
            selling_price: p.selling_price,
            warranty: p.warranty,
            status: p.status,
            category: p.category,
            added_at: p.added_at || p.created_at
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/inventory/phones', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { imei, brand, model, condition, purchase_price, selling_price, warranty, status, category } = req.body;
        const phone = await Phone.create({
            imei, brand, model, condition,
            purchase_price, selling_price,
            warranty, status: status || 'In Stock', category
        });
        recordLocalOp('inventory_phones', 'create', phone._id.toString(), { imei, brand, model, category, selling_price: Number(selling_price || 0) });
        res.status(201).json({ id: phone._id.toString() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error' });
    }
});

app.put('/api/inventory/phones/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { imei, brand, model, condition, purchase_price, selling_price, warranty, status, category } = req.body;
        const phone = await Phone.findByIdAndUpdate(
            req.params.id,
            { imei, brand, model, condition, purchase_price, selling_price, warranty, status, category },
            { new: true }
        );
        if (!phone) return res.status(404).json({ error: 'Phone not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/inventory/phones/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const phone = await Phone.findByIdAndDelete(req.params.id);
        if (!phone) return res.status(404).json({ error: 'Phone not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// =============================================
// INVENTORY: ACCESSORIES
// =============================================

app.get('/api/inventory/accessories', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const accessories = await Accessory.find({}).sort({ created_at: -1 });
        res.json(accessories.map(normalizeAccessoryFull));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Cashiers may CREATE items (and categories); editing/deleting afterwards is
// admin/shop-owner only - enforced here on the server as well as in the UI.
app.post('/api/inventory/accessories', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const fields = pickAccessoryFields(req.body);
        if (!fields.sku) return res.status(400).json({ error: 'SKU is required' });
        if (!fields.name) return res.status(400).json({ error: 'Name is required' });
        if (!fields.category) return res.status(400).json({ error: 'Category is required' });

        const existing = await Accessory.findOne({ sku: fields.sku });
        if (existing) return res.status(409).json({ error: `An item with SKU ${fields.sku} already exists` });

        const accessory = await Accessory.create(fields);

        // Initial stock counts as a Stock In movement.
        if (Number(accessory.quantity || 0) > 0 && !accessory.is_service) {
            await logStockMovement({
                accessory,
                type: 'STOCK_IN',
                quantityChange: Number(accessory.quantity),
                resultingQuantity: Number(accessory.quantity),
                reason: 'Initial stock',
                note: 'Item created',
                user: req.user
            });
        }

        recordLocalOp('inventory_accessories', 'create', accessory._id.toString(), { sku: fields.sku, name: fields.name, quantity: Number(accessory.quantity || 0), category: fields.category });
        res.status(201).json({ id: accessory._id.toString(), accessory: normalizeAccessoryFull(accessory) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventory/accessories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const accessory = await Accessory.findById(req.params.id);
        if (!accessory) return res.status(404).json({ error: 'Accessory not found' });

        const fields = pickAccessoryFields(req.body);
        const prevQty = Number(accessory.quantity || 0);

        Object.assign(accessory, fields);
        await accessory.save();

        // Quantity edited through the product form is an adjustment.
        const newQty = Number(accessory.quantity || 0);
        if (!accessory.is_service && newQty !== prevQty) {
            await logStockMovement({
                accessory,
                type: 'ADJUSTMENT',
                quantityChange: newQty - prevQty,
                resultingQuantity: newQty,
                reason: 'Product edit',
                note: 'Quantity changed while editing item details',
                user: req.user
            });
        }

        res.json({ success: true, id: accessory._id.toString(), accessory: normalizeAccessoryFull(accessory) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/inventory/accessories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const accessory = await Accessory.findByIdAndDelete(req.params.id);
        if (!accessory) return res.status(404).json({ error: 'Accessory not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Seed Inventory
app.post('/api/inventory/seed', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const seedPhones = [
            { imei: '358123456789012', brand: 'Apple', model: 'iPhone 13 128GB', condition: 'New', purchase_price: 110000, selling_price: 135000, warranty: '1 Year', category: 'New Phones' },
            { imei: '358123456789014', brand: 'Xiaomi', model: 'Redmi Note 12', condition: 'New', purchase_price: 50000, selling_price: 62000, warranty: '1 Year', category: 'New Phones' }
        ];
        const seedAccessories = [
            { sku: 'ACC-001', name: '20W Apple Fast Charger', quantity: 15, cost_price: 3000, sell_price: 4500, low_stock_threshold: 5, category: 'Accessories' },
            { sku: 'ACC-002', name: 'Samsung A14 Screen Replacement', quantity: 2, cost_price: 8000, sell_price: 12500, low_stock_threshold: 5, category: 'Spare Parts' }
        ];

        for (const p of seedPhones) {
            await Phone.findOneAndUpdate({ imei: p.imei }, { $setOnInsert: p }, { upsert: true });
        }
        for (const a of seedAccessories) {
            await Accessory.findOneAndUpdate({ sku: a.sku }, { $setOnInsert: a }, { upsert: true });
        }

        res.json({ message: 'Inventory Seeded' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// =============================================
// STOCK MANAGEMENT (categories / movements / takes / import / alerts)
// =============================================

// --- Stock categories ---
// Everyone (incl. cashiers) may list and create; only admin/shop_owner can
// edit or delete - matching the shop rule "entered details are immutable".
app.get('/api/stock/categories', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        let categories = await StockCategory.find({}).sort({ name: 1 });
        // No auto-seeding: an empty list simply means "no categories yet" and
        // the frontend shows its empty-state guidance. Never insert demo rows
        // into a live database behind the user's back.
        res.json(categories.map(normalizeCategory));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error loading categories' });
    }
});

app.post('/api/stock/categories', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Category name is required' });

        const existing = await StockCategory.findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
        if (existing) return res.status(409).json({ error: `Category "${name}" already exists` });

        const category = await StockCategory.create({
            name,
            description: String(req.body.description || ''),
            color_tag: String(req.body.color_tag || ''),
            is_phone_category: !!req.body.is_phone_category,
            created_by: req.user.name || ''
        });
        recordLocalOp('stock_categories', 'create', category._id.toString(), { name, description: String(req.body.description || '') });
        res.status(201).json(normalizeCategory(category));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error creating category' });
    }
});

app.put('/api/stock/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const category = await StockCategory.findById(req.params.id);
        if (!category) return res.status(404).json({ error: 'Category not found' });

        if (req.body.name !== undefined) {
            const name = String(req.body.name).trim();
            if (!name) return res.status(400).json({ error: 'Category name is required' });
            const dupe = await StockCategory.findOne({ _id: { $ne: category._id }, name });
            if (dupe) return res.status(409).json({ error: `Category "${name}" already exists` });
            category.name = name;
        }
        if (req.body.description !== undefined) category.description = String(req.body.description || '');
        if (req.body.color_tag !== undefined) category.color_tag = String(req.body.color_tag || '');
        if (req.body.is_phone_category !== undefined) category.is_phone_category = !!req.body.is_phone_category;
        if (req.body.active !== undefined) category.active = !!req.body.active;

        await category.save();

        // Keep item labels in sync with a renamed category.
        if (req.body.propagateRename && req.body.originalName) {
            await Accessory.updateMany({ category: req.body.originalName }, { $set: { category: category.name } });
        }

        res.json(normalizeCategory(category));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error updating category' });
    }
});

app.delete('/api/stock/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const category = await StockCategory.findByIdAndDelete(req.params.id);
        if (!category) return res.status(404).json({ error: 'Category not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error deleting category' });
    }
});

// --- Manual stock adjustment (+/- with reason) ---
app.post('/api/stock/adjust', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { accessoryId, sku, change, reason, note = '', allowNegative = false, localKey = null } = req.body;

        const delta = Number(change);
        if (!delta || Number.isNaN(delta) || delta === 0) {
            return res.status(400).json({ error: 'Adjustment amount must be a non-zero number' });
        }
        if (!ADJUSTMENT_REASONS.includes(reason)) {
            return res.status(400).json({ error: 'A valid adjustment reason is required' });
        }

        const accessory = accessoryId
            ? await Accessory.findById(accessoryId)
            : await Accessory.findOne({ sku: String(sku || '').trim() });
        if (!accessory) return res.status(404).json({ error: 'Item not found' });
        if (accessory.is_service) return res.status(400).json({ error: 'Service items are not stock-tracked' });

        const newQty = Number(accessory.quantity || 0) + delta;
        if (newQty < 0 && !allowNegative) {
            return res.status(400).json({ error: `Adjustment would take stock negative (${newQty}). Enable the negative override to proceed.` });
        }

        accessory.quantity = newQty;
        await accessory.save();

        const movement = await logStockMovement({
            accessory,
            type: 'ADJUSTMENT',
            quantityChange: delta,
            resultingQuantity: newQty,
            reason,
            note,
            user: req.user,
            localKey
        });

        recordLocalOp('stock_movements', 'adjust', accessory._id.toString(), { sku: accessory.sku, change: delta, resultingQuantity: newQty, reason });
        res.json({
            success: true,
            quantity: newQty,
            movement: normalizeMovement(movement)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error adjusting stock' });
    }
});

// --- Stock movement ledger (filterable) ---
app.get('/api/stock/movements', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { itemId = '', sku = '', type = '', from = '', to = '', user = '', limit = 500 } = req.query;
        const filter = {};

        if (itemId) filter.accessory_id = String(itemId);
        if (sku) filter.sku = String(sku).trim();
        if (type && MOVEMENT_TYPES.includes(type)) filter.type = type;
        if (user) filter.$or = [{ user_name: { $regex: String(user).trim(), $options: 'i' } }, { user_id: String(user).trim() }];
        if (from || to) {
            filter.created_at = {};
            if (from) filter.created_at.$gte = new Date(`${from}T00:00:00.000`);
            if (to) filter.created_at.$lte = new Date(`${to}T23:59:59.999`);
        }

        const movements = await StockMovement.find(filter)
            .sort({ created_at: -1 })
            .limit(Math.min(2000, Math.max(1, Number(limit) || 500)));
        res.json(movements.map(normalizeMovement));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error loading movements' });
    }
});

// --- Delete an ADJUSTMENT movement (admin / shop owner only) ---
// Deletes a stock-adjustment ledger record and reverses its quantity effect
// so the item's stock stays honest. Sales/refunds/imports are never deletable.
app.delete('/api/stock/movements/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const movement = await StockMovement.findById(req.params.id);
        if (!movement) return res.status(404).json({ error: 'Movement record not found' });
        if (movement.type !== 'ADJUSTMENT') {
            return res.status(400).json({ error: 'Only stock adjustment records can be deleted' });
        }

        // Reverse the adjustment so the current quantity stays honest.
        const accessory = await Accessory.findById(movement.accessory_id);
        if (accessory && !accessory.is_service) {
            accessory.quantity = Math.max(0, Number(accessory.quantity || 0) - Number(movement.quantity_change || 0));
            await accessory.save();
        }

        await StockMovement.deleteOne({ _id: movement._id });
        res.json({ deleted: true, id: String(movement._id), reversedQuantityChange: Number(movement.quantity_change || 0) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete movement' });
    }
});

// --- Stock takes ---
// Start: snapshots system quantities into blank counting lines.
app.post('/api/stock/takes/start', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const scopeType = req.body.scopeType === 'category' ? 'category' : 'all';
        const scopeCategory = String(req.body.scopeCategory || '').trim();
        if (scopeType === 'category' && !scopeCategory) {
            return res.status(400).json({ error: 'Pick a category to count or choose All Items' });
        }

        const query = scopeType === 'category' ? { category: scopeCategory } : {};
        const items = await Accessory.find(query).sort({ name: 1 });

        const take = await StockTake.create({
            status: 'in_progress',
            scope_type: scopeType,
            scope_category: scopeType === 'category' ? scopeCategory : '',
            started_by_id: String(req.user.id || ''),
            started_by_name: req.user.name || '',
            lines: items
                .filter((a) => !a.is_service)
                .map((a) => ({
                    accessory_id: a._id.toString(),
                    sku: a.sku,
                    name: a.name,
                    system_qty: Number(a.quantity || 0),
                    counted_qty: null,
                    difference: null,
                    applied: false
                }))
        });

        res.status(201).json(normalizeStockTake(take));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error starting stock take' });
    }
});

app.get('/api/stock/takes', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const takes = await StockTake.find({}).sort({ started_at: -1 }).limit(100);
        res.json(takes.map(normalizeStockTake));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error loading stock takes' });
    }
});

// Save counted quantities while the count is in progress.
app.put('/api/stock/takes/:id', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const take = await StockTake.findById(req.params.id);
        if (!take) return res.status(404).json({ error: 'Stock take not found' });
        if (take.status === 'completed') return res.status(400).json({ error: 'This stock take is already completed' });

        const counts = Array.isArray(req.body.counts) ? req.body.counts : [];
        for (const c of counts) {
            const line = take.lines.find((l) => l.accessory_id === String(c.accessoryId));
            if (!line) continue;
            line.counted_qty = c.countedQty === null || c.countedQty === undefined || c.countedQty === ''
                ? null
                : Math.max(0, Number(c.countedQty) || 0);
            line.difference = line.counted_qty === null ? null : line.counted_qty - line.system_qty;
        }

        take.items_counted = take.lines.filter((l) => l.counted_qty !== null).length;
        await take.save();
        res.json(normalizeStockTake(take));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error saving stock take' });
    }
});

// Apply corrections: writes STOCK_TAKE movements for every variance and closes the count.
app.post('/api/stock/takes/:id/apply', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const take = await StockTake.findById(req.params.id);
        if (!take) return res.status(404).json({ error: 'Stock take not found' });
        if (take.status === 'completed') return res.status(400).json({ error: 'This stock take is already completed' });

        // Optional client-side recount payload; falls back to stored lines.
        const submitted = Array.isArray(req.body.lines) ? req.body.lines : null;
        let correctedCount = 0;
        let totalVariance = 0;
        const appliedMovements = [];

        for (const line of take.lines) {
            const sub = submitted ? submitted.find((l) => String(l.accessoryId) === String(line.accessory_id)) : null;
            const counted = sub
                ? (sub.countedQty === null || sub.countedQty === undefined || sub.countedQty === '' ? null : Math.max(0, Number(sub.countedQty) || 0))
                : line.counted_qty;
            if (counted === null) continue;

            const difference = counted - line.system_qty;
            totalVariance += difference;

            if (difference !== 0) {
                const accessory = await Accessory.findById(line.accessory_id);
                if (accessory) {
                    accessory.quantity = counted;
                    await accessory.save();
                    const movement = await logStockMovement({
                        accessory,
                        type: 'STOCK_TAKE',
                        quantityChange: difference,
                        resultingQuantity: counted,
                        reason: difference > 0 ? 'Miscount' : 'Missing stock',
                        note: `Stock take correction (${take.scope_type === 'category' ? take.scope_category : 'All items'})`,
                        reference: `TAKE-${take._id.toString().slice(-6).toUpperCase()}`,
                        user: req.user,
                        localKey: sub?.localKey || null
                    });
                    appliedMovements.push(normalizeMovement(movement));
                }
                correctedCount++;
            }

            line.counted_qty = counted;
            line.difference = difference;
            line.applied = true;
        }

        take.status = 'completed';
        take.completed_by_id = String(req.user.id || '');
        take.completed_by_name = req.user.name || '';
        take.completed_at = new Date();
        take.items_counted = take.lines.filter((l) => l.counted_qty !== null).length;
        take.total_variance = totalVariance;
        await take.save();

        res.json({
            success: true,
            take: normalizeStockTake(take),
            movements: appliedMovements,
            correctedItems: correctedCount,
            totalVariance
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error applying stock take' });
    }
});

// --- Bulk import (CSV/Excel export) ---
// Permanent upload-history shape sent to clients (snake_case like other models).
const normalizeImport = (r) => ({
    id: String(r._id || r.id),
    local_key: r.local_key || null,
    filename: r.filename,
    row_count: r.row_count || 0,
    created: r.created || 0,
    updated: r.updated || 0,
    skipped: r.skipped || 0,
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 50) : [],
    imported_by_id: r.imported_by_id || null,
    imported_by_name: r.imported_by_name || 'unknown',
    created_at: r.created_at || r.createdAt
});

app.post('/api/stock/import', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const filename = String(req.body.filename || 'import.csv');
        const overwriteQty = !!req.body.overwrite;
        const rows = Array.isArray(req.body.rows) ? req.body.rows : [];

        if (rows.length === 0) return res.status(400).json({ error: 'Import contains no rows' });
        if (rows.length > 1000) return res.status(400).json({ error: 'Row cap exceeded (max 1000 rows per import)' });

        const importRef = `${filename} (${new Date().toLocaleDateString()})`;
        const results = { created: 0, updated: 0, errors: [], movements: [] };

        for (const row of rows) {
            try {
                const sku = String(row.sku || '').trim();
                const name = String(row.name || '').trim();
                const category = String(row.category || '').trim();
                const quantity = row.quantity === '' || row.quantity === undefined ? null : Number(row.quantity);
                const cost = row.cost_price === '' || row.cost_price === undefined ? null : Number(row.cost_price);
                const sell = row.sell_price === '' || row.sell_price === undefined ? null : Number(row.sell_price);
                const threshold = row.low_stock_threshold === '' || row.low_stock_threshold === undefined ? null : Number(row.low_stock_threshold);

                if (!sku) throw new Error('SKU is required');
                const rowLocalKey = row.localKey || null;
                if (!name) throw new Error('Name is required');
                if (!category) throw new Error('Category is required');
                if (quantity !== null && (Number.isNaN(quantity) || quantity < 0)) throw new Error(`Invalid quantity "${row.quantity}"`);
                if (cost !== null && Number.isNaN(cost)) throw new Error(`Invalid cost "${row.cost_price}"`);
                if (sell !== null && Number.isNaN(sell)) throw new Error(`Invalid sell price "${row.sell_price}"`);

                let accessory = await Accessory.findOne({ sku });

                if (accessory) {
                    // Existing item matched by SKU.
                    const prevQty = Number(accessory.quantity || 0);
                    const newQty = quantity === null
                        ? prevQty
                        : (overwriteQty ? quantity : prevQty + quantity);

                    accessory.name = name || accessory.name;
                    accessory.category = category;
                    if (cost !== null) accessory.cost_price = cost;
                    if (sell !== null && sell > 0) accessory.sell_price = sell;
                    if (threshold !== null) accessory.low_stock_threshold = threshold;

                    const qtyChanged = !accessory.is_service && newQty !== prevQty;
                    accessory.quantity = newQty;
                    await accessory.save();

                    if (qtyChanged) {
                        const movement = await logStockMovement({
                            accessory,
                            type: 'IMPORT',
                            quantityChange: newQty - prevQty,
                            resultingQuantity: newQty,
                            reason: 'Bulk import',
                            note: `Quantity ${overwriteQty ? 'overwritten' : 'added'} via ${importRef}`,
                            reference: importRef,
                            user: req.user,
                            localKey: rowLocalKey
                        });
                        results.movements.push(normalizeMovement(movement));
                    }
                    results.updated++;
                } else {
                    if (sell === null || Number.isNaN(sell) || sell <= 0) throw new Error('New items need a valid sell price');

                    accessory = await Accessory.create({
                        sku,
                        name,
                        category,
                        quantity: quantity || 0,
                        cost_price: cost,
                        sell_price: sell,
                        low_stock_threshold: threshold === null ? 5 : threshold
                    });

                    if (Number(accessory.quantity) > 0 && !accessory.is_service) {
                        const movement = await logStockMovement({
                            accessory,
                            type: 'IMPORT',
                            quantityChange: Number(accessory.quantity),
                            resultingQuantity: Number(accessory.quantity),
                            reason: 'Bulk import',
                            note: `New item created via ${importRef}`,
                            reference: importRef,
                            user: req.user,
                            localKey: rowLocalKey
                        });
                        results.movements.push(normalizeMovement(movement));
                    }
                    results.created++;
                }
            } catch (rowErr) {
                results.errors.push({ sku: row.sku || '(missing)', error: rowErr.message });
            }
        }

        // Permanent record of this upload so every file that ever changed
        // stock is identifiable later (who, when, how many rows, skips).
        let importRecord = null;
        try {
            importRecord = await StockImport.create({
                local_key: req.body.localKey || null,
                filename,
                row_count: rows.length,
                created: results.created,
                updated: results.updated,
                skipped: results.errors.length,
                errors: results.errors.slice(0, 100),
                imported_by_id: req.user?.id || null,
                imported_by_name: req.user?.name || 'unknown'
            });
        } catch (histErr) {
            console.warn('StockImport record failed:', histErr.message);
        }

        res.json({ success: true, filename, ...results, import: importRecord ? normalizeImport(importRecord) : null });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error importing rows' });
    }
});

// --- Alerts: low stock + dead stock ---
app.get('/api/stock/imports', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const imports = await StockImport.find({}).sort({ created_at: -1 }).limit(50).lean();
        res.json(imports.map(normalizeImport));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list stock imports' });
    }
});

// Removes ONE upload-history record. History only - the items, quantities and
// stock movements the file produced are intentionally left alone, so this can
// never roll back real stock data.
app.delete('/api/stock/imports/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ error: 'Invalid file record id' });
        }
        const removed = await StockImport.findByIdAndDelete(req.params.id);
        if (!removed) return res.status(404).json({ error: 'File record not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error deleting file record' });
    }
});

app.get('/api/stock/alerts', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const deadDays = Math.max(1, Number(req.query.deadDays) || 30);
        const accessories = await Accessory.find({}).sort({ name: 1 });

        const lowStock = accessories
            .filter((a) => !a.is_service && Number(a.quantity || 0) <= Number(a.low_stock_threshold || 0))
            .map((a) => ({
                id: a._id.toString(),
                sku: a.sku,
                name: a.name,
                category: a.category,
                quantity: Number(a.quantity || 0),
                low_stock_threshold: Number(a.low_stock_threshold || 0)
            }));

        // Last sale date per accessory from the sales ledger.
        const lastSaleAgg = await Sale.aggregate([
            { $unwind: '$items' },
            { $match: { 'items.inventory_type': 'accessory' } },
            { $group: { _id: '$items.inventory_id', lastSaleAt: { $max: '$createdAt' } } }
        ]);
        const lastSaleMap = new Map(lastSaleAgg.map((r) => [String(r._id), r.lastSaleAt]));

        const now = Date.now();
        const deadStock = accessories
            .filter((a) => !a.is_service && Number(a.quantity || 0) > 0)
            .map((a) => {
                const lastSale = lastSaleMap.get(a._id.toString()) || a.added_at || a.createdAt;
                const days = lastSale ? Math.floor((now - new Date(lastSale).getTime()) / 86400000) : 9999;
                return {
                    id: a._id.toString(),
                    sku: a.sku,
                    name: a.name,
                    category: a.category,
                    quantity: Number(a.quantity || 0),
                    days_in_stock: days
                };
            })
            .filter((a) => a.days_in_stock >= deadDays)
            .sort((x, y) => y.days_in_stock - x.days_in_stock);

        res.json({ lowStock, deadStock, deadDays, generatedAt: new Date().toISOString() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error loading alerts' });
    }
});

// =============================================
// SALES / BILLING
// =============================================

app.get('/api/sales/config', authenticateToken, (req, res) => {
    res.json({ discountApprovalLimitPercent: SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT });
});

app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { q = '', cashierId = '' } = req.query;
        const filter = {};

        if (!isAdminOrShopOwner(req.user.role)) {
            filter.cashier_id = req.user.id;
        } else if (cashierId) {
            filter.cashier_id = cashierId;
        }

        if (q && q.trim()) {
            const term = q.trim();
            filter.$or = [
                { receipt_no: { $regex: term, $options: 'i' } },
                { cashier_name: { $regex: term, $options: 'i' } },
                { cashier_role: { $regex: term, $options: 'i' } },
                { payment_method: { $regex: term, $options: 'i' } }
            ];
        }

        const sales = await Sale.find(filter).sort({ createdAt: -1 }).limit(200);
        res.json(sales.map(normalizeSale));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching sales' });
    }
});

app.get('/api/sales/:id', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const sale = await Sale.findById(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        if (!isAdminOrShopOwner(req.user.role) && sale.cashier_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        res.json(normalizeSale(sale));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching sale' });
    }
});

// Delete sales data (Admin/Shop Owner only)
// Supports optional date range: ?from=YYYY-MM-DD&to=YYYY-MM-DD
// Also supports deleting a single sale by id: /api/sales/:id (DELETE)
app.delete('/api/sales', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { from = '', to = '', cashierId = '' } = req.query;
        const filter = {};

        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
            if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
        }
        if (cashierId) filter.cashier_id = cashierId;

        const result = await Sale.deleteMany(filter);
        res.json({
            success: true,
            deletedCount: result.deletedCount || 0,
            message: `Deleted ${result.deletedCount || 0} sale record(s)`
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error deleting sales' });
    }
});

app.delete('/api/sales/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const sale = await Sale.findByIdAndDelete(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        res.json({ success: true, message: `Deleted sale ${sale.receipt_no}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error deleting sale' });
    }
});

// Initiate a refund. Cashiers route out-of-policy refunds to the approval queue.
// Exposed both as POST /api/refunds (modern) and via the legacy /api/sales/:id/refund wrapper.
const createRefundHandler = async (req, res) => {
    try {
        await connectDB();
        const { saleId, items, reason, reason_note, refund_method, movement_date } = req.body;
        if (!saleId) return res.status(400).json({ error: 'saleId is required' });
        if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item must be selected' });
        if (!REFUND_REASONS.includes(reason || '')) return res.status(400).json({ error: 'Invalid reason' });
        if (String(reason).trim() === 'Other' && !reason_note) return res.status(400).json({ error: 'reason_note is required when reason is Other' });

        const sale = await Sale.findById(saleId);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        if (sale.refunded === true) return res.status(400).json({ error: 'This sale has already been fully refunded' });

        const originalMethod = String(sale.payment_method || '').toUpperCase();
        const refundMethod = String(refund_method || originalMethod).toUpperCase();
        if (!REFUND_METHODS.includes(refundMethod)) return res.status(400).json({ error: 'Invalid refund method' });

        // Per-item quantity validation (<= sold qty - already refunded)
        const refundedTotals = await getRefundedTotals(sale._id);
        const itemsMap = new Map((sale.items || []).map((i) => [`${i.inventory_type}:${i.inventory_id}`, i]));
        let subtotal = 0; const normalizedItems = [];
        for (const sel of items) {
            const sType = String(sel.inventory_type || ''); const sId = String(sel.inventory_id || '');
            const original = itemsMap.get(`${sType}:${sId}`);
            if (!original) return res.status(400).json({ error: `Item ${sType}:${sId} not found in the original sale` });
            const remaining = Math.max(0, Number(original.quantity || 0) - Number(refundedTotals.get(`${sType}:${sId}`) || 0));
            const requested = Number(sel.quantity || 0);
            if (requested <= 0) return res.status(400).json({ error: `Quantity must be greater than zero for ${original.name}` });
            if (requested > remaining) return res.status(400).json({ error: `Cannot refund more than remaining (${remaining}) for ${original.name}` });
            const unit_price = Number(sel.unit_price != null ? sel.unit_price : original.unit_price || 0);
            const line_total = Math.round((unit_price * requested) * 100) / 100;
            subtotal += line_total;
            normalizedItems.push({ inventory_type: sType, inventory_id: sId, name: original.name || sel.name || '', sku: original.sku || sel.sku || '', imei: original.imei || sel.imei || '', unit_price, quantity: requested, line_total });
        }
        const total = Math.round(subtotal * 100) / 100;

        const policy = await getRefundPolicy();
        const isAdminOrOwner = isAdminOrShopOwner(req.user.role);
        const daysSince = diffDays(new Date(sale.createdAt || sale.created_at || Date.now()));
        const withinDays = daysSince <= Number(policy.maxDays || DEFAULT_REFUND_POLICY.maxDays);
        const withinAmount = total <= Number(policy.maxAmount || DEFAULT_REFUND_POLICY.maxAmount);
        const sameMethodOk = !policy.sameMethodRequired || refundMethod === originalMethod || isAdminOrOwner;
        const needsApproval = !isAdminOrOwner && (!withinDays || !withinAmount || !sameMethodOk);

        const refund = await Refund.create({
            sale_id: sale._id.toString(), sale_receipt_no: sale.receipt_no, refund_reference: formatRefundRef(),
            items: normalizedItems, subtotal, total, reason, reason_note: reason_note || '',
            refund_method: refundMethod, original_payment_method: originalMethod,
            initiated_by_id: req.user.id ? String(req.user.id) : '', initiated_by_name: (req.user.name || '').toString(),
            requires_approval: needsApproval, approval_status: needsApproval ? 'PENDING' : 'DIRECT',
            session_id: sale.session_id ? String(sale.session_id) : '',
            // Store as an ISO date (YYYY-MM-DD): the refunds report and the
            // cash-session summary string-match this field against ranges.
            movement_date: new Date(movement_date || Date.now()).toISOString().slice(0, 10)
        });

        if (!needsApproval) {
            await applyRefundEffects(refund, req.user);
            recordLocalOp('refunds', 'create', refund.refund_reference, { status: 'APPLIED', total, sale: sale.receipt_no });
            return res.status(201).json({ success: true, status: 'APPLIED', refund: normalizeRefund(refund) });
        }
        recordLocalOp('refunds', 'create', refund.refund_reference, { status: 'PENDING', total, sale: sale.receipt_no });
        return res.status(201).json({ success: true, status: 'PENDING', refund: normalizeRefund(refund) });
    } catch (err) {
        console.error('[refund create]', err);
        res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message || 'Failed to initiate refund' });
    }
};
app.post('/api/refunds', authenticateToken, (req, res) => { createRefundHandler(req, res).catch((e) => res.status(500).json({ error: e.message || 'Failed to initiate refund' })); });
// Cashiers may initiate refunds; the approval policy above routes out-of-policy
// refunds to PENDING (admin/shop-owner approval), otherwise they apply DIRECTly.
// (applyRefundEffects is defined below; request-time calls resolve after module load)
// =============================================================
// REFUNDS (full flow: partial/full, per-item qty, reasons,
// approval policy, same/cross-method handling, stock + cash +
// revenue reversal, warranty, printable receipt, reporting)
// =============================================================

const ObjectNotFoundError = (msg) => { const e = new Error(msg); e.code = 'NOT_FOUND'; return e; };

// Apply the stock / sale / cash-session effects for an APPROVED (or DIRECT) refund.
const applyRefundEffects = async (refund, approver) => {
    const sale = await Sale.findById(refund.sale_id);
    if (!sale) throw ObjectNotFoundError('Sale not found');

    for (const item of refund.items) {
        const iType = String(item.inventory_type || '');
        const iId = item.inventory_id;
        if (iType === 'accessory' && iId) {
            const accessory = await Accessory.findById(iId);
            if (accessory && !accessory.is_service) {
                const qty = Math.max(0, Number(item.quantity || 0));
                accessory.quantity = Math.max(0, Number(accessory.quantity || 0) + qty);
                await accessory.save();
                await logStockMovement({
                    accessory, type: 'REFUND',
                    quantityChange: qty, resultingQuantity: Number(accessory.quantity || 0),
                    reason: refund.reason || 'Sale refund',
                    note: `Refund ${refund.refund_reference} of receipt ${refund.sale_receipt_no}`,
                    reference: refund.refund_reference, user: approver, localKey: null
                });
            }
        } else if (iType === 'phone' && iId) {
            const phone = await Phone.findById(iId);
            if (phone) {
                const imeiMatch = String(phone.imei || '') === String(item.imei || '');
                if (imeiMatch) {
                    phone.status = 'Available'; phone.warranty = 'None'; phone.warranty_end_date = null;
                    await phone.save();
                    await RepairJob.updateOne(
                        { imei: phone.imei, repair_status: { $ne: 'Completed' } },
                        { $set: { warranty_end_date: null, refund_note: `IMEI ${phone.imei} refunded via ${refund.refund_reference}` } }
                    );
                } else if (phone.status === 'Sold') { phone.status = 'Available'; await phone.save(); }
            }
        }
    }

    const refundedTotals = await getRefundedTotals(sale._id);
    let fullyRefunded = Array.isArray(sale.items) && sale.items.length > 0;
    for (const original of (sale.items || [])) {
        const key = `${original.inventory_type}:${original.inventory_id}`;
        if (Number(refundedTotals.get(key) || 0) < Number(original.quantity || 0)) { fullyRefunded = false; break; }
    }
    if (fullyRefunded) { sale.refunded = true; sale.refunded_at = sale.refunded_at || new Date(); }
    sale.refunded_by_id = approver.id ? String(approver.id) : (sale.refunded_by_id || '');
    sale.refunded_by_name = (approver.name || '').toString() || sale.refunded_by_name || '';
    sale.refund_reason = sale.refund_reason || refund.reason;
    await sale.save();

    // Cash session adjustment: a REFUND movement removes cash from the day's expected float.
    await CashMovement.create({
        local_id: null,
        cashier_id: String(sale.cashier_id || ''),
        cashier_name: (sale.cashier_name || '') || (approver.name || '') || '',
        movement_type: 'REFUND',
        amount: Number(refund.total || 0),
        note: `Refund ${refund.refund_reference} of receipt ${sale.receipt_no} (${refund.refund_method})`,
        movement_date: refund.movement_date
    });

    refund.approved_by_id = approver.id ? String(approver.id) : '';
    refund.approved_by_name = (approver.name || '').toString();
    refund.approved_at = new Date();
    await refund.save();
};
// >>> REFUND_NEW routes (approve / reject / pending / search + legacy wrapper) <<<

// Approve a pending refund (admin / shop owner). PIN gate if configured.
app.post('/api/refunds/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const refund = await Refund.findById(req.params.id);
        if (!refund) return res.status(404).json({ error: 'Refund not found' });
        if (refund.approval_status !== 'PENDING') return res.status(400).json({ error: 'Only pending refunds can be approved' });

        const pinDoc = await StoreSetting.findOne({ key: 'admin_refund_pin' });
        // The setting may be stored as a bare string or wrapped ({ value: pin }).
        const storedPinRaw = pinDoc ? pinDoc.value : null;
        const storedPin = String((storedPinRaw && typeof storedPinRaw === 'object') ? (storedPinRaw.value ?? '') : (storedPinRaw ?? ''));
        if (storedPin && req.user.role !== 'shop_owner' && storedPin !== String(req.body.approver_pin || '')) {
            return res.status(403).json({ error: 'Valid admin approval PIN required' });
        }

        refund.approval_status = 'APPROVED'; refund.requires_approval = true;
        await refund.save();
        await applyRefundEffects(refund, req.user);
        recordLocalOp('refunds', 'approve', refund.refund_reference, { total: Number(refund.total || 0) });
        res.json({ success: true, status: 'APPROVED', refund: normalizeRefund(refund) });
    } catch (err) {
        console.error('[refund approve]', err);
        res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message || 'Failed to approve refund' });
    }
});

// Reject a pending refund.
app.post('/api/refunds/:id/reject', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const refund = await Refund.findById(req.params.id);
        if (!refund) return res.status(404).json({ error: 'Refund not found' });
        if (refund.approval_status !== 'PENDING') return res.status(400).json({ error: 'Only pending refunds can be rejected' });
        refund.approval_status = 'REJECTED'; refund.rejection_reason = req.body.reason || '';
        await refund.save();
        recordLocalOp('refunds', 'reject', refund.refund_reference, { reason: String(req.body.reason || '') });
        res.json({ success: true, status: 'REJECTED', refund: normalizeRefund(refund) });
    } catch (err) {
        console.error('[refund reject]', err);
        res.status(500).json({ error: err.message || 'Failed to reject refund' });
    }
});

// Pending approval queue (admin / shop owner).
app.get('/api/refunds/pending', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const rows = await Refund.find({ approval_status: 'PENDING' }).sort({ initiated_at: -1 });
        res.json(rows.map((r) => normalizeRefund(r)));
    } catch (err) {
        console.error('[refunds pending]', err);
        res.status(500).json({ error: 'Failed to load pending refunds' });
    }
});

// Refunds search (used by Sales History + the Refunds Report).
app.get('/api/refunds', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { saleId, receipt_no, from, to, status = 'ALL', page, limit } = req.query;
        const filter = {};
        if (saleId) filter.sale_id = saleId;
        if (receipt_no) filter.sale_receipt_no = receipt_no;
        if (from && to) filter.movement_date = { $gte: from, $lte: to };
        if (status !== 'ALL') filter.approval_status = status;
        const query = Refund.find(filter).sort({ movement_date: -1, createdAt: -1 });
        if (Number(page) > 0 && Number(limit) > 0) query.skip((Number(page) - 1) * Number(limit)).limit(Number(limit));
        const [rows, total] = await Promise.all([query, Refund.countDocuments(filter)]);
        res.json({ refunds: rows.map((r) => normalizeRefund(r)), total, count: rows.length });
    } catch (err) {
        console.error('[refunds search]', err);
        res.status(500).json({ error: 'Failed to search refunds' });
    }
});

// Refund approval policy (readable by any authenticated user so the UI can show
// whether a given refund needs admin approval).
app.get('/api/refunds/policy', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const policy = await getRefundPolicy();
        res.json(policy);
    } catch (err) { console.error('[refund policy]', err); res.status(500).json({ error: 'Failed to load refund policy' }); }
});

// Legacy whole-sale refund wrapper (backward compat) -> delegates to the full flow.
app.post('/api/sales/:id/refund', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const sale = await Sale.findById(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        req.body.saleId = sale._id.toString();
        req.body.items = (sale.items || []).map((i) => ({
            inventory_type: i.inventory_type, inventory_id: String(i.inventory_id),
            name: i.name, sku: i.sku, unit_price: i.unit_price, quantity: Number(i.quantity || 1)
        }));
        if (!req.body.reason) req.body.reason = 'Other';
        if (!req.body.refund_method) req.body.refund_method = String(sale.payment_method || '').toUpperCase();
        req.body.movement_date = req.body.movement_date || new Date().toISOString().slice(0, 10);
        return createRefundHandler(req, res);
    } catch (err) { res.status(500).json({ error: err.message || 'Failed to refund sale' }); }
});

// Generic store-setting read/write (refund policy + admin pin live here).
app.get('/api/store-settings/:key', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const doc = await StoreSetting.findOne({ key: req.params.key });
        res.json(doc ? doc.value : null);
    } catch (err) { res.status(500).json({ error: 'Failed to read store setting' }); }
});
app.put('/api/store-settings/:key', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const doc = await StoreSetting.findOneAndUpdate(
            { key: req.params.key }, { key: req.params.key, value: req.body },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.json(doc.value);
    } catch (err) { res.status(500).json({ error: 'Failed to save store setting' }); }
});


app.post('/api/sales/checkout', authenticateToken, async (req, res) => {
    const {
        items,
        paymentMethod,
        paymentDetails,
        cashReceived = 0,
        discountAmount = 0,
        approvalNote = '',
        sessionId,
        clientLocalId
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Cart cannot be empty' });
    }

    const normalizedPaymentMethod = String(paymentMethod || '').trim().toUpperCase();
    const allowedPaymentMethods = ['CASH', 'CARD', 'BANK_TRANSFER', 'SPLIT'];
    if (!allowedPaymentMethods.includes(normalizedPaymentMethod)) {
        return res.status(400).json({ error: 'Invalid payment method' });
    }

    const sanitizedDiscount = Number(discountAmount || 0);
    if (Number.isNaN(sanitizedDiscount) || sanitizedDiscount < 0) {
        return res.status(400).json({ error: 'Discount must be a valid positive number' });
    }

    // Use session for transaction if MongoDB replica set available, otherwise sequential ops
    try {
        await connectDB();
        // Idempotency: if this same sale (by its device token) was already
        // recorded — e.g. the background sync raced the immediate push, or a
        // network retry re-sent it — return the existing record instead of
        // creating it again (which would double-charge and double-deduct stock).
        if (clientLocalId) {
            const existing = await Sale.findOne({ client_local_id: clientLocalId });
            if (existing) {
                return res.json({ existing: true, sale: normalizeSale(existing), receipt: normalizeSale(existing), message: 'Sale already recorded' });
            }
        }
        let subtotal = 0;
        const normalizedItems = [];
        // Generated up-front so sale items can reference it in stock movements.
        const receiptNo = formatReceiptNo();

        for (const rawItem of items) {
            const itemType = String(rawItem.inventoryType || '').toLowerCase();
            const inventoryId = String(rawItem.inventoryId || '');

            if (!inventoryId || !['phone', 'accessory'].includes(itemType)) {
                throw new Error('Invalid cart item');
            }

            if (itemType === 'phone') {
                const phone = await Phone.findById(inventoryId);
                if (!phone) throw new Error('Phone item not found');
                if (phone.status === 'Sold') throw new Error(`${phone.brand} ${phone.model} is already sold`);

                const unitPrice = Number(phone.selling_price);
                subtotal += unitPrice;

                normalizedItems.push({
                    inventory_type: 'phone',
                    inventory_id: phone._id.toString(),
                    imei: phone.imei,
                    sku: null,
                    name: `${phone.brand} ${phone.model}`,
                    quantity: 1,
                    unit_price: unitPrice,
                    line_total: unitPrice,
                    tracked_by: 'IMEI'
                });

                phone.status = 'Sold';
                await phone.save();
            } else {
                const accessory = await Accessory.findById(inventoryId);
                if (!accessory) throw new Error('Accessory item not found');

                const quantity = Math.max(1, Number(rawItem.quantity || 1));
                if (quantity !== Math.floor(quantity)) throw new Error('Accessory quantity must be a whole number');
                if (accessory.quantity < quantity) throw new Error(`Not enough stock for ${accessory.name}`);

                const unitPrice = Number(accessory.sell_price);
                const lineTotal = unitPrice * quantity;
                subtotal += lineTotal;

                normalizedItems.push({
                    inventory_type: 'accessory',
                    inventory_id: accessory._id.toString(),
                    imei: null,
                    sku: accessory.sku,
                    name: accessory.name,
                    quantity,
                    unit_price: unitPrice,
                    line_total: lineTotal,
                    tracked_by: 'QTY'
                });

                accessory.quantity -= quantity;
                await accessory.save();

                // Immutable audit trail: every sale decrements via a movement.
                await logStockMovement({
                    accessory,
                    type: 'SALE',
                    quantityChange: -quantity,
                    resultingQuantity: Number(accessory.quantity),
                    reason: 'Sale',
                    note: `Sold ${quantity} x ${accessory.name}`,
                    reference: receiptNo,
                    user: req.user
                });
            }
        }

        if (sanitizedDiscount > subtotal) {
            throw new Error('Discount cannot exceed the sale subtotal');
        }

        const total = Math.max(0, subtotal - sanitizedDiscount);
        const discountPercent = subtotal > 0 ? (sanitizedDiscount / subtotal) * 100 : 0;
        const approvalRequired = discountPercent > SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT && !isAdminOrShopOwner(req.user.role);
        const approvalStatus = approvalRequired ? 'PENDING_APPROVAL' : (discountPercent > SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT ? 'APPROVED_BY_ADMIN' : 'NOT_REQUIRED');
        const cashTendered = normalizedPaymentMethod === 'CASH' ? Number(cashReceived || 0) : 0;
        const changeAmount = normalizedPaymentMethod === 'CASH' ? Math.max(0, cashTendered - total) : 0;
        if (normalizedPaymentMethod === 'CASH' && cashTendered < total - 0.01) {
            throw new Error('Cash received must cover the total amount');
        }

        const saleDoc = await Sale.create({
            // Only set client_local_id when provided: the field is uniquely
            // indexed and MongoDB treats two explicit nulls as duplicates.
            ...(clientLocalId ? { client_local_id: clientLocalId } : {}),
            receipt_no: receiptNo,
            cashier_id: req.user.id,
            cashier_name: req.user.name,
            cashier_role: req.user.role,
            items: normalizedItems,
            subtotal,
            discount_amount: sanitizedDiscount,
            discount_percent: discountPercent,
            total,
            payment_method: normalizedPaymentMethod,
            payment_details: paymentDetails || (normalizedPaymentMethod === 'CASH' ? { cash: cashTendered, change: changeAmount, cashReceived: cashTendered, change_amount: changeAmount } : null),
            cash_received: cashTendered,
            change_amount: changeAmount,
            approval_required: approvalRequired,
            approval_status: approvalStatus,
            approval_note: approvalNote || null,
            session_id: sessionId || null
        });

        recordLocalOp('sales', 'checkout', receiptNo, { total, paymentMethod: normalizedPaymentMethod, itemCount: normalizedItems.length });
        return res.status(201).json({
            sale: normalizeSale(saleDoc),
            receipt: normalizeSale(saleDoc),
            message: 'Sale completed and synced to cloud'
        });
    } catch (err) {
        // Concurrent duplicate (two pushes of the same sale landing together):
        // the unique index on client_local_id rejected the second create.
        // Return the already-recorded sale instead of a confusing error.
        if (clientLocalId && (err.code === 11000 || String(err.message || '').includes('E11000'))) {
            const existing = await Sale.findOne({ client_local_id: clientLocalId }).catch(() => null);
            if (existing) {
                return res.json({ existing: true, sale: normalizeSale(existing), receipt: normalizeSale(existing), message: 'Sale already recorded' });
            }
        }
        console.error(err);
        return res.status(400).json({ error: err.message || 'Unable to complete sale' });
    }
});

// =============================================
// OFFLINE SALE IMPORT (backup of offline-created sales)
// =============================================

// Used by the offline sync engine when a pending sale cannot go through the
// normal checkout (e.g. the item was already sold / stock changed on the
// server while the device was offline). It records the sale exactly as it was
// created on the POS device - preserving the ORIGINAL sale time - without
// applying any inventory side-effects. Idempotent per receipt_no.
app.post('/api/sales/import', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const s = req.body || {};
        if (!s.receipt_no || !Array.isArray(s.items)) {
            return res.status(400).json({ error: 'receipt_no and items are required' });
        }

        // Idempotent: if this receipt already exists, treat as success so the
        // client can mark its local copy as synced.
        const existing = await Sale.findOne({ receipt_no: s.receipt_no });
        if (existing) {
            return res.json({ sale: normalizeSale(existing), imported: false, message: 'Sale already exists' });
        }

        let createdAt = s.created_at ? new Date(s.created_at) : new Date();
        if (Number.isNaN(createdAt.getTime())) createdAt = new Date();

        const saleDoc = await Sale.create({
            receipt_no: String(s.receipt_no),
            cashier_id: s.cashier_id || req.user.id,
            cashier_name: s.cashier_name || req.user.name,
            cashier_role: s.cashier_role || req.user.role,
            items: s.items,
            subtotal: Number(s.subtotal || 0),
            discount_amount: Number(s.discount_amount || 0),
            discount_percent: Number(s.discount_percent || 0),
            total: Number(s.total || 0),
            payment_method: String(s.payment_method || 'CASH').toUpperCase(),
            payment_details: s.payment_details || null,
            cash_received: Number(s.cash_received || 0),
            change_amount: Number(s.change_amount || 0),
            approval_required: !!s.approval_required,
            approval_status: s.approval_status || 'NOT_REQUIRED',
            approval_note: s.approval_note || null,
            session_id: s.session_id || null,
            createdAt
        });

        recordLocalOp('sales', 'import', String(s.receipt_no), { total: Number(s.total || 0), cashier: s.cashier_name || req.user.name });
        res.status(201).json({ sale: normalizeSale(saleDoc), imported: true, message: 'Offline sale imported' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error importing sale' });
    }
});

// =============================================
// REPAIRS
// =============================================

const REPAIR_STATUS_FLOW = ['Received', 'Identifying', 'Awaiting Parts', 'In Repair', 'Ready for Pickup', 'Delivered'];

const getRepairStatusIndex = (status) => {
    const index = REPAIR_STATUS_FLOW.indexOf(status);
    return index >= 0 ? index : -1;
};

app.get('/api/repair-jobs', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { status = '', q = '' } = req.query;
        const filter = {};

        if (status) filter.repair_status = status;
        if (q && q.trim()) {
            const term = q.trim();
            filter.$or = [
                { customer_name: { $regex: term, $options: 'i' } },
                { imei: { $regex: term, $options: 'i' } },
                { phone_number: { $regex: term, $options: 'i' } }
            ];
        }

        const jobs = await RepairJob.find(filter).sort({ created_at: -1 });
        const parts = await RepairJobPart.find({});

        const repairJobs = await Promise.all(jobs.map(async (job) => {
            const jobParts = parts.filter(p => p.repair_job_id === job.id);

            return {
                id: job._id.toString(),
                job_no: job.job_no || null,
                customer_name: job.customer_name,
                phone_number: job.phone_number,
                device_model: job.device_model,
                imei: job.imei,
                reported_issue: job.reported_issue,
                items_left: job.items_left,
                received_date: job.received_date,
                estimated_cost: job.estimated_cost,
                estimated_completion_date: job.estimated_completion_date,
                repair_status: job.repair_status,
                warranty_period_months: job.warranty_period_months,
                warranty_end_date: job.warranty_end_date,
                advance_amount: Number(job.advance_amount || 0),
                payment_method: job.payment_method || '',
                payment_status: job.payment_status || 'UNPAID',
                created_at: job.created_at,
                parts: jobParts.map(p => ({
                    id: p._id.toString(),
                    repair_job_id: p.repair_job_id,
                    inventory_id: p.inventory_id,
                    part_name: p.part_name,
                    sku: p.sku,
                    quantity: p.quantity,
                    unit_cost: p.unit_cost,
                    total_cost: p.total_cost
                })),
                invoice: buildRepairInvoice(job, jobParts)
            };
        }));

        res.json(repairJobs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error fetching repair jobs' });
    }
});

app.post('/api/repair-jobs', authenticateToken, async (req, res) => {
    const { customer_name, phone_number, device_model, imei, reported_issue, items_left, received_date, estimated_cost, estimated_completion_date, warranty_period_months = 3, advance_amount = 0, payment_method = '' } = req.body;

    if (!customer_name || !phone_number || !device_model || !reported_issue || !estimated_completion_date) {
        return res.status(400).json({ error: 'Customer name, phone number, device model, issue, and estimated completion date are required.' });
    }

    // Single optional advance taken once at intake. Must be a non-negative
    // number; a payment method is required only when an advance is given.
    const advance = Number(advance_amount || 0);
    if (!Number.isFinite(advance) || advance < 0) {
        return res.status(400).json({ error: 'Advance amount must be a non-negative number.' });
    }
    const method = String(payment_method || '').trim().toUpperCase();
    if (advance > 0 && !['CASH', 'CARD', 'BANK_TRANSFER'].includes(method)) {
        return res.status(400).json({ error: 'Payment method (Cash / Card / Bank Transfer) is required when an advance is taken.' });
    }

    try {
        await connectDB();
        const warrantyMonths = Number(warranty_period_months || 3);
        const warrantyEnd = new Date(estimated_completion_date);
        const received = received_date || new Date().toISOString().slice(0, 10);
        warrantyEnd.setMonth(warrantyEnd.getMonth() + warrantyMonths);

        const job = await RepairJob.create({
            customer_name: String(customer_name).trim(),
            phone_number: String(phone_number).trim(),
            device_model: String(device_model).trim(),
            imei: imei ? String(imei).trim() : null,
            reported_issue: String(reported_issue).trim(),
            items_left: items_left || '',
            received_date: received,
            estimated_cost: Number(estimated_cost || 0),
            estimated_completion_date,
            warranty_period_months: warrantyMonths,
            warranty_end_date: warrantyEnd.toISOString().slice(0, 10),
            repair_status: 'Received',
            job_no: formatRepairJobNo(),
            advance_amount: advance,
            payment_method: advance > 0 ? method : '',
            payment_status: advance > 0 ? 'PARTIAL' : 'UNPAID',
            advance_received_at: advance > 0 ? new Date() : null,
            advance_received_by: advance > 0 ? (req.user.name || '') : ''
        });

        recordLocalOp('repair_jobs', 'create', job._id.toString(), { imei: job.imei, device_model: job.device_model, status: 'Received', advance });
        res.status(201).json({
            id: job._id.toString(),
            ...job.toObject(),
            parts: [],
            invoice: buildRepairInvoice(job, [])
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error creating repair job' });
    }
});

app.put('/api/repair-jobs/:id/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    if (!REPAIR_STATUS_FLOW.includes(status)) {
        return res.status(400).json({ error: 'Invalid repair status' });
    }

    try {
        await connectDB();
        const job = await RepairJob.findById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Repair job not found' });

        const currentIndex = getRepairStatusIndex(job.repair_status);
        const nextIndex = getRepairStatusIndex(status);

        if (nextIndex < currentIndex) {
            return res.status(400).json({ error: 'Status can only move forward in the workflow.' });
        }

        if (currentIndex >= 0 && nextIndex - currentIndex > 1) {
            return res.status(400).json({ error: 'Status changes must move to the next step only.' });
        }

        job.repair_status = status;
        job.updated_at = new Date();
        await job.save();

        const jobParts = await RepairJobPart.find({ repair_job_id: job.id });
        const partsTotal = jobParts.reduce((sum, part) => sum + Number(part.total_cost || 0), 0);
        const laborCost = Number(job.estimated_cost || 0);
        const total = laborCost + partsTotal;

        res.json({
            id: job._id.toString(),
            ...job.toObject(),
            invoice: {
                job_id: job._id.toString(),
                invoice_no: `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
                labor_cost: laborCost,
                parts_cost: partsTotal,
                total_cost: total,
                status: job.repair_status,
                created_at: job.created_at
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error updating repair status' });
    }
});

app.post('/api/repair-jobs/:id/parts', authenticateToken, async (req, res) => {
    const { inventoryId, quantity = 1 } = req.body;
    if (!inventoryId) {
        return res.status(400).json({ error: 'Spare part inventory ID is required.' });
    }

    try {
        await connectDB();
        const job = await RepairJob.findById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Repair job not found' });

        const part = await Accessory.findById(inventoryId);
        if (!part) return res.status(404).json({ error: 'Spare part not found' });

        const requestedQty = Math.max(1, Number(quantity) || 1);
        if (part.quantity < requestedQty) {
            return res.status(400).json({ error: `Not enough stock for ${part.name}.` });
        }

        const unitCost = Number(part.sell_price || 0);
        const totalCost = unitCost * requestedQty;

        part.quantity -= requestedQty;
        await part.save();

        // Audit trail: spare parts consumed by a repair job.
        await logStockMovement({
            accessory: part,
            type: 'ADJUSTMENT',
            quantityChange: -requestedQty,
            resultingQuantity: Number(part.quantity),
            reason: 'Other',
            note: `Used in repair job ${job._id.toString().slice(-6).toUpperCase()}`,
            reference: `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
            user: req.user
        });

        const newPart = await RepairJobPart.create({
            repair_job_id: job.id,
            inventory_id: part._id.toString(),
            part_name: part.name,
            sku: part.sku,
            quantity: requestedQty,
            unit_cost: unitCost,
            total_cost: totalCost
        });

        const jobParts = await RepairJobPart.find({ repair_job_id: job.id });
        const partsTotal = jobParts.reduce((sum, p) => sum + Number(p.total_cost || 0), 0);
        const laborCost = Number(job.estimated_cost || 0);
        const total = laborCost + partsTotal;

        res.status(201).json({
            job: {
                id: job._id.toString(),
                ...job.toObject(),
                invoice: {
                    job_id: job._id.toString(),
                    invoice_no: `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
                    labor_cost: laborCost,
                    parts_cost: partsTotal,
                    total_cost: total,
                    status: job.repair_status,
                    created_at: job.created_at
                }
            },
            part: {
                id: newPart._id.toString(),
                repair_job_id: newPart.repair_job_id,
                inventory_id: newPart.inventory_id,
                part_name: newPart.part_name,
                sku: newPart.sku,
                quantity: newPart.quantity,
                unit_cost: newPart.unit_cost,
                total_cost: newPart.total_cost
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error adding spare part' });
    }
});

app.get('/api/repair-jobs/:id/invoice', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const job = await RepairJob.findById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Repair job not found' });

        const jobParts = await RepairJobPart.find({ repair_job_id: job.id });
        res.json(buildRepairInvoice(job, jobParts));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching invoice' });
    }
});

// Final collection on delivery: records the remaining balance as paid.
// The single intake advance is NOT editable here — this endpoint only marks
// the outstanding balance collected (optionally updating the payment method
// used for the final payment).
app.post('/api/repair-jobs/:id/collect', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const job = await RepairJob.findById(req.params.id);
        if (!job) return res.status(404).json({ error: 'Repair job not found' });

        const jobParts = await RepairJobPart.find({ repair_job_id: job.id });
        const invoice = buildRepairInvoice(job, jobParts);
        const method = String(req.body.payment_method || job.payment_method || '').trim().toUpperCase();
        if (!['CASH', 'CARD', 'BANK_TRANSFER'].includes(method)) {
            return res.status(400).json({ error: 'Payment method (Cash / Card / Bank Transfer) is required to collect the balance.' });
        }
        job.payment_method = method;
        job.payment_status = 'PAID';
        job.updated_at = new Date();
        await job.save();
        recordLocalOp('repair_jobs', 'collect', job._id.toString(), { balance: invoice.balance_due, method });
        res.json({ ...buildRepairInvoice(job, jobParts), collected: invoice.balance_due });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error collecting repair balance' });
    }
});

app.get('/api/repair-warranty', authenticateToken, async (req, res) => {
    const { imei, jobId } = req.query;

    try {
        await connectDB();
        let job = null;
        if (jobId) {
            job = await RepairJob.findById(jobId);
        } else if (imei) {
            job = await RepairJob.findOne({ imei }).sort({ created_at: -1 });
        }

        if (!job) {
            return res.json({ found: false, status: 'NOT_FOUND' });
        }

        const warrantyEnd = job.warranty_end_date ? new Date(job.warranty_end_date) : null;
        const now = new Date();
        const isActive = warrantyEnd ? now <= warrantyEnd : false;

        res.json({
            found: true,
            job_id: job._id.toString(),
            imei: job.imei,
            customer_name: job.customer_name,
            warranty_period_months: job.warranty_period_months,
            warranty_end_date: job.warranty_end_date,
            status: isActive ? 'ACTIVE' : 'EXPIRED'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error checking repair warranty' });
    }
});

// =============================================
// CASH MOVEMENTS
// =============================================

app.get('/api/cash-movements', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { from = '', to = '', cashierId = '' } = req.query;
        const filter = {};

        if (from) filter.movement_date = { $gte: from };
        if (to) filter.movement_date = { ...filter.movement_date, $lte: to };
        if (cashierId) filter.cashier_id = cashierId;

        const rows = await CashMovement.find(filter).sort({ movement_date: -1, _id: -1 });
        res.json(rows.map(r => ({
            id: r._id.toString(),
            cashier_id: r.cashier_id,
            cashier_name: r.cashier_name,
            movement_type: r.movement_type,
            amount: r.amount,
            note: r.note,
            movement_date: r.movement_date,
            created_at: r.created_at
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Unable to load cash movements' });
    }
});

app.post('/api/cash-movements', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { cashierId = '', cashierName = '', movementType = 'RELOAD', amount = 0, note = '', movementDate = '' } = req.body;
        const normalizedType = String(movementType || 'RELOAD').toUpperCase();
        const allowedTypes = ['RELOAD', 'WITHDRAW', 'OPENING_BALANCE', 'CASH_IN', 'CASH_OUT'];
        if (!allowedTypes.includes(normalizedType)) {
            return res.status(400).json({ error: 'Invalid cash movement type' });
        }

        const normalizedAmount = Number(amount || 0);
        if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
            return res.status(400).json({ error: 'Amount must be greater than zero' });
        }

        const resolvedDate = movementDate || new Date().toISOString().slice(0, 10);
        const movement = await CashMovement.create({
            cashier_id: cashierId ? cashierId : null,
            cashier_name: cashierName || 'System',
            movement_type: normalizedType,
            amount: normalizedAmount,
            note: note || null,
            movement_date: resolvedDate
        });

        recordLocalOp('cash_movements', 'create', movement._id.toString(), { movement_type: normalizedType, amount: normalizedAmount });
        res.status(201).json({
            id: movement._id.toString(),
            cashier_id: movement.cashier_id,
            cashier_name: movement.cashier_name,
            movement_type: movement.movement_type,
            amount: movement.amount,
            note: movement.note,
            movement_date: movement.movement_date,
            created_at: movement.created_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Unable to save cash movement' });
    }
});

// =============================================
// REPORTS
// =============================================

app.get('/api/reports', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const now = new Date();
        const defaultFrom = new Date(now);
        defaultFrom.setDate(defaultFrom.getDate() - 30);

        const from = req.query.from || defaultFrom.toISOString().slice(0, 10);
        const to = req.query.to || now.toISOString().slice(0, 10);
        const deadDaysThreshold = Math.max(1, Number(req.query.deadDays || 30));

        const rangeStart = new Date(`${from}T00:00:00.000Z`);
        const rangeEnd = new Date(`${to}T23:59:59.999Z`);

                const [phones, accessories, saleRowsRange, saleRowsAll, deliveredRepairs, cashMovements, refundRows, stockInMovements, usersList, sessionsForPeriod] = await Promise.all([
            Phone.find({}),
            Accessory.find({}),
            Sale.find({ createdAt: { $gte: rangeStart, $lte: rangeEnd } }).sort({ createdAt: -1 }),
            Sale.find({}).sort({ createdAt: -1 }),
            RepairJob.find({ repair_status: 'Delivered', updated_at: { $gte: rangeStart, $lte: rangeEnd } }),
            CashMovement.find({ movement_date: { $gte: from, $lte: to } }),
            Refund.find({ movement_date: { $gte: from, $lte: to } }),
            StockMovement.find({ type: 'STOCK_IN', created_at: { $gte: rangeStart, $lte: rangeEnd } }),
            User.find({}),
            DailySession.find({ date: { $gte: from, $lte: to } }).sort({ date: -1 })
        ]);

        const phoneMap = new Map(phones.map((phone) => [phone._id.toString(), phone]));
        const accessoryMap = new Map(accessories.map((acc) => [acc._id.toString(), acc]));

        const soldLookup = new Map();
        saleRowsAll.forEach((row) => {
            (row.items || []).forEach((item) => {
                const key = `${item.inventory_type}:${item.inventory_id}`;
                if (!soldLookup.has(key) || new Date(row.createdAt) > new Date(soldLookup.get(key))) {
                    soldLookup.set(key, row.createdAt);
                }
            });
        });

        const deadStockItems = [];
        let totalDeadCapital = 0;

        phones.forEach((phone) => {
            if (phone.status !== 'In Stock') return;
            const key = `phone:${phone._id.toString()}`;
            const lastSoldAt = soldLookup.get(key) || null;
            const stockStart = phone.added_at || phone.created_at || now;
            const daysNoSale = diffDays(lastSoldAt || stockStart, now);
            if (daysNoSale < deadDaysThreshold) return;

            const daysInStock = diffDays(stockStart, now);
            const capital = Number(phone.purchase_price || 0);
            totalDeadCapital += capital;
            deadStockItems.push({
                category: String(phone.condition || '').toLowerCase().includes('used') ? 'Used Phones' : 'New Phones',
                item_name: `${phone.brand} ${phone.model}`,
                code: phone.imei,
                quantity: 1,
                days_in_stock: daysInStock,
                days_without_sale: daysNoSale,
                capital_locked: capital
            });
        });

        accessories.forEach((acc) => {
            const qty = Number(acc.quantity || 0);
            if (qty <= 0) return;
            const key = `accessory:${acc._id.toString()}`;
            const lastSoldAt = soldLookup.get(key) || null;
            const stockStart = acc.added_at || acc.created_at || now;
            const daysNoSale = diffDays(lastSoldAt || stockStart, now);
            if (daysNoSale < deadDaysThreshold) return;

            const daysInStock = diffDays(stockStart, now);
            const capital = Number(acc.cost_price || 0) * qty;
            totalDeadCapital += capital;
            deadStockItems.push({
                category: 'Accessories',
                item_name: acc.name,
                code: acc.sku,
                quantity: qty,
                days_in_stock: daysInStock,
                days_without_sale: daysNoSale,
                capital_locked: capital
            });
        });

        const deadStockByCategory = deadStockItems.reduce((acc, item) => {
            if (!acc[item.category]) acc[item.category] = [];
            acc[item.category].push(item);
            return acc;
        }, {});

        const salesByCategory = { 'New Phones': 0, 'Used Phones': 0, Accessories: 0, Repairs: 0 };

        const itemAggregate = new Map();
        const cashierAggregate = new Map();
        const cashierBalanceAggregate = new Map();

        saleRowsRange.forEach((row) => {
            const items = row.items || [];
            let saleRevenue = 0;
            let saleCost = 0;

            items.forEach((item) => {
                const qty = Number(item.quantity || 0);
                const revenue = Number(item.line_total || 0);
                saleRevenue += revenue;

                let unitCost = 0;
                let category = 'Accessories';

                if (item.inventory_type === 'phone') {
                    const phone = phoneMap.get(item.inventory_id);
                    unitCost = Number(phone?.purchase_price || 0);
                    category = String(phone?.condition || '').toLowerCase().includes('used') ? 'Used Phones' : 'New Phones';
                } else {
                    const acc = accessoryMap.get(item.inventory_id);
                    unitCost = Number(acc?.cost_price || 0);
                    category = 'Accessories';
                }

                const cost = unitCost * qty;
                saleCost += cost;
                salesByCategory[category] += revenue;

                const aggregateKey = `${item.name}::${item.inventory_type}`;
                const current = itemAggregate.get(aggregateKey) || { item_name: item.name, category: '', quantity_sold: 0, revenue: 0, cost: 0 };
                if (!current.category) current.category = current.category || category;
                current.quantity_sold += qty;
                current.revenue += revenue;
                current.cost += cost;
                itemAggregate.set(aggregateKey, current);
            });
                // per-product margin rows are built below from itemAggregate

            const cashierKey = `${row.cashier_id}`;
            const cashierCurrent = cashierAggregate.get(cashierKey) || { cashier_id: row.cashier_id, cashier_name: row.cashier_name, sales_total: 0, sale_count: 0 };
            cashierCurrent.sales_total += Number(row.total || 0);
            cashierCurrent.sale_count += 1;
            cashierAggregate.set(cashierKey, cashierCurrent);

            const saleDate = String(row.createdAt || '').slice(0, 10);
            const balanceKey = `${row.cashier_id}:${saleDate}`;
            const balanceCurrent = cashierBalanceAggregate.get(balanceKey) || {
                cashier_id: row.cashier_id,
                cashier_name: row.cashier_name,
                balance_date: saleDate,
                cash_from_sales: 0,
                cash_reload: 0,
                cash_withdrawn: 0,
                net_balance: 0
            };

            let cashContribution = 0;
            if (String(row.payment_method || '').toUpperCase() === 'CASH') {
                cashContribution = Number(row.cash_received || 0) - Number(row.change_amount || 0);
            } else if (String(row.payment_method || '').toUpperCase() === 'SPLIT') {
                cashContribution = Number(row.payment_details?.cash || row.payment_details?.cashReceived || 0);
            }

            balanceCurrent.cash_from_sales += cashContribution;
            cashierBalanceAggregate.set(balanceKey, balanceCurrent);
        });

        // ---- Refund reversal for revenue reports ----
        // Only APPROVED / DIRECT (already-applied) refunds reduce revenue. PENDING /
        // REJECTED refunds leave the original sale figures untouched.
        const categoryOfItem = (type, id) => {
            if (type === 'phone') {
                const ph = phoneMap.get(String(id));
                return ph && String(ph.condition || '').toLowerCase().includes('used') ? 'Used Phones' : 'New Phones';
            }
            return 'Accessories';
        };
        const appliedRefunds = refundRows.filter((r) => ['APPROVED', 'DIRECT'].includes(r.approval_status));
        const refundByDate = new Map();   // date -> { total, cash, card, bank, split }
        const refundByMethod = { CASH: 0, CARD: 0, BANK_TRANSFER: 0, SPLIT: 0 };
        appliedRefunds.forEach((r) => {
            const d = String(r.movement_date || r.created_at || '').slice(0, 10);
            const amt = Number(r.total || 0);
            const cur = refundByDate.get(d) || { total: 0, cash: 0, card: 0, bank: 0, split: 0 };
            cur.total += amt;
            const m = String(r.refund_method || 'CASH').toUpperCase();
            if (m === 'CASH') cur.cash += amt;
            else if (m === 'CARD') cur.card += amt;
            else if (m === 'BANK_TRANSFER') cur.bank += amt;
            else if (m === 'SPLIT') cur.split += amt;
            refundByDate.set(d, cur);
            if (refundByMethod[m] !== undefined) refundByMethod[m] += amt;

            // Cashier performance totals exclude refunded amounts.
            const cKey = String(r.initiated_by_id || r.approved_by_id || '');
            const cAgg = cashierAggregate.get(cKey) || { cashier_id: cKey, cashier_name: r.initiated_by_name || 'System', sales_total: 0, sale_count: 0 };
            cAgg.sales_total -= amt;
            cashierAggregate.set(cKey, cAgg);

            (r.items || []).forEach((it) => {
                const type = String(it.inventory_type || '');
                const cat = categoryOfItem(type, it.inventory_id);
                if (salesByCategory[cat] !== undefined) salesByCategory[cat] -= Number(it.line_total || 0);

                const key = `${it.name}::${type}`;
                const agg = itemAggregate.get(key);
                if (agg) {
                    let uc = 0;
                    if (type === 'phone') uc = Number((phoneMap.get(String(it.inventory_id)) || {}).purchase_price || 0);
                    else uc = Number((accessoryMap.get(String(it.inventory_id)) || {}).cost_price || 0);
                    agg.quantity_sold -= Number(it.quantity || 0);
                    agg.revenue -= Number(it.line_total || 0);
                    agg.cost -= uc * Number(it.quantity || 0);
                    itemAggregate.set(key, agg);
                }
            });
        });

        cashMovements.forEach((movement) => {
            const movementDate = String(movement.movement_date || '').slice(0, 10);
            const balanceKey = `${movement.cashier_id || 'system'}:${movementDate}`;
            const balanceCurrent = cashierBalanceAggregate.get(balanceKey) || {
                cashier_id: movement.cashier_id,
                cashier_name: movement.cashier_name || 'System',
                balance_date: movementDate,
                cash_from_sales: 0,
                cash_reload: 0,
                cash_withdrawn: 0,
                net_balance: 0
            };

            const amount = Number(movement.amount || 0);
            const type = String(movement.movement_type || '').toUpperCase();
            if (type === 'WITHDRAW' || type === 'CASH_OUT') {
                balanceCurrent.cash_withdrawn += amount;
            } else {
                balanceCurrent.cash_reload += amount;
            }
            cashierBalanceAggregate.set(balanceKey, balanceCurrent);
        });

        const cashierBalance = Array.from(cashierBalanceAggregate.values()).map((row) => ({
            ...row,
            net_balance: Number(row.cash_from_sales || 0) + Number(row.cash_reload || 0) - Number(row.cash_withdrawn || 0)
        })).sort((a, b) => `${b.balance_date}`.localeCompare(`${a.balance_date}`));

        const repairPartsRows = await RepairJobPart.find({});
        const repairPartsByJob = new Map();
        repairPartsRows.forEach((part) => {
            repairPartsByJob.set(part.repair_job_id, (repairPartsByJob.get(part.repair_job_id) || 0) + Number(part.total_cost || 0));
        });

        const repairTurnaroundDays = [];
        deliveredRepairs.forEach((job) => {
            const labor = Number(job.estimated_cost || 0);
            const parts = Number(repairPartsByJob.get(job.id) || 0);
            salesByCategory.Repairs += labor + parts;

            const receivedAt = job.received_date || job.created_at;
            const deliveredAt = job.updated_at;
            const turnaroundDays = diffDays(receivedAt, new Date(deliveredAt));
            repairTurnaroundDays.push(turnaroundDays);
        });

        const bestSelling = Array.from(itemAggregate.values())
            .sort((a, b) => b.quantity_sold - a.quantity_sold)
            .slice(0, 10)
            .map((p) => ({ item_name: p.item_name, category: p.category, quantity_sold: p.quantity_sold, revenue: Math.round(p.revenue * 100) / 100, days_without_sale: 0 }));

        const worstSelling = Array.from(itemAggregate.values())
            .sort((a, b) => a.quantity_sold - b.quantity_sold)
            .slice(0, 10)
            .map((p) => ({ item_name: p.item_name, category: p.category, quantity_sold: p.quantity_sold, revenue: Math.round(p.revenue * 100) / 100, days_without_sale: 0 }));

        // Profit & Margin report — per-product aggregation (item_name, category, qty, revenue, cost, profit, margin%).
        const marginRows = Array.from(itemAggregate.values())
            .map((p) => ({
                item_name: p.item_name,
                category: p.category,
                quantity_sold: p.quantity_sold,
                revenue: Math.round(p.revenue * 100) / 100,
                cost: Math.round(p.cost * 100) / 100,
                profit: Math.round((p.revenue - p.cost) * 100) / 100,
                margin_percent: p.revenue > 0 ? Math.round(((p.revenue - p.cost) / p.revenue) * 10000) / 100 : 0
            }))
            .sort((a, b) => b.profit - a.profit);

        const cashierPerformance = Array.from(cashierAggregate.values())
            .sort((a, b) => b.sales_total - a.sales_total);

        const avgTurnaround = repairTurnaroundDays.length
            ? repairTurnaroundDays.reduce((sum, days) => sum + days, 0) / repairTurnaroundDays.length
            : 0;

                // --- Payment type breakdown (Payment Type Report) ---
        const paymentBreakdown = { cash: 0, card: 0, bank_transfer: 0, reload: 0, split: 0, bank_transfer: 0 };
        saleRowsRange.forEach((row) => {
            const method = String(row.payment_method || '').toUpperCase();
            const total = Number(row.total || 0);
            if (method === 'CASH') paymentBreakdown.cash += (Number(row.cash_received || 0) - Number(row.change_amount || 0));
            else if (method === 'CARD') paymentBreakdown.card += total;
            else if (method === 'BANK_TRANSFER') paymentBreakdown.bank_transfer += total;
            else if (method === 'SPLIT') paymentBreakdown.split += total;
        });
        // Applied refunds reduce the payment-type totals (revenue is what the shop keeps).
        paymentBreakdown.cash -= refundByMethod.CASH;
        paymentBreakdown.card -= refundByMethod.CARD;
        paymentBreakdown.bank_transfer -= refundByMethod.BANK_TRANSFER;
        paymentBreakdown.split -= refundByMethod.SPLIT;

        // --- Daily Sales Report (per-date totals + payment method + session cross-ref) ---
        const dailyMap = new Map();
        const bump = (d, k, v) => { const r = dailyMap.get(d) || { date: d, sales: 0, orders: 0, cash: 0, card: 0, bank_transfer: 0, split: 0, reload_sales: 0, withdrawals: 0 }; r[k] = (r[k] || 0) + v; dailyMap.set(d, r); return r; };
        saleRowsRange.forEach((row) => {
            const dateStr = String(row.createdAt || row.created_at || '').slice(0, 10);
            const rec = bump(dateStr, 'sales', Number(row.total || 0));
            rec.orders += 1;
            const method = String(row.payment_method || '').toUpperCase();
            if (method === 'CASH') rec.cash += (Number(row.cash_received || 0) - Number(row.change_amount || 0));
            else if (method === 'CARD') rec.card += Number(row.total || 0);
            else if (method === 'BANK_TRANSFER') rec.bank_transfer += Number(row.total || 0);
            else if (method === 'SPLIT') { rec.split += Number(row.total || 0); rec.cash += Number(row.payment_details?.cash || row.payment_details?.cashReceived || 0); }
            dailyMap.set(dateStr, rec);
        });
        cashMovements.forEach((m) => {
            const d = String(m.movement_date || '').slice(0, 10);
            const rec = bump(d, 'sales', 0);
            const mt = String(m.movement_type || '').toUpperCase();
            if (mt === 'RELOAD' || mt === 'OPENING_BALANCE' || mt === 'CASH_IN') rec.reload_sales += Number(m.amount || 0);
            else if (mt === 'WITHDRAW' || mt === 'CASH_OUT' || mt === 'REFUND') rec.withdrawals += Number(m.amount || 0);
            dailyMap.set(d, rec);
        });
        // Applied refunds reduce that day's net sales (revenue is net of refunds).
        refundByDate.forEach((rf, d) => {
            const rec = dailyMap.get(d);
            if (!rec) return;
            rec.sales -= rf.total;
            rec.cash -= rf.cash;
            rec.card -= rf.card;
            rec.bank_transfer -= rf.bank;
            rec.split -= rf.split;
            dailyMap.set(d, rec);
        });
        const sessionByDate = new Map((sessionsForPeriod || []).map((s) => [String(s.date), s]));
        const dailySales = Array.from(dailyMap.values())
            .sort((a, b) => b.date.localeCompare(a.date))
            .map((rec) => {
                const sess = sessionByDate.get(rec.date);
                                return { ...rec, session_expected_cash: sess ? (Number(sess.opening_cash) + Number(rec.cash) - Number(rec.withdrawals)) : null };
            });

        // --- Refunds Report (summary; detailed list via /api/reports/refunds) ---
        const refundsList = (refundRows || []).map((r) => normalizeRefund(r));
        const totalRefunded = refundsList.reduce((sum, r) => sum + Number(r.total || 0), 0);
                // --- Purchases / Supplier Report (from Stock In movements) ---
        const supplierMap = new Map();
        const purchases = (stockInMovements || []).map((m) => {
            const acc = accessoryMap.get(String(m.accessory_id)) || accessoryMap.get(String(m.sku));
            const unitCost = Number((acc && acc.cost_price) || 0);
            const qty = Number(m.quantity_change || 0);
            const total = unitCost * qty;
            const supplier = m.note && /supplier[:\s]+([^,;\n]+)/i.test(String(m.note)) ? String(m.note).match(/supplier[:\s]+([^,;\n]+)/i)[1].trim() : 'Unattributed';
            const rec = supplierMap.get(supplier) || { supplier, total_spend: 0, quantity: 0 };
            rec.total_spend += total; rec.quantity += qty;
            supplierMap.set(supplier, rec);
            return { date: String(m.created_at || '').slice(0, 10), item_name: m.item_name, sku: m.sku, quantity: qty, unit_cost: unitCost, total_cost: total, supplier };
        });
        const supplierSpend = Array.from(supplierMap.values()).sort((a, b) => b.total_spend - a.total_spend);

        // --- Credit / Unpaid report (CreditNote OPEN balances) ---
        const creditNotes = await CreditNote.find({ status: 'OPEN' }).sort({ created_at: -1 }).catch(() => []);
        const totalOutstanding = creditNotes.reduce((sum, c) => sum + Number(c.balance || 0), 0);

        // --- User Activity / Audit Log ---
        const activity = [];
        cashMovements.forEach((m) => activity.push({ date: String(m.created_at || '').slice(0, 10), user_id: m.cashier_id || '', user_name: m.cashier_name || 'System', action: 'cash_movement', type: m.movement_type, amount: Number(m.amount || 0), note: m.note || '' }));
        refundRows.forEach((r) => activity.push({ date: String(r.created_at || '').slice(0, 10), user_id: r.initiated_by_id || r.approved_by_id || '', user_name: r.initiated_by_name || r.approved_by_name || '', action: 'refund', type: r.approval_status, amount: Number(r.total || 0), note: `${r.reason || ''} - ${r.refund_reference}` }));
        (sessionsForPeriod || []).forEach((s) => { activity.push({ date: String(s.date), user_id: s.opened_by || '', user_name: '', action: 'session_open', type: 'OPEN', amount: Number(s.opening_cash || 0), note: '' }); if (s.closed_by) activity.push({ date: String(s.closed_at || s.date), user_id: s.closed_by || '', user_name: '', action: 'session_close', type: 'CLOSED', amount: 0, note: `variance ${s.variance || 0}` }); });
        saleRowsRange.forEach((row) => { if (Number(row.discount_amount || 0) > 0) activity.push({ date: String(row.createdAt || '').slice(0, 10), user_id: row.cashier_id || '', user_name: row.cashier_name || '', action: 'discount_applied', type: String(row.payment_method), amount: Number(row.discount_amount || 0), note: `receipt ${row.receipt_no}` }); });
        stockInMovements.forEach((m) => activity.push({ date: String(m.created_at || '').slice(0, 10), user_id: m.user_id || '', user_name: m.user_name || '', action: 'stock_in', type: m.type, amount: Number(m.quantity_change || 0), note: `${m.item_name} (${m.sku})` }));
        saleRowsRange.forEach((row) => { activity.push({ date: String(row.createdAt || '').slice(0, 10), user_id: row.cashier_id || '', user_name: row.cashier_name || '', action: 'sale', type: String(row.payment_method), amount: Number(row.total || 0), note: `receipt ${row.receipt_no}` }); });
        activity.sort((a, b) => b.date.localeCompare(a.date));
        const cashiers = (usersList || []).filter((u) => u.role === 'cashier').map((u) => ({ id: u._id.toString(), name: u.name, role: u.role }));
        const allUsers = (usersList || []).map((u) => ({ id: u._id.toString(), name: u.name, role: u.role }));
        // NOTE: price changes are not individually audited in the current schema;
        // stock-ins, cash movements, refunds and discounts are tracked as above.
        // REPORT_EXTRA_B
        res.json({
            filters: { from, to, deadDays: deadDaysThreshold },
            dead_stock: {
                threshold_days: deadDaysThreshold,
                total_capital_locked: totalDeadCapital,
                by_category: deadStockByCategory,
                items: deadStockItems
            },
            sales_by_category: salesByCategory,
            profit_margin: marginRows,
            repair_turnaround: {
                delivered_jobs: repairTurnaroundDays.length,
                average_days: avgTurnaround
            },
                        cashier_balance: cashierBalance,
            best_selling: bestSelling,
            worst_selling: worstSelling,
            cashier_performance: cashierPerformance,
            payment_breakdown: paymentBreakdown,
            daily_sales: dailySales,
            sessions_for_period: sessionsForPeriod.map((s) => ({
                id: s._id.toString(), date: s.date, opening_cash: s.opening_cash,
                opening_reload: s.opening_reload, closing_cash: s.closing_cash,
                closing_reload: s.closing_reload, expected_cash: s.expected_cash,
                actual_cash: s.actual_cash, variance: s.variance, status: s.status,
                opened_by: s.opened_by, closed_by: s.closed_by, closed_at: s.closed_at
            })),
            refunds: refundsList,
            total_refunds: totalRefunded,
            purchases: purchases,
            supplier_spend: supplierSpend,
            credit_notes: creditNotes.map((c) => ({
                note_no: c.note_no, customer_name: c.customer_name, customer_phone: c.customer_phone,
                amount: c.amount, balance: c.balance, status: c.status, created_at: c.created_at
            })),
            total_credit_outstanding: totalOutstanding,
            user_activity_log: activity,
            cashiers: cashiers,
            users: allUsers,
            generated_at: new Date().toISOString()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Unable to generate reports' });
    }
});

app.get('/api/reports/transactions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { from, to, cashierId, page = 1, limit = 50 } = req.query;
        const p = Math.max(1, Number(page)); const l = Math.min(200, Math.max(1, Number(limit)));
        const match = {};
        if (from && to) match.createdAt = { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) };
        let query = Sale.find(match).sort({ createdAt: -1 });
        if (cashierId) query = query.where({ cashier_id: String(cashierId) });
        const [total, rows] = await Promise.all([Sale.countDocuments(match), query.skip((p - 1) * l).limit(l)]);
        const transactions = rows.map((s) => ({
            id: s._id.toString(), receipt_no: s.receipt_no, cashier_id: s.cashier_id, cashier_name: s.cashier_name,
            date: String(s.createdAt || s.created_at || '').slice(0, 10),
            total: Number(s.total || 0), payment_method: s.payment_method,
            cash_received: Number(s.cash_received || 0), change_amount: Number(s.change_amount || 0),
            discount_amount: Number(s.discount_amount || 0), refunded: !!s.refunded
        }));
        res.json({ transactions, total, page: p, limit: l });
    } catch (err) { console.error('[reports transactions]', err); res.status(500).json({ error: 'Failed to load transactions' }); }
});

app.get('/api/reports/refunds', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { from, to, status = 'ALL', page = 1, limit = 50 } = req.query;
        const p = Math.max(1, Number(page)); const l = Math.min(200, Math.max(1, Number(limit)));
        const filter = {};
        if (from && to) filter.movement_date = { $gte: from, $lte: to };
        if (status !== 'ALL') filter.approval_status = status;
        const [total, rows] = await Promise.all([Refund.countDocuments(filter), Refund.find(filter).sort({ movement_date: -1, createdAt: -1 }).skip((p - 1) * l).limit(l)]);
        const refunds = rows.map((r) => ({ ...normalizeRefund(r), date: String(r.created_at || r.movement_date || '').slice(0, 10) }));
        res.json({ refunds, total, count: refunds.length, total_refunded: refunds.reduce((s, r) => s + Number(r.total || 0), 0), page: p, limit: l });
    } catch (err) { console.error('[reports refunds]', err);     res.status(500).json({ error: 'Failed to load refunds' }); }
});

app.get('/api/reports/user-activity', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { from, to, userId, page = 1, limit = 50 } = req.query;
        const p = Math.max(1, Number(page)); const l = Math.min(200, Math.max(1, Number(limit)));
        const match = {};
        if (from && to) match.createdAt = { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) };
        const [movements, refundsAct, sessionsAct, salesAct] = await Promise.all([
            CashMovement.find(match).sort({ created_at: -1 }),
            Refund.find(from && to ? { movement_date: { $gte: from, $lte: to } } : {}).sort({ initiated_at: -1 }),
            (from && to) ? DailySession.find({ date: { $gte: from, $lte: to } }).sort({ date: -1 }) : DailySession.find({}).sort({ date: -1 }),
            Sale.find(match).sort({ createdAt: -1 })
        ]);
        const activity = [];
        movements.forEach((m) => activity.push({ date: String(m.created_at || '').slice(0, 10), user_id: m.cashier_id || '', user_name: m.cashier_name || 'System', action: 'cash_movement', type: m.movement_type, amount: Number(m.amount || 0), note: m.note || '' }));
        refundsAct.forEach((r) => activity.push({ date: String(r.created_at || '').slice(0, 10), user_id: r.initiated_by_id || r.approved_by_id || '', user_name: r.initiated_by_name || r.approved_by_name || '', action: 'refund', type: r.approval_status, amount: Number(r.total || 0), note: `RFS ${r.refund_reference} - ${r.reason || ''}` }));
        sessionsAct.forEach((s) => { activity.push({ date: String(s.date), user_id: s.opened_by || '', user_name: '', action: 'session_open', type: 'OPEN', amount: Number(s.opening_cash || 0), note: '' }); if (s.closed_by) activity.push({ date: String(s.closed_at || s.date), user_id: s.closed_by || '', user_name: '', action: 'session_close', type: 'CLOSED', amount: 0, note: `variance ${s.variance || 0}` }); });
        salesAct.forEach((row) => { if (Number(row.discount_amount || 0) > 0) activity.push({ date: String(row.createdAt || '').slice(0, 10), user_id: row.cashier_id || '', user_name: row.cashier_name || '', action: 'discount_applied', type: String(row.payment_method), amount: Number(row.discount_amount || 0), note: `receipt ${row.receipt_no}` }); });
        activity.sort((a, b) => b.date.localeCompare(a.date));
        const filtered = userId ? activity.filter((a) => a.user_id === String(userId)) : activity;
        const paged = filtered.slice((p - 1) * l, (p - 1) * l + l);
        res.json({ activity: paged, total: filtered.length, page: p, limit: l });
    } catch (err) { console.error('[reports user-activity]', err); res.status(500).json({ error: 'Failed to load user activity' }); }
});

// =============================================
// SESSIONS
// =============================================

app.get('/api/sessions/current', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const session = await DailySession.findOne({ status: 'open' }).sort({ created_at: -1 });
        if (!session) return res.json(null);

        const sales = await Sale.find({ session_id: session.id });

                let totalCashSales = 0;
        let totalCardSales = 0;
        let totalBankTransfer = 0;
        sales.forEach(sale => {
            const method = String(sale.payment_method || '').toUpperCase();
            if (method === 'CASH') {
                totalCashSales += (Number(sale.cash_received || 0) - Number(sale.change_amount || 0));
            } else if (method === 'CARD') {
                totalCardSales += Number(sale.total || 0);
            } else if (method === 'BANK_TRANSFER') {
                totalBankTransfer += Number(sale.total || 0);
            } else if (method === 'SPLIT') {
                totalCashSales += Number(sale.payment_details?.cash || sale.payment_details?.cashReceived || 0);
                totalCardSales += Number(sale.payment_details?.card || 0);
                totalBankTransfer += Number(sale.payment_details?.bankTransfer || 0);
            }
        });

        // Refunds issued against this session remove cash from the day's expected float.
        const refundMovements = await CashMovement.find({
            movement_type: 'REFUND',
            movement_date: session.date,
            ...(session.opened_by ? { cashier_id: String(session.opened_by) } : {})
        });
        const totalRefunds = refundMovements.reduce((sum, m) => sum + Number(m.amount || 0), 0);

        const expectedCash = (session.opening_cash || 0) + totalCashSales - totalRefunds;

        res.json({
            ...session.toObject(),
            id: session._id.toString(),
            summary: { totalCashSales, totalCardSales, totalBankTransfer, expectedCash }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error fetching current session' });
    }
});

app.post('/api/sessions/open', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { openingCash, openingReload } = req.body;

        const openSession = await DailySession.findOne({ status: 'open' }).sort({ created_at: -1 });
        if (openSession) {
            return res.status(400).json({ error: 'A session is already open. Please close it first.' });
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const session = await DailySession.create({
            date: dateStr,
            opening_cash: Number(openingCash || 0),
            opening_reload: Number(openingReload || 0),
            opened_by: req.user.id,
            status: 'open'
        });

        recordLocalOp('daily_sessions', 'open', session._id.toString(), { date: dateStr, opening_cash: session.opening_cash });
        res.status(201).json({ ...session.toObject(), id: session._id.toString() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error opening session' });
    }
});

app.post('/api/sessions/close', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const { id, actualCash, actualReload } = req.body;

        const session = await DailySession.findOne({ _id: id, status: 'open' });
        if (!session) {
            return res.status(404).json({ error: 'Open session not found.' });
        }

        const sales = await Sale.find({ session_id: session.id });

        let totalCashSales = 0;
        let totalCardSales = 0;
        sales.forEach(sale => {
            const method = String(sale.payment_method || '').toUpperCase();
            if (method === 'CASH') {
                totalCashSales += (Number(sale.cash_received || 0) - Number(sale.change_amount || 0));
            } else if (method === 'CARD') {
                totalCardSales += Number(sale.total || 0);
            } else if (method === 'SPLIT') {
                totalCashSales += Number(sale.payment_details?.cash || sale.payment_details?.cashReceived || 0);
                totalCardSales += Number(sale.payment_details?.card || 0);
            }
        });

                const actualReloadNum = Number(actualReload || 0);
        const reloadsSold = Math.max(0, session.opening_reload - actualReloadNum);

        // Refunds issued against this session remove cash from the day's expected float.
        const refundMovements = await CashMovement.find({
            movement_type: 'REFUND',
            movement_date: session.date,
            ...(session.opened_by ? { cashier_id: String(session.opened_by) } : {})
        });
        const totalRefunds = refundMovements.reduce((sum, m) => sum + Number(m.amount || 0), 0);

        const expectedCash = (session.opening_cash || 0) + totalCashSales + reloadsSold - totalRefunds;
        const actualCashNum = Number(actualCash || 0);
        const variance = actualCashNum - expectedCash;

        session.closing_cash = actualCashNum;
        session.closing_reload = actualReloadNum;
        session.expected_cash = expectedCash;
        session.actual_cash = actualCashNum;
        session.variance = variance;
        session.status = 'closed';
        session.closed_by = req.user.id;
        session.closed_at = new Date();
        await session.save();

        recordLocalOp('daily_sessions', 'close', session._id.toString(), { date: session.date, variance });
        res.json({
            ...session.toObject(),
            id: session._id.toString(),
            summary: { totalCashSales, totalCardSales }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error closing session' });
    }
});

app.get('/api/sessions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const sessions = await DailySession.find({}).sort({ date: -1, _id: -1 });
        res.json(sessions.map(s => ({ ...s.toObject(), id: s._id.toString() })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error fetching sessions' });
    }
});

// =============================================
// HEALTH + SYNC STATUS
// =============================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nangi POS Backend is running' });
});

// Combined DB status: online (MongoDB) + local (SQLite). The dashboard uses the
// `onlineOnly` flag to warn when the system is running only against the cloud
// because no local SQLite database is available on this host.
app.get('/api/system/db-status', authenticateToken, async (req, res) => {
    try {
        const mongoConnected = mongoose.connection.readyState === 1;
        const local = await localDb.getStatus();
        res.json({
            mongo: {
                configured: Boolean(MONGO_URI),
                connected: mongoConnected
            },
            local,
            onlineOnly: mongoConnected && !local.available
        });
    } catch (err) {
        console.error('[db-status]', err);
        res.status(500).json({ error: 'Failed to read database status' });
    }
});

// Admin action: (re)initialize / open the local SQLite database. On hosts with
// a read-only filesystem (e.g. Vercel serverless functions) this reports why
// the local database cannot be created so admins know the system is online-only.
app.post('/api/system/local-db/init', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await localDb.ensure();
        const local = await localDb.getStatus();
        if (!local.available) {
            return res.status(400).json({
                success: false,
                error: local.error || 'Local SQLite database is not available on this host',
                onlineOnly: true
            });
        }
        res.json({
            success: true,
            path: local.path,
            tables: local.tables,
            legacy: local.legacy
        });
    } catch (err) {
        console.error('[local-db init]', err);
        res.status(500).json({ error: err.message || 'Failed to initialize the local SQLite database' });
    }
});

app.get('/api/sync-status', authenticateToken, async (req, res) => {
    try {
        await connectDB();
        const pendingCounts = {
            users: await User.countDocuments({}),
            inventory_phones: await Phone.countDocuments({}),
            inventory_accessories: await Accessory.countDocuments({}),
            sales: await Sale.countDocuments({})
        };

        res.json({
            connected: !!cachedDb,
            lastSyncAt: new Date().toISOString(),
            lastSyncError: null,
            pendingCounts,
            totalPending: 0,
            mongoConfigured: Boolean(MONGO_URI)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            connected: false,
            lastSyncAt: null,
            lastSyncError: err.message,
            pendingCounts: {},
            totalPending: 0,
            mongoConfigured: Boolean(MONGO_URI)
        });
    }
});

// =============================================
// DASHBOARD
// =============================================

app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        await connectDB();

        // Use the client's timezone (sent as ?tzOffset=, getTimezoneOffset() style)
        // so "today" matches the shop's local calendar. Falls back to the server's
        // own timezone when the parameter is absent.
        let tzOffset = Number(req.query.tzOffset);
        if (!Number.isFinite(tzOffset) || Math.abs(tzOffset) > 900) {
            tzOffset = new Date().getTimezoneOffset();
        }

        const now = new Date();
        const todayStr = localDateStr(tzOffset, now);
        const { start: todayStart, end: todayEnd } = localDayRange(todayStr, tzOffset);

        const yesterdayStr = localDateStr(tzOffset, new Date(now.getTime() - 24 * 60 * 60 * 1000));
        const { start: yesterdayStart, end: yesterdayEnd } = localDayRange(yesterdayStr, tzOffset);

        // 1. Today's Sales & Yesterday's Sales
        // NOTE: Sale documents store their timestamp as `createdAt` (Mongoose timestamps),
        // NOT `created_at` — querying `created_at` always matched nothing.
        const todaySalesAgg = await Sale.aggregate([
            { $match: { createdAt: { $gte: todayStart, $lte: todayEnd } } },
            { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        const yesterdaySalesAgg = await Sale.aggregate([
            { $match: { createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } } },
            { $group: { _id: null, total: { $sum: '$total' } } }
        ]);

        const todaySales = Number(todaySalesAgg[0]?.total || 0);
        const yesterdaySales = Number(yesterdaySalesAgg[0]?.total || 0);
        const salesGrowth = yesterdaySales === 0 ? (todaySales > 0 ? 100 : 0) : ((todaySales - yesterdaySales) / yesterdaySales) * 100;

        // 2. Repairs Status
        const repairRows = await RepairJob.aggregate([
            { $group: { _id: '$repair_status', count: { $sum: 1 } } }
        ]);
        const repairStatusCounts = {
            Received: 0,
            'In Repair': 0,
            'Ready for Pickup': 0,
            Delivered: 0
        };
        repairRows.forEach(r => {
            if (repairStatusCounts.hasOwnProperty(r._id)) {
                repairStatusCounts[r._id] = r.count;
            }
        });
        const repairsInProgress = (repairStatusCounts['Received'] || 0) + (repairStatusCounts['In Repair'] || 0);

        // 3. Low Stock Alerts
        const lowStockCount = await Accessory.countDocuments({ quantity: { $lt: 5 } });

        // 4. Dead Stock (Phones > 30 days)
        const deadThresholdDate = new Date();
        deadThresholdDate.setDate(deadThresholdDate.getDate() - 30);

        const deadPhones = await Phone.find({
            status: 'In Stock',
            $or: [
                { added_at: { $lt: deadThresholdDate } },
                { created_at: { $lt: deadThresholdDate } }
            ]
        }).sort({ added_at: 1 }).limit(10);

        const deadStockCount = deadPhones.length;
        const deadStockList = deadPhones.slice(0, 5).map(p => {
            const dateRef = p.added_at || p.created_at;
            const daysUnsold = Math.floor((new Date() - new Date(dateRef)) / (1000 * 60 * 60 * 24));
            return {
                id: p._id.toString(),
                name: `${p.brand} ${p.model}`,
                days: daysUnsold,
                qty: 1
            };
        });

        // 5. Recent Sales
        const recentSalesRows = await Sale.find({}).sort({ createdAt: -1 }).limit(5);
        const recentSales = recentSalesRows.map(sale => {
            const items = sale.items || [];
            const mainItem = items.length > 0 ? items[0].name + (items.length > 1 ? ` +${items.length - 1} more` : '') : 'Unknown items';
            return {
                id: sale.receipt_no,
                item: mainItem,
                amount: `Rs. ${Number(sale.total).toLocaleString('en-LK')}`,
                cashier: sale.cashier_name,
                time: formatLocalTime(new Date(sale.createdAt), tzOffset)
            };
        });

        // 6. Sales Trend (Last 7 Days)
        const salesTrend = [];
        for (let i = 6; i >= 0; i--) {
            const dateStr = localDateStr(tzOffset, new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
            const dayName = new Date(`${dateStr}T00:00:00.000Z`)
                .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
            const { start, end } = localDayRange(dateStr, tzOffset);

            const dayAgg = await Sale.aggregate([
                { $match: { createdAt: { $gte: start, $lte: end } } },
                { $group: { _id: null, total: { $sum: '$total' } } }
            ]);

            salesTrend.push({
                name: dayName,
                sales: Number(dayAgg[0]?.total || 0)
            });
        }

        res.json({
            stats: {
                todaySales,
                salesGrowth,
                repairsInProgress,
                lowStockCount,
                deadStockCount
            },
            repairStatusCounts,
            recentSales,
            deadStockList,
            salesTrend
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching dashboard data' });
    }
});

// =============================================
// STORAGE MONITORING (Admin Only)
// MongoDB Atlas free tier caps storage at 512MB, so admins get real usage
// numbers straight from the database — the dbStats command and the per-
// collection $collStats aggregation — never client-side estimates.
// =============================================

const STORAGE_LIMIT_BYTES = 512 * 1024 * 1024;  // Atlas M0 free tier cap
// Dashboard warning fires above 500MB (97% of the free tier). Overridable via
// env var so the banner can be exercised in a test environment with a tiny
// threshold instead of pushing 500MB of junk data into the real database.
const STORAGE_WARN_BYTES = Number(process.env.STORAGE_WARN_BYTES || 500 * 1024 * 1024);
const STORAGE_HISTORY_DAYS = 30;

// User accounts and Inventory/Stock product data are excluded from the
// per-section breakdown per requirement. These are the mongoose registration
// names from models.js — their .collection.name gives the real collection
// names ('users', 'inventoryphones', 'inventoryaccessories').
const EXCLUDED_STORAGE_MODELS = ['User', 'InventoryPhone', 'InventoryAccessory'];
const getExcludedCollectionNames = () => {
    const names = new Set();
    for (const modelName of EXCLUDED_STORAGE_MODELS) {
        try {
            names.add(mongoose.model(modelName).collection.name);
        } catch (err) {
            // Model not registered in this build — nothing to exclude for it.
        }
    }
    return names;
};

// Store today's total usage so the trend chart builds itself over time.
// Guarded by an in-memory date stamp so both storage endpoints only hit the
// database with an upsert once per UTC day per server process.
let lastSnapshotDate = '';
const captureStorageSnapshot = async (dbStats) => {
    const today = new Date().toISOString().slice(0, 10);
    if (lastSnapshotDate === today) return false;
    try {
        await StorageSnapshot.updateOne(
            { date: today },
            {
                $set: {
                    total_data_size: Number(dbStats.dataSize || 0),
                    total_storage_size: Number(dbStats.storageSize || 0)
                },
                $setOnInsert: { captured_at: new Date() }
            },
            { upsert: true }
        );
        lastSnapshotDate = today;
        return true;
    } catch (err) {
        // A failed snapshot must never break the storage endpoints themselves.
        console.error('Failed to store daily storage snapshot:', err.message);
        return false;
    }
};

// Lightweight check used by the Dashboard warning banner: total usage vs the
// 512MB limit and whether the 500MB warning threshold is exceeded.
const getStorageUsage = async () => {
    await connectDB();
    const dbStats = await mongoose.connection.db.command({ dbStats: 1 });
    const usedBytes = Number(dbStats.dataSize || 0);
    await captureStorageSnapshot(dbStats);
    return {
        usedBytes,
        storageBytes: Number(dbStats.storageSize || 0),
        indexBytes: Number(dbStats.indexSize || 0),
        objectCount: Number(dbStats.objects || 0),
        limitBytes: STORAGE_LIMIT_BYTES,
        warnThresholdBytes: STORAGE_WARN_BYTES,
        percentUsed: STORAGE_LIMIT_BYTES > 0
            ? Number(((usedBytes / STORAGE_LIMIT_BYTES) * 100).toFixed(1))
            : 0,
        warning: usedBytes > STORAGE_WARN_BYTES
    };
};

app.get('/api/storage/usage', authenticateToken, requireAdmin, async (req, res) => {
    try {
        res.json(await getStorageUsage());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read MongoDB storage stats' });
    }
});

// Full breakdown for the Manage Storage page: real dbStats plus accurate
// per-collection sizes via $collStats, sorted largest data size first.
const getStorageBreakdown = async () => {
    await connectDB();
    const db = mongoose.connection.db;
    const dbStats = await db.command({ dbStats: 1 });

    const excluded = getExcludedCollectionNames();
    const collectionNames = (await db.listCollections().toArray())
        .map((c) => c.name)
        .filter((name) => !name.startsWith('system.') && !excluded.has(name));

    // $collStats returns exactly the numbers Atlas reports (data size, on-disk
    // storage size, document count) — not an estimate from record counts.
    const collections = [];
    for (const name of collectionNames) {
        try {
            const [row] = await db.collection(name)
                .aggregate([{ $collStats: { storageStats: {} } }])
                .toArray();
            const s = (row && row.storageStats) || {};
            collections.push({
                name,
                count: Number(s.count || 0),
                size: Number(s.size || 0),                // logical data size (bytes)
                storageSize: Number(s.storageSize || 0)   // on-disk compressed size (bytes)
            });
        } catch (err) {
            console.error(`Failed to read stats for collection "${name}":`, err.message);
        }
    }
    collections.sort((a, b) => b.size - a.size); // largest first

    const snapshotCaptured = await captureStorageSnapshot(dbStats);
    const snapshots = await StorageSnapshot.find({}).sort({ date: -1 }).limit(STORAGE_HISTORY_DAYS);
    const history = snapshots
        .reverse()
        .map((s) => ({
            date: s.date,
            totalDataSize: Number(s.total_data_size || 0),
            totalStorageSize: Number(s.total_storage_size || 0)
        }));

    return {
        db: {
            name: dbStats.db || mongoose.connection.name,
            dataSize: Number(dbStats.dataSize || 0),
            storageSize: Number(dbStats.storageSize || 0),
            indexSize: Number(dbStats.indexSize || 0),
            objects: Number(dbStats.objects || 0),
            collections: Number(dbStats.collections || 0)
        },
        limitBytes: STORAGE_LIMIT_BYTES,
        warnThresholdBytes: STORAGE_WARN_BYTES,
        collections,
        excludedCollections: Array.from(excluded),
        history,
        snapshotCaptured,
        generatedAt: new Date().toISOString()
    };
};
// =============================================
// PER-SECTION CLEARING (Admin / Shop Owner only)
// Lets the Manage Storage page delete a section's records to reclaim space.
// Only the collections surfaced in the breakdown are clearable, and user
// accounts + inventory/stock product data are NEVER clearable — the whitelist
// below cannot express them, so a bad or forged request fails safe.
// =============================================
const STORAGE_CLEARABLE = {
    sales:            { model: Sale,            label: 'Sales / Transactions' },
    repairjobs:       { model: RepairJob,       label: 'Repair Jobs' },
    repairjobparts:   { model: RepairJobPart,   label: 'Repair Job Parts' },
    dailysessions:    { model: DailySession,    label: 'Daily Cash Sessions' },
    cashmovements:    { model: CashMovement,    label: 'Cash Movements' },
    refunds:          { model: Refund,          label: 'Refunds' },
    creditnotes:      { model: CreditNote,      label: 'Credit Notes / Unpaid' },
    stockmovements:   { model: StockMovement,   label: 'Stock Movement Logs' },
    stocktakes:       { model: StockTake,       label: 'Stock Take Sessions' },
    stockimports:     { model: StockImport,     label: 'Stock Imports' },
    stockcategories:  { model: StockCategory,   label: 'Categories' },
    storesettings:    { model: StoreSetting,    label: 'Store Settings' },
    // Legacy raw collection (no Mongoose model): 'all' mode only, because its
    // document shape and date fields are not guaranteed by a schema.
    taxrates:         { model: null,            label: 'Tax Rates' },
    storagesnapshots: { model: StorageSnapshot, label: 'Storage Snapshots' }
};

// Every schema above is declared with { timestamps: true }, so each document
// carries a Mongoose-managed createdAt regardless of the explicit created_at
// fields — that makes createdAt the one reliable date field for "older than
// N days" clearing across all model-backed sections.
const STORAGE_CLEAR_DATE_FIELD = 'createdAt';
const STORAGE_CLEAR_MAX_DAYS = 36500; // ~100 years — sanity cap

// Clearing policy (mirrored by the Manage Storage page UI):
//   - whitelisted Mongoose-backed sections: "all" or "olderThan N days"
//   - raw/legacy collections (no model, e.g. legacy "categories"): "all" only
//   - user accounts + inventory/stock product data: NEVER clearable
const clearStorageCollection = async ({ collection, mode = 'all', days = null }) => {
    await connectDB();
    const name = String(collection || '');
    if (!name || name.startsWith('system.') || getExcludedCollectionNames().has(name)) {
        const err = new Error(`Collection "${name}" is protected or unknown — it cannot be cleared from Manage Storage`);
        err.status = 400;
        throw err;
    }
    if (mode !== 'all' && mode !== 'olderThan') {
        const err = new Error(`Invalid clear mode "${mode}" (expected "all" or "olderThan")`);
        err.status = 400;
        throw err;
    }

    const entry = STORAGE_CLEARABLE[name] || null;
    const label = entry ? entry.label : name;
    const model = entry && entry.model ? entry.model : null;

    const filter = {};
    if (mode === 'olderThan') {
        if (!model) {
            const err = new Error(`"${label}" does not support date-based clearing — use "Clear all" instead`);
            err.status = 400;
            throw err;
        }
        const n = Number(days);
        if (!Number.isInteger(n) || n < 1 || n > STORAGE_CLEAR_MAX_DAYS) {
            const err = new Error('"days" must be a whole number between 1 and 36500');
            err.status = 400;
            throw err;
        }
        filter[STORAGE_CLEAR_DATE_FIELD] = { $lt: new Date(Date.now() - n * 24 * 60 * 60 * 1000) };
    }

    const result = model
        ? await model.deleteMany(filter)
        : await mongoose.connection.db.collection(name).deleteMany(filter);

    // After wiping snapshots the in-memory date stamp would suppress today's
    // re-capture — reset it so the next storage read writes a fresh snapshot
    // and the trend chart keeps its "today" point.
    if (name === 'storagesnapshots' && mode === 'all') lastSnapshotDate = '';

    return {
        collection: name,
        label,
        mode,
        days: mode === 'olderThan' ? Number(days) : null,
        deletedCount: Number(result.deletedCount || 0)
    };
};

app.post('/api/storage/clear', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { collection = '', mode = 'all', days = null } = req.body || {};
        const result = await clearStorageCollection({ collection, mode, days });
        res.json({
            success: true,
            deletedCount: result.deletedCount,
            collection: result.collection,
            mode: result.mode,
            days: result.days,
            message: `Deleted ${result.deletedCount} record(s) from ${result.label}`
        });
    } catch (err) {
        if (err && err.status === 400) {
            return res.status(400).json({ error: err.message });
        }
        console.error('Failed to clear storage section:', err);
        res.status(500).json({ error: 'Database error clearing storage section' });
    }
});

app.get('/api/storage', authenticateToken, requireAdmin, async (req, res) => {
    try {
        res.json(await getStorageBreakdown());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read MongoDB storage breakdown' });
    }
});

// Exposed for verification tooling (backend/verify_storage.js) without
// changing the module export shape used by the Vercel serverless entry.
app.storage = { getStorageUsage, getStorageBreakdown, clearStorageCollection };

// =============================================
// Vercel Export
// =============================================

if (require.main === module) {
    // Local development: start server
    const PORT = process.env.PORT || 5000;
    if (!MONGO_URI) {
        console.error('MONGO_URI is not set. Please set it in .env');
        process.exit(1);
    }
    connectDB()
        .then(() => {
            console.log('Connected to MongoDB Atlas');
            // Open/create the local SQLite mirror (optional — never blocks or
            // breaks startup). When unavailable the system runs online-only and
            // the dashboard shows a dismissible warning.
            localDb.ensure()
                .then((handle) => {
                    if (handle) {
                        console.log(`Local SQLite database ready: ${localDb.getDbPath()}`);
                    } else {
                        console.warn('Local SQLite database is unavailable — the system is running online-only (cloud MongoDB only).');
                    }
                })
                .catch((err) => {
                    console.warn('Local SQLite database is unavailable — the system is running online-only (cloud MongoDB only).', err && err.message);
                });
            app.listen(PORT, () => {
                console.log(`Server is running on port ${PORT}`);
            });
        })
        .catch(err => {
            console.error('MongoDB connection error:', err);
            process.exit(1);
        });
}

module.exports = app;