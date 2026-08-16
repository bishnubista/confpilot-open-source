import {
  agendaAutoPlaceRequestSchema,
  agendaAutoPlaceResponseSchema,
  agendaDayCreateSchema,
  agendaDayUpdateSchema,
  agendaPlacementCreateSchema,
  agendaPlacementDeleteSchema,
  agendaPlacementUpdateSchema,
  agendaPublishResponseSchema,
  agendaResponseSchema,
  agendaRoomCreateSchema,
  agendaRoomUpdateSchema,
  agendaTrackCreateSchema,
  agendaTrackUpdateSchema,
  authSessionSchema,
  bulkSpeakerCommunicationEnqueueSchema,
  bulkSpeakerCommunicationResponseSchema,
  cfpPublicConfigResponseSchema,
  communicationHistoryResponseSchema,
  decisionListResponseSchema,
  decisionRecordRequestSchema,
  decisionRecordResponseSchema,
  contentCommentCreateSchema,
  contentCommentResponseSchema,
  contentReviewCreateSchema,
  contentReviewResponseSchema,
  deliverableRequestCreateSchema,
  deliverableRequestResponseSchema,
  deliverableRequestUpdateSchema,
  deliverableUploadResponseSchema,
  embedConfigCreateSchema,
  embedConfigListResponseSchema,
  embedConfigResponseSchema,
  embedConfigUpdateSchema,
  evaluationPlanVersionSchema,
  evaluationPlanWriteSchema,
  reviewRoundListResponseSchema,
  reviewRoundPoolResponseSchema,
  reviewRoundPoolWriteSchema,
  reviewRoundResponseSchema,
  reviewRoundUpdateSchema,
  reviewRoundWriteSchema,
  reviewAutoAssignRequestSchema,
  reviewAutoAssignResultSchema,
  reviewerProgressResponseSchema,
  reviewerReminderEnqueueSchema,
  reviewerReminderResponseSchema,
  notificationPreviewResponseSchema,
  notificationQueueRequestSchema,
  notificationQueueResponseSchema,
  ownerWorkspaceResponseSchema,
  organizerContentListResponseSchema,
  organizerEventCreateResponseSchema,
  organizerEventCreateSchema,
  organizerSpeakerRosterResponseSchema,
  organizerSpeakerTaskUpdateSchema,
  organizerProposalReviewDetailResponseSchema,
  organizerProposalReviewProgressResponseSchema,
  organizerReviewAssignmentCreateSchema,
  proposalCoPresenterListResponseSchema,
  proposalCoPresenterWriteSchema,
  proposalResponseSchema,
  publicEmbedResponseSchema,
  publicProgramResponseSchema,
  programReadinessResponseSchema,
  reviewerAssignmentDetailResponseSchema,
  reviewerAssignmentQueueResponseSchema,
  reviewerMembershipListResponseSchema,
  reviewerInvitationCreateResponseSchema,
  reviewerInvitationCreateSchema,
  reviewerInvitationListResponseSchema,
  reviewerInvitationRegisterSchema,
  reviewerInvitationResolveResponseSchema,
  reviewerInvitationResponseSchema,
  reviewerInvitationTokenRequestSchema,
  reviewAssignmentLifecycleResponseSchema,
  reviewInvitationResponseRequestSchema,
  reviewRecusalRequestSchema,
  reviewerConflictDeclareSchema,
  reviewAssignmentResponseSchema,
  reviewAssignmentRevokeResponseSchema,
  reviewScorecardSubmitSchema,
  submittedReviewSchema,
  speakerProposalListResponseSchema,
  speakerClaimCreateResponseSchema,
  speakerClaimCreateSchema,
  speakerClaimListResponseSchema,
  speakerClaimRegisterSchema,
  speakerClaimResolveResponseSchema,
  speakerClaimResponseSchema,
  speakerClaimTokenRequestSchema,
  speakerRegistrationSchema,
  speakerContentWorkspaceResponseSchema,
  speakerOwnedProfileUpdateSchema,
  speakerProfileResponseSchema,
  speakerProfileUpdateSchema,
  speakerRosterIngestResponseSchema,
  speakerRosterRowSchema,
  speakerReminderEnqueueResponseSchema,
  speakerReminderEnqueueSchema,
  speakerReminderTemplateListResponseSchema,
  speakerTaskBulkCreateSchema,
  speakerTaskResponseSchema,
  speakerTaskUpdateSchema,
  speakerVisibilityUpdateSchema,
  speakerWorkflowUpdateSchema,
  sessionContentHistoryResponseSchema,
  sessionContentUpdateSchema,
  sessionApprovalUpdateSchema,
  type AuthSession,
  type BulkSpeakerCommunicationEnqueue,
  type BulkSpeakerCommunicationResponse,
  type AgendaAutoPlaceRequest,
  type EvaluationPlanVersion,
  type EvaluationPlanWrite,
  type ReviewRoundListResponse,
  type ReviewRoundPoolResponse,
  type ReviewRoundPoolWrite,
  type ReviewRoundResponse,
  type ReviewRoundUpdate,
  type ReviewRoundWrite,
  type ReviewAutoAssignRequest,
  type ReviewAutoAssignResult,
  type ReviewerProgressResponse,
  type ReviewerReminderEnqueue,
  type ReviewerReminderResponse,
  type AgendaAutoPlaceResponse,
  type AgendaDayCreate,
  type AgendaDayUpdate,
  type AgendaPlacementCreate,
  type AgendaPlacementDelete,
  type AgendaPlacementUpdate,
  type AgendaPublishResponse,
  type AgendaResponse,
  type AgendaRoomCreate,
  type AgendaRoomUpdate,
  type AgendaTrackCreate,
  type AgendaTrackUpdate,
  type CfpConfigUpdate,
  type CfpPublicConfigResponse,
  type CommunicationHistoryResponse,
  type DecisionListResponse,
  type DecisionRecordRequest,
  type DecisionRecordResponse,
  type ContentCommentCreate,
  type ContentCommentResponse,
  type ContentReviewCreate,
  type ContentReviewResponse,
  type DeliverableRequestCreate,
  type DeliverableRequestResponse,
  type DeliverableRequestUpdate,
  type DeliverableUploadResponse,
  type EmbedConfigCreate,
  type EmbedConfigListResponse,
  type EmbedConfigResponse,
  type EmbedConfigUpdate,
  type LoginRequest,
  type NotificationPreviewResponse,
  type NotificationQueueRequest,
  type NotificationQueueResponse,
  type OwnerWorkspaceResponse,
  type OrganizerContentListResponse,
  type OrganizerEventCreate,
  type OrganizerEventCreateResponse,
  type OrganizerSpeakerRosterResponse,
  type OrganizerSpeakerTaskUpdate,
  type OrganizerProposalReviewDetailResponse,
  type OrganizerProposalReviewProgressResponse,
  type OrganizerReviewAssignmentCreate,
  type ProposalCoPresenterListResponse,
  type ProposalCoPresenterWrite,
  type ProposalDraftCreate,
  type ProposalDraftUpdate,
  type ProposalResponse,
  type PublicEmbedResponse,
  type PublicProgramResponse,
  type ProgramReadinessResponse,
  type ReviewerAssignmentDetailResponse,
  type ReviewerAssignmentQueueResponse,
  type ReviewerMembershipListResponse,
  type ReviewerInvitation,
  type ReviewerInvitationCreate,
  type ReviewerInvitationCreateResponse,
  type ReviewerInvitationListResponse,
  type ReviewerInvitationRegister,
  type ReviewerInvitationResolveResponse,
  type ReviewAssignmentLifecycleResponse,
  type ReviewInvitationResponseRequest,
  type ReviewRecusalRequest,
  type ReviewerConflictDeclare,
  type ReviewAssignmentResponse,
  type ReviewAssignmentRevokeResponse,
  type ReviewScorecardSubmit,
  type SpeakerProposalListResponse,
  type SpeakerClaim,
  type SpeakerClaimCreate,
  type SpeakerClaimCreateResponse,
  type SpeakerClaimListResponse,
  type SpeakerClaimRegister,
  type SpeakerClaimResolveResponse,
  type SpeakerRegistration,
  type SpeakerContentWorkspaceResponse,
  type SpeakerOwnedProfileUpdate,
  type SpeakerProfileResponse,
  type SpeakerProfileUpdate,
  type SpeakerRosterIngestResponse,
  type SpeakerRosterRow,
  type SpeakerReminderEnqueue,
  type SpeakerReminderEnqueueResponse,
  type SpeakerReminderTemplateListResponse,
  type SpeakerTaskBulkCreate,
  type SpeakerTaskResponse,
  type SpeakerTaskUpdate,
  type SpeakerVisibilityUpdate,
  type SpeakerWorkflowUpdate,
  type SessionContentHistoryResponse,
  type SessionContentUpdate,
  type SessionApprovalUpdate,
  type SubmittedReview,
} from '@confpilot/contracts'

