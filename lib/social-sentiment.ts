/**
 * Xueqiu Layer 8 (Phase 3 roadmap item) — sentiment classification + author segmentation
 * (retail/guru/bot) for posts synced from Codex, a separate local pipeline
 * (D:\Secondbrain\SocialMedia\database\socialmedia.db, SQLite) that owns raw post collection,
 * dedup, and stock-mention linking. This file only defines the shape of *this app's own* LLM
 * analysis of a post; scripts/sync-social-sentiment.ts is what reads Codex's SQLite and calls it.
 *
 * Kept out of the StockReport/Compound-OS agent pipeline (lib/agents/runner.ts) on purpose: that
 * pipeline analyzes one ticker's FinancialFact rows, not a social-media post's free text -- there's
 * no numeric fact to ground a sentiment call against the way checkGrounding() does for a valuation
 * metric. See lib/agents/sentiment-runner.ts for the (smaller, post-shaped) retry loop this uses
 * instead of runAgent().
 */
import { z } from "zod";

export const SentimentAnalysisSchema = z
  .object({
    sentiment: z.enum(["Bull", "Neutral", "Bear"]),
    sentimentScore: z.number().min(-1).max(1),
    authorSegment: z.enum(["retail", "guru", "bot", "unknown"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(10),
  })
  .refine((v) => (v.sentiment === "Bull" ? v.sentimentScore > 0 : v.sentiment === "Bear" ? v.sentimentScore < 0 : true), {
    message: "sentiment and sentimentScore disagree on direction",
  });

export type SentimentAnalysis = z.infer<typeof SentimentAnalysisSchema>;

/** What the agent needs about one post -- deliberately not Codex's raw SQLite row shape, so this
 *  file (and the agent prompt) don't have to know that pipeline's schema at all. */
export interface PostInput {
  ticker: string;
  source: string;
  author: string | null;
  publishedAt: string | null;
  content: string;
}

export function buildPostContext(post: PostInput): string {
  return [
    `ticker: ${post.ticker}`,
    `source: ${post.source}`,
    `author: ${post.author ?? "(unknown)"}`,
    `publishedAt: ${post.publishedAt ?? "(unknown)"}`,
    "",
    "content:",
    post.content,
  ].join("\n");
}
