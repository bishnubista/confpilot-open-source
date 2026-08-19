import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { defaultEmbedAppearance } from '@confpilot/contracts'
import type { SpeakerProfileResponse } from '@confpilot/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { cfpApi } from './api'
import { SOURCE_URL } from './ConnectedProgram'
import styles from './styles.css?raw'
import { DEMO_STORAGE_KEY, initialWorkflow } from './workflowStore'

function renderAt(path: string) {
  window.history.replaceState({}, '', path)
  return render(<App />)
}

async function openTaskTab(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }))
}

function requestPath(request: RequestInfo | URL) {
  const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
  return new URL(requestUrl, 'http://localhost').pathname
}

const cfpConfig = {
  event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027', tagline: 'The developer workflow conference', location: 'Moscone West, San Francisco, CA', description: 'A three-day conference for software builders.', startsOn: '2027-05-12', endsOn: '2027-05-14' },
  status: 'published', state: 'open', opensAt: '2026-08-01T00:00:00Z', closesAt: '2027-04-30T23:59:00Z', confirmationMessage: 'Thanks for sharing your proposal. You can view its status from this account.', turnstile: { enabled: true, siteKey: 'test-site-key' }, revision: 1,
  fields: [
    { key: 'title', section: 'session', type: 'short_text', label: 'Title', helpText: 'Make it clear and specific.', required: true, options: [], sortOrder: 10, showWhen: null },
    { key: 'abstract', section: 'session', type: 'long_text', label: 'Abstract', helpText: 'Describe what attendees will learn.', required: true, options: [], sortOrder: 20, showWhen: null },
    { key: 'track', section: 'session', type: 'dropdown', label: 'Track', helpText: '', required: true, options: [{ value: 'AI Engineering', label: 'AI Engineering' }, { value: 'Platform & Infra', label: 'Platform & Infra' }], sortOrder: 30, showWhen: null },
    { key: 'format', section: 'session', type: 'dropdown', label: 'Format', helpText: '', required: true, options: [{ value: 'talk', label: 'Talk (30 min)', durationMinutes: 30 }, { value: 'workshop', label: 'Workshop (120 min)', durationMinutes: 120 }], sortOrder: 40, showWhen: null },
    { key: 'key_takeaway', section: 'session', type: 'short_text', label: 'Key takeaway', helpText: '', required: true, options: [], sortOrder: 50, showWhen: null },
    { key: 'audience_level', section: 'session', type: 'dropdown', label: 'Audience level', helpText: '', required: false, options: [{ value: 'Intermediate', label: 'Intermediate' }], sortOrder: 60, showWhen: null },
    { key: 'workshop_prerequisites', section: 'session', type: 'long_text', label: 'Workshop prerequisites', helpText: '', required: false, options: [], sortOrder: 70, showWhen: { fieldKey: 'format', equals: 'workshop' } },
    { key: 'speaker_bio', section: 'speaker', type: 'long_text', label: 'Speaker bio', helpText: '', required: false, options: [], sortOrder: 80, showWhen: null },
  ],
} as const

const speakerSession = { user: { id: 'user-speaker', email: 'speaker@example.test', displayName: 'Priya Raman' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'speaker' }] }
const reviewerSession = { user: { id: 'user-reviewer-only', email: 'reviewer-only@example.test', displayName: 'Lee Reviewer' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'reviewer' }] }
const workspaceSession = { user: { id: 'user-organizer', email: 'organizer@example.test', displayName: 'Sam Whitfield' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'organizer' }] }
const reviewProposal = { publicId: 'ABS-142', title: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale', track: 'Platform & Infra', format: 'talk', durationMinutes: 30 }
const organizerProposalDossier = {
  id: 'proposal-review',
  ...reviewProposal,
  abstract: 'A concrete account of incremental builds, measurement, and rollback safety.',
  status: 'submitted',
  participants: [
    { id: 'presenter-priya', name: 'Priya Raman', email: 'speaker@example.test', role: 'primary' },
    { id: 'presenter-marcus', name: 'Marcus Okafor', email: 'marcus@example.test', role: 'co_presenter' },
  ],
  values: {
    title: reviewProposal.title,
    abstract: 'A concrete account of incremental builds, measurement, and rollback safety.',
    track: reviewProposal.track,
    format: reviewProposal.format,
    key_takeaway: 'Measure the dependency graph before optimizing it.',
    audience_level: 'Intermediate',
    speaker_bio: 'Priya builds reliable developer infrastructure.',
  },
} as const
const evaluationPlanFixture = {
  planId: 'plan-review', versionId: 'plan-version-1', versionNumber: 1, name: 'Program committee rubric', createdAt: '2026-08-11T12:00:00.000Z',
  criteria: [
    { id: 'criterion-evidence', key: 'evidence', label: 'Evidence quality', description: 'Ground claims in observable evidence.', weightBasisPoints: 4000, minimumScore: 1, maximumScore: 5, sortOrder: 0 },
    { id: 'criterion-impact', key: 'impact', label: 'Attendee impact', description: 'Score the usefulness for attendees.', weightBasisPoints: 6000, minimumScore: 1, maximumScore: 10, sortOrder: 1 },
  ],
} as const
const ownerWorkspace = {
  event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' },
  proposals: [{
    id: 'proposal-owned', publicId: 'ABS-OWNED', title: 'An owner-scoped accepted session', status: 'decided', decision: 'accept', notificationStatus: 'not_queued',
    acceptedSession: { id: 'session-owned', slug: 'owner-scoped-session', title: 'An owner-scoped accepted session', track: 'Platform & Infra', format: 'talk', durationMinutes: 30, presenters: [{ speakerId: 'speaker-owned', name: 'Sam Whitfield', role: 'primary' }], tasks: [{ id: 'task-owned', taskKey: 'confirm', label: 'Confirm participation', state: 'open', completedAt: null }] },
  }],
} as const
const contentSpeaker = {
  id: 'speaker-owned', name: 'Sam Whitfield', contactEmail: 'sam@example.test', title: 'Staff Engineer', company: 'Northstar Labs', bio: 'Sam builds resilient developer platforms.',
  socialUrls: { website: 'https://example.test/sam', linkedin: null, x: null }, travelPreferences: 'No travel support needed.', workflowStatus: 'confirmed', profileStatus: 'ready', agreementStatus: 'signed', publicVisibility: 'published', headshot: null, revision: 2, updatedAt: '2026-08-11T12:00:00Z',
} as const
const contentSpeakerHistoryProfile = ((speaker: typeof contentSpeaker) => {
  const { contactEmail, ...profile } = speaker
  void contactEmail
  return profile
})(contentSpeaker)
const contentTask = {
  id: 'task-content', sessionId: 'session-owned', taskKey: 'confirm-participation', label: 'Confirm participation', state: 'complete', dueAt: '2026-08-20T20:00:00Z', completedAt: '2026-08-11T12:10:00Z', revision: 2, updatedAt: '2026-08-11T12:10:00Z',
} as const
const contentRequest = {
  id: 'request-slides', sessionId: 'session-owned', requestKey: 'presentation', requestType: 'presentation', label: 'Final presentation', instructions: 'Upload the attendee-ready presentation.', dueAt: '2027-05-01T20:00:00Z', allowedContentTypes: ['application/pdf'], maxBytes: 10485760, required: true, active: true, revision: 1, createdAt: '2026-08-11T12:00:00Z', updatedAt: '2026-08-11T12:00:00Z',
} as const
const contentVersion = {
  id: 'version-slides-1', requestId: 'request-slides', sessionId: 'session-owned', requestType: 'presentation', versionNumber: 1, originalFilename: 'session-slides.pdf', contentType: 'application/pdf', byteSize: 2048, sha256: 'a'.repeat(64), note: 'Ready for review', uploader: { speakerId: 'speaker-owned', name: 'Sam Whitfield' }, uploadedAt: '2026-08-11T12:20:00Z', downloadPath: '/api/events/devflow-conf-2027/speaker/deliverables/version-slides-1/file', publicUrl: null,
} as const
const organizerPreviousContentVersion = {
  ...contentVersion,
  note: 'Superseded first pass',
  downloadPath: '/api/events/devflow-conf-2027/content/deliverables/version-slides-1/file',
} as const
const organizerCurrentContentVersion = {
  ...contentVersion,
  id: 'version-slides-2',
  versionNumber: 2,
  originalFilename: 'session-slides-final.pdf',
  sha256: 'b'.repeat(64),
  note: 'Final diagrams',
  uploadedAt: '2026-08-11T12:25:00Z',
  downloadPath: '/api/events/devflow-conf-2027/content/deliverables/version-slides-2/file',
} as const
const speakerContentWorkspace = {
  event: ownerWorkspace.event,
  speaker: contentSpeaker,
  sessions: [{ id: 'session-owned', slug: 'owner-scoped-session', title: 'An owner-scoped accepted session', track: 'Platform & Infra', format: 'talk', deliverablesStatus: 'ready', approvalStatus: 'approved', revision: 3, schedule: { room: 'Room 2A', startsAt: '2027-05-12T17:15:00Z', endsAt: '2027-05-12T17:45:00Z' }, tasks: [contentTask], requests: [{ ...contentRequest, versions: [contentVersion] }], comments: [], reviews: [{ id: 'review-version-1', sessionId: 'session-owned', versionId: 'version-slides-1', outcome: 'approved', comment: 'Ready for attendees.', reviewerName: 'Jordan Alvarez', reviewedAt: '2026-08-11T12:30:00Z' }] }],
} as const
const organizerSpeakerRoster = {
  event: ownerWorkspace.event,
  speakers: [{ accountLinked: true, profile: contentSpeaker, history: [{ id: 'history-headshot', speakerId: 'speaker-owned', action: 'headshot_uploaded', profile: contentSpeakerHistoryProfile, changeNote: 'Uploaded a new private headshot.', actorName: 'Sam Whitfield', createdAt: '2026-08-11T12:05:00Z' }], sessions: [{ id: 'session-owned', slug: 'owner-scoped-session', title: 'An owner-scoped accepted session', track: 'Platform & Infra', format: 'talk', deliverablesStatus: 'ready', approvalStatus: 'approved', revision: 3, schedule: { room: 'Room 2A', startsAt: '2027-05-12T17:15:00Z', endsAt: '2027-05-12T17:45:00Z' } }], tasks: [contentTask], readiness: { profileReady: true, agreementReady: true, headshotReady: false, requiredTasksReady: true, deliverablesReady: true, nextDueAt: null } }],
} as const
const organizerContent = {
  event: ownerWorkspace.event,
  approvedDeliverablesArchivePath: '/api/events/devflow-conf-2027/content/deliverables.zip',
  sessions: [{ id: 'session-owned', slug: 'owner-scoped-session', title: 'An owner-scoped accepted session', abstract: 'A concrete accepted-session abstract.', track: 'Platform & Infra', format: 'talk', durationMinutes: 30, deliverablesStatus: 'ready', approvalStatus: 'approved', revision: 3, schedule: { room: 'Room 2A', startsAt: '2027-05-12T17:15:00Z', endsAt: '2027-05-12T17:45:00Z' }, presenters: [contentSpeaker], tasks: [contentTask], requests: [contentRequest], versions: [organizerPreviousContentVersion, organizerCurrentContentVersion], comments: [], reviews: [{ id: 'review-version-1', sessionId: 'session-owned', versionId: 'version-slides-2', outcome: 'approved', comment: 'Ready for attendees.', reviewerName: 'Jordan Alvarez', reviewedAt: '2026-08-11T12:30:00Z' }], history: [], unmetApprovalGates: [] }],
} as const
const programReadiness = {
  event: ownerWorkspace.event,
  summary: { accepted: 8, publishReady: 5, blocked: 3, percent: 63 },
  lifecycle: [
    { stage: 'accepted', label: 'Accepted', count: 8, total: 8 },
    { stage: 'profile_ready', label: 'Profile ready', count: 7, total: 8 },
    { stage: 'deliverables_ready', label: 'Deliverables ready', count: 8, total: 8 },
    { stage: 'scheduled', label: 'Scheduled', count: 7, total: 8 },
    { stage: 'approved', label: 'Approved', count: 6, total: 8 },
    { stage: 'published', label: 'Published', count: 5, total: 8 },
  ],
  blockers: [
    { id: 'speaker_profile_incomplete:session-owned:speaker-owned', kind: 'speaker_profile_incomplete', entityType: 'speaker', entityId: 'speaker-owned', entityLabel: 'Sam Whitfield', rule: 'Primary presenters must be confirmed, complete, signed, and public', explanation: 'Owner-scoped session is waiting on profile details.', actionLabel: 'Open speaker', actionPath: '/admin/speakers?speaker=speaker-owned' },
    { id: 'speaker_tasks_incomplete:session-owned:speaker-owned', kind: 'speaker_tasks_incomplete', entityType: 'speaker', entityId: 'speaker-owned', entityLabel: 'Sam Whitfield', rule: 'All speaker tasks must be complete or waived', explanation: 'Owner-scoped session has one open task.', actionLabel: 'Open task ledger', actionPath: '/admin/speakers?speaker=speaker-owned' },
    { id: 'content_approval_pending:session-owned', kind: 'content_approval_pending', entityType: 'session', entityId: 'session-owned', entityLabel: 'An owner-scoped accepted session', rule: 'Session content must be approved', explanation: 'Content approval is pending.', actionLabel: 'Open content review', actionPath: '/admin/content?session=session-owned' },
    { id: 'session_unscheduled:session-docs', kind: 'session_unscheduled', entityType: 'session', entityId: 'session-docs', entityLabel: 'Docs That Answer Back', rule: 'Accepted sessions need an agenda placement', explanation: 'This accepted session has no agenda placement.', actionLabel: 'Place session', actionPath: '/admin/agenda?session=session-docs' },
    { id: 'publication_pending:session-ci', kind: 'publication_pending', entityType: 'session', entityId: 'session-ci', entityLabel: 'Taming 40-Minute CI', rule: 'Publish-ready sessions require an organizer publication action', explanation: 'Every prerequisite is satisfied, but this session is not visible yet.', actionLabel: 'Review and publish agenda', actionPath: '/admin/agenda?session=session-ci' },
  ],
} as const
const programOperatorBrief = {
  event: { id: 'event-devflow', slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' },
  snapshot: { schemaVersion: 1, capturedAt: '2026-08-19T07:00:00Z', staleLeaseBefore: '2026-08-18T07:00:00Z', fingerprint: 'a'.repeat(64), evidenceCount: 4 },
  generation: { mode: 'deterministic', modelStatus: 'not_configured', policyVersion: 'program-operator-shadow-v1' },
  summary: { status: 'attention_needed', acceptedSessions: 8, publishReadySessions: 5, riskCount: 2, reminderDraftCount: 1, exceptionCount: 1 },
  evidence: [
    { id: 'event:event-devflow', source: 'event', recordId: 'event-devflow', fields: ['slug', 'name'] },
    { id: 'speaker:speaker-owned', source: 'speaker', recordId: 'speaker-owned', fields: ['name', 'email'] },
    { id: 'speaker_task:task-headshot', source: 'speaker_task', recordId: 'task-headshot', fields: ['status', 'dueAt'] },
    { id: 'reviewer_summary:reviewer-1', source: 'reviewer_summary', recordId: 'reviewer-1', fields: ['outstandingCount'] },
  ],
  risks: [
    { id: 'risk-speaker-task', rank: 1, severity: 'critical', kind: 'overdue_speaker_task', title: 'Headshot overdue for Sam Whitfield', explanation: 'The required headshot task is overdue and incomplete.', suggestedResolution: 'Open task ledger at /admin/speakers?speaker=speaker-owned.', affectedRecords: [{ type: 'speaker', id: 'speaker-owned', label: 'Sam Whitfield' }, { type: 'speaker_task', id: 'task-headshot', label: 'Upload headshot' }], evidenceIds: ['speaker:speaker-owned', 'speaker_task:task-headshot'], confidence: 'high' },
    { id: 'risk-review-backlog', rank: 2, severity: 'high', kind: 'review_backlog', title: 'Reviewer queue is falling behind', explanation: 'One reviewer has 26 outstanding assignments.', suggestedResolution: 'Review the queue and send a targeted reminder.', affectedRecords: [{ type: 'review_assignment', id: 'reviewer-1', label: 'Alex Chen · 26 outstanding' }], evidenceIds: ['reviewer_summary:reviewer-1'], confidence: 'high' },
  ],
  plan: [{ id: 'plan-speaker-reminder', kind: 'speaker_reminder', status: 'draft', requiredApproval: 'human', queueOperation: 'speakers.queueReminders', recipient: { type: 'speaker', id: 'speaker-owned', name: 'Sam Whitfield', email: 'sam@example.test' }, draft: { templateKey: 'speaker.readiness-reminder', templateRevision: 2, subject: 'Action needed for DevFlow Conf 2027', text: 'Hi Sam,\n\nYour headshot is overdue. Please upload it through your speaker portal.' }, expectedStateChange: 'The reminder may prompt completion of the headshot task; ConfPilot will verify the task separately.', evidenceIds: ['speaker:speaker-owned', 'speaker_task:task-headshot'] }],
  exceptions: [{ id: 'exception-review-judgment', kind: 'manual_judgment', title: 'Reviewer reassignment needs organizer judgment', explanation: 'ConfPilot cannot safely choose which assignments to move.', evidenceIds: ['reviewer_summary:reviewer-1'] }],
  guardrails: { shadowMode: true, writesPerformed: 0, unauthorizedActions: 0 },
} as const
const emptyProgramOperatorBrief = {
  ...programOperatorBrief,
  event: { id: 'event-community', slug: 'community-conf-2028', name: 'Community Conf 2028' },
  snapshot: { ...programOperatorBrief.snapshot, fingerprint: 'b'.repeat(64), evidenceCount: 1 },
  summary: { status: 'complete', acceptedSessions: 0, publishReadySessions: 0, riskCount: 0, reminderDraftCount: 0, exceptionCount: 0 },
  evidence: [{ id: 'event:event-community', source: 'event', recordId: 'event-community', fields: ['slug', 'name'] }],
  risks: [], plan: [], exceptions: [],
} as const
const publicProgram = {
  event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027', tagline: 'The conference for people who build software', location: 'Moscone West · San Francisco, CA', description: 'Three days of practical ideas for software teams.', startsOn: '2027-05-12', endsOn: '2027-05-14', timeZone: 'America/Los_Angeles', status: 'published' },
  sessions: [
    { slug: 'taming-ci', title: reviewProposal.title, abstract: 'Learn how measurement, caching, and test selection cut monorepo CI times.', track: 'Platform & Infra', format: 'talk', durationMinutes: 30, publicationStatus: 'published', schedule: { dayNumber: 1, date: '2027-05-12', label: 'Wednesday, May 12', room: 'Room 2A', startsAt: '2027-05-12T17:15:00Z', endsAt: '2027-05-12T17:45:00Z' }, speakers: [{ slug: 'priya-raman', name: 'Priya Raman', title: 'Principal Engineer', company: 'Latticework Systems', headshotUrl: null, headshotFallback: 'PR' }] },
    { slug: 'evals-you-can-trust', title: 'Evals You Can Trust', abstract: 'Build a hands-on evaluation harness with representative fixtures and release gates.', track: 'AI Engineering', format: 'workshop', durationMinutes: 120, publicationStatus: 'published', schedule: { dayNumber: 2, date: '2027-05-13', label: 'Thursday, May 13', room: 'Workshop Lab', startsAt: '2027-05-13T20:00:00Z', endsAt: '2027-05-13T22:00:00Z' }, speakers: [{ slug: 'sanaa-idris', name: 'Sanaa Idris', title: 'AI Reliability Engineer', company: 'Kinship', headshotUrl: null, headshotFallback: 'SI' }] },
  ],
  speakers: [
    { slug: 'priya-raman', name: 'Priya Raman', title: 'Principal Engineer', company: 'Latticework Systems', bio: 'Priya builds reliable developer infrastructure.', headshotUrl: null, headshotFallback: 'PR', publicVisibility: 'published', sessions: [{ slug: 'taming-ci', title: reviewProposal.title, track: 'Platform & Infra', format: 'talk' }] },
    { slug: 'sanaa-idris', name: 'Sanaa Idris', title: 'AI Reliability Engineer', company: 'Kinship', bio: 'Sanaa designs trustworthy AI evaluation systems.', headshotUrl: null, headshotFallback: 'SI', publicVisibility: 'published', sessions: [{ slug: 'evals-you-can-trust', title: 'Evals You Can Trust', track: 'AI Engineering', format: 'workshop' }] },
  ],
} as const
const initialEmbed = {
  id: 'embed-website', eventSlug: 'devflow-conf-2027', slug: 'website-program', name: 'Website program', view: 'sessions', filters: { days: [], tracks: [], formats: [], rooms: [] }, outputFormat: 'iframe', appearance: defaultEmbedAppearance, enabled: true, revision: 1,
  createdAt: '2026-08-11T12:00:00Z', updatedAt: '2026-08-11T12:00:00Z', publicPath: '/embed/devflow-conf-2027/website-program', jsonPath: '/api/public/events/devflow-conf-2027/embeds/website-program', calendarPath: '/api/public/events/devflow-conf-2027/embeds/website-program/calendar.ics',
} as const
const agendaSpeaker = { id: 'speaker-priya', slug: 'priya-raman', name: 'Priya Raman', role: 'primary' } as const
const initialAgenda = {
  event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027', timeZone: 'America/Los_Angeles', status: 'published', agendaPublishedAt: '2027-04-18T21:14:00Z' },
  publication: { publicSessionCount: 2, unplacedCount: 1, contentNotApprovedCount: 0,
    primarySpeakerNotPublicCount: 0, readinessBlockedCount: 0, awaitingPublicationCount: 0 },
  days: [
    { id: 'day-d-1', dayNumber: 1, date: '2027-05-12', label: 'Day 1', opensAt: '2027-05-12T16:00:00Z', closesAt: '2027-05-12T23:00:00Z', slotMinutes: 15, revision: 1 },
    { id: 'day-d-2', dayNumber: 2, date: '2027-05-13', label: 'Day 2', opensAt: '2027-05-13T16:00:00Z', closesAt: '2027-05-13T23:00:00Z', slotMinutes: 15, revision: 1 },
    { id: 'day-d-3', dayNumber: 3, date: '2027-05-14', label: 'Day 3', opensAt: '2027-05-14T16:00:00Z', closesAt: '2027-05-14T23:00:00Z', slotMinutes: 15, revision: 1 },
  ],
  rooms: [
    { id: 'room-d-main', name: 'Main Stage', capacity: 800, sortOrder: 1, revision: 1 },
    { id: 'room-d-2a', name: 'Room 2A', capacity: 260, sortOrder: 2, revision: 1 },
    { id: 'room-d-2b', name: 'Room 2B', capacity: 220, sortOrder: 3, revision: 1 },
    { id: 'room-d-workshop', name: 'Workshop Lab', capacity: 96, sortOrder: 4, revision: 1 },
  ],
  tracks: [
    { id: 'track-ai', name: 'AI Engineering', color: 'plum', sortOrder: 1, revision: 1 },
    { id: 'track-platform', name: 'Platform & Infra', color: 'blue', sortOrder: 2, revision: 1 },
    { id: 'track-dx', name: 'Developer Experience', color: 'gold', sortOrder: 3, revision: 1 },
  ],
  sessions: [
    { id: 'session-ci', slug: 'taming-40-minute-ci', title: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale', track: 'Platform & Infra', format: 'talk', durationMinutes: 30, acceptanceStatus: 'accepted', approvalStatus: 'approved', publicationStatus: 'published', revision: 1, presenters: [agendaSpeaker, { id: 'speaker-marcus', slug: 'marcus-okafor', name: 'Marcus Okafor', role: 'co_presenter' }], placement: { id: 'placement-ci', dayId: 'day-d-1', roomId: 'room-d-2a', startsAt: '2027-05-12T17:15:00Z', endsAt: '2027-05-12T17:45:00Z', revision: 1 } },
    { id: 'session-ai', slug: 'ai-pair-programmer-verification', title: 'Your AI Pair Programmer Is Lying to You: Verification Patterns That Scale', track: 'AI Engineering', format: 'talk', durationMinutes: 30, acceptanceStatus: 'accepted', approvalStatus: 'approved', publicationStatus: 'published', revision: 1, presenters: [agendaSpeaker], placement: { id: 'placement-ai', dayId: 'day-d-1', roomId: 'room-d-2b', startsAt: '2027-05-12T18:15:00Z', endsAt: '2027-05-12T18:45:00Z', revision: 1 } },
    { id: 'session-docs', slug: 'docs-that-answer-back', title: 'Docs That Answer Back', track: 'Developer Experience', format: 'lightning', durationMinutes: 10, acceptanceStatus: 'accepted', approvalStatus: 'pending', publicationStatus: 'private', revision: 1, presenters: [agendaSpeaker], placement: null },
  ],
  conflicts: [],
} as const
let apiProposal: Record<string, unknown> | null
let apiCfpConfig: unknown
let apiParticipants: Array<{ id: string; name: string; email: string | null; role: 'primary' | 'co_presenter' }>
let activeReview: Record<string, unknown> | null
let activeEvaluationPlan: Record<string, unknown> | null
let reviewRounds: Array<Record<string, unknown>>
let activeWorkspaceSession: typeof workspaceSession | { user: typeof workspaceSession.user; memberships: Array<{ eventSlug: string; role: 'organizer' }> }
let apiEmbeds: Array<Record<string, unknown>>
let apiCommunicationMessages: Array<Record<string, unknown>>
let apiReviewerInvitations: Array<Record<string, unknown>>
let apiSpeakerClaims: Array<Record<string, unknown>>
let apiAgenda: {
  event: Record<string, unknown>
  publication: Record<string, number>
  days: Array<Record<string, unknown>>
  rooms: Array<Record<string, unknown>>
  tracks: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  conflicts: Array<Record<string, unknown>>
}

function syncedApiAgenda() {
  const eventPublished = apiAgenda.event.status === 'published'
  const unplacedCount = apiAgenda.sessions.filter((session) => session.placement === null).length
  const contentNotApprovedCount = apiAgenda.sessions.filter((session) => session.placement !== null
    && session.approvalStatus !== 'approved').length
  const publicSessionCount = eventPublished ? apiAgenda.sessions.filter((session) => session.placement !== null
    && session.approvalStatus === 'approved' && session.publicationStatus === 'published').length : 0
  const awaitingPublicationCount = apiAgenda.sessions.length - unplacedCount - contentNotApprovedCount
    - publicSessionCount
  apiAgenda.publication = {
    publicSessionCount,
    unplacedCount,
    contentNotApprovedCount,
    primarySpeakerNotPublicCount: 0,
    readinessBlockedCount: 0,
    awaitingPublicationCount,
  }
  return apiAgenda
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'test-request' } })
}

