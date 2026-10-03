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

// ---- Physical label geometry -------------------------------------------
// The sticker roll is 35mm x 25mm. Geometry below is expressed in MILLIMETRES,
// not pixels, so the printed result is a real physical size. Single-label and
// batch printing share these numbers so the two can never drift apart.
export const DEFAULT_LABEL_WIDTH_MM = 35;
export const DEFAULT_LABEL_HEIGHT_MM = 25;

// Bumped whenever the intended default sticker size changes. Settings saved by
// an older build (e.g. the original 40x30) are discarded rather than silently
// overriding the intended 35x25; changes made after this version are kept.
export const LABEL_SIZE_VERSION = 2;

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// Source units for the generated SVG. The printer rescales this vector artwork
// to the real millimetre size, so these only need to be large enough to keep
// bar edges crisp - they are NOT the printed size.
const BAR_SOURCE_HEIGHT = 100;
const BAR_SOURCE_MODULE_WIDTH = 2;
// Used only if JsBarcode reports no usable size for a code, so a render that
// actually succeeded is never thrown away over missing dimension attributes.
const BAR_SOURCE_FALLBACK_WIDTH = 200;

const resolveLabelSize = (widthMm, heightMm) => {
    const w = clamp(Number(widthMm) || DEFAULT_LABEL_WIDTH_MM, 15, 200);
    const h = clamp(Number(heightMm) || DEFAULT_LABEL_HEIGHT_MM, 10, 200);
    const pad = clamp(h * 0.045, 0.8, 1.6);
    return {
        w, h, pad,
        innerW: w - pad * 2,
        // Text and bar height scale with the label so a custom size still fits.
        // For 35x25 this yields ~2.6mm text and a 10.5mm bar - well above the
        // ~5mm symbol height needed for reliable laser scanning.
        nameSize: clamp(h * 0.105, 1.9, 3.4),
        metaSize: clamp(h * 0.095, 1.7, 3.0),
        codeSize: clamp(h * 0.09, 1.6, 2.6),
        barHeight: clamp(h * 0.42, 4.5, 12),
        gap: clamp(h * 0.02, 0.2, 0.6)
    };
};

// JsBarcode does not guarantee `width`/`height` attributes on the <svg>: depending
// on how it builds the element it may only emit a `viewBox`. Reading the
// attributes alone therefore yields 0, which made every label bail out with
// "Could not build a barcode" and the print button appear dead. Read the viewBox
// as a fallback so both shapes work.
const readSvgSize = (svg) => {
    const attrW = Number(svg.getAttribute('width')) || 0;
    const attrH = Number(svg.getAttribute('height')) || 0;
    if (attrW > 0 && attrH > 0) return { width: attrW, height: attrH };

    const box = (svg.getAttribute('viewBox') || '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    // viewBox = "minX minY width height"
    const vbW = Number.isFinite(box[2]) ? box[2] : 0;
    const vbH = Number.isFinite(box[3]) ? box[3] : 0;
    if (vbW > 0 && vbH > 0) return { width: vbW, height: vbH };

    return { width: attrW, height: attrH };
};

// Render a scannable CODE128 barcode and return it as an SVG markup string.
// Returns '' when the code cannot be encoded (e.g. empty/invalid input).
// The public shape is unchanged (BarcodePreview and the receipt printer use
// it); buildLabelBarcode below adds the physical sizing print needs.
const buildBarcodeElement = (code, options = {}) => {
    const value = String(code || '').trim();
    if (!value) return null;
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
        const size = readSvgSize(svg);
        return { el: svg, width: size.width, height: size.height };
    } catch (err) {
        console.warn('[barcode] Unable to render barcode:', err.message);
        return null;
    }
};

export const renderBarcodeSvg = (code, options = {}) => {
    const built = buildBarcodeElement(code, options);
    return built ? new XMLSerializer().serializeToString(built.el) : '';
};

