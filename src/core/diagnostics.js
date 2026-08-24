/**
 * Module health registry.
 *
 * Every module reports OK / DEGRADED / FAIL with a count and a human message.
 * The Diagnostics view renders this verbatim, so a partial failure is always
 * attributed to a named module instead of disappearing.
 */

export const HEALTH = { UNKNOWN: 'unknown', OK: 'ok', DEGRADED: 'degraded', FAIL: 'fail' };

export const MODULES = [
  'maps.page',
  'maps.feed',
  'maps.cards',
  'parser.card',
  'parser.rating',
  'parser.fullAddress',
  'parser.website',
  'parser.phone',
  'parser.geo',
  'enrich.website',
  'enrich.email',
  'enrich.social',
  'engine.dedupe',
  'engine.validate',
  'engine.score',
  'export.csv',
  'export.xlsx',
  'export.sheets',
  'auth.google',
  'storage',
];

const state = new Map();

function blank(name) {
  return { name, health: HEALTH.UNKNOWN, ok: 0, failed: 0, message: '', lastError: null, updatedAt: 0 };
}

export function reset() {
  state.clear();
}

function entry(name) {
  if (!state.has(name)) state.set(name, blank(name));
  return state.get(name);
}

export function reportOk(name, message = '', increment = 1) {
  const e = entry(name);
  e.ok += increment;
  e.updatedAt = Date.now();
  if (message) e.message = message;
  e.health = e.failed > 0 ? HEALTH.DEGRADED : HEALTH.OK;
  return e;
}

export function reportFail(name, error, message = '') {
  const e = entry(name);
  e.failed += 1;
  e.updatedAt = Date.now();
  e.lastError = typeof error === 'string' ? error : (error && error.message) || 'error';
  if (message) e.message = message;
  e.health = e.ok > 0 ? HEALTH.DEGRADED : HEALTH.FAIL;
  return e;
}

export function setHealth(name, health, message = '') {
  const e = entry(name);
  e.health = health;
  e.message = message;
  e.updatedAt = Date.now();
  return e;
}

export function snapshot() {
  return MODULES.map((name) => state.get(name) || blank(name));
}

/** Human sentence for a module, used by the Diagnostics list. */
export function describe(e) {
  if (e.health === HEALTH.OK) return e.message || `${e.ok} ok`;
  if (e.health === HEALTH.DEGRADED) {
    return e.message || `${e.ok} ok, ${e.failed} failed — ${e.lastError || 'see log'}`;
  }
  if (e.health === HEALTH.FAIL) return e.message || e.lastError || 'failed';
  return e.message || 'not exercised yet';
}

/** Bind diagnostics to safeCall's onError hook. */
export const errorSink = (err, moduleName) => reportFail(moduleName, err);
