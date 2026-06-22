import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import App from './App'
import UploadPage from './pages/UploadPage'
import ResultsPage from './pages/ResultsPage'
import ReviewPage from './pages/ReviewPage'
import ImportPage from './pages/ImportPage'
import SummaryPage from './pages/SummaryPage'
import './index.css'

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/upload" replace /> },
      { path: 'upload', element: <UploadPage /> },
      { path: 'results/:runId', element: <ResultsPage /> },
      { path: 'review/:runId', element: <ReviewPage /> },
      { path: 'import/:runId', element: <ImportPage /> },
      { path: 'summary/:runId', element: <SummaryPage /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
