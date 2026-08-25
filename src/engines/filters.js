/**
 * Filter engine.
 *
 * v2 offered 16 boolean predicates and nothing else — no rating threshold, no
 * review threshold, no category. v3 filters on a structured criteria object so
 * numeric ranges, dynamic category facets and location all combine with AND.
 *
 * Pure functions. A filter never mutates a record and never hides data because
 * of an internal error — a throwing predicate is treated as "no opinion".
 */
import * as V from '../collector/validators.js';
import { splitAddress } from '../collector/address.js';
import { SOCIAL_KEYS } from '../core/constants.js';

/** An empty criteria object. Every field is optional. */
export function blankCriteria() {
  return {
    search: '',
    ratingMin: null,
    ratingMax: null,
    reviewsMin: null,
    reviewsMax: null,
    categories: [],        // OR within categories, AND against everything else
    availability: [],      // ids from AVAILABILITY
    scoreMin: null,
    validation: [],        // 'Valid' | 'Partial' | 'Invalid'
    city: '',
    state: '',
    postalCode: '',
    country: '',
  };
}

/** Data-availability toggles. */
export const AVAILABILITY = [
  { id: 'hasWebsite', label: 'Has Website', test: (r) => !!r.website },
  { id: 'noWebsite', label: 'No Website', test: (r) => !r.website },
  { id: 'hasPhone', label: 'Has Phone', test: (r) => !!r.phone },
  { id: 'noPhone', label: 'No Phone', test: (r) => !r.phone },
  { id: 'hasAddress', label: 'Has Address', test: (r) => !!(r.address || r.fullAddress) },
  { id: 'noAddress', label: 'No Address', test: (r) => !(r.address || r.fullAddress) },
  { id: 'hasEmail', label: 'Has Email', test: (r) => !!r.email },
  { id: 'noEmail', label: 'No Email', test: (r) => !r.email },
  { id: 'hasFullAddress', label: 'Has Full Address', test: (r) => V.isPlausibleFullAddress(r.fullAddress) },
  { id: 'missingFullAddress', label: 'Missing Full Address', test: (r) => !V.isPlausibleFullAddress(r.fullAddress) },
  { id: 'hasFacebook', label: 'Has Facebook', test: (r) => !!r.facebook },
  { id: 'hasInstagram', label: 'Has Instagram', test: (r) => !!r.instagram },
  { id: 'hasLinkedin', label: 'Has LinkedIn', test: (r) => !!r.linkedin },
  { id: 'hasTiktok', label: 'Has TikTok', test: (r) => !!r.tiktok },
  { id: 'hasYoutube', label: 'Has YouTube', test: (r) => !!r.youtube },
  { id: 'hasAnySocial', label: 'Has Any Social', test: (r) => SOCIAL_KEYS.some((k) => !!r[k]) },
  { id: 'hasCoordinates', label: 'Has Coordinates', test: (r) => !!(r.latitude && r.longitude) },
];

const AVAILABILITY_BY_ID = new Map(AVAILABILITY.map((a) => [a.id, a]));

/* ------------------------------------------------------------------ *
 * Value readers
 * ------------------------------------------------------------------ */

function ratingOf(record) {
  const n = Number(record.rating);
  return Number.isFinite(n) ? n : null;
}