import { toContractDateTime } from './dateTime'

type Schema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}

export interface ApiIssue {
  field: string
  message: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly issues: ApiIssue[]

  constructor(status: number, code: string, message: string, requestId?: string, issues: ApiIssue[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.issues = issues
  }
}

export const AUTH_SESSION_CHANGED_EVENT = 'confpilot:auth-session-changed'
let authSessionRevision = 0

function announceAuthSession(session: AuthSession | null) {
  authSessionRevision += 1
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<AuthSession | null>(AUTH_SESSION_CHANGED_EVENT, { detail: session }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function apiRequest<T>(path: string, schema: Schema<T>, init: RequestInit = {}): Promise<T> {
  const requestAuthRevision = authSessionRevision
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('content-type', 'application/json')
  const method = init.method?.toUpperCase() ?? 'GET'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('x-confpilot-request', '1')
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  })
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login' && requestAuthRevision === authSessionRevision) announceAuthSession(null)
    const error = isRecord(body) && isRecord(body.error) ? body.error : {}
    const issues = Array.isArray(error.issues)
      ? error.issues.filter((issue): issue is ApiIssue => isRecord(issue) && typeof issue.field === 'string' && typeof issue.message === 'string')
      : []
    throw new ApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
      typeof error.message === 'string' ? error.message : 'The request could not be completed.',
      typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? undefined,
      issues,
    )
  }
  const parsed = schema.safeParse(isRecord(body) ? body.data : undefined)
  if (!parsed.success) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', 'The server returned an unexpected response.', response.headers.get('x-request-id') ?? undefined)
  }
  return parsed.data
}

