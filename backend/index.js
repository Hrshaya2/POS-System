const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretposkey123';

app.use(cors());
app.use(express.json());

const SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT = Number(process.env.SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT || 10);

const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
    });
});

const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
    });
});

const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
    });
});

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

const normalizeSaleRow = (row) => {
    if (!row) return null;
    const paymentDetails = parseJsonSafe(row.payment_details_json, {});
    const derivedCashReceived = Number(row.cash_received || paymentDetails.cash || paymentDetails.cashReceived || 0);
    const derivedChangeAmount = Number(row.change_amount || paymentDetails.change_amount || paymentDetails.change || 0);

    return {
        ...row,
        approval_required: Boolean(row.approval_required),
        items: parseJsonSafe(row.items_json, []),
        payment_details: paymentDetails,
        cash_received: derivedCashReceived,
        change_amount: derivedChangeAmount,
        pending_sync: row.sync_status !== 'SYNCED'
    };
};

// Basic SQLite setup
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.serialize(() => {
            // Users table
            db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'cashier',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'PENDING_INSERT',
        cloud_id TEXT
      )`);

            // Inventory Phones (IMEI tracked)
            db.run(`CREATE TABLE IF NOT EXISTS inventory_phones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imei TEXT UNIQUE NOT NULL,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        condition TEXT NOT NULL,
        purchase_price REAL,
        selling_price REAL NOT NULL,
        warranty TEXT,
        status TEXT DEFAULT 'In Stock',
        category TEXT NOT NULL,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'PENDING_INSERT',
        cloud_id TEXT
      )`);

            // Inventory Accessories & Parts (Quantity tracked, SKU)
            db.run(`CREATE TABLE IF NOT EXISTS inventory_accessories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        cost_price REAL,
        sell_price REAL NOT NULL,
        low_stock_threshold INTEGER DEFAULT 5,
        category TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sync_status TEXT DEFAULT 'PENDING_INSERT',
        cloud_id TEXT
      )`);

            db.all('PRAGMA table_info(inventory_phones)', (err, columns) => {
                if (err) return;
                const names = new Set((columns || []).map((column) => column.name));
                if (!names.has('added_at')) {
                    db.run('ALTER TABLE inventory_phones ADD COLUMN added_at DATETIME');
                }
            });

            db.all('PRAGMA table_info(inventory_accessories)', (err, columns) => {
                if (err) return;
                const names = new Set((columns || []).map((column) => column.name));
                if (!names.has('added_at')) {
                    db.run('ALTER TABLE inventory_accessories ADD COLUMN added_at DATETIME');
                }
            });

            // Sales / Receipts
            db.run(`CREATE TABLE IF NOT EXISTS sales (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            receipt_no TEXT UNIQUE NOT NULL,
                            cashier_id INTEGER NOT NULL,
                            cashier_name TEXT NOT NULL,
                            cashier_role TEXT NOT NULL,
                            items_json TEXT NOT NULL,
                            subtotal REAL NOT NULL,
                            discount_amount REAL NOT NULL DEFAULT 0,
                            discount_percent REAL NOT NULL DEFAULT 0,
                            total REAL NOT NULL,
                            payment_method TEXT NOT NULL,
                            payment_details_json TEXT,
                            cash_received REAL DEFAULT 0,
                            change_amount REAL DEFAULT 0,
                            approval_required INTEGER DEFAULT 0,
                            approval_status TEXT DEFAULT 'NOT_REQUIRED',
                            approval_note TEXT,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            sync_status TEXT DEFAULT 'PENDING_INSERT',
                            cloud_id TEXT
                        )`);

            db.all('PRAGMA table_info(sales)', (err, columns) => {
                if (err) return;
                const names = new Set((columns || []).map((column) => column.name));
                if (!names.has('cash_received')) {
                    db.run('ALTER TABLE sales ADD COLUMN cash_received REAL DEFAULT 0');
                }
                if (!names.has('change_amount')) {
                    db.run('ALTER TABLE sales ADD COLUMN change_amount REAL DEFAULT 0');
                }
                if (!names.has('session_id')) {
                    db.run('ALTER TABLE sales ADD COLUMN session_id INTEGER');
                }
            });

            db.run(`CREATE TABLE IF NOT EXISTS repair_jobs (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            customer_name TEXT NOT NULL,
                            phone_number TEXT NOT NULL,
                            device_model TEXT NOT NULL,
                            imei TEXT,
                            reported_issue TEXT NOT NULL,
                            items_left TEXT,
                            received_date TEXT,
                            estimated_cost REAL NOT NULL DEFAULT 0,
                            estimated_completion_date TEXT,
                            repair_status TEXT NOT NULL DEFAULT 'Received',
                            warranty_period_months INTEGER NOT NULL DEFAULT 3,
                            warranty_end_date TEXT,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            sync_status TEXT DEFAULT 'PENDING_INSERT',
                            cloud_id TEXT
                        )`);

            db.run(`CREATE TABLE IF NOT EXISTS repair_job_parts (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            repair_job_id INTEGER NOT NULL,
                            inventory_id INTEGER NOT NULL,
                            part_name TEXT NOT NULL,
                            sku TEXT,
                            quantity INTEGER NOT NULL DEFAULT 1,
                            unit_cost REAL NOT NULL DEFAULT 0,
                            total_cost REAL NOT NULL DEFAULT 0,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY(repair_job_id) REFERENCES repair_jobs(id),
                            FOREIGN KEY(inventory_id) REFERENCES inventory_accessories(id)
                        )`);

            db.run(`CREATE TABLE IF NOT EXISTS cash_movements (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            cashier_id INTEGER,
                            cashier_name TEXT,
                            movement_type TEXT NOT NULL,
                            amount REAL NOT NULL DEFAULT 0,
                            note TEXT,
                            movement_date TEXT NOT NULL,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            sync_status TEXT DEFAULT 'PENDING_INSERT',
                            cloud_id TEXT
                        )`);

            db.all('PRAGMA table_info(cash_movements)', (err, columns) => {
                if (err) return;
                const names = new Set((columns || []).map((column) => column.name));
                if (!names.has('movement_date')) {
                    db.run('ALTER TABLE cash_movements ADD COLUMN movement_date TEXT');
                }
            });

            db.all('PRAGMA table_info(repair_jobs)', (err, columns) => {
                if (err) return;
                const names = new Set((columns || []).map((column) => column.name));
                if (!names.has('received_date')) {
                    db.run('ALTER TABLE repair_jobs ADD COLUMN received_date TEXT');
                }
            });

            db.run(`CREATE TABLE IF NOT EXISTS daily_sessions (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            date TEXT NOT NULL,
                            opening_cash REAL NOT NULL DEFAULT 0,
                            opening_reload REAL NOT NULL DEFAULT 0,
                            closing_cash REAL,
                            closing_reload REAL,
                            expected_cash REAL,
                            actual_cash REAL,
                            variance REAL,
                            status TEXT NOT NULL DEFAULT 'open',
                            opened_by INTEGER NOT NULL,
                            closed_by INTEGER,
                            closed_at DATETIME,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            sync_status TEXT DEFAULT 'PENDING_INSERT',
                            cloud_id TEXT
                        )`);
        });
    }
});

// Pass db to the app config for use in external modules if needed
app.locals.db = db;

// Middleware
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

// --- AUTH ROUTES ---
app.post('/api/auth/seed', async (req, res) => {
    try {
        const adminHash = await bcrypt.hash('admin123', 10);
        const shopOwnerHash = await bcrypt.hash('shop123', 10);
        const cashierHash = await bcrypt.hash('cashier123', 10);

        const insert = db.prepare('INSERT OR IGNORE INTO users (name, email, password, role) VALUES (?, ?, ?, ?)');
        insert.run('Main Admin', 'admin@nangi.com', adminHash, 'admin');
        insert.run('Shop Owner', 'shop@nangi.com', shopOwnerHash, 'shop_owner');
        insert.run('Amali Cashier', 'cashier@nangi.com', cashierHash, 'cashier');
        insert.finalize();

        res.json({ message: 'Seeded admin (admin@nangi.com/admin123), shop_owner (shop@nangi.com/shop123) and cashier (cashier@nangi.com/cashier123)' });
    } catch (err) {
        res.status(500).json({ error: 'Server error adding seed users' });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, role: user.role, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    });
});

// --- USERS ROUTES (Admin Only) ---
app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
    db.all('SELECT id, name, email, role, created_at, sync_status FROM users', [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        // Filter users based on role
        let filteredRows = rows;
        if (req.user.role === 'shop_owner') {
            // shop owners can only see cashiers and their own account
            filteredRows = rows.filter(u => u.role === 'cashier' || u.id === req.user.id);
        }

        res.json(filteredRows);
    });
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'Missing fields' });

    // shop_owner can only create cashiers
    if (req.user.role === 'shop_owner' && role !== 'cashier') {
        return res.status(403).json({ error: 'Shop owners can only create cashier accounts' });
    }

    // Only admin can create admins, but logically usually they just create shop_owners
    if (role === 'admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only the admin can create admin accounts' });
    }

    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (name, email, password, role, sync_status) VALUES (?, ?, ?, ?, ?)', [name, email, hash, role, 'PENDING_INSERT'], function (err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.status(201).json({ id: this.lastID, name, email, role });
    });
});

app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { name, email, role, password } = req.body;
    const id = req.params.id;

    // Check if target user exists
    const targetUser = await getAsync('SELECT * FROM users WHERE id = ?', [id]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (req.user.role === 'shop_owner') {
        // Shop owners can only manage cashiers OR edit themselves
        if (targetUser.id !== req.user.id && targetUser.role !== 'cashier') {
            return res.status(403).json({ error: 'Shop owners can only manage cashiers' });
        }
        // If modifying themselves, prevent privilege escalation via role change
        if (role !== targetUser.role) {
            return res.status(403).json({ error: 'You do not have permission to change roles' });
        }
    }

    // Only admin can assign an admin role
    if (role === 'admin' && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only the admin can assign the admin role' });
    }

    // Admin cannot modify other admins
    if (targetUser.role === 'admin' && targetUser.id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Cannot modify admin accounts' });
    }

    if (password) {
        const hash = await bcrypt.hash(password, 10);
        db.run('UPDATE users SET name=?, email=?, role=?, password=?, sync_status=? WHERE id=?', [name, email, role, hash, 'PENDING_UPDATE', id], function (err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true });
        });
    } else {
        db.run('UPDATE users SET name=?, email=?, role=?, sync_status=? WHERE id=?', [name, email, role, 'PENDING_UPDATE', id], function (err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true });
        });
    }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const id = req.params.id;

    // Check if target user exists
    const targetUser = await getAsync('SELECT * FROM users WHERE id = ?', [id]);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Nobody can delete an admin account
    if (targetUser.role === 'admin') {
        return res.status(403).json({ error: 'Admin accounts cannot be deleted' });
    }

    // Shop owners can only delete cashiers
    if (req.user.role === 'shop_owner' && targetUser.role !== 'cashier') {
        return res.status(403).json({ error: 'Shop owners can only delete cashiers' });
    }

    // Prevent deleting yourself
    if (Number(id) === req.user.id) {
        return res.status(403).json({ error: 'You cannot delete your own account' });
    }

    db.run('UPDATE users SET sync_status=? WHERE id=?', ['PENDING_DELETE', id], function (err) {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true });
    });
});

// --- INVENTORY: PHONES (New & Used) ---
app.get('/api/inventory/phones', authenticateToken, (req, res) => {
    db.all("SELECT * FROM inventory_phones WHERE sync_status != 'PENDING_DELETE'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

app.post('/api/inventory/phones', authenticateToken, requireAdmin, (req, res) => {
    const { imei, brand, model, condition, purchase_price, selling_price, warranty, status, category } = req.body;
    db.run(
        'INSERT INTO inventory_phones (imei, brand, model, condition, purchase_price, selling_price, warranty, status, category, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [imei, brand, model, condition, purchase_price, selling_price, warranty, status, category, 'PENDING_INSERT'],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        }
    );
});

app.put('/api/inventory/phones/:id', authenticateToken, requireAdmin, (req, res) => {
    const { imei, brand, model, condition, purchase_price, selling_price, warranty, status, category } = req.body;
    const id = req.params.id;

    db.get('SELECT * FROM inventory_phones WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) return res.status(404).json({ error: 'Phone not found' });

        const nextSyncStatus = row.sync_status === 'SYNCED' ? 'PENDING_UPDATE' : row.sync_status;
        db.run(
            'UPDATE inventory_phones SET imei=?, brand=?, model=?, condition=?, purchase_price=?, selling_price=?, warranty=?, status=?, category=?, sync_status=? WHERE id=?',
            [imei, brand, model, condition, purchase_price, selling_price, warranty, status, category, nextSyncStatus, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: Number(id) });
            }
        );
    });
});

app.delete('/api/inventory/phones/:id', authenticateToken, requireAdmin, (req, res) => {
    const id = req.params.id;

    db.get('SELECT * FROM inventory_phones WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) return res.status(404).json({ error: 'Phone not found' });

        db.run('UPDATE inventory_phones SET sync_status=? WHERE id=?', ['PENDING_DELETE', id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: Number(id) });
        });
    });
});

// --- INVENTORY: ACCESSORIES & PARTS ---
app.get('/api/inventory/accessories', authenticateToken, (req, res) => {
    db.all("SELECT * FROM inventory_accessories WHERE sync_status != 'PENDING_DELETE'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

app.post('/api/inventory/accessories', authenticateToken, requireAdmin, (req, res) => {
    const { sku, name, quantity, cost_price, sell_price, low_stock_threshold, category } = req.body;

    db.run(
        'INSERT INTO inventory_accessories (sku, name, quantity, cost_price, sell_price, low_stock_threshold, category, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [sku, name, quantity, cost_price, sell_price, low_stock_threshold, category, 'PENDING_INSERT'],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ id: this.lastID });
        }
    );
});

app.put('/api/inventory/accessories/:id', authenticateToken, requireAdmin, (req, res) => {
    const { sku, name, quantity, cost_price, sell_price, low_stock_threshold, category } = req.body;
    const id = req.params.id;

    db.get('SELECT * FROM inventory_accessories WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) return res.status(404).json({ error: 'Accessory not found' });

        const nextSyncStatus = row.sync_status === 'SYNCED' ? 'PENDING_UPDATE' : row.sync_status;
        db.run(
            'UPDATE inventory_accessories SET sku=?, name=?, quantity=?, cost_price=?, sell_price=?, low_stock_threshold=?, category=?, sync_status=? WHERE id=?',
            [sku, name, quantity, cost_price, sell_price, low_stock_threshold, category, nextSyncStatus, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, id: Number(id) });
            }
        );
    });
});

app.delete('/api/inventory/accessories/:id', authenticateToken, requireAdmin, (req, res) => {
    const id = req.params.id;

    db.get('SELECT * FROM inventory_accessories WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!row) return res.status(404).json({ error: 'Accessory not found' });

        db.run('UPDATE inventory_accessories SET sync_status=? WHERE id=?', ['PENDING_DELETE', id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: Number(id) });
        });
    });
});

// Seed Inventory
app.post('/api/inventory/seed', authenticateToken, requireAdmin, (req, res) => {
    const insPhone = db.prepare("INSERT OR IGNORE INTO inventory_phones (imei, brand, model, condition, purchase_price, selling_price, warranty, category, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_INSERT')");
    insPhone.run('358123456789012', 'Apple', 'iPhone 13 128GB', 'New', 110000, 135000, '1 Year', 'New Phones');
    insPhone.run('358123456789014', 'Xiaomi', 'Redmi Note 12', 'New', 50000, 62000, '1 Year', 'New Phones');
    insPhone.finalize();

    const insAcc = db.prepare("INSERT OR IGNORE INTO inventory_accessories (sku, name, quantity, cost_price, sell_price, low_stock_threshold, category, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_INSERT')");
    insAcc.run('ACC-001', '20W Apple Fast Charger', 15, 3000, 4500, 5, 'Accessories');
    insAcc.run('ACC-002', 'Samsung A14 Screen Replacement', 2, 8000, 12500, 5, 'Spare Parts');
    insAcc.finalize();

    res.json({ message: 'Inventory Seeded' });
});

// --- SALES / BILLING ---
app.get('/api/sales/config', authenticateToken, (req, res) => {
    res.json({
        discountApprovalLimitPercent: SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT
    });
});

app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { q = '', cashierId = '' } = req.query;
        const params = [];
        let sql = 'SELECT * FROM sales WHERE 1=1';

        if (!isAdminOrShopOwner(req.user.role)) {
            sql += ' AND cashier_id = ?';
            params.push(req.user.id);
        } else if (cashierId) {
            sql += ' AND cashier_id = ?';
            params.push(Number(cashierId));
        }

        if (q && q.trim()) {
            const term = `%${q.trim()}%`;
            sql += ' AND (receipt_no LIKE ? OR cashier_name LIKE ? OR cashier_role LIKE ? OR payment_method LIKE ? OR items_json LIKE ?)';
            params.push(term, term, term, term, term);
        }

        sql += ' ORDER BY datetime(created_at) DESC, id DESC LIMIT 200';

        const rows = await allAsync(sql, params);
        res.json(rows.map(normalizeSaleRow));
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching sales' });
    }
});

app.get('/api/sales/:id', authenticateToken, async (req, res) => {
    try {
        const row = await getAsync('SELECT * FROM sales WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Sale not found' });
        if (!isAdminOrShopOwner(req.user.role) && row.cashier_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        res.json(normalizeSaleRow(row));
    } catch (err) {
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

    let transactionStarted = false;
    try {
        await runAsync('BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        let subtotal = 0;
        const normalizedItems = [];

        for (const rawItem of items) {
            const itemType = String(rawItem.inventoryType || '').toLowerCase();
            const inventoryId = Number(rawItem.inventoryId);

            if (!inventoryId || !['phone', 'accessory'].includes(itemType)) {
                throw new Error('Invalid cart item');
            }

            if (itemType === 'phone') {
                const phone = await getAsync('SELECT * FROM inventory_phones WHERE id = ? AND sync_status != "PENDING_DELETE"', [inventoryId]);
                if (!phone) throw new Error(`Phone item ${inventoryId} not found`);
                if (phone.status === 'Sold') throw new Error(`${phone.brand} ${phone.model} is already sold`);

                const unitPrice = Number(phone.selling_price);
                subtotal += unitPrice;

                normalizedItems.push({
                    inventory_type: 'phone',
                    inventory_id: phone.id,
                    imei: phone.imei,
                    sku: null,
                    name: `${phone.brand} ${phone.model}`,
                    quantity: 1,
                    unit_price: unitPrice,
                    line_total: unitPrice,
                    tracked_by: 'IMEI'
                });

                const nextSyncStatus = phone.sync_status === 'SYNCED' ? 'PENDING_UPDATE' : phone.sync_status;
                await runAsync('UPDATE inventory_phones SET status = ?, sync_status = ? WHERE id = ?', ['Sold', nextSyncStatus, phone.id]);
            } else {
                const accessory = await getAsync('SELECT * FROM inventory_accessories WHERE id = ? AND sync_status != "PENDING_DELETE"', [inventoryId]);
                if (!accessory) throw new Error(`Accessory item ${inventoryId} not found`);

                const quantity = Math.max(1, Number(rawItem.quantity || 1));
                if (quantity !== Math.floor(quantity)) throw new Error('Accessory quantity must be a whole number');
                if (accessory.quantity < quantity) throw new Error(`Not enough stock for ${accessory.name}`);

                const unitPrice = Number(accessory.sell_price);
                const lineTotal = unitPrice * quantity;
                subtotal += lineTotal;

                normalizedItems.push({
                    inventory_type: 'accessory',
                    inventory_id: accessory.id,
                    imei: null,
                    sku: accessory.sku,
                    name: accessory.name,
                    quantity,
                    unit_price: unitPrice,
                    line_total: lineTotal,
                    tracked_by: 'QTY'
                });

                const nextSyncStatus = accessory.sync_status === 'SYNCED' ? 'PENDING_UPDATE' : accessory.sync_status;
                await runAsync('UPDATE inventory_accessories SET quantity = quantity - ?, sync_status = ? WHERE id = ?', [quantity, nextSyncStatus, accessory.id]);
            }
        }

        if (sanitizedDiscount > subtotal) {
            throw new Error('Discount cannot exceed the sale subtotal');
        }

        const total = Math.max(0, subtotal - sanitizedDiscount);
        const discountPercent = subtotal > 0 ? (sanitizedDiscount / subtotal) * 100 : 0;
        const approvalRequired = discountPercent > SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT && !isAdminOrShopOwner(req.user.role) ? 1 : 0;
        const approvalStatus = approvalRequired ? 'PENDING_APPROVAL' : (discountPercent > SALE_DISCOUNT_APPROVAL_LIMIT_PERCENT ? 'APPROVED_BY_ADMIN' : 'NOT_REQUIRED');
        const cashTendered = normalizedPaymentMethod === 'CASH' ? Number(cashReceived || 0) : 0;
        const changeAmount = normalizedPaymentMethod === 'CASH' ? Math.max(0, cashTendered - total) : 0;
        if (normalizedPaymentMethod === 'CASH' && cashTendered < total - 0.01) {
            throw new Error('Cash received must cover the total amount');
        }
        const receiptNo = formatReceiptNo();
        const paymentDetailsJson = paymentDetails || normalizedPaymentMethod === 'CASH'
            ? JSON.stringify(paymentDetails || { cash: cashTendered, change: changeAmount, cashReceived: cashTendered, change_amount: changeAmount })
            : null;

        const saleResult = await runAsync(
            `INSERT INTO sales (
                receipt_no, cashier_id, cashier_name, cashier_role, items_json,
                subtotal, discount_amount, discount_percent, total,
                payment_method, payment_details_json, cash_received, change_amount,
                approval_required, approval_status, approval_note, sync_status, session_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                receiptNo,
                req.user.id,
                req.user.name,
                req.user.role,
                JSON.stringify(normalizedItems),
                subtotal,
                sanitizedDiscount,
                discountPercent,
                total,
                normalizedPaymentMethod,
                paymentDetailsJson,
                cashTendered,
                changeAmount,
                approvalRequired,
                approvalStatus,
                approvalNote || null,
                'PENDING_INSERT',
                sessionId || null
            ]
        );

        await runAsync('COMMIT');

        const saleRow = await getAsync('SELECT * FROM sales WHERE id = ?', [saleResult.lastID]);
        return res.status(201).json({
            sale: normalizeSaleRow(saleRow),
            receipt: normalizeSaleRow(saleRow),
            message: 'Sale completed locally and queued for cloud sync'
        });
    } catch (err) {
        if (transactionStarted) {
            try {
                await runAsync('ROLLBACK');
            } catch (rollbackErr) {
                console.error('Rollback failed:', rollbackErr.message);
            }
        }
        return res.status(400).json({ error: err.message || 'Unable to complete sale' });
    }
});

