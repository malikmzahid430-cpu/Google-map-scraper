/**
 * Al-Aqsa Scraper — shared constants.
 * This module imports nothing. Everything else may import it.
 */

export const APP_NAME = 'Al-Aqsa Scraper';
export const APP_VERSION = '4.2.0';

/* ------------------------------------------------------------------ *
 * Storage keys. Records are sharded per job so a big job never has to
 * be rewritten wholesale on every flush.
 * ------------------------------------------------------------------ */
export const SK = {
  SETTINGS: 'aq.settings',
  PROJECTS: 'aq.projects',
  ACTIVE_PROJECT: 'aq.activeProject',
  JOB_INDEX: 'aq.jobs.index',
  JOB: (id) => `aq.job.${id}`,
  RECORDS: (id) => `aq.records.${id}`,
  ACTIVE_JOB: 'aq.activeJob',
  QUEUE: 'aq.queue',
  DIAGNOSTICS: 'aq.diagnostics',
  LOG: 'aq.log',
  SHEETS: 'aq.sheets',
};

/* ------------------------------------------------------------------ *
 * Message types. Every cross-context message uses one of these.
 * Unknown types are answered with an error envelope, never thrown.
 * ------------------------------------------------------------------ */
export const MSG = {
  // side panel -> content script (via background)
  COLLECT_START: 'collect:start',
  COLLECT_PAUSE: 'collect:pause',
  COLLECT_RESUME: 'collect:resume',
  COLLECT_STOP: 'collect:stop',
  COLLECT_STATUS: 'collect:status',

  // content script -> background
  COLLECT_PROGRESS: 'collect:progress',
  COLLECT_RECORDS: 'collect:records',
  COLLECT_ENDED: 'collect:ended',

  // side panel -> background
  ENRICH_START: 'enrich:start',
  ENRICH_STOP: 'enrich:stop',
  DEDUPE_RUN: 'dedupe:run',
  VALIDATE_RUN: 'validate:run',
  SCORE_RUN: 'score:run',

  EXPORT_CSV: 'export:csv',
  EXPORT_XLSX: 'export:xlsx',
  EXPORT_SHEETS: 'export:sheets',

  SHEETS_STATUS: 'sheets:status',
  SHEETS_SIGNIN: 'sheets:signin',
  SHEETS_SIGNOUT: 'sheets:signout',
  SHEETS_LIST: 'sheets:list',
  SHEETS_CREATE: 'sheets:create',

  DIAG_RUN: 'diag:run',
  DIAG_PAGE_PROBE: 'diag:pageProbe',

  // Home screen: "is there already a Google Maps search open?"
  MAPS_DETECT: 'maps:detect',

  // detail resolution (post-collection)
  DETAIL_START: 'detail:start',
  DETAIL_STOP: 'detail:stop',
  DETAIL_PAUSE: 'detail:pause',
  DETAIL_RESUME: 'detail:resume',
  DETAIL_EXTRACT: 'detail:extract',      // worker -> a place tab

  // jobs & datasets
  JOBS_LIST: 'jobs:list',
  JOB_OPEN: 'job:open',
  JOB_DELETE: 'job:delete',
  JOB_RENAME: 'job:rename',
  JOBS_COMBINE: 'jobs:combine',

  QUEUE_RUN: 'queue:run',
  QUEUE_STOP: 'queue:stop',

  NET_FETCH: 'net:fetch',
  PING: 'ping',
  STATE_CHANGED: 'state:changed',
};

/* ------------------------------------------------------------------ */
export const JOB_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  ERROR: 'error',
};

export const MODE = {
  FAST: 'fast',
  STANDARD: 'standard',
  ADVANCED: 'advanced',
};

/**
 * Which core fields each mode collects.
 *
 * Documentation for the UI's mode descriptions. The collector always reads
 * every card field it can; this describes the OUTCOME of a mode — FAST simply
 * never runs the detail stage, which is what makes it fast.
 */
export const MODE_FIELDS = {
  [MODE.FAST]: ['businessName', 'category', 'rating', 'reviewCount', 'mapsUrl'],
  [MODE.STANDARD]: [
    'businessName', 'category', 'rating', 'reviewCount',
    'address', 'fullAddress', 'website', 'phone', 'mapsUrl',
  ],
  [MODE.ADVANCED]: [
    'businessName', 'category', 'rating', 'reviewCount',
    'address', 'fullAddress', 'website', 'phone', 'mapsUrl',
    'latitude', 'longitude',
  ],
};

