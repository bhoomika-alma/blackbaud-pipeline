STATUS: IN_PROGRESS

# Build progress — Blackbaud → HubSpot CSV import tool

Tasks are taken top-to-bottom, one per iteration. See `BUILD_SPEC.md` for the full spec.

## Phase 0 — Scaffold
- [x] Repo layout `/frontend` + `/supabase`; root README; root `.env.example` + `frontend/.env.example` documenting every variable with a description. — created dirs (.gitkeep), root README (architecture/setup/secrets), root `.env.example` (SUPABASE_URL, SERVICE_ROLE_KEY, HUBSPOT_TOKEN, bucket, 4 pipeline IDs), `frontend/.env.example` (VITE_* only).
- [x] Init `/frontend` (Vite + React + TS) + Supabase JS client + router for the 5 screens. — Vite 5 + React 18 + TS scaffold (manual, eslint flat config), `src/lib/env.ts` (throws on missing VITE_ vars) + `src/lib/supabase.ts` client, react-router with routes for all 5 screens. typecheck+lint+build all clean.
- [x] Init `/supabase` (config.toml, functions/, migrations/). — `config.toml` (api/db/storage, auth disabled, private `bb-uploads` bucket, edge_runtime), `functions/deno.json` (imports map for std + supabase-js, lint/fmt/test tasks), empty `migrations/`. config.toml parses as valid TOML; `deno fmt --check` clean. (deno lint reports "no targets" until functions exist in Phase 3.)

## Phase 1 — Database & storage
- [x] SQL migration: enums + import_runs + deal_rows (per schema) + FK + indexes. — `20260622000000_init_schema.sql`: 6 enums (import_status, review_status, deal_classification, matched_by, review_decision, import_action), both tables with all spec columns, FK deal_rows→import_runs (on delete cascade), 3 indexes (bb_id, deal_name, import_run_id), updated_at trigger. RLS left disabled (no-auth design, documented). DDL parse-validated with pgsql-ast-parser.
- [x] Create private Storage bucket `bb-uploads`. — declared in config.toml (local) + idempotent migration `20260622000100_storage_bucket.sql` (insert into storage.buckets, public=false) with anon insert/select policies for the no-auth upload flow. Insert stmt parse-validated; policy syntax hand-verified (standard PG RLS).

## Phase 2 — Shared backend modules
- [x] Env/config loader (validate required vars; clear errors). — `functions/_shared/env.ts`: `getConfig()` validates SUPABASE_URL/SERVICE_ROLE_KEY/HUBSPOT_TOKEN (throws clear error if missing), optional bucket + 4 pipeline IDs with defaults, `blackbaudPipelineIds()` helper. 4 unit tests (env.test.ts). deno check/lint/fmt/test all clean.
- [x] Cleaning module (cleanDomain, splitName, demonstrateStageDate, derivePipeline, buildDealName) + BB_PIPELINES constant. Unit-tested. — `functions/_shared/clean.ts`: Phase B rules incl. subdomain strip+flag with 2-part ccTLD exceptions, ACTIVE_STAGES + pipelineKeyForName helpers. 14 unit tests (clean.test.ts) covering all rules + edge cases; 18 backend tests pass total. deno check/lint/fmt/test clean.
- [x] HubSpot client (searchDealsByBbid batch, searchDealsByName, batchUpdateDeals idProperty=unique_bb_id, upsertCompany/Contact/Deal, createAssociations). Mockable. — `functions/_shared/hubspot.ts`: HubSpotClient with injectable fetch (mockable), bearer auth, batch search by unique_bb_id (≤100 + paging), name search, batch/update with idProperty, upserts deduped by domain/email/unique_bb_id, v4 default associations. 10 unit tests with mocked HTTP (28 backend tests total). deno check/lint/fmt/test clean.

## Phase 3 — Edge Functions
- [x] `ingest`: CSV from Storage → parse → create import_run → insert cleaned deal_rows. — `functions/ingest/{ingest.ts,index.ts}` + shared `csv.ts` (std parser), `blackbaud.ts` (column alias mapping + validateColumns + buildCleanedRow + normalizeDate), `http.ts` (CORS/json). runIngest is DI'd for testing; index.ts wires service-role Supabase client + Deno.serve. Registered [functions.ingest] in config.toml; switched supabase-js import to npm:. 15 new tests; 43 backend tests pass. deno check (incl. supabase-js)/lint/fmt clean.
- [x] `classify`: Phase C per row → write classification → roll up counts + edge_cases. — `functions/classify/{classify.ts,index.ts}`: pure `classifyRow` (bbid→EXISTING/INTERNAL by pipeline; no-bbid→HOLD or name-search NEW/REVIEW), DI'd `runClassify` (batch bbid search, name-search cache, per-row updates, rollup new/existing/review + edge_cases jsonb incl. dup-bbid/ARR/domain-flag). Registered [functions.classify]. 11 new tests; 54 backend tests pass. deno check/lint/fmt clean.
- [x] `import`: approved rows → EXISTING updates + NEW creates → results → post-import dup-company check → summary. — `functions/import/{import.ts,index.ts}`: pure resolveImportAction + payload builders (create INCLUDES amount; update OMITS amount/dealname/pipeline), DI'd runImport (batch update by unique_bb_id; create company-by-domain + contact-by-email + deal + 2 v4 associations; per-row results; dup-company check; summary jsonb + completed status). Registered [functions.import]. 10 new tests; 64 backend tests pass. deno check/lint/fmt clean.

## Phase 4 — Frontend
- [x] Screen 1 Upload (→ Storage → trigger ingest+classify). — `frontend/src/lib/{api.ts,types.ts}` (Storage upload + Edge Function invoke via anon key; shared run/row types) + `UploadPage.tsx`: email (no-auth, prefilled from localStorage) + source label + CSV → upload to bb-uploads → ingest → classify → navigate to /results/:runId, with per-phase status + error handling. typecheck/lint/build clean.
- [x] Screen 2 Results dashboard + Approved? gate. — `ResultsPage.tsx`: loads run + rows (added `getRun`/`getRows`/review-update helpers to api.ts), per-bucket count cards (new/existing/review/hold/internal + total), and the Approved? gate — edge cases → Review (with skip-anyway), none → Approve & import. typecheck/lint/build clean.
- [x] Screen 3 Review (the 7 edge cases; edit ARR/domain; decisions; approve). — `ReviewPage.tsx`: loads run edge_cases, one editable card per affected row (labels for all 7 categories, decision select approve/confirm/skip/reject, ARR + domain inputs with sensible defaults), reviewer email + notes; on approve persists each row's review fields (incl. linked_hs_deal_id on confirm) + run review_status, then routes to import. typecheck/lint/build clean.
- [x] Screens 4+5 Import + Summary. — `ImportPage.tsx`: shows to-create/to-update/reviewed counts, triggers the import edge function (guards already-completed runs), routes to summary. `SummaryPage.tsx`: created/updated/skipped/errors cards, duplicate-company merge flags, error list, per-row results table (action + HubSpot deal id + error), link to start a new import. typecheck/lint/build clean.

## Phase 5 — Wire-up & verify
- [ ] Sample CSV fixture; unit tests for cleaning + classification with mocked HTTP; typecheck/build both apps.
- [ ] Finalize README (setup, where to put secrets) + both `.env.example` files.

## Notes
- (iteration 1) Bootstrap: git init, remote set to work alias, `.gitignore` + `PROGRESS.md` created.
