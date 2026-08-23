import Anthropic from "@anthropic-ai/sdk";
import { RateLimitError } from "./errors";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  return (_client ??= new Anthropic());
}

// Only one agent file exists right now (valuation.md, "model: opus"), and this is the paid
// provider the user is explicitly avoiding until free alternatives are evaluated — so this
// stays a single configurable model rather than re-deriving runner.ts's old per-agent
// fable5/opus/sonnet -> model-string table. If a second agent file needs a different Claude
// tier, override ANTHROPIC_MODEL per-run rather than reintroducing that mapping here.
export const MODEL_NAME = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";

// jsonSchema is unused here — only claude-cli.ts's --json-schema mechanism needs it; kept in the
// signature so every provider shares one call shape (see lib/agents/runner.ts).
export async function generate(systemPrompt: string, userPrompt: string, jsonSchema?: Record<string, unknown>): Promise<string> {
  void jsonSchema;
  const client = getClient();
  try {
    const stream = client.messages.stream({
      model: MODEL_NAME,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new Error("Anthropic: model ปฏิเสธการสร้างคำตอบ");
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status === 429) {
      throw new RateLimitError("anthropic", e.message);
    }
    throw e;
  }
}
