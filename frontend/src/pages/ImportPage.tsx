import { useParams } from 'react-router-dom'

export default function ImportPage() {
  const { runId } = useParams()
  return (
    <section>
      <h2>Screen 4 — Import</h2>
      <p>Import run: {runId}</p>
      <p>Build create/update payloads and push to HubSpot. (Implemented in Phase 4.)</p>
    </section>
  )
}
