import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultEmbedAppearance } from '@confpilot/contracts'

import { App } from './App'
import { accessibleActionColor, compareSpeakersBySurname, resolveSourceUrl, speakerInitials } from './ConnectedProgram'

const organizerSession = { user: { id: 'organizer-1', email: 'organizer@example.test', displayName: 'Jordan Alvarez' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'organizer' }] }
const speakerSession = { user: { id: 'speaker-1', email: 'speaker@example.test', displayName: 'Priya Raman' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'speaker' }] }
const program = {
  event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027', tagline: 'Build software with confidence', location: 'Moscone West · San Francisco, CA', description: 'A practical conference for software teams.', startsOn: '2027-05-12', endsOn: '2027-05-14', timeZone: 'America/Los_Angeles', status: 'published' },
  sessions: [
    { slug: 'resilient-workflows', title: 'Resilient workflows', abstract: 'A practical guide to workflows that recover cleanly.', track: 'Platform & Infra', format: 'talk', durationMinutes: 30, publicationStatus: 'published', schedule: { dayNumber: 1, date: '2027-05-12', label: 'Wednesday, May 12', room: 'Room 2A', startsAt: '2027-05-12T17:00:00Z', endsAt: '2027-05-12T17:30:00Z' }, speakers: [{ slug: 'priya-raman', name: 'Priya Raman', title: 'Principal Engineer', company: 'Latticework Systems', headshotUrl: null, headshotFallback: 'PR' }] },
    { slug: 'trustworthy-evals', title: 'Trustworthy evals', abstract: 'A workshop for representative evaluation suites.', track: 'AI Engineering', format: 'workshop', durationMinutes: 120, publicationStatus: 'published', schedule: { dayNumber: 2, date: '2027-05-13', label: 'Thursday, May 13', room: 'Workshop Lab', startsAt: '2027-05-13T20:00:00Z', endsAt: '2027-05-13T22:00:00Z' }, speakers: [{ slug: 'sanaa-idris', name: 'Sanaa Idris', title: 'AI Reliability Engineer', company: 'Kinship', headshotUrl: null, headshotFallback: 'SI' }] },
  ],
  speakers: [
    { slug: 'priya-raman', name: 'Priya Raman', title: 'Principal Engineer', company: 'Latticework Systems', bio: 'Priya builds reliable developer infrastructure.', headshotUrl: null, headshotFallback: 'PR', publicVisibility: 'published', sessions: [{ slug: 'resilient-workflows', title: 'Resilient workflows', track: 'Platform & Infra', format: 'talk' }] },
    { slug: 'sanaa-idris', name: 'Sanaa Idris', title: 'AI Reliability Engineer', company: 'Kinship', bio: 'Sanaa builds evaluation systems.', headshotUrl: null, headshotFallback: 'SI', publicVisibility: 'published', sessions: [{ slug: 'trustworthy-evals', title: 'Trustworthy evals', track: 'AI Engineering', format: 'workshop' }] },
  ],
} as const
const embed = {
  id: 'embed-1', eventSlug: 'devflow-conf-2027', slug: 'website-program', name: 'Website program', view: 'sessions', filters: { days: [], tracks: [], formats: [], rooms: [] }, outputFormat: 'iframe', appearance: defaultEmbedAppearance, enabled: true, revision: 2,
  createdAt: '2026-08-11T12:00:00Z', updatedAt: '2026-08-11T13:00:00Z', publicPath: '/embed/devflow-conf-2027/website-program', jsonPath: '/api/public/events/devflow-conf-2027/embeds/website-program', calendarPath: '/api/public/events/devflow-conf-2027/embeds/website-program/calendar.ics',
} as const

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'program-test' } })
}

function pathOf(request: RequestInfo | URL) {
  const value = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
  return new URL(value, 'http://localhost').pathname
}

function renderAt(path: string) {
  window.history.replaceState({}, '', path)
  return render(<App />)
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
})

it('fails closed on a missing or invalid production source URL', () => {
  expect(() => resolveSourceUrl(undefined, false)).toThrow('VITE_SOURCE_URL')
  expect(() => resolveSourceUrl('javascript:alert(1)', false)).toThrow('VITE_SOURCE_URL')
  expect(() => resolveSourceUrl('https://user:password@git.example.org/operator/confpilot', false)).toThrow('VITE_SOURCE_URL')
  expect(resolveSourceUrl(undefined, true)).toBe('https://github.com/bishnubista/confpilot-open-source')
  expect(resolveSourceUrl('https://git.example.org/operator/confpilot', false)).toBe('https://git.example.org/operator/confpilot')
})

