/**
 * Maps Data Parser — turns one results-list card into a raw record.
 *
 * The pure functions at the top take strings and are unit-tested in
 * tools/tests/. The DOM-reading function at the bottom is the only part that
 * touches the page.
 */
import * as S from './selectors.js';
import { queryFirst, text, attr } from './dom.js';
import * as V from './validators.js';

/* ==================================================================== *
 * RATING + REVIEW COUNT
 *
 * This is where v1 went wrong. `"4.6 (37)".match(/[\d.]+/)` happens to work,
 * but the same code on "4,6 (37)" (comma locales) yields "4", and on
 * "4.6(37)" the greedy variants yield "4.637". The two values are also
 * different quantities and must never come from one capture group.
 * ==================================================================== */

/**
 * Extract a rating from an ARIA label such as:
 *   "4.6 stars 37 Reviews"      (en)
 *   "4,6 Sterne 37 Rezensionen" (de)
 *   "4.6 stars"
 * Returns null when no plausible rating is present.
 */
export function parseRatingFromAria(aria) {
  if (!aria) return null;
  // First number in the label is always the rating in every Maps locale.
  const m = String(aria).match(/(\d{1,2}(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  return coerceRating(m[1]);
}

/**
 * Review count from an ARIA label — the integer that follows the rating.
 *
 * The rating token is consumed FIRST and removed, so "4.8 stars" (no count)
 * cannot have its own decimal digit read back as a count of 8.
 */
export function parseReviewsFromAria(aria) {
  if (!aria) return null;
  const s = String(aria).replace(/[\u00a0\u202f\u2009]/g, ' ');

  // Consume the rating token greedily, including its decimal part.
  const head = s.match(/^\D*?(\d{1,2}(?:[.,]\d{1,2})?)/);
  const rest = head ? s.slice(head.index + head[0].length) : s;

  // The count must be preceded by a non-digit that is NOT a decimal separator,
  // so the "8" in "4.8 stars" can never be read as a review count.
  const m = rest.match(/(?:^|[^\d.,])(\d[\d.,\s]*)/);
  if (!m) return null;
  return coerceReviewCount(m[1]);
}

/**
 * Parse "4.6 (37)" / "4,6 (1.234)" / "4.6(37)" / "No reviews".
 * Rating and review count come from SEPARATE capture groups by construction.
 */
export function parseRatingAndReviews(raw) {
  const out = { rating: '', reviewCount: '' };
  if (!raw) return out;
  const s = String(raw).replace(/ | /g, ' ').trim();

  // group 1 = rating, group 2 = parenthesised count. The parens are required
  // for group 2, which is what stops "4.6" ever being read as 46.
  const m = s.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:\(\s*([\d.,\s]+?)\s*\))?/);
  if (!m) return out;

  const rating = coerceRating(m[1]);
  if (rating != null) out.rating = rating;

  if (m[2]) {
    const n = coerceReviewCount(m[2]);
    if (n != null) out.reviewCount = n;
  } else {
    // No parentheses — look for a bare "37 reviews" form.
    const alt = s.match(/([\d.,\s]+)\s*(?:reviews?|avis|rezensionen|reseñas|recensioni)/i);
    if (alt) {
      const n = coerceReviewCount(alt[1]);
      if (n != null) out.reviewCount = n;
    }
  }
  return out;
}

/**
 * Normalise a rating token to a number 0–5 with its decimal preserved.
 * Rejects anything outside the range, so a mis-parse yields blank, not "46".
 */
export function coerceRating(token) {
  if (token == null) return null;
  const cleaned = String(token).trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0 || n > 5) return null;
  // Preserve one decimal ("4.6" stays "4.6", "5" becomes "5.0").
  return n.toFixed(1);
}

/** Strip thousands separators and return a non-negative integer. */
export function coerceReviewCount(token) {
  if (token == null) return null;
  const digits = String(token).replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(n);
}

/* ==================================================================== *
 * CATEGORY + ADDRESS LINE from the card body
 * ==================================================================== */

/**
 * The card body is typically:
 *   line 0: "Al-Aqsa Roofing"
 *   line 1: "4.6 (37)"
 *   line 2: "Roofing contractor · 6215-1 Wilson Blvd"
 *   line 3: "Open ⋅ Closes 5 PM"
 * The separator is a middot; the part before it is the category, the part
 * after is a SHORT street line (never the full address).
 */
