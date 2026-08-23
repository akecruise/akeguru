/**
 * Grounding checks for AI-generated report sections — verifies an agent didn't just produce
 * schema-valid JSON (zod's job, see lib/report/schema.ts) but JSON that's actually traceable to
 * real FinancialFact rows. Two entry points, one per output shape:
 *
 * checkGrounding() — Fundamentals (per-Metric factId). Three independent checks, each catching a
 * failure mode the others miss:
 *
 *   - factId exists       catches wholesale hallucination (invented ids, e.g. "1".."18" —
 *                          confirmed against qwen3:8b, see scripts/test-grounding.ts)
 *   - value matches        catches a real factId cited alongside a fabricated/altered value
 *   - metricName matches   catches a real factId *borrowed* from a different metric — same value,
 *                          wrong meaning (e.g. citing Revenue's factId while labeling it "Net
 *                          Margin"). Value-equality alone can't catch this if the agent also
 *                          copies the borrowed value verbatim, or if two different real metrics
 *                          happen to share a numeric value (e.g. two unrelated ratios both = 1.5).
 *
 * checkBulletGrounding() / checkMoatGrounding() / checkClaimGrounding() — BulletItem / MoatItem /
 * ClaimItem (risk/moat/business/growth/bulls/bears: free text with no per-line factId, so
 * supportingFactIds stands in for it). See the shared checkTextGrounding() below for the two
 * checks all three run.
 */
import type { Fundamentals, Metric, BulletItem, MoatItem, ClaimItem, InvalidationTrigger, StockReport } from "../report/types";

export interface RealFact {
  id: string;
  metricName: string;
  value: number;
  unit: string;
}

export interface GroundingIssue {
  metricName: string;
  factId: string | null;
  reason: "missing-factId" | "unknown-factId" | "value-mismatch" | "metricName-mismatch";
  detail: string;
}

export interface GroundingResult {
  ok: boolean;
  checkedCount: number;
  issues: GroundingIssue[];
}

