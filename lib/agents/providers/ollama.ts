/** Free local testing — no production equivalent (Vercel can't host a persistent Ollama daemon),
 *  same reasoning as lib/deep-report.ts's Ollama fallback. */
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
export const MODEL_NAME = process.env.OLLAMA_MODEL ?? "qwen3:8b";

// jsonSchema is unused here — only claude-cli.ts's --json-schema mechanism needs it; kept in the
// signature so every provider shares one call shape (see lib/agents/runner.ts).
export async function generate(systemPrompt: string, userPrompt: string, jsonSchema?: Record<string, unknown>): Promise<string> {
  void jsonSchema;
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_NAME,
      format: "json", // constrains output to valid JSON — qwen3 is a "thinking" model and would
      // otherwise wrap the answer in <think>...</think> plus prose despite instructions not to
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama request failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { message?: { content?: string } };
  if (!data.message?.content) throw new Error("Ollama returned an empty response.");
  return data.message.content;
}
