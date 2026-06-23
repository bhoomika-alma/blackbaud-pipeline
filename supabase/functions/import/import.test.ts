import { assertEquals, assertRejects } from "std/assert/mod.ts";
import type { PipelineKey } from "../_shared/clean.ts";
import {
  buildCreateDealProperties,
  buildUpdateProperties,
  cleanAmount,
  detectDuplicateCompanies,
  type ImportDeps,
  type ImportRow,
  resolveImportAction,
  runImport,
  type UpsertResult,
} from "./import.ts";

const PIPELINE_IDS: Record<PipelineKey, string> = {
  highered: "16363685",
  k12: "23038595",
  canada: "36496197",
  england: "36528146",
};

function makeRow(overrides: Partial<ImportRow>): ImportRow {
  return {
    id: "r1",
    row_number: 1,
    classification: "new",
    review_decision: "pending",
    bb_id: null,
    account_name: null,
    domain: null,
    domain_final: null,
    contact_email: null,
    first_name: null,
    last_name: null,
    derived_pipeline: null,
    deal_name: null,
    hs_deal_id: null,
    linked_hs_deal_id: null,
    arr_raw: null,
    arr_final: null,
    close_date: null,
    demonstrate_stage_date: null,
    last_stage_change_date: null,
    region: null,
    vertical: null,
    ...overrides,
  };
}

// ─────────────────────────── resolveImportAction ───────────────────────────

Deno.test("resolveImportAction: maps classification + decision to an action", () => {
  assertEquals(resolveImportAction(makeRow({ classification: "existing" })), "update");
  assertEquals(
    resolveImportAction(makeRow({ classification: "existing", review_decision: "skip" })),
    "skip",
  );
  assertEquals(resolveImportAction(makeRow({ classification: "new" })), "create");
  assertEquals(
    resolveImportAction(makeRow({ classification: "new", review_decision: "skip" })),
    "skip",
  );
  assertEquals(
    resolveImportAction(makeRow({ classification: "review", review_decision: "confirm" })),
    "update",
  );
  assertEquals(
    resolveImportAction(makeRow({ classification: "review", review_decision: "approve" })),
    "create",
  );
  assertEquals(
    resolveImportAction(makeRow({ classification: "review", review_decision: "pending" })),
    "skip",
  );
  assertEquals(resolveImportAction(makeRow({ classification: "hold" })), "skip");
  assertEquals(resolveImportAction(makeRow({ classification: "internal" })), "skip");
});

// ─────────────────────────── property builders ───────────────────────────

Deno.test("cleanAmount strips currency formatting", () => {
  assertEquals(cleanAmount("$50,000"), "50000");
  assertEquals(cleanAmount("12,500.50"), "12500.50");
  assertEquals(cleanAmount(1000), "1000");
  assertEquals(cleanAmount(null), "");
});

Deno.test("buildUpdateProperties only sends properties that exist in HubSpot", () => {
  const props = buildUpdateProperties(makeRow({
    deal_name: "Acme - Blackbaud Canada",
    derived_pipeline: "Blackbaud Canada",
    arr_final: 9999,
    close_date: "2026-06-30",
    region: "Canada",
    vertical: "HigherEd",
    demonstrate_stage_date: "2026-03-15",
    last_stage_change_date: "2026-03-15",
  }));
  // never overwrite / not real HubSpot deal properties
  assertEquals("amount" in props, false);
  assertEquals("dealname" in props, false);
  assertEquals("pipeline" in props, false);
  assertEquals("bb_region" in props, false);
  assertEquals("bb_vertical" in props, false);
  assertEquals("last_stage_change_date" in props, false);
  // real properties we do write
  assertEquals(props.closedate, "2026-06-30");
  assertEquals(props.demonstrate_stage_date, "2026-03-15");
  assertEquals(props.region, "BBC"); // enum value, not raw "Canada"
});

Deno.test("buildCreateDealProperties includes amount + pipeline + unique_bb_id", () => {
  const props = buildCreateDealProperties(
    makeRow({
      bb_id: "BB1",
      deal_name: "Acme - Blackbaud Canada",
      derived_pipeline: "Blackbaud Canada",
      arr_raw: "$50,000",
      close_date: "2026-06-30",
    }),
    PIPELINE_IDS.canada,
  );
  assertEquals(props.unique_bb_id, "BB1");
  assertEquals(props.dealname, "Acme - Blackbaud Canada");
  assertEquals(props.pipeline, "36496197");
  assertEquals(props.amount, "50000");
  assertEquals(props.region, "BBC"); // enum value mapped from the routed pipeline
  // bb_region / bb_vertical do not exist in HubSpot — never sent.
  assertEquals("bb_region" in props, false);
  assertEquals("bb_vertical" in props, false);
});

Deno.test("region enum maps US/LatAm→BBUS, Canada→BBC, England→BBE", () => {
  const regionOf = (pipelineName: string) =>
    buildCreateDealProperties(makeRow({ bb_id: "X", derived_pipeline: pipelineName })).region;
  assertEquals(regionOf("Blackbaud HigherEd pipeline"), "BBUS");
  assertEquals(regionOf("Blackbaud k12 pipeline"), "BBUS");
  assertEquals(regionOf("Blackbaud Canada"), "BBC");
  assertEquals(regionOf("Blackbaud England"), "BBE");
});

Deno.test("buildCreateDealProperties prefers arr_final over arr_raw", () => {
  const props = buildCreateDealProperties(
    makeRow({ bb_id: "BB1", arr_raw: "100", arr_final: 250 }),
  );
  assertEquals(props.amount, "250");
});

