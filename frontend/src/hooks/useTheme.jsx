// Light / Dark theme for the whole app.
//
// Persisted in localStorage so the choice survives navigation and refreshes, and
// mirrored onto <html class="dark"> because Tailwind v4's `dark:` variant is
// class-based (see index.css @custom-variant).
//
// First paint is handled by the inline script in index.html, which sets the same
// class before React mounts. That is deliberate: doing it in an effect would
// show a white flash on every reload.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';

const STORAGE_KEY = 'pos_theme';

// Wipe classes applied to <html> while a View Transition runs (see index.css).
// Kept at module scope together with the sequence counter so rapid clicks can
// never let an older transition's cleanup strip the newer one's class.
const WIPE_CLASSES = ['vt-wipe-down', 'vt-wipe-up'];
let wipeSeq = 0;
let activeTransition = null;

const prefersReducedMotion = () =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Kept in sync with the inline bootstrap in index.html.
export const getInitialTheme = () => {
    if (typeof window === 'undefined') return 'light';
    try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved === 'dark' || saved === 'light') return saved;
    } catch (err) { /* private mode / storage disabled */ }
    return 'light';
};

export const applyTheme = (theme) => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
};

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
    const [theme, setTheme] = useState(getInitialTheme);

    useEffect(() => {
        applyTheme(theme);
        try { window.localStorage.setItem(STORAGE_KEY, theme); } catch (err) { /* ignore */ }
    }, [theme]);

    const toggleTheme = useCallback(() => {
        const root = document.documentElement;
        // Read the target from the DOM rather than from state: it is always
        // current (applyTheme keeps it in sync) and avoids a stale closure if
        // this callback is ever kept across renders.
        const next = root.classList.contains('dark') ? 'light' : 'dark';

        // Tier 2 - plain colour fade, exactly the original mechanism. Used when
        // the View Transitions API is missing (Firefox/older browsers) or the
        // user asked for reduced motion.
        const runFade = () => {
            // Enable transitions only for the swap itself. Doing it permanently
            // would make every hover/paint animate, which feels sluggish.
            root.classList.add('theme-transition');
            setTheme(next);
            window.setTimeout(() => root.classList.remove('theme-transition'), 260);
        };

        // Tier 1 - the day/night edge wipe. Requires the View Transitions API.
        const canWipe =
            typeof document.startViewTransition === 'function'
            && !prefersReducedMotion();

        if (!canWipe) {
            runFade();
            return;
        }

        // Only the toggle button calls this, but if a wipe is already running,
        // skip it so a second click starts clean instead of queueing.
        if (activeTransition && typeof activeTransition.skipTransition === 'function') {
            activeTransition.skipTransition();
        }

        // Latest wipe wins: an older transition's cleanup must not remove the
        // class belonging to the one now in flight.
        const id = ++wipeSeq;
        WIPE_CLASSES.forEach((c) => root.classList.remove(c));
        // Night falls from the top; day rises from the bottom.
        root.classList.add(next === 'dark' ? 'vt-wipe-down' : 'vt-wipe-up');

        let transition;
        try {
            transition = document.startViewTransition(() => {
                // Both steps are synchronous on purpose: the snapshot must see
                // the fully-updated DOM (Tailwind classes AND components that
                // read isDark, e.g. dashboard chart colours) before the
                // callback resolves. React state updates alone would flush
                // later than the capture.
                applyTheme(next);
                flushSync(() => setTheme(next));
            });
        } catch {
            // Any failure here must degrade to the plain fade, never a broken
            // half-wiped page.
            WIPE_CLASSES.forEach((c) => root.classList.remove(c));
            runFade();
            return;
        }

        activeTransition = transition;
        transition.finished
            .catch(() => { /* a skipped/rejected transition still lands here */ })
            .finally(() => {
                if (id === wipeSeq) {
                    WIPE_CLASSES.forEach((c) => root.classList.remove(c));
                    activeTransition = null;
                }
            });
    }, []);

    const value = useMemo(
        () => ({ theme, isDark: theme === 'dark', setTheme, toggleTheme }),
        [theme, toggleTheme]
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => {
    const ctx = useContext(ThemeContext);
    if (!ctx) {
        // Tolerate a component rendered outside the provider (e.g. in a test)
        // rather than throwing and blanking the screen.
        return { theme: 'light', isDark: false, setTheme: () => {}, toggleTheme: () => {} };
    }
    return ctx;
};
