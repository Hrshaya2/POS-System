// TEMPORARY pass 2: adds dark: twins for hover/focus/ACTIVE state tokens that
// the base-state pass (add-dark-variants.cjs) intentionally skipped because the
// string already had a dark twin for the base property. Additive + idempotent:
// existing tokens are never rewritten; one twin per (state, prop) per string.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'src');

const NEUTRAL = new Set(['gray', 'slate', 'white', 'zinc', 'neutral', 'stone']);

// hover:bg-gray-200  |  focus:border-blue-300  |  active:bg-purple-200/40
// Groups: 1 = non-state prefixes (sm:, print: ...), 2 = state, 3 = prop,
// 4 = colour, 5 = shade, 6 = opacity.
const STATE_TOKEN = /^((?:[a-z-]+:)*)(hover|focus|active):(bg|text|border)-([a-z]+)-(\d{2,3})(?:\/(\d{2,3}))?$/;

// What the dark twin should be, or null when the token already reads fine on a
// dark surface (solid accent buttons, saturated focus rings) - those are left
// alone so status colours keep their identity.
const darkSpec = (prop, colour, shadeStr, opacity) => {
    const shade = Number(shadeStr);
    const op = opacity ? `/${opacity}` : '';
    if (NEUTRAL.has(colour)) {
        if (prop === 'bg') return `bg-slate-700${op}`;
        if (prop === 'text') return 'text-slate-300';
        if (prop === 'border') return 'border-slate-500';
        return null;
    }
    if (prop === 'bg') {
        // Pale tinted washes (<=200) become a low-alpha wash of the same hue;
        // solid accent backgrounds (>=500) are theme-neutral and stay as-is.
        if (shade <= 50) return `bg-${colour}-500/15`;
        if (shade <= 200) return `bg-${colour}-500/20`;
        return null;
    }
    if (prop === 'text') {
        // Dark accent text (>=600) is unreadable on a dark card; lighter shades
        // (accent-400/500) are fine already.
        if (shade >= 800) return `text-${colour}-200`;
        if (shade >= 600) return `text-${colour}-300`;
        return null;
    }
    if (prop === 'border') {
        // Pale borders vanish on dark; keep the hue but brighten it.
        if (shade <= 400) return `border-${colour}-500/60`;
        return null;
    }
    return null;
};

const transformString = (cls) => {
    const parts = cls.split(/(\s+)/);

    // Pre-scan: one twin per (state, prop) per string - if the string already
    // carries a correct dark hover/focus twin (written by hand or by pass 1),
    // the bare light token is its light-mode half and must stay untouched.
    const handled = new Set();
    for (const tok of parts) {
        const m = tok.match(/^(?:[a-z-]+:)*dark:(hover|focus|active):(bg|text|border)-/);
        if (m) handled.add(`${m[1]}|${m[2]}`);
    }

    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const tok = parts[i];
        if (!tok.trim()) { out.push(tok); continue; }
        out.push(tok);

        const m = tok.match(STATE_TOKEN);
        if (!m) continue;
        const [, prefixes, state, prop, colour, shade, opacity] = m;
        // Already dark-scoped -> idempotency (covers re-runs and pass-1 output).
        if (/(^|:)dark:/.test(prefixes)) continue;
        const key = `${state}|${prop}`;
        if (handled.has(key)) continue;
        const spec = darkSpec(prop, colour, shade, opacity);
        if (!spec) continue;
        handled.add(key);

        const twin = `dark:${prefixes}${state}:${spec}`;
        const next = parts[i + 1];
        const hasSep = next !== undefined && !next.trim();
        if (hasSep) i += 1;
        out.push(' ', twin);
        if (hasSep) out.push(next);
    }
    return out.join('');
};

const QUOTED = /(['"])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

const transformBody = (body, singleToken = false) => {
    if (!body.trim()) return null;
    if (!/\b(?:hover|focus|active):/.test(body)) return null;
    if (!/\s/.test(body)) {
        if (!singleToken) return null;
        const next = transformString(body.trim());
        return next === body.trim() ? null : next;
    }
    const next = transformString(body);
    return next === body ? null : next;
};

const transformFile = (text) => {
    // Same scan order as pass 1: templates first (skip ${} bodies), then the
    // inner quoted strings of interpolated templates, then ordinary quotes.
    text = text.replace(/`([^`]*)`/g, (full, body) => {
        if (!body.includes('${')) {
            const next = transformBody(body, true);
            return next === null ? full : `\`${next}\``;
        }
        const inner = body.replace(QUOTED, (s, quote, innerBody) => {
            const next = transformBody(innerBody, true);
            return next === null ? s : `${quote}${next}${quote}`;
        });
        return inner === body ? full : `\`${inner}\``;
    });
    text = text.replace(QUOTED, (full, quote, body) => {
        const next = transformBody(body, false);
        return next === null ? full : `${quote}${next}${quote}`;
    });
    return text;
};

const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile() && /\.jsx$/.test(full)) out.push(full);
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
            tokens += (after.match(/dark:(hover|focus|active):/g) || []).length
                - (before.match(/dark:(hover|focus|active):/g) || []).length;
        }
    }
    console.log(`added ${tokens} dark state variants across ${files} files`);
    // Idempotency proof: a second run must change nothing.
    let again = 0;
    for (const file of walk(ROOT)) {
        const t = fs.readFileSync(file, 'utf8');
        if (transformFile(t) !== t) again++;
    }
    console.log(`re-run changed ${again} files (expected 0)`);
}
