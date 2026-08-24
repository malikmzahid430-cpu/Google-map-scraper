/**
 * ============================================================================
 * GOOGLE MAPS SELECTOR REGISTRY  —  the only file that knows Maps' DOM.
 * ============================================================================
 *
 * Google regenerates its class names frequently. Every entry below is an
 * ORDERED list; `dom.js:queryFirst()` walks it and takes the first hit.
 *
 * Ordering rule, most durable first:
 *     1. role / semantic attribute   (role="feed", role="main")
 *     2. ARIA label                  (aria-label="Results for …")
 *     3. href / data-item-id shape   (a[href*="/maps/place/"])
 *     4. structural position         ([role="feed"] > div > div)
 *     5. generated class name        (.fontBodyMedium, .m6QErb)  ← most brittle
 *
 * WHEN MAPS BREAKS: this is the only file you should need to edit. Add the new
 * selector at the TOP of the relevant array. Do not delete the old ones — they
 * still work for users on an older Maps rollout.
 */

/** The scrollable results list on a /maps/search/ page. */
export const FEED = [
  '[role="feed"]',                              // stable since 2022
  'div[aria-label^="Results for"]',             // ARIA fallback
  'div[aria-label*="Results"][tabindex]',
  '.m6QErb[aria-label]',                        // brittle: generated class
  '.section-scrollbox',                         // legacy Maps
];

/**
 * One business card inside the feed.
 * The `> div > div[jsaction]` shape has been stable for years; the anchor-based
 * fallback survives structural changes because every card links to a place.
 */
export const CARD = [
  '[role="feed"] > div > div[jsaction]',
  '[role="feed"] div[jsaction][class]:has(a[href*="/maps/place/"])',
  'div[role="article"]',
  '.Nv2PK',                                     // brittle: generated class
];

/** The place link inside a card — also our stable identity for the record. */
export const CARD_LINK = [
  'a[href*="/maps/place/"]',
  'a[href^="https://www.google.com/maps/place"]',
  'a[aria-label][href]',
];

/**
 * The card's text block. We read the ARIA label first because it is
 * locale-tagged and unambiguous ("4.6 stars 37 Reviews"); innerText is a
 * fallback because its line order changes between Maps experiments.
 */
export const CARD_TITLE = [
  '.fontHeadlineSmall',
  'div[role="heading"]',
  'a[aria-label]',
];

export const CARD_RATING_HOST = [
  'span[role="img"][aria-label*="star"]',
  'span[aria-label*="star"]',
  'span[aria-label*="étoile"]',                 // fr
  'span[aria-label*="Stern"]',                  // de
  '.MW4etd',                                    // brittle: rating text node
];

export const CARD_REVIEW_COUNT = [
  '.UY7F9',                                     // brittle: "(37)" node
  'span[aria-label*="review"]',
];

export const CARD_BODY = [
  '.fontBodyMedium',
  'div[jsinstance] > div:nth-child(2)',
];

/* -------------------------------------------------------------------------
 * PLACE DETAIL PANEL — used by the DOM fallback path when the HTTP parser
 * cannot resolve a field. `data-item-id` is the most durable hook Maps has.
 * ------------------------------------------------------------------------- */
export const DETAIL_PANEL = [
  'div[role="main"][aria-label]',
  '.m6QErb.WNBkOb',
];

export const DETAIL_ADDRESS = [
  'button[data-item-id="address"]',
  '[data-item-id="address"]',
  'button[aria-label^="Address:"]',
  'button[data-tooltip="Copy address"]',
];

export const DETAIL_WEBSITE = [
  'a[data-item-id="authority"]',
  '[data-item-id="authority"]',
  'a[aria-label^="Website:"]',
  'a[data-tooltip="Open website"]',
];

export const DETAIL_PHONE = [
  'button[data-item-id^="phone:tel:"]',
  '[data-item-id^="phone:tel:"]',
  'button[aria-label^="Phone:"]',
  'button[data-tooltip="Copy phone number"]',
];

export const DETAIL_TITLE = [
  'h1.DUwDvf',
  'div[role="main"] h1',
  'h1',
];

export const DETAIL_CATEGORY = [
  'button[jsaction*="category"]',
  '.DkEaL',
];

export const DETAIL_RATING = [
  'div.F7nice span[aria-hidden="true"]',
  'span[role="img"][aria-label*="star"]',
];

export const DETAIL_BACK = [
  'button[aria-label="Back"]',
  'button[jsaction*="omnibox.back"]',
  'button.hYBOP',
];

/** The end-of-results sentinel Maps appends to the feed. */
export const END_OF_LIST_TEXT = [
  "you've reached the end of the list",
  'you have reached the end of the list',
  'end of the list',
];

/** Search box — used to label the job with the query the user actually ran. */
export const SEARCH_INPUT = [
  'input#searchboxinput',
  'input.searchboxinput',
  'input[aria-label="Search Google Maps"]',
  'input[name="q"]',
];

/** Anything matching these is a Maps chrome element, never a business card. */
export const CARD_REJECT_TEXT = [
  'sponsored',
  'ad ·',
];
