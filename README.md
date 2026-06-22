# Blackbaud → HubSpot CSV import tool

A web app that ingests a Blackbaud pipeline CSV, cleans and classifies every row,
lets a reviewer resolve edge cases, then imports the result into HubSpot
(create new deals / update existing) via the HubSpot API.

## Architecture

```
.
├── frontend/      React + Vite + TypeScript SPA — the 5 screens (Upload → Results → Review → Import → Summary)
├── supabase/      Supabase backend: Postgres migrations + Edge Functions (Deno + TS)
│   ├── functions/   ingest · classify · import  (all HubSpot calls happen here)
│   └── migrations/  SQL schema (import_runs, deal_rows)
├── .env.example          backend env template (Edge Functions)
└── frontend/.env.example frontend env template (Vite)
```

**Strict split:** the frontend NEVER calls HubSpot directly. It uploads CSVs to
Supabase Storage and invokes Edge Functions; only the Edge Functions talk to
HubSpot (direct batch API, matched on `unique_bb_id`).

**No auth:** there is no login. The uploader/reviewer email is captured as plain
text and stored on the import run.

## The flow (5 screens)

1. **Upload** — pick a Blackbaud CSV → stored in Storage bucket `bb-uploads` → `ingest` parses + cleans rows.
2. **Results** — per-bucket counts (NEW / EXISTING / REVIEW / HOLD / INTERNAL); approve or go to Review.
3. **Review** — resolve the 7 edge-case types; edit ARR / domain; set decisions; approve.
4. **Import** — build the create/update payloads and push to HubSpot.
5. **Summary** — post-import duplicate-company check + final report.

## Setup

### Prerequisites
- Node.js 18+ (frontend)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (backend / migrations / functions)
- A Supabase project and a HubSpot private-app token

### Where secrets go
All configuration is via **environment variables** — nothing is hardcoded.

- **Backend** (Edge Functions): copy `.env.example` → `.env` at the repo root and fill it in.
  In production set the same vars as Supabase function secrets:
  `supabase secrets set --env-file ./.env`.
- **Frontend**: copy `frontend/.env.example` → `frontend/.env`. Only `VITE_`-prefixed
  vars are exposed to the browser — **never** put the service-role key or HubSpot
  token here.

Each `.env.example` documents every variable and where to find its value. Code
reads these vars and throws a clear error at startup if a required one is missing.

### Run locally
```bash
# Frontend
cd frontend && npm install && npm run dev

# Backend (separate terminal)
supabase start                      # local Postgres + functions
supabase db reset                   # apply migrations
supabase functions serve            # serve ingest / classify / import
```

## Verification
Both apps are typechecked, built, and linted; unit tests cover the cleaning and
classification logic with **mocked** HTTP. No live HubSpot/Supabase calls are made
during the build — add real credentials when you deploy.

See `BUILD_SPEC.md` for the full spec, DB schema, and build plan, and `PROGRESS.md`
for current status.
