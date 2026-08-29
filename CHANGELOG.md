# Changelog

## 4.6.0 — Full Address: anchor-based recovery, ported from a prior working version

Scope: `src/collector/detail-parser.js`, `src/collector/place-detail.js`,
`src/collector/index.js`, `src/background/detail-resolver.js`,
`tools/run-tests.mjs`.

### Why 4.5.0-4.5.4 still weren't enough
Every fix through 4.5.4 made the STRUCTURED extraction paths (Google's
internal JSON array layout, JSON-LD) more robust, and they were real,
verified fixes. But all of them shared one blind spot: they only ever find
an address that Google exposes in a recognisable STRUCTURE — a specific
array index, a `PostalAddress` object, a DOM element. When a specific
account's response puts the address somewhere none of those structures
recognise, none of them can find it, no matter how many structural fallbacks
are stacked on top of each other.

Digging through this project's own history surfaced the actual answer: a
prior working version of this extension solved exactly this problem, and
not by parsing structure at all — by anchoring on the street address already
trusted (from the card) and searching the RAW response text for how it
continues. That mechanism is what's ported and adapted here.

### Added — extractFullAddressByAnchor() and extractFullAddressGeneric()
`src/collector/detail-parser.js`:
- `extractFullAddressByAnchor(rawText, knownStreet)` — normalises unicode
  escapes/entities Google's raw response wraps text in, finds the known
  street as plain text in the response, and reads forward to wherever that
  address text ends (the next JSON string/array/object boundary). Rejects a
  "known street" that isn't itself street-shaped (a bare city name can never
  be used as an anchor). Validated with the same `V.isPlausibleFullAddress`
  used throughout this codebase — international-agnostic, no US-only ZIP
  assumption.
- `extractFullAddressGeneric(rawText)` — absolute last resort when there is
  no known street to anchor on at all: scans the raw text directly for
  anything address-shaped, bounded to 500 candidates so a huge response
  cannot spin the collector, each candidate bounded by JSON-string-safe
  characters so a match can never bleed across a string boundary.

Both are tried only after every structural attempt (array-index resolution,
JSON-LD, locality-fragment scan) has already failed, and both only ever
EXTEND a street already trusted — neither can replace a good value with
something worse, and neither invents a country/state/postal code that
wasn't actually found in the response.

