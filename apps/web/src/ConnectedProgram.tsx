import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  defaultEmbedAppearance,
  type EmbedAppearance,
  type EmbedFilters,
  type EmbedView,
  type PublicProgramResponse,
  type PublicSessionResponse,
  type PublicSpeakerResponse,
} from '@confpilot/contracts'

import { programApi } from './api'
import { downloadPersonalSchedule, loadPersonalSchedule, MAX_PERSONAL_SCHEDULE_SESSIONS, savePersonalSchedule } from './personalSchedule'
import { useApiResource } from './useApiResource'

const EMPTY_FILTERS: EmbedFilters = { days: [], tracks: [], formats: [], rooms: [] }
type ProgramView = EmbedView | 'personal'
const VIEWS: Array<{ value: ProgramView; label: string }> = [
  { value: 'sessions', label: 'Sessions' },
  { value: 'speakers', label: 'Speakers' },
  { value: 'agenda', label: 'Agenda' },
  { value: 'itinerary', label: 'By day' },
  { value: 'gallery', label: 'Gallery' },
  { value: 'personal', label: 'My schedule' },
]
const PROGRAM_VIEWS = new Set<ProgramView>(['sessions', 'agenda', 'itinerary'])
const SPEAKER_VIEWS = new Set<ProgramView>(['speakers', 'gallery'])
const UPSTREAM_SOURCE_URL = 'https://github.com/bishnubista/confpilot-open-source'

export function resolveSourceUrl(configured: string | undefined, development: boolean) {
  const value = configured?.trim()
  if (!value) {
    if (development) return UPSTREAM_SOURCE_URL
    throw new Error('VITE_SOURCE_URL must be an absolute HTTP(S) URL for production builds.')
  }
  try {
    const url = new URL(value)
    const isHttp = url.protocol === 'https:' || url.protocol === 'http:'
    if (isHttp && !url.username && !url.password) return url.toString()
  } catch {
    // Handled below so production builds fail closed.
  }
  if (development) return UPSTREAM_SOURCE_URL
  throw new Error('VITE_SOURCE_URL must be an absolute HTTP(S) URL for production builds.')
}

export const SOURCE_URL = resolveSourceUrl(
  import.meta.env.VITE_SOURCE_URL,
  import.meta.env.DEV,
)

function viewFromFragment(): ProgramView {
  if (window.location.hash === '#speakers') return 'speakers'
  if (window.location.hash === '#my-schedule') return 'personal'
  return 'sessions'
}

function unique(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}

function formatTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(value))
}

function formatRange(startsOn: string, endsOn: string) {
  const start = new Date(`${startsOn}T00:00:00Z`)
  const end = new Date(`${endsOn}T00:00:00Z`)
  const startText = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(start)
  const endText = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(end)
  return `${startText}–${endText}`
}

function formatFormat(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function speakerLine(speaker: PublicSessionResponse['speakers'][number]) {
  return [speaker.title, speaker.company].filter(Boolean).join(' · ')
}

const speakerNameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function surnameKey(name: string) {
  const parts = name.trim().split(/\s+/)
  const trailingOperationalId = parts.length > 1 && /^(?=.*\d)(?=.*[a-f])[a-f\d]{7,40}$/i.test(parts.at(-1) ?? '')
  return parts.at(trailingOperationalId ? -2 : -1) ?? name
}

export function compareSpeakersBySurname(left: Pick<PublicSpeakerResponse, 'name'>, right: Pick<PublicSpeakerResponse, 'name'>) {
  return speakerNameCollator.compare(surnameKey(left.name), surnameKey(right.name))
    || speakerNameCollator.compare(left.name, right.name)
}

function trackStyle(track: string) {
  let hash = 0
  for (const character of track) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  const colors = ['var(--track-blue)', 'var(--track-violet)', 'var(--track-gold)', 'var(--success)']
  return { '--session-track': colors[hash % colors.length] } as React.CSSProperties
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2])
}

