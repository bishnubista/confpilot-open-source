import type {
  AuthSession,
  DeliverableRequestCreate,
  OrganizerContentDossier,
  OrganizerSpeakerRosterResponse,
  SpeakerProfileResponse,
  SpeakerProfileUpdate,
  SpeakerReminderTemplateKey,
  SpeakerRosterIngestResponse,
} from '@confpilot/contracts'
import { createContext, type SubmitEvent, type ReactNode, useContext, useEffect, useRef, useState } from 'react'

import { ApiError, cfpApi, organizerCommunicationApi, organizerSpeakerContentApi, speakerClaimApi } from './api'
import { asApiError, eventWorkspacePath, isAccessError } from './session'
import { Link, PageHeader, TaskTabs } from './ui'
import { useApiResource } from './useApiResource'

const EventSlugContext = createContext<string | null>(null)
const SPEAKER_REMINDER_OPTIONS: readonly { key: SpeakerReminderTemplateKey; label: string; description: string }[] = [
  { key: 'speaker.readiness-reminder', label: 'Readiness reminder', description: 'Lists current incomplete profile, release, headshot, task, and deliverable items.' },
  { key: 'speaker.task-reminder', label: 'Open-task reminder', description: 'Lists current open readiness tasks and their recorded due times.' },
]

function useEventSlug() {
  const eventSlug = useContext(EventSlugContext)
  if (!eventSlug) throw new Error('Connected organizer surfaces require an event slug.')
  return eventSlug
}

function hasOrganizerRole(session: AuthSession, eventSlug: string) {
  return session.memberships.some((membership) => membership.eventSlug === eventSlug && membership.role === 'organizer')
}

function ErrorNotice({ error, reload }: { error: ApiError; reload?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [error])
  return <div ref={ref} className="form-error connected-error" role="alert" tabIndex={-1}><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}{reload && <button type="button" className="button button-outline" onClick={reload}>Reload current data</button>}</div>
}

