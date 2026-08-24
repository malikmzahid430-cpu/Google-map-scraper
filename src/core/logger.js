/**
 * Leveled logger with a bounded in-memory ring buffer.
 * The buffer is what the Diagnostics view reads; it is capped so a long run
 * cannot grow memory without bound.
 */
import { APP_NAME } from './constants.js';

const MAX_ENTRIES = 400;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel = LEVELS.info;
const ring = [];
const listeners = new Set();

export function setLogLevel(name) {
  if (LEVELS[name] != null) minLevel = LEVELS[name];
}

export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLogEntries() {
  return ring.slice();
}

export function clearLog() {
  ring.length = 0;
}

function push(level, scope, message, detail) {
  const entry = {
    t: Date.now(),
    level,
    scope,
    message: String(message),
    detail: detail === undefined ? null : safeDetail(detail),
  };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES);
  for (const fn of listeners) {
    try { fn(entry); } catch { /* a listener must never break logging */ }
  }
  if (LEVELS[level] >= minLevel && typeof console !== 'undefined') {
    const fn = console[level] || console.log;
    fn.call(console, `[${APP_NAME}/${scope}]`, message, detail === undefined ? '' : detail);
  }
}

function safeDetail(d) {
  if (d instanceof Error) return `${d.name}: ${d.message}`;
  if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') return d;
  try {
    const s = JSON.stringify(d);
    return s && s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return String(d);
  }
}

/** Create a scoped logger, e.g. `const log = createLogger('collector')`. */
export function createLogger(scope) {
  return {
    debug: (m, d) => push('debug', scope, m, d),
    info: (m, d) => push('info', scope, m, d),
    warn: (m, d) => push('warn', scope, m, d),
    error: (m, d) => push('error', scope, m, d),
  };
}
