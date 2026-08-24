/**
 * Full Address / Website / Phone / Geo extractor — HTTP path.
 *
 * A Google Maps place page embeds its data as a JSON array inside
 * `window.APP_INITIALIZATION_STATE`. v1 read fixed indices out of that array
 * (`json[6][39]`, `json[6][7][0]`, `json[6][178][0][0]`) with no validation.
 * When Google shifted the layout those indices silently returned the wrong
 * thing — which is how `http://schema.org/Place` ended up in the Website
 * column and why Full Address was never right.
 *
 * v2 uses candidate paths + validators + a bounded structural scan. Every
 * field records HOW it resolved so Diagnostics can show you exactly which
 * parser degraded instead of failing silently.
 */
import * as V from './validators.js';
import { COUNTRY_BY_CODE } from './countries.js';

/* ==================================================================== *
 * 1. Locate and parse the embedded payload
 * ==================================================================== */

/**
 * Pull the place payload out of a place page's HTML.
 * Returns the parsed array, or null when the shape is unrecognised.
 */
export function extractPlaceJson(html) {
  if (!html || typeof html !== 'string') return null;

  const blobs = [];

  // Form A: /*""*/ chunks inside APP_INITIALIZATION_STATE.
  const appState = html.indexOf('APP_INITIALIZATION_STATE');
  if (appState >= 0) {
    const tail = html.slice(appState, appState + 4_000_000);
    // Every XHR-style payload inside is prefixed with )]}'
    const re = /\)\]\}'\s*\\?n?/g;
    let m;
    while ((m = re.exec(tail)) !== null) {
      const start = m.index + m[0].length;
      const end = findArrayEnd(tail, start);
      if (end > start) blobs.push(tail.slice(start, end));
      if (blobs.length > 6) break;
    }
  }

  // Form B: the payload served directly by an XHR (no surrounding HTML).
  if (!blobs.length) {
    const idx = html.indexOf(")]}'");
    if (idx >= 0) {
      const start = idx + 4;
      const end = findArrayEnd(html, start);
      if (end > start) blobs.push(html.slice(start, end));
    }
  }

  for (const blob of blobs) {
    const parsed = tryParse(blob);
    if (parsed && looksLikePlacePayload(parsed)) return parsed;
  }
  // Fall back to the first parseable blob even if it fails the shape check —
  // the resolver's validators still protect every individual field.
  for (const blob of blobs) {
    const parsed = tryParse(blob);
    if (parsed) return parsed;
  }
  return null;
}

/** Walk forward from `start` to the matching close of the outer array. */
function findArrayEnd(s, start) {
  let i = start;
  while (i < s.length && s[i] !== '[') i++;
  if (i >= s.length) return -1;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    if (i - start > 4_000_000) return -1;      // hard bound; no runaway scans
  }
  return -1;
}

function tryParse(blob) {
  const candidates = [
    blob,
    // Some embeddings are escaped one level (\" instead of ").
    blob.replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
  ];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v)) return v;
    } catch { /* try the next form */ }
  }
  return null;
}

/** Heuristic: the place payload has a deep array at index 6. */
function looksLikePlacePayload(json) {
  return Array.isArray(json) && Array.isArray(json[6]) && json[6].length > 20;
}

/* ==================================================================== *
 * 2. Tolerant field resolution
 * ==================================================================== */

