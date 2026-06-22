-- Private Storage bucket for uploaded Blackbaud CSVs.
--
-- This complements the [storage.buckets.bb-uploads] entry in config.toml (which
-- only applies to a local `supabase start`). Running this migration ensures the
-- bucket also exists in any remote/hosted project the migrations are pushed to.
-- Idempotent: safe to re-run.

insert into storage.buckets (id, name, public)
values ('bb-uploads', 'bb-uploads', false)
on conflict (id) do nothing;

-- No-auth design: the browser (anon key) uploads CSVs directly into this bucket.
-- Server-side reads use the service-role key, which bypasses RLS. The bucket is
-- private (not public), so objects are never exposed via a public URL.
drop policy if exists "anon can upload to bb-uploads" on storage.objects;
create policy "anon can upload to bb-uploads"
  on storage.objects for insert to anon
  with check (bucket_id = 'bb-uploads');

drop policy if exists "anon can read bb-uploads" on storage.objects;
create policy "anon can read bb-uploads"
  on storage.objects for select to anon
  using (bucket_id = 'bb-uploads');