function OrganizerSignIn({ error, onAuthenticated }: { error: ApiError; onAuthenticated: (session: AuthSession) => void }) {
  const eventSlug = useEventSlug()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [loginError, setLoginError] = useState(error)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setPending(true); setLoginError(new ApiError(401, 'UNAUTHENTICATED', ''))
    try {
      const session = await cfpApi.login({ email, password })
      if (!hasOrganizerRole(session, eventSlug)) throw new ApiError(403, 'FORBIDDEN', `This account is not an organizer for ${eventSlug}.`)
      onAuthenticated(session)
    } catch (requestError) { setLoginError(asApiError(requestError)) }
    finally { setPending(false) }
  }
  if (loginError.code === 'FORBIDDEN') return <main className="page"><PageHeader eyebrow="Program operations" title="Access denied" description="Only event organizers can manage speaker and content readiness." /><ErrorNotice error={loginError} /><button type="button" className="button button-outline" onClick={() => setLoginError(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'))}>Use a different account</button></main>
  return <main className="page"><PageHeader eyebrow="Program operations" title="Organizer sign in" description="Sign in to manage private speaker and content records." /><form className="section-card admin-auth" onSubmit={submit}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{loginError.message && <ErrorNotice error={loginError} />}<button className="button button-primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></form></main>
}

function OrganizerGate({ eventSlug, children }: { eventSlug: string; children: (onUnauthorized: (error: ApiError) => void) => ReactNode }) {
  const session = useApiResource((signal) => cfpApi.session(signal), [])
  const [authenticated, setAuthenticated] = useState<AuthSession | null>(null)
  const [forcedError, setForcedError] = useState<ApiError | null>(null)
  const active = authenticated ?? (session.status === 'success' ? session.data : null)
  if (active && hasOrganizerRole(active, eventSlug) && forcedError === null) return <>{children(setForcedError)}</>
  if (session.status === 'loading' && !forcedError) return <main className="page" role="status" aria-live="polite"><PageHeader eyebrow="Program operations" title="Loading workspace" description="Checking organizer access…" /></main>
  const resourceError = session.status === 'error' ? asApiError(session.error) : null
  const error = forcedError ?? resourceError ?? (active ? new ApiError(403, 'FORBIDDEN', `This account is not an organizer for ${eventSlug}.`) : new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'))
  if (!isAccessError(error)) return <main className="page"><PageHeader eyebrow="Program operations" title="Access check unavailable" description={error.message} action={<button className="button button-primary" onClick={session.reload}>Try again</button>} /></main>
  return <OrganizerSignIn error={error} onAuthenticated={(next) => { setAuthenticated(next); setForcedError(null) }} />
}

function dateTime(value: string | null) {
  if (!value) return 'No due date'
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

function readyLabel(value: boolean) {
  return value ? 'Ready' : 'Needs attention'
}

function approvalGateLabel(value: string) {
  return value === 'Confirm participation, complete the profile, and sign for every presenter.'
    ? 'Confirm participation, complete each profile, and complete or waive each release task.'
    : value
}

function ReadinessMark({ value }: { value: boolean }) {
  return <span className={`readiness-mark ${value ? 'ready' : 'attention'}`}><b aria-hidden="true">{value ? '✓' : '!'}</b>{readyLabel(value)}</span>
}

function TaskProgress({ tasks }: { tasks: OrganizerSpeakerRosterResponse['speakers'][number]['tasks'] }) {
  if (tasks.length === 0) return <span className="speaker-task-progress"><strong>No tasks</strong></span>
  const complete = tasks.filter((task) => task.state === 'complete').length
  const open = tasks.filter((task) => task.state === 'open').length
  return <span className="speaker-task-progress"><strong>{complete} complete · {open} open</strong><small>{tasks.map((task) => `${task.label}: ${task.state}`).join(' · ')}</small></span>
}

function ReadinessGroup({ items }: { items: Array<{ label: string; ready: boolean }> }) {
  return <span className="speaker-readiness-group">{items.map((item) => <span key={item.label}><small>{item.label}</small><ReadinessMark value={item.ready} /></span>)}</span>
}

function OrganizerHeadshot({ item }: { item: OrganizerSpeakerRosterResponse['speakers'][number] }) {
  const headshot = item.profile.headshot
  if (!headshot) return null
  return <figure className="organizer-headshot"><img src={headshot.viewPath} alt={`${item.profile.name} headshot`} loading="lazy" /><figcaption><strong>{headshot.originalFilename}</strong><time dateTime={headshot.uploadedAt}>Uploaded {dateTime(headshot.uploadedAt)}</time></figcaption></figure>
}

function SpeakerRosterIngest({ reload, onUnauthorized }: { reload: () => void; onUnauthorized: (error: ApiError) => void }) {
  const eventSlug = useEventSlug()
  const [draft, setDraft] = useState({ name: '', email: '', title: '', company: '', bio: '' })
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [result, setResult] = useState<SpeakerRosterIngestResponse | null>(null)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setPending('manual'); setError(null)
    try {
      const response = await organizerSpeakerContentApi.createSpeaker(eventSlug, draft)
      setResult(response); if (response.summary.created) { setDraft({ name: '', email: '', title: '', company: '', bio: '' }); reload() }
    } catch (requestError) { const next = asApiError(requestError); if (isAccessError(next)) onUnauthorized(next); else setError(next) }
    finally { setPending('') }
  }
  const upload = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    if (!file) return
    setPending('csv'); setError(null)
    try { const response = await organizerSpeakerContentApi.importSpeakers(eventSlug, file); setResult(response); if (response.summary.created) reload() }
    catch (requestError) { const next = asApiError(requestError); if (isAccessError(next)) onUnauthorized(next); else setError(next) }
    finally { input.value = ''; setPending('') }
  }
  return <section className="section-card speaker-roster-ingest"><header><div><p className="overline">Roster intake</p><h2>Add speakers</h2></div><label className="button button-outline">{pending === 'csv' ? 'Importing…' : 'Import CSV'}<input className="sr-only" type="file" accept=".csv,text/csv" disabled={Boolean(pending)} onChange={(event) => void upload(event.currentTarget)} /></label></header><p className="resource-note">CSV headers: name,email,title,company,bio. Name and email are required.</p><p className="resource-note"><strong>Profile intake only.</strong> Manual and CSV intake create unclaimed event profiles. No invitation or email is sent, and these profiles cannot sign in. A separately verified invitation or account-link flow is required before speaker access can be enabled.</p><form className="form-grid" onSubmit={submit}><label>Name<input required minLength={2} maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Email<input required type="email" maxLength={254} value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label><label>Title<input maxLength={160} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>Company<input maxLength={160} value={draft.company} onChange={(event) => setDraft({ ...draft, company: event.target.value })} /></label><label className="wide">Biography<textarea maxLength={4000} value={draft.bio} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></label><button className="button button-primary" disabled={Boolean(pending)}>{pending === 'manual' ? 'Adding…' : 'Add speaker'}</button></form>{error && <ErrorNotice error={error} />}{result && <div className="ingest-results" aria-live="polite"><strong>{result.summary.created} created · {result.summary.duplicate} duplicate · {result.summary.invalid} invalid · {result.summary.conflict} role conflict · {result.summary.failed} failed</strong>{result.rows.map((row) => <p key={`${row.rowNumber}:${row.code}`}>Row {row.rowNumber}{row.normalizedEmail ? ` · ${row.normalizedEmail}` : ''}: {row.message}</p>)}</div>}</section>
}

function SpeakerReminderComposer({ speakerId, onUnauthorized }: { speakerId: string; onUnauthorized: (error: ApiError) => void }) {
  const eventSlug = useEventSlug()
  const [templateKey, setTemplateKey] = useState<SpeakerReminderTemplateKey>('speaker.readiness-reminder')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const idempotencyKey = useRef(crypto.randomUUID())
  const enqueue = async () => {
    setPending(true); setError(null); setMessage('')
    try {
      const result = await organizerSpeakerContentApi.enqueueReminder(eventSlug, { speakerId, templateKey, idempotencyKey: idempotencyKey.current })
      setMessage(result.outboxState === 'queued'
        ? 'Reminder queued in the immutable outbox. This action did not send it or claim delivery.'
        : result.outboxState === 'provider_accepted'
          ? 'The provider accepted the existing outbox record; inbox delivery remains unverified.'
          : `The idempotent outbox record already has state “${result.outboxState}”. This action did not send it.`)
      idempotencyKey.current = crypto.randomUUID()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending(false) }
  }
  return <section className="speaker-reminder-composer"><p className="overline">Speaker communications</p><h3>Queue a deterministic reminder</h3><p className="resource-note">Templates use current canonical readiness data. Queueing creates an immutable outbox record; provider delivery is a separate, optionally configured operation.</p><label>Reminder template<select aria-label="Reminder template" value={templateKey} disabled={pending} onChange={(event) => { setTemplateKey(event.target.value as SpeakerReminderTemplateKey); idempotencyKey.current = crypto.randomUUID(); setMessage(''); setError(null) }}>{SPEAKER_REMINDER_OPTIONS.map((template) => <option key={template.key} value={template.key}>{template.label}</option>)}</select><small>{SPEAKER_REMINDER_OPTIONS.find((template) => template.key === templateKey)?.description}</small></label><button type="button" className="button button-primary" disabled={pending} onClick={() => void enqueue()}>{pending ? 'Queueing…' : 'Queue reminder'}</button>{error && <ErrorNotice error={error} />}{message && <p className="save-state" role="status">{message}</p>}</section>
}

function claimDeliveryLabel(state: string | null) {
  if (state === 'provider_accepted') return 'Provider accepted · inbox delivery unverified'
  if (state === 'leased') return 'Delivery attempt in progress'
  if (state === 'failed') return 'Provider attempt failed'
  if (state === 'suppressed') return 'Suppressed before delivery'
  if (state === 'queued') return 'Queued · not sent'
  return 'No delivery record'
}

function SpeakerAccountClaim({ item, onUnauthorized }: { item: OrganizerSpeakerRosterResponse['speakers'][number]; onUnauthorized: (error: ApiError) => void }) {
  const eventSlug = useEventSlug()
  const claims = useApiResource((signal) => speakerClaimApi.list(eventSlug, item.profile.id, signal), [eventSlug, item.profile.id])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [acceptPath, setAcceptPath] = useState<string | null>(null)
  const idempotencyKey = useRef(crypto.randomUUID())
  const speakerClaims = claims.status === 'success' ? claims.data.claims : []
  const active = speakerClaims.find((claim) => claim.state === 'pending')
  const latest = speakerClaims[0]

  useEffect(() => {
    if (claims.status === 'error' && isAccessError(claims.error)) onUnauthorized(asApiError(claims.error))
  }, [claims.error, claims.status, onUnauthorized])

  const create = async () => {
    setPending(true); setError(null); setAcceptPath(null)
    try {
      const result = await speakerClaimApi.create(eventSlug, { speakerId: item.profile.id, idempotencyKey: idempotencyKey.current, expiresInDays: 7 })
      setAcceptPath(result.acceptPath)
      idempotencyKey.current = crypto.randomUUID()
      claims.reload()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending(false) }
  }

  const revoke = async () => {
    if (!active) return
    setPending(true); setError(null); setAcceptPath(null)
    try { await speakerClaimApi.revoke(eventSlug, active.id); claims.reload() }
    catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending(false) }
  }

  const absoluteLink = acceptPath ? `${window.location.origin}${acceptPath}` : null
  return <section className="speaker-reminder-composer speaker-account-claim"><p className="overline">Speaker account</p><h3>{item.accountLinked ? 'Account linked' : active ? 'Invitation pending' : 'Invite this speaker'}</h3><p className="resource-note">The invitation is bound to <strong>{item.profile.contactEmail}</strong> and links an account to this exact profile. It does not create another speaker, confirm participation, or publish the profile.</p>{claims.status === 'loading' && <p role="status">Loading account access…</p>}{!item.accountLinked && !active && claims.status === 'success' && <button type="button" className="button button-primary" disabled={pending || !item.profile.contactEmail} onClick={() => void create()}>{pending ? 'Creating invitation…' : latest ? 'Create replacement invitation' : 'Create speaker invitation'}</button>}{active && <div className="invitation-ledger-row"><div><strong>Pending until {dateTime(active.expiresAt)}</strong><small>{claimDeliveryLabel(active.outboxState)}</small></div><button type="button" className="button button-outline" disabled={pending} onClick={() => void revoke()}>{pending ? 'Revoking…' : 'Revoke'}</button></div>}{item.accountLinked && <p className="save-state" role="status">This existing profile has speaker workspace access.</p>}{latest && latest.state !== 'pending' && !item.accountLinked && <p className="resource-note">Latest invitation: {latest.state} · {claimDeliveryLabel(latest.outboxState)}</p>}{absoluteLink && <label className="one-time-invitation-link">One-time speaker invitation link<input aria-label="One-time speaker invitation link" readOnly value={absoluteLink} onFocus={(event) => event.currentTarget.select()} /><small>Shown only now. Copy it before leaving or refreshing.</small></label>}{claims.status === 'error' && !isAccessError(claims.error) && <ErrorNotice error={asApiError(claims.error)} reload={claims.reload} />}{error && <ErrorNotice error={error} />}</section>
}

