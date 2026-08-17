import "dotenv/config";
import { defineConfig } from "prisma/config";

// CLI/migrations always want the direct, unpooled connection. Local dev and GitHub Actions
// set DIRECT_URL directly; Vercel's native Neon integration instead auto-provisions
// DATABASE_URL_UNPOOLED (no DIRECT_URL) when the database is created via Storage -> Create
// Database, so fall back to that rather than requiring a manually-duplicated env var — the
// Vercel dashboard also can't show a Sensitive-flagged value in plain text to copy anyway.
// The app's pooled DATABASE_URL is wired into lib/prisma.ts separately at request time.
const directUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED;
if (!directUrl) {
  throw new Error("Set DIRECT_URL (or DATABASE_URL_UNPOOLED, from Vercel's Neon integration) before running Prisma CLI commands.");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx scripts/seed.ts",
  },
  datasource: {
    url: directUrl,
  },
});
