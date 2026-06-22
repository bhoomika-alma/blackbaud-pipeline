import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { classify, ingest, uploadCsv } from '../lib/api'

type Phase = 'idle' | 'uploading' | 'ingesting' | 'classifying' | 'error'

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Upload & process',
  uploading: 'Uploading CSV…',
  ingesting: 'Parsing & cleaning…',
  classifying: 'Classifying rows…',
  error: 'Try again',
}

export default function UploadPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState(() => localStorage.getItem('bb_uploader_email') ?? '')
  const [sourceLabel, setSourceLabel] = useState('Blackbaud')
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const busy = phase === 'uploading' || phase === 'ingesting' || phase === 'classifying'

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!email.trim()) {
      setError('Please enter your email so we can record who uploaded this file.')
      return
    }
    if (!file) {
      setError('Please choose a Blackbaud pipeline CSV to upload.')
      return
    }
    localStorage.setItem('bb_uploader_email', email.trim())

    try {
      setPhase('uploading')
      const path = await uploadCsv(file)

      setPhase('ingesting')
      const { importRunId } = await ingest({
        path,
        filename: file.name,
        uploadedByEmail: email.trim(),
        sourceLabel: sourceLabel.trim() || undefined,
      })

      setPhase('classifying')
      await classify(importRunId)

      navigate(`/results/${importRunId}`)
    } catch (err) {
      setPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section>
      <h2>Screen 1 — Upload a Blackbaud CSV</h2>
      <p className="muted">
        The file is stored in Supabase Storage, then parsed, cleaned, and classified against HubSpot.
      </p>

      <form className="form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Your email</span>
          <input
            type="email"
            value={email}
            placeholder="you@almabase.com"
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="field">
          <span>Source label</span>
          <input
            type="text"
            value={sourceLabel}
            placeholder="Blackbaud"
            onChange={(e) => setSourceLabel(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>Pipeline CSV</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
            required
          />
        </label>

        {error && <p className="error">{error}</p>}
        {busy && <p className="status">{PHASE_LABEL[phase]}</p>}

        <button type="submit" disabled={busy}>
          {PHASE_LABEL[busy ? phase : 'idle']}
        </button>
      </form>
    </section>
  )
}