export function parseCategoryAndAddressLine(bodyText) {
  const out = { category: '', addressLine: '' };
  if (!bodyText) return out;

  const lines = String(bodyText).split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (!/[·⋅•]/.test(line)) continue;
    if (/^(open|closed|opens|closes|temporarily|permanently)/i.test(line)) continue;
    const parts = line.split(/[·⋅•]/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;

    const first = parts[0];
    // A category never contains a street number at its head.
    if (!/^\d/.test(first) && first.length < 60 && !out.category) out.category = first;

    const rest = parts.slice(1).find((p) => p && !/^(open|closed|opens|closes)/i.test(p));
    if (rest && !out.addressLine) out.addressLine = rest;
    if (out.category) break;
  }

  if (!out.category) {
    const cand = lines.find(
      (l) => !/[\d]/.test(l.slice(0, 3)) && l.length < 45 && !/^(open|closed|·)/i.test(l),
    );
    if (cand && cand !== lines[0]) out.category = cand;
  }

  // Defensive: a phone number must never end up in Category or Address —
  // it belongs in Phone only. Strip one trailing off the address line (Maps
  // sometimes prints it on the same row as hours/status) and drop either
  // field outright if it turns out to be nothing but a phone number.
  if (out.addressLine) out.addressLine = stripTrailingPhone(out.addressLine);
  if (out.category && V.isPlausiblePhone(out.category)) out.category = '';
  if (out.addressLine && V.isPlausiblePhone(out.addressLine)) out.addressLine = '';

  return out;
}

/** Remove a phone number trailing at the end of a string, if present. */
function stripTrailingPhone(s) {
  return String(s || '')
    .replace(/\s*\+\d[\d\s().-]{6,}$/i, '')
    .replace(/\s*\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\s*$/i, '')
    .trim();
}

/**
 * Extract a stable place identity from a Maps place URL.
 * `!1s0x88e5b3...:0x9f2...` is the feature id; `!19s...` and the `data=` blob
 * carry it too. Falls back to the URL path slug.
 */
export function parsePlaceIdentity(href) {
  const out = { placeId: '', cid: '', slug: '', clean: '' };
  if (!href) return out;
  try {
    const u = new URL(href, 'https://www.google.com');
    // Strip the viewport (`/@lat,lng,zoom`) and `data=` segments: they change
    // with the map view and would make one place look like two records.
    const stablePath = u.pathname.split('/@')[0].split('/data=')[0];
    out.clean = `${u.origin}${stablePath}`;

    const slug = u.pathname.match(/\/maps\/place\/([^/]+)/);
    if (slug) out.slug = decodeURIComponent(slug[1]);

    const fid = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (fid) {
      out.placeId = fid[1];
      const hex = fid[1].split(':')[1];
      if (hex) {
        try { out.cid = BigInt(hex).toString(10); } catch { /* ignore */ }
      }
    }
    if (!out.placeId) {
      const alt = href.match(/[?&]cid=(\d+)/);
      if (alt) { out.cid = alt[1]; out.placeId = alt[1]; }
    }
    // Coordinates are frequently in the URL as !3dLAT!4dLNG.
    const geo = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (geo) { out.latitude = geo[1]; out.longitude = geo[2]; }
  } catch { /* malformed URL — return what we have */ }
  return out;
}

/* ==================================================================== *
 * WEBSITE + PHONE, straight off the card
 *
 * Google sometimes renders these as quick-action buttons directly on the
 * results card (not just inside the place detail panel). When they're
 * there, reading them here means the record is complete without ever
 * needing a detail-resolution pass for that field. When they're not there,
 * this simply returns '' — nothing is invented, and detail resolution (a
 * separate, later, optional stage) can still fill the gap.
 * ==================================================================== */

/** Business website from the card, or '' if absent/rejected. */
export function extractCardWebsite(cardEl) {
  const el = queryFirst(S.CARD_WEBSITE, cardEl);
  if (!el) return '';
  const href = el.href || attr(el, 'href');
  return V.isPlausibleWebsite(href) ? href : '';
}

