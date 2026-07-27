import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categories.js";
import { getItemsForCategory, getTrailingHistory, getDailyHistoryForItem, getAllDailyHistoryForCategory, closeDb } from "./db.js";
import { computeSignal } from "./signal.js";
import {
  computeSeasonality,
  computeItemSeasonality,
  bestDipDay,
  bestDipHour,
  bestPumpDay,
  bestPumpHour,
  backtestRoundTrip,
} from "./seasonality.js";
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
// a blend of all twelve — pooling everything washes out into a single
// economy-wide drift (every category's prices trending up together over the
// league dominates the average), hiding the cyclical day/hour effect within
// any one category. Cheap to compute — same query the global chart uses,
// just scoped to one category's item keys at a time.
function buildCategoryTiming() {
  const timing = new Map();
  for (const cat of CATEGORIES) {
    const s = computeSeasonality([cat.key]);
    let dipDay = bestDipDay(s.dayOfWeek, s.dayStatus);
    let pumpDay = bestPumpDay(s.dayOfWeek, s.dayStatus);
    // dipDay and pumpDay are each independently "reliable" (95%-confidence
    // directional lean), but that doesn't mean buying on dipDay and selling
    // on the next pumpDay actually made money historically — validate the
    // specific round trip before presenting it as a pair (see
    // backtestRoundTrip in seasonality.js). If it doesn't hold up, drop
    // both rather than show a pairing that back-tests as a loss.
    let roundTrip = null;
    if (dipDay && pumpDay) {
      roundTrip = backtestRoundTrip(getAllDailyHistoryForCategory(cat.key), dipDay.raw.day, pumpDay.raw.day);
      if (!roundTrip) {
        dipDay = null;
        pumpDay = null;
      }
    }
    timing.set(cat.label, {
      dipDay,
      dipHour: bestDipHour(s.hourOfDay, s.hourStatus),
      pumpDay,
      pumpHour: bestPumpHour(s.hourOfDay, s.hourStatus),
      roundTrip,
    });
  }
  return timing;
}

// bestDipDay/bestDipHour/bestPumpDay/bestPumpHour already gate on a
// 95%-confidence rate above 50% (see seasonality.js), so anything reaching
// here is more than just an average dragged around by a few outliers — but
// "reliable" still only means "better than a coin flip at 95% confidence",
// not "certain".
function describeBucket(b) {
  return `${b.label} (${(b.rate * 100).toFixed(0)}% of ${b.n} ticks, 95% floor ${(b.rateLowerBound * 100).toFixed(0)}%${b.preliminary ? ", preliminary" : ""})`;
}

function dayHourParts(day, hour) {
  const parts = [];
  if (day) parts.push(describeBucket(day));
  if (hour) parts.push(`around ${describeBucket(hour)}`);
  return parts;
}

function timingHintText(hint) {
  if (!hint) return null;
  const buyParts = dayHourParts(hint.dipDay, hint.dipHour);
  const sellParts = dayHourParts(hint.pumpDay, hint.pumpHour);
  if (!buyParts.length && !sellParts.length) return null;
  const segments = [];
  if (buyParts.length) segments.push(`tends to dip (buy well) on ${buyParts.join(" and ")}`);
  if (sellParts.length) segments.push(`tends to pump (sell well) on ${sellParts.join(" and ")}`);
  return `This category statistically ${segments.join("; ")}.`;
}

// One row per tracked category regardless of current BUY/SELL signal state —
// unlike the Buy-card timing hint (only attached to cards that already have
// a live BUY verdict), this answers "what's the calendar pattern for this
// whole category" even when nothing in it happens to be flagged right now.
function buildCategoryPlaybook(categoryTiming) {
  return CATEGORIES.map((cat) => ({ category: cat.label, ...categoryTiming.get(cat.label) }));
}

// Per-item calendar timing, mutating rows in place — cheap (local SQLite
// reads only, no network), so run for every displayed row. Sample sizes here
// are a single item's own history (its share of a category's daily closes,
// its own local hourly ticks), much smaller than the pooled category
// numbers above, so expect far more nulls, and treat any hit as weaker
// evidence than the category-level equivalent even though both pass the
// same 95%-confidence bar (see seasonality.js).
function attachItemTiming(rows) {
  for (const r of rows) {
    const s = computeItemSeasonality(r.itemKey);
    let buyDay = bestDipDay(s.dayOfWeek, s.dayStatus);
    let sellDay = bestPumpDay(s.dayOfWeek, s.dayStatus);
    r.buyHour = bestDipHour(s.hourOfDay, s.hourStatus);
    r.sellHour = bestPumpHour(s.hourOfDay, s.hourStatus);
    // Same round-trip validation as buildCategoryTiming, scoped to this
    // item's own history — see the comment there for why independently
    // "reliable" buy/sell days aren't enough on their own.
    r.roundTrip = null;
    if (buyDay && sellDay) {
      r.roundTrip = backtestRoundTrip(getDailyHistoryForItem(r.itemKey), buyDay.raw.day, sellDay.raw.day);
      if (!r.roundTrip) {
        buyDay = null;
        sellDay = null;
      }
    }
    r.buyDay = buyDay;
    r.sellDay = sellDay;
  }
}

// The direct "buy this specific item on day X, sell it on day Y" answer —
// only items where BOTH sides clear the reliability bar (not just one),
// since a buy-only or sell-only hit isn't a complete, actionable pair. When
// buyDay/sellDay are both present they've also passed the roundTrip
// backtest (see attachItemTiming) — a buyHour/sellHour-only pairing hasn't,
// since there's no continuous-enough hourly history yet to backtest that.
// Requires attachItemTiming(rows) to have already run.
function buildItemPlaybook(rows) {
  return rows
    .filter((r) => (r.buyDay || r.buyHour) && (r.sellDay || r.sellHour))
    .map((r) => ({
      name: r.name,
      category: r.category,
      buyDay: r.buyDay,
      buyHour: r.buyHour,
      sellDay: r.sellDay,
      sellHour: r.sellHour,
      roundTrip: r.roundTrip,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
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
  attachItemTiming(rows);

  const indexState = await fetchIndexState();
  const league = pickCurrentLeague(indexState);
  const seasonality = computeSeasonality(CATEGORIES.map((c) => c.key));
  const categoryTiming = buildCategoryTiming();
  const categoryPlaybook = buildCategoryPlaybook(categoryTiming);
  const itemPlaybook = buildItemPlaybook(rows);
  const { buyCards, sellCards } = pickTopOpportunities(rows);
  for (const card of buyCards) {
    // Prefer the item's own reliable window when it has one; the category
    // hint is still useful background even then, so keep both rather than
    // picking one.
    card.categoryTimingHint = timingHintText(categoryTiming.get(card.category));
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
    categoryPlaybook,
    itemPlaybook,
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
