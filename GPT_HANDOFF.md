# ARMA Audit Engine — Complete Implementation Handoff

> **Purpose of this file:** A single, self-contained description of *everything*
> implemented in this codebase, written so an LLM (e.g. a custom GPT) or a new
> engineer can understand what exists and how it works, and safely drive future
> changes. Last generated: **2026-07-01**.

---

## ⚠️ Important note before you read (please read this)

You asked me to document **"reports, logistics, WAG, OG, MBFI, and farmers' data."**

I searched the entire repository (all `.ts`, `.js`, `.md`, `.yaml`, `.html`
files). **None of these exist here:** there is no *WAG*, *OG*, *MBFI*,
*farmers' data*, or *logistics* module anywhere in the code, comments, docs, or
git history.

This project is a **local-business SEO / Google Business Profile audit engine**
for U.S. **home-service contractors** (plumbing, HVAC, roofing, electrical,
etc.). It is called the **"ARMA Audit Engine"** (a.k.a. GrowthScope API).

So this handoff documents **what actually exists**. If WAG / OG / MBFI / farmers
/ logistics belong to a *different* project or repo, that code is not here — tell
me where it lives and I'll document that separately. (One guess: "MBFI"-style
acronyms *might* be your own shorthand for the **revenue-gap financial model**
described in §7 — but nothing in the code uses those names, so I have not assumed
it.)

---

## 1. What this system does (one paragraph)

Given a contractor's website URL plus a target city/state/vertical, the engine
measures how visible that business is on Google versus its strongest local
competitor, crawls both websites for conversion elements, pulls Core Web Vitals,
estimates the monthly revenue being lost to the competitor using industry
benchmarks, and produces a polished **PDF audit report** (plus a cold-email
draft). Every number in the report is backed by a real API response or a real
browser measurement — there are deterministic fallbacks but **no invented
metrics**.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + TypeScript, run via `ts-node` |
| Web framework | Express 5 |
| Database | SQLite via `better-sqlite3` (caching + lead persistence) |
| Headless browser | `puppeteer-core` + `@sparticuz/chromium` (crawl + Google Maps scrape) |
| AI | Anthropic Claude SDK (`@anthropic-ai/sdk`) — Sonnet + Haiku |
| API docs | Swagger UI at `/docs` (served from `swagger.yaml`) |
| Hosting | Local (`ts-node server.ts`) **or** Vercel serverless (`api/index.ts`, `vercel.json`) |

**Entry point:** `server.ts`. On Vercel it is exported as a serverless function
(guarded by `process.env.VERCEL`); locally it calls `app.listen(3002)`.

### Required environment variables (`.env`, see `.env.example`)
| Var | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (report copy, niche classification, cold email, insight extraction) |
| `PAGESPEED_API_KEY` | Google PageSpeed Insights API (Core Web Vitals) |
| `GOOGLE_PLACES_API_KEY` | Google Places API v1 + Geocoding API (GBP lookup, geocoding, fallback rankings) |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | DataForSEO (map-pack / organic SERP, reviews, GBP posts, traffic, search volume) |

---

## 3. HTTP API surface

All routes are registered in `server.ts`.

| Method & path | Router file | Purpose |
|---|---|---|
| `GET /` | `server.ts` | Serves the dashboard HTML to browsers; JSON health blob to API clients (never cached). |
| `GET /docs` | `server.ts` | Swagger UI (assets loaded from jsDelivr CDN because Vercel drops the bundled assets). |
| `GET /docs.json` | `server.ts` | Raw OpenAPI spec. |
| `POST /lite-report` | `routes/liteReport.ts` | **Primary product.** Fast GBP + map-pack + revenue audit. Returns a PDF (or JSON with `?format=json`). Persists the lead to SQLite. |
| `POST /full-report` | `routes/fullReport.ts` | **Deep audit.** Requires a prior lite report for the same domain. Adds PageSpeed, site crawls, Claude-written 6-page report. Returns a PDF. |
| `POST /arma-report` | `routes/armaReport.ts` | Alternative single-shot report focused on a 4-step "customer journey" gap model with a weighted dollar split. Returns a PDF (or JSON). Does **not** require a prior lite report. |
| `GET /health` | `routes/utility.ts` | DB row counts + live cache count. |
| `GET /mappack-debug` | `routes/utility.ts` | Inspect live/cached map-pack rankings for a vertical+city (verification tool). |
| `GET /pagespeed-check` | `routes/utility.ts` | Live PageSpeed check bypassing cache. |
| `GET /cache-status` | `routes/utility.ts` | List all map-pack cache entries with age. |
| `DELETE /cache-clear` | `routes/utility.ts` | Clear one or all map-pack cache entries. |
| `POST /debug/trace` | `routes/utility.ts` | Runs the real ranking pipeline and returns every console log line for diagnosis. |

