/**
 * Guru Lens -- 9 investor personas from the VI/Quant Masters framework mapped earlier this
 * session, each a deterministic rule (no LLM call) applied to real, already-computed data.
 * Every eval() below is pure math/comparison over fields that already exist on Stock /
 * ResearchReport / MarketRegime -- nothing here is agent-generated or fabricated.
 *
 * Two lenses (Buffett, Munger) need a real ResearchReport (moat strength, gate-pass rate come
 * from agent output, not the Snowflake refresh) -- for a ticker never analyzed they return
 * 'UNANALYZED', not a guessed PASS, since "reviewed and rejected" and "never reviewed" are
 * different facts. The other 7 work for any scored ticker, analyzed or not.
 *
 * Two lenses (Greenblatt, Asness) need pool-wide context (a rank / a percentile against the rest
 * of the candidates shown) -- every lens's eval() takes a `PoolContext` built once per page load
 * (buildPoolContext) so the interface stays uniform even though most lenses ignore it.
 *
 * Known, deliberate simplifications vs. the personas' real methods (documented instead of
 * hidden, same discipline as lib/magic-formula.ts/lib/neff.ts):
 *   - Buffett's "ROE > 15% in 6 of the last 10 years" needs 10 years of annual ROE history this
 *     app doesn't retain (FinancialHistory keeps ~9 rows, mixed annual/quarterly) -- uses
 *     *current* ROE > 15% instead, labeled as such, not a fabricated multi-year count.
 *   - "Margin of safety" (Graham/Klarman/Marks) uses analyst target-price upside
 *     ((analystTargetPrice - price) / price), not a real intrinsic-value/DCF calculation --
 *     labeled "MOS proxy" everywhere it's shown. A real ResearchReport's Expectation Gap (reverse
 *     DCF) is a better answer to the same question but only exists for analyzed tickers.
 *   - Marks' "market cycle" uses this app's real MarketRegime classification (RISK_ON/MIXED/
 *     RISK_OFF, market breadth-based) in place of a CAPE percentile -- no valuation-index data
 *     exists in this pipeline (same gap lib/regime.ts's own header documents).
 *   - Turtle/Dennis only ever recommends BUY or WATCH (long-only app, no short capability) --
 *     a confirmed short breakout is surfaced as PASS ("avoid"), not a literal SELL/short order.
 *   - Position sizing deliberately excludes Kelly: no real edge/win-probability exists anywhere
 *     in this pipeline to feed one, and treating conviction (1-5) as a win probability would be
 *     exactly the fabricated-precision mistake lib/position-sizing.ts's own doc comment already
 *     rejects. Guru Lens shows the two sizing lenses that already exist for real: inverse-vol
 *     (lib/position-sizing.ts) and Turtle unit sizing (lib/turtle.ts).
 */
import { rankMagicFormula } from "./magic-formula";
import { percentileMap } from "./consensus";
import { MIN_ANALYSTS_FOR_COVERAGE } from "./report/estimates";

export type LensVerdict = "BUY" | "WATCH" | "PASS" | "SELL" | "UNANALYZED";
export type TurtleConfirmedDirection = "long" | "short" | "none";

export interface GuruCandidate {
  id: string;
  ticker: string;
  price: number | null;
  analystTargetPrice: number | null;
  numAnalystOpinions: number | null;
  peRatio: number | null;
  pegRatio: number | null;
  roe: number | null; // fraction, e.g. 0.18 = 18%
  roa: number | null;
  evToEbitda: number | null;
  estEarningsGrowth: number | null;
  dividendYield: number | null;
  lynchCategory: string | null;
  latestValueScore: number | null; // 0-5
  latestFutureScore: number | null; // 0-5
  latestHealthScore: number | null; // 0-5
  latestMomentumScore: number | null; // 0-5
  latestOverallScore: number | null; // 0-100
  regime: "RISK_ON" | "RISK_OFF" | "MIXED" | null;
  // Report-dependent -- null on every field below means "never analyzed", not "analyzed, scored 0".
  hasReport: boolean;
  moatScore: number | null; // 0-100, average of MoatItem strengths (strong=100/moderate=65/weak=35)
  gatesPassed: number | null;
  gatesTotal: number | null;
  turtleConfirmed: TurtleConfirmedDirection | null;
  turtleWeightPct: number | null;
}

export interface PoolContext {
  magicFormulaRank: Map<string, number>; // id -> combinedRank, 1 = best
  magicFormulaPoolSize: number;
  valuePercentile: Map<string, number>; // id -> percentile within the shown pool
  momentumPercentile: Map<string, number>;
}

/** Computed once per page load over the full candidate pool -- the two pool-relative lenses
 *  (Greenblatt's rank, Asness's percentiles) read from this instead of recomputing per stock. */