function json(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

function validatedInput<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', 'Check the form values and try again.')
  return parsed.data
}

export const cfpApi = {
  publicConfig(eventSlug: string, signal?: AbortSignal): Promise<CfpPublicConfigResponse> {
    return apiRequest(`/api/cfp/${encodeURIComponent(eventSlug)}`, cfpPublicConfigResponseSchema, { signal })
  },
  session(signal?: AbortSignal): Promise<AuthSession> {
    return apiRequest('/api/auth/session', authSessionSchema, { signal })
  },
  async login(input: LoginRequest): Promise<AuthSession> {
    const session = await apiRequest('/api/auth/login', authSessionSchema, json('POST', input))
    announceAuthSession(session)
    return session
  },
  async logout(): Promise<void> {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-confpilot-request': '1' },
    })
    if (response.ok) {
      announceAuthSession(null)
      return
    }
    const body: unknown = await response.json().catch(() => null)
    const error = isRecord(body) && isRecord(body.error) ? body.error : {}
    throw new ApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
      typeof error.message === 'string' ? error.message : 'Sign out could not be completed.',
      typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id') ?? undefined,
    )
  },
  async createEvent(input: OrganizerEventCreate): Promise<OrganizerEventCreateResponse> {
    const created = await apiRequest(
      '/api/events',
      organizerEventCreateResponseSchema,
      json('POST', validatedInput(organizerEventCreateSchema, input)),
    )
    announceAuthSession(created.session)
    return created
  },
  register(eventSlug: string, input: SpeakerRegistration): Promise<AuthSession> {
    return apiRequest(`/api/cfp/${encodeURIComponent(eventSlug)}/register`, authSessionSchema, json('POST', validatedInput(speakerRegistrationSchema, input)))
  },
  join(eventSlug: string): Promise<AuthSession> {
    return apiRequest(`/api/cfp/${encodeURIComponent(eventSlug)}/join`, authSessionSchema, json('POST'))
  },
  proposals(eventSlug: string, signal?: AbortSignal): Promise<SpeakerProposalListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals`, speakerProposalListResponseSchema, { signal })
  },
  createProposal(eventSlug: string, input: ProposalDraftCreate): Promise<ProposalResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals`, proposalResponseSchema, json('POST', input))
  },
  updateProposal(eventSlug: string, proposalId: string, input: ProposalDraftUpdate): Promise<ProposalResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals/${encodeURIComponent(proposalId)}`, proposalResponseSchema, json('PUT', input))
  },
  submitProposal(eventSlug: string, proposalId: string): Promise<ProposalResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals/${encodeURIComponent(proposalId)}/submit`, proposalResponseSchema, json('POST'))
  },
  proposalParticipants(eventSlug: string, proposalId: string, signal?: AbortSignal): Promise<ProposalCoPresenterListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals/${encodeURIComponent(proposalId)}/participants`, proposalCoPresenterListResponseSchema, { signal })
  },
  addCoPresenter(eventSlug: string, proposalId: string, input: ProposalCoPresenterWrite): Promise<ProposalCoPresenterListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals/${encodeURIComponent(proposalId)}/co-presenters`, proposalCoPresenterListResponseSchema, json('POST', validatedInput(proposalCoPresenterWriteSchema, input)))
  },
  removeCoPresenter(eventSlug: string, proposalId: string, presenterId: string): Promise<ProposalCoPresenterListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/proposals/${encodeURIComponent(proposalId)}/co-presenters/${encodeURIComponent(presenterId)}`, proposalCoPresenterListResponseSchema, json('DELETE'))
  },
  organizerConfig(eventSlug: string, signal?: AbortSignal): Promise<CfpPublicConfigResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp`, cfpPublicConfigResponseSchema, { signal })
  },
  updateOrganizerConfig(eventSlug: string, input: CfpConfigUpdate): Promise<CfpPublicConfigResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp`, cfpPublicConfigResponseSchema, json('PUT', input))
  },
}

export const reviewApi = {
  plan(eventSlug: string, signal?: AbortSignal, roundId?: string | null): Promise<EvaluationPlanVersion> {
    const query = roundId ? `?roundId=${encodeURIComponent(roundId)}` : ''
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-plan${query}`, evaluationPlanVersionSchema, { signal })
  },
  savePlan(eventSlug: string, input: EvaluationPlanWrite, roundId?: string | null): Promise<EvaluationPlanVersion> {
    const query = roundId ? `?roundId=${encodeURIComponent(roundId)}` : ''
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-plan${query}`, evaluationPlanVersionSchema, json('PUT', validatedInput(evaluationPlanWriteSchema, input)))
  },
  rounds(eventSlug: string, signal?: AbortSignal): Promise<ReviewRoundListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-rounds`, reviewRoundListResponseSchema, { signal })
  },
  createRound(eventSlug: string, input: ReviewRoundWrite): Promise<ReviewRoundResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-rounds`, reviewRoundResponseSchema, json('POST', validatedInput(reviewRoundWriteSchema, input)))
  },
  updateRound(eventSlug: string, roundId: string, input: ReviewRoundUpdate): Promise<ReviewRoundResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-rounds/${encodeURIComponent(roundId)}`, reviewRoundResponseSchema, json('PATCH', validatedInput(reviewRoundUpdateSchema, input)))
  },
  roundPool(eventSlug: string, roundId: string, signal?: AbortSignal): Promise<ReviewRoundPoolResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-rounds/${encodeURIComponent(roundId)}/pool`, reviewRoundPoolResponseSchema, { signal })
  },
  saveRoundPool(eventSlug: string, roundId: string, input: ReviewRoundPoolWrite): Promise<ReviewRoundPoolResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-rounds/${encodeURIComponent(roundId)}/pool`, reviewRoundPoolResponseSchema, json('PUT', validatedInput(reviewRoundPoolWriteSchema, input)))
  },
  autoAssign(eventSlug: string, roundId: string, input: ReviewAutoAssignRequest): Promise<ReviewAutoAssignResult> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/review-rounds/${encodeURIComponent(roundId)}/assignments/auto`, reviewAutoAssignResultSchema, json('POST', validatedInput(reviewAutoAssignRequestSchema, input)))
  },
  reviewerProgress(eventSlug: string, signal?: AbortSignal, roundId?: string | null): Promise<ReviewerProgressResponse> {
    const query = roundId ? `?roundId=${encodeURIComponent(roundId)}` : ''
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/reviews/reviewer-progress${query}`, reviewerProgressResponseSchema, { signal })
  },
  enqueueReviewerReminder(eventSlug: string, input: ReviewerReminderEnqueue): Promise<ReviewerReminderResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/reviews/reminders`, reviewerReminderResponseSchema, json('POST', validatedInput(reviewerReminderEnqueueSchema, input)))
  },
  reviewers(eventSlug: string, signal?: AbortSignal): Promise<ReviewerMembershipListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/reviewers`, reviewerMembershipListResponseSchema, { signal })
  },
  progress(eventSlug: string, signal?: AbortSignal): Promise<OrganizerProposalReviewProgressResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/reviews/progress`, organizerProposalReviewProgressResponseSchema, { signal })
  },
  proposalReviews(eventSlug: string, proposalId: string, signal?: AbortSignal): Promise<OrganizerProposalReviewDetailResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/proposals/${encodeURIComponent(proposalId)}/reviews`, organizerProposalReviewDetailResponseSchema, { signal })
  },
  async assign(eventSlug: string, proposalId: string, input: OrganizerReviewAssignmentCreate): Promise<ReviewAssignmentResponse> {
    let normalized: OrganizerReviewAssignmentCreate
    try {
      normalized = { ...input, ...(input.dueAt ? { dueAt: toContractDateTime(input.dueAt) } : {}) }
    } catch (error) {
      if (error instanceof RangeError) throw new ApiError(400, 'INVALID_INPUT', 'Enter a valid due date.')
      throw error
    }
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/proposals/${encodeURIComponent(proposalId)}/assignments`, reviewAssignmentResponseSchema, json('POST', validatedInput(organizerReviewAssignmentCreateSchema, normalized)))
  },
  revoke(eventSlug: string, assignmentId: string): Promise<ReviewAssignmentRevokeResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/cfp/assignments/${encodeURIComponent(assignmentId)}/revoke`, reviewAssignmentRevokeResponseSchema, json('POST'))
  },
  queue(eventSlug: string, signal?: AbortSignal): Promise<ReviewerAssignmentQueueResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/review/assignments`, reviewerAssignmentQueueResponseSchema, { signal })
  },
  assignment(eventSlug: string, assignmentId: string, signal?: AbortSignal): Promise<ReviewerAssignmentDetailResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/review/assignments/${encodeURIComponent(assignmentId)}`, reviewerAssignmentDetailResponseSchema, { signal })
  },
  respondToInvitation(eventSlug: string, assignmentId: string, input: ReviewInvitationResponseRequest): Promise<ReviewAssignmentLifecycleResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/review/assignments/${encodeURIComponent(assignmentId)}/invitation`, reviewAssignmentLifecycleResponseSchema, json('POST', validatedInput(reviewInvitationResponseRequestSchema, input)))
  },
  recuse(eventSlug: string, assignmentId: string, input: ReviewRecusalRequest): Promise<ReviewAssignmentLifecycleResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/review/assignments/${encodeURIComponent(assignmentId)}/recuse`, reviewAssignmentLifecycleResponseSchema, json('POST', validatedInput(reviewRecusalRequestSchema, input)))
  },
  declareConflict(eventSlug: string, assignmentId: string, input: ReviewerConflictDeclare): Promise<ReviewAssignmentLifecycleResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/review/assignments/${encodeURIComponent(assignmentId)}/conflict`, reviewAssignmentLifecycleResponseSchema, json('POST', validatedInput(reviewerConflictDeclareSchema, input)))
  },
  async submit(eventSlug: string, assignmentId: string, input: ReviewScorecardSubmit): Promise<SubmittedReview> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/review/assignments/${encodeURIComponent(assignmentId)}/review`, submittedReviewSchema, json('POST', validatedInput(reviewScorecardSubmitSchema, input)))
  },
}

