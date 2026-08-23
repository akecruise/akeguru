/**
 * Permanent regression test for lib/agents/grounding.ts — no network, no DB, runs in ms.
 * Run this every time runner.ts or grounding.ts changes.
 *
 *   npx tsx scripts/test-grounding.ts
 *
 * Case 1 is the ACTUAL output qwen3:8b produced against real MSFT FinancialFact rows on
 * 2026-08-19 (see scripts/test-valuation-agent.ts) — it passed zod (schema-valid shape) but
 * fabricated all 18 factIds ("1".."18") and every value (e.g. Market Cap "12000000000" vs
 * MSFT's real ~3.5T). This is kept verbatim as evidence the DB-existence check actually catches
 * wholesale hallucination, not just a hypothetical.
 */
import { checkGrounding, checkBulletGrounding, checkMoatGrounding, checkClaimGrounding, checkStockReportGrounding, collectReportFactIds, type RealFact } from "../lib/agents/grounding";
import type { Fundamentals, BulletItem, MoatItem, ClaimItem, StockReport } from "../lib/report/types";

function check(label: string, actual: boolean, expected: boolean) {
  const pass = actual === expected;
  console.log(`${label.padEnd(45)} ${pass ? "PASS ✓" : "FAIL ✗"} (ok=${actual})`);
  if (!pass) process.exitCode = 1;
}

// ---------- Case 1: real qwen3:8b hallucination (captured verbatim) ----------

const QWEN_HALLUCINATION: Fundamentals = {
  profile: {
    label: "Profile",
    metrics: [
      { name: "Market Cap", value: 12000000000, unit: "currency", factId: "1" },
      { name: "EV", value: 14500000000, unit: "currency", factId: "2" },
      { name: "Shares Outstanding", value: 100000000, unit: "count", factId: "3" },
    ],
  },
  margins: {
    label: "Margins",
    metrics: [
      { name: "Gross Margin", value: 0.45, unit: "raw", factId: "4" },
      { name: "Operating Margin", value: 0.22, unit: "raw", factId: "5" },
      { name: "EBITDA Margin", value: 0.31, unit: "raw", factId: "6" },
      { name: "Net Margin", value: 0.18, unit: "raw", factId: "7" },
    ],
  },
  returns: {
    label: "Returns",
    metrics: [
      { name: "ROE", value: 0.25, unit: "raw", factId: "8" },
      { name: "ROA", value: 0.15, unit: "raw", factId: "9" },
    ],
  },
  valuationTTM: {
    label: "Valuation (TTM)",
    metrics: [
      { name: "P/E", value: 15, unit: "x", factId: "10" },
      { name: "P/B", value: 2.8, unit: "x", factId: "11" },
      { name: "EV/EBITDA", value: 12, unit: "x", factId: "12" },
      { name: "EV/Sales", value: 4.5, unit: "x", factId: "13" },
    ],
  },
  valuationNTM: null,
  financialHealth: {
    label: "Financial Health",
    metrics: [
      { name: "Debt/Equity", value: 0.85, unit: "x", factId: "14" },
      { name: "Current Ratio", value: 1.5, unit: "x", factId: "15" },
      { name: "Net Debt", value: 1800000000, unit: "currency", factId: "16" },
    ],
  },
  growth: {
    label: "Growth",
    metrics: [
      { name: "Revenue Growth", value: 0.12, unit: "raw", factId: "17" },
      { name: "Earnings Growth", value: 0.25, unit: "raw", factId: "18" },
    ],
  },
  dividends: null,
};

// the real MSFT facts that were actually in the DB at the time — none of the ids above ("1".."18") exist among them
const REAL_MSFT_FACTS: RealFact[] = [
  { id: "cmt022hm400016swkilv101s6", metricName: "P/E", value: 26.742365, unit: "x" },
  { id: "cmt022hm400026swk568xm78u", metricName: "P/B", value: 8.085789, unit: "x" },
  { id: "cmt022hm400036swkezv3e8pv", metricName: "EV/EBITDA", value: 18.68, unit: "x" },
  { id: "cmt022hm400046swkqcnd1gmu", metricName: "EV/Sales", value: 10.934, unit: "x" },
];

{
  const result = checkGrounding(QWEN_HALLUCINATION, REAL_MSFT_FACTS);
  check("1. real qwen3:8b hallucination -> caught", result.ok, false);
  const unknownCount = result.issues.filter((i) => i.reason === "unknown-factId").length;
  console.log(`   ${unknownCount}/18 flagged unknown-factId (expect 18)`);
  if (unknownCount !== 18) process.exitCode = 1;
}

// ---------- Case 2: well-grounded output -> should pass ----------

const WELL_GROUNDED: Fundamentals = {
  profile: { label: "Profile", metrics: [] },
  margins: { label: "Margins", metrics: [] },
  returns: { label: "Returns", metrics: [] },
  valuationTTM: {
    label: "Valuation (TTM)",
    metrics: [{ name: "P/E", value: 26.742365, unit: "x", factId: "cmt022hm400016swkilv101s6" }],
  },
  valuationNTM: null,
  financialHealth: { label: "Financial Health", metrics: [] },
  growth: { label: "Growth", metrics: [] },
  dividends: null,
};

{
  const result = checkGrounding(WELL_GROUNDED, REAL_MSFT_FACTS);
  check("2. correctly grounded output -> passes", result.ok, true);
}

// ---------- Case 3: borrowed factId, value copied verbatim, wrong label ----------
// This is the scenario the user specifically asked check #4 for: agent cites a REAL factId and
// copies its REAL value (so check #2 "exists" and check #3 "value matches" both pass), but
// mislabels which metric it is. Only the metricName check catches this.