function installApiMock() {
  apiProposal = null
  apiCfpConfig = structuredClone(cfpConfig)
  apiParticipants = [{ id: 'presenter-primary', name: 'Priya Raman', email: 'speaker@example.test', role: 'primary' }]
  activeReview = null
  activeEvaluationPlan = null
  reviewRounds = [{ id: 'round-1', name: 'Initial Review', opensAt: '2026-08-01T00:00:00Z', closesAt: '2026-10-15T00:00:00Z', blindDefault: true, position: 0, windowState: 'open', poolSize: 1, hasActivePlan: false, updatedAt: '2026-08-11T12:00:00Z' }]
  activeWorkspaceSession = workspaceSession
  apiEmbeds = [{ ...initialEmbed, filters: { ...initialEmbed.filters } }]
  apiCommunicationMessages = []
  apiReviewerInvitations = []
  apiSpeakerClaims = []
  apiAgenda = structuredClone(initialAgenda) as unknown as typeof apiAgenda
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(request)
    if (path === '/api/cfp/devflow-conf-2027') return response({ data: apiCfpConfig, requestId: 'test-request' })
    if (path === '/api/program') return response({ data: publicProgram, requestId: 'test-request' })
    if (path === '/api/public/events/devflow-conf-2027/embeds/website-program') return response({ data: { embed: { slug: initialEmbed.slug, name: initialEmbed.name, view: initialEmbed.view, filters: initialEmbed.filters, appearance: initialEmbed.appearance, revision: initialEmbed.revision }, program: publicProgram }, requestId: 'test-request' })
    if (path === '/api/auth/session') {
      const pathname = window.location.pathname
      const eventRole = pathname.match(/^\/events\/[^/]+\/(reviewer|speaker|submit)(?:\/|$)/)?.[1]
      const routeSession = pathname.startsWith('/reviewer') || eventRole === 'reviewer'
        ? reviewerSession
        : pathname === '/speaker-portal' || pathname === '/submit' || eventRole === 'speaker' || eventRole === 'submit'
          ? speakerSession
          : activeWorkspaceSession
      return response({ data: routeSession, requestId: 'test-request' })
    }
    if (path === '/api/auth/logout' && init?.method === 'POST') return new Response(null, { status: 204 })
    if (path === '/api/events' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      activeWorkspaceSession = { ...workspaceSession, memberships: [...workspaceSession.memberships, { eventSlug: input.slug, role: 'organizer' }] }
      return response({ data: {
        event: { slug: input.slug, name: input.name, status: 'draft' },
        session: activeWorkspaceSession,
      }, requestId: 'event-create' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/agenda' && (!init?.method || init.method === 'GET')) return response({ data: syncedApiAgenda(), requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/readiness' && (!init?.method || init.method === 'GET')) return response({ data: programReadiness, requestId: 'readiness' })
    if (path === '/api/events/devflow-conf-2027/program-operator/daily-brief' && (!init?.method || init.method === 'GET')) return response({ data: programOperatorBrief, requestId: 'program-operator' })
    if (path === '/api/events/community-conf-2028/program-operator/daily-brief' && (!init?.method || init.method === 'GET')) return response({ data: emptyProgramOperatorBrief, requestId: 'program-operator-empty' })
    if (path === '/api/events/community-conf-2028/readiness' && (!init?.method || init.method === 'GET')) return response({ data: {
      event: { slug: 'community-conf-2028', name: 'Community Conf 2028' },
      summary: { accepted: 0, publishReady: 0, blocked: 0, percent: 0 },
      lifecycle: [
        { stage: 'accepted', label: 'Accepted', count: 0, total: 0 },
        { stage: 'profile_ready', label: 'Profile ready', count: 0, total: 0 },
        { stage: 'deliverables_ready', label: 'Deliverables ready', count: 0, total: 0 },
        { stage: 'scheduled', label: 'Scheduled', count: 0, total: 0 },
        { stage: 'approved', label: 'Approved', count: 0, total: 0 },
        { stage: 'published', label: 'Published', count: 0, total: 0 },
      ],
      blockers: [],
    }, requestId: 'readiness-empty' })
    if (path === '/api/events/devflow-conf-2027/agenda/rooms' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      apiAgenda.rooms.push({ id: `room-${apiAgenda.rooms.length + 1}`, ...input, revision: 1 })
      return response({ data: syncedApiAgenda(), requestId: 'agenda-room' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/agenda/tracks' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      apiAgenda.tracks.push({ id: `track-${apiAgenda.tracks.length + 1}`, ...input, revision: 1 })
      return response({ data: syncedApiAgenda(), requestId: 'agenda-track' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/agenda/days' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      apiAgenda.days.push({ id: `day-${apiAgenda.days.length + 1}`, dayNumber: apiAgenda.days.length + 1, ...input, revision: 1 })
      return response({ data: syncedApiAgenda(), requestId: 'agenda-day' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/agenda/placements' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      const session = apiAgenda.sessions.find((item) => item.id === input.sessionId)!
      session.placement = { id: `placement-${input.sessionId}`, dayId: input.dayId, roomId: input.roomId,
        startsAt: input.startsAt, endsAt: new Date(Date.parse(input.startsAt) + Number(session.durationMinutes) * 60000).toISOString().replace('.000Z', 'Z'), revision: 1 }
      return response({ data: syncedApiAgenda(), requestId: 'agenda-placement' }, 201)
    }
    if (path.startsWith('/api/events/devflow-conf-2027/agenda/placements/') && init?.method === 'PATCH') {
      const placementId = path.slice('/api/events/devflow-conf-2027/agenda/placements/'.length)
      const input = JSON.parse(String(init.body))
      const session = apiAgenda.sessions.find((item) => (item.placement as { id?: string } | null)?.id === placementId)!
      session.placement = { id: placementId, dayId: input.dayId, roomId: input.roomId,
        startsAt: input.startsAt, endsAt: new Date(Date.parse(input.startsAt) + Number(session.durationMinutes) * 60000).toISOString().replace('.000Z', 'Z'), revision: Number(input.revision) + 1 }
      return response({ data: syncedApiAgenda(), requestId: 'agenda-move' })
    }
    if (path.startsWith('/api/events/devflow-conf-2027/agenda/placements/') && init?.method === 'DELETE') {
      const placementId = path.slice('/api/events/devflow-conf-2027/agenda/placements/'.length)
      const session = apiAgenda.sessions.find((item) => (item.placement as { id?: string } | null)?.id === placementId)!
      session.placement = null
      return response({ data: syncedApiAgenda(), requestId: 'agenda-unplace' })
    }
    if (path === '/api/events/devflow-conf-2027/agenda/auto-place' && init?.method === 'POST') {
      const results = apiAgenda.sessions.filter((session) => session.placement === null).map((session, index) => {
        const startsAt = new Date(Date.parse('2027-05-13T18:00:00Z') + index * 30 * 60_000)
          .toISOString().replace('.000Z', 'Z')
        const placement = { id: `auto-${session.id}`, dayId: 'day-d-2', roomId: 'room-d-2b', startsAt,
          endsAt: new Date(Date.parse(startsAt) + Number(session.durationMinutes) * 60000).toISOString().replace('.000Z', 'Z'), revision: 1 }
        session.placement = placement
        return { sessionId: session.id, status: 'placed', placement }
      })
      return response({ data: { agenda: syncedApiAgenda(), results }, requestId: 'agenda-auto' })
    }
    if (path === '/api/events/devflow-conf-2027/agenda/publish' && init?.method === 'POST') {
      const publicBefore = apiAgenda.sessions.filter((session) => session.placement
        && session.approvalStatus === 'approved' && session.publicationStatus === 'published').length
      apiAgenda.event.status = 'published'
      apiAgenda.event.agendaPublishedAt ??= '2027-04-20T18:00:00Z'
      for (const session of apiAgenda.sessions) {
        if (session.placement && session.approvalStatus === 'approved') session.publicationStatus = 'published'
      }
      const publicSessionCount = apiAgenda.sessions.filter((session) => session.placement
        && session.approvalStatus === 'approved' && session.publicationStatus === 'published').length
      const skipped = [
        { reason: 'UNPLACED', count: apiAgenda.sessions.filter((session) => !session.placement).length },
        { reason: 'CONTENT_NOT_APPROVED', count: apiAgenda.sessions.filter((session) => session.placement && session.approvalStatus !== 'approved').length },
      ].filter((item) => item.count > 0)
      return response({ data: { agenda: syncedApiAgenda(), publication: {
        outcome: publicSessionCount > publicBefore ? 'changed' : 'unchanged',
        newlyPublicSessionCount: publicSessionCount - publicBefore, publicSessionCount, skipped,
      }, publicPaths: { program: '/program', calendar: '/api/program.ics?event=devflow-conf-2027' } }, requestId: 'agenda-publish' })
    }
    if (path === '/api/events/devflow-conf-2027/embeds' && (!init?.method || init.method === 'GET')) return response({ data: { embeds: apiEmbeds }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/embeds' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      const created = { id: `embed-${apiEmbeds.length + 1}`, eventSlug: 'devflow-conf-2027', ...input, revision: 1, createdAt: '2026-08-11T13:00:00Z', updatedAt: '2026-08-11T13:00:00Z', publicPath: `/embed/devflow-conf-2027/${input.slug}`, jsonPath: `/api/public/events/devflow-conf-2027/embeds/${input.slug}`, calendarPath: `/api/public/events/devflow-conf-2027/embeds/${input.slug}/calendar.ics` }
      apiEmbeds.push(created)
      return response({ data: created, requestId: 'test-request' }, 201)
    }
    if (path.startsWith('/api/events/devflow-conf-2027/embeds/') && init?.method === 'PATCH') {
      const id = path.slice('/api/events/devflow-conf-2027/embeds/'.length)
      const input = JSON.parse(String(init.body))
      const current = apiEmbeds.find((embed) => embed.id === id)!
      const saved = { ...current, ...input, revision: Number(input.revision) + 1, updatedAt: '2026-08-11T13:05:00Z' }
      apiEmbeds = apiEmbeds.map((embed) => embed.id === id ? saved : embed)
      return response({ data: saved, requestId: 'test-request' })
    }
    if (path === '/api/events/devflow-conf-2027/cfp' && init?.method === 'PUT') {
      const input = JSON.parse(String(init.body))
      const { expectedRevision, ...savedInput } = input
      apiCfpConfig = { ...savedInput, event: { slug: 'devflow-conf-2027', ...input.event }, state: 'open', turnstile: { enabled: true, siteKey: 'test-site-key' }, revision: expectedRevision + 1 }
      return response({ data: apiCfpConfig, requestId: 'test-request' })
    }
    if (path === '/api/events/devflow-conf-2027/cfp') return response({ data: apiCfpConfig, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/cfp/proposals') return response({ data: { proposals: [], page: { limit: 50, offset: 0, hasMore: false } }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/cfp/reviewers') return response({ data: { reviewers: [{ userId: 'user-reviewer', displayName: 'Sam Whitfield', email: 'reviewer@example.test' }] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/reviewer-invitations' && (!init?.method || init.method === 'GET')) return response({ data: { invitations: apiReviewerInvitations }, requestId: 'reviewer-invitations' })
    if (path === '/api/events/devflow-conf-2027/reviewer-invitations' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      const created = { id: 'invitation-created', email: input.email, displayName: input.displayName, state: 'pending', expiresAt: '2026-08-20T12:00:00Z', createdAt: '2026-08-13T12:00:00Z', updatedAt: '2026-08-13T12:00:00Z', acceptedAt: null, revokedAt: null, outboxState: 'queued' }
      apiReviewerInvitations = [created, ...apiReviewerInvitations]
      return response({ data: { invitation: created, acceptPath: '/reviewer-invitation#test-reviewer-invitation-token-1234567890', replayed: false }, requestId: 'reviewer-invitation-create' }, 201)
    }
    if (path.startsWith('/api/events/devflow-conf-2027/reviewer-invitations/') && path.endsWith('/revoke') && init?.method === 'POST') {
      const invitationId = path.split('/').at(-2)
      const current = apiReviewerInvitations.find((invitation) => invitation.id === invitationId)!
      const revoked = { ...current, state: 'revoked', revokedAt: '2026-08-13T12:05:00Z', updatedAt: '2026-08-13T12:05:00Z' }
      apiReviewerInvitations = apiReviewerInvitations.map((invitation) => invitation.id === invitationId ? revoked : invitation)
      return response({ data: revoked, requestId: 'reviewer-invitation-revoke' })
    }
    if (path === '/api/events/devflow-conf-2027/speaker-claims' && (!init?.method || init.method === 'GET')) return response({ data: { claims: apiSpeakerClaims }, requestId: 'speaker-claims' })
    if (path === '/api/events/devflow-conf-2027/speaker-claims' && init?.method === 'POST') {
      const created = { id: 'speaker-claim-created', speaker: { id: 'speaker-owned', name: 'Sam Whitfield' }, email: 'sam@example.test', state: 'pending', expiresAt: '2026-08-20T12:00:00Z', createdAt: '2026-08-13T12:00:00Z', updatedAt: '2026-08-13T12:00:00Z', acceptedAt: null, revokedAt: null, outboxState: 'queued' }
      apiSpeakerClaims = [created, ...apiSpeakerClaims]
      return response({ data: { claim: created, acceptPath: '/speaker-claim#test-speaker-claim-token-1234567890', replayed: false }, requestId: 'speaker-claim-create' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/cfp/review-rounds' && (!init?.method || init.method === 'GET')) return response({ data: { rounds: reviewRounds }, requestId: 'rounds' })
    if (path === '/api/events/devflow-conf-2027/cfp/review-rounds' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      reviewRounds = [...reviewRounds, { id: `round-${reviewRounds.length + 1}`, name: input.name, opensAt: input.opensAt, closesAt: input.closesAt, blindDefault: input.blindDefault, position: reviewRounds.length, windowState: 'upcoming', poolSize: 0, hasActivePlan: false, updatedAt: '2026-08-11T12:00:00Z' }]
      return response({ data: reviewRounds.at(-1), requestId: 'round-create' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/cfp/review-rounds/round-1/pool' && (!init?.method || init.method === 'GET')) return response({ data: { roundId: 'round-1', reviewers: [{ userId: 'user-reviewer', displayName: 'Sam Whitfield', email: 'reviewer@example.test' }], rejected: [] }, requestId: 'pool' })
    if (path.startsWith('/api/events/devflow-conf-2027/cfp/reviews/reviewer-progress')) return response({ data: { roundId: null, reviewers: [{ userId: 'user-reviewer', displayName: 'Sam Whitfield', email: 'reviewer@example.test', assignedCount: 2, completedCount: 0, overdueCount: 1 }] }, requestId: 'reviewer-progress' })
    if (path === '/api/events/devflow-conf-2027/cfp/reviews/reminders' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      return response({ data: { messageId: 'message-reviewer-reminder', reviewerUserId: input.reviewerUserId, templateKey: input.templateKey, templateRevision: 1, outboxState: 'queued', pendingAssignments: 2 }, requestId: 'reviewer-reminder' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/cfp/review-plan' && (!init?.method || init.method === 'GET')) {
      return activeEvaluationPlan
        ? response({ data: activeEvaluationPlan, requestId: 'review-plan' })
        : response({ error: { code: 'REVIEW_PLAN_NOT_FOUND', message: 'No evaluation plan is active.', requestId: 'review-plan' } }, 404)
    }
    if (path === '/api/events/devflow-conf-2027/cfp/review-plan' && init?.method === 'PUT') {
      const input = JSON.parse(String(init.body))
      activeEvaluationPlan = { planId: 'plan-review', versionId: `plan-version-${activeEvaluationPlan ? 2 : 1}`, versionNumber: activeEvaluationPlan ? 2 : 1, name: input.name, createdAt: '2026-08-11T12:00:00.000Z', criteria: input.criteria.map((criterion: Record<string, unknown>, index: number) => ({ id: `criterion-${index + 1}`, ...criterion, sortOrder: index })) }
      return response({ data: activeEvaluationPlan, requestId: 'review-plan' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/cfp/reviews/progress') return response({ data: { proposals: [{ proposalId: 'proposal-review', publicId: reviewProposal.publicId, title: reviewProposal.title, track: reviewProposal.track, format: reviewProposal.format, assignedCount: 1, completedCount: activeReview ? 1 : 0, averageScore: activeReview ? 3 : null, recommendations: { accept: activeReview ? 1 : 0, discuss: 0, reject: 0 } }, { proposalId: 'proposal-second', publicId: 'ABS-143', title: 'Designing Failure-Safe Conference Workflows', track: 'Developer Experience', format: 'talk', assignedCount: 1, completedCount: 1, averageScore: 5, recommendations: { accept: 1, discuss: 0, reject: 0 } }, { proposalId: 'proposal-unscored', publicId: 'ABS-144', title: 'A Proposal Awaiting Reviews', track: 'AI Engineering', format: 'talk', assignedCount: 0, completedCount: 0, averageScore: null, recommendations: { accept: 0, discuss: 0, reject: 0 } }] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/decisions' && (!init?.method || init.method === 'GET')) return response({ data: { event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' }, decisions: [] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/speaker/workspace') return response({ data: ownerWorkspace, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/speaker/content-workspace') return response({ data: speakerContentWorkspace, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: organizerSpeakerRoster, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/communications' && (!init?.method || init.method === 'GET')) return response({ data: {
      capability: { enabled: false, provider: null, reason: 'delivery_disabled' },
      messages: apiCommunicationMessages,
    }, requestId: 'communication-history' })
    if (path === '/api/events/devflow-conf-2027/communications/speakers/bulk' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      apiCommunicationMessages = input.speakerIds.map((speakerId: string, index: number) => ({
        id: `message-bulk-${index + 1}`, intent: 'speaker_bulk',
        recipient: { name: speakerId === 'speaker-owned' ? 'Sam Whitfield' : speakerId, email: 'sam@example.test' },
        subject: input.subject, transportStatus: 'queued', deliveryStatus: 'not_attempted', attemptCount: 0,
        provider: null, providerMessageId: null, lastErrorCode: null,
        createdAt: '2026-08-13T09:00:00Z', updatedAt: '2026-08-13T09:00:00Z', providerAcceptedAt: null,
      }))
      return response({ data: { requestedCount: input.speakerIds.length, queuedCount: input.speakerIds.length, messageIds: apiCommunicationMessages.map((item) => item.id), skipped: [] }, requestId: 'communication-bulk' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/speakers/communications/templates') return response({ data: { templates: [
      { key: 'speaker.readiness-reminder', revision: 1, label: 'Readiness reminder', description: 'Lists current outstanding readiness items.' },
      { key: 'speaker.task-reminder', revision: 1, label: 'Open-task reminder', description: 'Lists current open speaker tasks.' },
    ] }, requestId: 'reminder-templates' })
    if (path === '/api/events/devflow-conf-2027/speakers/communications/reminders' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      return response({ data: { messageId: 'message-reminder-1', speakerId: input.speakerId, templateKey: input.templateKey, templateRevision: 1, outboxState: 'queued' }, requestId: 'reminder-enqueue' })
    }
    if (path === '/api/events/devflow-conf-2027/speakers/speaker-owned/profile' && init?.method === 'PATCH') {
      const input = JSON.parse(String(init.body))
      return response({ data: { ...contentSpeaker, ...input, revision: input.revision + 1 }, requestId: 'profile-update' })
    }
    if (path === '/api/events/devflow-conf-2027/content' && (!init?.method || init.method === 'GET')) return response({ data: organizerContent, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/content/session-owned/requests' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      return response({ data: { ...contentRequest, ...input, id: 'request-created', revision: 1 }, requestId: 'request-created' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/content/session-owned/approval' && init?.method === 'PATCH') return response({ data: { ...organizerContent, sessions: organizerContent.sessions.map((session) => ({ ...session, approvalStatus: 'pending', revision: session.revision + 1 })) }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/cfp/proposals/proposal-review/reviews') return response({ data: { proposal: organizerProposalDossier, progress: { assigned: 1, submitted: activeReview ? 1 : 0, revoked: 0 }, assignments: [{ id: 'assignment-review', reviewer: { userId: 'user-reviewer', displayName: 'Sam Whitfield' }, round: 1, blind: true, status: activeReview ? 'completed' : 'pending', invitationStatus: 'accepted', dueAt: '2026-08-20T20:00:00.000Z', createdAt: '2026-08-11T12:00:00.000Z' }], reviews: activeReview ? [{ ...activeReview, assignmentId: 'assignment-review', round: 1, reviewer: { userId: 'user-reviewer', displayName: 'Sam Whitfield' } }] : [] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/cfp/proposals/proposal-second/reviews') return response({ data: { proposal: { ...organizerProposalDossier, id: 'proposal-second', publicId: 'ABS-143', title: 'Designing Failure-Safe Conference Workflows', values: { ...organizerProposalDossier.values, title: 'Designing Failure-Safe Conference Workflows' } }, progress: { assigned: 0, submitted: 0, revoked: 0 }, assignments: [], reviews: [] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/cfp/proposals/proposal-review/assignments' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      return response({ data: { id: 'assignment-review', round: 1, blind: input.blind, dueAt: input.dueAt ?? null, status: activeReview ? 'completed' : 'pending', invitationStatus: 'pending', assignedAt: '2026-08-11T12:00:00.000Z', revokedAt: null, proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, title: reviewProposal.title }, reviewer: { userId: 'user-reviewer', displayName: 'Sam Whitfield', email: 'reviewer@example.test' } }, requestId: 'test-request' })
    }
    if (path === '/api/events/devflow-conf-2027/cfp/assignments/assignment-review/revoke' && init?.method === 'POST') return response({ data: { id: 'assignment-review', status: 'revoked', revokedAt: '2026-08-11T14:00:00.000Z' }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/review/assignments') return response({ data: { assignments: [{ id: 'assignment-review', round: 1, blind: true, dueAt: '2026-08-20T20:00:00.000Z', status: activeReview ? 'completed' : 'pending', invitationStatus: 'accepted', proposal: reviewProposal }] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review') return response({ data: { id: 'assignment-review', round: 1, blind: true, dueAt: '2026-08-20T20:00:00.000Z', status: activeReview ? 'completed' : 'pending', invitationStatus: 'accepted', review: activeReview, correctionAllowed: Boolean(activeReview), evaluationPlan: activeEvaluationPlan, proposal: { ...reviewProposal, abstract: 'A concrete account of incremental builds, measurement, and rollback safety.', sessionAnswers: { key_takeaway: 'Measure the dependency graph before optimizing it.' } } }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review/review' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      const revisionNumber = input.expectedRevision ? input.expectedRevision + 1 : 1
      const correctedAt = input.expectedRevision ? '2026-08-12T13:00:00.000Z' : null
      activeReview = activeEvaluationPlan && input.criterionScores
        ? { id: `review-${revisionNumber}`, revisionNumber, originality: 3, relevance: 4, evaluationPlanVersion: 1, criterionScores: input.criterionScores.map((score: { criterionId: string; score: number }) => { const criterion = (activeEvaluationPlan as typeof evaluationPlanFixture).criteria.find((item) => item.id === score.criterionId)!; return { criterionId: score.criterionId, key: criterion.key, label: criterion.label, score: score.score } }), weightedScore: 4.25, recommendation: input.recommendation, comment: input.comment, submittedAt: '2026-08-11T13:00:00.000Z', correctedAt }
        : { id: `review-${revisionNumber}`, revisionNumber, originality: input.originality, relevance: input.relevance, recommendation: input.recommendation, comment: input.comment, submittedAt: '2026-08-11T13:00:00.000Z', correctedAt }
      return response({ data: activeReview, requestId: 'test-request' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/proposals' && (!init?.method || init.method === 'GET')) return response({ data: { proposals: apiProposal ? [apiProposal] : [] }, requestId: 'test-request' })
    if (path === '/api/events/devflow-conf-2027/proposals' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      apiProposal = { id: 'proposal-1', publicId: 'ABS-TEST', status: 'draft', submittedAt: null, createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z', clientDraftKey: input.clientDraftKey, decision: null, values: input.values }
      return response({ data: apiProposal, requestId: 'test-request' }, 201)
    }
    if (path === '/api/events/devflow-conf-2027/proposals/proposal-1' && init?.method === 'PUT') {
      const input = JSON.parse(String(init.body))
      apiProposal = { ...apiProposal, values: input.values, updatedAt: '2026-08-11T00:01:00Z' }
      return response({ data: apiProposal, requestId: 'test-request' })
    }
    if (path === '/api/events/devflow-conf-2027/proposals/proposal-1/participants' && (!init?.method || init.method === 'GET')) {
      return response({ data: { participants: apiParticipants }, requestId: 'test-request' })
    }
    if (path === '/api/events/devflow-conf-2027/proposals/proposal-1/co-presenters' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body))
      const normalizedEmail = input.email?.trim().toLowerCase() || null
      const existing = apiParticipants.find((participant) => participant.role === 'co_presenter'
        && (normalizedEmail ? participant.email === normalizedEmail : participant.name === input.name.trim()))
      if (!existing) apiParticipants.push({ id: `presenter-${apiParticipants.length + 1}`, name: input.name.trim(), email: normalizedEmail, role: 'co_presenter' })
      return response({ data: { participants: apiParticipants }, requestId: 'test-request' }, existing ? 200 : 201)
    }
    if (path.startsWith('/api/events/devflow-conf-2027/proposals/proposal-1/co-presenters/') && init?.method === 'DELETE') {
      const presenterId = path.slice('/api/events/devflow-conf-2027/proposals/proposal-1/co-presenters/'.length)
      apiParticipants = apiParticipants.filter((participant) => participant.id !== presenterId || participant.role === 'primary')
      return response({ data: { participants: apiParticipants }, requestId: 'test-request' })
    }
    if (path === '/api/events/devflow-conf-2027/proposals/proposal-1/submit' && init?.method === 'POST') {
      apiProposal = { ...apiProposal, status: 'submitted', submittedAt: '2026-08-11T00:02:00Z' }
      return response({ data: apiProposal, requestId: 'test-request' })
    }
    throw new Error(`Unhandled test request: ${init?.method ?? 'GET'} ${path}`)
  }))
}

async function completeProposal(title = 'A new evidence-backed session', submit = true) {
  fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
  fireEvent.click(screen.getByRole('button', { name: /Start a new proposal/ }))
  fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: title } })
  fireEvent.change(screen.getByLabelText(/Abstract/), { target: { value: 'A concrete abstract with evidence, tradeoffs, and a useful implementation path.' } })
  fireEvent.change(screen.getByLabelText(/Track/), { target: { value: 'Platform & Infra' } })
  fireEvent.change(screen.getByLabelText(/Format/), { target: { value: 'talk' } })
  fireEvent.change(screen.getByLabelText(/Key takeaway/), { target: { value: 'A repeatable checklist.' } })
  fireEvent.change(screen.getByLabelText(/Audience level/), { target: { value: 'Intermediate' } })
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
  await screen.findByRole('heading', { name: 'Who is presenting?' })
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
  if (submit) {
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))
    await screen.findByRole('heading', { name: 'Your proposal is in the review queue.' })
  }
}

beforeEach(installApiMock)

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete window.turnstile
  document.getElementById('cloudflare-turnstile-script')?.remove()
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

describe('ConfPilot Phase 0 shell', () => {
  it('presents the landing readiness cockpit as a demo', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: /Explore the demo readiness cockpit/ })).toHaveAttribute('href', '/admin')
    expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('link', { name: /Open source/ }))
      .toHaveAttribute('href', SOURCE_URL)
  })

  it('keeps the organizer shell mounted when a sidebar link changes the content panel', async () => {
    renderAt('/admin')
    await screen.findByRole('heading', { name: 'Program operations overview' })
    const sidebar = document.querySelector('.sidebar')

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace navigation' })).getByRole('link', { name: 'Schedule' }))

    expect(await screen.findByRole('heading', { name: 'Schedule' })).toBeInTheDocument()
    expect(document.querySelector('.sidebar')).toBe(sidebar)
    expect(screen.getByText('Organizer workspace')).toBeInTheDocument()
  })

  it('shows the canonical readiness denominator, exact actions, and attendee proof links', async () => {
    renderAt('/admin')

    await screen.findByRole('heading', { name: 'Program operations overview' })
    expect(screen.getByRole('heading', { name: '5 of 8 accepted sessions are publish-ready' })).toBeInTheDocument()
    expect(screen.getByText('63%')).toBeInTheDocument()
    expect(screen.getByText('3 sessions blocked')).toBeInTheDocument()
    expect(screen.getByText('Preview workspaces')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Sam Whitfield.*Primary presenters/ })).toHaveAttribute('href', '/admin/speakers?speaker=speaker-owned')
    expect(screen.getByRole('link', { name: /An owner-scoped accepted session.*Session content/ })).toHaveAttribute('href', '/admin/content?session=session-owned')
    expect(screen.getByRole('link', { name: /Docs That Answer Back.*Accepted sessions/ })).toHaveAttribute('href', '/admin/agenda?session=session-docs')
    const proof = screen.getByRole('heading', { name: 'Verify the attendee outputs' }).closest('section')!
    expect(within(proof).getByRole('link', { name: 'Public program ↗' })).toHaveAttribute('href', '/program')
    expect(within(proof).getByRole('link', { name: 'Saved embeds' })).toHaveAttribute('href', '/admin/embeds')
    expect(within(proof).getByRole('link', { name: 'Calendar (.ics) ↗' })).toHaveAttribute('href', '/api/program.ics?event=devflow-conf-2027')
    expect(screen.queryByRole('button', { name: 'Switch event' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Notifications' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset demo' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Workspace navigation' })).getByRole('link', { name: 'Speakers' })).not.toHaveTextContent('8')
    expect(screen.queryByText(/Illustrative demo/)).not.toBeInTheDocument()
  })

  it('shows the shadow-mode program brief and exact-recipient draft without offering a send action', async () => {
    renderAt('/admin')

    expect(await screen.findByRole('heading', { name: 'Today’s program brief' })).toBeInTheDocument()
    expect(screen.getByLabelText('Daily brief summary')).toHaveTextContent('2 ranked risks')
    expect(screen.getByRole('heading', { name: 'Headshot overdue for Sam Whitfield' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open record' })).toHaveAttribute('href', '/admin/speakers?speaker=speaker-owned')
    expect(screen.getByRole('note')).toHaveTextContent('Nothing has been queued or sent.')
    expect(screen.getByRole('heading', { name: 'Reviewer reassignment needs organizer judgment' })).toBeInTheDocument()

    fireEvent.click(screen.getByText('Review draft'))
    expect(screen.getByText('sam@example.test')).toBeInTheDocument()
    expect(screen.getByText('Human approval required')).toBeInTheDocument()
    expect(screen.getByText(/Your headshot is overdue/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve|queue|send/i })).not.toBeInTheDocument()

    const beforeRefresh = vi.mocked(fetch).mock.calls.filter(([request]) => requestPath(request) === '/api/events/devflow-conf-2027/program-operator/daily-brief').length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh brief' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([request]) => requestPath(request) === '/api/events/devflow-conf-2027/program-operator/daily-brief')).toHaveLength(beforeRefresh + 1))
    expect(vi.mocked(fetch).mock.calls.filter(([request]) => requestPath(request) === '/api/events/devflow-conf-2027/program-operator/daily-brief').every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it('keeps canonical readiness available when the optional daily brief fails', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => requestPath(request) === '/api/events/devflow-conf-2027/program-operator/daily-brief'
      ? response({ error: { code: 'PROGRAM_OPERATOR_UNAVAILABLE', message: 'Daily brief could not be prepared.' } }, 503)
      : fallback(request, init))

    renderAt('/admin')

    expect(await screen.findByRole('heading', { name: 'Daily brief unavailable' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '5 of 8 accepted sessions are publish-ready' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('keeps readiness actions inside an explicitly scoped event workspace', async () => {
    renderAt('/events/devflow-conf-2027/admin')

    await screen.findByRole('heading', { name: 'Program operations overview' })
    expect(screen.getByRole('link', { name: /Docs That Answer Back.*Accepted sessions/ }))
      .toHaveAttribute('href', '/events/devflow-conf-2027/admin/agenda?session=session-docs')
    expect(await screen.findByRole('link', { name: 'Open record' })).toHaveAttribute('href', '/events/devflow-conf-2027/admin/speakers?speaker=speaker-owned')
    const proof = screen.getByRole('heading', { name: 'Verify the attendee outputs' }).closest('section')!
    expect(within(proof).getByRole('link', { name: 'Public program ↗' }))
      .toHaveAttribute('href', '/events/devflow-conf-2027/program')
  })

  it('opens the exact agenda record from a readiness deep link', async () => {
    renderAt('/admin/agenda?session=session-docs')

    const dialog = await screen.findByRole('dialog', { name: 'Docs That Answer Back' })
    expect(within(dialog).getByText('Schedule session')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Place session' })).toBeInTheDocument()
  })

  it.each([
    ['/admin/speakers?speaker=speaker-owned', 'Sam Whitfield'],
    ['/admin/content?session=session-owned', 'An owner-scoped accepted session'],
  ])('opens the exact organizer record at %s', async (path, heading) => {
    renderAt(path)
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('keeps query-only agenda history navigation synchronized with the selected record', async () => {
    renderAt('/admin/agenda?session=session-ci')
    expect(await screen.findByRole('dialog', { name: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale' })).toBeInTheDocument()

    window.history.replaceState({}, '', '/admin/agenda?session=session-docs')
    fireEvent(window, new PopStateEvent('popstate'))

    expect(await screen.findByRole('dialog', { name: 'Docs That Answer Back' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale' })).not.toBeInTheDocument()
  })

  it('refreshes canonical readiness when the organizer returns to the page', async () => {
    renderAt('/admin')
    await screen.findByRole('heading', { name: 'Program operations overview' })
    const readinessCalls = () => vi.mocked(fetch).mock.calls
      .filter(([request]) => requestPath(request) === '/api/events/devflow-conf-2027/readiness').length
    const before = readinessCalls()

    fireEvent.focus(window)

    await waitFor(() => expect(readinessCalls()).toBeGreaterThan(before))
    expect(await screen.findByRole('heading', { name: '5 of 8 accepted sessions are publish-ready' })).toBeInTheDocument()
  })

  it('treats embeds as a connected workspace instead of demo seed data', async () => {
    renderAt('/admin/embeds')
    await screen.findByRole('heading', { name: 'Put the program where attendees are' })
    expect(screen.queryByText('Demo seed data')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset demo' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Primary web output')).toBeInTheDocument()
    expect(screen.getByText('Every saved configuration also includes a filtered iCalendar (.ics) feed.')).toBeInTheDocument()
  })

  it('makes wide organizer agenda boards visibly horizontally scrollable', async () => {
    renderAt('/admin/agenda')

    expect(await screen.findByText('More rooms continue horizontally. Scroll the schedule or focus it and use Shift + mouse wheel.')).toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: /schedule/ })).toHaveAttribute('aria-describedby', 'agenda-scroll-hint')
  })

  it.each(['/administrator', '/admin/unknown', '/admin/abstracts/one/extra', '/reviewer/assignments/', '/reviewer/assignments/one/extra'])('does not expose a private shell on unmatched path %s', (path) => {
    renderAt(path)
    expect(screen.getByRole('heading', { name: 'Page not found.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'ConfPilot home' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
  })

  it.each([
    '/events/Uppercase/program',
    '/events/under_score/submit',
    '/events/%2F/program',
    '/events/%20/program',
    '/events/%25/reviewer',
  ])('rejects an invalid decoded event slug before route dispatch at %s', (path) => {
    renderAt(path)

    expect(screen.getByRole('heading', { name: 'Page not found.' })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['/admin', 'Program operations overview'],
    ['/admin/cfp', 'Submission form'],
    ['/admin/abstracts', 'Proposals & reviews'],
    ['/admin/speakers', 'Speaker readiness'],
    ['/admin/content', 'Content & files'],
    ['/admin/agenda', 'Schedule'],
    ['/admin/embeds', 'Put the program where attendees are'],
    ['/admin/design-system', 'ConfPilot interface foundations'],
    ['/program', 'Program'],
    ['/submit', 'The developer workflow conference'],
    ['/reviewer', 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale'],
    ['/speaker-portal', 'Your speaker desk'],
  ])('makes %s reachable', async (path, heading) => {
    renderAt(path)
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('offers the organizer-scoped approved deliverables archive', async () => {
    renderAt('/admin/content')

    expect(await screen.findByRole('link', { name: 'Download approved files (.zip)' }))
      .toHaveAttribute('href', '/api/events/devflow-conf-2027/content/deliverables.zip')
  })

  it('shows every immutable deliverable version in the organizer content library', async () => {
    renderAt('/admin/content')
    await openTaskTab('Current files')

    const library = (await screen.findByRole('heading', { name: 'Content library' })).closest('section')!
    expect(within(library).getByRole('region', { name: 'All deliverable versions' })).toBeInTheDocument()
    expect(within(library).getByText('session-slides.pdf')).toBeInTheDocument()
    expect(within(library).getByText('session-slides-final.pdf')).toBeInTheDocument()
    expect(within(library).getByText('V1 · Previous')).toBeInTheDocument()
    expect(within(library).getByText('V2 · Current')).toBeInTheDocument()
    expect(within(library).getByRole('link', { name: 'Download V1' })).toHaveAttribute(
      'href',
      '/api/events/devflow-conf-2027/content/deliverables/version-slides-1/file',
    )
    expect(within(library).getByRole('link', { name: 'Download V2' })).toHaveAttribute(
      'href',
      '/api/events/devflow-conf-2027/content/deliverables/version-slides-2/file',
    )
    expect(within(library).getByText(/ZIP export remains limited to each active request's current approved version/)).toBeInTheDocument()
  })

  it('keeps reviewer input separate from decisions and notifications', async () => {
    renderAt('/admin/abstracts')
    expect(await screen.findByText('Reviewer input does not email authors.')).toBeInTheDocument()
    expect(screen.getByText(/Recording a decision and preparing its email are separate/)).toBeInTheDocument()
  })

  it('lets an organizer activate a versioned evaluation plan for future assignments', async () => {
    renderAt('/admin/abstracts')
    await openTaskTab('Review setup')

    expect(await screen.findByRole('heading', { name: 'Evaluation plan' })).toBeInTheDocument()
    expect(screen.getByText(/No evaluation plan is active/)).toBeInTheDocument()
    expect(screen.getByText('Total weight: 100.00%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Activate evaluation plan' }))

    expect(await screen.findByText('Evaluation plan version 1 is active for new assignments.')).toBeInTheDocument()
    expect(activeEvaluationPlan).toMatchObject({
      versionNumber: 1,
      name: 'Program evaluation',
      criteria: [
        { key: 'originality', weightBasisPoints: 5000, minimumScore: 1, maximumScore: 5 },
        { key: 'relevance', weightBasisPoints: 5000, minimumScore: 1, maximumScore: 5 },
      ],
    })
  })

  it('preserves partial decimal weights and generates reusable unique criterion keys', async () => {
    renderAt('/admin/abstracts')
    await openTaskTab('Review setup')
    expect(await screen.findByRole('heading', { name: 'Evaluation plan' })).toBeInTheDocument()

    const firstWeight = screen.getAllByLabelText('Weight (%)')[0]
    fireEvent.change(firstWeight, { target: { value: '12.' } })
    expect(firstWeight).toHaveValue('12.')

    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove New criterion' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Add criterion' }))
    const keys = screen.getAllByLabelText('Key').map((input) => (input as HTMLInputElement).value)
    expect(new Set(keys).size).toBe(keys.length)
    expect(screen.getAllByLabelText('Weight (%)')[0]).toHaveValue('12.')
  })

  it('shows review rounds with pools and per-reviewer progress, and queues a reviewer reminder truthfully', async () => {
    renderAt('/admin/reviewers')

    await screen.findByRole('heading', { name: 'Rounds, pools, and scorecards' })
    expect(screen.getByRole('heading', { name: 'Initial Review' })).toBeInTheDocument()
    expect(screen.getAllByText('Sam Whitfield').length).toBeGreaterThanOrEqual(1)

    await screen.findByRole('heading', { name: 'Per-reviewer completion' })
    expect(screen.getByText('0 of 2')).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: 'Queue reminder' }))
    const confirmation = await screen.findByText(/Reminder queued in the immutable outbox/)
    expect(confirmation.textContent).toMatch(/did not send it or claim delivery/)
  })

  it('creates a reviewer invitation, exposes the link once, and labels queued email truthfully', async () => {
    renderAt('/admin/reviewers')

    await screen.findByRole('heading', { name: 'Invite reviewers securely' })
    fireEvent.change(screen.getByLabelText('Reviewer name'), { target: { value: 'Nia Reviewer' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nia@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create reviewer invitation' }))

    const link = await screen.findByLabelText('One-time reviewer invitation link')
    expect(link).toHaveValue(`${window.location.origin}/reviewer-invitation#test-reviewer-invitation-token-1234567890`)
    expect(screen.getByText(/Copy this link now; ConfPilot stores only its hash/)).toBeInTheDocument()
    expect(await screen.findByText('Queued, not sent')).toBeInTheDocument()
    expect(screen.getByText('nia@example.test')).toBeInTheDocument()
  })

  it('removes the invitation token from the address bar and creates reviewer-only access', async () => {
    const token = 'reviewer-invitation-token-12345678901234567890'
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/reviewer-invitations/resolve') return response({ data: { event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' }, email: 'nia@example.test', displayName: 'Nia Reviewer', expiresAt: '2026-08-20T12:00:00Z' }, requestId: 'resolve' })
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'session' } }, 401)
      if (path === '/api/reviewer-invitations/register' && init?.method === 'POST') return response({ data: { user: { id: 'user-nia', email: 'nia@example.test', displayName: 'Nia Reviewer' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'reviewer' }] }, requestId: 'register' }, 201)
      return response({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'unknown' } }, 404)
    }))
    renderAt(`/reviewer-invitation#${token}`)

    expect(await screen.findByRole('heading', { name: 'Join DevFlow Conf 2027 as a reviewer.' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(screen.getByLabelText('Invited email')).toHaveValue('nia@example.test')
    fireEvent.change(screen.getByLabelText('Create password'), { target: { value: 'secure-reviewer-pass-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account and accept' }))

    expect(await screen.findByRole('heading', { name: 'Welcome to DevFlow Conf 2027.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open reviewer workspace →' })).toHaveAttribute('href', '/events/devflow-conf-2027/reviewer')
    const registerCall = vi.mocked(fetch).mock.calls.find(([request]) => requestPath(request) === '/api/reviewer-invitations/register')
    expect(String(registerCall?.[1]?.body)).toContain(token)
    expect(String(registerCall?.[0])).not.toContain(token)
  })

  it('creates an exact-record speaker invitation and labels queued delivery truthfully', async () => {
    const unclaimedRoster = { ...organizerSpeakerRoster, speakers: organizerSpeakerRoster.speakers.map((speaker) => ({ ...speaker, accountLinked: false })) }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(request) === '/api/events/devflow-conf-2027/speakers') return response({ data: unclaimedRoster, requestId: 'unclaimed-roster' })
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    expect(await screen.findByRole('heading', { name: 'Invite this speaker' })).toBeInTheDocument()
    expect(screen.getByText(/links an account to this exact profile/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Create speaker invitation' }))

    expect(await screen.findByLabelText('One-time speaker invitation link')).toHaveValue(`${window.location.origin}/speaker-claim#test-speaker-claim-token-1234567890`)
    expect(await screen.findByText('Queued · not sent')).toBeInTheDocument()
    expect(screen.getByText(/does not create another speaker, confirm participation, or publish/)).toBeInTheDocument()
  })

  it('strips the speaker claim token and links registration to the speaker workspace', async () => {
    const token = 'speaker-claim-token-12345678901234567890'
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/speaker-claims/resolve') return response({ data: { event: { slug: 'devflow-conf-2027', name: 'DevFlow Conf 2027' }, speaker: { id: 'speaker-unclaimed', name: 'Nia Speaker' }, email: 'nia@example.test', expiresAt: '2026-08-20T12:00:00Z' }, requestId: 'resolve' })
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'session' } }, 401)
      if (path === '/api/speaker-claims/register' && init?.method === 'POST') return response({ data: { user: { id: 'user-nia', email: 'nia@example.test', displayName: 'Nia Speaker' }, memberships: [{ eventSlug: 'devflow-conf-2027', role: 'speaker' }] }, requestId: 'register' }, 201)
      return response({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'unknown' } }, 404)
    }))
    renderAt(`/speaker-claim#${token}`)

    expect(await screen.findByRole('heading', { name: 'Claim your DevFlow Conf 2027 speaker profile.' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(screen.getByLabelText('Profile email')).toHaveValue('nia@example.test')
    expect(screen.getByText(/does not publish the profile or confirm participation/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Create password'), { target: { value: 'secure-speaker-pass-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account and claim' }))

    expect(await screen.findByRole('heading', { name: 'Your DevFlow Conf 2027 speaker profile is claimed.' })).toBeInTheDocument()
    expect(screen.getByText(/No duplicate profile was created/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open speaker workspace →' })).toHaveAttribute('href', '/events/devflow-conf-2027/speaker')
    const registerCall = vi.mocked(fetch).mock.calls.find(([request]) => requestPath(request) === '/api/speaker-claims/register')
    expect(String(registerCall?.[1]?.body)).toContain(token)
    expect(String(registerCall?.[0])).not.toContain(token)
  })

  it('sorts comparable review aggregates and confirms the private CSV download', async () => {
    activeReview = {
      id: 'review-existing',
      originality: 3,
      relevance: 3,
      recommendation: 'discuss',
      comment: 'Needs discussion.',
      submittedAt: '2026-08-11T13:00:00.000Z',
    }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(request) === '/api/events/devflow-conf-2027/cfp/reviews/export.csv') return new Response('proposal_id,average_score\nproposal-review,3', { status: 200, headers: { 'content-type': 'text/csv' } })
      return fallback(request, init)
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:review-results') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderAt('/admin/abstracts')

    const queue = await screen.findByRole('region', { name: 'Proposal review progress' })
    const titles = () => within(queue).getAllByRole('link')
      .filter((link) => link.classList.contains('review-progress-row'))
      .map((link) => link.textContent)
    const sort = within(queue).getByLabelText('Sort by average score')
    const exportButton = within(queue).getByRole('button', { name: 'Export review results (CSV)' })
    expect(within(queue).getByText(/Scores are normalized to a 1–5 scale so results from different scorecards can be compared/)).toBeInTheDocument()
    expect(titles()).toEqual(expect.arrayContaining([expect.stringContaining('3.0 average score')]))
    fireEvent.click(exportButton)
    expect(await within(queue).findByRole('status')).toHaveTextContent('Downloaded devflow-conf-2027-review-results.csv.')
    expect(defaultFetch.mock.calls.some(([request]) => requestPath(request) === '/api/events/devflow-conf-2027/cfp/reviews/export.csv')).toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(downloadClick).toHaveBeenCalled()

    fireEvent.change(sort, { target: { value: 'descending' } })
    expect(titles()).toEqual([
      expect.stringContaining('Designing Failure-Safe Conference Workflows'),
      expect.stringContaining(reviewProposal.title),
      expect.stringContaining('A Proposal Awaiting Reviews'),
    ])

    fireEvent.change(sort, { target: { value: 'ascending' } })
    expect(titles()).toEqual([
      expect.stringContaining(reviewProposal.title),
      expect.stringContaining('Designing Failure-Safe Conference Workflows'),
      expect.stringContaining('A Proposal Awaiting Reviews'),
    ])
  })

  it('shows organizers the complete persisted proposal dossier before assignment or decision', async () => {
    renderAt('/admin/abstracts')

    expect(await screen.findByRole('heading', { name: 'Submitted proposal' })).toBeInTheDocument()
    expect(screen.getByText(organizerProposalDossier.abstract)).toBeInTheDocument()
    expect(screen.getByText('Measure the dependency graph before optimizing it.')).toBeInTheDocument()
    expect(screen.getByText('Priya builds reliable developer infrastructure.')).toBeInTheDocument()
    expect(screen.getByText('30 minutes')).toBeInTheDocument()
    expect(screen.getByText('Marcus Okafor')).toBeInTheDocument()
    expect(screen.getByText('Primary presenter · speaker@example.test')).toBeInTheDocument()
    expect(screen.getByText('Co-presenter · marcus@example.test')).toBeInTheDocument()
  })

  it('submits organizer assignment due dates in the shared contract format', async () => {
    renderAt('/admin/abstracts')
    fireEvent.change(await screen.findByLabelText('Due date'), { target: { value: '2027-04-20T17:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign reviewer' }))

    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([path, init]) => String(path).endsWith('/proposal-review/assignments') && init?.method === 'POST')
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0][1]?.body)).dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })
  })

  it('uses the route as the source of truth when returning from a proposal deep link', async () => {
    renderAt('/admin/abstracts/proposal-second')
    expect(await screen.findByRole('heading', { name: 'Designing Failure-Safe Conference Workflows' })).toBeInTheDocument()

    window.history.replaceState({}, '', '/admin/abstracts')
    fireEvent(window, new PopStateEvent('popstate'))

    expect(await screen.findByRole('heading', { name: reviewProposal.title })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Designing Failure-Safe Conference Workflows' })).not.toBeInTheDocument()
  })

  it('uses the connected agenda response for exact rooms and named sessions', async () => {
    renderAt('/admin/agenda')
    expect(await screen.findByText('Main Stage')).toBeInTheDocument()
    expect(screen.getByText('Room 2A')).toBeInTheDocument()
    expect(screen.getByText('Room 2B')).toBeInTheDocument()
    expect(screen.getByText('Workshop Lab')).toBeInTheDocument()
    expect(screen.getAllByText('Taming 40-Minute CI: Incremental Builds at Monorepo Scale').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Your AI Pair Programmer Is Lying to You: Verification Patterns That Scale').length).toBeGreaterThan(0)
    expect(document.querySelector('.connected-unplaced .count-pill')).toHaveTextContent(/^1$/)
    expect(screen.getByText('Docs That Answer Back')).toBeInTheDocument()
    expect(window.localStorage.getItem(DEMO_STORAGE_KEY)).toBeNull()
  })

  it('moves agenda day tabs with Arrow, Home, and End keys', async () => {
    renderAt('/admin/agenda')
    const first = await screen.findByRole('tab', { name: /Day 1/ })
    const second = screen.getByRole('tab', { name: /Day 2/ })
    const third = screen.getByRole('tab', { name: /Day 3/ })

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'End' })
    expect(third).toHaveAttribute('aria-selected', 'true')
    expect(third).toHaveFocus()
    fireEvent.keyDown(third, { key: 'Home' })
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(third).toHaveAttribute('aria-selected', 'true')
    expect(third).toHaveFocus()
  })

  it('lets an organizer create the first agenda day from the empty state', async () => {
    apiAgenda.days = []
    apiAgenda.sessions.forEach((session) => { session.placement = null })
    renderAt('/admin/agenda')

    expect(await screen.findByRole('heading', { name: 'Add the first event day' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2027-05-12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add event day' }))
    expect(await screen.findByRole('tab', { name: /Day 1/ })).toBeInTheDocument()
    expect(screen.getByText('Day 1 added.')).toBeInTheDocument()
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([path, init]) => String(path).endsWith('/agenda/days') && init?.method === 'POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      date: '2027-05-12', label: 'Day 1', opensAt: '2027-05-12T16:00:00Z',
      closesAt: '2027-05-13T00:00:00Z', slotMinutes: 15,
    })
  })

  it('keeps the mobile itinerary inside the day tabpanel', async () => {
    renderAt('/admin/agenda')
    const panel = await screen.findByRole('tabpanel', { name: /Wed, May 12 schedule/ })
    expect(panel.querySelector('.agenda-mobile-list')).not.toBeNull()
  })

  it('renders and preserves an off-grid unscoped placement for correction', async () => {
    const session = apiAgenda.sessions.find((item) => item.id === 'session-ci')!
    session.placement = { id: 'placement-ci', dayId: 'day-d-1', roomId: 'room-d-2a', startsAt: '2027-05-12T17:10:00Z', endsAt: '2027-05-12T17:40:00Z', revision: 1 }
    renderAt('/admin/agenda')

    const offGridPlacement = await screen.findByRole('button', { name: /Taming 40-Minute CI.*Off-grid time/ })
    fireEvent.click(offGridPlacement)
    const start = within(screen.getByRole('dialog', { name: /Taming 40-Minute CI/ })).getByLabelText('Start time')
    expect(start).toHaveValue('2027-05-12T17:10:00Z')
    expect(within(start).getByRole('option', { name: /10:10 AM · off-grid time/ })).toBeInTheDocument()
  })

  it('calls out approved scheduled sessions that still need publication', async () => {
    const session = apiAgenda.sessions.find((item) => item.id === 'session-docs')!
    session.approvalStatus = 'approved'
    session.publicationStatus = 'ready'
    session.placement = { id: 'placement-docs', dayId: 'day-d-2', roomId: 'room-d-2b', startsAt: '2027-05-13T18:00:00Z', endsAt: '2027-05-13T18:10:00Z', revision: 1 }
    renderAt('/admin/agenda')

    expect(await screen.findByText('1 placed session is not public: 1 awaits publication.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Publish 1 update' }))
    expect(await screen.findByText((text) => text.includes('newly public'))).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/placed session is not public/)).not.toBeInTheDocument())
  })

  it('adds persisted agenda rooms and tracks from the setup panel', async () => {
    renderAt('/admin/agenda')
    await screen.findByText('Main Stage')
    fireEvent.click(screen.getByText('Rooms and tracks'))
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Overflow Room' } })
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }))
    expect(await screen.findByText('Overflow Room')).toBeInTheDocument()
    expect(screen.getByText('Overflow Room added.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Track name'), { target: { value: 'Community' } })
    fireEvent.change(screen.getByLabelText('Color'), { target: { value: 'teal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add track' }))
    expect(await screen.findByText('Community')).toBeInTheDocument()
    expect(screen.getByText('Community added.')).toBeInTheDocument()

    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(JSON.parse(String(calls.find(([path, init]) => String(path).endsWith('/agenda/rooms') && init?.method === 'POST')?.[1]?.body)))
      .toEqual({ name: 'Overflow Room', capacity: 120, sortOrder: 5 })
    expect(JSON.parse(String(calls.find(([path, init]) => String(path).endsWith('/agenda/tracks') && init?.method === 'POST')?.[1]?.body)))
      .toEqual({ name: 'Community', color: 'teal', sortOrder: 4 })
  })

  it('retains placement input after a typed room conflict and returns dialog focus on Escape', async () => {
    const normalFetch: typeof fetch = fetch
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/agenda/placements' && init?.method === 'POST') {
        return response({ error: { code: 'ROOM_CONFLICT', message: 'That room is already occupied during the selected time.', requestId: 'room-conflict' } }, 409)
      }
      return normalFetch(request, init)
    }))
    renderAt('/admin/agenda')
    const trigger = await screen.findByRole('button', { name: /Docs That Answer Back/ })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Docs That Answer Back' })
    expect(within(dialog).getByRole('button', { name: 'Close placement dialog' })).toHaveFocus()
    fireEvent.change(within(dialog).getByLabelText('Room'), { target: { value: 'room-d-2a' } })
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '2027-05-12T17:15:00Z' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Place session' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That room is already occupied')
    expect(within(dialog).getByLabelText('Room')).toHaveValue('room-d-2a')
    expect(within(dialog).getByLabelText('Start time')).toHaveValue('2027-05-12T17:15:00Z')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('moves, unplaces, auto-places, and publishes through canonical agenda responses', async () => {
    renderAt('/admin/agenda')
    const sessionButtons = await screen.findAllByRole('button', { name: /Taming 40-Minute CI/ })
    fireEvent.click(sessionButtons[0])
    let dialog = screen.getByRole('dialog', { name: /Taming 40-Minute CI/ })
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '2027-05-12T21:00:00Z' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save move' }))
    expect(await screen.findByText(/Taming 40-Minute CI.* moved\./)).toBeInTheDocument()

    fireEvent.click((await screen.findAllByRole('button', { name: /Taming 40-Minute CI/ }))[0])
    dialog = screen.getByRole('dialog', { name: /Taming 40-Minute CI/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from agenda' }))
    expect(await screen.findByText(/Taming 40-Minute CI.* removed from the agenda\./)).toBeInTheDocument()
    expect(document.querySelector('.connected-unplaced .count-pill')).toHaveTextContent(/^2$/)

    fireEvent.click(screen.getByRole('button', { name: 'Auto-place 2 in earliest slots' }))
    expect(await screen.findByText('2 sessions scheduled into the earliest available slots. Room and speaker conflicts were prevented.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Publish \d+ updates?|Retry publication/ }))
    expect(await screen.findByText((text) => text.includes('No new sessions were published') || text.includes('newly public'))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Download calendar/ })).toHaveAttribute('href', '/api/program.ics?event=devflow-conf-2027')
    expect(window.localStorage.getItem(DEMO_STORAGE_KEY)).toBeNull()
  })

  it('filters the live program and offers a dedicated reset at 390px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    renderAt('/program')
    await screen.findByRole('heading', { name: 'Program' })
    fireEvent.change(screen.getByLabelText('Filter by track'), { target: { value: 'Platform & Infra' } })
    fireEvent.change(screen.getByLabelText('Filter by format'), { target: { value: 'workshop' } })
    fireEvent.change(screen.getByLabelText('Filter by room'), { target: { value: 'Workshop Lab' } })
    expect(screen.getByRole('heading', { name: 'No sessions found' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(screen.getByLabelText('Filter by track')).toHaveValue('')
    expect(screen.getByRole('heading', { name: reviewProposal.title })).toBeInTheDocument()
  })

  it('keeps the anonymous program free of admin controls', async () => {
    renderAt('/program')
    await screen.findByRole('heading', { name: 'Program' })
    expect(screen.queryByText(/Back to ConfPilot admin/)).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
  })

  it('keeps reviewer and speaker workspaces isolated from organizer navigation', async () => {
    renderAt('/reviewer')
    expect(await screen.findByText(/Assignment privacy enforced/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    cleanup()
    renderAt('/speaker-portal')
    expect(await screen.findByRole('heading', { name: 'Your speaker desk' })).toBeInTheDocument()
    expect(screen.getByText('Sam Whitfield').closest('.role-header')).toBeInTheDocument()
    expect(screen.queryByText('Priya Raman')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
  })

  it('gates every anonymous admin route before the shell or private page mounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'anonymous-admin' } }, 401)
      throw new Error(`Admin child must not fetch before access is granted: ${path}`)
    }))
    renderAt('/admin/design-system')

    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'ConfPilot interface foundations' })).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['speaker', speakerSession, '/admin/speakers'],
    ['reviewer', reviewerSession, '/admin/content'],
  ])('keeps the %s role outside all admin shells and child data', async (_, deniedSession, path) => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ data: deniedSession, requestId: 'wrong-admin-role' })
      throw new Error(`Admin child must not fetch for the wrong role: ${path}`)
    }))
    renderAt(path)

    expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['admin', '/admin', 'Program operations overview'],
    ['reviewer', '/reviewer', 'Initial review'],
    ['speaker', '/speaker-portal', 'Your speaker desk'],
  ])('offers working sign out from the %s private shell', async (_, path, marker) => {
    renderAt(path)
    if (path === '/reviewer') await screen.findByText(/Assignment privacy enforced/)
    else await screen.findByRole('heading', { name: marker })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    expect(screen.queryByText('Your session expired. Sign in again to continue.')).not.toBeInTheDocument()
  })

  it('shows reviewer access denied without leaking assignment data to the wrong role', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ data: speakerSession, requestId: 'wrong-role' })
      throw new Error(`Unexpected protected request: ${path}`)
    }))
    renderAt('/reviewer')

    expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
    expect(screen.queryByText(reviewProposal.title)).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('lets a reviewer recover after signing in with the wrong account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'reviewer-signin' } }, 401)
      if (path === '/api/auth/login' && init?.method === 'POST') return response({ data: speakerSession, requestId: 'wrong-reviewer-role' })
      if (path === '/api/auth/logout' && init?.method === 'POST') return new Response(null, { status: 204 })
      throw new Error(`Unexpected protected request: ${init?.method ?? 'GET'} ${path}`)
    }))
    renderAt('/reviewer')

    await screen.findByRole('heading', { name: 'Sign in to continue.' })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'speaker@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }))
    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    expect(screen.getByLabelText('Email')).toHaveValue('')
  })

  it('clears the reviewer dossier when a protected detail request loses authorization', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review') return response({ error: { code: 'UNAUTHENTICATED', message: 'Your session expired.', requestId: 'expired-review' } }, 401)
      return fallback(request, init)
    })
    renderAt('/reviewer')

    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Your session expired. Sign in again to continue.')
    expect(screen.queryByText(reviewProposal.title)).not.toBeInTheDocument()
  })

  it('removes reviewer private UI when an ancillary protected request invalidates the shared session', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/cfp') return response({ error: { code: 'UNAUTHENTICATED', message: 'Your session expired.', requestId: 'ancillary-reviewer' } }, 401)
      return fallback(request, init)
    })
    renderAt('/reviewer')
    await screen.findByText(/Assignment privacy enforced/)

    await expect(cfpApi.organizerConfig('devflow-conf-2027')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })

    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Your session expired. Sign in again to continue.')
    expect(screen.queryByText(reviewProposal.title)).not.toBeInTheDocument()
  })

  it('keeps the reviewer workspace visible when an assignment request is forbidden', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review') return response({ error: { code: 'FORBIDDEN', message: 'This assignment is not available to your account.', requestId: 'forbidden-review' } }, 403)
      return fallback(request, init)
    })
    renderAt('/reviewer')

    expect(await screen.findByRole('alert')).toHaveTextContent('This assignment is not available to your account.')
    expect(screen.getByText(/Assignment privacy enforced/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in to continue.' })).not.toBeInTheDocument()
  })

  it('never substitutes another review for an unknown assignment deep link', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/review/assignments/unknown-assignment') {
        return response({ error: { code: 'NOT_FOUND', message: 'This assignment is not available.', requestId: 'unknown-review' } }, 404)
      }
      return fallback(request, init)
    })
    renderAt('/reviewer/assignments/unknown-assignment')

    expect(await screen.findByRole('alert')).toHaveTextContent('This assignment is not available.')
    expect(screen.queryByRole('heading', { level: 1, name: reviewProposal.title })).not.toBeInTheDocument()
    expect(defaultFetch).toHaveBeenCalledWith(
      '/api/events/devflow-conf-2027/review/assignments/unknown-assignment',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(defaultFetch).not.toHaveBeenCalledWith(
      '/api/events/devflow-conf-2027/review/assignments/assignment-review',
      expect.anything(),
    )
  })

  it('renders identified authors only for explicitly non-blind assignments', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review') return response({ data: { id: 'assignment-review', round: 1, blind: false, dueAt: null, status: 'pending', invitationStatus: 'accepted', review: null, proposal: { ...reviewProposal, abstract: 'Identified review abstract.', sessionAnswers: {}, authorDisplayName: 'Priya Raman' } }, requestId: 'identified' })
      return fallback(request, init)
    })
    renderAt('/reviewer')

    expect(await screen.findByText('Author · Priya Raman')).toBeInTheDocument()
    expect(screen.queryByText('speaker@example.test')).not.toBeInTheDocument()
  })

  it('requires a reviewer to accept or decline an invitation before scoring', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/review/assignments') return response({ data: { assignments: [{ id: 'assignment-review', round: 1, blind: true, dueAt: null, status: 'pending', invitationStatus: 'pending', conflict: null, proposal: reviewProposal }] }, requestId: 'pending-invitation' })
      if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review') return response({ data: { id: 'assignment-review', round: 1, blind: true, dueAt: null, status: 'pending', invitationStatus: 'pending', respondedAt: null, responseReason: null, conflict: null, review: null, evaluationPlan: null, proposal: { ...reviewProposal, abstract: 'Invitation-scoped proposal.', sessionAnswers: {} } }, requestId: 'pending-invitation' })
      if (path.endsWith('/assignment-review/invitation') && init?.method === 'POST') return response({ data: { id: 'assignment-review', invitationStatus: 'accepted', respondedAt: '2026-08-12T12:00:00.000Z', reason: null, conflict: null }, requestId: 'accepted-invitation' }, 201)
      return fallback(request, init)
    })
    renderAt('/reviewer')

    expect(await screen.findByRole('heading', { name: 'Accept or decline' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Submit evaluation/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Accept assignment' }))
    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/assignment-review/invitation') && init?.method === 'POST')).toBe(true))
    const mutation = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/assignment-review/invitation') && init?.method === 'POST')!
    expect(JSON.parse(String(mutation[1]?.body))).toEqual({ action: 'accept' })
  })

  it('shows organizers immutable reviewer response and conflict details', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/cfp/proposals/proposal-review/reviews') return response({ data: { proposal: organizerProposalDossier, progress: { assigned: 1, submitted: 0, revoked: 0 }, assignments: [{ id: 'assignment-review', reviewer: { userId: 'user-reviewer', displayName: 'Sam Whitfield' }, round: 1, blind: true, status: 'pending', invitationStatus: 'declined', respondedAt: '2026-08-12T12:00:00.000Z', responseReason: 'The author is in my reporting chain.', dueAt: null, createdAt: '2026-08-11T12:00:00.000Z', conflict: { category: 'institutional', note: 'The author is in my reporting chain.', declaredAt: '2026-08-12T12:00:00.000Z' } }], reviews: [] }, requestId: 'organizer-conflict' })
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')

    expect(await screen.findByText('Response reason:')).toBeInTheDocument()
    expect(screen.getAllByText(/The author is in my reporting chain/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Institutional conflict:/)).toBeInTheDocument()
  })

  it('reopens a completed scorecard and saves an explicit immutable correction revision', async () => {
    activeReview = { id: 'review-1', revisionNumber: 1, originality: 5, relevance: 4, recommendation: 'accept', comment: 'Canonical immutable review.', submittedAt: '2026-08-11T13:00:00.000Z', correctedAt: null }
    renderAt('/reviewer')

    expect(await screen.findByRole('heading', { name: 'Evaluation complete' })).toBeInTheDocument()
    expect(screen.getByText('Canonical immutable review.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Submit evaluation/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Correct scorecard' }))
    fireEvent.change(screen.getByLabelText(/Relevance/), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'Corrected after checking the rubric.' } })
    fireEvent.click(screen.getByRole('button', { name: /Save correction/ }))

    expect(await screen.findByText(/Submitted scorecard · Revision 2/)).toBeInTheDocument()
    expect(screen.getByText('Corrected after checking the rubric.')).toBeInTheDocument()
    expect(activeReview).toMatchObject({ revisionNumber: 2, relevance: 2, correctedAt: expect.any(String) })
    const mutation = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([path, init]) =>
      String(path).endsWith('/assignment-review/review') && init?.method === 'POST')
    expect(JSON.parse(String(mutation?.[1]?.body))).toMatchObject({ expectedRevision: 1, relevance: 2 })

    cleanup()
    renderAt('/admin/abstracts')
    expect(await screen.findByText('Corrected after checking the rubric.')).toBeInTheDocument()
    expect(screen.getByText(/Revision 2 · corrected/)).toBeInTheDocument()
  })

  it('discards an abandoned correction draft before reopening the saved revision', async () => {
    activeReview = { id: 'review-1', revisionNumber: 1, originality: 5, relevance: 4, recommendation: 'accept', comment: 'Canonical immutable review.', submittedAt: '2026-08-11T13:00:00.000Z', correctedAt: null }
    renderAt('/reviewer')

    fireEvent.click(await screen.findByRole('button', { name: 'Correct scorecard' }))
    fireEvent.change(screen.getByLabelText(/Relevance/), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'Abandoned correction draft.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel correction' }))
    fireEvent.click(screen.getByRole('button', { name: 'Correct scorecard' }))

    expect(screen.getByLabelText(/Relevance/)).toHaveValue('4')
    expect(screen.getByLabelText('Comments')).toHaveValue('Canonical immutable review.')
  })

  it('reloads the winning revision after a correction conflict', async () => {
    activeReview = { id: 'review-1', revisionNumber: 1, originality: 5, relevance: 4, recommendation: 'accept', comment: 'Canonical immutable review.', submittedAt: '2026-08-11T13:00:00.000Z', correctedAt: null }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/assignment-review/review') && init?.method === 'POST') {
        activeReview = { ...activeReview!, id: 'review-2', revisionNumber: 2, relevance: 2, comment: 'Concurrent winning correction.', correctedAt: '2026-08-12T13:00:00.000Z' }
        return response({ error: { code: 'REVIEW_CORRECTION_CONFLICT', message: 'Reload the latest scorecard revision before saving a correction.', requestId: 'correction-conflict' } }, 409)
      }
      return fallback(request, init)
    })
    renderAt('/reviewer')

    fireEvent.click(await screen.findByRole('button', { name: 'Correct scorecard' }))
    fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'Losing correction.' } })
    fireEvent.click(screen.getByRole('button', { name: /Save correction/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your correction was not saved.')
    expect(await screen.findByText(/Submitted scorecard · Revision 2/)).toBeInTheDocument()
    expect(screen.getByText('Concurrent winning correction.')).toBeInTheDocument()
  })

  it('keeps a rejected correction visibly unsaved when its round closes mid-edit', async () => {
    activeReview = { id: 'review-1', revisionNumber: 1, originality: 5, relevance: 4, recommendation: 'accept', comment: 'Canonical immutable review.', submittedAt: '2026-08-11T13:00:00.000Z', correctedAt: null }
    let roundClosed = false
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/assignment-review/review') && init?.method === 'POST') {
        roundClosed = true
        return response({ error: { code: 'REVIEW_ROUND_NOT_OPEN', message: 'Evaluations can only be submitted while the round window is open.', requestId: 'round-closed' } }, 409)
      }
      if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-review' && roundClosed) {
        return response({ data: { id: 'assignment-review', round: 1, blind: true, dueAt: '2026-08-20T20:00:00.000Z', status: 'completed', invitationStatus: 'accepted', review: activeReview, correctionAllowed: false, evaluationPlan: activeEvaluationPlan, proposal: { ...reviewProposal, abstract: 'A concrete account of incremental builds, measurement, and rollback safety.', sessionAnswers: { key_takeaway: 'Measure the dependency graph before optimizing it.' } } }, requestId: 'round-closed-detail' })
      }
      return fallback(request, init)
    })
    renderAt('/reviewer')

    fireEvent.click(await screen.findByRole('button', { name: 'Correct scorecard' }))
    fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'Correction at the deadline.' } })
    fireEvent.click(screen.getByRole('button', { name: /Save correction/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your correction was not saved.')
    expect(await screen.findByText('Corrections are closed for this assignment.')).toBeInTheDocument()
    expect(screen.getByText('Canonical immutable review.')).toBeInTheDocument()
  })

  it('prevents double scorecard submission while the first request is pending', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let resolveSubmission!: (value: Response) => void
    const submission = new Promise<Response>((resolve) => { resolveSubmission = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/assignment-review/review') && init?.method === 'POST') return submission
      return fallback(request, init)
    })
    renderAt('/reviewer')
    fireEvent.change(await screen.findByLabelText('Comments'), { target: { value: 'One durable submission.' } })
    const button = screen.getByRole('button', { name: /Submit evaluation/ })
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    const mutationCalls = defaultFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/assignment-review/review') && init?.method === 'POST')
    expect(mutationCalls).toHaveLength(1)
    resolveSubmission(response({ data: { id: 'review-one', originality: 3, relevance: 3, recommendation: 'discuss', comment: 'One durable submission.', submittedAt: '2026-08-11T13:00:00.000Z' }, requestId: 'one-write' }, 201))
    expect(await screen.findByRole('heading', { name: 'Evaluation complete' })).toBeInTheDocument()
  })

  it('keeps the submitted assignment selected when another review is pending', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/review/assignments') return response({ data: { assignments: [
        { id: 'assignment-review', round: 1, blind: true, dueAt: '2026-08-20T20:00:00.000Z', status: activeReview ? 'completed' : 'pending', invitationStatus: 'accepted', proposal: reviewProposal },
        { id: 'assignment-second', round: 1, blind: true, dueAt: null, status: 'pending', invitationStatus: 'accepted', proposal: { ...reviewProposal, publicId: 'ABS-143', title: 'Designing Failure-Safe Conference Workflows' } },
      ] }, requestId: 'two-assignments' })
      if (path === '/api/events/devflow-conf-2027/review/assignments/assignment-second') return response({ data: { id: 'assignment-second', round: 1, blind: true, dueAt: null, status: 'pending', invitationStatus: 'accepted', review: null, proposal: { ...reviewProposal, publicId: 'ABS-143', title: 'Designing Failure-Safe Conference Workflows', abstract: 'A second review dossier.', sessionAnswers: {} } }, requestId: 'second-assignment' })
      return fallback(request, init)
    })
    renderAt('/reviewer')
    fireEvent.change(await screen.findByLabelText('Comments'), { target: { value: 'Persist this review and its confirmation.' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit evaluation/ }))

    expect(await screen.findByRole('heading', { name: 'Evaluation complete' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: reviewProposal.title })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'Designing Failure-Safe Conference Workflows' })).not.toBeInTheDocument()
  })

  it('keeps reviewer navigation available without substituting a dossier for a malformed assignment route', async () => {
    renderAt('/reviewer/assignments/%')
    expect(await screen.findByText(/Assignment privacy enforced/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: reviewProposal.title })).not.toBeInTheDocument()
  })

  it('keeps the organizer shell available for a malformed abstract route', async () => {
    renderAt('/admin/abstracts/%')
    expect(await screen.findByRole('heading', { name: 'Proposals & reviews' })).toBeInTheDocument()
  })

  it('shows workshop prerequisites only for the configured workshop value', async () => {
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start a new proposal/ }))
    expect(screen.queryByText('Workshop prerequisites')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Format/), { target: { value: 'workshop' } })
    expect(screen.getByText('Workshop prerequisites')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Format/), { target: { value: 'talk' } })
    expect(screen.queryByText('Workshop prerequisites')).not.toBeInTheDocument()
  })

  it('uses singular proposal copy for one saved proposal', async () => {
    apiProposal = {
      id: 'proposal-1', publicId: 'ABS-TEST', status: 'draft', submittedAt: null,
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z',
      clientDraftKey: 'draft-1', decision: null, values: { title: 'One saved proposal' },
    }
    renderAt('/submit')
    expect(await screen.findByText(/1 proposal in this account/)).toBeInTheDocument()
  })

  it('prunes hidden conditional answers before saving a proposal', async () => {
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start a new proposal/ }))
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'A conditional field test' } })
    fireEvent.change(screen.getByLabelText(/Format/), { target: { value: 'workshop' } })
    fireEvent.change(screen.getByLabelText(/Workshop prerequisites/), { target: { value: 'Bring a laptop.' } })
    fireEvent.change(screen.getByLabelText(/Format/), { target: { value: 'talk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText(/Draft ABS-TEST saved/)
    expect(apiProposal).toMatchObject({ values: { title: 'A conditional field test', format: 'talk' } })
    expect((apiProposal as { values: Record<string, string> }).values).not.toHaveProperty('workshop_prerequisites')
  })

  it('creates a speaker account before exposing proposal fields', async () => {
    window.turnstile = {
      render: (_container, options) => { options.callback('verified-test-token'); return 'test-widget' },
      remove: vi.fn(),
    }
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      calls.push({ path, init })
      if (path === '/api/cfp/devflow-conf-2027') return response({ data: cfpConfig, requestId: 'test-request' })
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'test-request' } }, 401)
      if (path === '/api/cfp/devflow-conf-2027/register') return response({ data: speakerSession, requestId: 'test-request' }, 201)
      if (path === '/api/events/devflow-conf-2027/proposals') return response({ data: { proposals: [] }, requestId: 'test-request' })
      throw new Error(`Unhandled test request: ${init?.method ?? 'GET'} ${path}`)
    }))
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: 'Priya Raman' } })
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'speaker@example.test' } })
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: 'test-password-123' } })
    const createAccount = screen.getByRole('button', { name: /^Create account →$/ })
    await waitFor(() => expect(createAccount).toBeEnabled())
    fireEvent.click(createAccount)

    expect(await screen.findByRole('heading', { name: 'Tell us about your session.' })).toBeInTheDocument()
    const registration = calls.find((call) => call.path.endsWith('/register'))
    expect(JSON.parse(String(registration?.init?.body))).toMatchObject({ displayName: 'Priya Raman', email: 'speaker@example.test', turnstileToken: 'verified-test-token' })
  })

  it('lets a signed-in organizer join the CFP as a speaker when public registration is unavailable', async () => {
    const joinedSession = { ...workspaceSession, memberships: [...workspaceSession.memberships, { eventSlug: 'devflow-conf-2027', role: 'speaker' as const }] }
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      calls.push({ path, init })
      if (path === '/api/cfp/devflow-conf-2027') return response({ data: { ...cfpConfig, turnstile: { enabled: false, siteKey: null } }, requestId: 'test-request' })
      if (path === '/api/auth/session') return response({ data: workspaceSession, requestId: 'organizer-session' })
      if (path === '/api/cfp/devflow-conf-2027/join' && init?.method === 'POST') return response({ data: joinedSession, requestId: 'speaker-join' })
      if (path === '/api/events/devflow-conf-2027/proposals') return response({ data: { proposals: [] }, requestId: 'test-request' })
      throw new Error(`Unhandled test request: ${init?.method ?? 'GET'} ${path}`)
    }))

    renderAt('/events/devflow-conf-2027/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))

    expect(screen.getByRole('heading', { name: 'Welcome, Sam Whitfield.' })).toBeInTheDocument()
    const join = screen.getByRole('button', { name: /^Join as speaker →$/ })
    expect(join).toBeEnabled()
    fireEvent.click(join)

    expect(await screen.findByRole('heading', { name: 'Tell us about your session.' })).toBeInTheDocument()
    expect(calls.filter((call) => call.path === '/api/cfp/devflow-conf-2027/join' && call.init?.method === 'POST')).toHaveLength(1)
  })

  it('does not advance when joining the CFP fails to return speaker access', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/cfp/devflow-conf-2027') return response({ data: { ...cfpConfig, turnstile: { enabled: false, siteKey: null } }, requestId: 'test-request' })
      if (path === '/api/auth/session') return response({ data: workspaceSession, requestId: 'organizer-session' })
      if (path === '/api/cfp/devflow-conf-2027/join' && init?.method === 'POST') return response({ data: workspaceSession, requestId: 'speaker-join' })
      throw new Error(`Unhandled test request: ${init?.method ?? 'GET'} ${path}`)
    }))

    renderAt('/events/devflow-conf-2027/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Join as speaker →$/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Speaker access could not be confirmed for this event.')
    expect(screen.getByRole('heading', { name: 'Welcome, Sam Whitfield.' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tell us about your session.' })).not.toBeInTheDocument()
  })

  it('keeps unscoped demo storage out of the connected CFP routes', async () => {
    const unscoped = structuredClone(initialWorkflow)
    unscoped.cfpPublished = false
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(unscoped))

    renderAt('/submit')
    expect(await screen.findByRole('heading', { name: 'The developer workflow conference' })).toBeInTheDocument()
    cleanup()

    renderAt('/admin/cfp')
    await screen.findByLabelText('Confirmation message')
    expect(screen.queryByRole('button', { name: 'Reset demo' })).not.toBeInTheDocument()
  })

  it('uses server publication eligibility instead of fixture workflow flags', async () => {
    renderAt('/admin/content')
    fireEvent.click(await screen.findByRole('button', { name: 'Move approval to pending' }))
    cleanup()

    renderAt('/program')
    expect(await screen.findByRole('heading', { name: reviewProposal.title })).toBeInTheDocument()
    cleanup()

    renderAt('/admin/embeds')
    const preview = await screen.findByRole('region', { name: 'Saved embed preview' })
    expect(within(preview).getByRole('heading', { name: 'Website program' })).toBeInTheDocument()
    expect(within(preview).getByText(reviewProposal.title)).toBeInTheDocument()
  })

  it('submits reviewer criteria to the server and renders the auditable result', async () => {
    renderAt('/reviewer')
    const originality = await screen.findByLabelText(/Originality/)
    const relevance = screen.getByLabelText(/Relevance/)
    fireEvent.change(originality, { target: { value: '2' } })
    fireEvent.change(relevance, { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'Strong evidence and useful tradeoffs.' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit evaluation/ }))
    expect(await screen.findByRole('heading', { name: 'Evaluation complete' })).toBeInTheDocument()
    expect(screen.getByText(/Every submitted revision remains in the audit trail/)).toBeInTheDocument()
    expect(activeReview).toMatchObject({ originality: 2, relevance: 4, recommendation: 'discuss' })
  })

  it('uses the assignment-pinned plan for dynamic reviewer criteria', async () => {
    activeEvaluationPlan = structuredClone(evaluationPlanFixture) as unknown as Record<string, unknown>
    renderAt('/reviewer')

    const evidence = await screen.findByLabelText(/^Evidence quality/)
    const impact = screen.getByLabelText(/^Attendee impact/)
    expect(evidence).toHaveAttribute('aria-describedby', expect.stringContaining('description'))
    expect(screen.queryByLabelText(/^Originality/)).not.toBeInTheDocument()
    fireEvent.change(evidence, { target: { value: '4' } })
    fireEvent.change(impact, { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('Comments'), { target: { value: 'Scored against the assignment-pinned rubric.' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit evaluation/ }))

    expect(await screen.findByRole('heading', { name: 'Evaluation complete' })).toBeInTheDocument()
    expect(screen.getByText('Evaluation plan version 1')).toBeInTheDocument()
    expect(activeReview).toMatchObject({
      evaluationPlanVersion: 1,
      criterionScores: [
        { criterionId: 'criterion-evidence', score: 4 },
        { criterionId: 'criterion-impact', score: 9 },
      ],
      recommendation: 'discuss',
    })
  })

  it('submits through the server and resets for another proposal', async () => {
    renderAt('/submit')
    await completeProposal('Operational feedback loops that close')
    expect(apiProposal).toMatchObject({ status: 'submitted', values: { title: 'Operational feedback loops that close' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit another proposal' }))
    expect(screen.getByRole('heading', { name: 'Tell us about your session.' })).toBeInTheDocument()
  })

  it('reopens a submitted proposal, persists its update, and reloads the server-backed values', async () => {
    apiProposal = {
      id: 'proposal-1', publicId: 'ABS-TEST', status: 'submitted', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:02:00Z', clientDraftKey: 'submitted-edit-0001', decision: null,
      values: {
        title: 'Original submitted title', abstract: 'Original submitted abstract.', track: 'Platform & Infra', format: 'talk',
        key_takeaway: 'Original takeaway.', audience_level: 'Intermediate', speaker_bio: 'Original speaker biography.',
      },
    }
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Edit proposal/ }))
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Updated submitted title' } })
    fireEvent.change(screen.getByLabelText(/Abstract/), { target: { value: 'Updated submitted abstract with deterministic evidence.' } })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await screen.findByRole('heading', { name: 'Who is presenting?' })
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    fireEvent.click(screen.getByRole('button', { name: /Update proposal/ }))

    expect(await screen.findByRole('heading', { name: 'Your proposal has been updated.' })).toBeInTheDocument()
    expect(screen.getByText('ABS-TEST updated')).toBeInTheDocument()
    expect(apiProposal).toMatchObject({
      status: 'submitted',
      values: { title: 'Updated submitted title', abstract: 'Updated submitted abstract with deterministic evidence.' },
    })
    const updateCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([path, init]) => String(path).endsWith('/proposals/proposal-1') && init?.method === 'PUT')
    const resubmitCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([path, init]) => String(path).endsWith('/proposals/proposal-1/submit') && init?.method === 'POST')
    expect(updateCalls).toHaveLength(2)
    for (const [, init] of updateCalls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ values: { title: 'Updated submitted title' } })
    }
    expect(resubmitCalls).toHaveLength(0)

    cleanup()
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Edit proposal/ }))
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Updated submitted title')
    expect(screen.getByLabelText(/Abstract/)).toHaveValue('Updated submitted abstract with deterministic evidence.')
  })

  it('starts a fresh proposal explicitly without carrying over the selected proposal', async () => {
    apiProposal = {
      id: 'proposal-1', publicId: 'ABS-TEST', status: 'submitted', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:02:00Z', clientDraftKey: 'submitted-edit-0001', decision: null,
      values: {
        title: 'Existing submitted title', abstract: 'Existing submitted abstract.', track: 'Platform & Infra', format: 'talk',
        key_takeaway: 'Existing takeaway.', audience_level: 'Intermediate', speaker_bio: 'Existing speaker biography.',
      },
    }
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Edit proposal/ }))
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Existing submitted title')

    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Start a new proposal/ }))

    expect(screen.getByRole('heading', { name: 'Tell us about your session.' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument()
  })

  it('adds, reloads, and removes role-labelled co-presenters on an existing proposal', async () => {
    apiProposal = {
      id: 'proposal-1', publicId: 'ABS-TEST', status: 'submitted', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:02:00Z', clientDraftKey: 'participants-edit-0001', decision: null,
      values: {
        title: 'A proposal with a team', abstract: 'A complete abstract for the participant workflow.', track: 'Platform & Infra', format: 'talk',
        key_takeaway: 'Teams remain canonical.', audience_level: 'Intermediate', speaker_bio: 'Primary speaker biography.',
      },
    }
    renderAt('/events/devflow-conf-2027/submit/proposal-1')
    expect(await screen.findByText('Editing ABS-TEST.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))

    expect(await screen.findByRole('heading', { name: 'Who is presenting?' })).toBeInTheDocument()
    expect(screen.getByText('Primary presenter · speaker@example.test')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Morgan Lee' } })
    fireEvent.change(screen.getByLabelText(/^Email$/), { target: { value: 'MORGAN.LEE@EXAMPLE.TEST' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add co-presenter' }))
    expect(await screen.findByText('Co-presenter · morgan.lee@example.test')).toBeInTheDocument()

    cleanup()
    renderAt('/events/devflow-conf-2027/submit/proposal-1')
    expect(await screen.findByText('Editing ABS-TEST.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByText('Co-presenter · morgan.lee@example.test')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Morgan Lee' }))
    await waitFor(() => expect(screen.queryByText('Co-presenter · morgan.lee@example.test')).not.toBeInTheDocument())
    expect(screen.getByText('Primary presenter · speaker@example.test')).toBeInTheDocument()
  })

  it('links editable proposals from the speaker desk to their exact presenter workflow', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const editableProposal = {
      id: 'proposal-editable', publicId: 'ABS-EDIT', title: 'A submitted proposal missing a co-presenter',
      status: 'submitted' as const, decision: null, notificationStatus: 'not_queued' as const, acceptedSession: null,
    }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/workspace')) return response({ data: { ...ownerWorkspace, proposals: [editableProposal, ...ownerWorkspace.proposals] }, requestId: 'editable-workspace' })
      return fallback(request, init)
    })

    renderAt('/speaker-portal')

    const edit = await screen.findByRole('link', { name: 'Edit proposal and presenters — ABS-EDIT: A submitted proposal missing a co-presenter' })
    expect(edit).toHaveAttribute('href', '/events/devflow-conf-2027/submit/proposal-editable')
    const accepted = screen.getByText('ABS-OWNED').closest('article')!
    expect(within(accepted).queryByRole('link', { name: /and presenters/ })).not.toBeInTheDocument()
  })

  it('links the speaker desk to a read-only proposal record after the CFP closes', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const editableProposal = {
      id: 'proposal-after-close', publicId: 'ABS-CLOSED', title: 'A submitted proposal after the deadline',
      status: 'submitted' as const, decision: null, notificationStatus: 'not_queued' as const, acceptedSession: null,
    }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/cfp/devflow-conf-2027') return response({ data: { ...cfpConfig, state: 'closed' }, requestId: 'closed-cfp' })
      if (path.endsWith('/speaker/workspace')) return response({ data: { ...ownerWorkspace, proposals: [editableProposal] }, requestId: 'closed-workspace' })
      return fallback(request, init)
    })

    renderAt('/speaker-portal')

    expect(await screen.findByText('ABS-CLOSED')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /and presenters/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View submitted proposal — ABS-CLOSED: A submitted proposal after the deadline' })).toHaveAttribute('href', '/events/devflow-conf-2027/submit/proposal-after-close')
    expect(screen.getByText('Editing closed with the CFP.')).toBeInTheDocument()
  })

  it('shows the authenticated owner an exact read-only proposal record after the CFP closes', async () => {
    apiCfpConfig = { ...cfpConfig, state: 'closed' }
    apiProposal = {
      id: 'proposal-after-close', publicId: 'ABS-CLOSED', status: 'in_review', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:03:00Z', clientDraftKey: null, decision: null,
      values: {
        title: 'A durable submitted record',
        abstract: 'The exact abstract that the committee is reviewing.',
        track: 'AI Engineering',
        format: 'talk',
        key_takeaway: 'One source of truth survives the deadline.',
        audience_level: 'Intermediate',
        speaker_bio: 'Priya builds reliable submission systems.',
        retired_question: 'A preserved answer from the submission-time form.',
      },
    }

    renderAt('/events/devflow-conf-2027/submit/proposal-after-close')

    expect(await screen.findByRole('heading', { name: 'A durable submitted record' })).toBeInTheDocument()
    const record = screen.getByRole('article', { name: 'Read-only record for ABS-CLOSED' })
    expect(within(record).getByText('ABS-CLOSED · In review')).toBeInTheDocument()
    expect(within(record).getByText('The exact abstract that the committee is reviewing.')).toBeInTheDocument()
    expect(within(record).getByText('Talk (30 min)')).toBeInTheDocument()
    expect(within(record).getByText('Priya builds reliable submission systems.')).toBeInTheDocument()
    expect(within(record).getByText('Retired question')).toBeInTheDocument()
    expect(within(record).getByText('A preserved answer from the submission-time form.')).toBeInTheDocument()
    expect(within(record).getByText(/Read-only submitted record/)).toBeInTheDocument()
    expect(within(record).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(record).queryByRole('button', { name: /Save|Update|Submit|co-presenter/i })).not.toBeInTheDocument()
  })

  it('fails closed for an unavailable proposal after the CFP closes without echoing its id', async () => {
    apiCfpConfig = { ...cfpConfig, state: 'closed' }
    apiProposal = {
      id: 'proposal-owned', publicId: 'ABS-OWNED', status: 'submitted', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:02:00Z', clientDraftKey: null, decision: null,
      values: { title: 'The owner account proposal', abstract: 'Visible only from the owner-scoped list.' },
    }

    renderAt('/events/devflow-conf-2027/submit/not-owned')

    expect(await screen.findByRole('alert')).toHaveTextContent('This proposal is not available in your account.')
    expect(screen.getByRole('link', { name: /View ABS-OWNED/ })).toHaveAttribute('href', '/events/devflow-conf-2027/submit/proposal-owned')
    expect(screen.queryByText('Visible only from the owner-scoped list.')).not.toBeInTheDocument()
    expect(screen.queryByText('not-owned')).not.toBeInTheDocument()
  })

  it('keeps the closed CFP generic for an anonymous visitor', async () => {
    apiCfpConfig = { ...cfpConfig, state: 'closed' }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(request) === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required.', requestId: 'anonymous-cfp' } }, 401)
      return fallback(request, init)
    })

    renderAt('/events/devflow-conf-2027/submit/proposal-after-close')

    expect(await screen.findByRole('heading', { name: 'Submissions are closed.' })).toBeInTheDocument()
    expect(screen.queryByText('Read-only submitted record')).not.toBeInTheDocument()
  })

  it('explains when proposal editing has not opened yet', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const editableProposal = {
      id: 'proposal-upcoming', publicId: 'ABS-UPCOMING', title: 'A proposal before the CFP opens',
      status: 'draft' as const, decision: null, notificationStatus: 'not_queued' as const, acceptedSession: null,
    }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/cfp/devflow-conf-2027') return response({ data: { ...cfpConfig, state: 'upcoming' }, requestId: 'upcoming-cfp' })
      if (path.endsWith('/speaker/workspace')) return response({ data: { ...ownerWorkspace, proposals: [editableProposal] }, requestId: 'upcoming-workspace' })
      return fallback(request, init)
    })

    renderAt('/speaker-portal')

    expect(await screen.findByText('ABS-UPCOMING')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Edit proposal and presenters/ })).not.toBeInTheDocument()
    expect(screen.getByText('Editing opens with the CFP.')).toBeInTheDocument()
  })

  it('explains and can retry when CFP editing status cannot be confirmed', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const editableProposal = {
      id: 'proposal-unavailable', publicId: 'ABS-UNAVAILABLE', title: 'A proposal while CFP configuration is unavailable',
      status: 'submitted' as const, decision: null, notificationStatus: 'not_queued' as const, acceptedSession: null,
    }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/cfp/devflow-conf-2027') return response({ error: { code: 'NOT_FOUND', message: 'No published CFP exists.', requestId: 'unpublished-cfp' } }, 404)
      if (path.endsWith('/speaker/workspace')) return response({ data: { ...ownerWorkspace, proposals: [editableProposal] }, requestId: 'unavailable-workspace' })
      return fallback(request, init)
    })

    renderAt('/speaker-portal')

    expect(await screen.findByText('ABS-UNAVAILABLE')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Edit proposal and presenters/ })).not.toBeInTheDocument()
    expect(screen.getByText('Editing availability could not be confirmed.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh editing status' }))
    await waitFor(() => expect(defaultFetch.mock.calls.filter(([request]) => requestPath(request) === '/api/cfp/devflow-conf-2027')).toHaveLength(2))
  })

  it('fails closed when a deep-linked proposal is unavailable while keeping the owned list usable', async () => {
    apiProposal = {
      id: 'proposal-1', publicId: 'ABS-TEST', status: 'submitted', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:02:00Z', clientDraftKey: null, decision: null,
      values: { title: 'Owned editable proposal' },
    }

    renderAt('/events/devflow-conf-2027/submit/not-owned')

    expect(await screen.findByRole('alert')).toHaveTextContent('This proposal is not available to edit.')
    expect(screen.getByRole('button', { name: /Edit proposal/ })).toBeInTheDocument()
    expect(screen.queryByText('not-owned')).not.toBeInTheDocument()
  })

  it('fails closed when a deep-linked owned proposal became locked', async () => {
    apiProposal = {
      id: 'proposal-1', publicId: 'ABS-LOCKED', status: 'in_review', submittedAt: '2026-08-11T00:02:00Z',
      createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:03:00Z', clientDraftKey: null, decision: null,
      values: { title: 'Newly locked proposal' },
    }

    renderAt('/events/devflow-conf-2027/submit/proposal-1')

    expect(await screen.findByRole('alert')).toHaveTextContent('This proposal is not available to edit.')
    expect(screen.getByText('ABS-LOCKED · In review')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tell us about your session.' })).not.toBeInTheDocument()
  })

  it('shows exact accepted, rejected, and waitlisted states in the submitter proposal list', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const proposals = (['accept', 'reject', 'waitlist'] as const).map((decision, index) => ({
      id: `proposal-${decision}`, publicId: `ABS-${index + 1}`, status: 'decided', submittedAt: '2026-08-11T00:02:00Z', createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:02:00Z', clientDraftKey: null, decision, values: { title: `${decision} proposal` },
    }))
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/proposals' && (!init?.method || init.method === 'GET')) return response({ data: { proposals }, requestId: 'proposal-decisions' })
      return fallback(request, init)
    })
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))

    expect(await screen.findByText('ABS-1 · Accepted')).toBeInTheDocument()
    expect(screen.getByText('ABS-2 · Rejected')).toBeInTheDocument()
    expect(screen.getByText('ABS-3 · Waitlisted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue.*accept proposal/i })).not.toBeInTheDocument()
  })

  it('updates the live CFP preview in memory without writing before save', async () => {
    renderAt('/admin/cfp')
    await screen.findByLabelText('Event name')
    const preview = screen.getByLabelText('Public CFP preview')
    expect(within(preview).getByText('Saved version 1')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Save changes' }).every((button) => button.hasAttribute('disabled'))).toBe(true)
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'DevFlow Community Summit' } })
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: 'Build your own program' } })

    expect(screen.getByText('DevFlow Community Summit')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Build your own program' })).toBeInTheDocument()
    expect(within(preview).getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Save changes' }).every((button) => !button.hasAttribute('disabled'))).toBe(true)
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([path, init]) => path === '/api/events/devflow-conf-2027/cfp' && init?.method === 'PUT')).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
  })

  it('adds, configures, and explicitly reorders a custom field', async () => {
    renderAt('/admin/cfp')
    await screen.findByRole('button', { name: 'Add field' })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    const newField = screen.getByRole('group', { name: 'New question' })
    fireEvent.change(within(newField).getByLabelText('Label'), { target: { value: 'Team size' } })
    fireEvent.change(within(newField).getByLabelText('Type'), { target: { value: 'dropdown' } })
    fireEvent.change(within(newField).getByLabelText(/Options/), { target: { value: 'solo | Solo\nteam | Team' } })
    fireEvent.click(within(newField).getByRole('button', { name: 'Move Team size up' }))

    expect(screen.getByRole('group', { name: 'Team size' })).toBeInTheDocument()
    expect(screen.getByLabelText('Team size preview')).toBeEnabled()
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([path, init]) => path === '/api/events/devflow-conf-2027/cfp' && init?.method === 'PUT')).toBe(false)
    expect(screen.getByRole('button', { name: 'Remove Title' })).toBeDisabled()
  })

  it('keeps conditional rules valid when dropdown options and types change', async () => {
    renderAt('/admin/cfp')
    await screen.findByRole('button', { name: 'Add field' })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    const source = screen.getByRole('group', { name: 'New question' })
    fireEvent.change(within(source).getByLabelText('Label'), { target: { value: 'Audience' } })
    fireEvent.change(within(source).getByLabelText('Type'), { target: { value: 'dropdown' } })
    fireEvent.change(within(source).getByLabelText(/Options/), { target: { value: 'solo | Solo\nteam | Team' } })
    const sourceKey = (within(screen.getByRole('group', { name: 'Audience' })).getByLabelText('Key') as HTMLInputElement).value

    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    const newQuestions = screen.getAllByRole('group', { name: 'New question' })
    const dependent = newQuestions[newQuestions.length - 1]
    fireEvent.change(within(dependent).getByLabelText('Label'), { target: { value: 'Team details' } })
    fireEvent.change(within(dependent).getByLabelText('Visible when'), { target: { value: sourceKey } })
    expect(within(dependent).getByLabelText('Equals')).toHaveValue('solo')

    fireEvent.change(within(screen.getByRole('group', { name: 'Audience' })).getByLabelText(/Options/), { target: { value: 'team | Team' } })
    expect(within(screen.getByRole('group', { name: 'Team details' })).getByLabelText('Equals')).toHaveValue('team')
    fireEvent.change(within(screen.getByRole('group', { name: 'Audience' })).getByLabelText('Type'), { target: { value: 'short_text' } })
    expect(within(screen.getByRole('group', { name: 'Team details' })).getByLabelText('Visible when')).toHaveValue('')
  })

  it('uses stable non-recycled answer keys for newly added questions', async () => {
    renderAt('/admin/cfp')
    await screen.findByRole('button', { name: 'Add field' })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    const first = screen.getByRole('group', { name: 'New question' })
    const firstKey = (within(first).getByLabelText('Key') as HTMLInputElement).value
    expect(within(first).getByLabelText('Key')).toBeDisabled()
    fireEvent.click(within(first).getByRole('button', { name: 'Remove New question' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    const secondKey = (within(screen.getByRole('group', { name: 'New question' })).getByLabelText('Key') as HTMLInputElement).value
    expect(secondKey).not.toBe(firstKey)
  })

  it('saves organizer copy and fields with the expected revision guard', async () => {
    renderAt('/admin/cfp')
    await screen.findByLabelText('Confirmation message')
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'DevFlow Community Summit' } })
    fireEvent.change(screen.getByLabelText('Opens'), { target: { value: '2027-01-02T03:04' } })
    fireEvent.change(screen.getByLabelText('Confirmation message'), { target: { value: 'Updated confirmation.' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/events/devflow-conf-2027/cfp', expect.objectContaining({ method: 'PUT' })))
    const updateCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([path, init]) => path === '/api/events/devflow-conf-2027/cfp' && init?.method === 'PUT')
    const update = JSON.parse(String(updateCall?.[1]?.body))
    expect(update.opensAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(update.expectedRevision).toBe(1)
    expect(update.event).toMatchObject({ name: 'DevFlow Community Summit', startsOn: '2027-05-12', endsOn: '2027-05-14' })
    expect(await screen.findByText('Saved version 2.')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Public CFP preview')).getByText('Saved version 2')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Save changes' }).every((button) => button.hasAttribute('disabled'))).toBe(true)
  })

  it('shows a reload control after a stale customization save', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/cfp' && init?.method === 'PUT') return response({ error: { code: 'CFP_REVISION_CONFLICT', message: 'This submission form changed in another session.', requestId: 'stale-cfp' } }, 409)
      return fallback(request, init)
    })
    renderAt('/admin/cfp')
    await screen.findByLabelText('Event name')
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Stale organizer copy' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])

    expect(await screen.findByRole('alert')).toHaveTextContent('changed in another session')
    expect(screen.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Reload latest version' })).toBeInTheDocument()
  })

  it('removes stale organizer chrome before reauthentication changes to a speaker account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ data: workspaceSession, requestId: 'organizer-session' })
      if (path === '/api/events/devflow-conf-2027/cfp') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'test-request' } }, 401)
      if (path === '/api/auth/login' && init?.method === 'POST') return response({ data: speakerSession, requestId: 'test-request' })
      throw new Error(`Unhandled test request: ${init?.method ?? 'GET'} ${path}`)
    }))
    renderAt('/admin/cfp')
    await screen.findByRole('heading', { name: 'Sign in to continue.' })
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    expect(screen.queryByText('Sam Whitfield')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'speaker@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open your workspace' })).toHaveAttribute('href', '/events/devflow-conf-2027/speaker')
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    expect(screen.queryByText('Sam Whitfield')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('returns to organizer sign-in when the session expires during save', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ data: workspaceSession, requestId: 'organizer-session' })
      if (path === '/api/events/devflow-conf-2027/cfp' && init?.method === 'PUT') {
        return response({ error: { code: 'UNAUTHENTICATED', message: 'Your session expired. Sign in again.', requestId: 'expired-request' } }, 401)
      }
      if (path === '/api/events/devflow-conf-2027/cfp') return response({ data: cfpConfig, requestId: 'test-request' })
      throw new Error(`Unhandled test request: ${init?.method ?? 'GET'} ${path}`)
    }))
    renderAt('/admin/cfp')
    await screen.findByLabelText('Confirmation message')
    fireEvent.change(screen.getByLabelText('Confirmation message'), { target: { value: 'Unsaved organizer message.' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save changes' })[0])

    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Workspace navigation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })

  it('keeps connected reviews independent from hostile demo storage', async () => {
    window.localStorage.setItem(DEMO_STORAGE_KEY, '{}')
    renderAt('/reviewer')
    expect(await screen.findByRole('heading', { name: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale' })).toBeInTheDocument()
    cleanup()
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ proposals: [] }))
    renderAt('/speaker-portal')
    expect(await screen.findByRole('heading', { name: 'Your speaker desk' })).toBeInTheDocument()
  })

  it('opens details for every scheduled speaker', async () => {
    renderAt('/program')
    await screen.findByRole('heading', { name: 'Program' })
    fireEvent.click(screen.getByRole('heading', { name: 'Evals You Can Trust' }).closest('button')!)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Sanaa Idris/ }))
    expect(screen.getByRole('heading', { name: 'Sanaa Idris' })).toBeInTheDocument()
  })

  it('searches speaker-owned fields without pulling in unrelated co-presenters', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const sharedSession = { ...publicProgram.sessions[0], speakers: [
      publicProgram.sessions[0].speakers[0],
      { slug: 'marcus-okafor', name: 'Marcus Okafor', title: 'Staff Engineer', company: 'Northstar', headshotUrl: null, headshotFallback: 'MO' },
    ] }
    const program = {
      ...publicProgram,
      sessions: [sharedSession, publicProgram.sessions[1]],
      speakers: [
        publicProgram.speakers[0],
        { slug: 'marcus-okafor', name: 'Marcus Okafor', title: 'Staff Engineer', company: 'Northstar', bio: 'Marcus builds production agents.', headshotUrl: null, headshotFallback: 'MO', publicVisibility: 'published', sessions: [{ slug: sharedSession.slug, title: sharedSession.title, track: sharedSession.track, format: sharedSession.format }] },
        publicProgram.speakers[1],
      ],
    }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => requestPath(request) === '/api/program'
      ? response({ data: program, requestId: 'speaker-search' })
      : fallback(request, init))

    renderAt('/program#speakers')
    fireEvent.change(await screen.findByLabelText('Search sessions and speakers'), { target: { value: 'Priya Raman' } })

    expect(screen.getByText('1 speaker')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Priya Raman' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Marcus Okafor' })).not.toBeInTheDocument()
  })

  it('confirms a successful personal calendar download by filename', async () => {
    window.localStorage.setItem('confpilot:personal-schedule:v1:devflow-conf-2027', JSON.stringify(['taming-ci']))
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => requestPath(request) === '/api/program.ics' && init?.method === 'POST'
      ? new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200, headers: { 'content-type': 'text/calendar' } })
      : fallback(request, init))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:calendar') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    renderAt('/program#my-schedule')
    fireEvent.click(await screen.findByRole('button', { name: 'Download my schedule (.ics)' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Downloaded devflow-conf-2027-my-schedule.ics.')
  })

  it('moves focus into dialogs and returns it after Escape', async () => {
    renderAt('/program')
    await screen.findByRole('heading', { name: 'Program' })
    const trigger = screen.getByRole('heading', { name: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale' }).closest('button')!
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Close session details' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps canonical submitted confirmation visible after the server succeeds', async () => {
    renderAt('/submit')
    await completeProposal('Persisted confirmation')
    expect(screen.getByRole('heading', { name: 'Your proposal is in the review queue.' })).toBeInTheDocument()
    expect(screen.getByText('Thanks for sharing your proposal. You can view its status from this account.')).toBeInTheDocument()
  })

  it.each([
    ['the unscoped stock message', 'Thanks for sharing your proposal. You can edit it until the CFP closes.', 'Thanks for sharing your proposal. You can view its status from this account.'],
    ['custom organizer copy', 'We received your proposal and will share the outcome here.', 'We received your proposal and will share the outcome here.'],
  ])('preserves truthful confirmation behavior for %s', async (_, configuredMessage, expectedMessage) => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/cfp/devflow-conf-2027') return response({ data: { ...cfpConfig, confirmationMessage: configuredMessage }, requestId: 'cfp-confirmation' })
      return fallback(request, init)
    })

    renderAt('/submit')
    await completeProposal('Confirmation compatibility')

    expect(screen.getByText(expectedMessage)).toBeInTheDocument()
    if (configuredMessage !== expectedMessage) expect(screen.queryByText(configuredMessage)).not.toBeInTheDocument()
  })

  it('shows the truthful stock confirmation when the API returns the unscoped stock message', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/cfp') return response({ data: { ...cfpConfig, confirmationMessage: 'Thanks for sharing your proposal. You can edit it until the CFP closes.' }, requestId: 'cfp-confirmation' })
      return fallback(request, init)
    })

    renderAt('/admin/cfp')

    expect(await screen.findByLabelText('Confirmation message')).toHaveValue('Thanks for sharing your proposal. You can view its status from this account.')
  })

  it('dismisses the mobile navigation with Escape', async () => {
    renderAt('/admin')
    await screen.findByRole('heading', { name: 'Program operations overview' })
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }))
    expect(document.querySelector('.sidebar')).toHaveClass('is-open')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.sidebar')).not.toHaveClass('is-open')
  })

  it('reports clipboard failures instead of rejecting silently', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderAt('/admin/embeds')
    fireEvent.click(await screen.findByRole('button', { name: 'Copy iframe' }))
    expect(await screen.findByText('Copy failed. Select and copy the value manually.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('<iframe src="http://localhost:3000/embed/devflow-conf-2027/website-program" title="Website program" loading="lazy" style="width:100%;border:0;min-height:600px"></iframe>')
  })

  it('copies the displayed JSON feed URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderAt('/admin/embeds')
    fireEvent.click(await screen.findByRole('button', { name: 'Copy alternate' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:3000/api/public/events/devflow-conf-2027/embeds/website-program'))
  })

  it('copies the filtered iCalendar feed URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderAt('/admin/embeds')
    fireEvent.click(await screen.findByRole('button', { name: 'Copy iCal URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://localhost:3000/api/public/events/devflow-conf-2027/embeds/website-program/calendar.ics'))
  })

  it('preserves form values and focuses the server error when submission closes', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    defaultFetch.mockImplementationOnce(async () => response({ data: cfpConfig, requestId: 'test-request' }))
      .mockImplementationOnce(async () => response({ data: speakerSession, requestId: 'test-request' }))
      .mockImplementationOnce(async () => response({ data: { proposals: [] }, requestId: 'test-request' }))
    renderAt('/submit')
    await completeProposal('Racing publication state', false)
    // The next response rejects persistDraft's create request before submit can run.
    defaultFetch.mockResolvedValueOnce(response({ error: { code: 'CFP_CLOSED', message: 'This call for proposals is not accepting changes.', requestId: 'closed-request' } }, 409))
    fireEvent.click(screen.getByRole('button', { name: /Submit proposal/ }))
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(alert).toHaveTextContent('This call for proposals is not accepting changes.')
    expect(screen.getByText('Racing publication state')).toBeInTheDocument()
  })

  it('keeps focus in a field while clearing its validation issue', async () => {
    renderAt('/submit')
    fireEvent.click(await screen.findByRole('button', { name: /Start submission/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start a new proposal/ }))
    const title = screen.getByLabelText(/^Title/)
    fireEvent.submit(title.closest('form')!)
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())

    title.focus()
    fireEvent.change(title, { target: { value: 'A' } })
    expect(title).toHaveFocus()
    fireEvent.change(title, { target: { value: 'Ad' } })
    expect(title).toHaveFocus()
  })

  it('renders only the server-owned speaker workspace with exact decision and email states', async () => {
    const state = structuredClone(initialWorkflow) as unknown as Record<string, unknown>
    state.proposals = [{ id: 'hostile-local', title: 'A proposal owned by somebody else' }]
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state))
    renderAt('/speaker-portal')

    expect(await screen.findByText('Accepted')).toBeInTheDocument()
    expect(screen.getByText('Decision visible in ConfPilot; no notification saved to the outbox.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'An owner-scoped accepted session', level: 3 })).toBeInTheDocument()
    expect(screen.getAllByText('Confirm participation')).toHaveLength(2)
    expect(screen.queryByText('A proposal owned by somebody else')).not.toBeInTheDocument()
  })

  it.each(['accept', 'reject', 'waitlist'] as const)('records one immutable %s decision with the correct handoff', async (decisionValue) => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/decisions' && init?.method === 'POST') {
        const input = JSON.parse(String(init.body))
        return response({ data: {
          proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title },
          decision: { id: `decision-${decisionValue}`, value: input.decision, rationale: input.rationale, decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' },
          handoff: decisionValue === 'accept' ? { status: 'materialized', acceptanceId: 'acceptance-1', acceptedAt: '2026-08-11T13:00:00Z', programSession: { id: 'session-1', slug: 'taming-ci' } } : { status: 'not_applicable' },
          notification: { status: 'not_queued' },
        }, requestId: 'decision-request' }, 201)
      }
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')

    await screen.findByRole('heading', { name: 'Proposals & reviews' })
    const rationale = await screen.findByLabelText('Organizer rationale')
    if (decisionValue !== 'accept') fireEvent.click(screen.getByRole('radio', { name: new RegExp(decisionValue, 'i') }))
    fireEvent.change(rationale, { target: { value: `${decisionValue} based on the completed review.` } })
    fireEvent.click(screen.getByRole('button', { name: 'Review final decision' }))
    const dialog = screen.getByRole('dialog', { name: new RegExp(`${decisionValue}`, 'i') })
    fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(`Confirm ${decisionValue}`, 'i') }))

    expect(await screen.findByText('Decision visible in ConfPilot; no notification saved to the outbox.')).toBeInTheDocument()
    expect(screen.getByText('Immutable')).toBeInTheDocument()
    if (decisionValue === 'accept') expect(screen.getByText('✓ Canonical session created immediately')).toBeInTheDocument()
    else expect(screen.queryByText('✓ Canonical session created immediately')).not.toBeInTheDocument()
  })

  it('prevents a double decision submit while the first immutable write is pending', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let resolveDecision!: (value: Response) => void
    const pendingDecision = new Promise<Response>((resolve) => { resolveDecision = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/decisions' && init?.method === 'POST') return pendingDecision
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')
    await screen.findByRole('heading', { name: 'Proposals & reviews' })
    fireEvent.change(await screen.findByLabelText('Organizer rationale'), { target: { value: 'One final decision.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review final decision' }))
    const confirm = screen.getByRole('button', { name: 'Confirm accept' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(defaultFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/decisions') && init?.method === 'POST')).toHaveLength(1)
    resolveDecision(response({ data: { proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title }, decision: { id: 'decision-1', value: 'accept', rationale: 'One final decision.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }, handoff: { status: 'materialized', acceptanceId: 'acceptance-1', acceptedAt: '2026-08-11T13:00:00Z', programSession: { id: 'session-1', slug: 'taming-ci' } }, notification: { status: 'not_queued' } }, requestId: 'decision-request' }, 201))
    expect(await screen.findByText('✓ Canonical session created immediately')).toBeInTheDocument()
  })

  it('requires an open named round when assigning additional review after a decision', async () => {
    const item = { proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title }, decision: { id: 'decision-existing', value: 'accept', rationale: 'Advance to a final review round.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }, handoff: { status: 'materialized', acceptanceId: 'acceptance-1', acceptedAt: '2026-08-11T13:00:00Z', programSession: { id: 'session-1', slug: 'taming-ci' } }, notification: { status: 'not_queued' } }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/decisions') && (!init?.method || init.method === 'GET')) return response({ data: { event: ownerWorkspace.event, decisions: [item] }, requestId: 'decision-list' })
      if (path.endsWith('/cfp/reviewers') && (!init?.method || init.method === 'GET')) return response({ data: { reviewers: [
        { userId: 'user-reviewer', displayName: 'Sam Whitfield', email: 'reviewer@example.test' },
        { userId: 'user-reviewer-duplicate', displayName: 'Sam Whitfield', email: 'sam.duplicate@example.test' },
      ] }, requestId: 'duplicate-reviewers' })
      if (path.endsWith('/cfp/proposals/proposal-review/reviews')) return response({ data: { proposal: { ...organizerProposalDossier, status: 'decided' }, progress: { assigned: 0, submitted: 0, revoked: 0 }, assignments: [], reviews: [] }, requestId: 'decided-detail' })
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')

    expect(await screen.findByText('Additional round review')).toBeInTheDocument()
    expect(screen.getByText(/does not reopen or replace the recorded decision/i)).toBeInTheDocument()
    const round = screen.getByLabelText('Review round')
    await waitFor(() => expect(round).toHaveValue('round-1'))
    expect(within(round).queryByRole('option', { name: /Event default/ })).not.toBeInTheDocument()
    const reviewer = screen.getByLabelText('Reviewer')
    expect(within(reviewer).getByRole('option', { name: 'Sam Whitfield · reviewer@example.test' })).toBeInTheDocument()
    expect(within(reviewer).getByRole('option', { name: 'Sam Whitfield · sam.duplicate@example.test' })).toBeInTheDocument()
    fireEvent.change(reviewer, { target: { value: 'user-reviewer-duplicate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign reviewer' }))
    await waitFor(() => {
      const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/proposal-review/assignments') && init?.method === 'POST')
      expect(call).toBeDefined()
      expect(JSON.parse(String(call![1]?.body))).toMatchObject({ reviewerUserId: 'user-reviewer-duplicate', reviewRoundId: 'round-1' })
    })
  })

  it('explains why decided proposals cannot be assigned when no named round is open', async () => {
    reviewRounds = [{ ...reviewRounds[0], windowState: 'upcoming' }]
    const item = { proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title }, decision: { id: 'decision-existing', value: 'waitlist', rationale: 'Hold for later.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }, handoff: { status: 'not_applicable' }, notification: { status: 'not_queued' } }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/decisions') && (!init?.method || init.method === 'GET')) return response({ data: { event: ownerWorkspace.event, decisions: [item] }, requestId: 'decision-list' })
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')

    expect(await screen.findByText(/Create or open a named review round to collect additional input/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign reviewer' })).not.toBeInTheDocument()
  })

  it('does not claim additional review is closed when review rounds fail to load', async () => {
    const item = { proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title }, decision: { id: 'decision-existing', value: 'accept', rationale: 'Advance to a final review round.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }, handoff: { status: 'materialized', acceptanceId: 'acceptance-1', acceptedAt: '2026-08-11T13:00:00Z', programSession: { id: 'session-1', slug: 'taming-ci' } }, notification: { status: 'not_queued' } }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/decisions') && (!init?.method || init.method === 'GET')) return response({ data: { event: ownerWorkspace.event, decisions: [item] }, requestId: 'decision-list' })
      if (path.endsWith('/cfp/review-rounds') && (!init?.method || init.method === 'GET')) return response({ error: { code: 'REVIEW_ROUNDS_UNAVAILABLE', message: 'Review rounds are temporarily unavailable.', requestId: 'rounds-failed' } }, 503)
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')

    expect(await screen.findByText('Review rounds are temporarily unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByText('Additional review is closed.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign reviewer' })).not.toBeInTheDocument()
  })

  it('reloads the canonical outcome after a concurrent immutable decision conflict', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const canonical = {
      proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title },
      decision: { id: 'decision-concurrent', value: 'reject', rationale: 'Another organizer recorded this first.', decidedBy: { userId: 'organizer-2', displayName: 'Morgan Reyes' }, decidedAt: '2026-08-11T13:00:00Z' },
      handoff: { status: 'not_applicable' },
      notification: { status: 'not_queued' },
    }
    let conflictRecorded = false
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/decisions') && (!init?.method || init.method === 'GET')) {
        return response({ data: { event: ownerWorkspace.event, decisions: conflictRecorded ? [canonical] : [] }, requestId: 'decision-list' })
      }
      if (path.endsWith('/decisions') && init?.method === 'POST') {
        conflictRecorded = true
        return response({ error: { code: 'DECISION_ALREADY_RECORDED', message: 'A different immutable decision has already been recorded for this proposal.', requestId: 'decision-conflict' } }, 409)
      }
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')
    await screen.findByRole('heading', { name: 'Proposals & reviews' })
    fireEvent.change(await screen.findByLabelText('Organizer rationale'), { target: { value: 'Accept based on the completed review.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review final decision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm accept' }))

    expect(await screen.findByRole('heading', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.getByText('Another organizer recorded this first.')).toBeInTheDocument()
    expect(screen.getByText('Immutable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Assign reviewer' })).toBeInTheDocument()
  })

  it('previews without persisting, then saves the edited email snapshot to the outbox', async () => {
    const item = { proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title }, decision: { id: 'decision-existing', value: 'reject', rationale: 'Not a fit this year.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }, handoff: { status: 'not_applicable' }, notification: { status: 'not_queued' } }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/decisions') && (!init?.method || init.method === 'GET')) return response({ data: { event: ownerWorkspace.event, decisions: [item] }, requestId: 'decision-list' })
      if (path.endsWith('/decision-existing/notification-preview')) return response({ data: { proposal: item.proposal, decision: { id: 'decision-existing', value: 'reject' }, recipient: { speakerId: 'speaker-1', userId: 'user-1', name: 'Priya Raman', email: 'priya@example.test' }, subject: 'Proposal update', body: 'Thank you for submitting.' }, requestId: 'preview' })
      if (path.endsWith('/decision-existing/notification') && init?.method === 'POST') {
        const input = JSON.parse(String(init.body))
        return response({ data: { id: 'notification-1', status: 'queued', recipient: { speakerId: 'speaker-1', userId: 'user-1', name: 'Priya Raman', email: 'priya@example.test' }, subject: input.subject, body: input.body, queuedAt: '2026-08-11T13:05:00Z' }, requestId: 'queued' }, 201)
      }
      return fallback(request, init)
    })
    renderAt('/admin/abstracts')
    const previewTrigger = await screen.findByRole('button', { name: 'Preview decision email' })
    expect(screen.getByRole('button', { name: 'Assign reviewer' })).toBeInTheDocument()
    fireEvent.click(previewTrigger)

    let dialog = await screen.findByRole('dialog', { name: 'Review decision email' })
    expect(within(dialog).getByText('Priya Raman · priya@example.test')).toBeInTheDocument()
    expect(defaultFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    // The dialog moves focus in an effect, which findByRole does not wait for;
    // bare assertions here fail under CI load. Matches the waitFor pattern
    // already used for focus elsewhere in this file.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close email preview' })).toHaveFocus())
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(within(dialog).getByRole('button', { name: 'Save to outbox' })).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Review decision email' })).not.toBeInTheDocument()
    expect(previewTrigger).toHaveFocus()
    fireEvent.click(previewTrigger)
    dialog = await screen.findByRole('dialog', { name: 'Review decision email' })
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Updated proposal decision' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save to outbox' }))

    expect(await screen.findByText('Notification saved to outbox; waiting for provider dispatch.')).toBeInTheDocument()
    expect(screen.queryByText('Provider accepted the notification; delivery is unverified.')).not.toBeInTheDocument()
    expect(defaultFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/notification') && init?.method === 'POST')).toHaveLength(1)
  })

  it.each([
    ['queued', 'Notification saved to outbox; waiting for provider dispatch.', 'Saved to outbox; waiting for provider dispatch.'],
    ['provider_accepted', 'Provider accepted the notification; delivery is unverified.', 'Provider accepted; delivery is unverified.'],
    ['failed', 'Provider dispatch failed.', 'Provider dispatch failed.'],
  ] as const)('describes %s as notification outbox state', async (status, panelLabel, ledgerLabel) => {
    const notification = {
      id: `notification-${status}`,
      recipient: { speakerId: 'speaker-1', userId: 'user-1', name: 'Priya Raman', email: 'priya@example.test' },
      subject: 'Proposal update',
      body: 'Thank you for submitting.',
      queuedAt: '2026-08-11T13:05:00Z',
      status,
      ...(status === 'provider_accepted' ? { providerAcceptedAt: '2026-08-11T13:06:00Z' } : {}),
      ...(status === 'failed' ? { failureMessage: 'Provider delivery attempt failed.' } : {}),
    }
    const item = { proposal: { id: 'proposal-review', publicId: reviewProposal.publicId, slug: 'taming-ci', title: reviewProposal.title }, decision: { id: `decision-${status}`, value: 'reject', rationale: 'Not a fit this year.', decidedBy: { userId: 'organizer-1', displayName: 'Jordan Lee' }, decidedAt: '2026-08-11T13:00:00Z' }, handoff: { status: 'not_applicable' }, notification }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/decisions') && (!init?.method || init.method === 'GET')) return response({ data: { event: ownerWorkspace.event, decisions: [item] }, requestId: 'decision-list' })
      return fallback(request, init)
    })

    renderAt('/admin/abstracts')
    await openTaskTab('Decisions')

    expect((await screen.findAllByText(ledgerLabel)).length).toBeGreaterThan(0)
    if (panelLabel !== ledgerLabel) expect(screen.queryByText(panelLabel)).not.toBeInTheDocument()
    expect(screen.queryByText(/Decision email (?:queued|sent|delivery failed)/i)).not.toBeInTheDocument()
  })

  it.each([
    ['UNAUTHENTICATED', 401, 'Sign in to continue.'],
    ['FORBIDDEN', 403, 'This account cannot open this workspace.'],
  ])('preserves the %s speaker workspace boundary', async (code, status, heading) => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) return response({ error: { code, message: code === 'FORBIDDEN' ? 'Owner scope denied.' : 'Session expired.', requestId: 'speaker-boundary' } }, status)
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument()
    if (code === 'FORBIDDEN') expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('removes speaker private UI when proposal continuity loses the shared session', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let rejectProposals!: (response: Response) => void
    const proposals = new Promise<Response>((resolve) => { rejectProposals = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/workspace')) return proposals
      return fallback(request, init)
    })
    renderAt('/speaker-portal')
    await screen.findByRole('heading', { name: 'Your speaker desk' })

    rejectProposals(response({ error: { code: 'UNAUTHENTICATED', message: 'Your session expired.', requestId: 'ancillary-speaker' } }, 401))

    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Your session expired. Sign in again to continue.')
    expect(screen.queryByRole('heading', { name: 'Your speaker desk' })).not.toBeInTheDocument()
    expect(screen.queryByText(contentSpeaker.contactEmail)).not.toBeInTheDocument()
  })

  it('opens the speaker workspace after signing in from an expired session', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'expired-session' } }, 401)
      if (path === '/api/auth/login' && init?.method === 'POST') return response({ data: speakerSession, requestId: 'speaker-login' })
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    await screen.findByRole('heading', { name: 'Sign in to continue.' })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'speaker@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'speaker-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Your speaker desk' })).toBeInTheDocument()
    expect(screen.getByText('Accepted')).toBeInTheDocument()
  })

  it('returns to speaker sign-in when the workspace session expires after login', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', requestId: 'speaker-signin' } }, 401)
      if (path === '/api/auth/login' && init?.method === 'POST') return response({ data: speakerSession, requestId: 'speaker-login' })
      if (path.endsWith('/speaker/content-workspace')) return response({ error: { code: 'UNAUTHENTICATED', message: 'Your session expired.', requestId: 'expired-workspace' } }, 401)
      if (path.endsWith('/speaker/workspace')) return response({ data: ownerWorkspace, requestId: 'owner-workspace' })
      throw new Error(`Unexpected protected request: ${init?.method ?? 'GET'} ${path}`)
    }))
    renderAt('/speaker-portal')

    await screen.findByRole('heading', { name: 'Sign in to continue.' })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'speaker@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'speaker-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/events/devflow-conf-2027/speaker/content-workspace', expect.anything()))
    expect(await screen.findByRole('heading', { name: 'Sign in to continue.' })).toBeInTheDocument()
  })

  it('keeps an edited speaker profile after a revision conflict and sends the shared revision', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/profile') && init?.method === 'PATCH') return response({ error: { code: 'REVISION_CONFLICT', message: 'The profile changed in another window.', requestId: 'profile-conflict' } }, 409)
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const name = await screen.findByLabelText('Name')
    expect(screen.getByText('Profile and private details')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'Sam Retained' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(name).toHaveValue('Sam Retained')
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speaker/profile') && init?.method === 'PATCH')
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body).toMatchObject({ name: 'Sam Retained', revision: 2 })
    expect(body).not.toHaveProperty('publicVisibility')
    expect(screen.queryByLabelText('Public visibility')).not.toBeInTheDocument()
    expect(screen.getByText('Optional — initials appear until you upload one')).toBeInTheDocument()
  })

  it('preserves a speaker profile draft across a headshot revision and saves the rebased fields', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'speaker.png', contentType: 'image/png', byteSize: 128,
      sha256: 'c'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 3,
      viewPath: '/api/events/devflow-conf-2027/speaker/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=cccccccccccc',
    } as const
    let canonical: SpeakerProfileResponse = { ...contentSpeaker }
    let workspaceRequests = 0
    let finishWorkspaceRefresh!: (value: Response) => void
    const pendingWorkspaceRefresh = new Promise<Response>((resolve) => { finishWorkspaceRefresh = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) {
        workspaceRequests += 1
        if (workspaceRequests === 1) return response({ data: { ...speakerContentWorkspace, speaker: canonical }, requestId: 'profile-initial' })
        if (workspaceRequests === 2) return pendingWorkspaceRefresh
        return response({ data: { ...speakerContentWorkspace, speaker: canonical }, requestId: 'profile-refresh' })
      }
      if (path.endsWith('/speaker/headshot') && init?.method === 'POST') {
        canonical = { ...canonical, headshot, revision: 3, updatedAt: '2026-08-13T12:00:00Z' }
        return response({ data: canonical, requestId: 'headshot-upload' })
      }
      if (path.endsWith('/speaker/profile') && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body))
        canonical = { ...canonical, ...input, revision: input.revision + 1, updatedAt: '2026-08-13T12:01:00Z' }
        return response({ data: canonical, requestId: 'profile-save' })
      }
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const bio = await screen.findByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'Draft biography survives the image upload.' } })
    fireEvent.change(screen.getByLabelText('LinkedIn'), { target: { value: 'https://www.linkedin.com/in/sam-speaker' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'speaker.png', { type: 'image/png' })] } })

    expect(await screen.findByText('Headshot uploaded. Any unsaved profile edits remain in the form; save them separately.')).toBeInTheDocument()
    await waitFor(() => expect(workspaceRequests).toBe(2))
    expect(bio).toHaveValue('Draft biography survives the image upload.')
    expect(screen.queryByText('Loading your profile, tasks, and files…')).not.toBeInTheDocument()
    finishWorkspaceRefresh(response({ data: { ...speakerContentWorkspace, speaker: canonical }, requestId: 'profile-refresh' }))
    await waitFor(() => expect(screen.getByLabelText('Biography')).toHaveValue('Draft biography survives the image upload.'))
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/speaker/profile') && init?.method === 'PATCH')).toBe(true))
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speaker/profile') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      bio: 'Draft biography survives the image upload.',
      socialUrls: { linkedin: 'https://www.linkedin.com/in/sam-speaker' },
      revision: 3,
    })
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument()
    expect(bio).toHaveValue('Draft biography survives the image upload.')
  })

  it('does not rebase a dirty speaker draft over profile text changed before a headshot upload', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'speaker.png', contentType: 'image/png', byteSize: 128,
      sha256: 'e'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 4,
      viewPath: '/api/events/devflow-conf-2027/speaker/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=eeeeeeeeeeee',
    } as const
    let canonical: SpeakerProfileResponse = { ...contentSpeaker }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) return response({ data: { ...speakerContentWorkspace, speaker: canonical }, requestId: 'profile-workspace' })
      if (path.endsWith('/speaker/headshot') && init?.method === 'POST') {
        canonical = { ...canonical, title: 'Organizer corrected title', headshot, revision: 4, updatedAt: '2026-08-13T12:00:00Z' }
        return response({ data: canonical, requestId: 'headshot-upload' })
      }
      if (path.endsWith('/speaker/profile') && init?.method === 'PATCH') return response({ error: { code: 'REVISION_CONFLICT', message: 'The profile changed in another window.', requestId: 'profile-conflict' } }, 409)
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const bio = await screen.findByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'Speaker draft that must not overwrite the organizer.' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'speaker.png', { type: 'image/png' })] } })
    await screen.findByText(/Headshot uploaded/)
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The profile changed in another window.')
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speaker/profile') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      bio: 'Speaker draft that must not overwrite the organizer.',
      title: contentSpeaker.title,
      revision: contentSpeaker.revision,
    })
  })

  it('does not rebase a dirty speaker draft when a sibling refresh lands during headshot upload', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'speaker.png', contentType: 'image/png', byteSize: 128,
      sha256: '4'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 4,
      viewPath: '/api/events/devflow-conf-2027/speaker/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=444444444444',
    } as const
    let canonical: SpeakerProfileResponse = { ...contentSpeaker }
    let workspaceRequests = 0
    let finishHeadshot!: (value: Response) => void
    const pendingHeadshot = new Promise<Response>((resolve) => { finishHeadshot = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) {
        workspaceRequests += 1
        return response({ data: { ...speakerContentWorkspace, speaker: canonical }, requestId: 'profile-workspace' })
      }
      if (path.endsWith('/speaker/headshot') && init?.method === 'POST') return pendingHeadshot
      if (path.includes('/speaker/tasks/') && init?.method === 'PATCH') {
        canonical = { ...canonical, title: 'Organizer changed title during upload', revision: 3 }
        return response({ data: { ...contentTask, state: 'complete', revision: contentTask.revision + 1 }, requestId: 'task-save' })
      }
      if (path.endsWith('/speaker/profile') && init?.method === 'PATCH') return response({ error: { code: 'REVISION_CONFLICT', message: 'The profile changed in another window.', requestId: 'profile-conflict' } }, 409)
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const bio = await screen.findByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'Draft predating the sibling refresh.' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'speaker.png', { type: 'image/png' })] } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Reopen' })[0])
    await waitFor(() => expect(workspaceRequests).toBeGreaterThanOrEqual(2))
    canonical = { ...canonical, headshot, revision: 4 }
    finishHeadshot(response({ data: canonical, requestId: 'headshot-upload' }))
    await screen.findByText(/Headshot uploaded/)
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The profile changed in another window.')
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speaker/profile') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ bio: 'Draft predating the sibling refresh.', revision: contentSpeaker.revision })
  })

  it('keeps a dirty speaker draft mounted when the refresh after a headshot fails', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'speaker.png', contentType: 'image/png', byteSize: 128,
      sha256: 'f'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 3,
      viewPath: '/api/events/devflow-conf-2027/speaker/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=ffffffffffff',
    } as const
    let workspaceRequests = 0
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) {
        workspaceRequests += 1
        if (workspaceRequests === 1) return response({ data: speakerContentWorkspace, requestId: 'profile-initial' })
        return response({ error: { code: 'TEMPORARY_FAILURE', message: 'Workspace refresh failed.', requestId: 'profile-refresh' } }, 503)
      }
      if (path.endsWith('/speaker/headshot') && init?.method === 'POST') return response({ data: { ...contentSpeaker, headshot, revision: 3 }, requestId: 'headshot-upload' })
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const bio = await screen.findByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'Draft survives the failed refresh.' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'speaker.png', { type: 'image/png' })] } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace refresh failed.')
    expect(screen.getByLabelText('Biography')).toHaveValue('Draft survives the failed refresh.')
  })

  it('does not erase newer speaker edits made while a profile save is pending', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let finishSave!: (value: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/profile') && init?.method === 'PATCH') return pendingSave
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const bio = await screen.findByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'First submitted biography.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    fireEvent.change(bio, { target: { value: 'Newer biography typed during save.' } })
    finishSave(response({ data: { ...contentSpeaker, bio: 'First submitted biography.', revision: 3 }, requestId: 'profile-save' }))

    await screen.findByText('Profile saved.')
    expect(screen.getByLabelText('Biography')).toHaveValue('Newer biography typed during save.')
  })

  it('adopts canonical speaker text returned with a headshot when the draft is clean', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'speaker.png', contentType: 'image/png', byteSize: 128,
      sha256: '3'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 4,
      viewPath: '/api/events/devflow-conf-2027/speaker/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=333333333333',
    } as const
    let canonical: SpeakerProfileResponse = { ...contentSpeaker }
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) return response({ data: { ...speakerContentWorkspace, speaker: canonical }, requestId: 'profile-workspace' })
      if (path.endsWith('/speaker/headshot') && init?.method === 'POST') {
        canonical = { ...canonical, title: 'Canonical title from another editor', headshot, revision: 4 }
        return response({ data: canonical, requestId: 'headshot-upload' })
      }
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    await screen.findByLabelText('Title')
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'speaker.png', { type: 'image/png' })] } })

    await screen.findByText(/profile also changed elsewhere/)
    expect(screen.getByLabelText('Title')).toHaveValue('Canonical title from another editor')
  })

  it('starts a nullable speaker contact email as a safe required form draft', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) return response({ data: { ...speakerContentWorkspace, speaker: { ...contentSpeaker, contactEmail: null } }, requestId: 'nullable-contact' })
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    expect(await screen.findByLabelText(/^Contact email/)).toHaveValue('')
    expect(screen.getByLabelText(/^Contact email/)).toBeRequired()
  })

  it('updates only the signed-in speaker task through the owner-scoped route', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/tasks/task-content') && init?.method === 'PATCH') return response({ data: { ...contentTask, state: 'open', completedAt: null, revision: 3 }, requestId: 'task-update' })
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(defaultFetch).toHaveBeenCalledWith('/api/events/devflow-conf-2027/speaker/tasks/task-content', expect.objectContaining({ method: 'PATCH' })))
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speaker/tasks/task-content') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ state: 'open', revision: 2 })
    expect(screen.queryByText(/other presenter/i)).not.toBeInTheDocument()
  })

  it('refreshes task state in both the speaker ledger and accepted-session handoff', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let completed = false
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/tasks/task-content') && init?.method === 'PATCH') {
        completed = true
        return response({ data: contentTask, requestId: 'task-update' })
      }
      if (path.endsWith('/speaker/content-workspace')) {
        const task = { ...contentTask, state: completed ? 'complete' as const : 'open' as const, completedAt: completed ? contentTask.completedAt : null }
        return response({ data: { ...speakerContentWorkspace, sessions: [{ ...speakerContentWorkspace.sessions[0], tasks: [task] }] }, requestId: 'content-refresh' })
      }
      if (path.endsWith('/speaker/workspace')) {
        const task = { ...ownerWorkspace.proposals[0].acceptedSession!.tasks[0], state: completed ? 'complete' as const : 'open' as const, completedAt: completed ? contentTask.completedAt : null }
        return response({ data: { ...ownerWorkspace, proposals: [{ ...ownerWorkspace.proposals[0], acceptedSession: { ...ownerWorkspace.proposals[0].acceptedSession!, tasks: [task] } }] }, requestId: 'proposal-refresh' })
      }
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    fireEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))

    await waitFor(() => {
      expect(defaultFetch.mock.calls.filter(([path]) => String(path).endsWith('/speaker/content-workspace'))).toHaveLength(2)
      expect(defaultFetch.mock.calls.filter(([path]) => String(path).endsWith('/speaker/workspace'))).toHaveLength(2)
    })
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '1 complete · 1 total' })).toBeInTheDocument()
    const handoff = screen.getByRole('heading', { name: 'An owner-scoped accepted session', level: 3 }).parentElement!
    expect(within(handoff).getByText('complete')).toBeInTheDocument()
    expect(within(handoff).queryByText('open')).not.toBeInTheDocument()
  })

  it('keeps the private speaker workspace visible when proposal continuity cannot refresh', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/workspace')) return response({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Proposal continuity is temporarily unavailable.', requestId: 'proposal-refresh-error' } }, 503)
      return fallback(request, init)
    })

    renderAt('/speaker-portal')

    expect(await screen.findByRole('heading', { name: 'Your speaker desk' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your submissions could not refresh.' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Proposal continuity is temporarily unavailable.')
    expect(screen.getByRole('button', { name: 'Reload current data' })).toBeInTheDocument()
  })

  it('resynchronizes the comment version when canonical data gains its first upload', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let taskUpdated = false
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/content-workspace')) {
        const requests = speakerContentWorkspace.sessions[0].requests.map((request) => ({ ...request, versions: taskUpdated ? [contentVersion] : [] }))
        return response({ data: { ...speakerContentWorkspace, sessions: [{ ...speakerContentWorkspace.sessions[0], requests }] }, requestId: 'version-refresh' })
      }
      if (path.endsWith('/speaker/tasks/task-content') && init?.method === 'PATCH') {
        taskUpdated = true
        return response({ data: { ...contentTask, state: 'open', completedAt: null, revision: 3 }, requestId: 'task-update' })
      }
      if (path.endsWith('/speaker/sessions/session-owned/comments') && init?.method === 'POST') {
        const input = JSON.parse(String(init.body))
        return response({ data: { id: 'comment-new', sessionId: 'session-owned', versionId: input.versionId, author: { kind: 'speaker', name: 'Sam Whitfield', speakerId: 'speaker-owned' }, body: input.body, createdAt: '2026-08-11T13:00:00Z' }, requestId: 'comment-created' }, 201)
      }
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }))
    const version = await screen.findByLabelText('Version')
    expect(version).toHaveValue(contentVersion.id)
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Looks ready after the upload.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))

    await waitFor(() => {
      const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speaker/sessions/session-owned/comments') && init?.method === 'POST')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ versionId: contentVersion.id, body: 'Looks ready after the upload.' })
    })
  })

  it('reuses a deliverable idempotency key after failure and retains the selected file and note', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let attempts = 0
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/deliverables/request-slides/versions') && init?.method === 'POST') {
        attempts += 1
        if (attempts === 1) return response({ error: { code: 'UPLOAD_FAILED', message: 'The private upload could not be stored.', requestId: 'upload-failed' } }, 503)
        return response({ data: { version: { ...contentVersion, id: 'version-slides-2', versionNumber: 2, note: 'Revised diagrams' }, session: { id: 'session-owned', deliverablesStatus: 'ready', approvalStatus: 'pending', revision: 4 } }, requestId: 'upload-retry' }, 201)
      }
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const fileInput = await screen.findByLabelText('File for Final presentation')
    const note = screen.getByLabelText('Version note')
    const file = new File(['slides'], 'revised.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput, { target: { files: [file] } })
    fireEvent.change(note, { target: { value: 'Revised diagrams' } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload new version' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The private upload could not be stored.')
    expect(note).toHaveValue('Revised diagrams')
    expect((fileInput as HTMLInputElement).files?.[0]).toBe(file)
    fireEvent.click(screen.getByRole('button', { name: 'Upload new version' }))
    await waitFor(() => expect(attempts).toBe(2))
    const calls = defaultFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/speaker/deliverables/request-slides/versions') && init?.method === 'POST')
    expect(new Headers(calls[0][1]?.headers).get('idempotency-key')).toBe(new Headers(calls[1][1]?.headers).get('idempotency-key'))
    expect(calls[0][1]?.body).toBeInstanceOf(FormData)
    expect(new Headers(calls[0][1]?.headers).has('content-type')).toBe(false)
  })

  it('clears the native file input after upload so the same file can be selected again', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let attempts = 0
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speaker/deliverables/request-slides/versions') && init?.method === 'POST') {
        attempts += 1
        return response({ data: { version: { ...contentVersion, id: `version-slides-${attempts + 1}`, versionNumber: attempts + 1 }, session: { id: 'session-owned', deliverablesStatus: 'ready', approvalStatus: 'pending', revision: 3 + attempts } }, requestId: `upload-${attempts}` }, 201)
      }
      return fallback(request, init)
    })
    renderAt('/speaker-portal')

    const fileInput = await screen.findByLabelText('File for Final presentation') as HTMLInputElement
    const file = new File(['slides'], 'slides.pdf', { type: 'application/pdf' })
    fireEvent.change(fileInput, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload new version' }))

    await waitFor(() => expect(attempts).toBe(1))
    const nextFileInput = await waitFor(() => {
      const current = screen.getByLabelText('File for Final presentation') as HTMLInputElement
      expect(current).not.toBe(fileInput)
      expect(current.files).toHaveLength(0)
      return current
    })

    fireEvent.change(nextFileInput, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload new version' }))

    await waitFor(() => expect(attempts).toBe(2))
    expect(screen.queryByText('Choose a file to upload.')).not.toBeInTheDocument()
  })

  it('gates organizer speaker data before issuing the protected roster request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const path = requestPath(request)
      if (path === '/api/auth/session') return response({ data: speakerSession, requestId: 'speaker-only' })
      throw new Error(`Protected organizer data must not load: ${path}`)
    }))
    renderAt('/admin/speakers')

    expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('sam@example.test')).not.toBeInTheDocument()
  })

  it('filters the canonical organizer roster and refetches after a revisioned visibility change', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speakers/speaker-owned/visibility') && init?.method === 'PATCH') return response({ data: { ...contentSpeaker, publicVisibility: 'private', revision: 3 }, requestId: 'visibility-update' })
      return fallback(request, init)
    })
    renderAt('/admin/speakers')

    const search = await screen.findByLabelText('Search speakers')
    fireEvent.change(search, { target: { value: 'missing speaker' } })
    expect(screen.getByRole('heading', { name: 'No speakers match' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'Sam' } })
    expect(screen.getByRole('columnheader', { name: 'Session readiness' })).toBeInTheDocument()
    expect(screen.getByText('1 session')).toBeInTheDocument()
    await openTaskTab('Profile & tasks')
    fireEvent.click(screen.getByRole('button', { name: 'Remove profile from published program' }))

    await waitFor(() => expect(defaultFetch.mock.calls.filter(([path]) => String(path).endsWith('/speakers')).length).toBeGreaterThan(1))
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speakers/speaker-owned/visibility') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ publicVisibility: 'private', revision: 2 })
    expect(screen.queryByRole('button', { name: 'Reset demo' })).not.toBeInTheDocument()
  })

  it('explains the session boundary instead of offering a no-op task form', async () => {
    const rosterOnlySpeaker = {
      ...organizerSpeakerRoster.speakers[0],
      profile: { ...contentSpeaker, id: 'speaker-roster-only', name: 'Marcus Roster Only', contactEmail: 'marcus@example.test' },
      sessions: [],
      tasks: [],
      readiness: { ...organizerSpeakerRoster.speakers[0].readiness, requiredTasksReady: true, nextDueAt: null },
    }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(request) === '/api/events/devflow-conf-2027/speakers') return response({ data: { ...organizerSpeakerRoster, speakers: [rosterOnlySpeaker] }, requestId: 'roster-only-speaker' })
      return fallback(request, init)
    })

    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    expect(await screen.findByRole('heading', { name: 'Marcus Roster Only' })).toBeInTheDocument()
    expect(screen.getByText(/Tasks become available after this speaker is linked to an accepted session/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Task label')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add task to sessions' })).not.toBeInTheDocument()
    expect(defaultFetch.mock.calls.some(([request]) => requestPath(request).endsWith('/speakers/tasks'))).toBe(false)
  })

  it('keeps task creation targeted to every linked session', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(request) === '/api/events/devflow-conf-2027/speakers/tasks' && init?.method === 'POST') return response({ data: organizerSpeakerRoster, requestId: 'task-created' }, 201)
      return fallback(request, init)
    })

    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    fireEvent.change(await screen.findByLabelText('Task label'), { target: { value: 'Confirm travel plan' } })
    fireEvent.change(screen.getByLabelText('Due at'), { target: { value: '2027-04-20T12:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add task to sessions' }))

    await waitFor(() => expect(defaultFetch.mock.calls.some(([request]) => requestPath(request).endsWith('/speakers/tasks'))).toBe(true))
    const taskCall = defaultFetch.mock.calls.find(([request]) => requestPath(request).endsWith('/speakers/tasks'))
    expect(JSON.parse(String(taskCall?.[1]?.body))).toMatchObject({
      targets: [{ speakerId: 'speaker-owned', sessionId: 'session-owned' }],
      label: 'Confirm travel plan',
    })
  })

  it('reuses a deterministic task key for the same label and separates different labels', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (requestPath(request) === '/api/events/devflow-conf-2027/speakers/tasks' && init?.method === 'POST') return response({ data: organizerSpeakerRoster, requestId: 'task-created' }, 201)
      return fallback(request, init)
    })

    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')
    const submitTask = async (label: string) => {
      fireEvent.change(await screen.findByLabelText('Task label'), { target: { value: label } })
      fireEvent.change(screen.getByLabelText('Due at'), { target: { value: '2027-04-20T12:30' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add task to sessions' }))
      await waitFor(() => expect(screen.getByLabelText('Task label')).toHaveValue(''))
    }

    await submitTask(' Confirm travel plan ')
    await submitTask('confirm travel plan')
    await submitTask('Upload final slides')

    const taskBodies = defaultFetch.mock.calls
      .filter(([request, init]) => requestPath(request).endsWith('/speakers/tasks') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
    expect(taskBodies).toHaveLength(3)
    expect(taskBodies[0].taskKey).toMatch(/^custom-[a-z0-9-]+$/)
    expect(taskBodies[1].taskKey).toBe(taskBodies[0].taskKey)
    expect(taskBodies[2].taskKey).not.toBe(taskBodies[0].taskKey)
  })

  it('queues a revisioned speaker reminder without claiming delivery', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    expect(await screen.findByRole('heading', { name: 'Queue a deterministic reminder' })).toBeInTheDocument()
    const template = screen.getByLabelText(/^Reminder template/)
    fireEvent.change(template, { target: { value: 'speaker.task-reminder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue reminder' }))

    expect(await screen.findByText('Reminder queued in the immutable outbox. This action did not send it or claim delivery.')).toBeInTheDocument()
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speakers/communications/reminders') && init?.method === 'POST')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      speakerId: 'speaker-owned',
      templateKey: 'speaker.task-reminder',
    })
    expect(JSON.parse(String(call?.[1]?.body)).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('lets an organizer add a deadline to an existing open readiness task', async () => {
    const deadlineTask = { ...contentTask, id: 'task-deadline', state: 'open' as const, dueAt: null, completedAt: null }
    const roster = {
      ...organizerSpeakerRoster,
      speakers: organizerSpeakerRoster.speakers.map((speaker) => ({
        ...speaker,
        tasks: [deadlineTask],
        readiness: { ...speaker.readiness, requiredTasksReady: false, nextDueAt: null },
      })),
    }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: roster, requestId: 'deadline-roster' })
      if (path.endsWith('/speakers/speaker-owned/tasks/task-deadline') && init?.method === 'PATCH') {
        return response({ data: { ...deadlineTask, ...JSON.parse(String(init.body)), revision: 3 }, requestId: 'deadline-save' })
      }
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    expect(await screen.findByRole('heading', { name: 'Task deadlines' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Confirm participation'), { target: { value: '2027-04-01T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set deadline' }))

    expect(await screen.findByText('Deadline saved for Confirm participation.')).toBeInTheDocument()
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speakers/speaker-owned/tasks/task-deadline') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ state: 'open', dueAt: new Date('2027-04-01T10:00').toISOString().replace('.000Z', 'Z'), revision: 2 })
  })

  it('queues only the selected speaker audience and shows truthful provider status', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    renderAt('/admin/speakers')
    await openTaskTab('Messages')

    expect(await screen.findByRole('heading', { name: 'Message selected speakers' })).toBeInTheDocument()
    expect(screen.getByText('Automatic email sending is off')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select Sam Whitfield (sam@example.test) for communication'))
    fireEvent.change(screen.getByLabelText(/^Subject$/), { target: { value: 'Program update' } })
    fireEvent.change(screen.getByLabelText(/^Message$/), { target: { value: 'Please review the program details.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 message' }))

    expect(await screen.findByText('1 message queued. Queued does not mean sent or delivered.')).toBeInTheDocument()
    expect(await screen.findByText('Queued · not yet attempted')).toBeInTheDocument()
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/communications/speakers/bulk') && init?.method === 'POST')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      speakerIds: ['speaker-owned'],
      subject: 'Program update',
      body: 'Please review the program details.',
    })
  })

  it('previews documented merge fields for each selected speaker before queueing', async () => {
    renderAt('/admin/speakers')
    await openTaskTab('Messages')

    await screen.findByRole('heading', { name: 'Message selected speakers' })
    fireEvent.click(screen.getByLabelText('Select Sam Whitfield (sam@example.test) for communication'))
    fireEvent.change(screen.getByLabelText(/^Subject$/), { target: { value: '{first_name}: {session_title}' } })
    fireEvent.change(screen.getByLabelText(/^Message$/), { target: { value: 'Open {portal_link}' } })

    const preview = screen.getByRole('region', { name: 'Per-recipient message preview' })
    expect(within(preview).getByText('Sam Whitfield · Sam: An owner-scoped accepted session')).toBeInTheDocument()
    expect(within(preview).getByText(/Hello Sam Whitfield/)).toBeInTheDocument()
    expect(within(preview).getByText(/\/events\/devflow-conf-2027\/speaker/)).toBeInTheDocument()
    expect(within(preview).getByText(/This message was sent by an organizer through ConfPilot\./)).toBeInTheDocument()
  })

  it('disambiguates same-name speakers and names skipped communication recipients', async () => {
    const first = organizerSpeakerRoster.speakers[0]
    const second = {
      ...first,
      profile: { ...first.profile, id: 'speaker-sam-two', contactEmail: 'sam.two@example.test' },
    }
    const roster = { ...organizerSpeakerRoster, speakers: [first, second] }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: roster, requestId: 'same-name-roster' })
      if (path.endsWith('/communications/speakers/bulk') && init?.method === 'POST') return response({
        data: { requestedCount: 2, queuedCount: 1, messageIds: ['message-sam-one'], skipped: [{ speakerId: 'speaker-sam-two', reason: 'contact_email_missing' }] },
        requestId: 'communication-partial',
      }, 201)
      return fallback(request, init)
    })

    renderAt('/admin/speakers')
    await openTaskTab('Messages')
    expect(await screen.findByLabelText('Select Sam Whitfield (sam@example.test) for communication')).toBeInTheDocument()
    expect(screen.getByLabelText('Select Sam Whitfield (sam.two@example.test) for communication')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select Sam Whitfield (sam@example.test) for communication'))
    fireEvent.click(screen.getByLabelText('Select Sam Whitfield (sam.two@example.test) for communication'))
    expect(screen.getByText(/Sam Whitfield \(sam@example\.test\), Sam Whitfield \(sam\.two@example\.test\)/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Subject$/), { target: { value: 'Program update' } })
    fireEvent.change(screen.getByLabelText(/^Message$/), { target: { value: 'Please review the program details.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Queue 2 messages' }))

    expect(await screen.findByText(/Skipped Sam Whitfield \(sam\.two@example\.test\): contact email missing/)).toBeInTheDocument()
  })

  it('filters by workflow and shows canonical task progress and private headshot metadata', async () => {
    const headshot = {
      originalFilename: 'sam-profile.png', contentType: 'image/png', byteSize: 2048,
      sha256: 'b'.repeat(64), uploadedAt: '2026-08-11T12:05:00Z', revision: 3,
      viewPath: '/api/events/devflow-conf-2027/speakers/speaker-owned/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=bbbbbbbbbbbb',
    } as const
    const invitedSpeaker = {
      ...organizerSpeakerRoster.speakers[0],
      profile: {
        ...contentSpeaker,
        id: 'speaker-invited', name: 'Avery Stone', contactEmail: 'avery@example.test',
        workflowStatus: 'invited' as const, publicVisibility: 'private' as const,
      },
      history: [],
      tasks: [{
        ...contentTask,
        id: 'task-invited', state: 'open' as const, completedAt: null,
        label: 'Complete speaker profile', taskKey: 'profile', revision: 1,
      }],
      readiness: { ...organizerSpeakerRoster.speakers[0].readiness, requiredTasksReady: false },
    }
    const roster = {
      ...organizerSpeakerRoster,
      speakers: [
        {
          ...organizerSpeakerRoster.speakers[0],
          profile: { ...contentSpeaker, headshot, revision: 3 },
          readiness: { ...organizerSpeakerRoster.speakers[0].readiness, headshotReady: true },
        },
        invitedSpeaker,
      ],
    }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: roster, requestId: 'speaker-progress' })
      return fallback(request, init)
    })
    renderAt('/admin/speakers')

    const samRow = await screen.findByRole('row', { name: /Sam Whitfield/ })
    expect(within(samRow).getByText('1 complete · 0 open')).toBeInTheDocument()
    expect(within(samRow).getByText('Confirm participation: complete')).toBeInTheDocument()
    fireEvent.click(within(samRow).getByRole('button', { name: /Open Sam Whitfield/ }))
    const portrait = screen.getByRole('img', { name: 'Sam Whitfield headshot' })
    expect(portrait).toHaveAttribute('src', headshot.viewPath)
    expect(screen.getByText(headshot.originalFilename)).toBeInTheDocument()
    expect(screen.getByText(headshot.originalFilename).closest('div')?.querySelector('time'))
      .toHaveAttribute('dateTime', headshot.uploadedAt)

    await openTaskTab('Readiness')
    fireEvent.change(screen.getByLabelText('Workflow status'), { target: { value: 'invited' } })
    expect(screen.queryByRole('row', { name: /Sam Whitfield/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /Avery Stone/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open Avery Stone/ }))
    expect(screen.getByRole('heading', { name: 'Avery Stone' })).toBeInTheDocument()
  })

  it('shows the active speaker-readiness filter and exact canonical speaker IDs', async () => {
    const attentionSpeaker = organizerSpeakerRoster.speakers[0]
    const readySpeaker = {
      ...attentionSpeaker,
      profile: { ...attentionSpeaker.profile, id: 'speaker-ready', name: 'Ready Speaker', contactEmail: 'ready@example.test' },
      readiness: { profileReady: true, agreementReady: true, headshotReady: true, requiredTasksReady: true, deliverablesReady: true, nextDueAt: null },
    }
    const outstandingSpeaker = {
      ...attentionSpeaker,
      profile: { ...attentionSpeaker.profile, id: 'speaker-outstanding', name: 'Outstanding Speaker', contactEmail: 'outstanding@example.test' },
      readiness: { profileReady: true, agreementReady: true, headshotReady: true, requiredTasksReady: false, deliverablesReady: false, nextDueAt: '2026-08-20T20:00:00Z' },
    }
    const roster = { ...organizerSpeakerRoster, speakers: [attentionSpeaker, readySpeaker, outstandingSpeaker] }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speakers') && (!init?.method || init.method === 'GET')) return response({ data: roster, requestId: 'filter-roster' })
      return fallback(request, init)
    })
    const visibleSpeakerIds = () => Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr[data-speaker-id]')).map((row) => row.dataset.speakerId)
    renderAt('/admin/speakers')

    await screen.findByLabelText('Speaker readiness')
    expect(visibleSpeakerIds()).toEqual(['speaker-owned', 'speaker-ready', 'speaker-outstanding'])
    expect(screen.getByRole('status', { name: 'Active readiness filter' })).toHaveTextContent('All speakers · 3 of 3')
    await openTaskTab('Messages')
    fireEvent.click(screen.getByLabelText('Select Sam Whitfield (sam@example.test) for communication'))

    await openTaskTab('Readiness')
    const filter = screen.getByLabelText('Speaker readiness')
    fireEvent.change(filter, { target: { value: 'attention' } })
    expect(filter).toHaveValue('attention')
    expect(visibleSpeakerIds()).toEqual(['speaker-owned', 'speaker-outstanding'])
    expect(screen.getByRole('status', { name: 'Active readiness filter' })).toHaveTextContent('Needs attention · 2 of 3')
    fireEvent.click(screen.getByRole('button', { name: /Outstanding Speaker/ }))
    expect(screen.getByRole('heading', { name: 'Outstanding Speaker' })).toBeInTheDocument()

    await openTaskTab('Readiness')
    const readinessFilter = screen.getByLabelText('Speaker readiness')
    fireEvent.change(readinessFilter, { target: { value: 'ready' } })
    expect(visibleSpeakerIds()).toEqual(['speaker-ready'])
    expect(screen.getByRole('status', { name: 'Active readiness filter' })).toHaveTextContent('Ready · 1 of 3')
    expect(screen.getByRole('row', { name: /Ready Speaker/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /Outstanding Speaker/ })).not.toBeInTheDocument()
    await openTaskTab('Messages')
    fireEvent.click(screen.getByLabelText('Select Ready Speaker (ready@example.test) for communication'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear visible selection' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByText('Sam Whitfield (sam@example.test)', { selector: '.communication-selection-actions span' })).toBeInTheDocument()
  })

  it('labels roster intake as unclaimed and renders normalized row outcomes honestly', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof request === 'string' ? request : request instanceof URL ? request.pathname : new URL(request.url).pathname
      if (path === '/api/events/devflow-conf-2027/speakers' && init?.method === 'POST') {
        return response({ data: {
          summary: { created: 1, duplicate: 0, invalid: 0, conflict: 0, failed: 0 },
          rows: [{ rowNumber: 1, status: 'created', code: 'CREATED', message: 'Speaker created as an unclaimed event profile.', normalizedEmail: 'avery@example.test', speakerId: 'speaker-avery', linkedAccount: false }],
        }, requestId: 'manual-speaker' })
      }
      if (path === '/api/events/devflow-conf-2027/speakers/import' && init?.method === 'POST') {
        return response({ data: {
          summary: { created: 1, duplicate: 1, invalid: 1, conflict: 1, failed: 0 },
          rows: [
            { rowNumber: 2, status: 'created', code: 'CREATED', message: 'Speaker created as an unclaimed event profile.', normalizedEmail: 'new@example.test', speakerId: 'speaker-new', linkedAccount: false },
            { rowNumber: 3, status: 'duplicate', code: 'DUPLICATE_EMAIL', message: 'A speaker with this email already exists for the event.', normalizedEmail: 'sam@example.test', speakerId: 'speaker-owned', linkedAccount: true },
            { rowNumber: 4, status: 'invalid', code: 'VALIDATION_FAILED', message: 'email: Invalid email address', normalizedEmail: null, speakerId: null, linkedAccount: false },
            { rowNumber: 5, status: 'conflict', code: 'ACCOUNT_ROLE_CONFLICT', message: 'An account already uses this email. No speaker profile was created because roster import cannot verify account ownership.', normalizedEmail: 'reviewer@example.test', speakerId: null, linkedAccount: false },
          ],
        }, requestId: 'csv-speakers' })
      }
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Add / import')

    const intake = (await screen.findByRole('heading', { name: 'Add speakers' })).closest('section')!
    expect(within(intake).getByText(/Manual and CSV intake create unclaimed event profiles/)).toBeInTheDocument()
    expect(within(intake).getByText(/No invitation or email is sent, and these profiles cannot sign in/)).toBeInTheDocument()
    fireEvent.change(within(intake).getByLabelText('Name'), { target: { value: 'Avery Stone' } })
    fireEvent.change(within(intake).getByLabelText('Email'), { target: { value: 'AVERY@example.test' } })
    fireEvent.click(within(intake).getByRole('button', { name: 'Add speaker' }))
    const submittedIntake = screen.getByRole('heading', { name: 'Add speakers' }).closest('section')!
    expect(await within(submittedIntake).findByText('1 created · 0 duplicate · 0 invalid · 0 role conflict · 0 failed')).toBeInTheDocument()
    expect(within(submittedIntake).getByText(/Row 1 · avery@example\.test: Speaker created as an unclaimed event profile\./)).toBeInTheDocument()

    await waitFor(() => expect(screen.getByLabelText('Import CSV')).toBeEnabled())
    const refreshedIntake = screen.getByRole('heading', { name: 'Add speakers' }).closest('section')!
    const csvInput = within(refreshedIntake).getByLabelText('Import CSV')
    Object.defineProperty(csvInput, 'value', { configurable: true, writable: true, value: 'C:\\fakepath\\speakers.csv' })
    fireEvent.change(csvInput, { target: { files: [new File(['name,email\nNew,new@example.test'], 'speakers.csv', { type: 'text/csv' })] } })
    expect(await within(refreshedIntake).findByText('1 created · 1 duplicate · 1 invalid · 1 role conflict · 0 failed')).toBeInTheDocument()
    await waitFor(() => expect(csvInput).toHaveValue(''))
    expect(within(refreshedIntake).getByText('Row 4: email: Invalid email address')).toBeInTheDocument()
    expect(within(refreshedIntake).getByText(/Row 5 · reviewer@example\.test: An account already uses this email/)).toBeInTheDocument()
  })

  it('shows headshot upload history as audit-only instead of offering an invalid restore', async () => {
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    expect(await screen.findByText('Audit only')).toBeInTheDocument()
    expect(screen.getByText('headshot uploaded')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
  })

  it('lets an organizer edit the canonical speaker profile with optimistic revision safety', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    const profileForm = (await screen.findByRole('button', { name: 'Save speaker profile' })).closest('form')!
    const name = within(profileForm).getByLabelText('Name')
    fireEvent.change(name, { target: { value: 'Sam Organizer Edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save speaker profile' }))

    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH')).toBe(true))
    const matchingCalls = defaultFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH')
    const call = matchingCalls[matchingCalls.length - 1]
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ name: 'Sam Organizer Edit', contactEmail: 'sam@example.test', revision: 2 })
  })

  it('preserves an organizer profile draft across a headshot revision before saving', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'organizer.png', contentType: 'image/png', byteSize: 256,
      sha256: 'd'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 3,
      viewPath: '/api/events/devflow-conf-2027/speakers/speaker-owned/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=dddddddddddd',
    } as const
    let canonical: SpeakerProfileResponse = { ...contentSpeaker }
    const roster = () => ({
      ...organizerSpeakerRoster,
      speakers: organizerSpeakerRoster.speakers.map((item) => ({ ...item, profile: canonical })),
    })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: roster(), requestId: 'roster-refresh' })
      if (path.endsWith('/speakers/speaker-owned/headshot') && init?.method === 'POST') {
        canonical = { ...canonical, headshot, revision: 3, updatedAt: '2026-08-13T12:00:00Z' }
        return response({ data: canonical, requestId: 'headshot-upload' })
      }
      if (path.endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body))
        canonical = { ...canonical, ...input, revision: input.revision + 1, updatedAt: '2026-08-13T12:01:00Z' }
        return response({ data: canonical, requestId: 'profile-save' })
      }
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    const profileForm = (await screen.findByRole('button', { name: 'Save speaker profile' })).closest('form')!
    const bio = within(profileForm).getByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'Organizer draft survives the image upload.' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'organizer.png', { type: 'image/png' })] } })

    expect(await screen.findByText('Saved canonical status. Any unsaved profile edits remain in the form; save them separately.')).toBeInTheDocument()
    expect(bio).toHaveValue('Organizer draft survives the image upload.')
    fireEvent.click(screen.getByRole('button', { name: 'Save speaker profile' }))

    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH')).toBe(true))
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ bio: 'Organizer draft survives the image upload.', revision: 3 })
    expect(await screen.findByText('Profile saved. Reloading canonical readiness…')).toBeInTheDocument()
    expect(bio).toHaveValue('Organizer draft survives the image upload.')
  })

  it('does not rebase a dirty organizer draft over profile text changed before a headshot upload', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'organizer.png', contentType: 'image/png', byteSize: 256,
      sha256: '1'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 4,
      viewPath: '/api/events/devflow-conf-2027/speakers/speaker-owned/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=111111111111',
    } as const
    let canonical: SpeakerProfileResponse = { ...contentSpeaker }
    const roster = () => ({
      ...organizerSpeakerRoster,
      speakers: organizerSpeakerRoster.speakers.map((item) => ({ ...item, profile: canonical })),
    })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: roster(), requestId: 'roster-refresh' })
      if (path.endsWith('/speakers/speaker-owned/headshot') && init?.method === 'POST') {
        canonical = { ...canonical, title: 'Speaker corrected title', headshot, revision: 4, updatedAt: '2026-08-13T12:00:00Z' }
        return response({ data: canonical, requestId: 'headshot-upload' })
      }
      if (path.endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH') return response({ error: { code: 'REVISION_CONFLICT', message: 'The profile changed in another window.', requestId: 'profile-conflict' } }, 409)
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    const profileForm = (await screen.findByRole('button', { name: 'Save speaker profile' })).closest('form')!
    fireEvent.change(within(profileForm).getByLabelText('Biography'), { target: { value: 'Organizer draft that must not overwrite the speaker.' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'organizer.png', { type: 'image/png' })] } })
    await screen.findByText(/profile also changed elsewhere/)
    fireEvent.click(screen.getByRole('button', { name: 'Save speaker profile' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The profile changed in another window.')
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      bio: 'Organizer draft that must not overwrite the speaker.',
      title: contentSpeaker.title,
      revision: contentSpeaker.revision,
    })
  })

  it('keeps a dirty organizer draft mounted when the roster refresh after a headshot fails', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const headshot = {
      originalFilename: 'organizer.png', contentType: 'image/png', byteSize: 256,
      sha256: '2'.repeat(64), uploadedAt: '2026-08-13T12:00:00Z', revision: 3,
      viewPath: '/api/events/devflow-conf-2027/speakers/speaker-owned/headshot/file',
      publicUrl: '/api/public/events/devflow-conf-2027/speakers/sam-whitfield/headshot?v=222222222222',
    } as const
    let rosterRequests = 0
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') {
        rosterRequests += 1
        if (rosterRequests === 1) return response({ data: organizerSpeakerRoster, requestId: 'roster-initial' })
        return response({ error: { code: 'TEMPORARY_FAILURE', message: 'Roster refresh failed.', requestId: 'roster-refresh' } }, 503)
      }
      if (path.endsWith('/speakers/speaker-owned/headshot') && init?.method === 'POST') return response({ data: { ...contentSpeaker, headshot, revision: 3 }, requestId: 'headshot-upload' })
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    const profileForm = (await screen.findByRole('button', { name: 'Save speaker profile' })).closest('form')!
    fireEvent.change(within(profileForm).getByLabelText('Biography'), { target: { value: 'Organizer draft survives the failed refresh.' } })
    fireEvent.change(screen.getByLabelText('Upload headshot'), { target: { files: [new File(['image'], 'organizer.png', { type: 'image/png' })] } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Roster refresh failed.')
    expect(within(profileForm).getByLabelText('Biography')).toHaveValue('Organizer draft survives the failed refresh.')
  })

  it('preserves an organizer draft through visibility and workflow revisions', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let canonical: SpeakerProfileResponse = { ...contentSpeaker, publicVisibility: 'private' }
    const roster = () => ({
      ...organizerSpeakerRoster,
      speakers: organizerSpeakerRoster.speakers.map((item) => ({ ...item, profile: canonical })),
    })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/speakers') return response({ data: roster(), requestId: 'roster-refresh' })
      if (path.endsWith('/speakers/speaker-owned/visibility') && init?.method === 'PATCH') {
        canonical = { ...canonical, publicVisibility: 'published', revision: 3 }
        return response({ data: canonical, requestId: 'visibility-save' })
      }
      if (path.endsWith('/speakers/speaker-owned/workflow') && init?.method === 'PATCH') {
        canonical = { ...canonical, workflowStatus: 'confirmed', revision: 4 }
        return response({ data: canonical, requestId: 'workflow-save' })
      }
      if (path.endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body))
        canonical = { ...canonical, ...input, revision: 5 }
        return response({ data: canonical, requestId: 'profile-save' })
      }
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    const profileForm = (await screen.findByRole('button', { name: 'Save speaker profile' })).closest('form')!
    const bio = within(profileForm).getByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'Draft survives canonical metadata updates.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow profile in published program' }))
    await screen.findByRole('button', { name: 'Remove profile from published program' })
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'confirmed' } })
    await waitFor(() => expect(screen.getByLabelText('Workflow')).toHaveValue('confirmed'))
    expect(bio).toHaveValue('Draft survives canonical metadata updates.')
    fireEvent.click(screen.getByRole('button', { name: 'Save speaker profile' }))

    await screen.findByText('Profile saved. Reloading canonical readiness…')
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ bio: 'Draft survives canonical metadata updates.', publicVisibility: 'published', revision: 4 })
  })

  it('does not erase newer organizer edits made while a profile save is pending', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let finishSave!: (value: Response) => void
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve })
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path.endsWith('/speakers/speaker-owned/profile') && init?.method === 'PATCH') return pendingSave
      return fallback(request, init)
    })
    renderAt('/admin/speakers')
    await openTaskTab('Profile & tasks')

    const profileForm = (await screen.findByRole('button', { name: 'Save speaker profile' })).closest('form')!
    const bio = within(profileForm).getByLabelText('Biography')
    fireEvent.change(bio, { target: { value: 'First organizer biography.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save speaker profile' }))
    fireEvent.change(bio, { target: { value: 'Newer organizer biography typed during save.' } })
    finishSave(response({ data: { ...contentSpeaker, bio: 'First organizer biography.', revision: 3 }, requestId: 'profile-save' }))

    await screen.findByText('Profile saved. Reloading canonical readiness…')
    expect(within(profileForm).getByLabelText('Biography')).toHaveValue('Newer organizer biography typed during save.')
  })

  it('shows exact approval gates, prevents premature approval, and retains failed session edits', async () => {
    const blockedContent = { ...organizerContent, sessions: organizerContent.sessions.map((session) => ({ ...session, approvalStatus: 'pending' as const, revision: 4, unmetApprovalGates: ['Confirm participation, complete the profile, and sign for every presenter.', 'Latest required deliverable is not approved'] })) }
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/content' && (!init?.method || init.method === 'GET')) return response({ data: blockedContent, requestId: 'blocked-content' })
      if (path === '/api/events/devflow-conf-2027/content/session-owned' && init?.method === 'PATCH') return response({ error: { code: 'REVISION_CONFLICT', message: 'The session changed in another window.', requestId: 'session-conflict' } }, 409)
      return fallback(request, init)
    })
    renderAt('/admin/content')

    expect(await screen.findByText('Confirm participation, complete each profile, and complete or waive each release task.')).toBeInTheDocument()
    expect(screen.queryByText('Confirm participation, complete the profile, and sign for every presenter.')).not.toBeInTheDocument()
    expect(screen.getByText('Latest required deliverable is not approved')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: 'Approve content' })
    expect(approve).toBeDisabled()
    expect(approve).toHaveAttribute('title', 'Confirm participation, complete each profile, and complete or waive each release task; Latest required deliverable is not approved')
    const title = screen.getByLabelText('Title')
    fireEvent.change(title, { target: { value: 'Retained session title' } })
    fireEvent.change(screen.getByLabelText('Change note'), { target: { value: 'Clarified attendee outcome.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save session revision' }))

    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(title).toHaveValue('Retained session title')
    expect(defaultFetch.mock.calls.some(([path]) => String(path).endsWith('/approval'))).toBe(false)
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/content/session-owned') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ title: 'Retained session title', expectedRevision: 4 })
  })

  it('labels pre-change snapshots and restores the selected snapshot without losing the first edit', async () => {
    const currentSession = {
      ...organizerContent.sessions[0],
      title: 'UPDATED: An owner-scoped accepted session',
      abstract: 'A concrete accepted-session abstract. This session now includes a live demo. Attendees should bring a laptop.',
      revision: 5,
      history: [
        {
          id: 'history-before-first', sessionId: 'session-owned', action: 'updated' as const,
          title: 'An owner-scoped accepted session', abstract: 'A concrete accepted-session abstract.', track: 'Platform & Infra', format: 'talk' as const, durationMinutes: 30,
          changeNote: 'Added the live demo.', actorName: 'Jordan Alvarez', createdAt: '2026-08-11T12:20:00Z',
        },
        {
          id: 'history-before-second', sessionId: 'session-owned', action: 'updated' as const,
          title: 'UPDATED: An owner-scoped accepted session', abstract: 'A concrete accepted-session abstract. This session now includes a live demo.', track: 'Platform & Infra', format: 'talk' as const, durationMinutes: 30,
          changeNote: 'Added attendee preparation.', actorName: 'Jordan Alvarez', createdAt: '2026-08-11T12:30:00Z',
        },
      ],
    }
    let restored = false
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    const fallback = defaultFetch.getMockImplementation() as (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    defaultFetch.mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(request)
      if (path === '/api/events/devflow-conf-2027/content' && (!init?.method || init.method === 'GET')) {
        const session = restored ? { ...currentSession, title: currentSession.history[1].title, abstract: currentSession.history[1].abstract, revision: 6 } : currentSession
        return response({ data: { ...organizerContent, sessions: [session] }, requestId: 'restore-content' })
      }
      if (path === '/api/events/devflow-conf-2027/content/session-owned/history/history-before-second/restore' && init?.method === 'POST') {
        restored = true
        return response({ data: currentSession.history[1], requestId: 'restore-selected-snapshot' })
      }
      return fallback(request, init)
    })
    renderAt('/admin/content')
    await openTaskTab('History')

    expect(await screen.findByText(/Each entry shows the content saved before that change/)).toBeInTheDocument()
    const targetSnapshot = screen.getByText('A concrete accepted-session abstract. This session now includes a live demo.').closest('article')
    expect(targetSnapshot).not.toBeNull()
    expect(within(targetSnapshot!).getByText('Before an edit')).toBeInTheDocument()
    fireEvent.click(within(targetSnapshot!).getByRole('button', { name: 'Restore this version' }))

    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/history/history-before-second/restore') && init?.method === 'POST')).toBe(true))
    await openTaskTab('Needs approval')
    await waitFor(() => expect(screen.getByLabelText('Abstract')).toHaveValue('A concrete accepted-session abstract. This session now includes a live demo.'))
    expect(screen.getByLabelText('Title')).toHaveValue('UPDATED: An owner-scoped accepted session')
    expect((screen.getByLabelText('Abstract') as HTMLTextAreaElement).value).not.toContain('Attendees should bring a laptop.')
  })

  it('keeps session deliverables presentation-only and routes headshots through speaker profiles', async () => {
    renderAt('/admin/content')
    await openTaskTab('Current files')

    const form = (await screen.findByText('New presentation deliverable')).closest('form')
    expect(form).not.toBeNull()
    expect(within(form!).queryByRole('option', { name: 'Headshot' })).not.toBeInTheDocument()
    expect(within(form!).getByText('Speaker headshots are managed per speaker in the profile workspace.')).toBeInTheDocument()
  })

  it('submits the visible local due date as a contract timestamp', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    renderAt('/admin/content')
    await openTaskTab('Current files')

    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Conference slides' } })
    fireEvent.change(screen.getByLabelText('Due at'), { target: { value: '2027-05-01T12:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create request' }))

    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/content/session-owned/requests') && init?.method === 'POST')).toBe(true))
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/content/session-owned/requests') && init?.method === 'POST')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ label: 'Conference slides', requestType: 'presentation' })
    expect(JSON.parse(String(call?.[1]?.body)).dueAt).toMatch(/^2027-05-01T\d{2}:00:00Z$/)
  })

  it('sends the explicit approval transition with the current session revision', async () => {
    const defaultFetch = fetch as ReturnType<typeof vi.fn>
    renderAt('/admin/content')

    fireEvent.click(await screen.findByRole('button', { name: 'Move approval to pending' }))
    await waitFor(() => expect(defaultFetch.mock.calls.some(([path, init]) => String(path).endsWith('/content/session-owned/approval') && init?.method === 'PATCH')).toBe(true))
    const call = defaultFetch.mock.calls.find(([path, init]) => String(path).endsWith('/content/session-owned/approval') && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ approvalStatus: 'pending', expectedRevision: 3 })
  })

  it('keeps the connected workflow reachable at the specified responsive breakpoints', () => {
    expect(styles).toContain('@media (max-width: 900px)')
    expect(styles).toContain('@media (max-width: 640px)')
    expect(styles).toContain('.decision-radio-group { grid-template-columns: 1fr; }')
    expect(styles).toContain('grid-template-columns: repeat(3,minmax(0,1fr))')
    expect(styles).toContain('.speaker-handoff-grid { grid-template-columns: 1fr; }')
    expect(styles).toContain('.sidebar-top > a { min-height: 44px')
    expect(styles).toContain('.event-switcher button { width: 44px; height: 44px')
    expect(styles).toContain('.sidebar-nav { flex: 1; min-height: 0; padding: 4px 8px; overflow: auto; }')
    expect(styles).toContain('.sidebar-nav a { min-height: 44px')
    expect(styles).toContain('.sidebar-footer { flex: none;')
    expect(styles).toContain('.sidebar-footer .sidebar-sign-out { min-width: 64px; min-height: 44px')
    expect(styles).toContain('.program-search { min-width: 0; min-height: 44px; }')
    expect(styles).toContain('.landing-nav nav > a { min-height: 44px')
    expect(styles).toContain('.text-link { min-height: 44px')
    expect(styles).toContain('grid-template-columns: repeat(5,minmax(68px,1fr))')
    expect(styles).toContain('.stepper::-webkit-scrollbar { height: 6px; }')
    expect(styles).toContain('.role-logo { min-height: 44px;')
    expect(styles).toContain('overflow-wrap: anywhere')
  })

  it('does not leak persisted demo proposals into connected review operations', async () => {
    const state = structuredClone(initialWorkflow) as unknown as Record<string, unknown>
    state.proposals = [{ ...initialWorkflow.proposals[2], id: 'ABS-160', title: 'Hostile proposal', participants: [42] }]
    window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state))
    renderAt('/admin/abstracts')
    await screen.findByRole('heading', { name: 'Proposals & reviews' })
    expect(screen.queryByText('Hostile proposal')).not.toBeInTheDocument()
    expect(screen.getAllByText('Taming 40-Minute CI: Incremental Builds at Monorepo Scale').length).toBeGreaterThan(0)
  })

  it('scopes canonical public requests to each URL event slug', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    renderAt('/events/alpha-conf/program')
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/program?event=alpha-conf')).toBe(true))
    cleanup()
    renderAt('/events/zebra-summit/submit')
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/cfp/zebra-summit')).toBe(true))
  })

  it('denies a canonical admin event when membership belongs to another event', async () => {
    renderAt('/events/other-conf/admin')
    expect(await screen.findByRole('heading', { name: 'This account cannot open this workspace.' })).toBeInTheDocument()
  })

  it('keeps unscoped admin deterministic and emits canonical event links', async () => {
    renderAt('/admin')
    expect((await screen.findAllByText('devflow-conf-2027')).length).toBeGreaterThan(0)
    expect(within(screen.getByRole('navigation', { name: 'Workspace navigation' })).getByRole('link', { name: /Public program/ }))
      .toHaveAttribute('href', '/events/devflow-conf-2027/program')
  })

  it('uses a document boundary when switching between organizer event memberships', async () => {
    vi.spyOn(cfpApi, 'session').mockResolvedValue({
      ...workspaceSession,
      memberships: [
        { eventSlug: 'zebra-summit', role: 'organizer' },
        { eventSlug: 'devflow-conf-2027', role: 'organizer' },
        { eventSlug: 'review-only-conf', role: 'reviewer' },
      ],
    })
    renderAt('/events/devflow-conf-2027/admin')

    const current = await screen.findByText('devflow-conf-2027', { selector: '.event-switcher strong' })
    fireEvent.click(current.closest('summary')!)
    const switchLink = screen.getByRole('link', { name: 'zebra-summit' })
    expect(screen.queryByRole('link', { name: 'review-only-conf' })).not.toBeInTheDocument()
    const pushState = vi.spyOn(window.history, 'pushState')
    let componentPreventedDefault = true
    const preventNavigation = (event: MouseEvent) => {
      componentPreventedDefault = event.defaultPrevented
      event.preventDefault()
    }
    document.addEventListener('click', preventNavigation)
    fireEvent.click(switchLink)
    document.removeEventListener('click', preventNavigation)

    expect(componentPreventedDefault).toBe(false)
    expect(pushState).not.toHaveBeenCalled()
    expect(switchLink).toHaveAttribute('href', '/events/zebra-summit/admin')
  })

  it('creates a private draft event and opens its canonical organizer workspace', async () => {
    renderAt('/events/devflow-conf-2027/admin')
    const current = await screen.findByText('devflow-conf-2027', { selector: '.event-switcher strong' })
    fireEvent.click(current.closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: /Create new event/ }))

    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Community Conf 2028' } })
    expect(screen.getByLabelText(/^Workspace slug/)).toHaveValue('community-conf-2028')
    fireEvent.change(screen.getByLabelText('First event day'), { target: { value: '2028-09-08' } })
    fireEvent.change(screen.getByLabelText('Last event day'), { target: { value: '2028-09-10' } })
    fireEvent.change(screen.getByLabelText('CFP opens'), { target: { value: '2028-01-15T10:00' } })
    fireEvent.change(screen.getByLabelText('CFP closes'), { target: { value: '2028-05-15T16:59' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }))

    await waitFor(() => expect(window.location.pathname).toBe('/events/community-conf-2028/admin'))
    expect(screen.queryByRole('dialog', { name: 'Create an event workspace' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Program operations overview' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No accepted sessions yet' })).toBeInTheDocument()
    const createCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(([path, init]) => String(path) === '/api/events' && init?.method === 'POST')
    expect(createCall).toBeTruthy()
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      slug: 'community-conf-2028',
      name: 'Community Conf 2028',
      startsOn: '2028-09-08',
      endsOn: '2028-09-10',
      initialTrack: 'General',
    })
  })

  it('explains missing event fields before sending a create request', async () => {
    renderAt('/events/devflow-conf-2027/admin')
    const current = await screen.findByText('devflow-conf-2027', { selector: '.event-switcher strong' })
    fireEvent.click(current.closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: /Create new event/ }))
    fireEvent.change(screen.getByLabelText('Event name'), { target: { value: 'Incomplete Event' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create event' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Complete the required First event day field before creating the event.')
    expect(alert).toHaveFocus()
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([path, init]) => String(path) === '/api/events' && init?.method === 'POST')).toHaveLength(0)
  })

  it('preserves a manually edited workspace slug when the event name changes', async () => {
    renderAt('/events/devflow-conf-2027/admin')
    const current = await screen.findByText('devflow-conf-2027', { selector: '.event-switcher strong' })
    fireEvent.click(current.closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: /Create new event/ }))
    const name = screen.getByLabelText('Event name')
    const slug = screen.getByLabelText(/^Workspace slug/)

    fireEvent.change(name, { target: { value: 'Community Conf 2028' } })
    expect(slug).toHaveValue('community-conf-2028')
    fireEvent.change(slug, { target: { value: 'community-summit' } })
    fireEvent.change(name, { target: { value: 'Community Conf 2028 Revised' } })

    expect(slug).toHaveValue('community-summit')
  })

  it('closes event creation with Escape and restores focus to its trigger', async () => {
    renderAt('/events/devflow-conf-2027/admin')
    const current = await screen.findByText('devflow-conf-2027', { selector: '.event-switcher strong' })
    fireEvent.click(current.closest('summary')!)
    const trigger = screen.getByRole('button', { name: /Create new event/ })
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog', { name: 'Create an event workspace' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Create an event workspace' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create an event workspace' })).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('keeps nested canonical abstract IDs separate from the section path', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>
    renderAt('/events/devflow-conf-2027/admin/abstracts/proposal-1')
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path) === '/api/events/devflow-conf-2027/cfp/reviews/progress')).toBe(true))
    expect(screen.getByRole('link', { name: 'Speakers' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/events/devflow-conf-2027/admin/abstracts/proposal-1')
  })
})
