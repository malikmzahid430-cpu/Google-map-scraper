/**
 * ENRICH view — detail resolution and website enrichment.
 *
 * Both are stages that run over stored records. Neither can affect a running
 * collection, and neither counts a missing value as an error.
 */
import { MSG, SOCIAL_KEYS } from '../../core/constants.js';
import { esc, banner, onClick, empty, coverageRow } from '../ui.js';

export function renderEnrich(state) {
  const records = state.records || [];
  if (!records.length) {
    return `<div class="card">${empty('&#9737;', 'Nothing to enrich yet.<br>Collect some leads on the Home tab first.')}</div>`;
  }

  const q = state.quality();
  const detail = (state.job && state.job.detail) || { done: 0, total: 0 };
  const detailBusy = detail.total > 0 && detail.done < detail.total;
  const withSite = records.filter((r) => r.website).length;
  const e = state.settings.enrich || {};
  const needDetail = records.filter((r) => !r.fullAddress || !r.website || !r.phone).length;

  return `
  <div class="card">
    <h2>Coverage <span class="count">${records.length} record(s)</span></h2>
    ${q.rows.map(coverageRow).join('')}
  </div>

  <div class="card">
    <h2>1 · Place details <span class="count">from Google Maps</span></h2>
    <p class="hint">Most records already have <strong>website</strong> and <strong>phone</strong> straight off the results card — this only processes records still missing <strong>full address</strong>, website or phone, via concurrent fetches sent through your open Google Maps tab.</p>
    ${detailBusy
    ? `<div class="bar indeterminate"><i></i></div>
       <p class="hint">Resolving full address ${detail.done} / ${detail.total}</p>
       <div class="row">
         <button class="grow" data-act="detail-pause">Pause</button>
         <button class="grow" data-act="detail-resume">Resume</button>
         <button class="grow danger" data-act="detail-stop">Stop</button>
       </div>`
    : `<button class="primary block lg" data-act="detail-start" ${state.busy || !needDetail ? 'disabled' : ''}>
         ${needDetail ? `Resolve details for ${needDetail} record(s)` : 'All records already resolved'}
       </button>`}
    ${detail.ranAt ? `<p class="hint tiny" style="margin-top:8px">Last run: ${detail.resolved} resolved · ${detail.notFound} nothing published · ${detail.failed} failed.</p>` : ''}
    <p class="hint tiny">There is no cap and no per-business tab — every missing field is fetched directly, in the background, while you keep browsing.</p>
  </div>

  <div class="card">
    <h2>2 · Website enrichment <span class="count">${withSite} with a website</span></h2>
    <label class="check"><input type="checkbox" data-enrich="email" ${e.email !== false ? 'checked' : ''}><span>Email addresses</span></label>
    <label class="check"><input type="checkbox" data-enrich="social" ${e.social !== false ? 'checked' : ''}><span>Social profiles (Facebook, Instagram, TikTok, LinkedIn, YouTube, X)</span></label>
    <div class="row" style="margin-top:6px">
      <label class="field grow"><span>Concurrency</span>
        <input type="number" min="1" max="8" data-enrich-num="concurrency" value="${Number(e.concurrency) || 3}"></label>
      <label class="field grow"><span>Pages per site</span>
        <input type="number" min="1" max="8" data-enrich-num="maxPagesPerSite" value="${Number(e.maxPagesPerSite) || 4}"></label>
      <label class="field grow"><span>Timeout (ms)</span>
        <input type="number" min="3000" max="60000" step="1000" data-enrich-num="timeoutMs" value="${Number(e.timeoutMs) || 15000}"></label>
    </div>
    <div class="divider"></div>
    ${state.job && /Enrich/i.test((state.job.progress && state.job.progress.note) || '')
    ? `<div class="bar indeterminate"><i></i></div>
       <p class="hint">${esc(state.job.progress.note)}</p>
       <button class="danger block" data-act="enrich-stop">Stop Enrichment</button>`
    : `<button class="primary lg block" data-act="enrich-start" ${state.busy || !withSite ? 'disabled' : ''}>
         ${withSite ? `Enrich ${withSite} record(s)` : 'No websites to inspect'}
       </button>`}
    <p class="hint tiny" style="margin-top:8px">Homepage, then contact and about pages. Only addresses the business publishes itself are collected — nothing is guessed. Records with no website are marked <code>Skipped</code>, which is not an error.</p>
  </div>

  <div class="card">
    <h2>3 · Quality passes</h2>
    <div class="row wrap">
      <button class="grow" data-act="validate">Run Validation</button>
      <button class="grow" data-act="score">Calculate Lead Scores</button>
      <button class="grow" data-act="dedupe">Remove Duplicates</button>
    </div>
    <p class="hint tiny">Each is a separate stage. Any of them can fail without touching your records or the collector.</p>
  </div>

  ${banner('info', `<strong>Nothing here can break Start.</strong><br>
    <span class="hint tiny">Detail resolution, enrichment, validation, scoring and deduplication all run over records already saved to storage. The collector does not import any of them — <code>tools/verify-isolation.mjs</code> checks that mechanically.</span>`)}
  `;
}

