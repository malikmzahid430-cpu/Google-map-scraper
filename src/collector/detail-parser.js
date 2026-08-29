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
import { splitAddress, composeFull } from './address.js';

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
  full = full.replace(/\s*,\s*/g, ', ').replace(/,\s*,/g, ',').trim();

  // A bare street with no country to pair it with (the branch just above,
  // when nothing better was found) is still only one part — not a complete
  // address. Reject it HERE, after the country append had its chance,
  // rather than never accepting it at all: a street WITH a country really
  // is two parts. Returning '' for the plain-street case (instead of the
  // street itself) matters a great deal — it used to poison out.fullAddress
  // with a single-part, non-blank value that silently blocked every
  // fallback below it in parsePlaceDetail (the structural scan and the
  // locality-fragment scan both only run `if (!out.fullAddress)`), so a
  // record whose formattedAddress index happened to hold just the street
  // got permanently stuck on that lone street: never blank enough to try
  // anything better, never complete enough to be a real Full Address.
  return V.isPlausibleFullAddress(full) ? full : '';
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

/**
 * A short string that looks like the LOCALITY TAIL of an address — "City,
 * ST 12345", "Manchester M1 2AB", a bare postal code — without requiring a
 * street. Used only as a last resort, when nothing in the payload composed
 * into a full address string by index or by structural scan, so a
 * DOM-found street line (see place-detail.js) still has city/region/postal
 * to combine with instead of Full Address staying blank outright.
 */
function looksLikeLocalityFragment(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 4 || s.length > 80) return false;
  if (s.includes('@') || /^https?:\/\//i.test(s)) return false;
  if (V.isPlausiblePhone(s)) return false;
  // A locality tail is short-and-loose by design (no street required), which
  // is exactly the gap that let a reported Google-internal data string
  // ("4oR0.2021.O/m=GfLzUe, ..., WEtKm, B863O") through as a fake "City, ST"
  // tail — its own final segment happened to match the loose comma-tail
  // shape below. Reject the same internal-data signature here too.
  if (V.looksLikeGoogleInternalData(s)) return false;
  // "City, ST 12345" / "City, Postcode" — a comma followed by a short tail.
  if (s.includes(',') && /,\s*[A-Za-z0-9][A-Za-z0-9.\s-]{1,24}$/.test(s)) return true;
  // "Manchester M1 2AB" — a place name directly followed by a postcode-shaped tail.
  if (/^[A-Za-z][A-Za-z.\s]{0,24}\s+[A-Z0-9][A-Z0-9\s-]{2,10}$/.test(s)) return true;
  return false;
}

/**
 * JSON-LD structured data — schema.org PostalAddress inside a
 * `<script type="application/ld+json">` block. This is a fully independent
 * address source: it does not depend on locating or successfully parsing
 * the APP_INITIALIZATION_STATE array payload at all, so it is tried even
 * when that payload is missing or its shape has drifted from every
 * candidate index this parser knows about.
 */
export function extractJsonLdAddress(html) {
  if (!html || typeof html !== 'string') return null;
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const found = findPostalAddress(item, 0);
      if (found) return found;
    }
  }
  return null;
}