/** Modes that need the per-place detail request. */
export const MODE_NEEDS_DETAIL = {
  [MODE.FAST]: false,
  [MODE.STANDARD]: true,
  [MODE.ADVANCED]: true,
};

/* ------------------------------------------------------------------ *
 * Field catalogue — drives the field picker, the exporter columns and
 * the validation engine. `group` controls which UI section it appears in.
 * ------------------------------------------------------------------ */
export const FIELDS = [
  { key: 'businessName', label: 'Business Name', group: 'core', default: true },
  { key: 'category', label: 'Category', group: 'core', default: true },
  { key: 'rating', label: 'Review Rating', group: 'core', default: true },
  { key: 'reviewCount', label: 'Number of Reviews', group: 'core', default: true },
  { key: 'address', label: 'Address', group: 'core', default: false },
  { key: 'fullAddress', label: 'Full Address', group: 'core', default: true },
  { key: 'city', label: 'City', group: 'core', default: false },
  { key: 'state', label: 'State / Region', group: 'core', default: false },
  { key: 'postalCode', label: 'Postal Code', group: 'core', default: false },
  { key: 'country', label: 'Country', group: 'core', default: false },
  { key: 'website', label: 'Website', group: 'core', default: true },
  { key: 'phone', label: 'Phone', group: 'core', default: true },
  { key: 'mapsUrl', label: 'Maps URL', group: 'core', default: true },
  { key: 'latitude', label: 'Latitude', group: 'core', default: false },
  { key: 'longitude', label: 'Longitude', group: 'core', default: false },

  { key: 'email', label: 'Email', group: 'enrich', default: true },
  { key: 'emailStatus', label: 'Email Status', group: 'enrich', default: false },
  { key: 'facebook', label: 'Facebook', group: 'enrich', default: true },
  { key: 'instagram', label: 'Instagram', group: 'enrich', default: true },
  { key: 'tiktok', label: 'TikTok', group: 'enrich', default: false },
  { key: 'linkedin', label: 'LinkedIn', group: 'enrich', default: true },
  { key: 'youtube', label: 'YouTube', group: 'enrich', default: false },
  { key: 'twitter', label: 'X / Twitter', group: 'enrich', default: false },

  { key: 'leadScore', label: 'Lead Score', group: 'quality', default: true },
  { key: 'validationStatus', label: 'Validation', group: 'quality', default: false },
  { key: 'websiteStatus', label: 'Website Status', group: 'quality', default: false },
  { key: 'fullAddressStatus', label: 'Full Address Status', group: 'quality', default: false },
  { key: 'phoneStatus', label: 'Phone Status', group: 'quality', default: false },

  { key: 'scrapedAt', label: 'Date Scraped', group: 'source', default: true },
  { key: 'searchQuery', label: 'Search Query', group: 'source', default: true },
  { key: 'searchLocation', label: 'Search Location', group: 'source', default: true },
  { key: 'jobId', label: 'Job ID', group: 'source', default: false },
  { key: 'projectName', label: 'Project', group: 'source', default: false },
  { key: 'placeId', label: 'Place ID', group: 'source', default: false },
];

/** Field groups, in the order the UI shows them. */
export const FIELD_GROUPS = [
  { id: 'core', label: 'Maps data' },
  { id: 'enrich', label: 'Enrichment' },
  { id: 'quality', label: 'Quality' },
  { id: 'source', label: 'Source' },
];

/**
 * FIELD MAPPING — what each field means, where it comes from, what it looks
 * like. Rendered verbatim in the UI so there is never any doubt about which
 * value a column holds or which stage produces it.
 */
