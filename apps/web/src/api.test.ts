import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultEmbedAppearance } from '@confpilot/contracts'

import { agendaApi, ApiError, AUTH_SESSION_CHANGED_EVENT, cfpApi, decisionApi, embedApi, organizerSpeakerContentApi, programApi, reviewApi, speakerApi, speakerContentApi } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('review API client', () => {
  it('normalizes assignment due dates to the zero-fraction contract format', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 'assignment-1', round: 1, blind: true, dueAt: '2027-04-20T17:00:00Z', status: 'pending', invitationStatus: 'pending',
        assignedAt: '2026-08-11T13:00:00Z', revokedAt: null,
        proposal: { id: 'proposal-1', publicId: 'ABS-1', title: 'A resilient program workflow' },
        reviewer: { userId: 'reviewer-1', displayName: 'Sam Reviewer', email: 'reviewer@example.test' },
      },
      requestId: 'request-assignment',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await reviewApi.assign('devflow-conf-2027', 'proposal-1', { reviewerUserId: 'reviewer-1', blind: true, dueAt: '2027-04-20T17:00:00.000Z' })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({ dueAt: '2027-04-20T17:00:00Z' })
  })

  it('rejects an invalid assignment due date before issuing a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(reviewApi.assign('devflow-conf-2027', 'proposal-1', { reviewerUserId: 'reviewer-1', blind: true, dueAt: 'not-a-date' })).rejects.toMatchObject({
      code: 'INVALID_INPUT', message: 'Enter a valid due date.',
    } satisfies Partial<ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('validates, normalizes, and marks an immutable scorecard mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'review-1', originality: 4, relevance: 5, recommendation: 'accept', comment: 'Evidence-backed.', submittedAt: '2026-08-11T13:00:00.000Z' },
      requestId: 'request-review',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await reviewApi.submit('devflow conf/2027', 'assignment/1', { originality: 4, relevance: 5, recommendation: 'accept', comment: '  Evidence-backed.  ' })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/events/devflow%20conf%2F2027/review/assignments/assignment%2F1/review')
    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(request.headers).get('x-confpilot-request')).toBe('1')
    expect(request.credentials).toBe('same-origin')
    expect(JSON.parse(String(request.body))).toEqual({ originality: 4, relevance: 5, recommendation: 'accept', comment: 'Evidence-backed.' })
  })

  it('rejects invalid scorecards before issuing a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(reviewApi.submit('devflow-conf-2027', 'assignment-1', { originality: 3, relevance: 3, recommendation: 'discuss', comment: '  ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when a review queue response drifts from the shared contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { assignments: [{ id: 'assignment-1', blind: 1 }] } }), { status: 200 })))

    await expect(reviewApi.queue('devflow-conf-2027')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<ApiError>)
  })
})

