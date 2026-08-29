/**
 * Place detail extraction — Full Address / Website / Phone for one record.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS DOES NOT OPEN A TAB
 * ----------------------------------------------------------------------------
 * Earlier versions filled these fields by opening a real background tab per
 * record, navigating it to the place page, and reading the rendered DOM. That
 * works, but it means dozens to hundreds of tab creations/navigations for one
 * search — heavy on Chrome, slow, and the single biggest cause of collection
 * feeling sluggish.
 *
 * A same-origin `fetch()` of the place URL, issued from the Maps content
 * script (not the background — a background-worker fetch to google.com is a
 * different, cookie-isolated context and does not reliably return the same
 * response), returns a response that already contains almost everything the
 * rendered page would show: either the same `data-item-id="address"` /
 * `data-item-id="authority"` / `data-item-id^="phone:tel:"` markup the live
 * page uses, or — when it doesn't — the same embedded JSON payload
 * `detail-parser.js` already knows how to mine. No navigation, no paint, no
 * new tab.
 *
 * Layering, per field:
 *     data-item-id  ->  aria-label  ->  semantic row  ->  href  ->  payload
 *
 * Nothing here is invented. A field that cannot be resolved comes back '' with
 * a status of NOT_FOUND, which the quality analyser counts as coverage — never
 * as a technical error.
 */
import * as S from './selectors.js';
import { queryFirst, text, attr } from './dom.js';
import * as V from './validators.js';
import { splitAddress, isCompleteAddress, tidyAddress, composeFull } from './address.js';
import { parsePlaceDetail as parsePayload, extractPlaceJson } from './detail-parser.js';
import { FIELD_STATUS } from '../core/constants.js';

/* ------------------------------------------------------------------ *
 * Label stripping — Maps prefixes its ARIA labels with the field name.
 * ------------------------------------------------------------------ */
const LABEL_PREFIX = /^(address|adresse|direcci[oó]n|indirizzo|endere[cç]o|adres|adresa|cím|osoite|adressen?|地址|주소|العنوان|पता|phone|telephone|t[eé]l[eé]phone|tel[eé]fono|telefono|telefone|telefon|電話|전화|هاتف|website|site\s*web|sitio\s*web|sito\s*web|webseite|ιστότοπος|веб-сайт)\s*[:：]\s*/i;

function stripLabel(value) {
  return String(value || '').replace(LABEL_PREFIX, '').trim();
}

/* ==================================================================== *
 * Field extractors — each takes the document to read (the live page or a
 * DOMParser-parsed fetch response) and returns { value, via }.
 * ==================================================================== */

/**
 * ADDRESS
 *   button[data-item-id="address"]  ->  aria-label containing "Address"
 *   ->  semantic detail row  ->  payload
 */
export function extractAddress(root) {
  const el = queryFirst(S.DETAIL_ADDRESS, root);
  if (el) {
    const aria = stripLabel(attr(el, 'aria-label'));
    if (V.isPlausibleAddressLine(aria)) return { value: tidyAddress(aria), via: 'dom:data-item-id=address[aria-label]' };

    const inner = stripLabel(text(el));
    if (V.isPlausibleAddressLine(inner)) return { value: tidyAddress(inner), via: 'dom:data-item-id=address[text]' };
  }

  // Any button whose ARIA label announces itself as an address.
  const labelled = findByAriaPrefix(['address', 'adresse', 'dirección', 'indirizzo'], root);
  if (labelled) {
    const v = stripLabel(attr(labelled, 'aria-label'));
    if (V.isPlausibleAddressLine(v)) return { value: tidyAddress(v), via: 'dom:aria-label' };
  }

  // Semantic row: an info row whose icon/tooltip identifies it as the address.
  const row = queryFirst(['button[data-tooltip="Copy address"]', '[data-tooltip="Copy address"]'], root);
  if (row) {
    const v = stripLabel(text(row));
    if (V.isPlausibleAddressLine(v)) return { value: tidyAddress(v), via: 'dom:data-tooltip' };
  }

  return { value: '', via: 'none' };
}

