-- Initial schema for the Blackbaud → HubSpot CSV import tool.
-- Two tables (import_runs, deal_rows) + supporting enums, FK, and indexes.
--
-- No-auth design: there is no login layer. Uploader/reviewer email is stored as
-- plain text. RLS is intentionally left disabled on these tables so the browser
-- (anon key) can read run/row data and write reviewer edits directly. All writes
-- that touch HubSpot go through Edge Functions using the service-role key.

-- ───────────────────────────── Enums ─────────────────────────────

create type import_status as enum (
  'uploaded',
  'ingesting',
  'ingested',
  'classifying',
  'classified',
  'importing',
  'completed',
  'failed'
);

create type review_status as enum (
  'pending',
  'in_review',
  'approved'
);

create type deal_classification as enum (
  'pending',
  'new',
  'existing',
  'internal',
  'hold',
  'review'
);

create type matched_by as enum (
  'none',
  'bb_id',
  'deal_name'
);

create type review_decision as enum (
  'pending',
  'approve',
  'skip',
  'confirm',
  'reject'
);

create type import_action as enum (
  'pending',
  'create',
  'update',
  'skip',
  'error'
);

-- ─────────────────────────── import_runs ───────────────────────────

create table import_runs (
  id                 uuid primary key default gen_random_uuid(),
  filename           text not null,
  source_label       text,
  uploaded_by_email  text,
  uploaded_at        timestamptz,
  status             import_status not null default 'uploaded',
  row_count          integer not null default 0,
  new_count          integer not null default 0,
  existing_count     integer not null default 0,
  review_count       integer not null default 0,
  review_status      review_status not null default 'pending',
  reviewed_by_email  text,
  reviewed_at        timestamptz,
  approved_count     integer not null default 0,
  skipped_count      integer not null default 0,
  review_notes       text,
  edge_cases         jsonb not null default '[]'::jsonb,
  summary            jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ──────────────────────────── deal_rows ────────────────────────────

create table deal_rows (
  id                    uuid primary key default gen_random_uuid(),
  import_run_id         uuid not null references import_runs (id) on delete cascade,
  filename              text,
  row_number            integer not null,
  raw_data              jsonb not null default '{}'::jsonb,

  -- parsed raw fields (as read from the CSV)
  bb_id                 text,
  account_name          text,
  stage                 text,
  region                text,
  vertical              text,
  arr_raw               text,
  created_date          date,
  close_date            date,
  last_stage_change_date date,
  website_raw           text,
  contact_email         text,

  -- cleaned / derived fields (Phase B)
  domain                text,
  domain_flagged        boolean not null default false,
  first_name            text,
  last_name             text,
  demonstrate_stage_date date,
  derived_pipeline      text,
  deal_name             text,

  -- classification (Phase C)
  classification        deal_classification not null default 'pending',
  matched_by            matched_by not null default 'none',
  hs_deal_id            text,
  matched_pipeline      text,
  match_count           integer not null default 0,

  -- review (Phase E)
  review_decision       review_decision not null default 'pending',
  arr_final             numeric,
  domain_final          text,
  linked_hs_deal_id     text,

  -- import results (Phase F)
  import_action         import_action not null default 'pending',
  result_hs_deal_id     text,
  result_hs_company_id  text,
  result_hs_contact_id  text,
  import_error          text,
  imported_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ───────────────────────────── Indexes ─────────────────────────────

create index idx_deal_rows_bb_id on deal_rows (bb_id);
create index idx_deal_rows_deal_name on deal_rows (deal_name);
create index idx_deal_rows_import_run_id on deal_rows (import_run_id);

-- ─────────────────────── updated_at maintenance ────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_import_runs_updated_at
  before update on import_runs
  for each row execute function set_updated_at();

create trigger trg_deal_rows_updated_at
  before update on deal_rows
  for each row execute function set_updated_at();
