// Builds the self-contained HTML dashboard written to docs/index.html.
// Palette/marks follow the project's dataviz conventions: fixed status colors
// for BUY/SELL (never color-alone — always paired with a label + arrow glyph),
// a blue/red diverging pair for the seasonality bars, 2px sparkline strokes,
// tabular-nums in table columns only. No external assets, no build step.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtNum(n, digits = 4) {
  return n == null ? "" : n.toFixed(digits);
}

function fmtWhole(n) {
  return Math.round(n).toLocaleString();
}

// Real listings only work in whole divine orbs, not the raw fractional
// z-score math — so floor buy targets (never suggest paying more than the
// signal implies) and ceil sell targets (never suggest asking for less),
// floored at 1 divine either way.
function tradeableTarget(value, currency, mode) {
  if (value == null) return null;
  if (currency !== "divine") return value;
  const rounded = mode === "buy" ? Math.floor(value) : Math.ceil(value);
  return Math.max(1, rounded);
}

function fmtSingaporeTime(isoString) {
  const formatted = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(isoString));
  return `${formatted} SGT`;
}

// Below this, a single-unit price is a market rate, not a real in-game trade —
// divine orbs are the coarsest common tender, so anything sub-3-divine only
// trades sensibly in bulk. Pair the unit price with what a LOT_SIZE-unit lot
// goes for, so there's a whole number to actually act on.
const BULK_LOT_THRESHOLD_DIVINE = 3;
const LOT_SIZE = 10;

function valueDisplay(value, currency) {
  if (value == null) return "";
  const cur = escapeHtml(currency ?? "");
  const unit = `${fmtNum(value)} ${cur}`;
  const alreadyWhole = Math.abs(value - Math.round(value)) < 0.02;
  if (value >= BULK_LOT_THRESHOLD_DIVINE || !currency || alreadyWhole) return unit;
  const lot = fmtWhole(value * LOT_SIZE);
  return `${unit} <span class="lot-hint" title="Only trades sensibly in bulk &mdash; a ${LOT_SIZE}-unit lot runs about ${lot} ${cur}.">&middot; ~${lot}/${LOT_SIZE}</span>`;
}

function sparklinePath(data, w = 100, h = 28, pad = 3) {
  if (!data || data.length < 2) return { path: "", lastX: 0, lastY: h / 2 };
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (data.length - 1);
  const points = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points[points.length - 1];
  return { path, lastX, lastY };
}

function sparklineSvg(data, verdict) {
  const color = verdict === "BUY" ? "var(--status-good)" : verdict === "SELL" ? "var(--status-critical)" : "var(--text-muted)";
  const { path, lastX, lastY } = sparklinePath(data);
  if (!path) return `<svg width="100" height="28" class="spark"></svg>`;
  return `<svg width="100" height="28" class="spark" viewBox="0 0 100 28">
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${color}" stroke="var(--surface-1)" stroke-width="2"/>
  </svg>`;
}

function verdictPill(verdict, provisional) {
  const arrow = verdict === "BUY" ? "&#9650;" : verdict === "SELL" ? "&#9660;" : "&#8211;";
  const cls = verdict === "BUY" ? "pill-good" : verdict === "SELL" ? "pill-critical" : "pill-neutral";
  return `<span class="pill ${cls}">${arrow} ${verdict}${provisional ? " *" : ""}</span>`;
}

function targetLine(r) {
  const buy = tradeableTarget(r.buyTarget, r.currency, "buy");
  const sell = tradeableTarget(r.sellTarget, r.currency, "sell");
  if (buy == null && sell == null) return "";
  const cur = escapeHtml(r.currency ?? "");
  const parts = [];
  if (buy != null) parts.push(`buy &le; ${buy} ${cur}`);
  if (sell != null) parts.push(`sell &ge; ${sell} ${cur}`);
  return `<div class="opp-target">${parts.join(" &middot; ")}</div>`;
}

