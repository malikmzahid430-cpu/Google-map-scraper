# Changelog

## 4.2.0 — presentation-layer redesign

A UI/UX-only pass over the side panel. Nothing under `src/collector/`,
`src/background/`, `src/enrich/`, `src/export/`, `src/jobs/`, `src/engines/`
or `src/core/quality.js` changed — every file touched lives in
`src/sidepanel/`, and `tools/verify-isolation.mjs` /
`tools/verify-build.mjs` both still pass, same as before this release.

### Changed — visual design
- New color/spacing/shadow token set in `styles.css` (an added teal
  `--accent-2`, refined text/hairline/shadow tokens for both light and dark)
  and several new small components: a header connection pill, live
  field-coverage tiles, social-platform badges, job status badges, a
  prominent `.cta` button style, and a styled collapsible
  (`<details class="adv">`) for advanced settings.
- Header now shows the extension's own icon, the product name, a
  `● Connected` / `Google Maps` pill reflecting live Maps-tab detection, and
  a dedicated Settings button — Settings moved out of the tab strip into
  that button, leaving the main nav at Home / Jobs / Data / Filter / Enrich
  / Export.
- Home: rewritten hero copy, an explicit "optional — found during Enrich"
  section for email/social field checkboxes, a live per-field coverage grid
  while a job is running, and a completed-state action row (View Data /
  Enrich Missing Data / Filter Results / Export).
- Data table: Website and Email are now clickable links; Social renders as
  clickable per-platform badges instead of a single "yes" flag; the
  status-glyph legend uses ✓ / — / · / ⏳ / ⚠ consistently with the rest of
  the panel.
- Filter: match count promoted to a large stat with an always-visible Reset
  button (previously only shown once a filter was active).
- Enrich: added a coverage stat row (Email/Social/Website counts) above the
  enrichment controls; removed a `Pause` control that had no backing
  message handler and would have paused the unrelated detail-resolution
  stage instead.
- Jobs: status text replaced with badges using the vocabulary Completed /
  Collecting / Paused / Recovering / Partial / Failed, driven by existing
  `job.status`/`job.stuck` fields — no new job states were introduced.
- Settings: reorganized into named sections (General, Collection,
  Enrichment, Storage, Google Sheets, Diagnostics); scroll/patience,
  detail-resolution and lead-score-weight tuning — the settings a normal
  user never needs — moved into a collapsible "Advanced Settings" section.

### Verified unchanged — panel persistence
- The side panel was already window-scoped, not tab-scoped: nothing in
  `background/service-worker.js` calls `chrome.sidePanel.setOptions` with a
  `tabId`, so Chrome already keeps one panel instance per window across tab
  switches. Job state already lives in `chrome.storage` and is read by
  `jobsApi.getActiveJob()` independent of which tab is active, so switching
  tabs, closing the panel, or reopening it does not stop or lose a running
  collection. No background/service-worker code changed to achieve this —
  it was already true of the existing architecture.

## 4.1.0 — card-first collection, no per-business tabs

A second audit — this time comparing the codebase against a working prior
version of this same product — found that v4.0.0's UI fix sat on top of a
collection *engine* that still opened a real background tab and navigated it
for every business in Standard/Advanced mode, automatically, right after
every collection. Card-level collection and end-of-list detection were
already sound (kept as-is); this release only replaces how the remaining,
optional detail-resolution step gets its data.

### Fixed — heavy, tab-based detail resolution
- **Website and Phone are now read straight off the results card** when
  Google renders them there (`card-parser.js` gains `extractCardWebsite`/
  `extractCardPhone`, backed by new `CARD_WEBSITE`/`CARD_PHONE` selectors) —
  the same zero-network-cost pass that already reads Business Name,
  Category, Rating, Reviews and the street Address. Most records now have
  these two fields the instant they're collected.
- **Detail resolution no longer opens a tab.** `background/detail-resolver.js`
  drops the `TabPool`/`navigate()`/`chrome.tabs.create` mechanism entirely.
  What's left after card-first collection — almost always Full Address,
  since Maps' card never shows a complete postal address — is resolved by
  asking the Maps tab's *own* content script to `fetch()` the place page, a
  same-origin request that carries the user's session automatically. See
  `docs/ARCHITECTURE.md` §0.2 for why this fetch is reliable where an
  earlier, background-worker-issued one (row 2 of the v2.0.1 audit table)
  was not — different context, different result.