export const FIELD_MAPPING = [
  { key: 'businessName', source: 'Google Maps result card', stage: 'Collection',
    description: 'The business name as Maps lists it.',
    example: 'Al-Aqsa Roofing' },
  { key: 'category', source: 'Google Maps result card', stage: 'Collection',
    description: 'Primary Maps category, taken from the text before the middot on the card.',
    example: 'Roofing contractor' },
  { key: 'rating', source: 'Google Maps rating element (ARIA label)', stage: 'Collection',
    description: 'Star rating, 0–5, decimal preserved. Read from the star widget ARIA label first because it is locale-tagged.',
    example: '4.6' },
  { key: 'reviewCount', source: 'Google Maps review count', stage: 'Collection',
    description: 'Number of reviews, parsed separately from the rating so the two can never merge.',
    example: '264' },
  { key: 'address', source: 'Google Maps result card', stage: 'Collection',
    description: 'Street-level line as shown on the card. NOT the complete postal address.',
    example: '6215-1 Wilson Blvd Building 1' },
  { key: 'fullAddress', source: 'Google Maps place detail panel', stage: 'Detail resolution',
    description: 'Complete postal address: street, city, region, postal code and country. Left blank rather than filled with a partial street line.',
    example: '6215-1 Wilson Blvd Building 1, Jacksonville, FL 32210, United States' },
  { key: 'city', source: 'Parsed from Full Address', stage: 'Detail resolution',
    description: 'Locality component split out of the complete address.', example: 'Jacksonville' },
  { key: 'state', source: 'Parsed from Full Address', stage: 'Detail resolution',
    description: 'State or region component.', example: 'FL' },
  { key: 'postalCode', source: 'Parsed from Full Address', stage: 'Detail resolution',
    description: 'Postal or ZIP code component.', example: '32210' },
  { key: 'country', source: 'Parsed from Full Address', stage: 'Detail resolution',
    description: 'Country component. Never inferred from a postcode or phone prefix.', example: 'United States' },
  { key: 'website', source: 'Google Maps Website control (data-item-id="authority")', stage: 'Detail resolution',
    description: 'The business website Maps links to. Google-owned, schema.org and Maps-internal URLs are rejected.',
    example: 'https://alaqsaroofing.com' },
  { key: 'phone', source: 'Google Maps phone control (data-item-id="phone:tel:…")', stage: 'Detail resolution',
    description: 'Business phone as Maps publishes it, formatting preserved.', example: '+1 904-516-4279' },
  { key: 'mapsUrl', source: 'Google Maps result card link', stage: 'Collection',
    description: 'Canonical place URL, stripped of the map viewport so it stays stable.',
    example: 'https://www.google.com/maps/place/Al-Aqsa+Roofing' },
  { key: 'latitude', source: 'Maps URL / place payload', stage: 'Collection',
    description: 'Latitude when Maps exposes it. Blank when it does not.', example: '30.2419' },
  { key: 'longitude', source: 'Maps URL / place payload', stage: 'Collection',
    description: 'Longitude when Maps exposes it. Blank when it does not.', example: '-81.7412' },
  { key: 'email', source: 'The business website', stage: 'Enrichment',
    description: 'Public contact address read from the homepage, contact or about page. Never guessed or generated.',
    example: 'info@alaqsaroofing.com' },
  { key: 'facebook', source: 'The business website', stage: 'Enrichment',
    description: 'Facebook profile linked from the site. Share and intent URLs are rejected.',
    example: 'https://facebook.com/alaqsaroofing' },
  { key: 'instagram', source: 'The business website', stage: 'Enrichment',
    description: 'Instagram profile linked from the site.', example: 'https://instagram.com/alaqsaroofing' },
  { key: 'linkedin', source: 'The business website', stage: 'Enrichment',
    description: 'LinkedIn company or person page linked from the site.', example: 'https://linkedin.com/company/al-aqsa-roofing' },
  { key: 'tiktok', source: 'The business website', stage: 'Enrichment',
    description: 'TikTok profile linked from the site.', example: 'https://tiktok.com/@alaqsaroofing' },
  { key: 'youtube', source: 'The business website', stage: 'Enrichment',
    description: 'YouTube channel linked from the site.', example: 'https://youtube.com/@alaqsaroofing' },
  { key: 'twitter', source: 'The business website', stage: 'Enrichment',
    description: 'X / Twitter profile linked from the site.', example: 'https://x.com/alaqsaroof' },
  { key: 'leadScore', source: 'Computed from the record', stage: 'Scoring',
    description: 'Completeness score normalised to 0–100. Junk values earn nothing.', example: '87' },
  { key: 'validationStatus', source: 'Computed from the record', stage: 'Validation',
    description: 'Valid / Partial / Invalid, based on per-field format checks.', example: 'Valid' },
  { key: 'scrapedAt', source: 'Extension clock', stage: 'Collection',
    description: 'When this record was collected.', example: '2026-08-23 10:30' },
  { key: 'searchQuery', source: 'Your search', stage: 'Collection',
    description: 'The search term this record came from.', example: 'Roofing contractors' },
  { key: 'searchLocation', source: 'Your search', stage: 'Collection',
    description: 'The location this record came from.', example: 'Jacksonville, FL' },
  { key: 'jobId', source: 'Job manager', stage: 'Collection',
    description: 'Which collection run produced this record.', example: 'job_mt4n_9x2' },
];

