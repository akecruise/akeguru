/** Thrown by a provider's generate() on an HTTP 429 (or provider-specific rate-limit signal) so
 *  callers (scripts/eval-models.ts especially — Groq's free tier has a real daily token cap) can
 *  report it clearly instead of it looking like a generic crash. */
export class RateLimitError extends Error {
  constructor(
    public readonly provider: string,
    detail: string,
  ) {
    super(`${provider}: rate limited — ${detail}`);
    this.name = "RateLimitError";
  }
}
