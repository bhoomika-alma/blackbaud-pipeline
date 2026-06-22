import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getRun, runImport } from '../lib/api'
import type { ImportRun } from '../lib/types'

type Phase = 'idle' | 'importing' | 'error'

export default function ImportPage() {
  const { runId } = useParams()
  const navigate = useNavigate()
  const [run, setRun] = useState<ImportRun | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const reviewer = localStorage.getItem('bb_uploader_email') ?? ''

  useEffect(() => {
    if (!runId) return
    getRun(runId)
      .then(setRun)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [runId])

  async function handleImport() {
    if (!runId) return
    setError(null)
    setPhase('importing')
    try {
      await runImport(runId, reviewer || undefined)
      navigate(`/summary/${runId}`)
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (error && !run) return <p className="error">{error}</p>
  if (!run) return <p className="status">Loading…</p>

  const alreadyImported = run.status === 'completed'

  return (
    <section>
      <h2>Screen 4 — Import to HubSpot</h2>

      {alreadyImported ? (
        <>
          <p className="status">This run has already been imported.</p>
          <button onClick={() => navigate(`/summary/${runId}`)}>View summary →</button>
        </>
      ) : (
        <>
          <p className="muted">
            Creates new deals (company + contact + deal) and updates existing deals matched on{' '}
            <code>unique_bb_id</code>. Hold / internal / skipped rows are left untouched.
          </p>
          <div className="cards">
            <div className="card">
              <div className="card__n">{run.new_count}</div>
              <div className="card__label">To create</div>
            </div>
            <div className="card">
              <div className="card__n">{run.existing_count}</div>
              <div className="card__label">To update</div>
            </div>
            <div className="card">
              <div className="card__n">{run.review_count}</div>
              <div className="card__label">Reviewed</div>
            </div>
          </div>

          {error && <p className="error">{error}</p>}
          <button onClick={handleImport} disabled={phase === 'importing'}>
            {phase === 'importing' ? 'Importing…' : 'Run import →'}
          </button>
        </>
      )}
    </section>
  )
}
