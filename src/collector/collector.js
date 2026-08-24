/**
 * ============================================================================
 * GOOGLE MAPS COLLECTOR  —  the Start button's only dependency.
 * ============================================================================
 *
 * ISOLATION CONTRACT (enforced by tools/verify-isolation.mjs):
 *   This file may import ONLY from ../core/ and ./ .
 *   It must NEVER import enrichment, deduplication, validation, scoring,
 *   export or Google Sheets code — directly or transitively.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS WAS REWRITTEN FOR v3
 * ----------------------------------------------------------------------------
 * v2 walked the feed with a positional cursor:
 *
 *     for (; state.cardIndex < cards.length; state.cardIndex++)
 *
 * `cardIndex` persisted across scroll passes while `cards` was re-queried from
 * a VIRTUALIZED list. Maps recycles result nodes, so the array can shrink below
 * the cursor — after which the loop body stops executing entirely and the run
 * scrolls forever collecting nothing. Any card that landed below the cursor was
 * skipped permanently. That is the "not all results scraped" bug.
 *
 * v3 holds no positional state at all. Every pass re-reads the CURRENT DOM and
 * decides what is new purely by stable place identity:
 *
 *     scan current cards -> stable key -> Set lookup -> collect if new
 *     -> scroll -> wait for change -> repeat
 *
 * The only in-loop dedupe is that O(1) Set lookup. Fuzzy matching stays in the
 * separate deduplication stage, exactly as before.
 */
import { JOB_STATUS, TECH_ERROR } from '../core/constants.js';
import { safeSync, sleep, debounce } from '../core/safe.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';

import * as dom from './dom.js';
import * as S from './selectors.js';
import { parseCard } from './card-parser.js';

const log = createLogger('collector');

/* ==================================================================== *
 * Run state
 * ==================================================================== */
const state = {
  status: JOB_STATUS.IDLE,
  jobId: null,
  settings: null,

  /** Stable place keys already collected in THIS run. The entire dedupe. */
  seen: new Set(),
  serial: 0,

  counts: {
    found: 0,          // unique places collected
    scanned: 0,        // cards inspected (includes repeats — diagnostic only)
    scrolls: 0,        // scroll attempts made
    noChangeStreak: 0, // consecutive scrolls that produced nothing new
    technicalErrors: 0,
  },

  /** Heartbeat. Updated on every real event so a stall becomes visible. */
  lastActivityAt: 0,
  lastActivity: '',

  atEnd: false,
  endReason: '',
  abort: false,
  pauseResolvers: [],

  onProgress: null,
  onRecords: null,
  onEnded: null,
};

/** Records emitted by this run, kept so callers can patch them later. */
let emittedRecords = [];
let buffer = [];

export function getStatus() {
  return {
    status: state.status,
    jobId: state.jobId,
    counts: { ...state.counts },
    atEnd: state.atEnd,
    endReason: state.endReason,
    serial: state.serial,
    lastActivityAt: state.lastActivityAt,
    lastActivity: state.lastActivity,
    idleMs: state.lastActivityAt ? Date.now() - state.lastActivityAt : 0,
  };
}

export function getCollectedRecords() {
  return emittedRecords.slice();
}

function isStopped() {
  return state.abort || state.status === JOB_STATUS.STOPPED;
}

/** Heartbeat. Every meaningful event calls this; the UI reads the age. */
function beat(what) {
  state.lastActivityAt = Date.now();
  state.lastActivity = what;
}

function technical(category, message) {
  state.counts.technicalErrors += 1;
  diag.reportFail(`tech.${category}`, message);
  log.warn(`technical error (${category})`, message);
}

/* ==================================================================== *
 * Pause / resume / stop
 * ==================================================================== */

async function waitWhilePaused() {
  while (state.status === JOB_STATUS.PAUSED && !state.abort) {
    await new Promise((resolve) => state.pauseResolvers.push(resolve));
  }
}

