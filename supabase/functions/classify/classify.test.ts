import { assertEquals, assertRejects } from "std/assert/mod.ts";
import {
  type ClassifyContext,
  type ClassifyDeps,
  type ClassifyRow,
  classifyRow,
  type DealMatch,
  needsNameSearch,
  runClassify,
} from "./classify.ts";

// Pipeline ids: HE/k12/CA/EN are Blackbaud; "999" is some internal pipeline.
const BB_PIPELINES = new Set(["HE", "K12", "CA", "EN"]);

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return { blackbaudPipelines: BB_PIPELINES, ...over };
}

function deal(pipeline: string | null, id = "d1"): DealMatch {
  return { id, pipeline };
}

function row(over: Partial<ClassifyRow>): ClassifyRow {
  return {
    id: "r1",
    row_number: 1,
    bb_id: null,
    stage: null,
    deal_name: null,
    domain: null,
    domain_flagged: false,
    ...over,
  };
}

// ───────────────────────────── classifyRow ─────────────────────────────

Deno.test("classifyRow: bb_id found in a Blackbaud pipeline → EXISTING", () => {
  const result = classifyRow(row({ bb_id: "B1" }), ctx(), [deal("CA", "h1")], null);
  assertEquals(result.classification, "existing");
  assertEquals(result.matched_by, "bb_id");
  assertEquals(result.hs_deal_id, "h1");
  assertEquals(result.matched_pipeline, "CA");
});

Deno.test("classifyRow: bb_id found in a non-Blackbaud pipeline → INTERNAL", () => {
  const result = classifyRow(row({ bb_id: "B2" }), ctx(), [deal("999", "h2")], null);
  assertEquals(result.classification, "internal");
  assertEquals(result.matched_by, "bb_id");
  assertEquals(result.hs_deal_id, "h2");
});

Deno.test("classifyRow: bb_id found but deal has no pipeline → INTERNAL", () => {
  const result = classifyRow(row({ bb_id: "B3" }), ctx(), [deal(null)], null);
  assertEquals(result.classification, "internal");
});

Deno.test("classifyRow: bb_id matches 2+ deals → REVIEW duplicate (cat 4)", () => {
  const result = classifyRow(
    row({ bb_id: "DUP" }),
    ctx(),
    [deal("CA", "h1"), deal("999", "h2")],
    null,
  );
  assertEquals(result.classification, "review");
  assertEquals(result.match_count, 2);
  assertEquals(result.edgeCase?.category, 4);
  assertEquals(result.hs_deal_id, "h1");
});

Deno.test("classifyRow: not found + 0 name matches → NEW (any stage, no gate)", () => {
  // Early stage no longer holds — a not-found deal is a NEW candidate regardless.
  const result = classifyRow(row({ stage: "Discover", deal_name: "X - P" }), ctx(), [], 0);
  assertEquals(result.classification, "new");
  assertEquals(result.matched_by, "none");
});

Deno.test("classifyRow: not found + 1 name match → REVIEW (cat 2)", () => {
  const result = classifyRow(row({ stage: "Discover", deal_name: "X - P" }), ctx(), [], 1);
  assertEquals(result.classification, "review");
  assertEquals(result.matched_by, "deal_name");
  assertEquals(result.edgeCase?.category, 2);
});

Deno.test("classifyRow: not found + 2+ name matches → REVIEW (cat 3)", () => {
  const result = classifyRow(row({ stage: "Discover", deal_name: "X - P" }), ctx(), [], 3);
  assertEquals(result.classification, "review");
  assertEquals(result.match_count, 3);
  assertEquals(result.edgeCase?.category, 3);
});

// ───────────────────────────── needsNameSearch ─────────────────────────────

Deno.test("needsNameSearch: when bb_id not found and a deal name is present (any stage)", () => {
  // found by bb_id → no name search
  assertEquals(
    needsNameSearch(row({ bb_id: "A", stage: "Propose", deal_name: "n" }), [deal("CA")]),
    false,
  );
  // no deal name → no
  assertEquals(needsNameSearch(row({ stage: "Propose", deal_name: "" }), []), false);
  // not found + name present → yes, regardless of stage (early stages included)
  assertEquals(needsNameSearch(row({ stage: "Discover", deal_name: "n" }), []), true);
  assertEquals(needsNameSearch(row({ stage: "Propose", deal_name: "Acme - P" }), []), true);
});

// ───────────────────────────── runClassify ─────────────────────────────

