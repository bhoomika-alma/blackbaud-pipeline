# BUILD_SPEC — "Blackbaud → HubSpot CSV import tool"

The loop/goal reads this file every iteration. It is the single source of truth:
full context, input format, HubSpot reference, the per-phase flow, the import
column maps, the post-import procedure, the rules/edge-knowledge, the DB schema,
and the build plan. Nothing here is optional.

---

## 0. OVERVIEW & CONTEXT

Blackbaud (BB) is a reseller/partner. Periodically they send a CSV export of their
open opportunities. This tool lets a user upload that CSV, cleans + classifies each
row against our HubSpot, lets a human resolve edge cases, then updates existing deals
and creates new ones in HubSpot.

Key facts about the feed (verified against real exports):
- **Open opportunities only.** Blackbaud no longer sends Closed Won / Closed Lost → there is **no closed-deal filtering step**. Stages seen: `Discover & Access`, `Engage`, `Demonstrate`, `Propose`, `Negotiate`.
- **All amounts arrive in USD** already (ARR field). No currency conversion. (Historically CAD/GBP were excluded; not needed now.)
- Aakash/Maaz manually confirm/fill the **ARR amount** for new deals before import.
- **~5–10% error is accepted** — Blackbaud doesn't share everything, and sometimes creates two deals for one company. We minimize, not eliminate, duplicates.

---

## 1. INPUT — the Blackbaud CSV

Raw columns expected (validate these exist; keep the full original row in `raw_data` jsonb):
`Opportunity ID, Account Name, Opportunity Name, Close Date, Opportunity Owner, Opportunity Owner: Manager, Annual Recurring Amount (converted) Currency, Annual Recurring Amount (converted), Created Date, Forecast Category, Stage, Vertical, Type, Website, Opportunity Sourced Contact, Contact: Email, Contact: Title, Region, Competitor, Incumbent, Next Step, Next Steps & Progress Summary, Notes for Rep, Next Steps History (Progress Summary), Description, Opportunity Source, Last Stage Change Date, Products Owned, Opportunity Owner Email, Age, Last Activity, Days Since Last Activity, Stage Duration, Opportunity Owner Team, STATUS`

`Opportunity ID` is the **BBID** — the unique Blackbaud opportunity id, our primary key.

---

## 2. HUBSPOT REFERENCE

### 2.1 The match key
- Deal property **`unique_bb_id`** stores the BBID. It is configured as a **unique-identifier property** (shows the key icon / "can be used to find existing records and update them") → we can match imports/updates directly on `unique_bb_id`, no Record ID needed.
- In a real coverage test, **92.5% of BBIDs resolved to exactly one deal with zero duplicates** → BBID is a reliable 1:1 key.
- **Fallback = Deal Name** (when no BBID match). Deal Name is more reliable than Company Name (deal-name worst-case ~5 duplicates vs company-name 12+ duplicate records). Company Name is NOT used as a key.

### 2.2 Pipelines (HubSpot `pipeline` property id → label)
**Blackbaud pipelines → a deal found here = EXISTING (update):**
- `16363685` = Blackbaud HigherEd pipeline
- `23038595` = Blackbaud k12 pipeline
- `36496197` = Blackbaud Canada
- `36528146` = Blackbaud England

**Any OTHER pipeline → INTERNAL (skip; AEs own it):** Inbound Sales Pipeline (`ff92e552-3a15-49a1-a0ee-05bcb0ff5cdc`), Outbound Sales Pipeline (`25df29cb-acf9-4f92-8611-44348ee3d344`), ABM Awareness Funnel (`772437910`), Up-sell (`1297253`), Cross-Sell (`1297283`), and all `CS:` pipelines (Renewal, Customer Onboarding, Risk Management, Professional Services, etc.).
> Trust the `pipeline` field, NOT the deal name — names drift (an internal deal can still be named "X - Blackbaud HigherEd pipeline").

Keep these as a `BB_PIPELINES` constant in code (small + stable; no pipelines table).

### 2.3 Dedup keys for NEW deals
- Deal ← `unique_bb_id` · Company ← `domain` · Contact ← `email`. HubSpot won't duplicate a company/contact that already exists by domain/email — it associates.

