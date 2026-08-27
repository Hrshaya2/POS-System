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

export const exportToPdf = (columns, rows, fileName, totals = {}) => {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFontSize(16);
    doc.text(fileName, 40, 40);
    doc.setFontSize(10);
    doc.setTextColor('#666');
    doc.text(`Generated: ${new Date().toLocaleString()}`, 40, 56);
    doc.setTextColor('#000');
    doc.setFontSize(9);

    const colWidths = columns.map((c) => {
        const w = Math.max(c.label.length, (totals[c.key] != null ? 'TOTAL' : '').length, 8) * 7;
        return Math.min(w, 180);
    });
    // scale to page width
    const totalW = colWidths.reduce((a, b) => a + b, 0) + 40;
    const scale = totalW > pageWidth ? (pageWidth - 80) / (totalW - 40) : 1;
    const scaled = colWidths.map((w) => Math.round(w * scale));

    let x = 40;
    doc.setLineWidth(0.5);
    doc.line(40, 70, pageWidth - 40, 70);
    // header
    doc.setFontSize(9);
    doc.setFillColor('#f3f4f6');
    let cx = 40;
    scaled.forEach((w, i) => { doc.rect(cx, 74, w, 16, 'F'); const lbl = columns[i].label; doc.text(lbl, cx + 4, 86); cx += w; });
    doc.line(40, 90, pageWidth - 40, 90);

    let y = 94;
    const pageHeight = doc.internal.pageSize.getHeight();
    rows.forEach((row) => {
        if (y + 20 > pageHeight - 40) { doc.addPage(); doc.line(40, y, pageWidth - 40, y); y += 4; }
        cx = 40;
        scaled.forEach((w, i) => { doc.rect(cx, y, w, 14, 'S'); doc.text(displayValue(row, columns[i]), cx + 4, y + 10); cx += w; });
        y += 14;
    });
    // totals row
    if (Object.keys(totals).length) {
        doc.setFillColor('#f9fafb');
        cx = 40;
        scaled.forEach((w, i) => { const isT = totals[columns[i].key] != null; doc.rect(cx, y, w, 16, isT ? 'F' : 'S'); doc.setFontSize(9); doc.text(isT ? displayValue({ [columns[i].key]: totals[columns[i].key] }, columns[i]) : columns[i].label, cx + 4, y + 10); cx += w; });
        y += 18;
    }
    doc.line(40, y, pageWidth - 40, y);
    doc.save(`${fileName}.pdf`);
};