function opportunityCard(r) {
  return `<div class="opp-card">
    <div class="opp-head">
      <span class="opp-name">${escapeHtml(r.name)}</span>
      ${verdictPill(r.verdict, r.provisional)}
    </div>
    <div class="opp-sub">${escapeHtml(r.category)} &middot; ${valueDisplay(r.value, r.currency)}</div>
    ${sparklineSvg(r.sparkData, r.verdict)}
    ${targetLine(r)}
    <div class="opp-reason">${escapeHtml(r.reason)}</div>
    ${r.timingHint ? `<div class="opp-timing">${escapeHtml(r.timingHint)}</div>` : ""}
  </div>`;
}

function statTile(label, value, sub) {
  return `<div class="stat-tile">
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
  </div>`;
}

// A bucket is only "reliable" (solid green ring in the chart) if its 95%
// Wilson lower bound on the down-tick rate clears 50% — see seasonality.js.
// Everything else is still shown (informational), just not badged as trustworthy.
function barChart(buckets, labelFn, status) {
  const maxAbs = Math.max(1e-9, ...buckets.map((b) => Math.abs(b.avgPct)));
  const rows = buckets
    .map((b) => {
      const widthPct = (Math.abs(b.avgPct) / maxAbs) * 100;
      const isNeg = b.avgPct < 0;
      const color = isNeg ? "var(--diverging-neg)" : "var(--diverging-pos)";
      const reliable = b.winRateLowerBound != null && b.winRateLowerBound > 0.5;
      const winRatePct = b.winRate != null ? `${(b.winRate * 100).toFixed(0)}%` : "n/a";
      const title = `${b.avgPct.toFixed(2)}% avg, n=${b.n}, down-tick rate ${winRatePct} (95% floor ${b.winRateLowerBound != null ? (b.winRateLowerBound * 100).toFixed(0) + "%" : "n/a"})`;
      return `<div class="bar-row${reliable ? " bar-reliable" : ""}">
        <div class="bar-label">${escapeHtml(labelFn(b))}${reliable ? ' <span class="reliable-dot" title="Statistically reliable: 95% confidence the down-tick rate is above 50%">&#9679;</span>' : ""}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${widthPct.toFixed(1)}%; background:${color};" title="${title}"></div>
        </div>
        <div class="bar-value">${b.n > 0 ? `${b.avgPct >= 0 ? "+" : ""}${b.avgPct.toFixed(1)}%` : "&mdash;"}</div>
      </div>`;
    })
    .join("\n");
  return `<div class="bar-chart" data-status="${status}">${rows}</div>`;
}

function emptyState(title, body) {
  return `<div class="empty-state">
    <div class="empty-title">${escapeHtml(title)}</div>
    <div class="empty-body">${escapeHtml(body)}</div>
  </div>`;
}

function playbookCell(bucket) {
  if (!bucket) return `<span class="pill pill-neutral">no reliable pattern yet</span>`;
  const pct = (bucket.rate * 100).toFixed(0);
  return `${escapeHtml(bucket.label)} <span class="rate-note" title="95% Wilson-score floor ${(bucket.rateLowerBound * 100).toFixed(0)}%, n=${bucket.n}${bucket.preliminary ? ", preliminary" : ""}">(${pct}%, n=${bucket.n})</span>`;
}

