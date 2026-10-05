// Shared icon/color chip per stock movement type (UI convention):
// green up-arrow Stock In, blue down-arrow Sale, pink return Refund,
// orange wrench Adjustment, purple checklist Stock Take, teal import.
import React from 'react';
import { ArrowUpCircle, ArrowDownCircle, RotateCcw, Wrench, ClipboardCheck, FileSpreadsheet } from 'lucide-react';

export const MOVEMENT_TYPES = {
  STOCK_IN: {
    label: 'Stock In',
    icon: ArrowUpCircle,
    chipClass: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30',
    dotClass: 'text-emerald-600'
  },
  SALE: {
    label: 'Sale',
    icon: ArrowDownCircle,
    chipClass: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-500/30',
    dotClass: 'text-blue-600'
  },
  REFUND: {
    label: 'Refund',
    icon: RotateCcw,
    chipClass: 'bg-pink-50 dark:bg-pink-500/10 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-500/30',
    dotClass: 'text-pink-600'
  },
  ADJUSTMENT: {
    label: 'Adjustment',
    icon: Wrench,
    chipClass: 'bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-500/30',
    dotClass: 'text-orange-600'
  },
  STOCK_TAKE: {
    label: 'Stock Take',
    icon: ClipboardCheck,
    chipClass: 'bg-purple-50 dark:bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-500/30',
    dotClass: 'text-purple-600'
  },
  IMPORT: {
    label: 'Import',
    icon: FileSpreadsheet,
    chipClass: 'bg-teal-50 dark:bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-500/30',
    dotClass: 'text-teal-600'
  }
};

export default function MovementBadge({ type }) {
  const meta = MOVEMENT_TYPES[type] || {
    label: type || 'Unknown',
    icon: Wrench,
    chipClass: 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400 border-gray-200 dark:border-slate-700',
    dotClass: 'text-gray-500'
  };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${meta.chipClass}`}>
      <Icon size={14} />
      <span>{meta.label}</span>
    </span>
  );
}

export const formatQtyChange = (m) => {
  const n = Number(m.quantity_change) || 0;
  const sign = n > 0 ? '+' : '';
  const color = n > 0 ? 'text-emerald-600' : n < 0 ? 'text-rose-600' : 'text-gray-500';
  return <span className={`font-bold ${color}`}>{sign}{n}</span>;
};