function mockDeps(
  rows: ClassifyRow[],
  opts: {
    matches?: Record<string, DealMatch[]>;
    nameCounts?: Record<string, number>;
  } = {},
) {
  const captured = {
    rowUpdates: [] as { id: string; patch: Record<string, unknown> }[],
    runUpdates: [] as Record<string, unknown>[],
    bbidSearches: [] as string[][],
    nameSearches: [] as string[],
  };
  const deps: ClassifyDeps = {
    loadRows: () => Promise.resolve(rows),
    searchDealsByBbid: (bbIds) => {
      captured.bbidSearches.push(bbIds);
      const map = new Map<string, DealMatch[]>();
      for (const bb of bbIds) {
        const m = opts.matches?.[bb];
        if (m && m.length) map.set(bb, m);
      }
      return Promise.resolve(map);
    },
    searchByName: (name) => {
      captured.nameSearches.push(name);
      return Promise.resolve(opts.nameCounts?.[name] ?? 0);
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

const INPUT = { importRunId: "run-1", blackbaudPipelines: BB_PIPELINES };

Deno.test("runClassify: routes each row by bb_id lookup + name search, rolls up counts", async () => {
  const rows = [
    row({ id: "r1", row_number: 1, bb_id: "EXI", stage: "Demonstrate", deal_name: "E - P" }),
    row({ id: "r2", row_number: 2, bb_id: "INT", stage: "Demonstrate", deal_name: "I - P" }),
    row({ id: "r3", row_number: 3, bb_id: "NEW", stage: "Propose", deal_name: "N - P" }),
    row({ id: "r4", row_number: 4, bb_id: "ERL", stage: "Discover", deal_name: "D - P" }),
  ];
  const { deps, captured } = mockDeps(rows, {
    matches: {
      EXI: [deal("HE", "h-exi")], // Blackbaud pipeline → existing
      INT: [deal("999", "h-int")], // internal pipeline → internal
    },
    nameCounts: { "N - P": 0, "D - P": 0 },
  });
  const result = await runClassify(deps, INPUT);

  assertEquals(result.counts.existing, 1);
  assertEquals(result.counts.internal, 1);
  assertEquals(result.counts.new, 2); // r3 + r4 (not found, 0 name matches — no stage gate)
  assertEquals(result.counts.hold, 0); // HOLD is no longer produced

  // a single batch bb_id search covering every row with a bb_id
  assertEquals(captured.bbidSearches.length, 1);
  assertEquals(captured.bbidSearches[0], ["EXI", "INT", "NEW", "ERL"]);
  // both not-found rows reach the name search now (early-stage included)
  assertEquals(captured.nameSearches, ["N - P", "D - P"]);

  // EXISTING row persists the real matched deal id + pipeline
  const r1Patch = captured.rowUpdates.find((u) => u.id === "r1")?.patch;
  assertEquals(r1Patch?.hs_deal_id, "h-exi");
  assertEquals(r1Patch?.matched_pipeline, "HE");

  assertEquals(captured.runUpdates[0], { status: "classifying" });
  const final = captured.runUpdates.at(-1);
  assertEquals(final?.status, "classified");
  assertEquals(final?.existing_count, 1);
  assertEquals(final?.new_count, 2);
});

Deno.test("runClassify: domain_flagged adds a data-quality edge case", async () => {
  const rows = [
    row({
      id: "r1",
      row_number: 1,
      bb_id: "NEW",
      stage: "Demonstrate",
      deal_name: "N - P",
      domain: "broward.org",
      domain_flagged: true,
    }),
  ];
  const { deps, captured } = mockDeps(rows, { nameCounts: { "N - P": 0 } });
  const result = await runClassify(deps, INPUT);
  assertEquals(result.edgeCaseCount, 1);
  const edges = captured.runUpdates.at(-1)?.edge_cases as { category: number }[];
  assertEquals(edges.map((e) => e.category), [7]);
});

Deno.test("runClassify: no rows with a bb_id → no batch search", async () => {
  const rows = [
    row({ id: "r1", row_number: 1, bb_id: null, stage: "Propose", deal_name: "X - P" }),
  ];
  const { deps, captured } = mockDeps(rows, { nameCounts: { "X - P": 0 } });
  const result = await runClassify(deps, INPUT);
  assertEquals(captured.bbidSearches.length, 0);
  assertEquals(result.counts.new, 1);
});

Deno.test("runClassify: throws when importRunId is missing", async () => {
  const { deps } = mockDeps([]);
  await assertRejects(
    () => runClassify(deps, { ...INPUT, importRunId: "" }),
    Error,
    "importRunId",
  );
});
