// Looks for hour-of-day / day-of-week price patterns in our own local history
// (poe.ninja's sparkline only covers ~7 recent points, not enough for this).
// Deliberately conservative about claiming a pattern is real: below the
// coverage thresholds this returns an "insufficient data" state instead of a
// misleading chart, since a handful of samples can look like a pattern by
// pure chance.
import { getAllHistoryForCategory } from "./db.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Timestamps are stored in UTC, but the buckets are for a Singapore-based
// user — Singapore is a fixed UTC+8 with no DST, so a flat offset is exact
// (no need for Intl/timezone-db lookups).
const SGT_OFFSET_MS = 8 * 3600 * 1000;

// Days of calendar coverage needed before a bucket is shown at all / called solid.
const HOUR_PRELIMINARY_DAYS = 2;
const HOUR_SOLID_DAYS = 7;
const DAY_PRELIMINARY_DAYS = 7;
const DAY_SOLID_DAYS = 21;

export function computeSeasonality(categoryKeys) {
  const hourBuckets = Array.from({ length: 24 }, () => ({ sum: 0, n: 0, downTicks: 0 }));
  const dayBuckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0, downTicks: 0 }));
  const distinctDays = new Set();
  let minTs = null;
  let maxTs = null;

  for (const cat of categoryKeys) {
    const rows = getAllHistoryForCategory(cat);
    let prevKey = null;
    let prevVal = null;
    for (const r of rows) {
      if (r.itemKey !== prevKey) {
        prevKey = r.itemKey;
        prevVal = null;
      }
      const dayStr = new Date(new Date(r.ts).getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
      distinctDays.add(dayStr);
      if (!minTs || r.ts < minTs) minTs = r.ts;
      if (!maxTs || r.ts > maxTs) maxTs = r.ts;

      if (prevVal != null && prevVal !== 0) {
        const pct = ((r.primaryValue - prevVal) / prevVal) * 100;
        const d = new Date(new Date(r.ts).getTime() + SGT_OFFSET_MS);
        const hour = d.getUTCHours();
        const dow = (d.getUTCDay() + 6) % 7; // remap Sun=0..Sat=6 -> Mon=0..Sun=6
        hourBuckets[hour].sum += pct;
        hourBuckets[hour].n += 1;
        if (pct < 0) hourBuckets[hour].downTicks += 1;
        dayBuckets[dow].sum += pct;
        dayBuckets[dow].n += 1;
        if (pct < 0) dayBuckets[dow].downTicks += 1;
      }
      prevVal = r.primaryValue;
    }
  }

  const daysSpanned = distinctDays.size;

  const hourOfDay = hourBuckets.map((b, hour) => ({
    hour,
    avgPct: b.n ? b.sum / b.n : 0,
    n: b.n,
    winRate: b.n ? b.downTicks / b.n : null,
    winRateLowerBound: wilsonLowerBound(b.downTicks, b.n),
  }));
  const dayOfWeek = dayBuckets.map((b, i) => ({
    day: DAY_NAMES[i],
    avgPct: b.n ? b.sum / b.n : 0,
    n: b.n,
    winRate: b.n ? b.downTicks / b.n : null,
    winRateLowerBound: wilsonLowerBound(b.downTicks, b.n),
  }));

  return {
    hourOfDay,
    dayOfWeek,
    daysSpanned,
    minTs,
    maxTs,
    hourStatus: daysSpanned >= HOUR_SOLID_DAYS ? "solid" : daysSpanned >= HOUR_PRELIMINARY_DAYS ? "preliminary" : "insufficient",
    dayStatus: daysSpanned >= DAY_SOLID_DAYS ? "solid" : daysSpanned >= DAY_PRELIMINARY_DAYS ? "preliminary" : "insufficient",
    thresholds: { HOUR_PRELIMINARY_DAYS, HOUR_SOLID_DAYS, DAY_PRELIMINARY_DAYS, DAY_SOLID_DAYS },
  };
}

// 95% Wilson score lower bound on a proportion (wins/n) — the standard
// small-sample-safe way to ask "is this win rate actually above chance, or
// could a coin flip explain it?". Unlike a raw win rate, it automatically
// demands more samples before trusting a bucket: 3/3 "wins" barely clears
// ~44%, nowhere near enough to call reliable, while 40/60 (67%) comfortably
// clears 50% because the sample size backs it up.
const Z_95 = 1.96;

function wilsonLowerBound(wins, n) {
  if (n === 0) return null;
  const phat = wins / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = Z_95 * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return (center - margin) / denom;
}

// A bucket only counts as a reliable dip window if, at 95% confidence, its
// true down-tick rate is still above 50% — i.e. better than a coin flip,
// not just an average dragged down by a couple of big outlier drops.
const RELIABLE_WIN_RATE_FLOOR = 0.5;

function bestDip(buckets, status, labelKey) {
  if (status === "insufficient") return null;
  const candidates = buckets.filter((b) => b.winRateLowerBound != null && b.winRateLowerBound > RELIABLE_WIN_RATE_FLOOR);
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b.winRateLowerBound > a.winRateLowerBound ? b : a));
  return {
    label: labelKey(best),
    avgPct: best.avgPct,
    n: best.n,
    winRate: best.winRate,
    winRateLowerBound: best.winRateLowerBound,
    preliminary: status === "preliminary",
  };
}

const DAY_FULL_BY_ABBR = Object.fromEntries(DAY_NAMES.map((abbr, i) => [abbr, DAY_NAMES_FULL[i]]));

export function bestDipDay(dayOfWeek, dayStatus) {
  return bestDip(dayOfWeek, dayStatus, (b) => `${DAY_FULL_BY_ABBR[b.day]}s`);
}

export function bestDipHour(hourOfDay, hourStatus) {
  return bestDip(hourOfDay, hourStatus, (b) => `${String(b.hour).padStart(2, "0")}:00 SGT`);
}
