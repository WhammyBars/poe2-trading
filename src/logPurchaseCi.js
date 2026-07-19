// Invoked only by .github/workflows/log-purchase.yml (workflow_dispatch).
// Reads purchase details from env vars (mapped from workflow_dispatch inputs)
// and appends one entry to the encrypted purchase log. Never run locally with
// a real password — this exists so the password never has to leave GitHub's
// secret store.
import { addPurchase } from "./purchases.js";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const password = required("DASHBOARD_PASSWORD");
  const entry = {
    itemKey: required("PURCHASE_ITEM_KEY"),
    category: required("PURCHASE_CATEGORY"),
    itemId: required("PURCHASE_ITEM_ID"),
    name: required("PURCHASE_NAME"),
    qty: Number(required("PURCHASE_QTY")),
    pricePerUnit: Number(required("PURCHASE_PRICE")),
    currency: process.env.PURCHASE_CURRENCY || "divine",
    note: process.env.PURCHASE_NOTE || null,
  };

  if (!Number.isFinite(entry.qty) || entry.qty <= 0) throw new Error(`Invalid qty: ${process.env.PURCHASE_QTY}`);
  if (!Number.isFinite(entry.pricePerUnit) || entry.pricePerUnit < 0) throw new Error(`Invalid price: ${process.env.PURCHASE_PRICE}`);

  const purchases = await addPurchase(entry, password);
  console.log(`Logged purchase: ${entry.qty}x ${entry.name} @ ${entry.pricePerUnit} ${entry.currency}. Total entries: ${purchases.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
