/**
 * Service worker command router.
 *
 * Each command is an independent handler. A handler that throws is converted
 * to an error envelope by `bus.listen`, so one broken feature can never take
 * the worker — and therefore the Start button — down with it.
 *
 * STAGE ORDER (each stage is separately triggerable and separately failable):
 *   collect  ->  resolve details  ->  enrich  ->  dedupe  ->  validate  ->  score
 */
import {
  MSG, JOB_STATUS, DEFAULT_SETTINGS, SK, MODE, MODE_NEEDS_DETAIL, TECH_ERROR, ENRICH_STATUS,
} from '../core/constants.js';
import { ok, fail, sendToTab } from '../core/bus.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';
import { safeCall } from '../core/safe.js';
import * as store from '../core/storage.js';
import { analyze } from '../core/quality.js';

import * as jobs from '../jobs/job-manager.js';
import * as queue from '../jobs/queue.js';
import * as dataset from '../jobs/dataset.js';
import * as projects from '../jobs/projects.js';

import * as detailResolver from './detail-resolver.js';
import { ensureEnrichmentPermission } from './net.js';

import * as dedupe from '../engines/dedupe.js';
import * as validate from '../engines/validate.js';
import * as score from '../engines/score.js';
import * as filters from '../engines/filters.js';
import { normalizeRecord } from '../engines/normalize.js';

import * as enrich from '../enrich/enrich-manager.js';

import * as csv from '../export/csv.js';
import * as xlsx from '../export/xlsx.js';
import * as sheets from '../export/sheets.js';

const log = createLogger('router');

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function settings() {
  return await store.getSettings(DEFAULT_SETTINGS);
}

async function notifyUi() {
  await store.set('aq.tick', Date.now());
}

/** The Maps tab we should drive. Prefers the active tab, else any Maps tab. */
/**
 * The Maps tab we should drive.
 *
 * Detail resolution opens its own background tabs on real
 * `google.com/maps/place/...` URLs, so a naive "find a Maps tab" would happily
 * return one of those and send COLLECT_START to a single place page with no
 * results feed. Those tabs are excluded explicitly.
 */
async function findMapsTab() {
  try {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active[0] && !detailResolver.isDetailTab(active[0].id)
        && /google\.[^/]+\/maps/.test(active[0].url || '')) {
      return active[0];
    }
    const all = await chrome.tabs.query({ url: ['*://*.google.com/maps/*', '*://maps.google.com/*'] });
    // Prefer a search page; never a tab we opened ourselves.
    const usable = all.filter((t) => !detailResolver.isDetailTab(t.id));
    return usable.find((t) => /\/maps\/search\//.test(t.url || '')) || usable[0] || null;
  } catch (err) {
    log.warn('tab lookup failed', err);
    return null;
  }
}

async function activeJobId() {
  return await store.get(SK.ACTIVE_JOB, null);
}

/** Records for a scope, honouring the panel's current selection. */
async function scopedRecords(payload) {
  const p = payload || {};
  const scope = p.scope || dataset.SCOPE.CURRENT_JOB;
  return await dataset.readScope(scope, {
    jobId: p.jobId || (await activeJobId()),
    projectId: p.projectId || null,
    jobIds: p.jobIds || [],
  });
}

/* ==================================================================== *
 * COLLECTION — the Start path.
 *
 * Note how short this is. Start creates a job and forwards one message. It
 * touches no enrichment, no dedupe, no scoring, no Sheets, no export.
 * ==================================================================== */

async function handleStart(payload) {
  const tab = await findMapsTab();
  if (!tab) return fail('Open Google Maps and run a search first, then press Start.');

  const cfg = await settings();
  const p = payload || {};
  const mode = p.mode || cfg.mode;

  const job = await jobs.createJob({
    query: p.query || '',
    location: p.location || '',
    mode,
    fields: p.fields || cfg.fields,
    projectId: p.projectId || null,
    projectName: p.projectName || '',
    status: JOB_STATUS.IDLE,
  });

  const runSettings = {
    ...cfg,
    mode,
    searchQuery: p.query || '',
    searchLocation: p.location || '',
  };

  const res = await sendToTab(tab.id, MSG.COLLECT_START, { jobId: job.id, settings: runSettings });
  if (!res.ok) {
    await jobs.updateJob(job.id, { status: JOB_STATUS.ERROR });
    await jobs.addTechnicalError(job.id, TECH_ERROR.COMMUNICATION, res.error);
    return fail(`Could not start collection: ${res.error}. Reload the Google Maps tab and try again.`);
  }

  await jobs.updateJob(job.id, { status: JOB_STATUS.RUNNING, lastActivity: 'Collection started' });
  await notifyUi();
  return ok({ jobId: job.id, tabId: tab.id });
}

