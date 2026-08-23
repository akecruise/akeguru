import { RateLimitError, FatalProviderError } from "./errors";

/**
 * Groq (api.groq.com) — OpenAI-compatible chat completions, free tier.
 *
 * Model default note: llama-3.1-8b-instant and llama-3.3-70b-versatile (the models most people
 * remember for Groq) were deprecated 2026-06-17. Using openai/gpt-oss-20b instead — current,
 * fast, good instruction-following for structured JSON.
 *
 * Free tier (confirmed for the current models, console.groq.com/docs/rate-limits):
 * 30 RPM / 8K TPM / 1K RPD / 200K TPD.
 *
 * The 8K TPM cap is enforced per-request, not just as a rolling rate — confirmed live: a request
 * with ~2K input tokens + max_tokens:8192 was rejected outright (HTTP 413, "Requested 10228,
 * Limit 8000"). So input + max_tokens must together stay under 8000 for every single call, not
 * just averaged per minute. MSFT's 90-fact input alone is close to that ceiling, so it may not
 * fit no matter how low max_tokens goes — a real capacity limit of this model on this free tier,
 * not a bug to tune around indefinitely.
 */
const API_KEY = process.env.GROQ_API_KEY ?? "";
export const MODEL_NAME = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

interface GroqResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: { message?: string; type?: string; code?: string };
}

// jsonSchema is unused here — only claude-cli.ts's --json-schema mechanism needs it; kept in the
// signature so every provider shares one call shape (see lib/agents/runner.ts).
export async function generate(systemPrompt: string, userPrompt: string, jsonSchema?: Record<string, unknown>): Promise<string> {
  void jsonSchema;
  if (!API_KEY) throw new FatalProviderError("groq", "GROQ_API_KEY ไม่ได้ตั้ง — สมัครฟรีที่ https://console.groq.com/keys");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL_NAME,
      response_format: { type: "json_object" }, // not supported with streaming — plain fetch, no stream
      // 8192 (Anthropic's budget) blew straight through the 8K TPM cap combined with input;
      // 2048 was too tight and still truncated (finish_reason=length) — confirmed live both ways.
      max_tokens: 3500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining-tokens");
    const resetTokens = res.headers.get("x-ratelimit-reset-tokens");
    const retryAfter = res.headers.get("retry-after");
    throw new RateLimitError(
      "groq",
      `remaining-tokens=${remaining ?? "?"} reset-tokens=${resetTokens ?? "?"} retry-after=${retryAfter ?? "?"}s — likely hit the daily token cap (200K TPD free tier)`,
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as GroqResponse | null;
    throw new Error(`Groq request failed (${res.status}): ${body?.error?.message ?? (await res.text().catch(() => ""))}`);
  }

  const data = (await res.json()) as GroqResponse;
  const choice = data.choices?.[0];
  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    throw new Error(`Groq: generation did not finish normally (finish_reason=${choice.finish_reason})`);
  }
  const text = choice?.message?.content;
  if (!text) throw new Error("Groq returned an empty response.");
  return text;
}