export const reviewerInvitationApi = {
  list(eventSlug: string, signal?: AbortSignal): Promise<ReviewerInvitationListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/reviewer-invitations`, reviewerInvitationListResponseSchema, { signal })
  },
  create(eventSlug: string, input: ReviewerInvitationCreate): Promise<ReviewerInvitationCreateResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/reviewer-invitations`, reviewerInvitationCreateResponseSchema, json('POST', validatedInput(reviewerInvitationCreateSchema, input)))
  },
  revoke(eventSlug: string, invitationId: string): Promise<ReviewerInvitation> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/reviewer-invitations/${encodeURIComponent(invitationId)}/revoke`, reviewerInvitationResponseSchema, json('POST'))
  },
  resolve(token: string): Promise<ReviewerInvitationResolveResponse> {
    return apiRequest('/api/reviewer-invitations/resolve', reviewerInvitationResolveResponseSchema, json('POST', validatedInput(reviewerInvitationTokenRequestSchema, { token })))
  },
  async accept(token: string): Promise<AuthSession> {
    const session = await apiRequest('/api/reviewer-invitations/accept', authSessionSchema, json('POST', validatedInput(reviewerInvitationTokenRequestSchema, { token })))
    announceAuthSession(session)
    return session
  },
  async register(input: ReviewerInvitationRegister): Promise<AuthSession> {
    const session = await apiRequest('/api/reviewer-invitations/register', authSessionSchema, json('POST', validatedInput(reviewerInvitationRegisterSchema, input)))
    announceAuthSession(session)
    return session
  },
}

export const speakerClaimApi = {
  list(eventSlug: string, speakerId?: string, signal?: AbortSignal): Promise<SpeakerClaimListResponse> {
    const query = speakerId ? `?speakerId=${encodeURIComponent(speakerId)}` : ''
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker-claims${query}`, speakerClaimListResponseSchema, { signal })
  },
  create(eventSlug: string, input: SpeakerClaimCreate): Promise<SpeakerClaimCreateResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker-claims`, speakerClaimCreateResponseSchema, json('POST', validatedInput(speakerClaimCreateSchema, input)))
  },
  revoke(eventSlug: string, claimId: string): Promise<SpeakerClaim> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker-claims/${encodeURIComponent(claimId)}/revoke`, speakerClaimResponseSchema, json('POST'))
  },
  resolve(token: string): Promise<SpeakerClaimResolveResponse> {
    return apiRequest('/api/speaker-claims/resolve', speakerClaimResolveResponseSchema, json('POST', validatedInput(speakerClaimTokenRequestSchema, { token })))
  },
  async accept(token: string): Promise<AuthSession> {
    const session = await apiRequest('/api/speaker-claims/accept', authSessionSchema, json('POST', validatedInput(speakerClaimTokenRequestSchema, { token })))
    announceAuthSession(session)
    return session
  },
  async register(input: SpeakerClaimRegister): Promise<AuthSession> {
    const session = await apiRequest('/api/speaker-claims/register', authSessionSchema, json('POST', validatedInput(speakerClaimRegisterSchema, input)))
    announceAuthSession(session)
    return session
  },
}