Deno.test("detectDuplicateCompanies flags domains with multiple company ids", () => {
  const dups = detectDuplicateCompanies([
    { domain: "acme.com", companyId: "c1" },
    { domain: "acme.com", companyId: "c2" },
    { domain: "beta.org", companyId: "c3" },
  ]);
  assertEquals(dups, [{ domain: "acme.com", companyIds: ["c1", "c2"] }]);
});

// ─────────────────────────────── runImport ───────────────────────────────

function mockDeps(rows: ImportRow[], companyIdSequence: string[] = ["comp-1"]) {
  let companyIdx = 0;
  const captured = {
    status: [] as string[],
    batchUpdates: [] as { bbId: string; properties: Record<string, string> }[][],
    rowResults: [] as { id: string; patch: Record<string, unknown> }[],
    associations: [] as string[],
    finalize: null as Record<string, unknown> | null,
  };
  const deps: ImportDeps = {
    loadRows: () => Promise.resolve(rows),
    setRunStatus: (_id, status) => {
      captured.status.push(status);
      return Promise.resolve();
    },
    batchUpdateDeals: (updates) => {
      captured.batchUpdates.push(updates);
      return Promise.resolve();
    },
    upsertCompany: (): Promise<UpsertResult> => {
      const id = companyIdSequence[Math.min(companyIdx, companyIdSequence.length - 1)];
      companyIdx++;
      return Promise.resolve({ id, created: true });
    },
    upsertContact: () => Promise.resolve({ id: "ct-1", created: true }),
    upsertDeal: () => Promise.resolve({ id: "deal-1", created: true }),
    createAssociation: (fromType, fromId, toType, toId) => {
      captured.associations.push(`${fromType}:${fromId}->${toType}:${toId}`);
      return Promise.resolve();
    },
    updateRowResult: (id, patch) => {
      captured.rowResults.push({ id, patch });
      return Promise.resolve();
    },
    finalizeRun: (_id, patch) => {
      captured.finalize = patch;
      return Promise.resolve();
    },
  };
  return { deps, captured };
}

Deno.test("runImport: updates existing, creates new, skips hold; writes summary", async () => {
  const rows = [
    makeRow({
      id: "r1",
      row_number: 1,
      classification: "existing",
      bb_id: "A",
      hs_deal_id: "hs-A",
    }),
    makeRow({
      id: "r2",
      row_number: 2,
      classification: "new",
      bb_id: "N",
      account_name: "Acme",
      domain: "acme.com",
      contact_email: "a@acme.com",
      derived_pipeline: "Blackbaud Canada",
      deal_name: "Acme - Blackbaud Canada",
      arr_final: 1000,
    }),
    makeRow({ id: "r3", row_number: 3, classification: "hold" }),
  ];
  const { deps, captured } = mockDeps(rows);
  const result = await runImport(deps, { importRunId: "run-1", pipelineIds: PIPELINE_IDS });

  assertEquals(result.summary.created, 1);
  assertEquals(result.summary.updated, 1);
  assertEquals(result.summary.skipped, 1);
  assertEquals(result.summary.total_rows, 3);

  // existing → one batch update, matched by bb_id, no amount
  assertEquals(captured.batchUpdates.length, 1);
  assertEquals(captured.batchUpdates[0][0].bbId, "A");
  assertEquals("amount" in captured.batchUpdates[0][0].properties, false);

  // new → deal+company+contact associations (2)
  assertEquals(captured.associations, [
    "deal:deal-1->company:comp-1",
    "deal:deal-1->contact:ct-1",
  ]);

  // run lifecycle + finalize
  assertEquals(captured.status, ["importing"]);
  assertEquals(captured.finalize?.status, "completed");
  assertEquals(captured.finalize?.approved_count, 2);
  assertEquals(captured.finalize?.skipped_count, 1);

  const createResult = captured.rowResults.find((r) => r.id === "r2")?.patch;
  assertEquals(createResult?.import_action, "create");
  assertEquals(createResult?.result_hs_deal_id, "deal-1");
  assertEquals(createResult?.result_hs_company_id, "comp-1");
});

Deno.test("runImport: flags duplicate companies for the same domain", async () => {
  const rows = [
    makeRow({
      id: "r1",
      row_number: 1,
      classification: "new",
      bb_id: "N1",
      domain: "dup.com",
      account_name: "Dup A",
    }),
    makeRow({
      id: "r2",
      row_number: 2,
      classification: "new",
      bb_id: "N2",
      domain: "dup.com",
      account_name: "Dup B",
    }),
  ];
  const { deps, captured } = mockDeps(rows, ["comp-1", "comp-2"]);
  const result = await runImport(deps, { importRunId: "run-1", pipelineIds: PIPELINE_IDS });
  assertEquals(result.summary.duplicate_companies, [{
    domain: "dup.com",
    companyIds: ["comp-1", "comp-2"],
  }]);
  assertEquals(
    (captured.finalize?.summary as { duplicate_companies: unknown[] }).duplicate_companies.length,
    1,
  );
});

Deno.test("runImport: review-confirm without bb_id is skipped with an error note", async () => {
  const rows = [
    makeRow({
      id: "r1",
      row_number: 1,
      classification: "review",
      review_decision: "confirm",
      bb_id: null,
    }),
  ];
  const { deps, captured } = mockDeps(rows);
  const result = await runImport(deps, { importRunId: "run-1", pipelineIds: PIPELINE_IDS });
  assertEquals(result.summary.skipped, 1);
  const patch = captured.rowResults[0].patch;
  assertEquals(patch.import_action, "skip");
  assertEquals(typeof patch.import_error, "string");
});

Deno.test("runImport: throws when importRunId is missing", async () => {
  const { deps } = mockDeps([]);
  await assertRejects(
    () => runImport(deps, { importRunId: "", pipelineIds: PIPELINE_IDS }),
    Error,
    "importRunId",
  );
});
