// Barcode utilities for internally-generated item barcodes (Loyal Mobile POS)
//
// Internal barcodes use the format LM-XXXXXX (e.g. LM-000123). They are stored
// in the same SKU field as manufacturer barcodes, so every lookup (sales scan,
// inventory search) treats them identically.
import JsBarcode from 'jsbarcode';

export const INTERNAL_SKU_PREFIX = 'LM-';
const INTERNAL_SKU_REGEX = /^LM-\d{1,6}$/;

// True when the given code is one of our internally generated barcodes.
export const isInternalSku = (code) => INTERNAL_SKU_REGEX.test(String(code || '').trim().toUpperCase());

// Generate a unique internal barcode (LM-XXXXXX).
// Sequential: continues after the highest existing internal number so codes
// stay readable and sortable. Falls back to incrementing on any collision.
export const generateInternalSku = (existingSkus = []) => {
    const used = new Set((existingSkus || []).map((s) => String(s || '').trim().toUpperCase()));

    let max = 0;
    used.forEach((sku) => {
        const m = /^LM-(\d{1,6})$/.exec(sku);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    });

    let n = max + 1;
    let sku = `${INTERNAL_SKU_PREFIX}${String(n).padStart(6, '0')}`;
    while (used.has(sku.toUpperCase()) && n < 999999) {
        n += 1;
        sku = `${INTERNAL_SKU_PREFIX}${String(n).padStart(6, '0')}`;
    }
    return sku;
};

// Render a scannable CODE128 barcode and return it as an SVG markup string.
// Returns '' when the code cannot be encoded (e.g. empty/invalid input).
export const renderBarcodeSvg = (code, options = {}) => {
    const value = String(code || '').trim();
    if (!value) return '';
    try {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        JsBarcode(svg, value, {
            format: 'CODE128',
            displayValue: false,
            margin: 0,
            height: options.height || 48,
            width: options.width || 2,
            background: options.background || '#ffffff',
            lineColor: options.lineColor || '#000000'
        });
        return new XMLSerializer().serializeToString(svg);
    } catch (err) {
        console.warn('[barcode] Unable to render barcode:', err.message);
        return '';
    }
};

// Open a print-friendly label window sized for label printers.
// Default 40mm x 30mm; both dimensions are configurable by the caller
// (persisted in InventoryPage via localStorage).
export const printBarcodeLabel = ({ code, name = '', price = null, widthMm = 40, heightMm = 30 }) => {
    const value = String(code || '').trim();
    if (!value) return;

    const svgMarkup = renderBarcodeSvg(value, { height: Math.round(heightMm * 2.2), width: 2 });
    if (!svgMarkup) return;

    const w = Math.max(15, Number(widthMm) || 40);
    const h = Math.max(10, Number(heightMm) || 30);
    const priceLine = price !== null && price !== undefined && price !== ''
        ? `<div class="price">Rs. ${Number(price).toLocaleString('en-LK')}</div>`
        : '';

    const win = window.open('', '_blank', 'width=460,height=380');
    if (!win) return;

    win.document.write(`<!doctype html>
<html>
<head>
<title>Label ${value}</title>
<style>
  @page { size: ${w}mm ${h}mm; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .label {
    width: ${w}mm;
    height: ${h}mm;
    padding: 1.5mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
    overflow: hidden;
    text-align: center;
  }
  .name {
    font-size: 9px;
    font-weight: bold;
    color: #000;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .price { font-size: 9px; color: #000; margin-top: 0.5mm; }
  .code { font-size: 8px; letter-spacing: 0.5px; font-family: 'Courier New', monospace; color: #000; margin-top: 0.5mm; }
  .label svg { max-width: 96%; max-height: 55%; display: block; }
  .no-print { position: fixed; top: 6px; right: 6px; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <button class="no-print" onclick="window.print()">Print again</button>
  <div class="label">
    <div class="name">${String(name || '').replace(/[<>&]/g, '')}</div>
    ${priceLine}
    ${svgMarkup}
    <div class="code">${value.replace(/[<>&]/g, '')}</div>
  </div>
</body>
</html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
};