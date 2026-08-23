/**
 * Gate 6 (nena) — cross-checks every FinancialFact for the ticker directly against the raw
 * archived source file it claims to come from (RawSource.filePath on disk), independent of
 * whatever extraction code produced it. Checks all of the ticker's facts, not just the ones the
 * report cites (that's Gate 1/2's job) — this is a check on the underlying data, not on the
 * report's narrative.
 *
 * JSON sources get a direct diff (no AI): re-derive the expected value from the raw file using
 * the exact same deterministic mapping the extractor used, then compare.
 *   - YAHOO_FIELD_MAP facts: re-applies YAHOO_FIELD_MAP's own pct/divideBy100 transform
 *     (lib/data/input-sources/router.ts) to the raw dotted-path field.
 *   - YAHOO_EARNINGS_TREND facts: re-reads the matching earningsTrend.trend[] entry by endDate.
 *   - SEC_MAP facts: re-reads facts.us-gaap[tag].units[*][] for an entry whose `end` matches
 *     FinancialFact.period, mirroring sec.ts's flattenFacts() (value is a raw XBRL `val`, no
 *     transform — see sec.ts).
 *
 * PDF sources (HKEX annual reports) have no fixed-path structure to diff against — per the Phase 4
 * spec, those need an AI cross-check instead, not implemented here. This is a real gap, not a
 * silent one: flagged per-fact in `unverified`, and it currently affects zero real facts (nothing
 * in FinancialFact is PDF-extracted yet — HKEX filings are archived on disk but no extractor reads
 * them into FinancialFact today, confirmed against the live DB 2026-08-21). A ticker whose facts
 * are all Yahoo/SEC-sourced (every ticker in this DB today) gets full gate6 coverage regardless.
 *
 * Non-JSON, non-PDF sources (e.g. a plain-text `.txt` archive of manually-transcribed data — see
 * RawSource.market='MANUAL') get the same `unverified` treatment as PDF, for the same reason: no
 * fixed-path structure to diff against automatically. Confirmed real, not hypothetical: a live
 * INSET.BK run (2026-08-21) archived TradingView-sourced facts as a `.txt` file, and the old code
 * — which assumed every non-PDF file was JSON — tried `JSON.parse()` on it, failed, and
 * misclassified all 60 facts as `source-file-unreadable` (a hard issue) when the file was in fact
 * perfectly readable, just not machine-parseable the way the other sources are. Only a genuine
 * `.json` file that fails to parse (actually corrupt) is still flagged as a real issue.
 */
import fs from "fs/promises";
import { YAHOO_FIELD_MAP } from "../data/input-sources/router";
import type { GateOutcome } from "./types";

interface NenaFact {
  id: string;
  metricName: string;
  value: number;
  period: string;
  extractedBy: string;
  rawSourceId: string;
}

interface NenaRawSource {
  id: string;
  filePath: string;
}

interface NenaIssue {
  factId: string;
  metricName: string;
  reason: string;
  detail: string;
}

function dig(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

function nearlyEqual(a: number, b: number, relTol = 1e-4): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= relTol;
}

const YAHOO_FIELD_BY_METRIC_NAME = new Map(Object.entries(YAHOO_FIELD_MAP).map(([pathKey, def]) => [def.metricName, { pathKey, def }]));

function checkYahooFieldMapFact(fact: NenaFact, json: unknown, filePath: string): NenaIssue | null {
  const mapping = YAHOO_FIELD_BY_METRIC_NAME.get(fact.metricName);
  if (!mapping) return { factId: fact.id, metricName: fact.metricName, reason: "no-known-mapping", detail: `"${fact.metricName}" not found in YAHOO_FIELD_MAP` };

  const rawValue = dig(json, mapping.pathKey);
  if (typeof rawValue !== "number") {
    return { factId: fact.id, metricName: fact.metricName, reason: "raw-field-missing", detail: `${mapping.pathKey} not found/not-a-number in ${filePath}` };
  }
  const expected = mapping.def.pct ? rawValue * 100 : mapping.def.divideBy100 ? rawValue / 100 : rawValue;
  if (!nearlyEqual(expected, fact.value)) {
    return { factId: fact.id, metricName: fact.metricName, reason: "value-mismatch", detail: `raw ${mapping.pathKey}=${rawValue} -> expected ${expected}, FinancialFact.value=${fact.value}` };
  }
  return null;
}

