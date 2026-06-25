// HTTP entrypoint for the `classify` Edge Function. Wires the HubSpot client and
// Supabase service-role client into runClassify.

import { createClient } from "@supabase/supabase-js";
import { blackbaudPipelineIds, getConfig } from "../_shared/env.ts";
import { HubSpotClient } from "../_shared/hubspot.ts";
import { errorMessage, handleOptions, json } from "../_shared/http.ts";
import { type ClassifyDeps, type ClassifyRow, type DealMatch, runClassify } from "./classify.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const importRunId = String(body.importRunId ?? "");
  if (!importRunId) return json({ error: "Missing required field: importRunId" }, 400);

  let config;
  try {
    config = getConfig();
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
  // Classification READS from production (deal lookups by bb_id + name).
  const hubspot = HubSpotClient.read(config);

  const deps: ClassifyDeps = {
    loadRows: async (runId) => {
      const { data, error } = await supabase
        .from("deal_rows")
        .select("id,row_number,bb_id,stage,deal_name,domain,domain_flagged")
        .eq("import_run_id", runId)
        .order("row_number", { ascending: true });
      if (error) throw new Error(`Failed to load deal_rows: ${error.message}`);
      return (data ?? []) as ClassifyRow[];
    },
    searchDealsByBbid: async (bbIds) => {
      const grouped = await hubspot.searchDealsByBbid(bbIds);
      const out = new Map<string, DealMatch[]>();
      for (const [bbId, deals] of grouped) {
        out.set(bbId, deals.map((d) => ({ id: d.id, pipeline: d.properties["pipeline"] ?? null })));
      }
      return out;
    },
    searchByName: async (dealName) => (await hubspot.searchDealsByName(dealName)).length,
    updateRow: async (rowId, patch) => {
      const { error } = await supabase.from("deal_rows").update(patch).eq("id", rowId);
      if (error) throw new Error(`Failed to update deal_row ${rowId}: ${error.message}`);
    },
    updateRun: async (runId, patch) => {
      const { error } = await supabase.from("import_runs").update(patch).eq("id", runId);
      if (error) throw new Error(`Failed to update import_run: ${error.message}`);
    },
  };

  try {
    const result = await runClassify(deps, {
      importRunId,
      blackbaudPipelines: blackbaudPipelineIds(config),
    });
    return json(result, 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
});
