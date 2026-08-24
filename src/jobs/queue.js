/**
 * Search queue — runs several searches one at a time.
 *
 * The queue is a persisted list of items with their own status. It only ever
 * advances when the previous job has reached a terminal state, so two
 * collections can never overlap.
 */
import { SK, JOB_STATUS } from '../core/constants.js';
import * as store from '../core/storage.js';

/**
 * Queue item lifecycle.
 *
 * LOADING and SCRAPING are distinct on purpose: "nothing is happening yet"
 * during a Maps page load looks identical to a stall unless the UI can say
 * which one it is.
 */
export const QUEUE_ITEM = {
  PENDING: 'pending',
  LOADING: 'loading',     // the Maps tab is navigating to this search
  SCRAPING: 'scraping',   // the collector is running on it
  DONE: 'done',
  PAUSED: 'paused',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** Statuses that mean this item still occupies the queue's single slot. */
export const ACTIVE_STATES = [QUEUE_ITEM.LOADING, QUEUE_ITEM.SCRAPING, QUEUE_ITEM.PAUSED];

export function blankQueue() {
  return { running: false, currentIndex: -1, items: [] };
}

export async function getQueue() {
  return (await store.get(SK.QUEUE, null)) || blankQueue();
}

export async function saveQueue(q) {
  await store.set(SK.QUEUE, q);
  return q;
}

export function makeItem(query, location = '') {
  return {
    id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    query: String(query || '').trim(),
    location: String(location || '').trim(),
    status: QUEUE_ITEM.PENDING,
    jobId: null,
    count: 0,
    error: null,
    startedAt: null,
    endedAt: null,
  };
}

/**
 * Parse pasted lines into queue items.
 * Accepted separators between query and location: " — ", " - ", " | ", ", " last comma.
 */
export function parseQueueText(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let query = line;
      let location = '';
      const m = line.match(/^(.*?)\s+(?:—|–|-{1,2}|\|)\s+(.*)$/);
      if (m) {
        query = m[1].trim();
        location = m[2].trim();
      }
      return makeItem(query, location);
    });
}

/** Build the Google Maps search URL for an item. */
export function itemSearchUrl(item) {
  const term = [item.query, item.location].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/${encodeURIComponent(term)}?hl=en`;
}

export function isTerminal(status) {
  return [JOB_STATUS.COMPLETED, JOB_STATUS.STOPPED, JOB_STATUS.ERROR].includes(status);
}

/** Is any item mid-flight? The next search must not start while this is true. */
export function hasActiveItem(queue) {
  return (queue.items || []).some((i) => ACTIVE_STATES.includes(i.status));
}

/** Progress summary for the UI: "2 / 4 — Orlando Roofing". */
export function queueProgress(queue) {
  const items = (queue && queue.items) || [];
  const finished = items.filter((i) => [QUEUE_ITEM.DONE, QUEUE_ITEM.FAILED, QUEUE_ITEM.SKIPPED].includes(i.status)).length;
  const current = items.find((i) => ACTIVE_STATES.includes(i.status)) || null;
  return {
    total: items.length,
    finished,
    position: current ? items.indexOf(current) + 1 : finished,
    current,
    collected: items.reduce((n, i) => n + (i.count || 0), 0),
  };
}

export async function nextPendingIndex() {
  const q = await getQueue();
  return q.items.findIndex((i) => i.status === QUEUE_ITEM.PENDING);
}
