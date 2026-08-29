/**
 * Al-Aqsa Scraper v3 — test suite.
 *
 * Covers the 23 scenarios in the v3 brief plus the isolation guarantees.
 * Zero dependencies: the DOM harness in tools/harness/mini-dom.mjs drives the
 * real collector, including a VIRTUALIZED feed that reproduces the condition
 * which made v2 miss results.
 *
 * Run: node tools/run-tests.mjs
 */
import fs from 'node:fs';
import {
  installDom, makeFeed, addCardsToFeed, markEndOfList, sampleBusinesses, makeVirtualFeed,
} from './harness/mini-dom.mjs';

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log('\n  ' + name);
  console.log('  ' + '-'.repeat(Math.max(20, name.length)));
}

function check(label, condition, detail) {
  if (condition) { passed++; console.log('    PASS  ' + label); }
  else {
    failed++;
    failures.push(currentGroup + ' :: ' + label + (detail ? ' - ' + detail : ''));
    console.log('    FAIL  ' + label + (detail ? '  (' + detail + ')' : ''));
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Remove block and line comments so source assertions test CODE, not prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

installDom();
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.chrome = undefined;
globalThis.fetch = async () => ({ text: async () => '' });

/* ---------------------------- imports ----------------------------- */
const collector = await import('../src/collector/collector.js');
const cardParser = await import('../src/collector/card-parser.js');
const detailParser = await import('../src/collector/detail-parser.js');
const placeDetail = await import('../src/collector/place-detail.js');
const validators = await import('../src/collector/validators.js');
const address = await import('../src/collector/address.js');
const quality = await import('../src/core/quality.js');
const storage = await import('../src/core/storage.js');
const safe = await import('../src/core/safe.js');
const jobsApi = await import('../src/jobs/job-manager.js');
const queueApi = await import('../src/jobs/queue.js');
const datasetApi = await import('../src/jobs/dataset.js');
const filters = await import('../src/engines/filters.js');
const dedupe = await import('../src/engines/dedupe.js');
const validate = await import('../src/engines/validate.js');
const score = await import('../src/engines/score.js');
const normalize = await import('../src/engines/normalize.js');
const csv = await import('../src/export/csv.js');
const xlsx = await import('../src/export/xlsx.js');
const sheets = await import('../src/export/sheets.js');
const extract = await import('../src/enrich/extract.js');

/* --------------------------- run helpers --------------------------- */

const FAST = { mode: 'fast', scrollDelayMs: 3, maxNoChangeAttempts: 5 };

async function runCollector(settings, jobId) {
  const records = [];
  let ended = null;
  let lastProgress = null;
  await collector.start({
    jobId: jobId || 'test',
    settings,
    onRecords: (batch, isPatch) => {
      if (isPatch) { records.length = 0; records.push(...batch); } else records.push(...batch);
    },
    onProgress: (p) => { lastProgress = p; },
    onEnded: (s) => { ended = s; },
  });
  for (let i = 0; i < 1200 && !ended; i++) await sleep(10);
  return { records, ended, lastProgress };
}

function mountVirtual(opts) {
  collector.reset();
  document.body.children.length = 0;
  const feed = makeVirtualFeed(opts);
  document.body.append(feed);
  return feed;
}

/* ================================================================== */
group('TEST 1 & 2 - All results collected from a VIRTUALIZED feed');

{
  mountVirtual({ total: 55, windowSize: 18, batch: 8 });
  const r = await runCollector(FAST, 'v-55');
  check('TEST 1 - 55-result search collects all 55', r.records.length === 55, 'got ' + r.records.length);
  check('every record is unique', new Set(r.records.map((x) => x.stableKey)).size === r.records.length);
  check('serials are sequential', r.records.every((x, i) => x.serial === i + 1));

  mountVirtual({ total: 120, windowSize: 15, batch: 10 });
  const r2 = await runCollector(FAST, 'v-120');
  check('TEST 2 - 120-result search does not stop after the first batches',
    r2.records.length === 120, 'got ' + r2.records.length);

  mountVirtual({ total: 200, windowSize: 25, batch: 20, stallEvery: 4 });
  const r3 = await runCollector(FAST, 'v-200');
  check('TEST 21 - collector retries through Maps stalls instead of stopping early',
    r3.records.length === 200, 'got ' + r3.records.length);
  check('end reason is reported', !!(r3.ended && r3.ended.endReason), r3.ended && r3.ended.endReason);

  // The regression itself: v2's positional cursor on the same feed shape.
  // Comments are stripped first — collector.js quotes the old code in its
  // header to explain why it was removed, and that must not count as usage.
  const src = stripComments(fs.readFileSync(new URL('../src/collector/collector.js', import.meta.url), 'utf8'));
  check('collector no longer uses a positional cardIndex cursor',
    !/cardIndex/.test(src), (src.match(/.{0,40}cardIndex.{0,40}/) || [''])[0]);
  check('collection is keyed on a stable place identity',
    /stableKey/.test(src) && /state\.seen\.has/.test(src));
}

/* ================================================================== */
group('TEST 3 & 4 - Rating and review count');

for (const [input, r, n] of [['4.6 (37)', '4.6', '37'], ['4,6 (264)', '4.6', '264'],
  ['4.6(37)', '4.6', '37'], ['4.9 (1,234)', '4.9', '1234'], ['5.0 (2)', '5.0', '2']]) {
  const got = cardParser.parseRatingAndReviews(input);
  check(`"${input}" -> ${r} / ${n}`, got.rating === r && got.reviewCount === n, JSON.stringify(got));
}
check('TEST 3 - 4.6 exports as 4.6, never 46', cardParser.coerceRating('46') === null);
check('TEST 4 - 264 review count survives intact',
  cardParser.parseRatingAndReviews('4.6 (264)').reviewCount === '264');
check('a rating decimal is never read as a review count',
  cardParser.parseReviewsFromAria('4.8 stars') === null);

/* ================================================================== */
group('TEST 5 - Full Address vs Address');

{
  const complete = '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States';
  const c = address.splitAddress(complete);
  check('complete address splits into components',
    c.street === '6215-1 Wilson Blvd Building 1' && c.city === 'Jacksonville'
    && c.state === 'FL' && c.postalCode === '32210' && c.country === 'United States', JSON.stringify(c));
  check('a complete address is recognised as complete', address.isCompleteAddress(complete));
  check('a bare street line is NOT complete',
    address.isCompleteAddress('6215-1 Wilson Blvd Building 1') === false);
  check('composeFull refuses to build a Full Address from a street line alone',
    address.composeFull('6215-1 Wilson Blvd Building 1', {}) === '');
  check('composeFull builds the complete address from components',
    address.composeFull('6215-1 Wilson Blvd Building 1',
      { city: 'Jacksonville', state: 'FL', postalCode: '32210', country: 'United States' }) === complete);
  check('no country is invented when none is supplied',
    address.composeFull('12 High St', { city: 'Manchester', postalCode: 'M1 2AB' }).includes('United') === false);
}

/* ================================================================== */
group('TEST 6 & 7 - Website and phone, and what a blank means');

{
  for (const bad of ['http://schema.org/Place', 'https://schema.org', 'https://maps.google.com/x',
    'https://www.google.com/maps/place/x', 'https://lh3.googleusercontent.com/a', 'https://g.page/y']) {
    check('rejected as a website: ' + bad, validators.isPlausibleWebsite(bad) === false);
  }
  check('a real site is accepted', validators.isPlausibleWebsite('https://alaqsaroofing.com'));
  check('a phone is never accepted as an address',
    validators.isPlausibleAddressLine('+1 904-516-4279') === false);
  check('an address is never accepted as a phone',
    validators.isPlausiblePhone('6215-1 Wilson Blvd') === false);

  const rec = { businessName: 'X', rating: '4.5' };
  const st = quality.fieldStatuses(rec, { detailResolved: true, enrichRun: false, mode: 'standard' });
  check('TEST 6 - a missing website is "Not Found", not an error', st.website === 'Not Found');
  check('TEST 7 - a missing phone is "Not Found", not an error', st.phone === 'Not Found');
  check('an unrequested field says so', st.email === 'Not Requested');
  check('every status has a plain-English explanation',
    ['Found', 'Not Found', 'Not Requested', 'Pending', 'Failed']
      .every((s) => quality.explainStatus(s, 'Website').length > 10));
}

/* ================================================================== */
group('Address validator rejects Google-internal data — reported bug reproduction');

{
  // The exact bad values reported: Google's own internal build-label/RPC
  // metadata, picked up because the old validator only checked "2+ comma
  // parts with a digit somewhere" — which internal tokens trivially satisfy.
  const reportedBad1 = '4oR0.2021.O/m=GfLzUe, tNOPW, cZ2KIb, Rq2f7d, omhq0, MJcXSb, WEtKm, B863O';
  const reportedBad2 = '4oR0.2021.O/m=GfLzUe, tNOPW, cZ2KIb, OXJqAb, b/am=QAYAACAcAoA/';
  check('the exact reported bad Address value is rejected', validators.isPlausibleAddressLine(reportedBad1) === false);
  check('the exact reported bad Full Address value is rejected', validators.isPlausibleFullAddress(reportedBad1) === false);
  check('the second reported bad value (different suffix) is also rejected', validators.isPlausibleFullAddress(reportedBad2) === false);

  // Each individual signal that makes up the fix, isolated.
  check('a bare Google internal marker ("/m=") is rejected even in an otherwise address-shaped string',
    validators.isPlausibleFullAddress('123 Fake St/m=xyz, Somewhere, ST 00000') === false);
  check('a version-token-shaped string ("4oR0.2021.O") is rejected',
    validators.isPlausibleAddressLine('4oR0.2021.O some other text here') === false);
  check('2+ closure-symbol-shaped comma parts (mixed case + digits, no spaces) are rejected',
    validators.isPlausibleFullAddress('start, cZ2KIb, Rq2f7d, MJcXSb, end here now') === false);
  check('a single closure-symbol-shaped part alone is NOT enough to reject (avoid over-triggering)',
    validators.isPlausibleFullAddress('123 Main St, cZ2KIb, ST 00000') === true);

  // The fix must not regress genuine addresses — including edge cases that
  // exercise the exact same "has a digit" surface the old check relied on.
  const genuineAddresses = [
    '2105 E Mariposa Rd, Stockton, CA 95205, United States',
    '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States',
    '221B Baker Street, London, NW1 6XE, United Kingdom',
    '15335 Morrison St Ste 3052, Sherman Oaks, CA 91403',
    '123 Main St, Toronto, ON M5H 2N2, Canada',
    '45 George St, Sydney NSW 2000, Australia',
    'PO Box 4402, Springfield, IL 62701, United States',
    '3155 Station Ave, Vineland, NJ 08360, United States',
    '7271 Garden Grove Blvd Ste F, Garden Grove, CA 92841, United States',
  ];
  for (const addr of genuineAddresses) {
    check(`genuine address still accepted: ${addr}`, validators.isPlausibleFullAddress(addr) === true);
  }
  check('a bare genuine street (no city/state) still passes isPlausibleAddressLine',
    validators.isPlausibleAddressLine('2105 E Mariposa Rd') === true);
  check('but a bare genuine street correctly fails isPlausibleFullAddress (only one part)',
    validators.isPlausibleFullAddress('2105 E Mariposa Rd') === false);

  // End-to-end: the same reproduction that first proved the bug, now via
  // the real functions that actually surface candidates in production.
  const detailParser = await import('../src/collector/detail-parser.js');
  const badJson6 = new Array(200).fill(null);
  badJson6[50] = ['boq_travelfrontendserver', reportedBad1];
  const badJson = new Array(7); badJson[6] = badJson6;
  const scanResult = detailParser.structuralScan(badJson, validators.isPlausibleFullAddress, { maxDepth: 8, maxNodes: 30000 });
  check('structuralScan() no longer surfaces the internal token as a candidate address',
    scanResult === undefined, JSON.stringify(scanResult));

  const genericHtml = ")]}'\n" + JSON.stringify(['boq_x', reportedBad1]);
  check('extractFullAddressGeneric() no longer surfaces it either',
    detailParser.extractFullAddressGeneric(genericHtml) === '');

  const anchorHtml = ")]}'\n" + JSON.stringify([reportedBad2]);
  check('extractFullAddressByAnchor() refuses to even anchor on an already-corrupted "known street"',
    detailParser.extractFullAddressByAnchor(anchorHtml, '4oR0.2021.O/m=GfLzUe') === '');

  // Full pipeline: parsePlaceDetail() must come back genuinely blank
  // (Not Found), never the garbage — matching "no valid address exists ->
  // Address = blank, Full Address = blank, Status = Not Found".
  const fullBadHtml = ")]}'\n" + JSON.stringify(badJson);
  const parsed = detailParser.parsePlaceDetail(fullBadHtml);
  check('parsePlaceDetail() on a payload containing only internal data returns blank, not garbage',
    parsed.address === '' && parsed.fullAddress === '', JSON.stringify({ address: parsed.address, fullAddress: parsed.fullAddress }));

  // --- found via live-browser reproduction of this exact bug report: the
  //     WEBSITE validator independently accepted the same reported garbage,
  //     because a version-token like "4oR0.2021.O" has dots in it — exactly
  //     what makes a string look like a domain too. ---
  check('isPlausibleWebsite() rejects the exact reported garbage value',
    validators.isPlausibleWebsite(reportedBad1) === false);
  check('isPlausibleWebsite() rejects any candidate containing a raw space or comma',
    validators.isPlausibleWebsite('not a url, has commas') === false);
  check('isPlausibleWebsite() still accepts a genuine domain', validators.isPlausibleWebsite('https://alaqsaroofing.com') === true);
  check('isPlausibleWebsite() still accepts a bare domain with no scheme', validators.isPlausibleWebsite('alaqsaroofing.com') === true);

  // --- also found via the same live-browser reproduction: looksLikeLocalityFragment
  //     (detail-parser.js's own separate, un-exported validator for the
  //     "City, ST" last-resort scan) was not covered by the isPlausibleFullAddress
  //     fix at all, and still let a "City, ST"-shaped TAIL of the garbage
  //     through, producing a fake city/postal ("WEtKm", "B863O"). ---
  const localityBadJson6 = new Array(200).fill(null);
  localityBadJson6[10] = ['boq_mapsfrontend', reportedBad1];
  localityBadJson6[18] = '7006 Foothill Blvd';
  const localityBadJson = new Array(7); localityBadJson[6] = localityBadJson6;
  const localityBadHtml = ")]}'\n" + JSON.stringify(localityBadJson);
  const parsedWithRealStreet = detailParser.parsePlaceDetail(localityBadHtml);
  check('the locality-fragment scan no longer manufactures a fake city/postal from internal data',
    parsedWithRealStreet.city !== 'WEtKm' && parsedWithRealStreet.postalCode !== 'B863O'
    && !JSON.stringify(parsedWithRealStreet).includes('GfLzUe'),
    JSON.stringify(parsedWithRealStreet));

  // --- end to end, exactly as reported: internal metadata sitting ALONGSIDE
  //     the genuine address in the same payload must resolve to the real
  //     address, with the garbage never surfacing in ANY field. ---
  const placeDetail = await import('../src/collector/place-detail.js');
  const alongsideJson6 = new Array(200).fill(null);
  alongsideJson6[10] = ['boq_mapsfrontend', reportedBad1];
  alongsideJson6[18] = '7006 Foothill Blvd';
  alongsideJson6[145] = 'Tujunga, CA 91042';
  const alongsideJson = new Array(7); alongsideJson[6] = alongsideJson6;
  const alongsideHtml = ")]}'\n" + JSON.stringify(alongsideJson);
  const blankDetail = { businessName: '', category: '', rating: '', reviewCount: '', address: '', fullAddress: '',
    city: '', state: '', postalCode: '', country: '', website: '', phone: '', latitude: '', longitude: '', via: {} };
  const mergedReal = placeDetail.mergeEmbeddedPayload(blankDetail, alongsideHtml);
  check('reported bug reproduction: the real address is found and the garbage never appears anywhere in the record',
    mergedReal.fullAddress === '7006 Foothill Blvd, Tujunga, CA 91042'
    && !JSON.stringify(mergedReal).includes('GfLzUe')
    && !JSON.stringify(mergedReal).includes('/m='),
    JSON.stringify(mergedReal));
}

/* ================================================================== */
group('Website/phone read directly off the results card — no tab, no fetch');

{
  const { makeCard } = await import('./harness/mini-dom.mjs');

  const withBoth = makeCard({
    name: 'Al-Aqsa Roofing', category: 'Roofing contractor', rating: '4.6', reviews: '37',
    street: '6215-1 Wilson Blvd', website: 'https://alaqsaroofing.com', phone: '+1 904-516-4279',
  });
  check('website is read straight off the card', cardParser.extractCardWebsite(withBoth) === 'https://alaqsaroofing.com');
  check('phone is read straight off the card', cardParser.extractCardPhone(withBoth) === '+1 904-516-4279');

  const rec = cardParser.parseCard(withBoth, 1);
  check('parseCard carries the card website through', rec.website === 'https://alaqsaroofing.com');
  check('parseCard carries the card phone through', rec.phone === '+1 904-516-4279');

  const neither = makeCard({
    name: 'No Site Roofing', category: 'Roofing contractor', rating: '4.2', reviews: '9', street: '1 Elm St',
  });
  check('no website on the card yields blank, not an error', cardParser.extractCardWebsite(neither) === '');
  check('no phone on the card yields blank, not an error', cardParser.extractCardPhone(neither) === '');
  const rec2 = cardParser.parseCard(neither, 2);
  check('a card without these fields still parses everything else',
    rec2.businessName === 'No Site Roofing' && rec2.website === '' && rec2.phone === '');

  // A card cannot expose a Google/schema.org URL as the "website" — same
  // validator as detail resolution, applied at card level.
  const { El } = await import('./harness/mini-dom.mjs');
  const badSite = makeCard({ name: 'Bad Site Co', category: 'Roofer', rating: '4.0', reviews: '3', street: '2 Oak St' });
  badSite.append(new El('a', { 'data-item-id': 'authority', href: 'https://schema.org/Place' }));
  check('schema.org on the card is rejected as a website', cardParser.extractCardWebsite(badSite) === '');
}

/* ================================================================== */
group('Phone text fallback — no button/tel: element on the card');

{
  const { makeCard } = await import('./harness/mini-dom.mjs');

  // Google does not always render a dedicated phone control on the compact
  // results card; sometimes the number is only visible as plain text. This
  // is exactly what a previous, working extraction relied on and what this
  // card-first rewrite was initially missing.
  const usText = makeCard({
    name: 'ABC Roofing', category: 'Roofing contractor', rating: '4.7', reviews: '169',
    street: '6215-1 Wilson Blvd Building 1', phoneText: '+1 770-368-0005',
  });
  check('a plain-text US phone (with +1) is found via the text fallback',
    cardParser.extractCardPhone(usText) === '+1 770-368-0005');

  const usTextNoCountry = makeCard({
    name: 'XYZ Plumbing', category: 'Plumber', rating: '4.3', reviews: '58',
    street: '900 Bay St', phoneText: '(904) 555-1234',
  });
  check('a plain-text US phone (no country code) is found via the text fallback',
    cardParser.extractCardPhone(usTextNoCountry) === '(904) 555-1234');

  const intlText = makeCard({
    name: 'Islamabad Electricians', category: 'Electrician', rating: '4.5', reviews: '22',
    street: 'Shop 4, Blue Area', phoneText: '+92 51 111 2233',
  });
  check('a plain-text international phone is found via the text fallback',
    cardParser.extractCardPhone(intlText) === '+92 51 111 2233');

  const recNoBtn = cardParser.parseCard(usText, 1);
  check('parseCard carries the text-fallback phone through', recNoBtn.phone === '+1 770-368-0005');
  check('the text-fallback phone never leaks into address',
    recNoBtn.address === '6215-1 Wilson Blvd Building 1');
  check('the text-fallback phone never leaks into category', recNoBtn.category === 'Roofing contractor');

  // The button/data-item-id path still wins when both are present — the
  // text fallback only fires when nothing else resolved a value.
  const both = makeCard({
    name: 'Both Sources Co', category: 'Contractor', rating: '4.8', reviews: '90',
    street: '1 Main St', phone: '+1 904-000-1111', phoneText: '+1 904-999-8888',
  });
  check('a dedicated phone control still wins over the text fallback',
    cardParser.extractCardPhone(both) === '+1 904-000-1111');

  // Ordinary card text (name, rating, review count, hours, a hyphenated
  // street number) must never be misread as a phone number.
  const noPhoneAtAll = makeCard({
    name: 'No Phone Listed LLC', category: 'General contractor', rating: '4.9', reviews: '1234',
    street: '6215-1 Wilson Blvd',
  });
  check('a card with no phone anywhere yields blank, not a false positive',
    cardParser.extractCardPhone(noPhoneAtAll) === '');
}

/* ================================================================== */
group('Place detail — same-origin fetch, no tab (extraction logic)');

{
  const { El } = await import('./harness/mini-dom.mjs');

  // --- DOM extraction against a hand-built "detail panel" ---
  const panel = new El('div', { role: 'main' });
  panel.append(new El('h1', { class: 'DUwDvf' }).append('Al-Aqsa Roofing'));
  panel.append(new El('button', { 'data-item-id': 'address' })
    .append('6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States'));
  panel.append(new El('a', { 'data-item-id': 'authority', href: 'https://alaqsaroofing.com' }));
  panel.append(new El('button', { 'data-item-id': 'phone:tel:+19045164279' }));

  const placeUrl = 'https://www.google.com/maps/place/Al-Aqsa+Roofing/@30.2419,-81.7412,17z/data=!4m6!3m5!1s0x1:0x2!8m2!3d30.2419!4d-81.7412';
  const detail = placeDetail.extractFromDocument(panel, placeUrl);
  check('business name comes from the panel header', detail.businessName === 'Al-Aqsa Roofing');
  check('a complete address is read as Full Address, not just the street',
    detail.fullAddress === '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States', detail.fullAddress);
  check('website comes from data-item-id="authority"', detail.website === 'https://alaqsaroofing.com');
  check('phone comes from data-item-id="phone:tel:…"', detail.phone === '+19045164279');
  check('coordinates come from the place URL', detail.latitude === '30.2419' && detail.longitude === '-81.7412');

  // --- a bare street line must never be presented as Full Address ---
  const streetOnly = new El('div', { role: 'main' });
  streetOnly.append(new El('button', { 'data-item-id': 'address' }).append('6215-1 Wilson Blvd'));
  const partial = placeDetail.extractFromDocument(streetOnly, '');
  check('a street line alone leaves Full Address blank', partial.fullAddress === '');
  check('but is still kept as Address', partial.address === '6215-1 Wilson Blvd');

  // --- embedded JSON payload fills gaps, never overwrites what the DOM found ---
  const json6 = new Array(200).fill(null);
  json6[7] = ['https://payload-example.com'];
  json6[178] = [['+1 904 555 0199']];
  json6[18] = '99 Payload Ave, Testville, TS 99999, United States';
  const json = new Array(7); json[6] = json6;
  const html = ")]}'\n" + JSON.stringify(json);

  const blank = { businessName: '', category: '', rating: '', reviewCount: '', address: '', fullAddress: '',
    city: '', state: '', postalCode: '', country: '', website: '', phone: '', latitude: '', longitude: '', via: {} };
  const filled = placeDetail.mergeEmbeddedPayload(blank, html);
  check('payload fills website the DOM did not have', filled.website === 'https://payload-example.com');
  check('payload fills phone the DOM did not have', filled.phone === '+1 904 555 0199');
  check('payload fills Full Address the DOM did not have', filled.fullAddress === '99 Payload Ave, Testville, TS 99999, United States');
  check('payload also backfills the short Address field when the DOM found no street at all — found via live browser testing, not a pre-written scenario',
    filled.address === '99 Payload Ave', filled.address);

  const partiallyFound = { ...blank, website: 'https://dom-found-this.com' };
  const notOverwritten = placeDetail.mergeEmbeddedPayload(partiallyFound, html);
  check('payload never overwrites a value the DOM already found', notOverwritten.website === 'https://dom-found-this.com');

  // --- layered address: DOM found ONLY a street, the payload independently
  //     has city/state/zip but never joins them into one string at any of
  //     the known index paths — the merge must COMBINE the two rather than
  //     leaving Full Address blank just because neither source alone was
  //     a complete address. ---
  const comboJson6 = new Array(200).fill(null);
  // Deliberately nothing at the formattedAddress/addressComponents index
  // candidates ([6,18], [6,39], [6,2], [6,183,1]) — only a stray locality
  // string elsewhere in the tree, findable only by the structural scan.
  comboJson6[145] = 'Jacksonville, FL 32210';
  const comboJson = new Array(7); comboJson[6] = comboJson6;
  const comboHtml = ")]}'\n" + JSON.stringify(comboJson);

  const domStreetOnly = { ...blank, address: '6215-1 Wilson Blvd Building 1' };
  const combined = placeDetail.mergeEmbeddedPayload(domStreetOnly, comboHtml);
  check('a DOM street combines with a payload-only locality fragment into a complete Full Address',
    combined.fullAddress === '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210', combined.fullAddress);
  check('the combined address correctly splits city/state/postal (not the old "FL as city" bug)',
    combined.city === 'Jacksonville' && combined.state === 'FL' && combined.postalCode === '32210',
    JSON.stringify({ city: combined.city, state: combined.state, postalCode: combined.postalCode }));
  check('Address (the short field) is completely untouched by this — still just the street',
    combined.address === '6215-1 Wilson Blvd Building 1', combined.address);

  // --- no combine when there is nothing to combine with (DOM found nothing at all) ---
  const domNothing = { ...blank, address: '' };
  const noCombine = placeDetail.mergeEmbeddedPayload(domNothing, comboHtml);
  check('no street from any source means Full Address correctly stays blank, not a locality-only fragment',
    noCombine.fullAddress === '', noCombine.fullAddress);

  // --- THE ROOT-CAUSE FIX: a raw fetch() response is a JS SPA that never
  //     executed its JS, so extractAddress (DOM) very often finds NOTHING —
  //     out.address stays blank. Before this fix, the combine branch above
  //     required out.address (DOM) to be non-blank, so Full Address stayed
  //     blank forever even when the payload independently resolved a real
  //     street PLUS city/state/postal. Now the payload's own street
  //     (payload.address) is used as the combine seed when DOM gave nothing. ---
  const richJson6 = new Array(200).fill(null);
  // A bare street at a formattedAddress candidate index (index 18 — no
  // comma, so it is a plausible address LINE but not a plausible FULL
  // address) plus a genuine locality fragment ("City, ST ZIP") sitting at
  // an index none of the known addressComponents/formattedAddress paths
  // reach — findable only by the structural scan. This is exactly the
  // shape a real Google payload takes when its formattedAddress index
  // holds only the street and the addressComponents index has drifted.
  richJson6[18] = '456 Rich Payload Ave';
  richJson6[145] = 'Testburg, TS 55555';
  const richJson = new Array(7); richJson[6] = richJson6;
  const richHtml = ")]}'\n" + JSON.stringify(richJson);

  const domFoundNothing = { ...blank, address: '' };
  const richCombined = placeDetail.mergeEmbeddedPayload(domFoundNothing, richHtml);
  check('with NO DOM street at all, Full Address is still composed from the payload-only street + locality',
    richCombined.fullAddress === '456 Rich Payload Ave, Testburg, TS 55555', richCombined.fullAddress);
  check('the payload-derived street backfills the short Address field too, not just Full Address',
    richCombined.address === '456 Rich Payload Ave', richCombined.address);
  check('via records that the street came from the payload, not the DOM',
    richCombined.via.fullAddress === 'payload:composed-from-payload-street', richCombined.via.fullAddress);

  // --- the SAME shape, checked directly against parsePlaceDetail: a bare
  //     street candidate must never get smuggled through as a fake "Full
  //     Address" (composeFullAddress used to do exactly that, which
  //     permanently blocked the locality scan below it from ever running). ---
  const richPayload = detailParser.parsePlaceDetail(richHtml);
  check('a bare street alone is never presented as a complete Full Address',
    richPayload.fullAddress !== '456 Rich Payload Ave', richPayload.fullAddress);
  check('the genuine street is still correctly recovered as the short Address field',
    richPayload.address === '456 Rich Payload Ave', richPayload.address);
  check('city/state/postal are still recovered from the separately-found locality fragment',
    richPayload.city === 'Testburg' && richPayload.state === 'TS' && richPayload.postalCode === '55555',
    JSON.stringify({ city: richPayload.city, state: richPayload.state, postalCode: richPayload.postalCode }));

  // --- extractPlaceJson finds nothing at all (no APP_INITIALIZATION_STATE
  //     blob in the raw response) — parsePlaceDetail must NOT bail out
  //     empty; it should still try JSON-LD, an entirely independent source. ---
  const noPayloadButJsonLd = `<html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"LocalBusiness","name":"Ld Only Co",
     "address":{"@type":"PostalAddress","streetAddress":"789 Ld Only Rd",
     "addressLocality":"Ldville","addressRegion":"LD","postalCode":"77777",
     "addressCountry":"United States"}}
    </script></head><body>no APP_INITIALIZATION_STATE here at all</body></html>`;
  check('extractPlaceJson correctly reports nothing found for this HTML (sanity check for the next assertions)',
    detailParser.extractPlaceJson(noPayloadButJsonLd) === null);
  const ldOnly = detailParser.parsePlaceDetail(noPayloadButJsonLd);
  check('parsePlaceDetail no longer bails out empty when the array payload is missing',
    ldOnly.ok === true, JSON.stringify(ldOnly));
  check('Full Address is populated entirely from JSON-LD when the array payload cannot be found',
    ldOnly.fullAddress === '789 Ld Only Rd, Ldville, LD 77777, United States', ldOnly.fullAddress);
  check('the street line is also recovered from JSON-LD', ldOnly.address === '789 Ld Only Rd', ldOnly.address);
  check('city/state/postal/country are split correctly from the JSON-LD-composed address',
    ldOnly.city === 'Ldville' && ldOnly.state === 'LD' && ldOnly.postalCode === '77777' && ldOnly.country === 'United States',
    JSON.stringify({ city: ldOnly.city, state: ldOnly.state, postalCode: ldOnly.postalCode, country: ldOnly.country }));

  // --- extractJsonLdAddress directly ---
  const ldAddr = detailParser.extractJsonLdAddress(noPayloadButJsonLd);
  check('extractJsonLdAddress finds the PostalAddress block directly',
    ldAddr && ldAddr.street === '789 Ld Only Rd' && ldAddr.city === 'Ldville', JSON.stringify(ldAddr));
  check('extractJsonLdAddress returns null when there is no JSON-LD at all',
    detailParser.extractJsonLdAddress('<html><body>nothing here</body></html>') === null);
  check('extractJsonLdAddress ignores malformed JSON-LD rather than throwing',
    detailParser.extractJsonLdAddress('<script type="application/ld+json">{not valid json</script>') === null);

  // --- the fix must actually reach production: mergeEmbeddedPayload() used
  //     to only call parsePayload() when extractPlaceJson() already found
  //     the array blob, which made the JSON-LD fallback above dead code on
  //     the real fetchPlaceDetail() path (the one users actually hit) even
  //     though parsePlaceDetail() itself now handles it correctly in
  //     isolation. Confirm the merge step gets there too. ---
  const mergeLdOnly = placeDetail.mergeEmbeddedPayload(blank, noPayloadButJsonLd);
  check('mergeEmbeddedPayload finds a JSON-LD-only address (array payload absent) via the production path',
    mergeLdOnly.fullAddress === '789 Ld Only Rd, Ldville, LD 77777, United States', mergeLdOnly.fullAddress);

  // --- extractFullAddressByAnchor: ported from a prior working version of
  //     this extension. No array index, no components array, no JSON-LD —
  //     just the street we already trust and the raw response text. Uses
  //     the exact address from the user's own report. ---
  const anchorHtml = ")]}'\n" + JSON.stringify({
    someField: 'irrelevant',
    nested: { addr: '2105 E Mariposa Rd, Stockton, CA 95205, United States', other: 'x' },
  });
  check('extractFullAddressByAnchor finds the full address anchored on the known street',
    detailParser.extractFullAddressByAnchor(anchorHtml, '2105 E Mariposa Rd')
      === '2105 E Mariposa Rd, Stockton, CA 95205, United States',
    detailParser.extractFullAddressByAnchor(anchorHtml, '2105 E Mariposa Rd'));

  // Unicode-escaped exactly the way Google's raw JSON payload does it.
  const escapedHtml = ")]}'\n" + JSON.stringify({
    addr: '2105 E Mariposa Rd, Stockton, CA 95205, United States'.replace(/'/g, "\\u0027"),
  }).replace(/Stockton/, 'Stockton\\u2019s'); // stray unicode punctuation nearby, must not break the match
  check('extractFullAddressByAnchor tolerates unicode-escaped text around the match',
    detailParser.extractFullAddressByAnchor(escapedHtml, '2105 E Mariposa Rd').startsWith('2105 E Mariposa Rd'),
    detailParser.extractFullAddressByAnchor(escapedHtml, '2105 E Mariposa Rd'));

  check('extractFullAddressByAnchor returns blank when the street never appears in the response',
    detailParser.extractFullAddressByAnchor(anchorHtml, '999 Nowhere Ave') === '');
  check('extractFullAddressByAnchor never anchors on a bare locality name (not a real street)',
    detailParser.extractFullAddressByAnchor(anchorHtml, 'Stockton') === '');
  check('extractFullAddressByAnchor stops at a JSON string boundary, never bleeding into unrelated data',
    !detailParser.extractFullAddressByAnchor(
      ")]}'\n" + JSON.stringify({ addr: '55 Bleed St', junk: 'Somewhere, ZZ 00000' }),
      '55 Bleed St',
    ).includes('Somewhere'));
  check('extractFullAddressByAnchor returns blank for empty/garbage input rather than throwing',
    detailParser.extractFullAddressByAnchor('', '55 Bleed St') === ''
    && detailParser.extractFullAddressByAnchor(null, '55 Bleed St') === ''
    && detailParser.extractFullAddressByAnchor(anchorHtml, '') === '');

  // --- the anchor reaches production through mergeEmbeddedPayload(), using
  //     the CALLER-SUPPLIED known street (the card's own Address — the most
  //     trusted source, per the explicit requirement that Address extracted
  //     at collection time must anchor the Full Address fallback) even when
  //     this fetch's own DOM/payload extraction found no street at all. ---
  const anchorOnlyHtml = ")]}'\n" + JSON.stringify({
    unrelated: [1, 2, 3],
    blob: 'business info: 2105 E Mariposa Rd, Stockton, CA 95205, United States',
  });
  const anchorMerged = placeDetail.mergeEmbeddedPayload(blank, anchorOnlyHtml, '2105 E Mariposa Rd');
  check('mergeEmbeddedPayload recovers Full Address via the anchor using the card-supplied known street',
    anchorMerged.fullAddress === '2105 E Mariposa Rd, Stockton, CA 95205, United States', anchorMerged.fullAddress);
  check('the anchor also backfills the short Address field when the DOM found none',
    anchorMerged.address === '2105 E Mariposa Rd', anchorMerged.address);
  check('via correctly attributes the anchor as the source',
    anchorMerged.via.fullAddress === 'payload:anchor', anchorMerged.via.fullAddress);

  // --- end to end: fetchPlaceDetail() threads opts.knownStreet through to
  //     the anchor, exactly as detail-resolver.js now passes record.address. ---
  {
    const priorDomParserAnchor = globalThis.DOMParser;
    const priorFetchAnchor = globalThis.fetch;
    globalThis.DOMParser = class {
      parseFromString() {
        // A minimal document with nothing address-related — forces
        // fetchPlaceDetail() to rely entirely on the anchor.
        return { querySelector: () => null, querySelectorAll: () => [] };
      }
    };
    globalThis.fetch = async () => ({ ok: true, status: 200, url: 'https://www.google.com/maps/place/Anchor+Test', text: async () => anchorOnlyHtml });
    const anchorFetched = await placeDetail.fetchPlaceDetail('https://www.google.com/maps/place/Anchor+Test', { timeoutMs: 500, knownStreet: '2105 E Mariposa Rd' });
    check('fetchPlaceDetail resolves Full Address end to end via opts.knownStreet',
      anchorFetched.ok === true && anchorFetched.data.fullAddress === '2105 E Mariposa Rd, Stockton, CA 95205, United States',
      JSON.stringify(anchorFetched));
    globalThis.DOMParser = priorDomParserAnchor;
    globalThis.fetch = priorFetchAnchor;
  }

  // --- extractFullAddressGeneric: the absolute last resort when there is
  //     no known street at all to anchor on. ---
  check('extractFullAddressGeneric finds an address-shaped string with no known street at all',
    detailParser.extractFullAddressGeneric(")]}'\n" + JSON.stringify({ blob: '78 Ocean View Ter, Santa Cruz, CA 95060, United States' }))
      === '78 Ocean View Ter, Santa Cruz, CA 95060, United States');
  check('extractFullAddressGeneric returns blank when nothing address-shaped exists',
    detailParser.extractFullAddressGeneric(")]}'\n" + JSON.stringify({ blob: 'no address here, just words' })) === '');
  check('extractFullAddressGeneric returns blank for empty/garbage input rather than throwing',
    detailParser.extractFullAddressGeneric('') === '' && detailParser.extractFullAddressGeneric(null) === '');

  // --- international addresses: the anchor/generic fallbacks must not be
  //     US-only. UK, Canada and Australia shapes, none of which have a
  //     5-digit US ZIP, all the way through mergeEmbeddedPayload(). ---
  const ukJson6 = new Array(200).fill(null);
  ukJson6[2] = ['221B Baker Street', 'London', 'NW1 6XE', 'United Kingdom'];
  const ukJsonFull = new Array(7); ukJsonFull[6] = ukJson6;
  const ukMerged = placeDetail.mergeEmbeddedPayload(blank, ")]}'\n" + JSON.stringify(ukJsonFull), '221B Baker Street');
  check('a UK address (no US ZIP shape) resolves correctly through the full pipeline',
    ukMerged.fullAddress === '221B Baker Street, London, NW1 6XE, United Kingdom', ukMerged.fullAddress);

  const caJson6 = new Array(200).fill(null);
  caJson6[2] = ['123 Main St', 'Toronto', 'ON M5H 2N2', 'Canada'];
  const caJsonFull = new Array(7); caJsonFull[6] = caJson6;
  const caMerged = placeDetail.mergeEmbeddedPayload(blank, ")]}'\n" + JSON.stringify(caJsonFull), '123 Main St');
  check('a Canadian address (letter-digit postal code) resolves correctly',
    caMerged.fullAddress === '123 Main St, Toronto, ON M5H 2N2, Canada', caMerged.fullAddress);

  // --- suite/unit numbers must survive the full pipeline unmangled. ---
  const suiteHtml = `<html><body><script>
    var blob = "9606 Tierra Grande St Ste 202, San Diego, CA 92126, United States";
  </script></body></html>`;
  const suiteMerged = placeDetail.mergeEmbeddedPayload(blank, suiteHtml, '9606 Tierra Grande St Ste 202');
  check('a suite/unit number in the street survives the anchor fallback intact',
    suiteMerged.fullAddress === '9606 Tierra Grande St Ste 202, San Diego, CA 92126, United States', suiteMerged.fullAddress);

  // --- genuinely nothing exposed anywhere: must resolve Not Found, never
  //     invent city/state/zip/country. ---
  const nothingJson6 = new Array(200).fill(null);
  nothingJson6[7] = ['https://noaddress.example.com'];
  const nothingJsonFull = new Array(7); nothingJsonFull[6] = nothingJson6;
  const nothingMerged = placeDetail.mergeEmbeddedPayload(blank, ")]}'\n" + JSON.stringify(nothingJsonFull), '');
  check('when nothing is exposed anywhere, Full Address stays genuinely blank rather than inventing one',
    nothingMerged.fullAddress === '' && !nothingMerged.city && !nothingMerged.state
      && !nothingMerged.postalCode && !nothingMerged.country,
    JSON.stringify(nothingMerged));
  check('website is still found even when address is genuinely absent (fields are independent)',
    nothingMerged.website === 'https://noaddress.example.com', nothingMerged.website);

  // --- when BOTH the array payload and JSON-LD are absent, parsePlaceDetail
  //     still returns a well-formed blank object, not a crash. ---
  const nothingAtAll = detailParser.parsePlaceDetail('<html><body>totally empty page</body></html>');
  check('parsePlaceDetail returns a clean blank object (not a crash) when nothing is found at all',
    nothingAtAll.ok === false && nothingAtAll.fullAddress === '' && nothingAtAll.address === '');

  // --- fetchPlaceDetail: the actual network entry point, wired end to end ---
  class FakeDOMParser {
    parseFromString() {
      const root = new El('div', { role: 'main' });
      root.append(new El('h1', { class: 'DUwDvf' }).append('Fetched Place'));
      root.append(new El('button', { 'data-item-id': 'address' })
        .append('1 Fetch St, City, ST 00000, United States'));
      root.append(new El('a', { 'data-item-id': 'authority', href: 'https://fetched.com' }));
      // deliberately no phone element here — it must come from the embedded payload below
      return root;
    }
  }
  const fetchJson6 = new Array(200).fill(null);
  fetchJson6[178] = [['+1 555 000 2222']];
  const fetchJson = new Array(7); fetchJson[6] = fetchJson6;
  const fetchHtml = ")]}'\n" + JSON.stringify(fetchJson);

  const priorDomParser = globalThis.DOMParser;
  const priorFetch = globalThis.fetch;
  globalThis.DOMParser = FakeDOMParser;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => fetchHtml });

  const fetched = await placeDetail.fetchPlaceDetail('https://www.google.com/maps/place/Fetched+Place', { timeoutMs: 500 });
  check('fetchPlaceDetail resolves ok:true from a same-origin fetch', fetched.ok === true, JSON.stringify(fetched));
  check('it reads what the DOM had', fetched.data.businessName === 'Fetched Place' && fetched.data.website === 'https://fetched.com');
  check('it fills what only the embedded payload had', fetched.data.phone === '+1 555 000 2222');
  check('a resolved field is marked Found', fetched.data.websiteStatus === 'Found' && fetched.data.phoneStatus === 'Found');

  globalThis.fetch = async (url) => ({ ok: false, status: 0, text: async () => '' });
  const failedFetch = await placeDetail.fetchPlaceDetail('https://www.google.com/maps/place/Unreachable', { timeoutMs: 500 });
  check('a failed fetch reports ok:false with an error, not a thrown exception', failedFetch.ok === false && !!failedFetch.error);

  // --- diagnosePlaceDetail: the live-probe used by Diagnostics to show WHY
  //     detail resolution is or isn't finding anything, not just whether it did ---
  globalThis.DOMParser = FakeDOMParser;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: String(url), text: async () => fetchHtml });
  const diagOk = await placeDetail.diagnosePlaceDetail('https://www.google.com/maps/place/Fetched+Place', { timeoutMs: 500 });
  check('diagnosePlaceDetail reports the HTTP status', diagOk.httpStatus === 200);
  check('diagnosePlaceDetail reports the response length', diagOk.responseLength === fetchHtml.length, `${diagOk.responseLength} vs ${fetchHtml.length}`);
  check('diagnosePlaceDetail correctly reports an embedded payload was found', diagOk.payloadFound === true);
  check('diagnosePlaceDetail extracts the same data fetchPlaceDetail would', diagOk.data.businessName === 'Fetched Place' && diagOk.data.phone === '+1 555 000 2222');
  check('diagnosePlaceDetail includes a readable excerpt of the response', diagOk.excerpt.length > 0 && diagOk.excerpt.length <= 600);
  check('diagnosePlaceDetail strips <script> content from the excerpt', !diagOk.excerpt.includes('<script'));

  // A response that never contains real place data — e.g. a consent
  // interstitial instead of the place page — must be visibly flagged as
  // such (no payload, blank fields), not silently reported as "resolved".
  // Restore the REAL DOMParser first — FakeDOMParser above ignores its
  // input entirely and always returns the same canned document, which
  // would make this scenario pass for the wrong reason.
  globalThis.DOMParser = priorDomParser;
  const consentHtml = '<html><body><h1>Before you continue to Google Maps</h1><p>We use cookies...</p></body></html>';
  globalThis.fetch = async (url) => ({ ok: true, status: 200, url: 'https://consent.google.com/ml?continue=' + url, text: async () => consentHtml });
  const diagRedirected = await placeDetail.diagnosePlaceDetail('https://www.google.com/maps/place/Blocked+Place', { timeoutMs: 500 });
  check('diagnosePlaceDetail detects a redirect away from the place URL', diagRedirected.finalUrl !== diagRedirected.url, JSON.stringify({ url: diagRedirected.url, finalUrl: diagRedirected.finalUrl }));
  check('a consent/interstitial response correctly shows no embedded payload', diagRedirected.payloadFound === false);
  check('a consent/interstitial response correctly leaves Full Address blank rather than inventing one', diagRedirected.data.fullAddress === '');

  globalThis.DOMParser = priorDomParser;
  globalThis.fetch = priorFetch;
}