it('keeps interactive embed colors readable while preserving safe accents', () => {
  expect(accessibleActionColor('#FFFFFF', 'light')).toBe('#1D4ED8')
  expect(accessibleActionColor('#000000', 'dark')).toBe('#FACC15')
  expect(accessibleActionColor('#3157D5', 'light')).toBe('#3157D5')
})

it('orders public speakers by surname with a deterministic full-name tie-breaker', () => {
  const names = [
    { name: 'Zoe Adams' },
    { name: 'Amy Zeal' },
    { name: 'Ana Adams' },
    { name: 'Release Speaker 00082c6' },
    { name: 'Maria de la Cruz-7842' },
    { name: 'DJ Shadow2000' },
  ]
  expect(names.sort(compareSpeakersBySurname).map(({ name }) => name)).toEqual([
    'Ana Adams', 'Zoe Adams', 'Maria de la Cruz-7842', 'DJ Shadow2000', 'Release Speaker 00082c6', 'Amy Zeal',
  ])
})

it('derives visible public initials when legacy fallback data is blank-like', () => {
  expect(speakerInitials({ name: 'Priya Raman', headshotFallback: '—' })).toBe('PR')
  expect(speakerInitials({ name: 'Priya Raman', headshotFallback: 'P' })).toBe('P')
  expect(speakerInitials({ name: '—— ——', headshotFallback: '—' })).toBe('SP')
  expect(speakerInitials({ name: '·Priya ·Raman', headshotFallback: '-' })).toBe('PR')
  expect(speakerInitials({ name: 'ßeta ßeta', headshotFallback: '-' })).toBe('SS')
})

it('expands a bounded session description in place', async () => {
  const abstract = 'This detailed session description explains the design constraints, operational tradeoffs, failure modes, recovery steps, and concrete takeaways that attendees can use immediately.'
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: { ...program, sessions: [{ ...program.sessions[0], abstract }, program.sessions[1]] }, requestId: 'program-test' })))
  renderAt('/program')

  const expand = await screen.findByRole('button', { name: 'Show more description for Resilient workflows' })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText(abstract)).not.toBeInTheDocument()
  fireEvent.click(expand)
  expect(screen.getByText(abstract)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Show less description for Resilient workflows' })).toHaveAttribute('aria-expanded', 'true')
})

it('shows complete itinerary and speaker-session metadata', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program')

  fireEvent.click(await screen.findByRole('button', { name: 'By day' }))
  const itineraryButton = screen.getByRole('button', { name: 'Open Resilient workflows' })
  const itinerary = itineraryButton.closest('article')!
  expect(itineraryButton).toHaveTextContent('Resilient workflows')
  expect(itineraryButton).not.toHaveTextContent('A practical guide')
  expect(within(itinerary).getByText('A practical guide to workflows that recover cleanly.')).toBeInTheDocument()
  expect(within(itinerary).getByText('Principal Engineer · Latticework Systems')).toBeInTheDocument()
  expect(within(itinerary).getByText(/Wed, May 12 · 10:00 AM–10:30 AM · Room 2A/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Speakers' }))
  const priya = screen.getByRole('heading', { name: 'Priya Raman' }).closest('article')!
  fireEvent.click(within(priya).getByRole('button', { name: 'View speaker' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Sessions (1)')).toBeInTheDocument()
  expect(within(dialog).getByText(/Wed, May 12 · 10:00 AM–10:30 AM · Room 2A/)).toBeInTheDocument()
})

it('bounds itinerary descriptions without splitting supplementary-plane text', async () => {
  const abstract = `${'A'.repeat(136)}😀 ${'operational detail '.repeat(8)}`
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: { ...program, sessions: [{ ...program.sessions[0], abstract }, program.sessions[1]] }, requestId: 'program-test' })))
  renderAt('/program')

  fireEvent.click(await screen.findByRole('button', { name: 'By day' }))
  const itinerary = screen.getByRole('button', { name: 'Open Resilient workflows' }).closest('article')!
  expect(itinerary).not.toHaveTextContent('�')
  const expand = within(itinerary).getByRole('button', { name: 'Show more description for Resilient workflows' })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(expand)
  expect(itinerary.querySelector('.itinerary-description p')?.textContent).toBe(abstract)
})

