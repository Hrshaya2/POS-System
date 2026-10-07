// Light/Dark toggle for the header. Sun shows in dark mode (click to go light),
// Moon shows in light mode (click to go dark) - the icon always states the
// action the user is about to take.
import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme.jsx';

export default function ThemeToggle({ className = '' }) {
    const { isDark, toggleTheme } = useTheme();
    // The pop animation must not run on first paint — only once the user has
    // actually toggled. `touched` flips on the first click and stays true.
    const [touched, setTouched] = React.useState(false);

    return (
        <button
            type="button"
            onClick={() => { setTouched(true); toggleTheme(); }}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={isDark}
            className={`p-2 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-white transition-colors ${className}`}
        >
            {/*
              key={isDark} remounts the icon on every toggle so the pop
              animation replays; without it the class would stay mounted and
              the keyframes would only ever run once per page load.
            */}
            <span key={isDark ? 'sun' : 'moon'} className={touched ? 'theme-icon-pop' : 'inline-flex'}>
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </span>
        </button>
    );
}
