// China ADRs (US-listed, China/HK-headquartered) — kept as their own file rather than folded
// into universe-us.ts's undifferentiated list, since this group has real, structural differences
// worth being able to see at a glance: sourced from a Yahoo-quoted, USD-denominated ADR/ADS
// (or in a few cases, like PDD, a Cayman-incorporated holding company listed directly, commonly
// grouped with "China ADRs" the same way) rather than the underlying onshore/HK-listed shares.
//
// Still real Market.US tickers for this app's purposes: lib/refresh.ts merges this list into the
// "US" bucket, since that's the market these actually trade in and Yahoo already reports them in
// USD at the ADR/ADS level — the same pipeline that scores AAPL scores BABA with no special-casing
// needed for the Snowflake/screener path.
//
// Deliberately does NOT track ADR ratio (ADS-to-ordinary-share conversion, e.g. BABA's 1:8) as a
// field here — it isn't needed anywhere in this app (Yahoo's price/fundamentals are already
// reported at the ADR level, and this app doesn't do FX/underlying-share arbitrage analysis), and
// ratios do change over time (BIDU's changed in 2021) — stating one here without a live source to
// verify it against would be exactly the kind of confident-looking-but-unverified number this
// codebase's own discipline (see lib/data-quality.ts) rejects elsewhere.
//
// Known real limitation, not yet fixed (see README): akeguru's own Compound OS SEC ingestion
// (lib/data/input-sources/sec.ts) only looks for form 10-K/us-gaap tags. These ADRs file as
// foreign private issuers instead — annual 20-F (IFRS or a mix, not us-gaap) plus unaudited
// interim results via 6-K (no XBRL at all). Running `npx tsx scripts/ingest.ts BABA` today will
// correctly pull Yahoo ratios/quotes, but the SEC-sourced structured-fact side will silently
// return zero rows — "Analyze this stock" on any of these will work off Yahoo facts alone until
// sec.ts is extended for 20-F/IFRS, a real, separate piece of work not done here.
export const UNIVERSE_CN_ADR: readonly string[] = [
  // Tech / internet platforms
  "BABA", "JD", "PDD", "BIDU", "NTES", "BILI", "TME", "WB", "IQ",
  // E-commerce / consumer services
  "VIPS", "ATHM", "YMM",
  // EV / auto
  "NIO", "LI", "XPEV",
  // Education
  "TAL", "EDU",
  // Travel / logistics
  "TCOM", "ZTO",
  // Real estate / hospitality
  "BEKE", "HTHT",
  // Financial services
  "FUTU", "TIGR",
];