export const SOCIAL_KEYS = ['facebook', 'instagram', 'tiktok', 'linkedin', 'youtube', 'twitter'];

/**
 * Why a field is empty. Only FAILED is a technical problem; every other value
 * is ordinary data quality. This distinction is the whole point of the v3
 * error model — see core/quality.js.
 */
export const FIELD_STATUS = {
  FOUND: 'Found',
  NOT_FOUND: 'Not Found',        // Google/the site simply does not publish it
  NOT_REQUESTED: 'Not Requested', // the mode or settings did not ask for it
  PENDING: 'Pending',             // queued for resolution, not done yet
  FAILED: 'Failed',               // a real failure: timeout, exception, network
};

export const EMAIL_STATUS = {
  FOUND: 'Found',
  NOT_FOUND: 'Not Found',
  SKIPPED: 'Skipped',
  ERROR: 'Error',
};

/** Fields the data-quality analyser tracks coverage for. */
export const QUALITY_FIELDS = [
  { key: 'fullAddress', label: 'Full Address' },
  { key: 'website', label: 'Website' },
  { key: 'phone', label: 'Phone' },
  { key: 'rating', label: 'Rating' },
  { key: 'email', label: 'Email' },
  { key: 'social', label: 'Social Profiles' },
  { key: 'coordinates', label: 'Coordinates' },
];

/** Technical error categories. These are the ONLY things counted as errors. */
export const TECH_ERROR = {
  PARSER: 'parser',
  TIMEOUT: 'timeout',
  STORAGE: 'storage',
  COMMUNICATION: 'communication',
  COLLECTOR: 'collector',
  UNEXPECTED: 'unexpected',
};

/* ------------------------------------------------------------------ *
 * Hosts that must never be treated as a business website or a social
 * profile. This list is the reason `http://schema.org/Place` can no
 * longer reach the Website column.
 * ------------------------------------------------------------------ */
export const BLOCKED_WEBSITE_HOSTS = [
  'schema.org', 'www.schema.org',
  'google.com', 'www.google.com', 'maps.google.com', 'goo.gl', 'maps.app.goo.gl',
  'gstatic.com', 'ggpht.com', 'googleusercontent.com', 'googleapis.com',
  'g.page', 'business.google.com', 'support.google.com', 'accounts.google.com',
  'youtu.be',
];

export const BLOCKED_WEBSITE_SUBSTRINGS = [
  'schema.org', '/maps/', 'google.com/url?', '/search?', 'gstatic', 'googleusercontent',
];

export const DEFAULT_SETTINGS = {
  mode: MODE.STANDARD,
  fields: FIELDS.filter((f) => f.default).map((f) => f.key),

  /* --- collection --- */
  feedWaitMs: 15000,           // how long to wait for the results list to appear
  scrollDelayMs: 700,
  // How many consecutive fruitless scrolls before the end of the list is
  // accepted. Deliberately patient: Maps often pauses mid-list, and declaring
  // the end too early is what made v2 stop short.
  maxNoChangeAttempts: 8,
  maxRecords: 0,               // 0 = collect everything

  /* --- detail resolution (a separate stage, no cap, no tabs) ---
   * Only records still missing Full Address, Website or Phone after
   * collection reach this stage at all — most don't, because card-parser.js
   * already reads Website/Phone straight off the results card when Google
   * renders them there. What's left is resolved via concurrent same-origin
   * fetches from the Maps tab's own content script, never a new tab. */
  autoResolveDetails: true,    // run automatically after a Standard/Advanced collection
  detailConcurrency: 5,        // concurrent fetches from the Maps tab; 1-8
  detailTimeoutMs: 15000,
  detailRetries: 1,
  detailBatchSize: 10,         // persist every N records
  detailPaceMs: 120,
  enrich: {
    website: true,
    email: true,
    social: true,
    concurrency: 3,
    timeoutMs: 15000,
    maxPagesPerSite: 4,
  },
  scoring: {
    fullAddress: 10, phone: 10, website: 10, email: 25,
    facebook: 5, instagram: 5, linkedin: 5, tiktok: 5, youtube: 5,
    validWebsite: 10, goodRating: 5, highReviews: 5,
  },
  theme: 'auto',
};