- `collector/place-detail.js`'s DOM extractors (`extractAddress`,
  `extractWebsite`, `extractPhone`, `extractHeader`) now take a `root`
  document parameter instead of assuming the live page, so the same
  extraction logic reads either a live panel or a `DOMParser`-parsed fetch
  response. `readPlacePage()`/`waitForPlacePanel()` (the live-tab-only path)
  are gone, superseded by `extractFromDocument()` + `fetchPlaceDetail()`.
- Bounded concurrency for these fetches uses `core/safe.js:mapLimit` (default
  5 concurrent) — the same primitive `enrich-manager.js` already used for
  website fetches — instead of a 2–4-tab pool.
- `router.js:startDetailResolution()` now skips the whole stage when nothing
  is missing (common now that Website/Phone are often already there from
  Phase 1), and otherwise looks up the Maps tab once and passes its id
  through — no tab is created for this at any point.
- If no Google Maps tab is open when detail resolution runs, the affected
  records are marked `Failed` with a technical error explaining why, rather
  than silently guessed or left stuck `Pending`.

### Tests
- Rewrote the detail-resolver test group for the new mechanism (no
  `chrome.tabs.create` mocking) and added an explicit assertion that zero
  tabs are ever created across a run, plus a dedicated 51-business
  end-to-end test (card-first collection → missing-field-only detail
  resolution) that reports collection time, per-field coverage, Phase 2
  fetch count and tab count. 197 tests total (was 148).

## 4.0.0 — one screen, not two mechanisms

Audit of v3.0.1 against its own code (not just its docs) confirmed the
collector, storage, detail resolution, error model, heartbeat, jobs and queue
are sound — full details in `docs/ARCHITECTURE.md` §0. What was actually
broken was the UI:

### Fixed — "Search Query" vs. "Start Scraping" confusion
- The Scrape tab's What/Where boxes only labelled records; the separate
  "Search queue" textarea was the only thing that actually navigated Google
  Maps. Replaced both with one Home screen: What/Where (+ Add another
  search) and a single **START COLLECTING LEADS** button.
- New `MAPS_DETECT` message: the Home screen shows **"✓ Google Maps search
  detected"** with the query already on screen and lets you use it directly,
  with one click to use your typed search instead.
- Typed search(es) — one or many — now start through the same, already-tested
  queue engine (`QUEUE_RUN` → `onMapsTabReady`) that used to be reachable only
  via the separate queue textarea, so Google Maps opens and starts
  automatically instead of requiring you to do it by hand first.
- A failed queue item now has an inline **Retry** action instead of requiring
  a full re-type.

### Changed — navigation and labels
- Nav: Home / Jobs / Data / Filter / Enrich / Export / Settings. Diagnostics
  moved from a top-level tab to **Settings → Diagnostics** (same view, one
  click deeper, with a back link).
- Buttons renamed to plain language: **START COLLECTING LEADS**, **PAUSE
  COLLECTION**, **STOP COLLECTION**, **ENRICH DATA**.
- A job that errored after collecting records now reads **"Partial — N
  saved"** instead of a bare "Error", on Home and in the Jobs list.

### Fixed — small correctness issues found during the audit
- `core/constants.js` `APP_VERSION` said `2.0.0` while `manifest.json` said
  `3.0.1`. Both are `4.0.0` now.
- The keep-alive alarm asked for `periodInMinutes: 0.5`; Chrome's documented
  floor for a packed extension is 1, so the request bought nothing and
  misstated the real cadence. Now requests 1.
- The optional host permission enrichment needs is now requested from the
  side panel's own click handler first — a page context is a guaranteed
  user-gesture chain, which a message handler one step removed from the
  click is not. The background's own check (`ensureEnrichmentPermission`)
  still runs as a fallback.

## 3.0.1 — review pass

Found by an adversarial re-review of 3.0.0, all with regression tests.

- **Detail tabs could be mistaken for your Maps tab.** The resolver opens
  background tabs on real `google.com/maps/place/...` URLs, so `findMapsTab()`
  could return one and send COLLECT_START to a single place page with no results
  feed. The resolver now publishes the tab ids it owns; `findMapsTab()` and the
  queue's tab-ready hook both exclude them, and `findMapsTab()` prefers an
  actual `/maps/search/` tab.
- **A tab-create failure escaped its worker.** `chrome.tabs.create` rejecting
  (tab limits, policy) propagated out of the worker, rejected the `Promise.all`,
  and let `finally` close tabs while other workers were still using them.
  `acquire()` now returns null instead of throwing and every worker body is
  individually contained.
