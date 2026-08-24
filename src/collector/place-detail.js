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
export function mergeEmbeddedPayload(detail, html) {
  if (!html || (detail.fullAddress && detail.website && detail.phone)) return detail;

  let payload = null;
  try {
    if (extractPlaceJson(html)) payload = parsePayload(html);
  } catch { /* a malformed response must not break this record */ }
  if (!payload || !payload.ok) return detail;

  const out = { ...detail, via: { ...detail.via } };

  if (!out.fullAddress && payload.fullAddress && isCompleteAddress(payload.fullAddress)) {
    out.fullAddress = tidyAddress(payload.fullAddress);
    const c = splitAddress(out.fullAddress);
    out.city = out.city || c.city;
    out.state = out.state || c.state;
    out.postalCode = out.postalCode || c.postalCode;
    out.country = out.country || c.country;
    out.via.fullAddress = `payload:${payload.via.fullAddress}`;
  }
  if (!out.website && V.isPlausibleWebsite(payload.website)) {
    out.website = payload.website;
    out.via.website = `payload:${payload.via.website}`;
  }
  if (!out.phone && V.isPlausiblePhone(payload.phone)) {
    out.phone = payload.phone;
    out.via.phone = `payload:${payload.via.phone}`;
  }
  if (!out.latitude && payload.latitude) { out.latitude = payload.latitude; out.longitude = payload.longitude; }

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
    if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text(), error: null };
  } catch (err) {
    const message = err && err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err && err.message || err);
    return { ok: false, text: '', error: message };
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

  const merged = mergeEmbeddedPayload(parsed, res.text);
  return { ok: true, data: withStatuses(merged), error: null };
}
