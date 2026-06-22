import { useParams } from 'react-router-dom'

export default function ReviewPage() {
  const { runId } = useParams()
  return (
    <section>
      <h2>Screen 3 — Review edge cases</h2>
      <p>Import run: {runId}</p>
      <p>Resolve edge cases; edit ARR/domain; set decisions; approve. (Implemented in Phase 4.)</p>
    </section>
  )
}
