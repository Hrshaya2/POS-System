// Dark-mode pass. ADDS a `dark:` twin next to each light-mode Tailwind colour
// utility in a className string. It never rewrites an existing token, so the
// pass is inherently idempotent: a second run finds every utility already has a
// twin and changes nothing.
//
// Design rules that keep this safe:
//  * Only neutral (gray) colours are mapped. Blue/green/orange/red/purple accents
//    are left untouched, so status colours and chart series keep their identity.
//  * The twin is appended AFTER the light token, so in the compiled CSS the
//    `dark:` rule wins (same specificity, later in the stylesheet).
//  * Opacity modifiers and state prefixes (hover:, focus:, sm:) are preserved.
//  * Class-strings are matched as whole quoted strings, so JS code and hex
//    colours are never touched.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'src');

// light shade -> dark shade, per property. Dark values keep the same *role*
// (a surface stays a surface, muted text stays muted) at a readable lightness
// against the #0b1220 page.
const TEXT = { 900: 100, 800: 200, 700: 300, 600: 400, 500: 400, 400: 500, 300: 600 };
// `white` is the light twin of a dark card surface, so it is a key here too.
const BG = { white: 800, 50: 950, 100: 800, 200: 800, 300: 700, 400: 700, 500: 600, 600: 600, 700: 800, 800: 900, 900: 950 };
const BORDER = { 50: 800, 100: 800, 200: 700, 300: 700, 400: 600, 500: 600, 600: 500, 700: 700, 800: 700, 900: 700 };
const DIVIDE = { 50: 800, 100: 800, 200: 700, 300: 700, 400: 600 };
const RING = { 50: 700, 100: 700, 200: 600, 300: 600 };
const SHADES = {
  text: TEXT, bg: BG, border: BORDER, divide: DIVIDE, ring: RING,
  placeholder: TEXT, decoration: TEXT, accent: BG, caret: TEXT,
  from: BG, via: BG, to: BG, fill: BG, stroke: TEXT
};

// ---- Accent tints -------------------------------------------------------
// Soft tinted backgrounds (`bg-rose-50`) and their borders (`border-rose-200`)
// are light-mode-only: the pale wash reads as a harsh block on a dark card. In
// dark mode these become a low-alpha wash of the SAME accent at a higher opacity
// for borders and a brighter text shade, so each status keeps its hue and still
// looks intentional rather than merely dimmed.
const ACCENTS = ['blue', 'green', 'emerald', 'orange', 'amber', 'rose', 'red', 'purple', 'indigo', 'teal', 'cyan', 'sky', 'lime', 'fuchsia', 'pink'];
const ACCENT_TINT = {
  50: '500/10',   // background wash
  100: '500/20',
  200: '500/30'   // border
};
const ACCENT_TEXT = { 600: 400, 700: 300, 800: 200, 900: 100, 500: 400, 400: 400 };

// Neutral palettes all map onto slate, so they share one key in `handled`.
const NEUTRAL = new Set(['slate', 'gray', 'white', 'zinc', 'neutral', 'stone']);

// A single Tailwind utility, optionally behind state/variant prefixes, e.g.
//   hover:bg-gray-100/50   sm:text-gray-500   dark:bg-gray-800
// Groups: 1 = prefixes, 2 = property, 3 = shade, 4 = opacity modifier.
const UTIL = /^((?:[a-z-]+:)*)([a-z-]+)-(gray|white)(?:-(\d{2,3}))?(\/[0-9]+)?$/;
// Same shape, but for an accent colour with a numeric shade.
const ACCENT_UTIL = /^((?:[a-z-]+:)*)(text|bg|border|ring|divide|from|via|to)-([a-z]+)-(\d{2,3})$/;

