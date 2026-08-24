/**
 * SETTINGS view — collection tuning, scoring weights, data management.
 */
import { DEFAULT_SETTINGS, APP_VERSION, FIELD_MAPPING, FIELDS } from '../../core/constants.js';
import { esc, onClick, toast, banner } from '../ui.js';

export function renderSettings(state) {
  const s = state.settings;
  const w = s.scoring || DEFAULT_SETTINGS.scoring;

  return `
  <div class="card tight">
    <h2>General</h2>
    <p class="hint" style="margin:0">
      Al-Aqsa Scraper <strong>v${esc(APP_VERSION)}</strong><br>
      <span class="muted">Everything is stored locally in this browser profile. Nothing is sent anywhere except the Google Sheet you explicitly choose.</span>
    </p>
  </div>

  <div class="card">
    <h2>Collection</h2>
    <label class="field"><span>Stop after N records (0 = collect everything)</span>
      <input type="number" min="0" max="10000" step="10" data-set="maxRecords" value="${Number(s.maxRecords) || 0}"></label>
    <p class="hint tiny">Leave at 0 to collect every result Google Maps returns for a search.</p>
  </div>

  <div class="card">
    <h2>Enrichment</h2>
    <label class="check">
      <input type="checkbox" data-set-bool="autoResolveDetails" ${s.autoResolveDetails !== false ? 'checked' : ''}>
      <span>Resolve missing Full Address/Website/Phone automatically after collection</span>
    </label>
    <p class="hint tiny">Most records already have Website and Phone straight off the results card — this only ever runs for what's still missing, via same-origin fetches through your open Google Maps tab. No new tab is ever opened. Email and social profiles are always a separate, manual step from the Enrich tab.</p>
  </div>

  <div class="card">
    <h2>Storage</h2>
    <div class="row wrap">
      <button class="grow" data-act="clear-job">Clear current job</button>
      <button class="grow danger" data-act="clear-all">Delete all data</button>
    </div>
  </div>

  <div class="card">
    <h2>Google Sheets</h2>
    <p class="hint">Optional export destination — connecting, creating and choosing a spreadsheet all happen from the Export tab. CSV and Excel need none of this and always work.</p>
    <button class="block" data-act="open-export">Go to Export</button>
  </div>

  <div class="card">
    <h2>Diagnostics</h2>
    <p class="hint">Live checks on collection, detail resolution, data quality and system health — plus a real-time parse of the first result card on screen. Use this to see exactly what's happening when something looks wrong.</p>
    <button class="block" data-act="open-diagnostics">Open Diagnostics</button>
  </div>

  <details class="adv">
    <summary>Advanced Settings</summary>
    <div class="adv-body">
      <div class="section-label" style="margin-top:8px">Scrolling &amp; end-of-list</div>
      <div class="row">
        <label class="field grow"><span>Scroll delay (ms)</span>
          <input type="number" min="200" max="5000" step="50" data-set="scrollDelayMs" value="${Number(s.scrollDelayMs) || 700}"></label>
        <label class="field grow"><span>Patience (fruitless scrolls)</span>
          <input type="number" min="3" max="30" data-set="maxNoChangeAttempts" value="${Number(s.maxNoChangeAttempts) || 8}"></label>
      </div>
      <p class="hint tiny">Google Maps often pauses mid-list. Patience is how many fruitless scrolls the collector tolerates, with a growing wait, before deciding the results are finished. Raising it makes long lists more reliable; lowering it ends short searches sooner.</p>

      <div class="divider"></div>
      <div class="section-label">Detail resolution (same-origin fetch, no tabs)</div>
      <div class="row">
        <label class="field grow"><span>Concurrent fetches</span>
          <input type="number" min="1" max="8" data-set="detailConcurrency" value="${Number(s.detailConcurrency) || 5}"></label>
        <label class="field grow"><span>Timeout (ms)</span>
          <input type="number" min="5000" max="60000" step="1000" data-set="detailTimeoutMs" value="${Number(s.detailTimeoutMs) || 15000}"></label>
      </div>
      <div class="row">
        <label class="field grow"><span>Retries per record</span>
          <input type="number" min="0" max="4" data-set="detailRetries" value="${Number(s.detailRetries) || 1}"></label>
        <label class="field grow"><span>Save every N records</span>
          <input type="number" min="1" max="100" data-set="detailBatchSize" value="${Number(s.detailBatchSize) || 10}"></label>
      </div>

      <div class="divider"></div>
      <div class="section-label">Lead score weights</div>
      <div class="check-grid">
        ${Object.entries(w).map(([key, value]) => `
          <label class="field" style="margin-bottom:4px">
            <span>${esc(labelFor(key))}</span>
            <input type="number" min="0" max="50" data-score="${esc(key)}" value="${Number(value) || 0}">
          </label>`).join('')}
      </div>
      <p class="hint tiny">Scores are normalised to 0–100 against the total of these weights, so the scale stays meaningful when you change them.</p>
      <button class="ghost block" data-act="reset-scoring" style="margin-top:6px">Reset weights to defaults</button>
    </div>
  </details>

  ${renderFieldMapping(state)}`;
}

