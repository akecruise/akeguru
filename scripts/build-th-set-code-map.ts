/**
 * Builds docs/th-set-code-map.md by empirically matching ก.ล.ต. financial_statement set_codes
 * against Yahoo's own historical figures (fetchFinancialHistory, same source the Yahoo-only
 * refresh pipeline already uses) for the same ticker and the same calendar year — never mapping
 * a set_code on memorized/assumed magnitudes, and never comparing across different years.
 *
 * Method: for each company, pull every available report_year of financial_statement data, convert
 * (value * unit) to actual THB, and for each calendar year test candidate set_codes against
 * Yahoo's Revenue/NetIncome/TotalDebt/TotalEquity for that SAME year at a tight ±15% tolerance.
 * A candidate is only written into th.ts if it clears CONFIRMED: the same set_code independently
 * matches in >=2 different companies of the same account_form — real cross-company evidence.
 *
 *   npx tsx scripts/build-th-set-code-map.ts
 */
import "dotenv/config";
import fs from "fs/promises";
import { fetchFinancialHistory } from "../lib/yahoo";

const KEY = process.env.SEC_TH_API_KEY!;
const BASE = "https://api.sec.or.th";
const HEADERS = { "Ocp-Apim-Subscription-Key": KEY, Accept: "application/json" };

// CPALL (and every other large-cap general-commercial ticker tried — ADVANC, AOT, HMPRO, CRC,
// BJC, CPN, TRUE) has NO financial_statement data published via this API at all (204 for every
// year 2017-2024), despite existing in the company directory. GULF was the only other company
// found with real data alongside PTT/KTB during Phase 2 dev — this API's financial_statement
// coverage is genuinely sparse, not just delayed. Worth knowing before assuming th.ts will work
// for an arbitrary Thai ticker: it likely won't unless that company happens to be one of the few
// with published data.
const TARGETS = [
  { symbol: "PTT", yahoo: "PTT.BK", industry: "energy" },
  { symbol: "GULF", yahoo: "GULF.BK", industry: "energy/utilities" },
  { symbol: "KTB", yahoo: "KTB.BK", industry: "bank" },
] as const;

interface ThRow {
  calendarYear: number;
  accountForm: string;
  statement: string;
  setCode: string;
  value: number; // already * unit, actual THB
}

