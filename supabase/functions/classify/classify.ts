// Phase C — classification by direct HubSpot lookup (search by BBID).
//
// Each row is searched in HubSpot by its `unique_bb_id` (the deal property):
//   - BBID found in 1 deal:
//       · deal in a Blackbaud pipeline (HigherEd / k12 / Canada / England)
//         → EXISTING (update). In any other pipeline → INTERNAL (skip).
//   - BBID found in 2+ deals → REVIEW (duplicate deal for the same BB ID).
//   - BBID not found → an exact deal-name search decides:
//       0 matches → NEW (create); 1 → REVIEW (confirm existing); 2+ → REVIEW (ambiguous).
//
// There is NO stage gate: a deal not found by BBID is a NEW candidate regardless
// of its stage (Discover & Access / Engage included), so HOLD is never produced.
//
// `classifyRow` is pure; `runClassify` orchestrates the batch bb_id search + the
// name search + persistence via injected I/O so it is unit-testable.

export type Classification = "new" | "existing" | "internal" | "hold" | "review";
export type MatchedBy = "none" | "bb_id" | "deal_name";

export interface ClassifyRow {
  id: string;
  row_number: number;
  bb_id: string | null;
  stage: string | null;
  deal_name: string | null;
  domain: string | null;
  domain_flagged: boolean;
}

/** A HubSpot deal matched by `unique_bb_id` — just the bits classification needs. */
export interface DealMatch {
  id: string;
  pipeline: string | null;
}

export interface EdgeCase {
  kind: string;
  /** Maps to the 7 Phase E edge-case categories. */
  category: number;
  detail: string;
}

export interface ClassificationResult {
  classification: Classification;
  matched_by: MatchedBy;
  hs_deal_id: string | null;
  matched_pipeline: string | null;
  match_count: number;
  edgeCase: EdgeCase | null;
}

export interface ClassifyContext {
  /** HubSpot pipeline IDs that count as Blackbaud pipelines → EXISTING (update). */
  blackbaudPipelines: Set<string>;
}

/**
 * True when a row reaches the name-search branch: BBID not found in HubSpot AND
 * there is a deal name to search on. (A not-found row with no deal name falls
 * straight through to NEW.)
 */
export function needsNameSearch(row: ClassifyRow, matches: DealMatch[]): boolean {
  if (matches.length > 0) return false; // found by bb_id
  return (row.deal_name ?? "").trim().length > 0;
}

/**
 * Decide a row's classification from the HubSpot deals matched by its bb_id and
 * (for the not-found, active-stage branch) the number of exact deal-name matches.
 */
export function classifyRow(
  row: ClassifyRow,
  ctx: ClassifyContext,
  matches: DealMatch[],
  nameMatchCount: number | null,
): ClassificationResult {
  // ── BBID found ──
  if (matches.length > 0) {
    // 2+ deals share this bb_id → duplicate; a human picks the canonical deal.
    if (matches.length > 1) {
      return {
        classification: "review",
        matched_by: "bb_id",
        hs_deal_id: matches[0].id,
        matched_pipeline: matches[0].pipeline,
        match_count: matches.length,
        edgeCase: {
          kind: "bbid_duplicate",
          category: 4,
          detail: `${matches.length} HubSpot deals share BB ID "${
            row.bb_id ?? ""
          }" — pick the canonical deal`,
        },
      };
    }

    const deal = matches[0];
    const inBlackbaud = !!(deal.pipeline && ctx.blackbaudPipelines.has(deal.pipeline));
    return {
      classification: inBlackbaud ? "existing" : "internal",
      matched_by: "bb_id",
      hs_deal_id: deal.id,
      matched_pipeline: deal.pipeline,
      match_count: 1,
      edgeCase: null,
    };
  }

  // ── BBID not found → exact deal-name search decides NEW vs REVIEW ──
  const count = nameMatchCount ?? 0;
  if (count === 0) {
    return {
      classification: "new",
      matched_by: "none",
      hs_deal_id: null,
      matched_pipeline: null,
      match_count: 0,
      edgeCase: null,
    };
  }
  if (count === 1) {
    return {
      classification: "review",
      matched_by: "deal_name",
      hs_deal_id: null,
      matched_pipeline: null,
      match_count: 1,
      edgeCase: {
        kind: "name_match_single",
        category: 2,
        detail: `1 deal-name match for "${row.deal_name ?? ""}" with no BB ID — confirm existing`,
      },
    };
  }
  return {
    classification: "review",
    matched_by: "deal_name",
    hs_deal_id: null,
    matched_pipeline: null,
    match_count: count,
    edgeCase: {
      kind: "name_match_multiple",
      category: 3,
      detail: `${count} deal-name matches for "${row.deal_name ?? ""}" — ambiguous`,
    },
  };
}

