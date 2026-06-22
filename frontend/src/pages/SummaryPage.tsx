import { useParams } from 'react-router-dom'

export default function SummaryPage() {
  const { runId } = useParams()
  return (
    <section>
      <h2>Screen 5 — Summary</h2>
      <p>Import run: {runId}</p>
      <p>Post-import duplicate-company check and final report. (Implemented in Phase 4.)</p>
    </section>
  )
}