it('renders every public mode from the live response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program')

  expect(await screen.findByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
  expect(screen.getByText('10:00 AM')).toBeInTheDocument()
  const navigation = screen.getByRole('navigation', { name: 'Public program' })
  const programLink = within(navigation).getByRole('link', { name: 'Program' })
  const speakersLink = within(navigation).getByRole('link', { name: 'Speakers' })
  fireEvent.click(screen.getByRole('button', { name: 'Agenda' }))
  expect(programLink).toHaveAttribute('aria-current', 'location')
  expect(screen.getByRole('region', { name: 'Agenda table' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Trustworthy evals/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'By day' }))
  expect(programLink).toHaveAttribute('aria-current', 'location')
  expect(screen.getByRole('button', { name: 'Open Resilient workflows' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Speakers' }))
  expect(speakersLink).toHaveAttribute('aria-current', 'location')
  expect(screen.getByText('Priya builds reliable developer infrastructure.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Gallery' }))
  expect(speakersLink).toHaveAttribute('aria-current', 'location')
  expect(screen.getByRole('button', { name: /Sanaa Idris/ })).toBeInTheDocument()
})

it('describes the published schedule truthfully and pluralizes one result', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program')

  expect(await screen.findByText('Browse the published schedule')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions and speakers' }), { target: { value: 'Resilient workflows' } })
  expect(screen.getByText('1 session')).toBeInTheDocument()
  expect(screen.queryByText('1 sessions')).not.toBeInTheDocument()
})

it('keeps the corresponding-source offer in the public program DOM', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program')

  const source = await screen.findByRole('link', { name: 'Source code (AGPL-3.0-or-later) ↗' })
  expect(source).toHaveAttribute('href', 'https://github.com/bishnubista/confpilot-open-source')
  expect(source.closest('footer')).toHaveClass('public-footer')
})

it('persists an anonymous personal schedule and exports exactly those sessions', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => pathOf(request) === '/api/program.ics'
    ? new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { headers: { 'content-type': 'text/calendar' } })
    : response({ data: program, requestId: 'program-test' }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:personal-schedule')
    static revokeObjectURL = vi.fn()
  })
  const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true)
    expect(this.download).toBe('devflow-conf-2027-my-schedule.ics')
  })
  const timeoutSpy = vi.spyOn(window, 'setTimeout')
  renderAt('/program')

  fireEvent.click(await screen.findByRole('button', { name: 'Add Resilient workflows to my schedule' }))
  fireEvent.click(screen.getByRole('button', { name: 'By day' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add Trustworthy evals to my schedule' }))
  fireEvent.click(screen.getByRole('button', { name: 'My schedule (2)' }))

  expect(screen.getByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Trustworthy evals' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Download my schedule (.ics)' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/program.ics',
    {
      method: 'POST',
      headers: {
        accept: 'text/calendar',
        'content-type': 'application/json',
        'x-confpilot-request': '1',
      },
      body: JSON.stringify({
        event: 'devflow-conf-2027',
        sessionSlugs: ['resilient-workflows', 'trustworthy-evals'],
      }),
    },
  ))
  expect(URL.createObjectURL).toHaveBeenCalled()
  expect(downloadClick).toHaveBeenCalledOnce()
  expect(document.querySelector('a[href="blob:personal-schedule"]')).not.toBeInTheDocument()
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000)

  cleanup()
  renderAt('/program')
  fireEvent.click(await screen.findByRole('button', { name: 'My schedule (2)' }))
  expect(screen.getByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Trustworthy evals' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Remove Resilient workflows from my schedule' }))
  expect(screen.queryByRole('heading', { name: 'Resilient workflows' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Trustworthy evals' })).toBeInTheDocument()
})

it('surfaces personal-calendar download failures', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => pathOf(request) === '/api/program.ics'
    ? response({ error: { code: 'SESSIONS_CHANGED', message: 'No longer public.' } }, 409)
    : response({ data: program, requestId: 'program-test' }))
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/program')

  fireEvent.click(await screen.findByRole('button', { name: 'Add Resilient workflows to my schedule' }))
  fireEvent.click(screen.getByRole('button', { name: 'My schedule (1)' }))
  fireEvent.click(screen.getByRole('button', { name: 'Download my schedule (.ics)' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not download your schedule')
})

it('bounds a personal schedule to the calendar export limit', async () => {
  const sessions = Array.from({ length: 101 }, (_, index) => ({
    ...program.sessions[0], slug: `session-${index + 1}`, title: `Session ${index + 1}`,
  }))
  window.localStorage.setItem(
    'confpilot:personal-schedule:v1:devflow-conf-2027',
    JSON.stringify(sessions.slice(0, 100).map((session) => session.slug)),
  )
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: { ...program, sessions }, requestId: 'program-test' })))
  renderAt('/program')

  fireEvent.click(await screen.findByRole('button', { name: 'Add Session 101 to my schedule' }))

  expect(screen.getByRole('status')).toHaveTextContent('up to 100 sessions')
  expect(screen.getByRole('link', { name: 'My schedule (100)' })).toBeInTheDocument()
})

