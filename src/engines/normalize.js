/**
 * Normalization Engine.
 *
 * Rule: normalization NEVER destroys information. Every normalised field keeps
 * its original under `record.raw.<field>`, so an aggressive rule can always be
 * reversed and an export can fall back to what Maps actually showed.
 *
 * Pure functions only — no DOM, no chrome APIs, fully unit-tested.
 */
import { SOCIAL_KEYS } from '../core/constants.js';

/* ---------------------------- STRINGS ---------------------------- */

export function normalizeWhitespace(s) {
  return String(s == null ? '' : s)
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A comparison key for a business name. Used ONLY for duplicate matching —
 * never exported, because it is lossy by design.
 *   "ABC  Roofing" / "abc roofing" / "ABC Roofing LLC" -> "abc roofing"
 */
export function businessNameKey(name) {
  let s = normalizeWhitespace(name).toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');   // strip accents
  s = s.replace(/[&]/g, ' and ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  // Trailing legal-entity suffixes; only stripped at the END of the name so
  // "LLC Plumbing Supply" is not mangled.
  s = s.replace(/\b(llc|l l c|inc|incorporated|corp|corporation|ltd|limited|co|company|pllc|plc|gmbh|pvt|pty|llp|lp)\b\.?\s*$/g, '');
  return normalizeWhitespace(s);
}

export function normalizeBusinessName(name) {
  return normalizeWhitespace(name);
}

/* ----------------------------- PHONE ----------------------------- */

/**
 * Keep the number human-readable; normalise only the separators.
 * "+1 904-516-4279" stays "+1 904-516-4279" — a valid, dialable string.
 */
export function normalizePhone(phone) {
  const s = normalizeWhitespace(phone);
  if (!s) return '';
  return s.replace(/[‐-―]/g, '-').replace(/\s{2,}/g, ' ');
}

/** Digits-only comparison key. "+1 904-516-4279" -> "19045164279" */
export function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  // Drop a leading international trunk zero for comparison purposes.
  return digits.replace(/^0+/, '');
}

/* ---------------------------- WEBSITE ---------------------------- */

/**
 * "https://www.example.com/" -> "https://www.example.com"
 * Adds a scheme when missing, drops a trailing slash on the root, and removes
 * tracking parameters. Path, query and fragment are otherwise preserved.
 */
export function normalizeWebsite(url) {
  const s = normalizeWhitespace(url);
  if (!s) return '';
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return s;
  }
  const strip = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'referrer'];
  for (const k of strip) u.searchParams.delete(k);

  u.hash = '';
  let out = u.toString();
  if (u.pathname === '/' && !u.search) out = `${u.origin}`;
  else out = out.replace(/\/$/, '');
  return out;
}

/** Registrable-ish host key for comparison: "www.Example.com/" -> "example.com" */
export function websiteKey(url) {
  const n = normalizeWebsite(url);
  if (!n) return '';
  try {
    return new URL(n).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return n.toLowerCase();
  }
}

/* ----------------------------- EMAIL ----------------------------- */

export function normalizeEmail(email) {
  const s = normalizeWhitespace(email).toLowerCase();
  if (!s.includes('@')) return '';
  return s;
}

/* ---------------------------- ADDRESS ---------------------------- */

/**
 * Tidy separators and casing artefacts without rewriting the address.
 * "6215-1 Wilson Blvd Building 1,Jacksonville , FL 32210 ,United States"
 *   -> "6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States"
 */
export function normalizeAddress(addr) {
  let s = normalizeWhitespace(addr);
  if (!s) return '';
  s = s.replace(/\s*,\s*/g, ', ');
  s = s.replace(/,\s*,+/g, ', ');
  s = s.replace(/^[,\s]+|[,\s]+$/g, '');
  return s;
}

/** Comparison key for an address: lowercased, punctuation-free, abbreviations folded. */
export function addressKey(addr) {
  let s = normalizeAddress(addr).toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[.,#]/g, ' ');
  const abbr = {
    street: 'st', road: 'rd', avenue: 'ave', boulevard: 'blvd', drive: 'dr',
    lane: 'ln', court: 'ct', place: 'pl', highway: 'hwy', parkway: 'pkwy',
    suite: 'ste', apartment: 'apt', building: 'bldg', floor: 'fl',
    north: 'n', south: 's', east: 'e', west: 'w',
  };
  s = s.replace(/\b[a-z]+\b/g, (w) => abbr[w] || w);
  return normalizeWhitespace(s);
}

/* -------------------------- SOCIAL URLS -------------------------- */

const SOCIAL_HOSTS = {
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'm.facebook.com'],
  instagram: ['instagram.com', 'instagr.am'],
  tiktok: ['tiktok.com'],
  linkedin: ['linkedin.com'],
  youtube: ['youtube.com', 'youtu.be'],
  twitter: ['twitter.com', 'x.com'],
};

