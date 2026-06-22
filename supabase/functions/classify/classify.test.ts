import { assertEquals, assertRejects } from "std/assert/mod.ts";
import type { HubSpotDeal } from "../_shared/hubspot.ts";
import { type ClassifyDeps, type ClassifyRow, classifyRow, runClassify } from "./classify.ts";

const BB_PIPELINES = new Set(["16363685", "23038595", "36496197", "36528146"]);

function deal(id: string, pipeline: string, props: Record<string, string> = {}): HubSpotDeal {
  return { id, properties: { pipeline, ...props } };
}

function row(overrides: Partial<ClassifyRow>): ClassifyRow {
  return {
    id: overrides.id ?? "r1",
    row_number: overrides.row_number ?? 1,
    bb_id: overrides.bb_id ?? null,
    stage: overrides.stage ?? null,
    deal_name: overrides.deal_name ?? null,
    domain: overrides.domain ?? null,
    domain_flagged: overrides.domain_flagged ?? false,
  };
}

// ───────────────────────────── classifyRow ─────────────────────────────

Deno.test("classifyRow: bb_id match in a Blackbaud pipeline → EXISTING", () => {
  const result = classifyRow(row({ bb_id: "A" }), [deal("d1", "16363685")], null, BB_PIPELINES);
  assertEquals(result.classification, "existing");
  assertEquals(result.matched_by, "bb_id");
  assertEquals(result.hs_deal_id, "d1");
  assertEquals(result.matched_pipeline, "16363685");
  assertEquals(result.match_count, 1);
});

Deno.test("classifyRow: bb_id match NOT in a Blackbaud pipeline → INTERNAL", () => {
  const result = classifyRow(row({ bb_id: "A" }), [deal("d1", "99999")], null, BB_PIPELINES);
  assertEquals(result.classification, "internal");
  assertEquals(result.matched_by, "bb_id");
});

Deno.test("classifyRow: duplicate bb_id deals → edge case category 4", () => {
  const result = classifyRow(
    row({ bb_id: "A" }),
    [deal("d1", "16363685"), deal("d2", "16363685")],
    null,
    BB_PIPELINES,
  );
  assertEquals(result.classification, "existing");
  assertEquals(result.match_count, 2);
  assertEquals(result.edgeCase?.category, 4);
});

Deno.test("classifyRow: no bb_id match + inactive stage → HOLD", () => {
  const result = classifyRow(row({ stage: "Discover" }), [], null, BB_PIPELINES);
  assertEquals(result.classification, "hold");
  assertEquals(result.edgeCase, null);
});

Deno.test("classifyRow: active stage, 0 name matches → NEW (+ ARR edge case)", () => {
  const result = classifyRow(
    row({ stage: "Demonstrate", deal_name: "Acme - X" }),
    [],
    [],
    BB_PIPELINES,
  );
  assertEquals(result.classification, "new");
  assertEquals(result.edgeCase?.category, 1);
});

Deno.test("classifyRow: active stage, 1 name match → REVIEW (matched_by deal_name)", () => {
  const result = classifyRow(
    row({ stage: "Propose", deal_name: "Acme - X" }),
    [],
    [deal("d9", "16363685")],
    BB_PIPELINES,
  );
  assertEquals(result.classification, "review");
  assertEquals(result.matched_by, "deal_name");
  assertEquals(result.hs_deal_id, "d9");
  assertEquals(result.match_count, 1);
  assertEquals(result.edgeCase?.category, 2);
});

Deno.test("classifyRow: active stage, 2+ name matches → REVIEW ambiguous", () => {
  const result = classifyRow(
    row({ stage: "Negotiate", deal_name: "Acme - X" }),
    [],
    [deal("d1", "1"), deal("d2", "2")],
    BB_PIPELINES,
  );
  assertEquals(result.classification, "review");
  assertEquals(result.match_count, 2);
  assertEquals(result.hs_deal_id, null);
  assertEquals(result.edgeCase?.category, 3);
});

// ───────────────────────────── runClassify ─────────────────────────────

