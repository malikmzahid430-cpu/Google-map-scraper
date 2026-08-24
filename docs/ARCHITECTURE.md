# Al-Aqsa Scraper v4 — Architecture

Manifest V3 · no build step · zero runtime dependencies

---

## 0. v4 — two audits, two targeted changes

Sections 1 onward are the v3 reliability rebuild: the collector rewrite,
detail resolution's original design, the error model, the heartbeat,
jobs/queue/projects. **0.1** replaced the UI on top of that engine. **0.2**
replaced one specific mechanism inside it — how detail resolution actually
fetches data — after a second audit found it was reintroducing the exact
"heavy, tab-based" problem class this codebase's own earlier versions had
already been rewritten once to fix. Both changes were audited against the
real code first, and the whole test suite (197 tests as of 0.2) plus
`verify-isolation.mjs` and `verify-build.mjs` passed before and after each.

### 0.1 — one screen, not two mechanisms

What v3 got wrong was the **UI**, not the engine. `views/scrape.js` rendered
two mechanisms that looked like one: a "Search" card whose What/Where boxes
only *labelled* records, and a separate "Search queue" textarea that was the
only thing that actually built a Maps URL and navigated a tab. A user had no
way to know which box did what — this is the "Search Query vs. Start
Scraping" confusion.

v4 replaces both with one screen (`views/home.js`):

```
  WHAT ARE YOU LOOKING FOR?  /  WHERE?   (+ Add another search)
  ✓ Google Maps search detected · Use this search / Use my search above
  [ START COLLECTING LEADS ]
```

Two paths, chosen automatically by what's detected, never by the user having
to know a term:

