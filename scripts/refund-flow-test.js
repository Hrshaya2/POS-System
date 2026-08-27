// Live end-to-end refund flow verification against a running backend (:5000).
// Usage: node scripts/refund-flow-test.js
const BASE = 'http://localhost:5000';

async function req(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* html error page etc */ }
  return { http: res.status, ok: res.ok, json };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};

(async () => {
  const today = new Date().toISOString().slice(0, 10);

  // --- logins ---
  const cashierLogin = await req('POST', '/api/auth/login', null, { email: 'cashier@nangi.com', password: 'cashier123' });
  const adminLogin = await req('POST', '/api/auth/login', null, { email: 'admin@nangi.com', password: 'admin123' });
  const ct = cashierLogin.json?.token || cashierLogin.json?.user?.token;
  const at = adminLogin.json?.token || adminLogin.json?.user?.token;
  check('login cashier + admin', !!ct && !!at);

  // --- ensure an open cash session ---
  let cur = await req('GET', '/api/sessions/current', ct);
  if (!cur.ok || !cur.json?.id || cur.json.status !== 'open') {
    await req('POST', '/api/sessions/open', ct, { openingCash: 5000 }).catch(() => {});
    cur = await req('GET', '/api/sessions/current', ct);
  }
  const sid = cur.json?.id;
  const expectedBefore = Number(cur.json?.summary?.expectedCash ?? 0);
  console.log(`session ${sid} expectedCash(before)=${expectedBefore}`);

  // --- pick a test accessory ---
  const accs = (await req('GET', '/api/inventory/accessories', ct)).json || [];
  const acc = accs.find((a) => Number(a.quantity) >= 5);
  check('found accessory with quantity >= 5', !!acc, acc ? `${acc.name} q=${acc.quantity} price=${acc.sell_price}` : '');
  if (!acc) throw new Error('no accessory with quantity >= 5 available for testing');
  const q0 = Number(acc.quantity);

  // --- start from the original sale: cashier sells 2 units ---
  const saleRes = await req('POST', '/api/sales/checkout', ct, {
    items: [{ inventoryType: 'accessory', inventoryId: acc.id, quantity: 2 }],
    paymentMethod: 'CASH',
    cashReceived: 9999999
  });
  const sale = saleRes.json?.sale || saleRes.json?.receipt;
  check('sale created (2 units)', saleRes.ok && !!sale, `receipt=${sale?.receipt_no} total=${sale?.total} http=${saleRes.http}`);

  // pre-refund report snapshot
  const repB = await req('GET', `/api/reports?from=${today}&to=${today}`, at);
  const cashBeforeRefund = Number(repB.json?.payment_breakdown?.cash ?? 0);

  // --- (a) partial refund as CASHIER (within limits -> applies immediately) ---
  const rf1 = await req('POST', '/api/refunds', ct, {
    saleId: sale.id,
    items: [{ inventory_type: 'accessory', inventory_id: acc.id, quantity: 1 }],
    reason: 'Defective'
  });
  const r1 = rf1.json?.refund;
  const appliedNow = rf1.ok && ['APPROVED', 'DIRECT'].includes(r1?.approval_status);
  check('partial refund applied for cashier (within limits)', appliedNow,
    `http=${rf1.http} status=${r1?.approval_status} ref=${r1?.refund_reference} total=${r1?.total} method=${r1?.refund_method}`);

  await new Promise((s) => setTimeout(s, 900));

  // stock restored by exactly the refunded quantity
  const accAfter1 = ((await req('GET', '/api/inventory/accessories', ct)).json || []).find((a) => a.id === acc.id);
  const q1 = Number(accAfter1?.quantity);
  check('stock restored after partial refund', q1 === q0 - 2 + 1, `start=${q0} afterSale=${q0 - 2} now=${q1}`);

  // Stock Movement of type REFUND referencing the refund / receipt
  const mvA = await req('GET', `/api/stock/movements?type=REFUND&limit=50`, at);
  const mList = mvA.json?.movements || mvA.json || [];
  const mrowA = mList.find((m) =>
    String(m.reference || '').includes(r1.refund_reference) ||
    String(m.note || '').includes(sale.receipt_no));
  check('Stock Movement type REFUND logged (partial)', !!mrowA,
    mrowA ? `ref=${mrowA.reference} change=${mrowA.quantity_change} note=${(mrowA.note || '').slice(0, 45)}` : `http=${mvA.http} rows=${mList.length}`);

  // cash session reduced by the refund amount
  const cur2 = await req('GET', '/api/sessions/current', ct);
  const expectedAfter1 = Number(cur2.json?.summary?.expectedCash ?? 0);
  check('cash session reduced by refund amount', Math.abs((expectedBefore - expectedAfter1) - Number(r1.total)) < 0.01,
    `before=${expectedBefore} after=${expectedAfter1} refund=${r1.total}`);

  // reports: refund visible with reason + processor; excluded from revenue
  const repA = await req('GET', `/api/reports?from=${today}&to=${today}`, at);
  const row = (repA.json?.refunds || []).find((x) => x.sale_receipt_no === sale.receipt_no);
  check('refunds report shows reason + processed-by', !!row && row.reason === 'Defective' && !!row.initiated_by,
    row ? `reason=${row.reason} by=${row.initiated_by} amt=${row.total}` : '');
  check('revenue totals exclude refunded amounts', Math.abs(Number(repA.json?.payment_breakdown?.cash) - (cashBeforeRefund - Number(r1.total))) < 0.01,
    `preSaleSnapshot=${cashBeforeRefund} afterRefund=${repA.json?.payment_breakdown?.cash} refund=${r1.total}`);

  // --- (b) above-limit refund requires admin approval (PIN gate) ---
  await req('PUT', '/api/store-settings/refund_policy', at, { maxAmount: 1, maxDays: 30, sameMethodRequired: false });
  const pinPut = await req('PUT', '/api/store-settings/admin_refund_pin', at, { value: '2468' });
  check('admin PIN saved via store-settings', pinPut.ok, `http=${pinPut.http}`);

  const qHeld0 = Number((((await req('GET', '/api/inventory/accessories', ct)).json || []).find((a) => a.id === acc.id))?.quantity);
  const rf2 = await req('POST', '/api/refunds', ct, {
    saleId: sale.id,
    items: [{ inventory_type: 'accessory', inventory_id: acc.id, quantity: 1 }],
    reason: 'Damaged'
  });
  const r2 = rf2.json?.refund;
  check('over-limit refund held PENDING for cashier', rf2.ok && r2?.approval_status === 'PENDING' && r2.requires_approval === true,
    `status=${r2?.approval_status} requires_approval=${r2?.requires_approval} ref=${r2?.refund_reference}`);

  const qHeld = Number((((await req('GET', '/api/inventory/accessories', ct)).json || []).find((a) => a.id === acc.id))?.quantity);
  check('no stock side-effects while pending', qHeld === qHeld0, `qty=${qHeld}`);

  const pendList = await req('GET', '/api/refunds?status=PENDING', at);
  check('pending queue lists the refund', (pendList.json?.refunds || []).some((x) => x.id === r2.id), `count=${pendList.json?.count}`);

  const deny = await req('POST', `/api/refunds/${r2.id}/approve`, at, {});
  check('approve without PIN rejected (403)', !deny.ok && deny.http === 403, `http=${deny.http} err=${deny.json?.error}`);

  const appr = await req('POST', `/api/refunds/${r2.id}/approve`, at, { approver_pin: '2468' });
  check('approve with correct admin PIN succeeds', appr.ok && appr.json?.status === 'APPROVED',
    `approvedBy=${appr.json?.refund?.approved_by_name}`);

  await new Promise((s) => setTimeout(s, 900));
  const accFinal = ((await req('GET', '/api/inventory/accessories', ct)).json || []).find((a) => a.id === acc.id);
  const q3 = Number(accFinal?.quantity);
  check('approved over-limit refund restores remaining stock', q3 === q0, `final=${q3} start=${q0}`);

  const mvB = await req('GET', `/api/stock/movements?type=REFUND&limit=50`, at);
  const mListB = mvB.json?.movements || mvB.json || [];
  const countForReceipt = mListB.filter((m) =>
    String(m.reference || '').includes(r1.refund_reference) ||
    String(m.reference || '').includes(r2.refund_reference) ||
    String(m.note || '').includes(sale.receipt_no)).length;
  check('two REFUND movements logged for this receipt', countForReceipt >= 2, `rows=${countForReceipt}`);

  // approved over-limit refund also reduced the session cash once more
  const cur3 = await req('GET', '/api/sessions/current', ct);
  const expectedFinal = Number(cur3.json?.summary?.expectedCash ?? 0);
  check('session cash reflects both refunds', Math.abs((expectedBefore - expectedFinal) - (Number(r1.total) + Number(r2.total))) < 0.01,
    `diff=${(expectedBefore - expectedFinal).toFixed(2)} expect=${(Number(r1.total) + Number(r2.total)).toFixed(2)}`);

  // --- restore normal policy so real usage isn't blocked ---
  await req('PUT', '/api/store-settings/refund_policy', at, { maxAmount: 50000, maxDays: 30, sameMethodRequired: true });
  console.log('\npolicy restored: maxAmount=50000 maxDays=30 sameMethodRequired=true');

  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
