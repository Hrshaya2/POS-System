// =============================================
// MongoDB Seed Script for Nangi POS
// Seeds default users, inventory, and optionally migrates SQLite data
// Usage: node seed.js
// =============================================

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { User, Phone, Accessory, Sale, RepairJob, RepairJobPart, CashMovement, DailySession } = require('./models');

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGO_URI is not set. Check backend/.env');
    process.exit(1);
}

async function main() {
    console.log('Connecting to MongoDB Atlas...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to', mongoose.connection.name);

    // --- 1. Seed Default Users ---
    console.log('\n--- Seeding Users ---');
    const adminHash = await bcrypt.hash('admin123', 10);
    const shopOwnerHash = await bcrypt.hash('shop123', 10);
    const cashierHash = await bcrypt.hash('cashier123', 10);

    const seedUsers = [
        { name: 'Main Admin', email: 'admin@nangi.com', password: adminHash, role: 'admin' },
        { name: 'Shop Owner', email: 'shop@nangi.com', password: shopOwnerHash, role: 'shop_owner' },
        { name: 'Amali Cashier', email: 'cashier@nangi.com', password: cashierHash, role: 'cashier' }
    ];

    let seededUsers = 0;
    for (const u of seedUsers) {
        const existing = await User.findOne({ email: u.email });
        if (existing) {
            // Update password if missing or empty
            if (!existing.password) {
                existing.password = u.password;
                await existing.save();
                console.log(`  🔄 Updated password for ${u.email}`);
            } else {
                console.log(`  ✓ ${u.email} already exists`);
            }
        } else {
            await User.create(u);
            seededUsers++;
            console.log(`  ✅ Created ${u.email}`);
        }
    }

    // --- 2. Migrate Existing SQLite Data (if database.sqlite exists) ---
    console.log('\n--- Checking SQLite migration ---');
    const fs = require('fs');
    const path = require('path');
    const sqlitePath = path.resolve(__dirname, 'database.sqlite');

    let sqlite3 = null;
    try {
        sqlite3 = require('sqlite3').verbose();
    } catch (e) {
        console.log('  ⚠️ sqlite3 package not installed - install it temporarily to migrate: npm install sqlite3');
    }

    if (sqlite3 && fs.existsSync(sqlitePath)) {
        console.log('📁 Found SQLite database, migrating data...');
        const db = new sqlite3.Database(sqlitePath);

        // Migrate Phones
        await new Promise((resolve) => {
            db.all(`SELECT * FROM inventory_phones WHERE sync_status != 'PENDING_DELETE'`, [], async (err, rows) => {
                if (err) { console.log('⚠️  No phones table:', err.message); return resolve(); }
                if (!rows || rows.length === 0) { console.log('  ℹ️ No phones to migrate'); resolve(); return; }

                let count = 0;
                for (const row of rows) {
                    const existing = await Phone.findOne({ imei: row.imei });
                    if (!existing) {
                        await Phone.create({
                            imei: row.imei,
                            brand: row.brand,
                            model: row.model,
                            condition: row.condition,
                            purchase_price: row.purchase_price,
                            selling_price: row.selling_price,
                            warranty: row.warranty,
                            status: row.status,
                            category: row.category,
                            added_at: row.added_at ? new Date(row.added_at) : new Date()
                        });
                        count++;
                    }
                }
                console.log(`  ✅ Migrated ${count} phones (skipped ${rows.length - count} existing)`);
                resolve();
            });
        });

        // Migrate Accessories
        await new Promise((resolve) => {
            db.all(`SELECT * FROM inventory_accessories WHERE sync_status != 'PENDING_DELETE'`, (err, rows) => {
                if (err) { console.log('⚠️ Accessories:', err.message); resolve(); return; }
                if (!rows || rows.length === 0) { console.log('  ℹ️ No accessories to migrate'); resolve(); return; }
                (async () => {
                    let count = 0;
                    for (const row of rows) {
                        const existing = await Accessory.findOne({ sku: row.sku });
                        if (!existing) {
                            await Accessory.create({
                                sku: row.sku,
                                name: row.name,
                                quantity: row.quantity,
                                cost_price: row.cost_price,
                                sell_price: row.sell_price,
                                low_stock_threshold: row.low_stock_threshold,
                                category: row.category,
                                added_at: row.added_at ? new Date(row.added_at) : new Date()
                            });
                            count++;
                        }
                    }
                    console.log(`  ✅ Migrated ${count} accessories(s)`);
                    resolve();
                })();
            });
        });

        // Migrate Sales
        await new Promise((resolve) => {
            db.all('SELECT * FROM sales', (err, rows) => {
                if (err) { console.log('  Sales:', err.message); resolve(); return; }
                if (!rows || rows.length === 0) { console.log('  ℹ No sales to migrate'); resolve(); return; }
                (async () => {
                    let count = 0;
                    for (const row of rows) {
                        const existing = await Sale.findOne({ receipt_no: row.receipt_no });
                        if (!existing) {
                            try {
                                await Sale.create({
                                    receipt_no: row.receipt_no,
                                    cashier_id: row.cashier_id,
                                    cashier_name: row.cashier_name,
                                    cashier_role: row.cashier_role,
                                    items: row.items_json ? JSON.parse(row.items_json) : [],
                                    subtotal: row.subtotal,
                                    discount_amount: row.discount_amount,
                                    discount_percent: row.discount_percent,
                                    total: row.total,
                                    payment_method: row.payment_method,
                                    payment_details: row.payment_details_json ? JSON.parse(row.payment_details_json) : null,
                                    cash_received: row.cash_received,
                                    change_amount: row.change_amount,
                                    approval_required: !!row.approval_required,
                                    approval_status: row.approval_status,
                                    approval_note: row.approval_note,
                                    session_id: row.session_id,
                                    createdAt: row.created_at ? new Date(row.created_at) : undefined
                                });
                                count++;
                            } catch (e) {
                                console.log(`  ⚠️ Skipped sale ${row.receipt_no}: ${e.message}`);
                            }
                        }
                    }
                    console.log(`  ✅ Migrated ${count} sale(s)`);
                    resolve();
                })();
            });
        });

        db.close();
    } else {
        console.log('  ℹ No SQLite database found - skipping migration');
        console.log('  💡 Tip: To test, run:  POST /api/auth/seed  to create default users');
    }

    // --- 3. Summary ---
    console.log('\n--- Summary ---');
    console.log(`  Users: ${await User.countDocuments()}`);
    console.log(`  Phones: ${await Phone.countDocuments()}`);
    console.log(`  Accessories: ${await Accessory.countDocuments()}`);
    console.log(`  Sales: ${await Sale.countDocuments()}`);
    console.log(`  Repair Jobs: ${await RepairJob.countDocuments()}`);
    console.log(`  Cash Movements: ${await CashMovement.countDocuments()}`);
    console.log(`  Sessions: ${await DailySession.countDocuments()}`);

    console.log('\n✅ Seed complete!');
    console.log('\nLogin credentials:');
    console.log('  Admin: admin@nangi.com / admin123');
    console.log('  Shop Owner: shop@nangi.com / shop123');
    console.log('  Cashier: cashier@nangi.com / cashier123');

    await mongoose.connection.close();
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
});