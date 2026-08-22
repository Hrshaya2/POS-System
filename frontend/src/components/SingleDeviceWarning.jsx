import React from 'react';
import { AlertTriangle, MonitorSmartphone } from 'lucide-react';

export default function SingleDeviceWarning({ compact = false }) {
  if (compact) {
    return (
      <div className="flex items-start space-x-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm">
        <MonitorSmartphone size={18} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <p className="font-bold text-amber-800">Offline data is stored on this device only.</p>
          <p className="text-amber-700 mt-1">
            Always use the <strong>same browser and same computer</strong> for billing. Offline sales made here won't
            appear from a different browser/device until this browser reconnects and syncs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
      <div className="flex items-start space-x-3">
        <div className="p-2 rounded-xl bg-amber-100">
          <AlertTriangle size={20} className="text-amber-600" />
        </div>
        <div>
          <h4 className="font-bold text-amber-900 text-sm">Important: Use the same browser & computer for billing</h4>
          <p className="text-amber-800 text-sm mt-1 leading-relaxed">
            This POS keeps offline sales and repair records <strong>inside this browser</strong> on this device and syncs
            them to the cloud when the internet is back. Records made while offline will <strong>not</strong> be visible
            from a different browser or computer until this one reconnects and completes the sync.
          </p>
          <p className="text-amber-700 text-xs mt-2">
            Tip: Always run billing from the designated shop computer to avoid missing pending records.
          </p>
        </div>
      </div>
    </div>
  );
}