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
// (persisted in Stock Management page via localStorage).
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
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  /* The printed page is EXACTLY the label size - never taller. Nothing in this
     document can make it longer: the page box is fixed at ${h}mm by @page, and
     the label box below is shorter still. If the browser print PREVIEW still
     shows a tall page, the paper size selected in the print dialog (usually A4)
     overrides @page - that is a dialog/driver setting, not something CSS can
     force. Select the 35x25mm roll there to see the true output. */
  @media print {
    @page { size: ${w}mm ${h}mm; margin: 0; }
    html, body {
      width: ${w}mm;
      height: ${h}mm;
      margin: 0;
      padding: 0;
      overflow: hidden !important;
    }
  }
  .label {
    width: ${w}mm;
    /* STRICTLY shorter than the page, and NOT ${h}mm. A box that is exactly the
       page height sits right on the page-break boundary, so Chrome resolves the
       sub-pixel round-off by emitting a SECOND, empty page - which a roll label
       printer then feeds as an extra BLANK sticker. The 1mm slack is what keeps
       one label on one sticker; it costs 1mm of trailing whitespace, which is
       inside the label and harmless. (overflow:hidden alone does NOT prevent it.) */
    height: calc(${h}mm - 1mm);
    padding: 1.2mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
    overflow: hidden;
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;
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
  /* absolute, NOT fixed: a fixed element is repeated on every printed page and
     can pull extra page boxes into the paginated output. */
  .no-print { position: absolute; top: 6px; right: 6px; }
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

// Batch label printing: one print job containing one page per label.
// `items` is an array of { code, name, price }; each entry is repeated
// `copiesPerItem` times (qty-per-item option for sheet-style label rolls).
export const printBarcodeLabelsBatch = ({ items = [], widthMm = 40, heightMm = 30, copiesPerItem = 1 }) => {
  const valid = items.filter((it) => String(it?.code || '').trim());
  if (!valid.length) return;

  const w = Math.max(15, Number(widthMm) || 40);
  const h = Math.max(10, Number(heightMm) || 30);
  const copies = Math.max(1, Math.min(1000, Number(copiesPerItem) || 1));

  const esc = (s) => String(s || '').replace(/[<>&]/g, '');
  const labelsHtml = [];
  for (const item of valid) {
    const svgMarkup = renderBarcodeSvg(item.code, { height: Math.round(h * 2.2), width: 2 });
    if (!svgMarkup) continue;
    const priceLine = item.price !== null && item.price !== undefined && item.price !== ''
      ? `<div class="price">Rs. ${Number(item.price).toLocaleString('en-LK')}</div>`
      : '';
    const singleLabel = `
    <div class="label">
      <div class="name">${esc(item.name)}</div>
      ${priceLine}
      ${svgMarkup}
      <div class="code">${esc(item.code)}</div>
    </div>`;
    for (let c = 0; c < copies; c++) labelsHtml.push(singleLabel);
  }

  if (!labelsHtml.length) return;

  const win = window.open('', '_blank', 'width=460,height=380');
  if (!win) return;

  win.document.write(`<!doctype html>
<html>
<head>
<title>Batch labels (${labelsHtml.length})</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #fff; }
  /* One label per page, and the page is EXACTLY ${h}mm - never taller. Each label
     box is a hair shorter than that (see below) AND clips its own overflow, so
     a sub-pixel round-off can never spill onto the next page and feed an extra
     blank sticker. If the print PREVIEW looks taller than the label, the paper
     size chosen in the print dialog (usually A4) is overriding @page. */
  @media print {
    @page { size: ${w}mm ${h}mm; margin: 0; }
    html, body {
      width: ${w}mm;
      margin: 0;
      padding: 0;
      overflow: hidden !important;
    }
  }
  .label {
    width: ${w}mm;
    /* Strictly shorter than the page, so a sub-pixel round-off can never spill
       onto a next page and feed an extra blank sticker. */
    height: calc(${h}mm - 1mm);
    padding: 1.2mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
    overflow: hidden;
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;
    page-break-after: always;
    break-after: page;
  }
  .label:last-child { page-break-after: auto; break-after: auto; }
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
  .no-print { position: absolute; top: 6px; right: 6px; z-index: 10; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
  <button class="no-print" onclick="window.print()">Print again (${labelsHtml.length} labels)</button>
  ${labelsHtml.join('\n')}
</body>
</html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
};