export function buildPoolContext(pool: GuruCandidate[]): PoolContext {
  const mfRanks = rankMagicFormula(pool.map((c) => ({ id: c.id, roa: c.roa, evToEbitda: c.evToEbitda })));
  const ids = pool.map((c) => c.id);
  return {
    magicFormulaRank: new Map(mfRanks.map((r) => [r.id, r.combinedRank])),
    magicFormulaPoolSize: mfRanks.length,
    valuePercentile: percentileMap(ids, pool.map((c) => c.latestValueScore), true),
    momentumPercentile: percentileMap(ids, pool.map((c) => c.latestMomentumScore), true),
  };
}

export interface LensDefinition {
  id: string;
  name: string;
  tag: string;
  quote: string;
  rule: string;
  eval(c: GuruCandidate, ctx: PoolContext): { verdict: LensVerdict; reason: string };
}

function pct(v: number | null | undefined, digits = 1): string {
  return v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null ? "—" : v.toFixed(digits);
}

/** Analyst target-price upside as a real, universe-wide "margin of safety" proxy -- not a real
 *  intrinsic-value calc, see this file's header comment. Requires the same MIN_ANALYSTS_FOR_COVERAGE
 *  (3) threshold lib/report/estimates.ts already applies to consensus estimates -- a target price
 *  backed by 1-2 analysts isn't a "consensus," and can read as a wild, misleading upside (confirmed
 *  live: 1773.HK showed +350% off a single analyst's target before this check was added). */
export function analystUpsidePct(c: GuruCandidate): number | null {
  if (c.price == null || c.price <= 0 || c.analystTargetPrice == null) return null;
  if (c.numAnalystOpinions == null || c.numAnalystOpinions < MIN_ANALYSTS_FOR_COVERAGE) return null;
  return ((c.analystTargetPrice - c.price) / c.price) * 100;
}

const UNANALYZED = (what: string) => ({
  verdict: "UNANALYZED" as const,
  reason: `ยังไม่มี Compound OS report ให้ประเมิน${what} — กด "Analyze this stock" ก่อน`,
});

