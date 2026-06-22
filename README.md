# Blackbaud → HubSpot CSV import tool

A web app that ingests a Blackbaud pipeline CSV, cleans and classifies every row,
lets a reviewer resolve edge cases, then imports the result into HubSpot
(create new deals / update existing) via the HubSpot API.

## Architecture

```
.
├── frontend/      React + Vite + TypeScript SPA — the 5 screens (Upload → Results → Review → Import → Summary)
├── supabase/      Supabase backend
│   ├── functions/   Edge Functions (Deno + TS): ingest · classify · import  (all HubSpot calls happen here)
│   │   ├── _shared/   env, cleaning, HubSpot client, CSV/column parsing, HTTP helpers
│   │   └── _fixtures/ sample_blackbaud.csv (test fixture / example upload)
│   └── migrations/  SQL schema (import_runs, deal_rows) + private bb-uploads bucket
├── .env.example          backend env template (Edge Functions)
└── frontend/.env.example frontend env template (Vite)
```

**Strict split:** the frontend NEVER calls HubSpot directly. It uploads CSVs to
Supabase Storage and invokes Edge Functions; only the Edge Functions talk to
HubSpot (direct batch API, matched on `unique_bb_id`).

**No auth:** there is no login. The uploader/reviewer email is captured as plain
text and stored on the import run. RLS is intentionally disabled on the two tables
(see the schema migration); the browser reads/writes via the anon key and the
functions write via the service-role key.

## The flow (5 screens)

1. **Upload** — pick a Blackbaud CSV → stored in Storage bucket `bb-uploads` → `ingest` parses + cleans rows, then `classify` runs.
2. **Results** — per-bucket counts (NEW / EXISTING / REVIEW / HOLD / INTERNAL); the *Approved?* gate routes to Review (if edge cases) or Import.
3. **Review** — resolve the 7 edge-case types; edit ARR / domain; set per-row decisions; approve.
4. **Import** — build the create/update payloads and push to HubSpot (creates company+contact+deal+associations for NEW; batch-updates EXISTING by `unique_bb_id`).
5. **Summary** — created/updated/skipped counts, errors, and the post-import duplicate-company check.

### How rows are classified (Phase C)

- Deal found in HubSpot by `unique_bb_id`?
  - **Yes**, and it's in a Blackbaud pipeline → **EXISTING** (update). Otherwise → **INTERNAL** (skip).
  - **No**, and stage ∉ {Demonstrate, Propose, Negotiate} → **HOLD**. Otherwise search by exact deal name:
    0 matches → **NEW** (create); 1 → **REVIEW** (confirm); 2+ → **REVIEW** (ambiguous).

### The 7 review edge cases (Phase E)

1. NEW deal → confirm the ARR amount. 2. One deal-name match, no BB ID → confirm.
3. Two+ deal-name matches → confirm. 4. Duplicate deal for the same BB ID.
5. ABM-vs-Blackbaud source conflict. 6. Already won/onboarding/in CS. 7. Suspect domain → fix.

## Data model

Two tables (see [supabase/migrations](supabase/migrations)):
- **import_runs** — one row per uploaded file: status, per-bucket counts, review status, `edge_cases` + `summary` (jsonb).
- **deal_rows** — one row per CSV line: raw + cleaned fields, classification + match info, review decision, and import results. Indexed on `bb_id`, `deal_name`, `import_run_id`.

## Setup

### Prerequisites
- Node.js 18+ (frontend)
- [Supabase CLI](https://supabase.com/docs/guides/cli) + [Deno](https://deno.com/) (backend / functions / tests)
- A Supabase project and a HubSpot private-app token

### Where secrets go
All configuration is via **environment variables** — nothing is hardcoded.

- **Backend** (Edge Functions): copy `.env.example` → `.env` at the repo root and fill it in.
  For deployed functions set the same vars as Supabase secrets:
  `supabase secrets set --env-file ./.env`.
- **Frontend**: copy `frontend/.env.example` → `frontend/.env`. Only `VITE_`-prefixed
  vars are exposed to the browser — **never** put the service-role key or HubSpot
  token here.

Each `.env.example` documents every variable and where to find its value. Code
reads these vars and throws a clear error at startup if a required one is missing.

Required backend vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HUBSPOT_TOKEN`
(optional: `BB_UPLOADS_BUCKET`, `HUBSPOT_PIPELINE_{HIGHERED,K12,CANADA,ENGLAND}`).
Required frontend vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
(optional: `VITE_BB_UPLOADS_BUCKET`, `VITE_FUNCTIONS_URL`).

### Run locally
```bash
# Frontend
cd frontend && npm install && npm run dev

# Backend (separate terminal)
supabase start                      # local Postgres + Storage + functions
supabase db reset                   # apply migrations (schema + bb-uploads bucket)
supabase functions serve            # serve ingest / classify / import
```

### Deploy
```bash
supabase db push                            # apply migrations to the linked project
supabase secrets set --env-file ./.env      # push backend env to function secrets
supabase functions deploy ingest classify import
cd frontend && npm run build                # static SPA in frontend/dist
```

Try it with the sample file at
[`supabase/functions/_fixtures/sample_blackbaud.csv`](supabase/functions/_fixtures/sample_blackbaud.csv).

## Tests & verification

```bash
# Backend (Deno) — unit tests use MOCKED HTTP; no live calls
cd supabase/functions && deno task test       # or: deno test --allow-env --allow-read
deno task check && deno lint && deno fmt --check

# Frontend
cd frontend && npm run typecheck && npm run lint && npm run build
```

Unit tests cover the cleaning, classification, and import logic plus the HubSpot
client (with a mocked `fetch`). No live HubSpot/Supabase calls are made during the
build — add real credentials when you deploy.

See `BUILD_SPEC.md` for the full spec, DB schema, and build plan, and `PROGRESS.md`
for build status.