function SpeakerDetailBody({ item, reload, onUnauthorized }: { item: OrganizerSpeakerRosterResponse['speakers'][number]; reload: () => void; onUnauthorized: (error: ApiError) => void }) {
  const eventSlug = useEventSlug()
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const [taskLabel, setTaskLabel] = useState('')
  const [taskDue, setTaskDue] = useState('')
  const toProfileDraft = (profile: SpeakerProfileResponse): SpeakerProfileUpdate => ({
    name: profile.name, contactEmail: profile.contactEmail ?? '', title: profile.title,
    company: profile.company, bio: profile.bio, socialUrls: profile.socialUrls,
    travelPreferences: profile.travelPreferences, publicVisibility: profile.publicVisibility,
    revision: profile.revision,
  })
  const sameEditableProfileDraft = (left: SpeakerProfileUpdate, right: SpeakerProfileUpdate) => left.name === right.name
    && left.contactEmail === right.contactEmail && left.title === right.title && left.company === right.company
    && left.bio === right.bio && left.socialUrls.website === right.socialUrls.website
    && left.socialUrls.linkedin === right.socialUrls.linkedin && left.socialUrls.x === right.socialUrls.x
    && left.travelPreferences === right.travelPreferences
  const sameProfileDraft = (left: SpeakerProfileUpdate, right: SpeakerProfileUpdate) => sameEditableProfileDraft(left, right)
    && left.publicVisibility === right.publicVisibility
  const [profileDraft, setProfileDraft] = useState<SpeakerProfileUpdate>(() => toProfileDraft(item.profile))
  const canonicalDraft = useRef(toProfileDraft(item.profile))
  useEffect(() => {
    const nextCanonical = toProfileDraft(item.profile)
    const previousCanonical = canonicalDraft.current
    canonicalDraft.current = nextCanonical
    setProfileDraft((current) => sameProfileDraft(current, previousCanonical) ? nextCanonical : current)
  }, [item.profile])
  const mutate = async (key: string, action: () => Promise<unknown>) => {
    setPending(key); setError(null); setMessage('')
    try { await action(); setMessage('Saved. Reloading canonical readiness…'); reload(); return true }
    catch (requestError) { const next = asApiError(requestError); if (isAccessError(next)) onUnauthorized(next); else setError(next); return false }
    finally { setPending('') }
  }
  const mutateProfileMetadata = async (key: string, action: () => Promise<SpeakerProfileResponse>) => {
    setPending(key); setError(null); setMessage('')
    const requestCanonical = canonicalDraft.current
    try {
      const updated = await action()
      const latestCanonical = canonicalDraft.current
      const nextCanonical = toProfileDraft(updated)
      const onlyThisMutationAdvancedCanonical = updated.revision === requestCanonical.revision + 1
        && sameEditableProfileDraft(nextCanonical, requestCanonical)
      canonicalDraft.current = nextCanonical
      setProfileDraft((current) => {
        if (sameProfileDraft(current, latestCanonical)) return nextCanonical
        return onlyThisMutationAdvancedCanonical ? { ...current, publicVisibility: updated.publicVisibility, revision: updated.revision } : current
      })
      setMessage(onlyThisMutationAdvancedCanonical
        ? 'Saved canonical status. Any unsaved profile edits remain in the form; save them separately.'
        : 'Saved canonical status, but the profile also changed elsewhere. Any unsaved edits keep their original revision so they cannot overwrite that change.')
      reload()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending('') }
  }
  const saveProfile = async () => {
    setPending('profile'); setError(null); setMessage('')
    const submittedDraft = profileDraft
    try {
      const updated = await organizerSpeakerContentApi.profile(eventSlug, item.profile.id, submittedDraft)
      const nextCanonical = toProfileDraft(updated)
      canonicalDraft.current = nextCanonical
      setProfileDraft((current) => sameProfileDraft(current, submittedDraft)
        ? nextCanonical
        : { ...current, revision: nextCanonical.revision })
      setMessage('Profile saved. Reloading canonical readiness…')
      reload()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending('') }
  }
  const restoreProfile = async (historyId: string) => {
    setPending(historyId); setError(null); setMessage('')
    try {
      const updated = await organizerSpeakerContentApi.restoreSpeaker(eventSlug, item.profile.id, historyId)
      const nextCanonical = toProfileDraft(updated)
      canonicalDraft.current = nextCanonical
      setProfileDraft(nextCanonical)
      setMessage('Profile restored. Reloading canonical readiness…')
      reload()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending('') }
  }
  const uploadHeadshot = (file: File | undefined) => file && void mutateProfileMetadata('headshot', () => organizerSpeakerContentApi.headshot(eventSlug, item.profile.id, file))
  const createTask = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!taskDue || item.sessions.length === 0) return
    if (await mutate('create-task', () => organizerSpeakerContentApi.bulkTasks(eventSlug, { targets: item.sessions.map((session) => ({ speakerId: item.profile.id, sessionId: session.id })), taskKey: customTaskKey(taskLabel), label: taskLabel, dueAt: new Date(taskDue).toISOString().replace('.000Z', 'Z') }))) {
      setTaskLabel(''); setTaskDue('')
    }
  }
  return <section className="section-card organizer-speaker-detail" aria-busy={Boolean(pending)}><header><div><p className="overline">Selected speaker</p><h2>{item.profile.name}</h2><p>{item.profile.title}{item.profile.title && item.profile.company ? ' · ' : ''}{item.profile.company}</p></div><span className={`status-badge ${item.profile.publicVisibility === 'published' ? 'status-live' : 'status-draft'}`}>{item.profile.publicVisibility}</span></header><div className="speaker-detail-actions"><button className="button button-dark" disabled={Boolean(pending)} onClick={() => void mutateProfileMetadata('visibility', () => organizerSpeakerContentApi.visibility(eventSlug, item.profile.id, { publicVisibility: item.profile.publicVisibility === 'published' ? 'private' : 'published', revision: item.profile.revision }))}>{item.profile.publicVisibility === 'published' ? 'Remove profile from published program' : 'Allow profile in published program'}</button><label className="button button-outline">{pending === 'headshot' ? 'Uploading…' : item.profile.headshot ? 'Replace headshot' : 'Upload headshot'}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={Boolean(pending)} onChange={(event) => uploadHeadshot(event.target.files?.[0])} /></label>{pending === 'headshot' && <progress aria-label="Organizer headshot upload progress" />}{item.profile.headshot && <a className="button button-outline" href={item.profile.headshot.viewPath}>View headshot</a>}<label>Workflow<select value={item.profile.workflowStatus} disabled={Boolean(pending)} onChange={(event) => void mutateProfileMetadata('workflow', () => organizerSpeakerContentApi.workflow(eventSlug, item.profile.id, { status: event.target.value as 'invited' | 'confirmed' | 'declined', revision: item.profile.revision }))}><option value="invited">Awaiting confirmation (does not send email)</option><option value="confirmed">Confirmed</option><option value="declined">Declined</option></select></label></div><OrganizerHeadshot item={item} /><form className="speaker-profile-form organizer-profile-form" onSubmit={(event) => { event.preventDefault(); void saveProfile() }}><p className="overline">Organizer-editable profile</p><div className="form-grid"><label>Name<input required value={profileDraft.name} onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label><label>Contact email <span>Private</span><input required type="email" value={profileDraft.contactEmail} onChange={(event) => setProfileDraft({ ...profileDraft, contactEmail: event.target.value })} /></label><label>Title<input value={profileDraft.title} onChange={(event) => setProfileDraft({ ...profileDraft, title: event.target.value })} /></label><label>Company<input value={profileDraft.company} onChange={(event) => setProfileDraft({ ...profileDraft, company: event.target.value })} /></label><label className="wide">Biography<textarea value={profileDraft.bio} onChange={(event) => setProfileDraft({ ...profileDraft, bio: event.target.value })} /></label><label className="wide">Travel preferences <span>Private</span><textarea value={profileDraft.travelPreferences} onChange={(event) => setProfileDraft({ ...profileDraft, travelPreferences: event.target.value })} /></label></div><button className="button button-dark" disabled={Boolean(pending)}>{pending === 'profile' ? 'Saving profile…' : 'Save speaker profile'}</button></form><dl className="speaker-private-profile"><div><dt>Sessions</dt><dd>{item.sessions.map((session) => session.title).join(', ') || 'None'}</dd></div></dl><SpeakerReminderComposer speakerId={item.profile.id} onUnauthorized={onUnauthorized} /><section className="organizer-task-list"><div className="card-heading"><div><p className="overline">Readiness tasks</p><h3>Task ledger</h3></div><span className="count-pill">{item.tasks.length}</span></div>{item.tasks.map((task) => <article key={task.id}><div><strong>{task.label}</strong><small>{task.state} · {dateTime(task.dueAt)}</small></div><button className="button button-outline" disabled={Boolean(pending)} onClick={() => void mutate(task.id, () => organizerSpeakerContentApi.task(eventSlug, item.profile.id, task.id, { state: task.state === 'waived' ? 'open' : 'waived', revision: task.revision }))}>{pending === task.id ? 'Saving…' : task.state === 'waived' ? 'Reopen' : 'Waive'}</button></article>)}{item.sessions.length === 0 ? <p className="task-session-boundary" role="status">Tasks become available after this speaker is linked to an accepted session. Readiness tasks are session-specific, so no task was created.</p> : <form className="inline-task-form" onSubmit={(event) => void createTask(event)}><label>Task label<input required maxLength={200} value={taskLabel} onChange={(event) => setTaskLabel(event.target.value)} /></label><label>Due at<input required type="datetime-local" value={taskDue} onChange={(event) => setTaskDue(event.target.value)} /></label><button className="button button-primary" disabled={pending === 'create-task'}>{pending === 'create-task' ? 'Adding…' : 'Add task to sessions'}</button></form>}</section><section className="speaker-history"><p className="overline">Immutable history</p><h3>Profile changes</h3>{item.history.length === 0 && <p>No profile changes yet.</p>}{item.history.slice().reverse().map((history) => <article key={history.id}><div><strong>{history.action.replaceAll('_', ' ')}</strong><small>{history.actorName} · {dateTime(history.createdAt)} · {history.changeNote}</small></div>{history.action === 'headshot_uploaded' ? <span className="audit-only">Audit only</span> : <button className="button button-outline" disabled={Boolean(pending)} onClick={() => void restoreProfile(history.id)}>Restore</button>}</article>)}</section>{error && <ErrorNotice error={error} reload={error.status === 409 ? reload : undefined} />}<p className="save-state" aria-live="polite">{message}</p></section>
}

