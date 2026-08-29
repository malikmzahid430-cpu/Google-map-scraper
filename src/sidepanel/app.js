/**
 * Side panel application.
 *
 * The panel is a pure view: it never scrapes, parses or exports. It sends a
 * command and re-renders from storage. That separation is why a UI bug cannot
 * break collection, and why closing the panel does not stop a run.
 */
import { MSG, DEFAULT_SETTINGS, SK } from '../core/constants.js';
import { send } from '../core/bus.js';
import * as store from '../core/storage.js';
import * as jobsApi from '../jobs/job-manager.js';
import * as queue from '../jobs/queue.js';
import * as projects from '../jobs/projects.js';
import { SCOPE, readScope } from '../jobs/dataset.js';
import * as filters from '../engines/filters.js';
import { analyze } from '../core/quality.js';
import { $, $$, esc, toast } from './ui.js';

import { renderHome, bindHome } from './views/home.js';
import { renderData, bindData } from './views/data.js';
import { renderFilter, bindFilter } from './views/filter.js';
import { renderEnrich, bindEnrich } from './views/enrich.js';
import { renderExport, bindExport } from './views/export.js';
import { renderJobs, bindJobs } from './views/jobs.js';
import { renderSettings, bindSettings } from './views/settings.js';
import { renderDiagnostics, bindDiagnostics } from './views/diagnostics.js';

/* ------------------------------------------------------------------ */
export const state = {
  view: 'home',
  settings: { ...DEFAULT_SETTINGS },

  /** Which records the Data / Filter / Export views operate on. */
  scope: SCOPE.CURRENT_JOB,
  selectedJobIds: [],

  job: null,
  jobs: [],
  jobTotals: { jobs: 0, records: 0 },
  sources: [],

  records: [],
  criteria: filters.blankCriteria(),

  queue: queue.blankQueue(),
  projects: [],
  activeProjectId: null,

  sort: { key: 'serial', dir: 'asc' },
  sheets: { configured: false, signedIn: false },
  diagnostics: null,
  /** TEMPORARY — proof-of-concept iframe DOM probe result, see diagnostics.js. */
  iframeProbe: null,
  busy: false,
  now: Date.now(),

  /** Home screen: is a matching Google Maps search already open? */
  mapsDetect: { checked: false, onMaps: false, query: '', href: '' },
  /** 'current' | 'mine' | null — null lets detection choose automatically. */
  searchMode: null,
  searchQueryText: '',
  searchLocationText: '',
  /** Extra { query, location } rows added via "+ Add another search". */
  searchRows: [],
};

/* ---------------------------- selectors --------------------------- */

export function visibleRecords() {
  return filters.applyCriteria(state.records, state.criteria);
}

export function quality() {
  return analyze(visibleRecords());
}

export function facets() {
  return {
    categories: filters.categoryFacets(state.records),
    locations: filters.locationFacets(state.records),
    bounds: filters.numericBounds(state.records),
    availability: filters.availabilityCounts(state.records),
  };
}

export function activeFilterCount() {
  return filters.activeCount(state.criteria);
}

// Attached so view renderers, which only receive `state`, can call them
// without importing app.js (which would be a circular import).
state.visibleRecords = visibleRecords;
state.quality = quality;
state.facets = facets;
state.activeFilterCount = activeFilterCount;

/* --------------------------- data loading ------------------------- */

export async function reload() {
  state.now = Date.now();
  state.settings = await store.getSettings(DEFAULT_SETTINGS);
  state.job = await jobsApi.getActiveJob();
  state.queue = await queue.getQueue();
  state.projects = await projects.listProjects();
  state.activeProjectId = await store.get(SK.ACTIVE_PROJECT, null);

  const scoped = await readScope(state.scope, {
    jobId: state.job ? state.job.id : null,
    projectId: state.activeProjectId,
    jobIds: state.selectedJobIds,
  });
  state.records = scoped.records;
  state.sources = scoped.sources;

  paint();
}

export async function reloadJobs() {
  const res = await send(MSG.JOBS_LIST);
  if (res.ok && res.data) {
    state.jobs = res.data.jobs || [];
    state.jobTotals = res.data.totals || { jobs: 0, records: 0 };
  }
  paint();
}

/* ----------------------------- rendering -------------------------- */

const RENDERERS = {
  home: renderHome,
  data: renderData,
  filter: renderFilter,
  enrich: renderEnrich,
  export: renderExport,
  jobs: renderJobs,
  settings: renderSettings,
  diagnostics: renderDiagnostics,
};

export function paint() {
  const el = $(`#view-${state.view}`);
  if (!el) return;
  const renderer = RENDERERS[state.view];
  try {
    el.innerHTML = renderer ? renderer(state) : '';
  } catch (err) {
    // A view that fails to render shows the failure instead of a blank panel.
    // Collection and export keep working regardless.
    el.innerHTML = `<div class="banner error"><strong>This view failed to render.</strong><br>
      ${esc(err && err.message)}<br><span class="hint tiny">Collection and export are unaffected.</span></div>`;
  }
  paintBadges();
}

/** Small counts on the tab strip so the user can see state at a glance. */
function paintBadges() {
  const setBadge = (view, value) => {
    const tab = $(`.tab[data-view="${view}"]`);
    if (!tab) return;
    let badge = tab.querySelector('.badge');
    if (!value) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'badge';
      tab.appendChild(badge);
    }
    badge.textContent = value;
  };
  setBadge('data', state.records.length || '');
  const f = activeFilterCount();
  setBadge('filter', f || '');
  setBadge('jobs', state.jobTotals.jobs || '');
}

