// Invoked only by .github/workflows/zero-holding.yml (workflow_dispatch).
// One-off correction: removes every logged purchase entry for one itemKey,
// zeroing that item's held quantity (e.g. after selling out of a position
// that was tracked as a holding). Never run locally with a real password —
// this exists so the password never has to leave GitHub's secret store.
import { loadPurchases, savePurchases } from "./purchases.js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const password = required("DASHBOARD_PASSWORD");
  const itemKey = required("ZERO_ITEM_KEY");

  const purchases = await loadPurchases(password);
  const remaining = purchases.filter((p) => p.itemKey !== itemKey);
  const removedCount = purchases.length - remaining.length;

  if (removedCount === 0) {
    console.log(`No logged purchases found for ${itemKey}, nothing to zero out.`);
    return;
  }

  await savePurchases(remaining, password);
  console.log(`Removed ${removedCount} logged purchase(s) for ${itemKey}, holding is now zeroed.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
