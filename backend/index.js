require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const {
    User,
    Phone,
    Accessory,
    Sale,
    RepairJob,
    RepairJobPart,
    CashMovement,
    DailySession
} = require('./models');

const app = express();
app.use(cors());
app.use(express.json());

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

const formatReceiptNo = () => `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

const normalizeSale = (sale) => {
    if (!sale) return null;
    return {
        id: sale._id.toString(),
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

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
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
            created_at: u.createdAt
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
        res.json(accessories.map(a => ({
            id: a._id.toString(),
            sku: a.sku,
            name: a.name,
            quantity: a.quantity,
            cost_price: a.cost_price,
            sell_price: a.sell_price,
            low_stock_threshold: a.low_stock_threshold,
            category: a.category,
            added_at: a.added_at || a.created_at
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/inventory/accessories', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { sku, name, quantity, cost_price, sell_price, low_stock_threshold, category } = req.body;
        const accessory = await Accessory.create({
            sku, name, quantity: quantity || 0,
            cost_price, sell_price,
            low_stock_threshold: low_stock_threshold || 5, category
        });
        res.status(201).json({ id: accessory._id.toString() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventory/accessories/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const { sku, name, quantity, cost_price, sell_price, low_stock_threshold, category } = req.body;
        const accessory = await Accessory.findByIdAndUpdate(
            req.params.id,
            { sku, name, quantity, cost_price, sell_price, low_stock_threshold, category },
            { new: true }
        );
        if (!accessory) return res.status(404).json({ error: 'Accessory not found' });
        res.json({ success: true, id: req.params.id });
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
            filter.cashier_id = Number(cashierId);
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

        const sales = await Sale.find(filter).sort({ created_at: -1 }).limit(200);
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

app.post('/api/sales/checkout', authenticateToken, async (req, res) => {
    const {
        items,
        paymentMethod,
        paymentDetails,
        cashReceived = 0,
        discountAmount = 0,
        approvalNote = '',
        sessionId
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
        let subtotal = 0;
        const normalizedItems = [];

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
        const receiptNo = formatReceiptNo();

        const saleDoc = await Sale.create({
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

        return res.status(201).json({
            sale: normalizeSale(saleDoc),
            receipt: normalizeSale(saleDoc),
            message: 'Sale completed and synced to cloud'
        });
    } catch (err) {
        console.error(err);
        return res.status(400).json({ error: err.message || 'Unable to complete sale' });
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
            const partsTotal = jobParts.reduce((sum, part) => sum + Number(part.total_cost || 0), 0);
            const laborCost = Number(job.estimated_cost || 0);
            const total = laborCost + partsTotal;

            return {
                id: job._id.toString(),
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
                invoice: {
                    job_id: job._id.toString(),
                    invoice_no: `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
                    labor_cost: laborCost,
                    parts_cost: partsTotal,
                    total_cost: total,
                    status: job.repair_status,
                    created_at: job.created_at
                }
            };
        }));

        res.json(repairJobs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Database error fetching repair jobs' });
    }
});

