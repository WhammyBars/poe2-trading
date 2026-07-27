# PoE2 Arbitrage Advisory Tool

Informational price-trend tracker for Path of Exile 2, sourced from poe.ninja's
public (undocumented, reverse-engineered) API. Tells you BUY / HOLD / SELL per
item based on price trend vs. a local trailing history — nothing more.

**This tool does not automate trades, whispers, or any other in-game action.**
It only reads public HTTP endpoints and writes local files.

## What it tracks

All via GGG's Currency Exchange, checked for real trading volume before adding
(2026-07-19) — see `src/categories.js` for the exact list:

- Currency (includes Hinekora's Lock and other "locks" — no separate category needed)
- Lineage Support Gems
- Omens (poe.ninja's `type=Ritual` — heaviest volume of any category tracked)
- Runes
- Fragments
- Expedition
- Uncut Gems
- Catalysts (poe.ninja's `type=Breach`)
- Liquid Emotions (poe.ninja's `type=Delirium`)
- Soul Cores
- Idols
- Verisium

**Essences were checked and excluded**: all 80 essence items summed to only
~386 divine of total exchange volume, vs. tens of thousands for a single
top item in most categories above — genuinely thin on the exchange this
league, not a trustworthy signal. Worth re-checking if that changes.

Precursor Tablets and Unique Tablets are deliberately **not** tracked: poe.ninja's
stash overview endpoint collapses each tablet name+rarity into a single aggregate
price without exposing the actual mod roll (a "Ritual Tablet (Rare)" could be a
great or terrible roll, bucketed identically) — the signal isn't trustworthy
without that detail. The stash overview endpoint (documented below) still works
fine if that ever changes upstream.

Plain Waystones (map tiers) are **not** tracked — poe.ninja does not currently
expose them as a category on either endpoint (confirmed 404 on `type=Waystones`
as of 2026-07-19; worth re-checking occasionally in case that changes).

## Usage

```
npm run fetch    # one-off pull of current prices into data/prices.sqlite
npm run report   # print console table + write docs/index.html
npm run watch    # fetch + report every hour (default), Ctrl+C to stop
```

Env vars:
- `POE2_POLL_INTERVAL_MINUTES` (default `60`) — polling cadence for `watch`.
- `POE2_TRAILING_HOURS` (default `72`) — trailing window used for the z-score baseline.
- `DASHBOARD_PASSWORD` (required) — see "Password gate" below. `npm run report` refuses to run without it.

## Running in the cloud (GitHub Actions + Pages)

`.github/workflows/hourly.yml` runs `fetch` + `report` on an hourly schedule
(plus `workflow_dispatch` for manual runs) and commits the updated
`data/prices.sqlite` and `docs/index.html` back to `main` — each run picks up
where the last one left off, so history keeps accumulating without anyone's
PC needing to stay on. GitHub Pages serves `docs/index.html` directly from
`main`, giving a permanent dashboard URL.

Don't run `npm run watch` locally at the same time as the cloud job — both
would write to the same `data/prices.sqlite` independently and fight over
which version gets pushed. Use `npm run fetch` / `npm run report` locally
for one-off manual checks; let the workflow own the continuous polling.

## Password gate

The repo (and therefore `data/prices.sqlite`, the raw price history) is
public, since free GitHub Pages requires that. The published dashboard itself
is not readable without a password, though — `docs/index.html` is a minimal
shell containing only an AES-256-GCM ciphertext (key derived from the
password via PBKDF2-SHA256, both via the browser's native WebCrypto, no
libraries). Without the password there's nothing to reveal — no hidden div,
no plaintext sitting in the DOM — the real dashboard HTML doesn't exist
client-side until it's decrypted in-browser after a correct password. See
`src/crypto.js` and `buildGateShell` in `src/dashboardHtml.js`.

**What this is and isn't**: this stops casual access (search engines, someone
finding the repo, a link shared without the password). It does **not** stop a
determined attacker who captures the ciphertext and brute-forces it offline —
that's a function of password strength, since there's no rate-limiting on an
offline guessing attempt against a static file. Pick something long and
random, not a word. If you ever want protection that can't be brute-forced at
all, that requires real server-side auth (e.g. Cloudflare Access in front of
the page) — a bigger infra change, not done here.

**Setup**: add a `DASHBOARD_PASSWORD` repository secret (Settings → Secrets
and variables → Actions → New repository secret). The password never appears
in the repo, in a commit, or in this codebase — only inside the GitHub
Actions runner as a secret, and transiently in the visitor's browser memory
while decrypting.

## Purchase log & personalized holdings

Tell Claude what you bought (item, quantity, price paid) and it resolves the
item against `data/prices.sqlite`, then triggers the `Log a purchase` GitHub
Actions workflow (`.github/workflows/log-purchase.yml`, `workflow_dispatch`)
with those details as inputs. That workflow — running inside GitHub's
infrastructure, with access to the `DASHBOARD_PASSWORD` secret — decrypts the
existing `docs/purchases.enc.json` (if any), appends the new entry, re-encrypts,
and commits. The password never has to leave GitHub or appear in this
conversation.

The hourly build (`src/report.js`) decrypts `docs/purchases.enc.json`,
computes a weighted-average cost basis per item (`src/purchases.js`), and
renders a "Your holdings" section showing P/L against that cost basis next to
the same BUY/HOLD/SELL signal used everywhere else on the page — still just
information, not a recommendation to act.

`data/purchases.json` is intentionally not a thing — there is no plaintext
copy of your purchase history anywhere in the repo, only the encrypted
`docs/purchases.enc.json`.

## How the signal works

See `src/signal.js`. Once at least 3 local hourly samples exist for an item,
the verdict is a z-score of the current price against its own trailing mean/
stddev, confirmed by the direction poe.ninja's built-in 7-point sparkline is
currently moving:

- price notably **below** trend + momentum turning back up → **BUY**
- price notably **above** trend + momentum rolling over → **SELL**
- otherwise → **HOLD**

Before 3 samples exist, it falls back to poe.ninja's own sparkline
`totalChange` as a provisional read (clearly labeled `*` / "provisional").

### Trend regime (counter-trend caution)

The z-score above only ever looks at the trailing window (`POE2_TRAILING_HOURS`,
default 72h) — it can't tell a dip inside a multi-week **uptrend** (where
mean-reversion has actually been working) from the next leg down in a
multi-week **downtrend** (where the "dip" may just continue). `computeTrend`
in `src/signal.js` separately classifies each item's own daily-close history
(backfilled to league start — see `backfillDailyHistory.js`) as UPTREND /
DOWNTREND / RANGE, by comparing a 7-day average against a 21-day average
(`REGIME_SHORT_MA_DAYS` / `REGIME_LONG_MA_DAYS`; a 3% gap, `REGIME_THRESHOLD`,
is required before it's called a trend rather than noise). Below 21 days of
daily history for an item there's no regime read yet ("INSUFFICIENT").

A BUY that fires while the item is in a DOWNTREND (or a SELL during an
UPTREND) is flagged `confidence: "counterTrend"` — **never hidden**, but:
- shown with an amber `⚠` pill instead of the usual green/red one, hover for the exact numbers,
- ranked below trend-confirmed picks in "Top opportunities" (`confidenceRank` in `report.js`), and
- gets the item's %-off-all-time-high and regime spelled out directly in the "Why" text.

Every BUY/SELL row's reason also states, unconditionally, how far the current
price sits from that item's own all-time high — the thing you'd otherwise
have to query `data/prices.sqlite` by hand to find out.

### League-phase framing (game-sense, not a statistical signal)

`computeLeaguePhase` in `report.js` estimates how far into the league you are
(EARLY / MID / LATE / OVERDUE), using the earliest backfilled daily close as
a real proxy for league start, but an **assumed** total league length
(`POE2_LEAGUE_LENGTH_DAYS`, default 91 days — poe.ninja's API exposes no real
end date, so override this if the actual one is known). This is deliberately
kept as informational framing layered on top of the statistical core, the
same way category/item timing hints are — it never creates or changes a
BUY/SELL verdict by itself. The one place it does anything: when the phase
reads LATE, any counter-trend BUY (see above) gets one extra sentence noting
that challenge leagues typically see sustained sell-off pressure on
league-specific currency as farming winds down in the final stretch, which
historically makes counter-trend dip-buys riskier late in a league than the
same setup earlier on.

## The reverse-engineered API (undocumented, no official docs exist)

Discovered by downloading poe.ninja's Astro JS bundles (`/_astro/*.mjs`) and
grepping for route-builder calls. Confirmed working as of the "Runes of Aldur"
league (2026-07-19).

### League list
```
GET https://poe.ninja/poe2/api/data/index-state
```
Returns `economyLeagues` / `oldEconomyLeagues` as `{name, url, displayName, hardcore, indexed}`.
Always fetch this first — never hardcode a league name, they rotate every few months.

### Currency Exchange overview (fungible/stackable items)
```
GET https://poe.ninja/poe2/api/economy/exchange/current/overview?league={DISPLAY_NAME}&type={TYPE}
```
- `league` must be the **display name**, URL-encoded, exact case (e.g. `Runes of Aldur`).
  The URL slug (`runesofaldur`) silently returns an empty-but-200 response — no error.
- `{version}` in the path is the **literal string `current`**, not a numeric snapshot
  version (despite `index-state` exposing versioned `snapshotVersions` — those aren't
  needed for this endpoint).
- Confirmed `type` values: `Currency`, `Runes`, `Fragments`, `Expedition`, `UncutGems`,
  `Ritual`, `Breach`, `Delirium`, `Essences`, `Idols`, `SoulCores`, `LineageSupportGems`,
  `Verisium`.
- Response shape:
  ```
  { core: { items: [{id, name, image, category, detailsId}], rates: {...}, primary: "divine", secondary: "chaos" },
    items: [...same as core.items...],
    lines: [{ id, primaryValue, volumePrimaryValue, maxVolumeCurrency, maxVolumeRate,
               sparkline: { totalChange, data: [7 recent % points] } }] }
  ```
  `lines[i].id` joins to `items[i].id` (same order, same length) for name/icon lookup.

### Stash item overview (individually-rolled items: tablets, uniques)
```
GET https://poe.ninja/poe2/api/economy/stash/current/item/overview?league={DISPLAY_NAME}&type={TYPE}
```
Discovered via the `Poe2ItemOverviewPage` component (`a.BtjYvD0b.mjs`), which calls a
typed route builder: `GET /poe2/api/economy/stash/{version}/item/overview` with
`params.version` hardcoded to `"current"` and `query = {league, type}`.

- Same `league` display-name requirement as above.
- Confirmed `type` values: `PrecursorTablets`, `UniqueTablets`, `UniqueWeapons`,
  `UniqueArmours`, `UniqueAccessories`, `UniqueFlasks`, `UniqueCharms`, `UniqueJewels`,
  `UniqueSanctumRelics`.
- Unlike the exchange endpoint, an unsupported `type` returns a proper `404` (not a
  silent empty 200) — e.g. `type=Waystones` 404s, confirming that category doesn't exist yet.
- Response shape mirrors the exchange endpoint almost exactly, but:
  - the sparkline field is `sparkLine` (capital L) inside raw `lines[]`, not `sparkline`
  - `lines[]` already embeds `name`/`baseType`/`variant` directly (no join needed against
    the top-level `items` array, which is present but redundant for this endpoint)
  - `primaryValue` is a single representative value per distinct item name/variant, not a
    percentile/median spread — poe.ninja is doing the aggregation server-side already.
  - `listingCount` is the number of stash listings sampled for that value.

### `/poe2/api/economy/exchange/{version}/search` — dead end, do not use for pricing
This endpoint (referenced in bundle `a2.mjs` in the original investigation) returns a
**static name+icon catalog** for every category regardless of the `type` query param
you pass — it powers the exchange page's search-autocomplete UI, not pricing. It has no
price fields at all. The actual pricing endpoint for individually-rolled items is the
stash overview endpoint above, found by tracing the `Poe2ItemOverviewPage` React
component's data-fetching hook instead of grepping for path strings.

### How these were found
The page `https://poe.ninja/poe2/economy/{leagueUrl}/{categorySlug}` renders an Astro
"island" (`client="only"`, i.e. no server-rendered data — everything fetches client-side).
Its `component-url` attribute points at the bundle containing the actual page component;
tracing its imports back through the chunk graph to the shared route-builder module
(`a.CPvY68j_.mjs`, defining `R.poe2.economy.*` **page** routes — cosmetic, not API) and
separately to the data-fetching hook module (which calls a typed `GET` route builder
like `C("GET","/poe2/api/economy/stash/{version}/item/overview")`) revealed the real API
path and its exact query/param contract. Grepping bundles for literal `/api/` substrings
does **not** find this — the fetch happens through an abstracted route-builder, not an
inline template string.
