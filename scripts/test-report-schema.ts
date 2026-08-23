/**
 * Phase 0 smoke test for lib/report/schema.ts's zod gates — no DB, no network.
 *   npx tsx scripts/test-report-schema.ts
 */
import { validateSection, validateReport } from "../lib/report/schema";

// 1. metric with a value but no factId -> must fail (Gate 1)
const bad = validateSection("fundamentals", {
  profile: { label: "Profile", metrics: [{ name: "Market Cap", value: 2.28e9, unit: "currency", factId: null }] },
  margins: { label: "M", metrics: [] },
  returns: { label: "R", metrics: [] },
  valuationTTM: { label: "V", metrics: [] },
  valuationNTM: null,
  financialHealth: { label: "F", metrics: [] },
  growth: { label: "G", metrics: [] },
  dividends: null,
});
console.log("no-factId ->", bad.ok ? "PASS (wrong!)" : "REJECT ✓", bad.ok ? "" : bad.errors[0]);

// 2. bullet with no example -> fail
const b2 = validateSection("riskFactors", [{ title: "Debt", body: "very high debt, dangerous" }]);
console.log("no-example ->", b2.ok ? "PASS (wrong!)" : "REJECT ✓");

// 3. only one bull -> fail (Gate 3 Balance) — ClaimItem shape (bulls/bears stopped being string[]
// after the synthesis eval showed inline-cited strings can't be grounding-checked)
const b3 = validateSection("bulls", [{ claim: "cheap at 2.7x PE relative to peers", supportingFactIds: ["fact1"] }]);
console.log("bulls<2   ->", b3.ok ? "PASS (wrong!)" : "REJECT ✓");

// dates used below: computed relative to "now" so this test doesn't silently start failing once
// enough real time passes for a hardcoded date to fall inside the 90-day floor (see case 8)
const farEnough = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const tooSoon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// 4. verdict with no killCriteria -> fail
const b4 = validateSection("verdict", {
  decision: "NO_GO",
  conviction: 3,
  thesis: "x".repeat(25),
  killCriteria: [],
  reviewDate: farEnough,
});
console.log("no-kill   ->", b4.ok ? "PASS (wrong!)" : "REJECT ✓");

// 5. valid input -> must pass
const good = validateSection("verdict", {
  decision: "NO_GO",
  conviction: 3,
  thesis: "genuinely cheap at PE 2.7 / PB 0.6 but down 45% over 5 years + D/E 0.9 suggests a value trap",
  killCriteria: ["net debt drops below 1.5B", "revenue grows 2 quarters in a row"],
  reviewDate: farEnough,
});
console.log("valid     ->", good.ok ? "PASS ✓" : "REJECT (wrong!)");

// 6. empty report -> fail, listing what's missing
const empty = validateReport({});
console.log("empty     ->", empty.ok ? "PASS (wrong!)" : `REJECT ✓ (${empty.errors.length} errors)`);

// 7. claim with a factId written inline in the text -> fail (the specific failure mode ClaimItem's
// refine exists to block — see docs/eval/synthesis.md for the live groq case that motivated this)
const b7 = validateSection("bulls", [
  { claim: "Strong margins per cmt023y0j000dvgwk0b278qg2 filing", supportingFactIds: ["cmt023y0j000dvgwk0b278qg2"] },
  { claim: "Healthy balance sheet with low leverage", supportingFactIds: ["cmt023y0j0009vgwk1zywig2s"] },
]);
console.log("inline-id ->", b7.ok ? "PASS (wrong!)" : "REJECT ✓");

// 8. reviewDate less than 90 days out -> fail (both ollama runs in docs/eval/synthesis.md returned
// today's date despite the prompt asking for +90 days — this is now a hard zod gate, not just an instruction)
const b8 = validateSection("verdict", {
  decision: "WAIT",
  conviction: 3,
  thesis: "x".repeat(25),
  killCriteria: ["x"],
  reviewDate: tooSoon,
});
console.log("reviewDate<90d ->", b8.ok ? "PASS (wrong!)" : "REJECT ✓");