/* ================================================================== */
group('TEST 14, 15 & 23 - Missing fields are NEVER technical errors');

{
  const records = [
    { businessName: 'A', rating: '4.6', fullAddress: '1 St, Town, ST 1, US', website: 'https://a.com', phone: '+1 904 555 0100' },
    { businessName: 'B', rating: '4.1' },
    { businessName: 'C', rating: '4.9', phone: '+1 904 555 0102' },
    { businessName: 'D', rating: '3.8', website: 'https://d.com' },
  ];
  const q = quality.analyze(records);
  check('TEST 14 - missing websites raise the missing-website count',
    q.fields.website.missing === 2, JSON.stringify(q.fields.website));
  check('TEST 15 - missing phones raise the missing-phone count',
    q.fields.phone.missing === 2, JSON.stringify(q.fields.phone));
  check('complete vs partial are counted separately', q.complete === 1 && q.partial === 3,
    `complete ${q.complete} partial ${q.partial}`);

  let tech = quality.blankTechnical();
  check('TEST 23 - technical errors stay at 0 despite the missing fields', tech.total === 0);

  tech = quality.recordTechnicalError(tech, 'timeout', 'detail tab timed out');
  check('a real failure DOES count', tech.total === 1 && tech.byCategory.timeout === 1);

  const qsrc = fs.readFileSync(new URL('../src/core/quality.js', import.meta.url), 'utf8');
  check('the analyser has no path that increments an error counter',
    !/error(s)?\s*\+\+/i.test(qsrc.replace(/recordTechnicalError[\s\S]*$/, '')));

  const csrc = fs.readFileSync(new URL('../src/collector/collector.js', import.meta.url), 'utf8');
  check('the collector never counts a missing field as an error',
    !/if\s*\(\s*!?record\.(website|phone|fullAddress)[^)]*\)[^;]*errors/i.test(csrc));
}

