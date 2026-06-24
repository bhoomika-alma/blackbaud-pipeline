import { assertEquals, assertRejects } from "std/assert/mod.ts";
import {
  type ClassifyContext,
  type ClassifyDeps,
  type ClassifyRow,
  classifyRow,
  latestBbImportDate,
  type ListKeys,
  needsNameSearch,
  parseImportDate,
  runClassify,
} from "./classify.ts";

function keys(bbids: string[] = [], names: string[] = []): ListKeys {
  return { bbids: new Set(bbids), names: new Set(names.map((n) => n.toLowerCase())) };
}

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    internal: keys(),
    existing: keys(),
    lastImportDate: null,
    ...over,
  };
}

function row(over: Partial<ClassifyRow>): ClassifyRow {
  return {
    id: "r1",
    row_number: 1,
    bb_id: null,
    stage: null,
    deal_name: null,
    created_date: null,
    domain: null,
    domain_flagged: false,
    ...over,
  };
}

// ───────────────────────────── classifyRow ─────────────────────────────

Deno.test("classifyRow: in the internal list → INTERNAL", () => {
  const result = classifyRow(
    row({ bb_id: "A", stage: "Demonstrate" }),
    ctx({ internal: keys(["A"]) }),
    null,
  );
  assertEquals(result.classification, "internal");
  assertEquals(result.matched_by, "bb_id");
});

Deno.test("classifyRow: in the BB Pipeline Deals list → EXISTING", () => {
  const result = classifyRow(row({ bb_id: "B" }), ctx({ existing: keys(["B"]) }), null);
  assertEquals(result.classification, "existing");
  assertEquals(result.matched_by, "bb_id");
});

Deno.test("classifyRow: backup match by deal name (no bb_id)", () => {
  const result = classifyRow(
    row({ bb_id: null, deal_name: "Acme - Blackbaud Canada" }),
    ctx({ existing: keys([], ["Acme - Blackbaud Canada"]) }),
    null,
  );
  assertEquals(result.classification, "existing");
  assertEquals(result.matched_by, "deal_name");
});

Deno.test("classifyRow: internal takes precedence over existing", () => {
  const result = classifyRow(
    row({ bb_id: "X" }),
    ctx({ internal: keys(["X"]), existing: keys(["X"]) }),
    null,
  );
  assertEquals(result.classification, "internal");
});

Deno.test("classifyRow: unmapped + inactive stage → HOLD", () => {
  assertEquals(classifyRow(row({ stage: "Discover" }), ctx(), null).classification, "hold");
});

Deno.test("classifyRow: unmapped + active but created on/before last import → HOLD", () => {
  const result = classifyRow(
    row({ stage: "Propose", deal_name: "X - P", created_date: "2026-05-20" }),
    ctx({ lastImportDate: "2026-05-29" }),
    0,
  );
  assertEquals(result.classification, "hold");
});

Deno.test("classifyRow: unmapped + active + recent + 0 name matches → NEW", () => {
  const result = classifyRow(
    row({ stage: "Propose", deal_name: "X - P", created_date: "2026-06-01" }),
    ctx({ lastImportDate: "2026-05-29" }),
    0,
  );
  assertEquals(result.classification, "new");
});

Deno.test("classifyRow: unmapped recent + 1 name match → REVIEW (cat 2)", () => {
  const result = classifyRow(
    row({ stage: "Propose", deal_name: "X - P", created_date: "2026-06-01" }),
    ctx(),
    1,
  );
  assertEquals(result.classification, "review");
  assertEquals(result.edgeCase?.category, 2);
});

Deno.test("classifyRow: unmapped recent + 2+ name matches → REVIEW (cat 3)", () => {
  const result = classifyRow(row({ stage: "Negotiate", deal_name: "X - P" }), ctx(), 3);
  assertEquals(result.classification, "review");
  assertEquals(result.match_count, 3);
  assertEquals(result.edgeCase?.category, 3);
});

// ───────────────────────────── needsNameSearch ─────────────────────────────

Deno.test("needsNameSearch: only for unmapped, active, recent rows with a name", () => {
  assertEquals(
    needsNameSearch(
      row({ bb_id: "A", stage: "Propose", deal_name: "n" }),
      ctx({ internal: keys(["A"]) }),
    ),
    false,
  );
  assertEquals(needsNameSearch(row({ stage: "Discover", deal_name: "n" }), ctx()), false);
  assertEquals(
    needsNameSearch(
      row({ stage: "Propose", deal_name: "n", created_date: "2026-05-01" }),
      ctx({ lastImportDate: "2026-05-29" }),
    ),
    false,
  );
  assertEquals(needsNameSearch(row({ stage: "Propose", deal_name: "" }), ctx()), false);
  assertEquals(needsNameSearch(row({ stage: "Propose", deal_name: "Acme - P" }), ctx()), true);
});

