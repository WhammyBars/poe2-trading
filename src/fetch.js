import { fetchIndexState, pickCurrentLeague, fetchOverview } from "./api.js";
import { CATEGORIES } from "./categories.js";
import { recordSample, closeDb } from "./db.js";
import { isMain } from "./util.js";

// Truncated to the hour: poe.ninja's exchange data is aggregated hourly, so
// re-running within the same hour overwrites the same row instead of adding noise.
function hourTimestamp(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export async function runFetch() {
  const indexState = await fetchIndexState();
  const league = pickCurrentLeague(indexState);
  if (!league) throw new Error("Could not determine current league from index-state.");

  const ts = hourTimestamp();
  console.log(`[${ts}] League: ${league.displayName} (${league.url})`);

  for (const cat of CATEGORIES) {
    try {
      const overview = await fetchOverview({
        endpoint: cat.endpoint,
        type: cat.key,
        leagueDisplayName: league.displayName,
      });
      for (const line of overview.lines) {
        if (typeof line.primaryValue !== "number") continue;
        recordSample({ category: cat.key, line, primaryCurrency: overview.primaryCurrency, ts });
      }
      console.log(`  ${cat.label}: ${overview.lines.length} items (priced in ${overview.primaryCurrency ?? "?"})`);
    } catch (err) {
      console.error(`  ${cat.label}: FAILED - ${err.message}`);
    }
  }
}

if (isMain(import.meta.url)) {
  runFetch()
    .then(() => closeDb())
    .catch((err) => {
      console.error("Fetch run failed:", err);
      closeDb();
      process.exitCode = 1;
    });
}
