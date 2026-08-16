import type {
  AuthSession,
  CfpPublicConfigResponse,
  DeliverableRequestResponse,
  OwnerWorkspaceResponse,
  SpeakerContentWorkspaceResponse,
  SpeakerOwnedProfileUpdate,
  SpeakerProfileResponse,
} from '@confpilot/contracts'
import { type SubmitEvent, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, cfpApi, speakerApi, speakerContentApi } from './api'
import { DEFAULT_EVENT_SLUG, asApiError, eventWorkspacePath } from './session'
import { Link } from './ui'
import { useApiResource } from './useApiResource'
import { AccessDenied, eventSlugForRole, hasEventRole, SignInForm, SignOutButton, useAuthSessionGate } from './auth'

function ErrorNotice({ error, retry }: { error: ApiError; retry?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [error])
  return <div ref={ref} className="form-error connected-error" role="alert" tabIndex={-1}><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}{retry && <button type="button" className="button button-outline" onClick={retry}>Reload current data</button>}</div>
}

function SpeakerHeader({ name, onSignedOut }: { name?: string; onSignedOut?: () => void }) {
  return <header className="role-header"><div><Link to="/" className="role-logo"><span className="role-logo-mark" aria-hidden="true">▥</span> ConfPilot</Link><span className="role-badge">Speaker</span></div><div><strong>{name ?? 'Speaker workspace'}</strong><span>Private owner workspace</span></div>{onSignedOut && <SignOutButton onSignedOut={onSignedOut} />}</header>
}

