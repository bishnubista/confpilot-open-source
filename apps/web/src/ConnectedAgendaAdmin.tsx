import type {
  AgendaDayResponse,
  AgendaResponse,
  AgendaSessionResponse,
  AgendaTrackColor,
  AuthSession,
} from '@confpilot/contracts'
import { type CSSProperties, type SubmitEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'

import { agendaApi, ApiError, cfpApi } from './api'
import { asApiError, isAccessError, isAuthenticationError } from './session'
import { PageHeader } from './ui'
import { useApiResource } from './useApiResource'

const TRACK_COLORS: Record<AgendaTrackColor, string> = {
  plum: 'var(--track-violet)',
  blue: 'var(--track-blue)',
  gold: 'var(--track-gold)',
  teal: 'var(--success)',
  coral: 'var(--danger)',
  slate: 'var(--navy-700)',
}

function hasOrganizerRole(session: AuthSession, eventSlug: string) {
  return session.memberships.some((membership) => membership.eventSlug === eventSlug && membership.role === 'organizer')
}

function formatDay(date: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`))
}

function formatTime(timestamp: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone })
    .format(new Date(timestamp))
}

function formatDateTime(timestamp: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone,
  }).format(new Date(timestamp))
}

function eventLocalTimestamp(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const desired = Date.UTC(year!, month! - 1, day!, hour!, minute!)
  let instant = desired
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    instant += desired - rendered
  }
  return new Date(instant).toISOString().replace('.000Z', 'Z')
}

function slotStarts(day: AgendaDayResponse, durationMinutes = 0) {
  const values: string[] = []
  const close = Date.parse(day.closesAt)
  const step = day.slotMinutes * 60_000
  for (let value = Date.parse(day.opensAt); value + durationMinutes * 60_000 <= close; value += step) {
    values.push(new Date(value).toISOString().replace('.000Z', 'Z'))
  }
  return values
}

function trackStyle(track: string, data: AgendaResponse) {
  const color = data.tracks.find((item) => item.name === track)?.color ?? 'slate'
  return { '--agenda-track': TRACK_COLORS[color] } as CSSProperties
}

function ErrorNotice({ error, retry }: { error: ApiError; retry?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [error])
  return <div ref={ref} className="form-error connected-error agenda-error" role="alert" tabIndex={-1}><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}{retry && <button type="button" className="button button-outline" onClick={retry}>Reload agenda</button>}</div>
}

function AgendaSignIn({ eventSlug, error, onAuthenticated }: { eventSlug: string; error: ApiError; onAuthenticated: (session: AuthSession) => void }) {
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
  if (loginError?.code === 'FORBIDDEN') return <main className="page"><PageHeader eyebrow="Program · Agenda" title="Access denied" description="Only event organizers can manage the agenda." /><ErrorNotice error={loginError} /><button type="button" className="button button-outline" onClick={() => setLoginError(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'))}>Use a different account</button></main>
  return <main className="page"><PageHeader eyebrow="Program · Agenda" title="Organizer sign in" description="Sign in to schedule accepted sessions and publish the live program." /><form className="section-card admin-auth" onSubmit={signIn}><label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{loginError && <ErrorNotice error={loginError} />}<button className="button button-primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></form></main>
}

interface PlacementDraft {
  dayId: string
  roomId: string
  startsAt: string
}

function SessionPlacementDialog({ data, session, error, pending, trigger, onClose, onSave, onUnplace }: {
  data: AgendaResponse
  session: AgendaSessionResponse
  error: ApiError | null
  pending: boolean
  trigger: HTMLElement | null
  onClose: () => void
  onSave: (draft: PlacementDraft) => Promise<boolean>
  onUnplace: () => Promise<boolean>
}) {
  const initialDay = data.days.find((day) => day.id === session.placement?.dayId) ?? data.days[0]
  const [draft, setDraft] = useState<PlacementDraft>({
    dayId: initialDay?.id ?? '',
    roomId: session.placement?.roomId ?? data.rooms[0]?.id ?? '',
    startsAt: session.placement?.startsAt ?? (initialDay ? slotStarts(initialDay, session.durationMinutes)[0] ?? '' : ''),
  })
  const dialogRef = useRef<HTMLElement>(null)
  const day = data.days.find((item) => item.id === draft.dayId) ?? data.days[0]
  const starts = day ? slotStarts(day, session.durationMinutes) : []
  const displayedStarts = draft.startsAt && !starts.includes(draft.startsAt)
    ? [...starts, draft.startsAt].sort()
    : starts

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('button:not([disabled]), select:not([disabled])')?.focus()
    return () => trigger?.focus()
  }, [trigger])

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled])')]
    if (!controls.length) return
    const first = controls[0]!
    const last = controls.at(-1)!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await onSave(draft)) onClose()
  }

  return <div className="dialog-backdrop agenda-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="agenda-dialog" role="dialog" aria-modal="true" aria-labelledby="agenda-dialog-title" onKeyDown={onKeyDown}><button type="button" className="dialog-close" aria-label="Close placement dialog" onClick={onClose}>×</button><p className="overline">{session.placement ? 'Move session' : 'Schedule session'}</p><h2 id="agenda-dialog-title">{session.title}</h2><p>{session.presenters.map((presenter) => presenter.name).join(' · ')} · {session.durationMinutes} minutes</p><form onSubmit={submit}><label>Day<select value={draft.dayId} onChange={(event) => { const nextDay = data.days.find((item) => item.id === event.target.value); setDraft((current) => ({ ...current, dayId: event.target.value, startsAt: nextDay ? slotStarts(nextDay, session.durationMinutes)[0] ?? '' : '' })) }}>{data.days.map((item) => <option key={item.id} value={item.id}>{formatDay(item.date)}</option>)}</select></label><label>Room<select required value={draft.roomId} onChange={(event) => setDraft({ ...draft, roomId: event.target.value })}>{data.rooms.map((room) => <option key={room.id} value={room.id}>{room.name} · {room.capacity} seats</option>)}</select></label><label>Start time<select required value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}>{displayedStarts.map((value) => <option key={value} value={value}>{formatTime(value, data.event.timeZone)}{starts.includes(value) ? '' : ' · off-grid time'}</option>)}</select></label>{error && <ErrorNotice error={error} />}<div className="agenda-dialog-actions">{session.placement && <button type="button" className="button button-outline agenda-unplace" disabled={pending} onClick={() => void onUnplace().then((removed) => { if (removed) onClose() })}>Remove from agenda</button>}<span /><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={pending || !draft.dayId || !draft.roomId || !draft.startsAt}>{pending ? 'Saving…' : session.placement ? 'Save move' : 'Place session'}</button></div></form></section></div>
}

function AgendaBoard({ data, activeDay, onDay, onSession }: {
  data: AgendaResponse
  activeDay: AgendaDayResponse
  onDay: (dayId: string) => void
  onSession: (session: AgendaSessionResponse, trigger: HTMLElement) => void
}) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const slots = slotStarts(activeDay)
  const scheduled = data.sessions.filter((session) => session.placement?.dayId === activeDay.id)
  const conflicted = new Set(data.conflicts.flatMap((conflict) => conflict.sessionIds))
  const roomIndex = new Map(data.rooms.map((room, index) => [room.id, index]))
  const slotIndex = new Map(slots.map((slot, index) => [slot, index]))
  const gridStyle = {
    gridTemplateColumns: `84px repeat(${Math.max(data.rooms.length, 1)}, minmax(168px, 1fr))`,
    gridTemplateRows: `52px repeat(${slots.length}, 54px)`,
    minWidth: `${84 + Math.max(data.rooms.length, 1) * 168}px`,
  } as CSSProperties

  const selectDay = (dayId: string) => {
    onDay(dayId)
    tabRefs.current.get(dayId)?.focus()
  }
  const onTabsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = data.days.findIndex((day) => day.id === activeDay.id)
    if (currentIndex < 0 || data.days.length === 0) return
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % data.days.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + data.days.length) % data.days.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = data.days.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    selectDay(data.days[nextIndex]!.id)
  }

  return <section className="section-card connected-agenda-board"><div className="agenda-day-tabs" role="tablist" aria-label="Agenda day" onKeyDown={onTabsKeyDown}>{data.days.map((day) => <button ref={(node) => { if (node) tabRefs.current.set(day.id, node); else tabRefs.current.delete(day.id) }} key={day.id} role="tab" aria-selected={activeDay.id === day.id} aria-controls="connected-agenda-panel" tabIndex={activeDay.id === day.id ? 0 : -1} className={activeDay.id === day.id ? 'active' : ''} onClick={() => onDay(day.id)}><span>Day {day.dayNumber}</span>{formatDay(day.date)}</button>)}</div><div className="agenda-track-key" aria-label="Track legend">{data.tracks.map((track) => <span key={track.id}><i style={{ background: TRACK_COLORS[track.color] }} />{track.name}</span>)}</div>{data.rooms.length > 3 && <p id="agenda-scroll-hint" className="agenda-scroll-hint">More rooms continue horizontally. Scroll the schedule or focus it and use Shift + mouse wheel.</p>}<div id="connected-agenda-panel" role="tabpanel" className="connected-agenda-scroll" aria-label={`${formatDay(activeDay.date)} schedule`} aria-describedby={data.rooms.length > 3 ? 'agenda-scroll-hint' : undefined} tabIndex={0}><div className="agenda-builder-grid" style={gridStyle}><div className="agenda-grid-corner" style={{ gridColumn: 1, gridRow: 1 }}>Time</div>{data.rooms.map((room, index) => <div className="agenda-grid-room" key={room.id} style={{ gridColumn: index + 2, gridRow: 1 }}><strong>{room.name}</strong><span>{room.capacity} seats</span></div>)}{slots.map((slot, index) => <div className="agenda-grid-time" key={slot} style={{ gridColumn: 1, gridRow: index + 2 }}>{formatTime(slot, data.event.timeZone)}</div>)}{slots.flatMap((slot, row) => data.rooms.map((room, column) => <div aria-hidden="true" className="agenda-grid-cell" key={`${slot}-${room.id}`} style={{ gridColumn: column + 2, gridRow: row + 2 }} />))}{scheduled.map((session) => {
    const placement = session.placement!
    const column = roomIndex.get(placement.roomId)
    if (column === undefined) return null
    const step = activeDay.slotMinutes * 60_000
    const offset = Date.parse(placement.startsAt) - Date.parse(activeDay.opensAt)
    const exactRow = slotIndex.get(placement.startsAt)
    const row = exactRow ?? Math.floor(offset / step)
    if (row < 0 || row >= slots.length) return null
    const offsetWithinRow = exactRow === undefined ? offset - row * step : 0
    const span = Math.max(1, Math.ceil((offsetWithinRow + session.durationMinutes * 60_000) / step))
    const offGrid = exactRow === undefined
    return <button type="button" key={session.id} className={`connected-agenda-session ${conflicted.has(session.id) ? 'has-conflict' : ''} ${offGrid ? 'is-off-grid' : ''}`} style={{ ...trackStyle(session.track, data), gridColumn: column + 2, gridRow: `${row + 2} / span ${span}` }} onClick={(event) => onSession(session, event.currentTarget)}><small>{formatTime(placement.startsAt, data.event.timeZone)}–{formatTime(placement.endsAt, data.event.timeZone)}</small><strong>{session.title}</strong><span>{session.presenters.map((presenter) => presenter.name).join(', ')}</span><em>{session.track}</em>{offGrid && <b>Off-grid time</b>}{conflicted.has(session.id) && <b>Speaker conflict</b>}</button>
  })}</div><div className="agenda-mobile-list">{scheduled.length === 0 ? <p>No sessions scheduled for this day.</p> : scheduled.sort((left, right) => left.placement!.startsAt.localeCompare(right.placement!.startsAt)).map((session) => <button type="button" key={session.id} style={trackStyle(session.track, data)} className={`agenda-mobile-session ${conflicted.has(session.id) ? 'has-conflict' : ''}`} onClick={(event) => onSession(session, event.currentTarget)}><span><small>{formatTime(session.placement!.startsAt, data.event.timeZone)}–{formatTime(session.placement!.endsAt, data.event.timeZone)} · {data.rooms.find((room) => room.id === session.placement!.roomId)?.name}</small><strong>{session.title}</strong><em>{session.presenters.map((presenter) => presenter.name).join(', ')}</em></span><b aria-hidden="true">→</b></button>)}</div></div></section>
}

function SetupPanel({ eventSlug, data, pending, mutate }: {
  eventSlug: string
  data: AgendaResponse
  pending: boolean
  mutate: (label: string, request: () => Promise<AgendaResponse>) => Promise<boolean>
}) {
  const [roomName, setRoomName] = useState('')
  const [capacity, setCapacity] = useState('100')
  const [trackName, setTrackName] = useState('')
  const [color, setColor] = useState<AgendaTrackColor>('teal')
  const addRoom = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await mutate(`${roomName} added.`, () => agendaApi.createRoom(eventSlug, {
      name: roomName, capacity: Number(capacity), sortOrder: data.rooms.length + 1,
    }))) { setRoomName(''); setCapacity('100') }
  }
  const addTrack = async (event: SubmitEvent) => {
    event.preventDefault()
    if (await mutate(`${trackName} added.`, () => agendaApi.createTrack(eventSlug, {
      name: trackName, color, sortOrder: data.tracks.length + 1,
    }))) { setTrackName(''); setColor('teal') }
  }
  return <details className="section-card agenda-setup"><summary><span><small>Configuration</small><strong>Rooms and tracks</strong></span><b>{data.rooms.length} rooms · {data.tracks.length} tracks</b></summary><div><form onSubmit={addRoom}><p className="overline">Add room</p><label>Room name<input required maxLength={160} value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label><label>Capacity<input required min={1} max={100000} type="number" value={capacity} onChange={(event) => setCapacity(event.target.value)} /></label><button className="button button-outline" disabled={pending}>Add room</button></form><form onSubmit={addTrack}><p className="overline">Add track</p><label>Track name<input required maxLength={160} value={trackName} onChange={(event) => setTrackName(event.target.value)} /></label><label>Color<select value={color} onChange={(event) => setColor(event.target.value as AgendaTrackColor)}>{Object.keys(TRACK_COLORS).map((value) => <option value={value} key={value}>{value}</option>)}</select></label><button className="button button-outline" disabled={pending}>Add track</button></form></div></details>
}

function FirstDaySetup({ eventSlug, pending, timeZone, mutate }: {
  eventSlug: string
  pending: boolean
  timeZone: string
  mutate: (label: string, request: () => Promise<AgendaResponse>) => Promise<boolean>
}) {
  const [date, setDate] = useState('')
  const [label, setLabel] = useState('Day 1')
  const [opensAt, setOpensAt] = useState('09:00')
  const [closesAt, setClosesAt] = useState('17:00')
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    void mutate(`${label} added.`, () => agendaApi.createDay(eventSlug, {
      date,
      label,
      opensAt: eventLocalTimestamp(date, opensAt, timeZone),
      closesAt: eventLocalTimestamp(date, closesAt, timeZone),
      slotMinutes: 15,
    }))
  }
  return <section className="section-card agenda-first-day"><p className="overline">Schedule setup</p><h2>Add the first event day</h2><p>Enter times in the event time zone: {timeZone}.</p><form onSubmit={submit}><label>Date<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>Day label<input required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} /></label><label>Opens at<input required type="time" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} /></label><label>Closes at<input required type="time" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} /></label><button className="button button-primary" disabled={pending}>Add event day</button></form></section>
}

function AgendaWorkspace({ eventSlug, onUnauthorized, preferredSessionId }: { eventSlug: string; onUnauthorized: (error: ApiError) => void; preferredSessionId?: string }) {
  const resource = useApiResource((signal) => agendaApi.get(eventSlug, signal), [eventSlug])
  const [data, setData] = useState<AgendaResponse | null>(null)
  const [activeDayId, setActiveDayId] = useState('')
  const [selected, setSelected] = useState<AgendaSessionResponse | null>(null)
  const [trigger, setTrigger] = useState<HTMLElement | null>(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')
  const preferredApplied = useRef(false)
  useEffect(() => {
    preferredApplied.current = false
  }, [preferredSessionId])

  useEffect(() => {
    if (resource.status === 'success') {
      setData(resource.data)
      setActiveDayId((current) => resource.data.days.some((day) => day.id === current) ? current : resource.data.days[0]?.id ?? '')
      if (!preferredApplied.current && preferredSessionId) {
        const preferred = resource.data.sessions.find((session) => session.id === preferredSessionId)
        if (preferred) {
          setSelected(preferred)
          if (preferred.placement) setActiveDayId(preferred.placement.dayId)
        }
        preferredApplied.current = true
      }
      setError(null)
    } else if (resource.status === 'error') {
      const next = asApiError(resource.error)
      if (isAccessError(next)) onUnauthorized(next)
      else setError(next)
    }
  }, [onUnauthorized, preferredSessionId, resource.data, resource.error, resource.status])

  const mutate = async (label: string, request: () => Promise<AgendaResponse>) => {
    setPending(label)
    setError(null)
    setMessage('')
    try {
      const next = await request()
      setData(next)
      setSelected((current) => current ? next.sessions.find((session) => session.id === current.id) ?? null : null)
      setMessage(label)
      return true
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next)
      else setError(next)
      return false
    } finally {
      setPending('')
    }
  }

  if (resource.status === 'loading' && data === null) return <main className="page" role="status"><PageHeader eyebrow="Program · Agenda" title="Opening agenda" description="Loading accepted sessions and schedule configuration…" /></main>
  if (data === null) return <main className="page"><PageHeader eyebrow="Program · Agenda" title="Agenda unavailable" description={error?.message ?? 'The agenda could not be loaded.'} action={<button className="button button-primary" onClick={resource.reload}>Try again</button>} /></main>
  const activeDay = data.days.find((day) => day.id === activeDayId) ?? data.days[0]
  const unplaced = data.sessions.filter((session) => !session.placement)
  const placedCount = data.sessions.length - unplaced.length
  const { publicSessionCount, contentNotApprovedCount, primarySpeakerNotPublicCount,
    readinessBlockedCount, awaitingPublicationCount } = data.publication
  const placedNotPublicCount = contentNotApprovedCount + primarySpeakerNotPublicCount
    + readinessBlockedCount + awaitingPublicationCount
  const publicationBlockReasons = [
    contentNotApprovedCount > 0 ? `${contentNotApprovedCount} ${contentNotApprovedCount === 1 ? 'awaits' : 'await'} content approval` : '',
    primarySpeakerNotPublicCount > 0 ? `${primarySpeakerNotPublicCount} ${primarySpeakerNotPublicCount === 1 ? 'has' : 'have'} a private primary speaker profile` : '',
    readinessBlockedCount > 0 ? `${readinessBlockedCount} ${readinessBlockedCount === 1 ? 'requires' : 'require'} readiness checks` : '',
    awaitingPublicationCount > 0 ? `${awaitingPublicationCount} ${awaitingPublicationCount === 1 ? 'awaits' : 'await'} publication` : '',
  ].filter(Boolean).join('; ')
  const openSession = (session: AgendaSessionResponse, element: HTMLElement) => { setSelected(session); setTrigger(element); setError(null) }

  const autoPlace = async () => {
    if (unplaced.length === 0) {
      setError(null)
      setMessage('Nothing to schedule. Every accepted session is already placed.')
      return
    }
    setPending('auto')
    setError(null)
    setMessage('')
    try {
      const result = await agendaApi.autoPlace(eventSlug, { sessionIds: [] })
      setData(result.agenda)
      const placed = result.results.filter((item) => item.status === 'placed').length
      const unplacedCount = result.results.length - placed
      const placedLabel = `${placed} ${placed === 1 ? 'session' : 'sessions'}`
      const manualPlacementLabel = `${unplacedCount} ${unplacedCount === 1 ? 'needs' : 'need'} manual placement`
      if (unplacedCount === 0) {
        setMessage(`${placedLabel} scheduled into the earliest available slots. Room and speaker conflicts were prevented.`)
      } else if (placed > 0) {
        setMessage(`${placedLabel} of ${result.results.length} scheduled into the earliest available slots. ${manualPlacementLabel}; room and speaker conflicts were prevented.`)
      } else {
        setMessage(`No sessions could be scheduled automatically. ${manualPlacementLabel}; no room or speaker conflicts were introduced.`)
      }
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending('') }
  }

  const publish = async () => {
    setPending('publish'); setError(null); setMessage('')
    try {
      const result = await agendaApi.publish(eventSlug)
      setData(result.agenda)
      const { newlyPublicSessionCount, publicSessionCount, skipped } = result.publication
      const skippedCount = skipped.reduce((total, item) => total + item.count, 0)
      const details = skipped.map((item) => {
        if (item.reason === 'UNPLACED') return `${item.count} unscheduled`
        if (item.reason === 'CONTENT_NOT_APPROVED') return `${item.count} awaiting content approval`
        if (item.reason === 'READINESS_BLOCKED') return `${item.count} blocked by speaker, task, or deliverable readiness`
        return `${item.count} with a private primary speaker`
      }).join(', ')
      if (newlyPublicSessionCount > 0) {
        const sessionLabel = newlyPublicSessionCount === 1 ? 'session is' : 'sessions are'
        setMessage(`${newlyPublicSessionCount} ${sessionLabel} newly public; ${publicSessionCount} ${publicSessionCount === 1 ? 'session is' : 'sessions are'} in the attendee program.${skippedCount > 0 ? ` ${skippedCount} skipped: ${details}.` : ''}`)
      } else {
        setMessage(`No new sessions were published. ${publicSessionCount} ${publicSessionCount === 1 ? 'session is' : 'sessions are'} already public.${skippedCount > 0 ? ` ${skippedCount} skipped: ${details}.` : ''}`)
      }
    } catch (requestError) {
      const next = asApiError(requestError)
      if (isAccessError(next)) onUnauthorized(next); else setError(next)
    } finally { setPending('') }
  }

  if (!activeDay) return <main className="page"><PageHeader eyebrow="Program · Agenda" title="Agenda board" description="Create the first event day before scheduling accepted sessions." /><FirstDaySetup eventSlug={eventSlug} pending={Boolean(pending)} timeZone={data.event.timeZone} mutate={mutate} /><SetupPanel eventSlug={eventSlug} data={data} pending={Boolean(pending)} mutate={mutate} />{error && <ErrorNotice error={error} retry={resource.reload} />}</main>

  return <main className="page connected-agenda-page"><PageHeader eyebrow="Program · Agenda" title="Agenda board" description="Place accepted sessions, resolve speaker conflicts, and publish the same schedule attendees see." action={<div className="split-actions"><button type="button" className="button button-outline" disabled={Boolean(pending)} onClick={() => void autoPlace()}>{pending === 'auto' ? 'Auto-placing…' : `Auto-place ${unplaced.length} in earliest slots`}</button><button type="button" className="button button-primary" disabled={Boolean(pending) || data.conflicts.length > 0 || placedCount === 0} onClick={() => void publish()}>{pending === 'publish' ? 'Publishing…' : 'Publish program'}</button></div>} /><div className="agenda-status connected-agenda-status"><div><span className={`status-badge ${data.event.status === 'published' ? 'status-live' : 'status-draft'}`}>● {data.event.status === 'published' ? 'Published' : 'Draft'}</span><span>{data.event.agendaPublishedAt ? `Published ${formatDateTime(data.event.agendaPublishedAt, data.event.timeZone)}` : 'Not published yet'}</span>{placedNotPublicCount > 0 && <span className="warning-inline" role="status">{placedNotPublicCount} placed {placedNotPublicCount === 1 ? 'session is' : 'sessions are'} not public: {publicationBlockReasons}.</span>}</div><div><span className={data.conflicts.length === 0 ? 'complete-text' : 'warning-inline'}>{data.conflicts.length === 0 ? '✓ Conflicts clear' : `! ${data.conflicts.length} speaker conflicts`}</span><span>{publicSessionCount} public · {placedCount} placed · {data.sessions.length} accepted</span>{data.event.status === 'published' && <a href={`/api/program.ics?event=${encodeURIComponent(data.event.slug)}`}>Download calendar ↗</a>}</div></div>{data.conflicts.length > 0 && <section className="agenda-conflicts" aria-label="Speaker conflicts"><p className="overline">Resolve before publishing</p>{data.conflicts.map((conflict) => <article key={`${conflict.speaker.id}-${conflict.sessionIds.join('-')}`}><strong>{conflict.speaker.name} is double-booked</strong><span>{conflict.sessionIds.map((id) => data.sessions.find((session) => session.id === id)?.title).filter(Boolean).join(' ↔ ')}</span><small>{formatTime(conflict.startsAt, data.event.timeZone)}–{formatTime(conflict.endsAt, data.event.timeZone)}</small></article>)}</section>}<SetupPanel eventSlug={eventSlug} data={data} pending={Boolean(pending)} mutate={mutate} />{error && !selected && <ErrorNotice error={error} retry={error.status === 409 ? resource.reload : undefined} />}<p className="save-state agenda-save-state" aria-live="polite">{message}</p><div className="connected-agenda-layout"><AgendaBoard data={data} activeDay={activeDay} onDay={setActiveDayId} onSession={openSession} /><aside className="section-card connected-unplaced"><div className="card-heading"><div><p className="overline">Accepted</p><h2>Unscheduled</h2></div><span className="count-pill">{unplaced.length}</span></div>{unplaced.length === 0 ? <div className="builder-empty"><span>PLACEMENT COMPLETE</span><h3>Every accepted session is on the board.</h3></div> : <div className="connected-unplaced-list">{unplaced.map((session) => <button type="button" key={session.id} style={trackStyle(session.track, data)} onClick={(event) => openSession(session, event.currentTarget)}><span><small>{session.format} · {session.durationMinutes} min</small><strong>{session.title}</strong><em>{session.presenters.map((presenter) => presenter.name).join(', ')}</em></span><b aria-hidden="true">+</b></button>)}</div>}</aside></div>{selected && <SessionPlacementDialog key={`${selected.id}-${selected.placement?.revision ?? 0}`} data={data} session={selected} error={error} pending={Boolean(pending)} trigger={trigger} onClose={() => { setSelected(null); setError(null) }} onSave={(draft) => selected.placement ? mutate(`${selected.title} moved.`, () => agendaApi.updatePlacement(eventSlug, selected.placement!.id, { ...draft, revision: selected.placement!.revision })) : mutate(`${selected.title} scheduled.`, () => agendaApi.createPlacement(eventSlug, { sessionId: selected.id, ...draft }))} onUnplace={() => selected.placement ? mutate(`${selected.title} removed from the agenda.`, () => agendaApi.deletePlacement(eventSlug, selected.placement!.id, { expectedRevision: selected.placement!.revision })) : Promise.resolve(false)} />}</main>
}

export function ConnectedAgendaAdmin({ eventSlug, preferredSessionId }: { eventSlug: string; preferredSessionId?: string }) {
  const resource = useApiResource((signal) => cfpApi.session(signal), [])
  const [authenticated, setAuthenticated] = useState<AuthSession | null>(null)
  const [forcedError, setForcedError] = useState<ApiError | null>(null)
  const session = authenticated ?? (resource.status === 'success' ? resource.data : null)
  if (session && hasOrganizerRole(session, eventSlug) && forcedError === null) return <AgendaWorkspace eventSlug={eventSlug} preferredSessionId={preferredSessionId} onUnauthorized={(error) => { setAuthenticated(null); setForcedError(error) }} />
  if (resource.status === 'loading' && forcedError === null) return <main className="page" role="status"><PageHeader eyebrow="Program · Agenda" title="Checking agenda access" description="Checking organizer access…" /></main>
  if (session && !hasOrganizerRole(session, eventSlug) && forcedError === null) return <AgendaSignIn eventSlug={eventSlug} error={new ApiError(403, 'FORBIDDEN', `This account is not an organizer for ${eventSlug}.`)} onAuthenticated={(next) => { setAuthenticated(next); setForcedError(null) }} />
  const resourceError = resource.status === 'error' ? asApiError(resource.error) : null
  const error = forcedError ?? resourceError ?? new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.')
  if (!isAuthenticationError(error) && error.code !== 'FORBIDDEN') return <main className="page"><PageHeader eyebrow="Program · Agenda" title="Access check unavailable" description={error.message} action={<button className="button button-primary" type="button" onClick={resource.reload}>Try again</button>} /></main>
  return <AgendaSignIn eventSlug={eventSlug} error={error} onAuthenticated={(next) => { setAuthenticated(next); setForcedError(null) }} />
}