### 2.4 API (direct batch approach; ≤100 records/call; Private App Bearer token)
- Lookup/classify: `POST /crm/v3/objects/deals/search` (filter `unique_bb_id IN [...]`; and `dealname` for the fallback).
- Existing update: `POST /crm/v3/objects/deals/batch/update` with `idProperty=unique_bb_id`.
- New create: `POST /crm/v3/objects/companies/batch/upsert` (idProperty=domain) → `.../contacts/batch/upsert` (idProperty=email) → `.../deals/batch/upsert` (idProperty=unique_bb_id) → `POST /crm/v4/associations/deals/companies/batch/create` + `.../deals/contacts/batch/create`.
- Scopes: `crm.objects.deals.write`, `crm.objects.companies.write`, `crm.objects.contacts.write`.

---

## 3. PER-PHASE FLOW

### PHASE A — Upload & parse (Screen 1)
- User uploads a Blackbaud CSV → store in Supabase Storage bucket `bb-uploads`.
- Capture `uploaded_by_email`. Parse rows; validate the expected columns (§1) are present. Create an `import_runs` row; insert one `deal_rows` row per CSV line with the full row in `raw_data`.

### PHASE B — Clean each row (store raw + cleaned)
- **Website → domain:** lowercase/trim; strip `http(s)://`; strip `www.`; cut everything after the first `/`; strip port (`:443`). If the host has 3+ labels and isn't a 2-part ccTLD (`.ac.uk/.co.uk/.org.uk/.ab.ca`), strip the leading sub-label BUT set `domain_flagged=true` for review. Example: `https://www.uwindsor.ca/` → `uwindsor.ca`.
- **Split Contact Name** (`Opportunity Sourced Contact`) → first token = `first_name`, remainder = `last_name`. If blank, fall back to parsing `Contact: Email`.
- **Demonstrate Stage Date:** IF `Stage` ∈ {Demonstrate, Propose, Negotiate} → `demonstrate_stage_date = Last Stage Change Date`; ELSE blank. (This is the **effective "created" date** — when AEs get involved.)
- **Derive Pipeline:** Region=England → "Blackbaud England"; Region=Canada → "Blackbaud Canada"; Region=US (and LatAm→US) → Vertical=K12 → "Blackbaud k12 pipeline", else → "Blackbaud HigherEd pipeline".
- **Build Deal Name** = `Account Name + " - " + derived Pipeline`.

### PHASE C — Classify each row
- Search HubSpot deals by `unique_bb_id` (batched).
- **FOUND?**
  - **Yes** →
    - **exactly 1 deal** → is it in a Blackbaud pipeline (§2.2)? **Yes → EXISTING (Update).** **No → INTERNAL (Skip).**
    - **2+ deals share the BBID** → **REVIEW** (duplicate deal for the same BBID — edge case 4).
  - **No** → Search by **Deal Name (exact)**: `0` → **NEW (Create)**; `1` → **REVIEW (confirm existing)**; `2+` → **REVIEW (ambiguous)**.
    - **No stage gate:** a deal not found by BBID is a NEW candidate regardless of stage (Discover & Access / Engage included), so **HOLD** is no longer produced. Stage still drives the Demonstrate Stage Date in Phase B.
- Persist `classification`, `matched_by`, `hs_deal_id`, `matched_pipeline`, `match_count`. Roll up `new_count` / `existing_count` / `review_count` + `edge_cases` onto `import_runs`.

### PHASE D — Results dashboard (Screen 2)
- Show per-bucket counts (new / existing / internal / hold / review). **Approved?** → if no edge cases / user approves → proceed to import; else → Screen 3.

