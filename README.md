# akeguru

A personal stock-research app modeled on GuruFocus and Simply Wall St — fundamentals lookup, a personal watchlist, a screener, a Snowflake-style valuation score, configurable fundamental/momentum ranking, and on-demand AI deep reports that combine cached fundamentals with your own notes.

Covers Thai (SET, `.BK`), global/US, and Hong Kong (HKEX, `.HK`) stocks. Built with Next.js (App Router), TypeScript, Prisma 7, and PostgreSQL.

## Stack

- **App**: Next.js 16 (App Router), TypeScript, Tailwind CSS 4, Recharts
- **Data**: PostgreSQL via Prisma 7 (driver adapters, `@prisma/adapter-pg`)
- **Auth**: NextAuth v4 (Credentials + JWT)
- **Market data**: `yahoo-finance2` (unofficial, free — see [Data source](#data-source) below)
- **AI**: two separate systems, both defaulting to the local `claude` CLI (headless `claude -p`, no API key — uses whatever this machine's `claude login` session already has) now that deploy is local —
  - the original on-demand "Deep report" button (`lib/deep-report.ts`): Anthropic API (`@anthropic-ai/sdk`, needs `ANTHROPIC_API_KEY`) if set → local `claude` CLI → Ollama as a last resort
  - the newer Compound OS multi-agent research pipeline (`lib/agents/`, `.claude/agents/analysis/*.md` — valuation/risk/moat/business/growth/synthesis, plus a pure-function `estimates` step): `AGENT_PROVIDER=claude-cli` by default, with `gemini` wired up as a free-tier fallback; see [Compound OS pipeline](#compound-os-pipeline) below

See `C:\Users\ADMin\.claude\plans\lazy-strolling-rossum.md` for the full design rationale, architecture review notes, and build history.

## Local development

### 1. Install and start the local database

This project uses `prisma dev` — a local Postgres-compatible database that needs no Docker or cloud account.

```bash
npm install
npx prisma dev --name akeguru --detach   # starts a local DB in the background
```

If the local DB ever drops (it has, occasionally, during long-running scripts), restart it with `npx prisma dev start akeguru`. Check status with `npx prisma dev ls`.

Copy `.env` and fill in `DATABASE_URL` / `DIRECT_URL` with the connection string `prisma dev` prints (both point at the same local instance for dev). `NEXTAUTH_SECRET` needs a random value (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).

### 2. Push the schema and seed data

```bash
npx prisma db push       # sync the schema (local dev only — see note below)
npm run refresh          # pull fundamentals for the curated ticker universe from Yahoo
```

`npm run refresh` runs `scripts/refresh-universe.ts` — it fetches fundamentals, financial history, and price history for every ticker in `lib/data/universe-{th,us,hk}.ts`, then computes Snowflake scores. It's safe to re-run; everything is upserted.

> **Note on `prisma db push` vs `prisma migrate dev`**: the local `prisma dev` engine doesn't support a genuine second (shadow) database, so `prisma migrate dev` fails there. Local iteration uses `db push` instead. When deploying against a real Postgres (Neon, Prisma Postgres, etc.), generate a proper baseline migration there with `prisma migrate dev --create-only`.

### 3. Run the app

```bash
npm run dev
```

Visit `http://localhost:3000`. Register an account to use the watchlist and deep reports.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run build` / `npm run start` | Production build / start |
| `npm run refresh` | Refresh the cached ticker universe (fundamentals, prices, scores) — scheduled locally via Windows Task Scheduler (see [Deploying](#deploying)) |
| `npm run sync-notes` | **Local-only.** Syncs an Obsidian vault into the `Note` table for deep reports. Needs `OBSIDIAN_VAULT_PATH` and `NOTES_SYNC_USER_EMAIL` set (see `.env`). |
| `npx tsx scripts/ingest.ts <TICKER>` | Compound OS: pull a ticker's `FinancialFact` rows (see [Compound OS pipeline](#compound-os-pipeline)) |
| `npx tsx scripts/run-report.ts <TICKER>` | Compound OS: run the full agent pipeline for a ticker and save a `ResearchReport` |
| `npx tsx scripts/scorecard.ts [TICKER]` | Verdict Scorecard: every `ResearchReport`'s decision vs. what the price did afterward, flags a WAIT that's run up 15%+ with no re-review as regret |
| `powershell -File scripts/watch-status.ps1` | Live-view `logs/status.json` (the nightly refresh's progress) in a terminal |
| `npx prisma studio` | Browse the database |

## Data source

Fundamentals come from `yahoo-finance2`, an unofficial wrapper around Yahoo Finance. It's the only realistic free option that covers Thai (SET) tickers — Twelve Data's free tier is US-only, and SET's own data API is paid. It does occasionally break on individual tickers (see `INTUCH.BK` in the universe list, which fails a schema-validation check reproducibly as of this writing) — the refresh job logs and skips failures rather than aborting. If reliability becomes a real problem, `lib/yahoo.ts` is the only file that needs to change; candidates are Twelve Data Grow, Financial Modeling Prep, or EOD Historical Data.

The `yahoo-finance2` version in `package.json` is pinned (no `^`) rather than left open — this library's undocumented upstream API shifts occasionally, and an unpinned version can silently start failing on `npm install`.

## Deep reports

The "Generate report" button on a stock page (`lib/deep-report.ts`) is on-demand only (never run in bulk or on a schedule) and combines cached fundamentals with any notes you've synced for that ticker via `npm run sync-notes`. Falls back through 3 backends, same fallback chain as the Compound OS pipeline: the Anthropic API (`claude-opus-5`) if `ANTHROPIC_API_KEY` is set in `.env` (most control — e.g. adaptive thinking isn't available via the CLI) → the local `claude` CLI (free, no key) → Ollama as a last resort if `claude` itself isn't installed/logged in. **No key required** unless you specifically want the Anthropic-API path.

## Compound OS pipeline

A second, newer AI system alongside the single-shot Deep report above: `RawSource -> FinancialFact -> AnalysisOutput -> ResearchReport` (see `prisma/schema.prisma`'s "Compound OS" block — `QualityGateLog`/`KnowledgeNote` are scaffolded there for a planned fuller quality-gate + Obsidian-feedback loop, not implemented yet beyond the schema).

- `scripts/ingest.ts <TICKER>` — pulls Yahoo + SEC/ก.ล.ต. data into `FinancialFact` rows (includes analyst consensus estimates via `mapYahooEarningsTrendFacts`). No AI, 0 tokens.
- `.claude/agents/analysis/*.md` — one markdown prompt per report section (valuation, risk, moat, business, growth, synthesis), run via `lib/agents/runner.ts`'s `runAgent()`: loads facts, calls whichever provider `AGENT_PROVIDER` resolves to, validates the JSON against a zod schema (`lib/report/schema.ts`), retries with the validation errors fed back on failure. `estimates` is a plain function (`lib/report/estimates.ts`), not an agent — turning consensus facts into `EstimateBlock[]` needs no judgment.
- `lib/report/orchestrator.ts` (`scripts/run-report.ts <TICKER>`) — runs every agent for a ticker in dependency order, assembles a full `StockReport`, validates completeness, and saves a `ResearchReport` row on success.
- Grounding checks (`lib/agents/grounding.ts`) catch a model citing a number/id not actually backed by a real `FinancialFact` row — every provider tested so far (including `claude-cli`) has needed this at least once; see `docs/eval/*.md` for the specifics per agent.
- `AGENT_PROVIDER` (`.env`): `claude-cli` (default — local `claude` CLI, headless, no API key) | `gemini` (fallback, free tier, `GEMINI_API_KEY`) | `groq` | `ollama` (test-structure only, not for real use — see `resolveProvider`'s warning) | `xai` | `anthropic` (paid).

## Deploying

**Runs on this machine, not Vercel** — the app, the local Postgres (`prisma dev`), and the Compound OS pipeline (via the local `claude` CLI) are all local. Nothing here needs `ANTHROPIC_API_KEY`, a cloud Postgres, or a Vercel account.

- **Web app**: `npm run build && npm run start` (or just `npm run dev` for a personal single-user setup) on this machine, kept running (e.g. as a Windows service, or just a terminal you leave open).
- **Daily refresh** (`scripts/refresh-universe.ts`): scheduled locally via **Windows Task Scheduler** instead of `.github/workflows/refresh.yml` — that GitHub Actions workflow still exists and still works if you ever do move to a cloud Postgres, but isn't what's actually scheduled right now. Task Scheduler runs `scripts/run-refresh-task.ps1`, not the tsx script directly:
  - Self-heals `prisma dev` if it's not running (confirmed live it drops between sessions — see the note in [Local development](#local-development)) instead of failing every night until someone notices.
  - Logs each run to `logs\refresh\<timestamp>.log` via `cmd`-delegated redirection, not PowerShell's own `2>&1`/`*>` — Windows PowerShell 5.1 wraps a native command's stderr as a terminating `NativeCommandError`, which (confirmed live) turned refresh-universe.ts's normal, already-handled per-ticker warnings into a false failure until this was fixed.
  - `lib/refresh.ts` writes live progress to `logs\status.json` (`lib/progress.ts`'s `report()`) as it runs — watch it in another terminal with `powershell -File scripts\watch-status.ps1`, or just read the file. Always ends in a `done`/`failed` state, even on an uncaught crash, so a watcher never has to guess whether "running" means still-in-progress or abandoned.
  - Appends a one-line-per-run summary to the vault's `Pipeline Dashboard.md` (skipped, like every other Obsidian write here, if `OBSIDIAN_VAULT_PATH` isn't set).
  - Posts a done/failed push notification to ntfy.sh if you set `NTFY_TOPIC` in `.env` (opt-in — see the comment there).
  - Register it once: `schtasks /create /tn "akeguru-refresh" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \"<path>\scripts\run-refresh-task.ps1\"" /sc daily /st 06:00`.
- **Deep reports** (the old single-shot feature): same fallback chain as the Compound OS pipeline now — no key needed unless you want the Anthropic-API path specifically (see [Deep reports](#deep-reports)).
- **`npm run sync-notes`**: reads an Obsidian vault (`OBSIDIAN_VAULT_PATH`) into the `Note` table — always local-only regardless of deploy target, since it needs filesystem access to the vault.
- **Obsidian export** (`lib/report/obsidian-export.ts`): `scripts/run-report.ts` writes a `StockReport` into the real vault (`OBSIDIAN_VAULT_PATH`) as `09_Investment_Thesis/<Market>/<TICKER> - <date>.md` — full markdown (thesis, kill criteria, bulls/bears, business summary, fundamentals tables, moat, risk factors, growth drivers, consensus estimates), dated filenames so re-running later doesn't overwrite prior history. Gated on `checkStockReportGrounding()` (`lib/agents/grounding.ts`), not just `validateReport()` — a live run proved schema-valid isn't the same as citation-clean (see `docs/eval/risk.md`/`synthesis.md`, 2026-08-20), so a report with a real grounding issue still gets saved to `ResearchReport` (for review — this pipeline costs real money per run) but is *not* written into the vault until it's clean. `ResearchReport.obsidianPath` records the path when export did happen. Skipped (not failed) if `OBSIDIAN_VAULT_PATH` isn't set — same as `sync-notes.ts`. A Vercel-hosted instance couldn't do any of this (no filesystem access to a local vault), same reasoning `ollama`/`claude-cli` have no serverless equivalent.
