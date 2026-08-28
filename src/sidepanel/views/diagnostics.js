/**
 * DIAGNOSTICS view.
 *
 * Grouped, so a missing field never looks like a broken program:
 *   COLLECTION        — did the feed work, how much did it find
 *   DETAIL RESOLUTION — what the place panels yielded
 *   DATA QUALITY      — coverage. Blanks live here.
 *   TECHNICAL         — the only place errors appear
 */
import { HEALTH, describe } from '../../core/diagnostics.js';
import { esc, onClick, banner, empty, agoShort, coverageRow } from '../ui.js';

const ICON = {
  [HEALTH.OK]: '&#10003;',
  [HEALTH.DEGRADED]: '&#9888;',
  [HEALTH.FAIL]: '&#10007;',
  [HEALTH.UNKNOWN]: '&#8211;',
};

export function renderDiagnostics(state) {
  const d = state.diagnostics;
  if (!d) return `<div class="card">${empty('&#9881;', 'Running diagnostics…')}</div>`;
  if (d.error) {
    return `<div class="card">${banner('error', `<strong>Diagnostics could not run.</strong><br>${esc(d.error)}`)}
      <button class="block" data-act="rerun">Run again</button></div>`;
  }

  return `
  <div class="card tight">
    <button class="ghost" data-act="back-to-settings">&larr; Settings</button>
  </div>
  ${renderCollection(d, state)}
  ${renderDetail(d)}
  ${renderQuality(d)}
  ${renderTechnical(d)}
  ${renderModules(d.modules)}
  ${renderSheets(d.sheets)}
  ${renderSample(d.page)}
  ${renderDetailProbe(d.page)}

  <div class="card tight">
    <button class="primary block" data-act="rerun">Run diagnostics again</button>
    <p class="hint tiny" style="margin-top:8px">A module shows &#10003; only after it has genuinely succeeded in this session. &#8211; means it has not been exercised yet, which is not a failure.</p>
  </div>`;
}

/* ----------------------------- COLLECTION ---------------------------- */

function renderCollection(d, state) {
  const page = d.page || {};
  const job = d.job;

  const rows = [];
  if (page.error) {
    rows.push(['Google Maps tab', 'degraded', page.error]);
  } else {
    rows.push(['Feed detected', page.feedFound ? 'ok' : 'degraded', page.feedSelector || 'no feed selector matched']);
    rows.push(['Cards rendered', page.cardCount > 0 ? 'ok' : 'degraded', `${page.cardCount} currently in the DOM`]);
    rows.push(['End of list', 'info', page.atEnd ? 'reached' : 'not yet — more may load on scroll']);
  }
  if (job) {
    rows.push(['Unique places collected', job.counts.found > 0 ? 'ok' : 'info', `${job.counts.found} unique`]);
    rows.push(['Cards inspected', 'info', `${job.counts.scanned || 0} card reads (repeats are expected — the feed recycles nodes)`]);
    rows.push(['Scroll attempts', 'info', `${job.counts.scrolls || 0}`]);
    rows.push(['Last activity', job.stuck ? 'degraded' : 'ok',
      `${agoShort(job.lastActivityAt, state.now)}${job.lastActivity ? ` · ${job.lastActivity}` : ''}${job.stuck ? ' — possibly stuck' : ''}`]);
  }

  return `
  <div class="diag-group">
    <div class="card">
      <h2>Collection</h2>
      <div class="diag-list">${rows.map(row).join('')}</div>
    </div>
  </div>`;
}

/* -------------------------- DETAIL RESOLUTION ------------------------ */

function renderDetail(d) {
  const job = d.job;
  const det = (job && job.detail) || d.detail || {};
  if (!det.total && !det.done) {
    return `
    <div class="card">
      <h2>Detail resolution</h2>
      <p class="hint">Not run yet. Standard and Advanced modes start it automatically once collection finishes; you can also run it from the Enrich tab.</p>
    </div>`;
  }
  const rows = [
    ['Processed', 'info', `${det.done || 0} of ${det.total || 0}`],
    ['Details found', (det.resolved || 0) > 0 ? 'ok' : 'info', `${det.resolved || 0} place(s) returned data`],
    ['Nothing published', 'info', `${det.notFound || 0} place(s) expose no address, website or phone — normal, not an error`],
    ['Failed', (det.failed || 0) > 0 ? 'degraded' : 'ok', `${det.failed || 0} technical failure(s)`],
  ];
  return `
  <div class="card">
    <h2>Detail resolution</h2>
    <div class="diag-list">${rows.map(row).join('')}</div>
  </div>`;
}