- **Unvisited records were reported as "Not Found".** If a run was stopped, or
  no tab could be opened, records that were never actually checked were still
  finalised as Not Found. Only records the run genuinely reached are finalised
  now; unreachable ones are marked `Failed` and the cause is logged as a
  technical error.
- **`maxRecords` overshot.** The cap was checked between scan passes, so
  "stop after 25" returned 30. It is now enforced per record: 1, 7, 25 and 100
  all return exactly that many.
- **`feedWaitMs`** is configurable instead of a hard-coded 15 s.
- Detail resolution gained **Pause / Resume** alongside Stop.
- Removed `src/collector/detail-dom.js` — dead code superseded by
  `place-detail.js`, and a second implementation of the same feature.
- `tools/verify-build.mjs` now fails on **orphan modules**, so dead code and
  duplicate implementations are caught automatically.
- Filter view: long category labels no longer overflow their card, and their
  counts stay readable.

## 3.0.0 — reliability rebuild

Audit of v2.0.1 with line references is in `docs/ARCHITECTURE.md`.

### Fixed — collection missed results
- **Removed the positional cursor.** `collector.js` used `for (; state.cardIndex < cards.length; …)` with a cursor that persisted across scroll passes while the card list was re-queried from a virtualized DOM. When Maps recycled nodes and the array shrank below the cursor, the loop stopped executing entirely. The collector now re-scans the whole current DOM every pass and decides what is new purely by stable place identity (feature id → CID → viewport-stripped URL).
- **One bounded scroll step per scan.** The old `scrollFeed` wrote `scrollTop` twice and jumped to `scrollHeight`, letting the virtualized window slide further than it was tall so cards mounted and unmounted between scans. Cost 25 of 120 results in testing.
- **Patient end detection.** Compares card count, scroll height, scroll position and the loading indicator; retries 8 times with growing back-off; and performs a confirmation scan before accepting the end, because the scroll that triggers the end signal often renders one last batch.
- Measured on a virtualized harness: 60/60, 120/120, 51/51 with stalls, 200/200 with frequent stalls. The old algorithm scored 20/60 on the same feed.

### Fixed — 51 results, 2 websites
- **Detail resolution now reads the rendered Maps panel**, not an HTTP fetch of the place URL. A small pool of reusable background tabs navigates to each place; the content script reads `data-item-id` → `aria-label` → semantic row → `href` → validated payload. Your Maps tab is never touched.
- **The 40-record cap is gone.** Every record is processed, in batches, with concurrency, timeout and retry controls.

### Fixed — Full Address
- `Address` and `Full Address` are now distinct fields with distinct rules. A complete address requires a street plus at least two of city / region / postcode / country. A bare street line leaves Full Address blank with status `Not Found` instead of being passed off as complete.
- Components (city, state, postal code, country) are split out and exported separately. Country is appended only when actually present.

### Fixed — "51 Errors" for 51 good leads
- **New error model.** `core/quality.js` counts coverage; `recordTechnicalError()` counts failures. They share no counter and no code path. A missing website or phone can no longer increment anything called an error.
- The dashboard and Diagnostics both split **Data quality** from **System health**.
- Every blank field carries a reason — Found / Not Found / Not Requested / Pending / Failed — shown as a status chip in the Data table. Only `Failed` is an error.

### Fixed — stuck runs
- Heartbeat on every meaningful event. A running job idle past 30 s reports **Possibly Stuck** with the idle time and a Retry button, instead of an indefinite "Running".

### Fixed — multi-search data loss
- **New Jobs tab.** v2 wrote queue jobs to storage and never listed them — `listJobs()` existed but no view called it. Every dataset is now listed, openable, renameable and deletable.
- **Combine jobs** into a new dataset with optional deduplication; the originals are untouched.
- Scope switching (Current job / Project / All jobs / Selected) drives Data, Filter and Export.
- Queue states are now `pending → loading → scraping → done | failed | paused`, and the next search cannot begin until the previous job *and its detail resolution* are finished.

### Rebuilt — filters
- Rating range, review-count range, **dynamic categories built from the actual dataset**, availability toggles, lead-score minimum, validation status, and city / state / postcode / country. All combine with AND.

### Added
- Field mapping panel: description, source, stage, example and live availability for all 28 fields.
- Provenance on every record: search query, search location, job id, project.
- Grouped diagnostics: Collection / Detail resolution / Data quality / Technical.
- 8-tab UI with per-tab counts.
- 121 tests covering all 23 v3 scenarios, including a virtualized-feed harness that reproduces the v2 failure.

