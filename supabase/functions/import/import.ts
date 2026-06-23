// Phase F + G — build payloads and import into HubSpot, then post-import
// duplicate-company check + summary. Pure helpers (action resolution + property
// builders) are unit-tested; `runImport` orchestrates with injected I/O.

import { BB_PIPELINES, type PipelineKey, pipelineKeyForName } from "../_shared/clean.ts";
import { errorMessage } from "../_shared/http.ts";

export type ImportAction = "create" | "update" | "skip";

export interface ImportRow {
  id: string;
  row_number: number;
  classification: string;
  review_decision: string;
  bb_id: string | null;
  account_name: string | null;
  domain: string | null;
  domain_final: string | null;
  contact_email: string | null;
  first_name: string | null;
  last_name: string | null;
  derived_pipeline: string | null;
  deal_name: string | null;
  hs_deal_id: string | null;
  linked_hs_deal_id: string | null;
  arr_raw: string | null;
  arr_final: number | null;
  close_date: string | null;
  demonstrate_stage_date: string | null;
  last_stage_change_date: string | null;
  region: string | null;
  vertical: string | null;
}

/** Resolve what the import should do with a row, from classification + review decision. */
export function resolveImportAction(row: ImportRow): ImportAction {
  if (row.review_decision === "skip" || row.review_decision === "reject") return "skip";
  switch (row.classification) {
    case "existing":
      return "update";
    case "new":
      return "create";
    case "review":
      if (row.review_decision === "confirm") return "update";
      if (row.review_decision === "approve") return "create";
      return "skip";
    default: // hold, internal, pending
      return "skip";
  }
}

function setProp(target: Record<string, string>, key: string, value: string | null | undefined) {
  const trimmed = (value ?? "").toString().trim();
  if (trimmed.length > 0) target[key] = trimmed;
}

/** Normalize an ARR/amount value to a bare number string (strip $, commas). */
export function cleanAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[^0-9.]/g, "");
}

function finalDomain(row: ImportRow): string {
  return (row.domain_final ?? row.domain ?? "").trim();
}

function finalArr(row: ImportRow): string {
  if (row.arr_final !== null && row.arr_final !== undefined) return cleanAmount(row.arr_final);
  return cleanAmount(row.arr_raw);
}

function pipelineIdFor(
  row: ImportRow,
  pipelineIds: Record<PipelineKey, string>,
): string | undefined {
  const key = row.derived_pipeline ? pipelineKeyForName(row.derived_pipeline) : undefined;
  return key ? pipelineIds[key] : undefined;
}

/** HubSpot `region` enum value (BBUS/BBC/BBE) derived from the routed pipeline. */
function regionCodeFor(row: ImportRow): string | undefined {
  const key = row.derived_pipeline ? pipelineKeyForName(row.derived_pipeline) : undefined;
  return key ? BB_PIPELINES[key].regionCode : undefined;
}

// Only these deal properties exist in HubSpot, so these are all we ever send.
// region/vertical have no HubSpot deal property (bb_region / bb_vertical do not
// exist), and there is no separate last_stage_change_date property — that signal
// is folded into demonstrate_stage_date. We never create properties; we only
// write to ones that already exist.

/** NEW-create deal properties — INCLUDES the ARR amount. */
export function buildCreateDealProperties(
  row: ImportRow,
  pipelineId?: string,
): Record<string, string> {
  const props: Record<string, string> = {};
  setProp(props, "unique_bb_id", row.bb_id);
  setProp(props, "dealname", row.deal_name);
  if (pipelineId) props["pipeline"] = pipelineId;
  setProp(props, "amount", finalArr(row));
  setProp(props, "closedate", row.close_date);
  setProp(props, "demonstrate_stage_date", row.demonstrate_stage_date);
  setProp(props, "region", regionCodeFor(row));
  return props;
}

/**
 * EXISTING-update deal properties — NO amount, and deal_name + pipeline are
 * never overwritten (omitted entirely).
 */
export function buildUpdateProperties(row: ImportRow): Record<string, string> {
  const props: Record<string, string> = {};
  setProp(props, "closedate", row.close_date);
  setProp(props, "demonstrate_stage_date", row.demonstrate_stage_date);
  setProp(props, "region", regionCodeFor(row));
  return props;
}

export function buildCompanyProperties(row: ImportRow, domain: string): Record<string, string> {
  const props: Record<string, string> = {};
  setProp(props, "name", row.account_name);
  setProp(props, "domain", domain);
  return props;
}

export function buildContactProperties(row: ImportRow): Record<string, string> {
  const props: Record<string, string> = {};
  setProp(props, "email", row.contact_email);
  setProp(props, "firstname", row.first_name);
  setProp(props, "lastname", row.last_name);
  return props;
}

export interface DuplicateCompany {
  domain: string;
  companyIds: string[];
}

/** Post-import: domains that resolved to more than one company → flag for merge. */
export function detectDuplicateCompanies(
  records: { domain: string; companyId: string }[],
): DuplicateCompany[] {
  const byDomain = new Map<string, Set<string>>();
  for (const { domain, companyId } of records) {
    if (!domain || !companyId) continue;
    const set = byDomain.get(domain) ?? new Set<string>();
    set.add(companyId);
    byDomain.set(domain, set);
  }
  const duplicates: DuplicateCompany[] = [];
  for (const [domain, ids] of byDomain) {
    if (ids.size > 1) duplicates.push({ domain, companyIds: [...ids] });
  }
  return duplicates;
}

export interface UpsertResult {
  id: string;
  created: boolean;
}