export const decisionApi = {
  list(eventSlug: string, signal?: AbortSignal): Promise<DecisionListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/decisions`, decisionListResponseSchema, { signal })
  },
  record(eventSlug: string, input: DecisionRecordRequest): Promise<DecisionRecordResponse> {
    return apiRequest(
      `/api/events/${encodeURIComponent(eventSlug)}/decisions`,
      decisionRecordResponseSchema,
      json('POST', validatedInput(decisionRecordRequestSchema, input)),
    )
  },
  previewNotification(eventSlug: string, decisionId: string, signal?: AbortSignal): Promise<NotificationPreviewResponse> {
    return apiRequest(
      `/api/events/${encodeURIComponent(eventSlug)}/decisions/${encodeURIComponent(decisionId)}/notification-preview`,
      notificationPreviewResponseSchema,
      { signal },
    )
  },
  queueNotification(eventSlug: string, decisionId: string, input: NotificationQueueRequest): Promise<NotificationQueueResponse> {
    return apiRequest(
      `/api/events/${encodeURIComponent(eventSlug)}/decisions/${encodeURIComponent(decisionId)}/notification`,
      notificationQueueResponseSchema,
      json('POST', validatedInput(notificationQueueRequestSchema, input)),
    )
  },
}

export const speakerApi = {
  workspace(eventSlug: string, signal?: AbortSignal): Promise<OwnerWorkspaceResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/workspace`, ownerWorkspaceResponseSchema, { signal })
  },
}

