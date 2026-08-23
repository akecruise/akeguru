// Pure, DB-free scoring functions — the refresh job (or a future test suite) supplies the
// data; nothing in here talks to Postgres or Yahoo directly.

export const MIN_COHORT_SIZE = 10;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export interface FinancialHistoryPoint {
  fiscalDateEnding: Date;
  revenue: number | null;
  netIncome: number | null;
  eps: number | null;
  totalEquity: number | null;
}

export interface PriceHistoryPoint {
  date: Date;
  close: number;
}

export interface ScorableStock {
  id: string;
  peRatio: number | null;
  pbRatio: number | null;
  evToEbitda: number | null;
  psRatio: number | null;
  estEarningsGrowth: number | null;
  estRevenueGrowth: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  interestCoverage: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  financialHistory: FinancialHistoryPoint[];
  priceHistory: PriceHistoryPoint[];
}

export interface MetricDetail {
  value: number;
  percentile: number;
}

export interface DimensionDetail {
  availableCount: number;
  totalCount: number;
}

export interface RawMetrics {
  metrics: Record<string, MetricDetail>;
  dimensions: Record<string, DimensionDetail>;
}

export interface ScoreResult {
  valueScore: number | null;
  futureScore: number | null;
  pastScore: number | null;
  healthScore: number | null;
  dividendScore: number | null;
  momentumScore: number | null;
  overallScore: number | null;
  rawMetrics: RawMetrics;
}

// ---------------------------------------------------------------------------
// Derived per-stock metrics (not plain DB columns)
// ---------------------------------------------------------------------------

/** CAGR between the earliest and latest annual figures available (needs >= 2 years). Null if the base value isn't a valid CAGR denominator (<= 0). */
function cagr(history: FinancialHistoryPoint[], pick: (p: FinancialHistoryPoint) => number | null): number | null {
  const points = history
    .map((p) => ({ date: p.fiscalDateEnding, value: pick(p) }))
    .filter((p): p is { date: Date; value: number } => p.value != null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first.value <= 0) return null;
  const years = (last.date.getTime() - first.date.getTime()) / MS_PER_YEAR;
  if (years < 1) return null;
  return Math.pow(last.value / first.value, 1 / years) - 1;
}

function avgRoe(history: FinancialHistoryPoint[]): number | null {
  const roes = history
    .filter((p) => p.netIncome != null && p.totalEquity != null && p.totalEquity > 0)
    .map((p) => p.netIncome! / p.totalEquity!);
  if (roes.length === 0) return null;
  return roes.reduce((a, b) => a + b, 0) / roes.length;
}

/** Closest price point to `daysAgo` days before the latest point, within a loose tolerance window. */
function priceReturn(history: PriceHistoryPoint[], daysAgo: number): number | null {
  if (history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.date.getTime() - b.date.getTime());
  const latest = sorted[sorted.length - 1];
  const targetTime = latest.date.getTime() - daysAgo * 24 * 60 * 60 * 1000;
  const tolerance = 10 * 24 * 60 * 60 * 1000; // weekly data — allow +/-10 days

  let closest: PriceHistoryPoint | null = null;
  let closestDiff = Infinity;
  for (const p of sorted) {
    const diff = Math.abs(p.date.getTime() - targetTime);
    if (diff < closestDiff) {
      closest = p;
      closestDiff = diff;
    }
  }
  if (!closest || closestDiff > tolerance || closest.close <= 0 || closest === latest) return null;
  return latest.close / closest.close - 1;
}

export function deriveMetrics(stock: ScorableStock) {
  return {
    revenueCagr3y: cagr(stock.financialHistory, (p) => p.revenue),
    epsCagr3y: cagr(stock.financialHistory, (p) => p.eps),
    avgRoe3y: avgRoe(stock.financialHistory),
    return3m: priceReturn(stock.priceHistory, 91),
    return6m: priceReturn(stock.priceHistory, 182),
    return12m: priceReturn(stock.priceHistory, 365),
  };
}