const BORROWED_FACT_WRONG_LABEL: Fundamentals = {
  profile: { label: "Profile", metrics: [] },
  margins: {
    label: "Margins",
    // cites P/B's real factId+value but claims it's "Net Margin" — a completely different metric
    metrics: [{ name: "Net Margin", value: 8.085789, unit: "%", factId: "cmt022hm400026swk568xm78u" }],
  },
  returns: { label: "Returns", metrics: [] },
  valuationTTM: { label: "Valuation (TTM)", metrics: [] },
  valuationNTM: null,
  financialHealth: { label: "Financial Health", metrics: [] },
  growth: { label: "Growth", metrics: [] },
  dividends: null,
};

{
  const result = checkGrounding(BORROWED_FACT_WRONG_LABEL, REAL_MSFT_FACTS);
  check("3. borrowed factId + wrong label -> caught", result.ok, false);
  const isMetricNameIssue = result.issues.length === 1 && result.issues[0].reason === "metricName-mismatch";
  console.log(`   caught via metricName-mismatch specifically: ${isMetricNameIssue ? "yes ✓" : "no ✗ (" + result.issues.map((i) => i.reason).join(",") + ")"}`);
  if (!isMetricNameIssue) process.exitCode = 1;

  // control: verify checks #2 and #3 alone would NOT have caught this (proves #4 adds real coverage)
  const factIdExists = REAL_MSFT_FACTS.some((f) => f.id === "cmt022hm400026swk568xm78u");
  const valueMatches = REAL_MSFT_FACTS.find((f) => f.id === "cmt022hm400026swk568xm78u")!.value === 8.085789;
  console.log(`   (control) factId exists=${factIdExists}, value matches=${valueMatches} — both true, so #2/#3 alone would have PASSED this`);
  if (!factIdExists || !valueMatches) process.exitCode = 1;
}

// ---------- Case 4: legitimate SEC-tag translation should NOT be flagged as a mismatch ----------

const SEC_TRANSLATION: Fundamentals = {
  profile: {
    label: "Profile",
    metrics: [{ name: "Operating Income", value: 155237000000, unit: "currency", factId: "sec-oil-2026" }],
  },
  margins: { label: "Margins", metrics: [] },
  returns: { label: "Returns", metrics: [] },
  valuationTTM: { label: "Valuation (TTM)", metrics: [] },
  valuationNTM: null,
  financialHealth: { label: "Financial Health", metrics: [] },
  growth: { label: "Growth", metrics: [] },
  dividends: null,
};
const SEC_FACTS: RealFact[] = [{ id: "sec-oil-2026", metricName: "OperatingIncomeLoss", value: 155237000000, unit: "currency" }];

{
  const result = checkGrounding(SEC_TRANSLATION, SEC_FACTS);
  check('4. "Operating Income" <-> "OperatingIncomeLoss" -> not a false positive', result.ok, true);
}

// ---------- Case 5: acronym expansion should NOT be flagged — real false positive from Gemini's 1773.HK eval ----------
// Gemini cited FCF's real factId+value but relabeled the metric "Free Cash Flow" (and CFO ->
// "Operating Cash Flow") — correct, sensible relabeling that the pre-acronym-table version of
// namesPlausiblyMatch flagged as metricName-mismatch, since both acronyms are <4 chars and never
// reach the token-overlap check.

const ACRONYM_RELABEL: Fundamentals = {
  profile: {
    label: "Profile",
    metrics: [
      { name: "Free Cash Flow", value: 384922368, unit: "currency", factId: "fcf-1773hk" },
      { name: "Operating Cash Flow", value: 999999999, unit: "currency", factId: "cfo-1773hk" },
    ],
  },
  margins: { label: "Margins", metrics: [] },
  returns: { label: "Returns", metrics: [] },
  valuationTTM: { label: "Valuation (TTM)", metrics: [] },
  valuationNTM: null,
  financialHealth: { label: "Financial Health", metrics: [] },
  growth: { label: "Growth", metrics: [] },
  dividends: null,
};
const ACRONYM_FACTS: RealFact[] = [
  { id: "fcf-1773hk", metricName: "FCF", value: 384922368, unit: "currency" },
  { id: "cfo-1773hk", metricName: "CFO", value: 999999999, unit: "currency" },
];

{
  const result = checkGrounding(ACRONYM_RELABEL, ACRONYM_FACTS);
  check('5. "Free Cash Flow"<->"FCF", "Operating Cash Flow"<->"CFO" -> not a false positive', result.ok, true);
}

// ---------- checkBulletGrounding (risk/moat/business/growth) ----------

const RISK_FACTS: RealFact[] = [
  { id: "cmt-de-msft", metricName: "Debt/Equity", value: 0.47, unit: "x" },
  { id: "cmt-td-msft", metricName: "Total Debt", value: 47000000000, unit: "currency" },
  { id: "cmt-cr-msft", metricName: "Current Ratio", value: 1.27, unit: "x" },
];

// ---------- Case 6: fake supportingFactIds -> caught ----------

const FAKE_FACT_ID_BULLET: BulletItem[] = [
  {
    title: "High Leverage",
    body: "Debt/Equity is elevated for the sector, well above historical norms.",
    example: "For example, a downturn would raise refinancing risk given the elevated leverage.",
    supportingFactIds: ["fake-id-does-not-exist"],
  },
];

