/**
 * Detail Resolution Strategy.
 *
 * ============================================================================
 * COMPLETELY OUTSIDE THE COLLECTION LOOP.
 * ============================================================================
 * The collector never imports this file. Detail resolution runs afterwards,
 * over records already in storage, and can be paused or stopped without
 * touching a running collection.
 *
 * HOW IT WORKS
 *   A small pool of BACKGROUND tabs (default 2) is opened once and reused.
 *   Each tab is navigated to a place URL, the content script reads the
 *   RENDERED detail panel, and the tab moves on to the next record. The user's
 *   own Maps tab is never touched, and nothing depends on the feed still
 *   holding a card for that place.
 *
 * WHY NOT A CAP
 *   v2 stopped after 40 records (`domFallbackCap`), silently abandoning the
 *   rest. There is no cap here. Throughput is governed by concurrency,
 *   timeouts and retries, and every record is either resolved or given an
 *   explicit status.
 */
import { MSG, FIELD_STATUS, TECH_ERROR } from '../core/constants.js';
import { sleep, safeCall } from '../core/safe.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';

const log = createLogger('detail');

/**
 * Tab ids this module currently owns.
 *
 * Detail tabs are real `google.com/maps/place/...` pages, so anything that
 * looks for "a Google Maps tab" would happily pick one of ours. `findMapsTab`
 * and the queue's tab-ready hook both consult this set to exclude them.
 */
const ownedTabs = new Set();

export function isDetailTab(tabId) {
  return ownedTabs.has(tabId);
}

export function detailTabIds() {
  return [...ownedTabs];
}

const runState = {
  running: false,
  paused: false,
  abort: false,
  jobId: null,
  done: 0,
  total: 0,
  resolved: 0,
  notFound: 0,
  failed: 0,          // TECHNICAL failures only
  lastActivityAt: 0,
  note: '',
};

export function getDetailStatus() {
  return {
    ...runState,
    idleMs: runState.lastActivityAt ? Date.now() - runState.lastActivityAt : 0,
  };
}

export function pauseDetail() { runState.paused = true; return getDetailStatus(); }
export function resumeDetail() { runState.paused = false; return getDetailStatus(); }
export function stopDetail() { runState.abort = true; runState.paused = false; return getDetailStatus(); }

function beat(note) {
  runState.lastActivityAt = Date.now();
  if (note) runState.note = note;
}

async function waitWhilePaused() {
  while (runState.paused && !runState.abort) await sleep(250);
}

/* ==================================================================== *
 * Tab pool
 * ==================================================================== */

class TabPool {
  constructor(size) {
    this.size = Math.max(1, Math.min(size || 2, 4));
    this.tabs = [];
  }

  /**
   * Open one background tab. Returns null instead of throwing — the browser can
   * refuse (tab limits, policy), and a rejection here used to escape the worker
   * and reject the whole Promise.all while other workers kept running against
   * tabs that `finally` had already closed.
   */
  async acquire() {
    if (this.tabs.length >= this.size) return null;
    try {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!tab || tab.id == null) return null;
      this.tabs.push(tab.id);
      ownedTabs.add(tab.id);
      return tab.id;
    } catch (err) {
      log.warn('could not open a detail tab', err);
      return null;
    }
  }

  async closeAll() {
    for (const id of this.tabs) {
      ownedTabs.delete(id);
      try { await chrome.tabs.remove(id); } catch { /* already gone */ }
    }
    this.tabs = [];
  }
}

/** Navigate a tab and wait for it to finish loading. Never throws. */
async function navigate(tabId, url, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve({ ok, error: error || null });
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false, `navigation timed out after ${timeoutMs}ms`), timeoutMs);

    try {
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId, { url }).catch((err) => finish(false, String(err && err.message)));
    } catch (err) {
      finish(false, String(err && err.message));
    }
  });
}

/** `hl=en` keeps the panel's ARIA labels predictable for the extractors. */
export function placePageUrl(mapsUrl) {
  try {
    const u = new URL(mapsUrl);
    u.searchParams.set('hl', 'en');
    return u.toString();
  } catch {
    return mapsUrl;
  }
}

/* ==================================================================== *
 * Resolution
 * ==================================================================== */

