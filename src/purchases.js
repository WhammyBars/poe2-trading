// Purchase log: the single source of truth is docs/purchases.enc.json, an
// AES-GCM ciphertext of a plain JSON array, encrypted with DASHBOARD_PASSWORD.
// There is no plaintext copy anywhere in the repo — every reader (the hourly
// dashboard build, the log-purchase workflow) decrypts it fresh with the secret.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { encryptString, decryptString } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENC_PATH = path.join(__dirname, "..", "docs", "purchases.enc.json");

export async function loadPurchases(password) {
  if (!fs.existsSync(ENC_PATH)) return [];
  const blob = JSON.parse(fs.readFileSync(ENC_PATH, "utf8"));
  try {
    const json = await decryptString(blob, password);
    return JSON.parse(json);
  } catch (err) {
    // Don't let a corrupted/mismatched purchase file take down the whole
    // hourly dashboard build — degrade to "no holdings" and keep going.
    console.error(`Failed to decrypt purchases.enc.json, skipping holdings section: ${err.message}`);
    return [];
  }
}

export async function savePurchases(purchases, password) {
  const blob = await encryptString(JSON.stringify(purchases), password);
  fs.mkdirSync(path.dirname(ENC_PATH), { recursive: true });
  fs.writeFileSync(ENC_PATH, JSON.stringify(blob, null, 2), "utf8");
}

export async function addPurchase(entry, password) {
  const purchases = await loadPurchases(password);
  purchases.push({
    id: randomUUID(),
    itemKey: entry.itemKey,
    category: entry.category,
    itemId: entry.itemId,
    name: entry.name,
    qty: entry.qty,
    pricePerUnit: entry.pricePerUnit,
    currency: entry.currency ?? "divine",
    boughtAt: entry.boughtAt ?? new Date().toISOString(),
    note: entry.note ?? null,
  });
  await savePurchases(purchases, password);
  return purchases;
}

// Weighted-average cost basis per item, summed across every purchase of it.
export function aggregateHoldings(purchases) {
  const byItem = new Map();
  for (const p of purchases) {
    if (!byItem.has(p.itemKey)) {
      byItem.set(p.itemKey, { itemKey: p.itemKey, category: p.category, name: p.name, currency: p.currency, qty: 0, totalCost: 0 });
    }
    const h = byItem.get(p.itemKey);
    h.qty += p.qty;
    h.totalCost += p.qty * p.pricePerUnit;
  }
  return Array.from(byItem.values()).map((h) => ({ ...h, avgCost: h.qty > 0 ? h.totalCost / h.qty : 0 }));
}