{
  const result = checkBulletGrounding(FAKE_FACT_ID_BULLET, RISK_FACTS);
  check("6. fake supportingFactIds -> caught", result.ok, false);
  const isUnknownFactId = result.issues.length === 1 && result.issues[0].reason === "unknown-factId";
  console.log(`   caught via unknown-factId specifically: ${isUnknownFactId ? "yes ✓" : "no ✗ (" + result.issues.map((i) => i.reason).join(",") + ")"}`);
  if (!isUnknownFactId) process.exitCode = 1;
}

// ---------- Case 7: well-grounded bullet, number matches cited fact -> passes ----------

const WELL_GROUNDED_BULLET: BulletItem[] = [
  {
    title: "High Leverage",
    body: "Debt/Equity stands at 0.47x, elevated for the sector, with Total Debt around $47 billion.",
    example: "For example, at a 0.47x Debt/Equity ratio, refinancing the $47 billion of debt at higher rates would materially squeeze free cash flow available for buybacks and dividends.",
    supportingFactIds: ["cmt-de-msft", "cmt-td-msft"],
  },
];

{
  const result = checkBulletGrounding(WELL_GROUNDED_BULLET, RISK_FACTS);
  check("7. well-grounded bullet -> passes", result.ok, true);
}

// ---------- Case 8: real factId cited, but the number stated in prose doesn't match it -> caught ----------
// This is the scenario checkBulletGrounding's number check exists for: a real, correctly-cited
// factId doesn't guarantee the figure written in body/example is the one that fact actually holds.

const FABRICATED_NUMBER_BULLET: BulletItem[] = [
  {
    title: "High Leverage",
    body: "Debt/Equity stands at 1.85x, far above peers.",
    example: "For example, a downturn could force a covenant breach at this leverage level.",
    supportingFactIds: ["cmt-de-msft"], // real factId, but its value is 0.47x, not 1.85x
  },
];

{
  const result = checkBulletGrounding(FABRICATED_NUMBER_BULLET, RISK_FACTS);
  check("8. fabricated number alongside real factId -> caught", result.ok, false);
  const isUnsupportedNumber = result.issues.every((i) => i.reason === "unsupported-number");
  console.log(`   caught via unsupported-number specifically: ${isUnsupportedNumber ? "yes ✓" : "no ✗ (" + result.issues.map((i) => i.reason).join(",") + ")"}`);
  if (!isUnsupportedNumber) process.exitCode = 1;
}

// ---------- Case 9: incidental non-financial numbers (counts, quarters) -> NOT flagged ----------
// Control for false positives: "3 consecutive quarters" has no comma/decimal/%/x/magnitude marker,
// so it shouldn't be treated as a cited figure that needs a supporting fact.

const INCIDENTAL_NUMBER_BULLET: BulletItem[] = [
  {
    title: "Liquidity Tightening",
    body: "Current Ratio has weakened for 3 consecutive quarters, now at 1.27x.",
    example: "For example, a further slip in the ratio would signal working-capital strain.",
    supportingFactIds: ["cmt-cr-msft"],
  },
];

{
  const result = checkBulletGrounding(INCIDENTAL_NUMBER_BULLET, RISK_FACTS);
  check('9. incidental "3 consecutive quarters" -> not a false positive', result.ok, true);
}

// ---------- checkMoatGrounding (moat) ----------

const MOAT_FACTS: RealFact[] = [
  { id: "cmt-gm-msft", metricName: "Gross Margin", value: 68.9, unit: "%" },
  { id: "cmt-rev-msft", metricName: "Revenue", value: 331839012864, unit: "currency" },
];

// ---------- Case 10: qualitative moat type (brand), no number in body -> passes ----------
// Control: proves checkMoatGrounding does NOT require a number to be present — brand has no hard
// number to cite, and body correctly doesn't state one; supportingFactIds still required.

const QUALITATIVE_MOAT: MoatItem[] = [
  {
    type: "brand",
    title: "Enterprise Brand Trust",
    body: "Consistently high and stable gross margins over multiple periods are consistent with pricing power from brand strength rather than pure cost leadership.",
    strength: "moderate",
    supportingFactIds: ["cmt-gm-msft"],
  },
];

{
  const result = checkMoatGrounding(QUALITATIVE_MOAT, MOAT_FACTS);
  check("10. qualitative moat (brand), no number in body -> passes", result.ok, true);
}

// ---------- Case 11: quantitative moat type (scale_economies), number matches -> passes ----------

const QUANTITATIVE_MOAT_OK: MoatItem[] = [
  {
    type: "scale_economies",
    title: "Scale-Driven Margin Advantage",
    body: "Gross Margin of 68.9% on Revenue of 331839012864 reflects cost advantages only reachable at this scale.",
    strength: "strong",
    supportingFactIds: ["cmt-gm-msft", "cmt-rev-msft"],
  },
];

{
  const result = checkMoatGrounding(QUANTITATIVE_MOAT_OK, MOAT_FACTS);
  check("11. quantitative moat (scale_economies), number matches -> passes", result.ok, true);
}

// ---------- Case 12: quantitative moat type, fabricated number -> caught ----------

const QUANTITATIVE_MOAT_FABRICATED: MoatItem[] = [
  {
    type: "scale_economies",
    title: "Scale-Driven Margin Advantage",
    body: "Gross Margin of 95.2% reflects cost advantages only reachable at this scale.",
    strength: "strong",
    supportingFactIds: ["cmt-gm-msft"], // real factId, but its value is 68.9%, not 95.2%
  },
];

{
  const result = checkMoatGrounding(QUANTITATIVE_MOAT_FABRICATED, MOAT_FACTS);
  check("12. quantitative moat, fabricated number -> caught", result.ok, false);
  const isUnsupportedNumber = result.issues.every((i) => i.reason === "unsupported-number");
  console.log(`   caught via unsupported-number specifically: ${isUnsupportedNumber ? "yes ✓" : "no ✗ (" + result.issues.map((i) => i.reason).join(",") + ")"}`);
  if (!isUnsupportedNumber) process.exitCode = 1;
}

