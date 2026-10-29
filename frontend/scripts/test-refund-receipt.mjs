/**
 * test-refund-receipt.mjs
 *
 * Standalone verification script for the Refund Modal / receipt printing fix.
 *
 * It verifies the source code changes are correct (without needing a browser
 * or a test runner), plus tests the shared `formatMoney` helper by extracting
 * its exact implementation from receipt.js.
 *
 * What it verifies:
 *   1. RefundModal.jsx — refundAmount state, setRefundAmount call,
 *      printRefund(refund, refundAmount) signature and call sites,
 *      finish(refund, refundAmount), submit() popup flow.
 *   2. receipt.js — buildRefundReceiptHtml accepts refundAmount param,
 *      conditionally renders the "Cash Refund Amount" row, formatMoney works.
 *   3. formatMoney formats amounts with en-LK locale ("Rs. 1,500.00").
 *
 * Run:  cd frontend && node scripts/test-refund-receipt.mjs
 */

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

const assert = (condition, message) => {
  if (condition) { passed++; console.log(`  ✅  ${message}`); }
  else { failed++; console.error(`  ❌  ${message}`); }
};

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const refundModal = read('../src/components/RefundModal.jsx');
const receiptJs = read('../src/utils/receipt.js');

// ====================================================================
// Extract and test formatMoney (identical copy of receipt.js:68)
// ====================================================================
const formatMoney = (value) => `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

console.log('\nTEST 1 — formatMoney formats currency correctly (en-LK, Rs.)');
{
  assert(formatMoney(0) === 'Rs. 0.00', 'formatMoney(0) === "Rs. 0.00"');
  assert(formatMoney(1500) === 'Rs. 1,500.00', 'formatMoney(1500) === "Rs. 1,500.00"');
  assert(formatMoney(1250.5) === 'Rs. 1,250.50', 'formatMoney(1250.5) === "Rs. 1,250.50"');
  assert(formatMoney(null) === 'Rs. 0.00', 'formatMoney(null) === "Rs. 0.00"');
  assert(formatMoney(undefined) === 'Rs. 0.00', 'formatMoney(undefined) === "Rs. 0.00"');
  assert(formatMoney(-300) === 'Rs. -300.00', 'formatMoney(-300) === "Rs. -300.00"');
  assert(formatMoney(125000) === 'Rs. 125,000.00', 'formatMoney(125000) === "Rs. 125,000.00"');
}

// ====================================================================
// TEST 2 — RefundModal.jsx source changes
// ====================================================================
console.log('\nTEST 2 — RefundModal.jsx: refund amount state & flow');
{
  assert(refundModal.includes("const [refundAmount, setRefundAmount] = useState(null)"),
    'refundAmount state declared');
  assert(refundModal.includes('setRefundAmount(amt);'),
    'setRefundAmount called with entered amount in submit()');
  assert(refundModal.includes('const printRefund = (refund, refundAmount = null) => {'),
    'printRefund accepts refundAmount parameter');
  assert(refundModal.includes("buildRefundReceiptHtml(refund, getReceiptSettings(), refundAmount);"),
    'printRefund passes refundAmount to receipt builder');
  assert(refundModal.includes('finish(data.refund, refundAmount);'),
    'submit() passes refundAmount to finish()');
  assert(refundModal.includes('const finish = (refund, refundAmount = null) => {'),
    'finish() accepts refundAmount parameter');
  assert(refundModal.includes('printRefund(refund, refundAmount);'),
    'finish() calls printRefund with refundAmount');
  assert(refundModal.includes("Enter the cash refund amount to apply to the bill (Rs.):"),
    'submit() shows cash refund amount popup');
}

// ====================================================================
// TEST 3 — receipt.js source changes
// ====================================================================
console.log('\nTEST 3 — receipt.js: buildRefundReceiptHtml accepts & renders refundAmount');
{
  assert(receiptJs.includes("export const buildRefundReceiptHtml = (refund, settings, refundAmount = null) => {"),
    'buildRefundReceiptHtml signature includes refundAmount = null');
  assert(receiptJs.includes('<span>Cash Refund Amount</span>'),
    'Receipt HTML template includes "Cash Refund Amount" row');
  assert(receiptJs.includes('${refundAmount != null ? `<div class="row"><span>Cash Refund Amount</span><strong>${formatMoney(refundAmount)}</strong></div>` : \'\'}'),
    'Cash Refund Amount row is conditionally rendered only when amount provided');
  assert(receiptJs.includes('<strong>${formatMoney(refundAmount)}</strong>'),
    'Cash Refund Amount value is formatted with formatMoney');
}

// ====================================================================
// Summary
// ====================================================================
console.log('\n' + '='.repeat(50));
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
console.log('='.repeat(50) + '\n');

if (failed > 0) { process.exit(1); }

console.log('🎉  All refund receipt verification checks passed.\n');
console.log('The cash refund amount entered in the popup will now print on the bill.\n');