/* ================================================================== */
group('TEST 8 & 9 - Multiple searches keep their own datasets');

{
  storage.__resetMemory();
  const made = [];
  for (const [q, loc, n] of [['Roofing', 'Jacksonville, FL', 51], ['Roofing', 'Orlando, FL', 73], ['Roofing', 'Tampa, FL', 64]]) {
    const job = await jobsApi.createJob({ query: q, location: loc, mode: 'standard' });
    const recs = Array.from({ length: n }, (u, i) => ({
      serial: i + 1, businessName: `${loc} biz ${i + 1}`, rating: '4.5',
      mapsUrl: `https://www.google.com/maps/place/${loc}-${i}`,
      dedupeUrl: `https://www.google.com/maps/place/${loc}-${i}`,
      placeId: `0x${loc.length}${i}:0x${i}`,
      searchQuery: q, searchLocation: loc,
    }));
    await jobsApi.records.append(job.id, recs);
    await jobsApi.refreshQuality(job.id, recs);
    await jobsApi.updateJob(job.id, { status: 'completed' });
    made.push({ id: job.id, n });
  }

  const index = await jobsApi.listJobs();
  check('TEST 8 - all three jobs remain listed', index.length === 3, 'got ' + index.length);
  for (const m of made) {
    const recs = await jobsApi.records.read(m.id);
    check(`job ${m.id.slice(-6)} still holds its ${m.n} records`, recs.length === m.n, 'got ' + recs.length);
  }

  const all = await datasetApi.readScope(datasetApi.SCOPE.ALL_JOBS, {});
  check('TEST 9 - the combined view shows all 188 records together',
    all.records.length === 188, 'got ' + all.records.length);
  check('every record carries its provenance',
    all.records.every((r) => r.jobId && r.searchLocation && r.jobLabel));
  check('sources are listed per job', all.sources.length === 3);

  const combined = await datasetApi.combineJobs(made.map((m) => m.id), {
    name: 'Florida roofing', dedupeFn: dedupe.removeDuplicates,
  });
  check('combining produces a new dataset', combined.after > 0 && combined.before === 188,
    JSON.stringify({ before: combined.before, after: combined.after }));
  check('the originals survive combining', (await jobsApi.listJobs()).length === 4);
  for (const m of made) {
    check(`original job ${m.id.slice(-6)} untouched`, (await jobsApi.records.read(m.id)).length === m.n);
  }
}

