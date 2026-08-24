/**
 * Data Quality Layer -- staleness + outlier checks over FinancialFact, surfaced to agents as
 * advisory context (via FinancialFact.dataFriction + a live staleness check at read time), not a
 * blocking gate. Promoting either check to a hard Gate 8 is a real option later, once real report
 * volume shows how often each actually fires -- rejecting a report on a first-pass threshold guess
 * risks false-positive rejections (e.g. a bank's negative P/E is often a real, valid data point,
 * not a data error) more than it protects anything today.
 *
 * ---- Missing-data policy (the fourth ask, "skip vs impute") ----
 * This pipeline never imputes a missing value -- no mean/median/sector-average fill-in, no
 * carrying a stale prior forward relabeled as current. A missing field is `null`, everywhere,
 * always, and every consumer must treat `null` as "skip this input" (exclude from a ratio/rank/
 * screen), never as `0` or a guessed estimate -- an imputed number is fabricated precision with
 * exactly the same failure mode this session has rejected repeatedly (Kelly sizing, ROIC/EBIT
 * proxies, etc.): it *looks* like real data once it's on the page.
 * Two kinds of documented exception exist, and both are about a *number the pipeline computes*,
 * not about a stored fact:
 *   - `Stock.dividendYield = 0` means the provider *confirmed* no dividend -- a real, known fact,
 *     not "unknown" (which is what `null` means there). `lib/neff.ts` inherits this and treats a
 *     null yield as 0 too, documented in that file as "undercounting a possibly-real yield," not
 *     fabricating one.
 *   - `lib/ranking.ts`'s weighted blend gives a stock missing one scored component (e.g. no
 *     momentum score yet) 0 *credit for that component* rather than excluding the stock from the
 *     ranking entirely -- a deliberate scoring-weight default for a specific ranking function, not
 *     a claim that the underlying metric's real value is zero.
 * An unexplained `?? 0` anywhere else on a field that can be genuinely unknown is the actual
 * policy violation worth treating as a bug -- audited at data-quality.ts's introduction (2026-08-24)
 * and found clean beyond the two cases above.
 */

// ---------- Staleness (checked at read time, not stored -- see this file's header) ----------

// A quarterly filing is only ~90 days apart from the next one; 90 days is "no newer filing should
// plausibly exist yet without us having caught it." Doesn't know each company's actual fiscal
// calendar (a real refinement for later) -- flags purely on "how long since we last looked."
export const STALE_FACT_MAX_AGE_DAYS = 90;

export function isFactStale(extractedAt: Date, now: Date = new Date(), maxAgeDays = STALE_FACT_MAX_AGE_DAYS): boolean {
  const ageDays = (now.getTime() - extractedAt.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > maxAgeDays;
}

export function factAgeDays(extractedAt: Date, now: Date = new Date()): number {
  return Math.round((now.getTime() - extractedAt.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------- Outlier detection (checked at ingest time, written into FinancialFact.dataFriction) ----------

// Valuation multiples where a negative value isn't a real signal, just an undefined ratio (the
// denominator -- earnings/EBITDA -- went negative). Deliberately narrow: raw dollar figures
// (Revenue, Net Income, FCF, EPS...) can legitimately be negative and that IS the real signal, so
// this set only covers price-relative *multiples* where negative means "not a valid multiple,"
// not "the underlying business had a bad year." P/B is deliberately excluded -- a negative P/B
// (negative equity) is itself informative, not a meaningless ratio the way negative P/E is.
export const INVALID_IF_NEGATIVE_RATIOS = new Set(["P/E", "EV/EBITDA", "EV/Sales"]);

export function isNegativeRatioOutlier(metricName: string, value: number): boolean {
  return INVALID_IF_NEGATIVE_RATIOS.has(metricName) && value < 0;
}

// A YoY-style change this large is almost always a base-effect artifact (a metric that was near
// zero last period makes any absolute move read as a huge percentage) rather than real operating
// performance -- flagged so an agent doesn't cite "+5000% growth" as a bull point at face value.
export const YOY_OUTLIER_THRESHOLD_PCT = 300;

// Only raw, absolute-dollar figures get the YoY check -- a ratio/margin/growth-rate metric
// (P/E, ROE, "Revenue Growth" itself, ...) is already normalized, and a big swing there isn't the
// same base-effect artifact a near-zero-denominator absolute figure produces. Scoped to the
// Yahoo-sourced metricNames that are genuinely absolute currency figures (see
// lib/data/input-sources/router.ts's YAHOO_FIELD_MAP).
export const YOY_ELIGIBLE_METRICS = new Set(["Revenue", "Cash", "Total Debt", "FCF", "CFO", "Market Cap", "EV"]);

/** priorValue/currentValue are the same metricName for the same ticker, consecutive periods --
 *  caller resolves "which prior" (this file has no DB access, see scripts/ingest.ts). */
export function isYoyOutlier(priorValue: number, currentValue: number): boolean {
  if (priorValue === 0) return currentValue !== 0; // any move off a literal zero base is an undefined (infinite) percentage
  const pctChange = ((currentValue - priorValue) / Math.abs(priorValue)) * 100;
  return Math.abs(pctChange) >= YOY_OUTLIER_THRESHOLD_PCT;
}

/** Combines whichever outlier checks apply to one fact being written -- returns the dataFriction
 *  string to store, or null if nothing fired. `priorValue` is optional (only metrics with a real
 *  prior-period row to compare against get the YoY check; a first-ever ingest for a ticker has
 *  nothing to compare, which is a real "no prior data," not an outlier). */
export function detectOutlierFriction(metricName: string, value: number, priorValue: number | null): string | null {
  const flags: string[] = [];
  if (isNegativeRatioOutlier(metricName, value)) flags.push("negative-ratio");
  if (priorValue != null && YOY_ELIGIBLE_METRICS.has(metricName) && isYoyOutlier(priorValue, value)) flags.push("yoy-outlier");
  return flags.length ? flags.join(",") : null;
}
