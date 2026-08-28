/**
 * Enrichment stage.
 *
 * ============================================================================
 * COMPLETELY SEPARATE FROM COLLECTION.
 * ============================================================================
 * It runs in the service worker, over records already in storage, triggered by
 * the ENRICH DATA button. The collector does not import it, does not await it,
 * and does not know it exists. If every function in this file threw, the Start
 * button would still work.
 *
 * Per record: fetch the homepage, follow up to a few same-origin contact/about
 * pages, extract a public business email and social profile links. A field
 * already on the record is never re-derived or overwritten — only what is
 * genuinely missing is fetched for, and a fetch failure can never blank out
 * a value a previous run already found.
 */
import { EMAIL_STATUS, SOCIAL_KEYS } from '../core/constants.js';
import { safeCall, mapLimit, sleep } from '../core/safe.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';
import { fetchText } from '../background/net.js';
import { extractEmails, extractSocials, findContactLinks, guessContactUrls } from './extract.js';
import { normalizeWebsite } from '../engines/normalize.js';

const log = createLogger('enrich');

function blankCounts() {
  return {
    emails: 0, socials: 0, websites: 0,
    facebook: 0, instagram: 0, tiktok: 0, linkedin: 0, youtube: 0, twitter: 0,
    notFound: 0, errors: 0, skipped: 0,
  };
}

const runState = {
  running: false,
  paused: false,
  abort: false,
  jobId: null,
  done: 0,
  total: 0,
  currentName: '',
  counts: blankCounts(),
};

export function getEnrichStatus() {
  return { ...runState, counts: { ...runState.counts } };
}

export function stopEnrichment() {
  runState.abort = true;
  runState.paused = false;
  return getEnrichStatus();
}

export function pauseEnrichment() { runState.paused = true; return getEnrichStatus(); }
export function resumeEnrichment() { runState.paused = false; return getEnrichStatus(); }

async function waitWhilePaused() {
  while (runState.paused && !runState.abort) await sleep(250);
}

/** Does this record still need anything enrichment can provide? */
export function needsEnrichment(record, settings = {}) {
  const wantEmail = settings.email !== false;
  const wantSocial = settings.social !== false;
  const needsEmail = wantEmail && !record.email;
  const needsSocial = wantSocial && SOCIAL_KEYS.some((k) => !record[k]);
  return needsEmail || needsSocial;
}

/**
 * Fetch a site's homepage plus a few contact/about pages, or return the
 * cached result from an earlier call THIS RUN for the exact same website —
 * a failure is cached too, so a dead domain shared by several records is
 * only ever tried once per run, not once per record.
 *
 * The IN-FLIGHT PROMISE is cached, not just the resolved value — several
 * records for the same franchise are typically processed concurrently, and
 * caching only after the first `await` would let every one of them see an
 * empty cache at once and each start its own redundant fetch. Storing the
 * promise synchronously, before anything is awaited, means concurrent
 * callers for the same website all share the one request in flight.
 */
function fetchSitePages(website, needsEmail, needsSocial, maxPages, timeout, cache) {
  if (cache && cache.has(website)) return cache.get(website);

  const promise = (async () => {
    const home = await safeCall(
      'enrich.website',
      () => fetchText(website, { timeoutMs: timeout }),
      { timeout: timeout + 2000, fallback: null, onError: diag.errorSink },
    );

    if (!home.value || !home.value.ok) {
      return { ok: false, error: (home.value && home.value.error) || home.error || 'homepage unreachable' };
    }

    const pages = [{ url: home.value.url, html: home.value.text }];

    // --- contact / about pages, same origin only ---
    if ((needsEmail || needsSocial) && maxPages > 1) {
      let candidates = findContactLinks(home.value.text, home.value.url, maxPages - 1);
      if (!candidates.length) candidates = guessContactUrls(home.value.url).slice(0, maxPages - 1);

      for (const url of candidates) {
        if (runState.abort) break;
        await waitWhilePaused();
        if (runState.abort) break;
        const res = await safeCall(
          'enrich.website',
          () => fetchText(url, { timeoutMs: timeout }),
          { timeout: timeout + 2000, fallback: null },
        );
        if (res.value && res.value.ok) pages.push({ url: res.value.url, html: res.value.text });
        await sleep(120);                       // be polite to the host
      }
    }

    return { ok: true, pages };
  })();

  if (cache) cache.set(website, promise);
  return promise;
}

/**
 * Enrich one record. Always resolves; failures become a status, not an error.
 * A field the record already has is never re-fetched, re-derived or
 * overwritten — a failed attempt at what's missing leaves existing good
 * data on other fields completely untouched.
 * @param {Map} [cache] Optional website -> fetched-pages cache, shared
 *   across one enrichAll() run. Franchise/chain leads that share the exact
 *   same site are common in a Maps result set; without this, N records on
 *   the same domain cost N fetch cycles for identical pages.
 * @returns a NEW record with email / emailStatus / social fields set.
 */