// ---------------------------------------------------------------------------
// Percentile machinery
// ---------------------------------------------------------------------------

interface MetricSpec {
  key: string;
  invert?: boolean; // "lower is better" — P/E, P/B, EV/EBITDA, D/E
  getValue: (s: ScorableStock, derived: ReturnType<typeof deriveMetrics>) => number | null;
}

const VALUE_METRICS: MetricSpec[] = [
  { key: "peRatio", invert: true, getValue: (s) => s.peRatio },
  { key: "pbRatio", invert: true, getValue: (s) => s.pbRatio },
  { key: "evToEbitda", invert: true, getValue: (s) => s.evToEbitda },
  { key: "psRatio", invert: true, getValue: (s) => s.psRatio },
];

const FUTURE_METRICS: MetricSpec[] = [
  { key: "estEarningsGrowth", getValue: (s) => s.estEarningsGrowth },
  { key: "estRevenueGrowth", getValue: (s) => s.estRevenueGrowth },
];

const PAST_METRICS: MetricSpec[] = [
  { key: "revenueCagr3y", getValue: (_s, d) => d.revenueCagr3y },
  { key: "epsCagr3y", getValue: (_s, d) => d.epsCagr3y },
  { key: "avgRoe3y", getValue: (_s, d) => d.avgRoe3y },
];

const HEALTH_METRICS: MetricSpec[] = [
  { key: "debtToEquity", invert: true, getValue: (s) => s.debtToEquity },
  { key: "currentRatio", getValue: (s) => s.currentRatio },
  { key: "interestCoverage", getValue: (s) => s.interestCoverage },
];

const DIVIDEND_YIELD_METRIC: MetricSpec = { key: "dividendYield", getValue: (s) => s.dividendYield };

const MOMENTUM_METRICS: MetricSpec[] = [
  { key: "return3m", getValue: (_s, d) => d.return3m },
  { key: "return6m", getValue: (_s, d) => d.return6m },
  { key: "return12m", getValue: (_s, d) => d.return12m },
];

/** percentile = share of the cohort with a value <= this one, in [0, 100]. */
function percentileOf(value: number, sortedValues: number[]): number {
  let countLte = 0;
  for (const v of sortedValues) if (v <= value) countLte++;
  return (countLte / sortedValues.length) * 100;
}

function payoutRatioBandScore(ratio: number): number {
  if (ratio < 0 || ratio > 1) return 0; // negative earnings, or paying out more than earned
  if (ratio >= 0.2 && ratio <= 0.75) return 5; // healthy range
  if (ratio < 0.2) return 3 + (ratio / 0.2) * 2; // 0% -> 3, 20% -> 5
  return 5 - ((ratio - 0.75) / 0.25) * 4; // 75% -> 5, 100% -> 1
}

/**
 * Scores one market cohort (already filtered to a single Market by the caller — TH, US, and HK
 * are never percentile-ranked against each other). Metrics with fewer than MIN_COHORT_SIZE
 * non-null values across the whole cohort are dropped for every stock, not just flagged per-stock.
 */
