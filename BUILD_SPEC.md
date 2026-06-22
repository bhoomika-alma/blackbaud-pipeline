# BUILD_SPEC — "Blackbaud → HubSpot CSV import tool"

The loop/goal reads this file every iteration. It holds the full PROJECT SPEC,
DB SCHEMA, and BUILD PLAN. (The goal text holds only the stop condition, the
iteration protocol, the git rules, and the hard rules.)

---

## PROJECT SPEC (build in these phases; each step explained)

### PHASE A — Upload & parse
- Screen 1: user uploads a Blackbaud pipeline CSV → store in Supabase Storage bucket `bb-uploads`.
- Parse rows and validate the expected Blackbaud columns are present.

### PHASE B — Clean each row (store both raw + cleaned)
- Website → domain: lowercase/trim; strip `http(s)://`; strip `www.`; cut everything after the first `/`; strip port (`:443`). If host has 3+ labels and isn't a 2-part ccTLD (.ac.uk/.co.uk/.org.uk/.ab.ca), strip the leading sub-label BUT set `domain_flagged=true`. Example: `https://www.uwindsor.ca/` → `uwindsor.ca`.
- Split Contact Name → First / Last (first token = first_name, remainder = last_name).
- Demonstrate Stage Date: IF stage ∈ {Demonstrate, Propose, Negotiate} → = Last Stage Change Date; ELSE blank.
- Derive Pipeline: England → "Blackbaud England"; Canada → "Blackbaud Canada"; US (and LatAm→US) → Vertical=K12 → "Blackbaud k12 pipeline", else → "Blackbaud HigherEd pipeline".
- Build Deal Name = Account Name + " - " + derived Pipeline.

### PHASE C — Classify each row
- Search HubSpot deals by `unique_bb_id` (batch ≤100).
- FOUND? Yes → in a Blackbaud pipeline (16363685=HigherEd, 23038595=k12, 36496197=Canada, 36528146=England)? Yes → EXISTING (Update); No → INTERNAL (Skip).
- FOUND? No → Stage ∈ {Demonstrate, Propose, Negotiate}? No (Discover/Engage) → HOLD. Yes → Search by Deal Name (exact): 0 → NEW (Create); 1 → REVIEW (confirm existing); 2+ → REVIEW (ambiguous).
- Persist classification, matched_by, hs_deal_id, matched_pipeline, match_count; roll up new_count/existing_count/review_count + edge_cases on import_runs.

### PHASE D — Results dashboard (Screen 2)
- Show per-bucket counts. "Approved?" → no edge cases / user approves → proceed to import; else → Screen 3.

### PHASE E — Review edge cases (Screen 3), handle each:
1. NEW deal → fill / confirm the ARR amount.
2. 1 deal-name match, no BBID → confirm with user.
3. 2+ deal-name matches, no BBID → confirm with user.
4. Duplicate deal for same company (2 BBIDs) → confirm.
5. ABM-vs-Blackbaud source conflict → confirm.
6. Company already won/onboarding/in CS but Blackbaud lists it open → confirm (usually skip).
7. Data-quality flag → suspect domain not matching the account (e.g. `broward.org` → Broward County Government, not Broward College) → fix domain.
- Reviewer edits arr_final/domain_final, sets review_decision, approves.

### PHASE F — Build files & import (Screen 4)
- NEW-create (25 cols, Company+Contact+Deal, INCLUDE ARR): upsert company (dedup by domain) + contact (dedup by email) + deal (by unique_bb_id) + v4 associations.
- EXISTING-update (16 cols, match on unique_bb_id, NO amount, deal_name+pipeline = don't-overwrite): deals/batch/update with idProperty=unique_bb_id.
- Write per-row import_action + result ids/errors.

### PHASE G — Post-import & summary (Screen 5)
- Post-import duplicate-company check (same domain → multiple companies) → flag for merge.
- Write import_runs.summary (counts, errors, edge cases); show the report.

---

## DB SCHEMA (one SQL migration; two tables)

**import_runs**: id PK, filename, source_label, uploaded_by_email, uploaded_at, status(enum), row_count, new_count, existing_count, review_count, review_status(enum), reviewed_by_email, reviewed_at, approved_count, skipped_count, review_notes, edge_cases(jsonb), summary(jsonb), created_at, updated_at.

**deal_rows**: id PK, import_run_id FK→import_runs, filename, row_number, raw_data(jsonb), bb_id, account_name, stage, region, vertical, arr_raw, created_date, close_date, last_stage_change_date, website_raw, contact_email, domain, domain_flagged(bool), first_name, last_name, demonstrate_stage_date, derived_pipeline, deal_name, classification(enum), matched_by(enum), hs_deal_id, matched_pipeline, match_count, review_decision(enum), arr_final, domain_final, linked_hs_deal_id, import_action(enum), result_hs_deal_id, result_hs_company_id, result_hs_contact_id, import_error, imported_at, created_at, updated_at.

Indexes: bb_id, deal_name, import_run_id.

---

## BUILD PLAN (each line → one PROGRESS.md task, in order)

### Phase 0 — Scaffold
- Repo layout `/frontend` + `/supabase`; root README; root `.env.example` + `frontend/.env.example` documenting every variable with a description.
- Init `/frontend` (Vite + React + TS) + Supabase JS client + router for the 5 screens.
- Init `/supabase` (config.toml, functions/, migrations/).

### Phase 1 — Database & storage
- SQL migration: enums + import_runs + deal_rows (per schema) + FK + indexes.
- Create private Storage bucket `bb-uploads`.

### Phase 2 — Shared backend modules
- Env/config loader (validate required vars; clear errors).
- Cleaning module (cleanDomain, splitName, demonstrateStageDate, derivePipeline, buildDealName) + BB_PIPELINES constant. Unit-tested.
- HubSpot client (searchDealsByBbid batch, searchDealsByName, batchUpdateDeals idProperty=unique_bb_id, upsertCompany/Contact/Deal, createAssociations). Mockable.

### Phase 3 — Edge Functions
- `ingest`: CSV from Storage → parse → create import_run → insert cleaned deal_rows.
- `classify`: Phase C per row → write classification → roll up counts + edge_cases.
- `import`: approved rows → EXISTING updates + NEW creates → results → post-import dup-company check → summary.

### Phase 4 — Frontend
- Screen 1 Upload (→ Storage → trigger ingest+classify).
- Screen 2 Results dashboard + Approved? gate.
- Screen 3 Review (the 7 edge cases; edit ARR/domain; decisions; approve).
- Screens 4+5 Import + Summary.

### Phase 5 — Wire-up & verify
- Sample CSV fixture; unit tests for cleaning + classification with mocked HTTP; typecheck/build both apps.
- Finalize README (setup, where to put secrets) + both `.env.example` files.
