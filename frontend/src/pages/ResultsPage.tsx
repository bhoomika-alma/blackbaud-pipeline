import { useParams } from 'react-router-dom'

export default function ResultsPage() {
  const { runId } = useParams()
  return (
    <section>
      <h2>Screen 2 — Results dashboard</h2>
      <p>Import run: {runId}</p>
      <p>Per-bucket counts and the Approved? gate. (Implemented in Phase 4.)</p>
    </section>
  )
}
