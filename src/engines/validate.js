/**
 * Validation Engine.
 *
 * Annotates records with a per-field verdict and an overall status. It never
 * deletes anything — a failing field keeps its value so you can see what was
 * wrong, and the export can still include it if you want.
 */
import * as V from '../collector/validators.js';
import { SOCIAL_KEYS } from '../core/constants.js';
import { socialPlatform } from './normalize.js';

export const VERDICT = { OK: 'ok', EMPTY: 'empty', INVALID: 'invalid' };
export const STATUS = { VALID: 'Valid', PARTIAL: 'Partial', INVALID: 'Invalid' };

function verdict(value, isValid) {
  if (value === '' || value == null) return VERDICT.EMPTY;
  return isValid(value) ? VERDICT.OK : VERDICT.INVALID;
}

/** Validate one record. Returns a NEW record with `validation` attached. */
export function validateRecord(record) {
  const fields = {};
  const reasons = [];

  fields.website = verdict(record.website, V.isPlausibleWebsite);
  if (fields.website === VERDICT.INVALID) {
    const v = String(record.website).toLowerCase();
    if (v.includes('schema.org')) reasons.push('Website is schema.org metadata, not a business site');
    else if (v.includes('google.')) reasons.push('Website is a Google URL, not a business site');
    else reasons.push('Website is not a usable URL');
  }

  fields.email = verdict(record.email, V.isPlausibleEmail);
  if (fields.email === VERDICT.INVALID) reasons.push('Email is not a valid address');

  fields.phone = verdict(record.phone, V.isPlausiblePhone);
  if (fields.phone === VERDICT.INVALID) reasons.push('Phone is not a valid number');

  fields.fullAddress = verdict(record.fullAddress, V.isPlausibleFullAddress);
  if (fields.fullAddress === VERDICT.INVALID) reasons.push('Full address is incomplete');

  fields.rating = V.isValidRating(record.rating) ? (record.rating ? VERDICT.OK : VERDICT.EMPTY) : VERDICT.INVALID;
  if (fields.rating === VERDICT.INVALID) reasons.push(`Rating ${record.rating} is outside 0–5`);

  fields.reviewCount = V.isValidReviewCount(record.reviewCount)
    ? (record.reviewCount ? VERDICT.OK : VERDICT.EMPTY)
    : VERDICT.INVALID;
  if (fields.reviewCount === VERDICT.INVALID) reasons.push('Review count is not an integer');

  for (const key of SOCIAL_KEYS) {
    const value = record[key];
    if (!value) { fields[key] = VERDICT.EMPTY; continue; }
    const platform = socialPlatform(value);
    fields[key] = platform === key ? VERDICT.OK : VERDICT.INVALID;
    if (fields[key] === VERDICT.INVALID) reasons.push(`${key} URL is not a ${key} profile`);
  }

  const invalidCount = Object.values(fields).filter((v) => v === VERDICT.INVALID).length;
  const okCount = Object.values(fields).filter((v) => v === VERDICT.OK).length;

  let status = STATUS.VALID;
  if (invalidCount > 0) status = okCount > invalidCount ? STATUS.PARTIAL : STATUS.INVALID;

  return {
    ...record,
    validation: { status, fields, reasons, checkedAt: Date.now() },
    validationStatus: status,
  };
}

export function validateAll(records) {
  const out = (records || []).map(validateRecord);
  const stats = { valid: 0, partial: 0, invalid: 0, reasons: {} };
  for (const r of out) {
    const s = r.validation.status;
    if (s === STATUS.VALID) stats.valid++;
    else if (s === STATUS.PARTIAL) stats.partial++;
    else stats.invalid++;
    for (const reason of r.validation.reasons) {
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    }
  }
  return { records: out, stats };
}
