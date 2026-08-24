# Al-Aqsa Scraper

**v4.0.0 · Chrome Manifest V3 · no build step · no runtime dependencies**

A modular Google Maps lead-generation scraper. Collection, enrichment,
deduplication, validation, scoring and export are separate systems that fail
independently.

---

## Install (60 seconds)

1. Unzip somewhere permanent — Chrome loads the extension from disk, so don't
   unzip into Downloads and then delete it.
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select **the folder containing `manifest.json`**
5. Pin the extension to your toolbar

> **"Manifest file is missing or unreadable"** means you selected a folder one
> level too high. The folder you pick must show `manifest.json` directly inside
> it — not another folder that contains it. Open the folder in your file manager
> and confirm you can see `manifest.json`, `src`, `assets` before selecting it.

There is **no build step**. No `npm install`, no bundler, no compile.
The extension is plain ES modules that Chrome loads directly.

**Requires Chrome 114+** (for the Side Panel API).

---

## Use it

1. Click the Al-Aqsa Scraper icon → the side panel opens and stays open while you browse.
2. On **Home**, type what you're looking for and where — e.g. `Roofing contractors` /
   `Jacksonville, FL`. Already on Google Maps with a search open? The panel detects it
   automatically and offers to use it instead, so you don't have to type anything twice.
3. Press **START COLLECTING LEADS**. If you typed a search, Google Maps opens (or
   navigates) and collection starts on its own the moment the results are ready — you never
   have to switch tabs and press Start a second time. Add more rows with **+ Add another
   search** to run several searches back to back; one failing never stops the rest.
4. When it says **Collection complete**, press **ENRICH DATA** if you want email and social
   profiles too — that's a separate, optional step so the first pass stays fast.

| Tab | What it is for |
|---|---|
| **Home** | Search, mode, fields, Start/Pause/Stop, live dashboard, queue |
| **Jobs** | Every dataset you have ever collected, and combining |
| **Data** | The records, with a status chip for every field |
| **Filter** | Rating, reviews, category, availability, quality, location |
| **Enrich** | Detail resolution, email + social, validation, scoring, dedupe |
| **Export** | CSV, Excel, Google Sheets |
| **Settings** | Tuning, scoring weights, field mapping reference, and Diagnostics |

### Extraction modes

| Mode | Fields | Speed |
|---|---|---|
| **Fast** | Name, category, rating, reviews, Maps URL | Fastest — reads the results list only, opens no place |
| **Standard** | + address, full address, website, phone | Details resolve **after** collection finishes |
| **Advanced** | + coordinates | Same, then email/social/validation/scoring from the Enrich tab |

### The two things people get wrong

**Address is not Full Address.** `Address` is the street line from the results
card. `Full Address` is the complete postal address from the place panel. When
Google exposes only a street line, Full Address is left **blank** and marked
"Not Found" rather than being filled with a partial address.

**A missing field is not an error.** The dashboard has two separate areas:
*Data quality* counts coverage (48 of 51 websites), *System health* counts
technical errors (parser exceptions, timeouts, storage and communication
failures). A business that never published a phone number appears in the first
and never in the second.

---

## The one rule that matters

> **Adding a feature must never break the Start button.**

Every previous version broke because features were added *inside* the scraping
loop. In this version the collector may import **only** `src/core/` and
`src/collector/`. It cannot reach enrichment, deduplication, scoring,
validation, export or Google Sheets — and that is checked mechanically:

```bash
node tools/verify-isolation.mjs
```

It walks the real import graph and exits non-zero if any forbidden module is
reachable. **Run it after any change you make.** If it passes, Start is safe.

When you want to add something new: make it a *stage* that runs over stored
records after collection. Never a line inside the collect loop.

---

## Verifying the build

```bash
node tools/verify-isolation.mjs   # Start-button isolation contract
node tools/verify-build.mjs       # syntax, imports, exports, manifest, CSP
node tools/run-tests.mjs          # 148 tests incl. all 23 v3 scenarios
```

All three run on plain Node with no dependencies installed.

---

## Project layout