export async function enrichRecord(record, settings = {}, cache = null) {
  const out = { ...record };
  const timeout = Number(settings.timeoutMs) || 15000;
  const maxPages = Math.max(1, Number(settings.maxPagesPerSite) || 4);

  const wantEmail = settings.email !== false;
  const wantSocial = settings.social !== false;
  const needsEmail = wantEmail && !record.email;
  const needsSocial = wantSocial && SOCIAL_KEYS.some((k) => !record[k]);

  if (!needsEmail && !needsSocial) {
    // Nothing requested is actually missing — no fetch, nothing touched.
    out.emailStatus = record.emailStatus || (wantEmail ? EMAIL_STATUS.FOUND : EMAIL_STATUS.SKIPPED);
    out.enrichNote = 'already complete';
    return out;
  }

  const website = normalizeWebsite(record.website);
  if (!website) {
    if (needsEmail) out.emailStatus = EMAIL_STATUS.SKIPPED;
    out.enrichNote = 'no website to inspect';
    return out;
  }

  let host = '';
  try { host = new URL(website).hostname; } catch { /* keep blank */ }

  const result = await fetchSitePages(website, needsEmail, needsSocial, maxPages, timeout, cache);
  if (!result.ok) {
    // A fetch failure is a technical problem for THIS record, but must never
    // blank out a field that was already found on a previous run.
    if (needsEmail) out.emailStatus = EMAIL_STATUS.ERROR;
    out.enrichNote = result.error;
    diag.reportFail('enrich.website', result.error);
    return out;
  }
  diag.reportOk('enrich.website');
  const pages = result.pages;

  // --- email ---
  if (needsEmail) {
    let best = '';
    for (const page of pages) {
      const found = extractEmails(page.html, host);
      if (found.best) { best = found.best; break; }
    }
    if (best) {
      out.email = best;
      out.emailStatus = EMAIL_STATUS.FOUND;
      diag.reportOk('enrich.email');
    } else {
      out.emailStatus = EMAIL_STATUS.NOT_FOUND;
      diag.reportOk('enrich.email', 'no public email published', 0);
    }
  } else if (wantEmail) {
    out.emailStatus = record.emailStatus || EMAIL_STATUS.FOUND;   // already had one
  } else {
    out.emailStatus = EMAIL_STATUS.SKIPPED;
  }

  // --- social — only the platforms this record is still missing ---
  if (needsSocial) {
    const merged = {};
    for (const page of pages) {
      const socials = extractSocials(page.html);
      for (const [k, v] of Object.entries(socials)) if (!merged[k]) merged[k] = v;
    }
    for (const key of SOCIAL_KEYS) {
      if (!record[key] && merged[key]) out[key] = merged[key];
    }
  }

  out.enrichedAt = new Date().toISOString();
  return out;
}

/**
 * Enrich a whole record set with bounded concurrency.
 * @param {Function} onProgress ({done,total,counts,currentName}) => void
 * @param {Function} onBatch    (records) => Promise  — persists partial results
 */
export async function enrichAll(records, settings, { onProgress, onBatch } = {}) {
  if (runState.running) return { records, stats: getEnrichStatus(), alreadyRunning: true };

  const list = records || [];
  runState.running = true;
  runState.paused = false;
  runState.abort = false;
  runState.done = 0;
  runState.total = list.length;
  runState.currentName = '';
  runState.counts = blankCounts();

  const concurrency = Math.max(1, Math.min(Number(settings.concurrency) || 4, 8));
  const batchSize = Math.max(1, Number(settings.batchSize) || 10);
  const output = list.slice();
  // Franchise/chain leads sharing the exact same website are common in a
  // Maps result set; caching fetched pages per run means N such records
  // cost one fetch cycle, not N. Scoped to this call only — never persists
  // or leaks across separate enrichAll() runs or jobs.
  const pageCache = new Map();

  try {
    await mapLimit(
      list.map((r, i) => ({ r, i })),
      concurrency,
      async ({ r, i }) => {
        await waitWhilePaused();
        if (runState.abort) return null;

        runState.currentName = r.businessName || r.searchQuery || '';

        const res = await safeCall(
          'enrich.email',
          () => enrichRecord(r, settings, pageCache),
          { timeout: 60000, fallback: null, onError: diag.errorSink },
        );

        const enriched = res.value || { ...r, emailStatus: EMAIL_STATUS.ERROR, enrichNote: res.error };
        output[i] = enriched;

        // Coverage, not "did this run find something new" — a record that
        // already had a value keeps counting as found.
        if (enriched.email) runState.counts.emails++;
        if (enriched.website) runState.counts.websites++;
        let anySocial = false;
        for (const key of SOCIAL_KEYS) {
          if (enriched[key]) { runState.counts[key]++; anySocial = true; }
        }
        if (anySocial) runState.counts.socials++;

        // Only a genuine technical failure counts as an error. A record
        // that was skipped (no website, or already complete) or whose
        // search simply found nothing published is normal data coverage,
        // never a technical error.
        if (!res.ok || enriched.emailStatus === EMAIL_STATUS.ERROR) runState.counts.errors++;
        else if (enriched.emailStatus === EMAIL_STATUS.SKIPPED) runState.counts.skipped++;
        else if (enriched.emailStatus === EMAIL_STATUS.NOT_FOUND) runState.counts.notFound++;

        runState.done++;
        if (typeof onProgress === 'function' && (runState.done % 3 === 0 || runState.done === runState.total)) {
          try { onProgress(getEnrichStatus()); } catch { /* sink guarded */ }
        }
        if (typeof onBatch === 'function' && runState.done % batchSize === 0) {
          try { await onBatch(output); } catch (err) { log.warn('enrich batch persist failed', err); }
        }
        return enriched;
      },
      () => runState.abort,
    );
  } finally {
    runState.running = false;
  }

  if (typeof onProgress === 'function') {
    try { onProgress(getEnrichStatus()); } catch { /* ignore */ }
  }
  return { records: output, stats: getEnrichStatus(), aborted: runState.abort, paused: runState.paused };
}
