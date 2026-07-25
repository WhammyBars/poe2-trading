// Looks for hour-of-day / day-of-week price patterns.
// Hour-of-day comes from our own locally-collected hourly history (poe.ninja's
// sparkline only covers ~7 recent points, not enough for this, and poe.ninja's
// own per-item history endpoint is daily-only so it can't give hour granularity).
// Day-of-week comes from a separate backfilled daily-close table (see
// backfillDailyHistory.js) sourced from poe.ninja's per-item details endpoint,
// which goes back to league start — far more calendar coverage, immediately,
// than waiting weeks for the hourly watch loop to accumulate it. The two are
// deliberately never mixed into the same day-over-day delta: they're
// different price snapshots (live vs. daily close) for the same item, and a
// transition between them would show up as a phantom jump.
// Deliberately conservative about claiming a pattern is real: below the
// coverage thresholds this returns an "insufficient data" state instead of a
// misleading chart, since a handful of samples can look like a pattern by
// pure chance.
import { getAllHistoryForCategory, getAllDailyHistoryForCategory } from "./db.js";

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

function sgtDate(ts) {
  return new Date(new Date(ts).getTime() + SGT_OFFSET_MS);
}

function makeBuckets(n) {
  return Array.from({ length: n }, () => ({ sum: 0, n: 0, downTicks: 0 }));
}

function finalizeBuckets(buckets, labelFor) {
  return buckets.map((b, i) => ({
    ...labelFor(i),
    avgPct: b.n ? b.sum / b.n : 0,
    n: b.n,
    winRate: b.n ? b.downTicks / b.n : null,
    winRateLowerBound: wilsonLowerBound(b.downTicks, b.n),
  }));
}

function computeHourOfDay(categoryKeys) {
  const hourBuckets = makeBuckets(24);
  const distinctDays = new Set();

  for (const cat of categoryKeys) {
    const rows = getAllHistoryForCategory(cat);
    let prevKey = null;
    let prevVal = null;
    for (const r of rows) {
      if (r.itemKey !== prevKey) {
        prevKey = r.itemKey;
        prevVal = null;
      }
      distinctDays.add(sgtDate(r.ts).toISOString().slice(0, 10));

      if (prevVal != null && prevVal !== 0) {
        const pct = ((r.primaryValue - prevVal) / prevVal) * 100;
        const hour = sgtDate(r.ts).getUTCHours();
        hourBuckets[hour].sum += pct;
        hourBuckets[hour].n += 1;
        if (pct < 0) hourBuckets[hour].downTicks += 1;
      }
      prevVal = r.primaryValue;
    }
  }

  return {
    hourOfDay: finalizeBuckets(hourBuckets, (hour) => ({ hour })),
    daysSpanned: distinctDays.size,
  };
}

function computeDayOfWeek(categoryKeys) {
  const dayBuckets = makeBuckets(7);
  const distinctDays = new Set();

  for (const cat of categoryKeys) {
    const rows = getAllDailyHistoryForCategory(cat);
    let prevKey = null;
    let prevVal = null;
    for (const r of rows) {
      if (r.itemKey !== prevKey) {
        prevKey = r.itemKey;
        prevVal = null;
      }
      distinctDays.add(sgtDate(r.ts).toISOString().slice(0, 10));

      if (prevVal != null && prevVal !== 0) {
        const pct = ((r.primaryValue - prevVal) / prevVal) * 100;
        const dow = (sgtDate(r.ts).getUTCDay() + 6) % 7; // remap Sun=0..Sat=6 -> Mon=0..Sun=6
        dayBuckets[dow].sum += pct;
        dayBuckets[dow].n += 1;
        if (pct < 0) dayBuckets[dow].downTicks += 1;
      }
      prevVal = r.primaryValue;
    }
  }

  return {
    dayOfWeek: finalizeBuckets(dayBuckets, (i) => ({ day: DAY_NAMES[i] })),
    daysSpanned: distinctDays.size,
  };
}

export function computeSeasonality(categoryKeys) {
  const { hourOfDay, daysSpanned: hourDaysSpanned } = computeHourOfDay(categoryKeys);
  const { dayOfWeek, daysSpanned: dayDaysSpanned } = computeDayOfWeek(categoryKeys);

  return {
    hourOfDay,
    dayOfWeek,
    hourDaysSpanned,
    dayDaysSpanned,
    hourStatus: hourDaysSpanned >= HOUR_SOLID_DAYS ? "solid" : hourDaysSpanned >= HOUR_PRELIMINARY_DAYS ? "preliminary" : "insufficient",
    dayStatus: dayDaysSpanned >= DAY_SOLID_DAYS ? "solid" : dayDaysSpanned >= DAY_PRELIMINARY_DAYS ? "preliminary" : "insufficient",
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
