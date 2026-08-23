/**
 * Xueqiu Layer 8 (Phase 3 roadmap item) — reads posts already linked to a tracked ticker from
 * Codex (a separate local pipeline, D:\Secondbrain\SocialMedia\database\socialmedia.db, SQLite --
 * owns raw post collection, dedup, and stock-mention linking, see that project's own
 * PHASE3_COMPLETE.md), runs this app's sentiment agent on each one not already analyzed, and
 * persists the result as SocialSentiment.
 *
 * Only syncs posts whose Codex-linked ticker matches a Stock this app actually tracks -- Codex's
 * stock_aliases.csv covers tickers (e.g. BYD, TSM) this app's universe doesn't, and there's nothing
 * useful to do with sentiment on a ticker with no FinancialFact/ResearchReport to connect it to.
 *
 *   npx tsx scripts/sync-social-sentiment.ts             (all trackable, unanalyzed posts)
 *   npx tsx scripts/sync-social-sentiment.ts --dry-run    (show what would be analyzed, no LLM calls, no writes)
 *   npx tsx scripts/sync-social-sentiment.ts --limit 5    (cap how many posts to analyze this run)
 */
import "dotenv/config";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runSentimentAgent } from "../lib/agents/sentiment-runner";
import type { PostInput } from "../lib/social-sentiment";

const CODEX_DB_PATH = process.env.CODEX_SOCIALMEDIA_DB_PATH ?? "D:\\Secondbrain\\SocialMedia\\database\\socialmedia.db";

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

interface CodexPost extends PostInput {
  externalPostId: string;
}

function loadCodexPosts(): CodexPost[] {
  const db = new DatabaseSync(CODEX_DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT p.id AS post_id, p.content, p.author, p.published_at, s.name AS source, st.ticker
         FROM posts p
         JOIN sources s ON p.source_id = s.id
         JOIN post_stocks ps ON ps.post_id = p.id
         JOIN stocks st ON st.id = ps.stock_id
         WHERE st.ticker IS NOT NULL`,
      )
      .all() as Array<{ post_id: number; content: string; author: string | null; published_at: string | null; source: string; ticker: string }>;

    return rows.map((r) => ({
      externalPostId: String(r.post_id),
      ticker: r.ticker,
      source: r.source,
      author: r.author,
      publishedAt: r.published_at,
      content: r.content,
    }));
  } finally {
    db.close();
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const codexPosts = loadCodexPosts();
  console.log(`Codex: ${codexPosts.length} post(s) linked to a ticker`);

  const trackedTickers = new Set((await prisma.stock.findMany({ select: { ticker: true } })).map((s) => s.ticker));
  const trackable = codexPosts.filter((p) => trackedTickers.has(p.ticker));
  console.log(`${trackable.length} post(s) are for a ticker this app tracks`);

  const alreadyAnalyzed = new Set(
    (await prisma.socialSentiment.findMany({ select: { sourcePlatform: true, externalPostId: true } })).map(
      (s) => `${s.sourcePlatform}:${s.externalPostId}`,
    ),
  );
  const pending = trackable.filter((p) => !alreadyAnalyzed.has(`${p.source}:${p.externalPostId}`)).slice(0, limit);
  console.log(`${pending.length} post(s) not yet analyzed${Number.isFinite(limit) ? ` (capped at --limit ${limit})` : ""}`);

  if (dryRun) {
    for (const p of pending) console.log(`  [dry-run] ${p.ticker} <- ${p.source}#${p.externalPostId}: ${p.content.slice(0, 80)}`);
    return;
  }

  let analyzed = 0;
  let failed = 0;
  for (const post of pending) {
    const result = await runSentimentAgent(post);
    if (!result.ok || !result.analysis) {
      console.warn(`  FAILED ${post.ticker} <- ${post.source}#${post.externalPostId}: ${result.errors?.join("; ")}`);
      failed++;
      continue;
    }

    const a = result.analysis;
    await prisma.socialSentiment.upsert({
      where: { sourcePlatform_externalPostId: { sourcePlatform: post.source, externalPostId: post.externalPostId } },
      create: {
        ticker: post.ticker,
        sourcePlatform: post.source,
        externalPostId: post.externalPostId,
        author: post.author,
        publishedAt: post.publishedAt ? new Date(post.publishedAt) : null,
        contentExcerpt: post.content.slice(0, 500),
        sentiment: a.sentiment.toUpperCase() as "BULL" | "NEUTRAL" | "BEAR",
        sentimentScore: a.sentimentScore,
        authorSegment: a.authorSegment.toUpperCase() as "RETAIL" | "GURU" | "BOT" | "UNKNOWN",
        confidence: a.confidence,
        modelName: `${result.provider}/${result.backendModel}`,
        reasoning: a.reasoning,
      },
      update: {},
    });
    console.log(`  ${post.ticker} <- ${post.source}#${post.externalPostId}: ${a.sentiment} (${a.sentimentScore.toFixed(2)}), author=${a.authorSegment}`);
    analyzed++;
  }

  console.log(`\ndone. analyzed=${analyzed} failed=${failed}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    await pool.end();
    process.exitCode = 1;
  });