// ---------- Case 13: fake supportingFactIds on a moat item -> caught ----------

const FAKE_MOAT_FACT_ID: MoatItem[] = [
  {
    type: "none",
    title: "No Clear Moat",
    body: "Margins show no consistent advantage over peers and no scale or switching-cost dynamics are evident.",
    strength: "weak",
    supportingFactIds: ["fake-moat-fact-id"],
  },
];

{
  const result = checkMoatGrounding(FAKE_MOAT_FACT_ID, MOAT_FACTS);
  check("13. fake supportingFactIds on moat item -> caught", result.ok, false);
  const isUnknownFactId = result.issues.length === 1 && result.issues[0].reason === "unknown-factId";
  console.log(`   caught via unknown-factId specifically: ${isUnknownFactId ? "yes ✓" : "no ✗ (" + result.issues.map((i) => i.reason).join(",") + ")"}`);
  if (!isUnknownFactId) process.exitCode = 1;
}

// ---------- checkClaimGrounding (synthesis agent's bulls/bears) ----------
//
// Case 16 below is the ACTUAL output groq (openai/gpt-oss-20b) produced for 1773.HK's bulls on
// 2026-08-20 (see docs/eval/synthesis.md) — it passed zod under the OLD bulls: string[] schema and
// *looked* well-grounded because every claim had a citation written inline in the prose. Verified
// against the DB by hand: 4 of 5 bulls were wrong (one real factId relabeled as a different metric
// with a different value, one factId that doesn't exist at all, two real factId+metric pairs with
// the value off by roughly half). This is kept verbatim as evidence checkClaimGrounding actually
// catches this exact failure mode, not just a hypothetical — inline citation is what made it look
// safe on a skim, which is why ClaimItemSchema now rejects inline citations outright (a claim like
// this wouldn't even reach checkClaimGrounding today; see case 17 for that zod-level gate).

const CLAIM_FACTS: RealFact[] = [
  { id: "cmt023y0j000dvgwk0b278qg2", metricName: "Operating Margin", value: 27.159, unit: "%" },
  { id: "cmt023y0j0007vgwks087ltvd", metricName: "ROE", value: 23.988001, unit: "%" },
  { id: "cmt023y0j0003vgwkg40dw1qw", metricName: "P/E", value: 2.6585367, unit: "x" },
  { id: "cmt023y0j0009vgwk1zywig2s", metricName: "Debt/Equity", value: 0.8572799999999999, unit: "x" },
  { id: "cmt023y0j000avgwki63pn9m0", metricName: "Current Ratio", value: 0.416, unit: "x" },
  { id: "cmt023y0j000qvgwkhrrhfdzo", metricName: "Payout Ratio", value: 26.69, unit: "%" },
  // note: "cmt023y0j000rvgwkhrrhfdzo" (groq's "Earnings Growth" claim below) deliberately absent — it never existed
];

// ---------- Case 14: well-grounded claim -> passes ----------

const WELL_GROUNDED_CLAIMS: ClaimItem[] = [
  { claim: "Low P/E of 2.66x suggests attractive valuation relative to earnings.", supportingFactIds: ["cmt023y0j0003vgwkg40dw1qw"] },
  { claim: "High Debt/Equity ratio of 0.857 raises leverage concerns.", supportingFactIds: ["cmt023y0j0009vgwk1zywig2s"] },
];

{
  const result = checkClaimGrounding(WELL_GROUNDED_CLAIMS, CLAIM_FACTS);
  check("14. well-grounded claims -> pass", result.ok, true);
}

// ---------- Case 15: fake supportingFactIds on a claim -> caught ----------

const FAKE_CLAIM_FACT_ID: ClaimItem[] = [
  { claim: "Strong balance sheet supports continued investment without dilution.", supportingFactIds: ["fake-claim-fact-id"] },
];

{
  const result = checkClaimGrounding(FAKE_CLAIM_FACT_ID, CLAIM_FACTS);
  check("15. fake supportingFactIds on claim -> caught", result.ok, false);
  const isUnknownFactId = result.issues.length === 1 && result.issues[0].reason === "unknown-factId";
  console.log(`   caught via unknown-factId specifically: ${isUnknownFactId ? "yes ✓" : "no ✗ (" + result.issues.map((i) => i.reason).join(",") + ")"}`);
  if (!isUnknownFactId) process.exitCode = 1;
}

// ---------- Case 16: real groq 1773.HK bulls (captured verbatim, pre-ClaimItem schema) ----------

const GROQ_1773HK_BULLS_HALLUCINATED: ClaimItem[] = [
  { claim: "Revenue Growth 11.366% indicates continuing expansion", supportingFactIds: ["cmt023y0j000qvgwkhrrhfdzo"] }, // real id, but it's Payout Ratio 26.69%
  { claim: "Earnings Growth 28.293% shows improving profitability", supportingFactIds: ["cmt023y0j000rvgwkhrrhfdzo"] }, // id doesn't exist
  { claim: "Process Power moat evidenced by Operating Margin 14.098% and moderate strength", supportingFactIds: ["cmt023y0j000dvgwk0b278qg2"] }, // real id+metric, real value 27.159 (off by ~2x)
  { claim: "ROE 12.967% demonstrates efficient shareholder returns", supportingFactIds: ["cmt023y0j0007vgwks087ltvd"] }, // real id+metric, real value 23.988 (off by ~2x)
  { claim: "Low P/E of 2.66x suggests attractive valuation", supportingFactIds: ["cmt023y0j0003vgwkg40dw1qw"] }, // correct
];

