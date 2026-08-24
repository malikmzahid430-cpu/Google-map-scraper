/**
 * MV3 service worker entry point.
 *
 * The worker is stateless by design: it is evicted after a short idle period,
 * so every piece of durable state lives in chrome.storage. On wake-up it
 * simply re-registers its listeners and carries on.
 */
import { MSG, APP_VERSION, DEFAULT_SETTINGS } from '../core/constants.js';
import { listen } from '../core/bus.js';
import { createLogger } from '../core/logger.js';
import * as store from '../core/storage.js';
import { handlers, onMapsTabReady } from './router.js';

const log = createLogger('worker');

/* ------------------------------------------------------------------ *
 * Message routing. Registered at top level so it is live the instant the
 * worker wakes, before any await — otherwise an early message is dropped.
 * ------------------------------------------------------------------ */
listen(handlers);

/* ------------------------------------------------------------------ *
 * Side panel
 * ------------------------------------------------------------------ */
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => log.warn('setPanelBehavior failed', err));
} catch (err) {
  log.warn('sidePanel API unavailable', err);
}

chrome.action.onClicked.addListener(async (tab) => {
  // Fires only if openPanelOnActionClick could not be set.
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    log.warn('could not open side panel', err);
  }
});

/* ------------------------------------------------------------------ *
 * Install / update
 * ------------------------------------------------------------------ */
chrome.runtime.onInstalled.addListener(async (details) => {
  log.info(`installed (${details.reason}) v${APP_VERSION}`);
  const existing = await store.get('aq.settings', null);
  if (!existing) await store.saveSettings(DEFAULT_SETTINGS);
});

/* ------------------------------------------------------------------ *
 * Tab lifecycle — drives the search queue.
 * ------------------------------------------------------------------ */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !/^https:\/\/(www\.)?(maps\.)?google\.[^/]+\/maps/.test(tab.url)) return;

  // Give Maps a moment to render its results feed before we ask to collect.
  setTimeout(() => {
    onMapsTabReady(tabId).catch((err) => log.warn('queue step failed', err));
  }, 2500);
});

/* ------------------------------------------------------------------ *
 * Keep-alive during an active run.
 *
 * MV3 evicts an idle worker after ~30s. An alarm keeps it warm while a job is
 * running so progress messages are never dropped. Chrome's documented floor
 * for a packed extension's periodInMinutes is 1 — a shorter period is
 * silently clamped up to 1 anyway, so asking for 0.5 bought nothing and just
 * misstated the real cadence. The alarm is cheap and stops mattering as soon
 * as the job ends.
 * ------------------------------------------------------------------ */
const KEEPALIVE = 'aq.keepalive';

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE) return;
  // Touching storage is enough to reset the idle timer.
  store.get('aq.tick', 0).catch(() => {});
});

try {
  chrome.alarms.create(KEEPALIVE, { periodInMinutes: 1 });
} catch (err) {
  log.warn('alarms unavailable', err);
}

log.info(`Al-Aqsa Scraper service worker ready (v${APP_VERSION})`);
