/**
 * Phase 2 smoke test for lib/data/derived-metrics.ts — no DB, no network.
 *   npx tsx scripts/test-derived-metrics.ts
 */
import { computeFcfMargin, computeNetDebt, computeRoicPretax, computeCagr, type FactPoint } from "../lib/data/derived-metrics";

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${label.padEnd(28)} ${pass ? "PASS ✓" : "FAIL ✗"}${pass ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}

// 1. FCF Margin — direct Yahoo-style FCF fact
const yahooLike: FactPoint[] = [
  { metricName: "Revenue", value: 1000, period: "2026-08-19" },
  { metricName: "FCF", value: 250, period: "2026-08-19" },
];
check("FCF Margin (direct)", Math.round(computeFcfMargin(yahooLike).value!), 25);

// 2. FCF Margin — derived from CFO - Capex (SEC-style)
const secLike: FactPoint[] = [
  { metricName: "Revenues", value: 2000, period: "2025-12-31" },
  { metricName: "NetCashProvidedByUsedInOperatingActivities", value: 600, period: "2025-12-31" },
  { metricName: "PaymentsToAcquirePropertyPlantAndEquipment", value: 100, period: "2025-12-31" },
];
check("FCF Margin (CFO-Capex)", Math.round(computeFcfMargin(secLike).value!), 25);

// 3. FCF Margin — missing revenue -> null with a reason
const noRevenue: FactPoint[] = [{ metricName: "FCF", value: 250, period: "2026-08-19" }];
check("FCF Margin (missing revenue)", computeFcfMargin(noRevenue).value, null);
console.log("  missing reason:", computeFcfMargin(noRevenue).missing);

// 4. Net Debt
const netDebtFacts: FactPoint[] = [
  { metricName: "Total Debt", value: 500, period: "2026-08-19" },
  { metricName: "Cash", value: 120, period: "2026-08-19" },
];
check("Net Debt", computeNetDebt(netDebtFacts).value, 380);

// 5. ROIC (pre-tax) — all inputs present
const roicFacts: FactPoint[] = [
  { metricName: "OperatingIncomeLoss", value: 300, period: "2025-12-31" },
  { metricName: "StockholdersEquity", value: 1000, period: "2025-12-31" },
  { metricName: "LongTermDebtNoncurrent", value: 400, period: "2025-12-31" },
  { metricName: "CashAndCashEquivalentsAtCarryingValue", value: 200, period: "2025-12-31" },
];
// investedCapital = 400 + 1000 - 200 = 1200; ROIC = 300/1200 = 25%
check("ROIC pre-tax", Math.round(computeRoicPretax(roicFacts).value!), 25);

// 6. ROIC — negative invested capital -> null, not a nonsensical negative/huge %
const negativeIC: FactPoint[] = [
  { metricName: "Operating Income", value: 300, period: "2025-12-31" },
  { metricName: "Equity", value: 100, period: "2025-12-31" },
  { metricName: "Total Debt", value: 50, period: "2025-12-31" },
  { metricName: "Cash", value: 500, period: "2025-12-31" }, // debt+equity-cash = -350
];
check("ROIC (invested capital<=0)", computeRoicPretax(negativeIC).value, null);

// 7. CAGR — two real periods, positive growth
const revenueSeries: FactPoint[] = [
  { metricName: "Revenues", value: 1000, period: "2021-12-31" },
  { metricName: "Revenues", value: 1000, period: "2022-12-31" },
  { metricName: "Revenues", value: 1210, period: "2023-12-31" },
];
// 1000 -> 1210 over 2 years = 10% CAGR
check("Revenue CAGR", Math.round(computeCagr(revenueSeries, "revenue").value!), 10);

// 8. CAGR — only one period -> null
const singlePeriod: FactPoint[] = [{ metricName: "Revenue", value: 1000, period: "2026-08-19" }];
check("CAGR (single period)", computeCagr(singlePeriod, "revenue").value, null);

// 9. CAGR — negative starting value -> null, not a fabricated/complex-number result
const negativeStart: FactPoint[] = [
  { metricName: "Revenue", value: -100, period: "2021-12-31" },
  { metricName: "Revenue", value: 500, period: "2023-12-31" },
];
check("CAGR (negative start)", computeCagr(negativeStart, "revenue").value, null);

console.log("\ndone.");
