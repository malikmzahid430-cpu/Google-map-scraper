/**
 * ENRICH view — detail resolution and website enrichment.
 *
 * Both are stages that run over stored records. Neither can affect a running
 * collection, and neither counts a missing value as an error.
 */
import { MSG, SOCIAL_KEYS, ENRICH_STATUS } from '../../core/constants.js';
import { STALL_THRESHOLD_MS } from '../../jobs/job-manager.js';
import { esc, banner, onClick, empty, coverageRow, stat, agoShort } from '../ui.js';

const SOCIAL_LABELS = {
  facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', twitter: 'X / Twitter',
};

/**
 * Records still missing anything THIS enrichment pass would look for —
 * display-only mirror of `enrich-manager.js:needsEnrichment()`'s logic
 * (the sidepanel bundle never imports that background-only module, so this
 * is intentionally duplicated; keep the two in sync).
 */
function pendingCounts(records, e) {
  const wantEmail = e.email !== false;
  const wantSocial = e.social !== false;
  const perPlatform = {};
  for (const key of SOCIAL_KEYS) perPlatform[key] = wantSocial ? records.filter((r) => !r[key]).length : 0;
  const emailPending = wantEmail ? records.filter((r) => !r.email).length : 0;
  const total = records.filter((r) =>
    (wantEmail && !r.email) || (wantSocial && SOCIAL_KEYS.some((k) => !r[k]))).length;
  return { total, emailPending, perPlatform };
}

/**
 * The enrichment status block — the one thing that must never lie about
 * whether anything is still happening. `job.enrich.status` is the single
 * source of truth (see enrich-manager.js / router.js); nothing here infers
 * "still running" from a note string or from done < total alone.
 */