export function allMetrics(f: Fundamentals): Metric[] {
  const groups = [f.profile, f.margins, f.returns, f.valuationTTM, f.valuationNTM, f.financialHealth, f.growth, f.dividends];
  return groups.filter((g): g is NonNullable<typeof g> => g != null).flatMap((g) => g.metrics);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Known finance acronyms that appear as FinancialFact.metricName (from router.ts's
// YAHOO_FIELD_MAP) — all <4 chars, so the token-overlap check below never sees them, and a model
// correctly expanding one (e.g. citing 'FCF' but labeling the metric "Free Cash Flow") would
// otherwise be flagged as a false-positive mismatch. Confirmed as a real false positive during
// Phase 3 eval: Gemini relabeled 'FCF'->"Free Cash Flow" and 'CFO'->"Operating Cash Flow" —
// correct, sensible relabeling, not a hallucination — before this table existed.
const ACRONYM_EXPANSIONS: Record<string, string> = {
  fcf: "freecashflow",
  cfo: "operatingcashflow",
  roe: "returnonequity",
  roa: "returnonassets",
  ev: "enterprisevalue",
  pe: "priceearnings",
  pb: "pricebook",
  eps: "earningspershare",
};

function expand(normalized: string): string {
  return ACRONYM_EXPANSIONS[normalized] ?? normalized;
}

// Full-phrase synonym pairs where neither acronym-expansion nor token-overlap catches the match —
// genuinely different vocabulary for the same concept, not just a tokenization artifact. Confirmed
// real (not hypothetical) via a live claude-cli MSFT valuation run (docs/eval/valuation.md,
// 2026-08-20): agent wrote "Capital Expenditures" for the XBRL tag
// PaymentsToAcquirePropertyPlantAndEquipment — camelCase-splitting the XBRL name gives tokens like
// "payments"/"acquire"/"property"/"plant"/"equipment", none of which overlap with "capital"/
// "expenditures" even after the camelCase fix below, because "capex" is industry shorthand, not a
// literal description of the tag.
//
// ["cashflowfromoperations", "cfo"]: confirmed real (not hypothetical) on two separate live
// claude-cli runs (0694.HK and 6169.HK, 2026-08-21) — the agent wrote "Cash Flow From/from
// Operations" for a fact labeled "CFO". expand("cfo") already produces "operatingcashflow" (see
// ACRONYM_EXPANSIONS), which doesn't substring-match "cashflowfromoperations" (word order differs:
// "operating cash flow" vs "cash flow from operations"), and the wordTokens fallback can't help
// either — "CFO" is only 3 characters, below the >=4 token-length filter, so it produces zero
// tokens to overlap against. A direct synonym pair sidesteps both failure paths at once.
const SYNONYM_PAIRS: [string, string][] = [
  ["capitalexpenditures", "paymentstoacquirepropertyplantandequipment"],
  ["cashflowfromoperations", "cfo"],
];

/** Splits camelCase/PascalCase words apart (XBRL tags like "EarningsPerShareDiluted" arrive as one
 *  fused word with no separators) in addition to the usual non-alphanumeric split, so a raw tag's
 *  tokens can overlap with a human-written label's tokens (e.g. "diluted" in both "EPS (Diluted)"
 *  and "EarningsPerShareDiluted"). Confirmed real: same live run as SYNONYM_PAIRS above — "EPS
 *  (Diluted)" vs "EarningsPerShareDiluted" fell through the old split (which never separated the
 *  fused XBRL word) to a false-positive mismatch. */
function wordTokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

/**
 * Deliberately lenient: metric.name is a free-form label the agent may legitimately translate
 * from a raw XBRL tag (e.g. 'OperatingIncomeLoss' -> "Operating Income") or a known acronym (e.g.
 * 'FCF' -> "Free Cash Flow"), so exact string equality would flag correct translations as false
 * positives. Passes on exact match, substring match (either direction, acronym-expanded), a known
 * synonym pair, or any shared word token >=4 chars (camelCase-aware). Flags only a name with no
 * textual relationship at all.
 */
function namesPlausiblyMatch(agentName: string, factMetricName: string): boolean {
  const a = normalize(agentName);
  const b = normalize(factMetricName);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ea = expand(a);
  const eb = expand(b);
  if (ea === eb || ea.includes(eb) || eb.includes(ea)) return true;
  for (const [x, y] of SYNONYM_PAIRS) {
    if ((a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x))) return true;
  }
  const tokensA = wordTokens(agentName);
  const tokensB = wordTokens(factMetricName);
  return tokensA.some((t) => tokensB.includes(t));
}

/** Exhaustive over every metric with a value — not a sample. Cheap (array lookups only), so there's no reason to sample. */
export function checkGrounding(content: Fundamentals, realFacts: RealFact[]): GroundingResult {
  const byId = new Map(realFacts.map((f) => [f.id, f]));
  const issues: GroundingIssue[] = [];
  const metrics = allMetrics(content).filter((m): m is Metric & { value: number } => m.value !== null);

  for (const m of metrics) {
    if (!m.factId) {
      issues.push({ metricName: m.name, factId: null, reason: "missing-factId", detail: "value present but factId is null" });
      continue;
    }
    const fact = byId.get(m.factId);
    if (!fact) {
      issues.push({ metricName: m.name, factId: m.factId, reason: "unknown-factId", detail: `factId "${m.factId}" does not exist in FinancialFact` });
      continue;
    }
    // Tiny relative tolerance, not strict !==: confirmed real on a live claude-cli 0694.HK run
    // (2026-08-21) — agent wrote Operating Margin as -5.1090002, FinancialFact stored
    // -5.1090002000000005 for the exact same value; both numbers passed through JSON
    // stringify/parse and manual reproduction by the model, which is enough float noise at the
    // 15th significant digit to trip a strict equality check on a value that was never actually
    // altered. 1e-9 relative is far tighter than the 5% tolerance checkTextGrounding uses
    // elsewhere (that one allows genuinely *different* numbers close in magnitude; this one only
    // needs to absorb float round-tripping, not mask a real discrepancy).
    if (Math.abs(fact.value - m.value) > Math.abs(fact.value) * 1e-9 + 1e-9) {
      issues.push({
        metricName: m.name,
        factId: m.factId,
        reason: "value-mismatch",
        detail: `agent value ${m.value} != FinancialFact(${fact.metricName}).value ${fact.value}`,
      });
      continue;
    }
    if (!namesPlausiblyMatch(m.name, fact.metricName)) {
      issues.push({
        metricName: m.name,
        factId: m.factId,
        reason: "metricName-mismatch",
        detail: `agent labeled this "${m.name}" but factId ${m.factId} is actually FinancialFact.metricName="${fact.metricName}"`,
      });
    }
  }

  return { ok: issues.length === 0, checkedCount: metrics.length, issues };
}

// ---------- BulletItem grounding (risk/moat/business/growth — free-text sections with no
// per-metric factId the way Fundamentals has) ----------
//
// BulletItem instead carries supportingFactIds: string[] (schema-required, min 1) — the agent
// names which FinancialFact rows back the claim. Two checks, mirroring checkGrounding's split:
//   - factId exists      same wholesale-hallucination check as above, applied to supportingFactIds
//   - number is close     a real factId doesn't guarantee the *number written in the prose*
//                         matches it — this catches a bullet that cites a real fact but states a
//                         stale/fabricated figure alongside it

export interface BulletGroundingIssue {
  title: string;
  reason: "unknown-factId" | "unsupported-number";
  detail: string;
}

export interface BulletGroundingResult {
  ok: boolean;
  checkedCount: number;
  issues: BulletGroundingIssue[];
}

const MAGNITUDE_WORDS: Record<string, number> = {
  // English
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
  // Thai — several agents (risk/moat/business) write in Thai, and a correct claim like "2.85
  // พันล้านดอลลาร์" (2.85 billion) was going undetected as a magnitude word, leaving the extractor
  // to compare the bare "2.85" against a real fact of ~2.85e9 and false-flag it as unsupported
  // (found live via scripts/test-business-agent.ts on 1773.HK). Compound words ("พันล้าน" =
  // "พัน"+"ล้าน") must appear so the alternation below (sorted longest-first) matches the whole
  // compound instead of stopping at the shorter "ล้าน".
  "พัน": 1e3, "หมื่น": 1e4, "แสน": 1e5,
  "ล้าน": 1e6, "สิบล้าน": 1e7, "ร้อยล้าน": 1e8,
  "พันล้าน": 1e9, "หมื่นล้าน": 1e10, "แสนล้าน": 1e11,
  "ล้านล้าน": 1e12,
};

// Longest-first so "พันล้าน" (billion) matches as one token rather than the alternation stopping
// at "ล้าน" (million) partway through it.
const MAGNITUDE_ALTERNATION = Object.keys(MAGNITUDE_WORDS).sort((a, b) => b.length - a.length).join("|");

/**
 * Pulls "financial-looking" numbers out of free text: a leading $ or minus sign, a thousands-comma,
 * a decimal point, a %, an x-multiplier, or a magnitude word all count as a marker that this is a
 * measured figure rather than an incidental count. A bare integer with none of those ("3
 * consecutive quarters", "Q2 2026", a year) is skipped — those aren't the kind of number a
 * FinancialFact would back anyway, and flagging them would make every bullet fail.
 *
 * The `(?<!\w)-?` lookbehind on the sign only treats a leading "-" as negative when it isn't
 * glued to a preceding word/digit — otherwise "10-15%" would misread its own range separator as
 * the minus sign on 15.
 *
 * The trailing lookahead is `(?![A-Za-z0-9])`, not `\b`: JS's `\b` is ASCII-word-based, so it never
 * fires between two Thai characters (Thai isn't `\w`) — a suffix like "พันล้าน" glued directly to
 * more Thai text ("พันล้านดอลลาร์", no space) would fail a trailing `\b` and the regex would back
 * off to matching the bare digits instead, silently reintroducing the bug above. The lookahead only
 * blocks the match when an ASCII letter/digit follows (still correctly skips "3 months" — "m" can't
 * complete as a suffix there since "onths" follows), and Thai text is free to follow either way.
 *
 * One deliberate exclusion: a bare "1x"/"1.0x" (or its Thai equivalent "1 เท่า"/"1.0 เท่า" — "เท่า"
 * is the Thai unit word for a ratio multiplier, used the same way "x" is in English) is skipped
 * even though it matches the pattern above. Confirmed real on three separate live claude-cli runs
 * (1773.HK, 0694.HK, 6169.HK, all 2026-08-21), in both languages — every occurrence was the
 * universal breakeven/parity reference point for a ratio ("below the 1.0x threshold generally
 * considered healthy", "ต่ำกว่าระดับปลอดภัยที่ 1.0x", "ต่ำกว่า 1.0 เท่า"), never a claim about the
 * company's own figures, so it never has (or needs) a FinancialFact behind it. Scoped tightly to
 * exactly 1 with an "x"/"เท่า" suffix — every other value and every other suffix (%, magnitude
 * words, $) still requires real backing.
 */
function extractFinancialNumbers(text: string): number[] {
  const re = new RegExp(`(?<!\\w)(-)?(\\$)?(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?\\s?(${MAGNITUDE_ALTERNATION}|%|x|เท่า)?(?![A-Za-z0-9])`, "gi");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, negative, dollar, intPart, decPart, suffixRaw] = m;
    const suffix = suffixRaw?.toLowerCase();
    const hasComma = intPart.includes(",");
    const hasDecimal = !!decPart;
    const magnitude = suffix ? MAGNITUDE_WORDS[suffix] : undefined;
    const isRatioOrPct = suffix === "%" || suffix === "x" || suffix === "เท่า";
    if (!dollar && !hasComma && !hasDecimal && !magnitude && !isRatioOrPct) continue;
    let value = parseFloat(intPart.replace(/,/g, "") + (decPart ?? ""));
    if (magnitude) value *= magnitude;
    if (negative) value = -value;
    if ((suffix === "x" || suffix === "เท่า") && value === 1) continue;
    out.push(value);
  }
  return out;
}

