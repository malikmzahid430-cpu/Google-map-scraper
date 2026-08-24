/**
 * HOME — the whole app in one screen.
 *
 * v3 asked the user to understand two unrelated mechanisms: a "Search" card
 * that only labelled records, and a separate "Search queue" textarea that was
 * the only thing that actually drove Google Maps. Nobody could tell which box
 * did what.
 *
 * v4 replaces both with one flow:
 *   WHAT ARE YOU LOOKING FOR?  /  WHERE?  (+ Add another search)
 *   ✓ Google Maps search detected  (when the active tab already has one)
 *   [ START COLLECTING LEADS ]
 *
 * If a matching Google Maps search is already open, Start collects it
 * immediately. Otherwise Start hands the typed search(es) to the existing,
 * already-tested queue engine (`QUEUE_RUN` -> `onMapsTabReady`), which opens
 * or navigates a Maps tab and starts collection automatically the moment the
 * results feed is ready. One or many rows use the exact same path — there is
 * no separate concept for "a queue" the user has to learn.
 */
import { MSG, JOB_STATUS, MODE, FIELDS } from '../../core/constants.js';
import { esc, stat, onClick, toast, agoShort, coverageRow } from '../ui.js';
import * as queue from '../../jobs/queue.js';
import { STALL_THRESHOLD_MS } from '../../jobs/job-manager.js';

/** Second tier of the stall watchdog — past this it's not "recovering" anymore. */
const NEEDS_ATTENTION_MS = STALL_THRESHOLD_MS * 3;

const MODE_INFO = {
  [MODE.FAST]: {
    icon: '&#9889;',
    title: 'Fast',
    blurb: 'Name, category, rating, reviews, Maps URL. Reads the results list only — no place is opened, so it is by far the quickest.',
  },
  [MODE.STANDARD]: {
    icon: '&#9673;',
    title: 'Standard',
    blurb: 'Everything in Fast, plus address, full address, website and phone. Place details resolve after collection finishes.',
  },
  [MODE.ADVANCED]: {
    icon: '&#9670;',
    title: 'Advanced',
    blurb: 'Everything in Standard, plus coordinates. Email, social, validation and scoring then run from the Enrich tab.',
  },
};

export function renderHome(state) {
  const job = state.job;
  const status = job ? job.status : JOB_STATUS.IDLE;
  const running = status === JOB_STATUS.RUNNING;
  const paused = status === JOB_STATUS.PAUSED;
  const active = running || paused;

  return `
    ${renderIntro(state)}
    ${renderSearchCard(state, active)}
    ${renderModeCard(state, active)}
    ${renderFieldsCard(state, active)}
    ${renderStatusCard(state, job, status, running, paused, active)}
    ${renderQueueCard(state)}
    ${renderProjectCard(state)}
  `;
}

/* -------------------------------- intro ------------------------------- */

function renderIntro(state) {
  if (state.job || (state.queue && state.queue.items && state.queue.items.length)) return '';
  return `
  <div class="hero">
    <div class="hero-title">Find Business Leads</div>
    <p class="hero-sub">Collect business data from Google Maps quickly. Enter what you want to find and where, then press
      <strong>Start Collecting Leads</strong> — already on Google Maps with a search open? We'll offer to use that instead.</p>
  </div>`;
}

/* ------------------------------- search ------------------------------ */

function extraRowHtml(row = { query: '', location: '' }, disabled) {
  return `
  <div class="search-row" data-row>
    <input type="text" data-row-query placeholder="Roofing contractors" value="${esc(row.query)}" ${disabled ? 'disabled' : ''}>
    <input type="text" data-row-location placeholder="Orlando, FL" value="${esc(row.location)}" ${disabled ? 'disabled' : ''}>
    <button class="ghost icon-btn" data-act="remove-row" title="Remove this search" ${disabled ? 'disabled' : ''}>&#10005;</button>
  </div>`;
}