function SpeakerTaskDeadlinePanel({
  item,
  reload,
  onUnauthorized,
}: {
  item: OrganizerSpeakerRosterResponse['speakers'][number]
  reload: () => void
  onUnauthorized: (error: ApiError) => void
}) {
  const eventSlug = useEventSlug()
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const openTasks = item.tasks.filter((task) => task.state === 'open')
  const submit = async (
    event: SubmitEvent,
    task: OrganizerSpeakerRosterResponse['speakers'][number]['tasks'][number],
  ) => {
    event.preventDefault()
    const value = new FormData(event.currentTarget as HTMLFormElement).get('dueAt')
    if (typeof value !== 'string' || !value) return
    setPending(task.id); setError(null); setMessage('')
    try {
      await organizerSpeakerContentApi.task(eventSlug, item.profile.id, task.id, {
        state: 'open',
        dueAt: new Date(value).toISOString().replace('.000Z', 'Z'),
        revision: task.revision,
      })
      setMessage(`Deadline saved for ${task.label}.`)
      reload()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending('') }
  }
  if (openTasks.length === 0) return null
  return <section className="section-card task-deadline-panel" aria-labelledby="task-deadline-heading"><div className="card-heading"><div><p className="overline">Readiness controls</p><h3 id="task-deadline-heading">Task deadlines</h3></div><span className="count-pill">{openTasks.filter((task) => !task.dueAt).length} missing</span></div><p className="resource-note">Set explicit deadlines on the existing readiness tasks. This changes the task ledger only; it does not send a reminder.</p>{openTasks.map((task) => <form key={task.id} className="inline-task-form" onSubmit={(event) => void submit(event, task)}><label>{task.label}<input name="dueAt" required type="datetime-local" /></label><span>{task.dueAt ? `Current: ${dateTime(task.dueAt)}` : 'Deadline not set'}</span><button className="button button-outline" disabled={Boolean(pending)}>{pending === task.id ? 'Saving…' : task.dueAt ? 'Change deadline' : 'Set deadline'}</button></form>)}{error && <ErrorNotice error={error} reload={error.status === 409 ? reload : undefined} />}{message && <p className="save-state" role="status">{message}</p>}</section>
}

function SpeakerDetail(props: { item: OrganizerSpeakerRosterResponse['speakers'][number]; reload: () => void; onUnauthorized: (error: ApiError) => void }) {
  return <><SpeakerAccountClaim item={props.item} onUnauthorized={props.onUnauthorized} /><SpeakerDetailBody {...props} /><SpeakerTaskDeadlinePanel {...props} /></>
}

function communicationStatusLabel(status: 'queued' | 'sending' | 'retrying' | 'provider_accepted' | 'failed' | 'canceled') {
  if (status === 'provider_accepted') return 'Provider accepted · delivery unverified'
  if (status === 'sending') return 'Sending attempt in progress'
  if (status === 'retrying') return 'Queued for retry'
  if (status === 'canceled') return 'Suppressed before delivery'
  if (status === 'failed') return 'Provider attempt failed'
  return 'Queued · not yet attempted'
}

function customTaskKey(label: string) {
  const normalized = label.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'
  let hash = 2_166_136_261
  for (const character of normalized) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return `custom-${slug}-${(hash >>> 0).toString(36)}`
}

function speakerIdentityLabel(speaker: OrganizerSpeakerRosterResponse['speakers'][number]) {
  return `${speaker.profile.name} (${speaker.profile.contactEmail ?? `no contact email · ID ${speaker.profile.id}`})`
}

function communicationSkipReason(reason: 'not_found' | 'contact_email_missing' | 'idempotency_conflict') {
  if (reason === 'contact_email_missing') return 'contact email missing'
  if (reason === 'idempotency_conflict') return 'already queued with different content'
  return 'speaker record not found'
}

function communicationPreview(
  template: string,
  speaker: OrganizerSpeakerRosterResponse['speakers'][number],
  eventSlug: string,
) {
  const replacements: Record<string, string> = {
    first_name: speaker.profile.name.trim().split(/\s+/)[0] || speaker.profile.name,
    session_title: speaker.sessions[0]?.title ?? 'your ConfPilot session',
    portal_link: new URL(`/events/${encodeURIComponent(eventSlug)}/speaker`, window.location.origin).toString(),
  }
  return template.replace(/\{(first_name|session_title|portal_link)\}/g, (_, token: string) => replacements[token])
}

