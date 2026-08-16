import { useEffect, useRef, useState } from 'react'

const SCRIPT_ID = 'cloudflare-turnstile-script'
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const SCRIPT_LOAD_TIMEOUT_MS = 10_000

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string
    action: string
    size: 'flexible'
    callback: (token: string) => void
    'expired-callback': () => void
    'error-callback': () => void
    'timeout-callback': () => void
  }): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  return new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
    const script = existing ?? document.createElement('script')
    let settled = false
    let timeoutId: number | undefined
    const cleanup = () => {
      script.removeEventListener('load', loaded)
      script.removeEventListener('error', failed)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      script.remove()
      reject(new Error(message))
    }
    const loaded = () => {
      if (!window.turnstile) {
        fail('Turnstile did not initialize.')
        return
      }
      if (settled) return
      settled = true
      cleanup()
      resolve(window.turnstile)
    }
    const failed = () => fail('Turnstile could not load.')
    script.addEventListener('load', loaded, { once: true })
    script.addEventListener('error', failed, { once: true })
    timeoutId = window.setTimeout(
      () => fail('Turnstile initialization timed out.'),
      SCRIPT_LOAD_TIMEOUT_MS,
    )
    if (!existing) {
      script.id = SCRIPT_ID
      script.src = SCRIPT_URL
      script.async = true
      script.defer = true
      document.head.append(script)
    }
  })
}

export function TurnstileWidget({ siteKey, resetKey, onToken }: {
  siteKey: string
  resetKey: number
  onToken: (token: string | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Loading verification…')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let active = true
    let widgetId: string | null = null
    onToken(null)
    setStatus('Loading verification…')
    setLoadFailed(false)
    void loadTurnstile().then((turnstile) => {
      if (!active || !containerRef.current) return
      widgetId = turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: 'speaker_registration',
        size: 'flexible',
        callback: (token) => {
          if (!active) return
          onToken(token)
          setStatus('Verification complete.')
        },
        'expired-callback': () => {
          if (!active) return
          onToken(null)
          setStatus('Verification expired. Complete it again.')
        },
        'timeout-callback': () => {
          if (!active) return
          onToken(null)
          setStatus('Verification timed out. Complete it again.')
        },
        'error-callback': () => {
          if (!active) return
          onToken(null)
          setStatus('Verification could not complete. Try again.')
        },
      })
    }).catch(() => {
      if (active) {
        setLoadFailed(true)
        setStatus('Verification could not load. Check your connection and try again.')
      }
    })
    return () => {
      active = false
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [loadAttempt, onToken, resetKey, siteKey])

  return <div className="turnstile-field">
    <div ref={containerRef} aria-label="Account verification" />
    <small role="status" aria-live="polite">{status}</small>
    {loadFailed && <button type="button" className="plain-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry verification</button>}
  </div>
}
