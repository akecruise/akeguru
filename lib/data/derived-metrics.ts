/**
 * Derived metrics (Phase 2) — FCF Margin, Net Debt, ROIC, CAGR.
 *
 * Pure functions over already-ingested FinancialFact-shaped rows for one ticker — no network,
 * no AI, no DB writes (0 token, matching scripts/ingest.ts). These are NOT persisted back to
 * FinancialFact: a derived value doesn't have a single RawSource of its own (it's computed FROM
 * other facts, not extracted from a document), and FinancialFact.rawSourceId is a required FK —
 * inventing one would misrepresent where the number came from. Callers (ingest.ts, future report
 * agents) compute these on demand from facts that are already traceable.
 *
 * Sources disagree on metric names AND on what "period" means: Yahoo/th.ts use friendly labels
 * ('Revenue', 'Cash') and router.ts stamps every Yahoo fact with today's date (it's a live
 * snapshot, not a filing) — while sec.ts uses raw us-gaap XBRL tag names verbatim
 * ('StockholdersEquity') stamped with the actual fiscal-period-end date. A formula that combines
 * several inputs (ROIC, FCF Margin) MUST resolve every input from the *same* source: picking each
 * input independently (e.g. equity from SEC's last fiscal year-end but cash from Yahoo's snapshot
 * from 7 weeks later) silently blends two different points in time into one number. Confirmed as
 * a real bug against live MSFT data during Phase 2 dev (ROIC computed 31.4% by mixing a
 * 2026-06-30 SEC balance sheet with a 2026-08-19 Yahoo snapshot) before this file resolved inputs
 * per-source-bundle instead of per-field.
 */

export interface FactPoint {
  metricName: string;
  value: number;
  period: string; // ISO date string, e.g. '2025-12-31'
}

export interface DerivedMetric {
  name: string;
  value: number | null;
  unit: 'x' | '%' | 'currency';
  period: string | null;
  formula: string;
  /** set when value is null — which required inputs were missing */
  missing?: string[];
}

interface SourceFieldNames {
  label: string;
  revenue: string[];
  operatingIncome: string[];
  totalEquity: string[];
  // SEC's CORE_METRICS only tracks the long-term piece — a SEC-sourced Net Debt/ROIC will
  // understate debt by excluding short-term/current debt. Yahoo's 'Total Debt' is complete.
  // Documented here rather than silently treated as equivalent to the SEC figure.
  totalDebt: string[];
  cash: string[];
  cfo: string[];
  capex: string[];
  fcf: string[];
}

/** One "source bundle" = field names that are guaranteed to share the same period when present together. */
const SOURCES: SourceFieldNames[] = [
  {
    label: 'yahoo/th',
    revenue: ['Revenue'],
    operatingIncome: ['Operating Income'],
    totalEquity: ['Equity'],
    totalDebt: ['Total Debt'],
    cash: ['Cash'],
    cfo: ['CFO'],
    capex: [],
    fcf: ['FCF'],
  },
  {
    label: 'sec',
    revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    operatingIncome: ['OperatingIncomeLoss'],
    totalEquity: ['StockholdersEquity'],
    totalDebt: ['LongTermDebtNoncurrent'],
    cash: ['CashAndCashEquivalentsAtCarryingValue'],
    cfo: ['NetCashProvidedByUsedInOperatingActivities'],
    capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
    fcf: [],
  },
];

/** latest value among these alias names, restricted to one exact period if given */
function valueAt(facts: FactPoint[], names: string[], period?: string): FactPoint | undefined {
  const matches = facts.filter((f) => names.includes(f.metricName) && (period === undefined || f.period === period));
  return matches.sort((a, b) => b.period.localeCompare(a.period))[0];
}

/** distinct periods available for a field within one source, newest first */
function periodsFor(facts: FactPoint[], names: string[]): string[] {
  return [...new Set(facts.filter((f) => names.includes(f.metricName)).map((f) => f.period))].sort((a, b) =>
    b.localeCompare(a)
  );
}

/**
 * Try each source in turn; within a source, use the newest period where ALL requested fields
 * are simultaneously present. Returns the first fully-satisfied source (never mixes sources).
 */
function resolveFromOneSource(
  facts: FactPoint[],
  fields: (keyof Omit<SourceFieldNames, 'label'>)[]
): { values: Partial<Record<string, FactPoint>>; period: string; source: string } | { missing: string[] } {
  for (const source of SOURCES) {
    for (const period of periodsFor(facts, source[fields[0]])) {
      const values: Partial<Record<string, FactPoint>> = {};
      let complete = true;
      for (const field of fields) {
        const v = valueAt(facts, source[field], period);
        if (!v) {
          complete = false;
          break;
        }
        values[field] = v;
      }
      if (complete) return { values, period, source: source.label };
    }
  }
  return { missing: fields as string[] };
}

