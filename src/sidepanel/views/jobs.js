/**
 * JOBS view — every dataset stays reachable.
 *
 * v2 wrote queue jobs to storage and then never listed them: `listJobs()`
 * existed but no view called it, so running three searches left two datasets
 * unreachable. This view is that missing surface, plus combining.
 */
import { MSG } from '../../core/constants.js';
import { SCOPE } from '../../jobs/dataset.js';
import { esc, onClick, empty, timeAgo, toast, agoShort } from '../ui.js';

export function renderJobs(state) {
  const jobs = state.jobs || [];
  const totals = state.jobTotals || { jobs: 0, records: 0 };
  const selected = new Set(state.selectedJobIds || []);

  if (!jobs.length) {
    return `<div class="card">${empty('&#128193;', 'No jobs yet.<br>Every collection you run is kept here as its own dataset.')}</div>`;
  }

  return `
  <div class="card tight">
    <h2>All results <span class="count">${totals.jobs} job(s) · ${totals.records} leads</span></h2>
    <p class="hint tiny">Each search keeps its own dataset. Nothing is overwritten when the next search runs.</p>
  </div>

  <div class="card">
    <h2>Jobs</h2>
    ${jobs.map((j) => renderJob(j, state, selected)).join('')}
  </div>

  <div class="card">
    <h2>Combine <span class="count">${selected.size} selected</span></h2>
    <p class="hint">Merge the selected jobs into one new dataset. The originals are kept exactly as they are.</p>
    <label class="check"><input type="checkbox" id="combine-dedupe" checked><span>Remove duplicates while combining</span></label>
    <div class="row" style="margin-top:8px">
      <button class="primary grow" data-act="combine" ${selected.size < 1 ? 'disabled' : ''}>
        Combine ${selected.size || ''} job(s)
      </button>
      <button data-act="view-selected" ${selected.size < 1 ? 'disabled' : ''}>View Together</button>
    </div>
    ${selected.size ? `<p class="hint tiny" style="margin-top:7px">${
    jobs.filter((j) => selected.has(j.id)).reduce((n, j) => n + (j.count || 0), 0)} raw records across the selection.</p>` : ''}
  </div>`;
}

/**
 * Status badge: text + CSS variant, covering the vocabulary a user actually
 * cares about (Completed / Collecting / Paused / Recovering / Partial /
 * Failed) rather than the raw internal job.status.
 */
function jobStatusBadge(job) {
  const found = job.count || 0;
  if (job.status === 'running') return job.stuck ? ['Recovering', 'paused'] : ['Collecting', 'running'];
  if (job.status === 'paused') return ['Paused', 'paused'];
  if (job.status === 'error') return found > 0 ? ['Partial', 'partial'] : ['Failed', 'failed'];
  if (job.status === 'stopped') return [found > 0 ? 'Stopped' : 'Stopped — no results', 'paused'];
  if (job.status === 'completed') return [found > 0 ? 'Completed' : 'No results', 'done'];
  return [job.status, ''];
}

function renderJob(job, state, selected) {
  const isActive = job.id === (state.job && state.job.id);
  const q = job.quality;
  const date = new Date(job.createdAt);
  const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const [badgeText, badgeClass] = jobStatusBadge(job);

  return `
  <div class="job-card ${isActive ? 'active' : ''}">
    <div class="job-head">
      <input type="checkbox" data-select="${esc(job.id)}" ${selected.has(job.id) ? 'checked' : ''}>
      <div class="meta">
        <div class="name">${esc(job.label || job.query || job.id)}</div>
        <div class="sub">
          <span class="job-badge ${badgeClass}">${esc(badgeText)}</span>
          <span>${esc(dateLabel)}</span>
          ${job.combinedFrom ? '<span>combined</span>' : ''}
          ${q ? `<span>${q.complete}/${q.total} complete</span>` : ''}
        </div>
      </div>
      <span class="n">${job.count || 0}</span>
    </div>
    ${job.stuck || job.technicalErrors ? `
      <div class="job-flags">
        ${job.stuck ? '<span class="flag warn">&#9888; possibly stuck</span>' : ''}
        ${job.technicalErrors ? `<span class="flag bad">${job.technicalErrors} technical error(s)</span>` : ''}
      </div>` : ''}
    <div class="job-actions">
      <button data-open="${esc(job.id)}">Open</button>
      <button class="ghost" data-rename="${esc(job.id)}">Rename</button>
      <button class="ghost danger" data-delete="${esc(job.id)}">Delete</button>
    </div>
  </div>`;
}

export function bindJobs() {
  const root = document.getElementById('view-jobs');

  root.addEventListener('change', async (e) => {
    if (!e.target.matches('[data-select]')) return;
    const app = await import('../app.js');
    const set = new Set(app.state.selectedJobIds || []);
    const id = e.target.dataset.select;
    if (e.target.checked) set.add(id); else set.delete(id);
    app.state.selectedJobIds = [...set];
    app.paint();
  });

  onClick(root, '[data-open]', async (e, el) => {
    const app = await import('../app.js');
    await app.command(MSG.JOB_OPEN, { jobId: el.dataset.open }, { reloadAfter: false });
    await app.setScope(SCOPE.CURRENT_JOB, app.state.selectedJobIds);
    app.switchView('data');
  });

  onClick(root, '[data-rename]', async (e, el) => {
    const app = await import('../app.js');
    const job = (app.state.jobs || []).find((j) => j.id === el.dataset.rename);
    const name = prompt('Job name', (job && job.label) || '');
    if (name == null) return;
    await app.command(MSG.JOB_RENAME, { jobId: el.dataset.rename, name }, { reloadAfter: false });
    await app.reloadJobs();
  });

  onClick(root, '[data-delete]', async (e, el) => {
    const app = await import('../app.js');
    const job = (app.state.jobs || []).find((j) => j.id === el.dataset.delete);
    if (!confirm(`Delete "${(job && job.label) || el.dataset.delete}" and its ${job ? job.count : 0} record(s)?`)) return;
    await app.command(MSG.JOB_DELETE, { jobId: el.dataset.delete }, { reloadAfter: false });
    app.state.selectedJobIds = (app.state.selectedJobIds || []).filter((x) => x !== el.dataset.delete);
    await app.reloadJobs();
    await app.reload();
  });

  onClick(root, '[data-act="view-selected"]', async () => {
    const app = await import('../app.js');
    if (!app.state.selectedJobIds.length) return;
    await app.setScope(SCOPE.SELECTED, app.state.selectedJobIds);
    app.switchView('data');
  });

  onClick(root, '[data-act="combine"]', async () => {
    const app = await import('../app.js');
    const ids = app.state.selectedJobIds || [];
    if (!ids.length) { toast('Select at least one job.', 'error'); return; }
    const dedupeBox = document.getElementById('combine-dedupe');
    const name = prompt('Name for the combined dataset', 'Combined leads');
    if (name == null) return;

    const res = await app.command(MSG.JOBS_COMBINE, {
      jobIds: ids, name, deduplicate: !dedupeBox || dedupeBox.checked,
    }, {
      successMessage: (d) => (d ? `${d.before} raw · ${d.duplicates} duplicates · ${d.after} unique leads.` : 'Combined.'),
      reloadAfter: false,
    });

    if (res.ok) {
      app.state.selectedJobIds = [];
      await app.setScope(SCOPE.CURRENT_JOB, []);
      await app.reloadJobs();
      app.switchView('data');
    }
  });
}