async function forwardToCollector(type, mapStatus, activity) {
  const tab = await findMapsTab();
  if (!tab) return fail('No Google Maps tab found.');
  const res = await sendToTab(tab.id, type);
  if (!res.ok) return res;

  const id = await activeJobId();
  if (id && mapStatus) await jobs.updateJob(id, { status: mapStatus, lastActivity: activity });
  await notifyUi();
  return res;
}

/* ---- collector -> worker events ---- */

async function handleRecords(payload) {
  const { jobId, records, isPatch } = payload || {};
  if (!jobId || !records || !records.length) return ok({ stored: 0 });

  const prepared = records.map((r) => {
    try { return normalizeRecord(r); } catch { return r; }
  });

  const write = await safeCall('storage', async () => {
    if (isPatch) await store.writeRecords(jobId, prepared);
    else await store.appendRecords(jobId, prepared);
    return await store.countRecords(jobId);
  }, { fallback: null });

  if (!write.ok) {
    await jobs.addTechnicalError(jobId, TECH_ERROR.STORAGE, write.error);
    return fail(write.error);
  }

  await jobs.updateJob(jobId, {
    counts: { found: write.value },
    lastActivity: `Stored ${write.value} records`,
  });
  await notifyUi();
  return ok({ stored: write.value });
}

async function handleProgress(payload) {
  const p = payload || {};
  if (!p.jobId) return ok(null);

  const patch = {
    progress: { note: p.note || '' },
    lastActivity: p.lastActivity || p.note || '',
  };
  if (p.lastActivityAt) patch.lastActivityAt = p.lastActivityAt;
  if (p.counts) {
    patch.counts = {
      found: p.counts.found,
      scanned: p.counts.scanned,
      scrolls: p.counts.scrolls,
      technicalErrors: p.counts.technicalErrors,
    };
  }
  if (p.status && Object.values(JOB_STATUS).includes(p.status)) patch.status = p.status;

  await jobs.updateJob(p.jobId, patch);
  await notifyUi();
  return ok(null);
}

async function handleEnded(payload) {
  const { jobId, reason, message, endReason } = payload || {};
  if (!jobId) return ok(null);

  const status = reason === 'completed' ? JOB_STATUS.COMPLETED
    : reason === 'stopped' ? JOB_STATUS.STOPPED
      : JOB_STATUS.ERROR;

  await jobs.updateJob(jobId, {
    status,
    progress: { note: endReason || message || '' },
    lastActivity: `Collection ${reason}`,
  });
  if (reason === 'error' && message) {
    await jobs.addTechnicalError(jobId, TECH_ERROR.COLLECTOR, message);
  }
  await jobs.refreshQuality(jobId);
  await notifyUi();

  // Standard / Advanced resolve place details as a SEPARATE stage that starts
  // once collection has already finished and been saved. A failure here can no
  // longer affect the collection result.
  const job = await jobs.getJob(jobId);
  const cfg = await settings();
  if (job && status === JOB_STATUS.COMPLETED && MODE_NEEDS_DETAIL[job.mode] !== false && cfg.autoResolveDetails !== false) {
    startDetailResolution(jobId).catch((err) => log.warn('auto detail resolution failed', err));
  } else {
    await advanceQueue();
  }

  return ok(null);
}

/* ==================================================================== *
 * DETAIL RESOLUTION — separate stage, no cap
 * ==================================================================== */

