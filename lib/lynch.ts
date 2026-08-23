/**
 * Lynch Screener (Phase 3 roadmap item, "Lynch Screener -> akeguru (bottom-up)") — Peter Lynch's
 * stock categorization and PEG-based screen from "One Up On Wall Street", applied to the already-
 * cached universe. Pure, DB-free functions (same reasoning as lib/scoring.ts) — lib/refresh.ts
 * supplies the numbers and persists the result on Stock.
 *
 * Lynch's original scheme has 6 categories (slow grower, stalwart, fast grower, cyclical,
 * turnaround, asset play). Only 4 are classified here — turnaround (a distressed business on the
 * mend) and asset play (hidden balance-sheet value, e.g. real estate or a subsidiary carried below
 * market value) both need judgment this data doesn't support (multi-year loss-then-recovery
 * pattern, or per-segment/per-asset valuation) that a handful of cached ratios can't approximate
 * without guessing. Left `null` (unclassified) rather than forcing a guess into one of the other 4.
 */
import { normalizeSector, getScreenerAdjustment } from "./sector-profile";

export type LynchCategory = "fast_grower" | "stalwart" | "slow_grower" | "cyclical";

// GICS-style sectors where revenue/earnings characteristically swing with the economic cycle.
// A structural trait of the business, not something this ratio-only data can derive from a few
// years of history the way growth-rate buckets can -- sector is the honest signal available here.
const CYCLICAL_SECTORS = new Set(["Energy", "Basic Materials", "Industrials", "Consumer Cyclical"]);
const CYCLICAL_BETA_MIN = 1.2; // confirms the sector's typical volatility actually shows up in this stock, not just its label

const FAST_GROWER_MIN = 0.20; // estEarningsGrowth, fraction (0.20 = 20%)
const STALWART_MIN = 0.10;

export interface LynchClassifyInput {
  estEarningsGrowth: number | null;
  sector: string | null;
  beta: number | null;
}

/** Cyclical is checked first and overrides a growth-rate bucket when it applies -- cyclicality is
 *  a structural trait of the business, not a function of this year's growth estimate (a cyclical
 *  stock mid-upswing can show a high growth estimate and still be a cyclical, not a fast grower). */
export function classifyLynchCategory(input: LynchClassifyInput): LynchCategory | null {
  if (input.sector && CYCLICAL_SECTORS.has(input.sector) && input.beta != null && input.beta > CYCLICAL_BETA_MIN) {
    return "cyclical";
  }
  if (input.estEarningsGrowth == null) return null;
  if (input.estEarningsGrowth >= FAST_GROWER_MIN) return "fast_grower";
  if (input.estEarningsGrowth >= STALWART_MIN) return "stalwart";
  return "slow_grower";
}

/** Lynch's classic PEG = P/E / (growth rate as a whole number, e.g. 20 for 20%) -- only meaningful
 *  for a profitable company (P/E > 0) with positive expected growth; null otherwise (a negative-P/E
 *  or negative-growth "PEG" isn't a ratio Lynch's method assigns any meaning to). */
export function computePegRatio(peRatio: number | null, estEarningsGrowth: number | null): number | null {
  if (peRatio == null || peRatio <= 0 || estEarningsGrowth == null || estEarningsGrowth <= 0) return null;
  return peRatio / (estEarningsGrowth * 100);
}

const PEG_BUY_THRESHOLD = 1.0; // Lynch: PEG < 1 attractive, < 0.5 very attractive -- this flags the looser "attractive" bar
const MAX_DEBT_TO_EQUITY = 1.0; // Lynch was debt-averse outside asset plays (not classified here anyway)

/**
 * A PEG below threshold on a balance sheet that isn't over-levered -- the two hard filters from
 * Lynch's method this data can actually check. Low institutional ownership ("not yet discovered")
 * is a real Lynch signal too but stays a soft note, not a gate here -- heldPercentInstitutions
 * being high is common for large, well-covered stocks for reasons having nothing to do with
 * whether the stock is a good buy, so gating on it would just filter out large caps as a group.
 *
 * `rawSector` (optional): when lib/sector-profile.ts's screenerAdjustment for this sector is
 * 'exclude' (staples, energy, materials, real estate, utilities -- see that file), a PEG-based
 * growth screen isn't measuring what it looks like it's measuring for these sectors' own reasons
 * (bond-proxy yield stocks, cyclical earnings, FFO not EPS, ...), so no PEG here counts as a buy
 * signal regardless of the number -- same reasoning that file already documents per sector.
 * Omitted/unmapped sector falls back to the plain PEG+debt check, same as before this existed.
 */
export function isLynchBuyCandidate(pegRatio: number | null, debtToEquity: number | null, rawSector?: string | null): boolean {
  if (pegRatio == null || pegRatio >= PEG_BUY_THRESHOLD) return false;
  if (debtToEquity != null && debtToEquity > MAX_DEBT_TO_EQUITY) return false;
  if (rawSector) {
    try {
      if (getScreenerAdjustment(normalizeSector(rawSector)).mode === "exclude") return false;
    } catch {
      // unmapped sector string -- fall through to the plain PEG+debt result
    }
  }
  return true;
}
