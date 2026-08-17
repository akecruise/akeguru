import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

// Cache both the pool and the client on globalThis — Next dev's HMR would
// otherwise open a fresh pg.Pool on every reload if only the client were cached.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pgPool: pg.Pool | undefined;
};

const pool =
  globalForPrisma.pgPool ??
  new pg.Pool({
    // Pooled (PgBouncer-fronted in prod) connection — the app's own request-time queries.
    // The CLI/migrations/refresh script use DIRECT_URL instead, see prisma.config.ts / scripts/refresh-universe.ts.
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
  });

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg(pool) });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.pgPool = pool;
}
