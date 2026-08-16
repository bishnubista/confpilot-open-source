import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'

const RELOAD_GUARD_KEY = 'confpilot:preload-reloaded-at'
const RELOAD_COOLDOWN_MS = 60_000

/**
 * Recover from a chunk that disappeared under us.
 *
 * Vite emits `vite:preloadError` when a dynamic import cannot be fetched, which
 * normally means a deploy replaced the chunk hashes referenced by this already-
 * loaded page. Reloading pulls a fresh `index.html`.
 *
 * The cooldown is what keeps this safe. If the fetch fails for a reason a reload
 * cannot fix — an offline device, a poisoned cache, a genuinely missing asset —
 * reloading unconditionally would spin forever. Recording *when* we last
 * reloaded, rather than merely that we did, still lets a later deploy in a long
 * session recover automatically while making a tight loop impossible: a second
 * failure inside a minute falls through to the error boundary, which asks the
 * visitor instead of deciding for them.
 */
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0)
  if (Number.isFinite(last) && Date.now() - last < RELOAD_COOLDOWN_MS) return
  event.preventDefault()
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