async function startDetailResolution(jobId) {
  const id = jobId || (await activeJobId());
  if (!id) return { ok: false, error: 'No job selected.' };

  const records = await store.readRecords(id);
  if (!records.length) return { ok: false, error: 'Nothing to resolve.' };

  // Missing-field only: many records already have everything from the results
  // card (see card-parser.js), so skip the tab lookup entirely when there is
  // genuinely nothing left to fill in.
  const stillNeedsSomething = records.some((r) => !r.fullAddress || !r.website || !r.phone);
  if (!stillNeedsSomething) return { ok: true, started: false, skipped: 'nothing missing' };

  // No tab is opened for this — the Maps tab already open does the fetching
  // itself, same-origin, from its own content script. See place-detail.js.
  const tab = await findMapsTab();

  const cfg = await settings();
  const pendingCount = records.filter((r) => !r.fullAddress || !r.website || !r.phone).length;
  await jobs.updateJob(id, {
    lastActivity: 'Resolving place details',
    progress: { note: 'Full Address resolution started' },
    detail: { done: 0, total: pendingCount, resolved: 0, notFound: 0, failed: 0, aborted: false, ranAt: null },
  });
  await notifyUi();

  const run = detailResolver.resolveAll(records, cfg, {
    onProgress: async (status) => {
      const remaining = Math.max(0, status.total - status.done);
      await jobs.updateJob(id, {
        detail: {
          done: status.done, total: status.total, resolved: status.resolved,
          notFound: status.notFound, failed: status.failed, aborted: false,
        },
        progress: {
          note: `Resolving Full Address: ${status.done}/${status.total} processed — `
            + `${status.resolved} successful, ${status.failed} failed, ${remaining} remaining`,
        },
        lastActivity: status.note,
      });
      await notifyUi();
    },
    onBatch: async (partial) => {
      await store.writeRecords(id, partial);
      await notifyUi();
    },
  }, tab && tab.id);

  run.then(async (result) => {
    await store.writeRecords(id, result.records);
    for (const e of result.stats.technicalErrors || []) {
      await jobs.addTechnicalError(id, e.category, e.message);
    }
    await jobs.updateJob(id, {
      detail: {
        // Collapsing total to whatever was actually attempted (rather than
        // the original queued count) means `done < total` — the busy check
        // home.js and enrich.js both use — correctly clears whether this
        // run finished naturally or was stopped early.
        done: result.stats.done, total: result.stats.done, resolved: result.stats.resolved,
        notFound: result.stats.notFound, failed: result.stats.failed,
        aborted: !!result.aborted, ranAt: Date.now(),
      },
      progress: {
        note: result.aborted
          ? 'Full Address resolution stopped'
          : `Full Address enrichment complete — ${result.stats.resolved} resolved, ${result.stats.notFound} not found, ${result.stats.failed} failed`,
      },
      lastActivity: 'Detail resolution finished',
    });
    await jobs.refreshQuality(id, result.records);
    await notifyUi();
    await advanceQueue();
  }).catch(async (err) => {
    log.error('detail resolution failed', err);
    await jobs.addTechnicalError(id, TECH_ERROR.UNEXPECTED, String(err && err.message));
    await notifyUi();
    await advanceQueue();
  });

  return { ok: true, started: true };
}

/* ==================================================================== *
 * Post-processing stages
 * ==================================================================== */

async function handleDedupe(payload) {
  const p = payload || {};
  const id = p.jobId || (await activeJobId());
  if (!id) return fail('No job selected.');
  const records = await store.readRecords(id);

  const res = await safeCall('engine.dedupe', () => dedupe.removeDuplicates(records), {
    timeout: 120000, fallback: null,
  });
  if (!res.ok) {
    await jobs.addTechnicalError(id, TECH_ERROR.UNEXPECTED, `dedupe: ${res.error}`);
    return fail(`Deduplication failed: ${res.error}. Your records are unchanged.`);
  }

  await store.writeRecords(id, res.value.records);
  await jobs.updateJob(id, {
    counts: { found: res.value.stats.after, duplicates: res.value.stats.removed },
    dedupe: { ...res.value.stats, at: Date.now() },
    lastActivity: `Removed ${res.value.stats.removed} duplicates`,
  });
  await jobs.refreshQuality(id, res.value.records);
  diag.reportOk('engine.dedupe', `${res.value.stats.removed} removed`);
  await notifyUi();
  return ok(res.value.stats);
}

async function handleValidate(payload) {
  const id = (payload && payload.jobId) || (await activeJobId());
  if (!id) return fail('No job selected.');
  const records = await store.readRecords(id);

  const res = await safeCall('engine.validate', () => validate.validateAll(records), {
    timeout: 120000, fallback: null,
  });
  if (!res.ok) {
    await jobs.addTechnicalError(id, TECH_ERROR.UNEXPECTED, `validate: ${res.error}`);
    return fail(`Validation failed: ${res.error}. Your records are unchanged.`);
  }
  await store.writeRecords(id, res.value.records);
  await jobs.updateJob(id, { lastActivity: 'Validation complete' });
  diag.reportOk('engine.validate', `${res.value.stats.valid} valid`);
  await notifyUi();
  return ok(res.value.stats);
}