describe('CFP API client', () => {
  it('invalidates shared workspace state on a protected 401 but not invalid credentials', async () => {
    const changed: Array<unknown> = []
    const record = (event: Event) => changed.push((event as CustomEvent).detail)
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, record)
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Expired.' } }), { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' } }), { status: 401 }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(cfpApi.organizerConfig('devflow-conf-2027')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
      await expect(cfpApi.login({ email: 'organizer@example.test', password: 'wrong-password' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })

      expect(changed).toEqual([null])
    } finally {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, record)
    }
  })

  it('does not let an older protected 401 clear a newer authenticated session', async () => {
    const changed: Array<unknown> = []
    const record = (event: Event) => changed.push((event as CustomEvent).detail)
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, record)
    let resolveProtected: ((response: Response) => void) | undefined
    const protectedResponse = new Promise<Response>((resolve) => { resolveProtected = resolve })
    const nextSession = {
      user: { id: 'user-reviewer', email: 'reviewer@example.test', displayName: 'Review User' },
      memberships: [{ eventSlug: 'devflow-conf-2027', role: 'reviewer' }],
    }
    try {
      const fetchMock = vi.fn((request: RequestInfo | URL) => {
        const path = typeof request === 'string' ? request : request instanceof URL ? request.pathname : new URL(request.url).pathname
        if (path === '/api/events/devflow-conf-2027/cfp') return protectedResponse
        if (path === '/api/auth/login') return Promise.resolve(new Response(JSON.stringify({ data: nextSession }), { status: 200 }))
        throw new Error(`Unexpected request: ${path}`)
      })
      vi.stubGlobal('fetch', fetchMock)

      const staleRequest = cfpApi.organizerConfig('devflow-conf-2027')
      await cfpApi.login({ email: nextSession.user.email, password: 'test-password-123' })
      resolveProtected?.(new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Expired.' } }), { status: 401 }))
      await expect(staleRequest).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })

      expect(changed).toEqual([nextSession])
    } finally {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, record)
    }
  })

  it('signs out with the same-origin mutation guard and accepts an empty response', async () => {
    const changed: Array<unknown> = []
    const record = (event: Event) => changed.push((event as CustomEvent).detail)
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, record)
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)

      await cfpApi.logout()

      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
      expect(headers.get('x-confpilot-request')).toBe('1')
      expect(changed).toEqual([null])
    } finally {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, record)
    }
  })

  it('requires verification before issuing a registration request', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(() => cfpApi.register('example-conf', {
      displayName: 'Avery Quinn', email: 'avery@example.com', password: 'test-only-password-123', title: '', company: '', bio: '',
    } as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks mutations for the Worker same-origin guard', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 'proposal-1', publicId: 'ABS-TEST', status: 'draft', submittedAt: null,
        createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z',
        clientDraftKey: 'web-draft-key', decision: null, values: { title: 'A proposal' },
      },
      requestId: 'request-1',
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await cfpApi.createProposal('devflow-conf-2027', { clientDraftKey: 'web-draft-key', values: { title: 'A proposal' } })

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(request.headers).get('x-confpilot-request')).toBe('1')
    expect(request.credentials).toBe('same-origin')
  })

  it('fails closed when a successful response drifts from the shared contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { proposals: 'not-an-array' } }), { status: 200 })))

    await expect(cfpApi.proposals('devflow-conf-2027')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<ApiError>)
  })

  it('retains field-addressable validation issues and the request id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'PROPOSAL_INCOMPLETE', message: 'Complete the required fields.', requestId: 'request-2',
      issues: [{ field: 'abstract', message: 'This field is required.' }],
    } }), { status: 400 })))

    await expect(cfpApi.submitProposal('devflow-conf-2027', 'proposal-1')).rejects.toMatchObject({
      code: 'PROPOSAL_INCOMPLETE', requestId: 'request-2', issues: [{ field: 'abstract', message: 'This field is required.' }],
    } satisfies Partial<ApiError>)
  })
})

