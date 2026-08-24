/**
 * Network layer for the service worker.
 *
 * All third-party fetching goes through here so timeouts, size caps and
 * content-type checks are applied in exactly one place. Enrichment is the only
 * caller — collection never uses it.
 */
import { createLogger } from '../core/logger.js';

const log = createLogger('net');

const MAX_BYTES = 2_500_000;        // stop reading a page after ~2.5 MB
const DEFAULT_TIMEOUT = 15000;

/**
 * Fetch a page as text, with a hard timeout and a size cap.
 * Returns { ok, status, text, url, error }. Never throws.
 */
export async function fetchText(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT, maxBytes = MAX_BYTES } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });

    if (!res.ok) {
      return { ok: false, status: res.status, text: '', url, error: `HTTP ${res.status}` };
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !/text\/html|text\/plain|application\/xhtml/.test(type)) {
      return { ok: false, status: res.status, text: '', url, error: `unsupported content-type ${type}` };
    }

    const text = await readCapped(res, maxBytes);
    return { ok: true, status: res.status, text, url: res.url || url, error: null };
  } catch (err) {
    const message = err && err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err && err.message || err);
    return { ok: false, status: 0, text: '', url, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body but stop at `maxBytes` so one huge page can't blow memory. */
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  out += decoder.decode();
  return out;
}

/**
 * Ensure we hold host permission for third-party fetching.
 * `*://*\/*` is an OPTIONAL permission, requested only when enrichment first
 * runs — so declining it costs you enrichment and nothing else.
 */
export async function ensureEnrichmentPermission(interactive = true) {
  try {
    const has = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
    if (has) return { granted: true, asked: false };
    if (!interactive) return { granted: false, asked: false };
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    log.info('enrichment host permission', granted ? 'granted' : 'denied');
    return { granted, asked: true };
  } catch (err) {
    log.warn('permission check failed', err);
    return { granted: false, asked: false, error: String(err && err.message) };
  }
}