/**
 * The main What/Where boxes default to the active job's search, or the most
 * recent queue item, so "Retry this search" and simply reopening the panel
 * show what you last searched instead of a blank box. Once the user types,
 * `searchQueryText`/`searchLocationText` take over — this only fills gaps.
 */
function defaultSearch(state) {
  if (state.job && (state.job.query || state.job.location)) {
    return { query: state.job.query || '', location: state.job.location || '' };
  }
  const items = (state.queue && state.queue.items) || [];
  const last = items[items.length - 1];
  if (last) return { query: last.query || '', location: last.location || '' };
  return { query: '', location: '' };
}

function renderSearchCard(state, disabled) {
  const detect = state.mapsDetect || { checked: false, onMaps: false, query: '' };
  const extra = state.searchRows || [];
  const searchMode = state.searchMode; // 'current' | 'mine' | null (auto)
  const fallback = defaultSearch(state);
  const queryValue = state.searchQueryText || fallback.query;
  const locationValue = state.searchLocationText || fallback.location;

  return `
  <div class="card hero-card">
    <h2>What are you looking for?</h2>
    <div class="row">
      <label class="field grow"><span>What</span>
        <input type="text" id="s-query" placeholder="Roofing contractors"
               value="${esc(queryValue)}" ${disabled ? 'disabled' : ''}></label>
    </div>
    <div class="row">
      <label class="field grow"><span>Where</span>
        <input type="text" id="s-location" placeholder="Jacksonville, FL"
               value="${esc(locationValue)}" ${disabled ? 'disabled' : ''}></label>
    </div>

    <div id="search-extra-rows">
      ${extra.map((r) => extraRowHtml(r, disabled)).join('')}
    </div>
    ${!disabled ? `<button class="ghost small" data-act="add-search-row">+ Add another search</button>` : ''}

    <div class="divider"></div>

    ${renderDetection(detect, searchMode, disabled)}

    <p class="hint tiny">Enter what you want to find and where you want to find it, then click Start Collecting Leads. If you're already on Google Maps with a search open, we'll offer to use that instead of opening a new tab.</p>
  </div>`;
}

function renderDetection(detect, searchMode, disabled) {
  if (!detect.checked) {
    return `<div class="detect-line muted"><span class="dot"></span> Checking Google Maps…</div>`;
  }
  if (!detect.onMaps || !detect.query) {
    return `<div class="detect-line muted"><span class="dot"></span> Google Maps is not open with a search yet — Start will open one for you.</div>`;
  }

  return `
  <div class="detect-box">
    <div class="detect-line ok"><span class="dot ok"></span> <strong>Google Maps search detected</strong></div>
    <div class="detect-query">${esc(detect.query)}</div>
    <div class="seg" style="margin-top:8px">
      <button data-search-mode="current" aria-pressed="${searchMode !== 'mine'}" ${disabled ? 'disabled' : ''}>Use this search</button>
      <button data-search-mode="mine" aria-pressed="${searchMode === 'mine'}" ${disabled ? 'disabled' : ''}>Use my search above</button>
    </div>
  </div>`;
}

/* -------------------------------- mode ------------------------------- */

function renderModeCard(state, disabled) {
  const mode = state.settings.mode;
  const info = MODE_INFO[mode] || MODE_INFO[MODE.STANDARD];

  return `
  <div class="card">
    <h2>Extraction mode</h2>
    <div class="seg">
      ${[MODE.FAST, MODE.STANDARD, MODE.ADVANCED].map((m) => `
        <button data-mode="${m}" aria-pressed="${m === mode}" ${disabled ? 'disabled' : ''}>
          ${MODE_INFO[m].icon} ${MODE_INFO[m].title}
        </button>`).join('')}
    </div>
    <p class="hint">${info.blurb}</p>
  </div>`;
}

/* ------------------------------- fields ------------------------------ */

