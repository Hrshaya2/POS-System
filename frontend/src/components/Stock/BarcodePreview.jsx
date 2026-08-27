// Live CODE128 barcode preview rendered from the shared barcode utility.
import React, { useMemo } from 'react';
import { renderBarcodeSvg } from '../../utils/barcode';

export default function BarcodePreview({ code, height = 56, className = '' }) {
  const svg = useMemo(() => renderBarcodeSvg(code, { height }), [code, height]);

  if (!code || !svg) {
    return (
      <div className={`flex flex-col items-center justify-center bg-gray-50 border border-dashed border-gray-300 rounded-lg py-4 text-gray-400 text-xs ${className}`}>
        <span>Barcode preview appears here</span>
        <span className="text-[10px] mt-0.5">once a code is entered or generated</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center bg-white border border-gray-200 rounded-lg py-3 px-2 overflow-hidden ${className}`}>
      <div className="w-full flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="font-mono text-xs tracking-widest text-gray-700 mt-1">{code}</span>
    </div>
  );
}