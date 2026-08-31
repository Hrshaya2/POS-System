// Layout self-test for the shared PDF table exporter (reportExport.js).
// Runs in Node: builds a wide low-stock-style table with very long item names,
// asserts the layout choices (auto-landscape, multi-page, valid PDF) and
// writes a sample PDF you can open to eyeball the wrapping/truncation.
//   node tools/test-pdf-export.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTablePdf } from '../frontend/src/utils/reportExport.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const LONG_NAME = 'iPhone 15 Pro Max Tempered Glass Full Coverage Screen Protector with Installation Kit';
const columns = [
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'name', label: 'Item', type: 'text' },
  { key: 'sku', label: 'SKU', type: 'text' },
  { key: 'quantity', label: 'Qty', type: 'number', align: 'center' },
  { key: 'low_stock_threshold', label: 'Low Stock At', type: 'number', align: 'center' },
  { key: 'cost_price', label: 'Unit Cost', type: 'money', align: 'right' },
  { key: 'stock_value', label: 'Stock Value (cost)', type: 'money', align: 'right' },
  { key: 'status', label: 'Status', type: 'text' }
];

const rows = Array.from({ length: 45 }, (_, i) => ({
  category: 'Screen Protectors',
  name: `${LONG_NAME} — variant ${i + 1}`,
  sku: `LM-${String(1000 + i)}`,
  quantity: i % 4,
  low_stock_threshold: 5,
  cost_price: 1250.75,
  stock_value: (i % 4) * 1250.75,
  status: i % 4 === 0 ? 'Out of stock' : 'Low stock'
}));

const totals = {
  quantity: rows.reduce((s, r) => s + r.quantity, 0),
  stock_value: Math.round(rows.reduce((s, r) => s + r.stock_value, 0) * 100) / 100
};

const doc = buildTablePdf(columns, rows, 'Low Stock Export 2026-08-31', totals);

const w = doc.internal.pageSize.getWidth();
const h = doc.internal.pageSize.getHeight();
const orientation = w > h ? 'landscape' : 'portrait';
const pages = doc.getNumberOfPages();
const bytes = doc.output('arraybuffer');

const outPath = path.join(here, 'sample-low-stock-export.pdf');
fs.writeFileSync(outPath, Buffer.from(bytes));

console.log(`orientation : ${orientation} (${Math.round(w)}x${Math.round(h)}pt)`);
console.log(`pages       : ${pages}`);
console.log(`pdf bytes   : ${bytes.byteLength}`);
console.log(`sample pdf  : ${outPath}`);

const failures = [];
if (orientation !== 'landscape') failures.push('wide table should auto-switch to landscape');
if (pages < 2) failures.push('45 wrapped rows should span more than one page');
if (bytes.byteLength < 2000 || Buffer.from(bytes.slice(0, 4)).toString() !== '%PDF') failures.push('output is not a valid PDF stream');

if (failures.length) {
  console.error(`FAIL: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS: wide low-stock table renders landscape, multi-page, valid PDF.');