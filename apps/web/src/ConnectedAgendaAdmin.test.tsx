import type { AgendaAutoPlaceResponse, AgendaPublishResponse, AgendaResponse, AuthSession } from '@confpilot/contracts'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectedAgendaAdmin } from './ConnectedAgendaAdmin'

const organizerSession: AuthSession = {
  user: { id: 'user-organizer', email: 'organizer@example.test', displayName: 'Jordan Alvarez' },
  memberships: [{ eventSlug: 'devflow-conf-2027', role: 'organizer' }],
}

function agenda(placed: boolean): AgendaResponse {
  return {
    event: {
      slug: 'devflow-conf-2027',
      name: 'DevFlow Conf 2027',
      timeZone: 'America/Los_Angeles',
      status: 'scheduled',
      agendaPublishedAt: null,
    },
    publication: {
      publicSessionCount: 0,
      unplacedCount: placed ? 0 : 1,
      contentNotApprovedCount: 0,
      primarySpeakerNotPublicCount: 0,
      readinessBlockedCount: 0,
      awaitingPublicationCount: placed ? 1 : 0,
    },
    days: [{
      id: 'day-1', dayNumber: 1, date: '2027-05-12', label: 'Wednesday, May 12',
      opensAt: '2027-05-12T16:00:00Z', closesAt: '2027-05-12T23:00:00Z', slotMinutes: 15, revision: 1,
    }],
    rooms: [{ id: 'room-1', name: 'Room 2A', capacity: 120, sortOrder: 1, revision: 1 }],
    tracks: [{ id: 'track-1', name: 'Platform & Infra', color: 'blue', sortOrder: 1, revision: 1 }],
    sessions: [{
      id: 'session-1', slug: 'taming-ci', title: 'Taming 40-Minute CI', track: 'Platform & Infra',
      format: 'talk', durationMinutes: 30, acceptanceStatus: 'accepted', approvalStatus: 'approved',
      publicationStatus: 'ready', revision: 1,
      presenters: [{ id: 'speaker-1', slug: 'priya-raman', name: 'Priya Raman', role: 'primary' }],
      placement: placed ? {
        id: 'placement-1', dayId: 'day-1', roomId: 'room-1', startsAt: '2027-05-12T16:00:00Z',
        endsAt: '2027-05-12T16:30:00Z', revision: 1,
      } : null,
    }],
    conflicts: [],
  }
}

function skippedSession(id: string): AgendaResponse['sessions'][number] {
  return {
    ...agenda(true).sessions[0]!, id, slug: id, title: `Session ${id}`,
    approvalStatus: 'pending', publicationStatus: 'private',
    presenters: [{ id: `speaker-${id}`, slug: `speaker-${id}`, name: `Speaker ${id}`, role: 'primary' }],
    placement: { ...agenda(true).sessions[0]!.placement!, id: `placement-${id}` },
  }
}

