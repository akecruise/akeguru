import Anthropic from "@anthropic-ai/sdk";

// On-demand only (never run in bulk across the universe). Uses Claude when ANTHROPIC_API_KEY is
// set (costs real money per call, see .env) — otherwise falls back to a local Ollama model for
// free testing. Ollama has no production equivalent (Vercel can't host a persistent Ollama
// daemon), so the fallback only ever applies to local dev; deployed instances need a real key.
const DEEP_REPORT_MODEL = "claude-opus-5";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

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

// roe/dividendYield/payoutRatio are stored as fractions (e.g. 1.4875 for 148.75%), same as the
// stock page's fmtPct — without this the model was mislabeling e.g. ROE "1.49" as "1.49%".
function fmtPct(v: number | null): string {
  return v == null ? "n/a" : `${(v * 100).toFixed(2)}%`;
}

export function buildDeepReportPrompt(stock: DeepReportStockInput, notes: DeepReportNoteInput[]): string {
  const fundamentals = `
Ticker: ${stock.ticker} (${stock.market}) — ${stock.name}
Sector/Industry: ${stock.sector ?? "n/a"} / ${stock.industry ?? "n/a"}
Price: ${fmt(stock.price)} ${stock.currency ?? ""}
Market cap (USD): ${fmt(stock.marketCapUsd, 0)}
P/E: ${fmt(stock.peRatio)}  P/B: ${fmt(stock.pbRatio)}  ROE: ${fmtPct(stock.roe)}
Debt/Equity: ${fmt(stock.debtToEquity)}
Dividend yield: ${fmtPct(stock.dividendYield)}  Payout ratio: ${fmtPct(stock.payoutRatio)}
Snowflake score: ${fmt(stock.latestOverallScore, 0)}/100 — each dimension below is scored on a 0-5 scale: Value ${fmt(stock.latestValueScore, 1)}/5, Future ${fmt(stock.latestFutureScore, 1)}/5, Past ${fmt(stock.latestPastScore, 1)}/5, Health ${fmt(stock.latestHealthScore, 1)}/5, Dividend ${fmt(stock.latestDividendScore, 1)}/5, Momentum ${fmt(stock.latestMomentumScore, 1)}/5
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

async function generateWithOllama(prompt: string): Promise<{ content: string; model: string }> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  if (!data.message?.content) {
    throw new Error("Ollama returned an empty response.");
  }

  return { content: data.message.content, model: `ollama/${OLLAMA_MODEL}` };
}

async function generateWithClaude(prompt: string): Promise<{ content: string; model: string }> {
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

export async function generateDeepReport(
  stock: DeepReportStockInput,
  notes: DeepReportNoteInput[],
): Promise<{ content: string; model: string }> {
  const prompt = buildDeepReportPrompt(stock, notes);
  return process.env.ANTHROPIC_API_KEY ? generateWithClaude(prompt) : generateWithOllama(prompt);
}