/** Which platform a URL belongs to, or '' when it is not a social profile. */
export function socialPlatform(url) {
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
  for (const [platform, hosts] of Object.entries(SOCIAL_HOSTS)) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return platform;
  }
  return '';
}

/**
 * Normalise a social URL to a consistent form:
 *   https://www.instagram.com/company/  ->  https://instagram.com/company
 * Share/intent/tracking URLs and bare platform roots are rejected (return '').
 */
export function normalizeSocialUrl(url) {
  const s = normalizeWhitespace(url);
  if (!s) return '';
  const platform = socialPlatform(s);
  if (!platform) return '';

  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return '';
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  let path = u.pathname.replace(/\/+$/, '');

  // Reject non-profile paths — share widgets, login walls, generic pages.
  const junk = [
    '/sharer', '/share', '/intent', '/login', '/signup', '/home', '/help',
    '/privacy', '/terms', '/policies', '/tr', '/plugins', '/dialog', '/watch',
    '/hashtag', '/explore', '/p', '/reel', '/embed', '/oauth',
  ];
  const first = path.split('/')[1] || '';
  if (!first) return '';                                    // bare platform root
  if (junk.some((j) => path.toLowerCase().startsWith(j))) return '';
  if (/^(sharer|share|intent|login|signup|home|help|privacy|terms|tr|plugins|dialog|hashtag|explore|embed|oauth)$/i.test(first)) return '';

  // LinkedIn: keep the /company/ or /in/ prefix, it is part of the identity.
  if (platform === 'linkedin') {
    const m = path.match(/^\/(company|in|school|showcase)\/([^/]+)/i);
    if (!m) return '';
    path = `/${m[1].toLowerCase()}/${m[2]}`;
  }

  // TikTok profiles are /@handle
  if (platform === 'tiktok') {
    const m = path.match(/^\/(@[^/]+)/);
    if (!m) return '';
    path = `/${m[1]}`;
  }

  // YouTube: /@handle, /c/name, /channel/ID, /user/name
  if (platform === 'youtube') {
    const m = path.match(/^\/(@[^/]+|c\/[^/]+|channel\/[^/]+|user\/[^/]+)/);
    if (!m) return '';
    path = `/${m[1]}`;
  }

  // Facebook/Instagram/X: first path segment is the handle.
  if (['facebook', 'instagram', 'twitter'].includes(platform)) {
    const m = path.match(/^\/([^/]+)/);
    if (!m) return '';
    path = `/${m[1]}`;
    if (platform === 'facebook' && /^(pages|profile\.php)$/i.test(m[1])) {
      // Keep the fuller form for these two legacy shapes.
      path = u.pathname.replace(/\/+$/, '');
      return `https://facebook.com${path}${u.search}`;
    }
  }

  const canonicalHost = platform === 'twitter' ? 'x.com'
    : platform === 'youtube' && host === 'youtu.be' ? 'youtube.com'
      : host;

  return `https://${canonicalHost}${path}`;
}

/* -------------------------- RECORD LEVEL ------------------------- */

/**
 * Normalise a whole record, preserving originals under `raw`.
 * Returns a NEW object; the input is not mutated.
 */
export function normalizeRecord(record) {
  const r = { ...record };
  const raw = { ...(record.raw || {}) };

  const keep = (key, value) => {
    if (record[key] !== undefined && record[key] !== value && raw[key] === undefined) {
      raw[key] = record[key];
    }
  };

  const name = normalizeBusinessName(r.businessName);
  keep('businessName', name); r.businessName = name;

  const cat = normalizeWhitespace(r.category);
  keep('category', cat); r.category = cat;

  const addr = normalizeAddress(r.address);
  keep('address', addr); r.address = addr;

  const full = normalizeAddress(r.fullAddress);
  keep('fullAddress', full); r.fullAddress = full;

  const site = normalizeWebsite(r.website);
  keep('website', site); r.website = site;

  const phone = normalizePhone(r.phone);
  keep('phone', phone); r.phone = phone;

  const email = normalizeEmail(r.email);
  keep('email', email); r.email = email;

  for (const k of SOCIAL_KEYS) {
    if (!r[k]) continue;
    const s = normalizeSocialUrl(r[k]);
    keep(k, s); r[k] = s;
  }

  r.raw = raw;
  r.keys = {
    name: businessNameKey(r.businessName),
    phone: phoneKey(r.phone),
    website: websiteKey(r.website),
    address: addressKey(r.fullAddress || r.address),
    place: r.placeId || '',
    url: r.dedupeUrl || r.mapsUrl || '',
  };
  return r;
}