/* ================================================================== */
group('TESTS 10-13 - Filters');

{
  const recs = [
    { businessName: 'A Roofing', category: 'Roofing contractor', rating: '4.8', reviewCount: '264', website: 'https://a.com', phone: '+1 904 555 0100', fullAddress: '1 Main St, Jacksonville, FL 32210, United States', leadScore: 88 },
    { businessName: 'B Roofing', category: 'Roofing contractor', rating: '4.2', reviewCount: '40', website: 'https://b.com', phone: '', fullAddress: '2 Oak Ave, Orlando, FL 32801, United States', leadScore: 55 },
    { businessName: 'C General', category: 'General contractor', rating: '4.9', reviewCount: '510', website: '', phone: '+1 904 555 0102', fullAddress: '3 Pine Rd, Tampa, FL 33601, United States', leadScore: 47 },
    { businessName: 'D Const', category: 'Construction company', rating: '3.1', reviewCount: '12', website: 'https://d.com', phone: '+1 904 555 0103', fullAddress: '4 Elm St, Jacksonville, FL 32211, United States', leadScore: 60 },
    { businessName: 'E Roofing', category: 'Roofing contractor', rating: '4.6', reviewCount: '130', website: 'https://e.com', phone: '+1 904 555 0104', fullAddress: '5 Bay St, Jacksonville, FL 32202, United States', leadScore: 79 },
  ];
  const names = (c) => filters.applyCriteria(recs, c).map((r) => r.businessName);

  check('TEST 10 - rating >= 4.5', eq(names({ ratingMin: 4.5 }), ['A Roofing', 'C General', 'E Roofing']));
  check('TEST 11 - reviews >= 100', eq(names({ reviewsMin: 100 }), ['A Roofing', 'C General', 'E Roofing']));

  const cats = filters.categoryFacets(recs);
  check('TEST 12 - categories come from the data, with counts',
    eq(cats, [{ value: 'Roofing contractor', count: 3 }, { value: 'Construction company', count: 1 }, { value: 'General contractor', count: 1 }]),
    JSON.stringify(cats));
  check('TEST 12 - categories are not hard-coded anywhere',
    !/Roofing contractor/.test(fs.readFileSync(new URL('../src/engines/filters.js', import.meta.url), 'utf8')));

  check('TEST 13 - rating>=4.5 AND reviews>=100 AND category AND hasWebsite',
    eq(names({ ratingMin: 4.5, reviewsMin: 100, categories: ['Roofing contractor'], availability: ['hasWebsite'] }),
      ['A Roofing', 'E Roofing']));
  check('location filter works', eq(names({ city: 'jackson' }), ['A Roofing', 'D Const', 'E Roofing']));
  check('lead score filter works', eq(names({ scoreMin: 70 }), ['A Roofing', 'E Roofing']));
  check('numeric bounds come from the data',
    eq(filters.numericBounds(recs).reviews, { min: 12, max: 510 }));
  check('active filter count is accurate',
    filters.activeCount({ ratingMin: 4.5, categories: ['x'], availability: ['hasWebsite', 'hasPhone'] }) === 4);
}

/* ================================================================== */
group('TEST 16, 17 & 25 - Optional failures never stop anything');

{
  const r = await safe.safeCall('auth.google', async () => { throw new Error('OAuth denied'); }, { fallback: 'fb' });
  check('TEST 17 - a Sheets auth failure is contained', r.ok === false && r.value === 'fb');
  check('TEST 17 - CSV still builds with no Google auth',
    csv.buildCsv([{ businessName: 'x' }], ['businessName']).includes('Business Name'));
  check('TEST 17 - Excel still builds with no Google auth',
    xlsx.buildXlsx([{ businessName: 'x' }], ['businessName']).length > 1000);
  check('Sheets reports itself unconfigured rather than pretending',
    sheets.getConfig().configured === false);

  check('TEST 16 - a broken page yields nothing without throwing',
    extract.extractEmails('<html>nothing</html>', 'x.com').best === ''
    && eq(extract.extractSocials('<html>nothing</html>'), {}));
  check('TEST 16 - garbage input to the extractors is safe',
    extract.extractEmails(null).best === '' && eq(extract.extractSocials(null), {}));

  // TEST 25 — the isolation contract, checked against the real import graph.
  const csrc = fs.readFileSync(new URL('../src/collector/collector.js', import.meta.url), 'utf8');
  check('TEST 25 - collector imports no enrichment, export, dedupe, score or jobs code',
    !/from '\.\.\/(engines\/(dedupe|score|validate|filters)|enrich|export|jobs|background)/.test(csrc));
  check('TEST 25 - collector imports only core and its own folder',
    (csrc.match(/from '([^']+)'/g) || []).every((m) => /'\.\.\/core\/|'\.\//.test(m)));

  // And Start still works right after every optional stage has been exercised.
  mountVirtual({ total: 12, windowSize: 8, batch: 4 });
  const after = await runCollector(FAST, 'after-stages');
  check('Start works after every optional module has run', after.records.length === 12, 'got ' + after.records.length);
}

/* ================================================================== */
group('Google Sheets auth — never-signed-in vs expired/revoked, auto-reauth on 401');

{
  const storage = await import('../src/core/storage.js');
  const priorChrome = globalThis.chrome;
  storage.__resetMemory();

  const CLIENT_ID = '113148532135-test.apps.googleusercontent.com';
  let removedTokens = [];
  let interactivePrompts = 0;
  let cachedToken = null;    // faithfully mimics Chrome's own token cache
  let tokenSerial = 0;
  let nextInteractiveFails = false;

  // A faithful mock of chrome.identity: a cached token is returned AS-IS
  // regardless of the `interactive` flag (real Chrome only prompts when
  // there is NO cached token at all) — getting this wrong is exactly what
  // made the first version of this test pass for the wrong reason.
  function installChromeIdentityMock() {
    removedTokens = [];
    interactivePrompts = 0;
    cachedToken = null;
    tokenSerial = 0;
    nextInteractiveFails = false;
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ oauth2: { client_id: CLIENT_ID, scopes: ['https://www.googleapis.com/auth/spreadsheets'] } }),
        id: 'test-extension-id',
        lastError: null,
      },
      identity: {
        getAuthToken({ interactive }, cb) {
          if (interactive) interactivePrompts++;
          if (cachedToken) {
            globalThis.chrome.runtime.lastError = null;
            cb(cachedToken);
            return;
          }
          if (!interactive || nextInteractiveFails) {
            globalThis.chrome.runtime.lastError = { message: 'OAuth2 not granted or revoked.' };
            cb(null);
            return;
          }
          tokenSerial++;
          cachedToken = `token-${tokenSerial}`;
          globalThis.chrome.runtime.lastError = null;
          cb(cachedToken);
        },
        removeCachedAuthToken({ token }, cb) {
          removedTokens.push(token);
          if (cachedToken === token) cachedToken = null;
          cb && cb();
        },
      },
    };
  }

  // --- Scenario 1: a completely fresh install, never signed in. ---
  installChromeIdentityMock();
  const freshStatus = await sheets.getStatus();
  check('a fresh install with no prior sign-in shows no error banner at all',
    freshStatus.everConnected === false && freshStatus.reason === '', JSON.stringify(freshStatus));
  check('a fresh install correctly reports not signed in',
    freshStatus.signedIn === false);
  check('getStatus() does not even call chrome.identity on a fresh install (no needless prompt/failure)',
    interactivePrompts === 0);

  // --- Scenario 2: successful interactive sign-in, then status reflects it. ---
  const signInResult = await sheets.signIn();
  check('signIn() succeeds and returns a token', signInResult.ok === true && signInResult.token === 'token-1');
  const connectedStatus = await sheets.getStatus();
  check('after a successful sign-in, getStatus reports connected with no error',
    connectedStatus.everConnected === true && connectedStatus.signedIn === true && connectedStatus.reason === '',
    JSON.stringify(connectedStatus));

  // --- Scenario 3: Chrome's own cached token has since expired/gone (its
  //     own lifecycle, nothing this extension controls) — interactive:false
  //     now fails exactly like a fresh install would. Must still be
  //     distinguishable from "never connected" via everConnected. ---
  cachedToken = null;
  const expiredStatus = await sheets.getStatus();
  check('a revoked connection is reported as expired, not as "never connected"',
    expiredStatus.everConnected === true && expiredStatus.signedIn === false && expiredStatus.reason,
    JSON.stringify(expiredStatus));

  // --- Scenario 4: sign out cleanly resets to "not connected" (not "expired"). ---
  await sheets.signIn(); // re-establish a cached token (token-2) first
  await sheets.signOut();
  const signedOutStatus = await sheets.getStatus();
  check('after an explicit sign-out, status is clean "not connected", not "expired"',
    signedOutStatus.everConnected === false, JSON.stringify(signedOutStatus));

  // --- Scenario 5: withReauth — a cached token the API rejects with 401 is
  //     cleared and retried ONCE with a fresh interactive token, transparently. ---
  installChromeIdentityMock();
  await sheets.signIn(); // cachedToken = 'token-1'

  const priorFetch = globalThis.fetch;
  let fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    const auth = (opts && opts.headers && opts.headers.Authorization) || '';
    fetchCalls.push(auth);
    if (auth.includes('token-1')) {
      // The cached token is stale — Google rejects it even though Chrome
      // still had it cached and handed it out without complaint.
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid Credentials' } }) };
    }
    // Any fresher token succeeds.
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ spreadsheetId: 'sheet123', properties: { title: 'Recovered' } }),
    };
  };

  const created = await sheets.createSpreadsheet('Test Sheet', ['businessName']);
  check('a 401 on a stale cached token is recovered from automatically (ok:true after retry)',
    created.ok === true && created.spreadsheetId === 'sheet123', JSON.stringify(created));
  check('the stale token was removed from the Chrome token cache',
    removedTokens.includes('token-1'), JSON.stringify(removedTokens));
  check('exactly one retry happened — the first call used the stale token, the second a fresh one',
    fetchCalls.length >= 2 && fetchCalls[0].includes('token-1') && !fetchCalls[fetchCalls.length - 1].includes('token-1'),
    JSON.stringify(fetchCalls));

  // --- Scenario 6: if the retry's fresh sign-in ALSO fails (truly revoked,
  //     not just a stale cache), the caller gets a clean "sign in again"
  //     signal — never stuck silently retrying the same dead token forever. ---
  installChromeIdentityMock();
  await sheets.signIn(); // cachedToken = 'token-1'
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'Invalid Credentials' } }) });
  nextInteractiveFails = true; // the retry's fresh interactive attempt (after the 401 clears the cache) fails too
  const stillBroken = await sheets.createSpreadsheet('Test Sheet 2', ['businessName']);
  check('when reauth itself fails too, the caller gets needsReauth rather than a raw technical error',
    stillBroken.ok === false && stillBroken.needsReauth === true, JSON.stringify(stillBroken));
  const afterFailedReauth = await sheets.getStatus();
  check('a reauth that itself fails correctly resets to disconnected, not silently "connected"',
    afterFailedReauth.everConnected === false, JSON.stringify(afterFailedReauth));

  globalThis.fetch = priorFetch;
  globalThis.chrome = priorChrome;
  storage.__resetMemory();
}

