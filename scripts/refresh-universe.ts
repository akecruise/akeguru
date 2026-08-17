import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { runRefresh } from "../lib/refresh";

// Local/manual CLI entry point (`npm run refresh`). The scheduled production refresh runs via
// Vercel Cron -> app/api/cron/refresh/route.ts instead, which shares this same runRefresh() core
// but builds its own Prisma client against the runtime's own env — see that route for why.
// This script builds its own client against the DIRECT (unpooled) connection: a long batch job
// shouldn't compete with the app's pooled connection slots. See prisma.config.ts for why
// DATABASE_URL_UNPOOLED is a fallback (Vercel's Neon integration).
const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL_UNPOOLED });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

runRefresh(prisma)
  .then(async (result) => {
    await prisma.$disconnect();
    await pool.end();
    if (result.status === "FAILED") process.exitCode = 1;
  })
  .catch(async (err) => {
    console.error("[refresh] fatal error:", err);
    await prisma.$disconnect();
    await pool.end();
    process.exitCode = 1;
  });
