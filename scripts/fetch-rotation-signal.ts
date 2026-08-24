/**
 * Macro-regime sector rotation signal -- real yield curve (^TNX-^IRX), VIX, and defensive-vs-
 * cyclical sector relative performance, classified into a best-guess ExitCause via the simple,
 * documented rules-based heuristic in lib/rotation.ts (see that file's header for what this
 * deliberately is NOT -- the full Markov regime-switching / PSY bubble-test / DTW analog-matching
 * vision needs a Python quant service and external data sources this app doesn't have).
 *
 *   npx tsx scripts/fetch-rotation-signal.ts
 */
import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client";
import { yahooFinance, fetchWeeklyPriceHistory } from "../lib/yahoo";
import { classifyExitCause, ROTATION_MAP } from "../lib/rotation";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** Trailing ~3-month (91-day) return from real weekly price history -- reuses the same
 *  fetchWeeklyPriceHistory() every stock in this app already uses, just pointed at a sector ETF. */
async function trailing3moReturn(ticker: string): Promise<number> {
  const history = await fetchWeeklyPriceHistory(ticker);
  if (history.length < 14) throw new Error(`${ticker}: not enough price history for a 3mo return`);
  const sorted = [...history].sort((a, b) => a.date.getTime() - b.date.getTime());
  const latest = sorted[sorted.length - 1];
  const targetTime = latest.date.getTime() - 91 * 24 * 60 * 60 * 1000;
  const past = sorted.reduce((closest, p) => (Math.abs(p.date.getTime() - targetTime) < Math.abs(closest.date.getTime() - targetTime) ? p : closest));
  return ((latest.close - past.close) / past.close) * 100;
}

async function main() {
  const [tnx, irx, vix] = await Promise.all([yahooFinance.quote("^TNX"), yahooFinance.quote("^IRX"), yahooFinance.quote("^VIX")]);
  if (tnx.regularMarketPrice == null || irx.regularMarketPrice == null || vix.regularMarketPrice == null) {
    throw new Error("missing regularMarketPrice on ^TNX/^IRX/^VIX -- aborting rather than compute off an incomplete quote");
  }
  const yieldCurveSpread = tnx.regularMarketPrice - irx.regularMarketPrice;
  const vixLevel = vix.regularMarketPrice;

  const [xlpRet, xlvRet, xluRet, smhRet] = await Promise.all([
    trailing3moReturn("XLP"),
    trailing3moReturn("XLV"),
    trailing3moReturn("XLU"),
    trailing3moReturn("SMH"),
  ]);
  const defensiveVsCyclical3m = (xlpRet + xlvRet + xluRet) / 3 - smhRet;

  const signals = { yieldCurveSpread, vix: vixLevel, defensiveVsCyclical3m };
  const result = classifyExitCause(signals);

  console.log("real signals:");
  console.log(`  yield curve (10Y-3M): ${yieldCurveSpread.toFixed(2)}pp`);
  console.log(`  VIX: ${vixLevel.toFixed(1)}`);
  console.log(`  defensive (XLP/XLV/XLU avg) vs SMH, trailing 3mo: ${defensiveVsCyclical3m.toFixed(1)}pp`);
  console.log(`\nclassification: ${result.cause ?? "— (no confident match)"} (confidence: ${result.confidence})`);
  console.log(`reasoning: ${result.reasoning}`);

  const path = result.cause ? ROTATION_MAP[result.cause] : null;
  if (path) {
    console.log(`\nrotation playbook for ${result.cause}:`);
    console.log(`  phase 1 (${path.phase1.months[0]}-${path.phase1.months[1]}mo): ${path.phase1.sectors.join(", ")}`);
    console.log(`  phase 2 (${path.phase2.months[0]}-${path.phase2.months[1]}mo): ${path.phase2.sectors.join(", ")}`);
    if (path.note) console.log(`  note: ${path.note}`);
    if (path.trigger) console.log(`  trigger: ${path.trigger}`);
    if (path.analog) console.log(`  historical analog: ${path.analog}`);
    if (path.thesis) console.log(`  thesis: ${path.thesis}`);
  } else {
    console.log("\nno rotation playbook shown -- classification wasn't confident enough (see reasoning above).");
  }

  await prisma.rotationSignal.create({
    data: {
      asOf: new Date(),
      exitCause: result.cause,
      confidence: result.confidence,
      reasoning: result.reasoning,
      phase1Sectors: path?.phase1.sectors ?? [],
      phase2Sectors: path?.phase2.sectors ?? [],
      evidence: signals as unknown as Prisma.InputJsonValue,
    },
  });
  console.log("\nsaved RotationSignal.");
}

main()
  .then(() => prisma.$disconnect())
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    await pool.end();
    process.exitCode = 1;
  });
