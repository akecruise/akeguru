import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth/session";

async function loadOwnedItem(id: string, userId: string) {
  const item = await prisma.watchlistItem.findUnique({ where: { id } });
  if (!item || item.userId !== userId) return null;
  return item;
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const item = await loadOwnedItem(id, user.id);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.watchlistItem.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}

const patchSchema = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
  targetPrice: z.number().finite().nullable().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const item = await loadOwnedItem(id, user.id);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const updated = await prisma.watchlistItem.update({
    where: { id },
    data: parsed.data,
    include: { stock: true },
  });
  return NextResponse.json({ item: updated });
}