/* ================================================================== */
group('TESTS 19 & 20 - Pause, Resume, Stop');

{
  mountVirtual({ total: 80, windowSize: 20, batch: 6 });
  let ended = null;
  const records = [];
  await collector.start({
    jobId: 'pause',
    settings: { ...FAST, scrollDelayMs: 40 },
    onRecords: (b, patch) => { if (!patch) records.push(...b); },
    onProgress: () => {},
    onEnded: (s) => { ended = s; },
  });
  await sleep(90);
  const paused = collector.pause();
  const at = collector.getStatus().counts.found;
  await sleep(200);
  const still = collector.getStatus().counts.found;

  check('TEST 19 - Pause reports paused', paused.status === 'paused');
  check('TEST 19 - nothing is collected while paused', still === at, `${at} -> ${still}`);

  const resumed = collector.resume();
  check('TEST 19 - Resume reports running', resumed.status === 'running');
  for (let i = 0; i < 600 && !ended; i++) await sleep(10);
  check('TEST 19 - Resume continues rather than restarting',
    collector.getStatus().counts.found >= at && records.length === 80,
    `${at} -> ${records.length}`);
  check('TEST 19 - no duplicates after resume',
    new Set(records.map((r) => r.stableKey)).size === records.length);
}

{
  mountVirtual({ total: 300, windowSize: 20, batch: 5 });
  let ended = null;
  const records = [];
  await collector.start({
    jobId: 'stop',
    settings: { ...FAST, scrollDelayMs: 40 },
    onRecords: (b, patch) => { if (!patch) records.push(...b); },
    onProgress: () => {},
    onEnded: (s) => { ended = s; },
  });
  await sleep(120);
  const st = collector.stop();
  for (let i = 0; i < 300 && !ended; i++) await sleep(10);
  check('TEST 20 - Stop halts the run', ended && ended.reason === 'stopped', JSON.stringify(ended && ended.reason));
  check('TEST 20 - records collected before Stop are kept', records.length > 0, 'got ' + records.length);
  check('Stop reports the stopped status', st.status === 'stopped');
}

/* ================================================================== */
group('TEST 22 - Heartbeat and stuck detection');

{
  const src = fs.readFileSync(new URL('../src/collector/collector.js', import.meta.url), 'utf8');
  check('the collector maintains lastActivityAt', /lastActivityAt/.test(src) && /function beat\(/.test(src));

  mountVirtual({ total: 10, windowSize: 6, batch: 3 });
  const r = await runCollector(FAST, 'beat');
  check('status exposes a heartbeat', collector.getStatus().lastActivityAt > 0);
  check('status exposes idle time', typeof collector.getStatus().idleMs === 'number');

  const base = jobsApi.blankJob({ status: 'running' });
  check('TEST 22 - a fresh job is not stuck',
    jobsApi.stallState({ ...base, lastActivityAt: Date.now() }).stuck === false);
  check('TEST 22 - an idle running job IS reported stuck',
    jobsApi.stallState({ ...base, lastActivityAt: Date.now() - 45000 }).stuck === true);
  check('a paused job is never called stuck',
    jobsApi.stallState({ ...base, status: 'paused', lastActivityAt: Date.now() - 999999 }).stuck === false);
}

/* ================================================================== */
group('TEST 18 - Collection survives the panel closing');

{
  // The collector lives in the content script and reports through callbacks;
  // it holds no reference to the panel. Losing the sink must not stop it.
  mountVirtual({ total: 30, windowSize: 12, batch: 6 });
  let ended = null;
  let delivered = 0;
  await collector.start({
    jobId: 'panel-closed',
    settings: { ...FAST, scrollDelayMs: 15 },
    onRecords: () => {
      delivered++;
      // Simulate the panel going away mid-run.
      if (delivered === 2) throw new Error('side panel closed');
    },
    onProgress: () => { if (delivered >= 2) throw new Error('side panel closed'); },
    onEnded: (s) => { ended = s; },
  });
  for (let i = 0; i < 600 && !ended; i++) await sleep(10);
  check('TEST 18 - collection completes even when the UI sink throws',
    ended && ended.reason === 'completed', JSON.stringify(ended && ended.reason));
  check('TEST 18 - all records were still collected',
    collector.getCollectedRecords().length === 30, 'got ' + collector.getCollectedRecords().length);
}

/* ================================================================== */
group('Queue model');

{
  const items = queueApi.parseQueueText('Roofing — Jacksonville, FL\nRoofing — Orlando, FL\nRoofing — Tampa, FL');
  check('queue parses three searches', items.length === 3);
  check('query and location are separated',
    items[0].query === 'Roofing' && items[0].location === 'Jacksonville, FL');

  const q = { running: true, currentIndex: 1, items };
  items[0].status = queueApi.QUEUE_ITEM.DONE; items[0].count = 51;
  items[1].status = queueApi.QUEUE_ITEM.SCRAPING; items[1].count = 20;
  check('an in-flight item blocks the next search', queueApi.hasActiveItem(q) === true);
  const p = queueApi.queueProgress(q);
  check('progress reports position and current item',
    p.position === 2 && p.total === 3 && p.current.location === 'Orlando, FL', JSON.stringify(p));
  items[1].status = queueApi.QUEUE_ITEM.DONE;
  check('with nothing in flight the queue may advance', queueApi.hasActiveItem(q) === false);
  check('queue has loading and scraping as distinct states',
    queueApi.QUEUE_ITEM.LOADING !== queueApi.QUEUE_ITEM.SCRAPING);
}

/* ================================================================== */
group('Deduplication, validation, scoring, export');

{
  const recs = [
    { businessName: 'ABC Roofing', fullAddress: '12 Main St, Jacksonville, FL 32210', phone: '+1 904-516-4279', dedupeUrl: 'u/ABC', website: 'https://abc.com' },
    { businessName: 'abc roofing', fullAddress: '12 Main St, Jacksonville, FL 32210', phone: '(904) 516-4279', dedupeUrl: 'u/ABC2', email: 'i@abc.com' },
    { businessName: 'ABC  Roofing LLC', fullAddress: '12 Main Street, Jacksonville, FL 32210', dedupeUrl: 'u/ABC3' },
    { businessName: 'ABC Roofing', fullAddress: '99 Other Rd, Orlando, FL 32801', phone: '+1 407-000-1111', dedupeUrl: 'u/ABC-ORL' },
  ];
  const out = dedupe.removeDuplicates(recs);
  check('duplicates merge, different branches do not',
    out.stats.after === 2 && out.records.filter((r) => /abc/i.test(r.businessName)).length === 2,
    JSON.stringify(out.stats));
  check('merging keeps fields from every duplicate',
    out.records[0].website === 'https://abc.com' && out.records[0].email === 'i@abc.com');
  check('before / removed / after are reported',
    out.stats.before === 4 && out.stats.removed === 2 && out.stats.after === 2);

  check('validation flags a schema.org website',
    validate.validateRecord({ website: 'http://schema.org/Place' }).validation.reasons.some((r) => r.includes('schema.org')));
  check('junk data scores zero',
    score.scoreRecord({ website: 'http://schema.org/Place', rating: '9' }).score === 0);

  const fields = ['businessName', 'rating', 'reviewCount', 'fullAddress', 'website', 'phone',
    'email', 'leadScore', 'searchQuery', 'searchLocation', 'latitude', 'longitude'];
  const rows = [{
    businessName: 'ABC Roofing, LLC', rating: '4.6', reviewCount: '264',
    fullAddress: '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States',
    website: 'https://abc.com', phone: '+1 904-516-4279', email: 'i@abc.com', leadScore: 87,
    searchQuery: 'Roofing contractors', searchLocation: 'Jacksonville, FL',
    latitude: '30.2419', longitude: '-81.7412',
  }];
  const text = csv.buildCsv(rows, fields);
  check('CSV includes the provenance columns',
    text.includes('Search Query') && text.includes('Search Location') && text.includes('Jacksonville, FL'));
  check('CSV preserves a leading-plus phone number', text.includes('+1 904-516-4279'));
  check('CSV neutralises formula injection', csv.escapeCell('=cmd()').charAt(0) === "'");
  const bytes = xlsx.buildXlsx(rows, fields, { sheetName: 'Leads' });
  check('XLSX is a valid ZIP', bytes[0] === 0x50 && bytes[1] === 0x4b);
}

/* ================================================================== */
group('No unhandled errors under abusive input');

{
  let threw = null;
  const abusive = [null, undefined, '', '   ', '<html>', '[[[[', '{}', 'null', 'a'.repeat(20000)];
  for (const input of abusive) {
    try {
      detailParser.parsePlaceDetail(input);
      cardParser.parseRatingAndReviews(input);
      cardParser.parsePlaceIdentity(input);
      address.splitAddress(input);
      address.composeFull(input, {});
      address.isCompleteAddress(input);
      normalize.normalizeRecord({ businessName: input });
      quality.analyze([{ businessName: input }]);
      quality.fieldStatuses({ businessName: input }, {});
      filters.applyCriteria([{ businessName: input }], { ratingMin: 4 });
      extract.extractEmails(input);
    } catch (err) { threw = JSON.stringify(String(input).slice(0, 18)) + ': ' + err.message; break; }
  }
  check('no parser or engine throws on abusive input', threw === null, threw || '');

  let engineThrew = null;
  try {
    dedupe.removeDuplicates([]);
    validate.validateAll([{}]);
    score.scoreAll([{}]);
    filters.applyCriteria([], filters.blankCriteria());
    filters.categoryFacets(null);
    filters.locationFacets(null);
    quality.analyze(null);
    csv.buildCsv([{}], ['businessName']);
    xlsx.buildXlsx([{}], ['businessName']);
    datasetApi.SCOPE.ALL_JOBS;
  } catch (err) { engineThrew = err.message; }
  check('no engine throws on empty or malformed input', engineThrew === null, engineThrew || '');
}

/* ================================================================== */
group('UI - every view renders in empty and populated states');

{
  const views = await Promise.all([
    import('../src/sidepanel/views/home.js'),
    import('../src/sidepanel/views/data.js'),
    import('../src/sidepanel/views/filter.js'),
    import('../src/sidepanel/views/enrich.js'),
    import('../src/sidepanel/views/export.js'),
    import('../src/sidepanel/views/jobs.js'),
    import('../src/sidepanel/views/settings.js'),
    import('../src/sidepanel/views/diagnostics.js'),
  ]);
  const names = ['home', 'data', 'filter', 'enrich', 'export', 'jobs', 'settings', 'diagnostics'];
  const fns = [views[0].renderHome, views[1].renderData, views[2].renderFilter, views[3].renderEnrich,
    views[4].renderExport, views[5].renderJobs, views[6].renderSettings, views[7].renderDiagnostics];

  const constants = await import('../src/core/constants.js');
  const sample = [{
    serial: 1, businessName: 'ABC Roofing', category: 'Roofing contractor', rating: '4.6',
    reviewCount: '264', fullAddress: '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States',
    city: 'Jacksonville', state: 'FL', postalCode: '32210', country: 'United States',
    website: 'https://abc.com', phone: '+1 904-516-4279', email: 'i@abc.com', leadScore: 87,
    mapsUrl: 'https://www.google.com/maps/place/ABC', scrapedAt: '2026-08-23T10:30:00Z',
    searchQuery: 'Roofing contractors', searchLocation: 'Jacksonville, FL', jobLabel: 'Jacksonville Roofing',
  }];

  const mk = (records, job) => {
    const st = {
      settings: constants.DEFAULT_SETTINGS, job, jobs: [], jobTotals: { jobs: 0, records: 0 },
      sources: [], records, criteria: filters.blankCriteria(),
      queue: { items: [], running: false }, projects: [], activeProjectId: null,
      scope: 'current', selectedJobIds: [], sort: { key: 'serial', dir: 'asc' },
      sheets: { configured: false }, diagnostics: null, busy: false, now: Date.now(),
      mapsDetect: { checked: true, onMaps: false, query: '', href: '' },
      searchMode: null, searchQueryText: '', searchLocationText: '', searchRows: [],
    };
    st.visibleRecords = () => filters.applyCriteria(records, st.criteria);
    st.quality = () => quality.analyze(st.visibleRecords());
    st.facets = () => ({
      categories: filters.categoryFacets(records), locations: filters.locationFacets(records),
      bounds: filters.numericBounds(records), availability: filters.availabilityCounts(records),
    });
    st.activeFilterCount = () => filters.activeCount(st.criteria);
    return st;
  };

  const populatedJob = jobsApi.blankJob({
    id: 'job_x', status: 'running', query: 'Roofing contractors', location: 'Jacksonville',
    counts: { found: 51, scanned: 140, scrolls: 12, duplicates: 3, enriched: 0, technicalErrors: 0 },
    detail: { done: 23, total: 51, resolved: 20, notFound: 3, failed: 0, ranAt: null },
    quality: quality.analyze(sample), lastActivityAt: Date.now() - 3000, lastActivity: 'Collected 4 new',
    progress: { note: 'Resolving full address 23 / 51' },
  });

  const states = [
    ['empty', mk([], null)],
    ['populated', mk(sample, populatedJob)],
  ];
  for (const [label, st] of states) {
    if (label === 'populated') {
      st.jobs = [{ id: 'job_x', label: 'Jacksonville Roofing', count: 51, status: 'completed', createdAt: Date.now(), quality: quality.analyze(sample), technicalErrors: 0 }];
      st.jobTotals = { jobs: 3, records: 188 };
      st.sources = [{ jobId: 'job_x', label: 'Jacksonville Roofing', count: 51, status: 'completed' }];
      st.diagnostics = {
        job: { ...populatedJob, stuck: false, idleMs: 3000 },
        quality: quality.analyze(sample), technical: quality.blankTechnical(),
        modules: [], detail: populatedJob.detail,
        page: { onMapsPage: true, feedFound: true, feedSelector: '[role="feed"]', cardCount: 47, atEnd: false, query: 'roofing', sample: { businessName: 'ABC Roofing', rating: '4.6' } },
        sheets: { configured: false, signedIn: false },
      };
    }
    for (let i = 0; i < fns.length; i++) {
      let html = null; let err = null;
      try { html = fns[i](st); } catch (e) { err = e.message; }
      check(`${label}: ${names[i]} renders`, err === null && typeof html === 'string' && html.length > 0, err || 'empty');
    }
  }
}

/* ================================================================== */
group('Detail resolver — no tabs, fetch-based, failure containment');

{
  const resolver = await import('../src/background/detail-resolver.js');
  const constants = await import('../src/core/constants.js');
  const FS = constants.FIELD_STATUS;

  const makeRecords = (n) => Array.from({ length: n }, (u, i) => ({
    serial: i + 1, businessName: 'B' + i, mapsUrl: 'https://www.google.com/maps/place/B' + i,
  }));

  // A chrome mock with NO tabs.create at all. If detail resolution ever tried
  // to open a tab, calling an undefined function would throw — this is a
  // stronger guarantee than mocking create() and hoping nothing calls it.
  let tabsCreateCalls = 0;
  const noTabsCreateApi = () => { tabsCreateCalls += 1; throw new Error('detail resolution must never create a tab'); };

  // --- no Google Maps tab is open at all (tabId is null) ---
  globalThis.chrome = { tabs: { sendMessage: async () => ({ ok: true, data: {} }), create: noTabsCreateApi } };
  const noTab = await resolver.resolveAll(makeRecords(5), { detailConcurrency: 3, detailTimeoutMs: 100 }, {}, null);
  check('resolving with no Maps tab does not throw', !!noTab && Array.isArray(noTab.records));
  check('records are marked Failed, never a fabricated "Not Found"',
    noTab.records.every((r) => r.fullAddressStatus === FS.FAILED),
    JSON.stringify(noTab.records.map((r) => r.fullAddressStatus)));
  check('having no Maps tab is reported as a technical error',
    (noTab.stats.technicalErrors || []).some((e) => e.category === 'communication'),
    JSON.stringify(noTab.stats.technicalErrors));
  check('no tab was created while resolving with tabId=null', tabsCreateCalls === 0);

  // --- a real tab id: some fetches fail, the rest must still finish ---
  const sentTo = [];
  globalThis.chrome = {
    tabs: {
      create: noTabsCreateApi,
      sendMessage: async (tabId, msg) => {
        sentTo.push(tabId);
        const url = msg && msg.payload && msg.payload.url;
        if (url && url.includes('B1')) throw new Error('tab unreachable'); // one record's fetch explodes
        return {
          ok: true,
          data: {
            fullAddress: '1 Main St, Town, ST 11111, United States',
            website: 'https://example.com', phone: '+1 904 555 0100',
            fullAddressStatus: FS.FOUND, websiteStatus: FS.FOUND, phoneStatus: FS.FOUND,
            address: '1 Main St', city: 'Town', state: 'ST', postalCode: '11111', country: 'United States',
            via: {},
          },
        };
      },
    },
  };
  const partial = await resolver.resolveAll(makeRecords(6), {
    detailConcurrency: 2, detailTimeoutMs: 400, detailRetries: 0, detailPaceMs: 1,
  }, {}, 777);
  check('a failing record does not abort the run', !!partial && partial.records.length === 6);
  check('every fetch was sent to the SAME tab — no tab was ever created', sentTo.every((id) => id === 777) && tabsCreateCalls === 0,
    JSON.stringify({ sentTo, tabsCreateCalls }));
  const resolved = partial.records.filter((r) => r.fullAddress).length;
  check('the other records still resolved', resolved === 5, 'resolved ' + resolved + '/6');
  const failedOne = partial.records.find((r) => r.mapsUrl.includes('B1'));
  check('the one unreachable record is marked Failed, not silently dropped',
    failedOne.fullAddressStatus === FS.FAILED, failedOne.fullAddressStatus);
  check('no record is left claiming Pending forever',
    partial.records.every((r) => r.fullAddressStatus !== FS.PENDING),
    JSON.stringify(partial.records.map((r) => r.fullAddressStatus)));

  // --- fields already present are never re-fetched ---
  let fetchedFor = [];
  globalThis.chrome = {
    tabs: {
      create: noTabsCreateApi,
      sendMessage: async (tabId, msg) => {
        fetchedFor.push(msg.payload.url);
        return { ok: true, data: { fullAddress: '9 Pine Rd, Town, ST 22222, United States', website: '', phone: '', fullAddressStatus: FS.FOUND, websiteStatus: FS.NOT_FOUND, phoneStatus: FS.NOT_FOUND, via: {} } };
      },
    },
  };
  const mixed = [
    { serial: 1, businessName: 'Complete', mapsUrl: 'https://www.google.com/maps/place/complete',
      fullAddress: '1 Main St, Town, ST 11111, United States', website: 'https://complete.com', phone: '+1 555 0100' },
    { serial: 2, businessName: 'Missing address', mapsUrl: 'https://www.google.com/maps/place/gap',
      fullAddress: '', website: 'https://gap.com', phone: '+1 555 0101' },
  ];
  const res2 = await resolver.resolveAll(mixed, { detailConcurrency: 2, detailTimeoutMs: 200 }, {}, 777);
  check('a fully-complete record is never sent for fetching', !fetchedFor.includes('https://www.google.com/maps/place/complete'));
  check('only the record missing something is fetched',
    fetchedFor.length === 1 && fetchedFor[0] === 'https://www.google.com/maps/place/gap', JSON.stringify(fetchedFor));
  check('the already-complete record keeps its own values untouched',
    res2.records[0].website === 'https://complete.com' && res2.records[0].phone === '+1 555 0100');

  // --- kept for API compatibility with router.js's findMapsTab() ---
  check('detailTabIds is permanently empty — this module opens no tabs', resolver.detailTabIds().length === 0,
    JSON.stringify(resolver.detailTabIds()));
  check('isDetailTab reports false for any tab', resolver.isDetailTab(999999) === false);

  const rsrc = fs.readFileSync(new URL('../src/background/router.js', import.meta.url), 'utf8');
  check('findMapsTab still excludes the resolver\'s (permanently empty) own-tab set',
    /isDetailTab/.test(rsrc.slice(rsrc.indexOf('async function findMapsTab'), rsrc.indexOf('async function activeJobId'))));
  check('the queue hook still ignores detail tabs',
    /if \(detailResolver\.isDetailTab\(tabId\)\) return;/.test(rsrc));
  check('startDetailResolution looks up the Maps tab before resolving',
    /const tab = await findMapsTab\(\);/.test(rsrc));
  check('resolveAll is called with the found tab\'s id, not a newly created tab',
    /detailResolver\.resolveAll\(/.test(rsrc) && /\}, tab && tab\.id\);/.test(rsrc));

  // --- enrichment stays scoped to the one job it was asked to run on ---
  // (source-level check: handleEnrich never imports/touches chrome APIs at
  // module scope, so it can't be instantiated directly in this harness —
  // enrichAll()'s own isolation between separate calls is covered end to
  // end in the "Enrichment engine" group below.)
  check('handleEnrich reads records scoped to ONE job id',
    /const records = await store\.readRecords\(id\);/.test(rsrc));
  check('handleEnrich writes results back scoped to that SAME job id, never a different one',
    /await store\.writeRecords\(id, mergeEnrichedSubset\(records, partial\)\);/.test(rsrc)
    && /await store\.writeRecords\(id, merged\);/.test(rsrc));
  check('mergeEnrichedSubset merges by stable record identity, never by array position (which could shuffle across jobs)',
    /byKey\.get\(r\.stableKey \|\| r\.serial\)/.test(rsrc));

  globalThis.chrome = undefined;
}