/**
 * WEBSITE
 *   a[data-item-id="authority"]  ->  aria-label  ->  href  ->  validate
 * Google-owned, schema.org and Maps-internal URLs are rejected outright, so
 * `http://schema.org/Place` can never reach the Website column.
 */
export function extractWebsite(root) {
  const el = queryFirst(S.DETAIL_WEBSITE, root);
  if (el) {
    const href = el.href || attr(el, 'href');
    if (V.isPlausibleWebsite(href)) return { value: href, via: 'dom:data-item-id=authority[href]' };

    const aria = stripLabel(attr(el, 'aria-label'));
    if (V.isPlausibleWebsite(aria)) return { value: normaliseBareHost(aria), via: 'dom:data-item-id=authority[aria-label]' };

    const inner = stripLabel(text(el));
    if (V.isPlausibleWebsite(inner)) return { value: normaliseBareHost(inner), via: 'dom:data-item-id=authority[text]' };
  }

  const labelled = findByAriaPrefix(['website', 'site web', 'sitio web', 'sito web', 'webseite'], root);
  if (labelled) {
    const href = labelled.href || attr(labelled, 'href');
    if (V.isPlausibleWebsite(href)) return { value: href, via: 'dom:aria-label[href]' };
    const v = stripLabel(attr(labelled, 'aria-label'));
    if (V.isPlausibleWebsite(v)) return { value: normaliseBareHost(v), via: 'dom:aria-label' };
  }

  return { value: '', via: 'none' };
}

/** Maps sometimes shows a bare host ("alaqsaroofing.com"); give it a scheme. */
function normaliseBareHost(value) {
  const v = String(value || '').trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/**
 * PHONE
 *   data-item-id="phone:tel:…"  ->  tel: href  ->  aria-label
 */
export function extractPhone(root) {
  const el = queryFirst(S.DETAIL_PHONE, root);
  if (el) {
    const itemId = attr(el, 'data-item-id');
    const fromId = itemId.replace(/^phone:tel:/, '');
    if (fromId && fromId !== itemId && V.isPlausiblePhone(fromId)) {
      return { value: fromId, via: 'dom:data-item-id=phone' };
    }
    const aria = stripLabel(attr(el, 'aria-label'));
    if (V.isPlausiblePhone(aria)) return { value: aria, via: 'dom:data-item-id=phone[aria-label]' };

    const inner = stripLabel(text(el));
    if (V.isPlausiblePhone(inner)) return { value: inner, via: 'dom:data-item-id=phone[text]' };
  }

  // A tel: link anywhere in the panel.
  const tel = queryFirst(['a[href^="tel:"]'], root);
  if (tel) {
    const v = decodeURIComponent((tel.href || attr(tel, 'href') || '').replace(/^tel:/, ''));
    if (V.isPlausiblePhone(v)) return { value: v, via: 'dom:tel-href' };
  }

  const labelled = findByAriaPrefix(['phone', 'telephone', 'téléphone', 'teléfono', 'telefone'], root);
  if (labelled) {
    const v = stripLabel(attr(labelled, 'aria-label'));
    if (V.isPlausiblePhone(v)) return { value: v, via: 'dom:aria-label' };
  }

  return { value: '', via: 'none' };
}

/** Any element whose aria-label starts with one of these field names. */
function findByAriaPrefix(prefixes, root) {
  let nodes;
  try {
    nodes = (root || document).querySelectorAll('[aria-label]');
  } catch {
    return null;
  }
  for (const el of nodes) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    if (prefixes.some((p) => label.startsWith(`${p}:`) || label.startsWith(`${p} :`))) return el;
  }
  return null;
}

