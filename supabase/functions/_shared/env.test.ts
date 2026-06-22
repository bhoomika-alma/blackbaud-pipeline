import { assertEquals, assertThrows } from "std/assert/mod.ts";
import { blackbaudPipelineIds, getConfig } from "./env.ts";

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "HUBSPOT_TOKEN",
  "BB_UPLOADS_BUCKET",
  "HUBSPOT_PIPELINE_HIGHERED",
  "HUBSPOT_PIPELINE_K12",
  "HUBSPOT_PIPELINE_CANADA",
  "HUBSPOT_PIPELINE_ENGLAND",
];

function clearEnv() {
  for (const key of ENV_KEYS) Deno.env.delete(key);
}

function setRequired() {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  Deno.env.set("HUBSPOT_TOKEN", "pat-token");
}

Deno.test("getConfig throws a clear error when a required var is missing", () => {
  clearEnv();
  assertThrows(() => getConfig(), Error, "SUPABASE_URL");
});

Deno.test("getConfig fills optional vars with documented defaults", () => {
  clearEnv();
  setRequired();
  const cfg = getConfig();
  assertEquals(cfg.supabaseUrl, "https://example.supabase.co");
  assertEquals(cfg.bucket, "bb-uploads");
  assertEquals(cfg.blackbaudPipelines.highered, "16363685");
  assertEquals(cfg.blackbaudPipelines.k12, "23038595");
  assertEquals(cfg.blackbaudPipelines.canada, "36496197");
  assertEquals(cfg.blackbaudPipelines.england, "36528146");
});

Deno.test("optional var overrides its default when set", () => {
  clearEnv();
  setRequired();
  Deno.env.set("BB_UPLOADS_BUCKET", "custom-bucket");
  assertEquals(getConfig().bucket, "custom-bucket");
});

Deno.test("blackbaudPipelineIds returns the four pipeline ids", () => {
  clearEnv();
  setRequired();
  const ids = blackbaudPipelineIds(getConfig());
  assertEquals(ids.size, 4);
  assertEquals(ids.has("16363685"), true);
  assertEquals(ids.has("36496197"), true);
});