function withinTolerance(a: number, b: number, pct = 0.05): boolean {
  if (a === 0 || b === 0) return a === b;
  return Math.abs(a - b) / Math.abs(b) <= pct;
}

interface GroundableItem {
  title: string;
  text: string;
  supportingFactIds: string[];
}

/**
 * Shared by checkBulletGrounding and checkMoatGrounding — same two checks (factId exists, cited
 * numbers are close), differing only in which text field(s) get scanned for numbers: BulletItem
 * has body+example, MoatItem has body only (it has no example field). checkGrounding()'s per-item
 * shape differs too much from this (per-Metric factId vs. a single supportingFactIds array) to
 * share with that one.
 */
function checkTextGrounding(items: GroundableItem[], realFacts: RealFact[]): BulletGroundingResult {
  const byId = new Map(realFacts.map((f) => [f.id, f]));
  const issues: BulletGroundingIssue[] = [];

  for (const item of items) {
    const citedFacts: RealFact[] = [];
    for (const factId of item.supportingFactIds) {
      const fact = byId.get(factId);
      if (!fact) {
        issues.push({ title: item.title, reason: "unknown-factId", detail: `supportingFactIds "${factId}" does not exist in FinancialFact` });
        continue;
      }
      citedFacts.push(fact);
    }

    const numbers = extractFinancialNumbers(item.text);
    for (const n of numbers) {
      // Checks the fact's absolute value too, not just its signed value: confirmed real on a live
      // claude-cli INSET.BK run (2026-08-21) — text read "consuming $561.96M in cash" (a positive
      // magnitude with the direction implied by the word "consuming") for a CFO fact stored as
      // -561960000. Writing a negative figure's size as a positive number plus a direction word
      // ("consumed", "fell by", "shrank") is normal financial-writing style, not a fabrication —
      // this only relaxes which *sign* counts as a match, the magnitude still has to be close.
      const supported = citedFacts.some((f) => withinTolerance(n, f.value) || withinTolerance(n, -f.value));
      if (!supported) {
        issues.push({
          title: item.title,
          reason: "unsupported-number",
          detail: `number ${n} in text has no FinancialFact within ±5% among supportingFactIds (${item.supportingFactIds.join(", ")})`,
        });
      }
    }
  }

  return { ok: issues.length === 0, checkedCount: items.length, issues };
}