function mockDeps(
  rows: ClassifyRow[],
  bbidMap: Map<string, HubSpotDeal[]>,
  nameResults: Record<string, HubSpotDeal[]> = {},
) {
  const captured = {
    rowUpdates: [] as { id: string; patch: Record<string, unknown> }[],
    runUpdates: [] as Record<string, unknown>[],
    nameSearches: [] as string[],
  };
  const deps: ClassifyDeps = {
    loadRows: () => Promise.resolve(rows),
    searchByBbid: () => Promise.resolve(bbidMap),
    searchByName: (name) => {
      captured.nameSearches.push(name);
      return Promise.resolve(nameResults[name] ?? []);
    },
    updateRow: (id, patch) => {
      captured.rowUpdates.push({ id, patch });
      return Promise.resolve();
    },
    updateRun: (_id, patch) => {
      captured.runUpdates.push(patch);
      return Promise.resolve();
    },
  };
  return { deps, captured };
}

Deno.test("runClassify: rolls up counts and persists classified status", async () => {
  const rows = [
    row({ id: "r1", row_number: 1, bb_id: "A", stage: "Demonstrate", deal_name: "A - P" }),
    row({ id: "r2", row_number: 2, bb_id: "B", stage: "Demonstrate", deal_name: "B - P" }),
    row({ id: "r3", row_number: 3, bb_id: null, stage: "Discover", deal_name: "C - P" }),
    row({ id: "r4", row_number: 4, bb_id: null, stage: "Propose", deal_name: "D - P" }),
  ];
  const bbidMap = new Map<string, HubSpotDeal[]>([
    ["A", [deal("d1", "16363685")]], // existing
    ["B", [deal("d2", "55555")]], // internal
  ]);
  const { deps, captured } = mockDeps(rows, bbidMap, { "D - P": [] }); // r4 → new
  const result = await runClassify(deps, {
    importRunId: "run-1",
    blackbaudPipelineIds: BB_PIPELINES,
  });

  assertEquals(result.counts.existing, 1);
  assertEquals(result.counts.internal, 1);
  assertEquals(result.counts.hold, 1);
  assertEquals(result.counts.new, 1);
  assertEquals(result.counts.review, 0);

  assertEquals(captured.rowUpdates.length, 4);
  // first updateRun = classifying, last = classified rollup
  assertEquals(captured.runUpdates[0], { status: "classifying" });
  const final = captured.runUpdates.at(-1);
  assertEquals(final?.status, "classified");
  assertEquals(final?.new_count, 1);
  assertEquals(final?.existing_count, 1);
  assertEquals(final?.review_count, 0);
});

Deno.test("runClassify: domain_flagged adds a data-quality edge case", async () => {
  const rows = [
    row({
      id: "r1",
      row_number: 1,
      bb_id: null,
      stage: "Demonstrate",
      deal_name: "X - P",
      domain: "broward.org",
      domain_flagged: true,
    }),
  ];
  const { deps, captured } = mockDeps(rows, new Map(), { "X - P": [] });
  const result = await runClassify(deps, {
    importRunId: "run-1",
    blackbaudPipelineIds: BB_PIPELINES,
  });
  // NEW (ARR edge) + domain_flag edge
  assertEquals(result.edgeCaseCount, 2);
  const edges = captured.runUpdates.at(-1)?.edge_cases as { category: number }[];
  assertEquals(edges.map((e) => e.category).sort(), [1, 7]);
});

Deno.test("runClassify: caches name searches for duplicate deal names", async () => {
  const rows = [
    row({ id: "r1", row_number: 1, bb_id: null, stage: "Demonstrate", deal_name: "Dup - P" }),
    row({ id: "r2", row_number: 2, bb_id: null, stage: "Propose", deal_name: "Dup - P" }),
  ];
  const { deps, captured } = mockDeps(rows, new Map(), { "Dup - P": [] });
  await runClassify(deps, { importRunId: "run-1", blackbaudPipelineIds: BB_PIPELINES });
  assertEquals(captured.nameSearches, ["Dup - P"]); // only searched once
});

Deno.test("runClassify: throws when importRunId is missing", async () => {
  const { deps } = mockDeps([], new Map());
  await assertRejects(
    () => runClassify(deps, { importRunId: "", blackbaudPipelineIds: BB_PIPELINES }),
    Error,
    "importRunId",
  );
});
