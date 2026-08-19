import type { AuthSession, OrganizerEventCreate } from '@confpilot/contracts'
import { lazy, ReactNode, type KeyboardEvent as ReactKeyboardEvent, type SubmitEvent, Suspense, useEffect, useRef, useState } from 'react'
import { ConnectedProgram, ConnectedPublicEmbed, InvalidPublicEmbed, SOURCE_URL } from './ConnectedProgram'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * The public program stays in the entry bundle; every authenticated surface is
 * split out.
 *
 * Anonymous attendees are the largest audience and the one most likely to be on
 * a phone on venue wifi. They can never reach the organizer, reviewer, or
 * speaker workspaces, so shipping those in the first payload is bytes nobody on
 * that path can use. Splitting costs a signed-in organizer one extra request per
 * workspace, which is the right trade.
 */
const CfpAdmin = lazy(() => import('./ConnectedCfpPages').then((module) => ({ default: module.CfpAdmin })))
const PublicCfp = lazy(() => import('./ConnectedCfpPages').then((module) => ({ default: module.PublicCfp })))
const ConnectedReviewAdmin = lazy(() => import('./ConnectedReviewPages').then((module) => ({ default: module.ConnectedReviewAdmin })))
const ConnectedReviewersAdmin = lazy(() => import('./ConnectedReviewPages').then((module) => ({ default: module.ConnectedReviewersAdmin })))
const ConnectedReviewerPortal = lazy(() => import('./ConnectedReviewPages').then((module) => ({ default: module.ConnectedReviewerPortal })))
const ConnectedSpeakerPortal = lazy(() => import('./ConnectedSpeakerPortal').then((module) => ({ default: module.ConnectedSpeakerPortal })))
const ConnectedContentAdmin = lazy(() => import('./ConnectedSpeakerContentAdmin').then((module) => ({ default: module.ConnectedContentAdmin })))
const ConnectedSpeakersAdmin = lazy(() => import('./ConnectedSpeakerContentAdmin').then((module) => ({ default: module.ConnectedSpeakersAdmin })))
const ConnectedEmbedsAdmin = lazy(() => import('./ConnectedEmbedsAdmin').then((module) => ({ default: module.ConnectedEmbedsAdmin })))
const ConnectedAgendaAdmin = lazy(() => import('./ConnectedAgendaAdmin').then((module) => ({ default: module.ConnectedAgendaAdmin })))
const ConnectedReadinessCockpit = lazy(() => import('./ConnectedReadinessCockpit').then((module) => ({ default: module.ConnectedReadinessCockpit })))
const ConnectedReviewerInvitation = lazy(() => import('./ConnectedReviewerInvitation').then((module) => ({ default: module.ConnectedReviewerInvitation })))
const ConnectedSpeakerClaim = lazy(() => import('./ConnectedSpeakerClaim').then((module) => ({ default: module.ConnectedSpeakerClaim })))
import { Link, PageHeader } from './ui'
import { AccessDenied, AuthError, hasEventRole, SignInForm, SignOutButton, useAuthSessionGate } from './auth'
import { ApiError } from './api'
import { cfpApi } from './api'
import { toContractDateTime } from './dateTime'
import { asApiError, eventWorkspacePath, DEFAULT_EVENT_SLUG, isEventSlug } from './session'
import { eventSlugForRole } from './auth'

const adminNav = [
  { label: 'Overview', section: '', related: [] },
  { label: 'Call for proposals', section: 'cfp', related: [] },
  { label: 'Proposals & reviews', section: 'abstracts', related: ['reviewers'] },
  { label: 'Speakers', section: 'speakers', related: [] },
  { label: 'Content & files', section: 'content', related: [] },
  { label: 'Schedule', section: 'agenda', related: [] },
  { label: 'Website & embeds', section: 'embeds', related: [] },
] as const

