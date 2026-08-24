/**
 * DATA view — the record table with per-field status.
 *
 * No blank cell is left unexplained: every empty field carries a status chip
 * whose tooltip says why it is empty, and none of those reasons is an error
 * unless it genuinely failed.
 */
import { FIELDS, FIELD_STATUS } from '../../core/constants.js';
import { fieldStatuses, explainStatus } from '../../core/quality.js';
import { SCOPE } from '../../jobs/dataset.js';
import { esc, onClick, scoreClass, empty, timeAgo, statusChip } from '../ui.js';

const PAGE = 50;
let page = 0;

const COLUMNS = [
  { key: 'serial', label: '#', numeric: true },
  { key: 'businessName', label: 'Business Name' },
  { key: 'category', label: 'Category' },
  { key: 'rating', label: 'Rating', numeric: true },
  { key: 'reviewCount', label: 'Reviews', numeric: true },
  { key: 'fullAddress', label: 'Full Address' },
  { key: 'phone', label: 'Phone' },
  { key: 'website', label: 'Website' },
  { key: 'email', label: 'Email' },
  { key: 'leadScore', label: 'Score', numeric: true },
  { key: 'searchQuery', label: 'Search' },
  { key: 'jobLabel', label: 'Job' },
];

const STATUS_FIELDS = [
  ['website', 'Website'],
  ['phone', 'Phone'],
  ['fullAddress', 'Full Address'],
  ['email', 'Email'],
  ['instagram', 'Instagram'],
  ['facebook', 'Facebook'],
];

export function renderData(state) {
  const all = state.visibleRecords();

  return `
  ${renderScopeCard(state)}
  ${all.length ? renderTable(state, all) : `<div class="card">${empty('&#9776;',
    state.records.length
      ? 'No records match the current filters.<br>Adjust them on the Filter tab.'
      : 'No records yet.<br>Run a collection on the Scrape tab.')}</div>`}
  ${renderSourcesCard(state)}
  `;
}

/* ------------------------------- scope ------------------------------- */

function renderScopeCard(state) {
  const opts = [
    [SCOPE.CURRENT_JOB, 'Current job'],
    [SCOPE.PROJECT, 'Project'],
    [SCOPE.ALL_JOBS, 'All jobs'],
  ];
  return `
  <div class="card tight">
    <h2>Showing <span class="count">${state.visibleRecords().length} of ${state.records.length}</span></h2>
    <div class="seg">
      ${opts.map(([id, label]) => `<button data-scope="${id}" aria-pressed="${state.scope === id}">${label}</button>`).join('')}
    </div>
    ${state.scope === SCOPE.SELECTED ? `<p class="hint tiny" style="margin-top:7px">Showing ${state.selectedJobIds.length} selected job(s). Change the selection on the Jobs tab.</p>` : ''}
    ${state.activeFilterCount() ? `<p class="hint tiny" style="margin-top:7px">${state.activeFilterCount()} filter(s) active.</p>` : ''}
  </div>`;
}

/* ------------------------------- table ------------------------------- */

