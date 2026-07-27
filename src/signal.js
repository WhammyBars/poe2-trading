// Simple, explainable BUY/HOLD/SELL heuristic. No black-box scoring.
//
// Once we have enough locally-collected samples (MIN_SAMPLES), the call is a
// z-score of the current price against our own trailing-window mean/stddev,
// confirmed by the direction poe.ninja's 7-point sparkline is currently moving:
//   - price notably BELOW trend + momentum turning back up   -> BUY
//   - price notably ABOVE trend + momentum turning back down -> SELL
//   - otherwise                                               -> HOLD
//
// Before we've collected enough local history, we fall back to poe.ninja's own
// sparkline.totalChange (the 7-point window they already compute) as a
// provisional read, clearly labeled as such.

export const MIN_SAMPLES = 3;
export const Z_THRESHOLD = 1.0;
export const SPARKLINE_PROVISIONAL_THRESHOLD = 10; // percent

// Trend-regime overlay (see computeTrend below): the z-score verdict above
// only ever reasons about the trailing 72h window, so it can't tell a dip
// inside a multi-week uptrend (where mean-reversion has actually been
// working) from the next leg down in a multi-week downtrend (where the
// "dip" may just continue). REGIME_SHORT_MA_DAYS/LONG_MA_DAYS pick the two
// windows compared; REGIME_THRESHOLD is how far apart they need to be
// (as a fraction) before it's called a trend rather than noise.
export const REGIME_SHORT_MA_DAYS = 7;
export const REGIME_LONG_MA_DAYS = 21;
export const REGIME_THRESHOLD = 0.03;

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs, avg) {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - avg) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// Classifies an item's own daily-close history (backfilled to league start —
// see backfillDailyHistory.js — so this works from day one, unlike the
// hourly z-score which needs weeks to build up a local sample) into
// UPTREND / DOWNTREND / RANGE, plus all-time high/low context. Returns
// regime: "INSUFFICIENT" if there isn't yet REGIME_LONG_MA_DAYS of daily
// history for this item — callers should treat that the same as "no trend
// context available" rather than guessing.
export function computeTrend(dailyHistory) {
  if (!dailyHistory || dailyHistory.length === 0) return null;
  const values = dailyHistory.map((d) => d.primaryValue);

  let athIdx = 0;
  let atlIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[athIdx]) athIdx = i;
    if (values[i] < values[atlIdx]) atlIdx = i;
  }
  const ath = { value: values[athIdx], ts: dailyHistory[athIdx].ts };
  const atl = { value: values[atlIdx], ts: dailyHistory[atlIdx].ts };
  const current = values[values.length - 1];
  const pctFromAth = ath.value > 0 ? (current - ath.value) / ath.value : null;
  const pctFromAtl = atl.value > 0 ? (current - atl.value) / atl.value : null;

  if (values.length < REGIME_LONG_MA_DAYS) {
    return { ath, atl, current, pctFromAth, pctFromAtl, regime: "INSUFFICIENT", shortMA: null, longMA: null, daysOfHistory: values.length };
  }

  const shortMA = mean(values.slice(-REGIME_SHORT_MA_DAYS));
  const longMA = mean(values.slice(-REGIME_LONG_MA_DAYS));
  let regime = "RANGE";
  if (shortMA > longMA * (1 + REGIME_THRESHOLD)) regime = "UPTREND";
  else if (shortMA < longMA * (1 - REGIME_THRESHOLD)) regime = "DOWNTREND";

  return { ath, atl, current, pctFromAth, pctFromAtl, regime, shortMA, longMA, daysOfHistory: values.length };
}

