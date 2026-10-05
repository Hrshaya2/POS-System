// Full-page loading state: the Loyal Mobile logo with a gentle pulse.
//
// Used where the app is waiting on something before it can render (auth/session
// gate, page-level data fetches). Small inline spinners inside buttons and status
// chips deliberately keep using lucide icons - a logo at that size is oversized.
import React from 'react';

export default function LogoLoader({
  size = 72,
  label = 'Loading…',
  showLabel = true,
  className = ''
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center ${className}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <img
        src="/logo-loader.png"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className="logo-loader-mark"
        style={{ width: size, height: size }}
        draggable={false}
      />
      {showLabel && (
        <p className="mt-3 text-sm font-medium text-gray-500 dark:text-slate-400">
          {label}
        </p>
      )}
    </div>
  );
}