describe('decision and speaker API clients', () => {
  const proposal = { id: 'proposal-1', publicId: 'ABS-1', slug: 'resilient-workflows', title: 'Resilient workflows' }
  const decision = { id: 'decision-1', value: 'accept', rationale: 'Strong evidence.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }

  it('records only the contract decision fields and relies on server idempotency', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      proposal, decision,
      handoff: { status: 'materialized', acceptanceId: 'acceptance-1', acceptedAt: '2026-08-11T13:00:00Z', programSession: { id: 'session-1', slug: 'resilient-workflows' } },
      notification: { status: 'not_queued' },
    } }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await decisionApi.record('devflow-conf-2027', { proposalId: 'proposal-1', decision: 'accept', rationale: '  Strong evidence.  ' })

    const [, init] = fetchMock.mock.calls[0]
    expect(fetchMock.mock.calls[0][0]).toBe('/api/events/devflow-conf-2027/decisions')
    expect(JSON.parse(String(init.body))).toEqual({ proposalId: 'proposal-1', decision: 'accept', rationale: 'Strong evidence.' })
    expect(String(init.body)).not.toContain('idempotency')
  })

  it('previews without a write and queues through a separate mutation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { proposal, decision: { id: decision.id, value: decision.value }, recipient: { speakerId: 'speaker-1', userId: 'user-1', name: 'Priya Raman', email: 'priya@example.test' }, subject: 'Your decision', body: 'Hello Priya' } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'notification-1', status: 'queued', recipient: { speakerId: 'speaker-1', userId: 'user-1', name: 'Priya Raman', email: 'priya@example.test' }, subject: 'Updated subject', body: 'Updated body', queuedAt: '2026-08-11T13:05:00Z' } }), { status: 201, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await decisionApi.previewNotification('devflow-conf-2027', 'decision-1')
    await decisionApi.queueNotification('devflow-conf-2027', 'decision-1', { subject: ' Updated subject ', body: ' Updated body ' })

    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined()
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('x-confpilot-request')).toBeNull()
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ subject: 'Updated subject', body: 'Updated body' })
  })

  it('fails closed when the owner workspace response omits exact decision state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' }, proposals: [{ id: 'proposal-other' }] } }), { status: 200 })))

    await expect(speakerApi.workspace('devflow-conf-2027')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<ApiError>)
  })
})

