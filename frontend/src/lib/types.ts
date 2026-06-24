// Shared types mirroring the DB rows + Edge Function responses used by the screens.

export type Classification = "pending" | "new" | "existing" | "internal" | "hold" | "review"
export type ReviewDecision = "pending" | "approve" | "skip" | "confirm" | "reject"
export type ImportAction = "pending" | "create" | "update" | "skip" | "error"

export interface EdgeCaseEntry {
  row_id: string
  row_number: number
  classification: string
  kind: string
  category: number
  detail: string
}

export interface DuplicateCompany {
  domain: string
  companyIds: string[]
}

export interface ImportSummary {
  created: number
  updated: number
  skipped: number
  errors: { row_number: number; error: string }[]
  companies_created?: number
  companies_existing?: number
  contacts_created?: number
  contacts_existing?: number
  deals_created?: number
  deals_existing?: number
  duplicate_companies: DuplicateCompany[]
  total_rows: number
}

export interface ImportRun {
  id: string
  filename: string
  source_label: string | null
  uploaded_by_email: string | null
  status: string
  row_count: number
  new_count: number
  existing_count: number
  review_count: number
  review_status: string
  reviewed_by_email: string | null
  approved_count: number
  skipped_count: number
  edge_cases: EdgeCaseEntry[] | null
  summary: ImportSummary | null
  created_at: string
}

export interface DealRow {
  id: string
  row_number: number
  bb_id: string | null
  account_name: string | null
  stage: string | null
  region: string | null
  vertical: string | null
  arr_raw: string | null
  arr_final: number | null
  domain: string | null
  domain_final: string | null
  domain_flagged: boolean
  first_name: string | null
  last_name: string | null
  contact_email: string | null
  deal_name: string | null
  derived_pipeline: string | null
  classification: Classification
  matched_by: string
  hs_deal_id: string | null
  matched_pipeline: string | null
  match_count: number
  review_decision: ReviewDecision
  linked_hs_deal_id: string | null
  import_action: ImportAction
  result_hs_deal_id: string | null
  result_hs_company_id: string | null
  result_hs_contact_id: string | null
  import_error: string | null
  close_date: string | null
  demonstrate_stage_date: string | null
}

export interface IngestResponse {
  importRunId: string
  rowCount: number
}

export interface ClassifyResponse {
  importRunId: string
  counts: Record<string, number>
  edgeCaseCount: number
}
