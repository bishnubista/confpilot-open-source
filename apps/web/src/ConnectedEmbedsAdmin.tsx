import { SubmitEvent, useEffect, useRef, useState } from 'react'
import {
  defaultEmbedAppearance,
  type AuthSession,
  type EmbedAppearance,
  type EmbedConfigCreate,
  type EmbedConfigResponse,
  type EmbedOutputFormat,
  type EmbedView,
} from '@confpilot/contracts'

import { ApiError, cfpApi, embedApi, programApi } from './api'
import { ProgramSurface } from './ConnectedProgram'
import { asApiError, isAccessError, isAuthenticationError } from './session'
import { PageHeader } from './ui'
import { useApiResource } from './useApiResource'

const VIEW_OPTIONS: Array<{ value: EmbedView; label: string }> = [
  { value: 'sessions', label: 'Sessions list' },
  { value: 'speakers', label: 'Speaker directory' },
  { value: 'agenda', label: 'Agenda table' },
  { value: 'itinerary', label: 'Day-by-day schedule' },
  { value: 'gallery', label: 'Speaker gallery' },
]

const FORMAT_OPTIONS: Array<{ value: EmbedConfigCreate['filters']['formats'][number]; label: string }> = [
  { value: 'keynote', label: 'Keynote' },
  { value: 'talk', label: 'Talk' },
  { value: 'lightning', label: 'Lightning' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'panel', label: 'Panel' },
]

interface EmbedDraft {
  id: string | null
  slug: string
  name: string
  view: EmbedView
  days: string
  tracks: string
  formats: EmbedConfigCreate['filters']['formats']
  rooms: string
  outputFormat: EmbedOutputFormat
  appearance: EmbedAppearance
  enabled: boolean
  revision: number | null
  publicPath: string | null
  jsonPath: string | null
  calendarPath: string | null
}

const EMPTY_DRAFT: EmbedDraft = {
  id: null,
  slug: '',
  name: '',
  view: 'sessions',
  days: '',
  tracks: '',
  formats: [],
  rooms: '',
  outputFormat: 'iframe',
  appearance: { ...defaultEmbedAppearance },
  enabled: false,
  revision: null,
  publicPath: null,
  jsonPath: null,
  calendarPath: null,
}

function hasOrganizerRole(session: AuthSession, eventSlug: string) {
  return session.memberships.some((membership) => membership.eventSlug === eventSlug && membership.role === 'organizer')
}

function toDraft(embed: EmbedConfigResponse): EmbedDraft {
  return {
    id: embed.id,
    slug: embed.slug,
    name: embed.name,
    view: embed.view,
    days: embed.filters.days.join('\n'),
    tracks: embed.filters.tracks.join('\n'),
    formats: embed.filters.formats,
    rooms: embed.filters.rooms.join('\n'),
    outputFormat: embed.outputFormat,
    appearance: embed.appearance,
    enabled: embed.enabled,
    revision: embed.revision,
    publicPath: embed.publicPath,
    jsonPath: embed.jsonPath,
    calendarPath: embed.calendarPath,
  }
}