describe('speaker content API clients', () => {
  it('fails closed when the connected speaker workspace contains an unscoped shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' },
      speaker: { id: 'speaker-1' },
      sessions: [{ id: 'session-1', otherPresenterTasks: [{ id: 'private-task' }] }],
    } }), { status: 200 })))

    await expect(speakerContentApi.workspace('devflow-conf-2027')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<ApiError>)
  })

  it('validates a profile revision before issuing a mutation', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(() => speakerContentApi.profile('devflow-conf-2027', {
      name: 'Sam Speaker', contactEmail: 'sam@example.test', title: '', company: '', bio: '', socialUrls: { website: null, linkedin: null, x: null }, travelPreferences: '', revision: 0,
    })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a speaker-owned visibility change before issuing a mutation', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(() => speakerContentApi.profile('devflow-conf-2027', {
      name: 'Sam Speaker', contactEmail: 'sam@example.test', title: '', company: '', bio: '',
      socialUrls: { website: null, linkedin: null, x: null }, travelPreferences: '',
      publicVisibility: 'published', revision: 1,
    } as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploads multipart content without overriding its boundary and carries the required idempotency key', async () => {
    const version = {
      id: 'version-1', requestId: 'request-1', sessionId: 'session-1', requestType: 'presentation', versionNumber: 1, originalFilename: 'slides.pdf', contentType: 'application/pdf', byteSize: 6, sha256: 'a'.repeat(64), note: 'First pass', uploader: { speakerId: 'speaker-1', name: 'Sam Speaker' }, uploadedAt: '2026-08-11T13:00:00Z', downloadPath: '/api/events/devflow-conf-2027/speaker/deliverables/version-1/file', publicUrl: null,
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { version, session: { id: 'session-1', deliverablesStatus: 'submitted', approvalStatus: 'pending', revision: 2 } } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    await speakerContentApi.upload('devflow conf/2027', 'request/1', new File(['slides'], 'slides.pdf', { type: 'application/pdf' }), ' First pass ', 'retry-key-123')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/events/devflow%20conf%2F2027/speaker/deliverables/request%2F1/versions')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(init.body).toBeInstanceOf(FormData)
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('idempotency-key')).toBe('retry-key-123')
    expect(headers.get('x-confpilot-request')).toBe('1')
    expect((init.body as FormData).get('note')).toBe('First pass')
  })

  it('sends only the explicit approval transition and validates the canonical list response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' },
      approvedDeliverablesArchivePath: '/api/events/devflow-conf-2027/content/deliverables.zip',
      sessions: [],
    } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await organizerSpeakerContentApi.approval('devflow-conf-2027', 'session/1', { approvalStatus: 'approved', expectedRevision: 7 })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/events/devflow-conf-2027/content/session%2F1/approval')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ approvalStatus: 'approved', expectedRevision: 7 })
  })

  it('rejects an invalid approval revision before a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(() => organizerSpeakerContentApi.approval('devflow-conf-2027', 'session-1', { approvalStatus: 'approved', expectedRevision: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('program and embed API clients', () => {
  it('requests the public program with an encoded event query and validates the response', async () => {
    const data = {
      event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027', tagline: '', location: '', description: '', startsOn: '2027-05-12', endsOn: '2027-05-14', timeZone: 'UTC', status: 'published' },
      sessions: [], speakers: [],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await programApi.program('devflow conf/2027')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/program?event=devflow+conf%2F2027')
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('same-origin')
  })

  it('fails closed when anonymous embed data contains an unpublished field shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { embed: { slug: 'website', view: 'sessions' }, program: { sessions: 'private rows' } } }), { status: 200 })))

    await expect(programApi.embed('devflow-conf-2027', 'website')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<ApiError>)
  })

  it('validates embed input before mutation and marks PATCH requests as same-origin writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      id: 'embed-1', eventSlug: 'devflow-conf-2027', slug: 'website', name: 'Website', view: 'sessions', filters: { days: [], tracks: [], formats: [], rooms: [] }, outputFormat: 'iframe', appearance: defaultEmbedAppearance, enabled: true, revision: 2,
      createdAt: '2026-08-11T12:00:00Z', updatedAt: '2026-08-11T13:00:00Z', publicPath: '/embed/devflow-conf-2027/website', jsonPath: '/api/public/events/devflow-conf-2027/embeds/website', calendarPath: '/api/public/events/devflow-conf-2027/embeds/website/calendar.ics',
    } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(embedApi.create('devflow-conf-2027', { slug: 'Bad Slug', name: 'Website', view: 'sessions', filters: { days: [], tracks: [], formats: [], rooms: [] }, outputFormat: 'iframe', appearance: defaultEmbedAppearance, enabled: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()

    await embedApi.update('devflow-conf-2027', 'embed/1', { name: 'Website', view: 'sessions', filters: { days: [], tracks: [], formats: [], rooms: [] }, outputFormat: 'iframe', appearance: defaultEmbedAppearance, enabled: true, revision: 1 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/events/devflow-conf-2027/embeds/embed%2F1')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('PATCH')
    expect(new Headers(init.headers).get('x-confpilot-request')).toBe('1')
  })
})

describe('agenda API client', () => {
  const emptyAgenda = {
    event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027', timeZone: 'UTC', status: 'draft', agendaPublishedAt: null },
    publication: { publicSessionCount: 0, unplacedCount: 0, contentNotApprovedCount: 0,
      primarySpeakerNotPublicCount: 0, readinessBlockedCount: 0, awaitingPublicationCount: 0 },
    days: [], rooms: [], tracks: [], sessions: [], conflicts: [],
  }

  it('validates placement input before issuing a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(agendaApi.createPlacement('devflow-conf-2027', {
      sessionId: 'session-1', dayId: 'day-1', roomId: 'room-1', startsAt: 'not-a-timestamp',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' } satisfies Partial<ApiError>)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('encodes placement identity and sends revisioned DELETE input through the same-origin guard', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: emptyAgenda }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await agendaApi.deletePlacement('devflow conf/2027', 'placement/1', { expectedRevision: 3 })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/events/devflow%20conf%2F2027/agenda/placements/placement%2F1?expectedRevision=3')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('x-confpilot-request')).toBe('1')
  })

  it('fails closed when an auto-place response omits its canonical agenda', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { results: [] } }), { status: 200 })))

    await expect(agendaApi.autoPlace('devflow-conf-2027', { sessionIds: [] }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' } satisfies Partial<ApiError>)
  })
})