export function bindEnrich() {
  const root = document.getElementById('view-enrich');

  root.addEventListener('change', async (e) => {
    const app = await import('../app.js');
    const s = app.state.settings;
    if (e.target.matches('[data-enrich]')) {
      await app.saveSettings({ enrich: { ...s.enrich, [e.target.dataset.enrich]: e.target.checked } });
    }
    if (e.target.matches('[data-enrich-num]')) {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) await app.saveSettings({ enrich: { ...s.enrich, [e.target.dataset.enrichNum]: n } });
    }
  });

  onClick(root, '[data-act]', async (e, el) => {
    const app = await import('../app.js');
    switch (el.dataset.act) {
      case 'detail-start':
        await app.command(MSG.DETAIL_START, {}, { successMessage: 'Resolving place details in the background.' });
        break;
      case 'detail-pause':
        await app.command(MSG.DETAIL_PAUSE, {}, { successMessage: 'Detail resolution paused.' });
        break;
      case 'detail-resume':
        await app.command(MSG.DETAIL_RESUME, {}, { successMessage: 'Detail resolution resumed.' });
        break;
      case 'detail-stop':
        await app.command(MSG.DETAIL_STOP, {}, { successMessage: 'Detail resolution stopped.' });
        break;
      case 'enrich-start':
        // Request the optional host permission from THIS click — a page
        // context definitely has the user gesture chrome.permissions.request
        // needs. Falling back to the service worker (which router.js also
        // does) is less reliable because a message handler is one step
        // removed from the gesture that triggered it.
        try {
          await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
        } catch { /* the background's own check below still applies */ }
        await app.command(MSG.ENRICH_START, { settings: app.state.settings.enrich }, {
          successMessage: (d) => `Enriching ${d && d.total} record(s) in the background.`,
        });
        break;
      case 'enrich-stop':
        await app.command(MSG.ENRICH_STOP, {}, { successMessage: 'Enrichment stopped.' });
        break;
      case 'validate':
        await app.command(MSG.VALIDATE_RUN, {}, {
          successMessage: (d) => (d ? `${d.valid} valid, ${d.partial} partial, ${d.invalid} invalid.` : 'Validation complete.'),
        });
        break;
      case 'score':
        await app.command(MSG.SCORE_RUN, {}, {
          successMessage: (d) => (d ? `Average ${d.average}/100 — ${d.high} high-quality lead(s).` : 'Scoring complete.'),
        });
        break;
      case 'dedupe':
        await app.command(MSG.DEDUPE_RUN, {}, {
          successMessage: (d) => (d ? `Before ${d.before} · ${d.removed} duplicates · after ${d.after}.` : 'Deduplication complete.'),
        });
        break;
      default: break;
    }
  });
}