export function scoreCohort(stocks: ScorableStock[]): Map<string, ScoreResult> {
  const derivedByStock = new Map(stocks.map((s) => [s.id, deriveMetrics(s)]));

  function percentileLookup(spec: MetricSpec): Map<string, number> | null {
    const values: Array<{ id: string; value: number }> = [];
    for (const s of stocks) {
      const v = spec.getValue(s, derivedByStock.get(s.id)!);
      if (v != null && Number.isFinite(v)) values.push({ id: s.id, value: v });
    }
    if (values.length < MIN_COHORT_SIZE) return null;
    const sorted = values.map((v) => v.value).sort((a, b) => a - b);
    const lookup = new Map<string, number>();
    for (const { id, value } of values) {
      const pct = percentileOf(value, sorted);
      lookup.set(id, spec.invert ? 100 - pct : pct);
    }
    return lookup;
  }

  function dimensionScores(specs: MetricSpec[]) {
    const lookups = specs.map((spec) => ({ spec, lookup: percentileLookup(spec) }));
    const totalCount = specs.length;
    return (stockId: string, s: ScorableStock, derived: ReturnType<typeof deriveMetrics>) => {
      const subScores: number[] = [];
      const metricDetails: Record<string, MetricDetail> = {};
      let availableCount = 0;
      for (const { spec, lookup } of lookups) {
        if (!lookup) continue; // metric dropped cohort-wide (MIN_COHORT_SIZE)
        const value = spec.getValue(s, derived);
        const percentile = lookup.get(stockId);
        if (value == null || percentile == null) continue;
        availableCount++;
        subScores.push(percentile / 20);
        metricDetails[spec.key] = { value, percentile };
      }
      const score = subScores.length > 0 ? subScores.reduce((a, b) => a + b, 0) / subScores.length : null;
      return { score, metricDetails, dimension: { availableCount, totalCount } };
    };
  }

  const valueDim = dimensionScores(VALUE_METRICS);
  const futureDim = dimensionScores(FUTURE_METRICS);
  const pastDim = dimensionScores(PAST_METRICS);
  const healthDim = dimensionScores(HEALTH_METRICS);
  const momentumDim = dimensionScores(MOMENTUM_METRICS);
  const yieldLookup = percentileLookup(DIVIDEND_YIELD_METRIC);

  const results = new Map<string, ScoreResult>();

  for (const s of stocks) {
    const derived = derivedByStock.get(s.id)!;
    const value = valueDim(s.id, s, derived);
    const future = futureDim(s.id, s, derived);
    const past = pastDim(s.id, s, derived);
    const health = healthDim(s.id, s, derived);
    const momentum = momentumDim(s.id, s, derived);

    // Dividend: yield percentile + a rule-based payout-ratio band, not a second percentile.
    // dividendYield is written as 0 (not null) at ingestion for confirmed non-payers, so this
    // needs no special "missing vs. zero" case — a non-payer's real value is 0 and it ranks
    // at the bottom of the yield percentile naturally.
    const dividendMetrics: Record<string, MetricDetail> = {};
    const dividendSubScores: number[] = [];
    let dividendAvailable = 0;
    if (yieldLookup) {
      const yieldPct = yieldLookup.get(s.id);
      if (s.dividendYield != null && yieldPct != null) {
        dividendAvailable++;
        dividendSubScores.push(yieldPct / 20);
        dividendMetrics.dividendYield = { value: s.dividendYield, percentile: yieldPct };
      }
    }
    if (s.payoutRatio != null) {
      dividendAvailable++;
      const bandScore = payoutRatioBandScore(s.payoutRatio);
      dividendSubScores.push(bandScore);
      dividendMetrics.payoutRatio = { value: s.payoutRatio, percentile: (bandScore / 5) * 100 };
    }
    const dividendScore = dividendSubScores.length > 0
      ? dividendSubScores.reduce((a, b) => a + b, 0) / dividendSubScores.length
      : null;

    const dims = [value.score, future.score, past.score, health.score, dividendScore];
    const availableDims = dims.filter((d): d is number => d != null);
    const overallScore = availableDims.length > 0
      ? (availableDims.reduce((a, b) => a + b, 0) / (availableDims.length * 5)) * 100
      : null;

    results.set(s.id, {
      valueScore: value.score,
      futureScore: future.score,
      pastScore: past.score,
      healthScore: health.score,
      dividendScore,
      momentumScore: momentum.score,
      overallScore,
      rawMetrics: {
        metrics: {
          ...value.metricDetails,
          ...future.metricDetails,
          ...past.metricDetails,
          ...health.metricDetails,
          ...dividendMetrics,
          ...momentum.metricDetails,
        },
        dimensions: {
          value: value.dimension,
          future: future.dimension,
          past: past.dimension,
          health: health.dimension,
          dividend: { availableCount: dividendAvailable, totalCount: 2 },
          momentum: momentum.dimension,
        },
      },
    });
  }

  return results;
}