const REPAIR_STATUS_FLOW = ['Received', 'Diagnosing', 'Awaiting Parts', 'In Repair', 'Ready for Pickup', 'Delivered'];

const getRepairStatusIndex = (status) => {
    const index = REPAIR_STATUS_FLOW.indexOf(status);
    return index >= 0 ? index : -1;
};

const getRepairInvoice = async (jobId) => {
    const job = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [jobId]);
    if (!job) return null;

    const parts = await allAsync('SELECT * FROM repair_job_parts WHERE repair_job_id = ?', [jobId]);
    const partsTotal = parts.reduce((sum, part) => sum + Number(part.total_cost || 0), 0);
    const laborCost = Number(job.estimated_cost || 0);
    const total = laborCost + partsTotal;

    return {
        job_id: job.id,
        invoice_no: `REPAIR-${job.id.toString().padStart(4, '0')}`,
        labor_cost: laborCost,
        parts_cost: partsTotal,
        total_cost: total,
        status: job.repair_status,
        created_at: job.created_at
    };
};

app.get('/api/repair-jobs', authenticateToken, async (req, res) => {
    try {
        const { status = '', q = '' } = req.query;
        let sql = 'SELECT * FROM repair_jobs WHERE 1=1';
        const params = [];

        if (status) {
            sql += ' AND repair_status = ?';
            params.push(status);
        }

        if (q && q.trim()) {
            const term = `%${q.trim()}%`;
            sql += ' AND (customer_name LIKE ? OR imei LIKE ? OR phone_number LIKE ?)';
            params.push(term, term, term);
        }

        sql += ' ORDER BY datetime(created_at) DESC';
        const jobs = await allAsync(sql, params);

        const repairJobs = await Promise.all(jobs.map(async (job) => {
            const parts = await allAsync('SELECT * FROM repair_job_parts WHERE repair_job_id = ?', [job.id]);
            const invoice = await getRepairInvoice(job.id);
            return {
                ...job,
                parts,
                invoice
            };
        }));

        res.json(repairJobs);
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching repair jobs' });
    }
});

