// Unit tests for add-dark-variants. Run before applying to the codebase.
const assert = require('assert');
const { transformString, transformFile, mapToken } = require('./add-dark-variants.cjs');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error('FAIL:', name, '\n  ', e.message); process.exitCode = 1; }
};

// --- token mapping -------------------------------------------------------
t('bg-white gets a dark card surface', () => {
  assert.strictEqual(mapToken('bg-white'), 'dark:bg-slate-800');
});
t('text-gray-900 becomes light', () => {
  assert.strictEqual(mapToken('text-gray-900'), 'dark:text-slate-100');
});
t('state prefixes are preserved', () => {
  assert.strictEqual(mapToken('hover:bg-gray-100'), 'hover:dark:bg-slate-800');
});
t('opacity modifiers survive', () => {
  assert.strictEqual(mapToken('bg-gray-50/80'), 'dark:bg-slate-950/80');
});
t('existing dark: is never rewritten (idempotency)', () => {
  assert.strictEqual(mapToken('dark:bg-gray-100'), null);
});
t('accent colours are untouched at full strength', () => {
  // Solid/strong accents are deliberately NOT remapped - only the soft tints
  // (50/100 backgrounds, 200 borders) and text shades get dark variants.
  for (const k of ['bg-blue-600', 'border-emerald-500', 'bg-white/10', 'bg-blue-500', 'bg-rose-600']) {
    assert.strictEqual(mapToken(k), null, k);
  }
});

// --- accent tints --------------------------------------------------------
t('soft accent background gets a dark wash', () => {
  assert.strictEqual(mapToken('bg-rose-50'), 'dark:bg-rose-500/10');
});
t('accent border gets a dark outline', () => {
  assert.strictEqual(mapToken('border-rose-200'), 'dark:border-rose-500/30');
});
t('accent text brightens', () => {
  assert.strictEqual(mapToken('text-rose-700'), 'dark:text-rose-300');
});
t('two accents of the same property both get twins', () => {
  const out = transformString('bg-rose-50 text-rose-700 bg-emerald-50');
  assert.ok(out.includes('dark:bg-rose-500/10'), out);
  assert.ok(out.includes('dark:bg-emerald-500/10'), out);
});
t('accent pass is idempotent', () => {
  const once = transformString('bg-rose-50 border-rose-200 text-rose-700');
  assert.strictEqual(transformString(once), once, 'NOT IDEMPOTENT: ' + once);
});

// --- string transform ----------------------------------------------------
t('adds a twin beside the light token', () => {
  assert.strictEqual(
    transformString('bg-white p-4 text-gray-900'),
    'bg-white dark:bg-slate-800 p-4 text-gray-900 dark:text-slate-100'
  );
});
t('runs twice with no further change', () => {
  const once = transformString('bg-white border-gray-200 text-gray-500 hover:bg-gray-50');
  assert.strictEqual(transformString(once), once, 'NOT IDEMPOTENT');
});
t('only ONE dark twin per property per string', () => {
  const out = transformString('bg-gray-50 bg-gray-100 bg-gray-50');
  assert.strictEqual((out.match(/dark:bg-/g) || []).length, 1, out);
});
t('does not nest dark:dark:', () => {
  assert.ok(!transformString('bg-white text-gray-900').includes('dark:dark:'));
});
t('leaves already-dark strings untouched', () => {
  const s = 'dark:bg-slate-800 dark:text-slate-100';
  assert.strictEqual(transformString(s), s);
});

// --- file transform ------------------------------------------------------
t('only className-ish strings are rewritten', () => {
  const src = `const price = "bg-white";\n<div className="bg-white p-4" />`;
  const out = transformFile(src);
  assert.ok(out.includes('const price = "bg-white";'), 'rewrote a non-class string');
  assert.ok(out.includes('className="bg-white dark:bg-slate-800 p-4"'), out);
});
t('hex colours and JS are untouched', () => {
  const src = `const c = '#f8fafc';\nconst n = 40;`;
  assert.strictEqual(transformFile(src), src);
});
t('template literals with interpolation are skipped', () => {
  const src = '<div className={`bg-white ${x}`} />';
  assert.strictEqual(transformFile(src), src);
});

console.log(`\n${pass} assertions passed`);