function releasePause() {
  const list = state.pauseResolvers.splice(0);
  for (const r of list) { try { r(); } catch { /* ignore */ } }
}

export function pause() {
  if (state.status !== JOB_STATUS.RUNNING) return getStatus();
  state.status = JOB_STATUS.PAUSED;
  beat('Paused');
  emitProgress('Paused');
  return getStatus();
}

export function resume() {
  if (state.status !== JOB_STATUS.PAUSED) return getStatus();
  state.status = JOB_STATUS.RUNNING;
  releasePause();
  beat('Resumed');
  emitProgress('Resumed');
  return getStatus();
}

export function stop() {
  if ([JOB_STATUS.IDLE, JOB_STATUS.STOPPED, JOB_STATUS.COMPLETED].includes(state.status)) {
    return getStatus();
  }
  state.abort = true;
  state.status = JOB_STATUS.STOPPED;
  releasePause();
  beat('Stop requested');
  return getStatus();
}

/* ==================================================================== *
 * Output
 * ==================================================================== */

const flushBuffer = debounce(() => {
  if (!buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  if (typeof state.onRecords === 'function') {
    try { state.onRecords(batch); } catch (err) { technical(TECH_ERROR.STORAGE, `record sink failed: ${err.message}`); }
  }
}, 600);

function emitProgress(note) {
  if (typeof state.onProgress !== 'function') return;
  try {
    state.onProgress({
      status: state.status,
      counts: { ...state.counts },
      atEnd: state.atEnd,
      note: note || state.lastActivity || '',
      lastActivityAt: state.lastActivityAt,
      lastActivity: state.lastActivity,
    });
  } catch (err) {
    // A UI sink failure must never stop collection.
    log.warn('progress sink failed', err);
  }
}

/* ==================================================================== *
 * Stable place identity
 *
 * Priority: Google's feature id (place id) > CID > viewport-stripped URL.
 * The first two survive any DOM recycling; the third is a stable canonical
 * path because card-parser strips the /@lat,lng,zoom and data= segments.
 * ==================================================================== */
export function stableKey(record) {
  if (!record) return '';
  if (record.placeId) return `p:${record.placeId}`;
  if (record.cid) return `c:${record.cid}`;
  if (record.dedupeUrl) return `u:${record.dedupeUrl}`;
  if (record.mapsUrl) return `u:${record.mapsUrl}`;
  return '';
}

/* ==================================================================== *
 * START
 * ==================================================================== */

export async function start(opts) {
  if (state.status === JOB_STATUS.RUNNING || state.status === JOB_STATUS.PAUSED) {
    log.warn('start ignored — already running');
    return getStatus();
  }

  state.status = JOB_STATUS.RUNNING;
  state.jobId = opts.jobId;
  state.settings = opts.settings || {};
  state.seen = new Set();
  state.serial = 0;
  state.counts = { found: 0, scanned: 0, scrolls: 0, noChangeStreak: 0, technicalErrors: 0 };
  state.atEnd = false;
  state.endReason = '';
  state.abort = false;
  state.onRecords = opts.onRecords || null;
  state.onProgress = opts.onProgress || null;
  state.onEnded = opts.onEnded || null;
  emittedRecords = [];
  buffer = [];
  beat('Starting');

  // The whole loop sits inside one guard. A fault becomes an ERROR status with
  // a message, never an unhandled rejection that kills the content script.
  runLoop().catch((err) => {
    technical(TECH_ERROR.COLLECTOR, String(err && err.message ? err.message : err));
    state.status = JOB_STATUS.ERROR;
    finish('error', String(err && err.message ? err.message : err));
  });

  return getStatus();
}

/* ==================================================================== *
 * The loop
 * ==================================================================== */

async function runLoop() {
  const s = state.settings;
  const maxRecords = Number(s.maxRecords) || 0;

  // How many consecutive fruitless scrolls before we accept the end. Maps
  // frequently pauses mid-list, so this is deliberately patient.
  const maxNoChange = Math.max(3, Number(s.maxNoChangeAttempts) || 8);
  const scrollSettle = Number(s.scrollDelayMs) || 700;

  /* ---- 1. find the feed ---- */
  // How long to wait for the results list to appear before giving up. A real
  // Maps page paints it in well under a second; the generous default only
  // matters on a slow connection.
  const feedWaitMs = Number(s.feedWaitMs) || 15000;
  const feed = await dom.waitFor(S.FEED, feedWaitMs);
  if (!feed) {
    diag.setHealth('maps.feed', diag.HEALTH.FAIL, 'Results feed not found on this page');
    state.status = JOB_STATUS.ERROR;
    return finish('error', 'No Google Maps results list found. Run a search on Google Maps first.');
  }
  diag.reportOk('maps.page', 'Google Maps search page');
  diag.reportOk('maps.feed', 'results feed detected');
  beat('Results feed detected');
  emitProgress('Collecting');

  /* ---- 2. collect / scroll / repeat ---- */
  for (;;) {
    await waitWhilePaused();
    if (isStopped()) break;

    const before = state.counts.found;
    scanCurrentCards(maxRecords);
    const gained = state.counts.found - before;

    if (gained > 0) {
      beat(`Collected ${gained} new`);
      state.counts.noChangeStreak = 0;
      emitProgress('Collecting');
    }

    if (maxRecords && state.counts.found >= maxRecords) {
      state.atEnd = true;
      state.endReason = `record limit of ${maxRecords} reached`;
      break;
    }

    await waitWhilePaused();
    if (isStopped()) break;

    /* ---- scroll and judge whether anything can still arrive ---- */
    const outcome = await scrollAndObserve(scrollSettle, gained);

    if (outcome.changed) {
      state.counts.noChangeStreak = 0;
      beat(outcome.reason);
      continue;
    }

    state.counts.noChangeStreak += 1;
    emitProgress(`Waiting for more results (attempt ${state.counts.noChangeStreak}/${maxNoChange})`);

    const exhausted = outcome.endText || state.counts.noChangeStreak >= maxNoChange;
    if (!exhausted) {
      // Back off a little further on each attempt, then try again.
      await sleep(Math.min(400 * state.counts.noChangeStreak, 2500));
      continue;
    }

    // CONFIRMATION SCAN.
    //
    // The scroll that produced the end signal may itself have rendered a final
    // batch. Breaking here without re-reading the DOM loses that batch — which
    // is exactly how a 120-place search returned 95. Never accept the end
    // without one last look at the current cards.
    const beforeConfirm = state.counts.found;
    scanCurrentCards(maxRecords);
    if (state.counts.found > beforeConfirm) {
      state.counts.noChangeStreak = 0;
      beat(`Collected ${state.counts.found - beforeConfirm} new on final check`);
      continue;
    }

    state.atEnd = true;
    state.endReason = outcome.endText
      ? 'Google Maps reported the end of the list'
      : `no new results after ${maxNoChange} scroll attempts`;
    break;
  }

  // Safety net: one final read of whatever is on screen when the loop exits
  // for any reason other than Stop.
  if (!isStopped()) scanCurrentCards(maxRecords);

  flushBuffer.flush();

  if (isStopped()) return finish('stopped');
  state.status = JOB_STATUS.COMPLETED;
  return finish('completed');
}

/**
 * Parse every card currently in the DOM and keep the ones we have not seen.
 * Runs on the WHOLE current list every pass — no cursor, no assumptions about
 * ordering or stability of positions.
 */
function scanCurrentCards(maxRecords = 0) {
  const cards = dom.getCards();
  diag.reportOk('maps.cards', `${cards.length} cards in feed`, 0);

  for (const cardEl of cards) {
    if (isStopped()) return;

    // Enforce the record limit per RECORD, not per pass. Checking it only
    // between passes overshoots by however many the last pass happened to add.
    if (maxRecords && state.counts.found >= maxRecords) return;

    state.counts.scanned += 1;

    const parsed = safeSync('parser.card', () => parseCard(cardEl, state.serial + 1), null);
    if (!parsed.ok) {
      // A card that will not parse is a genuine parser fault.
      technical(TECH_ERROR.PARSER, parsed.error);
      continue;
    }

    const record = parsed.value;
    if (!record || !record.mapsUrl) continue;

    const key = stableKey(record);
    if (!key || state.seen.has(key)) continue;
    state.seen.add(key);

    state.serial += 1;
    record.serial = state.serial;
    record.jobId = state.jobId;
    record.stableKey = key;
    record.scrapedAt = new Date().toISOString();
    record.searchQuery = state.settings.searchQuery || '';
    record.searchLocation = state.settings.searchLocation || '';

    diag.reportOk('parser.card');
    if (record.rating) diag.reportOk('parser.rating');

    buffer.push(record);
    emittedRecords.push(record);
    state.counts.found += 1;
    flushBuffer();
  }
}

/**
 * Scroll once, then decide whether the feed actually moved.
 *
 * "Changed" means any of: more cards rendered, the scroll height grew, the
 * scroll position advanced, or Maps is visibly still loading. Only when NONE
 * of those hold does this count as a fruitless attempt — and even then the
 * caller retries several times before accepting the end.
 */
async function scrollAndObserve(settleMs, gainedThisPass) {
  const beforeMetrics = dom.feedMetrics();
  state.counts.scrolls += 1;

  const ok = await dom.scrollFeed({ settleMs });
  if (!ok) {
    return { changed: false, endText: false, reason: 'feed is not scrollable' };
  }

  // Give a visible loader time to finish before judging.
  let waited = 0;
  while (dom.isFeedLoading() && waited < 6000 && !isStopped()) {
    await sleep(300);
    waited += 300;
  }
  if (waited > 0) beat('Loading more results');

  const after = dom.feedMetrics();

  const grewCards = after.cards > beforeMetrics.cards;
  const grewHeight = after.scrollHeight > beforeMetrics.scrollHeight + 8;
  const movedDown = after.scrollTop > beforeMetrics.scrollTop + 8;

  if (grewCards) return { changed: true, endText: after.endText, reason: `${after.cards - beforeMetrics.cards} more cards rendered` };
  if (grewHeight) return { changed: true, endText: after.endText, reason: 'feed grew' };
  if (movedDown && !after.atBottom) return { changed: true, endText: after.endText, reason: 'scrolled further' };
  if (gainedThisPass > 0) return { changed: true, endText: after.endText, reason: 'new places found in this pass' };

  return { changed: false, endText: after.endText, reason: 'no change after scroll' };
}

/* ==================================================================== *
 * Finish
 * ==================================================================== */

function finish(reason, message) {
  flushBuffer.flush();
  const summary = {
    reason,
    message: message || '',
    status: state.status,
    counts: { ...state.counts },
    atEnd: state.atEnd,
    endReason: state.endReason,
    jobId: state.jobId,
    lastActivityAt: state.lastActivityAt,
  };
  log.info('collection finished', summary);
  if (typeof state.onEnded === 'function') {
    try { state.onEnded(summary); } catch (err) { log.warn('onEnded sink failed', err); }
  }
  emitProgress(reason === 'completed' ? 'Collection complete' : 'Stopped');
  return summary;
}

/** Reset everything. Used when the tab navigates to a new search. */
export function reset() {
  state.abort = true;
  releasePause();
  state.status = JOB_STATUS.IDLE;
  state.seen = new Set();
  state.serial = 0;
  state.counts = { found: 0, scanned: 0, scrolls: 0, noChangeStreak: 0, technicalErrors: 0 };
  state.lastActivityAt = 0;
  state.lastActivity = '';
  emittedRecords = [];
  buffer = [];
}

