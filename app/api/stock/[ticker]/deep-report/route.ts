import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";
import { generateDeepReport } from "@/lib/deep-report";

async function loadStock(rawTicker: string) {
  const ticker = decodeURIComponent(rawTicker).toUpperCase();
  return prisma.stock.findUnique({ where: { ticker } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker } = await params;
  const stock = await loadStock(ticker);
  if (!stock) return NextResponse.json({ error: "Unknown ticker" }, { status: 404 });

  const report = await prisma.deepReport.findFirst({
    where: { stockId: stock.id, userId: user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ report });
}

export async function POST(_request: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker } = await params;
  const stock = await loadStock(ticker);
  if (!stock) return NextResponse.json({ error: "Unknown ticker" }, { status: 404 });

  // Stock-specific notes only — general (untagged) notes aren't included in a single-stock report.
  const notes = await prisma.note.findMany({
    where: { userId: user.id, ticker: stock.ticker },
    orderBy: { syncedAt: "desc" },
  });

  let generated: { content: string; model: string };
  try {
    generated = await generateDeepReport(stock, notes);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  const report = await prisma.deepReport.create({
    data: {
      stockId: stock.id,
      userId: user.id,
      content: generated.content,
      model: generated.model,
    },
  });

  return NextResponse.json({ report }, { status: 201 });
}
