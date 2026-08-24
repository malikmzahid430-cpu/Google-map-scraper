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
group('Detail resolver — failure containment (v3.0.1 regressions)');

{
  const resolver = await import('../src/background/detail-resolver.js');
  const constants = await import('../src/core/constants.js');
  const FS = constants.FIELD_STATUS;

  const makeRecords = (n) => Array.from({ length: n }, (u, i) => ({
    serial: i + 1, businessName: 'B' + i, mapsUrl: 'https://www.google.com/maps/place/B' + i,
  }));

  // --- the browser refuses to open ANY tab ---
  globalThis.chrome = {
    tabs: {
      create: async () => { throw new Error('Cannot create tab'); },
      remove: async () => {},
      update: async () => {},
      sendMessage: async () => ({ ok: true, data: {} }),
      onUpdated: { addListener() {}, removeListener() {} },
    },
  };
  const noTabs = await resolver.resolveAll(makeRecords(5), { detailConcurrency: 2, detailTimeoutMs: 100 }, {});
  check('a tab-create failure does not throw', !!noTabs && Array.isArray(noTabs.records));
  check('records are marked Failed, never a fabricated "Not Found"',
    noTabs.records.every((r) => r.fullAddressStatus === FS.FAILED),
    JSON.stringify(noTabs.records.map((r) => r.fullAddressStatus)));
  check('the inability to open a tab is reported as a technical error',
    (noTabs.stats.technicalErrors || []).some((e) => e.category === 'communication'),
    JSON.stringify(noTabs.stats.technicalErrors));

  // --- one worker explodes mid-run, the other must finish its share ---
  let created = 0;
  const seenTabs = [];
  globalThis.chrome = {
    tabs: {
      create: async () => { created += 1; const id = 500 + created; seenTabs.push(id); return { id }; },
      remove: async () => {},
      update: async (id) => { if (id === 501) throw new Error('tab exploded'); },
      sendMessage: async () => ({
        ok: true,
        data: {
          fullAddress: '1 Main St, Town, ST 11111, United States',
          website: 'https://example.com', phone: '+1 904 555 0100',
          address: '1 Main St', city: 'Town', state: 'ST', postalCode: '11111', country: 'United States',
          via: {},
        },
      }),
      onUpdated: {
        addListener(fn) { this._fn = fn; setTimeout(() => { for (const t of seenTabs) fn(t, { status: 'complete' }); }, 5); },
        removeListener() {},
      },
    },
  };
  const partial = await resolver.resolveAll(makeRecords(6), {
    detailConcurrency: 2, detailTimeoutMs: 400, detailRetries: 0, detailPaceMs: 1, detailSettleMs: 1,
  }, {});
  check('a failing worker does not abort the run', !!partial && partial.records.length === 6);
  const resolved = partial.records.filter((r) => r.fullAddress).length;
  check('the healthy worker still resolved its share', resolved > 0, 'resolved ' + resolved + '/6');
  check('no record is left claiming Pending forever',
    partial.records.every((r) => r.fullAddressStatus !== FS.PENDING),
    JSON.stringify(partial.records.map((r) => r.fullAddressStatus)));

  // --- our own tabs must be identifiable ---
  check('detail tabs are released after the run', resolver.detailTabIds().length === 0,
    JSON.stringify(resolver.detailTabIds()));
  check('isDetailTab reports false for an unknown tab', resolver.isDetailTab(999999) === false);

  const rsrc = fs.readFileSync(new URL('../src/background/router.js', import.meta.url), 'utf8');
  check('findMapsTab excludes the resolver\'s own tabs', /isDetailTab/.test(rsrc.slice(rsrc.indexOf('async function findMapsTab'), rsrc.indexOf('async function activeJobId'))));
  check('the queue hook ignores detail tabs',
    /if \(detailResolver\.isDetailTab\(tabId\)\) return;/.test(rsrc));

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
