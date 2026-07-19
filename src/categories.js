// Tracked categories and which poe.ninja endpoint family they live on.
// exchange = GGG's Currency Exchange (fungible/stackable), stash = individually-rolled
// items sampled from stash listings (percentile-ish single spot value per item name).
// Precursor/Unique Tablets excluded: poe.ninja's stash overview collapses each
// tablet name+rarity into one aggregate price without exposing the actual mod
// roll, so the number isn't a reliable trade signal (a "Ritual Tablet (Rare)"
// could be a great or terrible roll bucketed the same way).
//
// The rest of these are every other confirmed-working exchange `type`, checked
// against real trading volume before adding (2026-07-19) — everything below
// clears at least 500 divine of volume on its single most-traded item.
// Essences was checked and excluded: all 80 essence items summed to only ~386
// divine of total volume (vs. tens of thousands for a single top item in most
// categories here) — genuinely thin on the exchange this league, not worth a
// signal. "Locks" (Hinekora's Lock etc.) are already inside Currency, no
// separate category needed.
export const CATEGORIES = [
  { key: "Currency", label: "Currency", endpoint: "exchange" },
  { key: "LineageSupportGems", label: "Lineage Support Gems", endpoint: "exchange" },
  { key: "Ritual", label: "Omens", endpoint: "exchange" },
  { key: "Runes", label: "Runes", endpoint: "exchange" },
  { key: "Fragments", label: "Fragments", endpoint: "exchange" },
  { key: "Expedition", label: "Expedition", endpoint: "exchange" },
  { key: "UncutGems", label: "Uncut Gems", endpoint: "exchange" },
  { key: "Breach", label: "Catalysts", endpoint: "exchange" },
  { key: "Delirium", label: "Liquid Emotions", endpoint: "exchange" },
  { key: "SoulCores", label: "Soul Cores", endpoint: "exchange" },
  { key: "Idols", label: "Idols", endpoint: "exchange" },
  { key: "Verisium", label: "Verisium", endpoint: "exchange" },
];

export const BASE_URL = "https://poe.ninja";
export const EXCHANGE_PATH = "/poe2/api/economy/exchange/current/overview";
export const STASH_PATH = "/poe2/api/economy/stash/current/item/overview";
export const INDEX_STATE_PATH = "/poe2/api/data/index-state";
