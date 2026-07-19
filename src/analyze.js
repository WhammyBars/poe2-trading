// One-off deeper-dive analysis on top of the stored report data: ranks BUY/SELL
// candidates by signal strength, filtered to liquid items, with the raw 7-point
// sparkline shown so a human can sanity-check it's a real trend and not noise.
import { CATEGORIES } from "./categories.js";
import { getItemsForCategory, getTrailingHistory, closeDb } from "./db.js";
import { computeSignal } from "./signal.js";
import { fetchOverview } from "./api.js";
import { fetchIndexState, pickCurrentLeague } from "./api.js";

const TRAILING_HOURS = Number(process.env.POE2_TRAILING_HOURS ?? 72);
function sinceTimestamp(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

// Liquidity proxy: stash items have listingCount, exchange items only expose
// volumePrimaryValue on the raw (non-normalized) response, so pull that separately.
async function getVolumeMap(cat, leagueDisplayName) {
  if (cat.endpoint !== "exchange") return new Map();
  const url = `https://poe.ninja/poe2/api/economy/exchange/current/overview?league=${encodeURIComponent(leagueDisplayName)}&type=${encodeURIComponent(cat.key)}`;
  const res = await fetch(url, { headers: { "User-Agent": "poe2-arbitrage-tool/1.0" } });
  const data = await res.json();
  const map = new Map();
  for (const line of data.lines ?? []) map.set(line.id, line.volumePrimaryValue ?? 0);
  return map;
}

async function main() {
  const indexState = await fetchIndexState();
  const league = pickCurrentLeague(indexState);
  const since = sinceTimestamp(TRAILING_HOURS);

  const rows = [];
  for (const cat of CATEGORIES) {
    const volumeMap = await getVolumeMap(cat, league.displayName);
    const items = getItemsForCategory(cat.key);
    for (const item of items) {
      const history = getTrailingHistory(item.itemKey, since);
      if (history.length === 0) continue;
      const current = history[history.length - 1];
      const baseline = history.slice(0, -1);
      const signal = computeSignal({ currentValue: current.primaryValue, history: baseline, sparkline: current.sparkline });
      const itemId = item.itemKey.split(":").slice(1).join(":");
      rows.push({
        category: cat.label,
        name: item.name + (item.variant && item.variant !== "Normal" ? ` (${item.variant})` : ""),
        value: current.primaryValue,
        currency: current.primaryCurrency,
        listingCount: current.listingCount,
        volume: volumeMap.get(itemId) ?? null,
        sparkData: current.sparkline?.data ?? [],
        totalChange: current.sparkline?.totalChange ?? 0,
        ...signal,
      });
    }
  }

  // Liquidity filter: stash items need a real sample size; exchange items need real volume.
  const liquid = rows.filter((r) => (r.listingCount != null ? r.listingCount >= 30 : (r.volume ?? 0) >= 20));

  const buys = liquid.filter((r) => r.verdict === "BUY").sort((a, b) => a.totalChange - b.totalChange).slice(0, 12);
  const sells = liquid.filter((r) => r.verdict === "SELL").sort((a, b) => b.totalChange - a.totalChange).slice(0, 12);

  console.log(`League: ${league.displayName}  |  liquid universe: ${liquid.length}/${rows.length} items  |  local samples/item: ${rows[0]?.n ?? 1}\n`);

  const fmt = (r) =>
    `  ${r.category.padEnd(20)} ${r.name.padEnd(28)} ${r.value.toFixed(4)} ${r.currency}  liq=${r.listingCount ?? r.volume}  spark=[${r.sparkData.map((n) => n.toFixed(1)).join(", ")}]  total=${r.totalChange.toFixed(1)}%`;

  console.log("=== TOP BUY CANDIDATES (liquid, sharpest recent dip) ===");
  buys.forEach((r) => console.log(fmt(r)));

  console.log("\n=== TOP SELL / TAKE-PROFIT CANDIDATES (liquid, sharpest recent pump) ===");
  sells.forEach((r) => console.log(fmt(r)));

  console.log(`\n(n=${rows[0] ? "1" : "0"} local sample so far — z-score engine is not confident yet; every verdict above is still poe.ninja's own sparkline, provisional.)`);
}

main().then(() => closeDb()).catch((e) => { console.error(e); closeDb(); process.exitCode = 1; });