/** Depth-bounded search for a schema.org PostalAddress-shaped object. */
function findPostalAddress(node, depth) {
  if (!node || typeof node !== 'object' || depth > 4) return null;

  if (typeof node.streetAddress === 'string' || typeof node.addressLocality === 'string') {
    const countryField = node.addressCountry;
    const country = countryField && typeof countryField === 'object'
      ? String(countryField.name || '').trim()
      : String(countryField || '').trim();
    return {
      street: String(node.streetAddress || '').trim(),
      city: String(node.addressLocality || '').trim(),
      state: String(node.addressRegion || '').trim(),
      postalCode: String(node.postalCode || '').trim(),
      country,
    };
  }

  if (node.address && typeof node.address === 'object') {
    const found = findPostalAddress(node.address, depth + 1);
    if (found) return found;
  }

  for (const key of Object.keys(node)) {
    if (key === 'address') continue;
    const v = node[key];
    if (v && typeof v === 'object') {
      const found = findPostalAddress(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
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

/**
 * Undo the escaping a raw JSON/HTML response wraps address text in, so a
 * plain-text search for it actually matches. Ported from a prior working
 * version of this extension's anchor-based address recovery below.
 */
function normalizeForAddressSearch(text) {
  if (!text) return '';
  return String(text)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-');
}

/**
 * Confine raw-text address search to where Google's actual data lives.
 *
 * `extractFullAddressByAnchor()`/`extractFullAddressGeneric()` below used to
 * search the ENTIRE raw HTTP response — markup, `<style>` blocks, inline
 * `style="..."` attributes, scripts, everything mixed together. A real
 * report showed that produces garbage: `<style>.x{box-shadow: 0 1px 0
 * rgba(0, 0, 0, .15)}</style>` is `digit, space, more text, comma, more
 * text` — structurally indistinguishable from a street address to a regex,
 * no matter how the *content* is validated afterward.
 *
 * The actual boundary that matters is WHERE Google's data lives, not what
 * a candidate string looks like: `APP_INITIALIZATION_STATE` and any
 * JSON-LD are always inside `<script>` tags; CSS is never in there. So
 * strip `<style>` blocks and inline `style="..."` attributes first — a
 * structural exclusion, not a content guess — then confine the search to
 * `<script>` tag content when the response has any. A same-origin fetch of
 * a place page can also come back as a bare XHR body with no HTML wrapper
 * at all (no `<script>` tags anywhere); that text IS already just data, so
 * it passes through unchanged rather than being discarded.
 */
function extractScriptText(html) {
  const withoutStyle = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, ' ')
    .replace(/\sstyle\s*=\s*'[^']*'/gi, ' ');

  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  const parts = [];
  let m;
  while ((m = scriptRe.exec(withoutStyle)) !== null) parts.push(m[1]);
  return parts.length ? parts.join('\n') : withoutStyle;
}

/**
 * Anchor-based Full Address recovery — ported from the mechanism a prior
 * working version of this extension used for exactly this problem. Rather
 * than guess at Google's undocumented internal JSON array layout (which
 * shifts between versions and silently breaks — the root cause chased
 * through 4.5.0-4.5.4), search the response text (restricted to
 * `<script>` content — see extractScriptText() above) for the street
 * address already trusted (from the card, the DOM, or this same payload)
 * and read forward to wherever that address text ends. Google embeds the
 * complete formatted address as plain text somewhere in its script data
 * even when it never lands in any `formattedAddress`-shaped structure at
 * an index this parser knows about, because the same text has to render
 * for a human either way.
 *
 * This only ever EXTENDS an address already trusted — it can never replace
 * a good street with something worse, and it makes no assumption about
 * country/postal format (the candidate is validated with the same
 * `V.isPlausibleFullAddress` used everywhere else in this file, which is
 * international-agnostic: it requires 2+ comma-separated parts of plausible
 * length, not a specific ZIP/postcode shape).
 */
export function extractFullAddressByAnchor(rawText, knownStreet) {
  if (!rawText || typeof rawText !== 'string') return '';
  const street = String(knownStreet || '').trim();
  // Must itself look like a genuine street (a digit, or a street word) —
  // never a bare city/locality name mistaken for one. Anchoring on "Austin"
  // would happily "confirm" any nearby "Austin, TX 78701" as if the street
  // were known, when really no street was ever found at all.
  if (!V.isPlausibleAddressLine(street)) return '';

  const text = normalizeForAddressSearch(extractScriptText(rawText));
  const normStreet = normalizeForAddressSearch(street);
  const idx = text.toLowerCase().indexOf(normStreet.toLowerCase());
  if (idx === -1) return '';

  // Whatever follows the street, up to the next JSON string/array/object
  // boundary — i.e. the rest of the same embedded string, which is where
  // Google keeps the rest of a formatted address when the street is a
  // prefix of it.
  const afterStart = idx + normStreet.length;
  const after = text.slice(afterStart, afterStart + 220);
  const boundary = after.search(/["\\[\]{}]/);
  const tail = boundary === -1 ? after : after.slice(0, boundary);

  const candidate = (text.slice(idx, afterStart) + tail)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,\s]+$/, '');

  return V.isPlausibleFullAddress(candidate) ? candidate : '';
}

/**
 * Absolute last resort — no known street to anchor on at all. Phase-1 card
 * scraping should almost always have already supplied one (that's the
 * street this whole fallback chain anchors on above); this only matters in
 * the rare case it genuinely didn't. Scans the response text (restricted
 * to `<script>` content — see extractScriptText() above, which is what
 * keeps CSS like `box-shadow: 0 1px 0 rgba(0, 0, 0, .15)` from ever being
 * visible here at all) for anything shaped like "123 Some St, City, ..."
 * without needing a pre-known street, bounded to a fixed number of
 * candidates so a huge minified response cannot spin the collector, and
 * each candidate is bounded by JSON-string-safe characters so a match can
 * never bleed across an embedded string's boundary. Validated with the
 * same `V.isPlausibleFullAddress` used everywhere else — no country/postal
 * format is assumed, and nothing is invented: a miss returns ''.
 */
export function extractFullAddressGeneric(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const text = normalizeForAddressSearch(extractScriptText(rawText));
  const re = /\d{1,6}[^"\\[\]{}]{2,60},[^"\\[\]{}]{2,140}/g;
  let m;
  let tries = 0;
  while ((m = re.exec(text)) !== null && tries < 500) {
    tries++;
    const candidate = m[0].replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
    if (V.isPlausibleFullAddress(candidate)) return candidate;
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
export function parsePlaceDetail(html, opts = {}) {
  const out = {
    address: '', fullAddress: '', website: '', phone: '',
    city: '', state: '', postalCode: '', country: '',
    latitude: '', longitude: '', placeId: '', category: '',
    rating: '', reviewCount: '',
    via: {}, ok: false,
  };

  const json = extractPlaceJson(html);
  out.via.payload = json ? 'parsed' : 'none';

  let formattedValue = '';
  let formattedVia = 'none';
  let components = null;
  let country = '';

  // Everything in this block depends on having located and parsed the
  // APP_INITIALIZATION_STATE array payload. When that payload is missing —
  // which is exactly the scenario that used to make this whole function
  // return empty before ANY fallback ran — website/phone/geo/category/
  // rating/placeId simply stay unresolved, but address resolution below
  // still gets a chance via JSON-LD, an entirely independent source.
  if (json) {
    out.ok = true;

    /* ---- website ---- */
    const site = resolve(json, P.website, V.isPlausibleWebsite, { maxDepth: 6, maxNodes: 20000 });
    out.website = site.value || '';
    out.via.website = site.via;

    /* ---- phone ---- */
    const phone = resolve(json, P.phone, V.isPlausiblePhone, { maxDepth: 7, maxNodes: 20000 });
    out.phone = phone.value || '';
    out.via.phone = phone.via;

    /* ---- address (array-index payload) ---- */
    const formatted = resolve(json, P.formattedAddress, V.isPlausibleFullAddress, false);
    formattedValue = formatted.value;
    formattedVia = formatted.via;

    if (!formattedValue) {
      const loose = resolve(json, P.formattedAddress, V.isPlausibleAddressLine, false);
      formattedValue = loose.value;
      formattedVia = loose.via;
    }

    for (const path of P.addressComponents) {
      const v = readPath(json, path);
      if (Array.isArray(v) && v.filter((x) => typeof x === 'string' && x.trim()).length >= 2) {
        components = v;
        break;
      }
    }

    country = resolveCountry(json);

    out.fullAddress = composeFullAddress({ formatted: formattedValue, components, country });

    if (!out.fullAddress) {
      // Last resort: scan for any string that looks like a complete address.
      const scanned = structuralScan(json, V.isPlausibleFullAddress, { maxDepth: 8, maxNodes: 30000 });
      if (scanned) {
        out.fullAddress = country ? composeFullAddress({ formatted: scanned, components: null, country }) : scanned;
        formattedVia = 'scan';
      }
    }
  }

  // JSON-LD (schema.org PostalAddress): tried whenever the array payload
  // didn't produce a complete address — whether because the payload was
  // never found at all, or because its address is fragmented across
  // indices this parser doesn't recognise. Independent of `json` above.
  if (!out.fullAddress) {
    const ld = extractJsonLdAddress(html);
    if (ld && (ld.street || ld.city)) {
      const ldCountry = country || ld.country;
      const built = composeFull(ld.street, {
        city: ld.city, state: ld.state, postalCode: ld.postalCode, country: ldCountry,
      });
      if (built) {
        out.fullAddress = built;
        formattedVia = 'jsonld';
        if (!country) country = ldCountry;
        out.ok = true;
      } else if (!formattedValue && ld.street && V.isPlausibleAddressLine(ld.street)) {
        formattedValue = ld.street;
        formattedVia = 'jsonld';
      }
    }
  }

  // Component breakdown (city/state/postalCode/country), independent of
  // whether a full address string was ever composed. place-detail.js uses
  // this to combine a DOM-found street line with whatever locality data
  // the payload has, instead of giving up when neither source alone is a
  // complete address — the layered approach a single index guess can't do.
  if (out.fullAddress) {
    const split = splitAddress(out.fullAddress);
    out.city = split.city; out.state = split.state; out.postalCode = split.postalCode;
    out.country = split.country || country || '';
  } else {
    out.city = ''; out.state = ''; out.postalCode = ''; out.country = country || '';
    // Nothing composed into a full string — look for a standalone locality
    // fragment ("City, ST 12345") anywhere in the payload.
    if (json) {
      const frag = structuralScan(json, looksLikeLocalityFragment, { maxDepth: 8, maxNodes: 30000 });
      if (frag) {
        const split = splitAddress(frag);
        if (split.city || split.postalCode || split.state) {
          out.city = split.city; out.state = split.state; out.postalCode = split.postalCode;
          out.country = split.country || country || '';
          out.via.locality = 'scan';
        }
      }
    }
  }

  // Components (a real addressComponents array) and formattedValue (a
  // resolved candidate street, even a bare one composeFullAddress declined
  // to promote to Full Address) are both genuine street sources. Try those
  // BEFORE falling back to out.fullAddress's first comma segment — when
  // Full Address came from the locality-fragment/structural scan rather
  // than a real street+components composition, its first segment is the
  // CITY, not the street, and must never be mistaken for one.
  out.address = extractStreetLine('', components)
    || (formattedValue ? String(formattedValue).split(',')[0].trim() : '')
    || extractStreetLine(out.fullAddress, components);

  // Last resort, tried only when nothing above produced a complete Full
  // Address: anchor on a street we trust and search the raw response text
  // for how it continues. See extractFullAddressByAnchor() above. Two
  // candidates, in order: the street resolved from THIS SAME payload above
  // (guaranteed to be Google's own text for this exact record), then
  // `opts.knownStreet` — the caller's already-trusted street (e.g. the
  // card's own Address from Phase-1 collection, threaded through by
  // place-detail.js), tried only if the first found nothing to anchor on.
  if (!out.fullAddress) {
    for (const candidate of [out.address, opts.knownStreet]) {
      if (!candidate) continue;
      const anchored = extractFullAddressByAnchor(html, candidate);
      if (!anchored) continue;
      out.fullAddress = anchored;
      out.address = out.address || String(candidate).trim();
      const split = splitAddress(out.fullAddress);
      out.city = split.city; out.state = split.state; out.postalCode = split.postalCode;
      out.country = split.country || country || '';
      formattedVia = 'anchor';
      out.ok = true;
      break;
    }
  }

  // Absolute last resort — no street was found at all above to anchor on.
  // See extractFullAddressGeneric() for why this is still safe: bounded and
  // validated the same way as everything else.
  if (!out.fullAddress) {
    const generic = extractFullAddressGeneric(html);
    if (generic) {
      out.fullAddress = generic;
      out.address = out.address || String(generic).split(',')[0].trim();
      const split = splitAddress(out.fullAddress);
      out.city = split.city; out.state = split.state; out.postalCode = split.postalCode;
      out.country = split.country || country || '';
      formattedVia = 'generic';
      out.ok = true;
    }
  }

  out.via.fullAddress = out.fullAddress ? formattedVia : 'none';
  out.via.country = country ? 'found' : 'absent';

  if (json) {
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
  }

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