export const speakerContentApi = {
  workspace(eventSlug: string, signal?: AbortSignal): Promise<SpeakerContentWorkspaceResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/content-workspace`, speakerContentWorkspaceResponseSchema, { signal })
  },
  profile(eventSlug: string, input: SpeakerOwnedProfileUpdate): Promise<SpeakerProfileResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/profile`, speakerProfileResponseSchema, json('PATCH', validatedInput(speakerOwnedProfileUpdateSchema, input)))
  },
  headshot(eventSlug: string, file: File): Promise<SpeakerProfileResponse> {
    const form = new FormData()
    form.set('file', file)
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/headshot`, speakerProfileResponseSchema, { method: 'POST', body: form })
  },
  task(eventSlug: string, taskId: string, input: SpeakerTaskUpdate): Promise<SpeakerTaskResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/tasks/${encodeURIComponent(taskId)}`, speakerTaskResponseSchema, json('PATCH', validatedInput(speakerTaskUpdateSchema, input)))
  },
  upload(eventSlug: string, requestId: string, file: File, note: string, idempotencyKey: string): Promise<DeliverableUploadResponse> {
    const form = new FormData()
    form.set('file', file)
    if (note.trim()) form.set('note', note.trim())
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/deliverables/${encodeURIComponent(requestId)}/versions`, deliverableUploadResponseSchema, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: form })
  },
  comment(eventSlug: string, sessionId: string, input: ContentCommentCreate): Promise<ContentCommentResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speaker/sessions/${encodeURIComponent(sessionId)}/comments`, contentCommentResponseSchema, json('POST', validatedInput(contentCommentCreateSchema, input)))
  },
}

