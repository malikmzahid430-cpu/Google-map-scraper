/**
 * Failure isolation primitives.
 *
 * The contract of this module: nothing wrapped by `safeCall` can ever throw
 * into its caller. Optional features are always invoked through it, which is
 * what keeps a broken enrichment module from taking down collection.
 */

/** Thrown internally by withTimeout; never escapes safeCall. */
export class TimeoutError extends Error {
  constructor(ms, label) {
    super(`${label || 'operation'} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Race a promise against a timer. The timer is always cleared, so a resolved
 * promise cannot leave a dangling handle (a memory-leak source in v1).
 */
export function withTimeout(promiseFactory, ms, label) {
  if (!ms || ms <= 0) return Promise.resolve(promiseFactory());
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    Promise.resolve()
      .then(promiseFactory)
      .then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Run `fn`, absorbing every failure mode.
 *
 * @param {string}   moduleName  name reported to diagnostics on failure
 * @param {Function} fn          the operation
 * @param {object}   opts
 * @param {number}   opts.timeout   ms, 0 to disable
 * @param {number}   opts.retries   extra attempts after the first
 * @param {number}   opts.backoffMs base delay between attempts
 * @param {*}        opts.fallback  value returned when every attempt fails
 * @param {Function} opts.onError   optional (err, moduleName) sink
 * @returns {Promise<{ok: boolean, value: *, error: string|null, attempts: number}>}
 */
export async function safeCall(moduleName, fn, opts = {}) {
  const {
    timeout = 0,
    retries = 0,
    backoffMs = 400,
    fallback = null,
    onError = null,
  } = opts;

  let lastError = null;
  const total = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      const value = await withTimeout(fn, timeout, moduleName);
      return { ok: true, value, error: null, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < total) {
        // Linear backoff. Deliberately not exponential: enrichment runs
        // against many hosts and we would rather move on than stall.
        await sleep(backoffMs * attempt);
      }
    }
  }

  const message = describeError(lastError);
  if (typeof onError === 'function') {
    try { onError(lastError, moduleName); } catch { /* sink must never throw */ }
  }
  return { ok: false, value: fallback, error: message, attempts: total };
}

/** Synchronous variant for parsers, which must never break a collect loop. */
export function safeSync(moduleName, fn, fallback = null, onError = null) {
  try {
    return { ok: true, value: fn(), error: null };
  } catch (err) {
    if (typeof onError === 'function') {
      try { onError(err, moduleName); } catch { /* ignore */ }
    }
    return { ok: false, value: fallback, error: describeError(err) };
  }
}

export function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Bounded-concurrency map. Used by the detail resolver and the enrichment
 * queue so neither can open an unbounded number of sockets.
 */
export async function mapLimit(items, limit, worker, shouldAbort) {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(limit | 0 || 1, 16));
  let cursor = 0;

  async function runner() {
    for (;;) {
      if (typeof shouldAbort === 'function' && shouldAbort()) return;
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { __error: describeError(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
  return results;
}

/** Collapse rapid calls into one trailing call. Used for storage flushes. */
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => {
    if (t) { clearTimeout(t); t = null; }
    fn(...args);
  };
  wrapped.cancel = () => { if (t) { clearTimeout(t); t = null; } };
  return wrapped;
}
