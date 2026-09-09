// Receipt printing settings + a shared receipt->HTML generator.
// Both the real print (SalesPage) and the Settings live preview render with the
// exact same markup so what you see while editing is what prints.
//
// Settings are stored in localStorage so they survive reloads and work fully
// offline (consistent with the app's offline-first design).

export const DEFAULT_RECEIPT_SETTINGS = {
  version: 1,
  shopName: 'Loyal Mobile',
  showShopName: true,
  showLogo: true,
  logo: '', // dataURL string from an uploaded image
  showHeaderMessage: false,
  headerMessage: '',
  showContact: true,
  phone: '',
  address: '',
  email: '',
  website: '',
  showFooterMessage: true,
  footerMessage: 'Thank you for your purchase!',
  // Width of the receipt paper in millimetres (print roll width).
  widthMm: 58
};

const KEY = 'pos_receipt_settings';

export const getReceiptSettings = () => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_RECEIPT_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    console.warn('[receipt] failed to read settings', err);
  }
  return { ...DEFAULT_RECEIPT_SETTINGS };
};

export const saveReceiptSettings = (partial) => {
  const next = { ...getReceiptSettings(), ...partial };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[receipt] failed to save settings', err);
  }
  return next;
};

// --- HTML escaping so user text can't break the markup ---
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// --- Currency / money formatting (Rs. with the en-LK locale) ---
const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Convert a millimetre width into CSS pixels (96dpi: 1in = 25.4mm = 96px).
export const mmToPx = (mm) => Math.max(40, Math.round((Number(mm) || 58) * 96 / 25.4));