async function handleScore(payload) {
  const id = (payload && payload.jobId) || (await activeJobId());
  if (!id) return fail('No job selected.');
  const records = await store.readRecords(id);
  const cfg = await settings();

  const res = await safeCall('engine.score', () => score.scoreAll(records, cfg.scoring), {
    timeout: 120000, fallback: null,
  });
  if (!res.ok) {
    await jobs.addTechnicalError(id, TECH_ERROR.UNEXPECTED, `score: ${res.error}`);
    return fail(`Scoring failed: ${res.error}. Your records are unchanged.`);
  }
  await store.writeRecords(id, res.value.records);
  await jobs.updateJob(id, { lastActivity: 'Lead scores calculated' });
  diag.reportOk('engine.score', `avg ${res.value.stats.average}`);
  await notifyUi();
  return ok(res.value.stats);
}

/**
 * Write an enriched SUBSET of records back into the full saved set, matched
 * by stable identity. Only records actually passed to enrichAll() (the
 * pending list — see handleEnrich) come back from it; every other record
 * must pass through untouched, never dropped from storage.
 */
function mergeEnrichedSubset(fullList, updatedSubset) {
  const byKey = new Map(updatedSubset.map((r) => [r.stableKey || r.serial, r]));
  return fullList.map((r) => byKey.get(r.stableKey || r.serial) || r);
}

async function handleEnrich(payload) {
  const id = (payload && payload.jobId) || (await activeJobId());
  if (!id) return fail('No job selected.');
  const records = await store.readRecords(id);
  if (!records.length) return fail('Nothing to enrich — collect some leads first.');

  const permission = await ensureEnrichmentPermission(true);
  if (!permission.granted) {
    return fail('Enrichment needs permission to read business websites. Collection and export are unaffected.');
  }

  const cfg = await settings();
  const enrichSettings = { ...cfg.enrich, ...((payload && payload.settings) || {}) };

  // Missing-field-only: build the pending list BEFORE starting anything.
  // A record that already has every field this pass asked for is never
  // re-fetched, re-derived, or even counted against the run.
  const pending = records.filter((r) => enrich.needsEnrichment(r, enrichSettings));
  if (!pending.length) {
    await jobs.updateJob(id, {
      enrich: { done: 0, total: 0, ranAt: Date.now(), status: ENRICH_STATUS.COMPLETED, currentName: '' },
      progress: { note: 'Enrichment complete' },
      lastActivity: 'Nothing left to enrich',
    });
    await notifyUi();
    return ok({ started: false, total: 0, alreadyComplete: records.length, message: 'Every record already has what you requested — nothing to enrich.' });
  }

  // Reset up front so the UI's busy check (done < total) is true the instant
  // Start is clicked, not just once the first progress tick arrives.
  await jobs.updateJob(id, {
    enrich: { done: 0, total: pending.length, status: ENRICH_STATUS.RUNNING, currentName: '' },
    lastActivity: 'Enriching records',
  });
  await notifyUi();

  const run = enrich.enrichAll(pending, enrichSettings, {
    onProgress: async (status) => {
      await jobs.updateJob(id, {
        counts: { enriched: status.done },
        enrich: {
          done: status.done, total: status.total, status: ENRICH_STATUS.RUNNING,
          currentName: status.currentName, counts: status.counts,
        },
        progress: { note: `Enriching ${status.done} / ${status.total}` },
        lastActivity: `Enriched ${status.done}/${status.total}`,
      });
      await notifyUi();
    },
    onBatch: async (partial) => {
      await store.writeRecords(id, mergeEnrichedSubset(records, partial));
      await notifyUi();
    },
  });

  run.then(async (result) => {
    const merged = mergeEnrichedSubset(records, result.records);
    await store.writeRecords(id, merged);

    // done === total is what actually tells the UI enrichment has
    // finished — never a note string, since a completion message like
    // "Enrichment complete" still contains the word "Enrich" and would
    // otherwise be indistinguishable from "still running" to a
    // text-matching check. Collapsing total to whatever was actually
    // processed (rather than the original queued count) means this holds
    // whether the run finished naturally or was stopped early.
    const finalStatus = result.aborted
      ? ENRICH_STATUS.STOPPED
      : result.stats.counts.errors > 0
        ? ENRICH_STATUS.PARTIAL
        : ENRICH_STATUS.COMPLETED;

    await jobs.updateJob(id, {
      counts: { enriched: result.stats.done },
      enrich: {
        done: result.stats.done, total: result.stats.done, ranAt: Date.now(),
        status: finalStatus, currentName: '', counts: result.stats.counts,
      },
      enrichRan: true,
      progress: { note: result.aborted ? 'Enrichment stopped' : 'Enrichment complete' },
      lastActivity: 'Enrichment finished',
    });
    await jobs.refreshQuality(id, merged);
    await notifyUi();
  }).catch(async (err) => {
    log.error('enrichment run failed', err);
    await jobs.addTechnicalError(id, TECH_ERROR.UNEXPECTED, `enrich: ${err && err.message}`);
    await jobs.updateJob(id, {
      enrich: { status: ENRICH_STATUS.FAILED },
      lastActivity: 'Enrichment failed',
    });
    await notifyUi();
  });

  return ok({ started: true, total: pending.length, alreadyComplete: records.length - pending.length });
}

