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

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs, avg) {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - avg) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeSignal({ currentValue, history, sparkline }) {
  const values = history.map((h) => h.primaryValue);
  const n = values.length;
  const spark = sparkline?.data ?? [];
  const totalChange = sparkline?.totalChange ?? 0;
  const momentum = spark.length >= 2 ? spark[spark.length - 1] - spark[spark.length - 2] : 0;

  if (n < MIN_SAMPLES) {
    let verdict = "HOLD";
    if (totalChange <= -SPARKLINE_PROVISIONAL_THRESHOLD) verdict = "BUY";
    else if (totalChange >= SPARKLINE_PROVISIONAL_THRESHOLD) verdict = "SELL";
    return {
      verdict,
      provisional: true,
      z: null,
      momentum,
      reason: `Only ${n}/${MIN_SAMPLES} local samples so far — using poe.ninja's sparkline instead: ${totalChange.toFixed(1)}% total change over its last 7 points.`,
    };
  }

  const avg = mean(values);
  const sd = stddev(values, avg);
  const z = sd > 0 ? (currentValue - avg) / sd : 0;

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

  return { verdict, provisional: false, z, momentum, mean: avg, stddev: sd, n, reason };
}
