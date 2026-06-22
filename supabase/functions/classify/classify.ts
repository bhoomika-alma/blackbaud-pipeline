// Phase C — classification. `classifyRow` is a pure decision function over the
// HubSpot search results; `runClassify` orchestrates the searches + persistence
// with injected I/O so it is unit-testable without HubSpot or the database.

import { ACTIVE_STAGES } from "../_shared/clean.ts";
import type { HubSpotDeal } from "../_shared/hubspot.ts";

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

function pipelineOf(deal: HubSpotDeal): string | null {
  return deal.properties["pipeline"] ?? null;
}

/**
 * Decide a row's classification given its bb_id matches and (for active-stage,
 * unmatched rows) its deal-name matches.
 */
export function classifyRow(
  row: ClassifyRow,
  bbidMatches: HubSpotDeal[],
  nameMatches: HubSpotDeal[] | null,
  blackbaudPipelineIds: Set<string>,
): ClassificationResult {
  if (bbidMatches.length > 0) {
    const deal = bbidMatches[0];
    const pipeline = pipelineOf(deal);
    const inBlackbaud = pipeline !== null && blackbaudPipelineIds.has(pipeline);
    const dupEdge: EdgeCase | null = bbidMatches.length > 1
      ? {
        kind: "duplicate_bbid",
        category: 4,
        detail: `${bbidMatches.length} HubSpot deals share unique_bb_id ${row.bb_id ?? ""}`,
      }
      : null;
    return {
      classification: inBlackbaud ? "existing" : "internal",
      matched_by: "bb_id",
      hs_deal_id: deal.id,
      matched_pipeline: pipeline,
      match_count: bbidMatches.length,
      edgeCase: dupEdge,
    };
  }

  const stage = (row.stage ?? "").trim().toLowerCase();
  if (!ACTIVE_STAGES.includes(stage)) {
    return {
      classification: "hold",
      matched_by: "none",
      hs_deal_id: null,
      matched_pipeline: null,
      match_count: 0,
      edgeCase: null,
    };
  }

  const matches = nameMatches ?? [];
  if (matches.length === 0) {
    return {
      classification: "new",
      matched_by: "none",
      hs_deal_id: null,
      matched_pipeline: null,
      match_count: 0,
      edgeCase: { kind: "new_arr", category: 1, detail: "New deal — confirm the ARR amount" },
    };
  }
  if (matches.length === 1) {
    return {
      classification: "review",
      matched_by: "deal_name",
      hs_deal_id: matches[0].id,
      matched_pipeline: pipelineOf(matches[0]),
      match_count: 1,
      edgeCase: {
        kind: "name_match_single",
        category: 2,
        detail: `1 deal-name match for "${row.deal_name ?? ""}" with no BB ID — confirm`,
      },
    };
  }
  return {
    classification: "review",
    matched_by: "deal_name",
    hs_deal_id: null,
    matched_pipeline: null,
    match_count: matches.length,
    edgeCase: {
      kind: "name_match_multiple",
      category: 3,
      detail: `${matches.length} deal-name matches for "${row.deal_name ?? ""}" — ambiguous`,
    },
  };
}

export interface EdgeCaseEntry extends EdgeCase {
  row_id: string;
  row_number: number;
  classification: Classification;
}

export interface ClassifyDeps {
  loadRows(importRunId: string): Promise<ClassifyRow[]>;
  searchByBbid(bbIds: string[]): Promise<Map<string, HubSpotDeal[]>>;
  searchByName(dealName: string): Promise<HubSpotDeal[]>;
  updateRow(rowId: string, patch: Record<string, unknown>): Promise<void>;
  updateRun(runId: string, patch: Record<string, unknown>): Promise<void>;
}

export interface ClassifyInput {
  importRunId: string;
  blackbaudPipelineIds: Set<string>;
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

  const bbIds = rows
    .map((r) => r.bb_id?.trim())
    .filter((v): v is string => !!v && v.length > 0);
  const bbidMap = await deps.searchByBbid(bbIds);

  const nameCache = new Map<string, HubSpotDeal[]>();
  const counts: Record<Classification, number> = {
    new: 0,
    existing: 0,
    internal: 0,
    hold: 0,
    review: 0,
  };
  const edgeCases: EdgeCaseEntry[] = [];

  for (const row of rows) {
    const bbid = row.bb_id?.trim();
    const bbidMatches = (bbid && bbidMap.get(bbid)) || [];

    let nameMatches: HubSpotDeal[] | null = null;
    const stage = (row.stage ?? "").trim().toLowerCase();
    if (bbidMatches.length === 0 && ACTIVE_STAGES.includes(stage)) {
      const name = (row.deal_name ?? "").trim();
      if (name.length > 0) {
        if (!nameCache.has(name)) nameCache.set(name, await deps.searchByName(name));
        nameMatches = nameCache.get(name) ?? [];
      } else {
        nameMatches = [];
      }
    }

    const result = classifyRow(row, bbidMatches, nameMatches, input.blackbaudPipelineIds);
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

  return { importRunId: input.importRunId, counts, edgeCaseCount: edgeCases.length };
}
