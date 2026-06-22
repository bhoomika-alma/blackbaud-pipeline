// Phase A — ingest. Pure orchestration: download a CSV, parse + validate it,
// create an import_run, and insert cleaned deal_rows. I/O is injected via
// `IngestDeps` so this is unit-testable without Storage or the database.

import { buildCleanedRow, type CleanedRow, validateColumns } from "../_shared/blackbaud.ts";
import { parseCsv } from "../_shared/csv.ts";

export interface IngestInput {
  path: string;
  filename?: string;
  uploadedByEmail?: string;
  sourceLabel?: string;
  uploadedAt?: string;
}

export interface NewImportRun {
  filename: string;
  source_label: string | null;
  uploaded_by_email: string | null;
  uploaded_at: string | null;
  status: string;
  row_count: number;
}

export type DealRowInsert = CleanedRow & {
  import_run_id: string;
  filename: string;
};

export interface IngestDeps {
  downloadCsv(path: string): Promise<string>;
  createRun(run: NewImportRun): Promise<string>;
  insertRows(rows: DealRowInsert[]): Promise<void>;
  updateRun(id: string, patch: Record<string, unknown>): Promise<void>;
}

export interface IngestResult {
  importRunId: string;
  rowCount: number;
}

export async function runIngest(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  if (!input.path || input.path.trim().length === 0) {
    throw new Error("Missing required field: path");
  }

  const text = await deps.downloadCsv(input.path);
  const { headers, records } = parseCsv(text);
  if (headers.length === 0) {
    throw new Error("CSV is empty or has no header row");
  }

  const { ok, missing, mapping } = validateColumns(headers);
  if (!ok) {
    throw new Error(`Missing expected Blackbaud columns: ${missing.join(", ")}`);
  }

  const filename = input.filename ?? input.path.split("/").pop() ?? input.path;
  const runId = await deps.createRun({
    filename,
    source_label: input.sourceLabel ?? null,
    uploaded_by_email: input.uploadedByEmail ?? null,
    uploaded_at: input.uploadedAt ?? null,
    status: "ingesting",
    row_count: records.length,
  });

  const rows: DealRowInsert[] = records.map((record, i) => ({
    import_run_id: runId,
    filename,
    ...buildCleanedRow(record, i + 1, mapping),
  }));

  if (rows.length > 0) await deps.insertRows(rows);
  await deps.updateRun(runId, { status: "ingested", row_count: rows.length });

  return { importRunId: runId, rowCount: rows.length };
}
