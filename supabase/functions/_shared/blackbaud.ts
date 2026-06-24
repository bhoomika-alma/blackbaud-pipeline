// Maps a raw Blackbaud CSV row to the cleaned `deal_rows` shape (Phase B), and
// validates that the expected Blackbaud columns are present (Phase A).

import {
  buildDealName,
  cleanDomain,
  demonstrateStageDate,
  derivePipeline,
  splitName,
} from "./clean.ts";

export type FieldKey =
  | "bb_id"
  | "account_name"
  | "contact_name"
  | "contact_email"
  | "website"
  | "stage"
  | "region"
  | "vertical"
  | "arr"
  | "created_date"
  | "close_date"
  | "last_stage_change_date";

export type ColumnMapping = Partial<Record<FieldKey, string>>;

// Normalized (lowercase, punctuation-stripped, single-spaced) header aliases per
// field. The real Blackbaud export headers (§1 of BUILD_SPEC) come first.
const COLUMN_ALIASES: Record<FieldKey, string[]> = {
  bb_id: ["opportunity id", "unique bb id", "bb id", "bbid", "blackbaud id", "unique blackbaud id"],
  account_name: ["account name", "account", "company name", "company", "organization name"],
  contact_name: [
    "opportunity sourced contact",
    "contact name",
    "contact",
    "full name",
    "name",
  ],
  contact_email: ["contact email", "email", "email address"],
  website: ["website", "web site", "url", "company website"],
  stage: ["stage", "deal stage", "pipeline stage"],
  region: ["region", "geo", "geography", "country"],
  vertical: ["vertical", "segment", "market", "industry"],
  arr: [
    "annual recurring amount converted",
    "annual recurring amount",
    "arr",
    "amount",
    "annual recurring revenue",
    "deal amount",
  ],
  created_date: ["created date", "create date", "created", "created on"],
  close_date: ["close date", "expected close date", "closed date", "close"],
  last_stage_change_date: ["last stage change date", "stage change date", "last stage change"],
};

const FIELD_LABELS: Record<FieldKey, string> = {
  bb_id: "Unique BB ID",
  account_name: "Account Name",
  contact_name: "Contact Name",
  contact_email: "Contact Email",
  website: "Website",
  stage: "Stage",
  region: "Region",
  vertical: "Vertical",
  arr: "ARR",
  created_date: "Created Date",
  close_date: "Close Date",
  last_stage_change_date: "Last Stage Change Date",
};

// Columns that must be present for a CSV to be a valid Blackbaud pipeline export.
export const REQUIRED_FIELDS: FieldKey[] = [
  "bb_id",
  "account_name",
  "stage",
  "region",
  "vertical",
];

function normalizeHeader(header: string): string {
  // Lowercase and collapse any run of non-alphanumerics to a single space, so
  // "Contact: Email" → "contact email" and "Annual Recurring Amount (converted)"
  // → "annual recurring amount converted".
  return header.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildColumnMapping(headers: string[]): ColumnMapping {
  const byNormalized = new Map<string, string>();
  for (const header of headers) byNormalized.set(normalizeHeader(header), header);

  const mapping: ColumnMapping = {};
  for (const key of Object.keys(COLUMN_ALIASES) as FieldKey[]) {
    for (const alias of COLUMN_ALIASES[key]) {
      const found = byNormalized.get(alias);
      if (found) {
        mapping[key] = found;
        break;
      }
    }
  }
  return mapping;
}

export interface ColumnValidation {
  ok: boolean;
  missing: string[];
  mapping: ColumnMapping;
}

export function validateColumns(headers: string[]): ColumnValidation {
  const mapping = buildColumnMapping(headers);
  const missing = REQUIRED_FIELDS.filter((key) => !mapping[key]).map((key) => FIELD_LABELS[key]);
  return { ok: missing.length === 0, missing, mapping };
}

/** Normalize a date cell to ISO `YYYY-MM-DD`, or null if blank/unparseable. */
export function normalizeDate(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return null;
}

export interface CleanedRow {
  row_number: number;
  raw_data: Record<string, string>;
  bb_id: string | null;
  account_name: string | null;
  stage: string | null;
  region: string | null;
  vertical: string | null;
  arr_raw: string | null;
  created_date: string | null;
  close_date: string | null;
  last_stage_change_date: string | null;
  website_raw: string | null;
  contact_email: string | null;
  domain: string | null;
  domain_flagged: boolean;
  first_name: string | null;
  last_name: string | null;
  demonstrate_stage_date: string | null;
  derived_pipeline: string | null;
  deal_name: string | null;
}

function orNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildCleanedRow(
  record: Record<string, string>,
  rowNumber: number,
  mapping: ColumnMapping,
): CleanedRow {
  const get = (key: FieldKey): string => {
    const header = mapping[key];
    return header ? (record[header] ?? "") : "";
  };

  const website = get("website");
  const { domain, flagged } = cleanDomain(website);
  const { firstName, lastName } = splitName(get("contact_name"), get("contact_email"));
  const stage = get("stage");
  const region = get("region");
  const vertical = get("vertical");
  const accountName = get("account_name");
  const lastStageChange = normalizeDate(get("last_stage_change_date"));
  const derivedPipeline = derivePipeline(region, vertical);

  return {
    row_number: rowNumber,
    raw_data: record,
    bb_id: orNull(get("bb_id")),
    account_name: orNull(accountName),
    stage: orNull(stage),
    region: orNull(region),
    vertical: orNull(vertical),
    arr_raw: orNull(get("arr")),
    created_date: normalizeDate(get("created_date")),
    close_date: normalizeDate(get("close_date")),
    last_stage_change_date: lastStageChange,
    website_raw: orNull(website),
    contact_email: orNull(get("contact_email")),
    domain: domain.length > 0 ? domain : null,
    domain_flagged: flagged,
    first_name: orNull(firstName),
    last_name: orNull(lastName),
    demonstrate_stage_date: demonstrateStageDate(stage, lastStageChange),
    derived_pipeline: derivedPipeline,
    deal_name: accountName.trim().length > 0 ? buildDealName(accountName, derivedPipeline) : null,
  };
}
