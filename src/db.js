import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "prices.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    item_key TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    base_type TEXT,
    variant TEXT,
    first_seen TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_history (
    item_key TEXT NOT NULL,
    ts TEXT NOT NULL,
    primary_value REAL NOT NULL,
    primary_currency TEXT,
    listing_count INTEGER,
    volume REAL,
    sparkline_total_change REAL,
    sparkline_data TEXT,
    PRIMARY KEY (item_key, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_price_history_key_ts ON price_history (item_key, ts);

  -- Backfilled from poe.ninja's per-item details endpoint (daily granularity,
  -- goes back to league start) — see backfillDailyHistory.js. Kept separate
  -- from price_history (hourly, live) rather than merged in, since the two
  -- are different price snapshots for the same item and a day-over-day delta
  -- computed across a live->daily-close boundary would show up as a phantom
  -- jump. Used only for day-of-week seasonality, never hour-of-day.
  CREATE TABLE IF NOT EXISTS daily_price_history (
    item_key TEXT NOT NULL,
    ts TEXT NOT NULL,
    primary_value REAL NOT NULL,
    primary_currency TEXT,
    PRIMARY KEY (item_key, ts)
  );

  CREATE INDEX IF NOT EXISTS idx_daily_price_history_key_ts ON daily_price_history (item_key, ts);
`);

// Migration for DBs created before the `volume` column existed.
const existingColumns = db.prepare("PRAGMA table_info(price_history)").all().map((c) => c.name);
if (!existingColumns.includes("volume")) {
  db.exec("ALTER TABLE price_history ADD COLUMN volume REAL");
}

export function itemKey(category, itemId) {
  return `${category}:${itemId}`;
}

const upsertItemStmt = db.prepare(`
  INSERT INTO items (item_key, category, item_id, name, base_type, variant, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_key) DO UPDATE SET name = excluded.name, base_type = excluded.base_type, variant = excluded.variant
`);

const insertHistoryStmt = db.prepare(`
  INSERT OR REPLACE INTO price_history
    (item_key, ts, primary_value, primary_currency, listing_count, volume, sparkline_total_change, sparkline_data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export function recordSample({ category, line, primaryCurrency, ts }) {
  const key = itemKey(category, line.id);
  upsertItemStmt.run(key, category, line.id, line.name, line.baseType, line.variant, ts);
  insertHistoryStmt.run(
    key,
    ts,
    line.primaryValue,
    primaryCurrency,
    line.listingCount,
    line.volume,
    line.sparkline?.totalChange ?? null,
    JSON.stringify(line.sparkline?.data ?? [])
  );
}

const historyStmt = db.prepare(`
  SELECT ts, primary_value AS primaryValue, primary_currency AS primaryCurrency,
         listing_count AS listingCount, volume, sparkline_total_change AS sparklineTotalChange,
         sparkline_data AS sparklineData
  FROM price_history
  WHERE item_key = ? AND ts >= ?
  ORDER BY ts ASC
`);

// Returns rows within the trailing window, ascending by time. The caller decides
// whether to treat the last row as "current" and the rest as the trend baseline.
export function getTrailingHistory(key, sinceTs) {
  return historyStmt.all(key, sinceTs).map((r) => ({
    ...r,
    sparkline: { totalChange: r.sparklineTotalChange, data: JSON.parse(r.sparklineData || "[]") },
  }));
}

const latestPerCategoryStmt = db.prepare(`
  SELECT i.item_key AS itemKey, i.item_id AS itemId, i.name, i.base_type AS baseType, i.variant, i.category
  FROM items i
  WHERE i.category = ?
`);

export function getItemsForCategory(category) {
  return latestPerCategoryStmt.all(category);
}

const findByNameStmt = db.prepare(`
  SELECT item_key AS itemKey, category, item_id AS itemId, name, variant
  FROM items
  WHERE name LIKE ? COLLATE NOCASE
  ORDER BY name ASC
`);

// Fuzzy (substring, case-insensitive) item lookup — used to resolve a purchase
// log entry's free-text item name to a concrete category+itemId.
export function findItemsByName(nameSubstring) {
  return findByNameStmt.all(`%${nameSubstring}%`);
}

const currentValueStmt = db.prepare(`
  SELECT primary_value AS primaryValue, primary_currency AS primaryCurrency
  FROM price_history
  WHERE item_key = ?
  ORDER BY ts DESC
  LIMIT 1
`);

export function getCurrentValue(key) {
  return currentValueStmt.get(key) ?? null;
}

const allHistoryForCategoryStmt = db.prepare(`
  SELECT ph.item_key AS itemKey, ph.ts, ph.primary_value AS primaryValue
  FROM price_history ph
  JOIN items i ON i.item_key = ph.item_key
  WHERE i.category = ?
  ORDER BY ph.item_key ASC, ph.ts ASC
`);

// All history for one currently-tracked category, joined against `items` so
// stale rows from categories that were later excluded (e.g. tablets) don't leak in.
export function getAllHistoryForCategory(category) {
  return allHistoryForCategoryStmt.all(category);
}

const upsertDailyStmt = db.prepare(`
  INSERT INTO daily_price_history (item_key, ts, primary_value, primary_currency)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(item_key, ts) DO UPDATE SET primary_value = excluded.primary_value, primary_currency = excluded.primary_currency
`);

export function recordDailySample({ itemKey: key, ts, primaryValue, primaryCurrency }) {
  upsertDailyStmt.run(key, ts, primaryValue, primaryCurrency);
}

const allDailyHistoryForCategoryStmt = db.prepare(`
  SELECT dph.item_key AS itemKey, dph.ts, dph.primary_value AS primaryValue
  FROM daily_price_history dph
  JOIN items i ON i.item_key = dph.item_key
  WHERE i.category = ?
  ORDER BY dph.item_key ASC, dph.ts ASC
`);

// Backfilled daily closes for one currently-tracked category — see
// daily_price_history's table comment for why this is separate from
// getAllHistoryForCategory.
export function getAllDailyHistoryForCategory(category) {
  return allDailyHistoryForCategoryStmt.all(category);
}

export function closeDb() {
  db.close();
}

export default db;
