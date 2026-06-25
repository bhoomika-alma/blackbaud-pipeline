import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getRows, getRun } from '../lib/api'
import type { Classification, DealRow, ImportRun } from '../lib/types'

const BUCKETS: { key: Classification; label: string; hint: string }[] = [
  { key: 'new', label: 'New', hint: 'Create in HubSpot' },
  { key: 'existing', label: 'Existing', hint: 'Update in HubSpot' },
  { key: 'review', label: 'Review', hint: 'Needs a decision' },
  { key: 'hold', label: 'Hold', hint: 'Early stage — skip' },
  { key: 'internal', label: 'Internal', hint: 'Non-Blackbaud — skip' },
]

export default function ResultsPage() {
  const { runId } = useParams()
  const navigate = useNavigate()
  const [run, setRun] = useState<ImportRun | null>(null)
  const [rows, setRows] = useState<DealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let active = true
    setLoading(true)
    Promise.all([getRun(runId), getRows(runId)])
      .then(([r, rws]) => {
        if (!active) return
        setRun(r)
        setRows(rws)
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [runId])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.classification] = (c[r.classification] ?? 0) + 1
    return c
  }, [rows])

  if (loading) return <p className="status">Loading results…</p>
  if (error) return <p className="error">{error}</p>
  if (!run) return <p className="error">Import run not found.</p>

  // Category 1 ("new deal → confirm ARR") is routine, not a real edge case.
  // Count distinct ROWS (you make one decision per row) — a row can carry more
  // than one edge case (e.g. a name-match that's also domain-flagged), so this
  // must match the per-row count shown on the Review screen.
  const realEdgeRowIds = new Set(
    (run.edge_cases ?? []).filter((e) => e.category !== 1).map((e) => e.row_id),
  )
  const realEdgeCount = realEdgeRowIds.size

  return (
    <section>
      <h2>Screen 2 — Results</h2>
      <p className="muted">
        <strong>{run.filename}</strong> · uploaded by {run.uploaded_by_email ?? 'unknown'} ·{' '}
        <span className="badge">{run.status}</span>
      </p>

      <div className="cards">
        {BUCKETS.map((b) => (
          <div className="card" key={b.key}>
            <div className="card__n">{counts[b.key] ?? 0}</div>
            <div className="card__label">{b.label}</div>
            <div className="card__hint">{b.hint}</div>
          </div>
        ))}
        <div className="card card--total">
          <div className="card__n">{run.row_count}</div>
          <div className="card__label">Total rows</div>
          <div className="card__hint">In this file</div>
        </div>
      </div>

      <div className="gate">
        {realEdgeCount > 0 ? (
          <p className="status">
            {realEdgeCount} edge case{realEdgeCount === 1 ? '' : 's'} need a decision before import.
          </p>
        ) : (
          <p className="status">No edge cases flagged — review the rows, or import directly.</p>
        )}
        <div className="gate__actions">
          {realEdgeCount > 0 && (
            <button className="danger" onClick={() => navigate(`/review/${runId}?mode=edge`)}>
              Review {realEdgeCount} edge case{realEdgeCount === 1 ? '' : 's'} →
            </button>
          )}
          <button onClick={() => navigate(`/review/${runId}?mode=all`)}>
            Review rows before inserting →
          </button>
          {realEdgeCount === 0 && (
            <button className="secondary" onClick={() => navigate(`/import/${runId}`)}>
              Approve &amp; import →
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
