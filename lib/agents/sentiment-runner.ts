/**
 * Runs the sentiment agent (.claude/agents/analysis/sentiment.md) against one social-media post.
 * Deliberately separate from runAgent() (runner.ts): that function's retry loop is built around
 * FinancialFact grounding (a ticker's numeric facts) and StockReport section schemas -- neither
 * applies to a post's free text. This reuses the same providers, same schema-validate-then-retry
 * shape, and the same fatal-vs-transient error handling (FatalProviderError fails fast,
 * RateLimitError backs off, everything else retries) rather than inventing a different contract.
 */
import path from "path";
import { z } from "zod";
import { PROVIDERS, resolveProvider, loadAgent, tryParseJson, type AgentProvider } from "./runner";
import { RateLimitError, FatalProviderError } from "./providers/errors";
import { SentimentAnalysisSchema, buildPostContext, type SentimentAnalysis, type PostInput } from "../social-sentiment";

const MAX_RETRIES = 2; // same budget runAgent() uses -- 1 initial attempt + up to 2 retries
const RATE_LIMIT_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AGENT_PATH = path.join(__dirname, "../../.claude/agents/analysis/sentiment.md");

export interface SentimentRunResult {
  ok: boolean;
  analysis: SentimentAnalysis | null;
  provider: AgentProvider;
  backendModel: string;
  retryCount: number;
  errors?: string[];
  elapsedMs: number;
}

export async function runSentimentAgent(post: PostInput, providerOverride?: AgentProvider): Promise<SentimentRunResult> {
  const startedAt = Date.now();
  const agent = await loadAgent(AGENT_PATH);

  const providerName = resolveProvider(providerOverride);
  const provider = PROVIDERS[providerName];
  const backendModel = provider.MODEL_NAME;

  const jsonSchema = z.toJSONSchema(SentimentAnalysisSchema as unknown as z.ZodType) as Record<string, unknown>;
  const userMessageBase = buildPostContext(post);

  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const userMessage =
      lastErrors.length === 0
        ? userMessageBase
        : `${userMessageBase}\n\nOutput รอบก่อนไม่ผ่าน validation ด้วย error เหล่านี้ — แก้แล้วส่ง JSON ทั้งก้อนใหม่:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;

    let text: string;
    try {
      text = await provider.generate(agent.instructions, userMessage, jsonSchema);
    } catch (e) {
      if (e instanceof FatalProviderError || attempt === MAX_RETRIES) {
        return {
          ok: false,
          analysis: null,
          provider: providerName,
          backendModel,
          retryCount: attempt,
          errors: [(e as Error).message],
          elapsedMs: Date.now() - startedAt,
        };
      }
      if (e instanceof RateLimitError) await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      lastErrors = [];
      continue;
    }

    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      lastErrors = [`output ไม่ใช่ JSON ที่ parse ได้: ${text.slice(0, 200)}`];
      continue;
    }

    const result = SentimentAnalysisSchema.safeParse(parsed);
    if (result.success) {
      return {
        ok: true,
        analysis: result.data,
        provider: providerName,
        backendModel,
        retryCount: attempt,
        elapsedMs: Date.now() - startedAt,
      };
    }
    lastErrors = result.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
  }

  return {
    ok: false,
    analysis: null,
    provider: providerName,
    backendModel,
    retryCount: MAX_RETRIES,
    errors: lastErrors,
    elapsedMs: Date.now() - startedAt,
  };
}
