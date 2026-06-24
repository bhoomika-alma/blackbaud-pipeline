import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getRows, getRun } from '../lib/api'
import type { DealRow, ImportRun } from '../lib/types'

export default function SummaryPage() {
  const { runId } = useParams()
  const [run, setRun] = useState<ImportRun | null>(null)
  const [rows, setRows] = useState<DealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    let active = true
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

  if (loading) return <p className="status">Loading summary…</p>
  if (error) return <p className="error">{error}</p>
  if (!run) return <p className="error">Import run not found.</p>

  const summary = run.summary
  const duplicates = summary?.duplicate_companies ?? []
  const errors = summary?.errors ?? []

  return (
    <section>
      <h2>Screen 5 — Import summary</h2>
      <p className="muted">
        <strong>{run.filename}</strong> · <span className="badge">{run.status}</span>
        {run.reviewed_by_email ? ` · reviewed by ${run.reviewed_by_email}` : ''}
      </p>

      <div className="cards">
        <div className="card card--total">
          <div className="card__n">{summary?.created ?? 0}</div>
          <div className="card__label">Created</div>
        </div>
        <div className="card card--total">
          <div className="card__n">{summary?.updated ?? 0}</div>
          <div className="card__label">Updated</div>
        </div>
        <div className="card">
          <div className="card__n">{summary?.skipped ?? run.skipped_count}</div>
          <div className="card__label">Skipped</div>
        </div>
        <div className="card">
          <div className="card__n">{errors.length}</div>
          <div className="card__label">Errors</div>
        </div>
      </div>

      {summary && (
        <>
          <h3>New vs existing in HubSpot</h3>
          <p className="muted">
            Found via batch search before creating — we never blind-upsert, so these counts are exact.
          </p>
          <div className="cards">
            <div className="card">
              <div className="card__n">
                {summary.deals_created ?? 0}
                <span className="card__sub"> / {summary.deals_existing ?? 0}</span>
              </div>
              <div className="card__label">Deals</div>
              <div className="card__hint">created / already existed</div>
            </div>
            <div className="card">
              <div className="card__n">
                {summary.companies_created ?? 0}
                <span className="card__sub"> / {summary.companies_existing ?? 0}</span>
              </div>
              <div className="card__label">Companies</div>
              <div className="card__hint">created / already existed</div>
            </div>
            <div className="card">
              <div className="card__n">
                {summary.contacts_created ?? 0}
                <span className="card__sub"> / {summary.contacts_existing ?? 0}</span>
              </div>
              <div className="card__label">Contacts</div>
              <div className="card__hint">created / already existed</div>
            </div>
          </div>
        </>
      )}

      {duplicates.length > 0 && (
        <div className="error">
          <strong>Possible duplicate companies (flag for merge):</strong>
          <ul>
            {duplicates.map((d) => (
              <li key={d.domain}>
                {d.domain} → {d.companyIds.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {errors.length > 0 && (
        <div className="error">
          <strong>Errors:</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                Row {e.row_number}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>Per-row results</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th>Classification</th>
              <th>Action</th>
              <th>HubSpot deal</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.row_number}</td>
                <td>{row.account_name ?? ''}</td>
                <td>{row.classification}</td>
                <td>{row.import_action}</td>
                <td>{row.result_hs_deal_id ?? row.hs_deal_id ?? ''}</td>
                <td className="table__error">{row.import_error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p>
        <Link to="/upload">← Start a new import</Link>
      </p>
    </section>
  )
}
