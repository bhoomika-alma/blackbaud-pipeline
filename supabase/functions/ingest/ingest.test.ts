import { assertEquals, assertRejects } from "std/assert/mod.ts";
import { type DealRowInsert, type IngestDeps, type NewImportRun, runIngest } from "./ingest.ts";

const CSV = [
  "Unique BB ID,Account Name,Contact Name,Contact Email,Website,Stage,Region,Vertical,ARR,Created Date,Close Date,Last Stage Change Date",
  "BB1,University of Windsor,Jane Doe,jane@uwindsor.ca,https://www.uwindsor.ca/,Demonstrate,Canada,HigherEd,50000,1/1/2026,2026-06-30,3/15/2026",
  "BB2,Acme School,John Q Public,john@acme.org,acme.org,Discover,US,K12,12000,2026-02-01,2026-09-30,2026-02-15",
].join("\n");

/** Build mock deps that capture everything runIngest does. */
function mockDeps(csv: string) {
  const captured = {
    createdRun: null as NewImportRun | null,
    insertedRows: [] as DealRowInsert[],
    updates: [] as Record<string, unknown>[],
  };
  const deps: IngestDeps = {
    downloadCsv: () => Promise.resolve(csv),
    createRun: (run) => {
      captured.createdRun = run;
      return Promise.resolve("run-123");
    },
    insertRows: (rows) => {
      captured.insertedRows = rows;
      return Promise.resolve();
    },
    updateRun: (_id, patch) => {
      captured.updates.push(patch);
      return Promise.resolve();
    },
  };
  return { deps, captured };
}

Deno.test("runIngest: parses, creates run, inserts cleaned rows", async () => {
  const { deps, captured } = mockDeps(CSV);
  const result = await runIngest(deps, {
    path: "uploads/pipeline.csv",
    uploadedByEmail: "rep@almabase.com",
    sourceLabel: "Blackbaud",
    uploadedAt: "2026-06-22T00:00:00.000Z",
  });

  assertEquals(result, { importRunId: "run-123", rowCount: 2 });
  assertEquals(captured.createdRun?.filename, "pipeline.csv");
  assertEquals(captured.createdRun?.status, "ingesting");
  assertEquals(captured.createdRun?.uploaded_by_email, "rep@almabase.com");
  assertEquals(captured.createdRun?.source_label, "Blackbaud");

  assertEquals(captured.insertedRows.length, 2);
  const first = captured.insertedRows[0];
  assertEquals(first.import_run_id, "run-123");
  assertEquals(first.row_number, 1);
  assertEquals(first.domain, "uwindsor.ca");
  assertEquals(first.deal_name, "University of Windsor - Blackbaud Canada");
  assertEquals(first.demonstrate_stage_date, "2026-03-15");

  // final update marks the run ingested with the real row count
  assertEquals(captured.updates.at(-1), { status: "ingested", row_count: 2 });
});

Deno.test("runIngest: throws when required columns are missing", async () => {
  const { deps } = mockDeps("Account Name,Website\nAcme,acme.org\n");
  await assertRejects(
    () => runIngest(deps, { path: "x.csv" }),
    Error,
    "Missing expected Blackbaud columns",
  );
});

Deno.test("runIngest: throws on empty CSV", async () => {
  const { deps } = mockDeps("");
  await assertRejects(() => runIngest(deps, { path: "x.csv" }), Error, "empty");
});

Deno.test("runIngest: throws when path is missing", async () => {
  const { deps } = mockDeps(CSV);
  await assertRejects(() => runIngest(deps, { path: "" }), Error, "path");
});
