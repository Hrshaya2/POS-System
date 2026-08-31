// Shared report export helpers (Excel via SheetJS / xlsx, PDF via jsPDF).
// These export EXACTLY what is currently shown: the supplied rows after filters.

import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';

export const formatMoney = (value) =>
    `Rs. ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const formatNumber = (value) => Number(value || 0).toLocaleString('en-LK');

// columns = [{ key, label, type: 'money'|'number'|'text'|'date' }]
const valueForCell = (row, col) => {
    const v = row[col.key];
    if (v == null) return '';
    if (col.type === 'money') return Number(v);
    if (col.type === 'number') return Number(v);
    return v;
};

export const exportToExcel = (rows, fileName, columns, sheetTitle = 'Report') => {
    const header = columns.map((c) => c.label);
    const body = rows.map((row) => columns.map((c) => valueForCell(row, c)));
    const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
    ws['!cols'] = columns.map((c, i) => ({ wch: Math.max(c.label.length, 12) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
    XLSX.writeFile(wb, `${fileName}.xlsx`);
};

// Export with a totals row appended after the body (totals computed across the
// full filtered set, not just the visible page — callers pass pre-computed totals).
export const exportToExcelWithTotals = (rows, fileName, columns, totals = {}) => {
    const header = columns.map((c) => c.label);
    const body = rows.map((row) => columns.map((c) => valueForCell(row, c)));
    const totalRow = columns.map((c) => (totals[c.key] !== undefined ? (c.type === 'money' ? Number(totals[c.key]) : Number(totals[c.key])) : 'TOTAL'));
    const ws = XLSX.utils.aoa_to_sheet([header, ...body, totalRow]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, `${fileName}.xlsx`);
};

// Render a single cell's display value for PDF tables.
const displayValue = (row, col) => {
    const v = row[col.key];
    if (v == null || v === '') return '';
    if (col.type === 'money') return formatMoney(v);
    if (col.type === 'number') return formatNumber(v);
    return v;
};

// Wrap a cell value into lines that fit the column width. Any single
// unbreakable chunk (e.g. a very long item name or SKU without spaces) that
// still does not fit is truncated with an ellipsis.
const fitCellLines = (doc, value, maxWidth) => {
    const text = String(value ?? '');
    if (!text) return [''];
    const parts = doc.splitTextToSize(text, maxWidth);
    const chunks = Array.isArray(parts) ? parts : [parts];
    const lines = [];
    for (const chunk of chunks) {
        if (doc.getTextWidth(chunk) <= maxWidth) { lines.push(chunk); continue; }
        let line = chunk;
        while (line.length > 1 && doc.getTextWidth(`${line}…`) > maxWidth) line = line.slice(0, -1);
        lines.push(`${line.trimEnd()}…`);
    }
    return lines;
};

// Build the full PDF document for a table export (without saving). Split out
// from exportToPdf so tools/ scripts can exercise the layout in Node.
export const buildTablePdf = (columns, rows, fileName, totals = {}) => {
    const PAD = 8;         // horizontal padding inside a cell (4pt per side)
    const LINE_H = 11;     // wrapped-line height for the 9pt table font
    const MIN_COL_W = 44;  // no column is squeezed below this width

    // Content-aware widths: measure the widest header/cell per column with a
    // throwaway doc (text metrics don't depend on page size), clamped — so a
    // long item name gets real room instead of a header-length guess.
    const probe = new jsPDF({ unit: 'pt', format: 'a4' });
    probe.setFontSize(9);
    const naturalWidths = columns.map((c) => {
        let w = probe.getTextWidth(c.label) + PAD;
        for (const row of rows) {
            const cw = probe.getTextWidth(displayValue(row, c)) + PAD;
            if (cw > w) w = cw;
        }
        return Math.min(Math.max(w, MIN_COL_W), 260);
    });

    // Wide tables switch to landscape so long names keep room to breathe.
    const PORTRAIT_USABLE = 595.28 - 80;
    const orientation = naturalWidths.reduce((a, b) => a + b, 0) > PORTRAIT_USABLE ? 'landscape' : 'portrait';
    const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const left = 40;
    const right = pageWidth - 40;
    const usableWidth = right - left;

    doc.setFontSize(16);
    doc.text(fileName, left, 40);
    doc.setFontSize(10);
    doc.setTextColor('#666');
    doc.text(`Generated: ${new Date().toLocaleString()} · ${formatNumber(rows.length)} rows`, left, 56);
    doc.setTextColor('#000');
    doc.setFontSize(9);

    // Fit the measured widths to the printable width: shrink proportionally
    // (never below MIN_COL_W) when too wide, stretch evenly when too narrow.
    const naturalTotal = naturalWidths.reduce((a, b) => a + b, 0);
    let widths;
    if (naturalTotal > usableWidth) {
        const overflow = naturalTotal - usableWidth;
        const shrinkableTotal = naturalWidths.reduce((a, w) => a + (w - MIN_COL_W), 0);
        const factor = shrinkableTotal > 0 ? Math.min(1, overflow / shrinkableTotal) : 1;
        widths = naturalWidths.map((w) => Math.max(MIN_COL_W, Math.round(w - (w - MIN_COL_W) * factor)));
        const still = widths.reduce((a, b) => a + b, 0) - usableWidth;
        if (still > 0) {
            // Extreme case (very many columns): scale past the floor just
            // enough to fit, and rely on wrapping/truncation.
            const f = usableWidth / (usableWidth + still);
            widths = widths.map((w) => Math.max(24, Math.floor(w * f)));
        }
    } else {
        const f = usableWidth / naturalTotal;
        widths = naturalWidths.map((w) => Math.round(w * f));
    }
    // Give any rounding leftover to the widest column so the table spans
    // exactly the printable width.
    const diff = usableWidth - widths.reduce((a, b) => a + b, 0);
    if (diff !== 0) widths[widths.indexOf(Math.max(...widths))] += diff;


    // Draw one cell's wrapped lines at (x, yTop) inside a column of width w,
    // honoring the column's align hint ('right' | 'center' | default left).
    const drawCellLines = (lines, x, w, yTop, align) => {
        lines.forEach((line, li) => {
            const yLine = yTop + 11 + li * LINE_H;
            if (align === 'right') doc.text(line, x + w - 4, yLine, { align: 'right' });
            else if (align === 'center') doc.text(line, x + w / 2, yLine, { align: 'center' });
            else doc.text(line, x + 4, yLine);
        });
    };

    // Gray column-header band, repeated on every page of multi-page exports.
    const drawHeaderRow = (yTop) => {
        doc.setLineWidth(0.5);
        doc.line(left, yTop, right, yTop);
        const headerLines = columns.map((c, i) => fitCellLines(doc, c.label, widths[i] - PAD));
        const h = Math.max(16, Math.max(...headerLines.map((l) => l.length)) * LINE_H + 6);
        doc.setFillColor('#f3f4f6');
        let cx = left;
        headerLines.forEach((lines, i) => {
            doc.rect(cx, yTop, widths[i], h, 'F');
            drawCellLines(lines, cx, widths[i], yTop, columns[i].align);
            cx += widths[i];
        });
        doc.line(left, yTop + h, right, yTop + h);
        return yTop + h;
    };

    // Body rows with wrap-aware heights.
    let y = drawHeaderRow(70) + 4;
    rows.forEach((row) => {
        const linesPerCol = columns.map((c, i) => fitCellLines(doc, displayValue(row, c), widths[i] - PAD));
        const h = Math.max(1, ...linesPerCol.map((l) => l.length)) * LINE_H + 5;
        if (y + h > pageHeight - 40) {
            doc.addPage();
            y = drawHeaderRow(50) + 4;
        }
        let cx = left;
        linesPerCol.forEach((lines, i) => {
            doc.rect(cx, y, widths[i], h, 'S');
            drawCellLines(lines, cx, widths[i], y, columns[i].align);
            cx += widths[i];
        });
        y += h;
    });

    // Bold totals row (only the columns that actually have totals are filled).
    if (Object.keys(totals).length) {
        const totalCells = columns.map((c) => (totals[c.key] != null ? displayValue({ [c.key]: totals[c.key] }, c) : c.label));
        const linesPerCol = totalCells.map((text, i) => fitCellLines(doc, text, widths[i] - PAD));
        const h = Math.max(1, ...linesPerCol.map((l) => l.length)) * LINE_H + 6;
        if (y + h > pageHeight - 40) {
            doc.addPage();
            y = drawHeaderRow(50) + 4;
        }
        doc.setFillColor('#f9fafb');
        doc.setFont('helvetica', 'bold');
        let cx = left;
        linesPerCol.forEach((lines, i) => {
            doc.rect(cx, y, widths[i], h, totals[columns[i].key] != null ? 'F' : 'S');
            drawCellLines(lines, cx, widths[i], y, columns[i].align);
            cx += widths[i];
        });
        y += h;
        doc.setFont('helvetica', 'normal');
    }
    doc.line(left, y, right, y);

    // Page footers.
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p += 1) {
        doc.setPage(p);
        doc.setFontSize(8);
        doc.setTextColor('#999');
        doc.text(`Page ${p} of ${pages}`, pageWidth / 2, pageHeight - 20, { align: 'center' });
        doc.setTextColor('#000');
    }

    return doc;
};

export const exportToPdf = (columns, rows, fileName, totals = {}) => {
    buildTablePdf(columns, rows, fileName, totals).save(`${fileName}.pdf`);
};