function SpeakerCommunicationPanel({
  speakers,
  visibleSpeakerIds,
  selectedSpeakerIds,
  onSelection,
  onUnauthorized,
}: {
  speakers: OrganizerSpeakerRosterResponse['speakers']
  visibleSpeakerIds: string[]
  selectedSpeakerIds: Set<string>
  onSelection: (speakerIds: Set<string>) => void
  onUnauthorized: (error: ApiError) => void
}) {
  const eventSlug = useEventSlug()
  const history = useApiResource((signal) => organizerCommunicationApi.history(eventSlug, signal), [eventSlug])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const requestKey = useRef(crypto.randomUUID())
  const selectionKey = [...selectedSpeakerIds].sort().join('\u0000')
  useEffect(() => { requestKey.current = crypto.randomUUID() }, [selectionKey, subject, body])
  useEffect(() => {
    if (history.status === 'error' && isAccessError(history.error)) onUnauthorized(asApiError(history.error))
  }, [history.error, history.status, onUnauthorized])

  const selected = speakers.filter((speaker) => selectedSpeakerIds.has(speaker.profile.id))
  const previews = selected.slice(0, 3).map((speaker) => {
    const renderedBody = communicationPreview(body, speaker, eventSlug).trim()
    const content = body.includes('{first_name}') ? renderedBody : `Hello ${speaker.profile.name},\n\n${renderedBody}`
    return {
      speaker,
      subject: communicationPreview(subject, speaker, eventSlug),
      body: `${content}\n\nThis message was sent by an organizer through ConfPilot.`,
    }
  })
  const queue = async (event: SubmitEvent) => {
    event.preventDefault()
    if (selected.length === 0) return
    setPending(true); setError(null); setMessage('')
    try {
      const result = await organizerCommunicationApi.enqueueSpeakers(eventSlug, {
        speakerIds: selected.map((speaker) => speaker.profile.id),
        subject,
        body,
        idempotencyKey: requestKey.current,
      })
      const skippedDetails = result.skipped.map((skip) => {
        const speaker = selected.find((candidate) => candidate.profile.id === skip.speakerId)
        return `${speaker ? speakerIdentityLabel(speaker) : `Speaker ID ${skip.speakerId}`}: ${communicationSkipReason(skip.reason)}`
      })
      setMessage(`${result.queuedCount} message${result.queuedCount === 1 ? '' : 's'} queued${skippedDetails.length ? ` · Skipped ${skippedDetails.join('; ')}` : ''}. Queued does not mean sent or delivered.`)
      setSubject(''); setBody(''); onSelection(new Set()); requestKey.current = crypto.randomUUID(); history.reload()
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending(false) }
  }
  const capability = history.status === 'success' ? history.data.capability : null
  const visibleSelected = visibleSpeakerIds.every((id) => selectedSpeakerIds.has(id)) && visibleSpeakerIds.length > 0
  const toggleVisibleSelection = () => {
    if (!visibleSelected) { onSelection(new Set(visibleSpeakerIds)); return }
    const visible = new Set(visibleSpeakerIds)
    onSelection(new Set([...selectedSpeakerIds].filter((id) => !visible.has(id))))
  }
  return <section className="section-card communication-control" aria-labelledby="speaker-communication-heading"><div className="card-heading"><div><p className="overline">Speaker communications</p><h2 id="speaker-communication-heading">Message selected speakers</h2></div><span className="count-pill">{selected.length} selected</span></div><p className="resource-note">Choose individual speakers or everyone in the current filter. ConfPilot saves the exact recipient and message when queued, so the audience cannot change later. Use this for conference operations, not marketing newsletters.</p><div className="communication-selection-actions"><button type="button" className="button button-outline" disabled={visibleSpeakerIds.length === 0} onClick={toggleVisibleSelection}>{visibleSelected ? 'Clear visible selection' : `Select filtered (${visibleSpeakerIds.length})`}</button><button type="button" className="button button-outline" disabled={selectedSpeakerIds.size === 0} onClick={() => onSelection(new Set())}>Clear all</button><span>{selected.map(speakerIdentityLabel).join(', ') || 'No recipients selected'}</span></div><form className="communication-compose" onSubmit={(event) => void queue(event)}><label>Subject<input required maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea required maxLength={20_000} value={body} onChange={(event) => setBody(event.target.value)} /></label><p className="resource-note">Merge fields: <code>{'{first_name}'}</code> <code>{'{session_title}'}</code> <code>{'{portal_link}'}</code>. ConfPilot fills them from each selected speaker’s record.</p>{previews.length > 0 && (subject || body) && <section className="communication-preview" aria-label="Per-recipient message preview"><p className="overline">Per-recipient preview</p>{previews.map((preview) => <article key={preview.speaker.profile.id}><strong>{preview.speaker.profile.name} · {preview.subject || 'No subject yet'}</strong><pre>{preview.body}</pre></article>)}{selected.length > previews.length && <small>Previewing 3 of {selected.length} recipients.</small>}</section>}<button className="button button-primary" disabled={pending || selected.length === 0}>{pending ? 'Queueing messages…' : `Queue ${selected.length || ''} message${selected.length === 1 ? '' : 's'}`.replace('  ', ' ')}</button></form>{error && <ErrorNotice error={error} />}{message && <p className="save-state" role="status">{message}</p>}<div className={`communication-capability ${capability?.enabled ? 'enabled' : 'disabled'}`}><strong>{capability?.enabled ? `Email sending enabled · ${capability.provider}` : 'Automatic email sending is off'}</strong><span>{capability?.enabled ? `Messages queued after ${dateTime(capability.sendAfter)} can be sent. Provider acceptance is recorded, but inbox delivery cannot be confirmed.` : 'Queued messages stay in ConfPilot until an operator enables a sender and delivery schedule.'}</span></div><div className="communication-history"><div className="card-heading"><div><p className="overline">Message history</p><h3>Recent queued messages</h3></div>{history.status === 'success' && <span className="count-pill">{history.data.messages.length}</span>}</div>{history.status === 'loading' && <p role="status">Loading message history…</p>}{history.status === 'error' && !isAccessError(history.error) && <ErrorNotice error={asApiError(history.error)} reload={history.reload} />}{history.status === 'success' && history.data.messages.length === 0 && <p>No messages have been queued yet.</p>}{history.status === 'success' && history.data.messages.map((item) => <article key={item.id}><div><strong>{item.subject}</strong><span>{item.recipient.name} · {item.recipient.email}</span><small>{dateTime(item.createdAt)} · {item.intent.replaceAll('_', ' ')}</small></div><div><span className={`status-badge communication-${item.transportStatus}`}>{communicationStatusLabel(item.transportStatus)}</span><small>{item.attemptCount} send attempt{item.attemptCount === 1 ? '' : 's'}{item.lastErrorCode ? ` · ${item.lastErrorCode}` : ''}</small></div></article>)}</div></section>
}

