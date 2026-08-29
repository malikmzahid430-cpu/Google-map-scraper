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
 * HOW IT WORKS — NO TABS
 *   Every business is fast-pathed already if the results card exposed its
 *   website/phone (see `card-parser.js`); only records still missing Full
 *   Address, Website or Phone reach this stage at all. For those, this module
 *   asks the Maps tab's own content script to `fetch()` the place page and
 *   read the response — a same-origin request that carries the user's Google
 *   session, so it returns a response rich enough to parse without ever
 *   rendering it. See `src/collector/place-detail.js` for why that fetch has
 *   to run from the content script and not here.
 *
 *   Nothing here opens, navigates or closes a browser tab. Bounded
 *   concurrency (`mapLimit`) controls how many concurrent fetches run inside
 *   that one content script, exactly the same way `enrich-manager.js` bounds
 *   concurrent website fetches — no tab pool, no per-record tab lifecycle.
 *
 * WHY NOT A CAP
 *   v2 stopped after 40 records (`domFallbackCap`), silently abandoning the
 *   rest. There is no cap here. Throughput is governed by concurrency,
 *   timeouts and retries, and every record is either resolved or given an
 *   explicit status.
 */
import { MSG, FIELD_STATUS, TECH_ERROR } from '../core/constants.js';
import { sleep, safeCall, mapLimit } from '../core/safe.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';

const log = createLogger('detail');

/**
 * Kept for API compatibility with `router.js`'s `findMapsTab()`, which
 * excludes "our own" tabs from consideration. This module opens none, so the
 * set is permanently empty — but the export stays so nothing upstream needs
 * to change just because the mechanism underneath it did.
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
 * Resolution
 * ==================================================================== */

/**
 * Resolve one record via the Maps tab's content script.
 * @returns {{status:'resolved'|'notfound'|'failed', detail:object|null, error:string|null}}
 */
async function resolveOne(tabId, record, settings) {
  const timeout = Number(settings.detailTimeoutMs) || 15000;

  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, {
      type: MSG.DETAIL_EXTRACT,
      // The card's own Address (record.address), already trusted, gives
      // the content script's anchor-based Full Address fallback something
      // to search for even when this one fetch's own DOM/payload
      // extraction finds no street of its own.
      payload: { url: record.mapsUrl, timeoutMs: timeout, knownStreet: record.address || '' },
    });
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
 * @param {number|null} tabId  the Maps tab whose content script performs the
 *                             fetches. No tab is opened for this — it is the
 *                             tab the caller already found via findMapsTab().
 * @returns {{records, stats}}
 */
export async function resolveAll(records, settings = {}, hooks = {}, tabId = null) {
  const { onProgress, onBatch } = hooks;
  const list = (records || []).slice();

  if (runState.running) return { records: list, stats: getDetailStatus(), alreadyRunning: true };

  // Only records that still need something. Nothing is skipped by a cap, and
  // nothing already found (often straight off the results card) is re-checked.
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

  const technicalErrors = [];

  if (!tabId) {
    // Nothing to message, so nothing was checked. Say so plainly rather than
    // marking every record "Not Found" — that would be a lie.
    runState.running = false;
    if (pendingIdx.length) {
      technicalErrors.push({
        category: TECH_ERROR.COMMUNICATION,
        message: 'No Google Maps tab is open — could not resolve place details.',
      });
      for (const i of pendingIdx) list[i] = markFailed(list[i], 'no Google Maps tab open');
      runState.failed = pendingIdx.length;
      runState.done = pendingIdx.length;
    }
    if (typeof onProgress === 'function') { try { onProgress(getDetailStatus()); } catch { /* ignore */ } }
    return { records: list, stats: { ...getDetailStatus(), technicalErrors }, aborted: false };
  }

  const concurrency = Math.max(1, Math.min(Number(settings.detailConcurrency) || 5, 8));
  const batchSize = Math.max(1, Number(settings.detailBatchSize) || 10);
  const retries = Math.max(0, Number(settings.detailRetries) || 1);

  // Mark everything queued so the UI can say "Pending" rather than "Not found".
  for (const i of pendingIdx) {
    if (!list[i].fullAddress) list[i] = { ...list[i], fullAddressStatus: FIELD_STATUS.PENDING };
  }

  const attempted = new Set();

  try {
    await mapLimit(pendingIdx, concurrency, async (index) => {
      await waitWhilePaused();
      if (runState.abort) return;

      const record = list[index];
      attempted.add(index);

      let outcome = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (runState.abort) return;
        // The content script's own DETAIL_EXTRACT handler can spend up to
        // settings.detailTimeoutMs on Tier 1 (fetch), then — only when Tier 1
        // found no Full Address — up to another ~10s rendering Tier 2's
        // hidden iframe (see iframe-address.js). This outer bound has to
        // comfortably cover both phases plus messaging overhead, not just
        // Tier 1 alone.
        outcome = await safeCall(
          'detail.resolve',
          () => resolveOne(tabId, record, settings),
          { timeout: (Number(settings.detailTimeoutMs) || 15000) + 15000, fallback: null },
        );
        if (outcome.ok && outcome.value && outcome.value.status !== 'failed') break;
        if (attempt < retries) await sleep(400 * (attempt + 1));
      }

      const result = (outcome && outcome.value) || { status: 'failed', detail: null, error: (outcome && outcome.error) || 'unknown' };

      if (result.status === 'resolved') {
        list[index] = applyDetail(record, result.detail);
        runState.resolved += 1;
        diag.reportOk('detail.panel');
      } else if (result.status === 'notfound') {
        // The place's page exposes nothing for this field. Data quality, NOT an error.
        list[index] = applyDetail(record, result.detail || {});
        runState.notFound += 1;
        diag.reportOk('detail.panel', 'place exposes no detail rows', 0);
      } else {
        // A genuine failure: fetch, messaging or timeout.
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

      // Be polite to Google's servers between requests in the same lane.
      await sleep(Number(settings.detailPaceMs) || 120);
    }, () => runState.abort);
  } finally {
    runState.running = false;
  }

  // Finalise ONLY the records this run actually attempted. A record left
  // pending because the run was stopped keeps a status that reflects the
  // truth instead of an invented "Not Found".
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
