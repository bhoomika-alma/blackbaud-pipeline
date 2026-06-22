import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getRows, getRun, updateRowReview, updateRunReview } from '../lib/api'
import type { DealRow, EdgeCaseEntry, ImportRun, ReviewDecision } from '../lib/types'

const DECISIONS: { value: ReviewDecision; label: string }[] = [
  { value: 'approve', label: 'Approve' },
  { value: 'confirm', label: 'Confirm match' },
  { value: 'skip', label: 'Skip' },
  { value: 'reject', label: 'Reject' },
]

// Category 1 ("new deal → confirm ARR") is routine, not a real edge case.
const isRealEdge = (e: EdgeCaseEntry) => e.category !== 1

interface RowEdit {
  decision: ReviewDecision
  arr: string
  domain: string
}

function defaultDecision(row: DealRow): ReviewDecision {
  if (row.review_decision !== 'pending') return row.review_decision
  switch (row.classification) {
    case 'new':
    case 'existing':
      return 'approve'
    case 'review':
      return row.match_count === 1 ? 'confirm' : 'skip'
    default:
      return 'skip'
  }
}

export default function ReviewPage() {
  const { runId } = useParams()
  const [searchParams] = useSearchParams()
  const mode = searchParams.get('mode') === 'all' ? 'all' : 'edge'
  const navigate = useNavigate()

  const [run, setRun] = useState<ImportRun | null>(null)
  const [rows, setRows] = useState<DealRow[]>([])
  const [edits, setEdits] = useState<Record<string, RowEdit>>({})
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('bb_uploader_email') ?? '')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let active = true
    Promise.all([getRun(runId), getRows(runId)])
      .then(([r, rws]) => {
        if (!active) return
        setRun(r)
        setRows(rws)
        const initial: Record<string, RowEdit> = {}
        for (const row of rws) {
          initial[row.id] = {
            decision: defaultDecision(row),
            arr: row.arr_final != null ? String(row.arr_final) : (row.arr_raw ?? ''),
            domain: row.domain_final ?? row.domain ?? '',
          }
        }
        setEdits(initial)
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [runId])

  const edgesByRow = useMemo(() => {
    const map = new Map<string, EdgeCaseEntry[]>()
    for (const edge of (run?.edge_cases ?? []).filter(isRealEdge)) {
      const list = map.get(edge.row_id) ?? []
      list.push(edge)
      map.set(edge.row_id, list)
    }
    return map
  }, [run])

  const displayRows = useMemo(
    () => (mode === 'all' ? rows : rows.filter((r) => edgesByRow.has(r.id))),
    [mode, rows, edgesByRow],
  )

  function patchEdit(rowId: string, patch: Partial<RowEdit>) {
    setEdits((prev) => ({ ...prev, [rowId]: { ...prev[rowId], ...patch } }))
  }

  async function handleApprove() {
    if (!runId) return
    setError(null)
    setSaving(true)
    try {
      for (const row of displayRows) {
        const edit = edits[row.id]
        if (!edit) continue
        const arrNum = edit.arr.trim() === '' ? null : Number(edit.arr.replace(/[^0-9.]/g, ''))
        await updateRowReview(row.id, {
          review_decision: edit.decision,
          arr_final: arrNum != null && !Number.isNaN(arrNum) ? arrNum : null,
          domain_final: edit.domain.trim() || null,
          linked_hs_deal_id: edit.decision === 'confirm' ? row.hs_deal_id : null,
        })
      }
      await updateRunReview(runId, {
        review_status: 'approved',
        reviewed_by_email: reviewer.trim() || undefined,
        review_notes: notes.trim() || undefined,
      })
      navigate(`/import/${runId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="status">Loading review…</p>
  if (error && !run) return <p className="error">{error}</p>
  if (!run) return <p className="error">Import run not found.</p>

  if (mode === 'edge' && displayRows.length === 0) {
    return (
      <section>
        <h2>Screen 3 — Review edge cases</h2>
        <p className="status">🎉 No edge cases to resolve.</p>
        <div className="gate__actions">
          <button onClick={() => navigate(`/review/${runId}?mode=all`)}>
            Review all rows before inserting →
          </button>
          <button className="secondary" onClick={() => navigate(`/import/${runId}`)}>
            Approve &amp; import →
          </button>
        </div>
      </section>
    )
  }

  const title = mode === 'all'
    ? `Screen 3 — Review all ${displayRows.length} rows`
    : `Screen 3 — Review ${displayRows.length} edge case${displayRows.length === 1 ? '' : 's'}`

  return (
    <section>
      <h2>{title}</h2>
      <p className="muted">
        {mode === 'all'
          ? 'Every row in the file. Edit ARR / domain and set a decision per row, then approve.'
          : 'Only rows that need a human decision. Edit ARR / domain, set a decision, then approve.'}{' '}
        {mode === 'edge' ? (
          <a href={`#/review/${runId}?mode=all`} onClick={(e) => { e.preventDefault(); navigate(`/review/${runId}?mode=all`) }}>
            View all rows →
          </a>
        ) : (
          <a href={`#/review/${runId}?mode=edge`} onClick={(e) => { e.preventDefault(); navigate(`/review/${runId}?mode=edge`) }}>
            View edge cases only →
          </a>
        )}
      </p>

      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>BB ID</th>
              <th>Account</th>
              <th>Deal name</th>
              <th>Pipeline</th>
              <th>Region</th>
              <th>Stage</th>
              <th>Class</th>
              <th>Domain</th>
              <th>ARR</th>
              <th>Decision</th>
              <th>Edge case</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              const edit = edits[row.id]
              if (!edit) return null
              const edges = edgesByRow.get(row.id) ?? []
              return (
                <tr key={row.id} className={edges.length ? 'grid__flagged' : ''}>
                  <td className="grid__num">{row.row_number}</td>
                  <td>{row.bb_id ?? ''}</td>
                  <td>{row.account_name ?? ''}</td>
                  <td>{row.deal_name ?? ''}</td>
                  <td>{row.derived_pipeline ?? ''}</td>
                  <td>{row.region ?? ''}</td>
                  <td>{row.stage ?? ''}</td>
                  <td>
                    <span className="badge">{row.classification}</span>
                  </td>
                  <td>
                    <input
                      className="grid__input"
                      value={edit.domain}
                      onChange={(e) => patchEdit(row.id, { domain: e.target.value })}
                      disabled={saving}
                    />
                  </td>
                  <td>
                    <input
                      className="grid__input grid__input--num"
                      value={edit.arr}
                      onChange={(e) => patchEdit(row.id, { arr: e.target.value })}
                      disabled={saving}
                    />
                  </td>
                  <td>
                    <select
                      className="grid__input"
                      value={edit.decision}
                      onChange={(e) =>
                        patchEdit(row.id, { decision: e.target.value as ReviewDecision })}
                      disabled={saving}
                    >
                      {DECISIONS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="grid__edge">{edges.map((e) => e.detail).join('; ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="gate">
        <div className="fields-row">
          <label className="field">
            <span>Reviewer email</span>
            <input
              type="email"
              value={reviewer}
              placeholder="you@almabase.com"
              onChange={(e) => setReviewer(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Review notes (optional)</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
            />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <button onClick={handleApprove} disabled={saving}>
          {saving ? 'Saving…' : 'Approve & continue to import →'}
        </button>
      </div>
    </section>
  )
}
