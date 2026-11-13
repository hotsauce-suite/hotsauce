import './brand/product'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { getLive } from './apps/meetings/live/liveState'
import { followServiceWorkerNavigation } from './lib/swNavigate'
import { createAppRouter } from './router'
import './styles/app.css'

// A deploy replaces the hashed chunks, and the new service worker takes over open tabs at once,
// so a tab running the old build can ask for a chunk that's gone. Reload into the new build,
// at most once a minute so a real outage doesn't loop, and never while a meeting is being
// recorded here: a reload would end the capture.
window.addEventListener('vite:preloadError', (event) => {
  if (getLive()) return
  try {
    const last = Number(sessionStorage.getItem('hearth:chunk-reload') ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem('hearth:chunk-reload', String(Date.now()))
  } catch {
    // No sessionStorage: reload anyway.
  }
  event.preventDefault()
  window.location.reload()
})

async function boot() {
  // Statically false in production builds, so the mock layer is tree-shaken away. The demo
  // build (`vite build --mode demo`, the live demo on hotsauce.work) keeps it.
  if (
    (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') ||
    import.meta.env.MODE === 'demo'
  ) {
    const { startMockApi } = await import('./mocks/browser')
    await startMockApi()
  }
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')
  const router = createAppRouter()
  followServiceWorkerNavigation(navigator.serviceWorker, (to) => void router.navigate(to))
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}

void boot()