function SpeakerRoster({ onUnauthorized, preferredSpeakerId }: { onUnauthorized: (error: ApiError) => void; preferredSpeakerId?: string }) {
  const eventSlug = useEventSlug()
  const resource = useApiResource((signal) => organizerSpeakerContentApi.roster(eventSlug, signal), [eventSlug])
  const lastRoster = useRef<{ eventSlug: string; data: OrganizerSpeakerRosterResponse } | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'ready' | 'attention'>('all')
  const [workflow, setWorkflow] = useState<'all' | 'invited' | 'confirmed' | 'declined'>('all')
  const [selectedId, setSelectedId] = useState(preferredSpeakerId ?? '')
  const [activeTab, setActiveTab] = useState<'readiness' | 'tasks' | 'messages' | 'add'>(preferredSpeakerId ? 'tasks' : 'readiness')
  const [selectedSpeakerIds, setSelectedSpeakerIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (preferredSpeakerId) { setSelectedId(preferredSpeakerId); setActiveTab('tasks') }
  }, [preferredSpeakerId])
  useEffect(() => { if (resource.status === 'error' && isAccessError(resource.error)) onUnauthorized(asApiError(resource.error)) }, [onUnauthorized, resource.error, resource.status])
  if (resource.status === 'success') lastRoster.current = { eventSlug, data: resource.data }
  const cachedRoster = lastRoster.current?.eventSlug === eventSlug ? lastRoster.current.data : null
  if (resource.status === 'loading' && cachedRoster === null) return <main className="page" role="status"><PageHeader eyebrow="Program · Speakers" title="Speaker readiness" description="Loading the live roster…" /></main>
  const rosterError = resource.status === 'error' ? asApiError(resource.error) : null
  if (rosterError && (cachedRoster === null || isAccessError(rosterError))) return <main className="page"><PageHeader eyebrow="Program · Speakers" title="Roster unavailable" description={rosterError.message} action={<button className="button button-primary" onClick={resource.reload}>Try again</button>} /></main>
  const roster = resource.status === 'success' ? resource.data : cachedRoster!
  const rows = roster.speakers.filter((item) => {
    const allReady = Object.values(item.readiness).filter((value) => typeof value === 'boolean').every(Boolean)
    const matchesReadiness = filter === 'all' || (filter === 'ready' ? allReady : !allReady)
    const matchesWorkflow = workflow === 'all' || item.profile.workflowStatus === workflow
    return `${item.profile.name} ${item.profile.contactEmail ?? ''} ${item.profile.title} ${item.profile.company}`.toLowerCase().includes(query.toLowerCase()) && matchesReadiness && matchesWorkflow
  })
  const filterLabel = filter === 'all' ? 'All speakers' : filter === 'ready' ? 'Ready' : 'Needs attention'
  const selected = roster.speakers.find((item) => item.profile.id === selectedId) ?? rows[0] ?? roster.speakers[0]
  const toggleSpeaker = (speakerId: string) => {
    const next = new Set(selectedSpeakerIds)
    if (next.has(speakerId)) next.delete(speakerId); else next.add(speakerId)
    setSelectedSpeakerIds(next)
  }
  const filters = <div className="speaker-roster-filters"><label className="search"><span aria-hidden="true">⌕</span><input aria-label="Search speakers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search speakers" /></label><label>Speaker readiness<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">All speakers</option><option value="ready">Ready</option><option value="attention">Needs attention</option></select></label><label>Workflow status<select value={workflow} onChange={(event) => setWorkflow(event.target.value as typeof workflow)}><option value="all">All statuses</option><option value="invited">Awaiting confirmation</option><option value="confirmed">Confirmed</option><option value="declined">Declined</option></select></label><p className={`active-content-filter filter-${filter}`} role="status" aria-label="Active readiness filter">{filterLabel} · {rows.length} of {roster.speakers.length}</p></div>
  const rosterTable = <section className="section-card connected-speaker-roster"><p className="table-scroll-note">Scroll sideways to see tasks, session checks, and due dates.</p><div className="table-wrap" role="region" aria-label="Speaker readiness roster" tabIndex={0}><table><thead><tr>{['Speaker', 'Profile readiness', 'Tasks', 'Session readiness', 'Next due'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{rows.map((item) => { const identity = speakerIdentityLabel(item); return <tr key={item.profile.id} data-speaker-id={item.profile.id} className={selected?.profile.id === item.profile.id ? 'selected-row' : ''}><td><button type="button" className="person-cell" aria-label={`Open ${identity}`} onClick={() => { setSelectedId(item.profile.id); setActiveTab('tasks') }}><span className="avatar avatar-soft">{item.profile.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><span><strong>{item.profile.name}</strong><small>{item.profile.contactEmail ?? `No contact email · ID ${item.profile.id}`}</small><small>{item.sessions.length} {item.sessions.length === 1 ? 'session' : 'sessions'}</small></span></button></td><td><ReadinessGroup items={[{ label: 'Profile', ready: item.readiness.profileReady }, { label: 'Headshot', ready: item.readiness.headshotReady }, { label: 'Biography', ready: Boolean(item.profile.bio) }, { label: 'Public profile', ready: item.profile.publicVisibility === 'published' }]} /></td><td><TaskProgress tasks={item.tasks} /></td><td><ReadinessGroup items={[{ label: 'Release', ready: item.readiness.agreementReady }, { label: 'Files', ready: item.readiness.deliverablesReady }, { label: 'Approval', ready: item.sessions.every((session) => session.approvalStatus === 'approved') }]} /></td><td>{dateTime(item.readiness.nextDueAt)}</td></tr> })}</tbody></table></div>{rows.length === 0 && <div className="empty-state"><h3>No speakers match</h3><p>Change the search, speaker-readiness, or workflow filter.</p></div>}</section>
  const messageRecipients = <section className="section-card communication-recipients" aria-labelledby="communication-recipients-heading"><div className="card-heading"><div><p className="overline">Recipients</p><h2 id="communication-recipients-heading">Choose speakers</h2></div><span className="count-pill">{selectedSpeakerIds.size}</span></div><div>{rows.map((item) => { const identity = speakerIdentityLabel(item); return <label key={item.profile.id}><input type="checkbox" aria-label={`Select ${identity} for communication`} checked={selectedSpeakerIds.has(item.profile.id)} onChange={() => toggleSpeaker(item.profile.id)} /><span><strong>{item.profile.name}</strong><small>{item.profile.contactEmail ?? `No contact email · ID ${item.profile.id}`}</small></span></label> })}</div>{rows.length === 0 && <p>No speakers match the current filters.</p>}</section>
  return <main className="page"><PageHeader eyebrow="Program · Speakers" title="Speaker readiness" description="Find blocked speakers first, then open profile, task, message, or intake tools when needed." action={<Link to={`${eventWorkspacePath(eventSlug, 'admin')}/content`} className="button button-outline">Content approvals</Link>} />{rosterError && <ErrorNotice error={rosterError} reload={resource.reload} />}<TaskTabs label="Speaker workflow" active={activeTab} onChange={(tab) => setActiveTab(tab as typeof activeTab)} tabs={[{ id: 'readiness', label: 'Readiness' }, { id: 'tasks', label: 'Profile & tasks' }, { id: 'messages', label: 'Messages' }, { id: 'add', label: 'Add / import' }]} />{activeTab === 'readiness' && <>{filters}{rosterTable}</>}{activeTab === 'tasks' && <>{roster.speakers.length > 0 && <label className="section-card speaker-task-selector">Speaker<select aria-label="Speaker profile and tasks" value={selected?.profile.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>{roster.speakers.map((item) => <option key={item.profile.id} value={item.profile.id}>{speakerIdentityLabel(item)}</option>)}</select></label>}{selected && <SpeakerDetail key={selected.profile.id} item={selected} reload={resource.reload} onUnauthorized={onUnauthorized} />}</>}{activeTab === 'messages' && <>{filters}{messageRecipients}<SpeakerCommunicationPanel speakers={roster.speakers} visibleSpeakerIds={rows.map((item) => item.profile.id)} selectedSpeakerIds={selectedSpeakerIds} onSelection={setSelectedSpeakerIds} onUnauthorized={onUnauthorized} /></>}{activeTab === 'add' && <SpeakerRosterIngest reload={resource.reload} onUnauthorized={onUnauthorized} />}</main>
}

type ContentMutation = (key: string, action: () => Promise<unknown>) => Promise<boolean>

function ContentLibrary({ sessions }: { sessions: OrganizerContentDossier[] }) {
  const entries = sessions.flatMap((session) => session.versions.map((version) => {
    const request = session.requests.find((candidate) => candidate.id === version.requestId)
    const latestVersion = Math.max(
      ...session.versions
        .filter((candidate) => candidate.requestId === version.requestId)
        .map((candidate) => candidate.versionNumber),
    )
    return { session, request, version, current: version.versionNumber === latestVersion }
  })).sort((left, right) => right.version.uploadedAt.localeCompare(left.version.uploadedAt)
    || left.session.title.localeCompare(right.session.title)
    || right.version.versionNumber - left.version.versionNumber
    || left.version.id.localeCompare(right.version.id))

  return <section className="section-card content-library" aria-labelledby="content-library-heading"><div className="card-heading"><div><p className="overline">Private files</p><h2 id="content-library-heading">Content library</h2></div><span className="count-pill">{entries.length}</span></div><p className="resource-note">Every submitted deliverable version remains available to organizers. Downloads use the authenticated private-file route; the ZIP export remains limited to each active request&apos;s current approved version.</p>{entries.length === 0 ? <div className="empty-state"><h3>No deliverable versions</h3><p>Uploaded presentation files will appear here without replacing earlier versions.</p></div> : <div className="table-wrap" role="region" aria-label="All deliverable versions" tabIndex={0}><table><thead><tr><th scope="col">Session</th><th scope="col">Deliverable</th><th scope="col">Version</th><th scope="col">File</th><th scope="col">Uploaded</th><th scope="col">Action</th></tr></thead><tbody>{entries.map(({ session, request, version, current }) => <tr key={version.id}><td><strong>{session.title}</strong></td><td>{request?.label ?? 'Unknown request'}</td><td><span className={`status-badge ${current ? 'status-live' : 'status-draft'}`}>V{version.versionNumber} · {current ? 'Current' : 'Previous'}</span></td><td><strong>{version.originalFilename}</strong><small>{version.note || 'No version note'} · {fileSize(version.byteSize)}</small></td><td><time dateTime={version.uploadedAt}>{dateTime(version.uploadedAt)}</time><small>{version.uploader.name}</small></td><td><a className="button button-outline" href={version.downloadPath}>Download V{version.versionNumber}</a></td></tr>)}</tbody></table></div>}</section>
}

function SessionEditor({ session, mutate }: { session: OrganizerContentDossier; mutate: ContentMutation }) {
  const eventSlug = useEventSlug()
  const [draft, setDraft] = useState({ title: session.title, abstract: session.abstract, track: session.track, format: session.format, durationMinutes: session.durationMinutes, changeNote: '' })
  return <form className="section-card content-session-editor" onSubmit={(event) => { event.preventDefault(); mutate('session', () => organizerSpeakerContentApi.updateSession(eventSlug, session.id, { ...draft, expectedRevision: session.revision })) }}><p className="overline">Session continuity</p><h2>Edit accepted content</h2><div className="form-grid"><label className="wide">Title<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label className="wide">Abstract<textarea required value={draft.abstract} onChange={(event) => setDraft({ ...draft, abstract: event.target.value })} /></label><label>Track<input required value={draft.track} onChange={(event) => setDraft({ ...draft, track: event.target.value })} /></label><label>Format<select value={draft.format} onChange={(event) => setDraft({ ...draft, format: event.target.value as typeof draft.format })}>{['keynote', 'talk', 'lightning', 'workshop', 'panel'].map((value) => <option key={value}>{value}</option>)}</select></label><label>Duration minutes<input type="number" min="1" max="480" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })} /></label><label>Change note<input required value={draft.changeNote} onChange={(event) => setDraft({ ...draft, changeNote: event.target.value })} /></label></div><button className="button button-dark">Save session revision</button></form>
}

