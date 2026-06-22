// Backend (Edge Functions) configuration loader.
//
// All config comes from environment variables — nothing is hardcoded. Required
// vars throw a clear error if missing; optional vars fall back to documented
// defaults. See `.env.example` at the repo root for the full list.

export interface BackendConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  hubspotToken: string;
  bucket: string;
  /** HubSpot pipeline IDs for the four Blackbaud pipelines. */
  blackbaudPipelines: {
    highered: string;
    k12: string;
    canada: string;
    england: string;
  };
}

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in your function secrets or .env (see .env.example at the repo root).`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = Deno.env.get(name)?.trim();
  return value && value.length > 0 ? value : fallback;
}

/** Read and validate the backend configuration. Throws if a required var is missing. */
export function getConfig(): BackendConfig {
  return {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    hubspotToken: required("HUBSPOT_TOKEN"),
    bucket: optional("BB_UPLOADS_BUCKET", "bb-uploads"),
    blackbaudPipelines: {
      highered: optional("HUBSPOT_PIPELINE_HIGHERED", "16363685"),
      k12: optional("HUBSPOT_PIPELINE_K12", "23038595"),
      canada: optional("HUBSPOT_PIPELINE_CANADA", "36496197"),
      england: optional("HUBSPOT_PIPELINE_ENGLAND", "36528146"),
    },
  };
}

/** The set of HubSpot pipeline IDs that count as "Blackbaud" pipelines (Phase C). */
export function blackbaudPipelineIds(config: BackendConfig): Set<string> {
  const p = config.blackbaudPipelines;
  return new Set([p.highered, p.k12, p.canada, p.england]);
}