export function switchView(name) {
  if (!RENDERERS[name]) return;
  state.view = name;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  paint();
  if (name === 'diagnostics') runDiagnostics();
  if (name === 'export') refreshSheetsStatus();
  if (name === 'jobs') reloadJobs();
  if (name === 'home') refreshMapsDetect();
}

/* --------------------------- commands ----------------------------- */

export async function command(type, payload, { successMessage, reloadAfter = true } = {}) {
  if (state.busy) return { ok: false, error: 'busy' };
  state.busy = true;
  paint();
  try {
    const res = await send(type, payload);
    if (!res.ok) toast(res.error || 'Something went wrong.', 'error');
    else if (successMessage) {
      toast(typeof successMessage === 'function' ? successMessage(res.data) : successMessage, 'ok');
    }
    state.busy = false;
    if (reloadAfter) await reload();
    else paint();
    return res;
  } catch (err) {
    state.busy = false;
    toast(String(err && err.message), 'error');
    paint();
    return { ok: false, error: String(err && err.message) };
  }
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await store.saveSettings(state.settings);
  paint();
}

export function setCriteria(patch) {
  state.criteria = { ...state.criteria, ...patch };
  paint();
}

export function clearCriteria() {
  state.criteria = filters.blankCriteria();
  paint();
}

export async function setScope(scope, jobIds = []) {
  state.scope = scope;
  state.selectedJobIds = jobIds;
  await reload();
}

export async function runDiagnostics() {
  const res = await send(MSG.DIAG_RUN);
  state.diagnostics = res.ok ? res.data : { error: res.error };
  paint();
}

/**
 * TEMPORARY — proof-of-concept only. Runs the hidden-iframe DOM probe
 * (src/collector/iframe-probe.js) against the sample business Diagnostics
 * already found, so this never needs its own URL input.
 */
export async function runIframeProbe() {
  const sample = state.diagnostics && state.diagnostics.page && state.diagnostics.page.sample;
  const url = sample && sample.mapsUrl;
  if (!url) {
    state.iframeProbe = { error: 'Run diagnostics first so a sample business URL is available.' };
    paint();
    return;
  }
  state.iframeProbe = { loading: true };
  paint();
  const res = await send(MSG.DIAG_IFRAME_PROBE, { url });
  state.iframeProbe = res.ok ? res.data : { error: res.error };
  paint();
}

export async function refreshSheetsStatus() {
  const res = await send(MSG.SHEETS_STATUS);
  state.sheets = res.ok ? res.data : { configured: false, signedIn: false, reason: res.error };
  paint();
}

/** Home screen: does the active tab already have a Google Maps search open? */
export async function refreshMapsDetect() {
  const res = await send(MSG.MAPS_DETECT);
  state.mapsDetect = {
    checked: true,
    onMaps: !!(res.ok && res.data && res.data.onMaps),
    query: (res.ok && res.data && res.data.query) || '',
    href: (res.ok && res.data && res.data.href) || '',
  };
  paintConnectionPill();
  if (state.view === 'home') paint();
}

/**
 * The header's "Google Maps · Connected" pill. Lives outside the view
 * container so it survives a view repaint — it reflects whether the active
 * tab is on Google Maps right now, not whether a job is running (a job keeps
 * running regardless of which tab you're looking at).
 */
function paintConnectionPill() {
  const el = $('#conn-pill');
  if (!el) return;
  const on = !!(state.mapsDetect && state.mapsDetect.onMaps);
  el.classList.toggle('on', on);
  const txt = el.querySelector('.txt');
  if (txt) txt.textContent = on ? 'Connected' : 'Google Maps';
  el.title = on ? 'A Google Maps tab is active' : 'Open Google Maps to search directly from here';
}

/* ------------------------------- boot ----------------------------- */

function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchView(tab.dataset.view);
  });
  $('#btn-refresh').addEventListener('click', () => { reload(); reloadJobs(); refreshMapsDetect(); });
  $('#btn-settings').addEventListener('click', () => switchView('settings'));
}

/** The worker bumps `aq.tick` after any state change; reload on that. */
function bindStorageWatch() {
  if (!chrome.storage || !chrome.storage.onChanged) return;
  let pending = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = Object.keys(changes).some((k) =>
      k === 'aq.tick' || k.startsWith('aq.job') || k.startsWith('aq.records') || k === SK.QUEUE);
    if (!relevant) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; reload(); }, 220);
  });
}

/**
 * Heartbeat tick. Only repaints while a job is live, so "last activity 4s ago"
 * stays truthful without polling storage.
 */
function bindHeartbeatTick() {
  setInterval(() => {
    state.now = Date.now();
    const live = state.job && ['running', 'paused'].includes(state.job.status);
    if (live && ['home', 'jobs', 'diagnostics'].includes(state.view)) paint();
  }, 1000);
}

async function boot() {
  bindTabs();
  bindStorageWatch();
  bindHeartbeatTick();

  bindHome();
  bindData();
  bindFilter();
  bindEnrich();
  bindExport();
  bindJobs();
  bindSettings();
  bindDiagnostics();

  await reload();
  reloadJobs();
  refreshSheetsStatus();
  refreshMapsDetect();
}

boot().catch((err) => {
  const el = $('#view-home');
  if (el) el.innerHTML = `<div class="banner error"><strong>The panel failed to start.</strong><br>${esc(err && err.message)}</div>`;
});
