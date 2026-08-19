const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');
db.all("PRAGMA table_info(inventory_phones)", [], (err, cols) => {
    cols.forEach(c => console.log('PHONE:', c.name));
});
db.all("PRAGMA table_info(sales)", [], (err, cols) => {
    cols.forEach(c => console.log('SALE:', c.name));
    setTimeout(() => db.close(), 200);
});