/** Exhaustive over every bullet's body+example, same as checkGrounding is over every valued metric. */
export function checkBulletGrounding(bullets: BulletItem[], realFacts: RealFact[]): BulletGroundingResult {
  return checkTextGrounding(
    bullets.map((b) => ({ title: b.title, text: `${b.body} ${b.example}`, supportingFactIds: b.supportingFactIds })),
    realFacts,
  );
}

/**
 * Exhaustive over every moat item's body. Unlike BulletItem, MoatItem's body is often purely
 * qualitative (brand, switching_costs, network_economies, counter_positioning genuinely have no
 * hard number to cite) — that's fine here for the same reason it's fine in checkBulletGrounding:
 * the number check only ever flags a number that *is* present and unsupported, it never requires
 * one to exist. A moat item with no financial-looking number in its body passes this check purely
 * on the factId-exists half; see .claude/agents/analysis/moat.md for what's required of
 * supportingFactIds in that case (indirect-but-real evidence, not a random fact to pad the array).
 */
export function checkMoatGrounding(moatItems: MoatItem[], realFacts: RealFact[]): BulletGroundingResult {
  return checkTextGrounding(
    moatItems.map((m) => ({ title: m.title, text: m.body, supportingFactIds: m.supportingFactIds })),
    realFacts,
  );
}