/**
 * FIELD MAPPING — what each field means, where it comes from, and how much of
 * it the current dataset actually has. Visible so there is never any doubt
 * about which value a column holds.
 */
function renderFieldMapping(state) {
  const records = state.records || [];
  const total = records.length;
  const labels = new Map(FIELDS.map((f) => [f.key, f.label]));

  return `
  <div class="card">
    <h2>Field mapping <span class="count">${FIELD_MAPPING.length} fields</span></h2>
    ${FIELD_MAPPING.map((m) => {
    const have = total ? records.filter((r) => !!r[m.key]).length : 0;
    return `
      <div class="map-entry">
        <div class="k">${esc(labels.get(m.key) || m.key)}<span class="tag">${esc(m.stage)}</span></div>
        <div class="d">${esc(m.description)}</div>
        <div class="s">Source: ${esc(m.source)}</div>
        <div class="ex">e.g. ${esc(m.example)}</div>
        ${total ? `<div class="s">Status: <strong>${have} / ${total}</strong> available in the current dataset</div>` : ''}
      </div>`;
  }).join('')}
  </div>`;
}

const LABELS = {
  fullAddress: 'Complete address', phone: 'Phone', website: 'Website', email: 'Email',
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok',
  youtube: 'YouTube', validWebsite: 'Valid website', goodRating: 'Good rating (4.0+)',
  highReviews: 'High reviews (25+)',
};

function labelFor(key) {
  return LABELS[key] || key;
}

export function bindSettings() {
  const root = document.getElementById('view-settings');

  root.addEventListener('change', async (e) => {
    const app = await import('../app.js');

    if (e.target.matches('[data-set]')) {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) await app.saveSettings({ [e.target.dataset.set]: n });
    }
    if (e.target.matches('[data-set-bool]')) {
      await app.saveSettings({ [e.target.dataset.setBool]: e.target.checked });
    }
    if (e.target.matches('[data-score]')) {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) {
        await app.saveSettings({ scoring: { ...app.state.settings.scoring, [e.target.dataset.score]: n } });
      }
    }
  });

  onClick(root, '[data-act]', async (e, el) => {
    const app = await import('../app.js');

    switch (el.dataset.act) {
      case 'open-diagnostics':
        app.switchView('diagnostics');
        break;

      case 'open-export':
        app.switchView('export');
        break;

      case 'reset-scoring':
        await app.saveSettings({ scoring: { ...DEFAULT_SETTINGS.scoring } });
        toast('Weights reset.', 'ok');
        break;

      case 'clear-job': {
        if (!app.state.job) break;
        if (!confirm(`Delete job "${app.state.job.query || app.state.job.id}" and its ${app.state.records.length} record(s)?`)) break;
        const jobs = await import('../../jobs/job-manager.js');
        await jobs.deleteJob(app.state.job.id);
        await app.reload();
        toast('Job deleted.', 'ok');
        break;
      }

      case 'clear-all': {
        if (!confirm('Delete ALL jobs, records, projects and settings? This cannot be undone.')) break;
        try {
          await chrome.storage.local.clear();
          await app.reload();
          toast('All data deleted.', 'ok');
        } catch (err) {
          toast(String(err && err.message), 'error');
        }
        break;
      }
      default: break;
    }
  });
}