### Request payloads
- **`/lite-report`** and **`/arma-report`**: `{ url, city, state, vertical?, matchType?, lat?, lng?, format? }`
  - `city`, `state`, `url` required. `vertical` defaults to "Home Services".
  - `matchType` ∈ `map` | `place` | `business` (default `map`) — which Google surface to rank against (see §6).
  - `lat`/`lng` optional live searcher coordinates (from browser geolocation).
- **`/full-report`**: `{ url }` — everything else is read from the saved lite-report row.

---

## 4. Request → report pipeline

### Lite report (`routes/liteReport.ts`)
1. Normalize URL, derive `domain` and a guessed business name.
2. In parallel: **GBP lookup** (`getLeadGBP`) + **monthly organic traffic** (`getMonthlyTraffic`).
3. **Map-pack ranking** (`getWeightedPosition`) for the *submitted market* (deliberately not the GBP-registered city — see the long comment in the file: auditing the city the user actually searched is the whole point).
4. Pick the **competitor** by rank rule (see §6) and resolve its place_id / website / phone.
5. In parallel: GBP review insights, GBP posts/week, lead & competitor homepage text, competitor phone, **organic position**.
6. Claude Haiku extracts **owner name + service area** from each homepage.
7. Compute **revenue loss** (§7).
8. Claude Haiku writes a **cold email** (deterministic fallback if the API fails).
9. Assemble `liteReport` JSON, **persist to `leads` table**, then render HTML → PDF (`report/liteHtml.ts` → `report/pdf.ts`), unless `?format=json`.

### Full report (`routes/fullReport.ts`)
1. Loads the saved `leads` row (errors if no lite report exists for that domain — lite → full is intentionally sequential so the competitor stays locked).
2. Parallel **PageSpeed** for lead + competitor, mobile + desktop; plus daily search volume, review insights, GBP posts.
3. Sequential **site crawls** of lead then competitor (sequential to avoid OOM under Puppeteer).
4. `classifyNiche` (Claude Sonnet) confirms the vertical → recompute revenue.
5. `computeTrustAngle` picks a review/rating narrative (`analysis/trust.ts`).
6. `analyzeWithClaude` (Sonnet, with screenshots) writes the full 6-page report JSON.
7. Render HTML → PDF (`report/html.ts` → `report/pdf.ts`); stamp `full_report_generated_at`.

### ARMA report (`routes/armaReport.ts`)
- Self-contained (no DB dependency). Fetches GBP + traffic + map-pack + PageSpeed + organic snapshot + a lightweight homepage-review count, then splits a conservative dollar figure across the four "customer-journey" gaps (§7) and renders `report/armaHtml.ts`.

---

## 5. Data services (`services/`)