async function getUniqueIds(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/v1/one-report/sbo/2023/info/E`, { headers: HEADERS });
  const data = (await res.json()) as { symbol: string; unique_id: string }[];
  const out: Record<string, string> = {};
  for (const t of TARGETS) {
    const hit = data.find((c) => c.symbol === t.symbol);
    if (!hit) throw new Error(`ไม่พบ ${t.symbol} ใน info list`);
    out[t.symbol] = hit.unique_id;
  }
  return out;
}

async function getThRows(uniqueId: string): Promise<ThRow[]> {
  const rows: ThRow[] = [];
  for (let y = 2023; y >= 2017; y--) {
    const res = await fetch(`${BASE}/v1/one-report/fs/${y}/financial_statement/${uniqueId}`, { headers: HEADERS });
    if (res.status !== 200) continue;
    const data = (await res.json()) as any[];
    for (const r of data) {
      const unit = Number(r.unit) || 1;
      for (const [offset, field] of [
        [0, "asof_year"],
        [1, "asof_yesteryear"],
        [2, "asof_year_before_yesteryear"],
      ] as const) {
        const v = Number(r[field]);
        if (!v) continue;
        rows.push({
          calendarYear: y - offset,
          accountForm: r.account_form,
          statement: r.financial_statement,
          setCode: String(r.set_code),
          value: v * unit,
        });
      }
    }
  }
  return rows;
}

interface YearAnchors {
  revenue?: number | null;
  netIncome?: number | null;
  totalDebt?: number | null;
  totalEquity?: number | null;
}

/**
 * Same-calendar-year Yahoo figures, keyed by year — NOT a "today" snapshot. The first version of
 * this script compared 2021 Thai SEC filings against Yahoo's live 2026 TTM data (a 5-year drift)
 * and got 0 genuine cross-company matches even at a loose tolerance for anything but the
 * slowest-moving line items. fetchFinancialHistory() (already used by the Yahoo-only refresh
 * pipeline) gives Yahoo's own historical annual Revenue/NetIncome/TotalDebt/TotalEquity — using
 * the matching year removes that drift entirely instead of just widening the tolerance to paper
 * over it.
 */
async function getYahooAnchorsByYear(yahooTicker: string): Promise<Map<number, YearAnchors>> {
  const history = await fetchFinancialHistory(yahooTicker, "annual");
  const out = new Map<number, YearAnchors>();
  for (const h of history) {
    const year = Number(h.period);
    if (!Number.isFinite(year)) continue;
    out.set(year, { revenue: h.revenue, netIncome: h.netIncome, totalDebt: h.totalDebt, totalEquity: h.totalEquity });
  }
  return out;
}

interface Match {
  symbol: string;
  metric: string;
  setCode: string;
  statement: string;
  calendarYear: number;
  candidateValue: number;
  anchorValue: number;
  ratio: number;
}

function withinTolerance(candidate: number, anchor: number): boolean {
  if (anchor === 0) return false;
  const ratio = candidate / anchor;
  return ratio > 0.85 && ratio < 1.15; // tight — a wide band (previously 0.4-2.5x) let the same
  // set_code "match" Revenue AND Total Equity AND Total Debt simultaneously, which is impossible;
  // that was a sign of false positives, not real identification. ±15% is still generous enough to
  // absorb the multi-year gap between Thai SEC's latest filing and Yahoo's live snapshot for a
  // slow-moving balance-sheet item, while actually discriminating between different real figures.
}

async function main() {
  console.log("looking up unique_ids...");
  const uniqueIds = await getUniqueIds();
  console.log(uniqueIds);

  const allMatches: Match[] = [];
  const allRowsBySymbol: Record<string, ThRow[]> = {};

  for (const t of TARGETS) {
    console.log(`\nfetching ${t.symbol} (${uniqueIds[t.symbol]})...`);
    const rows = await getThRows(uniqueIds[t.symbol]);
    allRowsBySymbol[t.symbol] = rows;
    console.log(`  ${rows.length} row-years fetched, years: ${[...new Set(rows.map((r) => r.calendarYear))].sort()}`);

    const anchorsByYear = await getYahooAnchorsByYear(t.yahoo);
    console.log(`  yahoo history years:`, [...anchorsByYear.keys()].sort());

    // test every Thai SEC year against Yahoo's OWN figure for that same calendar year — not a
    // single "today" snapshot — so a company's own multi-year drift can't produce false negatives
    // (or, worse, false positives against an unrelated year's numbers).
    for (const calendarYear of new Set(rows.map((r) => r.calendarYear))) {
      const anchors = anchorsByYear.get(calendarYear);
      if (!anchors) continue; // Yahoo has no history for this year — skip rather than guess

      const yearRows = rows.filter((r) => r.calendarYear === calendarYear);
      const metricAnchors: [string, number | null | undefined][] = [
        ["revenue", anchors.revenue],
        ["netIncome", anchors.netIncome],
        ["totalEquity", anchors.totalEquity],
        ["totalDebt", anchors.totalDebt],
      ];

      for (const [metric, anchorValue] of metricAnchors) {
        if (anchorValue == null) continue;
        for (const r of yearRows) {
          if (withinTolerance(r.value, anchorValue)) {
            allMatches.push({
              symbol: t.symbol,
              metric,
              setCode: r.setCode,
              statement: r.statement,
              calendarYear: r.calendarYear,
              candidateValue: r.value,
              anchorValue,
              ratio: r.value / anchorValue,
            });
          }
        }
      }
    }
  }

  // ---- classify ----
  // group matches by (accountForm-group, metric, setCode)
  const groupOf = (symbol: string) => (symbol === "KTB" ? "bank" : "general-commercial"); // from observed account_form strings

  type Key = string;
  const bySetCode = new Map<Key, Match[]>();
  for (const m of allMatches) {
    const key = `${groupOf(m.symbol)}|${m.metric}|${m.setCode}`;
    if (!bySetCode.has(key)) bySetCode.set(key, []);
    bySetCode.get(key)!.push(m);
  }

  interface Classified {
    group: string;
    metric: string;
    setCode: string;
    statement: string;
    tier: "CONFIRMED" | "LIKELY";
    evidence: Match[];
  }
  const classified: Classified[] = [];
  for (const [key, matches] of bySetCode) {
    const [group, metric, setCode] = key.split("|");
    const distinctSymbols = new Set(matches.map((m) => m.symbol));
    // CONFIRMED means genuine cross-company evidence: the same set_code independently clears the
    // tight tolerance against two different companies' own (different!) real numbers. A single
    // company matching in multiple *years* is NOT independent evidence — a real recurring line
    // item trivially exists every year regardless of whether it's the right one, so an earlier
    // version of this check (>=2 years => confirmed) rubber-stamped nearly everything and let one
    // set_code "match" Revenue, Total Equity, and Total Debt all at once. For account_forms where
    // only one company has published data (bank: KTB only), cross-company confirmation is
    // structurally impossible right now — those stay LIKELY, honestly, rather than inventing a
    // substitute signal.
    const confirmed = distinctSymbols.size >= 2;
    classified.push({
      group,
      metric,
      setCode,
      statement: matches[0].statement,
      tier: confirmed ? "CONFIRMED" : "LIKELY",
      evidence: matches,
    });
  }

  // ---- write docs/th-set-code-map.md ----
  const lines: string[] = [];
  lines.push("# Thai SEC (ก.ล.ต.) financial_statement set_code map");
  lines.push("");
  lines.push(
    "Generated by `scripts/build-th-set-code-map.ts` — matches ก.ล.ต. `set_code` line items against Yahoo Finance figures for the same ticker at a tight ±15% tolerance. **CONFIRMED** = the same set_code independently matched the same metric's Yahoo anchor for **two different companies** in the same account_form group — real cross-company evidence, not a coincidence of one company's own numbers. **LIKELY** = matched for exactly one company (or an account_form where only one company has data at all — see below). **UNKNOWN** = no candidate cleared tolerance — not listed, just absent. Only CONFIRMED rows are wired into `th.ts`."
  );
  lines.push("");
  lines.push(
    `Tested tickers: ${TARGETS.map((t) => `${t.symbol} (${t.industry})`).join(", ")}. **Real coverage gap found**: every other large-cap general-commercial ticker tried (CPALL, ADVANC, AOT, HMPRO, CRC, BJC, CPN, TRUE) returned no financial_statement data at all via this API (204 for every year 2017-2024) despite existing in the company directory — GULF was the only substitute with real data. This API's financial_statement coverage is sparse; th.ts will only produce ก.ล.ต.-sourced facts for tickers that happen to have data published, and falls back to Yahoo-only for the rest (see warnings in ingest.ts output). Tolerance: candidate/anchor ratio in (0.85, 1.15).`
  );
  lines.push("");

  for (const group of ["general-commercial", "bank"]) {
    lines.push(`## account_form: ${group}`);
    lines.push("");
    for (const tier of ["CONFIRMED", "LIKELY"] as const) {
      lines.push(`### ${tier}`);
      lines.push("");
      const rows = classified.filter((c) => c.group === group && c.tier === tier);
      if (!rows.length) {
        lines.push("_(none)_");
        lines.push("");
        continue;
      }
      lines.push("| metric | set_code | statement | evidence |");
      lines.push("|---|---|---|---|");
      for (const c of rows) {
        const ev = c.evidence
          .map((m) => `${m.symbol} ${m.calendarYear}: ${(m.candidateValue / 1e9).toFixed(1)}B vs anchor ${(m.anchorValue / 1e9).toFixed(1)}B (${m.ratio.toFixed(2)}x)`)
          .join("; ");
        lines.push(`| ${c.metric} | \`${c.setCode}\` | ${c.statement} | ${ev} |`);
      }
      lines.push("");
    }
  }

  await fs.writeFile("docs/th-set-code-map.md", lines.join("\n"));
  console.log("\nwrote docs/th-set-code-map.md");

  const confirmedCount = classified.filter((c) => c.tier === "CONFIRMED").length;
  console.log(`\nCONFIRMED: ${confirmedCount}, LIKELY: ${classified.length - confirmedCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