/**
 * Stop must update the job state IMMEDIATELY, not wait for whatever request
 * is currently in flight to finish draining — a user watching the panel
 * clicks Stop and expects it to visibly take effect right away. The
 * abort flag (set synchronously here) still governs the actual engine: no
 * new record starts, in-flight ones are given a chance to finish or bail
 * at their own next checkpoint, and results already completed are kept —
 * `run.then()` in handleEnrich() reconciles the final counts once that
 * settles, without changing the status this already set.
 */
async function handleEnrichStop() {
  const id = await activeJobId();
  const status = enrich.stopEnrichment();
  if (id) {
    await jobs.updateJob(id, {
      enrich: { status: ENRICH_STATUS.STOPPED },
      progress: { note: 'Enrichment stopped' },
      lastActivity: 'Enrichment stopped',
    });
    await notifyUi();
  }
  return ok(status);
}

async function handleEnrichPause() {
  const id = await activeJobId();
  const status = enrich.pauseEnrichment();
  if (id) {
    await jobs.updateJob(id, { enrich: { status: ENRICH_STATUS.PAUSED }, lastActivity: 'Enrichment paused' });
    await notifyUi();
  }
  return ok(status);
}

async function handleEnrichResume() {
  const id = await activeJobId();
  const status = enrich.resumeEnrichment();
  if (id) {
    await jobs.updateJob(id, { enrich: { status: ENRICH_STATUS.RUNNING }, lastActivity: 'Enrichment resumed' });
    await notifyUi();
  }
  return ok(status);
}

/* ==================================================================== *
 * Jobs & datasets
 * ==================================================================== */

async function handleJobsList() {
  const index = await jobs.listJobs();
  const full = await Promise.all(index.map(async (s) => {
    const job = await jobs.getJob(s.id);
    if (!job) return s;
    const stall = jobs.stallState(job);
    return {
      ...s,
      label: jobs.jobLabel(job),
      quality: job.quality,
      counts: job.counts,
      detail: job.detail,
      lastActivityAt: job.lastActivityAt,
      lastActivity: job.lastActivity,
      stuck: stall.stuck,
      idleMs: stall.idleMs,
      combinedFrom: job.combinedFrom || null,
    };
  }));
  return ok({ jobs: full, totals: await dataset.totals(), activeJobId: await activeJobId() });
}

async function handleJobOpen(payload) {
  const id = payload && payload.jobId;
  if (!id) return fail('No job id.');
  await jobs.setActiveJob(id);
  await notifyUi();
  return ok({ jobId: id });
}

async function handleJobDelete(payload) {
  const id = payload && payload.jobId;
  if (!id) return fail('No job id.');
  await jobs.deleteJob(id);
  await notifyUi();
  return ok({ jobId: id });
}

async function handleJobRename(payload) {
  const { jobId, name } = payload || {};
  if (!jobId) return fail('No job id.');
  await jobs.updateJob(jobId, { name: String(name || '').slice(0, 120) });
  await notifyUi();
  return ok({ jobId, name });
}

async function handleCombine(payload) {
  const { jobIds, name, deduplicate = true } = payload || {};
  if (!jobIds || jobIds.length < 1) return fail('Select at least one job to combine.');

  const res = await safeCall('engine.dedupe', () => dataset.combineJobs(jobIds, {
    name,
    dedupeFn: deduplicate ? dedupe.removeDuplicates : null,
  }), { timeout: 180000, fallback: null });

  if (!res.ok) return fail(`Combine failed: ${res.error}. Your original jobs are unchanged.`);
  await jobs.setActiveJob(res.value.jobId);
  await notifyUi();
  return ok(res.value);
}