/** Title, category, rating and review count from the panel header. */
export function extractHeader(root) {
  const out = { businessName: '', category: '', rating: '', reviewCount: '' };

  out.businessName = text(queryFirst(S.DETAIL_TITLE, root));

  const cat = queryFirst(S.DETAIL_CATEGORY, root);
  if (cat) out.category = text(cat);

  const star = queryFirst(['span[role="img"][aria-label*="star"]', 'span[aria-label*="star"]'], root);
  if (star) {
    const aria = attr(star, 'aria-label');
    const m = aria.match(/(\d{1,2}(?:[.,]\d{1,2})?)/);
    if (m) {
      const n = Number(m[1].replace(',', '.'));
      if (Number.isFinite(n) && n >= 0 && n <= 5) out.rating = n.toFixed(1);
    }
  }

  const reviews = queryFirst(['button[aria-label*="review"]', 'span[aria-label*="review"]', 'button[jsaction*="reviewChart"]'], root);
  if (reviews) {
    const digits = (attr(reviews, 'aria-label') || text(reviews)).replace(/[^\d]/g, '');
    if (digits) out.reviewCount = String(parseInt(digits, 10));
  }
  return out;
}

/** Coordinates from a Maps place URL. Blank when the URL does not expose them. */
export function extractGeo(href) {
  const out = { latitude: '', longitude: '' };
  const m = String(href || '').match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || String(href || '').match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) {
    if (V.isPlausibleLat(m[1])) out.latitude = m[1];
    if (V.isPlausibleLng(m[2])) out.longitude = m[2];
  }
  return out;
}

/* ==================================================================== *
 * Assembly — shared by the live page (Diagnostics probe) and the fetched
 * response (detail resolution). Pure: takes a document-like root, returns
 * the detail object. No network, no waiting.
 * ==================================================================== */

/** Read everything a place document (live or fetched-and-parsed) exposes. */
export function extractFromDocument(root, url) {
  const via = {};
  const header = extractHeader(root);

  const addr = extractAddress(root);
  const site = extractWebsite(root);
  const phone = extractPhone(root);
  const geo = extractGeo(url);

  via.address = addr.via;
  via.website = site.via;
  via.phone = phone.via;

  let fullAddress = '';
  let components = { street: '', city: '', state: '', postalCode: '', country: '' };

  if (addr.value) {
    if (isCompleteAddress(addr.value)) {
      fullAddress = tidyAddress(addr.value);
      components = splitAddress(fullAddress);
      via.fullAddress = addr.via;
    } else {
      // Only a street line: keep it as Address, leave Full Address blank.
      components.street = tidyAddress(addr.value);
      via.fullAddress = 'partial';
    }
  }

  // If the panel gave components but no single complete string, build one.
  if (!fullAddress && components.street && (components.city || components.postalCode)) {
    const built = composeFull(components.street, components);
    if (built) { fullAddress = built; via.fullAddress = 'composed'; }
  }

  return {
    businessName: header.businessName,
    category: header.category,
    rating: header.rating,
    reviewCount: header.reviewCount,

    address: components.street || tidyAddress(addr.value),
    fullAddress,
    city: components.city,
    state: components.state,
    postalCode: components.postalCode,
    country: components.country,

    website: site.value,
    phone: phone.value,
    latitude: geo.latitude,
    longitude: geo.longitude,

    via,
  };
}

/**
 * Fill any gap `extractFromDocument` left, from the page's embedded JSON
 * payload — a last resort, used only for what's still missing, and every
 * value is validated before use exactly like the DOM path.
 */
