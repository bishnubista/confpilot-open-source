import type { AuthSession, ReviewerInvitationResolveResponse } from '@confpilot/contracts'
import { type SubmitEvent, useEffect, useState } from 'react'

import { ApiError, cfpApi, reviewerInvitationApi } from './api'
import { asApiError, eventWorkspacePath } from './session'
import { Link } from './ui'

function InvitationError({ error }: { error: ApiError }) {
  return <div className="form-error" role="alert"><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}</div>
}

export function ConnectedReviewerInvitation() {
  const [token] = useState(() => window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '')
  const [invitation, setInvitation] = useState<ReviewerInvitationResolveResponse | null>(null)
  const [session, setSession] = useState<AuthSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [mode, setMode] = useState<'register' | 'signin'>('register')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState<AuthSession | null>(null)

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    if (!token) {
      setError(new ApiError(410, 'REVIEWER_INVITATION_UNAVAILABLE', 'This reviewer invitation link is missing or invalid.'))
      setLoading(false)
      return
    }
    let active = true
    Promise.all([
      reviewerInvitationApi.resolve(token),
      cfpApi.session().catch((requestError) => {
        const apiError = asApiError(requestError)
        if (apiError.code === 'UNAUTHENTICATED') return null
        throw apiError
      }),
    ]).then(([resolved, activeSession]) => {
      if (!active) return
      setInvitation(resolved)
      setDisplayName(resolved.displayName)
      setEmail(resolved.email)
      setSession(activeSession)
    }).catch((requestError) => {
      if (active) setError(asApiError(requestError))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [token])

  const accept = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      setAccepted(await reviewerInvitationApi.accept(token))
    } catch (requestError) {
      setError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if (mode === 'register') {
        setAccepted(await reviewerInvitationApi.register({ token, displayName, password }))
      } else {
        const signedIn = await cfpApi.login({ email, password })
        if (signedIn.user.email.trim().toLowerCase() !== invitation?.email.trim().toLowerCase()) {
          setSession(signedIn)
          throw new ApiError(403, 'REVIEWER_INVITATION_EMAIL_MISMATCH', 'This account does not match the email on the invitation.')
        }
        setAccepted(await reviewerInvitationApi.accept(token))
      }
      setPassword('')
    } catch (requestError) {
      setError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }

  if (loading) return <main className="invitation-page public-state" role="status" aria-live="polite"><span aria-hidden="true">○</span><h1>Checking your invitation…</h1><p>The link is removed from the address bar before account details load.</p></main>
  if (accepted && invitation) return <main className="invitation-page invitation-result"><section className="section-card"><p className="overline">Reviewer access ready</p><h1>Welcome to {invitation.event.name}.</h1><p>Your invitation was consumed and reviewer access is now attached to <strong>{accepted.user.email}</strong>.</p><Link className="button button-primary" to={eventWorkspacePath(invitation.event.slug, 'reviewer')}>Open reviewer workspace →</Link></section></main>
  if (!invitation) return <main className="invitation-page invitation-result"><section className="section-card"><p className="overline">Reviewer invitation</p><h1>This link cannot be used.</h1>{error && <InvitationError error={error} />}<p>Ask the event organizer to revoke the old invitation and create a replacement.</p><Link className="button button-outline" to="/">ConfPilot home</Link></section></main>

  const signedInMismatch = session
    && session.user.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()
  return <main className="invitation-page"><section className="invitation-intro"><p className="overline">Reviewer invitation</p><h1>Join {invitation.event.name} as a reviewer.</h1><p>The organizer invited <strong>{invitation.email}</strong>. This single-use link expires {new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(invitation.expiresAt))} UTC.</p><aside><strong>Identity-bound access</strong><span>Only the invited email can accept. Your account receives reviewer access for this event, not organizer or speaker access.</span></aside></section><section className="section-card invitation-account-card">{session && !signedInMismatch ? <><p className="overline">Signed in</p><h2>Accept as {session.user.displayName}</h2><p>{session.user.email} matches this invitation.</p>{error && <InvitationError error={error} />}<button className="button button-primary" disabled={pending} onClick={() => void accept()}>{pending ? 'Accepting…' : 'Accept reviewer invitation'}</button></> : session && signedInMismatch ? <><p className="overline">Different account</p><h2>This account cannot accept.</h2><p>You are signed in as <strong>{session.user.email}</strong>, but the invitation belongs to <strong>{invitation.email}</strong>.</p>{error && <InvitationError error={error} />}<button className="button button-outline" disabled={pending} onClick={() => { void cfpApi.logout().then(() => { setSession(null); setMode('signin'); setError(null) }).catch((requestError) => setError(asApiError(requestError))) }}>Use the invited account</button></> : <><div className="invitation-mode" role="group" aria-label="Account choice"><button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(null) }}>Create account</button><button type="button" aria-pressed={mode === 'signin'} onClick={() => { setMode('signin'); setError(null) }}>Sign in</button></div><form onSubmit={submit}>{mode === 'register' ? <><label>Your name<input required minLength={2} maxLength={120} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>Invited email<input readOnly value={invitation.email} /></label><label>Create password<input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></> : <><label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></>}{error && <InvitationError error={error} />}<button className="button button-primary" disabled={pending}>{pending ? mode === 'register' ? 'Creating account…' : 'Signing in…' : mode === 'register' ? 'Create account and accept' : 'Sign in and accept'}</button></form></>}</section></main>
}
