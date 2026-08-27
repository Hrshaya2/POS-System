// CSV helpers for the Stock Management bulk import (Excel-compatible).
// No external parser dependency - handles quoted fields, escaped quotes,
// embedded commas/newlines and CRLF line endings.

export const IMPORT_TEMPLATE_HEADERS = ['SKU', 'Name', 'Category', 'Quantity', 'Cost', 'Sell Price', 'Low Stock Threshold'];

const csvEscape = (value) => {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

export const toCsv = (rows, headers = IMPORT_TEMPLATE_HEADERS) => {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\r\n');
};

export const downloadCsv = (filename, rows, headers) => {
  const csv = toCsv(rows, headers);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }); // BOM keeps Excel happy
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'import-template.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ---- Generic table parsing (original header casing preserved) ----

const parseLine = (line) => {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
};

// Split on newlines that are not inside quotes.
const splitLines = (clean) => {
  const lines = [];
  let curLine = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '"') inQuotes = !inQuotes;
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (curLine !== '' || lines.length === 0) lines.push(curLine);
      curLine = '';
      if (ch === '\r' && clean[i + 1] === '\n') i++;
    } else {
      curLine += ch;
    }
  }
  if (curLine !== '') lines.push(curLine);
  return lines;
};

const parseTable = (text) => {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const nonEmpty = splitLines(clean).filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return { headers: [], cells: [] };
  const headers = parseLine(nonEmpty[0]);
  const cells = nonEmpty.slice(1).map(parseLine).filter((cl) => cl.some((c) => String(c).trim() !== ''));
  return { headers, cells };
};

// ---- Column auto-matching for exports from other systems ----

// "Qty." -> "qty", "Cost incl. tax" -> "costincltax"
export const normalizeHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Priority-ordered alias candidates per canonical field. Exact normalized
// equality; first unused header wins.
const FIELD_ALIASES = {
  sku: ['sku', 'code', 'itemcode', 'productcode', 'itemno', 'productno', 'itemid', 'productid', 'barcode', 'partno', 'partnumber', 'articleno', 'articlecode'],
  name: ['productname', 'itemname', 'name', 'product', 'item', 'title', 'description', 'itemdescription'],
  category: ['category', 'productgroup', 'group', 'producttype', 'type', 'department', 'dept', 'classification', 'stockgroup'],
  quantity: ['quantity', 'qty', 'stock', 'stockqty', 'stockonhand', 'onhand', 'onhandqty', 'instock', 'qtyinstock', 'stockcount', 'count', 'closingstock', 'systemqty'],
  cost_price: ['cost', 'costprice', 'unitcost', 'purchaseprice', 'buyprice', 'costexcludingtax', 'costexcltax', 'costbeforetax', 'costwithouttax', 'wholesaleprice', 'lastcost'],
  sell_price: ['sellprice', 'sellingprice', 'retailprice', 'retail', 'salesprice', 'saleprice', 'unitprice', 'price', 'rrp', 'mrp', 'pricewithtax', 'priceincltax'],
  low_stock_threshold: ['lowstockthreshold', 'reorderlevel', 'reorderpoint', 'minstocklevel', 'minstock', 'minimumstock', 'minqty', 'minlevel', 'alertqty', 'lowstockalert']
};

// Headers that must never be auto-mapped (derived columns / non-product data).
const NEVER_MAP = new Set([
  'total', 'totalbeforetax', 'totalaftertax', 'totalincludingtax', 'totalincltax',
  'totalexcludingtax', 'totalamount', 'linetotal', 'lineamount',
  'subtotal', 'grandtotal', 'amount', 'uom', 'unit', 'unitofmeasure', 'measure',
  'notes', 'note', 'comments', 'vat', 'tax', 'taxrate', 'gst', 'discount',
  'margin', 'profit', 'supplier', 'vendor', 'location', 'bin', 'shelf'
]);

// Weaker fallback: first header *containing* the hint (still skipping
// never-map headers and derived "incl/total" columns).
const CONTAINS_HINTS = {
  sku: ['code', 'sku'],
  name: ['name', 'product', 'item'],
  category: ['categ', 'group', 'type'],
  quantity: ['qty', 'quant', 'stock', 'onhand'],
  cost_price: ['cost', 'purchase'],
  sell_price: ['sell', 'retail', 'price', 'sale'],
  low_stock_threshold: ['reorder', 'threshold', 'minstock', 'lowstock', 'min']
};

const isDerivedHeader = (n) => NEVER_MAP.has(n) || n.includes('total') || n.includes('incl');