function RequestCreator({ session, mutate }: { session: OrganizerContentDossier; mutate: ContentMutation }) {
  const eventSlug = useEventSlug()
  const [label, setLabel] = useState('Upload session presentation')
  const [dueAt, setDueAt] = useState('')
  const [instructions, setInstructions] = useState('Upload the latest approved file.')
  const requestKeyRef = useRef(`presentation-${crypto.randomUUID()}`)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const submittedDueAt = new FormData(event.currentTarget as HTMLFormElement).get('dueAt')
    const dueDate = new Date(typeof submittedDueAt === 'string' ? submittedDueAt : '')
    if (!Number.isFinite(dueDate.getTime())) return
    const common = { requestKey: requestKeyRef.current, label, instructions, dueAt: dueDate.toISOString().replace('.000Z', 'Z'), maxBytes: 10 * 1024 * 1024, required: true }
    const input: DeliverableRequestCreate = { ...common, requestType: 'presentation', allowedContentTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'] }
    if (await mutate('request-create', () => organizerSpeakerContentApi.createRequest(eventSlug, session.id, input))) {
      setDueAt(''); requestKeyRef.current = `presentation-${crypto.randomUUID()}`
    }
  }
  return <form className="content-request-create" onSubmit={(event) => void submit(event)}><p className="overline">New presentation deliverable</p><div className="form-grid"><label>Label<input required value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>Due at<input name="dueAt" required type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label><label>Instructions<input value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label></div><p className="field-help">Speaker headshots are managed per speaker in the profile workspace.</p><button className="button button-primary">Create request</button></form>
}

function ReviewControls({ session, mutate }: { session: OrganizerContentDossier; mutate: ContentMutation }) {
  const eventSlug = useEventSlug()
  const [comments, setComments] = useState<Record<string, string>>({})
  const idempotencyKeys = useRef<Record<string, string>>({})
  const review = async (versionId: string, outcome: 'changes_requested' | 'approved') => {
    const key = `${versionId}:${outcome}`
    idempotencyKeys.current[key] ??= crypto.randomUUID()
    if (await mutate(`${outcome}-${versionId}`, () => organizerSpeakerContentApi.review(eventSlug, session.id, { versionId, idempotencyKey: idempotencyKeys.current[key], outcome, comment: comments[versionId], expectedSessionRevision: session.revision }))) {
      delete idempotencyKeys.current[key]
      setComments((current) => ({ ...current, [versionId]: '' }))
    }
  }
  return <section className="content-review-controls"><div className="card-heading"><div><p className="overline">Latest versions</p><h3>Review files</h3></div></div>{session.requests.map((request) => {
    const versions = session.versions.filter((version) => version.requestId === request.id)
    const latest = versions.sort((left, right) => right.versionNumber - left.versionNumber)[0]
    if (!latest) return <article key={request.id}><div><strong>{request.label}</strong><small>No version submitted</small></div></article>
    return <article key={request.id}><div><strong>{request.label} · V{latest.versionNumber}</strong><small>{latest.originalFilename} · {latest.uploader.name}</small></div><a className="button button-outline" href={latest.downloadPath}>Download</a><label>Review comment<textarea required value={comments[latest.id] ?? ''} onChange={(event) => setComments({ ...comments, [latest.id]: event.target.value })} /></label><div><button className="button button-outline" disabled={!comments[latest.id]?.trim()} onClick={() => void review(latest.id, 'changes_requested')}>Request changes</button><button className="button button-primary" disabled={!comments[latest.id]?.trim()} onClick={() => void review(latest.id, 'approved')}>Approve version</button></div></article>
  })}</section>
}

function ContentCommentComposer({ session, mutate }: { session: OrganizerContentDossier; mutate: ContentMutation }) {
  const eventSlug = useEventSlug()
  const [versionId, setVersionId] = useState(session.versions.at(-1)?.id ?? '')
  const [body, setBody] = useState('')
  useEffect(() => setVersionId(session.versions.at(-1)?.id ?? ''), [session])
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await mutate('comment', () => organizerSpeakerContentApi.comment(eventSlug, session.id, { versionId, body }))) setBody('')
  }
  return <section className="content-thread"><p className="overline">Conversation</p><h3>Version comments</h3>{session.comments.map((comment) => <article key={comment.id}><strong>{comment.author.name}<span>{comment.author.kind}</span></strong><p>{comment.body}</p><small>{dateTime(comment.createdAt)}</small></article>)}{session.reviews.map((review) => <article className={`review-note review-${review.outcome}`} key={review.id}><strong>{review.reviewerName}<span>{review.outcome.replace('_', ' ')}</span></strong><p>{review.comment}</p><small>{dateTime(review.reviewedAt)}</small></article>)}{session.versions.length > 0 && <form onSubmit={(event) => void submit(event)}><label>Version<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{session.versions.slice().reverse().map((version) => <option value={version.id} key={version.id}>V{version.versionNumber} · {version.originalFilename}</option>)}</select></label><label>Comment<textarea required value={body} onChange={(event) => setBody(event.target.value)} /></label><button className="button button-dark">Add comment</button></form>}</section>
}

