/**
 * DOM helpers for the Google Maps results page.
 * Every function here is defensive: a missing element returns null, never throws.
 */
import * as S from './selectors.js';
import { sleep } from '../core/safe.js';

/** First element matching any selector in an ordered list. */
export function queryFirst(selectorList, root = document) {
  for (const sel of selectorList) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      // `:has()` is unsupported on old Chrome — skip that selector, keep going.
    }
  }
  return null;
}

/** All elements for the first selector in the list that matches anything. */
export function queryAllFirstMatch(selectorList, root = document) {
  for (const sel of selectorList) {
    try {
      const list = root.querySelectorAll(sel);
      if (list && list.length) return Array.from(list);
    } catch {
      /* unsupported selector */
    }
  }
  return [];
}

export function text(el) {
  if (!el) return '';
  return (el.innerText || el.textContent || '').trim();
}

export function attr(el, name) {
  if (!el) return '';
  const v = el.getAttribute(name);
  return v == null ? '' : v.trim();
}

/** Poll for an element. Resolves null on timeout rather than rejecting. */
export async function waitFor(selectorList, timeoutMs = 12000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = queryFirst(selectorList);
    if (el) return el;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------------ *
 * Page / feed detection
 * ------------------------------------------------------------------ */

export function isMapsSearchPage() {
  const href = location.href;
  return /\/maps\/(search|place)\//.test(href) || !!queryFirst(S.FEED);
}

export function getFeed() {
  return queryFirst(S.FEED);
}

/**
 * The scrollable container. Usually the feed itself, but on some Maps
 * rollouts the scroll happens on an ancestor with a tabindex.
 */
export function getScrollContainer() {
  const feed = getFeed();
  if (!feed) return null;
  if (feed.scrollHeight > feed.clientHeight + 4) return feed;
  let node = feed.parentElement;
  for (let i = 0; i < 5 && node; i++) {
    if (node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  return feed;
}

/**
 * Business cards currently in the feed.
 * Filters out Maps chrome (headers, the end-of-list sentinel, spacers) by
 * requiring a place link — the one thing every real card has.
 */
export function getCards() {
  const feed = getFeed();
  if (!feed) return [];

  let cards = queryAllFirstMatch(S.CARD, feed);
  if (!cards.length) {
    // Last resort: derive cards from their place links.
    const links = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    cards = links.map((a) => a.closest('div[jsaction]') || a.parentElement).filter(Boolean);
  }

  const seen = new Set();
  return cards.filter((el) => {
    if (!el || seen.has(el)) return false;
    seen.add(el);
    return !!queryFirst(S.CARD_LINK, el);
  });
}

export function feedReachedEnd() {
  const feed = getFeed();
  if (!feed) return false;
  const tail = (feed.innerText || '').slice(-400).toLowerCase();
  return S.END_OF_LIST_TEXT.some((t) => tail.includes(t));
}

export function getSearchQuery() {
  const input = queryFirst(S.SEARCH_INPUT);
  if (input && input.value) return input.value.trim();
  const m = location.pathname.match(/\/maps\/search\/([^/]+)/);
  if (m) {
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
  }
  return '';
}

/**
 * A snapshot of everything that tells us whether the feed can still grow.
 * The collector compares successive snapshots instead of trusting any single
 * signal, because Maps routinely pauses before loading the next batch.
 */
export function feedMetrics() {
  const container = getScrollContainer();
  const cards = getCards();
  if (!container) {
    return { cards: cards.length, scrollTop: 0, scrollHeight: 0, clientHeight: 0, atBottom: false, endText: false, loading: false };
  }
  const scrollTop = container.scrollTop || 0;
  const scrollHeight = container.scrollHeight || 0;
  const clientHeight = container.clientHeight || 0;
  return {
    cards: cards.length,
    scrollTop,
    scrollHeight,
    clientHeight,
    atBottom: scrollHeight > 0 && scrollTop + clientHeight >= scrollHeight - 24,
    endText: feedReachedEnd(),
    loading: isFeedLoading(),
  };
}

/**
 * Is Maps currently fetching the next batch? Used to wait rather than declare
 * the end of the list — the single biggest cause of short runs in v2.
 */
export function isFeedLoading() {
  const feed = getFeed();
  if (!feed) return false;
  const selectors = [
    '[role="feed"] [role="progressbar"]',
    '[role="feed"] .Mznamd',           // brittle: spinner container
    '[role="progressbar"]',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.isConnected) return true;
    } catch { /* unsupported selector */ }
  }
  return false;
}

/**
 * Advance the feed by ONE BOUNDED STEP.
 *
 * This deliberately does not jump straight to `scrollHeight`. Maps virtualizes
 * the list: if the scroll position moves further than the rendered window is
 * tall, cards can mount and unmount between two scans and never be read. A
 * bounded step keeps the movement smaller than the rendered window, so every
 * card passes through at least one scan.
 *
 * Exactly one write to `scrollTop` per call, for the same reason — two writes
 * meant two window advances against a single scan.
 *
 * It decides nothing about the end of the list; that judgement belongs to the
 * collector, which compares successive feedMetrics() snapshots.
 */
export async function scrollFeed(opts = {}) {
  const { settleMs = 700, viewports = 1.5 } = opts;
  const container = getScrollContainer();
  if (!container) return false;

  try {
    const height = container.clientHeight || 600;
    const step = Math.max(320, Math.floor(height * viewports));
    const max = container.scrollHeight || 0;
    const current = container.scrollTop || 0;
    const atBottom = max > 0 && current + height >= max - 24;

    // At the bottom there is nothing left to traverse, so ask Maps to load
    // more by pinning to the very end. Otherwise take one bounded step.
    container.scrollTop = atBottom ? max : Math.min(current + step, max);
  } catch {
    return false;
  }

  await sleep(settleMs);
  return true;
}