const mapToken = (tok) => {
    const m = tok.match(UTIL);
    if (m) {
        const [, prefixes, prop, colour, shade, opacity = ''] = m;
        // Already has a dark: twin -> leave it completely alone (idempotency).
        if (/(^|:)dark:/.test(prefixes)) return null;
        const shades = SHADES[prop];
        if (!shades) return null;
        // Only a FULLY opaque `bg-white` is a light card surface. `bg-white/10` and
        // friends are translucent overlays whose dark counterpart is not a simple
        // solid, so they are left for the per-file review pass.
        if (colour === 'white' && (opacity || shade)) return null;
        const target = shade ? shades[shade] : shades.white;
        if (target === undefined) return null;
        return `${prefixes}dark:${prop}-slate-${target}${opacity}`;
    }

    // Accent tints: bg-rose-50 -> dark:bg-rose-500/10, border-rose-200 ->
    // dark:border-rose-500/30, text-rose-700 -> dark:text-rose-300.
    const a = tok.match(ACCENT_UTIL);
    if (!a) return null;
    const [, prefixes, prop, accent, shade] = a;
    if (/(^|:)dark:/.test(prefixes)) return null;
    if (!ACCENTS.includes(accent)) return null;

    if (prop === 'text') {
      const target = ACCENT_TEXT[shade];
      return target ? `${prefixes}dark:${prop}-${accent}-${target}` : null;
    }
    const tint = ACCENT_TINT[shade];
    if (!tint) return null;
    return `${prefixes}dark:${prop}-${accent}-${tint}`;
};

// Rewrite one className string, returning the original when nothing applies.
// The original separators are preserved exactly: a twin is inserted after the
// token using whatever whitespace already followed it, so multi-space alignment
// inside template literals survives untouched.
const transformString = (cls) => {
    const parts = cls.split(/(\s+)/);
    // Pre-scan: any property that ALREADY has a dark: twin in this string is left
    // alone. This is what makes the pass idempotent - on a second run every
    // property is already covered, so nothing is added again.
    // NOTE: this matches ANY `dark:<prop>-<colour>` token, including the slate
    // tokens this script itself generates, so a re-run recognises its own output.
    // NOTE: this matches ANY `dark:<prop>-<colour>` token, including the slate
    // and accent tokens this script itself generates, so a re-run recognises its
    // own output. Keyed as prop|accent: `bg` alone is ambiguous because a string
    // can carry both `bg-white` and `bg-rose-50`.
    const handled = new Set();
    for (const tok of parts) {
        // Matches `dark:<prop>-<colour>[-<shade>][/op]`, e.g. dark:bg-slate-800,
        // dark:bg-rose-500/10, dark:text-slate-100.
        const m = tok.match(/^(?:[a-z-]+:)*dark:([a-z-]+)-([a-z]+)(?:-[\d]+)?(?:\/[0-9]+)?$/);
        if (m) handled.add(`${m[1]}|${NEUTRAL.has(m[2]) ? '' : m[2]}`);
    }

    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const tok = parts[i];
        if (!tok.trim()) { out.push(tok); continue; }

        out.push(tok);

        const twin = mapToken(tok);
        if (!twin) continue;

        // Identify the (property, colour-family) pair this token owns.
        const util = tok.match(UTIL);
        const accent = tok.match(ACCENT_UTIL);
        const prop = util ? util[2] : accent[2];
        const colourName = util ? (util[3] || '') : accent[3];
        const key = `${prop}|${NEUTRAL.has(colourName) ? '' : colourName}`;
        if (handled.has(key)) continue;
        handled.add(key);

        // Insert the twin BETWEEN the token and the separator that follows it, so
        // the original spacing (including multi-space alignment inside template
        // literals) is preserved verbatim. The separator is consumed from the
        // source and re-emitted AFTER the twin.
        const next = parts[i + 1];
        const hasSep = next !== undefined && !next.trim();
        if (hasSep) i += 1;                          // consume it from the source
        out.push(' ', twin);
        if (hasSep) out.push(next);
    }
    return out.join('');
};

// A className string literal: "..." or '...' or `...` (no ${} inside).
const STRING = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;

const transformFile = (text) =>
    text.replace(STRING, (full, quote, body) => {
        if (!/[\s]/.test(body)) return full;              // single token, nothing to pair
        if (!/\b(?:bg|text|border|ring|divide|fill|stroke|from|via|to)-/.test(body)) return full;
        if (body.includes('${')) return full;            // template with interpolation
        const next = transformString(body);
        return next === body ? full : `${quote}${next}${quote}`;
    });

const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && /\.(jsx|js)$/.test(full)) out.push(full);
    }
    return out;
};

if (require.main === module) {
    let files = 0, tokens = 0;
    for (const file of walk(ROOT)) {
        const before = fs.readFileSync(file, 'utf8');
        const after = transformFile(before);
        if (after !== before) {
            fs.writeFileSync(file, after, 'utf8');
            files++;
            tokens += (after.match(/dark:/g) || []).length - (before.match(/dark:/g) || []).length;
        }
    }
    console.log(`added ${tokens} dark variants across ${files} files`);
}

module.exports = { transformString, transformFile, mapToken, UTIL };