/**
 * Text-fallback phone patterns — used only when the card exposes no
 * dedicated phone control (button/anchor). Google frequently prints the
 * number as plain visible text on the card (often sharing a line with hours
 * or status) rather than as a `data-item-id`/`tel:` element, which is why a
 * selector-only extractor misses numbers a user can plainly see.
 *
 * INTL is anchored on a literal "+" so it can never match a street number,
 * ZIP code or price. NA is the North-American 3-3-4 grouping carried over
 * unchanged from the extraction logic that reliably found these before this
 * card-first rewrite.
 */
const CARD_PHONE_INTL_RE = /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d){6,13}/;
const CARD_PHONE_NA_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

/** Business phone from the card, or '' if absent/rejected. */
export function extractCardPhone(cardEl) {
  const el = queryFirst(S.CARD_PHONE, cardEl);
  if (el) {
    const itemId = attr(el, 'data-item-id');
    const fromId = itemId.replace(/^phone:tel:/, '');
    if (fromId && fromId !== itemId && V.isPlausiblePhone(fromId)) return fromId;

    const fromHref = attr(el, 'href').replace(/^tel:/i, '');
    if (V.isPlausiblePhone(fromHref)) return fromHref;

    const fromAria = attr(el, 'aria-label').replace(/^Phone:\s*/i, '');
    if (V.isPlausiblePhone(fromAria)) return fromAria;
  }

  // No selector matched (or what it held wasn't a plausible number) — look
  // for a phone-shaped run of text anywhere on the card before giving up.
  const cardText = text(cardEl);
  if (cardText) {
    const intl = cardText.match(CARD_PHONE_INTL_RE);
    if (intl && V.isPlausiblePhone(intl[0])) return intl[0].trim();

    const na = cardText.match(CARD_PHONE_NA_RE);
    if (na && V.isPlausiblePhone(na[0])) return na[0].trim();
  }

  return '';
}

/* ==================================================================== *
 * DOM READER
 * ==================================================================== */

/**
 * Read one card element into a raw record.
 * Returns null only when the card has no place link (i.e. it is not a card).
 */
export function parseCard(cardEl, serial) {
  if (!cardEl) return null;

  const link = queryFirst(S.CARD_LINK, cardEl);
  const href = link ? link.href : '';
  if (!href) return null;

  const identity = parsePlaceIdentity(href);

  // Name: the anchor's aria-label is the cleanest source; the heading node and
  // the first body line are fallbacks.
  let businessName =
    attr(link, 'aria-label') ||
    text(queryFirst(S.CARD_TITLE, cardEl));
  if (!businessName) {
    businessName = (text(queryFirst(S.CARD_BODY, cardEl)).split('\n')[0] || '').trim();
  }
  businessName = businessName.replace(/\s+/g, ' ').trim();

  // Rating: prefer the ARIA label on the star widget.
  let rating = '';
  let reviewCount = '';
  const starEl = queryFirst(S.CARD_RATING_HOST, cardEl);
  const aria = attr(starEl, 'aria-label');
  if (aria) {
    const r = parseRatingFromAria(aria);
    if (r != null) rating = r;
    const n = parseReviewsFromAria(aria);
    if (n != null) reviewCount = n;
  }

  const bodyText = text(queryFirst(S.CARD_BODY, cardEl)) || text(cardEl);

  if (!rating || !reviewCount) {
    // Text fallback: find the line that actually looks like a rating line.
    const line = bodyText
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^\d{1,2}[.,]\d\s*(\(|$)/.test(l) || /^\d{1,2}[.,]\d\s*\(\s*[\d.,]+\s*\)/.test(l));
    const parsed = parseRatingAndReviews(line || bodyText);
    if (!rating && parsed.rating) rating = parsed.rating;
    if (!reviewCount && parsed.reviewCount) reviewCount = parsed.reviewCount;
  }

  const { category, addressLine } = parseCategoryAndAddressLine(bodyText);

  return {
    serial,
    businessName,
    category,
    rating,
    reviewCount,
    address: addressLine,          // short street line from the card
    fullAddress: '',               // filled by detail resolution when the card lacks it
    website: extractCardWebsite(cardEl),   // '' when Google doesn't render it on the card
    phone: extractCardPhone(cardEl),       // '' when Google doesn't render it on the card
    mapsUrl: href,
    placeId: identity.placeId || '',
    cid: identity.cid || '',
    latitude: identity.latitude || '',
    longitude: identity.longitude || '',
    dedupeUrl: identity.clean || href,
  };
}