export function mergeEmbeddedPayload(detail, html, knownStreet) {
  if (!html || (detail.fullAddress && detail.website && detail.phone)) return detail;

  const out = { ...detail, via: { ...detail.via } };

  let payload = null;
  try {
    // Always try — not gated on extractPlaceJson finding the array payload
    // first. parsePlaceDetail() handles a missing array payload internally
    // and still tries JSON-LD, an independent address source; a pre-check
    // here that skipped calling it entirely would make that fallback dead
    // code in the one situation it exists for. The DOM's own street
    // (out.address) is offered first, falling back to the caller's
    // already-trusted street (e.g. the card's own Address from Phase-1
    // collection) — parsePlaceDetail's own anchor-based fallback uses
    // whichever is available to recover a Full Address even when neither
    // the array payload nor JSON-LD produced one structurally.
    payload = parsePayload(html, { knownStreet: out.address || knownStreet });
  } catch { /* a malformed response must not break this record */ }

  // Everything below that reads `payload.*` needs payload.ok — but the
  // anchor-based fallback further down does NOT (it works directly off the
  // raw response text), so a missing/unparseable payload must not skip past
  // it via an early return the way it used to.
  const hasPayload = !!(payload && payload.ok);

  if (hasPayload && !out.fullAddress && payload.fullAddress && isCompleteAddress(payload.fullAddress)) {
    out.fullAddress = tidyAddress(payload.fullAddress);
    const c = splitAddress(out.fullAddress);
    out.city = out.city || c.city;
    out.state = out.state || c.state;
    out.postalCode = out.postalCode || c.postalCode;
    out.country = out.country || c.country;
    out.via.fullAddress = `payload:${payload.via.fullAddress}`;
    // The DOM found no street of its own (out.address blank), but the
    // payload just supplied a complete Full Address on its own — its
    // street component belongs in the short Address field too, not just
    // buried inside Full Address.
    if (!out.address && (c.street || payload.address)) out.address = c.street || payload.address;
  } else if (hasPayload && !out.fullAddress && (out.address || payload.address) && (payload.city || payload.postalCode)) {
    // Neither source alone produced a complete address. The DOM path
    // (extractAddress) reads `data-item-id="address"` markup that a raw,
    // non-JS-executed fetch() response frequently does not contain at all —
    // Maps is a JS SPA, so out.address is very often blank here even though
    // the payload independently resolved city/state/postal/country but
    // never composed them into one string (a wrong index, or the payload
    // simply never joins them itself). Fall back to the payload's OWN
    // street line (payload.address, resolved from the embedded JSON) when
    // the DOM gave us nothing, so Full Address is not left blank just
    // because this one fetch never got real content in the first place —
    // the pieces are otherwise all sitting right there.
    const usedPayloadStreet = !out.address;
    const street = out.address || payload.address;
    const built = composeFull(street, {
      city: payload.city, state: payload.state, postalCode: payload.postalCode, country: payload.country,
    });
    if (built) {
      out.fullAddress = built;
      if (!out.address) out.address = street;
      out.city = out.city || payload.city;
      out.state = out.state || payload.state;
      out.postalCode = out.postalCode || payload.postalCode;
      out.country = out.country || payload.country;
      out.via.fullAddress = usedPayloadStreet
        ? 'payload:composed-from-payload-street'
        : 'payload:composed-from-dom-street';
    }
  }

  // Anchor/generic recovery (a prior working version of this extension's
  // mechanism — see extractFullAddressByAnchor()/extractFullAddressGeneric()
  // in detail-parser.js) already ran INSIDE parsePayload() above, seeded
  // with the best street available (out.address || knownStreet). If it
  // found something, payload.fullAddress already carries the result and
  // the branches above already picked it up — no separate branch needed
  // here, so there is exactly one implementation of this logic, not two.

  if (hasPayload) {
    if (!out.website && V.isPlausibleWebsite(payload.website)) {
      out.website = payload.website;
      out.via.website = `payload:${payload.via.website}`;
    }
    if (!out.phone && V.isPlausiblePhone(payload.phone)) {
      out.phone = payload.phone;
      out.via.phone = `payload:${payload.via.phone}`;
    }
    if (!out.latitude && payload.latitude) { out.latitude = payload.latitude; out.longitude = payload.longitude; }
  }

  return out;
}

/** Attach the per-field statuses `applyDetail()` (detail-resolver.js) expects. */
function withStatuses(detail) {
  return {
    ...detail,
    fullAddressStatus: detail.fullAddress ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND,
    websiteStatus: detail.website ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND,
    phoneStatus: detail.phone ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND,
  };
}

/* ==================================================================== *
 * Network entry point — same-origin fetch, no tab.
 *
 * Must run from the Maps content script, not the background service worker:
 * a content script injected on google.com issues a same-origin request that
 * automatically carries the user's session, which is what makes the response
 * rich enough to parse. A background-worker fetch to the same URL is a
 * different, cookie-isolated context and does not reliably return the same
 * thing (this is what earlier versions of this codebase hit, and why detail
 * resolution used to open a real tab instead).
 * ==================================================================== */

