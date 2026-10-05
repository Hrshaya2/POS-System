import React from 'react';
import { ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { formatMoney, formatNumber } from '../../utils/reportExport';

// Paginated table used by every report. `totals` is computed across the FULL
// filtered set (passed in by the parent), not just the visible page.
export default function ReportTable({ columns, rows, total, page, limit, onPage, loading, noDataText }) {
    const totalPages = limit > 0 ? Math.ceil((total || 0) / limit) : 0;
    const start = total ? (page - 1) * limit + 1 : 0;
    const end = total ? Math.min(page * limit, total) : 0;

    const Cell = ({ row, col }) => {
        if (col.render) return col.render(row);
        const v = row[col.key];
        if (v == null || v === '') return <span className="text-gray-400">—</span>;
        if (col.type === 'money') return <span className="tabular-nums">{formatMoney(v)}</span>;
        if (col.type === 'number') return <span className="tabular-nums">{formatNumber(v)}</span>;
        return <span>{v}</span>;
    };

    if (loading) {
        return <tr><td colSpan={columns.length} className="px-4 py-10 text-center text-gray-400 dark:text-slate-500">Loading…</td></tr>;
    }
    if (!rows || rows.length === 0) {
        return (
            <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400 dark:text-slate-500">
                    <div className="flex flex-col items-center gap-2">
                        <AlertCircle size={28} className="text-gray-300" />
                        <span>{noDataText || 'No data for the selected filters.'}</span>
                    </div>
                </td>
            </tr>
        );
    }

    return (
        <>
            <tbody className="bg-white dark:bg-slate-800 divide-y divide-gray-100 dark:divide-slate-800">
                {rows.map((row, i) => (
                    <tr key={row.id || row._id || i} className={i % 2 ? 'bg-gray-50/40' : ''}>
                        {columns.map((col) => (
                            <td key={col.key} className={`px-4 py-2.5 text-sm ${col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'}`}>
                                <Cell row={row} col={col} />
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
            {total !== undefined && (
                <tfoot className="bg-gray-50">
                    <tr>
                        <td colSpan={columns.length} className="px-4 py-3 text-xs text-gray-500 dark:text-slate-400">
                            Showing {start}–{end} of {formatNumber(total)}
                        </td>
                    </tr>
                </tfoot>
            )}
        </>
    );
}

export const PaginationControls = ({ page, limit, total, onPage }) => {
    const totalPages = limit > 0 ? Math.ceil((total || 0) / limit) : 0;
    if (totalPages <= 1) return null;
    return (
        <div className="flex items-center justify-between px-1 py-3 text-sm text-gray-600 dark:text-slate-400">
            <span>Page {page} of {totalPages}</span>
            <div className="flex gap-1">
                <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} className="px-2.5 py-1 rounded-lg border border-gray-200 dark:border-slate-700 disabled:opacity-40">
                    <ChevronLeft size={14} />
                </button>
                <button onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="px-2.5 py-1 rounded-lg border border-gray-200 dark:border-slate-700 disabled:opacity-40">
                    <ChevronRight size={14} />
                </button>
            </div>
        </div>
    );
};