export function computeFcfMargin(facts: FactPoint[]): DerivedMetric {
  const direct = resolveFromOneSource(facts, ['revenue', 'fcf']);
  if ('values' in direct) {
    return {
      name: 'FCF Margin',
      value: (direct.values.fcf!.value / direct.values.revenue!.value) * 100,
      unit: '%',
      period: direct.period,
      formula: 'FCF / Revenue',
    };
  }

  // no source gives FCF directly (SEC/th.ts don't) — derive it as CFO - Capex, same-source
  const viaCfo = resolveFromOneSource(facts, ['revenue', 'cfo', 'capex']);
  if ('values' in viaCfo) {
    const fcf = viaCfo.values.cfo!.value - viaCfo.values.capex!.value;
    return {
      name: 'FCF Margin',
      value: (fcf / viaCfo.values.revenue!.value) * 100,
      unit: '%',
      period: viaCfo.period,
      formula: 'FCF / Revenue (FCF derived: CFO - Capex)',
    };
  }

  return { name: 'FCF Margin', value: null, unit: '%', period: null, formula: 'FCF / Revenue', missing: direct.missing };
}

export function computeNetDebt(facts: FactPoint[]): DerivedMetric {
  const r = resolveFromOneSource(facts, ['totalDebt', 'cash']);
  if (!('values' in r)) {
    return { name: 'Net Debt', value: null, unit: 'currency', period: null, formula: 'Total Debt - Cash', missing: r.missing };
  }
  return {
    name: 'Net Debt',
    value: r.values.totalDebt!.value - r.values.cash!.value,
    unit: 'currency',
    period: r.period,
    formula: 'Total Debt - Cash',
  };
}

/**
 * Pre-tax ROIC: EBIT / (Total Debt + Total Equity - Cash).
 * Named "pre-tax" deliberately — none of the current sources expose income tax expense or
 * pretax income, so a true NOPAT-based (post-tax) ROIC isn't honestly computable. Assuming a
 * tax rate would fabricate precision the data doesn't support; returning null is the alternative
 * to that, not this pre-tax approximation — this metric is reported as what it actually is.
 */
export function computeRoicPretax(facts: FactPoint[]): DerivedMetric {
  const r = resolveFromOneSource(facts, ['operatingIncome', 'totalEquity', 'totalDebt', 'cash']);
  const formula = 'EBIT / (Total Debt + Total Equity - Cash)';
  if (!('values' in r)) {
    return { name: 'ROIC (pre-tax)', value: null, unit: '%', period: null, formula, missing: r.missing };
  }
  const investedCapital = r.values.totalDebt!.value + r.values.totalEquity!.value - r.values.cash!.value;
  if (investedCapital <= 0) {
    return { name: 'ROIC (pre-tax)', value: null, unit: '%', period: r.period, formula, missing: ['investedCapital<=0'] };
  }
  return {
    name: 'ROIC (pre-tax)',
    value: (r.values.operatingIncome!.value / investedCapital) * 100,
    unit: '%',
    period: r.period,
    formula,
  };
}

/**
 * CAGR of `metric` between the earliest and latest period actually present in `facts` — never
 * interpolated or assumed. Needs >= 2 distinct periods (within one source — see module comment)
 * and a positive starting value (a CAGR off a negative/zero base is mathematically undefined, not
 * just inconvenient). Only SEC/th.ts facts carry multiple periods per ticker — router.ts's Yahoo
 * snapshot is always a single "today" period, so CAGR is never computable from Yahoo-only coverage.
 */
export function computeCagr(facts: FactPoint[], metric: 'revenue' | 'operatingIncome' = 'revenue'): DerivedMetric {
  const label = `${metric === 'revenue' ? 'Revenue' : 'Operating Income'} CAGR`;
  const formula = '(end/start)^(1/years) - 1';

  // A source with a degenerate result (e.g. Yahoo's "period" is always today's date, so two
  // ingest runs on the same day collide into one distinct period) must not shadow a later source
  // that has a genuine multi-year series — only return early on an actual valid computation.
  for (const source of SOURCES) {
    const distinctPeriods = periodsFor(facts, source[metric]).sort(); // oldest first
    if (distinctPeriods.length < 2) continue;

    const startPeriod = distinctPeriods[0];
    const endPeriod = distinctPeriods[distinctPeriods.length - 1];
    const start = valueAt(facts, source[metric], startPeriod)!;
    const end = valueAt(facts, source[metric], endPeriod)!;
    const years = (new Date(endPeriod).getTime() - new Date(startPeriod).getTime()) / (365.25 * 24 * 60 * 60 * 1000);

    if (start.value <= 0 || years <= 0) continue;

    return {
      name: label,
      value: (Math.pow(end.value / start.value, 1 / years) - 1) * 100,
      unit: '%',
      period: `${startPeriod}..${endPeriod}`,
      formula,
    };
  }
  return { name: label, value: null, unit: '%', period: null, formula, missing: ['no source has >=2 valid distinct periods'] };
}

export function computeAllDerivedMetrics(facts: FactPoint[]): DerivedMetric[] {
  return [computeFcfMargin(facts), computeNetDebt(facts), computeRoicPretax(facts), computeCagr(facts, 'revenue')];
}