/**
 * Exhaustive over every ClaimItem (bulls/bears from the synthesis agent). ClaimItem has no
 * separate title, just `claim` — used as both title and text here. The zod-level
 * ClaimItemSchema.refine already blocks a bare factId written inline in `claim` (the specific
 * failure mode this whole type existed to fix — see lib/report/schema.ts), so this only needs to
 * check the same two things checkBulletGrounding/checkMoatGrounding do: supportingFactIds are real,
 * and any number actually stated in `claim` is close to one of them.
 */
export function checkClaimGrounding(claims: ClaimItem[], realFacts: RealFact[]): BulletGroundingResult {
  return checkTextGrounding(
    claims.map((c) => ({ title: c.claim, text: c.claim, supportingFactIds: c.supportingFactIds })),
    realFacts,
  );
}

export interface InvalidationTriggerIssue {
  description: string;
  reason: "unknown-metric";
  detail: string;
}

export interface InvalidationTriggerResult {
  ok: boolean;
  checkedCount: number;
  issues: InvalidationTriggerIssue[];
}

/**
 * Exhaustive over every InvalidationTrigger (Verdict.invalidationTriggers) — verifies metricName is
 * a real FinancialFact.metricName for this ticker, not an invented label. Unlike
 * checkBulletGrounding/checkClaimGrounding, there's no supportingFactIds or number-in-prose to
 * check here: a trigger references a *metric going forward* (re-evaluated against whatever the
 * next refresh/ingest reports for that metricName — see scripts/scorecard.ts), not a specific
 * historical fact row, so factId-style checking doesn't apply — metricName existing among this
 * ticker's real facts is the whole check.
 */
export function checkInvalidationTriggers(triggers: InvalidationTrigger[], realFacts: RealFact[]): InvalidationTriggerResult {
  const knownMetrics = new Set(realFacts.map((f) => f.metricName));
  const issues: InvalidationTriggerIssue[] = [];
  for (const t of triggers) {
    if (!knownMetrics.has(t.metricName)) {
      issues.push({
        description: t.description,
        reason: "unknown-metric",
        detail: `metricName "${t.metricName}" is not among this ticker's FinancialFact rows`,
      });
    }
  }
  return { ok: issues.length === 0, checkedCount: triggers.length, issues };
}

/** Every factId a StockReport cites anywhere, deduped — what to fetch from FinancialFact before
 *  calling checkStockReportGrounding(). */
