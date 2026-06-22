import { Outlet } from 'react-router-dom'
import './App.css'

const STEPS = [
  { n: 1, label: 'Upload' },
  { n: 2, label: 'Results' },
  { n: 3, label: 'Review' },
  { n: 4, label: 'Import' },
  { n: 5, label: 'Summary' },
]

export default function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1>Blackbaud → HubSpot Import</h1>
        <ol className="app__steps">
          {STEPS.map((s) => (
            <li key={s.n}>
              {s.n}. {s.label}
            </li>
          ))}
        </ol>
      </header>
      <main className="app__main">
        <Outlet />
      </main>
    </div>
  )
}