/** `hl=en` keeps ARIA labels and any embedded payload text predictable. */
export function placePageUrl(mapsUrl) {
  try {
    const u = new URL(mapsUrl);
    u.searchParams.set('hl', 'en');
    return u.toString();
  } catch {
    return mapsUrl;
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}`, status: res.status, finalUrl: res.url };
    return { ok: true, text: await res.text(), error: null, status: res.status, finalUrl: res.url };
  } catch (err) {
    const message = err && err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err && err.message || err);
    return { ok: false, text: '', error: message, status: null, finalUrl: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one place's page and extract Full Address / Website / Phone (plus
 * whatever else is available) from the response — no navigation, no tab.
 * Always resolves. Unresolved fields are '' with an explicit status.
 */
export async function fetchPlaceDetail(mapsUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || 12000;
  const url = placePageUrl(mapsUrl);

  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) return { ok: false, data: null, error: res.error };

  let parsed;
  try {
    const doc = new DOMParser().parseFromString(res.text, 'text/html');
    parsed = extractFromDocument(doc, url);
  } catch (err) {
    // A response that fails to parse as HTML still has embedded JSON to try.
    parsed = { businessName: '', category: '', rating: '', reviewCount: '', address: '', fullAddress: '', city: '', state: '', postalCode: '', country: '', website: '', phone: '', latitude: '', longitude: '', via: { parseError: String(err && err.message) } };
  }

  // The card's already-known street (opts.knownStreet, threaded through
  // from detail-resolver.js -> the DETAIL_EXTRACT message) is the most
  // trusted address source available — it's what a human sees in the
  // results list — so it's offered to the anchor-based fallback even when
  // this fetch's own DOM/payload extraction found no street of its own.
  const merged = mergeEmbeddedPayload(parsed, res.text, opts.knownStreet);
  return { ok: true, data: withStatuses(merged), error: null };
}

/**
 * DIAGNOSTIC ONLY — never used by the production resolve path. Runs the
 * exact same fetch + extraction as fetchPlaceDetail(), but also reports the
 * HTTP status, the final URL (after any redirect — a same-origin request
 * that redirects to a consent/login page is invisible to the normal path
 * and would otherwise fail silently), the raw response length, whether an
 * embedded JSON payload was found at all, and a short sanitized excerpt of
 * what actually came back. This is the visibility needed to distinguish an
 * unexpected page format (Google returned something this parser doesn't
 * recognise) from no real content being returned at all — those two
 * failure modes look identical from outside.
 */
export async function diagnosePlaceDetail(mapsUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || 12000;
  const url = placePageUrl(mapsUrl);

  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) {
    return {
      ok: false, error: res.error, url, finalUrl: res.finalUrl || '',
      httpStatus: res.status, responseLength: 0, payloadFound: false, excerpt: '', data: null,
    };
  }

  let parsed;
  try {
    const doc = new DOMParser().parseFromString(res.text, 'text/html');
    parsed = extractFromDocument(doc, url);
  } catch (err) {
    parsed = { businessName: '', category: '', rating: '', reviewCount: '', address: '', fullAddress: '', city: '', state: '', postalCode: '', country: '', website: '', phone: '', latitude: '', longitude: '', via: { parseError: String(err && err.message) } };
  }

  let payloadFound = false;
  try { payloadFound = !!extractPlaceJson(res.text); } catch { /* treated as not found */ }

  const merged = mergeEmbeddedPayload(parsed, res.text, opts.knownStreet);

  // Strip script/style bodies so a diagnostics report a user pastes
  // somewhere never carries anything large or executable — just enough
  // plain markup to see what kind of page actually came back.
  const excerpt = String(res.text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '[script]')
    .replace(/<style[\s\S]*?<\/style>/gi, '[style]')
    .slice(0, 600);

  return {
    ok: true,
    url,
    finalUrl: res.finalUrl || url,
    httpStatus: res.status,
    responseLength: (res.text || '').length,
    payloadFound,
    excerpt,
    data: merged,
  };
}
