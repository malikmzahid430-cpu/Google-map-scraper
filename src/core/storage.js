/**
 * Storage layer.
 *
 * Source of truth for all job state. An MV3 service worker is evicted after a
 * short idle period, so nothing durable may live in a module variable.
 *
 * Records are sharded into fixed-size chunks. Appending during a long run then
 * rewrites one small chunk instead of the whole result set, which is what keeps
 * flushes cheap at a few thousand records.
 */
import { SK } from './constants.js';

const CHUNK_SIZE = 200;

/* ------------------------------------------------------------------ *
 * Backend. Real chrome.storage when available, an in-memory map in Node
 * so the pure-logic modules stay unit-testable.
 * ------------------------------------------------------------------ */
const memory = new Map();

const hasChrome =
  typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

const backend = hasChrome
  ? {
      async get(keys) {
        return await chrome.storage.local.get(keys);
      },
      async set(obj) {
        return await chrome.storage.local.set(obj);
      },
      async remove(keys) {
        return await chrome.storage.local.remove(keys);
      },
    }
  : {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (memory.has(k)) out[k] = memory.get(k);
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) memory.set(k, v);
      },
      async remove(keys) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) memory.delete(k);
      },
    };

export async function get(key, fallback = null) {
  const res = await backend.get([key]);
  return res && key in res && res[key] !== undefined ? res[key] : fallback;
}

export async function set(key, value) {
  await backend.set({ [key]: value });
  return value;
}

export async function setMany(obj) {
  await backend.set(obj);
}

export async function remove(keys) {
  await backend.remove(keys);
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */
export async function getSettings(defaults) {
  const stored = await get(SK.SETTINGS, null);
  return deepMerge(defaults, stored || {});
}

export async function saveSettings(settings) {
  await set(SK.SETTINGS, settings);
  return settings;
}

function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override.slice() : base.slice();
  if (base && typeof base === 'object') {
    const out = {};
    for (const k of Object.keys(base)) {
      out[k] = k in (override || {}) ? deepMerge(base[k], override[k]) : base[k];
    }
    // keep keys present only in the stored object (forward compatible)
    for (const k of Object.keys(override || {})) if (!(k in out)) out[k] = override[k];
    return out;
  }
  return override === undefined ? base : override;
}

/* ------------------------------------------------------------------ *
 * Sharded record store
 * ------------------------------------------------------------------ */
const metaKey = (jobId) => `${SK.RECORDS(jobId)}.meta`;
const chunkKey = (jobId, i) => `${SK.RECORDS(jobId)}.${i}`;

async function readMeta(jobId) {
  return (await get(metaKey(jobId), null)) || { chunks: 0, count: 0 };
}

/** Append records to a job. Returns the new total count. */
export async function appendRecords(jobId, records) {
  if (!records || records.length === 0) return (await readMeta(jobId)).count;
  const meta = await readMeta(jobId);
  const writes = {};

  let index = meta.chunks === 0 ? 0 : meta.chunks - 1;
  let current = meta.chunks === 0 ? [] : (await get(chunkKey(jobId, index), []) || []);

  for (const rec of records) {
    if (current.length >= CHUNK_SIZE) {
      writes[chunkKey(jobId, index)] = current;
      index += 1;
      current = [];
    }
    current.push(rec);
    meta.count += 1;
  }
  writes[chunkKey(jobId, index)] = current;
  meta.chunks = index + 1;
  writes[metaKey(jobId)] = meta;

  await setMany(writes);
  return meta.count;
}

/** Read every record for a job, in insertion order. */
export async function readRecords(jobId) {
  const meta = await readMeta(jobId);
  if (!meta.chunks) return [];
  const keys = Array.from({ length: meta.chunks }, (_, i) => chunkKey(jobId, i));
  const res = await backend.get(keys);
  const out = [];
  for (const k of keys) {
    const chunk = res[k];
    if (Array.isArray(chunk)) out.push(...chunk);
  }
  return out;
}

export async function countRecords(jobId) {
  return (await readMeta(jobId)).count;
}

/** Replace the whole record set for a job (used after dedupe / scoring). */
export async function writeRecords(jobId, records) {
  const old = await readMeta(jobId);
  const oldKeys = Array.from({ length: old.chunks }, (_, i) => chunkKey(jobId, i));
  if (oldKeys.length) await remove(oldKeys);

  const writes = {};
  let chunks = 0;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    writes[chunkKey(jobId, chunks)] = records.slice(i, i + CHUNK_SIZE);
    chunks += 1;
  }
  writes[metaKey(jobId)] = { chunks, count: records.length };
  await setMany(writes);
  return records.length;
}

export async function dropRecords(jobId) {
  const meta = await readMeta(jobId);
  const keys = Array.from({ length: meta.chunks }, (_, i) => chunkKey(jobId, i));
  keys.push(metaKey(jobId));
  await remove(keys);
}

/** Test hook — clears the in-memory backend. No effect under chrome.storage. */
export function __resetMemory() {
  memory.clear();
}
