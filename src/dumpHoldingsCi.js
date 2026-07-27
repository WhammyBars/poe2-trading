// Temporary read-only diagnostic, invoked only via workflow_dispatch. Prints
// the aggregated holdings (no secrets) so a mismatch can be debugged from the
// Actions log without ever decrypting the purchase log locally.
import { loadPurchases, aggregateHoldings } from "./purchases.js";

async function main() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error("Missing required env var: DASHBOARD_PASSWORD");

  const purchases = await loadPurchases(password);
  console.log(`\n${purchases.length} raw purchase entries:`);
  for (const p of purchases) {
    console.log(`  ${p.boughtAt}  ${p.itemKey}  qty=${p.qty}  price=${p.pricePerUnit} ${p.currency}  note=${p.note ?? ""}`);
  }

  const holdings = aggregateHoldings(purchases);
  console.log(`\n${holdings.length} aggregated holdings:`);
  for (const h of holdings) {
    console.log(`  ${h.itemKey}  ${h.name}  qty=${h.qty}  avgCost=${h.avgCost.toFixed(4)} ${h.currency}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