function usePath() {
  const route = () => `${window.location.pathname}${window.location.search}`
  const [path, setPath] = useState(route)
  useEffect(() => {
    const update = () => setPath(route())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return path
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className={`logo ${light ? 'logo-light' : ''}`}>
      <span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>
      ConfPilot
    </span>
  )
}

function DemoFlag() {
  return <span className="demo-flag"><span aria-hidden="true">●</span> Demo seed data</span>
}

function WorkspacePanelLoading() {
  return <main className="page role-loading" role="status" aria-live="polite">Loading workspace content…</main>
}

function Landing() {
  return (
    <main className="landing">
      <header className="landing-nav shell-width">
        <Logo />
        <nav aria-label="Primary navigation">
          <Link to="/program">Public program</Link>
          <Link to="/submit">Submit a proposal</Link>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">Open source <span aria-hidden="true">↗</span></a>
          <Link to="/admin" className="button button-dark">Open workspace <span aria-hidden="true">→</span></Link>
        </nav>
      </header>
      <section className="hero shell-width">
        <div className="hero-copy">
          <p className="eyebrow">Conference program operations</p>
          <h1>Know what’s blocking your program.</h1>
          <p className="hero-text">ConfPilot connects proposals, decisions, speaker tasks, scheduling, and publication—so your team always knows what to do next.</p>
          <div className="hero-actions">
            <Link to="/admin" className="button button-primary">Explore the demo readiness cockpit <span aria-hidden="true">→</span></Link>
            <Link to="/program" className="text-link">View the attendee program</Link>
          </div>
          <DemoFlag />
        </div>
        <div className="hero-preview" aria-label="Product preview">
          <div className="preview-bar"><i /><i /><i /><span>DevFlow Conf 2027</span></div>
          <div className="preview-body">
            <div className="preview-side"><b>Overview</b><span>Abstracts</span><span>Speakers</span><span>Agenda</span></div>
            <div className="preview-main">
              <div><small>PROGRAM READINESS</small><strong>74%</strong><span>On track</span></div>
              <div className="mini-funnel">{[100, 88, 72, 56].map((w) => <i key={w} style={{ width: `${w}%` }} />)}</div>
              <div className="mini-queue"><b>Needs attention</b><span>3 release tasks overdue</span><span>4 decisions waiting</span><span>1 schedule conflict</span></div>
            </div>
          </div>
        </div>
      </section>
      <section className="landing-proof shell-width" aria-label="Connected lifecycle">
        <p>One connected readiness trail</p>
        <div>{['Accepted', 'Profile ready', 'Deliverables ready', 'Scheduled', 'Approved', 'Published'].map((item, i) => <span key={item}>{item}{i < 5 && <b aria-hidden="true">→</b>}</span>)}</div>
      </section>
    </main>
  )
}

function localDateTimeNow() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function workspaceSlugFromName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
    .replace(/-+$/g, '')
}

const requiredEventFieldLabels: Record<string, string> = {
  name: 'Event name',
  slug: 'Workspace slug',
  startsOn: 'First event day',
  endsOn: 'Last event day',
  timeZone: 'Event time zone',
  initialTrack: 'Initial program track',
  cfpOpensAt: 'CFP opens',
  cfpClosesAt: 'CFP closes',
}

