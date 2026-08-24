# TODO

Session close-out notes (2026-08-24). See git log for full detail — this file is a quick pointer
for the next session, not a duplicate of commit messages.

## 1. RefreshLog write resilience — fixed, live confirmation pending

**Symptom** (recurring, 3+ times this session): `runRefresh()`'s final `prisma.refreshLog.update()`
failed with `ECONNREFUSED` on the same long-lived `PrismaClient`/pool that had been under
sustained write load for the whole ~3-5 min run. The actual fetch+scoring work (Stock/
ScoreSnapshot rows) always succeeded regardless — only that last bookkeeping write failed.

**Fix applied** (commit `56242dd`): `writeRefreshLogFinal()` now opens a fresh, short-lived
connection just for that final write, retries 3x with exponential backoff (2s, 4s), and never
throws — a failed log write no longer causes the whole run to read as "failed" or trigger a
redundant re-run of already-successful work.

**Status**: confirmed fixed. The verification run (`npm run refresh`, background job `buzsjb9a8`)
completed after the session-close summary was already sent, so it's recorded here: `status:
PARTIAL`, `finishedAt` set, `tickersProcessed: 183`, `tickersFailed: 1` (the pre-existing,
unrelated INTUCH.BK Yahoo-schema issue) — no ECONNREFUSED, no manual restart-and-retry, correct
on the first attempt. Nothing further needed here.

## 2. CN ADR universe verification — clean, nothing missing

All 23 tickers in `lib/data/universe-cn-adr.ts` have a real `Stock` row + real
`latestOverallScore`. No missing/incomplete tickers to list.

## Explicitly not done today (out of scope by instruction)

- **20-F/IFRS handling** for CN ADR tickers' Compound OS ingestion (`lib/data/input-sources/sec.ts`
  only handles 10-K/us-gaap today — "Analyze this stock" on a CN ADR runs off Yahoo facts only
  until this is built). Documented in `lib/data/universe-cn-adr.ts`'s header comment.
- **Deep crash debugging** for the local `prisma dev` instability. One concrete lead not
  chased further: `%LOCALAPPDATA%\prisma-dev-nodejs\Data\durable-streams\akeguru\
  durable-streams.sqlite` is ~6GB (Prisma Streams / CDC data this app never actually reads
  anywhere in the codebase — grepped, confirmed unused). Plausible contributing factor to the
  connection instability under load. Did **not** touch/truncate/delete it — not confident whether
  it's a prunable log or part of the actual storage engine, and a wrong guess risks real data.
  Worth investigating properly (ask Prisma's own docs/support what this file is and whether it's
  safe to reset) before touching it.