// Emit the barcode at an exact physical size that fits the space left on the
// sticker. Both axes are scaled by the SAME factor, so the intrinsic aspect
// ratio is preserved and bars are never stretched or squashed. A long
// manufacturer code simply gets a shorter (still scannable) bar rather than
// overflowing the label.
//
// The SVG is also given a viewBox plus explicit mm width/height. Without the
// viewBox the printer has no intrinsic size to scale from, and without real
// dimensions the artwork collapses - both of which look like a blank sticker.
const buildLabelBarcode = (code, m) => {
    const built = buildBarcodeElement(code, { height: BAR_SOURCE_HEIGHT, width: BAR_SOURCE_MODULE_WIDTH });
    if (!built) return '';

    // Last-resort dimensions so a successful render is never discarded: the
    // module count is unknown here, so fall back to a plausible symbol box.
    const srcW = built.width > 0 ? built.width : BAR_SOURCE_FALLBACK_WIDTH;
    const srcH = built.height > 0 ? built.height : BAR_SOURCE_HEIGHT;

    const scale = Math.min(m.innerW / srcW, m.barHeight / srcH);
    const outW = srcW * scale;
    const outH = srcH * scale;

    built.el.setAttribute('viewBox', `0 0 ${srcW} ${srcH}`);
    built.el.setAttribute('preserveAspectRatio', 'none');
    built.el.setAttribute('width', `${outW.toFixed(2)}mm`);
    built.el.setAttribute('height', `${outH.toFixed(2)}mm`);
    return new XMLSerializer().serializeToString(built.el);
};

const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const priceLineHtml = (price) => (
    price !== null && price !== undefined && price !== ''
        ? `<div class="price">Rs. ${escapeHtml(Number(price).toLocaleString('en-LK'))}</div>`
        : ''
);

// Print once the label window has finished parsing, with no arbitrary delay and
// no dependence on requestAnimationFrame.
//
// rAF is NOT usable here: a freshly opened window is backgrounded until focused,
// and browsers throttle/pause rAF in background tabs. The frames may never
// arrive, `win.print()` is never reached, and the click appears to do nothing.
const printWhenReady = (win) => {
    let settled = false;
    const run = () => {
        if (settled) return;
        settled = true;
        try {
            win.focus();
            win.print();
        } catch (err) {
            console.warn('[barcode] print failed:', err);
        }
    };
    if (win.document.readyState === 'complete') win.setTimeout(run, 0);
    else {
        win.addEventListener('load', () => win.setTimeout(run, 0), { once: true });
        // Safety net: if `load` never fires the dialog would never open at all.
        win.setTimeout(run, 1000);
    }
};

const openLabelWindow = (title, html) => {
    const win = window.open('', '_blank', 'width=460,height=380');
    if (!win) {
        // Never fail silently: a blocked popup used to look like a dead button.
        console.warn('[barcode] The print window was blocked by the popup blocker - allow popups to print labels.');
        alert(
            'The print window was blocked by your browser.\n\n' +
            'Allow pop-ups for this site (the blocked-popup icon in the address bar), then press Print again.'
        );
        return null;
    }
    win.document.write(html);
    win.document.close();
    return win;
};