export interface ImportDeps {
  loadRows(importRunId: string): Promise<ImportRow[]>;
  setRunStatus(runId: string, status: string): Promise<void>;
  batchUpdateDeals(updates: { bbId: string; properties: Record<string, string> }[]): Promise<void>;
  upsertCompany(domain: string, properties: Record<string, string>): Promise<UpsertResult>;
  upsertContact(email: string, properties: Record<string, string>): Promise<UpsertResult>;
  upsertDeal(bbId: string, properties: Record<string, string>): Promise<UpsertResult>;
  createAssociation(fromType: string, fromId: string, toType: string, toId: string): Promise<void>;
  updateRowResult(rowId: string, patch: Record<string, unknown>): Promise<void>;
  finalizeRun(runId: string, patch: Record<string, unknown>): Promise<void>;
}

export interface ImportInput {
  importRunId: string;
  pipelineIds: Record<PipelineKey, string>;
  reviewerEmail?: string;
  importedAt?: string;
  reviewedAt?: string;
}

export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: { row_number: number; error: string }[];
  duplicate_companies: DuplicateCompany[];
  total_rows: number;
}

export interface ImportResult {
  importRunId: string;
  summary: ImportSummary;
}

export async function runImport(deps: ImportDeps, input: ImportInput): Promise<ImportResult> {
  if (!input.importRunId) throw new Error("Missing required field: importRunId");

  const rows = await deps.loadRows(input.importRunId);
  await deps.setRunStatus(input.importRunId, "importing");

  const actions = new Map(rows.map((r) => [r.id, resolveImportAction(r)]));
  const companyByDomain: { domain: string; companyId: string }[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { row_number: number; error: string }[] = [];

  // 1. EXISTING-update — batch update matched on unique_bb_id.
  const updateRows = rows.filter((r) => actions.get(r.id) === "update");
  const updatable = updateRows.filter((r) => (r.bb_id ?? "").trim().length > 0);
  const nonUpdatable = updateRows.filter((r) => (r.bb_id ?? "").trim().length === 0);

  if (updatable.length > 0) {
    const updates = updatable.map((r) => ({
      bbId: (r.bb_id ?? "").trim(),
      properties: buildUpdateProperties(r),
    }));
    try {
      await deps.batchUpdateDeals(updates);
      for (const r of updatable) {
        updated++;
        await deps.updateRowResult(r.id, {
          import_action: "update",
          result_hs_deal_id: r.hs_deal_id ?? r.linked_hs_deal_id ?? null,
          imported_at: input.importedAt ?? null,
          import_error: null,
        });
      }
    } catch (error) {
      for (const r of updatable) {
        errors.push({ row_number: r.row_number, error: errorMessage(error) });
        await deps.updateRowResult(r.id, {
          import_action: "error",
          import_error: errorMessage(error),
        });
      }
    }
  }
  for (const r of nonUpdatable) {
    skipped++;
    await deps.updateRowResult(r.id, {
      import_action: "skip",
      import_error: "Confirmed match has no unique_bb_id; link manually",
    });
  }

  // 2. NEW-create — company (by domain) + contact (by email) + deal + v4 associations.
  const createRows = rows.filter((r) => actions.get(r.id) === "create");
  for (const r of createRows) {
    try {
      const bbId = (r.bb_id ?? "").trim();
      if (!bbId) throw new Error("NEW row is missing unique_bb_id");

      let companyId: string | null = null;
      const domain = finalDomain(r);
      if (domain) {
        const company = await deps.upsertCompany(domain, buildCompanyProperties(r, domain));
        companyId = company.id;
        companyByDomain.push({ domain, companyId });
      }

      let contactId: string | null = null;
      const email = (r.contact_email ?? "").trim();
      if (email) {
        const contact = await deps.upsertContact(email, buildContactProperties(r));
        contactId = contact.id;
      }

      const deal = await deps.upsertDeal(
        bbId,
        buildCreateDealProperties(r, pipelineIdFor(r, input.pipelineIds)),
      );
      if (companyId) await deps.createAssociation("deal", deal.id, "company", companyId);
      if (contactId) await deps.createAssociation("deal", deal.id, "contact", contactId);

      created++;
      await deps.updateRowResult(r.id, {
        import_action: "create",
        result_hs_deal_id: deal.id,
        result_hs_company_id: companyId,
        result_hs_contact_id: contactId,
        imported_at: input.importedAt ?? null,
        import_error: null,
      });
    } catch (error) {
      errors.push({ row_number: r.row_number, error: errorMessage(error) });
      await deps.updateRowResult(r.id, {
        import_action: "error",
        import_error: errorMessage(error),
      });
    }
  }

  // 3. Skipped rows (hold / internal / unresolved review).
  const skipRows = rows.filter((r) => actions.get(r.id) === "skip");
  for (const r of skipRows) {
    skipped++;
    await deps.updateRowResult(r.id, { import_action: "skip" });
  }

  // 4. Post-import duplicate-company check + summary.
  const duplicateCompanies = detectDuplicateCompanies(companyByDomain);
  const summary: ImportSummary = {
    created,
    updated,
    skipped,
    errors,
    duplicate_companies: duplicateCompanies,
    total_rows: rows.length,
  };

  await deps.finalizeRun(input.importRunId, {
    status: "completed",
    review_status: "approved",
    approved_count: created + updated,
    skipped_count: skipped,
    reviewed_by_email: input.reviewerEmail ?? null,
    reviewed_at: input.reviewedAt ?? null,
    summary,
  });

  return { importRunId: input.importRunId, summary };
}
