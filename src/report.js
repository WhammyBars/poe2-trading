import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categories.js";
import { getItemsForCategory, getTrailingHistory, closeDb } from "./db.js";
import { computeSignal } from "./signal.js";
import { computeSeasonality, bestDipDay, bestDipHour } from "./seasonality.js";
import { fetchIndexState, pickCurrentLeague } from "./api.js";
import { buildDashboard, buildGateShell } from "./dashboardHtml.js";
import { loadPurchases, aggregateHoldings } from "./purchases.js";
import { encryptString, PBKDF2_ITERATIONS } from "./crypto.js";
import { isMain } from "./util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAILING_HOURS = Number(process.env.POE2_TRAILING_HOURS ?? 72);

// Liquidity floor for the curated "top opportunities" cards — keeps thin
// markets (a swing driven by one or two odd listings) out of the highlights.
// The full table below is unfiltered.
const MIN_LIQUID_VOLUME = 20;
const TOP_N = 6;

// Per-unit value floor (all categories price in divine already, no conversion
// needed): anything cheaper only makes sense to trade in bulk, which isn't
// worth tracking here. Applies to the main table, top-opportunities cards, and
// the signal-count tiles — NOT to "Your holdings", which always shows real P/L
// for whatever you actually bought regardless of price.
const MIN_VALUE_DIVINE = Number(process.env.POE2_MIN_VALUE_DIVINE ?? 1);

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
        itemKey: item.itemKey,
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

// Per-category (not pooled-across-everything) calendar pattern, so "buy this
// on Wednesdays" is actually about the category the item lives in rather than
// a blend of all twelve. Cheap to compute — same query the global chart uses,
// just scoped to one category's item keys at a time.
function buildCategoryTiming() {
  const timing = new Map();
  for (const cat of CATEGORIES) {
    const s = computeSeasonality([cat.key]);
    timing.set(cat.label, {
      day: bestDipDay(s.dayOfWeek, s.dayStatus),
      hour: bestDipHour(s.hourOfDay, s.hourStatus),
    });
  }
  return timing;
}

function timingHintText(hint) {
  if (!hint || (!hint.day && !hint.hour)) return null;
  const parts = [];
  if (hint.day) parts.push(`${hint.day.label}s (avg ${hint.day.avgPct.toFixed(1)}%, n=${hint.day.n}${hint.day.preliminary ? ", preliminary" : ""})`);
  if (hint.hour) parts.push(`around ${hint.hour.label} (avg ${hint.hour.avgPct.toFixed(1)}%, n=${hint.hour.n}${hint.hour.preliminary ? ", preliminary" : ""})`);
  return `This category has historically dipped ${parts.join(" and ")}.`;
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

// poe.ninja's exchange item id for Mirror of Kalandra — the traditional PoE
// "how rich are you really" yardstick.
const MIRROR_ITEM_KEY = "Currency:mirror";

function computeNetWorth(holdings, allRows) {
  const totalDivine = holdings.reduce((sum, h) => sum + (h.currentValue != null ? h.currentValue * h.qty : 0), 0);
  const mirrorRow = allRows.find((r) => r.itemKey === MIRROR_ITEM_KEY);
  const mirrorPrice = mirrorRow?.value ?? null;
  return {
    totalDivine,
    mirrorPrice,
    pctOfMirror: mirrorPrice ? (totalDivine / mirrorPrice) * 100 : null,
    divineToMirror: mirrorPrice != null ? Math.max(0, mirrorPrice - totalDivine) : null,
  };
}

// Joins logged purchases (cost basis) against this run's fresh market rows,
// so the "Your holdings" table shows real P/L next to the same signal used everywhere else.
function buildHoldings(purchaseHoldings, rows) {
  const rowsByKey = new Map(rows.map((r) => [r.itemKey, r]));
  return purchaseHoldings.map((h) => {
    const row = rowsByKey.get(h.itemKey);
    const currentValue = row?.value ?? null;
    const pctChange = currentValue != null && h.avgCost > 0 ? ((currentValue - h.avgCost) / h.avgCost) * 100 : null;
    return {
      ...h,
      currentValue,
      pctChange,
      verdict: row?.verdict ?? null,
      provisional: row?.provisional ?? false,
      sellTarget: row?.sellTarget ?? null,
      reason: row?.reason ?? null,
    };
  });
}

export async function runReport() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    throw new Error(
      "DASHBOARD_PASSWORD is not set. The dashboard is published encrypted, so this is required — " +
        "set it as a GitHub Actions secret for CI, or export it in your shell for local runs."
    );
  }

  const allRows = buildReportRows();
  // Everything below MIN_VALUE_DIVINE only trades sensibly in bulk — drop it
  // from the table/cards/tiles. Holdings still joins against allRows so a
  // cheap item you already bought keeps showing real P/L instead of "n/a".
  const rows = allRows.filter((r) => r.value >= MIN_VALUE_DIVINE);
  printConsoleReport(rows);

  const indexState = await fetchIndexState();
  const league = pickCurrentLeague(indexState);
  const seasonality = computeSeasonality(CATEGORIES.map((c) => c.key));
  const categoryTiming = buildCategoryTiming();
  const { buyCards, sellCards } = pickTopOpportunities(rows);
  for (const card of buyCards) {
    card.timingHint = timingHintText(categoryTiming.get(card.category));
  }

  const purchases = await loadPurchases(password);
  const holdings = buildHoldings(aggregateHoldings(purchases), allRows);
  const netWorth = computeNetWorth(holdings, allRows);

  const innerHtml = buildDashboard({
    league: league?.displayName ?? "unknown",
    generatedAt: new Date().toISOString(),
    trailingHours: TRAILING_HOURS,
    rows,
    seasonality,
    buyCards,
    sellCards,
    holdings,
    netWorth,
    minValueDivine: MIN_VALUE_DIVINE,
  });

  const encrypted = await encryptString(innerHtml, password);
  const gateHtml = buildGateShell({ ...encrypted, pbkdf2Iterations: PBKDF2_ITERATIONS });

  // docs/ so GitHub Pages can serve this directly from the main branch.
  const outDir = path.join(__dirname, "..", "docs");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "index.html");
  fs.writeFileSync(outPath, gateHtml, "utf8");
  console.log(`Encrypted dashboard written to ${outPath} (${holdings.length} holding(s) from ${purchases.length} logged purchase(s))`);
}

if (isMain(import.meta.url)) {
  try {
    await runReport();
  } finally {
    closeDb();
  }
}
