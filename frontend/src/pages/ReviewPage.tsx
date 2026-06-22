import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getRows, getRun, updateRowReview, updateRunReview } from '../lib/api'
import type { DealRow, EdgeCaseEntry, ImportRun, ReviewDecision } from '../lib/types'

// The 7 Phase E edge-case categories.
const CATEGORY_LABEL: Record<number, string> = {
  1: 'New deal — confirm the ARR amount',
  2: '1 deal-name match, no BB ID — confirm',
  3: '2+ deal-name matches — ambiguous',
  4: 'Duplicate deal for the same BB ID',
  5: 'ABM vs Blackbaud source conflict',
  6: 'Already won / onboarding / in CS',
  7: 'Data-quality: suspect domain',
}

const DECISIONS: { value: ReviewDecision; label: string }[] = [
  { value: 'approve', label: 'Approve (create / update as classified)' },
  { value: 'confirm', label: 'Confirm existing match (update)' },
  { value: 'skip', label: 'Skip this row' },
  { value: 'reject', label: 'Reject' },
]

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
    for (const edge of run?.edge_cases ?? []) {
      const list = map.get(edge.row_id) ?? []
      list.push(edge)
      map.set(edge.row_id, list)
    }
    return map
  }, [run])

  const reviewRows = useMemo(() => rows.filter((r) => edgesByRow.has(r.id)), [rows, edgesByRow])

  function patchEdit(rowId: string, patch: Partial<RowEdit>) {
    setEdits((prev) => ({ ...prev, [rowId]: { ...prev[rowId], ...patch } }))
  }

  async function handleApprove() {
    if (!runId) return
    setError(null)
    setSaving(true)
    try {
      for (const row of reviewRows) {
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

  if (reviewRows.length === 0) {
    return (
      <section>
        <h2>Screen 3 — Review</h2>
        <p className="status">No edge cases to review.</p>
        <button onClick={() => navigate(`/import/${runId}`)}>Continue to import →</button>
      </section>
    )
  }

  return (
    <section>
      <h2>Screen 3 — Review {reviewRows.length} edge case(s)</h2>
      <p className="muted">Edit ARR / domain, set a decision per row, then approve to continue.</p>

      <div className="review-list">
        {reviewRows.map((row) => {
          const edit = edits[row.id]
          const edges = edgesByRow.get(row.id) ?? []
          if (!edit) return null
          return (
            <div className="review-row" key={row.id}>
              <div className="review-row__head">
                <strong>#{row.row_number} · {row.account_name ?? '(no account)'}</strong>
                <span className="badge">{row.classification}</span>
              </div>
              <div className="muted">{row.deal_name}</div>
              <ul className="review-row__edges">
                {edges.map((e, i) => (
                  <li key={i}>
                    <strong>{CATEGORY_LABEL[e.category] ?? e.kind}:</strong> {e.detail}
                  </li>
                ))}
              </ul>
              <div className="fields-row">
                <label className="field">
                  <span>Decision</span>
                  <select
                    value={edit.decision}
                    onChange={(ev) => patchEdit(row.id, { decision: ev.target.value as ReviewDecision })}
                    disabled={saving}
                  >
                    {DECISIONS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>ARR amount</span>
                  <input
                    type="text"
                    value={edit.arr}
                    placeholder="e.g. 50000"
                    onChange={(ev) => patchEdit(row.id, { arr: ev.target.value })}
                    disabled={saving}
                  />
                </label>
                <label className="field">
                  <span>Domain</span>
                  <input
                    type="text"
                    value={edit.domain}
                    placeholder="example.com"
                    onChange={(ev) => patchEdit(row.id, { domain: ev.target.value })}
                    disabled={saving}
                  />
                </label>
              </div>
            </div>
          )
        })}
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