/* ==================================================================== *
 * Export
 * ==================================================================== */

async function download(filename, url) {
  return await new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : { ok: true, downloadId: id });
    });
  });
}

/** Records for an export: the scope, then the panel's filter criteria. */
async function exportRows(payload) {
  const p = payload || {};
  if (Array.isArray(p.records) && p.records.length) return p.records;
  const { records } = await scopedRecords(p);
  return p.criteria ? filters.applyCriteria(records, p.criteria) : records;
}

async function handleExportCsv(payload) {
  const cfg = await settings();
  const fields = (payload && payload.fields) || cfg.fields;
  const rows = await exportRows(payload);
  const job = await jobs.getJob((payload && payload.jobId) || (await activeJobId()));

  const res = await safeCall('export.csv', async () => {
    const text = csv.buildCsv(rows, fields);
    return await download(csv.csvFilename(job), csv.csvDataUrl(text));
  }, { timeout: 120000, fallback: null });

  if (!res.ok || !res.value || !res.value.ok) {
    return fail(`CSV export failed: ${res.error || (res.value && res.value.error)}`);
  }
  diag.reportOk('export.csv', `${rows.length} rows`);
  return ok({ rows: rows.length, filename: csv.csvFilename(job) });
}

async function handleExportXlsx(payload) {
  const cfg = await settings();
  const fields = (payload && payload.fields) || cfg.fields;
  const rows = await exportRows(payload);
  const job = await jobs.getJob((payload && payload.jobId) || (await activeJobId()));

  const res = await safeCall('export.xlsx', async () => {
    const bytes = xlsx.buildXlsx(rows, fields, { sheetName: 'Leads' });
    return await download(xlsx.xlsxFilename(job), xlsx.xlsxDataUrl(bytes));
  }, { timeout: 180000, fallback: null });

  if (!res.ok || !res.value || !res.value.ok) {
    return fail(`Excel export failed: ${res.error || (res.value && res.value.error)}`);
  }
  diag.reportOk('export.xlsx', `${rows.length} rows`);
  return ok({ rows: rows.length, filename: xlsx.xlsxFilename(job) });
}

async function handleExportSheets(payload) {
  const cfg = await settings();
  const fields = (payload && payload.fields) || cfg.fields;
  const rows = await exportRows(payload);
  const result = await sheets.appendRecords(rows, fields, payload || {});
  if (!result.ok) return fail(result.error);
  return ok(result);
}

/* ==================================================================== *
 * Search queue
 * ==================================================================== */

/**
 * Advance the queue. Never starts the next search while any item is still
 * loading, scraping or paused.
 */
async function advanceQueue() {
  const q = await queue.getQueue();
  if (!q.running) return;

  const current = q.items[q.currentIndex];
  if (current && queue.ACTIVE_STATES.includes(current.status)) {
    const job = current.jobId ? await jobs.getJob(current.jobId) : null;
    if (!job || !queue.isTerminal(job.status)) {
      await queue.saveQueue(q);
      return;                       // still in flight — do not advance
    }
    // Detail resolution must also be done before we move on.
    const detailBusy = detailResolver.getDetailStatus().running;
    if (detailBusy) { await queue.saveQueue(q); return; }

    current.status = job.status === JOB_STATUS.ERROR ? queue.QUEUE_ITEM.FAILED : queue.QUEUE_ITEM.DONE;
    current.count = job.counts.found;
    current.endedAt = Date.now();
  }

  const next = q.items.findIndex((i) => i.status === queue.QUEUE_ITEM.PENDING);
  if (next < 0) {
    q.running = false;
    q.currentIndex = -1;
    await queue.saveQueue(q);
    await notifyUi();
    return;
  }

  q.currentIndex = next;
  q.items[next].status = queue.QUEUE_ITEM.LOADING;
  q.items[next].startedAt = Date.now();
  await queue.saveQueue(q);
  await notifyUi();

  const tab = await findMapsTab();
  const url = queue.itemSearchUrl(q.items[next]);
  try {
    if (tab) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
  } catch (err) {
    q.items[next].status = queue.QUEUE_ITEM.FAILED;
    q.items[next].error = String(err && err.message);
    await queue.saveQueue(q);
  }
  await notifyUi();
}

