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
 * pages, extract a public business email and social profile links.
 */
import { EMAIL_STATUS, SOCIAL_KEYS } from '../core/constants.js';
import { safeCall, mapLimit, sleep } from '../core/safe.js';
import { createLogger } from '../core/logger.js';
import * as diag from '../core/diagnostics.js';
import { fetchText } from '../background/net.js';
import { extractEmails, extractSocials, findContactLinks, guessContactUrls } from './extract.js';
import { normalizeWebsite } from '../engines/normalize.js';

const log = createLogger('enrich');

const runState = {
  running: false,
  abort: false,
  jobId: null,
  done: 0,
  total: 0,
  counts: { emails: 0, socials: 0, websites: 0, errors: 0, skipped: 0 },
};

export function getEnrichStatus() {
  return { ...runState, counts: { ...runState.counts } };
}

export function stopEnrichment() {
  runState.abort = true;
  return getEnrichStatus();
}

/**
 * Enrich one record. Always resolves; failures become a status, not an error.
 * @returns a NEW record with email / emailStatus / social fields set.
 */
export async function enrichRecord(record, settings = {}) {
  const out = { ...record };
  const timeout = Number(settings.timeoutMs) || 15000;
  const maxPages = Math.max(1, Number(settings.maxPagesPerSite) || 4);

  const website = normalizeWebsite(record.website);
  if (!website) {
    out.emailStatus = EMAIL_STATUS.SKIPPED;
    out.enrichNote = 'no website to inspect';
    return out;
  }

  let host = '';
  try { host = new URL(website).hostname; } catch { /* keep blank */ }

  // --- homepage ---
  const home = await safeCall(
    'enrich.website',
    () => fetchText(website, { timeoutMs: timeout }),
    { timeout: timeout + 2000, fallback: null, onError: diag.errorSink },
  );

  if (!home.value || !home.value.ok) {
    out.emailStatus = EMAIL_STATUS.ERROR;
    out.enrichNote = (home.value && home.value.error) || home.error || 'homepage unreachable';
    diag.reportFail('enrich.website', out.enrichNote);
    return out;
  }
  diag.reportOk('enrich.website');

  const pages = [{ url: home.value.url, html: home.value.text }];

  // --- contact / about pages, same origin only ---
  if (settings.email !== false && maxPages > 1) {
    let candidates = findContactLinks(home.value.text, home.value.url, maxPages - 1);
    if (!candidates.length) candidates = guessContactUrls(home.value.url).slice(0, maxPages - 1);

    for (const url of candidates) {
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

  // --- email ---
  if (settings.email !== false) {
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
      out.email = '';
      out.emailStatus = EMAIL_STATUS.NOT_FOUND;
      diag.reportOk('enrich.email', 'no public email published', 0);
    }
  } else {
    out.emailStatus = EMAIL_STATUS.SKIPPED;
  }

  // --- social ---
  if (settings.social !== false) {
    const merged = {};
    for (const page of pages) {
      const socials = extractSocials(page.html);
      for (const [k, v] of Object.entries(socials)) if (!merged[k]) merged[k] = v;
    }
    let any = false;
    for (const key of SOCIAL_KEYS) {
      if (merged[key]) { out[key] = merged[key]; any = true; }
    }
    if (any) diag.reportOk('enrich.social');
  }

  out.enrichedAt = new Date().toISOString();
  return out;
}

/**
 * Enrich a whole record set with bounded concurrency.
 * @param {Function} onProgress ({done,total,counts}) => void
 * @param {Function} onBatch    (records) => Promise  — persists partial results
 */
export async function enrichAll(records, settings, { onProgress, onBatch } = {}) {
  if (runState.running) return { records, stats: getEnrichStatus(), alreadyRunning: true };

  const list = records || [];
  runState.running = true;
  runState.abort = false;
  runState.done = 0;
  runState.total = list.length;
  runState.counts = { emails: 0, socials: 0, websites: 0, errors: 0, skipped: 0 };

  const concurrency = Math.max(1, Math.min(Number(settings.concurrency) || 3, 8));
  const output = list.slice();

  try {
    await mapLimit(
      list.map((r, i) => ({ r, i })),
      concurrency,
      async ({ r, i }) => {
        if (runState.abort) return null;

        const res = await safeCall(
          'enrich.email',
          () => enrichRecord(r, settings),
          { timeout: 60000, fallback: null, onError: diag.errorSink },
        );

        const enriched = res.value || { ...r, emailStatus: EMAIL_STATUS.ERROR, enrichNote: res.error };
        output[i] = enriched;

        if (enriched.email) runState.counts.emails++;
        if (enriched.website) runState.counts.websites++;
        if (SOCIAL_KEYS.some((k) => enriched[k])) runState.counts.socials++;
        if (enriched.emailStatus === EMAIL_STATUS.ERROR) runState.counts.errors++;
        if (enriched.emailStatus === EMAIL_STATUS.SKIPPED) runState.counts.skipped++;

        runState.done++;
        if (typeof onProgress === 'function' && runState.done % 3 === 0) {
          try { onProgress(getEnrichStatus()); } catch { /* sink guarded */ }
        }
        if (typeof onBatch === 'function' && runState.done % 20 === 0) {
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
  return { records: output, stats: getEnrichStatus(), aborted: runState.abort };
}