## 2.0.0 — complete rewrite

The v1.4.0 ZIP contained no editable source: four minified webpack bundles of a
third-party product (`local_lead_robot`) with the branding swapped, plus a
license gate that hid the Start button unless a remote server validated an
email and license key. It could not be extended safely, which is why every
feature addition broke Start. v2.0.0 is original, readable code.
Full audit in `docs/ARCHITECTURE.md`.

### Architecture
- Collection, enrichment, deduplication, validation, scoring and export are
  separate systems. The collector imports only `core/` and `collector/`.
- `tools/verify-isolation.mjs` walks the real import graph and fails the build
  if the collector can reach an optional module.
- Every optional operation runs through `safeCall` (try/catch + timeout +
  retry + named diagnostic). Nothing optional can throw into the collect loop.
- MV3 service worker is stateless; `chrome.storage.local` is the source of
  truth, so a job survives worker eviction, panel close and extension reload.
- Records are sharded in storage, so a flush during a long run rewrites one
  small chunk rather than the whole result set.

### Removed
- License gate and its remote auth server. Start works immediately.
- Unused permissions: `cookies`, `webRequest`, `contextMenus`,
  `downloads.open`, `activeTab`.
- Unconditional `http://*/*` host permission — now optional, requested only
  when Enrich first runs.
- All third-party runtime dependencies (React, Redux, Papa Parse, moment, uid,
  webextension-polyfill). No bundler, no build step.

### Fixed
- **Website returned `http://schema.org/Place`.** Fixed-index payload reads
  replaced with candidate paths + validators + a bounded structural scan.
  Any `schema.org`, Google-owned or Maps-internal URL is rejected outright.
- **Full Address was only a street line.** Now composed from the payload's
  address components, with the country appended only when actually present.
  Blank when Google exposes nothing complete — never a partial address
  presented as full.
- **Rating decimals lost.** `4.6 (37)` now yields rating `4.6` and reviews `37`
  from separate capture groups. Comma-decimal locales handled. Anything
  outside 0–5 rejected as a mis-parse. `4.8 stars` no longer yields 8 reviews.
- **Phone could land in Address.** Validators reject a phone as an address and
  an address as a phone.
- **Unstable place identity.** Maps URLs are stripped of the `@lat,lng,zoom`
  viewport and `data=` blob, so the same place is one record across scrolls.
- Unhandled rejections in the scrape loop; the loop now sits inside a guard
  that transitions the job to `ERROR` with a message.

### Added
- Side panel UI (Scrape · Enrich · Filter · Data · Export · Settings ·
  Diagnostics), glassmorphism, light and dark.
- Pause / Resume that continues from the cursor instead of restarting.
- Fast / Standard / Advanced extraction modes.
- Deduplication as a separate stage: Maps URL → Place ID → name+address →
  name+phone, merging fields from duplicates rather than discarding them.
- Normalization engine that preserves originals under `record.raw`.
- Validation engine and lead scoring normalised to 0–100.
- Email and social enrichment reading only the business's own public site.
- Missing-data filters; search queue; projects.
- Zero-dependency XLSX writer (verified against openpyxl) and CSV writer with
  formula-injection protection that does not mangle `+1` phone numbers.
- Google Sheets export with `chrome.identity`, append-new-only, and an honest
  "not configured" state until you supply your own client ID.
- Diagnostics naming the exact failing module, plus a live parse of the first
  card on screen.
- 118-test suite and two build verifiers, all dependency-free.

## 2.0.1 — packaging fixes

- `manifest.json` is now at the ZIP root, so the folder you unzip to is the
  folder you select in Chrome's **Load unpacked**.
- **Fixed: extension refused to load** with
  `Invalid value for 'content_scripts[0].matches[2]': Invalid host wildcard`.
  The pattern `https://www.google.*/maps/*` used a TLD wildcard, which Chrome
  does not support. Replaced with 66 explicitly listed Google regional domains,
  mirrored into `web_accessible_resources` so the content script can import its
  modules on every one of them.
- `tools/verify-build.mjs` now validates every match pattern in the manifest
  (scheme, host wildcard placement, required path) and cross-checks that each
  content-script host is covered by `web_accessible_resources`. This is the
  check that would have caught the bug above before shipping.
- `host_permissions` trimmed to the Google APIs endpoints only; Maps access now
  comes from the content-script matches themselves.
