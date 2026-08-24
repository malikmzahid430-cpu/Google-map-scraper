/**
 * Place detail extraction from the RENDERED Google Maps page.
 *
 * ----------------------------------------------------------------------------
 * WHY THIS REPLACES THE v2 APPROACH
 * ----------------------------------------------------------------------------
 * v2 did `fetch(placeUrl)` from the content script and mined
 * APP_INITIALIZATION_STATE out of the returned HTML. A plain fetch of a Maps
 * place URL does not reliably return the same payload the rendered page has,
 * so the parser mostly failed — 51 results yielded 2 websites.
 *
 * v3 reads the detail panel Maps actually renders. That is the authoritative
 * source, it is what the user sees, and its hooks (`data-item-id`) are the most
 * durable thing Maps exposes. The embedded payload is kept only as a LAST
 * resort, and every value it produces is validated before use.
 *
 * Layering, per field:
 *     data-item-id  ->  aria-label  ->  semantic row  ->  href  ->  payload
 *
 * Nothing here is invented. A field that cannot be resolved comes back '' with
 * a status of NOT_FOUND, which the quality analyser counts as coverage — never
 * as a technical error.
 */
import * as S from './selectors.js';
import { queryFirst, text, attr, waitFor } from './dom.js';
import { sleep } from '../core/safe.js';
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
 * Panel readiness
 * ==================================================================== */

/**
 * Wait until the place panel has actually rendered its detail rows.
 * Resolves false on timeout rather than throwing.
 */
export async function waitForPlacePanel(timeoutMs = 12000) {
  const title = await waitFor(S.DETAIL_TITLE, timeoutMs);
  if (!title) return false;

  // The title can paint before the address/phone/website rows exist.
  const deadline = Date.now() + Math.max(2000, timeoutMs / 2);
  while (Date.now() < deadline) {
    if (queryFirst(S.DETAIL_ADDRESS) || queryFirst(S.DETAIL_PHONE) || queryFirst(S.DETAIL_WEBSITE)) {
      await sleep(150);          // let the remaining rows settle
      return true;
    }
    await sleep(200);
  }
  // A place with genuinely no detail rows (rare) still counts as rendered.
  return true;
}

/* ==================================================================== *
 * Field extractors — each returns { value, via }
 * ==================================================================== */

/**
 * ADDRESS
 *   button[data-item-id="address"]  ->  aria-label containing "Address"
 *   ->  semantic detail row  ->  payload
 */
