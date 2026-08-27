// READ-ONLY diagnostic: lists current stock categories + newest items.
// Prints nothing destructive; safe to run anytime. Usage: node diagnose_stock_categories.js
require('dotenv').config();
const mongoose = require('mongoose');
const { StockCategory, Accessory } = require('./models');

(async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.log('MONGO_URI missing in backend/.env');
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected.\n');

    const cats = await StockCategory.find().sort({ createdAt: -1 }).lean();
    const accs = await Accessory.find().lean();

    const byName = new Map();
    for (const a of accs) {
      const k = String(a.category || '(none)');
      const e = byName.get(k) || { count: 0, qty: 0 };
      e.count += 1;
      e.qty += Number(a.quantity || 0);
      byName.set(k, e);
    }

    console.log(`=== CATEGORIES IN DATABASE (${cats.length}) ===`);
    for (const c of cats) {
      const s = byName.get(c.name) || { count: 0, qty: 0 };
      console.log(
        `- "${c.name}" | items:${s.count} | units:${s.qty} | phoneCat:${!!c.is_phone_category} | created:${c.createdAt ? new Date(c.createdAt).toISOString() : 'n/a'}`
      );
    }

    const orphanNames = [...byName.keys()].filter((k) => k !== '(none)' && !cats.some((c) => c.name === k));
    console.log(`\nItem-category labels with no StockCategory row: ${orphanNames.length ? orphanNames.join(', ') : '(none)'}`);

    console.log('\n=== 15 NEWEST ITEMS ===');
    const newest = await Accessory.find().sort({ createdAt: -1, added_at: -1 }).limit(15).select('sku name category quantity createdAt added_at').lean();
    for (const i of newest) {
      console.log(`- [${i.sku}] ${i.name} | cat:${i.category} | qty:${i.quantity} | created:${i.createdAt ? new Date(i.createdAt).toISOString() : i.added_at || 'n/a'}`);
    }

    console.log('\nDone (read-only).');
    await mongoose.disconnect();
  } catch (err) {
    console.error('Diagnostic failed:', err.message);
    process.exit(1);
  }
})();
