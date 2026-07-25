// Invoked only by .github/workflows/zero-cost-basis.yml (workflow_dispatch).
// One-off correction: sets pricePerUnit = 0 on every entry in the purchase
// log. Never run locally with a real password — this exists so the password
// never has to leave GitHub's secret store.
import { loadPurchases, savePurchases } from "./purchases.js";

async function main() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error("Missing required env var: DASHBOARD_PASSWORD");

  const purchases = await loadPurchases(password);
  if (purchases.length === 0) {
    console.log("No purchases logged, nothing to correct.");
    return;
  }

  for (const p of purchases) p.pricePerUnit = 0;
  await savePurchases(purchases, password);
  console.log(`Zeroed cost basis on ${purchases.length} logged purchase(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