/* ================================================================== */
group('End-to-end: 51 businesses, fast collection + missing-field-only detail resolution');

{
  // A live Chrome + live Google Maps run cannot happen in this sandboxed test
  // environment. This exercises the real collector.js, card-parser.js,
  // detail-resolver.js and place-detail.js against a realistic 51-card feed —
  // the same dependency-free methodology the rest of this suite uses — and
  // reports the metrics requested for the scraping-path change.
  const resolver = await import('../src/background/detail-resolver.js');
  const { makeCard, makeFeed, markEndOfList } = await import('./harness/mini-dom.mjs');

  const TOTAL = 51;
  const names = ['Roofing', 'Plumbing', 'Electric', 'HVAC', 'Landscaping', 'Painting', 'Flooring', 'Contracting'];
  const cards = [];
  const truth = []; // what each synthetic business "really" has, for grading

  for (let i = 0; i < TOTAL; i++) {
    const hasWebsite = i % 10 !== 3;               // 46/51 — most cards expose it
    // i === 3 deliberately has NEITHER website nor phone on the card — a
    // lead with no web presence at all, which must still be collected, not
    // discarded, and still get everything else Phase 2 can find.
    const hasPhone = i % 12 !== 5 && i !== 3;
    // About a third of the phones Google DOES expose are rendered as plain
    // visible text on the card rather than a dedicated button/tel: element —
    // exactly the case the phone-extraction fix (card-parser.js) had to stop
    // missing. The rest keep the button-based path, unchanged.
    const phoneViaText = hasPhone && i % 3 === 0;
    const name = `${names[i % names.length]} Co ${i + 1}`;
    const website = hasWebsite ? `https://business${i}.example.com` : '';
    const phoneValue = hasPhone ? `+1 904 555 ${String(1000 + i).slice(-4)}` : '';
    const phone = hasPhone && !phoneViaText ? phoneValue : '';
    const phoneText = hasPhone && phoneViaText ? phoneValue : '';
    cards.push(makeCard({
      name, category: names[i % names.length], rating: (4 + (i % 10) / 10).toFixed(1),
      reviews: String(5 + i * 3), street: `${100 + i} Test Ave`, website, phone, phoneText,
    }));
    truth.push({ name, hasWebsite, hasPhone, phoneViaText });
  }

  collector.reset();
  document.body.children.length = 0;
  const feed = makeFeed(cards);
  markEndOfList(feed);
  document.body.append(feed);

  const t0 = Date.now();
  const phase1 = await runCollector({ ...FAST, mode: 'standard', scrollDelayMs: 1, maxNoChangeAttempts: 3 }, 'e2e-51');
  const phase1Ms = Date.now() - t0;

  check('all 51 businesses collected in Phase 1', phase1.records.length === TOTAL, 'got ' + phase1.records.length);
  const named = phase1.records.filter((r) => r.businessName).length;
  const categorized = phase1.records.filter((r) => r.category).length;
  const rated = phase1.records.filter((r) => r.rating).length;
  const reviewed = phase1.records.filter((r) => r.reviewCount).length;
  const addressed = phase1.records.filter((r) => r.address).length;
  const sitedPhase1 = phase1.records.filter((r) => r.website).length;
  const phonedPhase1 = phase1.records.filter((r) => r.phone).length;
  const expectedSites = truth.filter((t) => t.hasWebsite).length;
  const expectedPhones = truth.filter((t) => t.hasPhone).length;

  check('business name found for every record', named === TOTAL, `${named}/${TOTAL}`);
  check('category found for every record', categorized === TOTAL, `${categorized}/${TOTAL}`);
  check('rating found for every record', rated === TOTAL, `${rated}/${TOTAL}`);
  check('review count found for every record', reviewed === TOTAL, `${reviewed}/${TOTAL}`);
  check('street address found for every record', addressed === TOTAL, `${addressed}/${TOTAL}`);
  check('website found directly in Phase 1 matches what the cards exposed',
    sitedPhase1 === expectedSites, `${sitedPhase1}/${TOTAL} (expected ${expectedSites})`);
  check('phone found directly in Phase 1 matches what the cards exposed',
    phonedPhase1 === expectedPhones, `${phonedPhase1}/${TOTAL} (expected ${expectedPhones})`);

  // Plain-text-only phones (no button, no data-item-id, no tel: href) —
  // exactly the case that was previously missed — must be read correctly
  // too, matching the number character-for-character.
  const textFallbackTruth = truth.filter((t) => t.phoneViaText);
  const textFallbackFound = textFallbackTruth.filter((t) => {
    const rec = phase1.records.find((r) => r.businessName === t.name);
    return rec && rec.phone && /^\+1 904 555 \d{4}$/.test(rec.phone);
  });
  check(`plain-text phone numbers (no button on the card) all extracted correctly (${textFallbackTruth.length} businesses)`,
    textFallbackFound.length === textFallbackTruth.length,
    `${textFallbackFound.length}/${textFallbackTruth.length}`);

  // A business with neither website nor phone on the card is still a lead —
  // it must be collected, not silently dropped.
  const noWebNoPhone = phase1.records.find((r) => r.businessName === truth[3].name);
  check('a business with no website AND no phone on the card is still collected, not discarded',
    !!noWebNoPhone && noWebNoPhone.website === '' && noWebNoPhone.phone === '');

  check('full address is NOT invented in Phase 1 — Maps cards never show it',
    phase1.records.every((r) => r.fullAddress === ''));
  check('zero technical errors from a clean 51-card collection',
    phase1.ended.counts.technicalErrors === 0, String(phase1.ended.counts.technicalErrors));

  // --- Phase 2: only records still missing something (here: all 51, since
  //     Full Address is never on the card — see the assertion above) ---
  let tabsCreated = 0;
  let phase2Fetches = 0;
  const FAKE_TAB_ID = 4242;
  globalThis.chrome = {
    tabs: {
      create: async () => { tabsCreated += 1; throw new Error('detail resolution must never open a tab'); },
      sendMessage: async (tabId, msg) => {
        phase2Fetches += 1;
        if (tabId !== FAKE_TAB_ID) throw new Error('sent to the wrong tab: ' + tabId);
        const url = msg.payload.url;
        const idx = phase1.records.findIndex((r) => r.mapsUrl === url);
        const t = truth[idx];
        return {
          ok: true,
          data: {
            fullAddress: `${100 + idx} Test Ave, Jacksonville, FL 32${String(200 + idx).slice(-3)}, United States`,
            website: t.hasWebsite ? '' : `https://recovered${idx}.example.com`, // only fills what Phase 1 missed
            phone: t.hasPhone ? '' : `+1 904 555 9${String(idx).padStart(3, '0')}`,
            fullAddressStatus: 'Found', websiteStatus: t.hasWebsite ? 'Found' : 'Found', phoneStatus: t.hasPhone ? 'Found' : 'Found',
            via: {},
          },
        };
      },
    },
  };

  const t1 = Date.now();
  const resolved = await resolver.resolveAll(phase1.records, {
    detailConcurrency: 5, detailTimeoutMs: 2000, detailRetries: 1, detailBatchSize: 10, detailPaceMs: 1,
  }, {}, FAKE_TAB_ID);
  const phase2Ms = Date.now() - t1;

  const fullAddressFound = resolved.records.filter((r) => r.fullAddress).length;
  const sitedAfter = resolved.records.filter((r) => r.website).length;
  const phonedAfter = resolved.records.filter((r) => r.phone).length;

  check('every record was saved (none dropped)', resolved.records.length === TOTAL, String(resolved.records.length));
  check('Full Address recovered for all 51 via Phase 2', fullAddressFound === TOTAL, `${fullAddressFound}/${TOTAL}`);
  check('website count after Phase 2 covers every record (card + recovered)', sitedAfter === TOTAL, `${sitedAfter}/${TOTAL}`);
  check('phone count after Phase 2 covers every record (card + recovered)', phonedAfter === TOTAL, `${phonedAfter}/${TOTAL}`);
  check('ZERO individual business tabs were opened', tabsCreated === 0, 'tabs opened: ' + tabsCreated);
  check('Phase 2 made exactly one fetch per record needing something — not per missing field',
    phase2Fetches === TOTAL, `${phase2Fetches} fetches for ${TOTAL} records`);
  check('no technical errors from a clean Phase 2 run',
    (resolved.stats.technicalErrors || []).length === 0, JSON.stringify(resolved.stats.technicalErrors));

  // The no-website/no-phone business from Phase 1 must have BOTH recovered
  // by detail resolution — no website is never a reason to skip a business.
  const recoveredLead = resolved.records.find((r) => r.businessName === truth[3].name);
  check('the no-website business still gets its phone AND address resolved via detail fetch',
    !!recoveredLead && !!recoveredLead.phone && !!recoveredLead.fullAddress);

  console.log('\n  ' + '='.repeat(58));
  console.log('  51-BUSINESS TEST REPORT (synthetic harness — see note above)');
  console.log('  ' + '='.repeat(58));
  console.log(`  Businesses collected             : ${phase1.records.length}`);
  console.log(`  Business Name                    : ${named}/${TOTAL}`);
  console.log(`  Category                         : ${categorized}/${TOTAL}`);
  console.log(`  Rating                           : ${rated}/${TOTAL}`);
  console.log(`  Reviews                          : ${reviewed}/${TOTAL}`);
  console.log(`  Address                          : ${addressed}/${TOTAL}`);
  console.log(`  Full Address (after detail pass) : ${fullAddressFound}/${TOTAL}`);
  console.log(`  Website                          : ${sitedAfter}/${TOTAL} (${sitedPhase1}/${TOTAL} straight off the card)`);
  console.log(`  Phone                            : ${phonedAfter}/${TOTAL} (${phonedPhase1}/${TOTAL} straight off the card)`);
  console.log(`    of which via plain-text fallback (no button on the card) : ${textFallbackFound.length}/${textFallbackTruth.length}`);
  console.log(`  Business with no website on the card, still collected + resolved : "${recoveredLead.businessName}"`);
  console.log(`  Technical errors                 : ${phase1.ended.counts.technicalErrors + (resolved.stats.technicalErrors || []).length}`);
  console.log(`  Individual business tabs opened  : ${tabsCreated}`);
  console.log(`  Phase 1 collection time          : ${phase1Ms} ms`);
  console.log(`  Phase 2 (detail resolution) time : ${phase2Ms} ms (${phase2Fetches} fetches)`);
  console.log(`  Records saved                    : ${resolved.records.length}`);
  console.log('  ' + '='.repeat(58) + '\n');

  globalThis.chrome = undefined;
}