function json(data: unknown) {
  return new Response(JSON.stringify({ data, requestId: 'agenda-test' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ConnectedAgendaAdmin deterministic scheduling action', () => {
  let currentAgenda: AgendaResponse
  let autoPlaceCalls: number
  let autoPlaceAgenda: AgendaResponse | null
  let autoPlaceResults: AgendaAutoPlaceResponse['results'] | null
  let publishResult: AgendaPublishResponse | null

  beforeEach(() => {
    currentAgenda = agenda(false)
    autoPlaceCalls = 0
    autoPlaceAgenda = null
    autoPlaceResults = null
    publishResult = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname
      if (path === '/api/auth/session') return json(organizerSession)
      if (path === '/api/events/devflow-conf-2027/agenda' && (!init?.method || init.method === 'GET')) {
        return json(currentAgenda)
      }
      if (path === '/api/events/devflow-conf-2027/agenda/auto-place' && init?.method === 'POST') {
        autoPlaceCalls += 1
        if (autoPlaceResults) return json({ agenda: autoPlaceAgenda ?? currentAgenda, results: autoPlaceResults })
        currentAgenda = agenda(true)
        return json({
          agenda: currentAgenda,
          results: [{ sessionId: 'session-1', status: 'placed', placement: currentAgenda.sessions[0]!.placement }],
        })
      }
      if (path === '/api/events/devflow-conf-2027/agenda/publish' && init?.method === 'POST' && publishResult) {
        return json(publishResult)
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`)
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('names the action for the remaining work and explains the deterministic result', async () => {
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Auto-place 1 in earliest slots' }))

    expect(await screen.findByText(
      '1 session scheduled into the earliest available slots. Room and speaker conflicts were prevented.',
    )).toBeInTheDocument()
    expect(autoPlaceCalls).toBe(1)
    expect(screen.getByRole('button', { name: 'Auto-place 0 in earliest slots' })).toBeEnabled()
  })

  it('keeps the zero-work action enabled and reports a local no-op', async () => {
    currentAgenda = agenda(true)
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    const action = await screen.findByRole('button', { name: 'Auto-place 0 in earliest slots' })
    expect(action).toBeEnabled()
    fireEvent.click(action)

    expect(screen.getByText('Nothing to schedule. Every accepted session is already placed.')).toBeInTheDocument()
    expect(autoPlaceCalls).toBe(0)
  })

  it('uses singular grammar when one session still needs manual placement after partial scheduling', async () => {
    autoPlaceAgenda = agenda(true)
    autoPlaceResults = [
      { sessionId: 'session-1', status: 'placed', placement: autoPlaceAgenda.sessions[0]!.placement! },
      { sessionId: 'session-2', status: 'unplaced', reason: 'NO_AVAILABLE_SLOT' },
    ]
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Auto-place 1 in earliest slots' }))

    expect(await screen.findByText(
      '1 session of 2 scheduled into the earliest available slots. 1 needs manual placement; room and speaker conflicts were prevented.',
    )).toBeInTheDocument()
  })

  it('uses plural grammar when multiple sessions need manual placement', async () => {
    autoPlaceResults = [
      { sessionId: 'session-1', status: 'unplaced', reason: 'NO_AVAILABLE_SLOT' },
      { sessionId: 'session-2', status: 'unplaced', reason: 'NO_AVAILABLE_SLOT' },
    ]
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Auto-place 1 in earliest slots' }))

    expect(await screen.findByText(
      'No sessions could be scheduled automatically. 2 need manual placement; no room or speaker conflicts were introduced.',
    )).toBeInTheDocument()
  })

  it('reports newly public and skipped publication results truthfully', async () => {
    currentAgenda = agenda(true)
    const publishedAgenda: AgendaResponse = {
      ...currentAgenda,
      event: { ...currentAgenda.event, status: 'published', agendaPublishedAt: '2027-04-20T18:00:00Z' },
      publication: {
        publicSessionCount: 1, unplacedCount: 0, contentNotApprovedCount: 2,
        primarySpeakerNotPublicCount: 0, readinessBlockedCount: 0, awaitingPublicationCount: 0,
      },
      sessions: [
        ...currentAgenda.sessions.map((session) => ({ ...session, publicationStatus: 'published' as const })),
        skippedSession('session-2'), skippedSession('session-3'),
      ],
    }
    publishResult = {
      agenda: publishedAgenda,
      publication: {
        outcome: 'changed', newlyPublicSessionCount: 1, publicSessionCount: 1,
        skipped: [{ reason: 'CONTENT_NOT_APPROVED', count: 2 }],
      },
      publicPaths: { program: '/program', calendar: '/api/program.ics?event=devflow-conf-2027' },
    }
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Publish program' }))

    expect(await screen.findByText(
      '1 session is newly public; 1 session is in the attendee program. 2 skipped: 2 awaiting content approval.',
    )).toBeInTheDocument()
    expect(screen.getByText('1 public · 3 placed · 3 accepted')).toBeInTheDocument()
    expect(screen.getByText('2 placed sessions are not public: 2 await content approval.')).toBeInTheDocument()
  })

  it('makes a published program with no pending work visibly current', async () => {
    currentAgenda = agenda(true)
    currentAgenda = {
      ...currentAgenda,
      event: { ...currentAgenda.event, status: 'published', agendaPublishedAt: '2027-04-20T18:00:00Z' },
      publication: {
        publicSessionCount: 1, unplacedCount: 0, contentNotApprovedCount: 0,
        primarySpeakerNotPublicCount: 0, readinessBlockedCount: 0, awaitingPublicationCount: 0,
      },
      sessions: currentAgenda.sessions.map((session) => ({ ...session, publicationStatus: 'published' })),
    }
    publishResult = {
      agenda: currentAgenda,
      publication: { outcome: 'unchanged', newlyPublicSessionCount: 0, publicSessionCount: 1, skipped: [] },
      publicPaths: { program: '/program', calendar: '/api/program.ics?event=devflow-conf-2027' },
    }
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    expect(await screen.findByRole('button', { name: 'Program is up to date' })).toBeDisabled()
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes('/agenda/publish') && init?.method === 'POST')).toBe(false)
  })

  it('explains when a private primary speaker keeps a session out of the public program', async () => {
    currentAgenda = agenda(true)
    const privateSpeakerSession = {
      ...skippedSession('session-private'), approvalStatus: 'approved' as const,
    }
    const publishedAgenda: AgendaResponse = {
      ...currentAgenda,
      event: { ...currentAgenda.event, status: 'published', agendaPublishedAt: '2027-04-20T18:00:00Z' },
      publication: {
        publicSessionCount: 1, unplacedCount: 0, contentNotApprovedCount: 0,
        primarySpeakerNotPublicCount: 1, readinessBlockedCount: 0, awaitingPublicationCount: 0,
      },
      sessions: [
        ...currentAgenda.sessions.map((session) => ({ ...session, publicationStatus: 'published' as const })),
        privateSpeakerSession,
      ],
    }
    publishResult = {
      agenda: publishedAgenda,
      publication: {
        outcome: 'changed', newlyPublicSessionCount: 1, publicSessionCount: 1,
        skipped: [{ reason: 'PRIMARY_SPEAKER_NOT_PUBLIC', count: 1 }],
      },
      publicPaths: { program: '/program', calendar: '/api/program.ics?event=devflow-conf-2027' },
    }
    render(<ConnectedAgendaAdmin eventSlug="devflow-conf-2027" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Publish program' }))

    expect(await screen.findByText(
      '1 session is newly public; 1 session is in the attendee program. 1 skipped: 1 with a private primary speaker.',
    )).toBeInTheDocument()
  })
})
