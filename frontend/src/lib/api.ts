// Frontend → backend calls. CSVs go to Supabase Storage; everything else goes
// through the Edge Functions (the browser never calls HubSpot directly).

import { ANON_KEY, FUNCTIONS_URL, STORAGE_BUCKET, supabase } from './supabase'
import type { ClassifyResponse, DealRow, ImportRun, IngestResponse } from './types'

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Upload a CSV to the bb-uploads bucket; returns the stored object path. */
export async function uploadCsv(file: File): Promise<string> {
  const path = `uploads/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, file, {
    contentType: 'text/csv',
    upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)
  return path
}

/** Invoke an Edge Function with the anon key and return its JSON body. */
export async function invokeFunction<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) {
    throw new Error(payload.error ?? `Function "${name}" failed (HTTP ${res.status})`)
  }
  return payload as T
}

export interface IngestInput {
  path: string
  filename?: string
  uploadedByEmail?: string
  sourceLabel?: string
}

export function ingest(input: IngestInput): Promise<IngestResponse> {
  return invokeFunction<IngestResponse>('ingest', input)
}

export function classify(importRunId: string): Promise<ClassifyResponse> {
  return invokeFunction<ClassifyResponse>('classify', { importRunId })
}

export function runImport(importRunId: string, reviewedByEmail?: string): Promise<unknown> {
  return invokeFunction('import', { importRunId, reviewedByEmail })
}

// ── Reads (anon key; RLS disabled for this no-auth internal tool) ──

export async function getRun(runId: string): Promise<ImportRun> {
  const { data, error } = await supabase.from('import_runs').select('*').eq('id', runId).single()
  if (error || !data) throw new Error(error?.message ?? 'Import run not found')
  return data as ImportRun
}

export async function getRows(runId: string): Promise<DealRow[]> {
  const { data, error } = await supabase
    .from('deal_rows')
    .select('*')
    .eq('import_run_id', runId)
    .order('row_number', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as DealRow[]
}

export async function updateRowReview(
  rowId: string,
  patch: Partial<Pick<DealRow, 'review_decision' | 'arr_final' | 'domain_final' | 'linked_hs_deal_id'>>,
): Promise<void> {
  const { error } = await supabase.from('deal_rows').update(patch).eq('id', rowId)
  if (error) throw new Error(error.message)
}

export async function updateRunReview(
  runId: string,
  patch: { review_status?: string; reviewed_by_email?: string; review_notes?: string },
): Promise<void> {
  const { error } = await supabase.from('import_runs').update(patch).eq('id', runId)
  if (error) throw new Error(error.message)
}
