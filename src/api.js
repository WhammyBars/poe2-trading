import { BASE_URL, EXCHANGE_PATH, STASH_PATH, INDEX_STATE_PATH } from "./categories.js";

const USER_AGENT = "poe2-arbitrage-tool/1.0 (informational price tracker; not for trade automation)";

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Picks the current main softcore trade league from index-state.
// poe.ninja lists the active league first, but we filter defensively rather
// than trust ordering, since leagues rotate and we never want to hardcode a name.
export function pickCurrentLeague(indexState) {
  const candidates = indexState.economyLeagues ?? [];
  const main = candidates.find(
    (l) => !l.hardcore && !/ssf/i.test(l.url) && !/hc/i.test(l.url)
  );
  return main ?? candidates[0];
}

export async function fetchIndexState() {
  return getJson(`${BASE_URL}${INDEX_STATE_PATH}`);
}

// Both the exchange and stash overview endpoints share the same response shape:
// { core: { items:[{id,name,category,...}], rates, primary, secondary },
//   lines: [{id, primaryValue, listingCount?, sparkline|sparkLine:{totalChange,data[7]}, ...}],
//   items: [...] }  (top-level `items` only present on the exchange endpoint)
export async function fetchOverview({ endpoint, type, leagueDisplayName }) {
  const path = endpoint === "exchange" ? EXCHANGE_PATH : STASH_PATH;
  const url = `${BASE_URL}${path}?league=${encodeURIComponent(leagueDisplayName)}&type=${encodeURIComponent(type)}`;
  const data = await getJson(url);
  return normalizeOverview(data);
}

// Normalizes field-name differences between the two endpoints (e.g. sparkline vs
// sparkLine, and whether name/baseType live on `lines` directly or need a join
// against a separate top-level `items` array) into one consistent shape.
function normalizeOverview(data) {
  const itemsById = new Map();
  for (const it of data.items ?? []) itemsById.set(it.id, it);

  const lines = (data.lines ?? []).map((line) => {
    const joined = itemsById.get(line.id);
    const spark = line.sparkline ?? line.sparkLine ?? { totalChange: 0, data: [] };
    return {
      id: line.id,
      name: line.name ?? joined?.name ?? String(line.id),
      baseType: line.baseType ?? null,
      variant: line.variant ?? null,
      primaryValue: line.primaryValue,
      listingCount: line.listingCount ?? null,
      // Exchange endpoint has no listingCount, but volumePrimaryValue is a real
      // liquidity proxy (total volume traded, denominated in the primary currency)
      // that was previously being discarded here.
      volume: line.volumePrimaryValue ?? null,
      sparkline: { totalChange: spark.totalChange ?? 0, data: spark.data ?? [] },
    };
  });

  return {
    primaryCurrency: data.core?.primary ?? null,
    secondaryCurrency: data.core?.secondary ?? null,
    lines,
  };
}
