// Minimal CSV parsing wrapper around the Deno std CSV parser. Returns the header
// row plus each data row keyed by header. Trims cells, strips a BOM, and skips
// fully-blank lines.

import { parse } from "std/csv/parse.ts";

export interface ParsedCsv {
  headers: string[];
  records: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  const cleaned = text.replace(/^﻿/, "");
  const rows = parse(cleaned) as string[][];
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim());
  const records = rows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => {
      const record: Record<string, string> = {};
      headers.forEach((header, i) => {
        record[header] = (row[i] ?? "").trim();
      });
      return record;
    });

  return { headers, records };
}
