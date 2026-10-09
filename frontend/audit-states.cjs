// Temporary audit: flags className-ish strings whose light hover/focus/active
// state tokens have no dark: twin. Popup/menu surfaces only (per task scope).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'src');
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && /\.jsx$/.test(full)) out.push(full);
  }
  return out;
};

// Light neutral/accent state tokens that would visibly flash in dark mode.
const STATE_TOKEN = /^(?:[a-z-]+:)*(hover|focus|active):(bg|text|border)-(gray|white|slate|zinc|blue|emerald|rose|amber|red|green|indigo|purple|orange|teal|sky|cyan|pink|fuchsia|lime)-(\d{2,3})(?:\/\d+)?$/;
const HAS_DARK = /(^|:)dark:/;

const results = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // Pull quoted strings + template literals from the line.
    const strings = [...line.matchAll(/(['"`])((?:(?!\1)[^\n\\]|\\.)*)\1/g)].map((m) => m[2]);
    for (const s of strings) {
      if (!/\b(hover|focus|active):/.test(s)) continue;
      if (!/\b(?:bg|text|border)-/.test(s)) continue;
      const tokens = s.split(/\s+/);
      const bare = tokens.filter((t) => STATE_TOKEN.test(t) && !HAS_DARK.test(t));
      if (!bare.length) continue;
      // Any dark twin for the same state+prop in the string? (rough heuristic)
      const stateful = bare.map((t) => t.split(':').filter((p) => /^(hover|focus|active)$/.test(p))).flat();
      const hasTwinFor = (state, prop) => tokens.some((t) => new RegExp(`(^|:)dark:.*`).test(t) && t.includes(`${state}:`) && t.includes(`${prop}-`));
      const missing = bare.filter((t) => {
        const m = STATE_TOKEN.exec(t);
        return !hasTwinFor(m[1], m[2]);
      });
      if (missing.length) {
        results.push(`${path.relative(ROOT, file)}:${i + 1}  [${missing.join(' ')}]`);
      }
    }
  });
}
console.log(results.length ? results.join('\n') : 'no bare light state tokens found');
console.log(`\n${results.length} flagged lines`);
