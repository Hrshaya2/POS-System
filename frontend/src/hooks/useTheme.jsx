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

const STORAGE_KEY = 'pos_theme';

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
        // Enable transitions only for the swap itself. Doing it permanently
        // would make every hover/paint animate, which feels sluggish.
        const root = document.documentElement;
        root.classList.add('theme-transition');
        setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
        window.setTimeout(() => root.classList.remove('theme-transition'), 260);
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