// Returns { [field]: originalHeaderText | '' } guessed from the file's headers.
export const guessColumnMapping = (headers) => {
  const normalized = headers.map(normalizeHeader);
  const mapping = { sku: '', name: '', category: '', quantity: '', cost_price: '', sell_price: '', low_stock_threshold: '' };
  const used = new Set();

  // Pass 1: exact alias match, in field + alias priority order.
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.findIndex((n, i) => n === alias && !used.has(i) && !NEVER_MAP.has(n));
      if (idx !== -1) { mapping[field] = headers[idx]; used.add(idx); break; }
    }
  }
  // Pass 2: contains-based fallback for anything still unmapped.
  for (const [field, hints] of Object.entries(CONTAINS_HINTS)) {
    if (mapping[field]) continue;
    for (const hint of hints) {
      const idx = normalized.findIndex((n, i) => n.includes(hint) && !used.has(i) && !isDerivedHeader(n));
      if (idx !== -1) { mapping[field] = headers[idx]; used.add(idx); break; }
    }
  }
  return mapping;
};

// Parse to raw objects keyed by the file's ORIGINAL header text, plus the
// guessed mapping. Used by the importer's "Map Columns" step.
export const parseCsvTable = (text) => {
  const { headers, cells } = parseTable(text);
  const rawRows = cells.map((cl) => Object.fromEntries(headers.map((h, i) => [h, cl[i] ?? ''])));
  return { headers, mapping: guessColumnMapping(headers), rawRows };
};

// Normalize a numeric cell from arbitrary accounting exports into a plain
// number string. Handles: currency symbols/codes (Rs., LKR, $, €...),
// thousands separators ("1,200.00" / "1.200.000"), European decimals
// ("1250,50"), accounting negatives ("(1200)" -> "-1200"). Returns the
// ORIGINAL string if the result doesn't validate, so downstream validation
// can flag the row as an error instead of us silently mangling data.
export const cleanNumeric = (raw) => {
  let t = String(raw ?? '').trim();
  if (!t) return '';
  // Strip currency codes/symbols, spaces (incl. NBSP) and stray text.
  t = t.replace(/(?:rs|lkr|usd|eur|gbp|inr|aud|npr)\./gi, '')
       .replace(/(?:rs|lkr|usd|eur|gbp|inr|aud|npr)/gi, '')
       .replace(/[$€£¥]/g, '')
       .replace(/[\s\u00A0]/g, '');
  // Accounting-style negative: parentheses.
  const parenNeg = /^\((.*)\)$/.test(t);
  if (parenNeg) t = t.replace(/^\((.*)\)$/, '$1');
  // Keep only digits + separators + sign from here on.
  t = t.replace(/[^0-9.,+-]/g, '');

  const hasDot = t.includes('.');
  const hasComma = t.includes(',');
  if (hasDot && hasComma) {
    // Whichever separator comes last is the decimal point.
    const decSep = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    const thouSep = decSep === ',' ? '.' : ',';
    t = t.split(thouSep).join('');
    if (decSep === ',') t = t.replace(/,/g, '.');
  } else if (hasComma) {
    if (/^-?\d{1,3}(,\d{3})+$/.test(t)) {
      t = t.split(',').join('');                 // thousands: 1,850 -> 1850
    } else if (/,\d{1,2}$/.test(t)) {
      t = t.replace(/,/g, '.');                  // decimal comma: 1250,50
    } else {
      t = t.split(',').join('');                 // anything else: drop commas
    }
  } else if (hasDot) {
    // Dot-thousands only when clearly grouped (1.200.000) and not zero-led.
    if (/^\d{1,3}(\.\d{3}){2,}$/.test(t) || (/^\d{1,3}\.\d{3}$/.test(t) && !/^0/.test(t))) {
      t = t.split('.').join('');
    }
  }

  return /^-?\d+(\.\d+)?$/.test(t) ? (parenNeg ? `-${t}` : t) : String(raw).trim();
};

// Project raw rows through a (user-adjustable) mapping into canonical rows.
export const applyColumnMapping = (rawRows, mapping) => {
  const pick = (row, field) => {
    const h = mapping?.[field];
    return h ? String(row[h] ?? '').trim() : '';
  };
  const pickNum = (row, field) => cleanNumeric(pick(row, field));
  return (rawRows || []).map((r) => ({
    sku: pick(r, 'sku'),
    name: pick(r, 'name'),
    category: pick(r, 'category'),
    quantity: pickNum(r, 'quantity'),
    cost_price: pickNum(r, 'cost_price'),
    sell_price: pickNum(r, 'sell_price'),
    low_stock_threshold: pickNum(r, 'low_stock_threshold')
  }));
};

// Back-compatible one-shot parse: table + auto mapping -> canonical rows.
export const parseCsv = (text) => {
  const { mapping, rawRows } = parseCsvTable(text);
  return applyColumnMapping(rawRows, mapping);
};