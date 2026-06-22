// HTTP entrypoint for the `ingest` Edge Function. Wires the real Supabase
// service-role client into runIngest. All Storage + DB access happens here.

import { createClient } from "@supabase/supabase-js";
import { getConfig } from "../_shared/env.ts";
import { errorMessage, handleOptions, json } from "../_shared/http.ts";
import { type DealRowInsert, type IngestDeps, type NewImportRun, runIngest } from "./ingest.ts";

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

  let config;
  try {
    config = getConfig();
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const deps: IngestDeps = {
    downloadCsv: async (path) => {
      const { data, error } = await supabase.storage.from(config.bucket).download(path);
      if (error || !data) {
        throw new Error(`Could not download '${path}': ${error?.message ?? "not found"}`);
      }
      return await data.text();
    },
    createRun: async (run: NewImportRun) => {
      const { data, error } = await supabase
        .from("import_runs")
        .insert(run)
        .select("id")
        .single();
      if (error || !data) throw new Error(`Failed to create import_run: ${error?.message}`);
      return data.id as string;
    },
    insertRows: async (rows: DealRowInsert[]) => {
      const { error } = await supabase.from("deal_rows").insert(rows);
      if (error) throw new Error(`Failed to insert deal_rows: ${error.message}`);
    },
    updateRun: async (id, patch) => {
      const { error } = await supabase.from("import_runs").update(patch).eq("id", id);
      if (error) throw new Error(`Failed to update import_run: ${error.message}`);
    },
  };

  try {
    const result = await runIngest(deps, {
      path: String(body.path ?? ""),
      filename: body.filename ? String(body.filename) : undefined,
      uploadedByEmail: body.uploadedByEmail ? String(body.uploadedByEmail) : undefined,
      sourceLabel: body.sourceLabel ? String(body.sourceLabel) : undefined,
      uploadedAt: new Date().toISOString(),
    });
    return json(result, 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
});
