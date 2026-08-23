/**
 * PDF text-extraction infra (Phase 2, text-extraction only — no figure parsing).
 *
 * Deterministic, no AI: given the path to an already-archived RawSource PDF (e.g. an HKEX
 * annual report from hkex.ts), pull out plain text per page. Turning that text into specific
 * FinancialFact rows (Revenue, ROE, ...) is left to a later AI extraction step — HKEX annual
 * report layouts vary too much between companies/languages for regex line-item matching to be
 * trustworthy, and a wrong number silently entering FinancialFact is exactly what RawSource's
 * traceability is meant to prevent.
 */

import fs from 'fs/promises';
import { PDFParse } from 'pdf-parse';

export interface ExtractedPdfText {
  numPages: number;
  pages: string[]; // pages[0] is page 1
  text: string; // full document, pages joined with \n\n
}

/** Re-runnable at any time from the RawSource.filePath on disk — nothing extracted here is persisted. */
export async function extractPdfText(filePath: string): Promise<ExtractedPdfText> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return {
      numPages: result.total,
      pages: result.pages.map((p) => p.text),
      text: result.text,
    };
  } finally {
    await parser.destroy();
  }
}