/** Read a path like [6, 7, 0]; returns undefined on any miss. */
export function readPath(root, path) {
  let node = root;
  for (const key of path) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Bounded depth-first scan for the first value satisfying `validator`.
 * Bounded so a malformed payload cannot spin the collector.
 */
export function structuralScan(root, validator, opts = {}) {
  const { maxDepth = 8, maxNodes = 40000, transform = (x) => x } = opts;
  let nodes = 0;

  const walk = (node, depth) => {
    if (nodes++ > maxNodes || depth > maxDepth || node == null) return undefined;
    if (typeof node === 'string' || typeof node === 'number') {
      const v = transform(node);
      return validator(v) ? v : undefined;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  return walk(root, 0);
}

/**
 * Try each candidate path in order, then fall back to a structural scan.
 * @returns {{value: *, via: string}} `via` is 'path:6.7.0' | 'scan' | 'none'
 */
export function resolve(root, paths, validator, scanOpts) {
  for (const path of paths) {
    const raw = readPath(root, path);
    const candidates = Array.isArray(raw) ? [raw[0], raw] : [raw];
    for (const c of candidates) {
      if (validator(c)) return { value: c, via: `path:${path.join('.')}` };
    }
  }
  if (scanOpts !== false) {
    const found = structuralScan(root, validator, scanOpts || {});
    if (found !== undefined) return { value: found, via: 'scan' };
  }
  return { value: '', via: 'none' };
}

/* ==================================================================== *
 * 3. Candidate paths
 *
 * Ordered most-likely first. These are observed layouts, not guarantees —
 * that is precisely why every one is validated before use.
 * ==================================================================== */

const P = {
  website: [[6, 7, 0], [6, 7], [7, 0]],
  phone: [[6, 178, 0, 0], [6, 178, 0, 3], [6, 178, 0], [178, 0, 0]],
  formattedAddress: [[6, 18], [6, 39], [18], [6, 2]],
  addressComponents: [[6, 2], [2], [6, 183, 1]],
  lat: [[6, 9, 2], [9, 2], [6, 9, 0]],
  lng: [[6, 9, 3], [9, 3], [6, 9, 1]],
  name: [[6, 11], [11]],
  categories: [[6, 13], [13]],
  ratingValue: [[6, 4, 7], [4, 7]],
  reviewCount: [[6, 4, 8], [4, 8]],
  placeId: [[6, 78], [78]],
  countryName: [[6, 183, 1, 3], [183, 1, 3]],
  countryCode: [[6, 183, 1, 6], [183, 1, 6], [6, 243]],
};

/* ==================================================================== *
 * 4. Full Address composition
 *
 * Address     = the street line as Maps displays it.
 * Full Address = street + city + region + postcode + country.
 *
 * The country is appended ONLY when the payload actually carries it, either
 * as a name or as an ISO-3166 alpha-2 code (a lookup, not a guess). If it is
 * absent, Full Address is returned without it and the record is counted under
 * Diagnostics → Full Address parser. Nothing is invented.
 * ==================================================================== */

export function composeFullAddress({ formatted, components, country }) {
  const parts = [];

  if (Array.isArray(components)) {
    for (const c of components) {
      if (typeof c === 'string' && c.trim() && !V.isPlausiblePhone(c)) parts.push(c.trim());
    }
  }

  let full = '';
  if (parts.length >= 2) {
    full = dedupeJoin(parts);
  }
  if (!V.isPlausibleFullAddress(full) && V.isPlausibleFullAddress(formatted)) {
    full = String(formatted).trim();
  }
  if (!full && V.isPlausibleAddressLine(formatted)) {
    full = String(formatted).trim();
  }
  if (!full) return '';

  if (country) {
    const c = String(country).trim();
    const tail = full.toLowerCase();
    if (c && !tail.endsWith(c.toLowerCase())) full = `${full}, ${c}`;
  }
  return full.replace(/\s*,\s*/g, ', ').replace(/,\s*,/g, ',').trim();
}

/** Join address parts without repeating a component already contained. */
function dedupeJoin(parts) {
  const out = [];
  for (const p of parts) {
    const norm = p.toLowerCase().replace(/\s+/g, ' ').trim();
    if (out.some((q) => q.toLowerCase().replace(/\s+/g, ' ').trim() === norm)) continue;
    out.push(p);
  }
  return out.join(', ');
}

/** Street line = the first address component, or the head of the formatted string. */
export function extractStreetLine(fullAddress, components) {
  if (Array.isArray(components) && typeof components[0] === 'string' && components[0].trim()) {
    return components[0].trim();
  }
  if (fullAddress) {
    const head = String(fullAddress).split(',')[0].trim();
    if (head) return head;
  }
  return '';
}

/* ==================================================================== *
 * 5. Top-level parse
 * ==================================================================== */

/**
 * Parse a place page's HTML into detail fields.
 * Always returns an object; unresolved fields are '' and reported in `via`.
 */
export function parsePlaceDetail(html) {
  const out = {
    address: '', fullAddress: '', website: '', phone: '',
    latitude: '', longitude: '', placeId: '', category: '',
    rating: '', reviewCount: '',
    via: {}, ok: false,
  };

  const json = extractPlaceJson(html);
  if (!json) {
    out.via.payload = 'none';
    return out;
  }
  out.via.payload = 'parsed';
  out.ok = true;

  /* ---- website ---- */
  const site = resolve(json, P.website, V.isPlausibleWebsite, { maxDepth: 6, maxNodes: 20000 });
  out.website = site.value || '';
  out.via.website = site.via;

  /* ---- phone ---- */
  const phone = resolve(json, P.phone, V.isPlausiblePhone, { maxDepth: 7, maxNodes: 20000 });
  out.phone = phone.value || '';
  out.via.phone = phone.via;

  /* ---- address ---- */
  const formatted = resolve(json, P.formattedAddress, V.isPlausibleFullAddress, false);
  let formattedValue = formatted.value;
  let formattedVia = formatted.via;

  if (!formattedValue) {
    const loose = resolve(json, P.formattedAddress, V.isPlausibleAddressLine, false);
    formattedValue = loose.value;
    formattedVia = loose.via;
  }

  let components = null;
  for (const path of P.addressComponents) {
    const v = readPath(json, path);
    if (Array.isArray(v) && v.filter((x) => typeof x === 'string' && x.trim()).length >= 2) {
      components = v;
      break;
    }
  }

  const country = resolveCountry(json);

  out.fullAddress = composeFullAddress({
    formatted: formattedValue,
    components,
    country,
  });

  if (!out.fullAddress) {
    // Last resort: scan for any string that looks like a complete address.
    const scanned = structuralScan(json, V.isPlausibleFullAddress, { maxDepth: 8, maxNodes: 30000 });
    if (scanned) {
      out.fullAddress = country ? composeFullAddress({ formatted: scanned, components: null, country }) : scanned;
      formattedVia = 'scan';
    }
  }

  out.address = extractStreetLine(out.fullAddress, components) || (formattedValue ? String(formattedValue).split(',')[0].trim() : '');
  out.via.fullAddress = out.fullAddress ? formattedVia : 'none';
  out.via.country = country ? 'found' : 'absent';

  /* ---- geo ---- */
  const lat = resolve(json, P.lat, V.isPlausibleLat, false);
  const lng = resolve(json, P.lng, V.isPlausibleLng, false);
  if (lat.value !== '' && lng.value !== '') {
    out.latitude = String(lat.value);
    out.longitude = String(lng.value);
    out.via.geo = lat.via;
  } else {
    out.via.geo = 'none';
  }

  /* ---- place id ---- */
  const pid = readPath(json, P.placeId[0]) ?? readPath(json, P.placeId[1]);
  if (typeof pid === 'string' && pid.length > 3 && pid.length < 120) out.placeId = pid;

  /* ---- category ---- */
  for (const path of P.categories) {
    const v = readPath(json, path);
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) { out.category = v[0].trim(); break; }
    if (typeof v === 'string' && v.trim()) { out.category = v.trim(); break; }
  }

  /* ---- rating (payload values are already numeric, so no text parsing) ---- */
  const rv = readPath(json, P.ratingValue[0]) ?? readPath(json, P.ratingValue[1]);
  if (typeof rv === 'number' && rv >= 0 && rv <= 5) out.rating = rv.toFixed(1);
  const rc = readPath(json, P.reviewCount[0]) ?? readPath(json, P.reviewCount[1]);
  if (typeof rc === 'number' && rc >= 0) out.reviewCount = String(Math.round(rc));

  return out;
}

function resolveCountry(json) {
  for (const path of P.countryName) {
    const v = readPath(json, path);
    if (typeof v === 'string' && /^[A-Za-z .'()-]{4,56}$/.test(v.trim())) return v.trim();
  }
  for (const path of P.countryCode) {
    const v = readPath(json, path);
    if (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim())) {
      const name = COUNTRY_BY_CODE[v.trim().toUpperCase()];
      if (name) return name;
    }
  }
  return '';
}

/** Build the URL we fetch for a place. `hl=en` keeps the payload shape stable. */
export function placeDetailUrl(mapsUrl) {
  try {
    const u = new URL(mapsUrl);
    u.searchParams.set('hl', 'en');
    return u.toString();
  } catch {
    return mapsUrl;
  }
}
