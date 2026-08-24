/**
 * Duplicate Detection Engine.
 *
 * ============================================================================
 * THIS NEVER RUNS INSIDE THE COLLECT LOOP.
 * ============================================================================
 * It is a separate stage over already-stored records, triggered by the
 * REMOVE DUPLICATES button. The collector's own in-run guard is a plain Set
 * lookup on the place URL — O(1), no fuzzy matching, no cost per card.
 *
 * Matching hierarchy, strongest first:
 *   1. Google Maps place URL   (exact, viewport-stripped)
 *   2. Place ID                (exact)
 *   3. Business name + full address
 *   4. Business name + phone
 *
 * Deliberately conservative: name alone is NEVER enough. Two genuinely
 * different branches of "ABC Roofing" at different addresses stay as two
 * records.
 */
import { businessNameKey, phoneKey, addressKey } from './normalize.js';

export const STRATEGY = {
  URL: 'maps-url',
  PLACE_ID: 'place-id',
  NAME_ADDRESS: 'name+address',
  NAME_PHONE: 'name+phone',
};

/** Last 10 digits — makes "+1 904-516-4279" and "(904) 516-4279" comparable. */
function phoneTail(phone) {
  const k = phoneKey(phone);
  if (!k) return '';
  return k.length > 10 ? k.slice(-10) : k;
}

/** Build the ordered key list for one record. Empty keys are skipped. */
export function buildKeys(record) {
  const name = businessNameKey(record.businessName);
  const addr = addressKey(record.fullAddress || record.address);
  const tail = phoneTail(record.phone);
  const url = record.dedupeUrl || record.mapsUrl || '';
  const pid = record.placeId || '';

  const keys = [];
  if (url) keys.push({ strategy: STRATEGY.URL, key: `u:${url}` });
  if (pid) keys.push({ strategy: STRATEGY.PLACE_ID, key: `p:${pid}` });
  // Composite keys require BOTH halves — a blank address must never make two
  // same-named businesses collide.
  if (name && addr) keys.push({ strategy: STRATEGY.NAME_ADDRESS, key: `na:${name}|${addr}` });
  if (name && tail) keys.push({ strategy: STRATEGY.NAME_PHONE, key: `np:${name}|${tail}` });
  return keys;
}

/**
 * Score a record's completeness. When two records are duplicates we keep the
 * richer one rather than whichever happened to be collected first.
 */
export function completeness(record) {
  let n = 0;
  for (const f of ['fullAddress', 'phone', 'website', 'email', 'category',
    'rating', 'reviewCount', 'latitude', 'facebook', 'instagram', 'linkedin']) {
    if (record[f]) n++;
  }
  return n;
}

/**
 * Find duplicates.
 * @returns {{ kept: object[], removed: object[], groups: object[], stats: object }}
 */
export function findDuplicates(records) {
  const index = new Map();          // key -> representative index
  const groupOf = new Map();        // record index -> group id
  const groups = [];                // [{ id, strategy, members: [idx] }]

  records.forEach((record, i) => {
    const keys = buildKeys(record);
    let matchedGroup = null;
    let matchedStrategy = null;

    for (const { strategy, key } of keys) {
      if (index.has(key)) {
        matchedGroup = index.get(key);
        matchedStrategy = strategy;
        break;                       // first (strongest) match wins
      }
    }

    if (matchedGroup == null) {
      const id = groups.length;
      groups.push({ id, strategy: null, members: [i] });
      groupOf.set(i, id);
      for (const { key } of keys) if (!index.has(key)) index.set(key, id);
    } else {
      groups[matchedGroup].members.push(i);
      if (!groups[matchedGroup].strategy) groups[matchedGroup].strategy = matchedStrategy;
      groupOf.set(i, matchedGroup);
      // Register this record's keys against the same group so a third record
      // matching on a different key still lands here.
      for (const { key } of keys) if (!index.has(key)) index.set(key, matchedGroup);
    }
  });

  const kept = [];
  const removed = [];
  const byStrategy = {};

  for (const group of groups) {
    if (group.members.length === 1) {
      kept.push(records[group.members[0]]);
      continue;
    }
    // Keep the most complete member; merge missing fields from the others so
    // deduplication adds information instead of losing it.
    const sorted = group.members
      .map((i) => ({ i, r: records[i], c: completeness(records[i]) }))
      .sort((a, b) => b.c - a.c || a.i - b.i);

    const winner = { ...sorted[0].r };
    for (const { r } of sorted.slice(1)) {
      for (const [k, v] of Object.entries(r)) {
        if (v && !winner[k] && k !== 'raw' && k !== 'keys') winner[k] = v;
      }
    }
    winner.duplicatesMerged = group.members.length - 1;
    winner.duplicateStrategy = group.strategy;
    kept.push(winner);

    for (const { r } of sorted.slice(1)) {
      removed.push({ ...r, duplicateOf: winner.id || winner.mapsUrl, duplicateStrategy: group.strategy });
    }
    byStrategy[group.strategy] = (byStrategy[group.strategy] || 0) + group.members.length - 1;
  }

  return {
    kept,
    removed,
    groups: groups.filter((g) => g.members.length > 1),
    stats: {
      before: records.length,
      removed: removed.length,
      after: kept.length,
      byStrategy,
    },
  };
}

/** Convenience wrapper used by the Dedupe button. */
export function removeDuplicates(records) {
  const result = findDuplicates(records || []);
  return { records: result.kept, stats: result.stats, removed: result.removed };
}
