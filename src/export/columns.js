/**
 * Field -> column mapping shared by all three exporters, so CSV, Excel and
 * Google Sheets always produce identical columns for the same selection.
 */
import { FIELDS } from '../core/constants.js';

const LABEL = new Map(FIELDS.map((f) => [f.key, f.label]));

/** Column definitions for the selected field keys, in catalogue order. */
export function buildColumns(selectedKeys) {
  const selected = new Set(selectedKeys && selectedKeys.length ? selectedKeys : FIELDS.filter((f) => f.default).map((f) => f.key));
  return FIELDS.filter((f) => selected.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
}

/** One record -> an array of cell values, in column order. */
export function toRow(record, columns) {
  return columns.map((c) => cellValue(record, c.key));
}

export function cellValue(record, key) {
  const v = record ? record[key] : '';
  if (v == null) return '';
  if (key === 'scrapedAt' && v) return formatDate(v);
  if (typeof v === 'number') return String(v);
  return String(v);
}

function formatDate(value) {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(value);
  }
}

export function headerRow(columns) {
  return columns.map((c) => c.label);
}

export function labelFor(key) {
  return LABEL.get(key) || key;
}

/** A safe, descriptive filename stem for an export. */
export function exportFilename(job, ext) {
  const base = [job && job.query, job && job.location]
    .filter(Boolean)
    .join(' - ') || 'al-aqsa-leads';
  const clean = base.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${clean} ${stamp}.${ext}`;
}