app.post('/api/repair-jobs', authenticateToken, async (req, res) => {
    const { customer_name, phone_number, device_model, imei, reported_issue, items_left, received_date, estimated_cost, estimated_completion_date, warranty_period_months = 3 } = req.body;

    if (!customer_name || !phone_number || !device_model || !reported_issue || !estimated_completion_date) {
        return res.status(400).json({ error: 'Customer name, phone number, device model, issue, and estimated completion date are required.' });
    }

    try {
        const warrantyMonths = Number(warranty_period_months || 3);
        const warrantyEnd = new Date(estimated_completion_date);
        const receivedDate = received_date || new Date().toISOString().slice(0, 10);
        warrantyEnd.setMonth(warrantyEnd.getMonth() + warrantyMonths);

        const result = await runAsync(
            `INSERT INTO repair_jobs (
                customer_name, phone_number, device_model, imei, reported_issue, items_left,
                received_date, estimated_cost, estimated_completion_date, warranty_period_months, warranty_end_date,
                repair_status, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                String(customer_name).trim(),
                String(phone_number).trim(),
                String(device_model).trim(),
                imei ? String(imei).trim() : null,
                String(reported_issue).trim(),
                items_left || '',
                receivedDate,
                Number(estimated_cost || 0),
                estimated_completion_date,
                warrantyMonths,
                warrantyEnd.toISOString().slice(0, 10),
                'Received',
                'PENDING_INSERT'
            ]
        );

        const insertedJob = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [result.lastID]);
        const invoice = await getRepairInvoice(insertedJob.id);
        res.status(201).json({ ...insertedJob, parts: [], invoice });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Database error creating repair job' });
    }
});

app.put('/api/repair-jobs/:id/status', authenticateToken, async (req, res) => {
    const { status } = req.body;
    if (!REPAIR_STATUS_FLOW.includes(status)) {
        return res.status(400).json({ error: 'Invalid repair status' });
    }

    try {
        const job = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ error: 'Repair job not found' });

        const currentIndex = getRepairStatusIndex(job.repair_status);
        const nextIndex = getRepairStatusIndex(status);

        if (nextIndex < currentIndex) {
            return res.status(400).json({ error: 'Status can only move forward in the workflow.' });
        }

        if (currentIndex >= 0 && nextIndex - currentIndex > 1) {
            return res.status(400).json({ error: 'Status changes must move to the next step only.' });
        }

        await runAsync('UPDATE repair_jobs SET repair_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id]);
        const updatedJob = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [req.params.id]);
        const invoice = await getRepairInvoice(updatedJob.id);

        res.json({ ...updatedJob, invoice });
    } catch (err) {
        res.status(500).json({ error: 'Database error updating repair status' });
    }
});

app.post('/api/repair-jobs/:id/parts', authenticateToken, async (req, res) => {
    const { inventoryId, quantity = 1 } = req.body;
    if (!inventoryId) {
        return res.status(400).json({ error: 'Spare part inventory ID is required.' });
    }

    try {
        const job = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ error: 'Repair job not found' });

        const part = await getAsync('SELECT * FROM inventory_accessories WHERE id = ? AND sync_status != "PENDING_DELETE"', [inventoryId]);
        if (!part) return res.status(404).json({ error: 'Spare part not found' });

        const requestedQty = Math.max(1, Number(quantity) || 1);
        if (part.quantity < requestedQty) {
            return res.status(400).json({ error: `Not enough stock for ${part.name}.` });
        }

        const unitCost = Number(part.sell_price || 0);
        const totalCost = unitCost * requestedQty;

        await runAsync('UPDATE inventory_accessories SET quantity = quantity - ?, sync_status = ? WHERE id = ?', [requestedQty, 'PENDING_UPDATE', part.id]);

        const result = await runAsync(
            'INSERT INTO repair_job_parts (repair_job_id, inventory_id, part_name, sku, quantity, unit_cost, total_cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [job.id, part.id, part.name, part.sku, requestedQty, unitCost, totalCost]
        );

        const insertedPart = await getAsync('SELECT * FROM repair_job_parts WHERE id = ?', [result.lastID]);
        const updatedJob = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [job.id]);
        const invoice = await getRepairInvoice(job.id);

        res.status(201).json({ job: { ...updatedJob, invoice }, part: insertedPart });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Database error adding spare part' });
    }
});

app.get('/api/repair-jobs/:id/invoice', authenticateToken, async (req, res) => {
    const invoice = await getRepairInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Repair job not found' });
    res.json(invoice);
});

app.get('/api/repair-warranty', authenticateToken, async (req, res) => {
    const { imei, jobId } = req.query;

    try {
        let job = null;
        if (jobId) {
            job = await getAsync('SELECT * FROM repair_jobs WHERE id = ?', [jobId]);
        } else if (imei) {
            job = await getAsync('SELECT * FROM repair_jobs WHERE imei = ? ORDER BY created_at DESC LIMIT 1', [imei]);
        }

        if (!job) {
            return res.json({ found: false, status: 'NOT_FOUND' });
        }

        const warrantyEnd = job.warranty_end_date ? new Date(job.warranty_end_date) : null;
        const now = new Date();
        const isActive = warrantyEnd ? now <= warrantyEnd : false;

        res.json({
            found: true,
            job_id: job.id,
            imei: job.imei,
            customer_name: job.customer_name,
            warranty_period_months: job.warranty_period_months,
            warranty_end_date: job.warranty_end_date,
            status: isActive ? 'ACTIVE' : 'EXPIRED'
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error checking repair warranty' });
    }
});

app.get('/api/cash-movements', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { from = '', to = '', cashierId = '' } = req.query;
        let sql = 'SELECT * FROM cash_movements WHERE 1=1';
        const params = [];

        if (from) {
            sql += ' AND date(movement_date) >= date(?)';
            params.push(from);
        }

        if (to) {
            sql += ' AND date(movement_date) <= date(?)';
            params.push(to);
        }

        if (cashierId) {
            sql += ' AND cashier_id = ?';
            params.push(Number(cashierId));
        }

        sql += ' ORDER BY date(movement_date) DESC, id DESC';
        const rows = await allAsync(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Unable to load cash movements' });
    }
});

app.post('/api/cash-movements', authenticateToken, requireAdmin, async (req, res) => {
    try {
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
        const result = await runAsync(
            `INSERT INTO cash_movements (
                cashier_id, cashier_name, movement_type, amount, note, movement_date, sync_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)` ,
            [
                cashierId ? Number(cashierId) : null,
                cashierName || 'System',
                normalizedType,
                normalizedAmount,
                note || null,
                resolvedDate,
                'PENDING_INSERT'
            ]
        );

        const inserted = await getAsync('SELECT * FROM cash_movements WHERE id = ?', [result.lastID]);
        res.status(201).json(inserted);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Unable to save cash movement' });
    }
});

app.get('/api/reports', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const now = new Date();
        const defaultFrom = new Date(now);
        defaultFrom.setDate(defaultFrom.getDate() - 30);

        const from = req.query.from || defaultFrom.toISOString().slice(0, 10);
        const to = req.query.to || now.toISOString().slice(0, 10);
        const deadDaysThreshold = Math.max(1, Number(req.query.deadDays || 30));

        const rangeStart = toSqlDateTimeStart(from);
        const rangeEnd = toSqlDateTimeEnd(to);

        const [phones, accessories, saleRowsRange, saleRowsAll, deliveredRepairs, cashMovements] = await Promise.all([
            allAsync('SELECT * FROM inventory_phones WHERE sync_status != "PENDING_DELETE"'),
            allAsync('SELECT * FROM inventory_accessories WHERE sync_status != "PENDING_DELETE"'),
            allAsync('SELECT * FROM sales WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?) ORDER BY datetime(created_at) DESC', [rangeStart, rangeEnd]),
            allAsync('SELECT id, created_at, items_json, cashier_id, cashier_name, total, receipt_no FROM sales ORDER BY datetime(created_at) DESC'),
            allAsync('SELECT * FROM repair_jobs WHERE repair_status = "Delivered" AND datetime(updated_at) BETWEEN datetime(?) AND datetime(?)', [rangeStart, rangeEnd]),
            allAsync('SELECT * FROM cash_movements WHERE date(movement_date) BETWEEN date(?) AND date(?)', [from, to])
        ]);

        const phoneMap = new Map(phones.map((phone) => [phone.id, phone]));
        const accessoryMap = new Map(accessories.map((acc) => [acc.id, acc]));

        const soldLookup = new Map();
        saleRowsAll.forEach((row) => {
            const items = parseJsonSafe(row.items_json, []);
            items.forEach((item) => {
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
            const key = `phone:${phone.id}`;
            const lastSoldAt = soldLookup.get(key) || null;
            const stockStart = phone.added_at || phone.created_at || now.toISOString();
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
            const key = `accessory:${acc.id}`;
            const lastSoldAt = soldLookup.get(key) || null;
            const stockStart = acc.added_at || acc.created_at || now.toISOString();
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

        const salesByCategory = {
            'New Phones': 0,
            'Used Phones': 0,
            Accessories: 0,
            Repairs: 0
        };

        const marginRows = [];
        const itemAggregate = new Map();
        const cashierAggregate = new Map();
        const cashierBalanceAggregate = new Map();

        saleRowsRange.forEach((row) => {
            const items = parseJsonSafe(row.items_json, []);
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
                sale_id: row.id,
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

            const paymentDetails = parseJsonSafe(row.payment_details_json, {});
            let cashContribution = 0;
            if (String(row.payment_method || '').toUpperCase() === 'CASH') {
                cashContribution = Number(row.cash_received || 0) - Number(row.change_amount || 0);
            } else if (String(row.payment_method || '').toUpperCase() === 'SPLIT') {
                cashContribution = Number(paymentDetails.cash || paymentDetails.cashReceived || 0);
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

        const repairPartsRows = await allAsync('SELECT repair_job_id, total_cost FROM repair_job_parts');
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
            filters: {
                from,
                to,
                deadDays: deadDaysThreshold
            },
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
        res.status(500).json({ error: err.message || 'Unable to generate reports' });
    }
});


// --- SESSIONS ---
app.get('/api/sessions/current', authenticateToken, async (req, res) => {
    try {
        const session = await getAsync('SELECT * FROM daily_sessions WHERE status = "open" ORDER BY created_at DESC LIMIT 1');
        if (session) {
            // Calculate current expectations
            const sales = await allAsync('SELECT * FROM sales WHERE session_id = ?', [session.id]);

            let totalCashSales = 0;
            let totalCardSales = 0;
            let totalBankTransfer = 0;
            sales.forEach(sale => {
                const paymentDetails = parseJsonSafe(sale.payment_details_json, {});
                const method = String(sale.payment_method || '').toUpperCase();
                if (method === 'CASH') {
                    totalCashSales += (Number(sale.cash_received || 0) - Number(sale.change_amount || 0));
                } else if (method === 'CARD') {
                    totalCardSales += Number(sale.total || 0);
                } else if (method === 'BANK_TRANSFER') {
                    totalBankTransfer += Number(sale.total || 0);
                } else if (method === 'SPLIT') {
                    totalCashSales += Number(paymentDetails.cash || paymentDetails.cashReceived || 0);
                    totalCardSales += Number(paymentDetails.card || 0);
                    totalBankTransfer += Number(paymentDetails.bankTransfer || 0);
                }
            });

            const expectedCash = session.opening_cash + totalCashSales;

            res.json({
                ...session,
                summary: {
                    totalCashSales,
                    totalCardSales,
                    totalBankTransfer,
                    expectedCash
                }
            });
        } else {
            res.json(null);
        }
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching current session' });
    }
});

app.post('/api/sessions/open', authenticateToken, async (req, res) => {
    try {
        const { openingCash, openingReload } = req.body;

        const openSession = await getAsync('SELECT * FROM daily_sessions WHERE status = "open" ORDER BY created_at DESC LIMIT 1');
        if (openSession) {
            return res.status(400).json({ error: 'A session is already open. Please close it first.' });
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const result = await runAsync(
            `INSERT INTO daily_sessions (date, opening_cash, opening_reload, opened_by, status, sync_status) 
             VALUES (?, ?, ?, ?, 'open', 'PENDING_INSERT')`,
            [dateStr, Number(openingCash || 0), Number(openingReload || 0), req.user.id]
        );

        const newSession = await getAsync('SELECT * FROM daily_sessions WHERE id = ?', [result.lastID]);
        res.status(201).json(newSession);
    } catch (err) {
        res.status(500).json({ error: 'Database error opening session' });
    }
});

app.post('/api/sessions/close', authenticateToken, async (req, res) => {
    try {
        const { id, actualCash, actualReload } = req.body;

        const session = await getAsync('SELECT * FROM daily_sessions WHERE id = ? AND status = "open"', [id]);
        if (!session) {
            return res.status(404).json({ error: 'Open session not found.' });
        }

        // Calculate expectations
        const sales = await allAsync('SELECT * FROM sales WHERE session_id = ?', [session.id]);

        let totalCashSales = 0;
        let totalCardSales = 0;
        sales.forEach(sale => {
            const paymentDetails = parseJsonSafe(sale.payment_details_json, {});
            const method = String(sale.payment_method || '').toUpperCase();
            if (method === 'CASH') {
                totalCashSales += (Number(sale.cash_received || 0) - Number(sale.change_amount || 0));
            } else if (method === 'CARD') {
                totalCardSales += Number(sale.total || 0);
            } else if (method === 'SPLIT') {
                totalCashSales += Number(paymentDetails.cash || paymentDetails.cashReceived || 0);
                totalCardSales += Number(paymentDetails.card || 0);
            }
        });

        // Any cash movements that happened while this session was open? 
        // For simplicity, we just use the raw sales calculation for now.
        // Calculate reloads sold and add to expected cash
        const actualReloadNum = Number(actualReload || 0);
        const reloadsSold = Math.max(0, session.opening_reload - actualReloadNum);
        const expectedCash = session.opening_cash + totalCashSales + reloadsSold;
        const actualCashNum = Number(actualCash || 0);
        const variance = actualCashNum - expectedCash;

        await runAsync(
            `UPDATE daily_sessions SET 
             closing_cash = ?, closing_reload = ?, expected_cash = ?, actual_cash = ?, variance = ?, 
             status = 'closed', closed_by = ?, closed_at = CURRENT_TIMESTAMP, sync_status = 'PENDING_UPDATE'
             WHERE id = ?`,
            [actualCashNum, actualReloadNum, expectedCash, actualCashNum, variance, req.user.id, session.id]
        );

        const closedSession = await getAsync('SELECT * FROM daily_sessions WHERE id = ?', [session.id]);
        // include summary info on return so the frontend can print the Z-Report
        res.json({
            ...closedSession,
            summary: {
                totalCashSales,
                totalCardSales
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error closing session' });
    }
});

app.get('/api/sessions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const sessions = await allAsync('SELECT * FROM daily_sessions ORDER BY date DESC, id DESC');
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: 'Database error fetching sessions' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Nangi POS Backend is running' });
});

// Start the Mongo Sync Worker if MONGO_URI is present
let getSyncStatus = () => ({ connected: false, lastSyncAt: null, lastSyncError: null, pendingCounts: {}, totalPending: 0 });

if (process.env.MONGO_URI) {
    const { startSyncService, getSyncStatus: getStatus } = require('./mongoSync');
    getSyncStatus = getStatus;
    startSyncService(db);
}

// --- SYNC STATUS ROUTE ---
app.get('/api/sync-status', authenticateToken, (req, res) => {
    const status = getSyncStatus();
    res.json({
        ...status,
        mongoConfigured: Boolean(process.env.MONGO_URI)
    });
});

app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const todayStr = new Date().toISOString().slice(0, 10);

        let yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);

        // 1. Today's Sales & Yesterday's Sales for growth
        const todaySalesRow = await getAsync(`SELECT SUM(total) as total FROM sales WHERE date(created_at) = ?`, [todayStr]);
        const yesterdaySalesRow = await getAsync(`SELECT SUM(total) as total FROM sales WHERE date(created_at) = ?`, [yesterdayStr]);

        const todaySales = Number(todaySalesRow?.total || 0);
        const yesterdaySales = Number(yesterdaySalesRow?.total || 0);
        const salesGrowth = yesterdaySales === 0 ? (todaySales > 0 ? 100 : 0) : ((todaySales - yesterdaySales) / yesterdaySales) * 100;

        // 2. Repairs Status
        const repairRows = await allAsync(`SELECT repair_status as status, COUNT(*) as count FROM repair_jobs GROUP BY repair_status`);
        const repairStatusCounts = {
            Received: 0,
            'In Repair': 0,
            'Ready for Pickup': 0,
            Delivered: 0
        };
        repairRows.forEach(r => {
            if (repairStatusCounts.hasOwnProperty(r.status)) {
                repairStatusCounts[r.status] = r.count;
            }
        });
        const repairsInProgress = (repairStatusCounts['Received'] || 0) + (repairStatusCounts['In Repair'] || 0);

        // 3. Low Stock Alerts
        const lowStockRow = await getAsync(`SELECT COUNT(*) as count FROM inventory_accessories WHERE quantity < 5 AND sync_status != 'PENDING_DELETE'`);
        const lowStockCount = lowStockRow ? lowStockRow.count : 0;

        // 4. Dead Stock (Phones > 30 days)
        const deadThresholdDate = new Date();
        deadThresholdDate.setDate(deadThresholdDate.getDate() - 30);
        const deadDateStr = deadThresholdDate.toISOString();

        const deadPhones = await allAsync(`SELECT id, brand, model, added_at, selling_price, status 
            FROM inventory_phones 
            WHERE status = 'In Stock' AND sync_status != 'PENDING_DELETE' AND added_at < ?
            ORDER BY added_at ASC`, [deadDateStr]);

        const deadStockCount = deadPhones.length;
        const deadStockList = deadPhones.slice(0, 5).map(p => {
            const daysUnsold = Math.floor((new Date() - new Date(p.added_at)) / (1000 * 60 * 60 * 24));
            return {
                id: p.id,
                name: `${p.brand} ${p.model}`,
                days: daysUnsold,
                qty: 1
            };
        });

        // 5. Recent Sales
        const recentSalesRows = await allAsync(`SELECT id, receipt_no, cashier_name, total, items_json, created_at FROM sales ORDER BY created_at DESC LIMIT 5`);
        const recentSales = recentSalesRows.map(sale => {
            const items = JSON.parse(sale.items_json || '[]');
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

            const daySalesRow = await getAsync(`SELECT SUM(total) as total FROM sales WHERE date(created_at) = ?`, [dateStr]);
            salesTrend.push({
                name: dayName,
                sales: Number(daySalesRow?.total || 0)
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

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