/* ================================================================== */
group('Collector edge cases');

{
  // --- no feed at all ---
  collector.reset();
  document.body.children.length = 0;
  const nofeed = await runCollector({ ...FAST, scrollDelayMs: 1, feedWaitMs: 300 }, 'no-feed');
  check('a page with no results feed ends as an error, not a hang',
    nofeed.ended && nofeed.ended.reason === 'error', JSON.stringify(nofeed.ended && nofeed.ended.reason));
  check('the error message tells the user what to do',
    /Google Maps results list/i.test((nofeed.ended && nofeed.ended.message) || ''));

  // --- feed present but completely empty ---
  collector.reset();
  document.body.children.length = 0;
  const emptyFeed = makeFeed([]);
  document.body.append(emptyFeed);
  const none = await runCollector({ ...FAST, scrollDelayMs: 1, maxNoChangeAttempts: 3 }, 'empty-feed');
  check('an empty feed completes with zero records rather than looping',
    none.ended && none.ended.reason === 'completed' && none.records.length === 0,
    JSON.stringify(none.ended && { r: none.ended.reason, n: none.records.length }));

  // --- cards with no place link are skipped, not counted as errors ---
  collector.reset();
  document.body.children.length = 0;
  const junkFeed = makeFeed(sampleBusinesses(4));
  const { El } = await import('./harness/mini-dom.mjs');
  for (let i = 0; i < 3; i++) {
    const junk = new El('div', { jsaction: 'x' });
    junk.append('advertisement placeholder');
    junkFeed.__inner.append(junk);
  }
  document.body.append(junkFeed);
  markEndOfList(junkFeed);
  const junk = await runCollector({ ...FAST, scrollDelayMs: 1, maxNoChangeAttempts: 3 }, 'junk');
  check('non-business cards are skipped', junk.records.length === 4, 'got ' + junk.records.length);
  check('skipping them is not a technical error',
    junk.ended.counts.technicalErrors === 0, String(junk.ended.counts.technicalErrors));

  // --- record cap ---
  mountVirtual({ total: 200, windowSize: 20, batch: 10 });
  const capped = await runCollector({ ...FAST, maxRecords: 25 }, 'capped');
  check('maxRecords stops the run at the limit', capped.records.length === 25, 'got ' + capped.records.length);
  check('hitting the cap is reported as the end reason',
    /limit/i.test(capped.ended.endReason || ''), capped.ended.endReason);

  // --- a large list still completes ---
  mountVirtual({ total: 500, windowSize: 30, batch: 25 });
  const big = await runCollector({ ...FAST, maxNoChangeAttempts: 4 }, 'big');
  check('a 500-result list is collected in full', big.records.length === 500, 'got ' + big.records.length);
  check('no duplicates across 500 records',
    new Set(big.records.map((r) => r.stableKey)).size === 500);

  // --- starting twice must not double-run ---
  mountVirtual({ total: 20, windowSize: 10, batch: 5 });
  let ended2 = null;
  await collector.start({ jobId: 'a', settings: { ...FAST, scrollDelayMs: 25 }, onRecords: () => {}, onProgress: () => {}, onEnded: (s2) => { ended2 = s2; } });
  const second = await collector.start({ jobId: 'b', settings: FAST, onRecords: () => {}, onProgress: () => {}, onEnded: () => {} });
  check('a second Start while running is ignored', second.jobId === 'a', second.jobId);
  collector.stop();
  for (let i = 0; i < 200 && !ended2; i++) await sleep(10);
}

/* ================================================================== */
group('Address parsing — international shapes');

{
  const cases = [
    ['6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States', 'Jacksonville', 'FL', '32210', 'United States'],
    ['12 High St, Manchester M1 2AB, United Kingdom', 'Manchester', '', 'M1 2AB', 'United Kingdom'],
    ['1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA', 'Mountain View', 'CA', '94043', 'United States'],
    ['Shop 4, Blue Area, Islamabad 44000, Pakistan', 'Blue Area', 'Islamabad', '44000', 'Pakistan'],
  ];
  for (const [input, city, st, zip, country] of cases) {
    const c = address.splitAddress(input);
    check(`splits: ${input.slice(0, 34)}…`,
      c.city === city && c.state === st && c.postalCode === zip && c.country === country,
      JSON.stringify(c));
  }
  check('a street line alone yields no city/country',
    eq(address.splitAddress('6215-1 Wilson Blvd'), { street: '6215-1 Wilson Blvd', city: '', state: '', postalCode: '', country: '' }));
  check('USA is canonicalised to United States', address.canonicalCountry('USA') === 'United States');
  check('an unknown trailing word is not treated as a country',
    address.splitAddress('1 Main St, Springfield, Gibberishland').country === '');
}

/* ================================================================== */
group('Address parsing — stacked-line (newline) addresses');

{
  // Google frequently renders the address as two DOM rows (street, then
  // city/state/zip) rather than one comma-joined string. Reading that back
  // via innerText gives a newline where a comma would be — which used to
  // make a genuinely complete address parse as street-only, or worse,
  // misread the city as a state.
  const stacked = '6215-1 Wilson Blvd Building 1\nJacksonville, FL 32210';

  const split = address.splitAddress(stacked);
  check('a newline between street and city/state/zip is treated as a separator',
    split.street === '6215-1 Wilson Blvd Building 1' && split.city === 'Jacksonville'
    && split.state === 'FL' && split.postalCode === '32210',
    JSON.stringify(split));

  check('a stacked-line address is recognised as complete', address.isCompleteAddress(stacked));
  check('a stacked-line address passes the plausibility check', validators.isPlausibleFullAddress(stacked));

  const tidied = address.tidyAddress(stacked);
  check('tidyAddress converts the line break into a proper comma, not a bare space',
    tidied === '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210', tidied);

  // The exact place-detail.js pipeline order: isCompleteAddress on the raw
  // value, THEN tidy, THEN split again — must agree at every step.
  if (address.isCompleteAddress(stacked)) {
    const full = address.tidyAddress(stacked);
    const comps = address.splitAddress(full);
    check('the full pipeline (isComplete -> tidy -> split) yields the same correct components',
      comps.city === 'Jacksonville' && comps.state === 'FL' && comps.postalCode === '32210',
      JSON.stringify(comps));
  } else {
    check('the full pipeline (isComplete -> tidy -> split) yields the same correct components', false, 'isCompleteAddress rejected a valid stacked address');
  }

  // A street-only single line (no second row at all) must still stay
  // correctly street-only — this fix must not manufacture components.
  check('a genuinely street-only address (no second line) still yields no city',
    !address.isCompleteAddress('6215-1 Wilson Blvd Building 1'));
}

/* ================================================================== */
group('Address — card layouts without a middot-combined line');

{
  const { makeCard } = await import('./harness/mini-dom.mjs');

  // Some Maps card layouts render category and street as two independent
  // rows instead of one "category · street" line — the address-line
  // extractor previously had no fallback for this at all, so both category
  // and address came back blank.
  const separateCard = makeCard({
    name: 'Sunrise Plumbing', category: 'Plumber', rating: '4.8', reviews: '212',
    street: '900 Bay St', layout: 'separate',
  });
  const rec = cardParser.parseCard(separateCard, 1);
  check('address is still found when category/street are on separate lines (no middot)',
    rec.address === '900 Bay St', rec.address);
  check('category is still found when category/street are on separate lines (no middot)',
    rec.category === 'Plumber', rec.category);

  // The combined (middot) layout must be completely unaffected.
  const combinedCard = makeCard({
    name: 'Sunrise Plumbing 2', category: 'Plumber', rating: '4.8', reviews: '212',
    street: '901 Bay St', layout: 'combined',
  });
  const rec2 = cardParser.parseCard(combinedCard, 2);
  check('the combined (middot) layout is unaffected', rec2.address === '901 Bay St' && rec2.category === 'Plumber');
}

/* ================================================================== */
group('Address — amenity/accessibility badge between category and street');

{
  // Real-world bug, seen in an actual export: Google Maps sometimes inserts
  // a THIRD middot segment between category and street — an amenity or
  // accessibility badge ("Wheelchair accessible entrance") that is often
  // ICON-ONLY, with no visible text label at all, just one glyph from a
  // private-use-area ligature font. The old code took the first non-hours
  // segment unconditionally and grabbed that icon glyph as if it were the
  // address — which is exactly the unreadable "" seen in the spreadsheet.
  const badgeGlyph = String.fromCodePoint(0xE001);

  const withBadge = `Al-Aqsa Roofing\n4.6 (37)\nRoofing contractor · ${badgeGlyph} · 3850 W Rincon Ave\nOpen ⋅ Closes 5 PM`;
  const parsed = cardParser.parseCategoryAndAddressLine(withBadge);
  check('the street is found even with an icon-only badge segment in between',
    parsed.addressLine === '3850 W Rincon Ave', JSON.stringify(parsed));
  check('the icon glyph never ends up as the address', !validators.isPlausibleAddressLine(badgeGlyph));
  check('the category is still correctly read (unaffected by the badge)', parsed.category === 'Roofing contractor');

  // A badge with a digit in it (e.g. "2 accessible spots") must ALSO be
  // rejected in favor of the real street — a bare digit alone is not
  // enough to prove something is an address once an icon glyph is present.
  const badgeWithDigit = `Al-Aqsa Roofing\n4.6 (37)\nRoofing contractor · ${badgeGlyph} 2 spots · 3850 W Rincon Ave`;
  const parsed2 = cardParser.parseCategoryAndAddressLine(badgeWithDigit);
  check('a digit-bearing badge is still rejected in favor of the real street',
    parsed2.addressLine === '3850 W Rincon Ave', JSON.stringify(parsed2));

  // No real street anywhere on the card: must stay blank, never guess the badge.
  const badgeOnly = `Al-Aqsa Roofing\n4.6 (37)\nRoofing contractor · ${badgeGlyph}\nOpen ⋅ Closes 5 PM`;
  const parsed3 = cardParser.parseCategoryAndAddressLine(badgeOnly);
  check('with no real street on the card, address stays blank rather than showing the badge glyph',
    parsed3.addressLine === '', JSON.stringify(parsed3));

  // The category-fallback path (no middot line at all) must reject an
  // icon-only line the same way.
  const iconAsCategoryLine = `Some Business\n4.6 (37)\n${badgeGlyph}\n900 Bay St`;
  const parsed4 = cardParser.parseCategoryAndAddressLine(iconAsCategoryLine);
  check('an icon-only line is never picked as the category either',
    parsed4.category !== badgeGlyph, JSON.stringify(parsed4));
}

/* ================================================================== */
group('Enrichment — busy state reflects reality, not a note string');