export const GURU_LENSES: LensDefinition[] = [
  {
    id: "buffett",
    name: "Warren Buffett",
    tag: "moat + quality",
    quote: "ซื้อธุรกิจยอดเยี่ยมในราคายุติธรรม ดีกว่าธุรกิจธรรมดาในราคาถูก",
    rule: "BUY: moat score ≥ 75 (จาก MoatItem strength เฉลี่ย) และ ROE ปัจจุบัน > 15%",
    eval(c) {
      if (!c.hasReport || c.moatScore == null) return UNANALYZED("moat");
      const roeOk = c.roe != null && c.roe > 0.15;
      if (c.moatScore >= 75 && roeOk) return { verdict: "BUY", reason: `moat score ${fmt(c.moatScore, 0)}, ROE ${pct(c.roe)} — ธุรกิจแบบนี้ผมถือได้ยาว` };
      if (c.moatScore >= 60) return { verdict: "WATCH", reason: `moat score ${fmt(c.moatScore, 0)} ยัง "ดี" แต่ไม่ "ยอดเยี่ยม" — รอ wonderful business เท่านั้น` };
      return { verdict: "PASS", reason: `moat score ${fmt(c.moatScore, 0)}, ROE ${pct(c.roe)} — ราคาถูกแค่ไหนก็ไม่ชดเชยธุรกิจอ่อน` };
    },
  },
  {
    id: "graham",
    name: "Benjamin Graham",
    tag: "margin of safety",
    quote: "Margin of Safety คือสามคำที่สำคัญที่สุดในการลงทุน",
    rule: "BUY: analyst target upside ≥ 30% (proxy MOS) · WATCH: 15-30%",
    eval(c) {
      const mos = analystUpsidePct(c);
      if (mos == null) return { verdict: "PASS", reason: "ไม่มี analyst target price หรือ analyst น้อยกว่า 3 คน (ไม่พอเป็น consensus)" };
      if (mos >= 30) return { verdict: "BUY", reason: `upside ${fmt(mos)}% — ส่วนเผื่อหนาพอให้ผิดพลาดได้โดยไม่เจ็บหนัก` };
      if (mos >= 15) return { verdict: "WATCH", reason: `upside ${fmt(mos)}% — ยังบางไป รอราคาลงหรือหาหลักฐานเพิ่ม` };
      return { verdict: "PASS", reason: `upside ${fmt(mos)}% — ${mos < 0 ? "เทรดสูงกว่าเป้านักวิเคราะห์แล้ว" : "ไม่มีส่วนเผื่อ = ไม่มีการป้องกัน"}` };
    },
  },
  {
    id: "lynch",
    name: "Peter Lynch",
    tag: "GARP + category",
    quote: "รู้ว่าถืออะไรอยู่ และรู้ว่าถือเพราะอะไร",
    rule: "BUY: PEG < 1 (fast grower/stalwart) · unclassified/cyclical ระวังเป็นพิเศษ",
    eval(c) {
      if (c.pegRatio == null) return { verdict: "PASS", reason: "ไม่มี PEG ให้ประเมิน (กำไรหรือ growth estimate ติดลบ/ไม่มี)" };
      const label = c.lynchCategory ?? "unclassified";
      if (c.lynchCategory === "cyclical") return { verdict: "WATCH", reason: `cyclical, PEG ${fmt(c.pegRatio, 2)} — วงจรธุรกิจสำคัญกว่า PEG จุดเดียว` };
      if (c.pegRatio < 1 && (c.lynchCategory === "fast_grower" || c.lynchCategory === "stalwart")) {
        return { verdict: "BUY", reason: `${label} PEG ${fmt(c.pegRatio, 2)} — จ่ายน้อยกว่าการเติบโตที่ได้ นี่แหละ tenbagger candidate` };
      }
      if (c.pegRatio < 1) return { verdict: "WATCH", reason: `${label} PEG ${fmt(c.pegRatio, 2)} — PEG น่าสนใจ แต่ยังไม่จัด category ที่มั่นใจ` };
      if (c.pegRatio <= 1.5) return { verdict: "WATCH", reason: `${label} PEG ${fmt(c.pegRatio, 2)} — ราคาเต็มแล้ว ไม่แพงแต่ไม่มี edge` };
      return { verdict: "PASS", reason: `${label} PEG ${fmt(c.pegRatio, 2)} — จ่ายแพงกว่า growth ที่ได้จริง` };
    },
  },
  {
    id: "greenblatt",
    name: "Joel Greenblatt",
    tag: "magic formula",
    quote: "ซื้อธุรกิจดี (ROIC สูง) ในราคาถูก (earnings yield สูง) แล้วทำซ้ำอย่างมีวินัย",
    rule: "BUY: Magic Formula-style combined rank top-3 ของ universe ที่มีข้อมูลพอ (ROA + EV/EBITDA)",
    eval(c, ctx) {
      const rank = ctx.magicFormulaRank.get(c.id);
      if (rank == null) return { verdict: "PASS", reason: "ไม่มี ROA หรือ EV/EBITDA พอให้จัดอันดับ Magic Formula" };
      if (rank <= 3) return { verdict: "BUY", reason: `combined rank #${rank}/${ctx.magicFormulaPoolSize} — สูตรบอกให้ซื้อ ไม่เถียงสูตร นั่นคือประเด็นของ Magic Formula` };
      if (rank <= 6) return { verdict: "WATCH", reason: `combined rank #${rank} — เกือบเข้าเกณฑ์ รอ rebalance รอบหน้า` };
      return { verdict: "PASS", reason: `combined rank #${rank} — ระบบทำงานเพราะไม่ยกเว้นให้ตัวที่ "รู้สึกว่าน่าซื้อ"` };
    },
  },
  {
    id: "munger",
    name: "Charlie Munger",
    tag: "inversion",
    quote: "Invert, always invert — บอกผมก่อนว่าตัวนี้ตายยังไง",
    rule: "BUY: gate pass rate ≥ 6/7 (bears case ตอบได้) และ moat score ≥ 70",
    eval(c) {
      if (!c.hasReport || c.gatesTotal == null || c.moatScore == null) return UNANALYZED("bears case");
      const gateRate = c.gatesPassed! / c.gatesTotal!;
      if (gateRate >= 6 / 7 && c.moatScore >= 70) return { verdict: "BUY", reason: `gates ${c.gatesPassed}/${c.gatesTotal} ผ่าน, moat ${fmt(c.moatScore, 0)} — ไม่เจอทางตายถาวร` };
      if (gateRate >= 5 / 7) return { verdict: "WATCH", reason: `gates ${c.gatesPassed}/${c.gatesTotal} — มีคำถามที่ยังตอบไม่สนิท คนฉลาดตายเพราะรีบ` };
      return { verdict: "PASS", reason: `gates ${c.gatesPassed}/${c.gatesTotal} — เจอจุดที่ตอบไม่ได้ รายการ "too hard" มีไว้เพื่อสิ่งนี้` };
    },
  },
  {
    id: "turtle",
    name: "Richard Dennis",
    tag: "turtle rules",
    quote: "กฎคือกฎ — ระบบไม่สนว่าคุณรู้สึกยังไงกับหุ้นตัวนี้",
    rule: "BUY: Donchian breakout ยืนยัน long · avoid: breakout ลง (แอปนี้ long-only)",
    eval(c) {
      if (c.turtleConfirmed == null || c.turtleConfirmed === "none") return { verdict: "WATCH", reason: "ไม่มี breakout ยืนยัน = ไม่มี trade วันนี้ นั่งรอคือส่วนหนึ่งของระบบ" };
      if (c.turtleConfirmed === "long") return { verdict: "BUY", reason: `Donchian breakout ยืนยัน long — suggested weight ${fmt(c.turtleWeightPct, 1)}% ของพอร์ต` };
      return { verdict: "PASS", reason: "breakout ลง ยืนยัน short — แอปนี้ long-only จึง avoid ไม่ short" };
    },
  },
  {
    id: "klarman",
    name: "Seth Klarman",
    tag: "downside first",
    quote: "หน้าที่แรกไม่ใช่ทำกำไร แต่คือไม่ขาดทุนถาวร — ถือ cash ได้ถ้าไม่มีของถูก",
    rule: "BUY: upside proxy ≥ 30% และ Health score ≥ 3.5/5 · ไม่มี MOS = PASS ไม่ใช่ WAIT",
    eval(c) {
      const mos = analystUpsidePct(c);
      const healthOk = c.latestHealthScore != null && c.latestHealthScore >= 3.5;
      if (mos == null) return { verdict: "PASS", reason: "ไม่มี analyst target price ที่น่าเชื่อถือพอ (ต้อง ≥3 analyst) — ไม่มี MOS คือ PASS ทันที" };
      if (mos >= 30 && healthOk) return { verdict: "BUY", reason: `upside ${fmt(mos)}% + health score ${fmt(c.latestHealthScore)}/5 — ขาดทุนยากก่อน แล้วกำไรจะตามมาเอง` };
      if (mos >= 20) return { verdict: "WATCH", reason: `upside ${fmt(mos)}% — ยังไม่หนาพอ ถือ cash รอได้` };
      return { verdict: "PASS", reason: `upside ${fmt(mos)}% — ไม่มีส่วนเผื่อพอ ราคาต้องมาหาเรา` };
    },
  },
  {
    id: "marks",
    name: "Howard Marks",
    tag: "market cycle",
    quote: "คุณบอกอนาคตไม่ได้ แต่บอกได้ว่าตอนนี้ยืนอยู่ตรงไหนของ cycle",
    rule: "Regime-aware (MarketRegime จริง): RISK_OFF/MIXED เข้มเกณฑ์ upside proxy ขึ้น",
    eval(c) {
      const mos = analystUpsidePct(c);
      if (mos == null) return { verdict: "PASS", reason: "ไม่มี analyst target price ที่น่าเชื่อถือพอ (ต้อง ≥3 analyst)" };
      const strict = c.regime !== "RISK_ON";
      const buyBar = strict ? 30 : 20;
      const watchBar = strict ? 15 : 8;
      const regimeLabel = c.regime ?? "ไม่ทราบ regime";
      if (mos >= buyBar && (c.latestHealthScore ?? 0) >= 3) return { verdict: "BUY", reason: `regime ${regimeLabel}, upside ${fmt(mos)}% — ดีกว่าที่ราคาสะท้อนแม้ปรับเกณฑ์ตาม cycle แล้ว` };
      if (mos >= watchBar) return { verdict: "WATCH", reason: `regime ${regimeLabel} — ของกลางๆ ตอนนี้คือ risk ที่ไม่ได้รับค่าตอบแทน` };
      return { verdict: "PASS", reason: `regime ${regimeLabel}, upside ${fmt(mos)}% — จ่ายเต็มราคาตอนที่ทุกคนรู้สึกว่าไม่เสี่ยง คือความเสี่ยงสูงสุด` };
    },
  },
  {
    id: "asness",
    name: "Cliff Asness",
    tag: "value × momentum",
    quote: "Value กับ Momentum เกลียดกันแต่ทำงานคู่กันดีที่สุด — อย่าเลือกข้าง ถือทั้งคู่",
    rule: "BUY: (Value percentile + Momentum percentile) ≥ 120 / 200",
    eval(c, ctx) {
      const v = ctx.valuePercentile.get(c.id);
      const m = ctx.momentumPercentile.get(c.id);
      if (v == null || m == null) return { verdict: "PASS", reason: "ไม่มี Value หรือ Momentum score พอให้จัดเปอร์เซ็นไทล์" };
      const combined = v + m;
      if (combined >= 120) return { verdict: "BUY", reason: `value pct ${fmt(v, 0)} + momentum pct ${fmt(m, 0)} = ${fmt(combined, 0)} — ถูกด้วย วิ่งด้วย` };
      if (combined >= 90) return { verdict: "WATCH", reason: `combined ${fmt(combined, 0)} — factor เดียวเด่น อีกตัวแผ่ว รอยืนยัน` };
      return { verdict: "PASS", reason: `combined ${fmt(combined, 0)} — ไม่ถูกพอและไม่วิ่ง ถือไว้ก็แค่กิน factor risk ฟรี` };
    },
  },
];