function reviewsOf(record) {
  const n = parseInt(String(record.reviewCount).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** Location components, using the stored ones when present. */
export function locationOf(record) {
  if (record.city || record.state || record.postalCode || record.country) {
    return {
      city: record.city || '',
      state: record.state || '',
      postalCode: record.postalCode || '',
      country: record.country || '',
    };
  }
  const c = splitAddress(record.fullAddress || record.address || '');
  return { city: c.city, state: c.state, postalCode: c.postalCode, country: c.country };
}

const contains = (haystack, needle) =>
  String(haystack || '').toLowerCase().includes(String(needle || '').trim().toLowerCase());

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** Does one record satisfy the criteria? Criteria left blank are ignored. */
export function matches(record, criteria) {
  const c = { ...blankCriteria(), ...(criteria || {}) };

  // --- rating ---
  if (c.ratingMin != null || c.ratingMax != null) {
    const v = ratingOf(record);
    if (v == null) return false;                       // filtering on rating excludes unrated
    if (c.ratingMin != null && v < c.ratingMin) return false;
    if (c.ratingMax != null && v > c.ratingMax) return false;
  }

  // --- reviews ---
  if (c.reviewsMin != null || c.reviewsMax != null) {
    const v = reviewsOf(record);
    if (v == null) return false;
    if (c.reviewsMin != null && v < c.reviewsMin) return false;
    if (c.reviewsMax != null && v > c.reviewsMax) return false;
  }

  // --- category (OR within the selection) ---
  if (c.categories && c.categories.length) {
    const cat = String(record.category || '').trim().toLowerCase();
    if (!c.categories.some((x) => String(x).trim().toLowerCase() === cat)) return false;
  }

  // --- availability (AND across the selection) ---
  for (const id of c.availability || []) {
    const f = AVAILABILITY_BY_ID.get(id);
    if (!f) continue;
    try { if (!f.test(record)) return false; } catch { /* a broken predicate never hides data */ }
  }

  // --- quality ---
  if (c.scoreMin != null) {
    const s = Number(record.leadScore);
    if (!Number.isFinite(s) || s < c.scoreMin) return false;
  }
  if (c.validation && c.validation.length) {
    const v = record.validationStatus || 'Unknown';
    if (!c.validation.includes(v)) return false;
  }

  // --- location ---
  if (c.city || c.state || c.postalCode || c.country) {
    const loc = locationOf(record);
    if (c.city && !contains(loc.city, c.city)) return false;
    if (c.state && !contains(loc.state, c.state)) return false;
    if (c.postalCode && !contains(loc.postalCode, c.postalCode)) return false;
    if (c.country && !contains(loc.country, c.country)) return false;
  }

  // --- free text ---
  if (c.search && c.search.trim()) {
    const q = c.search.trim().toLowerCase();
    const hay = ['businessName', 'category', 'fullAddress', 'address', 'website',
      'phone', 'email', 'searchQuery', 'searchLocation']
      .map((k) => String(record[k] || '')).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }

  return true;
}

export function applyCriteria(records, criteria) {
  const list = records || [];
  const c = criteria || blankCriteria();
  return list.filter((r) => {
    try { return matches(r, c); } catch { return true; }
  });
}

/* ------------------------------------------------------------------ *
 * Facets — built from the ACTUAL dataset, never hard-coded
 * ------------------------------------------------------------------ */

/** Category options with live counts, most common first. */
export function categoryFacets(records) {
  const counts = new Map();
  for (const r of records || []) {
    const cat = String(r.category || '').trim();
    if (!cat) continue;
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Location facets, also derived from the data. */
export function locationFacets(records) {
  const fields = { city: new Map(), state: new Map(), country: new Map() };
  for (const r of records || []) {
    const loc = locationOf(r);
    for (const key of Object.keys(fields)) {
      const v = String(loc[key] || '').trim();
      if (!v) continue;
      fields[key].set(v, (fields[key].get(v) || 0) + 1);
    }
  }
  const toList = (m) => [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 40);
  return { city: toList(fields.city), state: toList(fields.state), country: toList(fields.country) };
}

/** Rating / review ranges present in the data, for sensible slider bounds. */
export function numericBounds(records) {
  let rMin = null; let rMax = null; let vMin = null; let vMax = null;
  for (const r of records || []) {
    const rating = ratingOf(r);
    if (rating != null) {
      rMin = rMin == null ? rating : Math.min(rMin, rating);
      rMax = rMax == null ? rating : Math.max(rMax, rating);
    }
    const reviews = reviewsOf(r);
    if (reviews != null) {
      vMin = vMin == null ? reviews : Math.min(vMin, reviews);
      vMax = vMax == null ? reviews : Math.max(vMax, reviews);
    }
  }
  return {
    rating: { min: rMin == null ? 0 : rMin, max: rMax == null ? 5 : rMax },
    reviews: { min: vMin == null ? 0 : vMin, max: vMax == null ? 0 : vMax },
  };
}

/** Counts for the availability chips, against the unfiltered set. */
export function availabilityCounts(records) {
  const out = {};
  for (const f of AVAILABILITY) {
    let n = 0;
    for (const r of records || []) {
      try { if (f.test(r)) n++; } catch { /* ignore */ }
    }
    out[f.id] = n;
  }
  return out;
}

/** How many criteria are actually active — drives the "N filters" badge. */
export function activeCount(criteria) {
  const c = { ...blankCriteria(), ...(criteria || {}) };
  let n = 0;
  if (c.search && c.search.trim()) n++;
  if (c.ratingMin != null || c.ratingMax != null) n++;
  if (c.reviewsMin != null || c.reviewsMax != null) n++;
  if (c.categories && c.categories.length) n++;
  n += (c.availability || []).length;
  if (c.scoreMin != null) n++;
  if (c.validation && c.validation.length) n++;
  for (const k of ['city', 'state', 'postalCode', 'country']) if (c[k]) n++;
  return n;
}
