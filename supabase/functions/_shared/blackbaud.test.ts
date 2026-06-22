import { assertEquals } from "std/assert/mod.ts";
import {
  buildCleanedRow,
  buildColumnMapping,
  normalizeDate,
  validateColumns,
} from "./blackbaud.ts";

const HEADERS = [
  "Unique BB ID",
  "Account Name",
  "Contact Name",
  "Contact Email",
  "Website",
  "Stage",
  "Region",
  "Vertical",
  "ARR",
  "Created Date",
  "Close Date",
  "Last Stage Change Date",
];

Deno.test("validateColumns: ok when required columns present", () => {
  const result = validateColumns(HEADERS);
  assertEquals(result.ok, true);
  assertEquals(result.missing, []);
});

Deno.test("validateColumns: reports missing required columns", () => {
  const result = validateColumns(["Account Name", "Website"]);
  assertEquals(result.ok, false);
  // bb_id, stage, region, vertical are missing.
  assertEquals(result.missing, ["Unique BB ID", "Stage", "Region", "Vertical"]);
});

Deno.test("buildColumnMapping: matches aliases case/underscore-insensitively", () => {
  const mapping = buildColumnMapping([
    "BB_ID",
    "Company Name",
    "Deal Stage",
    "geography",
    "segment",
  ]);
  assertEquals(mapping.bb_id, "BB_ID");
  assertEquals(mapping.account_name, "Company Name");
  assertEquals(mapping.stage, "Deal Stage");
  assertEquals(mapping.region, "geography");
  assertEquals(mapping.vertical, "segment");
});

Deno.test("normalizeDate: ISO and US formats, blank/unparseable → null", () => {
  assertEquals(normalizeDate("2026-03-15"), "2026-03-15");
  assertEquals(normalizeDate("2026-03-15T10:00:00Z"), "2026-03-15");
  assertEquals(normalizeDate("3/5/2026"), "2026-03-05");
  assertEquals(normalizeDate("12/31/2025"), "2025-12-31");
  assertEquals(normalizeDate(""), null);
  assertEquals(normalizeDate("not a date"), null);
});

Deno.test("buildCleanedRow: derives cleaned + computed fields", () => {
  const mapping = buildColumnMapping(HEADERS);
  const record: Record<string, string> = {
    "Unique BB ID": "BB1",
    "Account Name": "University of Windsor",
    "Contact Name": "Jane Doe",
    "Contact Email": "jane@uwindsor.ca",
    "Website": "https://www.uwindsor.ca/",
    "Stage": "Demonstrate",
    "Region": "Canada",
    "Vertical": "HigherEd",
    "ARR": "50000",
    "Created Date": "1/1/2026",
    "Close Date": "2026-06-30",
    "Last Stage Change Date": "3/15/2026",
  };
  const row = buildCleanedRow(record, 1, mapping);

  assertEquals(row.row_number, 1);
  assertEquals(row.bb_id, "BB1");
  assertEquals(row.domain, "uwindsor.ca");
  assertEquals(row.domain_flagged, false);
  assertEquals(row.first_name, "Jane");
  assertEquals(row.last_name, "Doe");
  assertEquals(row.created_date, "2026-01-01");
  assertEquals(row.close_date, "2026-06-30");
  assertEquals(row.last_stage_change_date, "2026-03-15");
  assertEquals(row.demonstrate_stage_date, "2026-03-15");
  assertEquals(row.derived_pipeline, "Blackbaud Canada");
  assertEquals(row.deal_name, "University of Windsor - Blackbaud Canada");
  assertEquals(row.raw_data["Account Name"], "University of Windsor");
});

Deno.test("buildCleanedRow: non-active stage leaves demonstrate date blank, flags subdomain", () => {
  const mapping = buildColumnMapping(HEADERS);
  const row = buildCleanedRow(
    {
      "Unique BB ID": "BB2",
      "Account Name": "Sample School",
      "Contact Name": "Madonna",
      "Website": "mail.broward.edu",
      "Stage": "Discover",
      "Region": "US",
      "Vertical": "K12",
      "Last Stage Change Date": "3/15/2026",
    },
    2,
    mapping,
  );

  assertEquals(row.demonstrate_stage_date, null);
  assertEquals(row.domain, "broward.edu");
  assertEquals(row.domain_flagged, true);
  assertEquals(row.first_name, "Madonna");
  assertEquals(row.last_name, null);
  assertEquals(row.derived_pipeline, "Blackbaud k12 pipeline");
});