export const organizerSpeakerContentApi = {
  roster(eventSlug: string, signal?: AbortSignal): Promise<OrganizerSpeakerRosterResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers`, organizerSpeakerRosterResponseSchema, { signal })
  },
  createSpeaker(eventSlug: string, input: SpeakerRosterRow): Promise<SpeakerRosterIngestResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers`, speakerRosterIngestResponseSchema, json('POST', validatedInput(speakerRosterRowSchema, input)))
  },
  importSpeakers(eventSlug: string, file: File): Promise<SpeakerRosterIngestResponse> {
    const form = new FormData()
    form.set('file', file)
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/import`, speakerRosterIngestResponseSchema, { method: 'POST', body: form })
  },
  reminderTemplates(eventSlug: string, signal?: AbortSignal): Promise<SpeakerReminderTemplateListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/communications/templates`, speakerReminderTemplateListResponseSchema, { signal })
  },
  enqueueReminder(eventSlug: string, input: SpeakerReminderEnqueue): Promise<SpeakerReminderEnqueueResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/communications/reminders`, speakerReminderEnqueueResponseSchema, json('POST', validatedInput(speakerReminderEnqueueSchema, input)))
  },
  content(eventSlug: string, signal?: AbortSignal): Promise<OrganizerContentListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content`, organizerContentListResponseSchema, { signal })
  },
  profile(eventSlug: string, speakerId: string, input: SpeakerProfileUpdate): Promise<SpeakerProfileResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/profile`, speakerProfileResponseSchema, json('PATCH', validatedInput(speakerProfileUpdateSchema, input)))
  },
  task(eventSlug: string, speakerId: string, taskId: string, input: OrganizerSpeakerTaskUpdate): Promise<SpeakerTaskResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/tasks/${encodeURIComponent(taskId)}`, speakerTaskResponseSchema, json('PATCH', validatedInput(organizerSpeakerTaskUpdateSchema, input)))
  },
  bulkTasks(eventSlug: string, input: SpeakerTaskBulkCreate): Promise<OrganizerSpeakerRosterResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/tasks`, organizerSpeakerRosterResponseSchema, json('POST', validatedInput(speakerTaskBulkCreateSchema, input)))
  },
  visibility(eventSlug: string, speakerId: string, input: SpeakerVisibilityUpdate): Promise<SpeakerProfileResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/visibility`, speakerProfileResponseSchema, json('PATCH', validatedInput(speakerVisibilityUpdateSchema, input)))
  },
  workflow(eventSlug: string, speakerId: string, input: SpeakerWorkflowUpdate): Promise<SpeakerProfileResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/workflow`, speakerProfileResponseSchema, json('PATCH', validatedInput(speakerWorkflowUpdateSchema, input)))
  },
  headshot(eventSlug: string, speakerId: string, file: File): Promise<SpeakerProfileResponse> {
    const form = new FormData()
    form.set('file', file)
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/headshot`, speakerProfileResponseSchema, { method: 'POST', body: form })
  },
  restoreSpeaker(eventSlug: string, speakerId: string, historyId: string): Promise<SpeakerProfileResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(speakerId)}/history/${encodeURIComponent(historyId)}/restore`, speakerProfileResponseSchema, json('POST'))
  },
  createRequest(eventSlug: string, sessionId: string, input: DeliverableRequestCreate): Promise<DeliverableRequestResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}/requests`, deliverableRequestResponseSchema, json('POST', validatedInput(deliverableRequestCreateSchema, input)))
  },
  updateRequest(eventSlug: string, sessionId: string, requestId: string, input: DeliverableRequestUpdate): Promise<DeliverableRequestResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, deliverableRequestResponseSchema, json('PATCH', validatedInput(deliverableRequestUpdateSchema, input)))
  },
  review(eventSlug: string, sessionId: string, input: ContentReviewCreate): Promise<ContentReviewResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}/reviews`, contentReviewResponseSchema, json('POST', validatedInput(contentReviewCreateSchema, input)))
  },
  comment(eventSlug: string, sessionId: string, input: ContentCommentCreate): Promise<ContentCommentResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}/comments`, contentCommentResponseSchema, json('POST', validatedInput(contentCommentCreateSchema, input)))
  },
  updateSession(eventSlug: string, sessionId: string, input: SessionContentUpdate): Promise<SessionContentHistoryResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}`, sessionContentHistoryResponseSchema, json('PATCH', validatedInput(sessionContentUpdateSchema, input)))
  },
  restoreSession(eventSlug: string, sessionId: string, historyId: string): Promise<SessionContentHistoryResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}/history/${encodeURIComponent(historyId)}/restore`, sessionContentHistoryResponseSchema, json('POST'))
  },
  approval(eventSlug: string, sessionId: string, input: SessionApprovalUpdate): Promise<OrganizerContentListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/content/${encodeURIComponent(sessionId)}/approval`, organizerContentListResponseSchema, json('PATCH', validatedInput(sessionApprovalUpdateSchema, input)))
  },
}

export const organizerCommunicationApi = {
  history(eventSlug: string, signal?: AbortSignal): Promise<CommunicationHistoryResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/communications`, communicationHistoryResponseSchema, { signal })
  },
  enqueueSpeakers(eventSlug: string, input: BulkSpeakerCommunicationEnqueue): Promise<BulkSpeakerCommunicationResponse> {
    return apiRequest(
      `/api/events/${encodeURIComponent(eventSlug)}/communications/speakers/bulk`,
      bulkSpeakerCommunicationResponseSchema,
      json('POST', validatedInput(bulkSpeakerCommunicationEnqueueSchema, input)),
    )
  },
}

