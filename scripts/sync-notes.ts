import "dotenv/config";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

// Runs ONLY on the user's own machine, by hand — never in GitHub Actions, never on Vercel.
// A deployed/cloud akeguru instance has no filesystem access to a local Obsidian vault; this
// script is the one place that boundary is crossed, and it only ever writes into Postgres —
// the app itself never reads the vault directly.
//
// Usage:
//   OBSIDIAN_VAULT_PATH="D:\path\to\vault" NOTES_SYNC_USER_EMAIL="you@example.com" npx tsx scripts/sync-notes.ts

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

interface ParsedNote {
  title: string;
  ticker: string | null;
  content: string;
}

/** Minimal flat frontmatter parser — handles the two fields this script needs (`title`, `ticker`); not general YAML. */
function parseFrontmatter(raw: string, fallbackTitle: string): ParsedNote {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { title: fallbackTitle, ticker: null, content: raw.trim() };
  }
  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    title: fields.title || fallbackTitle,
    ticker: fields.ticker ? fields.ticker.toUpperCase() : null,
    content: body.trim(),
  };
}

function walkMarkdownFiles(dir: string, root: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip .obsidian/, dotfiles
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walkMarkdownFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  const userEmail = process.env.NOTES_SYNC_USER_EMAIL;

  if (!vaultPath) throw new Error("Set OBSIDIAN_VAULT_PATH to your vault's root directory.");
  if (!userEmail) throw new Error("Set NOTES_SYNC_USER_EMAIL to the akeguru account these notes belong to.");
  if (!fs.existsSync(vaultPath)) throw new Error(`Vault path does not exist: ${vaultPath}`);

  const user = await prisma.user.findUnique({ where: { email: userEmail.toLowerCase() } });
  if (!user) throw new Error(`No akeguru user with email ${userEmail} — register in the app first.`);

  const files = walkMarkdownFiles(vaultPath, vaultPath);
  let created = 0;
  let updated = 0;

  for (const filePath of files) {
    const sourcePath = path.relative(vaultPath, filePath).replace(/\\/g, "/");
    const raw = fs.readFileSync(filePath, "utf-8");
    const fallbackTitle = path.basename(filePath, ".md");
    const parsed = parseFrontmatter(raw, fallbackTitle);

    if (!parsed.content) continue; // skip empty notes

    const existing = await prisma.note.findUnique({
      where: { userId_sourcePath: { userId: user.id, sourcePath } },
      select: { id: true },
    });

    await prisma.note.upsert({
      where: { userId_sourcePath: { userId: user.id, sourcePath } },
      create: {
        userId: user.id,
        sourcePath,
        title: parsed.title,
        ticker: parsed.ticker,
        content: parsed.content,
      },
      update: {
        title: parsed.title,
        ticker: parsed.ticker,
        content: parsed.content,
      },
    });

    if (existing) updated++;
    else created++;
  }

  console.log(`[sync-notes] done: ${created} created, ${updated} updated, ${files.length} .md files scanned`);

  await prisma.$disconnect();
  await pool.end();
}

main().catch(async (err) => {
  console.error("[sync-notes] fatal error:", err.message ?? err);
  await prisma.$disconnect();
  await pool.end();
  process.exitCode = 1;
});
