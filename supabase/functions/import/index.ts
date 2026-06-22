// HTTP entrypoint for the `import` Edge Function. Wires the HubSpot client and
// Supabase service-role client into runImport.

import { createClient } from "@supabase/supabase-js";
import { getConfig } from "../_shared/env.ts";
import { HubSpotClient } from "../_shared/hubspot.ts";
import { errorMessage, handleOptions, json } from "../_shared/http.ts";
import { type ImportDeps, type ImportRow, runImport } from "./import.ts";

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
  const hubspot = HubSpotClient.fromConfig(config);
  const now = new Date().toISOString();

  const deps: ImportDeps = {
    loadRows: async (runId) => {
      const { data, error } = await supabase
        .from("deal_rows")
        .select(
          "id,row_number,classification,review_decision,bb_id,account_name,domain,domain_final," +
            "contact_email,first_name,last_name,derived_pipeline,deal_name,hs_deal_id," +
            "linked_hs_deal_id,arr_raw,arr_final,close_date,demonstrate_stage_date," +
            "last_stage_change_date,region,vertical",
        )
        .eq("import_run_id", runId)
        .order("row_number", { ascending: true });
      if (error) throw new Error(`Failed to load deal_rows: ${error.message}`);
      return (data ?? []) as unknown as ImportRow[];
    },
    setRunStatus: async (runId, status) => {
      const { error } = await supabase.from("import_runs").update({ status }).eq("id", runId);
      if (error) throw new Error(`Failed to set run status: ${error.message}`);
    },
    batchUpdateDeals: async (updates) => {
      await hubspot.batchUpdateDeals(updates);
    },
    upsertCompany: (domain, properties) => hubspot.upsertCompany(domain, properties),
    upsertContact: (email, properties) => hubspot.upsertContact(email, properties),
    upsertDeal: (bbId, properties) => hubspot.upsertDeal(bbId, properties),
    createAssociation: (fromType, fromId, toType, toId) =>
      hubspot.createAssociation(fromType, fromId, toType, toId),
    updateRowResult: async (rowId, patch) => {
      const { error } = await supabase.from("deal_rows").update(patch).eq("id", rowId);
      if (error) throw new Error(`Failed to update deal_row ${rowId}: ${error.message}`);
    },
    finalizeRun: async (runId, patch) => {
      const { error } = await supabase.from("import_runs").update(patch).eq("id", runId);
      if (error) throw new Error(`Failed to finalize import_run: ${error.message}`);
    },
  };

  try {
    const result = await runImport(deps, {
      importRunId,
      pipelineIds: config.blackbaudPipelines,
      reviewerEmail: body.reviewedByEmail ? String(body.reviewedByEmail) : undefined,
      importedAt: now,
      reviewedAt: now,
    });
    return json(result, 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
});
