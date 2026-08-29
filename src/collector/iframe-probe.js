/**
 * TEMPORARY diagnostic probe — proof of concept only, NOT part of the
 * production Full Address resolver (place-detail.js / detail-parser.js are
 * untouched by this file and never import it).
 *
 * Question this answers: `fetch()` + `DOMParser` can never see
 * `[data-item-id="address"]` because DOMParser does not execute
 * JavaScript, and that element is only constructed by Google Maps' own
 * client-side rendering — confirmed by a live "View Source" test showing
 * the raw HTML response has no trace of it. Can a hidden, same-origin
 * `<iframe>` injected into the existing Maps tab (no new browser tab, no
 * `chrome.tabs.create`) actually render the page and expose that same
 * element? This module creates exactly one such iframe, waits for the
 * element, extracts it, tears the iframe down, and reports precisely what
 * happened at each step — success, blocked, timeout, or error — so that
 * can be judged on real evidence before any bulk resolver work begins.
 */

const ADDRESS_SELECTOR = '[data-item-id="address"]';
const DEFAULT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function teardown(iframe) {
  try {
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
  } catch { /* best-effort cleanup only */ }
}

/**
 * @param {string} url        a real Google Maps place URL
 * @param {object} opts       { timeoutMs }
 * @returns {object} a full report — see the field comments below
 */
export async function runIframeAddressProbe(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const report = {
    url,
    iframeCreated: false,
    iframeLoaded: false,
    elementFound: false,
    address: '',
    fullAddress: '',
    seconds: 0,
    result: 'ERROR',   // SUCCESS | BLOCKED | TIMEOUT | ERROR
    reason: '',
  };

  const finish = () => { report.seconds = Math.round((Date.now() - startedAt) / 100) / 10; return report; };

  let iframe;
  try {
    iframe = document.createElement('iframe');
    // Off-screen and invisible, but NOT display:none — some browsers
    // deprioritize or suspend script execution inside display:none
    // iframes, which would silently invalidate this exact test.
    iframe.style.cssText = 'position:fixed; top:-9999px; left:-9999px; width:1px; height:1px; border:0; visibility:hidden;';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    document.documentElement.appendChild(iframe);
    report.iframeCreated = true;
  } catch (err) {
    report.reason = `iframe creation failed: ${String((err && err.message) || err)}`;
    return finish();
  }

  try {
    await new Promise((resolve, reject) => {
      const onLoad = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('iframe "error" event — network-level load failure')); };
      const cleanup = () => {
        iframe.removeEventListener('load', onLoad);
        iframe.removeEventListener('error', onError);
      };
      iframe.addEventListener('load', onLoad, { once: true });
      iframe.addEventListener('error', onError, { once: true });
      iframe.src = url;
    });
    report.iframeLoaded = true;
  } catch (err) {
    report.result = 'ERROR';
    report.reason = String((err && err.message) || err);
    teardown(iframe);
    return finish();
  }

  // Poll the iframe's own document for the rendered node. This also serves
  // as the same-origin access check: if Google ever blocked the embed at
  // the browser level (X-Frame-Options / CSP frame-ancestors), Chrome does
  // not reliably fire a JS-observable "error" event for that — the frame
  // just loads empty — so a same-origin access exception here, or running
  // out the clock with the frame staying empty, are both treated as real
  // outcomes rather than assumed successes.
  const deadline = Date.now() + timeoutMs;
  let el = null;
  while (Date.now() < deadline) {
    let doc;
    try {
      doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
    } catch (err) {
      report.result = 'BLOCKED';
      report.reason = `same-origin access error: ${String((err && err.message) || err)}`;
      teardown(iframe);
      return finish();
    }
    if (!doc) {
      report.result = 'BLOCKED';
      report.reason = 'same-origin access error: contentDocument unavailable';
      teardown(iframe);
      return finish();
    }
    try {
      el = doc.querySelector(ADDRESS_SELECTOR);
    } catch (err) {
      report.result = 'ERROR';
      report.reason = `querySelector failed: ${String((err && err.message) || err)}`;
      teardown(iframe);
      return finish();
    }
    if (el) break;
    await sleep(POLL_INTERVAL_MS);
  }

  if (!el) {
    report.result = 'TIMEOUT';
    report.reason = `[data-item-id="address"] never appeared within ${timeoutMs}ms — either Google's frame-embedding policy silently blocked the iframe (loads empty, no JS-observable error), or the page needs longer to render than this test waited`;
    teardown(iframe);
    return finish();
  }

  report.elementFound = true;
  const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
  const text = (el.textContent || '').trim();
  const value = (aria || text).trim();

  report.fullAddress = value;
  report.address = value ? value.split(',')[0].trim() : '';
  if (value) {
    report.result = 'SUCCESS';
  } else {
    report.result = 'ERROR';
    report.reason = 'element found but had no aria-label and no textContent';
  }

  teardown(iframe);
  return finish();
}
