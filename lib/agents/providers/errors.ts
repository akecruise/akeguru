/** Thrown by a provider's generate() on an HTTP 429 (or provider-specific rate-limit signal) so
 *  callers (scripts/eval-models.ts especially — Groq's free tier has a real daily token cap) can
 *  report it clearly instead of it looking like a generic crash. Also a signal to
 *  lib/agents/runner.ts's retry loop: worth retrying (with backoff), unlike FatalProviderError. */
export class RateLimitError extends Error {
  constructor(
    public readonly provider: string,
    detail: string,
  ) {
    super(`${provider}: rate limited — ${detail}`);
    this.name = "RateLimitError";
  }
}

/** Thrown by a provider's generate() for a permanent misconfiguration — not logged in, no API key,
 *  the CLI binary missing from PATH. lib/agents/runner.ts's retry loop rethrows this immediately
 *  instead of burning MAX_RETRIES attempts on a failure a retry can't fix; every other error thrown
 *  from generate() (timeout, non-zero exit, a malformed response envelope, a transient HTTP 5xx) is
 *  presumed transient and gets retried like a validation failure. */
export class FatalProviderError extends Error {
  constructor(
    public readonly provider: string,
    detail: string,
  ) {
    super(`${provider}: ${detail}`);
    this.name = "FatalProviderError";
  }
}