// The printable document for a label window. Single and batch share this so the
// two can never drift apart in page size, margins or typography.
//
// `paginate: true` (batch) gives every label its own page. `paginate: false`
// (single) omits page-break rules entirely - one label, one page, no trailing
// break to turn into an extra blank sticker.
const labelDocumentHtml = ({ title, body, m, paginate }) => {
    const { w, h, pad, innerW, nameSize, metaSize, codeSize, barHeight, gap } = m;
    const breakRules = paginate ? `
    page-break-after: always;
    break-after: page;` : '';

    return `<!doctype html>
<html>
<head>
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* Reset every browser default that could add height around the label. */
  html, body { margin: 0; padding: 0; border: 0; background: #fff; }
  /* @page requests the exact sticker size. The print dialog's paper selector
     can override it (it defaults to A4) - if the preview is much taller than the
     label, choose the 35x25mm roll there. That is a driver setting; no CSS can
     force unsupported hardware. */
  @page { size: ${w}mm ${h}mm; margin: 0; }
  @media print {
    html, body {
      width: ${w}mm;
      margin: 0;
      padding: 0;
      /* No height here on purpose: the label box below sets its own, and a body
         height fighting pagination is what produced extra blank stickers. */
      overflow: hidden !important;
    }
  }
  .label {
    width: ${w}mm;
    /* STRICTLY shorter than the page. A box exactly ${h}mm tall sits ON the
       page-break boundary; Chrome resolves the sub-pixel round-off by emitting a
       SECOND, empty page, which a roll printer feeds as a blank sticker. The 1mm
       slack keeps one label on one sticker. It costs 1mm of trailing whitespace
       INSIDE the label, which the printer cuts away anyway. overflow:hidden does
       NOT prevent the phantom page on its own. */
    height: calc(${h}mm - 1mm);
    padding: ${pad}mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${gap}mm;
    font-family: Arial, Helvetica, sans-serif;
    overflow: hidden;
    text-align: center;
    page-break-inside: avoid;
    break-inside: avoid;${breakRules}
  }
  ${paginate ? '.label:last-child { page-break-after: auto; break-after: auto; }' : ''}
  .name {
    font-size: ${nameSize}mm;
    line-height: 1.15;
    font-weight: bold;
    color: #000;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .price { font-size: ${metaSize}mm; line-height: 1.15; color: #000; }
  .bars { display: flex; align-items: center; justify-content: center; max-width: 100%; height: ${barHeight}mm; }
  .bars svg { max-width: ${innerW}mm; max-height: ${barHeight}mm; display: block; }
  .code { font-size: ${codeSize}mm; line-height: 1.15; letter-spacing: 0.04em; font-family: 'Courier New', monospace; color: #000; }
  /* absolute, NOT fixed: a fixed element is repeated on every printed page and
     can pull extra page boxes into the paginated output. */
  .no-print { position: absolute; top: 2mm; right: 2mm; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
};

// One printable label. Barcode geometry comes from buildLabelBarcode so the SVG
// is sized in millimetres and keeps its aspect ratio.
const labelHtml = ({ code, name, price }, m) => `
    <div class="label">
      <div class="name">${escapeHtml(name)}</div>
      ${priceLineHtml(price)}
      <div class="bars">${buildLabelBarcode(code, m)}</div>
      <div class="code">${escapeHtml(code)}</div>
    </div>`;

// Open a print-friendly label window sized for label printers.
// Default 35mm x 25mm; both dimensions remain configurable by the caller
// (persisted in Stock Management page via localStorage).
export const printBarcodeLabel = ({
    code, name = '', price = null,
    widthMm = DEFAULT_LABEL_WIDTH_MM, heightMm = DEFAULT_LABEL_HEIGHT_MM
}) => {
    const value = String(code || '').trim();
    if (!value) {
        // Previously returned with no message at all, which looks like a dead
        // button. Always say why nothing happened.
        console.warn('[barcode] No barcode/SKU supplied to print.');
        alert('Cannot print label: this item has no SKU / barcode.');
        return;
    }

    const m = resolveLabelSize(widthMm, heightMm);
    const label = labelHtml({ code: value, name, price }, m);
    // Never open a print window for a label with no barcode in it.
    if (!label.includes('<svg')) {
        console.warn('[barcode] Could not build a barcode for:', value);
        alert(`Cannot print label: the barcode for "${value}" could not be generated. Check the browser console for details.`);
        return;
    }

    const win = openLabelWindow(`Label ${value}`, labelDocumentHtml({
        title: `Label ${value}`,
        body: `<button class="no-print" onclick="window.print()">Print again</button>\n${label}`,
        m,
        paginate: false
    }));
    if (win) printWhenReady(win);
};

// Batch label printing: one print job containing one page per label.
// `items` is an array of { code, name, price }; each entry is repeated
// `copiesPerItem` times (qty-per-item option for sheet-style label rolls).
export const printBarcodeLabelsBatch = ({
    items = [],
    widthMm = DEFAULT_LABEL_WIDTH_MM,
    heightMm = DEFAULT_LABEL_HEIGHT_MM,
    copiesPerItem = 1
}) => {
    const valid = items.filter((it) => String(it?.code || '').trim());
    if (!valid.length) {
        console.warn('[barcode] Batch print called with no printable items.');
        alert('Nothing to print: no items with a barcode / SKU were selected.');
        return;
    }

    const m = resolveLabelSize(widthMm, heightMm);
    const copies = Math.max(1, Math.min(1000, Number(copiesPerItem) || 1));

    // One .label per sticker. Copying the rendered string is what makes each
    // requested copy a separate physical label - nothing is re-scaled or reused,
    // so N items x M copies always yields exactly N x M stickers, no gaps.
    const labelsHtml = [];
    for (const item of valid) {
        const markup = labelHtml({ code: item.code, name: item.name, price: item.price }, m);
        if (!markup.includes('<svg')) {
            console.warn('[barcode] Skipping unprintable code:', item.code);
            continue;
        }
        for (let c = 0; c < copies; c++) labelsHtml.push(markup);
    }

    if (!labelsHtml.length) return;

    const win = openLabelWindow(
        `Batch labels (${labelsHtml.length})`,
        labelDocumentHtml({
            title: `Batch labels (${labelsHtml.length})`,
            body: `<button class="no-print" onclick="window.print()">Print again (${labelsHtml.length} labels)</button>\n${labelsHtml.join('\n')}`,
            m,
            paginate: true
        })
    );
    if (win) printWhenReady(win);
};
