// Polls poe.ninja on a fixed interval (default: hourly, matching GGG's exchange
// aggregation window) and writes a fresh report after every successful fetch.
// This process only reads public data and writes local files — no game
// interaction of any kind.
import { runFetch } from "./fetch.js";
import { runReport } from "./report.js";
import { closeDb } from "./db.js";
import { isMain } from "./util.js";

const INTERVAL_MS = Number(process.env.POE2_POLL_INTERVAL_MINUTES ?? 60) * 60 * 1000;

async function tick() {
  const ts = new Date().toISOString();
  console.log(`\n----- run @ ${ts} -----`);
  try {
    await runFetch();
    await runReport();
  } catch (err) {
    console.error("Tick failed:", err);
  }
}

async function main() {
  console.log(`Starting poll loop, every ${INTERVAL_MS / 60000} minute(s). Ctrl+C to stop.`);
  await tick();
  const timer = setInterval(tick, INTERVAL_MS);

  const shutdown = () => {
    clearInterval(timer);
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isMain(import.meta.url)) {
  main();
}