/**
 * Resolve one record in a given tab.
 * @returns {{status:'resolved'|'notfound'|'failed', detail:object|null, error:string|null}}
 */
async function resolveOne(tabId, record, settings) {
  const timeout = Number(settings.detailTimeoutMs) || 15000;

  const nav = await navigate(tabId, placePageUrl(record.mapsUrl), timeout);
  if (!nav.ok) return { status: 'failed', detail: null, error: nav.error };

  // The content script needs a moment after `complete` before the panel paints.
  await sleep(Number(settings.detailSettleMs) || 350);

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: MSG.DETAIL_EXTRACT, payload: { timeoutMs: timeout } });
  } catch (err) {
    return { status: 'failed', detail: null, error: `content script unreachable: ${err && err.message}` };
  }

  if (!res || !res.ok || !res.data) {
    return { status: 'failed', detail: null, error: (res && res.error) || 'no detail returned' };
  }

  const detail = res.data;
  const gotSomething = detail.fullAddress || detail.website || detail.phone;
  return { status: gotSomething ? 'resolved' : 'notfound', detail, error: null };
}

/** Copy resolved values onto a record without overwriting anything good. */
export function applyDetail(record, detail) {
  if (!detail) return record;
  const out = { ...record };

  const take = (key) => { if (detail[key] && !out[key]) out[key] = detail[key]; };
  ['fullAddress', 'city', 'state', 'postalCode', 'country', 'website', 'phone',
    'latitude', 'longitude', 'category'].forEach(take);

  // The panel's street line is more precise than the card's.
  if (detail.address) out.address = detail.address;

  // Card values win for rating: they are what the user saw in the list.
  if (detail.rating && !out.rating) out.rating = detail.rating;
  if (detail.reviewCount && !out.reviewCount) out.reviewCount = detail.reviewCount;

  out.fullAddressStatus = out.fullAddress ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND;
  out.websiteStatus = out.website ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND;
  out.phoneStatus = out.phone ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND;
  out.detailVia = detail.via || null;
  out.detailResolvedAt = new Date().toISOString();
  return out;
}

/** Mark a record whose resolution genuinely failed (a technical problem). */
function markFailed(record, error) {
  return {
    ...record,
    fullAddressStatus: record.fullAddress ? FIELD_STATUS.FOUND : FIELD_STATUS.FAILED,
    websiteStatus: record.website ? FIELD_STATUS.FOUND : FIELD_STATUS.FAILED,
    phoneStatus: record.phone ? FIELD_STATUS.FOUND : FIELD_STATUS.FAILED,
    detailError: String(error).slice(0, 200),
  };
}

/**
 * Resolve details for a whole record set.
 *
 * @param {object[]} records
 * @param {object}   settings  { detailConcurrency, detailTimeoutMs, detailBatchSize, detailRetries }
 * @param {object}   hooks     { onProgress(status), onBatch(records) }
 * @returns {{records, stats}}
 */
