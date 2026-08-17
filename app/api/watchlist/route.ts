import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const items = await prisma.watchlistItem.findMany({
    where: { userId: user.id },
    include: { stock: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ items });
}

const addSchema = z.object({
  ticker: z.string().trim().min(1).max(20),
  notes: z.string().trim().max(2000).optional(),
  targetPrice: z.number().finite().optional(),
});

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const stock = await prisma.stock.findUnique({ where: { ticker: parsed.data.ticker.toUpperCase() } });
  if (!stock) {
    return NextResponse.json({ error: "Unknown ticker" }, { status: 404 });
  }

  const item = await prisma.watchlistItem.upsert({
    where: { userId_stockId: { userId: user.id, stockId: stock.id } },
    create: {
      userId: user.id,
      stockId: stock.id,
      notes: parsed.data.notes,
      targetPrice: parsed.data.targetPrice,
    },
    update: {
      ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
      ...(parsed.data.targetPrice !== undefined && { targetPrice: parsed.data.targetPrice }),
    },
    include: { stock: true },
  });

  return NextResponse.json({ item }, { status: 201 });
}
