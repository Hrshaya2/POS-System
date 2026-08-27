// Backend connectivity self-test for the Stock Management feature.
// Usage:
//   node tools/check-backend.mjs [baseUrl] [authToken]
//   baseUrl defaults to http://localhost:5000
// Examples:
//   node tools/check-backend.mjs
//   node tools/check-backend.mjs http://localhost:5000 eyJhbGciOi...
// It performs READ-ONLY requests - nothing in your database is modified.

const baseUrl = String(process.argv[2] || 'http://localhost:5000').replace(/\/+$/, '');
const token = process.argv[3] || '';

const authHeaders = token
  ? { Authorization: `Bearer ${token}` }
  : {};

async function probe(label, path) {
  const url = `${baseUrl}${path}`;
  try {
    const res = await fetch(url, { headers: authHeaders });
    if (res.status === 404) return `${label}: MISSING (404) -> backend predates Stock Management. Restart/redeploy it.`;
    if (res.status === 401 || res.status === 403) return `${label}: route EXISTS but needs a valid token (pass authToken as arg 2).`;
    if (!res.ok) return `${label}: HTTP ${res.status} -> unexpected, inspect backend logs.`;
    return `${label}: OK (${res.status})`;
  } catch (err) {
    return `${label}: UNREACHABLE (${err.cause?.code || err.message}) -> is the backend running on ${baseUrl}?`;
  }
}

(async () => {
  console.log(`Probing backend at ${baseUrl}\n`);
  console.log(await probe('[legacy] /api/inventory/accessories', '/api/inventory/accessories'));
  console.log(await probe('[stock ] /api/stock/movements      ', '/api/stock/movements?limit=1'));
  console.log(await probe('[stock ] /api/stock/categories     ', '/api/stock/categories'));
  console.log(await probe('[stock ] /api/stock/takes          ', '/api/stock/takes'));
  console.log(await probe('[stock ] /api/stock/imports        ', '/api/stock/imports'));
  console.log('\nIf the stock rows say MISSING/UNREACHABLE while the legacy row says OK,');
  console.log('the running backend process is an older copy - restart it (node index.js)');
  console.log('or redeploy it if you are using the hosted deployment.');
})();