// One row per tracked category, independent of any live BUY/SELL signal —
// this is the direct "what do I buy and on which day, what do I sell and on
// which day" answer, since the pooled/global calendar chart above gets
// swamped by economy-wide drift (see its section-note) and can't show that
// per category.
function categoryPlaybookSection(categoryPlaybook) {
  if (!categoryPlaybook || categoryPlaybook.length === 0) return "";
  const rowsHtml = categoryPlaybook
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.category)}</td>
        <td>${playbookCell(r.dipDay)}</td>
        <td>${playbookCell(r.dipHour)}</td>
        <td>${playbookCell(r.pumpDay)}</td>
        <td>${playbookCell(r.pumpHour)}</td>
      </tr>`
    )
    .join("\n");

  return `<section class="section">
    <h2>Category buy/sell calendar</h2>
    <p class="section-note">Per-category (not pooled) reliable timing windows: a day/hour only appears here if, at 95% confidence, its down-tick rate (buy day/hour) or up-tick rate (sell day/hour) is above 50% &mdash; see the "Calendar patterns" section below for what that means. Applies to the category as a whole, not any single item within it (too few per-item samples yet). "No reliable pattern yet" is an honest result, not a bug &mdash; not every category has a real cyclical edge on top of its overall trend.</p>
    <table>
      <thead><tr><th>Category</th><th>Buy day</th><th>Buy hour (SGT)</th><th>Sell day</th><th>Sell hour (SGT)</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </section>`;
}

function seasonalitySection(seasonality) {
  const { hourOfDay, dayOfWeek, hourDaysSpanned, dayDaysSpanned, hourStatus, dayStatus, thresholds } = seasonality;

  const hourBlock =
    hourStatus === "insufficient"
      ? emptyState(
          "Not enough history yet for an hour-of-day pattern",
          `Covering ${hourDaysSpanned} day(s) of our own hourly collection so far; need at least ${thresholds.HOUR_PRELIMINARY_DAYS} for a first (preliminary) read, ${thresholds.HOUR_SOLID_DAYS}+ for a solid one. This fills in automatically as the watch loop keeps running (poe.ninja's own history endpoint is daily-only, so it can't help with hour-of-day).`
        )
      : `${hourStatus === "preliminary" ? `<div class="status-note">Preliminary — only ${hourDaysSpanned} day(s) of coverage, treat as a first look, not a confirmed pattern.</div>` : ""}
         ${barChart(hourOfDay, (b) => `${String(b.hour).padStart(2, "0")}:00`, hourStatus)}`;

  const dayBlock =
    dayStatus === "insufficient"
      ? emptyState(
          "Not enough history yet for a day-of-week pattern",
          `Covering ${dayDaysSpanned} day(s) so far; need at least ${thresholds.DAY_PRELIMINARY_DAYS} for a first (preliminary) read, ${thresholds.DAY_SOLID_DAYS}+ for a solid one. Run the daily-history backfill (see backfillDailyHistory.js) to pull this in from poe.ninja's own per-item history instead of waiting on it.`
        )
      : `${dayStatus === "preliminary" ? `<div class="status-note">Preliminary — only ${dayDaysSpanned} day(s) of coverage, treat as a first look, not a confirmed pattern.</div>` : ""}
         ${barChart(dayOfWeek, (b) => b.day, dayStatus)}`;

  return `<section class="section">
    <h2>Calendar patterns</h2>
    <p class="section-note">Average % price change bucketed by Singapore-time (SGT, UTC+8) hour-of-day and day-of-week, <b>pooled across every tracked category</b> &mdash; for the same numbers broken out per category (what actually answers "buy on which day, sell on which day"), see "Category buy/sell calendar" above; this chart is background context, not a buy/sell instruction on its own. Hour-of-day is hour-over-hour change from our own local collection; day-of-week is day-over-day change from poe.ninja's own daily-close history per item (goes back to league start, so this fills in fast). Blue = prices tend to fall in that bucket (dip window); red = prices tend to rise (pump window) &mdash; pooling everything together usually skews red/positive even when individual categories have real dip windows, because it's dominated by the whole economy's overall drift over the league. A <span class="reliable-dot">&#9679;</span> next to a label means that bucket clears a 95%-confidence bar for its down-tick rate being above 50% (hover the bar for the exact numbers).</p>
    <div class="two-col">
      <div>
        <h3>By hour of day (Singapore time)</h3>
        ${hourBlock}
      </div>
      <div>
        <h3>By day of week</h3>
        ${dayBlock}
      </div>
    </div>
  </section>`;
}

function pctBadge(pct) {
  if (pct == null) return `<span class="pill pill-neutral">n/a</span>`;
  const cls = pct >= 0 ? "pill-good" : "pill-critical";
  const sign = pct >= 0 ? "+" : "";
  return `<span class="pill ${cls}">${sign}${pct.toFixed(1)}%</span>`;
}

