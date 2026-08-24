/**
 * Content script bootstrap.
 *
 * Chrome's `content_scripts` manifest entry cannot load an ES module directly,
 * so this classic script dynamic-imports the real entry point. That is what
 * lets the whole extension be modular with NO build step.
 *
 * It is deliberately tiny and has no dependencies: if the module graph fails to
 * load, this still runs and reports the failure instead of dying silently.
 */
(async () => {
  try {
    const url = chrome.runtime.getURL('src/collector/index.js');
    await import(url);
  } catch (err) {
    console.error('[Al-Aqsa Scraper] content module failed to load:', err);
    try {
      chrome.runtime.sendMessage({
        type: 'collect:progress',
        payload: { status: 'error', note: `Content module failed to load: ${err && err.message}` },
      });
    } catch { /* the worker may not be up yet — nothing more we can do here */ }
  }
})();
