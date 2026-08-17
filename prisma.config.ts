import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx scripts/seed.ts",
  },
  datasource: {
    // CLI/migrations always want the direct, unpooled connection.
    // The app's pooled DATABASE_URL is wired into lib/prisma.ts separately at request time.
    url: env("DIRECT_URL"),
  },
});