function netWorthLine(netWorth) {
  if (!netWorth) return "";
  const worth = `<b>${fmtNum(netWorth.totalDivine, 2)} divine</b>`;
  if (netWorth.mirrorPrice == null) {
    return `<p class="section-note">Net worth: ${worth}. (Mirror of Kalandra price unavailable this run, can't compare.)</p>`;
  }
  const pct = netWorth.pctOfMirror.toFixed(netWorth.pctOfMirror < 1 ? 3 : 1);
  return `<p class="section-note">Net worth: ${worth} &mdash; that's <b>${pct}%</b> of one Mirror of Kalandra
    (currently ${fmtNum(netWorth.mirrorPrice, 0)} divine). ${fmtNum(netWorth.divineToMirror, 2)} divine to go.</p>`;
}

function holdingsSection(holdings, netWorth) {
  if (!holdings || holdings.length === 0) {
    return `<section class="section">
      <h2>Your holdings</h2>
      ${netWorthLine(netWorth)}
      <div class="empty-state">
        <div class="empty-title">No purchases logged yet</div>
        <div class="empty-body">Tell Claude what you bought (item, quantity, price paid) and it'll show up here with a personalized read against your actual cost basis.</div>
      </div>
    </section>`;
  }

  const rowsHtml = holdings
    .map(
      (h) => `<tr>
        <td>${escapeHtml(h.name)}</td>
        <td>${escapeHtml(h.category)}</td>
        <td class="num">${h.qty}</td>
        <td class="num">${valueDisplay(h.avgCost, h.currency)}</td>
        <td class="num">${h.currentValue != null ? valueDisplay(h.currentValue, h.currency) : "n/a"}</td>
        <td class="num">${pctBadge(h.pctChange)}</td>
        <td>${h.verdict ? verdictPill(h.verdict, h.provisional) : `<span class="pill pill-neutral">n/a</span>`}</td>
        <td class="num">${(() => { const t = tradeableTarget(h.sellTarget, h.currency, "sell"); return t != null ? `${t} ${escapeHtml(h.currency ?? "")}` : "n/a"; })()}</td>
        <td class="reason">${h.reason ? escapeHtml(h.reason) : "Item no longer in tracked categories."}</td>
      </tr>`
    )
    .join("\n");

  return `<section class="section">
    <h2>Your holdings</h2>
    <p class="section-note">Cost basis is the weighted average of everything logged as purchased. This is your P/L laid next to the same market signal used everywhere else on this page &mdash; still informational only, the call is yours. "Sell target" is the price at which our own signal would flip to SELL.</p>
    ${netWorthLine(netWorth)}
    <table>
      <thead><tr><th>Item</th><th>Category</th><th class="num">Qty</th><th class="num">Avg cost</th><th class="num">Current</th><th class="num">P/L</th><th>Signal</th><th class="num">Sell target</th><th>Why</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </section>`;
}

function targetCell(r) {
  const buy = tradeableTarget(r.buyTarget, r.currency, "buy");
  const sell = tradeableTarget(r.sellTarget, r.currency, "sell");
  if (buy == null && sell == null) return "n/a";
  const parts = [];
  if (buy != null) parts.push(`&le;${buy}`);
  if (sell != null) parts.push(`&ge;${sell}`);
  return parts.join(" / ");
}

function tableRows(rows) {
  return rows
    .map(
      (r, i) => `<tr data-verdict="${r.verdict}" data-idx="${i}">
        <td>${escapeHtml(r.category)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${valueDisplay(r.value, r.currency)}</td>
        <td class="num">${r.volume != null ? Math.round(r.volume).toLocaleString() : ""}</td>
        <td>${verdictPill(r.verdict, r.provisional)}</td>
        <td class="num">${r.z == null ? "n/a" : r.z.toFixed(2)}</td>
        <td class="num" title="Price level our own signal would flip BUY/SELL at (buy &le; / sell &ge;).">${targetCell(r)}</td>
        <td>${sparklineSvg(r.sparkData, r.verdict)}</td>
        <td class="reason">${escapeHtml(r.reason)}</td>
      </tr>`
    )
    .join("\n");
}

