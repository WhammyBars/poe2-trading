// Backfills daily_price_history from poe.ninja's per-item details endpoint,
// which carries daily closes back to league start — much more calendar
// coverage than waiting for the hourly watch loop to accumulate it locally.
// Safe to re-run: upserts on (item_key, ts), and also picks up any new daily
// close since the last run, so this can run on a recurring schedule (see
// .github/workflows/backfill-daily-history.yml) rather than just once.
import { fetchIndexState, pickCurrentLeague, fetchOverview, fetchDetails } from "./api.js";
import { CATEGORIES } from "./categories.js";
import { getItemsForCategory, recordDailySample, closeDb } from "./db.js";
import { isMain } from "./util.js";

// One request per item (500+ across all categories) — a small delay keeps
// this a polite, low-burst client rather than a thundering herd against
// poe.ninja's API.
const REQUEST_DELAY_MS = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Most items' details-endpoint slug matches their overview `id` exactly, but
// two known exceptions exist, so on a 404 we retry with each transform in
// turn rather than hardcoding a per-category or per-item exception list —
// self-heals for any current or future item hitting the same quirks:
//   1. Tiered items (uncut gems, Thaumaturgic Flux, ...) insert "-level-"
//      before the trailing tier number the overview id doesn't have, e.g.
//      "uncut-spirit-gem-20" -> "uncut-spirit-gem-level-20".
//   2. A handful of currency items (mostly short legacy PoE1-style codes —
//      "alch", "gcp", "mirror", ...) have an overview id that isn't derived
//      from the display name at all, unlike ~95% of items where it is. The
//      real slug is just the display name, slugified.
function withLevelInserted(itemId) {
  const m = itemId.match(/^(.+)-(\d+)$/);
  return m ? `${m[1]}-level-${m[2]}` : null;
}

function slugifyName(name) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (e.g. e-with-accent -> e)
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchDetailsWithFallback({ type, itemId, itemName, leagueDisplayName }) {
  const candidates = [itemId, withLevelInserted(itemId), slugifyName(itemName)].filter(
    (id, i, arr) => id && arr.indexOf(id) === i // dedupe, drop nulls
  );
  let lastErr;
  for (const candidateId of candidates) {
    try {
      return await fetchDetails({ type, itemId: candidateId, leagueDisplayName });
    } catch (err) {
      lastErr = err;
      if (!/HTTP 404/.test(err.message)) throw err; // only retry on 404, not on real failures
    }
  }
  throw lastErr;
}

export async function runBackfill() {
  const indexState = await fetchIndexState();
  const league = pickCurrentLeague(indexState);
  if (!league) throw new Error("Could not determine current league from index-state.");

  console.log(`Backfilling daily history for league: ${league.displayName}`);

  for (const cat of CATEGORIES) {
    let overview;
    try {
      overview = await fetchOverview({ endpoint: cat.endpoint, type: cat.key, leagueDisplayName: league.displayName });
    } catch (err) {
      console.error(`  ${cat.label}: FAILED to load overview - ${err.message}`);
      continue;
    }
    const primaryCurrency = overview.primaryCurrency;
    const items = getItemsForCategory(cat.key);

    let written = 0;
    for (const item of items) {
      // The benchmark currency itself (e.g. Divine Orb within Currency) is
      // always priced at 1.0 against itself — nothing to backfill.
      if (item.itemId === primaryCurrency) continue;
      try {
        const details = await fetchDetailsWithFallback({
          type: cat.key,
          itemId: item.itemId,
          itemName: item.name,
          leagueDisplayName: league.displayName,
        });
        const pair = details.pairs.find((p) => p.id === primaryCurrency);
        if (pair) {
          for (const h of pair.history) {
            if (typeof h.rate !== "number") continue;
            recordDailySample({ itemKey: item.itemKey, ts: h.ts, primaryValue: h.rate, primaryCurrency });
          }
          written++;
        }
      } catch (err) {
        console.error(`  ${item.itemKey}: FAILED - ${err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
    console.log(`  ${cat.label}: backfilled ${written}/${items.length} items`);
  }
}

if (isMain(import.meta.url)) {
  runBackfill()
    .then(() => closeDb())
    .catch((err) => {
      console.error("Backfill run failed:", err);
      closeDb();
      process.exitCode = 1;
    });
}