function values(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function toInput(draft: EmbedDraft): EmbedConfigCreate {
  return {
    slug: draft.slug,
    name: draft.name,
    view: draft.view,
    filters: {
      days: values(draft.days),
      tracks: values(draft.tracks),
      formats: draft.formats,
      rooms: values(draft.rooms),
    },
    outputFormat: draft.outputFormat,
    appearance: draft.appearance,
    enabled: draft.enabled,
  }
}

function normalized(valuesToNormalize: string[]) {
  return [...new Set(valuesToNormalize)].sort()
}

function sameValues(left: string[], right: string[]) {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
}

function matchesSavedEmbed(draft: EmbedDraft, saved: EmbedConfigResponse) {
  const input = toInput(draft)
  return input.slug === saved.slug
    && input.name === saved.name
    && input.view === saved.view
    && sameValues(input.filters.days, saved.filters.days)
    && sameValues(input.filters.tracks, saved.filters.tracks)
    && sameValues(input.filters.formats, saved.filters.formats)
    && sameValues(input.filters.rooms, saved.filters.rooms)
    && input.outputFormat === saved.outputFormat
    && JSON.stringify(input.appearance) === JSON.stringify(saved.appearance)
    && input.enabled === saved.enabled
}

function hasNewDraftChanges(draft: EmbedDraft) {
  return JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(EMPTY_DRAFT))
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function EmbedSignIn({ eventSlug, error, onAuthenticated }: { eventSlug: string; error: ApiError; onAuthenticated: (session: AuthSession) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [loginError, setLoginError] = useState<ApiError | null>(error)
  const signIn = async (event: SubmitEvent) => {
    event.preventDefault()
    setPending(true)
    setLoginError(null)
    try {
      const session = await cfpApi.login({ email, password })
      if (!hasOrganizerRole(session, eventSlug)) throw new ApiError(403, 'FORBIDDEN', `This account is not an organizer for ${eventSlug}.`)
      setPassword('')
      onAuthenticated(session)
    } catch (requestError) {
      setLoginError(asApiError(requestError))
    } finally {
      setPending(false)
    }
  }
  if (loginError?.code === 'FORBIDDEN') return <main className="page"><PageHeader eyebrow="Distribution · Embeds" title="Access denied" description="Only event organizers can manage public embeds." /><div className="form-error" role="alert">{loginError.message}</div><button className="button button-outline" type="button" onClick={() => { setEmail(''); setPassword(''); setLoginError(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.')) }}>Use a different account</button></main>
  return <main className="page"><PageHeader eyebrow="Distribution · Embeds" title="Organizer sign in" description="Sign in to manage public program embeds." /><form className="section-card admin-auth" onSubmit={signIn}><label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{loginError && <div className="form-error" role="alert">{loginError.message}</div>}<button className="button button-primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></form></main>
}

function CopyAction({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState('')
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access unavailable')
      await navigator.clipboard.writeText(value)
      setState('Copied.')
    } catch {
      setState('Copy failed. Select and copy the value manually.')
    }
  }
  return <><button className="button button-outline" type="button" onClick={() => void copy()}>{label}</button><span className="copy-status" role="status">{state}</span></>
}

function EmbedWorkspace({ eventSlug, onUnauthorized }: { eventSlug: string; onUnauthorized: (error: ApiError) => void }) {
  const resource = useApiResource((signal) => embedApi.list(eventSlug, signal), [eventSlug])
  const previewResource = useApiResource((signal) => programApi.program(eventSlug, signal), [eventSlug])
  const [embeds, setEmbeds] = useState<EmbedConfigResponse[] | null>(null)
  const [draft, setDraft] = useState<EmbedDraft>(EMPTY_DRAFT)
  const [mobileView, setMobileView] = useState<'configure' | 'preview'>('configure')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (resource.status === 'success') {
      setEmbeds(resource.data.embeds)
      setDraft((current) => current.id === null && current.name !== '' ? current : resource.data.embeds[0] ? toDraft(resource.data.embeds[0]) : EMPTY_DRAFT)
      setError(null)
    } else if (resource.status === 'error') {
      const nextError = asApiError(resource.error)
      if (isAccessError(nextError)) onUnauthorized(nextError)
      else setError(nextError)
    }
  }, [onUnauthorized, resource.data, resource.error, resource.status])

  useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  const recoverConflict = async (embedId: string | null, conflict: ApiError) => {
    if (conflict.status !== 409 || embedId === null) return conflict
    try {
      const fresh = await embedApi.list(eventSlug)
      const latest = fresh.embeds.find((embed) => embed.id === embedId)
      if (!latest) return conflict
      setEmbeds(fresh.embeds)
      setDraft((current) => current.id === latest.id ? {
        ...current,
        revision: latest.revision,
        publicPath: latest.publicPath,
        jsonPath: latest.jsonPath,
        calendarPath: latest.calendarPath,
      } : current)
      return new ApiError(
        409,
        conflict.code,
        `${conflict.message} Reloaded version ${latest.revision}; review your preserved changes and save again.`,
        conflict.requestId,
        conflict.issues,
      )
    } catch {
      return conflict
    }
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    setMessage('')
    try {
      const input = toInput(draft)
      const saved = draft.id === null
        ? await embedApi.create(eventSlug, input)
        : await embedApi.update(eventSlug, draft.id, { name: input.name, view: input.view, filters: input.filters, outputFormat: input.outputFormat, appearance: input.appearance, enabled: input.enabled, revision: draft.revision! })
      setEmbeds((current) => draft.id === null ? [...(current ?? []), saved] : (current ?? []).map((embed) => embed.id === saved.id ? saved : embed))
      setDraft(toDraft(saved))
      setMessage(`${saved.name} saved as version ${saved.revision}.`)
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAccessError(nextError)) onUnauthorized(nextError)
      else setError(await recoverConflict(draft.id, nextError))
    } finally {
      setPending(false)
    }
  }

  const toggle = async (embed: EmbedConfigResponse, draftDirty: boolean) => {
    if (embed.id === draft.id && draftDirty) {
      setMessage('')
      setError(new ApiError(409, 'UNSAVED_EMBED_CHANGES', 'Save or discard your changes before enabling or disabling this embed.'))
      return
    }
    setPending(true)
    setError(null)
    setMessage('')
    try {
      const saved = await embedApi.update(eventSlug, embed.id, { name: embed.name, view: embed.view, filters: embed.filters, outputFormat: embed.outputFormat, appearance: embed.appearance, enabled: !embed.enabled, revision: embed.revision })
      setEmbeds((current) => (current ?? []).map((item) => item.id === saved.id ? saved : item))
      if (draft.id === saved.id) setDraft(toDraft(saved))
      setMessage(`${saved.name} ${saved.enabled ? 'enabled' : 'disabled'}.`)
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAccessError(nextError)) onUnauthorized(nextError)
      else setError(await recoverConflict(embed.id, nextError))
    } finally {
      setPending(false)
    }
  }

  if (resource.status === 'loading' && embeds === null) return <main className="page" aria-live="polite"><PageHeader eyebrow="Distribution · Embeds" title="Program embeds" description="Loading saved embed configurations…" /></main>
  if (embeds === null) return <main className="page"><PageHeader eyebrow="Distribution · Embeds" title="Embeds unavailable" description={error?.message ?? 'The embed configurations could not be loaded.'} action={<button className="button button-primary" type="button" onClick={resource.reload}>Try again</button>} /></main>

  const origin = window.location.origin
  const publicUrl = draft.publicPath ? new URL(draft.publicPath, origin).toString() : ''
  const jsonUrl = draft.jsonPath ? new URL(draft.jsonPath, origin).toString() : ''
  const calendarUrl = draft.calendarPath ? new URL(draft.calendarPath, origin).toString() : ''
  const snippet = publicUrl ? `<iframe src="${escapeAttribute(publicUrl)}" title="${escapeAttribute(draft.name)}" loading="lazy" style="width:100%;border:0;min-height:600px"></iframe>` : ''
  const primaryArtifact = draft.outputFormat === 'iframe' ? snippet : jsonUrl
  const primaryLabel = draft.outputFormat === 'iframe' ? 'Iframe snippet' : 'JSON feed URL'
  const previewFilters = toInput(draft).filters
  const savedDraft = draft.id === null ? null : embeds.find((embed) => embed.id === draft.id) ?? null
  const draftDirty = savedDraft ? !matchesSavedEmbed(draft, savedDraft) : hasNewDraftChanges(draft)
  const previewStatus = draft.id === null ? (draftDirty ? 'Unsaved' : 'New') : (draftDirty ? 'Unsaved' : 'Saved')
  const previewDescription = draft.id !== null && !draft.enabled
    ? 'Design preview · public embed disabled'
    : draft.outputFormat === 'json' ? 'Visual rendering of the JSON-backed program' : 'Rendered iframe content'
  const startNewDraft = () => {
    if (draftDirty) {
      setMessage('')
      setError(new ApiError(409, 'UNSAVED_EMBED_CHANGES', 'Save or discard your changes before starting another embed.'))
      return
    }
    setDraft({ ...EMPTY_DRAFT, appearance: { ...defaultEmbedAppearance } })
    setError(null)
    setMessage('New embed draft.')
  }
  const selectEmbed = (embed: EmbedConfigResponse) => {
    if (draftDirty) {
      setMessage('')
      setError(new ApiError(409, 'UNSAVED_EMBED_CHANGES', 'Save or discard your changes before loading a saved embed.'))
      return
    }
    setDraft(toDraft(embed))
    setError(null)
    setMessage('')
  }
  const discardChanges = () => {
    setDraft(savedDraft ? toDraft(savedDraft) : { ...EMPTY_DRAFT, appearance: { ...defaultEmbedAppearance } })
    setError(null)
    setMessage('Changes discarded.')
  }

  return <main className="page"><PageHeader eyebrow="Distribution · Embeds" title="Put the program where attendees are" description="Customize a persisted, same-origin program view while the preview updates beside you." action={<button className="button button-primary" type="button" onClick={startNewDraft}>+ Add embed</button>} />
    <div className="customization-tabs embed-customization-tabs" role="tablist" aria-label="Embed customization view"><button type="button" role="tab" aria-selected={mobileView === 'configure'} onClick={() => setMobileView('configure')}>Configure</button><button type="button" role="tab" aria-selected={mobileView === 'preview'} onClick={() => setMobileView('preview')}>Preview</button></div>
    <div className={`embed-admin-layout mobile-${mobileView}`}>
      <aside className="section-card embed-list embed-configure-pane" aria-label="Saved embeds"><div className="card-heading"><div><p className="overline">Configurations</p><h2>Saved embeds</h2></div><span className="count-pill">{embeds.length}</span></div>{embeds.length === 0 ? <div className="embed-list-empty"><strong>No embeds yet</strong><span>Create the first public program view.</span></div> : embeds.map((embed) => <article key={embed.id} className={draft.id === embed.id ? 'active' : ''}><button type="button" onClick={() => selectEmbed(embed)}><strong>{embed.name}</strong><span>{VIEW_OPTIONS.find((option) => option.value === embed.view)?.label}</span><small>Version {embed.revision} · {embed.outputFormat.toUpperCase()} · {embed.enabled ? 'Enabled' : 'Disabled'}</small></button><button className="plain-button" type="button" disabled={pending} onClick={() => void toggle(embed, draftDirty)}>{embed.enabled ? 'Disable' : 'Enable'}</button></article>)}</aside>
      <form className="section-card embed-config connected-embed-config embed-configure-pane" onSubmit={save}>
        <div className="builder-title"><div><p className="overline">{draft.id ? 'Edit configuration' : 'New configuration'}</p><h2>{draft.name || 'Untitled embed'}</h2></div>{draft.id && <span className={`status-badge ${draft.enabled ? 'status-live' : 'status-draft'}`}>● {draft.enabled ? 'Enabled' : 'Disabled'}</span>}</div>
        <div className="form-grid"><label>Name<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Slug<input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" disabled={draft.id !== null} value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} /></label><label>View<select value={draft.view} onChange={(event) => setDraft({ ...draft, view: event.target.value as EmbedView })}>{VIEW_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label>Primary web output<select aria-label="Primary web output" value={draft.outputFormat} onChange={(event) => setDraft({ ...draft, outputFormat: event.target.value as EmbedOutputFormat })}><option value="iframe">Iframe</option><option value="json">JSON</option></select><span>Every saved configuration also includes a filtered iCalendar (.ics) feed.</span></label><label className="embed-enabled-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enable after save</label><label>Days <span>(one date per line)</span><textarea className="embed-filter-values" rows={2} placeholder={'2027-05-12\n2027-05-13'} value={draft.days} onChange={(event) => setDraft({ ...draft, days: event.target.value })} /></label><label>Tracks <span>(one per line)</span><textarea className="embed-filter-values" rows={2} placeholder={'AI Engineering\nPlatform & Infra'} value={draft.tracks} onChange={(event) => setDraft({ ...draft, tracks: event.target.value })} /></label><fieldset className="embed-format-options"><legend>Formats <span>(select any)</span></legend>{FORMAT_OPTIONS.map((option) => <label key={option.value}><input type="checkbox" checked={draft.formats.includes(option.value)} onChange={(event) => setDraft({ ...draft, formats: event.target.checked ? [...draft.formats, option.value] : draft.formats.filter((value) => value !== option.value) })} /> {option.label}</label>)}</fieldset><label>Rooms <span>(one per line)</span><textarea className="embed-filter-values" rows={2} placeholder={'Main Stage\nRoom 2A'} value={draft.rooms} onChange={(event) => setDraft({ ...draft, rooms: event.target.value })} /></label></div>
        <fieldset className="embed-presentation-options"><legend>Presentation</legend><div className="form-grid"><label>Theme<select value={draft.appearance.theme} onChange={(event) => setDraft({ ...draft, appearance: { ...draft.appearance, theme: event.target.value as EmbedAppearance['theme'] } })}><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Density<select value={draft.appearance.density} onChange={(event) => setDraft({ ...draft, appearance: { ...draft.appearance, density: event.target.value as EmbedAppearance['density'] } })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label>Accent color<input aria-label="Accent color" type="color" value={draft.appearance.accentColor} onChange={(event) => setDraft({ ...draft, appearance: { ...draft.appearance, accentColor: event.target.value.toUpperCase() } })} /><span>Interactive text uses an accessible fallback when the accent lacks contrast.</span></label><label className="embed-option-check"><input type="checkbox" checked={draft.appearance.showSearch} onChange={(event) => setDraft({ ...draft, appearance: { ...draft.appearance, showSearch: event.target.checked } })} /> Show search</label><label className="embed-option-check"><input type="checkbox" checked={draft.appearance.showFilters} onChange={(event) => setDraft({ ...draft, appearance: { ...draft.appearance, showFilters: event.target.checked } })} /> Show filters</label><label className="embed-option-check"><input type="checkbox" checked={draft.appearance.showEventSummary} onChange={(event) => setDraft({ ...draft, appearance: { ...draft.appearance, showEventSummary: event.target.checked } })} /> Show event summary</label></div></fieldset>
        <p className="resource-note">Changes stay in this browser until Save. The preview never writes to D1.</p>{error && <div ref={errorRef} className="form-error" role="alert" tabIndex={-1}>{error.message}</div>}<p className="save-state" aria-live="polite">{message}</p><div className="form-actions"><button className="button button-primary" disabled={pending}>{pending ? 'Saving…' : draft.id ? 'Save changes' : 'Create embed'}</button>{draftDirty && <button className="button button-outline" type="button" disabled={pending} onClick={discardChanges}>Discard changes</button>}</div>
        {draft.id && <div className="embed-distribution"><p className="resource-note">Three durable outputs share this saved configuration and its public eligibility rules.</p><div className="code-block"><span>Primary output · {primaryLabel}</span><code>{primaryArtifact}</code><CopyAction value={primaryArtifact} label={draft.outputFormat === 'iframe' ? 'Copy iframe' : 'Copy JSON URL'} /></div><div className="feed-row"><span><small>{draft.outputFormat === 'iframe' ? 'Also available as anonymous JSON' : 'Also available as a rendered public embed'}</small><code>{draft.outputFormat === 'iframe' ? jsonUrl : publicUrl}</code></span><CopyAction value={draft.outputFormat === 'iframe' ? jsonUrl : publicUrl} label="Copy alternate" /></div><div className="feed-row"><span><small>Filtered iCalendar feed</small><code>{calendarUrl}</code></span><CopyAction value={calendarUrl} label="Copy iCal URL" /></div></div>}
      </form>
      <section className="section-card embed-preview" aria-label={`${previewStatus} embed preview`}><div><div><p className="overline">Live preview</p><small>{previewDescription}</small></div><span className={`status-badge ${previewStatus === 'Saved' ? 'status-live' : 'status-draft'}`}>● {previewStatus}</span></div>{previewResource.status === 'loading' && <div className="builder-empty" role="status"><span>LOADING</span><h3>Loading the current published program…</h3></div>}{previewResource.status === 'error' && <div className="builder-empty"><span>PREVIEW UNAVAILABLE</span><h3>{previewResource.error.message}</h3><button className="button button-outline" type="button" onClick={previewResource.reload}>Try again</button></div>}{previewResource.status === 'success' && <div className="embed-live-canvas"><ProgramSurface data={previewResource.data} fixedView={draft.view} fixedFilters={previewFilters} embedded embedName={draft.name || 'Untitled embed'} appearance={draft.appearance} /></div>}</section>
    </div>
  </main>
}

export function ConnectedEmbedsAdmin({ eventSlug }: { eventSlug: string }) {
  const resource = useApiResource((signal) => cfpApi.session(signal), [])
  const [authenticated, setAuthenticated] = useState<AuthSession | null>(null)
  const [forcedError, setForcedError] = useState<ApiError | null>(null)

  const session = authenticated ?? (resource.status === 'success' ? resource.data : null)
  if (session && hasOrganizerRole(session, eventSlug) && forcedError === null) return <EmbedWorkspace eventSlug={eventSlug} onUnauthorized={(error) => { setAuthenticated(null); setForcedError(error) }} />
  if (resource.status === 'loading' && forcedError === null) return <main className="page" aria-live="polite"><PageHeader eyebrow="Distribution · Embeds" title="Program embeds" description="Checking organizer access…" /></main>
  if (session && !hasOrganizerRole(session, eventSlug) && forcedError === null) return <EmbedSignIn eventSlug={eventSlug} error={new ApiError(403, 'FORBIDDEN', `This account is not an organizer for ${eventSlug}.`)} onAuthenticated={(next) => { setAuthenticated(next); setForcedError(null) }} />

  const resourceError = resource.status === 'error' ? asApiError(resource.error) : null
  const error = forcedError ?? resourceError ?? new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.')
  if (!isAuthenticationError(error) && error.code !== 'FORBIDDEN') return <main className="page"><PageHeader eyebrow="Distribution · Embeds" title="Access check unavailable" description={error.message} action={<button className="button button-primary" type="button" onClick={resource.reload}>Try again</button>} /></main>
  return <EmbedSignIn eventSlug={eventSlug} error={error} onAuthenticated={(next) => { setAuthenticated(next); setForcedError(null) }} />
}