export function collectReportFactIds(report: StockReport): string[] {
  const ids = new Set<string>();
  for (const m of allMetrics(report.fundamentals)) if (m.factId) ids.add(m.factId);
  for (const b of [...report.riskFactors, ...report.growthDrivers]) for (const id of b.supportingFactIds) ids.add(id);
  for (const m of report.moat) for (const id of m.supportingFactIds) ids.add(id);
  for (const c of [...report.businessSummary, ...report.bulls, ...report.bears]) for (const id of c.supportingFactIds) ids.add(id);
  return [...ids];
}

export interface StockReportGroundingIssue {
  section: "fundamentals" | "riskFactors" | "growthDrivers" | "moat" | "businessSummary" | "bulls" | "bears" | "invalidationTriggers";
  reason: string;
  title: string;
  detail: string;
}

export interface StockReportGroundingResult {
  ok: boolean;
  checkedCount: number;
  issues: StockReportGroundingIssue[];
}

/**
 * Runs every applicable grounding check across a fully-assembled StockReport (checkGrounding for
 * fundamentals; checkBulletGrounding for riskFactors/growthDrivers; checkMoatGrounding for moat;
 * checkClaimGrounding for businessSummary/bulls/bears), tagging each issue with which section it
 * came from. Used by lib/report/orchestrator.ts to decide whether a report is safe to export to
 * the real Obsidian vault — validateReport() alone only checks schema/completeness, it does NOT
 * catch citation problems. Found live and not hypothetical: a real `scripts/run-report.ts 1773.HK`
 * run passed validateReport cleanly but had 2 real grounding issues once checked exhaustively (a
 * near-miss fabricated factId in riskFactors, an incomplete citation in bears) — see
 * docs/eval/risk.md and docs/eval/synthesis.md, 2026-08-20.
 *
 * priceChart/charts/recentDevelopments/insiders aren't checked — none are built yet (always
 * empty/null on every report today), and none carry a supportingFactIds-style field to check even
 * once they are.
 */
export function checkStockReportGrounding(report: StockReport, realFacts: RealFact[]): StockReportGroundingResult {
  const fundamentalsResult = checkGrounding(report.fundamentals, realFacts);
  const riskResult = checkBulletGrounding(report.riskFactors, realFacts);
  const growthResult = checkBulletGrounding(report.growthDrivers, realFacts);
  const moatResult = checkMoatGrounding(report.moat, realFacts);
  const businessResult = checkClaimGrounding(report.businessSummary, realFacts);
  const bullsResult = checkClaimGrounding(report.bulls, realFacts);
  const bearsResult = checkClaimGrounding(report.bears, realFacts);
  const triggersResult = checkInvalidationTriggers(report.verdict.invalidationTriggers, realFacts);

  const issues: StockReportGroundingIssue[] = [
    ...fundamentalsResult.issues.map((i) => ({ section: "fundamentals" as const, reason: i.reason, title: i.metricName, detail: i.detail })),
    ...riskResult.issues.map((i) => ({ section: "riskFactors" as const, reason: i.reason, title: i.title, detail: i.detail })),
    ...growthResult.issues.map((i) => ({ section: "growthDrivers" as const, reason: i.reason, title: i.title, detail: i.detail })),
    ...moatResult.issues.map((i) => ({ section: "moat" as const, reason: i.reason, title: i.title, detail: i.detail })),
    ...businessResult.issues.map((i) => ({ section: "businessSummary" as const, reason: i.reason, title: i.title, detail: i.detail })),
    ...bullsResult.issues.map((i) => ({ section: "bulls" as const, reason: i.reason, title: i.title, detail: i.detail })),
    ...bearsResult.issues.map((i) => ({ section: "bears" as const, reason: i.reason, title: i.title, detail: i.detail })),
    ...triggersResult.issues.map((i) => ({ section: "invalidationTriggers" as const, reason: i.reason, title: i.description, detail: i.detail })),
  ];

  const checkedCount =
    fundamentalsResult.checkedCount +
    riskResult.checkedCount +
    growthResult.checkedCount +
    moatResult.checkedCount +
    businessResult.checkedCount +
    bullsResult.checkedCount +
    bearsResult.checkedCount +
    triggersResult.checkedCount;

  return { ok: issues.length === 0, checkedCount, issues };
}