function contrastRatio(left: string, right: string) {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

export function accessibleActionColor(accentColor: string, theme: EmbedAppearance['theme']) {
  const background = theme === 'dark' ? '#0C1526' : '#FFFFFF'
  if (contrastRatio(accentColor, background) >= 4.5) return accentColor
  return theme === 'dark' ? '#FACC15' : '#1D4ED8'
}

function matchesFixedFilters(session: PublicSessionResponse, filters: EmbedFilters) {
  const schedule = session.schedule
  return (filters.days.length === 0 || (schedule !== null && filters.days.includes(schedule.date)))
    && (filters.tracks.length === 0 || filters.tracks.includes(session.track))
    && (filters.formats.length === 0 || filters.formats.includes(session.format))
    && (filters.rooms.length === 0 || (schedule !== null && filters.rooms.includes(schedule.room)))
}

function PublicState({ title, message, retry }: { title: string; message: string; retry?: () => void }) {
  return <main className="public-state" aria-live="polite"><span aria-hidden="true">{retry ? '!' : '○'}</span><h1>{title}</h1><p>{message}</p>{retry && <button className="button button-primary" type="button" onClick={retry}>Try again</button>}</main>
}

interface ProgramSurfaceProps {
  data: PublicProgramResponse
  fixedView?: EmbedView
  fixedFilters?: EmbedFilters
  embedded?: boolean
  embedName?: string
  appearance?: EmbedAppearance
}

export function ProgramSurface({ data, fixedView, fixedFilters = EMPTY_FILTERS, embedded = false, embedName, appearance = defaultEmbedAppearance }: ProgramSurfaceProps) {
  const [view, setView] = useState<ProgramView>(() => fixedView ?? viewFromFragment())
  const [query, setQuery] = useState('')
  const [day, setDay] = useState('')
  const [track, setTrack] = useState('')
  const [format, setFormat] = useState('')
  const [room, setRoom] = useState('')
  const [selectedSession, setSelectedSession] = useState<PublicSessionResponse | null>(null)
  const [selectedSpeaker, setSelectedSpeaker] = useState<PublicSpeakerResponse | null>(null)
  const [personalSchedule, setPersonalSchedule] = useState(() => embedded
    ? new Set<string>()
    : loadPersonalSchedule(data.event.slug, data.sessions.map((session) => session.slug)))
  const [personalScheduleNotice, setPersonalScheduleNotice] = useState('')

  const fixedSessions = useMemo(
    () => data.sessions.filter((session) => matchesFixedFilters(session, fixedFilters)),
    [data.sessions, fixedFilters],
  )
  const fixedSessionSlugs = useMemo(() => new Set(fixedSessions.map((session) => session.slug)), [fixedSessions])
  const fixedSpeakers = useMemo(() => data.speakers.flatMap((speaker) => {
    const speakerSessions = speaker.sessions.filter((session) => fixedSessionSlugs.has(session.slug))
    return speakerSessions.length > 0 ? [{ ...speaker, sessions: speakerSessions }] : []
  }).sort(compareSpeakersBySurname), [data.speakers, fixedSessionSlugs])

  const available = useMemo(() => ({
    days: unique(fixedSessions.flatMap((session) => session.schedule ? [session.schedule.date] : [])),
    tracks: unique(fixedSessions.map((session) => session.track)),
    formats: unique(fixedSessions.map((session) => session.format)),
    rooms: unique(fixedSessions.flatMap((session) => session.schedule ? [session.schedule.room] : [])),
  }), [fixedSessions])

  const sessions = useMemo(() => fixedSessions.filter((session) => {
    const searchable = `${session.title} ${session.abstract} ${session.track} ${session.speakers.map((speaker) => `${speaker.name} ${speaker.company}`).join(' ')}`.toLowerCase()
    const schedule = session.schedule
    return searchable.includes(query.trim().toLowerCase())
      && (!day || schedule?.date === day)
      && (!track || session.track === track)
      && (!format || session.format === format)
      && (!room || schedule?.room === room)
  }), [day, fixedSessions, format, query, room, track])

  const speakerSessionSlugs = useMemo(() => new Set(fixedSessions.filter((session) => {
    const schedule = session.schedule
    return (!day || schedule?.date === day)
      && (!track || session.track === track)
      && (!format || session.format === format)
      && (!room || schedule?.room === room)
  }).map((session) => session.slug)), [day, fixedSessions, format, room, track])
  const speakers = useMemo(() => fixedSpeakers.filter((speaker) => {
    const searchable = `${speaker.name} ${speaker.title} ${speaker.company} ${speaker.bio}`.toLowerCase()
    return searchable.includes(query.trim().toLowerCase())
      && speaker.sessions.some((session) => speakerSessionSlugs.has(session.slug))
  }), [fixedSpeakers, query, speakerSessionSlugs])

  const reset = () => { setQuery(''); setDay(''); setTrack(''); setFormat(''); setRoom('') }
  const filtersApplied = Boolean(query || day || track || format || room)
  const activeView = fixedView ?? view
  const embedStyle = embedded ? {
    '--embed-accent': appearance.accentColor,
    '--action': accessibleActionColor(appearance.accentColor, appearance.theme),
  } as React.CSSProperties : undefined
  const personalSessions = useMemo(() => data.sessions.filter((session) => personalSchedule.has(session.slug)), [data.sessions, personalSchedule])
  const togglePersonalSession = (session: PublicSessionResponse) => {
    setPersonalSchedule((current) => {
      const next = new Set(current)
      if (next.has(session.slug)) {
        next.delete(session.slug)
        setPersonalScheduleNotice('')
      } else if (next.size >= MAX_PERSONAL_SCHEDULE_SESSIONS) {
        setPersonalScheduleNotice(`A personal schedule can contain up to ${MAX_PERSONAL_SCHEDULE_SESSIONS} sessions.`)
        return current
      } else {
        next.add(session.slug)
        setPersonalScheduleNotice('')
      }
      savePersonalSchedule(data.event.slug, next)
      return next
    })
  }

  const selectFragmentView = (event: MouseEvent<HTMLAnchorElement>, nextView: ProgramView, fragment: '#schedule' | '#speakers' | '#my-schedule') => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (window.location.hash !== fragment) window.history.pushState({}, '', fragment)
    setView(nextView)
  }

  useEffect(() => {
    if (fixedView) return
    const synchronizeFragment = () => setView(viewFromFragment())
    window.addEventListener('hashchange', synchronizeFragment)
    window.addEventListener('popstate', synchronizeFragment)
    return () => {
      window.removeEventListener('hashchange', synchronizeFragment)
      window.removeEventListener('popstate', synchronizeFragment)
    }
  }, [fixedView])

  return <div className={embedded ? `public-embed embed-theme-${appearance.theme} embed-density-${appearance.density}` : 'public-app'} style={embedStyle}>
    {embedded ? <><header className="embed-public-header"><span className="logo"><span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>ConfPilot</span><div><strong>{embedName}</strong><span>{data.event.name}</span></div></header>{appearance.showEventSummary && <section className="embed-event-summary"><div><strong>{formatRange(data.event.startsOn, data.event.endsOn)}</strong><span>{data.event.location}</span></div><p>{data.event.description}</p></section>}</> : <>
      <header className="public-nav shell-width"><a href="/" className="logo logo-light"><span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>ConfPilot</a><nav aria-label="Public program"><a href="#schedule" aria-current={PROGRAM_VIEWS.has(activeView) ? 'location' : undefined} onClick={(event) => selectFragmentView(event, 'sessions', '#schedule')}>Program</a><a href="#speakers" aria-current={SPEAKER_VIEWS.has(activeView) ? 'location' : undefined} onClick={(event) => selectFragmentView(event, 'speakers', '#speakers')}>Speakers</a><a className="save-button" href="#my-schedule" aria-current={activeView === 'personal' ? 'location' : undefined} onClick={(event) => selectFragmentView(event, 'personal', '#my-schedule')}>My schedule ({personalSchedule.size})</a></nav></header>
      <section className="event-hero"><div className="shell-width"><p className="eyebrow">{data.event.tagline}</p><h1>{data.event.name}</h1><div className="event-meta"><span>{formatRange(data.event.startsOn, data.event.endsOn)}</span><span>{data.event.location}</span></div><p className="event-description">{data.event.description}</p></div></section>
    </>}
    <main id="schedule" className={embedded ? 'embed-program-main' : 'program-main shell-width'}>
      <div className="program-heading"><div><p className="overline">{embedded ? 'Live program' : 'Browse the published schedule'}</p><h2>{embedName ?? 'Program'}</h2>{!embedded && <p>Explore every published session and speaker from the live conference program.</p>}</div></div>
      {!fixedView && <div className="program-view-tabs" role="group" aria-label="Program view">{VIEWS.map((option) => <button key={option.value} type="button" aria-pressed={view === option.value} className={view === option.value ? 'active' : ''} onClick={() => setView(option.value)}>{option.value === 'personal' ? `${option.label} (${personalSchedule.size})` : option.label}</button>)}</div>}
      {activeView !== 'personal' && (!embedded || appearance.showSearch || appearance.showFilters) && <div className="program-filters" aria-label="Filter program">{(!embedded || appearance.showSearch) && <label className="search program-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search sessions and speakers" placeholder="Search sessions or speakers" /></label>}{(!embedded || appearance.showFilters) && <><select aria-label="Filter by day" value={day} onChange={(event) => setDay(event.target.value)}><option value="">All days</option>{available.days.map((value) => <option value={value} key={value}>{formatDate(value)}</option>)}</select><select aria-label="Filter by track" value={track} onChange={(event) => setTrack(event.target.value)}><option value="">All tracks</option>{available.tracks.map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter by format" value={format} onChange={(event) => setFormat(event.target.value)}><option value="">All formats</option>{available.formats.map((value) => <option value={value} key={value}>{formatFormat(value)}</option>)}</select><select aria-label="Filter by room" value={room} onChange={(event) => setRoom(event.target.value)}><option value="">All rooms</option>{available.rooms.map((value) => <option key={value}>{value}</option>)}</select></>}</div>}
      <p className="result-count" aria-live="polite">{activeView === 'speakers' || activeView === 'gallery' ? `${speakers.length} ${speakers.length === 1 ? 'speaker' : 'speakers'}` : activeView === 'personal' ? `${personalSessions.length} saved ${personalSessions.length === 1 ? 'session' : 'sessions'}` : `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`}</p>
      {personalScheduleNotice && <p className="personal-schedule-notice" role="status">{personalScheduleNotice}</p>}
      {(activeView === 'sessions') && <SessionList sessions={sessions} timeZone={data.event.timeZone} onSession={setSelectedSession} personalSchedule={personalSchedule} onTogglePersonal={embedded ? undefined : togglePersonalSession} />}
      {(activeView === 'agenda') && <AgendaView sessions={sessions} timeZone={data.event.timeZone} onSession={setSelectedSession} />}
      {(activeView === 'itinerary') && <ItineraryView sessions={sessions} timeZone={data.event.timeZone} onSession={setSelectedSession} personalSchedule={personalSchedule} onTogglePersonal={embedded ? undefined : togglePersonalSession} />}
      {(activeView === 'speakers') && <SpeakerList speakers={speakers} onSpeaker={setSelectedSpeaker} />}
      {(activeView === 'gallery') && <SpeakerGallery speakers={speakers} onSpeaker={setSelectedSpeaker} />}
      {(activeView === 'personal') && <PersonalSchedule eventSlug={data.event.slug} sessions={personalSessions} timeZone={data.event.timeZone} onSession={setSelectedSession} personalSchedule={personalSchedule} onTogglePersonal={togglePersonalSession} />}
      {(activeView === 'sessions' || activeView === 'agenda' || activeView === 'itinerary') && sessions.length === 0 && <ProgramEmpty filtersApplied={filtersApplied} reset={reset} />}
      {(activeView === 'speakers' || activeView === 'gallery') && speakers.length === 0 && <ProgramEmpty filtersApplied={filtersApplied} reset={reset} subject="speakers" />}
    </main>
    {!embedded && <footer className="public-footer"><div className="shell-width"><span className="logo logo-light"><span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>ConfPilot</span><p>Live program data from {data.event.name}</p><a href={SOURCE_URL}>Source code (AGPL-3.0-or-later) ↗</a></div></footer>}
    {selectedSession && <SessionDialog session={selectedSession} timeZone={data.event.timeZone} onClose={() => setSelectedSession(null)} onSpeaker={(slug) => { setSelectedSession(null); setSelectedSpeaker(fixedSpeakers.find((speaker) => speaker.slug === slug) ?? null) }} />}
    {selectedSpeaker && <SpeakerDialog speaker={selectedSpeaker} sessions={fixedSessions} timeZone={data.event.timeZone} onClose={() => setSelectedSpeaker(null)} onSession={(slug) => { setSelectedSpeaker(null); setSelectedSession(fixedSessions.find((session) => session.slug === slug) ?? null) }} />}
  </div>
}

function ProgramEmpty({ filtersApplied, reset, subject = 'sessions' }: { filtersApplied: boolean; reset: () => void; subject?: string }) {
  return <div className="empty-state"><span aria-hidden="true">⌕</span><h3>No {subject} found</h3><p>{filtersApplied ? 'Try a broader search or reset the filters.' : `Published ${subject} will appear here when they are available.`}</p>{filtersApplied && <button className="button button-dark" type="button" onClick={reset}>Reset filters</button>}</div>
}

interface PersonalScheduleControls {
  personalSchedule: Set<string>
  onTogglePersonal?: (session: PublicSessionResponse) => void
}

function PersonalScheduleButton({ session, selected, onToggle }: { session: PublicSessionResponse; selected: boolean; onToggle: (session: PublicSessionResponse) => void }) {
  return <button className={`personal-schedule-toggle${selected ? ' selected' : ''}`} type="button" aria-label={`${selected ? 'Remove' : 'Add'} ${session.title} ${selected ? 'from' : 'to'} my schedule`} aria-pressed={selected} onClick={() => onToggle(session)}>{selected ? '✓' : '+'}</button>
}

function ExpandableText({ text, label, className = '' }: { text: string; label: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const characters = useMemo(() => [...text], [text])
  const truncated = characters.length > 140
  const visible = truncated && !expanded ? `${characters.slice(0, 137).join('').trimEnd()}…` : text
  return <div className={`expandable-text ${className}`.trim()}><p>{visible}</p>{truncated && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less' : 'Show more'} <span className="sr-only">{label}</span></button>}</div>
}

function SessionList({ sessions, timeZone, onSession, personalSchedule, onTogglePersonal }: { sessions: PublicSessionResponse[]; timeZone: string; onSession: (session: PublicSessionResponse) => void } & PersonalScheduleControls) {
  const scheduled = sessions.filter((session) => session.schedule)
  return <div className="program-list">{scheduled.map((session) => <article className="program-session" key={session.slug} style={trackStyle(session.track)}><div className="session-time"><strong>{formatTime(session.schedule!.startsAt, timeZone)}</strong><span>{formatTime(session.schedule!.endsAt, timeZone)}</span></div><div className="session-track" /><div className="session-content"><button className="session-detail-trigger" type="button" onClick={() => onSession(session)}><span className="session-tags"><em>{session.track}</em><em>{formatFormat(session.format)}</em></span><h3>{session.title}</h3><span className="session-speaker">{session.speakers.map((speaker) => <span className="session-speaker-item" key={speaker.slug}><SpeakerImage speaker={speaker} /><span><strong>{speaker.name}</strong><small>{speakerLine(speaker)}</small></span></span>)}</span></button><ExpandableText text={session.abstract} label={`description for ${session.title}`} className="session-description" /></div><div className="session-place"><strong>{session.schedule!.room}</strong><span>{formatDate(session.schedule!.date)}</span>{onTogglePersonal && <PersonalScheduleButton session={session} selected={personalSchedule.has(session.slug)} onToggle={onTogglePersonal} />}</div></article>)}</div>
}

function AgendaView({ sessions, timeZone, onSession }: { sessions: PublicSessionResponse[]; timeZone: string; onSession: (session: PublicSessionResponse) => void }) {
  const scheduled = sessions.filter((session) => session.schedule).sort((left, right) => left.schedule!.startsAt.localeCompare(right.schedule!.startsAt))
  return <div className="public-agenda-scroll" role="region" aria-label="Agenda table" tabIndex={0}><table className="public-agenda-table"><thead><tr><th scope="col">Day and time</th><th scope="col">Session</th><th scope="col">Track</th><th scope="col">Room</th></tr></thead><tbody>{scheduled.map((session) => <tr key={session.slug}><td>{formatDate(session.schedule!.date)}<small>{formatTime(session.schedule!.startsAt, timeZone)}–{formatTime(session.schedule!.endsAt, timeZone)}</small></td><td><button type="button" onClick={() => onSession(session)}>{session.title}<small>{session.speakers.map((speaker) => speaker.name).join(', ')}</small><small className="agenda-mobile-meta">{session.track} · {session.schedule!.room}</small></button></td><td>{session.track}</td><td>{session.schedule!.room}</td></tr>)}</tbody></table></div>
}

function ItineraryView({ sessions, timeZone, onSession, personalSchedule, onTogglePersonal }: { sessions: PublicSessionResponse[]; timeZone: string; onSession: (session: PublicSessionResponse) => void } & PersonalScheduleControls) {
  const days = unique(sessions.flatMap((session) => session.schedule ? [session.schedule.date] : []))
  return <div className="itinerary-days">{days.map((date) => <section key={date}><header><p className="overline">Conference day</p><h3>{formatDate(date)}</h3></header>{sessions.filter((session) => session.schedule?.date === date).sort((left, right) => left.schedule!.startsAt.localeCompare(right.schedule!.startsAt)).map((session) => <article className="itinerary-session" key={session.slug} style={trackStyle(session.track)}><div className="itinerary-session-content"><time>{formatTime(session.schedule!.startsAt, timeZone)}</time><span aria-hidden="true" /><div><button className="itinerary-detail-trigger" type="button" aria-label={`Open ${session.title}`} onClick={() => onSession(session)}><strong>{session.title}</strong></button><small>{formatDate(session.schedule!.date)} · {formatTime(session.schedule!.startsAt, timeZone)}–{formatTime(session.schedule!.endsAt, timeZone)} · {session.schedule!.room}</small><em>{session.track} · {formatFormat(session.format)}</em><ExpandableText text={session.abstract} label={`description for ${session.title}`} className="itinerary-description" /><div className="itinerary-speakers">{session.speakers.map((speaker) => <span key={speaker.slug}><b>{speaker.name}</b>{speakerLine(speaker) && <small>{speakerLine(speaker)}</small>}</span>)}</div></div></div>{onTogglePersonal && <PersonalScheduleButton session={session} selected={personalSchedule.has(session.slug)} onToggle={onTogglePersonal} />}</article>)}</section>)}</div>
}

function PersonalSchedule({ eventSlug, sessions, timeZone, onSession, personalSchedule, onTogglePersonal }: { eventSlug: string; sessions: PublicSessionResponse[]; timeZone: string; onSession: (session: PublicSessionResponse) => void; onTogglePersonal: (session: PublicSessionResponse) => void } & PersonalScheduleControls) {
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle')
  if (sessions.length === 0) return <div className="empty-state personal-schedule-empty"><span aria-hidden="true">☆</span><h3>Your schedule is empty</h3><p>Add sessions from the program or day-by-day itinerary. Your picks are saved in this browser.</p></div>
  const download = async () => {
    setDownloadState('downloading')
    try {
      await downloadPersonalSchedule(eventSlug, sessions.map((session) => session.slug))
      setDownloadState('success')
    } catch {
      setDownloadState('error')
    }
  }
  return <section className="personal-schedule" aria-label="My schedule"><div className="personal-schedule-actions"><div><h3>My schedule</h3><p>Your picks are saved in this browser. When you download, ConfPilot sends them in a private request body to this server to build the calendar file.</p>{downloadState === 'success' && <p className="download-success" role="status">Downloaded {eventSlug}-my-schedule.ics.</p>}{downloadState === 'error' && <p className="error-text" role="alert">Could not download your schedule. Refresh the program and try again.</p>}</div><button className="button button-dark" type="button" onClick={download} disabled={downloadState === 'downloading'}>{downloadState === 'downloading' ? 'Downloading…' : 'Download my schedule (.ics)'}</button></div><SessionList sessions={sessions} timeZone={timeZone} onSession={onSession} personalSchedule={personalSchedule} onTogglePersonal={onTogglePersonal} /></section>
}

function SpeakerList({ speakers, onSpeaker }: { speakers: PublicSpeakerResponse[]; onSpeaker: (speaker: PublicSpeakerResponse) => void }) {
  return <div id="speakers" className="public-speaker-list">{speakers.map((speaker) => <article key={speaker.slug}><SpeakerImage speaker={speaker} large /><div><p className="overline">{speaker.sessions.length} {speaker.sessions.length === 1 ? 'session' : 'sessions'}</p><h3>{speaker.name}</h3><strong>{[speaker.title, speaker.company].filter(Boolean).join(' · ')}</strong><p>{speaker.bio || 'Speaker biography coming soon.'}</p></div><button className="button button-outline" type="button" onClick={() => onSpeaker(speaker)}>View speaker</button></article>)}</div>
}

function SpeakerGallery({ speakers, onSpeaker }: { speakers: PublicSpeakerResponse[]; onSpeaker: (speaker: PublicSpeakerResponse) => void }) {
  return <section id="speakers" className="public-speakers"><div className="speaker-gallery">{speakers.map((speaker) => <article key={speaker.slug}><button type="button" onClick={() => onSpeaker(speaker)}><SpeakerImage speaker={speaker} gallery /><h3>{speaker.name}</h3><p>{speaker.title}<br />{speaker.company}</p><span>{speaker.sessions.length} {speaker.sessions.length === 1 ? 'session' : 'sessions'} →</span></button></article>)}</div></section>
}

type SpeakerImageValue = Pick<PublicSpeakerResponse, 'name' | 'headshotUrl' | 'headshotFallback'> | PublicSessionResponse['speakers'][number]

export function speakerInitials(speaker: Pick<SpeakerImageValue, 'name' | 'headshotFallback'>) {
  const stored = speaker.headshotFallback.trim()
  if (/\p{L}|\p{N}/u.test(stored)) return stored
  const derived = speaker.name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => {
      const initial = Array.from(part).find((character) => /\p{L}|\p{N}/u.test(character))
      return initial ? Array.from(initial.toUpperCase())[0] ?? '' : ''
    })
    .join('')
  return /\p{L}|\p{N}/u.test(derived) ? derived : 'SP'
}

function SpeakerImage({ speaker, large = false, gallery = false }: { speaker: SpeakerImageValue; large?: boolean; gallery?: boolean }) {
  const className = gallery ? 'gallery-avatar' : `avatar avatar-soft${large ? ' public-speaker-avatar' : ''}`
  return speaker.headshotUrl ? <img className={className} src={speaker.headshotUrl} alt="" /> : <span className={className} aria-hidden="true">{speakerInitials(speaker)}</span>
}

function SessionDialog({ session, timeZone, onClose, onSpeaker }: { session: PublicSessionResponse; timeZone: string; onClose: () => void; onSpeaker: (slug: string) => void }) {
  const dialogRef = useDialogFocus(onClose)
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="session-title"><button className="dialog-close" type="button" onClick={onClose} aria-label="Close session details">×</button><span className="dialog-track" style={trackStyle(session.track)}>{session.track}</span><h2 id="session-title">{session.title}</h2><p>{session.abstract}</p><div className="dialog-meta"><span><small>When</small><strong>{session.schedule ? `${formatDate(session.schedule.date)} · ${formatTime(session.schedule.startsAt, timeZone)}–${formatTime(session.schedule.endsAt, timeZone)}` : 'Schedule to be announced'}</strong></span><span><small>Where</small><strong>{session.schedule?.room ?? 'Room TBA'}</strong></span><span><small>Format</small><strong>{formatFormat(session.format)} · {session.durationMinutes} min</strong></span></div><div className="dialog-speakers">{session.speakers.map((speaker) => <button className="dialog-speaker" type="button" key={speaker.slug} onClick={() => onSpeaker(speaker.slug)}><SpeakerImage speaker={speaker} large /><span><small>Speaker</small><strong>{speaker.name} →</strong><p>{speakerLine(speaker)}</p></span></button>)}</div></section></div>
}

function SpeakerDialog({ speaker, sessions, timeZone, onClose, onSession }: { speaker: PublicSpeakerResponse; sessions: PublicSessionResponse[]; timeZone: string; onClose: () => void; onSession: (slug: string) => void }) {
  const dialogRef = useDialogFocus(onClose)
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="session-dialog speaker-dialog" role="dialog" aria-modal="true" aria-labelledby="speaker-title"><button className="dialog-close" type="button" onClick={onClose} aria-label="Close speaker details">×</button><SpeakerImage speaker={speaker} large /><p className="overline">Speaker</p><h2 id="speaker-title">{speaker.name}</h2><strong>{[speaker.title, speaker.company].filter(Boolean).join(' · ')}</strong><ExpandableText text={speaker.bio || 'Speaker biography coming soon.'} label={`biography for ${speaker.name}`} className="speaker-bio" /><div className="linked-sessions"><small>Sessions ({speaker.sessions.length})</small>{speaker.sessions.map((linked) => { const session = sessions.find((candidate) => candidate.slug === linked.slug); const schedule = session?.schedule; return <button type="button" key={linked.slug} onClick={() => onSession(linked.slug)}><strong>{linked.title}</strong><span>{schedule ? `${formatDate(schedule.date)} · ${formatTime(schedule.startsAt, timeZone)}–${formatTime(schedule.endsAt, timeZone)} · ${schedule.room}` : linked.track} →</span></button> })}</div></section></div>
}

function useDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const dialog = dialogRef.current
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((element) => !element.hasAttribute('disabled'))
    focusable()[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleKey)
    return () => { window.removeEventListener('keydown', handleKey); trigger?.focus() }
  }, [])
  return dialogRef
}

export function ConnectedProgram({ eventSlug }: { eventSlug: string }) {
  const resource = useApiResource((signal) => programApi.program(eventSlug, signal), [eventSlug])
  if (resource.status === 'loading') return <PublicState title="Loading the live program" message="Fetching published sessions and speakers…" />
  if (resource.status === 'error') return <PublicState title="Program unavailable" message={resource.error.message} retry={resource.reload} />
  return <ProgramSurface data={resource.data} />
}

export function ConnectedPublicEmbed({ eventSlug, embedSlug }: { eventSlug: string; embedSlug: string }) {
  const resource = useApiResource((signal) => programApi.embed(eventSlug, embedSlug, signal), [eventSlug, embedSlug])
  if (resource.status === 'loading') return <PublicState title="Loading program embed" message="Fetching the latest published configuration…" />
  if (resource.status === 'error') return <PublicState title="Embed unavailable" message={resource.error.message} retry={resource.reload} />
  return <ProgramSurface data={resource.data.program} fixedView={resource.data.embed.view} fixedFilters={resource.data.embed.filters} embedded embedName={resource.data.embed.name} appearance={resource.data.embed.appearance} />
}

export function InvalidPublicEmbed() {
  return <PublicState title="Embed unavailable" message="The embed address is incomplete or malformed." />
}
