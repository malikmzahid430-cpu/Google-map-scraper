/**
 * CSV Exporter.
 *
 * Zero dependencies, and zero dependency on Google authentication — this is
 * the export path that must always work.
 */
import { buildColumns, headerRow, toRow, exportFilename } from './columns.js';

/**
 * RFC 4180 quoting. A value is quoted when it contains a delimiter, a quote,
 * a newline, or leading/trailing whitespace.
 */
export function escapeCell(value, delimiter = ',') {
  let s = value == null ? '' : String(value);

  // Neutralise spreadsheet formula injection WITHOUT mangling phone numbers.
  //
  // A naive `/^[=+\-@]/` guard prefixes "+1 904-516-4279" and breaks it. The
  // dangerous shapes are a leading =, @, tab or CR, or a leading +/- followed
  // by a letter or an opening bracket ("=cmd()", "@SUM(A1)", "+HYPERLINK(...)").
  // A leading +/- followed by a DIGIT is just a phone number or a signed value.
  if (/^[=@\t\r]/.test(s) || /^[+\-][A-Za-z(]/.test(s)) s = `'${s}`;

  const mustQuote = s.includes(delimiter) || s.includes('"') || /[\n\r]/.test(s) || /^\s|\s$/.test(s);
  if (!mustQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildCsv(records, selectedFields, opts = {}) {
  const { delimiter = ',', includeBom = true, newline = '\r\n' } = opts;
  const columns = buildColumns(selectedFields);

  const lines = [];
  lines.push(headerRow(columns).map((h) => escapeCell(h, delimiter)).join(delimiter));
  for (const record of records || []) {
    lines.push(toRow(record, columns).map((c) => escapeCell(c, delimiter)).join(delimiter));
  }

  const body = lines.join(newline) + newline;
  // The BOM is what makes Excel open UTF-8 CSV correctly on Windows.
  return includeBom ? `﻿${body}` : body;
}

export function csvFilename(job) {
  return exportFilename(job, 'csv');
}

/** Build a data: URL. Used by the service worker, which has no Blob download. */
export function csvDataUrl(csvText) {
  const bytes = new TextEncoder().encode(csvText);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:text/csv;charset=utf-8;base64,${btoa(binary)}`;
}