### Changed — the card's Address now anchors detail resolution
`record.address` (the street already confirmed correct at Phase-1 card
collection) is threaded through end to end: `detail-resolver.js` includes it
in the `DETAIL_EXTRACT` message it already sends the content script ->
`index.js` passes it to `fetchPlaceDetail()` -> `place-detail.js` passes it
to `parsePlaceDetail()` as `opts.knownStreet`, alongside the array-payload's
own internally-resolved street (tried first, since it's guaranteed to be
Google's own text for that exact record). This is the single most useful
anchor available, since it's what a human already sees in the results list.

`mergeEmbeddedPayload()` no longer duplicates this fallback chain — it seeds
`parsePlaceDetail()` with the best street it has (the DOM's own, falling
back to the caller's known street) and lets that one authoritative
implementation do the recovery, rather than running two separate copies of
similar logic that could drift out of sync.

### Tested — 20 businesses, real browser, real production code
This sandbox's network policy blocks outbound access to `google.com`
entirely (confirmed directly against the egress proxy: a 403 on the CONNECT
itself), so a live fetch against Google Maps is not possible from here. What
was tested instead: 20 realistic synthetic place-page responses — modeling
the actual response shapes this code has to handle (a genuine
`addressComponents` array, a bare street with a separate locality fragment
[the exact reported bug], JSON-LD only, raw-text-only with and without a
known street, UK/Canada/Australia address formats, suite/unit numbers, no
website, no phone, and a case with genuinely no address anywhere) — run
through the unmodified production code (`place-detail.js`/
`detail-parser.js`) in an actual Chromium browser's real `fetch()`/
`DOMParser`, via network interception standing in for Google's response.

Result: **20/20 complete and correct**, 0 incomplete, 0 missing, 0 incorrect,
0 technical errors — including the case with no address anywhere correctly
resolving to blank/Not Found rather than inventing one, and the international
addresses resolving with no US-ZIP assumption anywhere in the fix.

Also verified: the packaged extension loads unpacked into a real Chromium
with a clean manifest, a service worker that starts without error, and a
side panel that renders with zero console errors. `chrome.tabs.create` is
grepped across the whole codebase and appears in exactly two places, neither
of them detail resolution: opening the exported Google Sheet after export,
and starting the next queued SEARCH job (a whole new query) when no Maps tab
is already open — never once per business record. **Individual business
tabs opened: 0.**

320/320 tests pass (12 new, covering the anchor/generic functions directly,
the international/suite/not-found cases, and the end-to-end
`fetchPlaceDetail()` path). Isolation and build verification clean.

## 4.5.4 — verified 4.5.3 live in a real browser; found and fixed one more gap

Scope: `src/collector/place-detail.js`, `tools/run-tests.mjs`.

### Tested — not just unit tests this time
Before handing 4.5.3 back for real-world loading, it was run for real: the
packaged extension was loaded unpacked into an actual Chromium (via
Playwright), confirmed the manifest is valid, the service worker starts
clean, and the side panel renders with zero console errors. Separately, the
real `fetchPlaceDetail()`/`mergeEmbeddedPayload()` code (not the Node test
harness — the browser's own `fetch()` and `DOMParser`) was exercised against
four realistic response shapes via network interception, standing in for
Google's actual response since this sandbox's network policy blocks
`google.com` outright: a bare-street-plus-separate-locality payload (the
exact shape 4.5.3 targeted), an array-payload-absent/JSON-LD-only page, a
page with nothing usable at all, and a plain intact `addressComponents`
array. All four now correctly produce a complete Full Address.

### Fixed — the short Address field wasn't backfilled from a payload-only Full Address
That live run surfaced one more real gap: when the payload's own Full
Address resolved as already complete on its own (`mergeEmbeddedPayload()`'s
first branch — the straightforward case, unrelated to the three bugs fixed
in 4.5.3), the short **Address** field was never backfilled from it, even
though Full Address was. In production this is usually masked because
Phase-1 card scraping already fills Address for most records, but a record
relying on the payload alone for its street would show a populated Full
Address next to a blank Address. Fixed: `out.address` is now backfilled
from the payload's street (or Full Address's own split-out street) in that
branch too, matching what the combine branch already did.

302/302 tests pass (2 new, covering exactly this), isolation and build
verification clean, and the extension reloads cleanly with no console
errors.

## 4.5.3 — fix Full Address staying blank across an entire job

Scope: `src/collector/detail-parser.js`, `src/collector/place-detail.js`,
`tools/run-tests.mjs`.

### Fixed — three separate bugs that each independently made this worse
Confirmed with a live example: "California Building Professionals" shows a
complete address on Google's own detail panel (street, city, state, zip,
country, all in plain text), the extension's short Address field now
correctly shows the street (the 4.5.1 fix), but Full Address stayed blank —
for every record in the job, every time, even after "Resolve" reported
complete. Re-reading `detail-parser.js` and `place-detail.js` end to end
turned up three compounding structural bugs, not one:

1. **`parsePlaceDetail()` bailed out completely, before any fallback ran.**
   If `extractPlaceJson()` couldn't find/parse Google's
   `APP_INITIALIZATION_STATE` array blob in the raw (non-JS-executed) fetch
   response, the function returned an entirely empty object immediately —
   before the locality-fragment scan, before anything. Every fallback built
   in 4.5.0/4.5.1 only ever ran *after* this point, so none of them mattered
   when the array payload itself wasn't found. Fixed by gating only the
   array-index-dependent extraction (website/phone/geo/category/rating/
   placeId) behind `if (json)`, while address resolution now also tries a
   brand new independent source: JSON-LD (`extractJsonLdAddress()`, schema.org
   `PostalAddress` in a `<script type="application/ld+json">` block), which
   doesn't depend on locating that array blob at all.

2. **A bare street line was silently smuggled through as a fake "Full
   Address."** `composeFullAddress()` would fall back to using a single,
   comma-less street segment as the entire Full Address when nothing better
   was found. That made `out.fullAddress` *non-blank* — which then
   permanently blocked the structural scan and the locality-fragment scan
   right below it, since both only run `if (!out.fullAddress)`. A record
   whose `formattedAddress` index happened to hold just the street (very
   plausible — that's a wrong-index guess, not a payload absence) got stuck
   on that lone street forever: never blank enough to try anything better,
   never complete enough to actually be a full address. Fixed: a bare
   street is now rejected (returns `''`) unless a country was available to
   pair with it, matching the documented invariant in `address.js`
   ("Full Address stays blank... a partial address is never presented as
   complete") that this function was quietly violating.

3. **The DOM+payload combine step required a DOM-found street that a raw
   `fetch()` essentially never has.** `mergeEmbeddedPayload()`'s fallback —
   combine a found street with payload-only city/state/postal when neither
   source alone was complete — only ever used `out.address`, the DOM-parsed
   street. Google Maps is a JS SPA: a same-origin `fetch()` response that
   never executed any JS frequently has none of the `data-item-id="address"`
   markup `extractAddress()` looks for, so `out.address` was very often
   blank on exactly this path — the one every real detail fetch goes
   through. The combine step then had nothing to combine with, no matter
   what the payload resolved. Fixed to also accept the payload's *own*
   independently-resolved street (`payload.address`) as the seed when the
   DOM gave nothing — and fixed `parsePlaceDetail()`'s own street selection
   (`out.address`) to prefer a genuine components/formatted-value street
   over blindly taking the first comma segment of a locality-only scanned
   string (which is the city, not the street).

Also fixed a gate that made the JSON-LD fix above dead code in production:
`mergeEmbeddedPayload()` only called into `parsePlaceDetail()` at all when
`extractPlaceJson()` had *already* found the array payload — meaning the new
JSON-LD fallback, which exists specifically for when that payload is
missing, was never reached from the real `fetchPlaceDetail()` path. It's
called unconditionally now.

None of this is guessed: 300/301 existing tests still pass unchanged (the
one difference is 16 new tests added for these exact scenarios), isolation
and build verification are clean, and every fix traces to a specific,
readable line that previously produced the exact "runs to completion, Full
Address blank for everyone" symptom reported. If Full Address is still
blank after this on real data, the Diagnostics → **Live detail-fetch probe**
added in 4.5.2 will now show a genuinely different picture — whether the
array payload was found, whether JSON-LD was present, and the source each
field actually resolved from — which is the next thing to check.

## 4.5.2 — live detail-fetch diagnostic probe

Scope: `src/collector/place-detail.js`, `src/collector/index.js`,
`src/sidepanel/views/diagnostics.js`, `src/sidepanel/styles.css`.

### Added — a way to actually see why Full Address stays empty
A report came back that Full Address is blank for every record in a job,
even though detail resolution ran to completion. That combination — runs,
finishes, finds nothing for anyone — points at the fetch or extraction
itself silently failing every time, but there was no way to see what the
fetch actually returned to tell "Google's response doesn't look like a
normal place page" apart from "the fetch never reached real content in the
first place." A resolved record's own status can't distinguish these
either: `gotSomething` in `detail-resolver.js` counts as resolved if
website OR phone was (re-)found, even when Full Address specifically
wasn't, so a job that shows "N/N resolved" doesn't prove Full Address
extraction is working.

`place-detail.js:diagnosePlaceDetail()` runs the exact same fetch that
detail resolution uses for one place, but reports the HTTP status, whether
the request got redirected somewhere else (e.g. a consent/login
interstitial — invisible to the normal path), the raw response length,
whether an embedded JSON payload was found at all, and a sanitized excerpt
of the first 600 characters of whatever actually came back. Diagnostics →
**Live detail-fetch probe** now runs this against the first card on screen
and shows all of it, plus each field's resolved value and exactly which
source it came from (`dom:…` / `payload:…` / `none`).

Purely additive — a new diagnostic-only function alongside the unchanged
production `fetchPlaceDetail()`, never called from the resolve path. 285/285
tests pass, including the new probe's own coverage (HTTP status, redirect
detection, and a simulated consent-page response correctly showing no
payload and a blank Full Address instead of inventing one).

## 4.5.1 — fix Address corrupted by icon-only amenity badges

Found from a real export: the Address column showed an unreadable `` box
for many rows instead of a street or a blank. Scope:
`src/collector/card-parser.js`, `src/collector/validators.js`.

### Fixed
Google Maps result cards sometimes insert a THIRD middot-separated segment
between category and street — an amenity or accessibility badge ("Wheelchair
accessible entrance", "Dine-in") that is frequently **icon-only**, with no
visible text label, just one glyph from a private-use-area ligature font.
`card-parser.js:parseCategoryAndAddressLine()` took the first non-hours
segment after category unconditionally, so on cards with this badge it
grabbed the icon glyph instead of the real street address — the unreadable
box seen in the export. Two fixes:
- `validators.js:isPlausibleAddressLine()` now rejects any string containing
  a private-use-area / icon-font codepoint outright, even if it also
  contains a digit (a badge like "2 accessible spots" would otherwise still
  have passed).
- The primary category/address extraction now requires the segment it picks
  to actually pass `isPlausibleAddressLine()`, searching past a badge
  segment to find the real street wherever it is — and leaving Address
  blank rather than guessing when no segment on the card looks like one.
  The same guard was applied to the category-detection fallback.

Verified with a direct regression test reproducing the exact case (category
· icon-only badge · street) plus the badge-with-a-digit and no-real-street
variants; the address-line-on-separate-rows fallback added in 4.3.0 and the
combined (middot) layout are both unaffected. 276/276 tests pass.

### Still open — Full Address empty across an entire dataset
A separate report: Full Address was blank for every record in an exported
job, not just some. This fix does not address that on its own. The most
likely causes are either detail resolution never running for that
particular job (its `mode` may predate the 4.3.0 UI change, if the job was
collected before that update) or every resolution attempt failing as a
technical error (closed Maps tab, lost content-script connection). Next
step: open the **Enrich** tab for that job — if it offers "Resolve details
for N record(s)", click it (this button bypasses any mode gating and always
attempts resolution); if it already says "All records already resolved",
check the **Diagnostics** tab's technical-error and Full-Address-parser
sections for what's actually failing.

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