| File | Key exports | What it does |
|---|---|---|
| `gbp.ts` | `getLeadGBP`, `resolveStateName`, `getGBPReviewInsights`, `getGBPPostsPerWeek`, `getPlacePhone`, `getPlaceCoords` | Google Business Profile data. `getLeadGBP` searches Places by **domain first**, then name, and only accepts a match whose website host equals the input domain (prevents matching the wrong business). Review insights come from DataForSEO's async review task (submit → poll), falling back to Places API v1 (which lacks owner-reply data). |
| `mappack.ts` | `getWeightedPosition` / `getMapPackPosition`, `getOrganicPosition`, `getOrganicSnapshot` | **The heart of the system** — see §6. |
| `gmaps.ts` | `scrapeMapsPack`, `buildMapsSearchUrl` | Direct Google Maps scrape via Puppeteer: types the query into the Maps search box, scrolls the results feed, and **polls until the ranking stabilizes** before reading it (Google re-ranks for a few seconds after render). |
| `pagespeed.ts` | `getPageSpeed` | Google PageSpeed Insights API → performance score, LCP, CLS, INP, TTFB. Caches successful results 24h in `pagespeed_cache`; never caches failures. |
| `traffic.ts` | `getMonthlyTraffic`, `getDailySearches` | DataForSEO Labs domain rank overview (organic ETV) and Google Ads search volume ÷ 30. Both fall back to safe defaults (200/mo traffic, 0 daily). |
| `crawl.ts` | `crawlSite` | Puppeteer crawl → conversion booleans (see §8) + mobile/desktop screenshots + page text/title/meta. Snaps back to the homepage if the URL redirects to a subpage. |

Support libs: `lib/http.ts` (fetch-with-timeout, URL normalize, page-text fetch),
`lib/places.ts` (Google Places v1 wrappers), `lib/auth.ts` (DataForSEO basic-auth
header), `lib/browser.ts` (Puppeteer/Chromium launch options), `lib/trace.ts`
(console capture for `/debug/trace`).

---

## 6. Map-pack ranking logic (most important + most-iterated part)

This is the module most likely to need future tuning; treat it carefully.

### Three independent Google surfaces (`MatchType`)
Google ranks these **separately** (they differ by 1–3 positions), so the caller
picks which one the report should match:
- `map` → **google.com/maps** → primary source is the **Puppeteer Maps scrape** (`gmaps.ts`); DataForSEO Maps as fallback.
- `place` → Google Search "Places" / "More places" list → **DataForSEO `local_finder`**.
- `business` → Google Search "All" tab "Businesses" 3-pack → **DataForSEO `organic` local_pack**.

Each surface has its own attempt chain that degrades to the others so a single-API
hiccup still yields a ranking. `SURFACE_LABEL` gives the human name shown in the report.

### Location anchoring
- The city is **geocoded** to a centroid; the search is pinned to that coordinate so the API ranking matches a manual "<vertical> in <city>" search.
- If live `lat`/`lng` are provided, they're used **only if within ~160 km** of the city centroid (`LIVE_LOCATION_MAX_KM`) — otherwise a remote auditor's device would anchor the search to the wrong region. Haversine distance guards this.
- Live-location runs **bypass the shared cache** so one user's GPS-pinned result never leaks to another.

### Caching
- Table `mappack_cache`, keyed **per surface**: `"<vertical>::<matchType>"` + city + state. **6-hour TTL** (rankings shift intraday). `db.ts` contains ~14 historical one-time migrations that flushed this cache each time the ranking methodology changed — that history explains the current approach.

### Finding the lead in the pack
1. Exact **place_id** match.
2. Fuzzy **name + review-count** match requiring overlap on a **distinctive** token (brand/owner words), because generic trade words ("heating", "cooling", "llc" — see `GENERIC_NAME_WORDS`) are shared by nearly every business and caused false matches. Review-count closeness (±3 or ±2%) is a strong signal.
- If the lead isn't found in the top ~20, position is recorded as **99** and the report carries a `data_quality_warning` (usually means the vertical is wrong for that business).

### Picking the competitor (`pickCompetitorRank`)
The report always compares the lead against **one** representative competitor,
chosen by the lead's own rank (rank counts non-lead entries):
- Lead #1–4 → competitor **#1** (closest challenger / leader)
- Lead #5–8 → **#3**
- Lead #9–13 → **#4**
- Lead #14+ → **#5**

Excluded brands can be filtered out; the competitor's missing place_id / website /
phone are then resolved via Places API. `fullPack` returns the top-5 slots always
including the lead + competitor, enriched with ratings/review counts where the
scrape omitted them.

### Verification URL
Every ranking returns a **`verificationUrl`** — the exact location-pinned Google
URL (Maps scrape URL, or DataForSEO `check_url`) so the client can open it and see
the same list. This is a core trust feature of the product.