export async function resolveAll(records, settings = {}, hooks = {}) {
  const { onProgress, onBatch } = hooks;
  const list = (records || []).slice();

  if (runState.running) return { records: list, stats: getDetailStatus(), alreadyRunning: true };

  // Only records that still need something. Nothing is skipped by a cap.
  const pendingIdx = list
    .map((r, i) => i)
    .filter((i) => !list[i].fullAddress || !list[i].website || !list[i].phone);

  runState.running = true;
  runState.abort = false;
  runState.paused = false;
  runState.done = 0;
  runState.total = pendingIdx.length;
  runState.resolved = 0;
  runState.notFound = 0;
  runState.failed = 0;
  beat('Starting detail resolution');

  const concurrency = Math.max(1, Math.min(Number(settings.detailConcurrency) || 2, 4));
  const batchSize = Math.max(1, Number(settings.detailBatchSize) || 10);
  const retries = Math.max(0, Number(settings.detailRetries) || 1);

  const pool = new TabPool(concurrency);
  const technicalErrors = [];

  // Mark everything queued so the UI can say "Pending" rather than "Not found".
  for (const i of pendingIdx) {
    if (!list[i].fullAddress) list[i] = { ...list[i], fullAddressStatus: FIELD_STATUS.PENDING };
  }

  // Records this run actually reached. Anything not in here keeps its previous
  // status: reporting an unvisited place as "Not Found" would be a lie.
  const attempted = new Set();
  let tabsOpened = 0;

  try {
    const workers = [];
    let cursor = 0;

    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        const tabId = await pool.acquire();
        if (!tabId) return;
        tabsOpened += 1;

        for (;;) {
          await waitWhilePaused();
          if (runState.abort) return;

          const slot = cursor++;
          if (slot >= pendingIdx.length) return;
          const index = pendingIdx[slot];
          const record = list[index];
          attempted.add(index);

          let outcome = null;
          for (let attempt = 0; attempt <= retries; attempt++) {
            if (runState.abort) return;
            outcome = await safeCall(
              'detail.resolve',
              () => resolveOne(tabId, record, settings),
              { timeout: (Number(settings.detailTimeoutMs) || 15000) + 8000, fallback: null },
            );
            if (outcome.ok && outcome.value && outcome.value.status !== 'failed') break;
            if (attempt < retries) await sleep(600 * (attempt + 1));
          }

          const result = (outcome && outcome.value) || { status: 'failed', detail: null, error: (outcome && outcome.error) || 'unknown' };

          if (result.status === 'resolved') {
            list[index] = applyDetail(record, result.detail);
            runState.resolved += 1;
            diag.reportOk('detail.panel');
          } else if (result.status === 'notfound') {
            // Google exposes nothing for this place. Data quality, NOT an error.
            list[index] = applyDetail(record, result.detail || {});
            runState.notFound += 1;
            diag.reportOk('detail.panel', 'place exposes no detail rows', 0);
          } else {
            // A genuine failure: navigation, messaging or timeout.
            list[index] = markFailed(record, result.error);
            runState.failed += 1;
            technicalErrors.push({ category: TECH_ERROR.TIMEOUT, message: result.error });
            diag.reportFail('detail.panel', result.error);
          }

          runState.done += 1;
          beat(`Resolved ${runState.done}/${runState.total}`);

          if (runState.done % 3 === 0 || runState.done === runState.total) {
            if (typeof onProgress === 'function') {
              try { onProgress(getDetailStatus()); } catch { /* sink guarded */ }
            }
          }
          if (runState.done % batchSize === 0 && typeof onBatch === 'function') {
            try { await onBatch(list); } catch (err) { log.warn('batch persist failed', err); }
          }

          await sleep(Number(settings.detailPaceMs) || 120);
        }
      })().catch((err) => {
        // One worker dying must not abort the others, and must not reject the
        // Promise.all that keeps `finally` from closing tabs out from under them.
        log.warn('detail worker failed', err);
        technicalErrors.push({ category: TECH_ERROR.UNEXPECTED, message: `detail worker: ${err && err.message}` });
      }));
    }

    await Promise.all(workers);
  } finally {
    await pool.closeAll();
    runState.running = false;
  }

  if (tabsOpened === 0 && pendingIdx.length) {
    // Nothing could be opened, so nothing was checked. Say so plainly rather
    // than marking every record "Not Found".
    technicalErrors.push({
      category: TECH_ERROR.COMMUNICATION,
      message: 'Could not open a background tab for detail resolution.',
    });
    for (const i of pendingIdx) {
      if (list[i].fullAddressStatus === FIELD_STATUS.PENDING) {
        list[i] = { ...list[i], fullAddressStatus: FIELD_STATUS.FAILED };
      }
    }
    runState.failed += pendingIdx.length;
  }

  // Finalise ONLY the records this run actually visited. A record left pending
  // because the run was stopped, or because no tab could be opened, keeps a
  // status that reflects the truth instead of an invented "Not Found".
  for (const i of attempted) {
    if (list[i].fullAddressStatus === FIELD_STATUS.PENDING) {
      list[i] = { ...list[i], fullAddressStatus: list[i].fullAddress ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND };
    }
  }

  if (typeof onProgress === 'function') {
    try { onProgress(getDetailStatus()); } catch { /* ignore */ }
  }

  return {
    records: list,
    stats: { ...getDetailStatus(), technicalErrors },
    aborted: runState.abort,
  };
}