async function handleQueueRun(payload) {
  const q = await queue.getQueue();
  if (payload && Array.isArray(payload.items)) q.items = payload.items;
  if (!q.items.length) return fail('The queue is empty.');
  q.running = true;
  q.currentIndex = -1;
  for (const item of q.items) {
    if (item.status !== queue.QUEUE_ITEM.DONE) item.status = queue.QUEUE_ITEM.PENDING;
  }
  await queue.saveQueue(q);
  await advanceQueue();
  return ok(await queue.getQueue());
}

async function handleQueueStop() {
  const q = await queue.getQueue();
  q.running = false;
  await queue.saveQueue(q);
  await notifyUi();
  return ok(q);
}

/** Called when a Maps tab finishes loading a queued search. */
export async function onMapsTabReady(tabId) {
  // Our own detail tabs finish loading Maps pages constantly. Starting a
  // collection in one of them would scrape a single place instead of a list.
  if (detailResolver.isDetailTab(tabId)) return;

  const q = await queue.getQueue();
  if (!q.running || q.currentIndex < 0) return;
  const item = q.items[q.currentIndex];
  if (!item || item.status !== queue.QUEUE_ITEM.LOADING || item.jobId) return;

  const cfg = await settings();
  const job = await jobs.createJob({
    name: '', query: item.query, location: item.location, mode: cfg.mode, fields: cfg.fields,
  });
  item.jobId = job.id;
  item.status = queue.QUEUE_ITEM.SCRAPING;
  await queue.saveQueue(q);

  const res = await sendToTab(tabId, MSG.COLLECT_START, {
    jobId: job.id,
    settings: { ...cfg, searchQuery: item.query, searchLocation: item.location },
  });
  if (res.ok) {
    await jobs.updateJob(job.id, { status: JOB_STATUS.RUNNING, lastActivity: 'Queued collection started' });
  } else {
    item.status = queue.QUEUE_ITEM.FAILED;
    item.error = res.error;
    await queue.saveQueue(q);
    await jobs.addTechnicalError(job.id, TECH_ERROR.COMMUNICATION, res.error);
  }
  await notifyUi();
}

/* ==================================================================== *
 * Home screen — "is there already a Google Maps search open?"
 * ==================================================================== */

async function handleMapsDetect() {
  const tab = await findMapsTab();
  if (!tab) return ok({ onMaps: false, query: '', href: '', tabId: null });

  const res = await sendToTab(tab.id, MSG.PING);
  if (!res.ok || !res.data) return ok({ onMaps: false, query: '', href: tab.url || '', tabId: tab.id });

  return ok({
    onMaps: !!res.data.onMaps,
    query: res.data.query || '',
    href: res.data.href || tab.url || '',
    tabId: tab.id,
  });
}

/* ==================================================================== *
 * Diagnostics
 * ==================================================================== */

async function handleDiagRun() {
  const id = await activeJobId();
  const job = id ? await jobs.getJob(id) : null;
  const records = id ? await store.readRecords(id) : [];

  const report = {
    job: job ? {
      id: job.id, label: jobs.jobLabel(job), status: job.status,
      counts: job.counts, detail: job.detail,
      lastActivityAt: job.lastActivityAt, lastActivity: job.lastActivity,
      ...jobs.stallState(job),
    } : null,
    quality: analyze(records),
    technical: (job && job.technical) || { total: 0, byCategory: {}, recent: [] },
    modules: diag.snapshot(),
    page: null,
    sheets: await sheets.getStatus(),
    permissions: await ensureEnrichmentPermission(false),
    detail: detailResolver.getDetailStatus(),
  };

  const storageProbe = await safeCall('storage', () => store.set('aq.diagProbe', Date.now()), { fallback: null });
  if (storageProbe.ok) diag.reportOk('storage', 'read/write ok');
  else diag.reportFail('storage', storageProbe.error);

  const tab = await findMapsTab();
  if (tab) {
    const probe = await sendToTab(tab.id, MSG.DIAG_PAGE_PROBE);
    report.page = probe.ok ? probe.data : { error: probe.error };
  } else {
    report.page = { error: 'No Google Maps tab is open.' };
  }

  try { csv.buildCsv([{ businessName: 'probe' }], ['businessName']); diag.reportOk('export.csv', 'self-test passed'); }
  catch (err) { diag.reportFail('export.csv', err); }
  try { xlsx.buildXlsx([{ businessName: 'probe' }], ['businessName']); diag.reportOk('export.xlsx', 'self-test passed'); }
  catch (err) { diag.reportFail('export.xlsx', err); }

  report.modules = diag.snapshot();
  return ok(report);
}