/* ---------------------------- DATA QUALITY --------------------------- */

function renderQuality(d) {
  const q = d.quality;
  if (!q || !q.total) return '';
  return `
  <div class="card">
    <h2>Data quality <span class="count">${q.complete} of ${q.total} complete</span></h2>
    ${q.rows.map(coverageRow).join('')}
    <p class="hint tiny" style="margin-top:8px">These are coverage counts. A blank field means Google or the business does not publish it — it is never counted as an error.</p>
  </div>`;
}

/* ----------------------------- TECHNICAL ----------------------------- */

function renderTechnical(d) {
  const t = d.technical || { total: 0, byCategory: {}, recent: [] };
  const cats = t.byCategory || {};
  return `
  <div class="card">
    <h2>Technical</h2>
    <div class="health ${t.total ? 'some' : 'zero'}"><span>Total technical errors</span><span class="n">${t.total || 0}</span></div>
    <div class="health ${cats.parser ? 'some' : 'zero'}"><span>Parser exceptions</span><span class="n">${cats.parser || 0}</span></div>
    <div class="health ${cats.timeout ? 'some' : 'zero'}"><span>Timeouts</span><span class="n">${cats.timeout || 0}</span></div>
    <div class="health ${cats.storage ? 'some' : 'zero'}"><span>Storage failures</span><span class="n">${cats.storage || 0}</span></div>
    <div class="health ${cats.communication ? 'some' : 'zero'}"><span>Communication failures</span><span class="n">${cats.communication || 0}</span></div>
    <div class="health ${cats.collector ? 'some' : 'zero'}"><span>Collector failures</span><span class="n">${cats.collector || 0}</span></div>
    ${t.recent && t.recent.length ? `
      <div class="divider"></div>
      ${t.recent.slice(-4).reverse().map((e) => `<p class="hint tiny" style="margin:3px 0"><strong>${esc(e.category)}</strong> — ${esc(e.message)}</p>`).join('')}`
    : '<p class="hint tiny" style="margin-top:6px">No technical errors. Missing fields appear under Data quality, not here.</p>'}
  </div>`;
}

/* ------------------------------ modules ------------------------------ */

const FRIENDLY = {
  'maps.page': 'Google Maps detected',
  'maps.feed': 'Results feed',
  'maps.cards': 'Card detection',
  'parser.card': 'Card parser',
  'parser.rating': 'Rating parser',
  'detail.panel': 'Place detail panel',
  'parser.fullAddress': 'Full Address parser',
  'parser.website': 'Website parser',
  'parser.phone': 'Phone parser',
  'enrich.website': 'Website fetch',
  'enrich.email': 'Email module',
  'enrich.social': 'Social module',
  'engine.dedupe': 'Deduplication',
  'engine.validate': 'Validation',
  'engine.score': 'Lead scoring',
  'export.csv': 'CSV export',
  'export.xlsx': 'Excel export',
  'export.sheets': 'Google Sheets API',
  'auth.google': 'Google OAuth',
  storage: 'Storage',
};

