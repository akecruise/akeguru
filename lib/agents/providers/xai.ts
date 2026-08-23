import { RateLimitError, FatalProviderError } from "./errors";

/**
 * x.ai (Grok) — OpenAI-compatible chat completions. Not Groq (different company, similar name —
 * confirmed mixed up once already during Phase 3 dev; Groq keys start with gsk_, xAI keys with
 * xai-). No response_format/json-mode documented for this endpoint as of Aug 2026 (unlike Groq's
 * response_format:{type:"json_object"}) — relies on the agent's own prompt instructions plus
 * runner.ts's markdown-fence-stripping fallback. Free-tier/rate-limit numbers aren't published in
 * the docs checked; 429 is still handled the same way as the other providers if it happens.
 */
const API_KEY = process.env.XAI_API_KEY ?? "";
export const MODEL_NAME = process.env.XAI_MODEL ?? "grok-4.6";

interface XaiResponse {
  choices?: { message?: { content?: string; refusal?: string | null }; finish_reason?: string }[];
  error?: { message?: string };
}

// jsonSchema is unused here — only claude-cli.ts's --json-schema mechanism needs it; kept in the
// signature so every provider shares one call shape (see lib/agents/runner.ts).
export async function generate(systemPrompt: string, userPrompt: string, jsonSchema?: Record<string, unknown>): Promise<string> {
  void jsonSchema;
  if (!API_KEY) throw new FatalProviderError("xai", "XAI_API_KEY ไม่ได้ตั้ง — สมัครที่ https://console.x.ai");

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (res.status === 429) {
    throw new RateLimitError("xai", `retry-after=${res.headers.get("retry-after") ?? "?"}s — ${await res.text()}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as XaiResponse | null;
    throw new Error(`x.ai request failed (${res.status}): ${body?.error?.message ?? (await res.text().catch(() => ""))}`);
  }

  const data = (await res.json()) as XaiResponse;
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`x.ai: model ปฏิเสธการสร้างคำตอบ (${choice.message.refusal})`);
  if (choice?.finish_reason && choice.finish_reason !== "stop") {
    throw new Error(`x.ai: generation did not finish normally (finish_reason=${choice.finish_reason})`);
  }
  const text = choice?.message?.content;
  if (!text) throw new Error("x.ai returned an empty response.");
  return text;
}