export const programApi = {
  program(eventSlug: string, signal?: AbortSignal): Promise<PublicProgramResponse> {
    const params = new URLSearchParams({ event: eventSlug })
    return apiRequest(`/api/program?${params}`, publicProgramResponseSchema, { signal })
  },
  embed(eventSlug: string, embedSlug: string, signal?: AbortSignal): Promise<PublicEmbedResponse> {
    return apiRequest(
      `/api/public/events/${encodeURIComponent(eventSlug)}/embeds/${encodeURIComponent(embedSlug)}`,
      publicEmbedResponseSchema,
      { signal },
    )
  },
}

export const readinessApi = {
  get(eventSlug: string, signal?: AbortSignal): Promise<ProgramReadinessResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/readiness`, programReadinessResponseSchema, { signal })
  },
}

export const embedApi = {
  list(eventSlug: string, signal?: AbortSignal): Promise<EmbedConfigListResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/embeds`, embedConfigListResponseSchema, { signal })
  },
  async create(eventSlug: string, input: EmbedConfigCreate): Promise<EmbedConfigResponse> {
    return apiRequest(
      `/api/events/${encodeURIComponent(eventSlug)}/embeds`,
      embedConfigResponseSchema,
      json('POST', validatedInput(embedConfigCreateSchema, input)),
    )
  },
  async update(eventSlug: string, embedId: string, input: EmbedConfigUpdate): Promise<EmbedConfigResponse> {
    return apiRequest(
      `/api/events/${encodeURIComponent(eventSlug)}/embeds/${encodeURIComponent(embedId)}`,
      embedConfigResponseSchema,
      json('PATCH', validatedInput(embedConfigUpdateSchema, input)),
    )
  },
}

export const agendaApi = {
  get(eventSlug: string, signal?: AbortSignal): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda`, agendaResponseSchema, { signal })
  },
  async createRoom(eventSlug: string, input: AgendaRoomCreate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/rooms`, agendaResponseSchema,
      json('POST', validatedInput(agendaRoomCreateSchema, input)))
  },
  async updateRoom(eventSlug: string, roomId: string, input: AgendaRoomUpdate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/rooms/${encodeURIComponent(roomId)}`, agendaResponseSchema,
      json('PATCH', validatedInput(agendaRoomUpdateSchema, input)))
  },
  async createTrack(eventSlug: string, input: AgendaTrackCreate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/tracks`, agendaResponseSchema,
      json('POST', validatedInput(agendaTrackCreateSchema, input)))
  },
  async updateTrack(eventSlug: string, trackId: string, input: AgendaTrackUpdate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/tracks/${encodeURIComponent(trackId)}`, agendaResponseSchema,
      json('PATCH', validatedInput(agendaTrackUpdateSchema, input)))
  },
  async createDay(eventSlug: string, input: AgendaDayCreate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/days`, agendaResponseSchema,
      json('POST', validatedInput(agendaDayCreateSchema, input)))
  },
  async updateDay(eventSlug: string, dayId: string, input: AgendaDayUpdate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/days/${encodeURIComponent(dayId)}`, agendaResponseSchema,
      json('PATCH', validatedInput(agendaDayUpdateSchema, input)))
  },
  async createPlacement(eventSlug: string, input: AgendaPlacementCreate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/placements`, agendaResponseSchema,
      json('POST', validatedInput(agendaPlacementCreateSchema, input)))
  },
  async updatePlacement(eventSlug: string, placementId: string, input: AgendaPlacementUpdate): Promise<AgendaResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/placements/${encodeURIComponent(placementId)}`, agendaResponseSchema,
      json('PATCH', validatedInput(agendaPlacementUpdateSchema, input)))
  },
  async deletePlacement(eventSlug: string, placementId: string, input: AgendaPlacementDelete): Promise<AgendaResponse> {
    const value = validatedInput(agendaPlacementDeleteSchema, input)
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/placements/${encodeURIComponent(placementId)}?expectedRevision=${value.expectedRevision}`, agendaResponseSchema,
      json('DELETE'))
  },
  async autoPlace(eventSlug: string, input: AgendaAutoPlaceRequest): Promise<AgendaAutoPlaceResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/auto-place`, agendaAutoPlaceResponseSchema,
      json('POST', validatedInput(agendaAutoPlaceRequestSchema, input)))
  },
  async publish(eventSlug: string): Promise<AgendaPublishResponse> {
    return apiRequest(`/api/events/${encodeURIComponent(eventSlug)}/agenda/publish`, agendaPublishResponseSchema, json('POST'))
  },
}