it.each([
  ['malformed JSON', '{', 0],
  ['stale and non-string entries', JSON.stringify(['resilient-workflows', 'not-public', 42]), 1],
])('fails closed for %s in personal-schedule storage', async (_case, stored, expectedCount) => {
  window.localStorage.setItem('confpilot:personal-schedule:v1:devflow-conf-2027', stored)
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program')

  expect(await screen.findByRole('link', { name: `My schedule (${expectedCount})` })).toBeInTheDocument()
})

it('keeps personal-schedule controls out of session embeds', async () => {
  const publicEmbed = { embed: { slug: embed.slug, name: embed.name, view: embed.view, filters: embed.filters, appearance: embed.appearance, revision: embed.revision }, program }
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: publicEmbed, requestId: 'program-test' })))
  renderAt('/embed/devflow-conf-2027/website-program')

  expect(await screen.findByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
  expect(document.querySelector('.public-embed')).toHaveClass('embed-theme-light', 'embed-density-comfortable')
  expect(screen.getByRole('textbox', { name: 'Search sessions and speakers' })).toBeInTheDocument()
  expect(screen.getByText('A practical conference for software teams.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /my schedule/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /my schedule/i })).not.toBeInTheDocument()
})

it('opens the speaker view from the public header navigation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program')

  await screen.findByRole('heading', { name: 'Resilient workflows' })
  const navigation = screen.getByRole('navigation', { name: 'Public program' })
  const speakersLink = within(navigation).getByRole('link', { name: 'Speakers' })
  fireEvent.click(speakersLink)

  expect(window.location.hash).toBe('#speakers')
  expect(speakersLink).toHaveAttribute('aria-current', 'location')
  expect(screen.getByRole('button', { name: 'Speakers' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText('Priya builds reliable developer infrastructure.')).toBeInTheDocument()

  const programLink = within(navigation).getByRole('link', { name: 'Program' })
  fireEvent.click(programLink)
  expect(window.location.hash).toBe('#schedule')
  expect(programLink).toHaveAttribute('aria-current', 'location')
  expect(speakersLink).not.toHaveAttribute('aria-current')
  expect(screen.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
})

it('uses the fragment on direct load and follows browser history', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: program, requestId: 'program-test' })))
  renderAt('/program#speakers')

  const navigation = await screen.findByRole('navigation', { name: 'Public program' })
  const programLink = within(navigation).getByRole('link', { name: 'Program' })
  const speakersLink = within(navigation).getByRole('link', { name: 'Speakers' })
  expect(speakersLink).toHaveAttribute('aria-current', 'location')
  expect(screen.getByText('Priya builds reliable developer infrastructure.')).toBeInTheDocument()

  fireEvent.click(programLink)
  expect(window.location.hash).toBe('#schedule')
  expect(await screen.findByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()

  window.history.back()
  await waitFor(() => expect(speakersLink).toHaveAttribute('aria-current', 'location'))
  expect(screen.getByText('Priya builds reliable developer infrastructure.')).toBeInTheDocument()

  window.history.forward()
  await waitFor(() => expect(programLink).toHaveAttribute('aria-current', 'location'))
  expect(screen.getByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
})

