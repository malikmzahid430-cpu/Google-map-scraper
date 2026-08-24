/**
 * Message bus.
 *
 * One envelope shape for every cross-context message:
 *     { type, payload }            request
 *     { ok, data } | { ok:false, error }   response
 *
 * A handler that throws is converted into an error envelope. An unknown type
 * returns an error envelope. Neither case can leave a sender hanging, which is
 * what previously turned one bad message into a dead Start button.
 */
import { describeError } from './safe.js';
import { createLogger } from './logger.js';

const log = createLogger('bus');

export function ok(data = null) {
  return { ok: true, data, error: null };
}

export function fail(error) {
  return { ok: false, data: null, error: describeError(error) };
}

/** Send to the service worker. Never rejects. */
export async function send(type, payload = null) {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      return fail('chrome.runtime unavailable');
    }
    const res = await chrome.runtime.sendMessage({ type, payload });
    if (res === undefined) {
      // Happens when no listener replied (e.g. worker still spinning up).
      return fail(`no response for ${type}`);
    }
    return res;
  } catch (err) {
    return fail(err);
  }
}

/** Send to a specific tab's content script. Never rejects. */
export async function sendToTab(tabId, type, payload = null) {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) {
      return fail('chrome.tabs unavailable');
    }
    const res = await chrome.tabs.sendMessage(tabId, { type, payload });
    if (res === undefined) return fail(`no response for ${type} from tab ${tabId}`);
    return res;
  } catch (err) {
    // Most common cause: no content script in that tab (not on Maps).
    return fail(err);
  }
}

/**
 * Register a handler table. Returns an unregister function.
 * Handlers may be sync or async and may throw freely.
 */
export function listen(handlers) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
    return () => {};
  }

  const listener = (message, sender, sendResponse) => {
    const type = message && message.type;
    const handler = type && handlers[type];

    if (!handler) {
      // Not ours — say so and let another listener answer.
      return false;
    }

    Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then((data) => sendResponse(data && data.ok !== undefined ? data : ok(data)))
      .catch((err) => {
        log.error(`handler ${type} threw`, err);
        sendResponse(fail(err));
      });

    return true; // keep the channel open for the async reply
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
