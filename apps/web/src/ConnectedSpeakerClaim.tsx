import type { AuthSession, SpeakerClaimResolveResponse } from '@confpilot/contracts'
import { type SubmitEvent, useEffect, useState } from 'react'

import { ApiError, cfpApi, speakerClaimApi } from './api'
import { asApiError, eventWorkspacePath } from './session'
import { Link } from './ui'

function ClaimError({ error }: { error: ApiError }) {
  return <div className="form-error" role="alert"><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}</div>
}

export function ConnectedSpeakerClaim() {
  const [token] = useState(() => window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '')
  const [claim, setClaim] = useState<SpeakerClaimResolveResponse | null>(null)
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
      setError(new ApiError(410, 'SPEAKER_CLAIM_UNAVAILABLE', 'This speaker account invitation link is missing or invalid.'))
      setLoading(false)
      return
    }
    let active = true
    Promise.all([
      speakerClaimApi.resolve(token),
      cfpApi.session().catch((requestError) => {
        const apiError = asApiError(requestError)
        if (apiError.code === 'UNAUTHENTICATED') return null
        throw apiError
      }),
    ]).then(([resolved, activeSession]) => {
      if (!active) return
      setClaim(resolved)
      setDisplayName(resolved.speaker.name)
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
    setPending(true); setError(null)
    try { setAccepted(await speakerClaimApi.accept(token)) }
    catch (requestError) { setError(asApiError(requestError)) }
    finally { setPending(false) }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true); setError(null)
    try {
      if (mode === 'register') {
        setAccepted(await speakerClaimApi.register({ token, displayName, password }))
      } else {
        const signedIn = await cfpApi.login({ email, password })
        if (signedIn.user.email !== claim?.email) {
          setSession(signedIn)
          throw new ApiError(403, 'SPEAKER_CLAIM_EMAIL_MISMATCH', 'This account does not match the email on the speaker profile.')
        }
        setAccepted(await speakerClaimApi.accept(token))
      }
      setPassword('')
    } catch (requestError) { setError(asApiError(requestError)) }
    finally { setPending(false) }
  }

  if (loading) return <main className="invitation-page public-state" role="status" aria-live="polite"><span aria-hidden="true">○</span><h1>Checking your speaker invitation…</h1><p>The link is removed from the address bar before account details load.</p></main>
  if (accepted && claim) return <main className="invitation-page invitation-result"><section className="section-card"><p className="overline">Speaker access ready</p><h1>Your {claim.event.name} speaker profile is claimed.</h1><p>The existing profile for <strong>{claim.speaker.name}</strong> is now attached to <strong>{accepted.user.email}</strong>. No duplicate profile was created.</p><Link className="button button-primary" to={eventWorkspacePath(claim.event.slug, 'speaker')}>Open speaker workspace →</Link></section></main>
  if (!claim) return <main className="invitation-page invitation-result"><section className="section-card"><p className="overline">Speaker account invitation</p><h1>This link cannot be used.</h1>{error && <ClaimError error={error} />}<p>Ask the event organizer to revoke the old invitation and create a replacement.</p><Link className="button button-outline" to="/">ConfPilot home</Link></section></main>

  const signedInMismatch = session && session.user.email !== claim.email
  return <main className="invitation-page"><section className="invitation-intro"><p className="overline">Speaker account invitation</p><h1>Claim your {claim.event.name} speaker profile.</h1><p>The organizer invited <strong>{claim.email}</strong> to control the existing profile for <strong>{claim.speaker.name}</strong>. This single-use link expires {new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(claim.expiresAt))} UTC.</p><aside><strong>Exact-record access</strong><span>Only the profile contact email can accept. Claiming links this account to the existing speaker record; it does not publish the profile or confirm participation.</span></aside></section><section className="section-card invitation-account-card">{session && !signedInMismatch ? <><p className="overline">Signed in</p><h2>Claim as {session.user.displayName}</h2><p>{session.user.email} matches this speaker profile.</p>{error && <ClaimError error={error} />}<button className="button button-primary" disabled={pending} onClick={() => void accept()}>{pending ? 'Claiming…' : 'Claim speaker profile'}</button></> : session && signedInMismatch ? <><p className="overline">Different account</p><h2>This account cannot claim the profile.</h2><p>You are signed in as <strong>{session.user.email}</strong>, but the profile belongs to <strong>{claim.email}</strong>.</p>{error && <ClaimError error={error} />}<button className="button button-outline" disabled={pending} onClick={() => { void cfpApi.logout().then(() => { setSession(null); setMode('signin'); setError(null) }).catch((requestError) => setError(asApiError(requestError))) }}>Use the profile email</button></> : <><div className="invitation-mode" role="group" aria-label="Account choice"><button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(null) }}>Create account</button><button type="button" aria-pressed={mode === 'signin'} onClick={() => { setMode('signin'); setError(null) }}>Sign in</button></div><form onSubmit={submit}>{mode === 'register' ? <><label>Your name<input required minLength={2} maxLength={120} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>Profile email<input readOnly value={claim.email} /></label><label>Create password<input required minLength={12} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></> : <><label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></>}{error && <ClaimError error={error} />}<button className="button button-primary" disabled={pending}>{pending ? mode === 'register' ? 'Creating account…' : 'Signing in…' : mode === 'register' ? 'Create account and claim' : 'Sign in and claim'}</button></form></>}</section></main>
}