### PHASE E — Review edge cases (Screen 3) — handle each:
1. **NEW deal** → fill / confirm the ARR amount (most common).
2. **1 deal-name match, no BBID** → confirm with user; if same deal, treat as existing (and backfill the BBID onto it).
3. **2+ deal-name matches, no BBID** → confirm with user (pick which, or create new) using created date / amount.
4. **Duplicate deal for the same BBID** → the BBID resolves to 2+ HubSpot deals (flagged at classify time) → confirm which is canonical. (Also covers Blackbaud sending two BBIDs for one company — usually import both for hygiene.)
5. **ABM-vs-Blackbaud source conflict** → confirm source/commission, and whether we even need the BB copy.
6. **Already a customer** (won / onboarding / in a CS pipeline) but Blackbaud lists it open → confirm (usually skip).
7. **Data-quality flag** → suspect domain not matching the account (e.g. `broward.org` → Broward County Government, not Broward College) → fix the domain.
- Reviewer edits `arr_final` / `domain_final`, sets `review_decision`, approves.

### PHASE F — Build files & import (Screen 4)
See the exact column maps in §4. Two outputs:
- **EXISTING-update** (16 cols, Deal only, match on `unique_bb_id`, **no amount**, `dealname`+`pipeline` = don't-overwrite) → `deals/batch/update` (idProperty=unique_bb_id).
- **NEW-create** (25 cols, Company+Contact+Deal, **include ARR**) → upsert company(domain)+contact(email)+deal(unique_bb_id) + v4 associations.
- Write per-row `import_action` + result ids / `import_error`.

### PHASE G — Post-import & summary (Screen 5)
- **Duplicate-company check:** list companies created today; find same-domain / different-name pairs (often one has many contacts, one has 1). Flag them (name1, name2, domain, contact counts, which holds the deal). After approval: reassociate the deal to the correct company (more contacts / older), then merge (primary = the one with more contacts / older create date).
- Write `import_runs.summary` (counts, errors, edge cases); show the report.

---

## 4. IMPORT FILE COLUMN MAPS

### 4.1 EXISTING-update file (16 columns, "Update existing records", Deals only)
| CSV column | HubSpot property | Notes |
|---|---|---|
| Opportunity ID | unique_bb_id | 🔑 match key |
| Record ID | hs_object_id | optional (match via unique_bb_id) |
| Deal Name | dealname | set "don't overwrite" |
| Pipeline | pipeline | set "don't overwrite" |
| Close Date | closedate | |
| Opportunity Owner | BB Executive | |
| Opportunity Owner: Manager | BB Executive Manager | |
| Created Date | createdate | |
| Stage | dealstage | |
| Demonstrate Stage Date | demonstrate_stage_date | |
| Region | region | |
| Competitor | competitor | |
| Incumbent | incumbent | |
| Next Step | Next Steps (BB Partnership group, NOT the regular "Next step") | |
| Description | deal description (Deal-level, NOT Company) | |
| Opportunity Source | opportunity_source | |

**Never sent on update:** amount/ARR, website/company, contact fields.

### 4.2 NEW-create file (25 columns, "Create and update records", Company+Contact+Deal)
- **Company:** Account Name → company `name`; Website → company `domain`.
- **Contact:** First Name, Last Name, Contact: Email → `email`, Contact: Title → `jobtitle`. Do NOT mark as marketing contact.
- **Deal:** Opportunity ID → `unique_bb_id`; Deal Name → `dealname`; Pipeline; Close Date → `closedate`; **Annual Recurring Amount → `amount`** (NOT "One-time services"); Opportunity Owner → BB Executive; Opportunity Owner: Manager → BB Executive Manager; Created Date → `createdate`; Stage → `dealstage`; Demonstrate Stage Date; Region; Competitor; Incumbent; Next Step (BB Partnership); Next Steps & Progress Summary; Notes for Rep; Description → deal description; Opportunity Source; Stage Duration.

### 4.3 Mapping gotchas (carry these into the API field mapping)
- **Description** belongs on the **Deal**, not the Company.
- **Close date** belongs on the **Deal**, not the Contact.
- **Amount** = "Amount", never "One-time services".
- **Website** → Company `domain`.
- **Next steps** → the **BB Partnership** "Next Steps" property, not the generic "Next step".
- Contacts: never set as marketing contact.

---

## 5. RULES & EDGE KNOWLEDGE
- **Amounts:** ARR is imported **only for NEW deals**; existing-deal amounts are **never updated** (AEs manage them). Blackbaud reports a partial figure; Aakash/Maaz set the real full value, which arrives in the ARR field as-stated USD.
- **Stages:** Demonstrate / Propose / Negotiate = AEs involved; Discover & Access / Engage = earlier. Stage drives the Demonstrate Stage Date (Phase B) but is **not** a classification gate — a deal not found by BBID is imported as NEW regardless of stage (HOLD is no longer produced). Closed Won/Lost no longer appear.
- **Internal deals:** moved into Inbound/Outbound (or other non-BB pipelines) by AEs — already managed, so SKIP (don't overwrite).
- **`region` + `vertical`** drive pipeline derivation (and are also imported as deal properties). **`last_stage_change_date`** is the source for the Demonstrate Stage Date (and the change-detection signal).

---

## 6. DB SCHEMA (one SQL migration; two tables)

**import_runs** — per-upload summary/review record:
`id PK, filename, source_label, uploaded_by_email, uploaded_at, status(enum: uploaded|parsing|classifying|classified|in_review|importing|completed|failed), row_count, new_count, existing_count, review_count, review_status(enum: not_started|in_progress|complete), reviewed_by_email, reviewed_at, approved_count, skipped_count, review_notes, edge_cases(jsonb), summary(jsonb), created_at, updated_at`

**deal_rows** — one per CSV row, walks raw → cleaned → classified → reviewed → imported:
`id PK, import_run_id FK→import_runs, filename, row_number, raw_data(jsonb), bb_id, account_name, stage, region, vertical, arr_raw, created_date, close_date, last_stage_change_date, website_raw, contact_email, domain, domain_flagged(bool), first_name, last_name, demonstrate_stage_date, derived_pipeline, deal_name, classification(enum: existing|internal|new|hold|review_confirm|review_ambiguous), matched_by(enum: bbid|dealname|none), hs_deal_id, matched_pipeline, match_count, review_decision(enum: pending|create|update|skip|mark_existing), arr_final, domain_final, linked_hs_deal_id, import_action(enum: created|updated|skipped|held|error), result_hs_deal_id, result_hs_company_id, result_hs_contact_id, import_error, imported_at, created_at, updated_at`

Indexes: `bb_id`, `deal_name`, `import_run_id`.

---

## 7. BUILD PLAN (each line → one PROGRESS.md task, in order)

### Phase 0 — Scaffold
- Repo layout `/frontend` + `/supabase`; root README; root `.env.example` + `frontend/.env.example` documenting every variable with a description (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HUBSPOT_TOKEN; VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
- Init `/frontend` (Vite + React + TS) + Supabase JS client + router for the 5 screens.
- Init `/supabase` (config.toml, functions/, migrations/).

### Phase 1 — Database & storage
- SQL migration: enums + import_runs + deal_rows (§6) + FK + indexes.
- Create private Storage bucket `bb-uploads`.

### Phase 2 — Shared backend modules
- Env/config loader (validate required vars; clear errors).
- Cleaning module (cleanDomain, splitName, demonstrateStageDate, derivePipeline, buildDealName) + `BB_PIPELINES` constant (§2.2). Unit-tested.
- HubSpot client (searchDealsByBbid batch, searchDealsByName, batchUpdateDeals idProperty=unique_bb_id, upsertCompany/Contact/Deal, createAssociations) per §2.4. Mockable.

### Phase 3 — Edge Functions
- `ingest`: CSV from Storage → parse + validate → create import_run → insert cleaned deal_rows.
- `classify`: Phase C per row → write classification + matched fields → roll up counts + edge_cases.
- `import`: approved rows → EXISTING updates (§4.1) + NEW creates (§4.2) with mapping gotchas (§4.3) → per-row results → post-import dup-company check (Phase G) → write summary.

### Phase 4 — Frontend
- Screen 1 Upload (→ Storage → trigger ingest + classify).
- Screen 2 Results dashboard + Approved? gate.
- Screen 3 Review (the 7 edge cases; edit ARR/domain; decisions; approve).
- Screens 4+5 Import + Summary (incl. dup-company flags).

### Phase 5 — Wire-up & verify
- Sample Blackbaud CSV fixture; unit tests for cleaning + classification with MOCKED http; typecheck/build both apps.
- Finalize README (setup, where to put secrets) + both `.env.example` files.
