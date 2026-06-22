// End-to-end over the sample CSV fixture: parse → validate columns → clean each
// row → classify with mocked HubSpot results. No live HTTP.

import { assertEquals } from "std/assert/mod.ts";
import { buildCleanedRow, validateColumns } from "./blackbaud.ts";
import { parseCsv } from "./csv.ts";
import { type ClassifyRow, classifyRow } from "../classify/classify.ts";
import type { HubSpotDeal } from "./hubspot.ts";

const BB_PIPELINES = new Set(["16363685", "23038595", "36496197", "36528146"]);
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

function asClassifyRow(
  bbId: string | null,
  stage: string,
  dealName: string,
): ClassifyRow {
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

function deal(pipeline: string): HubSpotDeal {
  return { id: "d1", properties: { pipeline } };
}

Deno.test("fixture: classification over mocked HubSpot results", () => {
  // bb_id match in a Blackbaud pipeline → EXISTING.
  assertEquals(
    classifyRow(asClassifyRow("BB1001", "Demonstrate", "x"), [deal("36496197")], null, BB_PIPELINES)
      .classification,
    "existing",
  );
  // bb_id match outside Blackbaud pipelines → INTERNAL.
  assertEquals(
    classifyRow(asClassifyRow("BB9", "Demonstrate", "x"), [deal("70000000")], null, BB_PIPELINES)
      .classification,
    "internal",
  );
  // no bb_id match + inactive stage → HOLD.
  assertEquals(
    classifyRow(asClassifyRow(null, "Discover", "x"), [], null, BB_PIPELINES).classification,
    "hold",
  );
  // no match, active stage, no name match → NEW.
  assertEquals(
    classifyRow(asClassifyRow(null, "Propose", "Acme - X"), [], [], BB_PIPELINES).classification,
    "new",
  );
  // no match, active stage, 1 name match → REVIEW.
  assertEquals(
    classifyRow(asClassifyRow(null, "Propose", "Acme - X"), [], [deal("1")], BB_PIPELINES)
      .classification,
    "review",
  );
});
