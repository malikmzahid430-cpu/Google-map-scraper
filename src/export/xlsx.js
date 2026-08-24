/**
 * Excel Exporter - writes a real .xlsx with no third-party library.
 *
 * An .xlsx is a ZIP of OOXML parts. We emit the minimum set that Excel,
 * LibreOffice and Google Sheets all accept:
 *   [Content_Types].xml, _rels/.rels, xl/workbook.xml,
 *   xl/_rels/workbook.xml.rels, xl/styles.xml, xl/worksheets/sheet1.xml
 *
 * Strings are written inline (t="inlineStr") rather than through a shared
 * string table - slightly larger, dramatically simpler, and there is no index
 * to corrupt. Numbers are written as numbers so Rating and Lead Score sort
 * correctly in Excel instead of sorting as text.
 */
import { createZip, bytesToBase64 } from './zip.js';
import { buildColumns, headerRow, toRow, exportFilename } from './columns.js';

/**
 * XML text escaping. Also strips the control characters that make Excel
 * declare a file corrupt (everything below 0x20 except tab, LF and CR).
 */
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** A1-style column reference for a zero-based index: 0 -> A, 26 -> AA. */
export function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** These export as real numbers so Excel can sort and filter them properly. */
const NUMERIC_KEYS = new Set(['rating', 'reviewCount', 'leadScore', 'latitude', 'longitude']);

function cellXml(ref, value, key, isHeader) {
  if (value === '' || value == null) return `<c r="${ref}"${isHeader ? ' s="1"' : ''}/>`;

  if (!isHeader && NUMERIC_KEYS.has(key)) {
    const n = Number(value);
    if (Number.isFinite(n) && String(value).trim() !== '') {
      return `<c r="${ref}"><v>${n}</v></c>`;
    }
  }
  const style = isHeader ? ' s="1"' : '';
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(columns, records) {
  const rows = [];

  const headerCells = headerRow(columns)
    .map((label, i) => cellXml(`${colName(i)}1`, label, null, true))
    .join('');
  rows.push(`<row r="1">${headerCells}</row>`);

  records.forEach((record, r) => {
    const values = toRow(record, columns);
    const cells = values
      .map((v, i) => cellXml(`${colName(i)}${r + 2}`, v, columns[i].key, false))
      .join('');
    rows.push(`<row r="${r + 2}">${cells}</row>`);
  });

  const lastCol = colName(Math.max(0, columns.length - 1));
  const lastRow = records.length + 1;

  // Column widths sized from the header plus a sample of the data.
  const cols = columns.map((c, i) => {
    let width = String(c.label).length + 4;
    for (let r = 0; r < Math.min(records.length, 120); r++) {
      const len = String(toRow(records[r], columns)[i] || '').length;
      if (len + 2 > width) width = len + 2;
    }
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(width, 10), 60)}" customWidth="1"/>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** Two cell styles: 0 = normal, 1 = bold header on a light fill. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1D1D1F"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D5DD"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/** Excel sheet names: max 31 chars, and none of the reserved punctuation. */
export function safeSheetName(name) {
  const clean = String(name || 'Leads')
    .replace(SHEET_NAME_BAD, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'Leads').slice(0, 31);
}

const SHEET_NAME_BAD = /[:\\/?*\[\]]/g;

/**
 * Build a complete .xlsx workbook.
 * @returns {Uint8Array}
 */
export function buildXlsx(records, selectedFields, opts = {}) {
  const columns = buildColumns(selectedFields);
  const sheetName = safeSheetName(opts.sheetName || 'Leads');

  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(columns, records || []) },
  ]);
}

export function xlsxFilename(job) {
  return exportFilename(job, 'xlsx');
}

export function xlsxDataUrl(bytes) {
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytesToBase64(bytes)}`;
}
