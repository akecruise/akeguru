import Anthropic from "@anthropic-ai/sdk";

// On-demand only (never run in bulk across the universe) — this calls the Anthropic API on
// the app owner's own key and costs real money per call. See ANTHROPIC_API_KEY in .env.
const DEEP_REPORT_MODEL = "claude-opus-5";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export interface DeepReportStockInput {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  industry: string | null;
  currency: string | null;
  price: number | null;
  marketCapUsd: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  latestOverallScore: number | null;
  latestValueScore: number | null;
  latestFutureScore: number | null;
  latestPastScore: number | null;
  latestHealthScore: number | null;
  latestDividendScore: number | null;
  latestMomentumScore: number | null;
  description: string | null;
}

export interface DeepReportNoteInput {
  title: string;
  content: string;
  syncedAt: Date;
}

function fmt(v: number | null, digits = 2): string {
  return v == null ? "n/a" : v.toFixed(digits);
}

export function buildDeepReportPrompt(stock: DeepReportStockInput, notes: DeepReportNoteInput[]): string {
  const fundamentals = `
Ticker: ${stock.ticker} (${stock.market}) — ${stock.name}
Sector/Industry: ${stock.sector ?? "n/a"} / ${stock.industry ?? "n/a"}
Price: ${fmt(stock.price)} ${stock.currency ?? ""}
Market cap (USD): ${fmt(stock.marketCapUsd, 0)}
P/E: ${fmt(stock.peRatio)}  P/B: ${fmt(stock.pbRatio)}  ROE: ${fmt(stock.roe)}
Debt/Equity: ${fmt(stock.debtToEquity)}
Dividend yield: ${fmt(stock.dividendYield)}  Payout ratio: ${fmt(stock.payoutRatio)}
Snowflake score: ${fmt(stock.latestOverallScore, 0)}/100 (Value ${fmt(stock.latestValueScore, 1)}, Future ${fmt(stock.latestFutureScore, 1)}, Past ${fmt(stock.latestPastScore, 1)}, Health ${fmt(stock.latestHealthScore, 1)}, Dividend ${fmt(stock.latestDividendScore, 1)}, Momentum ${fmt(stock.latestMomentumScore, 1)})
${stock.description ? `Business summary: ${stock.description}` : ""}
`.trim();

  const notesBlock =
    notes.length > 0
      ? notes
          .map((n) => `### ${n.title} (synced ${n.syncedAt.toISOString().slice(0, 10)})\n${n.content}`)
          .join("\n\n")
      : "(No personal notes synced for this ticker.)";

  return `You are writing a deep-dive investment research note for a personal investor, combining cached fundamental data with the investor's own notes.

## Cached fundamentals (daily-refreshed, may be a few days stale)
${fundamentals}

## Investor's personal notes on this ticker
${notesBlock}

## Task
Write a concise deep-dive report (400-700 words) synthesizing the fundamentals and the investor's notes. Cover: (1) a brief thesis in 2-3 sentences, (2) valuation and quality read from the Snowflake dimensions, (3) how the investor's own notes support, complicate, or contradict the fundamentals, (4) key risks, (5) what to watch next. Write in plain prose. Do not fabricate data not present above — if something is unknown, say so plainly rather than guessing.`;
}

export async function generateDeepReport(
  stock: DeepReportStockInput,
  notes: DeepReportNoteInput[],
): Promise<{ content: string; model: string }> {
  const prompt = buildDeepReportPrompt(stock, notes);
  const client = getClient();

  const stream = client.messages.stream({
    model: DEEP_REPORT_MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("The model declined to generate this report.");
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return { content: text, model: message.model };
}
