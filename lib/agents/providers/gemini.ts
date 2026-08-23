import { RateLimitError, FatalProviderError } from "./errors";

/** Google AI Studio (generativelanguage.googleapis.com) — free tier. */
const API_KEY = process.env.GEMINI_API_KEY ?? "";
// gemini-2.5-flash returned 404 "no longer available to new users" as of this writing (Aug 2026)
// — confirmed live against the API, not assumed. The 404 body itself named the replacement.
export const MODEL_NAME = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

const TRANSIENT_RETRY_DELAYS_MS = [1000, 3000]; // 503 "high demand" is transient, confirmed live — worth a couple of short retries before giving up

async function doRequest(systemPrompt: string, userPrompt: string): Promise<Response> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    }),
  });
}

// jsonSchema is unused here — only claude-cli.ts's --json-schema mechanism needs it; kept in the
// signature so every provider shares one call shape (see lib/agents/runner.ts).
export async function generate(systemPrompt: string, userPrompt: string, jsonSchema?: Record<string, unknown>): Promise<string> {
  void jsonSchema;
  if (!API_KEY) throw new FatalProviderError("gemini", "GEMINI_API_KEY ไม่ได้ตั้ง — สมัครฟรีที่ https://aistudio.google.com/apikey");

  let res = await doRequest(systemPrompt, userPrompt);
  for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
    if (res.status !== 503) break;
    await new Promise((r) => setTimeout(r, delay));
    res = await doRequest(systemPrompt, userPrompt);
  }

  if (res.status === 429) {
    throw new RateLimitError("gemini", await res.text());
  }
  if (!res.ok) throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as GeminiResponse;
  if (data.promptFeedback?.blockReason) {
    throw new Error(`Gemini: prompt blocked (${data.promptFeedback.blockReason})`);
  }
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Gemini: generation did not finish normally (finishReason=${candidate.finishReason})`);
  }
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}