// ─────────────────────────────── orchestration ───────────────────────────────

export interface EdgeCaseEntry extends EdgeCase {
  row_id: string;
  row_number: number;
  classification: Classification;
}

export interface ClassifyDeps {
  loadRows(importRunId: string): Promise<ClassifyRow[]>;
  /** Batch-search HubSpot deals by `unique_bb_id` → bb_id → matched deals. */
  searchDealsByBbid(bbIds: string[]): Promise<Map<string, DealMatch[]>>;
  /** Count of exact deal-name matches in HubSpot. */
  searchByName(dealName: string): Promise<number>;
  updateRow(rowId: string, patch: Record<string, unknown>): Promise<void>;
  updateRun(runId: string, patch: Record<string, unknown>): Promise<void>;
}

export interface ClassifyInput {
  importRunId: string;
  /** HubSpot pipeline IDs that count as Blackbaud pipelines (EXISTING). */
  blackbaudPipelines: Set<string>;
}

export interface ClassifyResult {
  importRunId: string;
  counts: Record<Classification, number>;
  edgeCaseCount: number;
}

export async function runClassify(
  deps: ClassifyDeps,
  input: ClassifyInput,
): Promise<ClassifyResult> {
  if (!input.importRunId) throw new Error("Missing required field: importRunId");

  const rows = await deps.loadRows(input.importRunId);
  await deps.updateRun(input.importRunId, { status: "classifying" });

  const ctx: ClassifyContext = { blackbaudPipelines: input.blackbaudPipelines };

  // One batch search up front for every row that has a bb_id.
  const bbIds = rows.map((r) => (r.bb_id ?? "").trim()).filter((v) => v.length > 0);
  const matchesByBbid = bbIds.length > 0
    ? await deps.searchDealsByBbid(bbIds)
    : new Map<string, DealMatch[]>();

  const nameCountCache = new Map<string, number>();
  const counts: Record<Classification, number> = {
    new: 0,
    existing: 0,
    internal: 0,
    hold: 0,
    review: 0,
  };
  const edgeCases: EdgeCaseEntry[] = [];

  for (const row of rows) {
    const bb = (row.bb_id ?? "").trim();
    const matches = bb ? (matchesByBbid.get(bb) ?? []) : [];

    let nameMatchCount: number | null = null;
    if (needsNameSearch(row, matches)) {
      const name = (row.deal_name ?? "").trim();
      if (!nameCountCache.has(name)) nameCountCache.set(name, await deps.searchByName(name));
      nameMatchCount = nameCountCache.get(name) ?? 0;
    }

    const result = classifyRow(row, ctx, matches, nameMatchCount);
    counts[result.classification]++;

    if (result.edgeCase) {
      edgeCases.push({
        row_id: row.id,
        row_number: row.row_number,
        classification: result.classification,
        ...result.edgeCase,
      });
    }
    if (
      row.domain_flagged &&
      result.classification !== "hold" &&
      result.classification !== "internal"
    ) {
      edgeCases.push({
        row_id: row.id,
        row_number: row.row_number,
        classification: result.classification,
        kind: "domain_flag",
        category: 7,
        detail: `Suspect domain "${row.domain ?? ""}" — verify it matches the account`,
      });
    }

    await deps.updateRow(row.id, {
      classification: result.classification,
      matched_by: result.matched_by,
      hs_deal_id: result.hs_deal_id,
      matched_pipeline: result.matched_pipeline,
      match_count: result.match_count,
    });
  }

  await deps.updateRun(input.importRunId, {
    status: "classified",
    new_count: counts.new,
    existing_count: counts.existing,
    review_count: counts.review,
    edge_cases: edgeCases,
  });

  return {
    importRunId: input.importRunId,
    counts,
    edgeCaseCount: edgeCases.length,
  };
}
