// Runtime test for the CSV column auto-mapping (run: node tools/test-csv-map.mjs)
import { parseCsvTable, applyColumnMapping, parseCsv, guessColumnMapping } from '../frontend/src/utils/csv.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`); }
};

// 1) The user's foreign export (exact header row from their screenshot).
const foreign = [
  'Code,Product group,Product,Qty.,UOM,Cost,Cost incl. tax,Total before tax,Total',
  'IP15TG,Screen Protectors,iPhone 15 Tempered Glass,10.00,Nos,250.00,275.00,2500.00,2750.00',
  '"CASE, SILICONE",Phone Cases,Silicone Case iPhone 15,"5",Nos,"1,200.00",1320.00,6000.00,6600.00',
  'WGT100,Chargers,USB-C Wall Charger 20W,3.00,Nos,"Rs. 1,850.00",2035.00,5550.00,6105.00'
].join('\r\n');

const t1 = parseCsvTable(foreign);
check('foreign headers preserved', t1.headers,
  ['Code', 'Product group', 'Product', 'Qty.', 'UOM', 'Cost', 'Cost incl. tax', 'Total before tax', 'Total']);
check('foreign auto-mapping', t1.mapping, {
  sku: 'Code', name: 'Product', category: 'Product group', quantity: 'Qty.',
  cost_price: 'Cost', sell_price: '', low_stock_threshold: ''
});
const r1 = applyColumnMapping(t1.rawRows, t1.mapping);
check('foreign row 1 canonical', r1[0], {
  sku: 'IP15TG', name: 'iPhone 15 Tempered Glass', category: 'Screen Protectors',
  quantity: '10.00', cost_price: '250.00', sell_price: '', low_stock_threshold: ''
});
check('foreign quoted row parsed', [r1[1].sku, r1[1].name, r1[1].quantity, r1[1].cost_price],
  ['CASE, SILICONE', 'Silicone Case iPhone 15', '5', '1200.00']);
check('currency prefix + thousands stripped', [r1[2].sku, r1[2].quantity, r1[2].cost_price],
  ['WGT100', '3.00', '1850.00']);

// 2) Our own template still maps 7/7.
const template = [
  'SKU,Name,Category,Quantity,Cost,Sell Price,Low Stock Threshold',
  'LM-000101,iPhone 15 Tempered Glass,Screen Protectors,10,250,500,3'
].join('\n');
const t2 = parseCsvTable(template);
check('template auto-mapping', t2.mapping, {
  sku: 'SKU', name: 'Name', category: 'Category', quantity: 'Quantity',
  cost_price: 'Cost', sell_price: 'Sell Price', low_stock_threshold: 'Low Stock Threshold'
});
check('template row canonical', applyColumnMapping(t2.rawRows, t2.mapping)[0], {
  sku: 'LM-000101', name: 'iPhone 15 Tempered Glass', category: 'Screen Protectors',
  quantity: '10', cost_price: '250', sell_price: '500', low_stock_threshold: '3'
});

// 3) Other common foreign variants (Sage/QuickBooks style).
const t3 = parseCsvTable('Item Code,Description,On Hand,Reorder Level,Unit Cost,Retail Price\nAB-1,Widget,7,2,10,20');
check('sage-style mapping', t3.mapping, {
  sku: 'Item Code', name: 'Description', category: '', quantity: 'On Hand',
  cost_price: 'Unit Cost', sell_price: 'Retail Price', low_stock_threshold: 'Reorder Level'
});

// 4) Back-compatible parseCsv one-shot.
const r4 = parseCsv(foreign);
check('parseCsv canonical keys', Object.keys(r4[0]).sort(),
  ['category', 'cost_price', 'low_stock_threshold', 'name', 'quantity', 'sell_price', 'sku']);

// 5) guessColumnMapping edge: empty input + never-map columns.
check('empty headers', guessColumnMapping([]),
  { sku: '', name: '', category: '', quantity: '', cost_price: '', sell_price: '', low_stock_threshold: '' });
// 'Group' now exact-maps to category (desirable); the real point of this test
// is that derived columns like 'Total' never map to anything.
const t5 = parseCsvTable('Code,Group,Total\nA,B,99');
check('never-map Total stays unmapped', [t5.mapping.category, t5.mapping.quantity], ['Group', '']);

// 6) CRLF + BOM + blank row handling.
const t6 = parseCsvTable('\uFEFFCode,Product\r\nX1,Thing\r\n\r\n');
check('BOM/CRLF/blank-row', [t6.rawRows.length, t6.rawRows[0].Code, t6.rawRows[0].Product], [1, 'X1', 'Thing']);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