/**
 * TEMPORARY diagnostic probe — proof of concept only, see
 * src/collector/iframe-probe.js. Relays to whichever Maps tab is already
 * open; opens no tab of its own.
 */
async function handleDiagIframeProbe(payload) {
  const url = payload && payload.url;
  if (!url) return fail('No place URL supplied.');

  const tab = await findMapsTab();
  if (!tab) return fail('No Google Maps tab is open.');

  const res = await sendToTab(tab.id, MSG.DIAG_IFRAME_PROBE, { url, timeoutMs: (payload && payload.timeoutMs) || 10000 });
  return res.ok ? ok(res.data) : fail(res.error);
}

/* ==================================================================== *
 * Handler table
 * ==================================================================== */

export const handlers = {
  [MSG.PING]: () => ok({ alive: true }),

  [MSG.COLLECT_START]: handleStart,
  [MSG.COLLECT_PAUSE]: () => forwardToCollector(MSG.COLLECT_PAUSE, JOB_STATUS.PAUSED, 'Paused'),
  [MSG.COLLECT_RESUME]: () => forwardToCollector(MSG.COLLECT_RESUME, JOB_STATUS.RUNNING, 'Resumed'),
  [MSG.COLLECT_STOP]: () => forwardToCollector(MSG.COLLECT_STOP, JOB_STATUS.STOPPED, 'Stopped'),
  [MSG.COLLECT_STATUS]: () => forwardToCollector(MSG.COLLECT_STATUS, null, null),

  [MSG.COLLECT_RECORDS]: handleRecords,
  [MSG.COLLECT_PROGRESS]: handleProgress,
  [MSG.COLLECT_ENDED]: handleEnded,

  [MSG.DETAIL_START]: async (p) => {
    const r = await startDetailResolution(p && p.jobId);
    return r.ok ? ok(r) : fail(r.error);
  },
  [MSG.DETAIL_STOP]: async () => {
    const result = detailResolver.stopDetail();
    // Background-side abort only stops NEW records from being dispatched —
    // it has no reach into the content script's own in-flight iframes.
    // Tell that tab directly so it tears them down immediately.
    const tab = await findMapsTab();
    if (tab) await sendToTab(tab.id, MSG.DETAIL_STOP);
    return ok(result);
  },
  [MSG.DETAIL_PAUSE]: () => ok(detailResolver.pauseDetail()),
  [MSG.DETAIL_RESUME]: () => ok(detailResolver.resumeDetail()),

  [MSG.ENRICH_START]: handleEnrich,
  [MSG.ENRICH_STOP]: handleEnrichStop,
  [MSG.ENRICH_PAUSE]: handleEnrichPause,
  [MSG.ENRICH_RESUME]: handleEnrichResume,
  [MSG.DEDUPE_RUN]: handleDedupe,
  [MSG.VALIDATE_RUN]: handleValidate,
  [MSG.SCORE_RUN]: handleScore,

  [MSG.JOBS_LIST]: handleJobsList,
  [MSG.JOB_OPEN]: handleJobOpen,
  [MSG.JOB_DELETE]: handleJobDelete,
  [MSG.JOB_RENAME]: handleJobRename,
  [MSG.JOBS_COMBINE]: handleCombine,

  [MSG.EXPORT_CSV]: handleExportCsv,
  [MSG.EXPORT_XLSX]: handleExportXlsx,
  [MSG.EXPORT_SHEETS]: handleExportSheets,

  [MSG.SHEETS_STATUS]: () => sheets.getStatus().then(ok),
  [MSG.SHEETS_SIGNIN]: () => sheets.signIn().then((r) => (r.ok ? ok(r) : fail(r.error))),
  [MSG.SHEETS_SIGNOUT]: () => sheets.signOut().then(ok),
  [MSG.SHEETS_CREATE]: (p) => sheets.createSpreadsheet(p && p.title, p && p.fields, p && p.worksheet)
    .then((r) => (r.ok ? ok(r) : fail(r.error))),
  [MSG.SHEETS_LIST]: (p) => sheets.describeSpreadsheet(p && p.value)
    .then((r) => (r.ok ? ok(r) : fail(r.error))),

  [MSG.QUEUE_RUN]: handleQueueRun,
  [MSG.QUEUE_STOP]: handleQueueStop,

  [MSG.DIAG_RUN]: handleDiagRun,
  [MSG.DIAG_IFRAME_PROBE]: handleDiagIframeProbe,

  [MSG.MAPS_DETECT]: handleMapsDetect,
};
