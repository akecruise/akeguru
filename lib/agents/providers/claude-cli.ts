import { spawn } from "child_process";
import { RateLimitError } from "./errors";

/**
 * Local Claude Code CLI, headless (`claude -p`) — the primary provider now that the deploy target
 * moved from Vercel to running on the user's own machine. Uses whatever the machine's `claude` CLI
 * is already authenticated with (a Pro/Max subscription via `claude login`, or an API key if the
 * CLI itself is configured that way) — no separate ANTHROPIC_API_KEY needed. gemini stays wired up
 * as a fallback provider (see docs/eval/ for its results) — nothing about it was removed.
 *
 * --allowedTools "" (not --disallowedTools) — an empty *allowlist* rather than a denylist of named
 * tools. `claude -p` runs the full agent loop by default (it can read files on its own); a denylist
 * only blocks tools you thought to name, an empty allowlist blocks everything unconditionally. This
 * matters specifically here: if the model ever reached for a tool and read raw-sources/ directly
 * instead of the FinancialFact rows in the prompt, it could cite numbers with no real factId behind
 * them — grounding would never catch it, because checkGrounding/checkBulletGrounding/etc. only
 * verify a cited factId against the DB, they can't detect "this number came from a file the agent
 * wasn't supposed to read." Confirmed live: `permission_denials` stays `[]` and results are
 * unaffected with every tool blocked this way.
 *
 * Sanity-checks `permission_denials` (not `num_turns`) as the "did it try to use a tool" signal.
 * num_turns is 2 on every normal, fully-successful --json-schema call (turn 1 = the model's answer,
 * turn 2 = the forced tool-call that actually carries the structured output — that's how
 * --json-schema is implemented under the hood, via Anthropic's tool-use mechanism) — treating
 * num_turns > 1 as "a tool was used" would reject every successful call, not just misuse.
 * permission_denials is the real signal: non-empty means the model tried something --allowedTools ""
 * blocked.
 *
 * --json-schema: Anthropic's tool-use mechanism requires the top-level schema type to be "object"
 * (confirmed live: a top-level `{"type":"array",...}` 400s with "Input should be 'object'") — but
 * more than half of this app's sections (riskFactors, moat, businessSummary, growthDrivers,
 * estimates, bulls, bears, ...) are top-level arrays. Fixed by wrapping an array schema as
 * `{type:"object", properties:{data: <array schema>}, required:["data"]}` before sending, then
 * unwrapping `structured_output.data` after — confirmed live this round-trips correctly.
 *
 * Timeout was 120s; raised to 240s after live testing (docs/eval/valuation.md) found MSFT's
 * valuation prompt (146 FinancialFact rows, exhaustive per-metric categorization into 8 groups)
 * reliably exceeds 120s — risk/moat/synthesis use the same 146-row prompt and finish in 55-75s, so
 * this is valuation.md's task shape being slow, not raw prompt size. 240s is a pragmatic 2x margin,
 * not a measured ceiling — revisit if a denser ticker still times out.
 */
const TIMEOUT_MS = 240_000;

export const MODEL_NAME = process.env.CLAUDE_CLI_MODEL ?? "sonnet";

interface ClaudeCliResult {
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  permission_denials?: unknown[];
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: NodeJS.ErrnoException;
}

function runClaudeCli(args: string[], stdinInput: string): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

/**
 * Prepares a zod-derived JSON Schema for --json-schema:
 *  - strips "$schema" — z.toJSONSchema() adds a top-level `$schema: "https://json-schema.org/..."`
 *    meta key; confirmed live the CLI's own schema validator rejects it outright ("not a valid
 *    JSON Schema: no schema with key or ref ...") rather than just ignoring an unrecognized keyword.
 *  - wraps a top-level array schema in {data: [...]} — Anthropic tool-use requires a top-level
 *    object schema (confirmed live: 400s with "Input should be 'object'" otherwise), but most
 *    sections here (riskFactors, moat, businessSummary, ...) are top-level arrays.
 */