```
manifest.json                 MV3 manifest
src/
  core/
    constants.js              fields, field mapping, statuses, settings
    quality.js                DATA QUALITY vs TECHNICAL ERRORS — the split
    safe.js  storage.js  bus.js  logger.js  diagnostics.js
  collector/                  THE START BUTTON PATH (8 modules, nothing else)
    selectors.js              ← every Google Maps selector lives here
    dom.js                    feed detection, metrics, one bounded scroll step
    card-parser.js            results-card parsing + stable place identity
    address.js                Address vs Full Address, component splitting
    place-detail.js           layered read of the RENDERED place panel
    detail-parser.js          embedded payload, used only as a last resort
    validators.js             rejects schema.org, phones-as-addresses, …
    collector.js              the loop: scan → key → scroll → confirm
  engines/                    normalize · dedupe · validate · score · filters
  enrich/                     email + social from the business website
  export/                     csv · xlsx (zero-dep writer) · zip · sheets
  jobs/                       job-manager · dataset (combine) · queue · projects
  background/
    service-worker.js  router.js  net.js
    detail-resolver.js        background tab pool, no cap, batched
  sidepanel/                  Home / Jobs / Data / Filter / Enrich / Export / Settings
tools/
  verify-isolation.mjs        enforces the Start-button contract
  verify-build.mjs            syntax, imports, exports, manifest, match patterns
  run-tests.mjs               121 tests
  harness/mini-dom.mjs        dependency-free DOM, incl. a VIRTUALIZED feed
docs/ARCHITECTURE.md          full architecture + the v2.0.1 audit
```

---

## When Google Maps changes

Google regenerates its class names regularly. **You only need to edit one file:**
`src/collector/selectors.js`.

Every selector is an ordered list. Add the new one at the **top**; leave the old
ones in place for users on an older Maps rollout.

To find out *which* selector broke, open the side panel → **Diagnostics**.
It shows a live parse of the first result card on screen, so you can see exactly
which field came back blank.

---

## Google Sheets (optional)

Sheets export is fully implemented but **inert until you supply your own OAuth
client ID** — a client ID is tied to your specific extension ID, so only you can
create one. The UI says "not configured" rather than pretending to be connected.

See **`SETUP-GOOGLE-SHEETS.md`** for the five-minute walkthrough.

**CSV and Excel need none of this.** They are generated entirely inside the
extension and work with no Google account at all.

---

## Honest limitations

These are real constraints, not bugs. Nothing is faked to hide them.

| Field | Behaviour |
|---|---|
| **Full Address** | Read from the place's rendered Maps panel. Complete when Google exposes the components; **blank** when it exposes only a street line, with `Full Address Status = Not Found`. |
| **Country** | Appended only when the panel or payload actually carries it. Never inferred from a postcode or phone prefix. |
| **Latitude / Longitude** | From the place URL or payload. Not every result exposes them; those export blank. |
| **Website** | Rejected outright if it is `schema.org`, any Google-owned host, or a Maps internal URL. A business with no website gets a blank and `Website Status = Not Found`. |
| **Email** | Only ever read from the business's own public website. No pattern-guessing, no third-party lookup. |
| **Rating** | Parsed from the star widget's ARIA label first (locale-safe). Anything outside 0–5 is rejected as a mis-parse and left blank. |
| **Detail resolution speed** | Roughly 1–3 seconds per record. 51 records with 2 background tabs is about 40–70 seconds. That is the cost of reading the rendered panel instead of guessing from an HTTP response. |

---

## Privacy & security

- Everything is stored **locally** in your Chrome profile (`chrome.storage.local`).
- Nothing is transmitted anywhere except the Google Sheet you explicitly choose.
- **No license server, no telemetry, no analytics, no phone-home.**
- No secrets in the source. No OAuth client secret exists (a Chrome extension is
  a public client and does not use one). No token is written to storage —
  `chrome.identity` holds it in Chrome's own credential store.
- Permissions are minimal. `*://*/*` is an **optional** permission requested only
  the first time you run Enrich; decline it and everything else still works.
- Only publicly displayed business information is collected.

---

## Troubleshooting

**Start says "Open Google Maps and run a search first"**
This only happens when using "Use this search" with no matching Maps tab open — it can
close between detection and the click. Typing a search into What/Where and pressing Start
does not need an existing tab; it opens or navigates one for you.

**No cards are found**
Settings → Diagnostics → Collection will tell you whether the feed was detected. If
"Feed detected" fails, Maps changed its DOM — add the new selector to
`src/collector/selectors.js`.

**Full Address is blank for some records**
Google didn't expose address components for those places. Turn on
**Settings → Detail panel fallback**, which opens each incomplete place's panel
and reads the address directly. Slower, more reliable.

**Google Sheets says "not configured"**
That's correct until you add your OAuth client ID. See `SETUP-GOOGLE-SHEETS.md`.

**The side panel won't open**
Chrome 114+ is required. Check `chrome://settings/help`.

**After editing the code, Start stopped working**
Run `node tools/verify-isolation.mjs`. If it fails, you imported an optional
module into the collector — that's the one thing that breaks Start.