// ───────────────────────── import-name date parsing ─────────────────────────

Deno.test("parseImportDate: handles the BB import naming convention", () => {
  assertEquals(parseImportDate("BB Pipeline Report 29th May 2026 - New deals", 2026), "2026-05-29");
  assertEquals(
    parseImportDate("BB Pipeline Report 29th May - Import Existing", 2026),
    "2026-05-29",
  );
  assertEquals(parseImportDate("BB Pipeline Report 1 June 2026", 2025), "2026-06-01");
  assertEquals(parseImportDate("no date here", 2026), null);
});

Deno.test("latestBbImportDate: latest matching BB import, ignores others", () => {
  const imports = [
    { name: "BB Pipeline Report 26th May 2026 - New deals" },
    { name: "BB Pipeline Report 29th May 2026 - Import Existing" },
    { name: "Some other import 30th May 2026" },
  ];
  assertEquals(latestBbImportDate(imports, 2026), "2026-05-29");
  assertEquals(latestBbImportDate([], 2026), null);
});

// ───────────────────────────── runClassify ─────────────────────────────

function mockDeps(
  rows: ClassifyRow[],
  opts: {
    internal?: ListKeys;
    existing?: ListKeys;
    lastImportDate?: string | null;
    nameCounts?: Record<string, number>;
  } = {},
) {
  const captured = {
    rowUpdates: [] as { id: string; patch: Record<string, unknown> }[],
    runUpdates: [] as Record<string, unknown>[],
    nameSearches: [] as string[],
  };
  const deps: ClassifyDeps = {
    loadRows: () => Promise.resolve(rows),
    getListKeys: (name) =>
      Promise.resolve(name === "INTERNAL" ? (opts.internal ?? keys()) : (opts.existing ?? keys())),
    getLastImportDate: () => Promise.resolve(opts.lastImportDate ?? null),
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

const INPUT = { importRunId: "run-1", internalListName: "INTERNAL", existingListName: "EXISTING" };

Deno.test("runClassify: classifies against the two lists + date filter, rolls up counts", async () => {
  const rows = [
    row({ id: "r1", row_number: 1, bb_id: "INT", stage: "Demonstrate", deal_name: "I - P" }),
    row({ id: "r2", row_number: 2, bb_id: "EXI", stage: "Demonstrate", deal_name: "E - P" }),
    row({
      id: "r3",
      row_number: 3,
      bb_id: "NEW",
      stage: "Propose",
      deal_name: "N - P",
      created_date: "2026-06-01",
    }),
    row({
      id: "r4",
      row_number: 4,
      bb_id: "OLD",
      stage: "Propose",
      deal_name: "O - P",
      created_date: "2026-05-01",
    }),
    row({ id: "r5", row_number: 5, bb_id: "ERL", stage: "Discover", deal_name: "D - P" }),
  ];
  const { deps, captured } = mockDeps(rows, {
    internal: keys(["INT"]),
    existing: keys(["EXI"]),
    lastImportDate: "2026-05-29",
    nameCounts: { "N - P": 0 },
  });
  const result = await runClassify(deps, INPUT);

  assertEquals(result.counts.internal, 1);
  assertEquals(result.counts.existing, 1);
  assertEquals(result.counts.new, 1); // r3 (recent, no name match)
  assertEquals(result.counts.hold, 2); // r4 (too old) + r5 (early stage)
  assertEquals(result.lastImportDate, "2026-05-29");

  // only r3 needed a name search (mapped + held rows are skipped)
  assertEquals(captured.nameSearches, ["N - P"]);

  assertEquals(captured.runUpdates[0], { status: "classifying" });
  const final = captured.runUpdates.at(-1);
  assertEquals(final?.status, "classified");
  assertEquals(final?.new_count, 1);
  assertEquals(final?.existing_count, 1);
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

Deno.test("runClassify: throws when importRunId is missing", async () => {
  const { deps } = mockDeps([]);
  await assertRejects(
    () => runClassify(deps, { ...INPUT, importRunId: "" }),
    Error,
    "importRunId",
  );
});
