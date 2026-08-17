import { NextRequest, NextResponse } from "next/server";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { runRefresh } from "@/lib/refresh";

// Vercel Cron hits this route on the schedule declared in vercel.json. Vercel automatically
// sends `Authorization: Bearer $CRON_SECRET` on cron-triggered requests when CRON_SECRET is set
// on the project — this is the documented way to make sure only Vercel's own scheduler (not an
// arbitrary caller who finds the URL) can trigger a refresh.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Own direct-connection client, not the shared pooled lib/prisma.ts one — a big batch of
  // upserts shouldn't compete with the app's pooled connection slots.
  const targetUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const pool = new pg.Pool({ connectionString: targetUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const result = await runRefresh(prisma);
    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}
