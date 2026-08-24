/**
 * Content script entry point — the bridge between the side panel and the
 * collector.
 *
 * It owns no scraping logic. Its whole job is: receive a command, call the
 * collector, and forward the collector's callbacks to the service worker.
 * Keeping it this thin is what makes the Start path auditable at a glance.
 */
import { MSG, JOB_STATUS } from '../core/constants.js';
import { listen, ok, fail, send } from '../core/bus.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';
import * as collector from './collector.js';
import * as dom from './dom.js';
import * as S from './selectors.js';
import { parseCard } from './card-parser.js';
import { fetchPlaceDetail } from './place-detail.js';

const log = createLogger('content');

/* ------------------------------------------------------------------ *
 * Sinks — forward collector events to the service worker. Each is
 * individually guarded so a messaging failure cannot stop collection.
 * ------------------------------------------------------------------ */

function onRecords(records, isPatch = false) {
  send(MSG.COLLECT_RECORDS, {
    jobId: collector.getStatus().jobId,
    records,
    isPatch,
  });
}

function onProgress(progress) {
  send(MSG.COLLECT_PROGRESS, {
    jobId: collector.getStatus().jobId,
    ...progress,
  });
}

function onEnded(summary) {
  send(MSG.COLLECT_ENDED, summary);
}

/* ------------------------------------------------------------------ *
 * Command handlers
 * ------------------------------------------------------------------ */

const handlers = {
  [MSG.PING]: () => ok({
    alive: true,
    onMaps: dom.isMapsSearchPage(),
    href: location.href,
    query: dom.getSearchQuery(),
  }),

  [MSG.COLLECT_START]: async (payload) => {
    if (!dom.isMapsSearchPage()) {
      return fail('This tab is not showing Google Maps search results.');
    }
    const status = await collector.start({
      jobId: payload && payload.jobId,
      settings: (payload && payload.settings) || {},
      onRecords,
      onProgress,
      onEnded,
    });
    return ok(status);
  },

  /**
   * Resolve Full Address / Website / Phone for ONE place, without opening a
   * tab or navigating this one.
   *
   * Sent by the detail resolver in the background to whichever Maps tab is
   * already open. This tab's own `fetch()` of the place URL is same-origin —
   * it carries the user's Google session automatically — so the response is
   * rich enough to parse directly. This never touches this tab's own DOM,
   * URL or scroll position, so it cannot disturb a collection running here.
   */
  [MSG.DETAIL_EXTRACT]: async (payload) => {
    const url = payload && payload.url;
    if (!url) return fail('No place URL supplied.');
    const result = await fetchPlaceDetail(url, {
      timeoutMs: (payload && payload.timeoutMs) || 12000,
    });
    return result.ok ? ok(result.data) : fail(result.error);
  },

  [MSG.COLLECT_PAUSE]: () => ok(collector.pause()),
  [MSG.COLLECT_RESUME]: () => ok(collector.resume()),
  [MSG.COLLECT_STOP]: () => ok(collector.stop()),
  [MSG.COLLECT_STATUS]: () => ok(collector.getStatus()),

  /**
   * Live page probe for the Diagnostics view. Reads the page without
   * collecting anything, so it is safe to run at any time.
   */
  [MSG.DIAG_PAGE_PROBE]: () => {
    const feed = dom.getFeed();
    const cards = dom.getCards();
    const sample = cards.length ? cards[0] : null;

    let sampleParse = null;
    if (sample) {
      try {
        sampleParse = parseCard(sample, 1);
      } catch (err) {
        sampleParse = { error: String(err && err.message) };
      }
    }

    return ok({
      href: location.href,
      onMapsPage: dom.isMapsSearchPage(),
      feedFound: !!feed,
      feedSelector: feed ? matchedSelector(S.FEED, feed) : null,
      cardCount: cards.length,
      atEnd: dom.feedReachedEnd(),
      query: dom.getSearchQuery(),
      sample: sampleParse,
      diagnostics: diag.snapshot(),
    });
  },
};


/** Which selector in the list actually matched — shown in Diagnostics. */
function matchedSelector(list, el) {
  for (const sel of list) {
    try { if (el.matches(sel)) return sel; } catch { /* unsupported */ }
  }
  return list[0];
}

listen(handlers);

/* ------------------------------------------------------------------ *
 * Maps is a single-page app: a new search replaces the feed without a
 * page load. Reset the collector when that happens so a stale run cannot
 * bleed into the next search.
 * ------------------------------------------------------------------ */
let lastHref = location.href;
setInterval(() => {
  if (location.href === lastHref) return;
  const wasSearch = /\/maps\/search\//.test(lastHref);
  lastHref = location.href;
  const status = collector.getStatus().status;
  if (wasSearch && status === JOB_STATUS.RUNNING) {
    log.info('navigation during run — collector left running (Maps SPA panel change)');
  }
}, 1500);

log.info('content module ready', location.href);
send(MSG.COLLECT_PROGRESS, { status: 'ready', note: 'Content script loaded' });
