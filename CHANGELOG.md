# Changelog

## 4.5.0 — layered Full Address, enrichment lifecycle (pause/resume/stop, missing-only, caching)

Scope: `src/collector/address.js`, `src/collector/detail-parser.js`,
`src/collector/place-detail.js`, `src/core/constants.js`,
`src/enrich/enrich-manager.js`, `src/jobs/job-manager.js`,
`src/background/router.js`, `src/sidepanel/views/enrich.js`. Scraping
architecture, queue, storage, dedupe, export, Google Sheets and every other
UI view are unchanged.

### Full Address — layered, not one JSON-index guess
`detail-parser.js`'s embedded-JSON-payload parse now exposes `city` /
`state` / `postalCode` / `country` independently of whether it managed to
compose them into one "formatted address" string, plus a last-resort scan
for a standalone locality fragment ("City, ST 12345") anywhere in the
payload when no known index holds one. `place-detail.js:mergeEmbeddedPayload()`
uses this to COMBINE a DOM-found street line with a payload-found locality
whenever *neither alone* was a complete address — previously, if the DOM
found only a street and the payload's own composition attempt failed, Full
Address stayed blank even when the city/state/zip were sitting right there
in the payload. `address.js:splitAddress()` also had a real parsing bug
fixed: a locality-only string with nothing left over after the postal code
("Jacksonville, FL 32210") was misread as street="Jacksonville",
city="FL" — the state abbreviation was being stored as the city. Address
(the short street field) and Full Address remain architecturally distinct
throughout; nothing here changes how or when Address is set.

### Enrichment — a real lifecycle instead of a busy/not-busy guess
- **Pause/Resume**: new `MSG.ENRICH_PAUSE`/`ENRICH_RESUME`, mirroring the
  existing detail-resolution pattern. `enrich-manager.js` gained
  `pauseEnrichment()`/`resumeEnrichment()`/`waitWhilePaused()` — pausing
  stops new records from starting while letting in-flight ones finish;
  resuming continues the SAME run from wherever it was, never restarting.
- **Missing-field-only, for real**: `enrichRecord()` now checks per-field
  whether email/each social platform is already present and skips exactly
  what's not missing — a fully-complete record now costs zero network
  requests (previously every record was always re-fetched and
  re-searched regardless of what it already had, and a failed re-fetch
  could even blank out a value a previous run had already found).
  `router.js:handleEnrich()` builds the pending list up front and merges
  results back into the full saved record set by stable identity, so
  untouched records are never dropped from storage.
- **Explicit final states**: `job.enrich.status` is now one of
  `ENRICH_STATUS` (running/paused/stopped/completed/partial/failed) — the
  authoritative source of truth `enrich.js`'s view reads directly, never
  inferred from progress text or from done/total. Stop now patches job
  state immediately (previously the UI could keep showing "Enriching…"
  until whatever request was in flight happened to finish). Detail
  resolution had the identical latent bug (a Stop never cleared `home.js`'s
  busy indicator either) and got the equivalent fix.
- **Caching**: a per-run cache means several leads sharing one franchise
  website cost one fetch cycle, not one per record — including in-flight
  request de-duplication so concurrent workers processing the same site at
  once don't each start a redundant fetch.
- **Performance**: default concurrency raised from 3 to 4; checkpointing
  (`onBatch`) persists progress incrementally, unchanged in mechanism.
- **Recovery display**: the Enrich tab now shows "Recovering…" using the
  same heartbeat (`job.lastActivityAt` / `STALL_THRESHOLD_MS`) collection
  already uses, instead of ever appearing frozen with no explanation.
- The full 251-record completion summary the UI shows now breaks results
  down per platform (Email, Facebook, Instagram, LinkedIn, TikTok,
  YouTube) plus Not Found / Skipped / Technical Errors, with a View Data
  button — not just a done count.

## 4.4.0 — complete-address parsing, enrichment status stops lying

Two targeted fixes. Scope: `src/collector/address.js`, `src/collector/validators.js`,
`src/collector/card-parser.js`, `src/jobs/job-manager.js`, `src/background/router.js`,
`src/sidepanel/views/enrich.js`. Nothing else changed.

### Fixed — Full Address parsed incorrectly or left blank
`address.js:splitAddress()` and `validators.js:isPlausibleFullAddress()` both
split a raw address string on commas only. Google frequently renders the
address as two stacked DOM rows (street on one line, city/state/zip on the
next) rather than one comma-joined string — reading that back via
`innerText` produces a line break where a comma would be. That broke the
comma-based split: a genuinely complete address either failed the
"complete" check entirely (kept as a bare street line, Full Address left
blank) or — worse — parsed with the city misread as the region. Both
functions now treat a line break exactly like a comma before splitting;
`address.js:tidyAddress()` does the same conversion *before* its general
whitespace collapse, since that collapse previously turned the line break
into a plain space and glued the two rows together with no separator left
to recover.

Separately, `card-parser.js:parseCategoryAndAddressLine()` only ever found
the short **Address** field (the street line collected during the main
fast pass) on a card whose category and street were rendered on one
"category · street" line. Some card layouts show them as two independent
rows with no middot at all — the previous code had no fallback for this
and left both Category and (short) Address blank. It also had unused,
purely defensive fallback code for Category alone: that fallback compared
its match against `lines[0]` (the business name) *after* `find()` had
already returned it, so it always matched the name first, rejected it, and
gave up — it could never reach the real category line beneath it. Both
gaps are fixed: the category fallback now excludes the name line from
consideration up front, and a new fallback independently looks for a line
that reads like a street address (has a digit or a street-suffix word)
when no middot-combined line produced one.

