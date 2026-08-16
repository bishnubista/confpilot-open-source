import type { AuthSession } from '@confpilot/contracts'
import { type SubmitEvent, useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, AUTH_SESSION_CHANGED_EVENT, cfpApi } from './api'
import { asApiError, eventWorkspacePath } from './session'
import { Link } from './ui'
import { useApiResource } from './useApiResource'

export type EventRole = 'organizer' | 'reviewer' | 'speaker'

export function hasEventRole(session: AuthSession, eventSlug: string, role: EventRole) {
  return session.memberships.some((membership) => membership.eventSlug === eventSlug && membership.role === role)
}

export function eventSlugForRole(session: AuthSession, role: EventRole) {
  return session.memberships
    .filter((membership) => membership.role === role)
    .map((membership) => membership.eventSlug)
    .sort((left, right) => left.localeCompare(right))[0]
}

export function workspacePathForSession(session: AuthSession) {
  const organizer = eventSlugForRole(session, 'organizer')
  if (organizer) return eventWorkspacePath(organizer, 'admin')
  const reviewer = eventSlugForRole(session, 'reviewer')
  if (reviewer) return eventWorkspacePath(reviewer, 'reviewer')
  const speaker = eventSlugForRole(session, 'speaker')
  if (speaker) return eventWorkspacePath(speaker, 'speaker')
  return '/'
}

type AuthGateReason = 'initial' | 'expired' | 'signed-out'

export function useAuthSessionGate() {
  const resource = useApiResource((signal) => cfpApi.session(signal), [])
  const [authenticated, setAuthenticated] = useState<AuthSession | null>(null)
  const [reason, setReason] = useState<AuthGateReason>('initial')
  const hadSession = useRef(false)

  if (authenticated || resource.status === 'success') hadSession.current = true

  const authenticate = useCallback((session: AuthSession) => {
    hadSession.current = true
    setAuthenticated(session)
    setReason('initial')
  }, [])
  const expire = useCallback(() => {
    setAuthenticated(null)
    setReason('expired')
  }, [])
  const signOut = useCallback(() => {
    setAuthenticated(null)
    setReason('signed-out')
  }, [])

  useEffect(() => {
    const synchronize = (event: Event) => {
      const session = (event as CustomEvent<AuthSession | null>).detail
      if (session) {
        authenticate(session)
        return
      }
      setAuthenticated(null)
      setReason(hadSession.current ? 'expired' : 'signed-out')
    }
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, synchronize)
    return () => window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, synchronize)
  }, [authenticate])

  const activeSession = authenticated ?? (reason === 'initial' && resource.status === 'success' ? resource.data : null)
  return {
    resource,
    activeSession,
    reason,
    checking: reason === 'initial' && !authenticated && resource.status === 'loading',
    authenticate,
    expire,
    signOut,
  }
}

export function AuthError({ error, retry }: { error: ApiError; retry?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [error])
  return <div ref={ref} className="form-error connected-error" role="alert" tabIndex={-1}><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}{retry && <button type="button" className="button button-outline" onClick={retry}>Try again</button>}</div>
}

export function SignInForm({ eyebrow, description, onAuthenticated, error: initialError }: { eyebrow: string; description: string; onAuthenticated: (session: AuthSession) => void; error?: ApiError | null }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(initialError ?? null)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const authenticated = await cfpApi.login({ email, password })
      setPassword('')
      onAuthenticated(authenticated)
    } catch (requestError) {
      setError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }
  return <main className="role-signin"><div><p className="overline">{eyebrow}</p><h1>Sign in to continue.</h1><p>{description}</p></div><form className="section-card admin-auth" onSubmit={submit}><label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <AuthError error={error} />}<button className="button button-primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></form></main>
}

export function AccessDenied({ session, onSignedOut }: { session: AuthSession; onSignedOut: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const useDifferentAccount = async () => {
    setPending(true)
    setError(null)
    try {
      await cfpApi.logout()
      onSignedOut()
    } catch (requestError) {
      setError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }
  const landing = workspacePathForSession(session)
  return <main className="role-empty"><span>ACCOUNT ACCESS</span><h1>This account cannot open this workspace.</h1><p>Signed in as {session.user.displayName}. You can open an available workspace or use a different account.</p>{error && <AuthError error={error} />}<div className="auth-access-actions">{landing !== '/' && <Link className="button button-primary" to={landing}>Open your workspace</Link>}<button type="button" className="button button-outline" disabled={pending} onClick={() => void useDifferentAccount()}>{pending ? 'Signing out…' : 'Use a different account'}</button></div></main>
}

export function SignOutButton({ onSignedOut, className = 'button button-outline' }: { onSignedOut: () => void; className?: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const signOut = async () => {
    setPending(true)
    setError(null)
    try {
      await cfpApi.logout()
      onSignedOut()
    } catch (requestError) {
      setError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }
  return <span className="sign-out-control"><button type="button" className={className} disabled={pending} onClick={() => void signOut()}>{pending ? 'Signing out…' : 'Sign out'}</button>{error && <span className="sign-out-error" role="alert">{error.message}</span>}</span>
}
