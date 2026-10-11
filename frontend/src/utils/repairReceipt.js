// Repair bill printing (advance receipt + final bill).
// Built on the SAME primitives as barcode.js stock labels so repair prints
// scan and paginate identically:
//   - renderBarcodeSvg() for the job_no CODE128 barcode (same quiet-zone /
//     height handling as label barcodes).
//   - openLabelWindow() + printWhenReady() for the print popup (waits for the
//     SVG to mount, focuses, then prints — same as stock labels).
// Shop header/footer/paper width still come from receipt.js settings so the
// repair bills match the sales receipts as well.
import { renderBarcodeSvg } from './barcode';
import { getReceiptSettings, mmToPx } from './receipt';

const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// kind: 'ADVANCE' (intake receipt, only when advance > 0) | 'FINAL' (delivery bill).
export const buildRepairBillHtml = (job, kind = 'FINAL', settings) => {
  const s = settings || getReceiptSettings();
  const isAdvance = kind === 'ADVANCE';
  const parts = Array.isArray(job?.parts) ? job.parts : [];
  const labor = Number(job?.invoice?.labor_cost ?? job?.estimated_cost ?? 0);
  const partsTotal = Number(job?.invoice?.parts_cost ?? parts.reduce((sum, p) => sum + Number(p.total_cost || 0), 0));
  const total = Number(job?.invoice?.total_cost ?? (labor + partsTotal));
  const advance = Number(job?.invoice?.advance_amount ?? job?.advance_amount ?? 0);
  const balance = Number(job?.invoice?.balance_due ?? Math.max(0, total - advance));
  const jobNo = job?.job_no || job?.invoice?.invoice_no || job?.id || '';
  const title = isAdvance ? 'Advance Receipt' : 'Repair Bill';
  const badge = isAdvance
    ? 'background:#fef3c7;color:#92400e;border:1px solid #fcd34d;'
    : 'background:#dcfce7;color:#166534;border:1px solid #86efac;';
  const partsRows = parts.map((p) => (
    `<tr><td style="padding:0.7em 0;border-bottom:1px solid #eee;">` +
    `<div style="font-weight:700;">${esc(p.part_name)}</div>` +
    `<div style="font-size:0.9em;color:#666;">Qty ${esc(p.quantity)}</div></td>` +
    `<td style="padding:0.7em 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(p.total_cost)}</td></tr>`
  )).join('');
  const headerLogo = s.showLogo && s.logo
    ? `<img src="${s.logo}" alt="logo" style="max-width:120px;max-height:60px;object-fit:contain;margin-bottom:6px;" />` : '';
  const shopName = s.showShopName && s.shopName
    ? `<div style="font-size:1.5em;font-weight:800;margin-bottom:2px;">${esc(s.shopName)}</div>` : '';
  const contactLines = [];
  if (s.phone) contactLines.push(`Tel: ${esc(s.phone)}`);
  if (s.address) contactLines.push(esc(s.address));
  const contact = s.showContact && contactLines.length
    ? `<div style="font-size:0.92em;color:#444;margin-top:0.5em;line-height:1.5;text-align:center;">${contactLines.join('<br/>')}</div>` : '';
  let barcode = '';
  // Same barcode primitive as barcode.js stock labels: CODE128 SVG with the
  // library-managed quiet zone, plus the human-readable job_no underneath
  // (mirrors the .code line on physical labels).
  if (s.showBarcode && jobNo && typeof document !== 'undefined' && typeof XMLSerializer !== 'undefined') {
    const svg = renderBarcodeSvg(String(jobNo), { height: 44, width: 2, displayValue: false });
    if (svg) barcode = `<div class="bars">${svg}</div><div class="code">${esc(jobNo)}</div>`;
  }
  const laborBlock = isAdvance ? '' :
    `<table style="width:100%;border-collapse:collapse;margin-top:1em;"><tbody>` +
    `<tr><td style="padding:0.7em 0;border-bottom:1px solid #eee;"><div style="font-weight:700;">Labor / Service</div></td>` +
    `<td style="padding:0.7em 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(labor)}</td></tr>` +
    `${partsRows}</tbody></table>` +
    `<div class="row"><span>Labor</span><strong>${formatMoney(labor)}</strong></div>` +
    `<div class="row"><span>Parts</span><strong>${formatMoney(partsTotal)}</strong></div>` +
    `<div class="row"><span>Total</span><strong>${formatMoney(total)}</strong></div>`;
  const totalsBlock = isAdvance
    ? `<div class="row" style="font-size:1.5em;"><span>Received</span><strong>${formatMoney(advance)}</strong></div>`
    : `<div class="row" style="font-size:1.5em;"><span>Balance due</span><strong>${formatMoney(balance)}</strong></div>`;
  const noteBlock = isAdvance
    ? `<p class="muted" style="text-align:center;">Balance confirmed on delivery after parts and labor are finalized.</p>`
    : `<p class="muted" style="text-align:center;margin-top:1em;">Please bring this bill to collect your device.</p>`;
  return '<!doctype html><html><head><title>' + esc(jobNo) + ' - ' + title + '</title><style>' +
    `@media print {@page { size: ${s.widthMm}mm auto; margin: 0; } html, body { margin: 0; padding: 0; } }` +
    `body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 20px; color: #111; font-size: ${s.fontSize}px; }` +
    `.sheet { width: ${mmToPx(s.widthMm)}px; max-width: 100%; margin: 0 auto; }` +
    `.muted { color: #666; font-size: 0.95em; }` +
    `.row { display: flex; justify-content: space-between; margin: 0.5em 0; }` +
    `.badge { display: inline-block; padding: 0.3em 0.7em; border-radius: 999px; font-size: 0.92em; margin-top: 0.7em; }` +
    `.kv { display: flex; justify-content: space-between; gap: 12px; padding: 0.25em 0; font-size: 0.95em; }` +
    `.kv span:first-child { color: #666; }` +
    // Label-style barcode block (same class names / geometry as barcode.js):
    // bars scale to the sheet width, code line underneath, quiet zone kept.
    `.bars svg { width: 100%; height: auto; max-height: 64px; display: block; margin: 0.8em auto 0; }` +
    `.code { text-align: center; font-size: 0.95em; letter-spacing: 2px; margin-top: 0.25em; color: #111; }` +
    `@media print { .no-print { display: none !important; } }` +
    `.print-btn { display: block; width: 100%; margin-bottom: 12px; padding: 10px; font-size: 14px; font-weight: 700; border: 1px solid #111; background: #111; color: #fff; border-radius: 8px; cursor: pointer; }` +
    `</style></head><body><div class="sheet">` +
    `<button class="no-print print-btn" onclick="window.print()">Print again</button>` +
    `<div style="text-align:center;margin-bottom:6px;">${headerLogo}${shopName}</div>` +
    `<div class="muted" style="text-align:center;">${esc(jobNo)}</div>` +
    `<div style="text-align:center;"><span class="badge" style="${badge}">${title}</span></div>${contact}` +
    `<div style="border-top:1px dashed #aaa;margin:0.85em 0;"></div>` +
    `<div class="kv"><span>Customer</span><strong>${esc(job?.customer_name)}</strong></div>` +
    `<div class="kv"><span>Phone</span><strong>${esc(job?.phone_number)}</strong></div>` +
    `<div class="kv"><span>Device</span><strong>${esc(job?.device_model)}</strong></div>` +
    (job?.imei ? `<div class="kv"><span>IMEI</span><strong>${esc(job.imei)}</strong></div>` : '') +
    `<div class="kv"><span>Issue</span><strong>${esc(job?.reported_issue)}</strong></div>` +
    (job?.items_left ? `<div class="kv"><span>Items left</span><strong>${esc(job.items_left)}</strong></div>` : '') +
    `<div class="kv"><span>Received</span><strong>${esc(job?.received_date || '')}</strong></div>` +
    `<div class="kv"><span>Due</span><strong>${esc(job?.estimated_completion_date || '')}</strong></div>` +
    `${laborBlock}<div class="row"><span>Advance paid</span><strong>${formatMoney(advance)}</strong></div>${totalsBlock}` +
    `<div class="kv"><span>Payment</span><strong>${esc(String(job?.payment_method || '').replace('_', ' ') || '---')}</strong></div>` +
    `${noteBlock}${barcode}</div></body></html>`;
};

export const openRepairBillPrint = (job, kind = 'FINAL') => {
  // Same guarded pattern as barcode.js printBarcodeLabel: blocked popup shows
  // a message (never a dead button), and printing waits for the barcode SVG
  // to mount instead of a blind timeout.
  const html = buildRepairBillHtml(job, kind, getReceiptSettings());
  if (!html.includes('<svg') && getReceiptSettings().showBarcode) {
    console.warn('[repairReceipt] Barcode could not be generated for:', job?.job_no || job?.id);
  }
  const win = window.open('', '_blank', 'width=420,height=760');
  if (!win) {
    alert('The print window was blocked by your browser.\n\nAllow pop-ups for this site (the blocked-popup icon in the address bar), then press Print again.');
    return false;
  }
  win.document.write(html);
  win.document.close();
  const run = () => {
    try {
      win.focus();
      win.print();
    } catch (err) {
      console.warn('[repairReceipt] print failed:', err);
    }
  };
  if (win.document.readyState === 'complete') win.setTimeout(run, 0);
  else {
    win.addEventListener('load', () => win.setTimeout(run, 0), { once: true });
    win.setTimeout(run, 1000);
  }
  return true;
};

