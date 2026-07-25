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
import {
  getAllHistoryForCategory,
  getAllDailyHistoryForCategory,
  getFullHistoryForItem,
  getDailyHistoryForItem,
} from "./db.js";

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
  return Array.from({ length: n }, () => ({ sum: 0, n: 0, downTicks: 0, upTicks: 0 }));
}

// Down-tick stats power "reliable dip" (buy timing); up-tick stats power
// "reliable pump" (sell timing) — see bestDip/bestPump below. Kept as two
// separate win rates rather than treating "not a dip" as "a pump", since a
// tick can also be flat (pct === 0), and because a bucket with a middling,
// unreliable dip rate shouldn't be reported as a reliable pump by default.
function finalizeBuckets(buckets, labelFor) {
  return buckets.map((b, i) => ({
    ...labelFor(i),
    avgPct: b.n ? b.sum / b.n : 0,
    n: b.n,
    winRate: b.n ? b.downTicks / b.n : null,
    winRateLowerBound: wilsonLowerBound(b.downTicks, b.n),
    pumpRate: b.n ? b.upTicks / b.n : null,
    pumpRateLowerBound: wilsonLowerBound(b.upTicks, b.n),
  }));
}

// Buckets a single item-ordered stream of {itemKey, ts, primaryValue} rows —
// shared by both the category-pooled path (many items concatenated) and the
// single-item path (see computeItemSeasonality below). Resets the
// prev-value baseline on every itemKey change so pooling several items
// never computes a delta across two different items' prices.
function bucketByHour(rows) {
  const hourBuckets = makeBuckets(24);
  const distinctDays = new Set();
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
      else if (pct > 0) hourBuckets[hour].upTicks += 1;
    }
    prevVal = r.primaryValue;
  }

  return {
    hourOfDay: finalizeBuckets(hourBuckets, (hour) => ({ hour })),
    daysSpanned: distinctDays.size,
  };
}

function bucketByDay(rows) {
  const dayBuckets = makeBuckets(7);
  const distinctDays = new Set();
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
      else if (pct > 0) dayBuckets[dow].upTicks += 1;
    }
    prevVal = r.primaryValue;
  }

  return {
    dayOfWeek: finalizeBuckets(dayBuckets, (i) => ({ day: DAY_NAMES[i] })),
    daysSpanned: distinctDays.size,
  };
}

function statusFor(daysSpanned, preliminaryDays, solidDays) {
  return daysSpanned >= solidDays ? "solid" : daysSpanned >= preliminaryDays ? "preliminary" : "insufficient";
}

export function computeSeasonality(categoryKeys) {
  const hourRows = categoryKeys.flatMap((cat) => getAllHistoryForCategory(cat));
  const dayRows = categoryKeys.flatMap((cat) => getAllDailyHistoryForCategory(cat));
  const { hourOfDay, daysSpanned: hourDaysSpanned } = bucketByHour(hourRows);
  const { dayOfWeek, daysSpanned: dayDaysSpanned } = bucketByDay(dayRows);

  return {
    hourOfDay,
    dayOfWeek,
    hourDaysSpanned,
    dayDaysSpanned,
    hourStatus: statusFor(hourDaysSpanned, HOUR_PRELIMINARY_DAYS, HOUR_SOLID_DAYS),
    dayStatus: statusFor(dayDaysSpanned, DAY_PRELIMINARY_DAYS, DAY_SOLID_DAYS),
    thresholds: { HOUR_PRELIMINARY_DAYS, HOUR_SOLID_DAYS, DAY_PRELIMINARY_DAYS, DAY_SOLID_DAYS },
  };
}

// Same shape as computeSeasonality, but scoped to one item's own history
// instead of pooling a whole category. Much smaller sample sizes (a single
// item's daily closes, ~1/{item count} of a category's pooled ticks), so the
// 95%-confidence reliability gate in bestDip/bestPump will rightly return
// "no reliable pattern" for most items — that's the honest result of not
// having enough independent samples yet, not a bug.
export function computeItemSeasonality(itemKey) {
  const { hourOfDay, daysSpanned: hourDaysSpanned } = bucketByHour(getFullHistoryForItem(itemKey));
  const { dayOfWeek, daysSpanned: dayDaysSpanned } = bucketByDay(getDailyHistoryForItem(itemKey));

  return {
    hourOfDay,
    dayOfWeek,
    hourDaysSpanned,
    dayDaysSpanned,
    hourStatus: statusFor(hourDaysSpanned, HOUR_PRELIMINARY_DAYS, HOUR_SOLID_DAYS),
    dayStatus: statusFor(dayDaysSpanned, DAY_PRELIMINARY_DAYS, DAY_SOLID_DAYS),
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

// A bucket only counts as reliable — dip (buy) or pump (sell) — if, at 95%
// confidence, its true rate is still above 50%: better than a coin flip,
// not just an average dragged around by a couple of outlier moves.
const RELIABLE_RATE_FLOOR = 0.5;

function bestByRate(buckets, status, labelKey, rateKey, boundKey) {
  if (status === "insufficient") return null;
  const candidates = buckets.filter((b) => b[boundKey] != null && b[boundKey] > RELIABLE_RATE_FLOOR);
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b[boundKey] > a[boundKey] ? b : a));
  return {
    label: labelKey(best),
    avgPct: best.avgPct,
    n: best.n,
    rate: best[rateKey],
    rateLowerBound: best[boundKey],
    preliminary: status === "preliminary",
  };
}

const DAY_FULL_BY_ABBR = Object.fromEntries(DAY_NAMES.map((abbr, i) => [abbr, DAY_NAMES_FULL[i]]));
const dayLabel = (b) => `${DAY_FULL_BY_ABBR[b.day]}s`;
const hourLabel = (b) => `${String(b.hour).padStart(2, "0")}:00 SGT`;

export function bestDipDay(dayOfWeek, dayStatus) {
  return bestByRate(dayOfWeek, dayStatus, dayLabel, "winRate", "winRateLowerBound");
}

export function bestDipHour(hourOfDay, hourStatus) {
  return bestByRate(hourOfDay, hourStatus, hourLabel, "winRate", "winRateLowerBound");
}

export function bestPumpDay(dayOfWeek, dayStatus) {
  return bestByRate(dayOfWeek, dayStatus, dayLabel, "pumpRate", "pumpRateLowerBound");
}

export function bestPumpHour(hourOfDay, hourStatus) {
  return bestByRate(hourOfDay, hourStatus, hourLabel, "pumpRate", "pumpRateLowerBound");
}
