import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categories.js";
import { getItemsForCategory, getTrailingHistory, closeDb } from "./db.js";
import { computeSignal } from "./signal.js";
import { computeSeasonality } from "./seasonality.js";
import { fetchIndexState, pickCurrentLeague } from "./api.js";
import { buildDashboard } from "./dashboardHtml.js";
import { isMain } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAILING_HOURS = Number(process.env.POE2_TRAILING_HOURS ?? 72);

// Liquidity floor for the curated "top opportunities" cards — keeps thin
// markets (a swing driven by one or two odd listings) out of the highlights.
// The full table below is unfiltered.
const MIN_LIQUID_VOLUME = 20;
const TOP_N = 6;

function sinceTimestamp(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function buildReportRows() {
  const since = sinceTimestamp(TRAILING_HOURS);
  const rows = [];

  for (const cat of CATEGORIES) {
    const items = getItemsForCategory(cat.key);
    for (const item of items) {
      const history = getTrailingHistory(item.itemKey, since);
      if (history.length === 0) continue;

      const current = history[history.length - 1];
      const baseline = history.slice(0, -1);
      const signal = computeSignal({
        currentValue: current.primaryValue,
        history: baseline,
        sparkline: current.sparkline,
      });

      rows.push({
        category: cat.label,
        name: item.name + (item.variant && item.variant !== "Normal" ? ` (${item.variant})` : ""),
        value: current.primaryValue,
        currency: current.primaryCurrency ?? "",
        listingCount: current.listingCount,
        volume: current.volume,
        sparkData: current.sparkline?.data ?? [],
        samples: history.length,
        ...signal,
      });
    }
  }

  // Default order for the main table: most-traded first (volume = total value
  // traded in the primary currency, poe.ninja's only liquidity signal on the
  // exchange endpoint — not a trade count). The "Top opportunities" cards below
  // sort by signal strength independently, so this doesn't bury BUY/SELL picks.
  rows.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));

  return rows;
}

function pickTopOpportunities(rows) {
  const liquid = rows.filter((r) => (r.listingCount ?? r.volume ?? 0) >= MIN_LIQUID_VOLUME);
  const buyCards = liquid
    .filter((r) => r.verdict === "BUY")
    .sort((a, b) => (a.sparkline?.totalChange ?? 0) - (b.sparkline?.totalChange ?? 0))
    .slice(0, TOP_N);
  const sellCards = liquid
    .filter((r) => r.verdict === "SELL")
    .sort((a, b) => (b.sparkline?.totalChange ?? 0) - (a.sparkline?.totalChange ?? 0))
    .slice(0, TOP_N);
  return { buyCards, sellCards };
}

function printConsoleReport(rows) {
  console.log(`\nPoE2 Arbitrage Advisory — trailing window: ${TRAILING_HOURS}h (informational only, not trade automation)\n`);

  // Group by category regardless of the input order (the dashboard's default
  // sort is volume-first and interleaves categories) so terminal output stays readable.
  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }

  for (const [category, catRows] of byCategory) {
    console.log(`\n=== ${category} ===`);
    for (const r of catRows) {
      const flag = r.verdict === "BUY" ? "BUY " : r.verdict === "SELL" ? "SELL" : "HOLD";
      const prov = r.provisional ? " (provisional)" : "";
      const zStr = r.z == null ? "  n/a" : r.z.toFixed(2).padStart(5);
      console.log(
        `[${flag}]${prov}  z=${zStr}  ${r.value.toFixed(4)} ${r.currency}  vol=${r.volume ?? "?"}  ${r.name}\n        ${r.reason}`
      );
    }
  }
  console.log("");
}

export async function runReport() {
  const rows = buildReportRows();
  printConsoleReport(rows);

  const indexState = await fetchIndexState();
  const league = pickCurrentLeague(indexState);
  const seasonality = computeSeasonality(CATEGORIES.map((c) => c.key));
  const { buyCards, sellCards } = pickTopOpportunities(rows);

  const html = buildDashboard({
    league: league?.displayName ?? "unknown",
    generatedAt: new Date().toISOString(),
    trailingHours: TRAILING_HOURS,
    rows,
    seasonality,
    buyCards,
    sellCards,
  });

  // docs/ so GitHub Pages can serve this directly from the main branch.
  const outDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.html");
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`HTML dashboard written to ${outPath}`);
}

if (isMain(import.meta.url)) {
  try {
    await runReport();
  } finally {
    closeDb();
  }
}
