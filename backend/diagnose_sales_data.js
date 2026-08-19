const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.all('SELECT id, receipt_no, items_json, created_at FROM sales ORDER BY created_at DESC LIMIT 10', [], (err, rows) => {
    if (err) {
        console.log('ERROR:', err.message);
        return;
    }
    rows.forEach(row => {
        try {
            const items = JSON.parse(row.items_json || '[]');
            console.log(`✅ Sale ${row.id} (${row.receipt_no}): valid JSON, ${items.length} items`);
        } catch (e) {
            console.log(`❌ Sale ${row.id} (${row.receipt_no}): INVALID JSON - ${e.message}`);
            console.log(`   Raw: ${row.items_json?.substring(0, 200)}`);
        }
    });
    db.close();
});