function EventCreateDialog({ trigger, onClose }: { trigger: HTMLElement | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const slugManuallyEdited = useRef(false)
  const [draft, setDraft] = useState({
    slug: '', name: '', tagline: '', location: '', description: '', startsOn: '', endsOn: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    cfpOpensAt: localDateTimeNow(), cfpClosesAt: '', initialTrack: 'General',
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => {
    const focusable = dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]')
    focusable?.focus()
    return () => trigger?.focus()
  }, [trigger])
  const close = () => { if (!pending) onClose() }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]')]
    if (!controls.length) return
    const first = controls[0]
    const last = controls.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    setError(null)
    const form = event.currentTarget as HTMLFormElement
    if (!form.checkValidity()) {
      const invalid = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(':invalid')
      const label = requiredEventFieldLabels[invalid?.name ?? ''] ?? 'highlighted'
      const message = invalid?.validity.valueMissing === false
        ? `Correct the ${label} field before creating the event.`
        : `Complete the required ${label} field before creating the event.`
      setError(new ApiError(400, 'VALIDATION_FAILED', message))
      invalid?.focus()
      return
    }
    setPending(true)
    try {
      const input: OrganizerEventCreate = {
        ...draft,
        cfpOpensAt: toContractDateTime(draft.cfpOpensAt),
        cfpClosesAt: toContractDateTime(draft.cfpClosesAt),
      }
      const created = await cfpApi.createEvent(input)
      const target = eventWorkspacePath(created.event.slug, 'admin')
      onClose()
      window.history.pushState({}, '', target)
      window.dispatchEvent(new PopStateEvent('popstate'))
      window.scrollTo(0, 0)
    } catch (requestError) {
      setError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }
  const update = (field: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  return <div className="dialog-backdrop event-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section ref={dialogRef} className="event-create-dialog" role="dialog" aria-modal="true" aria-labelledby="event-create-title" onKeyDown={onKeyDown}><button type="button" className="dialog-close" aria-label="Close event creation" disabled={pending} onClick={close}>×</button><p className="overline">New event</p><h2 id="event-create-title">Create an event workspace</h2><p>The new event starts as a private draft with a basic CFP form. You become its organizer.</p><form noValidate onSubmit={submit}><div className="event-create-grid"><label>Event name<input name="name" required maxLength={200} value={draft.name} onChange={(event) => { const name = event.target.value; setDraft((current) => ({ ...current, name, ...(!slugManuallyEdited.current && { slug: workspaceSlugFromName(name) }) })) }} /></label><label>Workspace slug<input name="slug" required maxLength={128} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="community-conf-2027" value={draft.slug} onChange={(event) => { slugManuallyEdited.current = true; update('slug', event.target.value) }} /><small>Lowercase words separated by hyphens.</small></label><label>Tagline<input maxLength={500} value={draft.tagline} onChange={(event) => update('tagline', event.target.value)} /></label><label>Location<input maxLength={500} value={draft.location} onChange={(event) => update('location', event.target.value)} /></label><label>First event day<input name="startsOn" required type="date" value={draft.startsOn} onChange={(event) => update('startsOn', event.target.value)} /></label><label>Last event day<input name="endsOn" required type="date" min={draft.startsOn || undefined} value={draft.endsOn} onChange={(event) => update('endsOn', event.target.value)} /></label><label>Event time zone<input name="timeZone" required maxLength={64} placeholder="America/Los_Angeles" value={draft.timeZone} onChange={(event) => update('timeZone', event.target.value)} /></label><label>Initial program track<input name="initialTrack" required maxLength={120} value={draft.initialTrack} onChange={(event) => update('initialTrack', event.target.value)} /></label><label>CFP opens<input name="cfpOpensAt" required type="datetime-local" value={draft.cfpOpensAt} onChange={(event) => update('cfpOpensAt', event.target.value)} /></label><label>CFP closes<input name="cfpClosesAt" required type="datetime-local" min={draft.cfpOpensAt || undefined} value={draft.cfpClosesAt} onChange={(event) => update('cfpClosesAt', event.target.value)} /></label><label className="event-create-description">Description<textarea maxLength={20_000} value={draft.description} onChange={(event) => update('description', event.target.value)} /></label></div>{error && <AuthError error={error} />}<div className="event-create-actions"><button type="button" className="button button-outline" disabled={pending} onClick={close}>Cancel</button><button className="button button-primary" disabled={pending}>{pending ? 'Creating…' : 'Create event'}</button></div></form></section></div>
}

function EventSwitcher({ eventSlug, session, closeNavigation }: { eventSlug: string; session: AuthSession; closeNavigation: () => void }) {
  const [creating, setCreating] = useState(false)
  const createTriggerRef = useRef<HTMLButtonElement>(null)
  const events = session.memberships
    .filter((membership) => membership.role === 'organizer')
    .map((membership) => membership.eventSlug)
    .sort((left, right) => left.localeCompare(right))
  return <><details className="event-switcher"><summary><span className="event-monogram">{eventSlug.slice(0, 2).toUpperCase()}</span><span><strong>{eventSlug}</strong><small>Event workspace</small></span><span aria-hidden="true">⌄</span></summary><div className="event-switcher-menu"><p>Organizer events</p>{events.map((slug) => <Link key={slug} to={eventWorkspacePath(slug, 'admin')} onClick={closeNavigation} ariaCurrent={slug === eventSlug ? 'page' : undefined}>{slug}{slug === eventSlug && <span>Current</span>}</Link>)}<button ref={createTriggerRef} type="button" onClick={() => { closeNavigation(); setCreating(true) }}>＋ Create new event</button></div></details>{creating && <EventCreateDialog trigger={createTriggerRef.current} onClose={() => setCreating(false)} />}</>
}

function AdminShell({ path, eventSlug, unscoped, session, onSignedOut, children }: { path: string; eventSlug: string; unscoped: boolean; session: AuthSession; onSignedOut: () => void; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const adminBase = unscoped ? '/admin' : eventWorkspacePath(eventSlug, 'admin')
  const programPath = eventWorkspacePath(eventSlug, 'program')
  const isIllustrativeOverview = unscoped && path === adminBase
  useEffect(() => {
    if (!mobileOpen) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [mobileOpen])
  return (
    <div className="admin-app">
      <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
        <div className="sidebar-top"><Link to="/" onClick={() => setMobileOpen(false)}><Logo light /></Link><button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button></div>
        <EventSwitcher eventSlug={eventSlug} session={session} closeNavigation={() => setMobileOpen(false)} />
        <nav className="sidebar-nav" aria-label="Workspace navigation">
          <p>Program</p>
          {adminNav.map(({ label, section, related }) => {
            const href = section ? `${adminBase}/${section}` : adminBase
            const relatedActive = related.some((candidate) => path === `${adminBase}/${candidate}` || path.startsWith(`${adminBase}/${candidate}/`))
            const active = path === href || Boolean(section && path.startsWith(`${href}/`)) || relatedActive
            return <Link key={label} to={href} onClick={() => setMobileOpen(false)} className={active ? 'active' : ''} ariaCurrent={active ? 'page' : undefined}><NavIcon label={label} />{label}</Link>
          })}
          <p>Preview</p>
          <details className="workspace-preview-menu"><summary><NavIcon label="Preview" />Preview workspaces<span aria-hidden="true">⌄</span></summary><div><Link to={programPath} onClick={() => setMobileOpen(false)}>Public program <span className="external">↗</span></Link><Link to={eventWorkspacePath(eventSlug, 'reviewer')} onClick={() => setMobileOpen(false)}>Reviewer workspace <span className="external">↗</span></Link><Link to={eventWorkspacePath(eventSlug, 'speaker')} onClick={() => setMobileOpen(false)}>Speaker workspace <span className="external">↗</span></Link></div></details>
        </nav>
        <div className="sidebar-footer"><span className="avatar">{session.user.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><span><strong>{session.user.displayName}</strong><small>Organizer</small></span><SignOutButton onSignedOut={onSignedOut} className="sidebar-sign-out" /></div>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>☰</button>
          <div><strong>{eventSlug}</strong><span>Organizer workspace</span></div>
          <div className="top-actions">{isIllustrativeOverview && <DemoFlag />}<Link to={programPath} className="button button-outline">View public program ↗</Link></div>
        </header>
        {/*
          A second boundary inside the shell, so a crash in one workspace does not
          take the navigation with it. The root boundary would leave an organizer
          on a blank page with no way out but the browser's back button; here the
          sidebar survives and they can move to another section.

          Keyed on `path` so navigating away clears the error state — otherwise a
          single failure would persist across every subsequent section.
        */}
        <ErrorBoundary key={path}>
          <Suspense fallback={<WorkspacePanelLoading />}>{children}</Suspense>
        </ErrorBoundary>
      </div>
      {mobileOpen && <button className="nav-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    </div>
  )
}

function OrganizerAccess({ path, requestedEventSlug, unscoped, children }: { path: string; requestedEventSlug?: string; unscoped: boolean; children: (eventSlug: string) => ReactNode }) {
  const auth = useAuthSessionGate()
  if (auth.checking) return <main className="role-loading" role="status" aria-live="polite">Checking your ConfPilot access…</main>
  const eventSlug = requestedEventSlug ?? (auth.activeSession ? eventSlugForRole(auth.activeSession, 'organizer') : undefined) ?? DEFAULT_EVENT_SLUG
  if (auth.activeSession && !hasEventRole(auth.activeSession, eventSlug, 'organizer')) return <AccessDenied session={auth.activeSession} onSignedOut={auth.signOut} />
  if (auth.activeSession) return <AdminShell path={path} eventSlug={eventSlug} unscoped={unscoped} session={auth.activeSession} onSignedOut={auth.signOut}>{children(eventSlug)}</AdminShell>
  const error = auth.reason === 'initial' && auth.resource.status === 'error' ? asApiError(auth.resource.error) : null
  if (error && error.code !== 'UNAUTHENTICATED') return <main className="role-empty"><span>ACCOUNT ACCESS</span><h1>Account status could not load.</h1><AuthError error={error} retry={auth.resource.reload} /></main>
  return <SignInForm eyebrow="Organizer workspace" description="Program operations are scoped to your account and this event." error={auth.reason === 'expired' ? new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Sign in again to continue.') : null} onAuthenticated={auth.authenticate} />
}

function NavIcon({ label }: { label: string }) {
  const icons: Record<string, string> = { Overview: '⌂', 'Call for proposals': '✎', 'Proposals & reviews': '▤', Speakers: '♙', 'Content & files': '▱', Schedule: '▦', 'Website & embeds': '◇', Preview: '↗' }
  return <span aria-hidden="true">{icons[label]}</span>
}

/**
 * One boundary for every split surface.
 *
 * The fallback is announced politely rather than as an alert: a workspace chunk
 * normally resolves in well under a second, and an assertive announcement on
 * every navigation would be noise for a screen reader user.
 */
export function App() {
  return (
    <Suspense fallback={<main className="public-state" aria-live="polite"><span aria-hidden="true">○</span><h1>Loading…</h1><p>Preparing this workspace.</p></main>}>
      <AppRoutes />
    </Suspense>
  )
}

function AppRoutes() {
  const route = usePath()
  const path = route.split('?')[0]!
  if (path === '/') return <Landing />
  if (path === '/reviewer-invitation') return <ConnectedReviewerInvitation />
  if (path === '/speaker-claim') return <ConnectedSpeakerClaim />
  const eventMatch = path.match(/^\/events\/([^/]+)\/(admin|submit|reviewer|speaker|program|embed)(?:\/(.*))?$/)
  if (eventMatch) {
    const [, encodedEventSlug, workspace, encodedDetail] = eventMatch
    const eventSlug = safeDecode(encodedEventSlug)
    const detail = encodedDetail ? safeDecode(encodedDetail) : undefined
    if (!isEventSlug(eventSlug)) return <NotFound />
    if (workspace === 'program' && !detail) return <ConnectedProgram key={eventSlug} eventSlug={eventSlug} />
    if (workspace === 'embed' && detail && !detail.includes('/')) return <ConnectedPublicEmbed key={`${eventSlug}:${detail}`} eventSlug={eventSlug} embedSlug={detail} />
    if (workspace === 'submit' && (!detail || !detail.includes('/'))) return <PublicCfp key={`${eventSlug}:${detail ?? ''}`} eventSlug={eventSlug} preferredProposalId={detail} />
    if (workspace === 'reviewer' && (!detail || !detail.includes('/'))) return <ConnectedReviewerPortal key={eventSlug} eventSlug={eventSlug} preferredAssignmentId={detail} />
    if (workspace === 'speaker' && !detail) return <ConnectedSpeakerPortal key={eventSlug} eventSlug={eventSlug} />
    if (workspace === 'admin') {
      const adminBase = eventWorkspacePath(eventSlug, 'admin')
      if (!isAdminPagePath(path, adminBase)) return <NotFound />
      return <OrganizerAccess key={eventSlug} path={path} requestedEventSlug={eventSlug} unscoped={false}>{(selectedEventSlug) => adminPage(path, adminBase, selectedEventSlug, false)}</OrganizerAccess>
    }
    return <NotFound />
  }
  if (path === '/program') return <ConnectedProgram eventSlug={DEFAULT_EVENT_SLUG} />
  if (path.startsWith('/embed/')) {
    const segments = path.slice('/embed/'.length).split('/').map(safeDecode)
    const [eventSlug, embedSlug] = segments
    if (segments.length === 2 && eventSlug && embedSlug && isEventSlug(eventSlug)) {
      return <ConnectedPublicEmbed eventSlug={eventSlug} embedSlug={embedSlug} />
    }
    return <InvalidPublicEmbed />
  }
  if (path === '/submit') return <PublicCfp eventSlug={DEFAULT_EVENT_SLUG} />
  const reviewerAssignmentTail = path.startsWith('/reviewer/assignments/') ? path.slice('/reviewer/assignments/'.length) : ''
  const isReviewerPath = path === '/reviewer' || Boolean(reviewerAssignmentTail && !reviewerAssignmentTail.includes('/'))
  if (isReviewerPath) return <ConnectedReviewerPortal eventSlug={DEFAULT_EVENT_SLUG} preferredAssignmentId={reviewerAssignmentTail ? safeDecode(reviewerAssignmentTail) || undefined : undefined} />
  if (path === '/speaker-portal') return <ConnectedSpeakerPortal eventSlug={DEFAULT_EVENT_SLUG} />
  const isAdminPath = path === '/admin' || path.startsWith('/admin/')
  if (!isAdminPath) return <NotFound />
  if (!isAdminPagePath(path, '/admin')) return <NotFound />
  return <OrganizerAccess path={path} unscoped>{(eventSlug) => adminPage(path, '/admin', eventSlug, true)}</OrganizerAccess>
}

function isAdminPagePath(path: string, base: string) {
  if ([base, `${base}/cfp`, `${base}/reviewers`, `${base}/speakers`, `${base}/content`, `${base}/agenda`, `${base}/embeds`, `${base}/design-system`].includes(path)) return true
  const abstractTail = path.startsWith(`${base}/abstracts/`) ? path.slice(`${base}/abstracts/`.length) : ''
  return path === `${base}/abstracts` || Boolean(abstractTail && !abstractTail.includes('/'))
}

function adminPage(path: string, base: string, eventSlug: string, unscoped: boolean) {
  const abstractTail = path.startsWith(`${base}/abstracts/`) ? path.slice(`${base}/abstracts/`.length) : ''
  const isAbstracts = path === `${base}/abstracts` || Boolean(abstractTail && !abstractTail.includes('/'))
  const abstractProposalId = abstractTail ? safeDecode(abstractTail) || undefined : undefined
  const params = new URLSearchParams(window.location.search)
  const preferredSpeakerId = params.get('speaker') ?? undefined
  const preferredSessionId = params.get('session') ?? undefined
  return path === base ? <ConnectedReadinessCockpit eventSlug={eventSlug} scoped={!unscoped} /> : path === `${base}/cfp` ? <CfpAdmin eventSlug={eventSlug} /> : isAbstracts ? <ConnectedReviewAdmin eventSlug={eventSlug} preferredProposalId={abstractProposalId} /> : path === `${base}/reviewers` ? <ConnectedReviewersAdmin eventSlug={eventSlug} /> : path === `${base}/speakers` ? <ConnectedSpeakersAdmin eventSlug={eventSlug} preferredSpeakerId={preferredSpeakerId} /> : path === `${base}/content` ? <ConnectedContentAdmin eventSlug={eventSlug} preferredSessionId={preferredSessionId} /> : path === `${base}/agenda` ? <ConnectedAgendaAdmin eventSlug={eventSlug} preferredSessionId={preferredSessionId} /> : path === `${base}/embeds` ? <ConnectedEmbedsAdmin eventSlug={eventSlug} /> : path === `${base}/design-system` ? <DesignSystem /> : <NotFound />
}

function NotFound() {
  return <main className="role-empty"><span>404</span><h1>Page not found.</h1><p>Return to ConfPilot home.</p><Link to="/" className="button button-primary">ConfPilot home</Link></main>
}

function DesignSystem() {
  const colors = [
    ['Navy', '#0A1020', 'var(--navy-900)'],
    ['Signal', '#FFD84D', 'var(--signal)'],
    ['Action', '#2F5BFF', 'var(--action)'],
    ['Paper', '#F6F7FB', 'var(--paper)'],
    ['Success', '#0F6B45', 'var(--success)'],
    ['Warning', '#9A6500', 'var(--warning-soft)'],
    ['Danger', '#D42A3E', 'var(--danger)'],
    ['Violet', '#6A2BD9', 'var(--track-violet)'],
  ]
  return (
    <main className="page">
      <PageHeader eyebrow="System · Foundations" title="ConfPilot interface foundations" description="A compact operational system: high contrast, square geometry, visible state, and consistent interaction rules." />
      <div className="design-system-grid">
        <section className="section-card design-panel">
          <p className="overline">Color roles</p><h2>Color communicates purpose</h2>
          <div className="swatch-grid">{colors.map(([name, hex, color]) => <div className="swatch" key={name} style={{ background: color, color: ['Navy','Action','Success','Danger','Violet'].includes(name) ? 'white' : 'var(--text)' }}><strong>{name}</strong><span>{hex}</span></div>)}</div>
        </section>
        <section className="section-card design-panel">
          <p className="overline">Typography</p><h2>Three voices, one hierarchy</h2>
          <p className="type-sample-display">Program desk</p>
          <p className="type-sample-body">IBM Plex Sans keeps dense operational content calm, clear, and easy to scan.</p>
          <p className="type-sample-mono">ROOM 2A · 10:15 AM · ABS-142</p>
        </section>
        <section className="section-card design-panel">
          <p className="overline">Controls and status</p><h2>Meaning survives without color</h2>
          <div className="component-row"><button className="button button-primary">Primary action →</button><button className="button button-dark">Record decision</button><button className="button button-outline">Secondary</button></div>
          <div className="component-row" style={{ marginTop: 20 }}><span className="decision decision-accept">Accepted</span><span className="severity severity-due-soon">Due soon</span><span className="severity severity-conflict">Conflict</span><DemoFlag /></div>
        </section>
        <section className="section-card design-panel">
          <p className="overline">Usage rules</p><h2>Operational before decorative</h2>
          <div className="rule-list"><div><strong>Geometry</strong><span>1px rules, 2–4px corners, almost no shadow.</span></div><div><strong>Actions</strong><span>Yellow advances the workflow; blue navigates or selects.</span></div><div><strong>States</strong><span>Every status includes text or an icon, never color alone.</span></div><div><strong>Touch</strong><span>Interactive targets are at least 44px on compact screens.</span></div></div>
        </section>
      </div>
    </main>
  )
}
