/**
 * Data Quality Analyzer.
 *
 * ============================================================================
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * ============================================================================
 *   A missing field is a DATA QUALITY fact.
 *   A broken program is a TECHNICAL ERROR.
 *   They are counted separately and displayed separately. Always.
 *
 * v2.0.1 incremented `counts.errors` when a business had no website, and
 * reported a missing phone as `parser.phone` FAILED. Fifty-one perfectly good
 * leads therefore read as "51 Errors". Nothing in this file can produce that:
 * `analyze()` only ever counts coverage, and technical errors arrive through a
 * completely separate channel (`recordTechnicalError`).
 */
import { QUALITY_FIELDS, FIELD_STATUS, SOCIAL_KEYS, TECH_ERROR } from './constants.js';

/** Does this record have a usable value for a tracked quality field? */
export function hasValue(record, key) {
  if (!record) return false;
  switch (key) {
    case 'social':
      return SOCIAL_KEYS.some((k) => !!record[k]);
    case 'coordinates':
      return !!(record.latitude && record.longitude);
    default:
      return !!record[key];
  }
}

/**
 * Coverage report over a record set.
 * Returns counts only — never an error, never a failure.
 */
export function analyze(records) {
  const list = records || [];
  const total = list.length;

  const fields = {};
  for (const { key, label } of QUALITY_FIELDS) {
    let found = 0;
    for (const r of list) if (hasValue(r, key)) found++;
    fields[key] = {
      key,
      label,
      found,
      missing: total - found,
      total,
      percent: total ? Math.round((found / total) * 100) : 0,
    };
  }

  // "Complete" = has the four things a lead is actually useful without.
  const coreKeys = ['fullAddress', 'website', 'phone', 'rating'];
  let complete = 0;
  let partial = 0;
  for (const r of list) {
    const got = coreKeys.filter((k) => hasValue(r, k)).length;
    if (got === coreKeys.length) complete++;
    else if (got > 0) partial++;
  }

  return {
    total,
    complete,
    partial,
    empty: total - complete - partial,
    fields,
    /** Convenience for the dashboard: [{label, found, total, percent}] */
    rows: QUALITY_FIELDS.map(({ key }) => fields[key]),
  };
}

/**
 * Per-field status for one record, with a reason for every blank.
 * Drives the Data table's status cells — no blank is shown unexplained.
 */
export function fieldStatuses(record, context = {}) {
  const { detailResolved = null, enrichRun = false, mode = 'standard' } = context;
  const out = {};

  const status = (key, requested) => {
    if (hasValue(record, key)) return FIELD_STATUS.FOUND;
    if (!requested) return FIELD_STATUS.NOT_REQUESTED;
    // An explicit per-field status set by a resolver always wins.
    const explicit = record[`${key}Status`];
    if (explicit && Object.values(FIELD_STATUS).includes(explicit)) return explicit;
    return FIELD_STATUS.NOT_FOUND;
  };

  const detailRequested = mode !== 'fast';
  const detailDone = detailResolved === null ? detailRequested : detailResolved;

  out.businessName = status('businessName', true);
  out.category = status('category', true);
  out.rating = status('rating', true);
  out.reviewCount = status('reviewCount', true);
  out.address = status('address', true);

  for (const key of ['fullAddress', 'website', 'phone']) {
    if (!detailRequested) { out[key] = FIELD_STATUS.NOT_REQUESTED; continue; }
    if (hasValue(record, key)) { out[key] = FIELD_STATUS.FOUND; continue; }
    const explicit = record[`${key}Status`];
    if (explicit) { out[key] = explicit; continue; }
    out[key] = detailDone ? FIELD_STATUS.NOT_FOUND : FIELD_STATUS.PENDING;
  }

  out.coordinates = hasValue(record, 'coordinates')
    ? FIELD_STATUS.FOUND
    : (detailDone ? FIELD_STATUS.NOT_FOUND : FIELD_STATUS.PENDING);

  for (const key of ['email', ...SOCIAL_KEYS]) {
    if (hasValue(record, key)) { out[key] = FIELD_STATUS.FOUND; continue; }
    if (!enrichRun) { out[key] = FIELD_STATUS.NOT_REQUESTED; continue; }
    if (key === 'email' && record.emailStatus === 'Error') { out[key] = FIELD_STATUS.FAILED; continue; }
    if (!record.website) { out[key] = FIELD_STATUS.NOT_REQUESTED; continue; }
    out[key] = FIELD_STATUS.NOT_FOUND;
  }

  return out;
}

/** Plain-English explanation for a status chip. */
export function explainStatus(status, fieldLabel = 'This field') {
  switch (status) {
    case FIELD_STATUS.FOUND: return `${fieldLabel} was found.`;
    case FIELD_STATUS.NOT_FOUND: return `${fieldLabel} is not published — Google or the website does not expose it. This is normal, not an error.`;
    case FIELD_STATUS.NOT_REQUESTED: return `${fieldLabel} was not requested. Run the stage that produces it (detail resolution or enrichment).`;
    case FIELD_STATUS.PENDING: return `${fieldLabel} is queued for resolution and has not been processed yet.`;
    case FIELD_STATUS.FAILED: return `${fieldLabel} could not be retrieved — a timeout or network failure. This one IS a technical error.`;
    default: return '';
  }
}

/* ==================================================================== *
 * Technical errors — the separate channel
 * ==================================================================== */

export function blankTechnical() {
  return {
    total: 0,
    byCategory: Object.fromEntries(Object.values(TECH_ERROR).map((c) => [c, 0])),
    recent: [],
  };
}

/**
 * Record a genuine failure. Callers must pass one of TECH_ERROR's categories.
 * Anything a user could reasonably describe as "the business didn't have one"
 * must NOT come through here.
 */
export function recordTechnicalError(technical, category, message) {
  const t = technical && technical.byCategory ? technical : blankTechnical();
  const cat = Object.values(TECH_ERROR).includes(category) ? category : TECH_ERROR.UNEXPECTED;
  t.total += 1;
  t.byCategory[cat] = (t.byCategory[cat] || 0) + 1;
  t.recent.push({ category: cat, message: String(message).slice(0, 240), at: Date.now() });
  if (t.recent.length > 25) t.recent.splice(0, t.recent.length - 25);
  return t;
}

/** Merge two technical-error records (used when combining jobs). */
export function mergeTechnical(a, b) {
  const out = blankTechnical();
  for (const src of [a, b]) {
    if (!src) continue;
    out.total += src.total || 0;
    for (const [k, v] of Object.entries(src.byCategory || {})) out.byCategory[k] = (out.byCategory[k] || 0) + v;
    out.recent.push(...(src.recent || []));
  }
  out.recent.sort((x, y) => y.at - x.at);
  out.recent.length = Math.min(out.recent.length, 25);
  return out;
}