export function extractAddress() {
  const el = queryFirst(S.DETAIL_ADDRESS);
  if (el) {
    const aria = stripLabel(attr(el, 'aria-label'));
    if (V.isPlausibleAddressLine(aria)) return { value: tidyAddress(aria), via: 'dom:data-item-id=address[aria-label]' };

    const inner = stripLabel(text(el));
    if (V.isPlausibleAddressLine(inner)) return { value: tidyAddress(inner), via: 'dom:data-item-id=address[text]' };
  }

  // Any button whose ARIA label announces itself as an address.
  const labelled = findByAriaPrefix(['address', 'adresse', 'dirección', 'indirizzo']);
  if (labelled) {
    const v = stripLabel(attr(labelled, 'aria-label'));
    if (V.isPlausibleAddressLine(v)) return { value: tidyAddress(v), via: 'dom:aria-label' };
  }

  // Semantic row: an info row whose icon/tooltip identifies it as the address.
  const row = queryFirst(['button[data-tooltip="Copy address"]', '[data-tooltip="Copy address"]']);
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
export function extractWebsite() {
  const el = queryFirst(S.DETAIL_WEBSITE);
  if (el) {
    const href = el.href || attr(el, 'href');
    if (V.isPlausibleWebsite(href)) return { value: href, via: 'dom:data-item-id=authority[href]' };

    const aria = stripLabel(attr(el, 'aria-label'));
    if (V.isPlausibleWebsite(aria)) return { value: normaliseBareHost(aria), via: 'dom:data-item-id=authority[aria-label]' };

    const inner = stripLabel(text(el));
    if (V.isPlausibleWebsite(inner)) return { value: normaliseBareHost(inner), via: 'dom:data-item-id=authority[text]' };
  }

  const labelled = findByAriaPrefix(['website', 'site web', 'sitio web', 'sito web', 'webseite']);
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
export function extractPhone() {
  const el = queryFirst(S.DETAIL_PHONE);
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
  const tel = queryFirst(['a[href^="tel:"]']);
  if (tel) {
    const v = decodeURIComponent((tel.href || '').replace(/^tel:/, ''));
    if (V.isPlausiblePhone(v)) return { value: v, via: 'dom:tel-href' };
  }

  const labelled = findByAriaPrefix(['phone', 'telephone', 'téléphone', 'teléfono', 'telefone']);
  if (labelled) {
    const v = stripLabel(attr(labelled, 'aria-label'));
    if (V.isPlausiblePhone(v)) return { value: v, via: 'dom:aria-label' };
  }

  return { value: '', via: 'none' };
}

/** Any element whose aria-label starts with one of these field names. */
function findByAriaPrefix(prefixes) {
  let nodes;
  try {
    nodes = document.querySelectorAll('[aria-label]');
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
export function extractHeader() {
  const out = { businessName: '', category: '', rating: '', reviewCount: '' };

  out.businessName = text(queryFirst(S.DETAIL_TITLE));

  const cat = queryFirst(S.DETAIL_CATEGORY);
  if (cat) out.category = text(cat);

  const star = queryFirst(['span[role="img"][aria-label*="star"]', 'span[aria-label*="star"]']);
  if (star) {
    const aria = attr(star, 'aria-label');
    const m = aria.match(/(\d{1,2}(?:[.,]\d{1,2})?)/);
    if (m) {
      const n = Number(m[1].replace(',', '.'));
      if (Number.isFinite(n) && n >= 0 && n <= 5) out.rating = n.toFixed(1);
    }
  }

  const reviews = queryFirst(['button[aria-label*="review"]', 'span[aria-label*="review"]', 'button[jsaction*="reviewChart"]']);
  if (reviews) {
    const digits = (attr(reviews, 'aria-label') || text(reviews)).replace(/[^\d]/g, '');
    if (digits) out.reviewCount = String(parseInt(digits, 10));
  }
  return out;
}

/** Coordinates from the current URL. Blank when Maps does not expose them. */
export function extractGeo(href = (typeof location !== 'undefined' ? location.href : '')) {
  const out = { latitude: '', longitude: '' };
  const m = String(href).match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || String(href).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) {
    if (V.isPlausibleLat(m[1])) out.latitude = m[1];
    if (V.isPlausibleLng(m[2])) out.longitude = m[2];
  }
  return out;
}

/* ==================================================================== *
 * Top level
 * ==================================================================== */

/**
 * Read everything the rendered place page exposes.
 * Always resolves. Unresolved fields are '' with an explicit status.
 */
export async function readPlacePage(opts = {}) {
  const { timeoutMs = 12000, allowPayloadFallback = true } = opts;

  const rendered = await waitForPlacePanel(timeoutMs);

  const via = {};
  const header = extractHeader();

  const addr = extractAddress();
  const site = extractWebsite();
  const phone = extractPhone();
  const geo = extractGeo();

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

  /* ---- last resort: the embedded payload, fully validated ---- */
  let website = site.value;
  let phoneValue = phone.value;

  if (allowPayloadFallback && (!fullAddress || !website || !phoneValue)) {
    const payload = readEmbeddedPayload();
    if (payload) {
      if (!fullAddress && payload.fullAddress && isCompleteAddress(payload.fullAddress)) {
        fullAddress = tidyAddress(payload.fullAddress);
        components = splitAddress(fullAddress);
        via.fullAddress = `payload:${payload.via.fullAddress}`;
      }
      if (!website && V.isPlausibleWebsite(payload.website)) {
        website = payload.website;
        via.website = `payload:${payload.via.website}`;
      }
      if (!phoneValue && V.isPlausiblePhone(payload.phone)) {
        phoneValue = payload.phone;
        via.phone = `payload:${payload.via.phone}`;
      }
      if (!geo.latitude && payload.latitude) { geo.latitude = payload.latitude; geo.longitude = payload.longitude; }
    }
  }

  // If the panel gave components but no single complete string, build one.
  if (!fullAddress && components.street && (components.city || components.postalCode)) {
    const built = composeFull(components.street, components);
    if (built) { fullAddress = built; via.fullAddress = 'composed'; }
  }

  return {
    rendered,
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

    website,
    phone: phoneValue,
    latitude: geo.latitude,
    longitude: geo.longitude,

    fullAddressStatus: fullAddress ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND,
    websiteStatus: website ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND,
    phoneStatus: phoneValue ? FIELD_STATUS.FOUND : FIELD_STATUS.NOT_FOUND,

    via,
  };
}

/** Mine the page's own embedded payload, if this rollout still ships one. */
function readEmbeddedPayload() {
  try {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    if (!html || !extractPlaceJson(html)) return null;
    const parsed = parsePayload(html);
    return parsed && parsed.ok ? parsed : null;
  } catch {
    return null;
  }
}
