// Curated US large-cap universe for the screener. Not the full S&P 500 — expandable
// later; the refresh job already tolerates individual bad/delisted tickers.
export const UNIVERSE_US: readonly string[] = [
  // Tech
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "ORCL", "CRM",
  "ADBE", "CSCO", "ACN", "IBM", "INTC", "AMD", "QCOM", "TXN", "NOW", "INTU",
  // Financials
  "JPM", "BAC", "WFC", "GS", "MS", "C", "AXP", "BLK", "SCHW", "V", "MA", "PYPL",
  // Healthcare
  "JNJ", "UNH", "PFE", "MRK", "ABBV", "LLY", "TMO", "ABT", "DHR", "BMY",
  // Consumer
  "WMT", "PG", "KO", "PEP", "COST", "MCD", "NKE", "SBUX", "HD", "LOW", "DIS", "CMCSA",
  // Industrial
  "BA", "CAT", "GE", "HON", "UPS", "RTX", "LMT", "MMM",
  // Energy
  "XOM", "CVX",
  // Communications
  "NFLX", "T", "VZ",
];