{
  const result = checkClaimGrounding(GROQ_1773HK_BULLS_HALLUCINATED, CLAIM_FACTS);
  check("16. real groq 1773.HK bulls hallucination -> caught", result.ok, false);
  const unknownCount = result.issues.filter((i) => i.reason === "unknown-factId").length;
  const unsupportedCount = result.issues.filter((i) => i.reason === "unsupported-number").length;
  // 1 unknown-factId (fabricated id) + 4 unsupported-number: relabeled Payout Ratio, the 2
  // off-by-~2x values, AND the fabricated-id claim's own number (once its factId is unknown,
  // citedFacts for that claim is empty, so its "28.293%" has nothing to match against either)
  console.log(`   ${unknownCount} unknown-factId, ${unsupportedCount} unsupported-number (expect 1 unknown, 4 unsupported)`);
  if (unknownCount !== 1 || unsupportedCount !== 4) process.exitCode = 1;
}

// ---------- Case 17: factId written inline in claim text -> rejected at the zod level, not
// checkClaimGrounding (ClaimItemSchema.refine in lib/report/schema.ts) — this is the actual fix for
// case 16's root cause: an inline citation isn't in supportingFactIds at all, so no grounding
// checker downstream of zod would ever see it. Exercised via test-report-schema.ts, not here (this
// file is checkGrounding-only, no zod), but noted here so the two regression suites cross-reference.

// ---------- Case 18: real ollama (qwen3:8b) MSFT bulls+bears (captured verbatim) — synthesis
// agent, post-ClaimItem schema, 2026-08-20, see docs/eval/synthesis.md ----------
//
// A different fabrication shape than case 16's groq run: instead of forging cuid-*shaped* strings,
// qwen3:8b invented ids straight out of the section headers in the extraContext prompt it was
// given ("moat001", "fundamentals006", "valuation001", "riskFactors003", "financials003") — not
// even attempting to reuse one of the real cuids present in the JSON context it was handed. Kept
// verbatim as evidence checkClaimGrounding catches this pattern too, not just case 16's shape.
//
// Note on coverage: the real run's grounding-issue count (16) did NOT include a flag on bulls[0]'s
// "45%+" — the trailing "+" broke extractFinancialNumbers' old suffix-then-\b chain (JS \b requires
// an ASCII word/non-word transition, and "%"->"+" isn't one, so it backed off to matching bare "45"
// instead, which has no qualifying marker and got skipped). That \b was replaced with a
// `(?![A-Za-z0-9])` lookahead while fixing a related, more serious bug (Thai magnitude words like
// "พันล้าน" going unrecognized — see MAGNITUDE_WORDS in grounding.ts), and the new lookahead catches
// "45%+" as a side effect (the "+" isn't an ASCII alnum, so nothing blocks matching "%" now). Expected
// counts below were re-verified against the actual fixed function, not hand-recomputed.

const OLLAMA_MSFT_SYNTHESIS_HALLUCINATED = {
  bulls: [
    {
      claim: "บริษัทมีความได้เปรียบทางการแข่งขันที่แข็งแกร่งจาก scale economies และ switching costs ที่สูง ซึ่งช่วยเพิ่ม margins ให้อยู่ระดับ 45%+",
      supportingFactIds: ["moat001", "moat002", "fundamentals006"],
    },
    {
      claim: "รายได้เติบโต 17.7% YoY พร้อม EBITDA margin ที่อยู่ที่ 44.6% สะท้อนความมั่นคงของรายได้และประสิทธิภาพการดำเนินงาน",
      supportingFactIds: ["fundamentals001", "fundamentals004"],
    },
  ] as ClaimItem[],
  bears: [
    {
      claim: "P/E ratio 26.7x ที่สูงกว่าอุตสาหกรรม 13.3% ต้องเผชิญความเสี่ยงหากการเติบโตชะลอตัวลงจาก 17.7% ปัจจุบัน",
      supportingFactIds: ["valuation001", "valuation002", "riskFactors003"],
    },
    {
      claim: "CapEx ปี 2026 ที่สูงถึง 11.8% ของรายได้ อาจก่อให้เกิด cash burn ถ้า ROI ไม่สอดคล้องกับความคาดหวัง",
      supportingFactIds: ["riskFactors001", "financials003"],
    },
  ] as ClaimItem[],
};

{
  // realFacts intentionally empty: none of these ids were ever real (that's the whole point) — an
  // empty list is enough to prove every citation resolves to unknown-factId regardless of what a
  // real FinancialFact table happens to contain.
  const bullsResult = checkClaimGrounding(OLLAMA_MSFT_SYNTHESIS_HALLUCINATED.bulls, []);
  const bearsResult = checkClaimGrounding(OLLAMA_MSFT_SYNTHESIS_HALLUCINATED.bears, []);
  const allIssues = [...bullsResult.issues, ...bearsResult.issues];
  check("18. real ollama MSFT synthesis hallucination -> caught", bullsResult.ok && bearsResult.ok, false);
  const unknownCount = allIssues.filter((i) => i.reason === "unknown-factId").length;
  const unsupportedCount = allIssues.filter((i) => i.reason === "unsupported-number").length;
  // 10 unknown-factId (unchanged). 7 unsupported-number, not the live run's 6 — that run predates
  // the (?![A-Za-z0-9]) lookahead fix, which now also catches "45%+" (see note above).
  console.log(`   ${unknownCount} unknown-factId, ${unsupportedCount} unsupported-number (expect 10 unknown, 7 unsupported)`);
  if (unknownCount !== 10 || unsupportedCount !== 7) process.exitCode = 1;
}