it('shows a retryable public error and recovers from the next response', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response({ error: { code: 'PROGRAM_UNAVAILABLE', message: 'The published program is temporarily unavailable.', requestId: 'program-test' } }, 503))
    .mockResolvedValueOnce(response({ data: program, requestId: 'program-test' }))
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/program')

  expect(await screen.findByRole('heading', { name: 'Program unavailable' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('renders a filtered iframe route without organizer navigation or private data', async () => {
  const publicEmbed = { embed: { slug: 'ai-agenda', name: 'AI agenda', view: 'agenda', filters: { days: [], tracks: ['AI Engineering'], formats: [], rooms: [] }, appearance: defaultEmbedAppearance, revision: 1 }, program }
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    expect(pathOf(request)).toBe('/api/public/events/devflow-conf-2027/embeds/ai-agenda')
    return response({ data: publicEmbed, requestId: 'program-test' })
  }))
  renderAt('/embed/devflow-conf-2027/ai-agenda')

  const agenda = await screen.findByRole('region', { name: 'Agenda table' })
  expect(within(agenda).getByRole('button', { name: /Trustworthy evals/ })).toBeInTheDocument()
  expect(within(agenda).queryByText('Resilient workflows')).not.toBeInTheDocument()
  expect(within(screen.getByRole('combobox', { name: 'Filter by track' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['All tracks', 'AI Engineering'])
  expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
  expect(screen.queryByText('Jordan Alvarez')).not.toBeInTheDocument()
})

it('projects fixed embed filters into speaker counts and filter choices', async () => {
  const previewProgram = {
    event: program.event,
    sessions: [
      program.sessions[0],
      { ...program.sessions[1], speakers: [...program.sessions[1].speakers, program.sessions[0].speakers[0]] },
    ],
    speakers: [
      {
        ...program.speakers[0],
        sessions: [...program.speakers[0].sessions, {
          slug: program.sessions[1].slug,
          title: program.sessions[1].title,
          track: program.sessions[1].track,
          format: program.sessions[1].format,
        }],
      },
      program.speakers[1],
    ],
  }
  const publicEmbed = { embed: { slug: 'ai-speakers', name: 'AI speakers', view: 'speakers', filters: { days: [], tracks: ['AI Engineering'], formats: [], rooms: [] }, appearance: defaultEmbedAppearance, revision: 1 }, program: previewProgram }
  vi.stubGlobal('fetch', vi.fn(async () => response({ data: publicEmbed, requestId: 'program-test' })))
  renderAt('/embed/devflow-conf-2027/ai-speakers')

  const priya = (await screen.findByRole('heading', { name: 'Priya Raman' })).closest('article')!
  expect(within(priya).getByText('1 session')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Sanaa Idris' })).toBeInTheDocument()
  expect(within(screen.getByRole('combobox', { name: 'Filter by track' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['All tracks', 'AI Engineering'])
})

it.each(['/embed/', '/embed/a', '/embed/a/b/c', '/embed/a//b'])(
  'renders a bounded unavailable state for malformed embed path %s',
  (path) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderAt(path)

    expect(screen.getByRole('heading', { name: 'Embed unavailable' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Conference programs/ })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

it('does not request embed configurations for a non-organizer session', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    expect(pathOf(request)).toBe('/api/auth/session')
    return response({ data: speakerSession, requestId: 'program-test' })
  })
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/admin/embeds')

  expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Use a different account' })).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('previews unsaved presentation changes and persists JSON as the primary output', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds' && !init?.method) return response({ data: { embeds: [] }, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      return response({ data: { ...embed, ...input, id: 'embed-new', slug: input.slug, name: input.name, revision: 1, publicPath: `/embed/devflow-conf-2027/${input.slug}`, jsonPath: `/api/public/events/devflow-conf-2027/embeds/${input.slug}`, calendarPath: `/api/public/events/devflow-conf-2027/embeds/${input.slug}/calendar.ics` }, requestId: 'program-test' }, 201)
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/admin/embeds')

  const previewTab = await screen.findByRole('tab', { name: 'Preview' })
  fireEvent.click(previewTab)
  expect(previewTab).toHaveAttribute('aria-selected', 'true')
  expect(document.querySelector('.embed-admin-layout')).toHaveClass('mobile-preview')
  fireEvent.click(screen.getByRole('tab', { name: 'Configure' }))
  expect(document.querySelector('.embed-admin-layout')).toHaveClass('mobile-configure')
  fireEvent.click(await screen.findByRole('button', { name: '+ Add embed' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Partner agenda' } })
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'partner-agenda' } })
  expect(screen.getByRole('option', { name: 'Day-by-day schedule' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('View'), { target: { value: 'itinerary' } })
  fireEvent.change(screen.getByLabelText('Primary web output'), { target: { value: 'json' } })
  fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } })
  fireEvent.change(screen.getByLabelText('Accent color'), { target: { value: '#b45309' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show search' }))
  fireEvent.change(screen.getByLabelText(/Tracks/), { target: { value: 'Platform & Infra' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Talk' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Workshop' }))
  expect(screen.getByText('Visual rendering of the JSON-backed program')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Search sessions and speakers' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Resilient workflows' })).not.toBeInTheDocument()
  expect((document.querySelector('.embed-live-canvas .public-embed') as HTMLElement).style.getPropertyValue('--embed-accent')).toBe('#B45309')
  expect((document.querySelector('.embed-live-canvas .public-embed') as HTMLElement).style.getPropertyValue('--action')).toBe(accessibleActionColor('#B45309', 'dark'))
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Create embed' }))

  expect(await screen.findByText('Partner agenda saved as version 1.')).toBeInTheDocument()
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(String(post[1]?.body))).toEqual({ slug: 'partner-agenda', name: 'Partner agenda', view: 'itinerary', filters: { days: [], tracks: ['Platform & Infra'], formats: ['talk', 'workshop'], rooms: [] }, outputFormat: 'json', appearance: { ...defaultEmbedAppearance, theme: 'dark', accentColor: '#B45309', showSearch: false }, enabled: false })
  expect(screen.getByText(/http:\/\/localhost:3000\/embed\/devflow-conf-2027\/partner-agenda/)).toBeInTheDocument()
  expect(screen.getByText('http://localhost:3000/api/public/events/devflow-conf-2027/embeds/partner-agenda')).toBeInTheDocument()
  expect(screen.getByText('http://localhost:3000/api/public/events/devflow-conf-2027/embeds/partner-agenda/calendar.ics')).toBeInTheDocument()
  expect(screen.getByText('Three durable outputs share this saved configuration and its public eligibility rules.')).toBeInTheDocument()
  expect(screen.getByText('Primary output · JSON feed URL')).toBeInTheDocument()
})

it('exports a valid iframe snippet when the embed name contains HTML attribute characters', async () => {
  const namedEmbed = { ...embed, name: 'Partner "AI" & <Cloud> agenda' }
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds') return response({ data: { embeds: [namedEmbed] }, requestId: 'program-test' })
    throw new Error(`Unexpected request: GET ${path}`)
  }))
  renderAt('/admin/embeds')

  expect(await screen.findByText(/title="Partner &quot;AI&quot; &amp; &lt;Cloud&gt; agenda"/)).toBeInTheDocument()
})

it('persists enable and disable with the current revision', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds' && !init?.method) return response({ data: { embeds: [embed] }, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds/embed-1' && init?.method === 'PATCH') {
      const input = JSON.parse(String(init.body))
      return response({ data: { ...embed, ...input, revision: 3, updatedAt: '2026-08-11T13:05:00Z' }, requestId: 'program-test' })
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/admin/embeds')

  fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
  expect(await screen.findByText('Website program disabled.')).toBeInTheDocument()
  const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  expect(JSON.parse(String(patchCall[1]?.body))).toMatchObject({ enabled: false, revision: 2 })
  expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument()
})

it('protects unsaved presentation changes from quick enable and disable actions', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL, _init?: RequestInit) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds') return response({ data: { embeds: [embed] }, requestId: 'program-test' })
    throw new Error(`Unexpected request: GET ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/admin/embeds')

  expect(await screen.findByRole('region', { name: 'Saved embed preview' })).toBeInTheDocument()
  const name = screen.getByLabelText('Name')
  fireEvent.change(name, { target: { value: 'Unsaved program name' } })
  expect(screen.getByRole('region', { name: 'Unsaved embed preview' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Disable' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Save or discard your changes')
  expect(name).toHaveValue('Unsaved program name')
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
  expect(name).toHaveValue('Website program')
  expect(screen.getByRole('region', { name: 'Saved embed preview' })).toBeInTheDocument()
})

it('protects unsaved changes when the active saved embed is selected again', async () => {
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds') return response({ data: { embeds: [embed] }, requestId: 'program-test' })
    throw new Error(`Unexpected request: GET ${path}`)
  }))
  renderAt('/admin/embeds')

  const name = await screen.findByLabelText('Name')
  fireEvent.change(name, { target: { value: 'Keep this unsaved name' } })
  fireEvent.click(screen.getByRole('button', { name: /Website programSessions listVersion 2/ }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Save or discard your changes')
  expect(name).toHaveValue('Keep this unsaved name')
})

it('round-trips comma-bearing filter values without a false dirty state or preview drift', async () => {
  const commaTrack = 'Data, ML & AI'
  const commaProgram = {
    ...program,
    sessions: [{ ...program.sessions[0], track: commaTrack }],
    speakers: [{ ...program.speakers[0], sessions: [{ ...program.speakers[0].sessions[0], track: commaTrack }] }],
  }
  const commaEmbed = { ...embed, filters: { ...embed.filters, tracks: [commaTrack] } }
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: commaProgram, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds') return response({ data: { embeds: [commaEmbed] }, requestId: 'program-test' })
    throw new Error(`Unexpected request: GET ${path}`)
  }))
  renderAt('/admin/embeds')

  const preview = await screen.findByRole('region', { name: 'Saved embed preview' })
  expect(within(preview).getByRole('heading', { name: 'Resilient workflows' })).toBeInTheDocument()
  expect(within(within(preview).getByRole('combobox', { name: 'Filter by track' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['All tracks', commaTrack])
  expect(screen.getByLabelText(/Tracks/)).toHaveValue(commaTrack)
})

it('keeps the public-disabled warning visible while editing a disabled embed', async () => {
  const disabledEmbed = { ...embed, enabled: false }
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds') return response({ data: { embeds: [disabledEmbed] }, requestId: 'program-test' })
    throw new Error(`Unexpected request: GET ${path}`)
  }))
  renderAt('/admin/embeds')

  expect(await screen.findByText('Design preview · public embed disabled')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited disabled embed' } })
  expect(screen.getByText('Design preview · public embed disabled')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Unsaved embed preview' })).toBeInTheDocument()
})

it('updates a saved embed with its complete current configuration', async () => {
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds' && !init?.method) return response({ data: { embeds: [embed] }, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds/embed-1' && init?.method === 'PATCH') {
      const input = JSON.parse(String(init.body))
      return response({ data: { ...embed, ...input, revision: 3, updatedAt: '2026-08-11T13:05:00Z' }, requestId: 'program-test' })
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  renderAt('/admin/embeds')

  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Partner speaker gallery' } })
  fireEvent.change(screen.getByLabelText('View'), { target: { value: 'gallery' } })
  fireEvent.change(screen.getByLabelText(/Rooms/), { target: { value: 'Main Stage' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

  expect(await screen.findByText('Partner speaker gallery saved as version 3.')).toBeInTheDocument()
  const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!
  expect(JSON.parse(String(patchCall[1]?.body))).toEqual({ name: 'Partner speaker gallery', view: 'gallery', filters: { days: [], tracks: [], formats: [], rooms: ['Main Stage'] }, outputFormat: 'iframe', appearance: defaultEmbedAppearance, enabled: true, revision: 2 })
})

it('refreshes a conflicting revision while preserving the edited input for a successful retry', async () => {
  let listCount = 0
  let patchCount = 0
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(request)
    if (path === '/api/auth/session') return response({ data: organizerSession, requestId: 'program-test' })
    if (path === '/api/program') return response({ data: program, requestId: 'program-test' })
    if (path === '/api/events/devflow-conf-2027/embeds' && !init?.method) {
      listCount += 1
      return response({ data: { embeds: [{ ...embed, revision: listCount === 1 ? 2 : 3 }] }, requestId: 'program-test' })
    }
    if (path === '/api/events/devflow-conf-2027/embeds/embed-1' && init?.method === 'PATCH') {
      patchCount += 1
      const input = JSON.parse(String(init.body))
      if (patchCount === 1) return response({ error: { code: 'EMBED_CONFLICT', message: 'This embed changed in another session.', requestId: 'program-test' } }, 409)
      expect(input).toMatchObject({ name: 'Unsaved partner program', revision: 3 })
      return response({ data: { ...embed, ...input, revision: 4 }, requestId: 'program-test' })
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
  }))
  renderAt('/admin/embeds')

  const name = await screen.findByLabelText('Name')
  fireEvent.change(name, { target: { value: 'Unsaved partner program' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  const alert = await screen.findByRole('alert')
  await waitFor(() => expect(alert).toHaveFocus())
  expect(name).toHaveValue('Unsaved partner program')
  expect(alert).toHaveTextContent('Reloaded version 3')

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByText('Unsaved partner program saved as version 4.')).toBeInTheDocument()
  expect(patchCount).toBe(2)
})
