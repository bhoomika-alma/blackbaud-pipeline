STATUS: IN_PROGRESS

# Build progress — Blackbaud → HubSpot CSV import tool

Tasks are taken top-to-bottom, one per iteration. See `BUILD_SPEC.md` for the full spec.

## Phase 0 — Scaffold
- [ ] Repo layout `/frontend` + `/supabase`; root README; root `.env.example` + `frontend/.env.example` documenting every variable with a description.
- [ ] Init `/frontend` (Vite + React + TS) + Supabase JS client + router for the 5 screens.
- [ ] Init `/supabase` (config.toml, functions/, migrations/).

## Phase 1 — Database & storage
- [ ] SQL migration: enums + import_runs + deal_rows (per schema) + FK + indexes.
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