// Attaches trend context to an already-computed verdict. A BUY that fires
// while the item's own daily closes are in a DOWNTREND (or a SELL during an
// UPTREND) is flagged "counterTrend" — still shown, never silently dropped,
// but callers (report.js's top-opportunities picks, dashboardHtml.js's pill
// styling) treat it as lower-confidence than a trend-confirmed call. HOLD
// verdicts are left alone: there's nothing actionable to caveat.
function applyTrendContext(result, trend) {
  result.trend = trend ?? null;
  result.confidence = "normal";
  result.trendCaution = null;
  if (!trend || trend.regime === "INSUFFICIENT" || result.verdict === "HOLD") return result;

  const athNote = `${trend.pctFromAth != null ? (trend.pctFromAth * 100).toFixed(1) : "?"}% off its all-time high (${trend.ath.value.toFixed(4)} on ${trend.ath.ts.slice(0, 10)})`;
  const counterTrend = (result.verdict === "BUY" && trend.regime === "DOWNTREND") || (result.verdict === "SELL" && trend.regime === "UPTREND");

  if (counterTrend) {
    result.confidence = "counterTrend";
    const gapPct = Math.abs(trend.shortMA / trend.longMA - 1) * 100;
    result.trendCaution = `Counter-trend: ${REGIME_SHORT_MA_DAYS}d avg (${trend.shortMA.toFixed(4)}) is ${gapPct.toFixed(0)}% ${trend.regime === "DOWNTREND" ? "below" : "above"} the ${REGIME_LONG_MA_DAYS}d avg (${trend.longMA.toFixed(4)}) — a ${trend.regime} regime over this item's own history. Currently ${athNote}.`;
    result.reason = `${result.reason} ${result.trendCaution}`;
  } else {
    result.confidence = "trendConfirmed";
    result.reason = `${result.reason} Trend-confirmed (${trend.regime.toLowerCase()} regime); ${athNote}.`;
  }
  return result;
}

export function computeSignal({ currentValue, history, sparkline, trend }) {
  const values = history.map((h) => h.primaryValue);
  const n = values.length;
  const spark = sparkline?.data ?? [];
  const totalChange = sparkline?.totalChange ?? 0;
  const momentum = spark.length >= 2 ? spark[spark.length - 1] - spark[spark.length - 2] : 0;

  if (n < MIN_SAMPLES) {
    let verdict = "HOLD";
    if (totalChange <= -SPARKLINE_PROVISIONAL_THRESHOLD) verdict = "BUY";
    else if (totalChange >= SPARKLINE_PROVISIONAL_THRESHOLD) verdict = "SELL";
    return applyTrendContext(
      {
        verdict,
        provisional: true,
        z: null,
        momentum,
        buyTarget: null,
        sellTarget: null,
        reason: `Only ${n}/${MIN_SAMPLES} local samples so far — using poe.ninja's sparkline instead: ${totalChange.toFixed(1)}% total change over its last 7 points.`,
      },
      trend
    );
  }

  const avg = mean(values);
  const sd = stddev(values, avg);
  const z = sd > 0 ? (currentValue - avg) / sd : 0;
  // Same mean/stddev/threshold the verdict itself uses, so these read as
  // "the price at which our own signal would flip" rather than a separate model.
  const buyTarget = sd > 0 ? avg - Z_THRESHOLD * sd : null;
  const sellTarget = sd > 0 ? avg + Z_THRESHOLD * sd : null;

  let verdict = "HOLD";
  let reason;
  if (z <= -Z_THRESHOLD && momentum >= 0) {
    verdict = "BUY";
    reason = `Price is ${Math.abs(z).toFixed(2)}sigma below its trailing average (${avg.toFixed(4)}) and momentum is turning up (${momentum >= 0 ? "+" : ""}${momentum.toFixed(2)} pts on the sparkline).`;
  } else if (z >= Z_THRESHOLD && momentum <= 0) {
    verdict = "SELL";
    reason = `Price is ${z.toFixed(2)}sigma above its trailing average (${avg.toFixed(4)}) and momentum is rolling over (${momentum.toFixed(2)} pts on the sparkline).`;
  } else {
    reason = `z=${z.toFixed(2)} vs trailing average (${avg.toFixed(4)}) over ${n} samples; momentum ${momentum >= 0 ? "+" : ""}${momentum.toFixed(2)} pts — no clear edge.`;
  }

  return applyTrendContext({ verdict, provisional: false, z, momentum, mean: avg, stddev: sd, n, buyTarget, sellTarget, reason }, trend);
}