const EARNINGS_TREND_PATTERN = /^(Revenue|EPS) Estimate \((Avg|High|Low|# Analysts)\)$/;
const EARNINGS_TREND_STAT_KEY: Record<string, string> = { Avg: "avg", High: "high", Low: "low", "# Analysts": "numberOfAnalysts" };

function checkEarningsTrendFact(fact: NenaFact, json: unknown, filePath: string): NenaIssue | null {
  const match = fact.metricName.match(EARNINGS_TREND_PATTERN);
  if (!match) return { factId: fact.id, metricName: fact.metricName, reason: "no-known-mapping", detail: `"${fact.metricName}" doesn't match the earningsTrend naming pattern` };

  const [, field, stat] = match;
  const trend = (json as { earningsTrend?: { trend?: unknown[] } })?.earningsTrend?.trend ?? [];
  const entry = trend.find((t) => {
    const endDate = (t as { endDate?: string })?.endDate;
    return endDate && new Date(endDate).toISOString().slice(0, 10) === fact.period;
  }) as { revenueEstimate?: Record<string, unknown>; earningsEstimate?: Record<string, unknown> } | undefined;

  const node = field === "Revenue" ? entry?.revenueEstimate : entry?.earningsEstimate;
  const rawValue = node?.[EARNINGS_TREND_STAT_KEY[stat]];
  if (typeof rawValue !== "number") {
    return { factId: fact.id, metricName: fact.metricName, reason: "raw-field-missing", detail: `earningsTrend entry for period ${fact.period} / ${fact.metricName} not found in ${filePath}` };
  }
  if (!nearlyEqual(rawValue, fact.value)) {
    return { factId: fact.id, metricName: fact.metricName, reason: "value-mismatch", detail: `raw=${rawValue}, FinancialFact.value=${fact.value}` };
  }
  return null;
}

function checkSecMapFact(fact: NenaFact, json: unknown, filePath: string): NenaIssue | null {
  const node = (json as { facts?: Record<string, Record<string, { units?: Record<string, unknown[]> }>> })?.facts?.["us-gaap"]?.[fact.metricName];
  let found: number | undefined;
  if (node?.units) {
    for (const entries of Object.values(node.units)) {
      const hit = (entries as Array<{ end?: string; val?: unknown }>).find((e) => e?.end === fact.period);
      if (hit) {
        found = Number(hit.val);
        break;
      }
    }
  }
  if (found === undefined) {
    return { factId: fact.id, metricName: fact.metricName, reason: "raw-field-missing", detail: `us-gaap.${fact.metricName} with end=${fact.period} not found in ${filePath}` };
  }
  if (!nearlyEqual(found, fact.value)) {
    return { factId: fact.id, metricName: fact.metricName, reason: "value-mismatch", detail: `raw val=${found}, FinancialFact.value=${fact.value}` };
  }
  return null;
}

export async function gate6Nena(facts: NenaFact[], rawSources: NenaRawSource[]): Promise<GateOutcome> {
  const rawSourceById = new Map(rawSources.map((r) => [r.id, r]));
  const fileCache = new Map<string, unknown>();
  const issues: NenaIssue[] = [];
  const unverified: { factId: string; metricName: string; reason: string }[] = [];
  let checkedCount = 0;

  for (const fact of facts) {
    const rawSource = rawSourceById.get(fact.rawSourceId);
    if (!rawSource) {
      issues.push({ factId: fact.id, metricName: fact.metricName, reason: "missing-rawsource", detail: `rawSourceId ${fact.rawSourceId} not found` });
      continue;
    }

    if (rawSource.filePath.toLowerCase().endsWith(".pdf")) {
      unverified.push({ factId: fact.id, metricName: fact.metricName, reason: "pdf-needs-ai-crosscheck" });
      continue;
    }

    if (!rawSource.filePath.toLowerCase().endsWith(".json")) {
      unverified.push({ factId: fact.id, metricName: fact.metricName, reason: `non-json-source-format (${rawSource.filePath.split(".").pop()}) — needs manual/AI cross-check` });
      continue;
    }

    if (!fileCache.has(rawSource.filePath)) {
      try {
        const raw = await fs.readFile(rawSource.filePath, "utf-8");
        fileCache.set(rawSource.filePath, JSON.parse(raw));
      } catch {
        fileCache.set(rawSource.filePath, null);
      }
    }
    const json = fileCache.get(rawSource.filePath);
    if (json == null) {
      issues.push({ factId: fact.id, metricName: fact.metricName, reason: "source-file-unreadable", detail: `could not read/parse ${rawSource.filePath}` });
      continue;
    }

    checkedCount++;
    let issue: NenaIssue | null = null;
    if (fact.extractedBy === "YAHOO_FIELD_MAP") issue = checkYahooFieldMapFact(fact, json, rawSource.filePath);
    else if (fact.extractedBy === "YAHOO_EARNINGS_TREND") issue = checkEarningsTrendFact(fact, json, rawSource.filePath);
    else if (fact.extractedBy === "SEC_MAP") issue = checkSecMapFact(fact, json, rawSource.filePath);
    else {
      checkedCount--;
      unverified.push({ factId: fact.id, metricName: fact.metricName, reason: `unknown extractedBy "${fact.extractedBy}" — no direct-diff mapping implemented` });
      continue;
    }
    if (issue) issues.push(issue);
  }

  return {
    gateNumber: 6,
    gateName: "nena",
    passed: issues.length === 0,
    notes: { checkedCount, totalFacts: facts.length, unverifiedCount: unverified.length, issues, unverified },
  };
}