function renderFieldsCard(state, disabled) {
  const selected = new Set(state.settings.fields || []);
  const core = FIELDS.filter((f) => f.group === 'core');
  const enrichFields = FIELDS.filter((f) => f.group === 'enrich');

  return `
  <div class="card">
    <h2>Fields to collect <span class="count">${selected.size} selected</span></h2>
    <div class="check-grid">
      ${core.map((f) => `
        <label class="check">
          <input type="checkbox" data-field="${esc(f.key)}" ${selected.has(f.key) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span>${esc(f.label)}</span>
        </label>`).join('')}
    </div>
    <p class="hint tiny"><strong>Address</strong> is the street line from the results card. <strong>Full Address</strong> is the complete postal address, resolved separately when the card doesn't show it. When genuinely unavailable, it stays blank rather than showing a partial one.</p>

    <div class="divider"></div>
    <div class="section-label" style="margin:0 0 6px">Optional — found during Enrich, not collection</div>
    <div class="check-grid">
      ${enrichFields.map((f) => `
        <label class="check">
          <input type="checkbox" data-field="${esc(f.key)}" ${selected.has(f.key) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span>${esc(f.label)}</span>
        </label>`).join('')}
    </div>
    <p class="hint tiny">Selecting these doesn't slow collection down — they're only looked up when you run <strong>Enrich</strong> afterwards, and only for records that need them.</p>
  </div>`;
}

/* ------------------------------- status ------------------------------ */

/** Human label for a job, distinguishing a clean run from a partial one. */
function jobStatusLabel(job, stuck, needsAttention) {
  const found = (job.counts && job.counts.found) || 0;
  if (job.status === JOB_STATUS.RUNNING) {
    if (needsAttention) return 'Needs attention';
    if (stuck) return 'Recovering…';
    return 'Collecting leads';
  }
  if (job.status === JOB_STATUS.PAUSED) return 'Paused';
  if (job.status === JOB_STATUS.COMPLETED) return found > 0 ? 'Collection complete' : 'Collection complete — no results';
  if (job.status === JOB_STATUS.STOPPED) return found > 0 ? `Stopped — ${found} saved` : 'Stopped';
  if (job.status === JOB_STATUS.ERROR) return found > 0 ? `Partial — ${found} saved` : 'Failed';
  return 'Ready';
}

function renderStatusCard(state, job, status, running, paused, active) {
  if (!job) {
    const multi = (state.searchRows || []).length > 0;
    const queueLoading = !!(state.queue && state.queue.running);

    if (queueLoading) {
      return `
      <div class="card">
        <h2>Status</h2>
        <div class="status-line"><span class="dot running"></span><span>Opening Google Maps…</span></div>
        <div class="bar indeterminate"><i></i></div>
        <p class="hint tiny">Collection will start automatically the moment the results are ready.</p>
      </div>`;
    }

    return `
    <div class="card">
      <h2>Status</h2>
      <div class="status-line"><span class="dot"></span><span>Ready</span></div>
      <div style="height:10px"></div>
      <button class="primary cta block" data-act="start" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? 'Starting…' : (multi ? 'START ALL SEARCHES' : 'START COLLECTING LEADS')}
      </button>
      <p class="hint tiny" style="margin-top:9px">Collection keeps running if you switch tabs or close this panel — come back anytime to see progress.</p>
    </div>`;
  }

  const c = job.counts || {};
  const detail = job.detail || {};
  const idleMs = state.now - (job.lastActivityAt || 0);
  const stuck = running && idleMs > STALL_THRESHOLD_MS;
  const needsAttention = running && idleMs > NEEDS_ATTENTION_MS;

  const dotClass = needsAttention || status === JOB_STATUS.ERROR ? 'error'
    : stuck ? 'paused'
      : running ? 'running'
        : paused ? 'paused'
          : status === JOB_STATUS.COMPLETED ? 'done' : '';

  const controls = active
    ? `<div class="row">
         <button class="lg grow ${paused ? 'primary' : ''}" data-act="${paused ? 'resume' : 'pause'}">${paused ? 'RESUME COLLECTION' : 'PAUSE COLLECTION'}</button>
         <button class="lg grow danger" data-act="stop">STOP COLLECTION</button>
       </div>
       ${stuck ? `<button class="block" data-act="retry" style="margin-top:7px">${needsAttention ? '&#9888; Needs attention — retry now' : '&#9888; Recovering — nudge the collector'}</button>` : ''}`
    : `<button class="primary lg block" data-act="start" ${state.busy ? 'disabled' : ''}>
         ${state.busy ? 'Starting…' : 'START COLLECTING LEADS'}
       </button>`;

  const done = [JOB_STATUS.COMPLETED, JOB_STATUS.STOPPED, JOB_STATUS.ERROR].includes(status);
  const q = state.quality();
  const tech = job.technical || { total: 0, byCategory: {} };
  const resolving = detail.total > 0 && detail.done < detail.total;
  const label = jobStatusLabel(job, stuck, needsAttention);

  return `
  <div class="card">
    <h2>Status <span class="count">${esc(job.query || job.name || 'untitled')}</span></h2>

    <div class="status-line">
      <span class="dot ${dotClass}"></span>
      <span>${esc(label)}</span>
      ${active ? `<span class="muted" style="margin-left:auto;font-size:11px;font-weight:400">${esc(job.progress.note || '')}</span>` : ''}
    </div>

    ${active || resolving ? `<div class="bar indeterminate"><i></i></div>` : '<div style="height:8px"></div>'}

    ${active ? `
      <div class="beat ${stuck ? 'stuck' : ''}">
        ${needsAttention
    ? `&#9888; No activity for ${Math.round(idleMs / 1000)}s — this may need a manual retry.`
    : stuck
      ? `&#9888; Recovering — no activity for ${Math.round(idleMs / 1000)}s, still watching.`
      : `Last activity: ${esc(agoShort(job.lastActivityAt, state.now))}${job.lastActivity ? ` · ${esc(job.lastActivity)}` : ''}`}
      </div>` : ''}

    <div class="stats" style="margin-top:10px">
      ${stat(c.found || 0, 'Collected', 'accent')}
      ${stat(q.complete || 0, 'Complete', 'ok')}
      ${stat(c.duplicates || 0, 'Duplicates')}
    </div>

    ${active ? renderLiveFieldGrid(q) : ''}
    ${resolving ? `<p class="hint" style="margin-top:9px">Resolving full address ${detail.done} / ${detail.total}</p>` : ''}

    <div class="divider"></div>
    ${controls}

    ${done && (c.found || 0) > 0 ? `
      <div class="divider"></div>
      <p class="hint" style="margin-bottom:9px"><strong>&#10003; Collection Complete</strong> — ${c.found} business${c.found === 1 ? '' : 'es'}.</p>
      <div class="row wrap">
        <button class="grow" data-act="goto-data">View Data</button>
        <button class="grow" data-act="goto-enrich">Enrich Missing Data</button>
      </div>
      <div class="row wrap" style="margin-top:6px">
        <button class="grow" data-act="goto-filter">Filter Results</button>
        <button class="grow" data-act="goto-export">Export</button>
      </div>
      <button class="ghost block" data-act="dedupe" style="margin-top:6px">Remove Duplicates</button>` : ''}
    ${status === JOB_STATUS.ERROR ? `
      <div class="divider"></div>
      <button class="block" data-act="retry-search">Retry this search</button>` : ''}
  </div>

  ${renderQualityCard(q)}
  ${renderHealthCard(tech, detail)}
  `;
}

/** Live per-field counts while collecting — "Website 128 · Phone 133 · …" */
function renderLiveFieldGrid(q) {
  if (!q || !q.total) return '';
  const pick = (key) => (q.fields && q.fields[key] ? q.fields[key].found : 0);
  return `
  <div class="field-grid">
    <div class="field-tile"><span class="k">Website</span><span class="v">${pick('website')}</span></div>
    <div class="field-tile"><span class="k">Phone</span><span class="v">${pick('phone')}</span></div>
    <div class="field-tile"><span class="k">Full Address</span><span class="v">${pick('fullAddress')}</span></div>
    <div class="field-tile"><span class="k">Rating</span><span class="v">${pick('rating')}</span></div>
  </div>`;
}

/**
 * DATA QUALITY. Coverage only.
 *
 * v2 rendered a single "Errors" tile fed by a counter that incremented for
 * every business without a website — 51 good leads read as 51 errors. Coverage
 * and failure now live in two different cards and share no counter.
 */
function renderQualityCard(q) {
  if (!q || !q.total) return '';
  return `
  <div class="card">
    <h2>Data quality <span class="count">${q.complete} of ${q.total} complete</span></h2>
    ${q.rows.map(coverageRow).join('')}
    <p class="hint tiny" style="margin-top:8px">These are coverage counts, not problems. A blank field usually means Google or the business simply does not publish it.</p>
  </div>`;
}

/** SYSTEM HEALTH. The only place an error number appears. */
function renderHealthCard(tech, detail) {
  const total = tech.total || 0;
  const cats = tech.byCategory || {};
  const failedDetails = (detail && detail.failed) || 0;

  return `
  <div class="card">
    <h2>System health</h2>
    <div class="health ${total ? 'some' : 'zero'}">
      <span>Technical errors</span><span class="n">${total}</span>
    </div>
    <div class="health ${cats.parser ? 'some' : 'zero'}"><span>Parser exceptions</span><span class="n">${cats.parser || 0}</span></div>
    <div class="health ${cats.timeout || failedDetails ? 'some' : 'zero'}"><span>Timeouts</span><span class="n">${(cats.timeout || 0) + 0}</span></div>
    <div class="health ${cats.storage ? 'some' : 'zero'}"><span>Storage failures</span><span class="n">${cats.storage || 0}</span></div>
    <div class="health ${cats.communication ? 'some' : 'zero'}"><span>Communication failures</span><span class="n">${cats.communication || 0}</span></div>
    ${tech.recent && tech.recent.length ? `
      <div class="divider"></div>
      <p class="hint tiny">Most recent: ${esc(tech.recent[tech.recent.length - 1].message)}</p>` : ''}
    ${total === 0 ? '<p class="hint tiny" style="margin-top:6px">Nothing has gone wrong. Missing fields are reported under Data quality, above.</p>' : ''}
  </div>`;
}

/* -------------------------------- queue ------------------------------ */

function renderQueueCard(state) {
  const q = state.queue || queue.blankQueue();
  const items = q.items || [];
  if (!items.length) return '';
  const progress = queue.queueProgress(q);

  return `
  <div class="card">
    <h2>Searches <span class="count">${progress.position} / ${items.length}</span></h2>
    <div style="margin-bottom:8px">
      ${items.map((i) => `
        <div class="queue-item">
          <span class="q">${esc(i.query)}${i.location ? ` <span class="muted">— ${esc(i.location)}</span>` : ''}</span>
          ${i.count ? `<span class="muted" style="font-variant-numeric:tabular-nums">${i.count}</span>` : ''}
          <span class="st ${esc(i.status)}">${esc(i.status)}</span>
          ${i.status === 'failed' ? `<button class="ghost small" data-retry-item="${esc(i.id)}">Retry</button>` : ''}
        </div>`).join('')}
    </div>
    ${progress.current ? `<p class="hint tiny">Current: <strong>${esc(progress.current.query)}${progress.current.location ? ` — ${esc(progress.current.location)}` : ''}</strong> · ${progress.collected} collected across the queue</p>` : ''}
    <div class="row">
      ${q.running
    ? '<button class="danger grow" data-act="queue-stop">Stop</button>'
    : '<button class="grow" data-act="queue-run">Run again</button>'}
      <button data-act="queue-clear" class="ghost">Clear</button>
    </div>
    <p class="hint tiny">Searches run strictly one at a time. The next one never starts until the previous collection — and its detail resolution — has finished. One search failing does not stop the rest. Every search keeps its own dataset; see the Jobs tab.</p>
  </div>`;
}

/* ------------------------------ projects ----------------------------- */

function renderProjectCard(state) {
  const list = state.projects || [];
  return `
  <div class="card tight">
    <h2>Project</h2>
    <div class="row">
      <select id="project-select" class="grow">
        <option value="">No project</option>
        ${list.map((p) => `<option value="${esc(p.id)}" ${p.id === state.activeProjectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <button data-act="project-new" title="New project">+</button>
      ${state.activeProjectId ? '<button data-act="project-save" title="Save current settings">Save</button>' : ''}
    </div>
    <p class="hint tiny">A project groups jobs and remembers searches, fields, mode, enrichment settings and the Google Sheet destination.</p>
  </div>`;
}

/* ------------------------------- events ------------------------------ */

function readExtraRows(root) {
  return Array.from(root.querySelectorAll('[data-row]')).map((rowEl) => ({
    query: (rowEl.querySelector('[data-row-query]') || {}).value || '',
    location: (rowEl.querySelector('[data-row-location]') || {}).value || '',
  }));
}

export function bindHome() {
  const root = document.getElementById('view-home');

  onClick(root, '[data-mode]', async (e, el) => {
    const app = await import('../app.js');
    await app.saveSettings({ mode: el.dataset.mode });
  });

  onClick(root, '[data-search-mode]', async (e, el) => {
    const app = await import('../app.js');
    app.state.searchMode = el.dataset.searchMode;
    app.paint();
  });

  root.addEventListener('change', async (e) => {
    const app = await import('../app.js');

    if (e.target.matches('[data-field]')) {
      const fields = new Set(app.state.settings.fields || []);
      if (e.target.checked) fields.add(e.target.dataset.field);
      else fields.delete(e.target.dataset.field);
      await app.saveSettings({ fields: [...fields] });
    }

    if (e.target.id === 'project-select') {
      const { setActiveProject } = await import('../../jobs/projects.js');
      await setActiveProject(e.target.value || null);
      await app.reload();
    }
  });

  // Keep the What/Where boxes in state without forcing a full re-render on
  // every keystroke (a re-render would drop focus mid-type).
  root.addEventListener('input', async (e) => {
    const app = await import('../app.js');
    if (e.target.id === 's-query') app.state.searchQueryText = e.target.value;
    if (e.target.id === 's-location') app.state.searchLocationText = e.target.value;
  });

  onClick(root, '[data-act="add-search-row"]', async () => {
    const app = await import('../app.js');
    app.state.searchRows = [...(app.state.searchRows || []), { query: '', location: '' }];
    app.paint();
  });

  onClick(root, '[data-act="remove-row"]', async (e, el) => {
    const app = await import('../app.js');
    const rowEl = el.closest('[data-row]');
    const container = document.getElementById('search-extra-rows');
    const idx = container ? Array.from(container.children).indexOf(rowEl) : -1;
    if (idx < 0) return;
    const rows = readExtraRows(root);
    rows.splice(idx, 1);
    app.state.searchRows = rows;
    app.paint();
  });

  onClick(root, '[data-act]', async (e, el) => {
    const app = await import('../app.js');
    const act = el.dataset.act;

    const readMainSearch = () => ({
      query: (document.getElementById('s-query') || {}).value || '',
      location: (document.getElementById('s-location') || {}).value || '',
    });

    switch (act) {
      case 'start':
      case 'retry-search': {
        const detect = app.state.mapsDetect || {};
        // Explicit signals that the user wants their TYPED search, not
        // whatever happens to be open on Maps: they clicked "Use my search
        // above", they added extra rows (multi-search only makes sense typed),
        // or this is a retry of a specific failed search.
        const extraRows = readExtraRows(root);
        const forceTyped = act === 'retry-search' || app.state.searchMode === 'mine' || extraRows.length > 0;
        const useCurrent = !forceTyped && detect.onMaps && !!detect.query;

        if (useCurrent) {
          // Mode A: collect the search already open on Google Maps. The typed
          // boxes (if any) only label the resulting leads — they never decide
          // what gets searched, so a leftover value left over in them by a
          // previous job can't silently steer Start into typing mode instead.
          const main = readMainSearch();
          await app.command(MSG.COLLECT_START, {
            mode: app.state.settings.mode,
            fields: app.state.settings.fields,
            query: main.query.trim(),
            location: main.location.trim(),
            projectId: app.state.activeProjectId,
          });
          break;
        }

        const rows = [readMainSearch(), ...extraRows].filter((r) => r.query.trim());
        if (!rows.length) { toast('Enter what you are looking for first.', 'error'); break; }

        // Mode B (one row) or multiple searches: both go through the same
        // tested queue engine, which opens/navigates Google Maps and starts
        // collection automatically once the results feed is ready.
        const items = rows.map((r) => queue.makeItem(r.query, r.location));
        await app.command(MSG.QUEUE_RUN, { items }, {
          successMessage: items.length > 1
            ? `Starting ${items.length} searches — Google Maps will open automatically.`
            : 'Opening Google Maps and starting collection…',
        });
        break;
      }
      case 'pause': await app.command(MSG.COLLECT_PAUSE); break;
      case 'resume': await app.command(MSG.COLLECT_RESUME); break;
      case 'stop': await app.command(MSG.COLLECT_STOP); break;
      case 'retry': await app.command(MSG.COLLECT_STATUS, {}, { successMessage: 'Collector poked.' }); break;

      case 'dedupe':
        await app.command(MSG.DEDUPE_RUN, {}, {
          successMessage: (d) => (d ? `${d.removed} duplicate(s) removed — ${d.after} remain.` : 'Deduplication complete.'),
        });
        break;

      case 'goto-data': app.switchView('data'); break;
      case 'goto-enrich': app.switchView('enrich'); break;
      case 'goto-filter': app.switchView('filter'); break;
      case 'goto-export': app.switchView('export'); break;

      case 'queue-run': await app.command(MSG.QUEUE_RUN, {}, { successMessage: 'Queue started.' }); break;
      case 'queue-stop': await app.command(MSG.QUEUE_STOP, {}, { successMessage: 'Queue stopped.' }); break;
      case 'queue-clear': {
        const { saveQueue, blankQueue } = await import('../../jobs/queue.js');
        await saveQueue(blankQueue());
        await app.reload();
        break;
      }

      case 'project-new': {
        const p = await import('../../jobs/projects.js');
        const name = prompt('Project name', 'New project');
        if (!name) break;
        const project = p.blankProject(name);
        project.mode = app.state.settings.mode;
        project.fields = app.state.settings.fields.slice();
        await p.saveProject(project);
        await p.setActiveProject(project.id);
        await app.reload();
        break;
      }
      case 'project-save': {
        const p = await import('../../jobs/projects.js');
        const project = (await p.listProjects()).find((x) => x.id === app.state.activeProjectId);
        if (!project) break;
        project.mode = app.state.settings.mode;
        project.fields = app.state.settings.fields.slice();
        project.enrich = { ...app.state.settings.enrich };
        project.searches = [readMainSearch(), ...readExtraRows(root)].filter((r) => r.query.trim());
        await p.saveProject(project);
        toast(`Saved to "${project.name}".`, 'ok');
        break;
      }
      default: break;
    }
  });

  onClick(root, '[data-retry-item]', async (e, el) => {
    const app = await import('../app.js');
    const q = app.state.queue || queue.blankQueue();
    const failed = (q.items || []).find((i) => i.id === el.dataset.retryItem);
    if (!failed) return;
    const fresh = queue.makeItem(failed.query, failed.location);
    const items = [...q.items, fresh];
    await app.command(MSG.QUEUE_RUN, { items }, { successMessage: 'Retrying — Google Maps will open automatically.' });
  });
}
