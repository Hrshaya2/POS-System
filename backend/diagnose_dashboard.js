const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

const runQuery = (label, sql, params = []) => {
    return new Promise((resolve) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.log(`❌ ${label}: ${err.message}`);
                resolve(null);
            } else {
                console.log(`✅ ${label}: ${JSON.stringify(rows).substring(0, 200)}`);
                resolve(rows);
            }
        });
    });
};

async function diagnose() {
    const todayStr = new Date().toISOString().slice(0, 10);
    let yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // Check all tables exist
    await runQuery('List tables', "SELECT name FROM sqlite_master WHERE type='table'");

    // 1. Today's Sales
    await runQuery('Today sales', `SELECT SUM(total) as total FROM sales WHERE date(created_at) = ?`, [todayStr]);
    await runQuery('Yesterday sales', `SELECT SUM(total) as total FROM sales WHERE date(created_at) = ?`, [yesterdayStr]);

    // 2. Repairs Status
    await runQuery('Repair status', `SELECT repair_status as status, COUNT(*) as count FROM repair_jobs GROUP BY repair_status`);

    // 3. Low Stock
    await runQuery('Low stock', `SELECT COUNT(*) as count FROM inventory_accessories WHERE quantity < 5 AND sync_status != 'PENDING_DELETE'`);

    // 4. Dead Stock
    const deadThresholdDate = new Date();
    deadThresholdDate.setDate(deadThresholdDate.getDate() - 30);
    const deadDateStr = deadThresholdDate.toISOString();
    await runQuery('Dead phones', `SELECT id, brand, model, added_at, selling_price, status 
        FROM inventory_phones 
        WHERE status = 'In Stock' AND sync_status != 'PENDING_DELETE' AND added_at < ?
        ORDER BY added_at ASC`, [deadDateStr]);

    // 5. Recent Sales
    await runQuery('Recent sales', `SELECT id, receipt_no, cashier_name, total, items_json, created_at FROM sales ORDER BY created_at DESC LIMIT 5`);

    // 6. Sales Trend
    for (let i = 6; i >= 0; i--) {
        let d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        await runQuery(`Sales trend ${dateStr}`, `SELECT SUM(total) as total FROM sales WHERE date(created_at) = ?`, [dateStr]);
    }

    db.close();
}

diagnose();