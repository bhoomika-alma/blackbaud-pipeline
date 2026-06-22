STATUS: IN_PROGRESS

# Build progress — Blackbaud → HubSpot CSV import tool

Tasks are taken top-to-bottom, one per iteration. See `BUILD_SPEC.md` for the full spec.

## Phase 0 — Scaffold
- [x] Repo layout `/frontend` + `/supabase`; root README; root `.env.example` + `frontend/.env.example` documenting every variable with a description. — created dirs (.gitkeep), root README (architecture/setup/secrets), root `.env.example` (SUPABASE_URL, SERVICE_ROLE_KEY, HUBSPOT_TOKEN, bucket, 4 pipeline IDs), `frontend/.env.example` (VITE_* only).
- [x] Init `/frontend` (Vite + React + TS) + Supabase JS client + router for the 5 screens. — Vite 5 + React 18 + TS scaffold (manual, eslint flat config), `src/lib/env.ts` (throws on missing VITE_ vars) + `src/lib/supabase.ts` client, react-router with routes for all 5 screens. typecheck+lint+build all clean.
- [x] Init `/supabase` (config.toml, functions/, migrations/). — `config.toml` (api/db/storage, auth disabled, private `bb-uploads` bucket, edge_runtime), `functions/deno.json` (imports map for std + supabase-js, lint/fmt/test tasks), empty `migrations/`. config.toml parses as valid TOML; `deno fmt --check` clean. (deno lint reports "no targets" until functions exist in Phase 3.)

## Phase 1 — Database & storage
- [x] SQL migration: enums + import_runs + deal_rows (per schema) + FK + indexes. — `20260622000000_init_schema.sql`: 6 enums (import_status, review_status, deal_classification, matched_by, review_decision, import_action), both tables with all spec columns, FK deal_rows→import_runs (on delete cascade), 3 indexes (bb_id, deal_name, import_run_id), updated_at trigger. RLS left disabled (no-auth design, documented). DDL parse-validated with pgsql-ast-parser.
- [ ] Create private Storage bucket `bb-uploads`.

## Phase 2 — Shared backend modules
- [ ] Env/config loader (validate required vars; clear errors).
- [ ] Cleaning module (cleanDomain, splitName, demonstrateStageDate, derivePipeline, buildDealName) + BB_PIPELINES constant. Unit-tested.
- [ ] HubSpot client (searchDealsByBbid batch, searchDealsByName, batchUpdateDeals idProperty=unique_bb_id, upsertCompany/Contact/Deal, createAssociations). Mockable.

## Phase 3 — Edge Functions
- [ ] `ingest`: CSV from Storage → parse → create import_run → insert cleaned deal_rows.
- [ ] `classify`: Phase C per row → write classification → roll up counts + edge_cases.
- [ ] `import`: approved rows → EXISTING updates + NEW creates → results → post-import dup-company check → summary.

## Phase 4 — Frontend
- [ ] Screen 1 Upload (→ Storage → trigger ingest+classify).
- [ ] Screen 2 Results dashboard + Approved? gate.
- [ ] Screen 3 Review (the 7 edge cases; edit ARR/domain; decisions; approve).
- [ ] Screens 4+5 Import + Summary.

## Phase 5 — Wire-up & verify
- [ ] Sample CSV fixture; unit tests for cleaning + classification with mocked HTTP; typecheck/build both apps.
- [ ] Finalize README (setup, where to put secrets) + both `.env.example` files.

## Notes
- (iteration 1) Bootstrap: git init, remote set to work alias, `.gitignore` + `PROGRESS.md` created.
