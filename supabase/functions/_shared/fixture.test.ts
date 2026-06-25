// End-to-end over the sample CSV fixture: parse → validate columns → clean each
// row → classify with mocked HubSpot results. No live HTTP.

import { assertEquals } from "std/assert/mod.ts";
import { buildCleanedRow, validateColumns } from "./blackbaud.ts";
import { parseCsv } from "./csv.ts";
import {
  type ClassifyContext,
  type ClassifyRow,
  classifyRow,
  type DealMatch,
} from "../classify/classify.ts";

const csvText = await Deno.readTextFile(
  new URL("../_fixtures/sample_blackbaud.csv", import.meta.url),
);

Deno.test("fixture: columns validate and rows clean per Phase B", () => {
  const { headers, records } = parseCsv(csvText);
  const { ok, mapping } = validateColumns(headers);
  assertEquals(ok, true);
  assertEquals(records.length, 7);

  const rows = records.map((r, i) => buildCleanedRow(r, i + 1, mapping));

  // Windsor → uwindsor.ca, Canada pipeline, demonstrate date set (active stage).
  assertEquals(rows[0].domain, "uwindsor.ca");
  assertEquals(rows[0].domain_flagged, false);
  assertEquals(rows[0].derived_pipeline, "Blackbaud Canada");
  assertEquals(rows[0].deal_name, "University of Windsor - Blackbaud Canada");
  assertEquals(rows[0].demonstrate_stage_date, "2026-03-15");

  // Acme → US K12 pipeline, path stripped from website, US date normalized.
  assertEquals(rows[1].domain, "acmeacademy.org");
  assertEquals(rows[1].derived_pipeline, "Blackbaud k12 pipeline");
  assertEquals(rows[1].created_date, "2026-01-10");

  // Broward subdomain → stripped + flagged.
  assertEquals(rows[2].domain, "broward.edu");
  assertEquals(rows[2].domain_flagged, true);

  // Oxford → ac.uk 2-part ccTLD not flagged; inactive (Discover) → no demonstrate date.
  assertEquals(rows[3].domain, "oxfordtrust.ac.uk");
  assertEquals(rows[3].domain_flagged, false);
  assertEquals(rows[3].demonstrate_stage_date, null);

  // LatAm K12 → US k12 pipeline.
  assertEquals(rows[4].derived_pipeline, "Blackbaud k12 pipeline");

  // England (any vertical) → England pipeline; co.uk not flagged.
  assertEquals(rows[5].domain, "greenfield.co.uk");
  assertEquals(rows[5].derived_pipeline, "Blackbaud England");
});

function asClassifyRow(bbId: string | null, stage: string, dealName: string): ClassifyRow {
  return {
    id: "x",
    row_number: 1,
    bb_id: bbId,
    stage,
    deal_name: dealName,
    domain: null,
    domain_flagged: false,
  };
}

const BB_PIPELINES = new Set(["HE", "K12", "CA", "EN"]);

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return { blackbaudPipelines: BB_PIPELINES, ...over };
}

function deal(pipeline: string | null): DealMatch {
  return { id: "d1", pipeline };
}

Deno.test("fixture: classification by bb_id lookup + name search", () => {
  // Found by bb_id, in a Blackbaud pipeline → EXISTING.
  assertEquals(
    classifyRow(asClassifyRow("BB1001", "Demonstrate", "x"), ctx(), [deal("CA")], null)
      .classification,
    "existing",
  );
  // Found by bb_id, in a non-Blackbaud (internal) pipeline → INTERNAL.
  assertEquals(
    classifyRow(asClassifyRow("BB9", "Demonstrate", "x"), ctx(), [deal("999")], null)
      .classification,
    "internal",
  );
  // Not found + 0 name matches → NEW (no stage gate; early stages included).
  assertEquals(
    classifyRow(asClassifyRow(null, "Discover", "x"), ctx(), [], 0).classification,
    "new",
  );
  // Not found + 1 name match → REVIEW.
  assertEquals(
    classifyRow(asClassifyRow(null, "Propose", "Acme - X"), ctx(), [], 1).classification,
    "review",
  );
});