function ContentDossier({ session, view, reload, onUnauthorized }: { session: OrganizerContentDossier; view: 'approval' | 'files' | 'history'; reload: () => void; onUnauthorized: (error: ApiError) => void }) {
  const eventSlug = useEventSlug()
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const mutate: ContentMutation = async (key, action) => {
    setPending(key); setError(null); setMessage('')
    try { await action(); setMessage('Saved. Reloading canonical content state…'); reload(); return true }
    catch (requestError) { const next = asApiError(requestError); if (isAccessError(next)) onUnauthorized(next); else setError(next); return false }
    finally { setPending('') }
  }
  const gatesId = `approval-gates-${session.id}`
  const approved = session.approvalStatus === 'approved'
  const approvalBlocked = !approved && session.unmetApprovalGates.length > 0
  const approvalGateLabels = session.unmetApprovalGates.map(approvalGateLabel)
  const approvalGateTitle = approvalGateLabels.map((gate) => gate.replace(/[.;]+$/, '')).join('; ')
  return <div className="content-dossier-connected" aria-busy={Boolean(pending)}><header className="section-card content-readiness-summary"><div><p className="overline">Accepted session · {session.track}</p><h2>{session.title}</h2><p>{session.presenters.map((speaker) => speaker.name).join(', ')}</p></div><span className={`status-badge ${approved ? 'status-live' : 'status-draft'}`}>{session.approvalStatus.replace('_', ' ')}</span><div className="approval-gates" id={gatesId}><strong>{session.unmetApprovalGates.length === 0 ? 'Ready for approval' : `${session.unmetApprovalGates.length} approval ${session.unmetApprovalGates.length === 1 ? 'step remains' : 'steps remain'}`}</strong>{session.unmetApprovalGates.length > 0 && <ul>{approvalGateLabels.map((gate) => <li key={gate}>{gate}</li>)}</ul>}</div><div className="content-approval-action"><button className={approved ? 'button button-outline' : 'button button-primary'} disabled={Boolean(pending) || approvalBlocked} aria-describedby={gatesId} title={approvalBlocked ? approvalGateTitle : undefined} onClick={() => void mutate('approval', () => organizerSpeakerContentApi.approval(eventSlug, session.id, { approvalStatus: approved ? 'pending' : 'approved', expectedRevision: session.revision }))}>{pending === 'approval' ? 'Saving approval…' : approved ? 'Move approval to pending' : 'Approve content'}</button>{approvalBlocked && <small>Complete the steps above before approval.</small>}</div></header>{view === 'approval' && <SessionEditor key={`${session.id}:${session.revision}`} session={session} mutate={mutate} />}{view === 'files' && <><section className="section-card content-files-panel"><div className="card-heading"><div><p className="overline">File requests</p><h2>Files and versions</h2></div><span className="count-pill">{session.versions.length}</span></div>{session.requests.map((request) => <article className="content-request-row" key={request.id}><div><strong>{request.label}</strong><small>{request.active ? 'Active' : 'Inactive'} · due {dateTime(request.dueAt)} · {request.required ? 'required' : 'optional'}</small></div><button className="button button-outline" onClick={() => void mutate(request.id, () => organizerSpeakerContentApi.updateRequest(eventSlug, session.id, request.id, { label: request.label, instructions: request.instructions, dueAt: request.dueAt, allowedContentTypes: request.allowedContentTypes, maxBytes: request.maxBytes, required: request.required, active: !request.active, revision: request.revision }))}>{request.active ? 'Deactivate' : 'Activate'}</button></article>)}<RequestCreator session={session} mutate={mutate} /><ReviewControls session={session} mutate={mutate} /></section><ContentCommentComposer session={session} mutate={mutate} /></>}{view === 'history' && <section className="section-card content-history"><p className="overline">Change history</p><h2>Session history</h2><p className="history-restore-help">Each entry shows the content saved before that change. Restoring replaces the current title, abstract, track, format, and duration with the values shown, while preserving the current version in this history.</p>{session.history.length === 0 && <p>No content edits yet.</p>}{session.history.slice().reverse().map((history) => <article key={history.id}><div><span className="history-snapshot-kind">{history.action === 'restored' ? 'Before a restore' : 'Before an edit'}</span><strong>{history.title}</strong><small>{history.actorName} · {dateTime(history.createdAt)} · {history.changeNote}</small><p className="history-snapshot-abstract"><b>Abstract</b><span>{history.abstract}</span></p><small>{history.track} · {history.format} · {history.durationMinutes} minutes</small></div><button className="button button-outline" onClick={() => void mutate(history.id, () => organizerSpeakerContentApi.restoreSession(eventSlug, session.id, history.id))}>Restore this version</button></article>)}</section>}{error && <ErrorNotice error={error} reload={error.status === 409 ? reload : undefined} />}<p className="save-state" aria-live="polite">{message}</p></div>
}

function ContentOperations({ onUnauthorized, preferredSessionId }: { onUnauthorized: (error: ApiError) => void; preferredSessionId?: string }) {
  const eventSlug = useEventSlug()
  const resource = useApiResource((signal) => organizerSpeakerContentApi.content(eventSlug, signal), [eventSlug])
  const [selectedId, setSelectedId] = useState(preferredSessionId ?? '')
  const [activeTab, setActiveTab] = useState<'approval' | 'files' | 'history'>('approval')
  useEffect(() => {
    if (preferredSessionId) setSelectedId(preferredSessionId)
  }, [preferredSessionId])
  useEffect(() => { if (resource.status === 'error' && isAccessError(resource.error)) onUnauthorized(asApiError(resource.error)) }, [onUnauthorized, resource.error, resource.status])
  if (resource.status === 'loading') return <main className="page" role="status"><PageHeader eyebrow="Program · Content" title="Content & files" description="Loading accepted sessions…" /></main>
  if (resource.status === 'error') return <main className="page"><PageHeader eyebrow="Program · Content" title="Content unavailable" description={resource.error.message} action={<button className="button button-primary" onClick={resource.reload}>Try again</button>} /></main>
  const selected = resource.data.sessions.find((session) => session.id === selectedId)
    ?? resource.data.sessions.find((session) => session.approvalStatus !== 'approved')
    ?? resource.data.sessions[0]
  return <main className="page"><PageHeader eyebrow="Program · Content" title="Content & files" description="Approve session details, review current files, or inspect earlier changes." action={<a className="button button-dark" href={resource.data.approvedDeliverablesArchivePath}>Download approved files (.zip)</a>} /><TaskTabs label="Content workflow" active={activeTab} onChange={(tab) => setActiveTab(tab as typeof activeTab)} tabs={[{ id: 'approval', label: 'Needs approval' }, { id: 'files', label: 'Current files' }, { id: 'history', label: 'History' }]} />{activeTab === 'files' && <ContentLibrary sessions={resource.data.sessions} />}<div className="content-operations-layout"><aside className="section-card content-session-list"><div className="card-heading"><div><p className="overline">Accepted sessions</p><h2>Sessions</h2></div><span className="count-pill">{resource.data.sessions.length}</span></div>{resource.data.sessions.map((session) => <button type="button" className={selected?.id === session.id ? 'active' : ''} key={session.id} onClick={() => setSelectedId(session.id)}><strong>{session.title}</strong><small>{session.deliverablesStatus} · {session.approvalStatus.replace('_', ' ')}</small></button>)}</aside>{selected ? <ContentDossier session={selected} view={activeTab} reload={resource.reload} onUnauthorized={onUnauthorized} /> : <section className="section-card empty-state"><h2>No accepted sessions</h2><p>Accepted sessions will appear after decisions are recorded.</p></section>}</div></main>
}

export function ConnectedSpeakersAdmin({ eventSlug, preferredSpeakerId }: { eventSlug: string; preferredSpeakerId?: string }) {
  return <EventSlugContext.Provider value={eventSlug}><OrganizerGate eventSlug={eventSlug}>{(onUnauthorized) => <SpeakerRoster onUnauthorized={onUnauthorized} preferredSpeakerId={preferredSpeakerId} />}</OrganizerGate></EventSlugContext.Provider>
}

export function ConnectedContentAdmin({ eventSlug, preferredSessionId }: { eventSlug: string; preferredSessionId?: string }) {
  return <EventSlugContext.Provider value={eventSlug}><OrganizerGate eventSlug={eventSlug}>{(onUnauthorized) => <ContentOperations onUnauthorized={onUnauthorized} preferredSessionId={preferredSessionId} />}</OrganizerGate></EventSlugContext.Provider>
}