// ---------- Case 19: Thai magnitude words ("พันล้าน"=billion, "ล้าน"=million) -> NOT false-flagged
// ----------
// Real bug, found live via scripts/test-business-agent.ts on 1773.HK (groq, business.md): a
// correct claim written in Thai ("2.85 พันล้านดอลลาร์" = 2.85 billion) was read as the bare number
// 2.85 because extractFinancialNumbers only recognized English magnitude words, then compared
// against the real ~2.85e9 fact and false-flagged as unsupported. Also exercises the compound-word
// ordering (พันล้าน must win over a bare ล้าน mid-string) and the suffix-glued-to-more-Thai-text
// case ("พันล้านดอลลาร์", no space) that the old trailing \b couldn't handle.

const THAI_MAGNITUDE_FACTS: RealFact[] = [
  { id: "cmt-cash-1773hk", metricName: "Cash", value: 458745984, unit: "currency" },
  { id: "cmt-debt-1773hk", metricName: "Total Debt", value: 2848782080, unit: "currency" },
  { id: "cmt-mcap-1773hk", metricName: "Market Cap", value: 2214858240, unit: "currency" },
];

const THAI_MAGNITUDE_CLAIMS: ClaimItem[] = [
  {
    claim: "บริษัทมีมูลค่าตลาดประมาณ 2.21 พันล้านดอลลาร์ โดยมีเงินสด 458 ล้านดอลลาร์และหนี้รวม 2.85 พันล้านดอลลาร์",
    supportingFactIds: ["cmt-mcap-1773hk", "cmt-cash-1773hk", "cmt-debt-1773hk"],
  },
];

{
  const result = checkClaimGrounding(THAI_MAGNITUDE_CLAIMS, THAI_MAGNITUDE_FACTS);
  check("19. Thai magnitude words (พันล้าน/ล้าน) -> not a false positive", result.ok, true);
}

// ---------- Case 20: camelCase-fused XBRL tag <-> spaced human label -> NOT a false positive
// ----------
// Real false positive, found live via scripts/test-valuation-agent.ts on MSFT (claude-cli,
// 2026-08-20, see docs/eval/valuation.md): agent wrote "EPS (Diluted)" for factId whose real
// metricName is "EarningsPerShareDiluted" (SEC XBRL tag, one fused camelCase word, no separators)
// — the old tokenizer only split on non-alphanumeric characters, so it never saw "Diluted" as a
// separate token inside "EarningsPerShareDiluted" and flagged a correct translation as a mismatch.

const CAMELCASE_MSFT_FACTS: RealFact[] = [{ id: "cmt-eps-msft", metricName: "EarningsPerShareDiluted", value: 17.95, unit: "currency" }];

{
  const result = checkGrounding(
    {
      profile: { label: "Profile", metrics: [] },
      margins: { label: "Margins", metrics: [] },
      returns: { label: "Returns", metrics: [] },
      valuationTTM: { label: "Valuation (TTM)", metrics: [] },
      valuationNTM: null,
      financialHealth: { label: "Financial Health", metrics: [] },
      growth: { label: "Growth", metrics: [{ name: "EPS (Diluted)", value: 17.95, unit: "currency", factId: "cmt-eps-msft" }] },
      dividends: null,
    },
    CAMELCASE_MSFT_FACTS,
  );
  check('20. "EPS (Diluted)"<->"EarningsPerShareDiluted" -> not a false positive', result.ok, true);
}

// ---------- Case 21: "Capital Expenditures" <-> XBRL PP&E tag -> NOT a false positive ----------
// Real false positive, same live run as case 20: agent wrote "Capital Expenditures" (standard
// industry shorthand, "CapEx") for factId whose real metricName is
// "PaymentsToAcquirePropertyPlantAndEquipment". Neither a substring relationship nor
// camelCase-aware token overlap catches this — "capital"/"expenditures" share no word with
// "payments"/"acquire"/"property"/"plant"/"equipment" even after splitting the XBRL tag apart, since
// "capex" is industry shorthand for the concept, not a paraphrase of the tag's literal words. Needs
// an explicit synonym pair (SYNONYM_PAIRS in grounding.ts).

const CAPEX_MSFT_FACTS: RealFact[] = [{ id: "cmt-capex-msft", metricName: "PaymentsToAcquirePropertyPlantAndEquipment", value: 115948000000, unit: "currency" }];

{
  const result = checkGrounding(
    {
      profile: { label: "Profile", metrics: [] },
      margins: { label: "Margins", metrics: [] },
      returns: { label: "Returns", metrics: [] },
      valuationTTM: { label: "Valuation (TTM)", metrics: [] },
      valuationNTM: null,
      financialHealth: { label: "Financial Health", metrics: [{ name: "Capital Expenditures", value: 115948000000, unit: "currency", factId: "cmt-capex-msft" }] },
      growth: { label: "Growth", metrics: [] },
      dividends: null,
    },
    CAPEX_MSFT_FACTS,
  );
  check('21. "Capital Expenditures"<->"PaymentsToAcquirePropertyPlantAndEquipment" -> not a false positive', result.ok, true);
}

// ---------- Case 22: checkStockReportGrounding aggregates every section + tags issues by section
// ----------
// Not a live-run fixture (the underlying per-section checks are already tested individually above)
// — this exercises the NEW logic checkStockReportGrounding itself adds: dispatching to the right
// checker per section and tagging each issue with which section it came from. A minimal synthetic
// report with exactly one bad citation, isolated to riskFactors, everything else clean.