function renderTable(state, all) {
  const sorted = sortRecords(all, state.sort);
  const start = Math.min(page * PAGE, Math.max(0, sorted.length - 1));
  const slice = sorted.slice(start, start + PAGE);
  const pages = Math.ceil(sorted.length / PAGE);

  const ctx = {
    detailResolved: !!(state.job && state.job.detail && state.job.detail.ranAt),
    enrichRun: !!(state.job && state.job.enrichRan),
    mode: state.job ? state.job.mode : 'standard',
  };

  return `
  <div class="card tight">
    <h2>Records</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${COLUMNS.slice(0, 2).map((c) => `<th data-sort="${c.key}">${esc(c.label)}${state.sort.key === c.key ? (state.sort.dir === 'asc' ? ' &#9650;' : ' &#9660;') : ''}</th>`).join('')}
          <th title="Website · Phone · Full Address · Email · Instagram · Facebook">Fields</th>
          ${COLUMNS.slice(2).map((c) => `<th data-sort="${c.key}">${esc(c.label)}${state.sort.key === c.key ? (state.sort.dir === 'asc' ? ' &#9650;' : ' &#9660;') : ''}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${slice.map((r) => `<tr>
            ${COLUMNS.slice(0, 2).map((c) => cell(r, c)).join('')}
            <td>${renderStatusRow(r, ctx)}</td>
            ${COLUMNS.slice(2).map((c) => cell(r, c)).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${pages > 1 ? `
      <div class="row" style="margin-top:9px;justify-content:center">
        <button data-page="prev" ${page === 0 ? 'disabled' : ''}>Previous</button>
        <span class="muted" style="font-size:11.5px">Page ${page + 1} of ${pages}</span>
        <button data-page="next" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
      </div>` : ''}
    <p class="hint tiny" style="margin-top:8px">
      <span class="st-chip ok">✓</span> found ·
      <span class="st-chip muted">—</span> not published ·
      <span class="st-chip muted">·</span> not requested ·
      <span class="st-chip pending">○</span> pending ·
      <span class="st-chip bad">✗</span> failed. Only ✗ is a technical error.
    </p>
  </div>`;
}

function renderStatusRow(record, ctx) {
  const st = fieldStatuses(record, ctx);
  return `<span class="st-row">${STATUS_FIELDS.map(([key, label]) => {
    const status = st[key] || FIELD_STATUS.NOT_REQUESTED;
    return `<span title="${esc(`${label}: ${explainStatus(status, label)}`)}">${statusChip(status)}</span>`;
  }).join('')}</span>`;
}

function cell(record, col) {
  const raw = record[col.key];
  const value = raw == null ? '' : String(raw);

  if (col.key === 'leadScore') {
    if (!value) return '<td class="num"><span class="muted">—</span></td>';
    return `<td class="num"><span class="score-pill ${scoreClass(value)}">${esc(value)}</span></td>`;
  }
  if (col.key === 'website' && value) {
    return `<td><a href="${esc(value)}" target="_blank" rel="noreferrer noopener" title="${esc(value)}">${esc(shortUrl(value))}</a></td>`;
  }
  if (!value) return '<td><span class="muted">—</span></td>';
  return `<td class="${col.numeric ? 'num' : ''}" title="${esc(value)}">${esc(value)}</td>`;
}

function shortUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function sortRecords(records, sort) {
  const { key, dir } = sort || { key: 'serial', dir: 'asc' };
  const col = COLUMNS.find((c) => c.key === key);
  const sign = dir === 'asc' ? 1 : -1;
  return records.slice().sort((a, b) => {
    if (col && col.numeric) return sign * ((Number(a[key]) || 0) - (Number(b[key]) || 0));
    return sign * String(a[key] || '').localeCompare(String(b[key] || ''), undefined, { sensitivity: 'base' });
  });
}

/* ------------------------------ sources ------------------------------ */

function renderSourcesCard(state) {
  if (!state.sources || state.sources.length < 1) return '';
  return `
  <div class="card tight">
    <h2>Where these came from</h2>
    ${state.sources.map((s) => `
      <div class="queue-item">
        <span class="q">${esc(s.label)}</span>
        <span class="muted" style="font-variant-numeric:tabular-nums">${s.count}</span>
        <span class="st ${esc(s.status)}">${esc(s.status)}</span>
      </div>`).join('')}
    ${state.job && state.job.dedupe ? `
      <p class="hint tiny" style="margin-top:8px">Last deduplication — before ${state.job.dedupe.before}, removed ${state.job.dedupe.removed}, after ${state.job.dedupe.after} (${esc(timeAgo(state.job.dedupe.at))}).</p>` : ''}
  </div>`;
}

/* ------------------------------- events ------------------------------ */

export function bindData() {
  const root = document.getElementById('view-data');

  onClick(root, 'th[data-sort]', async (e, el) => {
    const app = await import('../app.js');
    const key = el.dataset.sort;
    const cur = app.state.sort;
    app.state.sort = { key, dir: cur.key === key && cur.dir === 'asc' ? 'desc' : 'asc' };
    page = 0;
    app.paint();
  });

  onClick(root, '[data-page]', async (e, el) => {
    const app = await import('../app.js');
    page = el.dataset.page === 'next' ? page + 1 : Math.max(0, page - 1);
    app.paint();
  });

  onClick(root, '[data-scope]', async (e, el) => {
    const app = await import('../app.js');
    page = 0;
    await app.setScope(el.dataset.scope, app.state.selectedJobIds);
  });
}