function dateTime(value: string | null) {
  if (!value) return 'No due date'
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`
}

function toSpeakerProfileDraft(profile: SpeakerProfileResponse): SpeakerOwnedProfileUpdate {
  return {
    name: profile.name, contactEmail: profile.contactEmail ?? '', title: profile.title,
    company: profile.company, bio: profile.bio, socialUrls: profile.socialUrls,
    travelPreferences: profile.travelPreferences, revision: profile.revision,
  }
}

function sameSpeakerProfileDraft(left: SpeakerOwnedProfileUpdate, right: SpeakerOwnedProfileUpdate) {
  return left.name === right.name
    && left.contactEmail === right.contactEmail
    && left.title === right.title
    && left.company === right.company
    && left.bio === right.bio
    && left.socialUrls.website === right.socialUrls.website
    && left.socialUrls.linkedin === right.socialUrls.linkedin
    && left.socialUrls.x === right.socialUrls.x
    && left.travelPreferences === right.travelPreferences
}

function ProfileEditor({ eventSlug, profile, reload }: { eventSlug: string; profile: SpeakerProfileResponse; reload: () => void }) {
  const [draft, setDraft] = useState<SpeakerOwnedProfileUpdate>(() => toSpeakerProfileDraft(profile))
  const canonicalDraft = useRef(toSpeakerProfileDraft(profile))
  const [pending, setPending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    const nextCanonical = toSpeakerProfileDraft(profile)
    const previousCanonical = canonicalDraft.current
    canonicalDraft.current = nextCanonical
    setDraft((current) => sameSpeakerProfileDraft(current, previousCanonical) ? nextCanonical : current)
  }, [profile])

  const save = async (event: SubmitEvent) => {
    event.preventDefault(); setPending(true); setMessage(''); setError(null)
    const submittedDraft = draft
    try {
      const updated = await speakerContentApi.profile(eventSlug, {
        name: submittedDraft.name, contactEmail: submittedDraft.contactEmail, title: submittedDraft.title, company: submittedDraft.company,
        bio: submittedDraft.bio, socialUrls: submittedDraft.socialUrls, travelPreferences: submittedDraft.travelPreferences,
        revision: submittedDraft.revision,
      })
      const nextCanonical = toSpeakerProfileDraft(updated)
      canonicalDraft.current = nextCanonical
      setDraft((current) => sameSpeakerProfileDraft(current, submittedDraft)
        ? nextCanonical
        : { ...current, revision: nextCanonical.revision })
      setMessage('Profile saved.'); reload()
    } catch (requestError) { setError(asApiError(requestError)) }
    finally { setPending(false) }
  }

  const uploadHeadshot = async (file: File | undefined) => {
    if (!file) return
    setUploading(true); setMessage(''); setError(null)
    const requestCanonical = canonicalDraft.current
    try {
      const updated = await speakerContentApi.headshot(eventSlug, file)
      const nextCanonical = toSpeakerProfileDraft(updated)
      const latestCanonical = canonicalDraft.current
      const onlyThisMutationAdvancedCanonical = updated.revision === requestCanonical.revision + 1
        && sameSpeakerProfileDraft(nextCanonical, requestCanonical)
      canonicalDraft.current = nextCanonical
      setDraft((current) => {
        if (sameSpeakerProfileDraft(current, latestCanonical)) return nextCanonical
        return onlyThisMutationAdvancedCanonical ? { ...current, revision: updated.revision } : current
      })
      setMessage(onlyThisMutationAdvancedCanonical
        ? 'Headshot uploaded. Any unsaved profile edits remain in the form; save them separately.'
        : 'Headshot uploaded. The profile also changed elsewhere; any unsaved edits keep their original revision so they cannot overwrite that change.')
      reload()
    }
    catch (requestError) { setError(asApiError(requestError)) }
    finally { setUploading(false) }
  }

  return <section id="profile" className="section-card connected-profile-editor"><div className="card-heading"><div><p className="overline">Profile and private details</p><h2>Bio and identity</h2></div><span className={`status-badge ${profile.profileStatus === 'ready' ? 'status-live' : 'status-draft'}`}>{profile.profileStatus}</span></div><form onSubmit={save} className="speaker-profile-form"><div className="form-grid"><label>Name<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Contact email <span>Private</span><input required type="email" value={draft.contactEmail} onChange={(event) => setDraft({ ...draft, contactEmail: event.target.value })} /></label><label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label>Company<input value={draft.company} onChange={(event) => setDraft({ ...draft, company: event.target.value })} /></label><label className="wide">Biography<textarea value={draft.bio} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></label><label>Website<input type="url" value={draft.socialUrls.website ?? ''} onChange={(event) => setDraft({ ...draft, socialUrls: { ...draft.socialUrls, website: event.target.value || null } })} /></label><label>LinkedIn<input type="url" value={draft.socialUrls.linkedin ?? ''} onChange={(event) => setDraft({ ...draft, socialUrls: { ...draft.socialUrls, linkedin: event.target.value || null } })} /></label><label>X<input type="url" value={draft.socialUrls.x ?? ''} onChange={(event) => setDraft({ ...draft, socialUrls: { ...draft.socialUrls, x: event.target.value || null } })} /></label><label className="wide">Travel preferences <span>Private to organizers</span><textarea value={draft.travelPreferences} onChange={(event) => setDraft({ ...draft, travelPreferences: event.target.value })} /></label></div>{error && <ErrorNotice error={error} retry={error.status === 409 ? reload : undefined} />}<p className="save-state" aria-live="polite">{message}</p><button className="button button-dark" disabled={pending}>{pending ? 'Saving…' : 'Save profile'}</button></form><div className="headshot-control"><div><strong>Headshot</strong><span>{profile.headshot ? `${profile.headshot.originalFilename} · ${fileSize(profile.headshot.byteSize)}` : 'Optional — initials appear until you upload one'}</span></div>{profile.headshot && <a className="button button-outline" href={profile.headshot.viewPath}>View current</a>}<label className="button button-outline">{uploading ? 'Uploading…' : profile.headshot ? 'Replace headshot' : 'Upload headshot'}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(event) => void uploadHeadshot(event.target.files?.[0])} /></label>{uploading && <progress aria-label="Headshot upload progress" />}</div></section>
}

function TaskList({ eventSlug, tasks, reload }: { eventSlug: string; tasks: SpeakerContentWorkspaceResponse['sessions'][number]['tasks']; reload: () => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const mutate = async (task: typeof tasks[number]) => {
    setPending(task.id); setError(null)
    try { await speakerContentApi.task(eventSlug, task.id, { state: task.state === 'complete' ? 'open' : 'complete', revision: task.revision }); reload() }
    catch (requestError) { setError(asApiError(requestError)) }
    finally { setPending(null) }
  }
  return <section className="speaker-task-ledger"><div className="card-heading"><div><p className="overline">Your tasks</p><h3>Due work</h3></div><span className="count-pill">{tasks.filter((task) => task.state === 'open').length}</span></div>{tasks.map((task) => <article key={task.id}><span className={`task-state task-state-${task.state}`} aria-hidden="true">{task.state === 'complete' ? '✓' : task.state === 'waived' ? '—' : '○'}</span><div><strong>{task.label}</strong><small>{task.state === 'waived' ? 'Waived by organizer' : `${task.state === 'complete' ? 'Completed' : 'Due'} · ${dateTime(task.dueAt)}`}</small></div>{task.state !== 'waived' && <button type="button" className="button button-outline" disabled={pending === task.id} onClick={() => void mutate(task)}>{pending === task.id ? 'Saving…' : task.state === 'complete' ? 'Reopen' : 'Mark complete'}</button>}</article>)}{error && <ErrorNotice error={error} retry={error.status === 409 ? reload : undefined} />}</section>
}

function UploadRequest({ eventSlug, request, reload }: { eventSlug: string; request: DeliverableRequestResponse & { versions: SpeakerContentWorkspaceResponse['sessions'][number]['requests'][number]['versions'] }; reload: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const [fileInputGeneration, setFileInputGeneration] = useState(0)
  const idempotencyRef = useRef(crypto.randomUUID())
  const latest = request.versions.at(-1)
  const upload = async (event: SubmitEvent) => {
    event.preventDefault(); setError(null); setMessage('')
    if (!file) { setError(new ApiError(400, 'FILE_REQUIRED', 'Choose a file to upload.')); return }
    if (!request.allowedContentTypes.includes(file.type as never) || file.size > request.maxBytes) { setError(new ApiError(400, 'INVALID_FILE', `Use an allowed file type no larger than ${fileSize(request.maxBytes)}.`)); return }
    setPending(true)
    try { await speakerContentApi.upload(eventSlug, request.id, file, note, idempotencyRef.current); setFile(null); setFileInputGeneration((current) => current + 1); setNote(''); idempotencyRef.current = crypto.randomUUID(); setMessage('New immutable version uploaded.'); reload() }
    catch (requestError) { setError(asApiError(requestError)) }
    finally { setPending(false) }
  }
  return <article className="deliverable-request"><header><div><p className="overline">{request.requestType} · Due {dateTime(request.dueAt)}</p><h4>{request.label}</h4></div><span className={`status-badge ${latest ? 'status-live' : 'status-draft'}`}>{latest ? `V${latest.versionNumber} current` : 'Missing'}</span></header><p>{request.instructions}</p><small>{request.allowedContentTypes.map((type) => type.split('/').at(-1)).join(', ')} · maximum {fileSize(request.maxBytes)}{request.required ? ' · required' : ''}</small><div className="version-history">{request.versions.slice().reverse().map((version, index) => <div key={version.id}><span>V{version.versionNumber}</span><div><strong>{version.originalFilename}</strong><small>{version.note || 'No version note'} · {dateTime(version.uploadedAt)} · {fileSize(version.byteSize)}</small></div>{index === 0 && <b>Current</b>}<a className="button button-outline" href={version.downloadPath}>Download</a></div>)}</div>{request.active && <form className="upload-form" onSubmit={upload}><label>File<input key={fileInputGeneration} type="file" aria-label={`File for ${request.label}`} accept={request.allowedContentTypes.join(',')} onChange={(event) => { setFile(event.target.files?.[0] ?? null); idempotencyRef.current = crypto.randomUUID() }} /></label><label>Version note<input value={note} maxLength={1_000} onChange={(event) => setNote(event.target.value)} /></label>{error && <ErrorNotice error={error} />}<p className="save-state" aria-live="polite">{message}</p>{pending && <progress aria-label={`${request.label} upload progress`} />}<button className="button button-primary" disabled={pending}>{pending ? 'Uploading…' : 'Upload new version'}</button></form>}</article>
}

function CommentThread({ eventSlug, session, reload }: { eventSlug: string; session: SpeakerContentWorkspaceResponse['sessions'][number]; reload: () => void }) {
  const versions = useMemo(() => session.requests.flatMap((request) => request.versions), [session.requests])
  const [versionId, setVersionId] = useState(versions.at(-1)?.id ?? '')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => setVersionId((current) => versions.some((version) => version.id === current) ? current : versions.at(-1)?.id ?? ''), [versions])
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); setPending(true); setError(null)
    try { await speakerContentApi.comment(eventSlug, session.id, { versionId, body }); setBody(''); reload() }
    catch (requestError) { setError(asApiError(requestError)) }
    finally { setPending(false) }
  }
  return <section className="content-thread"><p className="overline">File feedback</p><h3>Conversation</h3>{session.comments.length === 0 && <p className="empty-copy">No comments yet.</p>}{session.comments.map((comment) => <article key={comment.id}><strong>{comment.author.name}<span>{comment.author.kind}</span></strong><p>{comment.body}</p><small>{dateTime(comment.createdAt)} · Version {versions.find((version) => version.id === comment.versionId)?.versionNumber ?? 'unknown'}</small></article>)}{session.reviews.map((review) => <article className={`review-note review-${review.outcome}`} key={review.id}><strong>{review.reviewerName}<span>{review.outcome.replace('_', ' ')}</span></strong><p>{review.comment}</p><small>{dateTime(review.reviewedAt)}</small></article>)}{versions.length > 0 && <form onSubmit={submit}><label>Version<select value={versionId} onChange={(event) => setVersionId(event.target.value)}>{versions.slice().reverse().map((version) => <option value={version.id} key={version.id}>V{version.versionNumber} · {version.originalFilename}</option>)}</select></label><label>Comment<textarea required value={body} onChange={(event) => setBody(event.target.value)} /></label>{error && <ErrorNotice error={error} />}<button className="button button-dark" disabled={pending}>{pending ? 'Posting…' : 'Add comment'}</button></form>}</section>
}

function ProposalHistory({ eventSlug, cfpState, cfpStatus, proposals, reloadCfp }: { eventSlug: string; cfpState: CfpPublicConfigResponse['state'] | null; cfpStatus: 'loading' | 'success' | 'error'; proposals: OwnerWorkspaceResponse | null; reloadCfp: () => void }) {
  if (!proposals) return null
  const decisionLabel = (decision: typeof proposals.proposals[number]['decision']) => decision === 'accept' ? 'Accepted' : decision === 'reject' ? 'Rejected' : decision === 'waitlist' ? 'Waitlisted' : null
  const notificationLabel = (status: typeof proposals.proposals[number]['notificationStatus']) => status === 'not_queued' ? 'Decision visible in ConfPilot; no notification saved to the outbox.' : status === 'queued' ? 'Decision visible in ConfPilot; notification saved to the outbox.' : status === 'provider_accepted' ? 'Decision visible in ConfPilot; provider accepted the notification, but delivery is unverified.' : 'Decision visible in ConfPilot; provider dispatch failed.'
  return <section id="submissions" className="section-card speaker-submissions"><p className="overline">Proposal continuity</p><h2>Your submissions</h2>{proposals.proposals.map((proposal) => {
    const editable = proposal.status === 'draft' || proposal.status === 'submitted'
    return <article key={proposal.id}><span>{proposal.publicId}</span><strong>{proposal.title}</strong><b>{decisionLabel(proposal.decision) ?? proposal.status}</b>{editable && cfpState === 'open' && <Link ariaLabel={`Edit proposal and presenters — ${proposal.publicId}: ${proposal.title}`} className="button button-outline" to={eventWorkspacePath(eventSlug, 'submit', proposal.id)}>Edit proposal and presenters</Link>}{cfpState === 'closed' && <Link ariaLabel={`View submitted proposal — ${proposal.publicId}: ${proposal.title}`} className="button button-outline" to={eventWorkspacePath(eventSlug, 'submit', proposal.id)}>View submitted proposal</Link>}{editable && cfpState === 'closed' && <small>Editing closed with the CFP.</small>}{editable && cfpState === 'upcoming' && <small>Editing opens with the CFP.</small>}{editable && cfpStatus === 'loading' && <small>Checking editing availability…</small>}{editable && cfpStatus === 'error' && <div><small>Editing availability could not be confirmed.</small><button type="button" className="button button-outline" onClick={reloadCfp}>Refresh editing status</button></div>}{proposal.decision && <small>{notificationLabel(proposal.notificationStatus)}</small>}{proposal.acceptedSession && <div className="speaker-accepted-continuity"><p className="overline">Accepted-session handoff</p><h3>{proposal.acceptedSession.title}</h3><p>{proposal.acceptedSession.track} · {proposal.acceptedSession.format} · {proposal.acceptedSession.durationMinutes} minutes</p>{proposal.acceptedSession.tasks.length > 0 && <ul>{proposal.acceptedSession.tasks.map((task) => <li key={task.id}><span className={`task-state task-state-${task.state}`} aria-hidden="true">{task.state === 'complete' ? '✓' : '○'}</span><strong>{task.label}</strong><small>{task.state}</small></li>)}</ul>}</div>}</article>
  })}</section>
}

function SpeakerWorkspace({ eventSlug, cfpState, cfpStatus, data, proposals, proposalsError, reloadCfp, reloadContent, reloadProposals }: { eventSlug: string; cfpState: CfpPublicConfigResponse['state'] | null; cfpStatus: 'loading' | 'success' | 'error'; data: SpeakerContentWorkspaceResponse; proposals: OwnerWorkspaceResponse | null; proposalsError: ApiError | null; reloadCfp: () => void; reloadContent: () => void; reloadProposals: () => void }) {
  const taskCount = data.sessions.flatMap((session) => session.tasks).filter((task) => task.state === 'complete').length
  const totalTasks = data.sessions.flatMap((session) => session.tasks).length
  return <main className="connected-speaker-workspace"><header className="portal-welcome"><div><p className="overline">{data.event.name}</p><h1>Your speaker desk</h1><p>Manage your own profile, tasks, private files, and organizer feedback.</p></div><span className="readiness-ring" role="img" aria-label={`${taskCount} complete · ${totalTasks} total`}><strong>{taskCount}</strong><small>complete · {totalTasks} total</small></span></header><nav className="speaker-anchor-nav" aria-label="Speaker workspace sections"><a href="#submissions">Submissions</a><a href="#profile">Profile</a><a href="#sessions">Sessions</a></nav>{proposalsError && <section id="submissions" className="section-card speaker-submissions"><p className="overline">Proposal continuity</p><h2>Your submissions could not refresh.</h2><ErrorNotice error={proposalsError} retry={reloadProposals} /></section>}<ProposalHistory eventSlug={eventSlug} cfpState={cfpState} cfpStatus={cfpStatus} proposals={proposals} reloadCfp={reloadCfp} /><ProfileEditor key={data.speaker.id} eventSlug={eventSlug} profile={data.speaker} reload={reloadContent} /><section id="sessions" className="speaker-session-list" aria-label="Accepted sessions">{data.sessions.map((session) => <article className="section-card speaker-content-session" key={session.id}><header><div><p className="overline">Accepted session · {session.track}</p><h2>{session.title}</h2><span>{session.format} · {session.deliverablesStatus} deliverables · {session.approvalStatus}</span></div><span className={`status-badge ${session.approvalStatus === 'approved' ? 'status-live' : 'status-draft'}`}>{session.approvalStatus.replace('_', ' ')}</span></header><TaskList eventSlug={eventSlug} tasks={session.tasks} reload={() => { reloadContent(); reloadProposals() }} /><section className="speaker-deliverables"><div className="card-heading"><div><p className="overline">Private files</p><h3>Deliverable requests</h3></div><span className="count-pill">{session.requests.length}</span></div>{session.requests.map((request) => <UploadRequest eventSlug={eventSlug} key={request.id} request={request} reload={reloadContent} />)}</section><CommentThread eventSlug={eventSlug} session={session} reload={reloadContent} /></article>)}</section></main>
}

function AuthenticatedSpeakerWorkspace({ eventSlug, session, onExpired, onSignedOut }: { eventSlug: string; session: AuthSession; onExpired: () => void; onSignedOut: () => void }) {
  const workspace = useApiResource((signal) => speakerContentApi.workspace(eventSlug, signal), [eventSlug])
  const proposals = useApiResource((signal) => speakerApi.workspace(eventSlug, signal), [eventSlug])
  const cfp = useApiResource((signal) => cfpApi.publicConfig(eventSlug, signal), [eventSlug])
  const lastWorkspace = useRef<{ eventSlug: string; data: SpeakerContentWorkspaceResponse } | null>(null)
  useEffect(() => {
    const workspaceExpired = workspace.status === 'error' && asApiError(workspace.error).code === 'UNAUTHENTICATED'
    const proposalsExpired = proposals.status === 'error' && asApiError(proposals.error).code === 'UNAUTHENTICATED'
    if (workspaceExpired || proposalsExpired) onExpired()
  }, [onExpired, proposals.error, proposals.status, workspace.error, workspace.status])
  if (workspace.status === 'success') lastWorkspace.current = { eventSlug, data: workspace.data }
  const cachedWorkspace = lastWorkspace.current?.eventSlug === eventSlug ? lastWorkspace.current.data : null
  if (workspace.status === 'loading' && cachedWorkspace === null) return <div className="role-app"><SpeakerHeader name={session.user.displayName} onSignedOut={onSignedOut} /><main className="role-loading" role="status" aria-live="polite">Loading your profile, tasks, and files…</main></div>
  const workspaceError = workspace.status === 'error' ? asApiError(workspace.error) : null
  if (workspaceError && (cachedWorkspace === null || workspaceError.code === 'UNAUTHENTICATED' || workspaceError.code === 'FORBIDDEN')) {
    const error = workspaceError
    if (error.code === 'UNAUTHENTICATED') return <div className="role-app"><SpeakerHeader /><main className="role-loading" role="status">Opening sign in…</main></div>
    if (error.code === 'FORBIDDEN') return <div className="role-app"><SpeakerHeader name={session.user.displayName} /><AccessDenied session={session} onSignedOut={onSignedOut} /></div>
    return <div className="role-app"><SpeakerHeader name={session.user.displayName} onSignedOut={onSignedOut} /><main className="role-empty"><span>SPEAKER WORKSPACE</span><h1>Your workspace could not load.</h1><ErrorNotice error={error} retry={workspace.reload} /></main></div>
  }
  const workspaceData = workspace.status === 'success' ? workspace.data : cachedWorkspace!
  return <div className="role-app"><SpeakerHeader name={workspaceData.speaker.name} onSignedOut={onSignedOut} />{workspaceError && <ErrorNotice error={workspaceError} retry={workspace.reload} />}<SpeakerWorkspace eventSlug={eventSlug} cfpState={cfp.status === 'success' ? cfp.data.state : null} cfpStatus={cfp.status} data={workspaceData} proposals={proposals.status === 'success' ? proposals.data : null} proposalsError={proposals.status === 'error' ? asApiError(proposals.error) : null} reloadCfp={cfp.reload} reloadContent={workspace.reload} reloadProposals={proposals.reload} /></div>
}

export function ConnectedSpeakerPortal({ eventSlug: requestedEventSlug }: { eventSlug?: string }) {
  const auth = useAuthSessionGate()
  if (auth.checking) return <div className="role-app"><SpeakerHeader /><main className="role-loading" role="status" aria-live="polite">Checking your ConfPilot access…</main></div>
  const sessionError = auth.reason === 'initial' && auth.resource.status === 'error' ? asApiError(auth.resource.error) : null
  if (sessionError && sessionError.code !== 'FORBIDDEN' && sessionError.code !== 'UNAUTHENTICATED') return <div className="role-app"><SpeakerHeader /><main className="role-empty"><span>ACCOUNT ACCESS</span><h1>Account status could not load.</h1><ErrorNotice error={sessionError} retry={auth.resource.reload} /></main></div>
  const eventSlug = requestedEventSlug ?? (auth.activeSession ? eventSlugForRole(auth.activeSession, 'speaker') : undefined) ?? DEFAULT_EVENT_SLUG
  if (auth.activeSession && !hasEventRole(auth.activeSession, eventSlug, 'speaker')) return <div className="role-app"><SpeakerHeader name={auth.activeSession.user.displayName} /><AccessDenied session={auth.activeSession} onSignedOut={auth.signOut} /></div>
  if (!auth.activeSession) return <div className="role-app"><SpeakerHeader /><SignInForm eyebrow="Speaker workspace" description="Your profile, tasks, private files, and feedback are scoped to this account." error={auth.reason === 'expired' ? new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Sign in again to continue.') : null} onAuthenticated={auth.authenticate} /></div>
  return <AuthenticatedSpeakerWorkspace eventSlug={eventSlug} session={auth.activeSession} onExpired={auth.expire} onSignedOut={auth.signOut} />
}