const REPORT_FACTS: RealFact[] = [{ id: "cmt-rev-report", metricName: "Revenue", value: 1000000000, unit: "currency" }];

const MINIMAL_REPORT_WITH_ONE_BAD_RISK: StockReport = {
  meta: { ticker: "TEST", companyName: "Test Co", exchange: "SEC", currency: "USD", generatedAt: "2026-08-20T00:00:00.000Z", dataAsOf: "2026-08-20", modelTier: "TIER2_OPUS" },
  priceChart: null,
  businessSummary: [{ claim: "The company generates real, disclosed revenue.", supportingFactIds: ["cmt-rev-report"] }],
  fundamentals: {
    profile: { label: "Profile", metrics: [{ name: "Revenue", value: 1000000000, unit: "currency", factId: "cmt-rev-report" }] },
    margins: { label: "Margins", metrics: [] },
    returns: { label: "Returns", metrics: [] },
    valuationTTM: { label: "Valuation (TTM)", metrics: [] },
    valuationNTM: null,
    financialHealth: { label: "Financial Health", metrics: [] },
    growth: { label: "Growth", metrics: [] },
    dividends: null,
  },
  recentDevelopments: [],
  moat: [],
  charts: [],
  growthDrivers: [],
  riskFactors: [
    {
      title: "Fake Risk",
      body: "Margins look weak based on internal data not otherwise disclosed in the given facts.",
      example: "For example, this could pressure future results if the trend continues.",
      supportingFactIds: ["cmt-fake-does-not-exist"],
    },
  ],
  estimates: [],
  insiders: [],
  bulls: [{ claim: "The company reports real revenue with a traceable source.", supportingFactIds: ["cmt-rev-report"] }],
  bears: [{ claim: "No specific bear case beyond general market risk is identified here.", supportingFactIds: ["cmt-rev-report"] }],
  verdict: { decision: "WAIT", conviction: 3, thesis: "x".repeat(25), killCriteria: ["x"], reviewDate: "2027-01-01" },
};

{
  const factIds = collectReportFactIds(MINIMAL_REPORT_WITH_ONE_BAD_RISK);
  console.log(`   collectReportFactIds found ${factIds.length} distinct id(s) (expect 2)`);
  if (factIds.length !== 2) process.exitCode = 1;

  const result = checkStockReportGrounding(MINIMAL_REPORT_WITH_ONE_BAD_RISK, REPORT_FACTS);
  check("22. checkStockReportGrounding -> catches the one bad riskFactors citation, nothing else", result.ok, false);
  const isSingleTaggedIssue = result.issues.length === 1 && result.issues[0].section === "riskFactors" && result.issues[0].reason === "unknown-factId";
  console.log(`   exactly 1 issue, tagged section="riskFactors": ${isSingleTaggedIssue ? "yes ✓" : "no ✗ (" + JSON.stringify(result.issues) + ")"}`);
  if (!isSingleTaggedIssue) process.exitCode = 1;
}

// ---------- Case 23: floating-point round-trip noise on a value should NOT be flagged ----------
// Real false positive from a live claude-cli 0694.HK run (2026-08-21): agent wrote Operating
// Margin as -5.1090002, FinancialFact stored -5.1090002000000005 for the same underlying value —
// both numbers passed through JSON stringify/parse and manual reproduction by the model, which is
// enough float noise at the 15th significant digit to trip the old strict `!==` check on a value
// that was never actually altered.

const FLOAT_NOISE: Fundamentals = {
  profile: { label: "Profile", metrics: [] },
  margins: { label: "Margins", metrics: [{ name: "Operating Margin", value: -5.1090002, unit: "%", factId: "cmt-om-0694" }] },
  returns: { label: "Returns", metrics: [] },
  valuationTTM: { label: "Valuation (TTM)", metrics: [] },
  valuationNTM: null,
  financialHealth: { label: "Financial Health", metrics: [] },
  growth: { label: "Growth", metrics: [] },
  dividends: null,
};
const FLOAT_NOISE_FACTS: RealFact[] = [{ id: "cmt-om-0694", metricName: "Operating Margin", value: -5.1090002000000005, unit: "%" }];

{
  const result = checkGrounding(FLOAT_NOISE, FLOAT_NOISE_FACTS);
  check("23. float round-trip noise (-5.1090002 vs ...00005) -> not a false positive", result.ok, true);
}

// ---------- Case 24: "Cash Flow From Operations" <-> "CFO" should NOT be flagged ----------
// Real false positive, confirmed on two separate live claude-cli runs (0694.HK and 6169.HK, both
// 2026-08-21). Case 5 already covers "Operating Cash Flow" <-> "CFO" (matches via acronym
// expansion); this phrasing doesn't — expand("cfo") gives "operatingcashflow", which doesn't
// substring-match "cashflowfromoperations" (word order differs), and "CFO" is only 3 characters so
// it produces zero wordTokens to fall back on.

const CFO_PHRASING: Fundamentals = {
  profile: { label: "Profile", metrics: [] },
  margins: { label: "Margins", metrics: [] },
  returns: { label: "Returns", metrics: [] },
  valuationTTM: { label: "Valuation (TTM)", metrics: [] },
  valuationNTM: null,
  financialHealth: { label: "Financial Health", metrics: [{ name: "Cash Flow From Operations", value: 1595908992, unit: "currency", factId: "cmt-cfo-6169" }] },
  growth: { label: "Growth", metrics: [] },
  dividends: null,
};
const CFO_PHRASING_FACTS: RealFact[] = [{ id: "cmt-cfo-6169", metricName: "CFO", value: 1595908992, unit: "currency" }];