### Fixed — Enrich tab stuck showing "Enriching..." after enrichment finished
The panel decided whether enrichment was still running by regex-matching
`/Enrich/i` against the job's human-readable progress note. The
*completion* message router.js sets is literally `"Enrichment complete"` —
which also matches `/Enrich/i`. The panel could never tell "still running"
apart from "just finished": the progress bar and STOP button stayed up
forever once a run finished, with no indication anything had completed.
- `job-manager.js` gained a structured `job.enrich = { done, total, ranAt }`
  (mirroring the existing `job.detail` used for detail-resolution's busy
  state), merged the same way in `updateJob()`.
- `router.js:handleEnrich()` now writes real progress into it, and —
  importantly — collapses `total` to whatever was actually processed on
  completion, whether the run finished naturally or was stopped early via
  the STOP button. Without that collapse, a manual Stop before the full
  queue finished would leave `done < total` permanently, reproducing the
  same stuck state. `detail-resolution`'s completion patch had the
  identical latent bug (a manual Stop there never cleared `home.js`'s
  "Resolving full address X / Y" busy indicator either) and got the same
  fix.
- `enrich.js`'s view now reads `job.enrich.done < job.enrich.total`
  directly instead of matching text, and shows an explicit "✓ Enrichment
  complete — N record(s) processed" line once it's actually done.

## 4.3.0 — reliable phone extraction, simplified field selection, filter-before-export

A targeted correction on top of the card-first collection engine (unchanged
by this release) and the 4.2.0 UI redesign (also unchanged, aside from the
Home screen's field picker). Scope: `src/collector/card-parser.js`,
`src/collector/selectors.js`, `src/core/constants.js`, `src/engines/filters.js`,
`src/sidepanel/views/home.js`, `src/sidepanel/views/export.js` and
`src/sidepanel/styles.css`. Nothing in the queue, recovery, storage,
deduplication, enrichment engine, export format code or Google Sheets
integration changed.

### Fixed — phone numbers missed even when Google Maps visibly showed them
`card-parser.js:extractCardPhone()` only ever looked for a dedicated phone
*control* on the results card (`data-item-id^="phone:tel:"` / `tel:` href /
a `data-tooltip="Copy phone number"` button). Google frequently prints the
number as **plain visible text** on the card instead — often sharing a line
with the hours/status row — with no button, no `data-item-id`, no `tel:`
href at all. The old, previously-working extension had exactly this case
covered with a regex fallback over the card's text; the card-first rewrite
in 4.1.0 carried over the selector-based path but dropped that fallback.
- `extractCardPhone()` now falls back to two anchored text patterns — an
  international one requiring a literal `+` prefix (so it can never match a
  street number, ZIP or price) and the North-American 3-3-4 grouping — only
  when no selector-based element resolved a value. The selector-based path
  is unchanged and still wins when it succeeds.
- `selectors.js:CARD_PHONE` gained two more selector variants
  (`data-tooltip="Copy phone number"`, `aria-label^="Phone:"`) mirroring
  what `place-detail.js` already tries at the detail-panel level.
- `parseCategoryAndAddressLine()` now defensively strips a trailing
  phone-shaped run of text from the address line, and drops Category or
  Address outright if either turns out to be nothing but a phone number —
  belt-and-suspenders against the number leaking into the wrong field.
- Verified end-to-end in `tools/run-tests.mjs`'s 51-business synthetic test:
  16 of 51 businesses now render their phone as plain text only (no
  button), and all 16 are extracted correctly, matching Google Maps
  character-for-character (e.g. `+1 770-368-0005` stays exactly that).
- Detail resolution (`place-detail.js`/`detail-resolver.js`) was already
  correct and is unchanged — it already fetches every record still missing
  Full Address, Website or Phone regardless of whether the business has a
  website, via the existing same-origin fetch through the Maps tab. No tab
  is opened for this before or after this release.

### Changed — no more Fast / Standard / Advanced picker
The Home screen no longer asks the user to choose an extraction mode.
- `home.js` dropped `renderModeCard`/`MODE_INFO` and the `[data-mode]`
  handler entirely. The underlying `MODE`/`MODE_NEEDS_DETAIL` mechanism in
  `core/constants.js` is untouched and stays fixed at Standard internally
  (detail resolution always runs), so no scraping behavior changed — only
  the picker is gone.
- The field picker is now two fixed sections: **Default fields** (Business
  Name, Website, Phone Number, Address, Rating, Reviews — shown checked and
  locked, always collected, no way to turn them off) and **Additional
  fields** (Full Address, Email, Facebook, Instagram, LinkedIn, TikTok,
  YouTube, X/Twitter, Maps URL, Latitude, Longitude — opt-in checkboxes,
  unchanged mechanism). `FIELDS[].default` flags in `core/constants.js`
  were updated to match; a new `DEFAULT_FIELD_KEYS` export is the single
  source of truth both the render and the save handler use, and the save
  handler always unions those six keys back in so a legacy settings object
  can never lose them.

### Changed — filters get more complete, export can bypass them
- `engines/filters.js:AVAILABILITY` gained `Has Address` / `No Address`
  (the short street line collected by default now warrants its own filter,
  distinct from the existing Full-Address-specific pair) and `Has TikTok` /
  `Has YouTube`, alongside the existing Website/Phone/Email/Facebook/
  Instagram/LinkedIn/coordinates toggles. `filter.js`'s chip UI already
  renders `AVAILABILITY` generically, so these appeared with no view change.
- The Export screen now shows **Total records** and **Filtered records** as
  two distinct stats, and — whenever a filter is active — offers both
  "Export N Filtered" and "Export All N" for CSV and Excel, so filtering
  never forces exporting everything or nothing.

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