- **Mode A — already on Maps.** `MAPS_DETECT` (a new, tiny message — `router.js`
  asks the active Maps tab's content script for `dom.getSearchQuery()`) shows
  what's already on screen. Start sends `COLLECT_START` directly, unchanged
  from v3.
- **Mode B — typed search(es), 1 or many.** Every row (the main one plus any
  "+ Add another search" rows) becomes a queue item and goes through
  `QUEUE_RUN` → `advanceQueue()` → `onMapsTabReady()` — the same,
  already-tested queue engine that drove the old "Search queue" textarea.
  A single search and ten searches take the identical path; there is no
  separate "queue" concept the user has to learn.

Nav is Home / Jobs / Data / Filter / Enrich / Export / Settings — Diagnostics
moved from a top-level tab into Settings → Diagnostics (same view, same
`renderDiagnostics`/`bindDiagnostics`, just reached one click deeper).

Buttons: **START COLLECTING LEADS** / **PAUSE COLLECTION** / **STOP
COLLECTION** / **ENRICH DATA**. A job that errored after collecting records
reads as **Partial — N saved**, not a bare "Error", both on Home and in the
Jobs list.

### 0.2 — card-first collection: no per-business tabs

The v3 rewrite (section 1 below) fixed *whether* every result got collected.
It did not fix *how heavy* getting the details for each one was: for
Standard/Advanced mode, `detail-resolver.js` opened a pool of 2–4 real
background tabs and **navigated one to every record's place page**,
sequentially through that pool, automatically right after every collection.
Reading the rendered panel this way is reliable, but dozens to hundreds of
tab creations/navigations per search is heavy on Chrome and slow — the
"opens many tabs, makes Chrome slow" complaint. This audit compared the
codebase against a working prior version of this same product and adopted
its faster approach where it held up, rather than guessing.

**Card-first.** `card-parser.js` already read Business Name, Category,
Rating, Reviews and the street Address straight off the results card with
zero network cost. It's extended to also read **Website** and **Phone**
this way, via `CARD_WEBSITE`/`CARD_PHONE` in `selectors.js` — Google
frequently renders these as quick-action buttons directly on the card, not
only inside the place detail panel. When they're there, the record is
complete after Phase 1 alone. When they're not, the field is simply blank
until (optional) detail resolution — nothing is invented either way.

**No tabs for what's left.** For whatever's still missing — in practice this
is almost always Full Address, since Maps' card never shows a complete
postal address — `detail-resolver.js` no longer opens anything. It asks the
Maps tab's *own* content script to `fetch()` the place page and parse the
response (`place-detail.js:fetchPlaceDetail`). Bounded concurrency
(`core/safe.js:mapLimit`, default 5) governs how many of these run at once,
the same primitive `enrich-manager.js` already used for website fetches —
no tab pool, no per-record tab lifecycle, and `router.js` never calls
`chrome.tabs.create` for this.

This is not the same fetch that failed in row 2 of the table below. That was
a background-service-worker fetch, an unrelated, cookie-isolated context, at
fixed and undocumented JSON array indices with no validation. This fetch
runs from the content script already injected on `google.com` — a
same-origin request that carries the user's session automatically — and its
parser (`extractFromDocument`) reads the same `data-item-id` attributes the
rendered page exposes, falling back to `detail-parser.js`'s existing
candidate-path-plus-validator JSON miner (unchanged) only for what the DOM
didn't have. `resolveAll()` still only processes records missing something,
same as before, and applies whatever it finds without ever overwriting a
value Phase 1 already found.

`readPlacePage()`/`waitForPlacePanel()` (the live-tab-reading path) and the
whole `TabPool`/`navigate()` machinery are gone — superseded, not left
behind as dead code alongside the replacement.

---

## 1. What was wrong with v2.0.1, from its own code

| # | Symptom | Root cause in v2.0.1 |
|---|---|---|
| 1 | Not all results collected | `collector.js:216` — `for (; state.cardIndex < cards.length; state.cardIndex++)`. `cardIndex` was set to 0 once (line 170) and **never reset between scroll passes**, while `cards` was re-queried from a **virtualized** list. When Maps recycled nodes and the array shrank below the cursor, the loop body stopped executing entirely. Anything landing below the cursor was skipped permanently. |
| 2 | 51 results, 2 websites | The detail phase did `fetch(placeDetailUrl)` from the content script and mined `APP_INITIALIZATION_STATE` from the returned HTML. A plain fetch of a place URL does not reliably return the rendered page's payload, so `parsePlaceDetail` returned `ok:false` for most records. |
| 3 | Full Address incomplete | Only the payload path could produce it, and that path was failing. There was no component model and no distinction between "street line" and "complete address" at the field level. |
| 4 | 11 records abandoned | `collector.js:387` — `const cap = Number(settings.domFallbackCap) || 40;` |
| 5 | "51 Errors" for 51 good leads | Two sources: the detail phase ran `state.counts.detailFail++; state.counts.errors++;` when a business had no website, and `recordDiagnostics()` called `diag.reportFail('parser.phone', …)` when a business had no phone. `scrape.js:127` then rendered `c.errors` as "Errors". |
| 6 | Stuck on "Running" | No activity tracking existed anywhere — `grep lastActivityAt` returned nothing. |
| 7 | Queue data unreachable | `listJobs()` existed in `job-manager.js` but **no view called it**, and there was no `jobs.js` view. |
| 10 | Filters too basic | All 16 filters were boolean predicates. No numeric comparison, no category, no location. |

---

## 2. The collector, rewritten

v2 held a positional cursor. v3 holds **no positional state at all**.

```
        ┌─────────────────────────────────────────────┐
        │  scan ALL cards currently in the DOM        │
        │        ↓                                    │
        │  stable place key (placeId > cid > URL)     │
        │        ↓                                    │
        │  Set lookup — collect only what is new      │
        │        ↓                                    │
        │  ONE bounded scroll step                    │
        │        ↓                                    │
        │  compare feed metrics                       │
        │        ↓                                    │
        │  changed? → loop.  not changed? → retry N×  │
        │        ↓                                    │
        │  confirmation scan, then finish             │
        └─────────────────────────────────────────────┘
```

Three properties matter:

**Stable identity, not position.** `stableKey()` prefers Google's feature id, then
the CID, then the viewport-stripped place URL. Recycling a DOM node cannot make a
place look new, and moving one cannot make it invisible.

**One bounded scroll step per scan.** `scrollFeed()` writes `scrollTop` exactly
once and moves at most ~1.5 viewports. v2 wrote it twice and jumped to
`scrollHeight`, so the virtualized window could slide further than it was tall
and cards mounted and unmounted between two scans. Testing showed this alone
cost 25 of 120 results.

**Patient end detection.** A single fruitless scroll means nothing — Maps pauses
constantly. The loop compares card count, scroll height, scroll position and the
loading indicator, retries `maxNoChangeAttempts` times (default 8) with growing
back-off, and then does a **confirmation scan** before accepting the end,
because the scroll that produced the end signal may itself have rendered a final
batch.

Measured against a virtualized harness (`tools/harness/mini-dom.mjs`):

| Scenario | v2 algorithm | v3 |
|---|---|---|
| 60 places, window 20 | 20 / 60 | **60 / 60** |
| 120 places, window 15 | — | **120 / 120** |
| 51 places, stalls every 3rd scroll | — | **51 / 51** |
| 200 places, frequent stalls | — | **200 / 200** |

---

## 3. Detail resolution — card first, then a same-origin fetch, never a tab

Website and Phone are read straight off the **results card** during
collection whenever Google renders them there (`card-parser.js`) — no
network cost, no separate stage. What's left after that — in practice,
almost always Full Address, which Maps' card never shows in full — is
resolved by asking the Maps tab's own content script to fetch the place page
and read the response; its `data-item-id` hooks are the most durable thing
Maps exposes, whether read from a live page or a fetched one.

```
  ┌── background service worker ──────────────────────┐
  │  resolveAll(): only records missing something     │
  │      ↓ sendMessage(mapsTabId, {url})               │
  │  the SAME Maps tab's content script:               │
  │      fetch(placeUrl)  ← same-origin, cookies on    │
  │      ↓                                              │
  │  place-detail.js: extractFromDocument()             │
  │      data-item-id → aria-label → semantic row      │
  │      → href → embedded payload (validated)          │
  │      ↓                                              │
  │  applyDetail() → record + per-field status          │
  └───────────────────────────────────────────────────┘
```

- **No tab is opened, ever.** `mapLimit` (default 5 concurrent) bounds how
  many of these fetches run at once inside the one Maps tab already open —
  the same primitive `enrich-manager.js` uses for website fetches.
- Only records still missing Full Address, Website or Phone are processed at
  all; a record Phase 1 already completed is never touched again.
- **No cap.** Throughput is governed by concurrency, timeout, retries and batch
  size; every record is either resolved or given an explicit status.
- If no Google Maps tab is open when this runs, nothing is silently guessed —
  the affected records are marked `Failed` with a technical error explaining
  why, exactly as an unreachable tab would have been reported before.
- Runs *after* collection has finished and been saved, so it cannot affect the
  collection result.

**Address vs Full Address** are separate fields with separate rules
(`collector/address.js`). `isCompleteAddress()` requires a street plus at least
two of {city, region, postcode, country}. A bare street line becomes `Address`
and leaves `Full Address` blank with `fullAddressStatus: Not Found`. Country is
appended only when actually present — never inferred from a postcode.

---

## 4. The error model

```
     MISSING FIELD                    BROKEN PROGRAM
          │                                 │
          ▼                                 ▼
  core/quality.js:analyze()      core/quality.js:recordTechnicalError()
          │                                 │
     coverage counts                 technical.byCategory
          │                                 │
          ▼                                 ▼
   "DATA QUALITY" card              "SYSTEM HEALTH" card
```

These share no counter and no code path. `analyze()` contains no statement that
can increment an error. The only categories that count as technical errors are
`parser`, `timeout`, `storage`, `communication`, `collector`, `unexpected`.

Every blank field carries a reason: `Found`, `Not Found`, `Not Requested`,
`Pending`, `Failed`. Only `Failed` is an error, and the Data table's status
chips say which is which on hover.

---

## 5. Heartbeat and the watchdog

Every meaningful event calls `beat()`: cards detected, records collected, feed
scrolled, more results loaded, a detail resolved, a batch saved. The job record
carries `lastActivityAt`; `stallState()` reports `stuck` once a **running** job
has been idle past `STALL_THRESHOLD_MS` (30 s). A paused job is never "stuck".

The UI shows `Last activity: 4s ago · Collected 4 new`, or
`⚠ No activity for 35s` with a Retry button.

---

## 6. Jobs, datasets, queue, projects

| Concept | Owns | File |
|---|---|---|
| **Job** | one collection run and its records | `jobs/job-manager.js` |
| **Dataset** | a *view* over one or more jobs | `jobs/dataset.js` |
| **Queue** | execution order only | `jobs/queue.js` |
| **Project** | settings and grouping, never records | `jobs/projects.js` |

The Jobs tab lists every job with its coverage; scope switching (Current job /
Project / All jobs / Selected) drives Data, Filter and Export. `combineJobs()`
merges a selection into a **new** job and leaves the originals byte-identical.

The queue distinguishes `pending → loading → scraping → done | failed | paused`,
and `hasActiveItem()` blocks the next search until the previous job *and its
detail resolution* are finished.

---

## 7. The Start-button contract

```
  START ──► JobManager.createJob() ──► Collector.run()
                                          │
                                          ├─ core/{constants,safe,logger,diagnostics}
                                          └─ collector/{selectors,dom,card-parser}
```

`src/collector/collector.js` may import **only** from `../core/` and `./`.
It reaches 8 modules total. `tools/verify-isolation.mjs` walks the real import
graph and fails the build if it can reach `engines/dedupe`, `engines/score`,
`engines/validate`, `engines/filters`, `enrich/*`, `export/*`, `background/*` or
`jobs/*`.

Run it after any change you make. If it passes, Start is safe.

---

## 8. Stage order

```
COLLECTION    Maps Collector → raw records → persistent job store
                    │
PROCESSING    Detail Resolver → Normalizer → Quality Analyzer
                    │           → Deduplication → Validation → Scoring
                    │
ENRICHMENT    Website → Email → Social
                    │
PRESENTATION  Dashboard · Data · Filters · Jobs · Diagnostics
                    │
EXPORT        CSV · Excel · Google Sheets
```

Every stage reads records from storage and writes them back. Any stage can fail
without touching the others.

---

## 9. What this still cannot do, honestly

- **Coordinates** come from the place URL or payload. Not every result exposes
  them; those export blank.
- **Full Address country** is appended only when the panel or payload carries it.
- **Email** is read only from the business's own public website.
- **Google Sheets** is inert until you supply your own OAuth client ID.
- Detail resolution needs a Google Maps tab open to fetch through — if none
  is open when it runs, the affected records are marked `Failed` rather than
  silently guessed, and it can be retried once a Maps tab is open again.
- Website/Phone straight off the results card depend on Google actually
  rendering those quick-action buttons there, which isn't universal across
  every Maps rollout — when absent, the field is simply blank after Phase 1
  and picked up by detail resolution instead, same as before.
