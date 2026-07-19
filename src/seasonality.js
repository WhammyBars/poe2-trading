// Looks for hour-of-day / day-of-week price patterns in our own local history
// (poe.ninja's sparkline only covers ~7 recent points, not enough for this).
// Deliberately conservative about claiming a pattern is real: below the
// coverage thresholds this returns an "insufficient data" state instead of a
// misleading chart, since a handful of samples can look like a pattern by
// pure chance.
import { getAllHistoryForCategory } from "./db.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Days of calendar coverage needed before a bucket is shown at all / called solid.
const HOUR_PRELIMINARY_DAYS = 2;
const HOUR_SOLID_DAYS = 7;
const DAY_PRELIMINARY_DAYS = 7;
const DAY_SOLID_DAYS = 21;

export function computeSeasonality(categoryKeys) {
  const hourBuckets = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
  const dayBuckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
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
      const dayStr = r.ts.slice(0, 10);
      distinctDays.add(dayStr);
      if (!minTs || r.ts < minTs) minTs = r.ts;
      if (!maxTs || r.ts > maxTs) maxTs = r.ts;

      if (prevVal != null && prevVal !== 0) {
        const pct = ((r.primaryValue - prevVal) / prevVal) * 100;
        const d = new Date(r.ts);
        const hour = d.getUTCHours();
        const dow = (d.getUTCDay() + 6) % 7; // remap Sun=0..Sat=6 -> Mon=0..Sun=6
        hourBuckets[hour].sum += pct;
        hourBuckets[hour].n += 1;
        dayBuckets[dow].sum += pct;
        dayBuckets[dow].n += 1;
      }
      prevVal = r.primaryValue;
    }
  }

  const daysSpanned = distinctDays.size;

  const hourOfDay = hourBuckets.map((b, hour) => ({ hour, avgPct: b.n ? b.sum / b.n : 0, n: b.n }));
  const dayOfWeek = dayBuckets.map((b, i) => ({ day: DAY_NAMES[i], avgPct: b.n ? b.sum / b.n : 0, n: b.n }));

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
