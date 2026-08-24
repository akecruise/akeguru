// Curated HKEX large/mid-cap universe for the screener. Not the full Hang Seng
// Composite — expandable later; the refresh job already tolerates individual
// bad/delisted tickers. Yahoo Finance HK tickers are 4-digit zero-padded codes
// with a `.HK` suffix (e.g. Tencent 700 -> "0700.HK").
export const UNIVERSE_HK: readonly string[] = [
  // Tech / internet
  "0700.HK", "9988.HK", "3690.HK", "9618.HK", "9999.HK", "1024.HK", "0772.HK",
  // Financials
  "0005.HK", "1299.HK", "2318.HK", "0388.HK", "1398.HK", "3988.HK", "0939.HK", "2388.HK",
  // Property / conglomerates
  "0001.HK", "0016.HK", "0017.HK", "1113.HK", "0688.HK", "0012.HK",
  // Energy / utilities
  "0883.HK", "0857.HK", "0386.HK", "0002.HK", "0003.HK", "0006.HK",
  // Telecom
  "0941.HK", "0762.HK",
  // Consumer / retail
  "1929.HK", "2331.HK", "6862.HK", "0027.HK",
  // Industrial / materials
  "0669.HK", "0175.HK", "2333.HK",
  // Healthcare
  "1093.HK", "2269.HK", "1177.HK",
  // Transportation / infrastructure
  "0694.HK", // Beijing Capital International Airport
];
