/**
 * Field validators.
 *
 * These are the gate that decides whether a candidate value is accepted. The
 * tolerant resolver in detail-parser.js tries several sources per field and
 * takes the FIRST that passes here — which is why a wrong index now produces a
 * blank rather than `http://schema.org/Place`.
 */
import { BLOCKED_WEBSITE_HOSTS, BLOCKED_WEBSITE_SUBSTRINGS } from '../core/constants.js';

export function isString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/* ---------------------------- WEBSITE ---------------------------- */

export function isPlausibleWebsite(v) {
  if (!isString(v)) return false;
  const s = v.trim();
  if (s.length < 4 || s.length > 500) return false;

  const lower = s.toLowerCase();
  if (BLOCKED_WEBSITE_SUBSTRINGS.some((frag) => lower.includes(frag))) return false;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;

  // Reject Google-owned and metadata hosts outright.
  for (const blocked of BLOCKED_WEBSITE_HOSTS) {
    const b = blocked.replace(/^www\./, '');
    if (host === b || host.endsWith(`.${b}`)) return false;
  }
  return true;
}

/* ----------------------------- PHONE ----------------------------- */

/**
 * A phone number, not a street number and not free text.
 * Requires 7–17 digits and rejects anything with letters beyond an extension.
 */
export function isPlausiblePhone(v) {
  if (!isString(v)) return false;
  const s = v.trim();
  if (s.length > 40) return false;
  if (/[a-z]{3,}/i.test(s.replace(/\b(ext|x|extension)\b/gi, ''))) return false;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 17) return false;
  // Must be mostly phone punctuation.
  if (!/^[+()\-.\s\d/]+(?:\s*(?:ext|x)\.?\s*\d+)?$/i.test(s)) return false;
  return true;
}

/* ---------------------------- ADDRESS ---------------------------- */

/** A street line: has some digits or a recognisable street word, and no @. */
export function isPlausibleAddressLine(v) {
  if (!isString(v)) return false;
  const s = v.trim();
  if (s.length < 4 || s.length > 300) return false;
  if (s.includes('@') || /^https?:\/\//i.test(s)) return false;
  if (isPlausiblePhone(s)) return false;               // never accept a phone as an address
  return /\d/.test(s) || /\b(st|street|rd|road|ave|avenue|blvd|ln|lane|dr|drive|way|hwy|suite|unit|floor)\b/i.test(s);
}

/**
 * A full postal address: a street line PLUS at least one more component
 * (city/region/postcode), i.e. it must contain a separator.
 */
export function isPlausibleFullAddress(v) {
  if (!isPlausibleAddressLine(v)) return false;
  // A line break separates components the same way a comma does — Maps
  // often renders the address as stacked rows rather than one comma-joined
  // string, and reading that back gives a newline where a comma would be.
  const s = v.trim().replace(/\s*\n+\s*/g, ', ');
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  if (s.length < 12) return false;
  return true;
}

/* ------------------------------ GEO ------------------------------ */

export function isPlausibleLat(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 90 && n !== 0;
}

export function isPlausibleLng(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 180 && n !== 0;
}

/* ----------------------------- EMAIL ----------------------------- */

const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;

export function isPlausibleEmail(v) {
  if (!isString(v)) return false;
  const s = v.trim().toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) return false;

  const [local, domain] = s.split('@');
  if (!local || !domain) return false;

  // Reject placeholder and asset-derived addresses.
  const badDomains = ['example.com', 'email.com', 'domain.com', 'yourdomain.com',
    'test.com', 'website.com', 'sentry.io', 'wixpress.com', 'sentry-next.wixpress.com'];
  if (badDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;
  if (/^(sentry|wixpress|godaddy|squarespace)/.test(domain)) return false;

  const tld = domain.split('.').pop();
  const assetExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'css', 'js',
    'json', 'xml', 'pdf', 'zip', 'mp4', 'mp3', 'woff', 'woff2', 'ttf', 'eot', 'otf'];
  if (assetExts.includes(tld)) return false;
  if (tld.length < 2 || tld.length > 24) return false;

  return true;
}

/* ---------------------------- RATING ----------------------------- */

export function isValidRating(v) {
  if (v === '' || v == null) return true;              // blank is allowed
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 5;
}

export function isValidReviewCount(v) {
  if (v === '' || v == null) return true;
  return /^\d+$/.test(String(v));
}