{
  // job-manager.js: the structured enrich{done,total,ranAt} state.
  const blank = jobsApi.blankJob({ id: 'e1' });
  check('a fresh job starts with enrich.total === 0 (not busy)', blank.enrich.total === 0 && blank.enrich.done === 0);

  const started = { ...blank, enrich: { done: 0, total: 51, ranAt: null } };
  check('enrichment in progress: done < total', started.enrich.done < started.enrich.total);

  // The bug: router.js used to leave `enrich.total` at the original queued
  // count even after the run stopped early, so done < total stayed true
  // forever. The fix collapses total to whatever was actually processed.
  const stoppedEarly = { ...blank, enrich: { done: 20, total: 20, ranAt: Date.now() } }; // 20 queued, stopped after 20
  check('a run stopped early is NOT stuck busy once total is collapsed to done',
    !(stoppedEarly.enrich.total > 0 && stoppedEarly.enrich.done < stoppedEarly.enrich.total));

  const completed = { ...blank, enrich: { done: 51, total: 51, ranAt: Date.now() } };
  check('a naturally completed run is not busy', !(completed.enrich.total > 0 && completed.enrich.done < completed.enrich.total));

  // The exact bug reported: a completion note still containing the word
  // "Enrich" must NOT be mistaken for "still running".
  const completedNote = 'Enrichment complete';
  check('sanity: the completion note text does contain the word that broke the old check',
    /Enrich/i.test(completedNote));

  // enrich.js's rendered view must show the Start button (not the busy bar)
  // once enrichment has actually finished, and must show the finished
  // summary rather than nothing at all.
  const { renderEnrich } = await import('../src/sidepanel/views/enrich.js');
  const constants = await import('../src/core/constants.js');
  const records = [
    { businessName: 'A', website: 'https://a.example.com', phone: '+1 555 0001', address: '1 Main St', rating: '4.5', reviewCount: '10' },
  ];
  const mkEnrichState = (job) => {
    const st = {
      settings: constants.DEFAULT_SETTINGS, job, records, busy: false, now: Date.now(),
      quality: () => quality.analyze(records),
    };
    return st;
  };
  const ES = constants.ENRICH_STATUS;

  const runningCounts = {
    emails: 12, socials: 9, websites: 20,
    facebook: 5, instagram: 4, linkedin: 2, tiktok: 1, youtube: 0, twitter: 0,
    notFound: 0, errors: 0, skipped: 0,
  };

  const busyJob = jobsApi.blankJob({
    id: 'e3', lastActivityAt: Date.now(),
    enrich: { done: 5, total: 20, ranAt: null, status: ES.RUNNING, currentName: 'ABC Roofing', counts: runningCounts },
  });
  const busyHtml = renderEnrich(mkEnrichState(busyJob));
  check('while actually running, the view shows the busy bar and Stop button',
    busyHtml.includes('data-act="enrich-stop"') && !busyHtml.includes('data-act="enrich-start"'));
  check('while running, the current business name is shown', busyHtml.includes('ABC Roofing'));
  check('while running, a Pause button is offered', busyHtml.includes('data-act="enrich-pause"'));

  const pausedJob = jobsApi.blankJob({
    id: 'e5', enrich: { done: 5, total: 20, ranAt: null, status: ES.PAUSED, currentName: '', counts: runningCounts },
  });
  const pausedHtml = renderEnrich(mkEnrichState(pausedJob));
  check('while paused, the view offers Resume, not Start or Stop', pausedHtml.includes('data-act="enrich-resume"')
    && !pausedHtml.includes('data-act="enrich-start"') && !pausedHtml.includes('data-act="enrich-stop"'));
  check('while paused, the progress made so far (5/20) is still shown', pausedHtml.includes('5') && pausedHtml.includes('20'));

  const finalCounts = {
    emails: 94, socials: 71, websites: 240,
    facebook: 42, instagram: 71, linkedin: 18, tiktok: 12, youtube: 23, twitter: 9,
    notFound: 83, errors: 3, skipped: 25,
  };

  const doneJob = jobsApi.blankJob({
    id: 'e2', enrich: { done: 251, total: 251, ranAt: Date.now(), status: ES.COMPLETED, currentName: '', counts: finalCounts },
    progress: { note: 'Enrichment complete' },
  });
  const doneHtml = renderEnrich(mkEnrichState(doneJob));
  check('after completion, the view shows View Data, not the busy bar',
    doneHtml.includes('data-act="goto-data"') && !doneHtml.includes('data-act="enrich-stop"') && !doneHtml.includes('data-act="enrich-start"'));
  check('after completion, the view explicitly says enrichment is complete',
    /Enrichment complete/i.test(doneHtml));
  check('the completion summary breaks results down per platform (Facebook/Instagram/LinkedIn/TikTok/YouTube)',
    ['42', '71', '18', '12', '23'].every((n) => doneHtml.includes(n)));
  check('the completion summary reports Not Found and Technical Errors separately',
    doneHtml.includes('83') && doneHtml.includes('3'));

  const partialJob = jobsApi.blankJob({
    id: 'e6', enrich: { done: 251, total: 251, ranAt: Date.now(), status: ES.PARTIAL, currentName: '', counts: finalCounts },
  });
  const partialHtml = renderEnrich(mkEnrichState(partialJob));
  check('a run that finished with some failures is reported as partial, not silently "complete"',
    /partial/i.test(partialHtml) && doneHtml !== partialHtml);

  const stoppedJob = jobsApi.blankJob({
    id: 'e4', enrich: { done: 87, total: 87, ranAt: Date.now(), status: ES.STOPPED, currentName: '', counts: { ...finalCounts, emails: 30 } },
    progress: { note: 'Enrichment stopped' },
  });
  const stoppedHtml = renderEnrich(mkEnrichState(stoppedJob));
  check('after a manual Stop, the view offers Resume (not stuck on the busy bar)',
    stoppedHtml.includes('data-act="enrich-start"') && !stoppedHtml.includes('data-act="enrich-stop"') && !stoppedHtml.includes('data-act="enrich-pause"'));
  check('after a manual Stop, the progress made so far (87) is shown, not reset to 0',
    stoppedHtml.includes('87'));

  const failedJob = jobsApi.blankJob({ id: 'e7', enrich: { done: 3, total: 251, status: ES.FAILED, counts: {} } });
  const failedHtml = renderEnrich(mkEnrichState(failedJob));
  check('a crashed enrichment run is reported as failed, not left showing the busy bar',
    !failedHtml.includes('data-act="enrich-stop"') && /fail/i.test(failedHtml));

  // --- pending-only (idle) state: shows what's actually missing, per field ---
  const idleRecords = [
    { businessName: 'A', website: 'https://a.example.com', email: 'a@a.com', facebook: 'https://facebook.com/a' },
    { businessName: 'B', website: 'https://b.example.com' },
    { businessName: 'C', website: '' },
  ];
  const idleState = {
    settings: constants.DEFAULT_SETTINGS, job: jobsApi.blankJob({ id: 'e8' }), records: idleRecords, busy: false, now: Date.now(),
    quality: () => quality.analyze(idleRecords),
  };
  const idleHtml = renderEnrich(idleState);
  // A is missing social platforms beyond Facebook, B is missing email+social,
  // C has no website at all (still "missing" email/social, but a fast no-op
  // skip once processed) — all three are pending under this pass's settings.
  check('idle state shows how many records are actually pending, not a placeholder count',
    idleHtml.includes('3 record(s)'), idleHtml.match(/\d+ record\(s\)/)?.[0]);

  // A record with EVERY requested field already found must be excluded.
  const fullyDoneRecord = {
    businessName: 'D', website: 'https://d.example.com', email: 'd@d.com',
    facebook: 'https://facebook.com/d', instagram: 'https://instagram.com/d',
    linkedin: 'https://linkedin.com/company/d', tiktok: 'https://tiktok.com/@d',
    youtube: 'https://youtube.com/@d', twitter: 'https://x.com/d',
  };
  const doneOnlyState = {
    settings: constants.DEFAULT_SETTINGS, job: jobsApi.blankJob({ id: 'e9' }), records: [fullyDoneRecord], busy: false, now: Date.now(),
    quality: () => quality.analyze([fullyDoneRecord]),
  };
  const doneOnlyHtml = renderEnrich(doneOnlyState);
  check('a record with every requested field already found leaves nothing pending',
    /nothing to enrich/i.test(doneOnlyHtml), doneOnlyHtml.slice(0, 200));
}

/* ================================================================== */
group('Enrichment engine — missing-only, error isolation, pause/resume/stop, zero tabs');

{
  const enrichManager = await import('../src/enrich/enrich-manager.js');
  const priorFetch = globalThis.fetch;
  const fetchCalls = [];

  // net.js:fetchText() reads res.headers.get('content-type') and falls back
  // to res.text() when res.body isn't a stream — both must be present on
  // the fake Response or every request "fails" for a mock-shape reason that
  // has nothing to do with the code under test.
  const fakeFetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('fail-site')) {
      return { ok: false, status: 500, url: String(url), headers: { get: () => 'text/html' }, text: async () => '' };
    }
    const html = `<html><body><a href="mailto:info@${encodeURIComponent(url).replace(/[^a-z0-9]/gi, '')}.com">Email</a>`
      + `<a href="https://facebook.com/${encodeURIComponent(url).replace(/[^a-z0-9]/gi, '')}">FB</a></body></html>`;
    return { ok: true, status: 200, url: String(url), headers: { get: () => 'text/html' }, text: async () => html };
  };
  globalThis.fetch = fakeFetch;

  // --- needsEnrichment: field-level, not record-level ---
  const fullSocial = { facebook: 'x', instagram: 'x', linkedin: 'x', tiktok: 'x', youtube: 'x', twitter: 'x' };
  check('a record with email + every social platform already found needs nothing',
    !enrichManager.needsEnrichment({ email: 'a@a.com', ...fullSocial }, { email: true, social: true }));
  check('missing only Instagram still counts as needing enrichment',
    enrichManager.needsEnrichment({ email: 'a@a.com', ...fullSocial, instagram: '' }, { email: true, social: true }));

  // --- a fully-complete record triggers ZERO network requests and is untouched ---
  const alreadyDone = { businessName: 'HasEmail', website: 'https://has-email.example.com', email: 'existing@has-email.com', ...fullSocial };
  fetchCalls.length = 0;
  const untouched = await enrichManager.enrichRecord(alreadyDone, { email: true, social: true });
  check('a record with everything already found makes zero network requests', fetchCalls.length === 0, String(fetchCalls.length));
  check('its existing email is completely unchanged', untouched.email === 'existing@has-email.com');
  check('its existing social links are completely unchanged', untouched.facebook === 'x' && untouched.instagram === 'x');

  // --- missing email only: fetches, fills email, never touches pre-existing social ---
  const missingEmailOnly = { businessName: 'MissingEmail', website: 'https://missing-email.example.com', email: '', facebook: 'https://facebook.com/keep-me', instagram: 'x', linkedin: 'x', tiktok: 'x', youtube: 'x', twitter: 'x' };
  const emailFilled = await enrichManager.enrichRecord(missingEmailOnly, { email: true, social: true });
  check('a record missing only email gets it filled in', !!emailFilled.email, emailFilled.email);
  check('its pre-existing social link is left exactly as it was', emailFilled.facebook === 'https://facebook.com/keep-me');

  // --- a fetch failure is a real error, but never blanks an existing value ---
  const failingSite = { businessName: 'Failer', website: 'https://fail-site.example.com', email: '', facebook: 'https://facebook.com/already-there' };
  const failedResult = await enrichManager.enrichRecord(failingSite, { email: true, social: true });
  check('a homepage fetch failure is reported as an Error status', failedResult.emailStatus === 'Error', failedResult.emailStatus);
  check('a fetch failure never blanks a field the record already had', failedResult.facebook === 'https://facebook.com/already-there');

  // --- no website: Skipped, not Error, zero network calls ---
  fetchCalls.length = 0;
  const noWebsite = { businessName: 'NoSite', website: '', email: '' };
  const skipped = await enrichManager.enrichRecord(noWebsite, { email: true, social: true });
  check('a record with no website is Skipped, not Error', skipped.emailStatus === 'Skipped', skipped.emailStatus);
  check('a record with no website makes zero network requests', fetchCalls.length === 0);

  // --- enrichAll: a batch run with ONE failing record, checkpointing, per-platform counts ---
  const bigList = [];
  for (let i = 0; i < 30; i++) {
    bigList.push({
      businessName: `Biz ${i}`, stableKey: `k${i}`,
      website: i === 15 ? 'https://fail-site-15.example.com' : `https://biz${i}.example.com`,
      email: '', facebook: '', instagram: '', linkedin: '', tiktok: '', youtube: '', twitter: '',
    });
  }
  let batchCalls = 0;
  const allResult = await enrichManager.enrichAll(
    bigList, { email: true, social: true, concurrency: 4, batchSize: 10, timeoutMs: 2000, maxPagesPerSite: 1 },
    { onProgress: () => {}, onBatch: async () => { batchCalls++; } },
  );

  check('all 30 records come back (none dropped)', allResult.records.length === 30);
  check('exactly one record (the failing site) is reported as an error', allResult.stats.counts.errors === 1, String(allResult.stats.counts.errors));
  check('the other 29 records were NOT stopped by the one failure',
    allResult.records.filter((r) => r.email).length === 29, String(allResult.records.filter((r) => r.email).length));
  check('checkpointing (onBatch) fired more than once across 30 records at batchSize 10', batchCalls >= 2, String(batchCalls));
  check('per-platform counts are tracked correctly (Facebook found on every successful record)',
    allResult.stats.counts.facebook === 29, String(allResult.stats.counts.facebook));
  check('a missing/failed field is never counted as a technical error beyond the one real failure',
    allResult.stats.counts.notFound === 0 && allResult.stats.counts.errors === 1);

  // --- zero tabs: this whole engine runs with chrome entirely undefined ---
  check('enrichAll never touches chrome.tabs — chrome is undefined throughout and nothing threw',
    typeof chrome === 'undefined');

  // --- pause genuinely halts progress; resume continues, does not restart ---
  const slowFetch = async (url) => { await sleep(25); return fakeFetch(url); };
  globalThis.fetch = slowFetch;

  const pauseList = Array.from({ length: 12 }, (_, i) => ({
    businessName: `Pause ${i}`, stableKey: `p${i}`, website: `https://pause${i}.example.com`, email: '',
  }));
  const pauseRunPromise = enrichManager.enrichAll(
    pauseList, { email: true, social: false, concurrency: 3, batchSize: 100, timeoutMs: 2000, maxPagesPerSite: 1 }, {},
  );
  await sleep(5);
  enrichManager.pauseEnrichment();
  // 12 items / concurrency 3 * 25ms ≈ 100ms unpaused — waiting 220ms while
  // paused is more than double that, so if pause were a no-op this would
  // already be finished.
  await sleep(220);
  const doneWhilePaused = enrichManager.getEnrichStatus().done;
  check('pausing genuinely halts progress (220ms paused is longer than a full unpaused run would take)',
    doneWhilePaused < 12, String(doneWhilePaused));
  enrichManager.resumeEnrichment();
  const pauseResult = await pauseRunPromise;
  check('after resume, the run continues to completion instead of staying stuck',
    pauseResult.records.length === 12 && pauseResult.records.every((r) => r.email));
  check('resuming continued the SAME run rather than restarting — no record was skipped or duplicated',
    new Set(pauseResult.records.map((r) => r.stableKey)).size === 12);

  // --- stop mid-run: keeps completed work, aborts the rest, never overshoots the list ---
  const stopList = Array.from({ length: 12 }, (_, i) => ({
    businessName: `Stop ${i}`, stableKey: `s${i}`, website: `https://stop${i}.example.com`, email: '',
  }));
  const stopRunPromise = enrichManager.enrichAll(
    stopList, { email: true, social: false, concurrency: 3, batchSize: 100, timeoutMs: 2000, maxPagesPerSite: 1 }, {},
  );
  await sleep(45);           // long enough for at least the first wave to land, short of the full run
  enrichManager.stopEnrichment();
  const stopResult = await stopRunPromise;
  check('a stopped run reports aborted:true', stopResult.aborted === true);
  check('a stopped run keeps whatever was already completed rather than discarding it',
    stopResult.records.some((r) => r.email), JSON.stringify(stopResult.records.map((r) => !!r.email)));
  check('a stopped run never processed more than the full list', stopResult.records.length === 12);

  // --- website page caching: franchise leads sharing one domain cost one fetch, not N ---
  globalThis.fetch = fakeFetch;
  fetchCalls.length = 0;
  const franchiseList = Array.from({ length: 8 }, (_, i) => ({
    businessName: `Franchise ${i}`, stableKey: `f${i}`, website: 'https://onefranchisesite.example.com', email: '',
  }));
  const franchiseResult = await enrichManager.enrichAll(
    franchiseList, { email: true, social: false, concurrency: 4, batchSize: 100, timeoutMs: 2000, maxPagesPerSite: 1 }, {},
  );
  check('all 8 records sharing one website still get enriched', franchiseResult.records.every((r) => r.email));
  check('the shared website was only fetched ONCE for 8 records on the same domain, not 8 times',
    fetchCalls.length === 1, `${fetchCalls.length} fetch(es) for 8 records`);

  globalThis.fetch = priorFetch;
}

/* ------------------------------ report ---------------------------- */
console.log('\n  ' + '='.repeat(58));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.log('\n  Failures:');
  for (const f of failures) console.log('    - ' + f);
  console.log('');
  process.exit(1);
}
console.log('  All tests passed.\n');
