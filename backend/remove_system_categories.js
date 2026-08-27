// ONE-SHOT cleanup: deletes ONLY the auto-seeded demo stock categories
// (rows flagged created_by:'system'). Writes a JSON backup of every deleted
// row to this folder first, and never touches Accessory/items or any
// user-created category. Usage: node remove_system_categories.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { StockCategory } = require('./models');

(async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.log('MONGO_URI missing in backend/.env');
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected.\n');

    const seeded = await StockCategory.find({ created_by: 'system' }).lean();
    if (!seeded.length) {
      console.log('No system-seeded categories found - nothing to remove.');
      await mongoose.disconnect();
      return;
    }

    console.log(`Found ${seeded.length} system-seeded category row(s):`);
    for (const c of seeded) console.log(`  - "${c.name}" (${c._id})`);

    const backupPath = path.join(__dirname, 'removed-system-categories-backup.json');
    fs.writeFileSync(backupPath, JSON.stringify({ removedAt: new Date().toISOString(), rows: seeded }, null, 2));
    console.log(`\nBackup written first: ${backupPath}`);

    const res = await StockCategory.deleteMany({ _id: { $in: seeded.map((c) => c._id) } });
    console.log(`Deleted ${res.deletedCount} system-seeded row(s).`);

    const remaining = await StockCategory.find({}).sort({ name: 1 }).lean();
    console.log(`\nCategories now in database (${remaining.length}):`);
    for (const c of remaining) console.log(`  - "${c.name}" (created_by: ${c.created_by || 'unknown'})`);

    await mongoose.disconnect();
    console.log('\nDone. Items were untouched; categories labelled by these names remain visible as item-derived cards.');
  } catch (err) {
    console.error('Cleanup failed:', err.message);
    process.exit(1);
  }
})();