app.post('/api/repair-jobs', authenticateToken, async (req, res) => {
    const { customer_name, phone_number, device_model, imei, reported_issue, items_left, received_date, estimated_cost, estimated_completion_date, warranty_period_months = 3 } = req.body;

    if (!customer_name || !phone_number || !device_model || !reported_issue || !estimated_completion_date) {
        return res.status(400).json({ error: 'Customer name, phone number, device model, issue, and estimated completion date are required.' });
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
            repair_status: 'Received'
        });

        res.status(201).json({
            id: job._id.toString(),
            ...job.toObject(),
            parts: [],
            invoice: {
                job_id: job._id.toString(),
                invoice_no: `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
                labor_cost: Number(estimated_cost || 0),
                parts_cost: 0,
                total_cost: Number(estimated_cost || 0),
                status: 'Received',
                created_at: job.created_at
            }
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
        const partsTotal = jobParts.reduce((sum, part) => sum + Number(part.total_cost || 0), 0);
        const laborCost = Number(job.estimated_cost || 0);
        const total = laborCost + partsTotal;

        res.json({
            job_id: job._id.toString(),
            invoice_no: `REPAIR-${job._id.toString().slice(-4).toUpperCase()}`,
            labor_cost: laborCost,
            parts_cost: partsTotal,
            total_cost: total,
            status: job.repair_status,
            created_at: job.created_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching invoice' });
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
        if (cashierId) filter.cashier_id = Number(cashierId);

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
            cashier_id: cashierId ? Number(cashierId) : null,
            cashier_name: cashierName || 'System',
            movement_type: normalizedType,
            amount: normalizedAmount,
            note: note || null,
            movement_date: resolvedDate
        });

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

        const [phones, accessories, saleRowsRange, saleRowsAll, deliveredRepairs, cashMovements] = await Promise.all([
            Phone.find({}),
            Accessory.find({}),
            Sale.find({ created_at: { $gte: rangeStart, $lte: rangeEnd } }).sort({ created_at: -1 }),
            Sale.find({}).sort({ created_at: -1 }),
            RepairJob.find({ repair_status: 'Delivered', updated_at: { $gte: rangeStart, $lte: rangeEnd } }),
            CashMovement.find({ movement_date: { $gte: from, $lte: to } })
        ]);

        const phoneMap = new Map(phones.map((phone) => [phone._id.toString(), phone]));
        const accessoryMap = new Map(accessories.map((acc) => [acc._id.toString(), acc]));

        const soldLookup = new Map();
        saleRowsAll.forEach((row) => {
            (row.items || []).forEach((item) => {
                const key = `${item.inventory_type}:${item.inventory_id}`;
                if (!soldLookup.has(key) || new Date(row.created_at) > new Date(soldLookup.get(key))) {
                    soldLookup.set(key, row.created_at);
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

        const marginRows = [];
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
                const current = itemAggregate.get(aggregateKey) || { item_name: item.name, quantity_sold: 0, revenue: 0 };
                current.quantity_sold += qty;
                current.revenue += revenue;
                itemAggregate.set(aggregateKey, current);
            });

            const profit = saleRevenue - saleCost;
            marginRows.push({
                sale_id: row._id.toString(),
                receipt_no: row.receipt_no,
                created_at: row.created_at,
                cashier_name: row.cashier_name,
                revenue: saleRevenue,
                cost: saleCost,
                profit,
                margin_percent: saleRevenue > 0 ? (profit / saleRevenue) * 100 : 0
            });

            const cashierKey = `${row.cashier_id}`;
            const cashierCurrent = cashierAggregate.get(cashierKey) || { cashier_id: row.cashier_id, cashier_name: row.cashier_name, sales_total: 0, sale_count: 0 };
            cashierCurrent.sales_total += Number(row.total || 0);
            cashierCurrent.sale_count += 1;
            cashierAggregate.set(cashierKey, cashierCurrent);

            const saleDate = String(row.created_at || '').slice(0, 10);
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
            .slice(0, 10);

        const worstSelling = Array.from(itemAggregate.values())
            .sort((a, b) => a.quantity_sold - b.quantity_sold)
            .slice(0, 10);

        const cashierPerformance = Array.from(cashierAggregate.values())
            .sort((a, b) => b.sales_total - a.sales_total);

        const avgTurnaround = repairTurnaroundDays.length
            ? repairTurnaroundDays.reduce((sum, days) => sum + days, 0) / repairTurnaroundDays.length
            : 0;

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
            cashier_performance: cashierPerformance
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Unable to generate reports' });
    }
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

        const expectedCash = session.opening_cash + totalCashSales;

        res.json({
            ...session.toObject(),
            id: session._id.toString(),
            summary: { totalCashSales, totalCardSales, totalBankTransfer, expectedCash }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching current session' });
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

        res.status(201).json({ ...session.toObject(), id: session._id.toString() });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error opening session' });
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
        const expectedCash = session.opening_cash + totalCashSales + reloadsSold;
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

        res.json({
            ...session.toObject(),
            id: session._id.toString(),
            summary: { totalCashSales, totalCardSales }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error closing session' });
    }
});

app.get('/api/sessions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await connectDB();
        const sessions = await DailySession.find({}).sort({ date: -1, _id: -1 });
        res.json(sessions.map(s => ({ ...s.toObject(), id: s._id.toString() })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error fetching sessions' });
    }
});

// =============================================
// HEALTH + SYNC STATUS
// =============================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nangi POS Backend is running' });
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
        const todayStr = new Date().toISOString().slice(0, 10);
        const todayStart = new Date(`${todayStr}T00:00:00.000Z`);
        const todayEnd = new Date(`${todayStr}T23:59:59.999Z`);

        let yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        const yesterdayStart = new Date(`${yesterdayStr}T00:00:00.000Z`);
        const yesterdayEnd = new Date(`${yesterdayStr}T23:59:59.999Z`);

        // 1. Today's Sales & Yesterday's Sales
        const todaySalesAgg = await Sale.aggregate([
            { $match: { created_at: { $gte: todayStart, $lte: todayEnd } } },
            { $group: { _id: null, total: { $sum: '$total' } } }
        ]);
        const yesterdaySalesAgg = await Sale.aggregate([
            { $match: { created_at: { $gte: yesterdayStart, $lte: yesterdayEnd } } },
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
        const recentSalesRows = await Sale.find({}).sort({ created_at: -1 }).limit(5);
        const recentSales = recentSalesRows.map(sale => {
            const items = sale.items || [];
            const mainItem = items.length > 0 ? items[0].name + (items.length > 1 ? ` +${items.length - 1} more` : '') : 'Unknown items';
            return {
                id: sale.receipt_no,
                item: mainItem,
                amount: `Rs. ${Number(sale.total).toLocaleString('en-LK')}`,
                cashier: sale.cashier_name,
                time: new Date(sale.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
        });

        // 6. Sales Trend (Last 7 Days)
        const salesTrend = [];
        for (let i = 6; i >= 0; i--) {
            let d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().slice(0, 10);
            const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
            const start = new Date(`${dateStr}T00:00:00.000Z`);
            const end = new Date(`${dateStr}T23:59:59.999Z`);

            const dayAgg = await Sale.aggregate([
                { $match: { created_at: { $gte: start, $lte: end } } },
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