// Build the complete printable receipt HTML from a sale/receipt object plus the
// current settings. Receipt fields (see SalesPage buildLocalReceipt):
//   receipt_no, cashier_name, created_at, items[], subtotal, discount_amount,
//   payment_method, cash_received, change_amount, total
export const buildReceiptHtml = (receipt, settings) => {
  const s = settings || getReceiptSettings();

  const itemsMarkup = (receipt.items || []).map((item) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;">
          <div style="font-weight:700;">${esc(item.name)}</div>
          <div style="font-size:11px;color:#666;">${item.tracked_by === 'IMEI' ? `IMEI ${esc(item.imei)}` : `SKU ${esc(item.sku)}`}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(item.unit_price)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(item.line_total)}</td>
      </tr>
    `).join('');

  const headerLogo = s.showLogo && s.logo
    ? `<img src="${s.logo}" alt="logo" style="max-width:120px;max-height:60px;object-fit:contain;margin-bottom:6px;" />`
    : '';
  const shopNameMarkup = s.showShopName && s.shopName
    ? `<div style="font-size:18px;font-weight:800;margin-bottom:2px;">${esc(s.shopName)}</div>`
    : '';
  const headerMessage = s.showHeaderMessage && s.headerMessage
    ? `<div style="font-size:11px;color:#666;margin-top:6px;white-space:pre-wrap;">${esc(s.headerMessage)}</div>`
    : '';

  const contactLines = [];
  if (s.phone) contactLines.push(`Tel: ${esc(s.phone)}`);
  if (s.address) contactLines.push(esc(s.address));
  if (s.email) contactLines.push(esc(s.email));
  if (s.website) contactLines.push(esc(s.website));
  const contactMarkup = s.showContact && contactLines.length
    ? `<div style="font-size:11px;color:#444;margin-top:6px;line-height:1.5;">${contactLines.join('<br/>')}</div>`
    : '';

  const footerMarkup = s.showFooterMessage && s.footerMessage
    ? `<p style="margin-top:16px;text-align:center;font-size:12px;color:#555;white-space:pre-wrap;">${esc(s.footerMessage)}</p>`
    : '';

  const divider = `<div style="border-top:1px dashed #aaa;margin:10px 0;"></div>`;

  // Paper width: drives the sheet so the printed receipt matches the roll size.
  const sheetWidthPx = mmToPx(s.widthMm);

  return `<!doctype html>
<html>
  <head>
    <title>${esc(receipt.receipt_no)} - Receipt</title>
    <style>
      /* Print at the exact roll width and let the page height auto-size to the
         receipt's own content (size: <roll width>mm auto). This makes the
         browser stop feeding paper immediately after the last receipt line
         instead of padding it out to a fixed A4/Letter page length. */
      @media print {
        @page { size: ${s.widthMm}mm auto; margin: 0; }
        html, body { margin: 0; padding: 0; }
      }
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 20px; color: #111; }
      .sheet { width: ${sheetWidthPx}px; max-width: 100%; margin: 0 auto; }
      table { width: 100%; border-collapse: collapse; margin-top: 14px; }
      .muted { color: #666; font-size: 12px; }
      .row { display: flex; justify-content: space-between; margin: 6px 0; }
      .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #f3f4f6; font-size: 11px; margin-top: 8px; }
    </style>
  </head>
  <body>
    <div class="sheet">
      <div style="text-align:center;margin-bottom:6px;">${headerLogo}${shopNameMarkup}</div>
      <div class="muted" style="text-align:center;">${esc(receipt.receipt_no)}</div>
      <div class="muted" style="text-align:center;">Cashier: ${esc(receipt.cashier_name)}</div>
      <div class="muted" style="text-align:center;">${new Date(receipt.created_at).toLocaleString()}</div>
      <span class="badge">${receipt.pending_sync ? 'Pending sync' : 'Synced'}</span>
      ${headerMessage}
      <table>
        <thead>
          <tr>
            <th style="text-align:left;padding-top:12px;">Item</th>
            <th style="padding-top:12px;">Qty</th>
            <th style="padding-top:12px;text-align:right;">Price</th>
            <th style="padding-top:12px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${itemsMarkup}</tbody>
      </table>
      ${divider}
      <div class="row"><span>Subtotal</span><strong>${formatMoney(receipt.subtotal)}</strong></div>
      <div class="row"><span>Discount</span><strong>- ${formatMoney(receipt.discount_amount)}</strong></div>
      <div class="row"><span>Payment</span><strong>${esc(String(receipt.payment_method || '').replace('_', ' '))}</strong></div>
      ${receipt.payment_method === 'CASH' ? `<div class="row"><span>Cash</span><strong>${formatMoney(receipt.cash_received || 0)}</strong></div><div class="row"><span>Change</span><strong>${formatMoney(receipt.change_amount || 0)}</strong></div>` : ''}
      <div class="row" style="font-size:18px;"><span>Total</span><strong>${formatMoney(receipt.total)}</strong></div>
      ${contactMarkup ? `${divider}${contactMarkup}` : ''}
      ${footerMarkup}
    </div>
  </body>
</html>`;
};

// A realistic sample receipt used for the live preview on the Settings page.
export const SAMPLE_RECEIPT = {
  receipt_no: 'RCPT-PREVIEW-0001',
  cashier_name: 'Sample Cashier',
  created_at: new Date().toISOString(),
  items: [
    { name: 'Wireless Charger', sku: 'WC-001', quantity: 2, unit_price: 1500, line_total: 3000, tracked_by: 'QTY' },
    { name: 'USB-C Cable', sku: 'CBL-004', quantity: 3, unit_price: 600, line_total: 1800, tracked_by: 'QTY' }
  ],
  subtotal: 4800,
  discount_amount: 200,
  total: 4600,
  payment_method: 'CASH',
  cash_received: 5000,
  change_amount: 400,
  pending_sync: false
};

// ---- Refund receipt (negative totals, offline-first) ----
export const buildRefundReceiptHtml = (refund, settings) => {
  const s = settings || getReceiptSettings();
  const itemsMarkup = (refund.items || []).map((item) => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;">
          <div style="font-weight:700;">${esc(item.name)}</div>
          <div style="font-size:11px;color:#666;">${item.tracked_by === 'IMEI' ? `IMEI ${esc(item.imei)}` : `SKU ${esc(item.sku)}`}</div>
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(item.unit_price)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${formatMoney(-Math.abs(item.line_total))}</td>
      </tr>
    `).join('');

  const headerLogo = s.showLogo && s.logo
    ? `<img src="${s.logo}" alt="logo" style="max-width:120px;max-height:60px;object-fit:contain;margin-bottom:6px;" />`
    : '';
  const shopNameMarkup = s.showShopName && s.shopName
    ? `<div style="font-size:18px;font-weight:800;margin-bottom:2px;">${esc(s.shopName)}</div>`
    : '';

  const isRefund = true;
  const badge = `<span class="badge" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;">REFUND</span>`;
  const total = -Math.abs(Number(refund.total || 0));
  const refundMethod = (refund.refund_method || refund.original_payment_method || '').replace('_', ' ');

  return `<!doctype html>
<html>
  <head>
    <title>${esc(refund.refund_reference)} - Refund</title>
    <style>
      /* Same auto-height @page rule as the sales receipt: the height must be
         "auto" so the roll stops feeding right after the refund content ends. */
      @media print {
        @page { size: ${s.widthMm}mm auto; margin: 0; }
        html, body { margin: 0; padding: 0; }
      }
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 20px; color: #111; }
      .sheet { width: ${mmToPx(s.widthMm)}px; max-width: 100%; margin: 0 auto; }
      table { width: 100%; border-collapse: collapse; margin-top: 14px; }
      .muted { color: #666; font-size: 12px; }
      .row { display: flex; justify-content: space-between; margin: 6px 0; }
      .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 11px; margin-top: 8px; }
    </style>
  </head>
  <body>
    <div class="sheet">
      <div style="text-align:center;margin-bottom:6px;">${headerLogo}${shopNameMarkup}</div>
      <div class="muted" style="text-align:center;">${esc(refund.refund_reference)}</div>
      <div class="muted" style="text-align:center;">Cashier: ${esc(refund.initiated_by)}</div>
      <div class="muted" style="text-align:center;">Reason: ${esc(refund.reason)}${refund.reason_note ? ' — ' + esc(refund.reason_note) : ''}</div>
      <div class="muted" style="text-align:center;">Refund method: ${esc(refundMethod)}</div>
      <div class="muted" style="text-align:center;">Original receipt: ${esc(refund.sale_receipt_no)}</div>
      <div class="muted" style="text-align:center;">${new Date(refund.created_at || refund.initiated_at).toLocaleString()}</div>
      ${badge}
      <table>
        <thead>
          <tr>
            <th style="text-align:left;padding-top:12px;">Item</th>
            <th style="padding-top:12px;">Qty</th>
            <th style="padding-top:12px;text-align:right;">Price</th>
            <th style="padding-top:12px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${itemsMarkup}</tbody>
      </table>
      <div class="row"><span>Subtotal</span><strong>- ${formatMoney(refund.subtotal)}</strong></div>
      <div class="row"><span>Refund method</span><strong>${esc(refundMethod)}</strong></div>
      <div class="row" style="font-size:20px;border-top:1px dashed #aaa;margin-top:8px;padding-top:8px;"><span>Total Refunded</span><strong style="color:#b91c1c;">${formatMoney(total)}</strong></div>
      ${s.showFooterMessage && s.footerMessage ? `<p style="margin-top:16px;text-align:center;font-size:12px;color:#555;white-space:pre-wrap;">${esc(s.footerMessage)}</p>` : ''}
    </div>
  </body>
</html>`;
};

export const SAMPLE_REFUND_RECEIPT = {
  refund_reference: 'RFS-PREVIEW-0001',
  initiated_by: 'Admin User',
  reason: 'Defective',
  reason_note: '',
  refund_method: 'CASH',
  original_payment_method: 'CASH',
  sale_receipt_no: 'RCPT-XXXX-0001',
  created_at: new Date().toISOString(),
  items: [
    { name: 'Wireless Charger', sku: 'WC-001', imei: '', quantity: 1, unit_price: 1500, line_total: 1500, tracked_by: 'QTY' }
  ],
  subtotal: 1500,
  total: 1500
};