### Organic (blue-link) rank
`getOrganicPosition` / `getOrganicSnapshot` use DataForSEO organic SERP to report
where the lead and competitor rank in the classic links below the map.

---

## 7. Financial / revenue-gap model (`benchmarks.ts`)

This is the closest thing to a "financial impact" module (if that's what your
"MBFI" shorthand meant, this is it — but again, that name isn't in the code).

### Industry benchmarks
`INDUSTRY_BENCHMARKS` is a hand-curated table of **26 home-service verticals**,
each with:
- `cvr` — typical lead→customer conversion rate (%),
- `avg_ticket` — average job value ($),
- `confidence` — H / M / L.

Examples: Plumbing (3.5% CVR, $1,080), HVAC (3.0%, $1,635), Roofing Replacement
(1.2%, $9,540), Kitchen Remodeling (1.2%, $26,950), Solar (0.9%, $22,200).

`findBenchmark(input)` fuzzy-maps any free-text vertical to a canonical key
(e.g. "roof" → "Roofing Replacement"), defaulting to Plumbing if nothing matches.
`NICHE_KEYWORDS` provides 2–3 buyer-intent search terms per vertical, and
`getBuyerIntentKeywords` returns them.

### Revenue-loss calculation (`calculateRevenueLoss`)
```
cvr_typical    = benchmark.cvr / 100
cvr_potential  = cvr_typical * 2.0          // "what good looks like"
traffic        = monthlyTraffic (capped at 200 for very-high-ticket niches)
current_rev    = traffic * cvr_typical   * avg_ticket
potential_rev  = traffic * cvr_potential * avg_ticket
monthly_loss   = potential_rev - current_rev   (hard-capped at $60,000)
loss_low/high  = monthly_loss * 0.7 / * 1.3    // the range shown in reports
```
The output is intentionally **conservative** (caps prevent absurd figures for
high-ticket niches) and always presented as an **estimate/range**, never a
guaranteed number.

### ARMA report's journey-gap split (`routes/armaReport.ts`)
The ARMA report scales the benchmark loss by **how far down the lead actually
ranks** (a CTR curve by map position) and then splits that dollar figure across
only the **active gaps** among four customer-journey steps, using weights:
`{ map: 0.564, search: 0.242, trust: 0.097, speed: 0.097 }`. Inactive steps get
$0 and their weight is redistributed — so a business that only has a map problem
sees the whole loss attributed to discovery, not invented speed/trust losses.

---

## 8. Website crawl signals (`services/crawl.ts`)

Puppeteer loads the homepage (desktop 1280px + mobile 390px) and evaluates these
booleans, which drive both the report tables and Claude's fix recommendations:

- `hasStickyCTA` — fixed/sticky call/quote/book bar
- `hasAboveFoldCTA` — CTA button in the top ~800px
- `hasPhoneAboveFold` / `hasPhoneAboveFoldMobile` — click-to-call or visible phone number near the top (mobile checked at 390px)
- `hasReviewsOnHome` — review/testimonial/rating widgets or text
- `hasTrustBadges` — licensed/insured/certified/BBB/Angi badges
- `hasServiceAreaPages` — "service area", "serving", location links
- `hasBookingForm` — any form/contact/estimate/quote widget or CTA copy
- `hasEmergencyMessaging` — 24/7, emergency, same-day
- `hasFinancing` — financing / payment plan / 0% interest
- `hasDomainMismatch` — H1's first word not in the hostname
- Plus `pageText`, `title`, `metaDescription`, `h1`, and base64 mobile+desktop screenshots.

Screenshots are sent to Claude as **ground truth** — if the model can see a phone
number or CTA that the DOM checks missed (CSS-injected/image content), it overrides
the boolean.

---

## 9. AI / Claude usage (`analysis/claude.ts`, `analysis/trust.ts`)

| Function | Model | Job |
|---|---|---|
| `extractLeadInsights` | Haiku | Extract owner/founder name + service areas from homepage text → JSON. |
| `classifyNiche` | Sonnet | Map site to one of the 26 benchmark niches (skipped if vertical was provided). |
| `generateColdEmail` | Haiku | 3-sentence cold email + subject; deterministic fallback on failure. |
| `analyzeWithClaude` | Sonnet | The big one — writes the full 6-page report JSON from real data + screenshots. |
| `buildFallback` | (none) | Deterministic report generator used verbatim when Claude fails, so the product never hard-fails on an AI outage. |
| `computeTrustAngle` | (none) | Chooses one of several review/rating "paradox" narratives for the report's trust page. |

**Guardrails baked into the system prompt (important — keep these when editing):**
- Use only real numbers; never invent metrics or "+X% uplift"/"$ at risk" claims. Each fix instead names one **measured** metric from a fixed allow-list.
- Every fix array must have exactly 3 items; no duplicate topics across pages.
- Never recommend adding something the crawl shows already exists (sticky CTA, financing, phone above fold, weekly GBP posts, etc.).
- Three-state review-reply logic (not responding / mostly responds with a few open / already responding) drives which GBP fix is suggested.
- Only the lead and the single chosen competitor may be named — never other pack members.

---

## 10. Database schema (`db.ts`)

SQLite file at `./audits.db` locally, `/tmp/audits.db` on Vercel (ephemeral there).

- **`leads`** — one row per audited domain (PK = `domain`): business + GBP fields, competitor fields, traffic, the full lite-report JSON, and generation timestamps. The full report reads competitor fields back from this row so lite → full stays consistent.
- **`mappack_cache`** — per-surface ranking snapshots (PK = keyword+city+state, 6h TTL).
- **`pagespeed_cache`** — per-domain+strategy Core Web Vitals (24h TTL).
- **`migrations`** — tracks the ~14 one-time cache-flush/schema migrations (their comments are a written history of every ranking-methodology change).

---

## 11. Frontend (`public/`)

A static dashboard (`index.html` + `app.js` + `style.css`) served at `/` to
browsers. It's the operator UI for entering a URL/city/state/vertical, choosing
the match surface, optionally sharing geolocation, and downloading the report.

---

## 12. Current git state (uncommitted work)

At the time of writing, these are modified/untracked (work in progress):
- Modified: `db.ts`, `public/app.js`, `public/index.html`, `report/liteHtml.ts`, `routes/liteReport.ts`, `routes/utility.ts`, `server.ts`, `services/mappack.ts`, `swagger.yaml`
- New (untracked): `lib/trace.ts`, `report/armaHtml.ts`, `routes/armaReport.ts`

The **ARMA report** feature (`/arma-report`) and the **`/debug/trace`** tool are
the newest additions and are not yet committed.

---

## 13. How to run

```bash
cp .env.example .env      # fill in the 4 API credential sets
npm install
npm run dev               # ts-node server.ts → http://localhost:3002
```

Then either open `http://localhost:3002` (dashboard) or:
```bash
curl -X POST http://localhost:3002/lite-report \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example-plumbing.com","city":"Toledo","state":"OH","vertical":"plumbing","format":"json"}'
```

---

## 14. Guidance for a GPT driving future changes

- **Never let the report emit unmeasured numbers.** The entire product credibility
  rests on every figure tracing to an API response, a crawl boolean, or the
  benchmark table. Preserve the "no invented metrics" guardrails in §9.
- **The map-pack module (`services/mappack.ts`) is the highest-risk area.** It has
  been re-tuned ~14 times (see `db.ts` migrations). Changing the ranking source,
  query format, location anchoring, or cache key requires flushing `mappack_cache`
  via a new migration.
- **Lite → Full is sequential by design.** `/full-report` depends on the `leads`
  row written by `/lite-report`; don't decouple them without rethinking competitor locking.
- **Keep deterministic fallbacks working** for every AI call — the product must
  still produce a valid report during an Anthropic/API outage.
- **There is existing documentation** in `docs/` (`ARCHITECTURE.md`,
  `api-reference.md`, `full-checker.md`, `lite-checker.md`, `system-overview.md`)
  and `README.md`. This file is the consolidated superset.
