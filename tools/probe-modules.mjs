// Probes a running Vite dev server: every app module must transform cleanly.
// A compile/import failure shows up as HTTP 500 with the actual error text.
import http from 'node:http';
import fs from 'node:fs';

const base = 'http://127.0.0.1:5199';
const srcDir = 'd:/Nangi/POS/frontend/src';

const get = (p) => new Promise((resolve) => {
  http.get(base + p, (r) => {
    let body = '';
    r.on('data', (d) => { body += d; });
    r.on('end', () => resolve({ status: r.statusCode, body }));
  }).on('error', (e) => resolve({ status: 0, body: e.message }));
});

const targets = [
  '/',
  '/stock',
  '/src/main.jsx',
  '/src/App.jsx',
  '/src/pages/StockManagementPage.jsx',
  '/src/services/stockService.js',
  '/src/services/syncService.js',
  '/src/db/database.js'
];
for (const f of fs.readdirSync(srcDir + '/components/Stock')) {
  targets.push('/src/components/Stock/' + f);
}

let bad = 0;

// Wait for the dev server to accept connections (up to ~30s).
let ready = false;
for (let i = 0; i < 30 && !ready; i += 1) {
  const warm = await get('/');
  ready = warm.status !== 0;
  if (!ready) await new Promise((r) => setTimeout(r, 1000));
}
if (!ready) {
  console.log('DEV SERVER NEVER STARTED');
  process.exit(2);
}

for (const p of targets) {
  const r = await get(p);
  const ok = r.status === 200;
  if (!ok) bad += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL ' + r.status}  ${p}`);
  if (!ok) console.log('     >>', r.body.replace(/\s+/g, ' ').slice(0, 240));
}
console.log(bad === 0 ? '\nALL MODULES TRANSFORM CLEANLY' : `\n${bad} MODULE(S) FAILED`);
process.exit(bad ? 1 : 0);
