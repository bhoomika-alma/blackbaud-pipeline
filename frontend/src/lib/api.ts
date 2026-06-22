// Frontend → backend calls. CSVs go to Supabase Storage; everything else goes
// through the Edge Functions (the browser never calls HubSpot directly).

import { ANON_KEY, FUNCTIONS_URL, STORAGE_BUCKET, supabase } from './supabase'
import type { ClassifyResponse, IngestResponse } from './types'

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
