# akeguru

A personal stock-research app modeled on GuruFocus and Simply Wall St — fundamentals lookup, a personal watchlist, a screener, a Snowflake-style valuation score, configurable fundamental/momentum ranking, and on-demand AI deep reports that combine cached fundamentals with your own notes.

Covers both Thai (SET, `.BK`) and global/US stocks. Built with Next.js (App Router), TypeScript, Prisma 7, and PostgreSQL.

## Stack

- **App**: Next.js 16 (App Router), TypeScript, Tailwind CSS 4, Recharts
- **Data**: PostgreSQL via Prisma 7 (driver adapters, `@prisma/adapter-pg`)
- **Auth**: NextAuth v4 (Credentials + JWT)
- **Market data**: `yahoo-finance2` (unofficial, free — see [Data source](#data-source) below)
- **AI**: `@anthropic-ai/sdk` for on-demand deep reports

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

`npm run refresh` runs `scripts/refresh-universe.ts` — it fetches fundamentals, financial history, and price history for every ticker in `lib/data/universe-{th,us}.ts`, then computes Snowflake scores. It's safe to re-run; everything is upserted.

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
| `npm run refresh` | Refresh the cached ticker universe (fundamentals, prices, scores) — this is what `.github/workflows/refresh.yml` runs daily in production |
| `npm run sync-notes` | **Local-only.** Syncs an Obsidian vault into the `Note` table for deep reports. Needs `OBSIDIAN_VAULT_PATH` and `NOTES_SYNC_USER_EMAIL` set (see `.env`). Never run in CI — a deployed instance has no filesystem access to your vault. |
| `npx prisma studio` | Browse the database |

## Data source

Fundamentals come from `yahoo-finance2`, an unofficial wrapper around Yahoo Finance. It's the only realistic free option that covers Thai (SET) tickers — Twelve Data's free tier is US-only, and SET's own data API is paid. It does occasionally break on individual tickers (see `INTUCH.BK` in the universe list, which fails a schema-validation check reproducibly as of this writing) — the refresh job logs and skips failures rather than aborting. If reliability becomes a real problem, `lib/yahoo.ts` is the only file that needs to change; candidates are Twelve Data Grow, Financial Modeling Prep, or EOD Historical Data.

The `yahoo-finance2` version in `package.json` is pinned (no `^`) rather than left open — this library's undocumented upstream API shifts occasionally, and an unpinned version can silently start failing on `npm install`.

## Deep reports

The "Generate report" button on a stock page calls the Anthropic API (`claude-opus-5`) on **your own key** — set `ANTHROPIC_API_KEY` in `.env`. It's on-demand only (never run in bulk or on a schedule) since it's a paid-per-call feature. Reports combine cached fundamentals with any notes you've synced for that ticker via `npm run sync-notes`.

## Deploying

1. Provision a real Postgres (Neon, or Prisma's own hosted Postgres via `npx create-db`) and set `DATABASE_URL` (pooled) / `DIRECT_URL` (direct) accordingly on your hosting platform.
2. Generate a baseline migration against that database (`npx prisma migrate dev --create-only`) and commit it.
3. Deploy the Next.js app (Vercel is the natural fit).
4. Add a `DIRECT_URL` repository secret in GitHub so `.github/workflows/refresh.yml` can run the daily refresh job. The workflow already exists — it just needs the secret to point at production instead of local dev.
5. Set `ANTHROPIC_API_KEY` and `NEXTAUTH_SECRET` (a fresh one, not the dev value) as environment variables on the hosting platform.

`npm run sync-notes` stays a local-only command you run from your own machine whenever your notes change — it's never part of deployment.
