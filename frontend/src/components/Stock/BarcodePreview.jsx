// Live CODE128 barcode preview rendered from the shared barcode utility.
import React, { useMemo } from 'react';
import { renderBarcodeSvg } from '../../utils/barcode';

export default function BarcodePreview({ code, height = 56, className = '' }) {
  const svg = useMemo(() => renderBarcodeSvg(code, { height }), [code, height]);

  if (!code || !svg) {
    return (
      <div className={`flex flex-col items-center justify-center bg-gray-50 dark:bg-slate-800 border border-dashed border-gray-300 dark:border-slate-600 rounded-lg py-4 text-gray-400 dark:text-slate-500 text-xs ${className}`}>
        <span>Barcode preview appears here</span>
        <span className="text-[10px] mt-0.5">once a code is entered or generated</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg py-3 px-2 overflow-hidden ${className}`}>
      {/* The svg now carries its quiet zone, so keep it responsive — scale the whole symbol down together rather than clipping the blank margin. */}
      <div className="w-full flex justify-center [&>svg]:max-w-full [&>svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="font-mono text-xs tracking-widest text-gray-700 dark:text-slate-300 mt-1">{code}</span>
    </div>
  );
}