{
  const result = checkGrounding(CFO_PHRASING, CFO_PHRASING_FACTS);
  check('24. "Cash Flow From Operations"<->"CFO" -> not a false positive', result.ok, true);
}

// ---------- Case 25: bare "1.0x"/"1x" threshold reference should NOT be flagged ----------
// Real false positive, confirmed on three separate live claude-cli runs (1773.HK, 0694.HK,
// 6169.HK, all 2026-08-21) — every occurrence was the universal breakeven/parity reference point
// for a ratio ("below the 1.0x threshold generally considered healthy"), never a claim about the
// company's own figures. A genuine company-specific number at any other value (including "1"
// without an "x" suffix, or "1.5x") still requires real backing — only the exact value 1 with an
// "x" suffix is excluded.

const CURRENT_RATIO_FACTS: RealFact[] = [{ id: "cmt-cr-0694", metricName: "Current Ratio", value: 0.221, unit: "x" }];

{
  const belowThreshold: BulletItem = {
    title: "Weak Liquidity",
    body: "Current Ratio stands at just 0.221x, well below the 1.0x threshold generally considered healthy for a company this size.",
    example: "For example, if a large short-term liability came due, the sub-1.0x current ratio would leave little cushion beyond the 0.221x level already on the books.",
    supportingFactIds: ["cmt-cr-0694"],
  };
  const result = checkBulletGrounding([belowThreshold], CURRENT_RATIO_FACTS);
  check('25. bare "1.0x" threshold reference -> not a false positive', result.ok, true);

  const fabricatedOtherX: BulletItem = {
    title: "Fabricated Multiple",
    body: "Current Ratio actually sits at a fabricated 2.5x, well above the 1.0x threshold considered healthy.",
    example: "For example, this made-up 2.5x figure has no basis in the given facts.",
    supportingFactIds: ["cmt-cr-0694"],
  };
  const controlResult = checkBulletGrounding([fabricatedOtherX], CURRENT_RATIO_FACTS);
  const stillCatchesRealIssues = !controlResult.ok && controlResult.issues.every((i) => i.reason !== "unsupported-number" || !i.detail.includes("number 1 "));
  console.log(`   (control) the exclusion is scoped to exactly "1x"/"1.0x" — a fabricated 2.5x is still caught: ${!controlResult.ok ? "yes ✓" : "no ✗ (" + JSON.stringify(controlResult.issues) + ")"}`);
  if (controlResult.ok || !stillCatchesRealIssues) process.exitCode = 1;

  // Thai equivalent of case 25 — "เท่า" is the Thai unit word for a ratio multiplier, used the
  // same way "x" is in English. Real false positive from the same live 6169.HK run: agent wrote
  // "ต่ำกว่า 1.0 เท่า" (below 1.0x) and the old code only recognized the Latin "x" suffix, so this
  // phrasing slipped through the case-25 fix untouched.
  const belowThresholdThai: BulletItem = {
    title: "สภาพคล่องอ่อนแอ",
    body: "Current Ratio อยู่ที่เพียง 0.221 เท่า ต่ำกว่า 1.0 เท่า ซึ่งถือว่าต่ำกว่าระดับที่ปลอดภัย",
    example: "ตัวอย่างเช่น หากหนี้สินระยะสั้นถึงกำหนดชำระพร้อมกัน ระดับ 0.221 เท่า จะไม่เพียงพอ",
    supportingFactIds: ["cmt-cr-0694"],
  };
  const thaiResult = checkBulletGrounding([belowThresholdThai], CURRENT_RATIO_FACTS);
  check('25b. bare "1.0 เท่า" threshold reference (Thai) -> not a false positive', thaiResult.ok, true);
}

// ---------- Case 26: positive magnitude for a negative fact ("consumed $X") -> NOT a false
// positive, but a genuinely wrong magnitude is still caught ----------
// Real false positive from a live claude-cli INSET.BK run (2026-08-21): "consuming $561.96M in
// cash" (positive magnitude, direction implied by "consuming") for a CFO fact stored as
// -561960000. Writing a negative figure's size as a positive number plus a direction word is
// normal financial-writing style — this only relaxes which sign counts as a match.

const CFO_NEGATIVE_FACT: RealFact[] = [{ id: "cmt-cfo-inset-2024", metricName: "CFO", value: -561960000, unit: "currency" }];

{
  const consumedPhrasing: BulletItem = {
    title: "Volatile Operating Cash Flow",
    body: "Despite positive net income, the company was consuming $561.96M in cash from operations in 2024.",
    example: "For example, this cash consumption of $561.96M would need to be funded from elsewhere.",
    supportingFactIds: ["cmt-cfo-inset-2024"],
  };
  const result = checkBulletGrounding([consumedPhrasing], CFO_NEGATIVE_FACT);
  check('26. positive-magnitude phrasing ("consuming $561.96M") for a negative fact -> not a false positive', result.ok, true);

  const wrongMagnitude: BulletItem = {
    title: "Fabricated Cash Burn",
    body: "The company was consuming a fabricated $999.99M in cash from operations in 2024.",
    example: "For example, this made-up $999.99M figure has no basis in the given facts.",
    supportingFactIds: ["cmt-cfo-inset-2024"],
  };
  const controlResult = checkBulletGrounding([wrongMagnitude], CFO_NEGATIVE_FACT);
  console.log(`   (control) the sign-tolerance doesn't mask a wrong magnitude — fabricated $999.99M still caught: ${!controlResult.ok ? "yes ✓" : "no ✗ (" + JSON.stringify(controlResult.issues) + ")"}`);
  if (controlResult.ok) process.exitCode = 1;
}

console.log("\ndone.");