function prepareSchema(schema: Record<string, unknown>): { sent: Record<string, unknown>; wrapped: boolean } {
  const { $schema: _drop, ...rest } = schema;
  if (rest.type === "array") {
    return {
      sent: { type: "object", properties: { data: rest }, required: ["data"], additionalProperties: false },
      wrapped: true,
    };
  }
  return { sent: rest, wrapped: false };
}

export async function generate(systemPrompt: string, userPrompt: string, jsonSchema?: Record<string, unknown>): Promise<string> {
  // userPrompt goes over stdin, not argv — a Windows command line has a hard ~32K-character total
  // length limit (spawn() without shell:true still assembles one string for CreateProcess), and
  // userPrompt carries the full FinancialFact list plus, for synthesis, 3 prior sections' JSON —
  // easily 40-70KB for a dense ticker like MSFT (194 facts). Confirmed live: MSFT's synthesis call
  // failed with `spawn ENAMETOOLONG` once synthesis.md's own system prompt grew past ~11KB on top
  // of that (2026-08-21) — 1773.HK (64 facts) stayed under the limit and never failed. systemPrompt
  // stays on argv (--system-prompt) since it's bounded by the .md file's own size, not by ticker
  // data density, and comfortably fits.
  const args = ["-p", "--output-format", "json", "--system-prompt", systemPrompt, "--model", MODEL_NAME, "--allowedTools", ""];

  let wrapped = false;
  if (jsonSchema) {
    const w = prepareSchema(jsonSchema);
    wrapped = w.wrapped;
    args.push("--json-schema", JSON.stringify(w.sent));
  }

  // Array args passed to spawn (not a shell string) — no shell-escaping needed, and no injection
  // risk from prompt content ending up in a shell command line.
  const outcome = await runClaudeCli(args, userPrompt);

  if (outcome.spawnError) {
    if (outcome.spawnError.code === "ENOENT") {
      throw new Error("claude-cli: `claude` CLI ไม่พบใน PATH — ติดตั้งจาก https://claude.com/claude-code ก่อน");
    }
    throw new Error(`claude-cli: spawn ล้มเหลว — ${outcome.spawnError.message}`);
  }
  if (outcome.timedOut) {
    throw new Error(`claude-cli: timeout (${TIMEOUT_MS / 1000}s) ไม่มีการตอบกลับ — kill process แล้ว`);
  }
  if (outcome.code !== 0) {
    throw new Error(`claude-cli: exited with code ${outcome.code} — ${outcome.stderr.slice(0, 500) || outcome.stdout.slice(0, 500) || "(no output)"}`);
  }

  let parsed: ClaudeCliResult;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    throw new Error(`claude-cli: output ไม่ใช่ JSON ที่ parse ได้ (คาดว่าเป็น --output-format json envelope): ${outcome.stdout.slice(0, 300)}`);
  }

  if (parsed.is_error) {
    const detail = parsed.result ?? "(no detail)";
    if (parsed.api_error_status === 429 || /rate.?limit/i.test(detail)) {
      throw new RateLimitError("claude-cli", detail);
    }
    if (
      parsed.api_error_status === 401 ||
      parsed.api_error_status === 403 ||
      /not logged in|authentication|unauthorized|please run.*login|no api key|invalid.*api.?key/i.test(detail)
    ) {
      throw new Error(`claude-cli: ยังไม่ได้ login หรือ auth ใช้ไม่ได้ — รัน \`claude login\` ก่อน (${detail})`);
    }
    throw new Error(`claude-cli: ${detail}`);
  }

  if (parsed.permission_denials && parsed.permission_denials.length > 0) {
    throw new Error(`claude-cli: model พยายามใช้ tool ที่ถูกล็อกไว้ (--allowedTools "") — permission_denials: ${JSON.stringify(parsed.permission_denials).slice(0, 300)}`);
  }

  if (typeof parsed.structured_output === "undefined") {
    // No --json-schema was passed (jsonSchema arg omitted), or the CLI didn't populate it — fall
    // back to the raw result text, same contract as every other provider (runner.ts's
    // tryParseJson + zod validateSection do the shape-checking either way).
    if (!parsed.result) throw new Error("claude-cli: returned an empty response.");
    return parsed.result;
  }

  const output = wrapped ? (parsed.structured_output as { data: unknown }).data : parsed.structured_output;
  return JSON.stringify(output);
}
