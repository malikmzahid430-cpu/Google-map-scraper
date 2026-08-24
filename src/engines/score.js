/**
 * Lead Scoring Engine.
 *
 * Runs over stored records only — a score never influences collection, and a
 * scoring failure cannot affect anything upstream.
 *
 * Raw points are summed, then normalised to 0–100 against the maximum
 * achievable with the CURRENT weights, so the score stays comparable if you
 * change the weights in Settings.
 */
import { DEFAULT_SETTINGS, SOCIAL_KEYS } from '../core/constants.js';
import * as V from '../collector/validators.js';
import { socialPlatform } from './normalize.js';

/** Maximum points obtainable under a weight set. */
export function maxScore(weights) {
  const w = { ...DEFAULT_SETTINGS.scoring, ...(weights || {}) };
  return Object.values(w).reduce((a, b) => a + (Number(b) || 0), 0);
}

/**
 * Score one record.
 * @returns {{ score: number, raw: number, max: number, breakdown: object }}
 */
export function scoreRecord(record, weights) {
  const w = { ...DEFAULT_SETTINGS.scoring, ...(weights || {}) };
  const breakdown = {};
  let raw = 0;

  const award = (key, condition) => {
    const points = Number(w[key]) || 0;
    if (condition && points) { raw += points; breakdown[key] = points; }
  };

  award('fullAddress', V.isPlausibleFullAddress(record.fullAddress));
  award('phone', V.isPlausiblePhone(record.phone));

  // A website only scores if it is actually a business site. Awarding points
  // for `http://schema.org/Place` would reward exactly the bug this rewrite
  // exists to fix.
  const websiteOk = V.isPlausibleWebsite(record.website);
  award('website', websiteOk);

  award('email', V.isPlausibleEmail(record.email));

  // A social link only scores when the URL really belongs to that platform,
  // so a Facebook URL filed under `instagram` earns nothing.
  for (const key of SOCIAL_KEYS) {
    if (key === 'twitter') continue;                 // no weight defined for X
    award(key, !!record[key] && socialPlatform(record[key]) === key);
  }

  // Bonus tier: a secure, well-formed site on top of the base website point.
  award('validWebsite', websiteOk && /^https:\/\//i.test(String(record.website)));

  // Ratings outside 0–5 are mis-parses, not five-star businesses.
  const rating = Number(record.rating);
  const ratingOk = Number.isFinite(rating) && rating >= 0 && rating <= 5;
  award('goodRating', ratingOk && rating >= 4.0);

  const reviews = /^\d+$/.test(String(record.reviewCount)) ? parseInt(record.reviewCount, 10) : NaN;
  award('highReviews', Number.isFinite(reviews) && reviews >= 25);

  const max = maxScore(w) || 1;
  const score = Math.max(0, Math.min(100, Math.round((raw / max) * 100)));

  return { score, raw, max, breakdown };
}

export function scoreAll(records, weights) {
  const out = (records || []).map((r) => {
    const s = scoreRecord(r, weights);
    return { ...r, leadScore: s.score, scoreBreakdown: s.breakdown, scoreRaw: s.raw, scoreMax: s.max };
  });

  const scores = out.map((r) => r.leadScore);
  const stats = {
    count: out.length,
    average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    high: out.filter((r) => r.leadScore >= 70).length,
    medium: out.filter((r) => r.leadScore >= 40 && r.leadScore < 70).length,
    low: out.filter((r) => r.leadScore < 40).length,
  };
  return { records: out, stats };
}

/** Sort helper for the Data view. */
export function sortByScore(records, direction = 'desc') {
  const sign = direction === 'asc' ? 1 : -1;
  return (records || []).slice().sort((a, b) => sign * ((a.leadScore || 0) - (b.leadScore || 0)));
}
