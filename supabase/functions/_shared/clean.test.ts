import { assertEquals } from "std/assert/mod.ts";
import {
  ACTIVE_STAGES,
  BB_PIPELINES,
  buildDealName,
  cleanDomain,
  demonstrateStageDate,
  derivePipeline,
  pipelineKeyForName,
  splitName,
} from "./clean.ts";

// ───────────────────────────── cleanDomain ─────────────────────────────

Deno.test("cleanDomain: strips protocol, www, path, and trailing slash", () => {
  assertEquals(cleanDomain("https://www.uwindsor.ca/"), { domain: "uwindsor.ca", flagged: false });
});

Deno.test("cleanDomain: lowercases and trims", () => {
  assertEquals(cleanDomain("  HTTP://Example.COM  "), { domain: "example.com", flagged: false });
});

Deno.test("cleanDomain: strips port", () => {
  assertEquals(cleanDomain("https://example.com:443/foo"), {
    domain: "example.com",
    flagged: false,
  });
});

Deno.test("cleanDomain: cuts query and fragment", () => {
  assertEquals(cleanDomain("example.org?utm=1"), { domain: "example.org", flagged: false });
  assertEquals(cleanDomain("example.org#section"), { domain: "example.org", flagged: false });
});

Deno.test("cleanDomain: 3+ labels strips leading sub-label and flags", () => {
  assertEquals(cleanDomain("mail.broward.edu"), { domain: "broward.edu", flagged: true });
  assertEquals(cleanDomain("https://www.foo.bar.com"), { domain: "bar.com", flagged: true });
});

Deno.test("cleanDomain: 2-part ccTLDs are not stripped or flagged", () => {
  assertEquals(cleanDomain("example.co.uk"), { domain: "example.co.uk", flagged: false });
  assertEquals(cleanDomain("https://www.dept.ac.uk/"), { domain: "dept.ac.uk", flagged: false });
  assertEquals(cleanDomain("school.ab.ca"), { domain: "school.ab.ca", flagged: false });
});

Deno.test("cleanDomain: empty / nullish input", () => {
  assertEquals(cleanDomain(""), { domain: "", flagged: false });
  assertEquals(cleanDomain(null), { domain: "", flagged: false });
  assertEquals(cleanDomain(undefined), { domain: "", flagged: false });
});

// ───────────────────────────── splitName ─────────────────────────────

Deno.test("splitName: first token vs remainder", () => {
  assertEquals(splitName("John Smith"), { firstName: "John", lastName: "Smith" });
  assertEquals(splitName("Jean Luc Picard"), { firstName: "Jean", lastName: "Luc Picard" });
  assertEquals(splitName("Madonna"), { firstName: "Madonna", lastName: "" });
  assertEquals(splitName("  Ada   Lovelace  "), { firstName: "Ada", lastName: "Lovelace" });
  assertEquals(splitName(""), { firstName: "", lastName: "" });
});

Deno.test("splitName: falls back to the email local-part when name is blank", () => {
  assertEquals(splitName("", "jane.doe@uwindsor.ca"), { firstName: "Jane", lastName: "Doe" });
  assertEquals(splitName(null, "j_q_public@acme.org"), { firstName: "J", lastName: "Q Public" });
  assertEquals(splitName("", "madonna@x.com"), { firstName: "Madonna", lastName: "" });
  // a real name always wins over the email
  assertEquals(splitName("Alan Turing", "ignored@x.com"), {
    firstName: "Alan",
    lastName: "Turing",
  });
  assertEquals(splitName("", ""), { firstName: "", lastName: "" });
});

// ─────────────────────────── demonstrateStageDate ───────────────────────────

Deno.test("demonstrateStageDate: set for active stages, blank otherwise", () => {
  assertEquals(demonstrateStageDate("Demonstrate", "2026-03-15"), "2026-03-15");
  assertEquals(demonstrateStageDate("Propose", "2026-03-15"), "2026-03-15");
  assertEquals(demonstrateStageDate("Negotiate", "2026-03-15"), "2026-03-15");
  assertEquals(demonstrateStageDate("Discover", "2026-03-15"), null);
  assertEquals(demonstrateStageDate("Engage", "2026-03-15"), null);
  assertEquals(demonstrateStageDate("Demonstrate", ""), null);
});

Deno.test("ACTIVE_STAGES holds the three active stages", () => {
  assertEquals(ACTIVE_STAGES, ["demonstrate", "propose", "negotiate"]);
});

// ───────────────────────────── derivePipeline ─────────────────────────────

Deno.test("derivePipeline: region + vertical mapping (names and BB codes)", () => {
  // England / Canada — dedicated pipelines, no vertical split.
  assertEquals(derivePipeline("England", "HigherEd"), "Blackbaud England");
  assertEquals(derivePipeline("BBE", "Schools (K-12)"), "Blackbaud England");
  assertEquals(derivePipeline("Canada", "K12"), "Blackbaud Canada");
  assertEquals(derivePipeline("BBC", "Schools (K-12)"), "Blackbaud Canada");
  // US / LatAm-Caribbean — split by vertical (real K-12 value is "Schools (K-12)").
  assertEquals(derivePipeline("US", "Schools (K-12)"), "Blackbaud k12 pipeline");
  assertEquals(derivePipeline("BBUS", "Schools (K-12)"), "Blackbaud k12 pipeline");
  assertEquals(derivePipeline("BBUS", "Higher Education"), "Blackbaud HigherEd pipeline");
  assertEquals(derivePipeline("BBLATCAR", "Schools (K-12)"), "Blackbaud k12 pipeline");
  assertEquals(derivePipeline("BBLATCAR", "Healthcare"), "Blackbaud HigherEd pipeline");
  assertEquals(derivePipeline("LatAm", "K-12"), "Blackbaud k12 pipeline");
  // Unknown region defaults to the US branch.
  assertEquals(derivePipeline("", ""), "Blackbaud HigherEd pipeline");
});

Deno.test("pipelineKeyForName: reverse lookup", () => {
  assertEquals(pipelineKeyForName("Blackbaud England"), "england");
  assertEquals(pipelineKeyForName("Blackbaud k12 pipeline"), "k12");
  assertEquals(pipelineKeyForName("Blackbaud HigherEd pipeline"), "highered");
  assertEquals(pipelineKeyForName("Blackbaud Canada"), "canada");
  assertEquals(pipelineKeyForName("Nope"), undefined);
});

Deno.test("BB_PIPELINES has all four pipelines", () => {
  assertEquals(Object.keys(BB_PIPELINES).sort(), ["canada", "england", "highered", "k12"]);
});

// ───────────────────────────── buildDealName ─────────────────────────────

Deno.test("buildDealName: account + ' - ' + pipeline", () => {
  assertEquals(
    buildDealName("University of Windsor", "Blackbaud Canada"),
    "University of Windsor - Blackbaud Canada",
  );
  assertEquals(buildDealName("  Acme  ", "Blackbaud England"), "Acme - Blackbaud England");
});