function renderModules(modules) {
  const shown = (modules || []).filter((m) => FRIENDLY[m.name]);
  if (!shown.length) return '';
  return `
  <div class="card">
    <h2>Modules</h2>
    <div class="diag-list">
      ${shown.map((m) => `
        <div class="diag ${esc(m.health)}">
          <span class="icon">${ICON[m.health] || ICON[HEALTH.UNKNOWN]}</span>
          <span class="name">${esc(FRIENDLY[m.name] || m.name)}</span>
          <span class="msg">${esc(describe(m))}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

function renderSheets(sheets) {
  if (!sheets) return '';
  const configured = !!sheets.configured;
  const signedIn = !!sheets.signedIn;
  return `
  <div class="card">
    <h2>Google integration</h2>
    <div class="diag-list">
      ${row(['OAuth client ID', configured ? 'ok' : 'info', configured ? 'configured' : 'not configured — see SETUP-GOOGLE-SHEETS.md'])}
      ${row(['Signed in', signedIn ? 'ok' : 'info', signedIn ? 'yes' : (sheets.reason || 'not signed in')])}
    </div>
    <p class="hint tiny">Google Sheets is optional. When it is unavailable, CSV, Excel and collection are unaffected.</p>
  </div>`;
}

function renderSample(page) {
  const sample = page && page.sample;
  if (!sample || sample.error) return '';
  const show = ['businessName', 'category', 'rating', 'reviewCount', 'address', 'placeId', 'mapsUrl'];
  return `
  <div class="card">
    <h2>Live parse of the first card</h2>
    <div class="table-wrap">
      <table><tbody>
        ${show.map((k) => `<tr>
          <td class="muted" style="width:110px">${esc(k)}</td>
          <td>${sample[k] ? esc(String(sample[k]).slice(0, 90)) : '<span class="muted">— blank —</span>'}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>
    <p class="hint tiny">The parser's real output for the first result on screen. If a value here is wrong, the selector for that field needs updating — they all live in <code>src/collector/selectors.js</code>.</p>
  </div>`;
}

/**
 * Live fetch-and-extract probe against the first card's own place page —
 * the exact mechanism detail resolution runs for every record, exposed
 * here with full visibility instead of just a pass/fail count. Built to
 * diagnose "detail resolution completes but Full Address is always blank"
 * reports: this shows whether the fetch itself is even reaching real
 * content, or whether it succeeds but the page doesn't contain what the
 * parser expects.
 */
function renderDetailProbe(page) {
  const probe = page && page.detailProbe;
  if (!probe) return '';

  if (!probe.ok) {
    return `
    <div class="card">
      <h2>Live detail-fetch probe</h2>
      ${banner('error', `<strong>The fetch itself failed.</strong><br><span class="hint tiny">${esc(probe.error || 'unknown error')}</span>`)}
      <p class="hint tiny" style="margin-top:8px">This is the same fetch detail resolution runs for every record — if it fails here, it is almost certainly failing for all of them the same way.</p>
    </div>`;
  }

  const data = probe.data || {};
  const via = data.via || {};
  const redirected = probe.finalUrl && probe.url && probe.finalUrl !== probe.url;
  const fields = ['fullAddress', 'address', 'website', 'phone'];

  return `
  <div class="card">
    <h2>Live detail-fetch probe</h2>
    <div class="diag-list">
      ${row(['HTTP status', probe.httpStatus === 200 ? 'ok' : 'degraded', String(probe.httpStatus ?? 'unknown')])}
      ${row(['Response size', probe.responseLength > 1000 ? 'ok' : 'degraded', `${probe.responseLength} characters`])}
      ${row(['Redirected', redirected ? 'degraded' : 'ok', redirected ? `yes — landed on ${probe.finalUrl}` : 'no, stayed on the place URL'])}
      ${row(['Embedded JSON payload found', probe.payloadFound ? 'ok' : 'degraded', probe.payloadFound ? 'yes' : 'no — APP_INITIALIZATION_STATE was not found in the response'])}
    </div>
    <div class="divider"></div>
    <div class="table-wrap">
      <table><tbody>
        ${fields.map((k) => `<tr>
          <td class="muted" style="width:110px">${esc(k)}</td>
          <td>${data[k] ? esc(String(data[k]).slice(0, 90)) : '<span class="muted">— blank —</span>'}</td>
          <td class="muted" style="width:170px">${esc(via[k] || '—')}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>
    <p class="hint tiny" style="margin-top:8px">The third column is HOW each value resolved (or why it didn't) — <code>dom:…</code> means the fetched page's own HTML had it, <code>payload:…</code> means it came from the embedded JSON, <code>none</code> means neither found anything.</p>
    <div class="divider"></div>
    <p class="hint tiny" style="margin-bottom:4px">First 600 characters of the actual response (scripts/styles stripped) — if this doesn't look like a Google Maps place page, that is the root cause:</p>
    <pre class="diag-excerpt">${esc(probe.excerpt || '(empty response)')}</pre>
  </div>`;
}

/* ------------------------------- helper ------------------------------ */

function row([name, kind, msg]) {
  const cls = kind === 'ok' ? 'ok' : kind === 'degraded' ? 'degraded' : 'unknown';
  const icon = kind === 'ok' ? ICON[HEALTH.OK] : kind === 'degraded' ? ICON[HEALTH.DEGRADED] : ICON[HEALTH.UNKNOWN];
  return `
  <div class="diag ${cls}">
    <span class="icon">${icon}</span>
    <span class="name">${esc(name)}</span>
    <span class="msg">${esc(msg)}</span>
  </div>`;
}

export function bindDiagnostics() {
  const root = document.getElementById('view-diagnostics');
  onClick(root, '[data-act="rerun"]', async () => {
    const app = await import('../app.js');
    app.state.diagnostics = null;
    app.paint();
    await app.runDiagnostics();
  });
  onClick(root, '[data-act="back-to-settings"]', async () => {
    const app = await import('../app.js');
    app.switchView('settings');
  });
}
