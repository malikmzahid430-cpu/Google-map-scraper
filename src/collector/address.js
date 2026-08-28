/**
 * Address composition and component splitting.
 *
 * Address      = the street line, as Maps shows it on the card.
 * Full Address = street + locality + region + postal code + country.
 *
 * These are DIFFERENT FIELDS and are never substituted for one another. If
 * only a street line is available, Full Address stays blank and its status
 * becomes "Not Found" — a partial address is never presented as complete.
 */
import { COUNTRY_BY_CODE } from './countries.js';

const COUNTRY_NAMES = new Set(Object.values(COUNTRY_BY_CODE).map((n) => n.toLowerCase()));

/** Extra spellings Maps uses that differ from the ISO short name. */
const COUNTRY_ALIASES = new Map([
  ['usa', 'United States'],
  ['us', 'United States'],
  ['u.s.a.', 'United States'],
  ['united states of america', 'United States'],
  ['uk', 'United Kingdom'],
  ['u.k.', 'United Kingdom'],
  ['great britain', 'United Kingdom'],
  ['england', 'United Kingdom'],
  ['scotland', 'United Kingdom'],
  ['wales', 'United Kingdom'],
  ['northern ireland', 'United Kingdom'],
  ['uae', 'United Arab Emirates'],
  ['türkiye', 'Türkiye'],
  ['turkey', 'Türkiye'],
  ['south korea', 'South Korea'],
  ['korea', 'South Korea'],
]);

export function looksLikeCountry(part) {
  if (!part) return false;
  const p = String(part).trim().toLowerCase();
  if (!p || p.length > 56) return false;
  return COUNTRY_NAMES.has(p) || COUNTRY_ALIASES.has(p);
}

export function canonicalCountry(part) {
  const p = String(part || '').trim();
  const lower = p.toLowerCase();
  if (COUNTRY_ALIASES.has(lower)) return COUNTRY_ALIASES.get(lower);
  for (const name of COUNTRY_NAMES) {
    if (name === lower) {
      // Recover the correctly-cased ISO name.
      const found = Object.values(COUNTRY_BY_CODE).find((n) => n.toLowerCase() === lower);
      return found || p;
    }
  }
  return p;
}

/**
 * Split a complete address into components.
 *
 * Conservative by design: anything it cannot identify with confidence is left
 * blank rather than guessed. It never invents a country from a postcode.
 *
 * "6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States"
 *   -> street "6215-1 Wilson Blvd Building 1"
 *      city   "Jacksonville"
 *      state  "FL"
 *      postal "32210"
 *      country "United States"
 */
export function splitAddress(fullAddress) {
  const out = { street: '', city: '', state: '', postalCode: '', country: '' };
  // Google frequently renders the address as multiple stacked lines (street
  // on one row, city/state/zip on the next) rather than one comma-joined
  // string — reading that back via innerText/textContent yields a newline
  // where a comma would otherwise be, which silently broke the split below
  // (a genuinely complete address read as street-only, or its city ending
  // up misparsed as a region). Treat a line break exactly like a comma.
  const raw = String(fullAddress || '').replace(/\s*\n+\s*/g, ', ').trim();
  if (!raw) return out;

  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return out;

  // Country: only when the last part is a recognised country name.
  if (parts.length > 1 && looksLikeCountry(parts[parts.length - 1])) {
    out.country = canonicalCountry(parts.pop());
  }

  // Region + postcode. Common shapes:
  //   "FL 32210"        US
  //   "Manchester M1 2AB"  UK (postcode is the tail)
  //   "32210"           postcode alone
  //   "Ontario"         region alone
  if (parts.length > 1) {
    const tail = parts[parts.length - 1];

    const usStyle = tail.match(/^([A-Za-z][A-Za-z.\s]{0,24}?)\s+([A-Z0-9][A-Z0-9\s-]{2,10})$/);
    const postalOnly = tail.match(/^([A-Z0-9][A-Z0-9\s-]{2,10})$/i);

    if (usStyle && /\d/.test(usStyle[2])) {
      const name = usStyle[1].trim();
      out.postalCode = usStyle[2].trim();
      parts.pop();
      // "Jacksonville, FL 32210" leaves a separate city part, so FL is the
      // region. "Manchester M1 2AB" leaves only the street, which makes
      // Manchester the city rather than a region.
      if (parts.length > 1) out.state = name;
      else out.city = name;
    } else if (postalOnly && /\d/.test(postalOnly[1])) {
      out.postalCode = postalOnly[1].trim();
      parts.pop();
    } else if (parts.length > 2) {
      // A non-postal tail with enough parts left is a region.
      out.state = tail;
      parts.pop();
    }
  }

  // City is the next part up, when a street line still remains beneath it.
  if (parts.length > 1) out.city = parts.pop();

  out.street = parts.join(', ');
  return out;
}

/**
 * Is this a COMPLETE postal address rather than a bare street line?
 * Requires a street plus at least two of {city, region, postcode, country}.
 */
export function isCompleteAddress(fullAddress) {
  const c = splitAddress(fullAddress);
  if (!c.street) return false;
  const extras = [c.city, c.state, c.postalCode, c.country].filter(Boolean).length;
  return extras >= 2;
}

/** Tidy separators without rewriting any component. */
export function tidyAddress(value) {
  return String(value || '')
    // A line break separates components exactly like a comma does — convert
    // it FIRST, before the general whitespace collapse below turns it into
    // an indistinguishable plain space and glues two components together
    // (e.g. a street line and city rendered as two stacked DOM rows).
    .replace(/\s*\n+\s*/g, ', ')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(,\s*)+/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

/**
 * Build a Full Address from a street line plus components, appending the
 * country ONLY when it was actually supplied. Returns '' when the result would
 * still be just a street line.
 */
export function composeFull(street, components = {}) {
  const parts = [];
  const push = (v) => { const t = String(v || '').trim(); if (t && !parts.includes(t)) parts.push(t); };

  push(street);
  push(components.city);

  const region = [components.state, components.postalCode].filter(Boolean).join(' ').trim();
  push(region);
  push(components.country);

  const joined = tidyAddress(parts.join(', '));
  return isCompleteAddress(joined) ? joined : '';
}
