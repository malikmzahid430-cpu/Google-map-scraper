/**
 * Full Address — Tier 2 resolver (hidden same-origin iframe render).
 *
 * WHY THIS EXISTS
 *   Tier 1 (place-detail.js's fetchPlaceDetail — a same-origin fetch() of
 *   the place URL, parsed with DOMParser) cannot see `[data-item-id="address"]`
 *   for a growing share of businesses: that element is constructed by
 *   Google Maps' own client-side JavaScript after the page loads, and
 *   DOMParser never executes scripts. Confirmed live: a raw "View Source"
 *   of a real place page had no `APP_INITIALIZATION_STATE`, no JSON-LD
 *   address, and no trace of the address text at all — yet the same URL's
 *   rendered DOM (Chrome DevTools, JS executed) had the complete address
 *   sitting in `[data-item-id="address"]`. A follow-up proof-of-concept
 *   (the "Iframe DOM probe" in Diagnostics — see iframe-probe.js, kept
 *   alongside this file) proved a hidden, same-origin iframe injected into
 *   the existing Maps tab can render that same element without opening any
 *   browser tab, and it succeeded against a real business. This module is
 *   the production version of that proof.
 *
 * WHAT IT DOES NOT DO
 *   - No chrome.tabs.create, no navigation of the visible tab.
 *   - No raw-HTML/CSS/regex scanning of any kind. The only signal read is
 *     the exact same, already-validated place-detail.js `extractAddress()`
 *     function, pointed at the iframe's own rendered document instead of a
 *     DOMParser'd fetch response — reusing existing extraction/validation
 *     rather than inventing new logic.
 *   - No invented data: a candidate that doesn't pass `V.isPlausibleFullAddress`
 *     is never returned; timeouts and errors resolve to 'notfound'/'failed',
 *     never a guess.
 *
 * BOUNDED BY DESIGN
 *   - At most MAX_CONCURRENT_IFRAMES iframes exist at once, globally, in
 *     this content script's single tab — independent of however many
 *     DETAIL_EXTRACT messages the background has in flight.
 *   - Every iframe gets a hard timeout (IFRAME_TIMEOUT_MS) and is removed
 *     from the DOM in a `finally`, on every exit path.
 *   - `abortAll()` (called when the user presses Stop) tears down every
 *     currently active iframe immediately and rejects any call still
 *     waiting on one to load, instead of leaving it to hang until its
 *     timeout. It uses a generation counter rather than a sticky flag, so
 *     a later, genuinely new resolution run is never left permanently
 *     unable to use this tier just because an earlier run was stopped.
 */
import * as placeDetail from './place-detail.js';
import * as V from './validators.js';

export const MAX_CONCURRENT_IFRAMES = 2;
const IFRAME_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 250;

let activeCount = 0;
const waitQueue = [];
const activeIframes = new Set();
const loadRejectors = new Map(); // iframe -> reject(), only while waiting for 'load'
let generation = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireSlot() {
  if (activeCount < MAX_CONCURRENT_IFRAMES) {
    activeCount += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

/** Hands the slot straight to the next waiter, or frees it if none is queued. */
function releaseSlot() {
  const next = waitQueue.shift();
  if (next) next();
  else activeCount = Math.max(0, activeCount - 1);
}

function teardown(iframe) {
  activeIframes.delete(iframe);
  try {
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
  } catch { /* best-effort cleanup only */ }
}

const aborted = () => ({ status: 'aborted', fullAddress: '', via: 'none', error: null });
const failed = (err) => ({ status: 'failed', fullAddress: '', via: 'none', error: String((err && err.message) || err) });

/**
 * Immediately tear down every active iframe and unblock every waiter —
 * called when the user presses Stop. Bumping `generation` means any call
 * already in flight sees the mismatch on its very next check and reports
 * itself 'aborted' instead of finishing normally or hanging.
 */
export function abortAll() {
  generation += 1;

  for (const [iframe, reject] of loadRejectors) {
    try { reject(new Error('aborted')); } catch { /* the catch below handles it */ }
  }
  loadRejectors.clear();

  for (const iframe of [...activeIframes]) teardown(iframe);

  activeCount = 0;
  while (waitQueue.length) waitQueue.shift()();
}

/**
 * Resolve one place's Full Address by rendering it in a hidden, same-origin
 * iframe and reading the same DOM element the live app itself uses.
 *
 * @param {string} url
 * @param {object} opts  { timeoutMs }
 * @returns {{status:'resolved'|'notfound'|'failed'|'aborted', fullAddress:string, via:string, error:string|null}}
 */
export async function resolveFullAddressViaIframe(url, opts = {}) {
  const myGeneration = generation;
  const timeoutMs = Number(opts.timeoutMs) || IFRAME_TIMEOUT_MS;

  await acquireSlot();
  if (myGeneration !== generation) { releaseSlot(); return aborted(); }

  let iframe = null;
  try {
    iframe = document.createElement('iframe');
    // Off-screen and invisible, but NOT display:none — some browsers
    // deprioritize or suspend script execution inside display:none
    // iframes, which would silently break rendering.
    iframe.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:1px; height:1px; border:0; visibility:hidden;';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    activeIframes.add(iframe);
    document.documentElement.appendChild(iframe);

    try {
      await new Promise((resolve, reject) => {
        loadRejectors.set(iframe, reject);
        const onLoad = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('iframe "error" event — network-level load failure')); };
        const cleanup = () => {
          loadRejectors.delete(iframe);
          iframe.removeEventListener('load', onLoad);
          iframe.removeEventListener('error', onError);
        };
        iframe.addEventListener('load', onLoad, { once: true });
        iframe.addEventListener('error', onError, { once: true });
        iframe.src = url;
      });
    } catch (err) {
      return myGeneration !== generation ? aborted() : failed(err);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (myGeneration !== generation) return aborted();

      let doc;
      try {
        doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      } catch (err) {
        return failed(`same-origin access error: ${String((err && err.message) || err)}`);
      }

      if (doc) {
        // The SAME extractor place-detail.js uses for the DOM path — no
        // separate selector or validation logic duplicated here.
        const found = placeDetail.extractAddress(doc);
        if (found && found.value && V.isPlausibleFullAddress(found.value)) {
          return { status: 'resolved', fullAddress: found.value, via: `iframe:${found.via}`, error: null };
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return myGeneration !== generation ? aborted() : { status: 'notfound', fullAddress: '', via: 'none', error: null };
  } catch (err) {
    return myGeneration !== generation ? aborted() : failed(err);
  } finally {
    if (iframe) teardown(iframe);
    releaseSlot();
  }
}