function renderEnrichmentStatus(state, records, e) {
  const job = state.job;
  const enrichState = (job && job.enrich) || { done: 0, total: 0, ranAt: null, status: ENRICH_STATUS.IDLE, currentName: '', counts: {} };
  const status = enrichState.status || ENRICH_STATUS.IDLE;
  const counts = enrichState.counts || {};
  const idleMs = state.now - ((job && job.lastActivityAt) || state.now);
  const stuck = status === ENRICH_STATUS.RUNNING && idleMs > STALL_THRESHOLD_MS;

  if (status === ENRICH_STATUS.RUNNING) {
    if (stuck) {
      return `
      <div class="status-line"><span class="dot paused"></span><span>Recovering…</span></div>
      <p class="hint">No activity for ${Math.round(idleMs / 1000)}s — still watching. ${enrichState.done} / ${enrichState.total} processed so far.</p>
      <button class="grow danger block" data-act="enrich-stop">STOP ENRICHMENT</button>`;
    }
    return `
    <div class="status-line"><span class="dot running"></span><span>Enriching data</span></div>
    <div class="bar indeterminate"><i></i></div>
    <p class="hint"><strong>${enrichState.done} / ${enrichState.total}</strong> processed
      ${enrichState.currentName ? `— Current: <strong>${esc(enrichState.currentName)}</strong>` : ''}</p>
    <div class="field-grid" style="margin:8px 0">
      <div class="field-tile"><span class="k">Email</span><span class="v">${counts.emails || 0} / ${enrichState.total}</span></div>
      <div class="field-tile"><span class="k">Social</span><span class="v">${counts.socials || 0} / ${enrichState.total}</span></div>
    </div>
    <p class="hint tiny">Last activity: ${esc(agoShort((job && job.lastActivityAt) || 0, state.now))}</p>
    <div class="row" style="margin-top:6px">
      <button class="grow" data-act="enrich-pause">PAUSE</button>
      <button class="grow danger" data-act="enrich-stop">STOP ENRICHMENT</button>
    </div>`;
  }

  if (status === ENRICH_STATUS.PAUSED) {
    return `
    <div class="status-line"><span class="dot paused"></span><span>&#8545; Enrichment paused</span></div>
    <p class="hint">${enrichState.done} / ${enrichState.total} processed so far. Already-completed records are kept — resuming continues from here, not from the start.</p>
    <button class="primary block" data-act="enrich-resume">RESUME ENRICHMENT</button>`;
  }

  if (status === ENRICH_STATUS.STOPPED) {
    return `
    <div class="status-line"><span class="dot paused"></span><span>&#9209; Enrichment stopped</span></div>
    <p class="hint">Enriched ${enrichState.done} / ${enrichState.total}. Stopped by user — nothing already completed was lost.</p>
    <button class="primary block" data-act="enrich-start">RESUME ENRICHMENT</button>`;
  }

  if (status === ENRICH_STATUS.FAILED) {
    return `
    <div class="status-line"><span class="dot error"></span><span>Enrichment failed</span></div>
    <p class="hint">Something went wrong before this could finish. Records already enriched were kept — see Diagnostics for what happened, then try again.</p>
    <button class="primary block" data-act="enrich-start">Try again</button>`;
  }

  if (status === ENRICH_STATUS.COMPLETED || status === ENRICH_STATUS.PARTIAL) {
    const partial = status === ENRICH_STATUS.PARTIAL;
    return `
    <div class="status-line"><span class="dot ${partial ? 'error' : 'done'}"></span><span>${partial ? '&#9888; Enrichment partially complete' : '&#10003; Enrichment complete'}</span></div>
    <p class="hint"><strong>${enrichState.total} / ${enrichState.total}</strong> processed</p>
    <div class="field-grid" style="margin:8px 0">
      <div class="field-tile"><span class="k">Email</span><span class="v">${counts.emails || 0} found</span></div>
      ${SOCIAL_KEYS.map((key) => `<div class="field-tile"><span class="k">${esc(SOCIAL_LABELS[key])}</span><span class="v">${counts[key] || 0} found</span></div>`).join('')}
    </div>
    <p class="hint tiny">Not found: ${counts.notFound || 0} · Skipped (no website): ${counts.skipped || 0} · Technical errors: ${counts.errors || 0}</p>
    <button class="primary block" data-act="goto-data">VIEW DATA</button>`;
  }

  // IDLE — nothing has run, or a previous run's job was replaced.
  const pending = pendingCounts(records, e);
  if (!pending.total) {
    return `<p class="hint">Every record already has what you're asking for above — nothing to enrich.</p>
      <button class="primary cta block" disabled>Nothing to enrich</button>`;
  }
  return `
  <p class="hint tiny">Pending — Email: ${pending.emailPending}${SOCIAL_KEYS.map((key) => `, ${esc(SOCIAL_LABELS[key])}: ${pending.perPlatform[key]}`).join('')}</p>
  <button class="primary cta block" data-act="enrich-start" ${state.busy ? 'disabled' : ''}>
    START ENRICHMENT — ${pending.total} record(s)
  </button>
  <p class="hint tiny" style="margin-top:8px">Homepage, then contact and about pages. Only addresses the business publishes itself are collected — nothing is guessed. Records with no website are marked <code>Skipped</code>, which is not an error.</p>`;
}

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
    <h2>2 · Enrich missing data <span class="count">${withSite} with a website</span></h2>
    <p class="hint">Improve your collected leads by finding missing public information — email addresses and social profiles, read only from each business's own website. Only what's actually missing is ever fetched — a field a previous run already found is never re-checked or overwritten.</p>
    <label class="check"><input type="checkbox" data-enrich="email" ${e.email !== false ? 'checked' : ''}><span>Email addresses</span></label>
    <label class="check"><input type="checkbox" data-enrich="social" ${e.social !== false ? 'checked' : ''}><span>Social profiles (Facebook, Instagram, TikTok, LinkedIn, YouTube, X)</span></label>
    <div class="row" style="margin-top:6px">
      <label class="field grow"><span>Concurrency</span>
        <input type="number" min="1" max="8" data-enrich-num="concurrency" value="${Number(e.concurrency) || 4}"></label>
      <label class="field grow"><span>Pages per site</span>
        <input type="number" min="1" max="8" data-enrich-num="maxPagesPerSite" value="${Number(e.maxPagesPerSite) || 4}"></label>
      <label class="field grow"><span>Timeout (ms)</span>
        <input type="number" min="3000" max="60000" step="1000" data-enrich-num="timeoutMs" value="${Number(e.timeoutMs) || 15000}"></label>
    </div>
    <div class="divider"></div>
    ${renderEnrichmentStatus(state, records, e)}
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
          successMessage: (d) => (d && d.started === false
            ? (d.message || 'Nothing to enrich — every record already has what you requested.')
            : `Enriching ${d && d.total} record(s) in the background.`),
        });
        break;
      case 'enrich-pause':
        await app.command(MSG.ENRICH_PAUSE, {}, { successMessage: 'Enrichment paused.' });
        break;
      case 'enrich-resume':
        await app.command(MSG.ENRICH_RESUME, {}, { successMessage: 'Enrichment resumed.' });
        break;
      case 'enrich-stop':
        await app.command(MSG.ENRICH_STOP, {}, { successMessage: 'Enrichment stopped.' });
        break;
      case 'goto-data':
        app.switchView('data');
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
