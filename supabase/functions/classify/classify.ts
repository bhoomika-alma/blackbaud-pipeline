// Phase C — classification via the two HubSpot lists.
//
// Each row is matched (by unique_bb_id, with deal name as backup) against:
//   1. "BB Pipeline Deals moved to Internal Pipelines"  → INTERNAL (drop/skip)
//   2. "BB Pipeline Deals"                               → EXISTING (update)
//   3. neither (unmapped) → must be an active stage AND created after the last
//      BB import; then an exact deal-name search decides NEW (0) vs REVIEW (1+).
//
// `classifyRow` is pure; `runClassify` orchestrates list/import lookups + the
// name search + persistence via injected I/O so it is unit-testable.

import { ACTIVE_STAGES } from "../_shared/clean.ts";

export type Classification = "new" | "existing" | "internal" | "hold" | "review";
export type MatchedBy = "none" | "bb_id" | "deal_name";

export interface ClassifyRow {
  id: string;
  row_number: number;
  bb_id: string | null;
  stage: string | null;
  deal_name: string | null;
  created_date: string | null;
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

/** Member keys of a HubSpot deal list: unique_bb_ids + lowercased deal names. */
export interface ListKeys {
  bbids: Set<string>;
  names: Set<string>;
}

export interface ClassifyContext {
  /** "BB Pipeline Deals moved to Internal Pipelines" — matched → INTERNAL. */
  internal: ListKeys;
  /** "BB Pipeline Deals" — matched → EXISTING. */
  existing: ListKeys;
  /** Only unmapped deals created AFTER this date are NEW candidates (ISO, or null). */
  lastImportDate: string | null;
}

function inList(row: ClassifyRow, keys: ListKeys): MatchedBy | null {
  const bb = (row.bb_id ?? "").trim();
  if (bb && keys.bbids.has(bb)) return "bb_id";
  const nameKey = (row.deal_name ?? "").trim().toLowerCase();
  if (nameKey && keys.names.has(nameKey)) return "deal_name";
  return null;
}

function isActiveStage(row: ClassifyRow): boolean {
  return ACTIVE_STAGES.includes((row.stage ?? "").trim().toLowerCase());
}

function createdBeforeLastImport(row: ClassifyRow, ctx: ClassifyContext): boolean {
  // ISO dates compare lexicographically. created_date <= lastImportDate ⇒ already
  // covered by an earlier import.
  return !!(ctx.lastImportDate && row.created_date && row.created_date <= ctx.lastImportDate);
}

/** True when a row reaches the unmapped branch and needs an exact deal-name search. */
export function needsNameSearch(row: ClassifyRow, ctx: ClassifyContext): boolean {
  if (inList(row, ctx.internal) || inList(row, ctx.existing)) return false;
  if (!isActiveStage(row)) return false;
  if (createdBeforeLastImport(row, ctx)) return false;
  return (row.deal_name ?? "").trim().length > 0;
}

function hold(): ClassificationResult {
  return {
    classification: "hold",
    matched_by: "none",
    hs_deal_id: null,
    matched_pipeline: null,
    match_count: 0,
    edgeCase: null,
  };
}

/**
 * Decide a row's classification given the list context and (for unmapped,
 * active-stage, recent rows) the number of exact deal-name matches in HubSpot.
 */
export function classifyRow(
  row: ClassifyRow,
  ctx: ClassifyContext,
  nameMatchCount: number | null,
): ClassificationResult {
  const internalMatch = inList(row, ctx.internal);
  if (internalMatch) {
    return {
      classification: "internal",
      matched_by: internalMatch,
      hs_deal_id: null,
      matched_pipeline: null,
      match_count: 1,
      edgeCase: null,
    };
  }

  const existingMatch = inList(row, ctx.existing);
  if (existingMatch) {
    return {
      classification: "existing",
      matched_by: existingMatch,
      hs_deal_id: null,
      matched_pipeline: null,
      match_count: 1,
      edgeCase: null,
    };
  }

  if (!isActiveStage(row)) return hold();
  // Created on/before the last import → already handled in a prior run.
  if (createdBeforeLastImport(row, ctx)) return hold();

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
        detail: `1 deal-name match for "${row.deal_name ?? ""}" with no BB ID — confirm`,
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

// ─────────────────────────── import-name date parsing ───────────────────────────

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Parse a date out of an import name like "BB Pipeline Report 29th May 2026 - …". */
export function parseImportDate(name: string, defaultYear: number): string | null {
  const m = name.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?(?:,?\s+(\d{4}))?/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  const year = m[3] ? parseInt(m[3], 10) : defaultYear;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Latest date among imports whose name matches the BB Pipeline Report convention. */
export function latestBbImportDate(
  imports: { name: string }[],
  defaultYear: number,
): string | null {
  let latest: string | null = null;
  for (const imp of imports) {
    if (!/bb pipeline report/i.test(imp.name)) continue;
    const date = parseImportDate(imp.name, defaultYear);
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

// ─────────────────────────────── orchestration ───────────────────────────────

export interface EdgeCaseEntry extends EdgeCase {
  row_id: string;
  row_number: number;
  classification: Classification;
}

export interface ClassifyDeps {
  loadRows(importRunId: string): Promise<ClassifyRow[]>;
  /** Member keys (bbids + names) of a deal list, resolved by name. */
  getListKeys(listName: string): Promise<ListKeys>;
  /** The last BB import date (ISO) parsed from recent import names, or null. */
  getLastImportDate(): Promise<string | null>;
  /** Count of exact deal-name matches in HubSpot. */
  searchByName(dealName: string): Promise<number>;
  updateRow(rowId: string, patch: Record<string, unknown>): Promise<void>;
  updateRun(runId: string, patch: Record<string, unknown>): Promise<void>;
}

export interface ClassifyInput {
  importRunId: string;
  internalListName: string;
  existingListName: string;
}

export interface ClassifyResult {
  importRunId: string;
  counts: Record<Classification, number>;
  edgeCaseCount: number;
  lastImportDate: string | null;
}

export async function runClassify(
  deps: ClassifyDeps,
  input: ClassifyInput,
): Promise<ClassifyResult> {
  if (!input.importRunId) throw new Error("Missing required field: importRunId");

  const rows = await deps.loadRows(input.importRunId);
  await deps.updateRun(input.importRunId, { status: "classifying" });

  const [internal, existing, lastImportDate] = await Promise.all([
    deps.getListKeys(input.internalListName),
    deps.getListKeys(input.existingListName),
    deps.getLastImportDate(),
  ]);
  const ctx: ClassifyContext = { internal, existing, lastImportDate };

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
    let nameMatchCount: number | null = null;
    if (needsNameSearch(row, ctx)) {
      const name = (row.deal_name ?? "").trim();
      if (!nameCountCache.has(name)) nameCountCache.set(name, await deps.searchByName(name));
      nameMatchCount = nameCountCache.get(name) ?? 0;
    }

    const result = classifyRow(row, ctx, nameMatchCount);
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
    lastImportDate,
  };
}