export function buildDashboard({
  league,
  generatedAt,
  trailingHours,
  rows,
  seasonality,
  categoryPlaybook,
  buyCards,
  sellCards,
  holdings,
  netWorth = { totalDivine: 0, mirrorPrice: null, pctOfMirror: null, divineToMirror: null },
  minValueDivine,
}) {
  const counts = { BUY: 0, HOLD: 0, SELL: 0 };
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const daysOfHistory = seasonality.hourDaysSpanned;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PoE2 Arbitrage Advisory</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e1e0d9;
    --border: rgba(11,11,11,0.10);
    --status-good: #0ca30c;
    --status-critical: #d03b3b;
    --diverging-pos: #e34948;
    --diverging-neg: #2a78d6;
    --pill-good-bg: rgba(12,163,12,0.12);
    --pill-critical-bg: rgba(208,59,59,0.12);
    --pill-neutral-bg: rgba(137,135,129,0.14);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --border: rgba(255,255,255,0.10);
      --status-good: #0ca30c;
      --status-critical: #e66767;
      --diverging-pos: #e66767;
      --diverging-neg: #3987e5;
      --pill-good-bg: rgba(12,163,12,0.18);
      --pill-critical-bg: rgba(230,103,103,0.18);
      --pill-neutral-bg: rgba(137,135,129,0.18);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --gridline: #2c2c2a;
    --border: rgba(255,255,255,0.10);
    --status-good: #0ca30c;
    --status-critical: #e66767;
    --diverging-pos: #e66767;
    --diverging-neg: #3987e5;
    --pill-good-bg: rgba(12,163,12,0.18);
    --pill-critical-bg: rgba(230,103,103,0.18);
    --pill-neutral-bg: rgba(137,135,129,0.18);
  }

  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--page);
    color: var(--text-primary);
    margin: 0;
    padding: 2rem 1.25rem 4rem;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.1rem; margin: 0 0 0.5rem; }
  h3 { font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 0.5rem; font-weight: 600; }
  .meta { color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1.5rem; line-height: 1.5; }
  .meta b { color: var(--text-primary); }

  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1.75rem; }
  .stat-tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 0.9rem 1rem; }
  .stat-label { font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 0.3rem; }
  .stat-value { font-size: 1.6rem; font-weight: 600; }
  .stat-sub { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.2rem; }

  .section { margin-bottom: 2.25rem; }
  .section-note { color: var(--text-secondary); font-size: 0.82rem; max-width: 80ch; margin: 0 0 1rem; }

  .opp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem; }
  .opp-col-title { font-size: 0.85rem; font-weight: 600; margin-bottom: 0.6rem; color: var(--text-secondary); }
  .opp-cards { display: flex; flex-direction: column; gap: 0.6rem; }
  .opp-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 0.7rem 0.9rem; }
  .opp-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .opp-name { font-weight: 600; font-size: 0.92rem; }
  .opp-sub { color: var(--text-secondary); font-size: 0.78rem; margin: 0.2rem 0 0.4rem; }
  .opp-target { font-size: 0.8rem; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 0.35rem; }
  .opp-reason { color: var(--text-secondary); font-size: 0.78rem; margin-top: 0.35rem; }
  .opp-timing { color: var(--text-muted); font-size: 0.74rem; font-style: italic; margin-top: 0.3rem; }

  .pill { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap; }
  .pill-good { background: var(--pill-good-bg); color: var(--status-good); }
  .pill-critical { background: var(--pill-critical-bg); color: var(--status-critical); }
  .pill-neutral { background: var(--pill-neutral-bg); color: var(--text-muted); }

  .filter-row { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
  .filter-btn { background: var(--surface-1); border: 1px solid var(--border); color: var(--text-secondary); border-radius: 999px; padding: 0.3rem 0.85rem; font-size: 0.78rem; cursor: pointer; }
  .filter-btn.active { background: var(--text-primary); color: var(--page); border-color: var(--text-primary); }

  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--gridline); text-align: left; vertical-align: middle; }
  th { color: var(--text-secondary); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; cursor: pointer; user-select: none; }
  th:hover { color: var(--text-primary); }
  tbody tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .lot-hint { color: var(--text-muted); font-size: 0.85em; font-weight: 400; cursor: help; }
  .rate-note { color: var(--text-muted); font-size: 0.85em; font-weight: 400; cursor: help; }
  .reason { color: var(--text-secondary); font-size: 0.78rem; max-width: 32ch; }
  .spark { display: block; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  .bar-chart { display: flex; flex-direction: column; gap: 0.35rem; }
  .bar-row { display: grid; grid-template-columns: 3.2rem 1fr 3.4rem; align-items: center; gap: 0.5rem; font-size: 0.76rem; }
  .bar-label { color: var(--text-secondary); text-align: right; }
  .reliable-dot { color: var(--status-good); font-size: 0.6rem; cursor: help; }
  .bar-track { background: var(--gridline); border-radius: 3px; height: 10px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; }
  .bar-value { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .status-note { font-size: 0.76rem; color: var(--text-muted); margin-bottom: 0.5rem; font-style: italic; }

  .empty-state { border: 1px dashed var(--border); border-radius: 10px; padding: 1.25rem; text-align: center; }
  .empty-title { font-weight: 600; margin-bottom: 0.3rem; font-size: 0.88rem; }
  .empty-body { color: var(--text-secondary); font-size: 0.8rem; max-width: 42ch; margin: 0 auto; }

  .disclaimer { color: var(--text-muted); font-size: 0.75rem; border-top: 1px solid var(--gridline); padding-top: 1rem; margin-top: 2rem; }

  @media (max-width: 760px) {
    .opp-grid, .two-col { grid-template-columns: 1fr; }
    .reason { max-width: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>PoE2 Arbitrage Advisory</h1>
  <div class="meta">
    League <b>${escapeHtml(league)}</b> &middot; generated <b>${escapeHtml(fmtSingaporeTime(generatedAt))}</b> &middot;
    trailing window <b>${trailingHours}h</b> &middot; local history <b>${daysOfHistory} day(s)</b><br>
    Informational only &mdash; this does not trade, whisper, or automate anything in-game. Source: poe.ninja public data.
    <code>*</code> = provisional read (not enough local samples yet for a z-score, using poe.ninja's own sparkline instead).
    <code>~X/${LOT_SIZE}</code> = a ${LOT_SIZE}-unit lot price, shown for anything under ${BULK_LOT_THRESHOLD_DIVINE} divine per unit since those only trade sensibly in bulk.
  </div>

  <div class="stat-row">
    ${statTile("Tracked items", rows.length, `≥${minValueDivine} divine only`)}
    ${statTile("Buy signals", counts.BUY ?? 0)}
    ${statTile("Hold", counts.HOLD ?? 0)}
    ${statTile("Sell signals", counts.SELL ?? 0)}
    ${statTile("History depth", `${daysOfHistory}d`, "grows automatically while watch runs")}
    ${statTile(
      "Net worth",
      `${fmtNum(netWorth.totalDivine, 2)} divine`,
      netWorth.mirrorPrice != null
        ? `${netWorth.pctOfMirror.toFixed(netWorth.pctOfMirror < 1 ? 3 : 1)}% of a Mirror`
        : "Mirror price unavailable"
    )}
  </div>

  ${holdingsSection(holdings, netWorth)}

  <section class="section">
    <h2>Top opportunities</h2>
    <p class="section-note">Filtered to reasonably liquid items worth at least ${minValueDivine} divine (excludes thin markets, and anything cheap enough that trading it only makes sense in bulk).</p>
    <div class="opp-grid">
      <div>
        <div class="opp-col-title">Buy &mdash; sharpest liquid dip</div>
        <div class="opp-cards">${buyCards.length ? buyCards.map(opportunityCard).join("\n") : `<div class="empty-state"><div class="empty-title">No liquid buy candidates right now</div></div>`}</div>
      </div>
      <div>
        <div class="opp-col-title">Sell / take profit &mdash; sharpest liquid pump</div>
        <div class="opp-cards">${sellCards.length ? sellCards.map(opportunityCard).join("\n") : `<div class="empty-state"><div class="empty-title">No liquid sell candidates right now</div></div>`}</div>
      </div>
    </div>
  </section>

  ${categoryPlaybookSection(categoryPlaybook)}

  ${seasonalitySection(seasonality)}

  <section class="section">
    <h2>All tracked items</h2>
    <p class="section-note">Limited to items worth at least ${minValueDivine} divine per unit (cheaper stuff only trades sensibly in bulk, not worth surfacing here). Sorted by volume by default &mdash; most actively traded first. Volume is total value traded in the primary currency (divine), not a trade count, so a cheap bulk currency and an expensive item can post similar numbers for very different real trade counts. Click any column header to re-sort.</p>
    <div class="filter-row" id="filters">
      <button class="filter-btn active" data-filter="ALL">All</button>
      <button class="filter-btn" data-filter="BUY">Buy</button>
      <button class="filter-btn" data-filter="HOLD">Hold</button>
      <button class="filter-btn" data-filter="SELL">Sell</button>
    </div>
    <table id="main-table">
      <thead>
        <tr>
          <th data-key="category">Category</th>
          <th data-key="name">Item</th>
          <th data-key="value" class="num">Value</th>
          <th data-key="volume" class="num">Volume (divine)</th>
          <th data-key="verdict">Signal</th>
          <th data-key="z" class="num">z</th>
          <th class="num">Target (buy/sell)</th>
          <th>Trend</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
${tableRows(rows)}
      </tbody>
    </table>
  </section>

  <div class="disclaimer">
    Signal logic: BUY/SELL requires either a z-score vs. this item's own trailing average (once 3+ local hourly samples exist)
    confirmed by sparkline momentum, or, before that, poe.ninja's own 7-point sparkline trend as a provisional read.
    Target prices (buy &le; / sell &ge;) are the trailing mean &plusmn; the same z-score threshold used for the verdict &mdash;
    i.e. the price at which this tool's own signal would flip, rounded to a whole divine orb (floored for buy, ceiled for
    sell) since that's the smallest unit you can actually list at. The "Category buy/sell calendar" table and each Buy
    card's timing note are both about that item's category, not the item itself (too few per-item samples yet); a
    day/hour only appears when its down-tick rate (buy) or up-tick rate (sell) clears a 95% Wilson-score confidence
    floor above 50% &mdash; i.e. not just an average dragged around by a few big outlier moves, but a rate that's
    statistically likely to be a real lean rather than chance. That still isn't a guarantee: the
    hour-of-day half pools many hourly ticks from the same handful of items over a short local-collection window, so
    those samples aren't fully independent, and "better than a coin flip at 95% confidence" is not "certain" either
    way. The day-of-week half is backfilled from poe.ninja's own daily-close history per item (one genuinely
    independent sample per item per day, back to league start), which is less correlated but still a short economic
    history overall. Treat any of it as a lean worth weighing, not a promise. See README.md and src/signal.js /
    src/seasonality.js / src/backfillDailyHistory.js for the exact rules. This tool reads public data only and takes
    no in-game action.
  </div>
</div>
<script>
(function() {
  var rowsData = ${JSON.stringify(rows.map((r) => ({ category: r.category, name: r.name, value: r.value, volume: r.volume ?? -1, verdict: r.verdict, z: r.z ?? null })))};
  var tbody = document.querySelector('#main-table tbody');
  var trs = Array.from(tbody.querySelectorAll('tr'));
  var sortState = { key: 'volume', dir: -1 }; // matches the server-rendered default order

  document.getElementById('filters').addEventListener('click', function(e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var f = btn.dataset.filter;
    trs.forEach(function(tr) {
      tr.style.display = (f === 'ALL' || tr.dataset.verdict === f) ? '' : 'none';
    });
  });

  document.querySelectorAll('#main-table th[data-key]').forEach(function(th) {
    th.addEventListener('click', function() {
      var key = th.dataset.key;
      sortState.dir = sortState.key === key ? -sortState.dir : 1;
      sortState.key = key;
      var idxs = trs.map(function(tr) { return parseInt(tr.dataset.idx, 10); });
      idxs.sort(function(a, b) {
        var va = rowsData[a][key], vb = rowsData[b][key];
        if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va == null) va = -Infinity;
        if (vb == null) vb = -Infinity;
        return va < vb ? -sortState.dir : va > vb ? sortState.dir : 0;
      });
      idxs.forEach(function(i) { tbody.appendChild(trs.find(function(tr) { return parseInt(tr.dataset.idx, 10) === i; })); });
    });
  });
})();
</script>
</body>
</html>
`;
}

// The actual published docs/index.html: a minimal shell containing only a
// password form and the AES-GCM ciphertext of the real dashboard (built above
// by buildDashboard). Without the password there is nothing readable here —
// no hidden div, no plaintext data sitting in the DOM waiting to be revealed.
// Decryption uses the browser's native WebCrypto (crypto.subtle), the same
// PBKDF2-SHA256 + AES-256-GCM parameters used to encrypt it in src/crypto.js.
// On success the whole document is replaced via document.write, so the
// decrypted page's own <script> (the sort/filter logic above) runs normally.
export function buildGateShell({ salt, iv, ciphertext, pbkdf2Iterations }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PoE2 Arbitrage Advisory</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0d0d0d; color: #ffffff;
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: #1a1a19; border: 1px solid rgba(255,255,255,0.10); border-radius: 12px;
    padding: 2rem; width: 100%; max-width: 340px;
  }
  h1 { font-size: 1.05rem; margin: 0 0 1.25rem; text-align: center; font-weight: 600; }
  input[type=password] {
    width: 100%; padding: 0.6rem 0.75rem; border-radius: 8px; margin-bottom: 0.75rem;
    background: #0d0d0d; border: 1px solid rgba(255,255,255,0.15); color: #ffffff; font-size: 0.9rem;
  }
  button {
    width: 100%; padding: 0.6rem; border-radius: 8px; border: none; cursor: pointer;
    background: #ffffff; color: #0d0d0d; font-weight: 600; font-size: 0.9rem;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: #e66767; font-size: 0.8rem; margin-top: 0.75rem; text-align: center; min-height: 1.1em; }
</style>
</head>
<body>
  <form class="card" id="gate-form">
    <h1>PoE2 Arbitrage Advisory</h1>
    <input type="password" id="gate-password" autocomplete="current-password" autofocus>
    <button type="submit" id="gate-submit">Unlock</button>
    <div class="error" id="gate-error"></div>
  </form>
<script>
(function() {
  var salt = "${salt}", iv = "${iv}", ciphertext = "${ciphertext}", iterations = ${pbkdf2Iterations};

  function b64ToBytes(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function tryDecrypt(password) {
    var passKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    var key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64ToBytes(salt), iterations: iterations, hash: "SHA-256" },
      passKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    var plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(iv) }, key, b64ToBytes(ciphertext));
    return new TextDecoder().decode(plainBuf);
  }

  document.getElementById("gate-form").addEventListener("submit", function(e) {
    e.preventDefault();
    var btn = document.getElementById("gate-submit");
    var err = document.getElementById("gate-error");
    var pw = document.getElementById("gate-password").value;
    btn.disabled = true;
    err.textContent = "";
    tryDecrypt(pw).then(function(html) {
      document.open();
      document.write(html);
      document.close();
    }).catch(function() {
      btn.disabled = false;
      err.textContent = "Wrong password.";
    });
  });
})();
</script>
</body>
</html>
`;
}
