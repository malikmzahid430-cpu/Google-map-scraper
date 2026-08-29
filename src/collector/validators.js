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
  // A real URL/domain never legitimately contains a raw space or comma — the
  // WHATWG URL constructor below silently percent-encodes them instead of
  // rejecting the input, which is how a comma-and-space-joined garbage
  // string (e.g. Google's own internal data) could pass as a "website"
  // despite looking nothing like one.
  if (/[\s,]/.test(s)) return false;
  if (looksLikeGoogleInternalData(s)) return false;

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

/**
 * A single glyph from a private-use-area icon font, rather than real text.
 * Google Maps cards often show amenity/accessibility badges ("Wheelchair
 * accessible entrance", "Dine-in") as an ICON ONLY — no visible label, just
 * one character from a ligature font mapped into a Unicode private-use
 * range. That glyph is unrenderable garbage everywhere outside the site
 * that shipped the font, and must never be mistaken for address text.
 */
export function hasIconGlyph(v) {
  return /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/u.test(String(v || ''));
}

/**
 * Substrings/patterns that only ever appear in Google's own internal
 * JS/JSON — build labels, RPC parameters, batchexecute payloads — never in
 * a human-written postal address. Found by tracing an actual reported bad
 * value (`4oR0.2021.O/m=GfLzUe, tNOPW, cZ2KIb, ...`) back through
 * structuralScan(): Google's APP_INITIALIZATION_STATE payload is enormous
 * and full of exactly this kind of internal metadata string, and a scan
 * that only checked "looks like 2+ comma-separated parts with a digit
 * somewhere" had no way to tell that apart from a real address.
 */
const GOOGLE_INTERNAL_MARKERS = ['/m=', '/am=', '/rt=', '/rs=', 'wli=', 'batchexecute', 'boq_'];

/** "4oR0.2021.O" — a short alphanumeric build/version label, dot-separated. */
const VERSION_TOKEN_RE = /\b[a-zA-Z0-9]{1,6}\.\d{4}\.[a-zA-Z0-9]{1,4}\b/;

/**
 * "cZ2KIb", "Rq2f7d", "MJcXSb" — the distinctive shape of a Closure-
 * compiler-obfuscated identifier: short, mixes upper case, lower case AND
 * digits with no recognisable word or number pattern. A real address
 * component (a city, a state code, a unit number) never looks like this.
 */
function looksLikeObfuscatedToken(part) {
  return /^[A-Za-z][A-Za-z0-9]{3,9}$/.test(part)
    && /\d/.test(part) && /[a-z]/.test(part) && /[A-Z]/.test(part);
}

/**
 * Any of the concrete Google-internal signals found while debugging this.
 * Exported because the same false positive hits more than just the address
 * fields: a version-token like "4oR0.2021.O" has dots in it, which is
 * exactly what makes a string LOOK like a domain name too — isPlausibleWebsite
 * below was found accepting the very same reported garbage as a "website"
 * for that reason, and detail-parser.js's own locality-fragment scan needs
 * the same guard for the same underlying reason.
 */
export function looksLikeGoogleInternalData(v) {
  const s = String(v || '');
  const lower = s.toLowerCase();
  if (GOOGLE_INTERNAL_MARKERS.some((m) => lower.includes(m))) return true;
  if (VERSION_TOKEN_RE.test(s)) return true;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.filter(looksLikeObfuscatedToken).length >= 2) return true;
  return false;
}

/**
 * Does this look like an actual street segment — "2105 E Mariposa Rd",
 * "6215-1 Wilson Blvd Building 1", "221B Baker Street", "PO Box 4402" —
 * rather than an arbitrary string that merely contains a digit somewhere?
 * A genuine street line has EITHER a leading house number followed by a
 * space and more text, OR a recognisable street word with a space next to
 * it. This is deliberately stricter than "has a digit" — that alone is
 * what let Google's internal tokens through in the first place, since a
 * build label or RPC parameter list very often contains digits too.
 */
function looksLikeGenuineStreetSegment(s) {
  if (/^\d{1,6}[a-zA-Z]?(?:-\d+)?\s+\S/.test(s)) return true;
  if (/\bp\.?\s*o\.?\s*box\b/i.test(s)) return true;
  return /\s/.test(s) && /\b(st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|way|hwy|highway|suite|ste|unit|floor|building|bldg|circle|cir|court|ct|place|pl|terrace|ter|parkway|pkwy|square|sq|trail|trl|route|rte)\b/i.test(s);
}

/** A street line: shaped like a genuine address, and no @. */
export function isPlausibleAddressLine(v) {
  if (!isString(v)) return false;
  const s = v.trim();
  if (s.length < 4 || s.length > 300) return false;
  if (s.includes('@') || /^https?:\/\//i.test(s)) return false;
  if (isPlausiblePhone(s)) return false;               // never accept a phone as an address
  if (hasIconGlyph(s)) return false;                    // an icon-only badge, not a street
  if (looksLikeGoogleInternalData(s)) return false;      // Google's own internal data, not an address
  return looksLikeGenuineStreetSegment(s);
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
