import {
  type AuthSession,
  type DecisionListItem,
  type DecisionRecordResponse,
  type DecisionValue,
  type EvaluationPlanVersion,
  type EvaluationPlanWrite,
  type NotificationPreviewResponse,
  type OrganizerProposalReviewDetailResponse,
  type OrganizerProposalReviewProgress,
  type ReviewerAssignmentDetailResponse,
  type ReviewerAssignmentQueueItem,
  type ReviewerConflictCategory,
  type ReviewRecommendation,
  type ReviewScorecardSubmit,
} from '@confpilot/contracts'
import { type SubmitEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { ApiError, decisionApi, reviewerInvitationApi, reviewApi } from './api'
import { toContractDateTime } from './dateTime'
import { asApiError, eventWorkspacePath, isAuthenticationError } from './session'
import { Link, PageHeader, TaskTabs } from './ui'
import { useApiResource } from './useApiResource'
import { AccessDenied, hasEventRole, SignInForm, SignOutButton, useAuthSessionGate } from './auth'

function formatDate(value: string | null, empty = 'No due date') {
  if (!value) return empty
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value))
}

function fieldLabel(key: string) {
  return key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function decisionLabel(value: DecisionValue) {
  return value === 'accept' ? 'Accept' : value === 'reject' ? 'Reject' : 'Waitlist'
}

function DecisionDialog({ labelledBy, trigger, children, onClose }: { labelledBy: string; trigger: HTMLElement | null; children: ReactNode; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const focusable = dialog?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]')
    focusable?.focus()
    return () => trigger?.focus()
  }, [trigger])
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
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
  return <div className="dialog-backdrop decision-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>{children}</section></div>
}

function RoleHeader({ role, title, description, action }: { role: string; title: string; description: string; action?: ReactNode }) {
  return <header className="role-header"><div><Link to="/" className="role-logo"><span className="role-logo-mark" aria-hidden="true">▥</span> ConfPilot</Link><span className="role-badge">{role}</span></div><div><strong>{title}</strong><span>{description}</span></div>{action}</header>
}

function ErrorNotice({ error, retry }: { error: ApiError; retry?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [error])
  return <div ref={ref} className="form-error connected-error" role="alert" tabIndex={-1}><strong>{error.message}</strong>{error.requestId && <small>Request {error.requestId}</small>}{retry && <button type="button" className="button button-outline" onClick={retry}>Try again</button>}</div>
}

function RoleGate({ eventSlug, role, children }: { eventSlug: string; role: 'organizer' | 'reviewer'; children: (session: AuthSession, onUnauthorized: () => void, onSignedOut: () => void) => ReactNode }) {
  const auth = useAuthSessionGate()
  if (auth.checking) return <div className="role-loading" role="status" aria-live="polite">Checking your ConfPilot access…</div>
  if (auth.activeSession && hasEventRole(auth.activeSession, eventSlug, role)) return <>{children(auth.activeSession, auth.expire, auth.signOut)}</>
  if (auth.activeSession) return <AccessDenied session={auth.activeSession} onSignedOut={auth.signOut} />
  const sessionError = auth.reason === 'initial' && auth.resource.status === 'error' ? asApiError(auth.resource.error) : null
  if (sessionError && sessionError.code !== 'UNAUTHENTICATED') return <main className="role-empty"><span>ACCOUNT ACCESS</span><h1>Account status could not load.</h1><ErrorNotice error={sessionError} retry={auth.resource.reload} /></main>
  return <SignInForm eyebrow={`${role} workspace`} description="Assignments and reviews are scoped to your account and this event." error={auth.reason === 'expired' ? new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Sign in again to continue.') : null} onAuthenticated={auth.authenticate} />
}

export function ConnectedReviewerPortal({ eventSlug, preferredAssignmentId }: { eventSlug: string; preferredAssignmentId?: string }) {
  return <div className="role-app"><RoleGate eventSlug={eventSlug} role="reviewer">{(session, onUnauthorized, onSignedOut) => <><RoleHeader role="Reviewer" title={session.user.displayName} description="Assignment-scoped workspace" action={<SignOutButton onSignedOut={onSignedOut} />} /><ReviewerWorkspace eventSlug={eventSlug} session={session} preferredAssignmentId={preferredAssignmentId} onUnauthorized={onUnauthorized} /></>}</RoleGate></div>
}

function ReviewerWorkspace({ eventSlug, session, preferredAssignmentId, onUnauthorized }: { eventSlug: string; session: AuthSession; preferredAssignmentId?: string; onUnauthorized: () => void }) {
  const queue = useApiResource((signal) => reviewApi.queue(eventSlug, signal), [eventSlug])
  const [selectedId, setSelectedId] = useState(preferredAssignmentId ?? '')
  const [pinnedId, setPinnedId] = useState('')
  const [scorecardRecovery, setScorecardRecovery] = useState<{ assignmentId: string; error: ApiError } | null>(null)

  useEffect(() => {
    if (queue.status !== 'success') return
    const preferred = preferredAssignmentId
      ? preferredAssignmentId
      : pinnedId && queue.data.assignments.some((assignment) => assignment.id === pinnedId)
        ? pinnedId
      : queue.data.assignments.find((assignment) => assignment.status === 'pending')?.id ?? queue.data.assignments[0]?.id ?? ''
    if (selectedId !== preferred) setSelectedId(preferred)
  }, [queue.status, queue.data, preferredAssignmentId, pinnedId, selectedId])

  useEffect(() => {
    if (queue.status === 'error' && isAuthenticationError(queue.error)) onUnauthorized()
  }, [queue.status, queue.error, onUnauthorized])

  if (queue.status === 'loading') return <main className="role-empty" role="status" aria-live="polite"><span>REVIEW QUEUE</span><h1>Loading your assignments…</h1><p>Only proposals assigned to {session.user.displayName} will appear.</p></main>
  if (queue.status === 'error') return <main className="role-empty"><span>REVIEW QUEUE</span><h1>Your assignments could not load.</h1><ErrorNotice error={asApiError(queue.error)} retry={queue.reload} /></main>
  if (!queue.data.assignments.length) return <main className="role-empty"><span>REVIEW QUEUE</span><h1>You’re all caught up.</h1><p>No active assignments are available for this event.</p></main>

  return <main className="reviewer-shell connected-reviewer"><ReviewerQueue eventSlug={eventSlug} assignments={queue.data.assignments} selectedId={selectedId} onSelect={(id) => { setScorecardRecovery(null); setPinnedId(''); setSelectedId(id) }} />{selectedId && <ReviewerAssignment eventSlug={eventSlug} key={selectedId} assignmentId={selectedId} reviewerName={session.user.displayName} recoveryError={scorecardRecovery?.assignmentId === selectedId ? scorecardRecovery.error : null} onRecoveryError={(error) => setScorecardRecovery(error ? { assignmentId: selectedId, error } : null)} onSaved={() => { setPinnedId(selectedId); queue.reload() }} onUnauthorized={onUnauthorized} />}</main>
}

function ReviewerQueue({ eventSlug, assignments, selectedId, onSelect }: { eventSlug: string; assignments: ReviewerAssignmentQueueItem[]; selectedId: string; onSelect: (id: string) => void }) {
  const completed = assignments.filter((assignment) => assignment.status === 'completed').length
  return <aside className="review-queue" aria-label="Assigned reviews"><p className="overline">Assigned to you</p><p className="queue-summary">{completed} of {assignments.length} complete</p><div className="review-queue-list">{assignments.map((assignment) => <Link key={assignment.id} to={eventWorkspacePath(eventSlug, 'reviewer', assignment.id)} onClick={() => onSelect(assignment.id)} ariaCurrent={assignment.id === selectedId ? 'page' : undefined} className={assignment.id === selectedId ? 'active' : ''}><span>{assignment.proposal.publicId}</span><strong>{assignment.proposal.title}</strong><small>{assignment.status === 'completed' ? '✓ Complete' : assignment.invitationStatus === 'pending' ? 'Invitation awaiting response' : assignment.invitationStatus === 'declined' ? 'Invitation declined' : assignment.invitationStatus === 'recused' ? 'Recused' : assignment.dueAt ? `Due ${formatDate(assignment.dueAt)}` : 'Ready to review'}</small></Link>)}</div><div className="privacy-note">◉ Assignment privacy enforced<br /><span>Blind assignments omit author identity and speaker-only answers.</span></div></aside>
}

function ReviewerAssignment({ eventSlug, assignmentId, reviewerName, recoveryError, onRecoveryError, onSaved, onUnauthorized }: { eventSlug: string; assignmentId: string; reviewerName: string; recoveryError: ApiError | null; onRecoveryError: (error: ApiError | null) => void; onSaved: () => void; onUnauthorized: () => void }) {
  const detail = useApiResource((signal) => reviewApi.assignment(eventSlug, assignmentId, signal), [eventSlug, assignmentId])
  useEffect(() => {
    if (detail.status === 'error' && isAuthenticationError(detail.error)) onUnauthorized()
  }, [detail.status, detail.error, onUnauthorized])
  if (detail.status === 'loading') return <section className="review-assignment-loading" role="status" aria-live="polite">Loading the selected proposal and scorecard…</section>
  if (detail.status === 'error') return <section className="review-assignment-error"><ErrorNotice error={asApiError(detail.error)} retry={detail.reload} /></section>
  const refresh = () => { detail.reload(); onSaved() }
  const closed = detail.data.invitationStatus === 'declined' || detail.data.invitationStatus === 'recused'
  return <>{!closed && <ReviewDossier detail={detail.data} />}<ReviewerLifecycleControls eventSlug={eventSlug} detail={detail.data} onChanged={refresh} onUnauthorized={onUnauthorized} />{detail.data.invitationStatus === 'accepted' && <ReviewerScorecard eventSlug={eventSlug} detail={detail.data} reviewerName={reviewerName} recoveryError={recoveryError} onRecoveryError={onRecoveryError} onSaved={refresh} onUnauthorized={onUnauthorized} />}</>
}

function ReviewerLifecycleControls({ eventSlug, detail, onChanged, onUnauthorized }: { eventSlug: string; detail: ReviewerAssignmentDetailResponse; onChanged: () => void; onUnauthorized: () => void }) {
  const [reason, setReason] = useState('')
  const [category, setCategory] = useState<ReviewerConflictCategory>('author_relationship')
  const [pending, setPending] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const act = async (action: 'accept' | 'decline' | 'recuse' | 'conflict') => {
    if (pending || ((action === 'decline' || action === 'recuse' || action === 'conflict') && !reason.trim())) return
    setPending(action)
    setError(null)
    try {
      if (action === 'accept') await reviewApi.respondToInvitation(eventSlug, detail.id, { action: 'accept' })
      if (action === 'decline') await reviewApi.respondToInvitation(eventSlug, detail.id, { action: 'decline', reason })
      if (action === 'recuse') await reviewApi.recuse(eventSlug, detail.id, { reason })
      if (action === 'conflict') await reviewApi.declareConflict(eventSlug, detail.id, { category, note: reason })
      onChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending('')
    }
  }
  if (detail.review) return null
  if (detail.invitationStatus === 'declined' || detail.invitationStatus === 'recused') {
    return <aside className="scorecard"><p className="overline">Assignment status</p><h2>{detail.invitationStatus === 'declined' ? 'Invitation declined' : 'Reviewer recused'}</h2>{detail.responseReason && <p><strong>Recorded reason:</strong> {detail.responseReason}</p>}{detail.conflict && <p><strong>{fieldLabel(detail.conflict.category)} conflict declared.</strong> {detail.conflict.note}</p>}<p>This assignment is closed for scoring. The organizer can reassign the proposal.</p></aside>
  }
  if (detail.invitationStatus === 'pending') {
    return <aside className="scorecard"><p className="overline">Review invitation</p><h2>Accept or decline</h2><p>Accept before submitting a scorecard. Declining records an immutable reason for the organizer.</p><button className="button button-primary" type="button" disabled={Boolean(pending)} onClick={() => void act('accept')}>{pending === 'accept' ? 'Accepting…' : 'Accept assignment'}</button><label htmlFor={`decline-${detail.id}`}>Decline reason<textarea id={`decline-${detail.id}`} maxLength={1_000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>{error && <ErrorNotice error={error} />}<button className="button button-outline" type="button" disabled={Boolean(pending) || !reason.trim()} onClick={() => void act('decline')}>{pending === 'decline' ? 'Declining…' : 'Decline invitation'}</button></aside>
  }
  return <aside className="scorecard"><p className="overline">Conflict and recusal</p><h2>Can’t continue?</h2><p>Recusal closes this assignment. Declaring a conflict also prevents a future assignment to this proposal.</p><label htmlFor={`lifecycle-reason-${detail.id}`}>Reason<textarea id={`lifecycle-reason-${detail.id}`} maxLength={1_000} value={reason} onChange={(event) => setReason(event.target.value)} /></label><label htmlFor={`conflict-category-${detail.id}`}>Conflict category<select id={`conflict-category-${detail.id}`} value={category} onChange={(event) => setCategory(event.target.value as ReviewerConflictCategory)}><option value="author_relationship">Author relationship</option><option value="institutional">Institutional</option><option value="financial">Financial</option><option value="personal">Personal</option><option value="other">Other</option></select></label>{error && <ErrorNotice error={error} />}<div><button className="button button-outline" type="button" disabled={Boolean(pending) || !reason.trim()} onClick={() => void act('recuse')}>{pending === 'recuse' ? 'Recusing…' : 'Recuse'}</button><button className="button button-outline" type="button" disabled={Boolean(pending) || !reason.trim()} onClick={() => void act('conflict')}>{pending === 'conflict' ? 'Declaring…' : 'Declare conflict'}</button></div></aside>
}

function ReviewDossier({ detail }: { detail: ReviewerAssignmentDetailResponse }) {
  const answers = Object.entries(detail.proposal.sessionAnswers).filter(([key]) => !['title', 'abstract', 'track', 'format'].includes(key))
  return <section className="review-dossier-main"><header><p className="overline">{detail.proposal.publicId} · Round {detail.round}</p><h1>{detail.proposal.title}</h1><div><span>{detail.proposal.track}</span><span>{detail.proposal.format}</span><span>{detail.proposal.durationMinutes} minutes</span></div>{detail.blind ? <p className="blind-label">Blind review · author identity hidden</p> : <p className="identified-label">Author · {detail.proposal.authorDisplayName ?? 'Name unavailable'}</p>}</header><article><h2>Abstract</h2><p>{detail.proposal.abstract}</p>{answers.map(([key, value]) => <section className="dossier-answer" key={key}><h2>{fieldLabel(key)}</h2><p>{value}</p></section>)}</article></section>
}

function ReviewerScorecard({ eventSlug, detail, reviewerName, recoveryError, onRecoveryError, onSaved, onUnauthorized }: { eventSlug: string; detail: ReviewerAssignmentDetailResponse; reviewerName: string; recoveryError: ApiError | null; onRecoveryError: (error: ApiError | null) => void; onSaved: () => void; onUnauthorized: () => void }) {
  const existing = detail.review
  const evaluationPlan = detail.evaluationPlan
  const [originality, setOriginality] = useState(existing?.originality ?? 3)
  const [relevance, setRelevance] = useState(existing?.relevance ?? 3)
  const [criterionScores, setCriterionScores] = useState<Record<string, number>>(() => Object.fromEntries(
    evaluationPlan?.criteria.map((criterion) => [
      criterion.id,
      existing?.criterionScores.find((score) => score.criterionId === criterion.id)?.score
        ?? Math.round((criterion.minimumScore + criterion.maximumScore) / 2),
    ]) ?? [],
  ))
  const [recommendation, setRecommendation] = useState<ReviewRecommendation>(existing?.recommendation ?? 'discuss')
  const [comment, setComment] = useState(existing?.comment ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [saved, setSaved] = useState(existing)
  const [editing, setEditing] = useState(false)
  const hydratedRevision = useRef(existing ? `${existing.id}:${existing.revisionNumber}` : '')
  const review = saved ?? existing
  const builtinLabels = evaluationPlan?.builtinLabels ?? null
  const recommendationLabels: Record<ReviewRecommendation, string> = {
    accept: builtinLabels?.recommendationAccept ?? 'Accept',
    discuss: builtinLabels?.recommendationDiscuss ?? 'Discuss',
    reject: builtinLabels?.recommendationReject ?? 'Reject',
  }
  const commentsLabel = builtinLabels?.commentsLabel ?? 'Comments'

  const hydrateDraft = (source = review) => {
    if (!source) return
    setOriginality(source.originality)
    setRelevance(source.relevance)
    setCriterionScores(Object.fromEntries(
      evaluationPlan?.criteria.map((criterion) => [
        criterion.id,
        source.criterionScores.find((score) => score.criterionId === criterion.id)?.score
          ?? Math.round((criterion.minimumScore + criterion.maximumScore) / 2),
      ]) ?? [],
    ))
    setRecommendation(source.recommendation)
    setComment(source.comment)
  }

  useEffect(() => {
    const serverRevision = existing ? `${existing.id}:${existing.revisionNumber}` : ''
    if (hydratedRevision.current === serverRevision) return
    hydratedRevision.current = serverRevision
    setSaved(existing)
    hydrateDraft(existing)
    setEditing(false)
    setError(null)
  }, [existing?.id, existing?.revisionNumber])

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending || (saved && !editing)) return
    const payload: ReviewScorecardSubmit = evaluationPlan
      ? {
          ...(editing && review ? { expectedRevision: review.revisionNumber } : {}),
          criterionScores: evaluationPlan.criteria.map((criterion) => ({
            criterionId: criterion.id,
            score: criterionScores[criterion.id],
          })),
          recommendation,
          comment,
        }
      : { ...(editing && review ? { expectedRevision: review.revisionNumber } : {}), originality, relevance, recommendation, comment }
    setPending(true)
    setError(null)
    try {
      const result = await reviewApi.submit(eventSlug, detail.id, payload)
      setSaved(result)
      onRecoveryError(null)
      setEditing(false)
      onSaved()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) {
        onUnauthorized()
        return
      }
      setError(nextError)
      if ([
        'REVIEW_ALREADY_SUBMITTED',
        'ASSIGNMENT_NOT_FOUND',
        'REVIEW_CORRECTION_CONFLICT',
        'REVIEW_CORRECTION_CLOSED',
        'REVIEW_ROUND_NOT_OPEN',
        'REVIEW_CONFLICT_DECLARED',
      ].includes(nextError.code)) {
        onRecoveryError(new ApiError(
          nextError.status,
          nextError.code,
          `Your ${editing ? 'correction' : 'evaluation'} was not saved. ${nextError.message}`,
          nextError.requestId,
          nextError.issues,
        ))
        setSaved(null)
        setEditing(false)
        onSaved()
      }
    } finally {
      setPending(false)
    }
  }

  if (review && !editing) return <aside className="scorecard scorecard-complete">{recoveryError && <ErrorNotice error={recoveryError} />}<p className="overline">Submitted scorecard · Revision {review.revisionNumber}</p><h2>Evaluation complete</h2>{review.evaluationPlanVersion ? <><p className="scorecard-plan-label">Evaluation plan version {review.evaluationPlanVersion}</p><div className="score-readout score-readout-criteria">{review.criterionScores.map((score) => <span key={score.criterionId}><small>{score.label}</small><strong>{score.score}</strong></span>)}</div><p><strong>{review.weightedScore?.toFixed(3)}</strong> weighted score</p></> : <div className="score-readout"><span><small>Originality</small><strong>{review.originality}/5</strong></span><span><small>Relevance</small><strong>{review.relevance}/5</strong></span></div>}<dl><div><dt>Recommendation</dt><dd>{recommendationLabels[review.recommendation] ?? fieldLabel(review.recommendation)}</dd></div><div><dt>{commentsLabel}</dt><dd>{review.comment}</dd></div><div><dt>Submitted</dt><dd>{formatDate(review.submittedAt)}</dd></div>{review.correctedAt && <div><dt>Last corrected</dt><dd>{formatDate(review.correctedAt)}</dd></div>}</dl><p className="immutable-note">✓ Saved for {reviewerName}. Every submitted revision remains in the audit trail.</p>{detail.correctionAllowed ? <button className="button button-outline" type="button" onClick={() => { onRecoveryError(null); setEditing(true) }}>Correct scorecard</button> : <p className="builtin-note">Corrections are closed for this assignment.</p>}</aside>

  return <form className="scorecard" onSubmit={submit}><p className="overline">{editing ? `Correct revision ${review?.revisionNumber ?? 1}` : 'Your scorecard'}</p><h2>{editing ? 'Correct evaluation' : 'Evaluation'}</h2>{editing && <p className="builtin-note">Saving creates a new immutable revision. The previous submission remains in the audit trail.</p>}{evaluationPlan ? <fieldset className="evaluation-criteria"><legend>{evaluationPlan.name} · Version {evaluationPlan.versionNumber}</legend>{evaluationPlan.criteria.map((criterion) => { const descriptionId = `criterion-${detail.id}-${criterion.id}-description`; return <label key={criterion.id} htmlFor={`criterion-${detail.id}-${criterion.id}`}>{criterion.label} <span>{criterionScores[criterion.id]}/{criterion.maximumScore}</span>{criterion.description && <small id={descriptionId}>{criterion.description}</small>}<input id={`criterion-${detail.id}-${criterion.id}`} aria-describedby={criterion.description ? descriptionId : undefined} type="range" min={criterion.minimumScore} max={criterion.maximumScore} value={criterionScores[criterion.id]} onChange={(event) => setCriterionScores((current) => ({ ...current, [criterion.id]: Number(event.target.value) }))} /></label>})}</fieldset> : <><label htmlFor={`originality-${detail.id}`}>Originality <span>{originality}/5</span><input id={`originality-${detail.id}`} type="range" min="1" max="5" value={originality} onChange={(event) => setOriginality(Number(event.target.value))} /></label><label htmlFor={`relevance-${detail.id}`}>Relevance <span>{relevance}/5</span><input id={`relevance-${detail.id}`} type="range" min="1" max="5" value={relevance} onChange={(event) => setRelevance(Number(event.target.value))} /></label></>}<label htmlFor={`recommendation-${detail.id}`}>Recommendation<select id={`recommendation-${detail.id}`} value={recommendation} onChange={(event) => setRecommendation(event.target.value as ReviewRecommendation)}><option value="accept">{recommendationLabels.accept}</option><option value="discuss">{recommendationLabels.discuss}</option><option value="reject">{recommendationLabels.reject}</option></select></label><label htmlFor={`comment-${detail.id}`}>{commentsLabel}<textarea id={`comment-${detail.id}`} required maxLength={4_000} value={comment} onChange={(event) => setComment(event.target.value)} /></label>{error && <ErrorNotice error={error} />}<button className="button button-primary" type="submit" disabled={pending || !comment.trim()}>{pending ? 'Saving…' : editing ? 'Save correction →' : 'Submit evaluation →'}</button>{editing && <button className="button button-outline" type="button" disabled={pending} onClick={() => { hydrateDraft(); setError(null); setEditing(false) }}>Cancel correction</button>}<span className="save-state" aria-live="polite">{comment.trim() ? editing ? 'Ready to save a new revision' : 'Ready to submit' : 'Add a comment to submit'}</span></form>
}

const defaultEvaluationCriteria: EvaluationPlanWrite['criteria'] = [
  { key: 'originality', label: 'Originality', description: 'How distinctive and well-framed is the proposal?', weightBasisPoints: 5_000, minimumScore: 1, maximumScore: 5 },
  { key: 'relevance', label: 'Audience relevance', description: 'How useful is this session for the event audience?', weightBasisPoints: 5_000, minimumScore: 1, maximumScore: 5 },
]

type EditableEvaluationCriterion = EvaluationPlanWrite['criteria'][number] & { weightText: string }

function editableEvaluationCriterion(criterion: EvaluationPlanWrite['criteria'][number]): EditableEvaluationCriterion {
  return { ...criterion, weightText: String(criterion.weightBasisPoints / 100) }
}

function weightBasisPoints(value: string) {
  const normalized = value.trim()
  if (!/^\d{1,3}(?:\.\d{0,2})?$/.test(normalized)) return null
  const basisPoints = Math.round(Number(normalized) * 100)
  return Number.isSafeInteger(basisPoints) && basisPoints >= 1 && basisPoints <= 10_000 ? basisPoints : null
}

function nextCriterionKey(criteria: EditableEvaluationCriterion[]) {
  const keys = new Set(criteria.map((criterion) => criterion.key))
  let suffix = 1
  while (keys.has(`criterion_${suffix}`)) suffix += 1
  return `criterion_${suffix}`
}

const defaultBuiltinLabels = { recommendationAccept: 'Accept', recommendationDiscuss: 'Discuss', recommendationReject: 'Reject', commentsLabel: 'Comments' }
type BuiltinLabelsDraft = typeof defaultBuiltinLabels

function EvaluationPlanManager({ eventSlug, roundId = null, onUnauthorized }: { eventSlug: string; roundId?: string | null; onUnauthorized: () => void }) {
  const resource = useApiResource((signal) => reviewApi.plan(eventSlug, signal, roundId), [eventSlug, roundId])
  const hydratedVersion = useRef('')
  const [savedPlan, setSavedPlan] = useState<EvaluationPlanVersion | null>(null)
  const [name, setName] = useState('Program evaluation')
  const [criteria, setCriteria] = useState<EditableEvaluationCriterion[]>(() => defaultEvaluationCriteria.map(editableEvaluationCriterion))
  const [labels, setLabels] = useState<BuiltinLabelsDraft>(defaultBuiltinLabels)
  const [labelsDirty, setLabelsDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (resource.status === 'error' && isAuthenticationError(resource.error)) onUnauthorized()
  }, [resource.status, resource.error, onUnauthorized])

  useEffect(() => {
    if (resource.status !== 'success' || hydratedVersion.current === resource.data.versionId) return
    hydratedVersion.current = resource.data.versionId
    setSavedPlan(resource.data)
    setName(resource.data.name)
    setCriteria(resource.data.criteria.map(({ key, label, description, weightBasisPoints, minimumScore, maximumScore }) => editableEvaluationCriterion({ key, label, description, weightBasisPoints, minimumScore, maximumScore })))
    setLabels(resource.data.builtinLabels ?? defaultBuiltinLabels)
    setLabelsDirty(false)
  }, [resource.status, resource.data])

  const activePlan = savedPlan ?? (resource.status === 'success' ? resource.data : null)
  const missingPlan = resource.status === 'error' && asApiError(resource.error).code === 'REVIEW_PLAN_NOT_FOUND'
  const parsedWeights = criteria.map((criterion) => weightBasisPoints(criterion.weightText))
  const weightsTotal = parsedWeights.reduce<number>((total, weight) => total + (weight ?? 0), 0)
  const uniqueKeys = new Set(criteria.map((criterion) => criterion.key)).size === criteria.length
  const labelsValid = Object.values(labels).every((label) => label.trim().length >= 1 && label.trim().length <= 40)
  const valid = Boolean(name.trim()) && criteria.length > 0 && parsedWeights.every((weight) => weight !== null) && weightsTotal === 10_000 && uniqueKeys && labelsValid && criteria.every((criterion) => criterion.key && criterion.label.trim() && criterion.minimumScore < criterion.maximumScore)

  const updateCriterion = (index: number, update: Partial<EditableEvaluationCriterion>) => {
    setCriteria((current) => current.map((criterion, criterionIndex) => criterionIndex === index ? { ...criterion, ...update } : criterion))
  }
  const normalizeWeight = (index: number) => {
    const parsed = weightBasisPoints(criteria[index]?.weightText ?? '')
    if (parsed === null) return
    updateCriterion(index, { weightBasisPoints: parsed, weightText: String(parsed / 100) })
  }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending || !valid) return
    setPending(true)
    setError(null)
    setMessage('')
    try {
      const normalizedCriteria = criteria.map(({ weightText, ...criterion }, index) => ({
        ...criterion,
        weightBasisPoints: parsedWeights[index]!,
      }))
      const trimmedLabels = {
        recommendationAccept: labels.recommendationAccept.trim(),
        recommendationDiscuss: labels.recommendationDiscuss.trim(),
        recommendationReject: labels.recommendationReject.trim(),
        commentsLabel: labels.commentsLabel.trim(),
      }
      const result = await reviewApi.savePlan(eventSlug, {
        name,
        criteria: normalizedCriteria,
        ...(labelsDirty || savedPlan?.builtinLabels ? { builtinLabels: trimmedLabels } : {}),
      }, roundId)
      hydratedVersion.current = result.versionId
      setSavedPlan(result)
      setName(result.name)
      setCriteria(result.criteria.map(({ key, label, description, weightBasisPoints, minimumScore, maximumScore }) => editableEvaluationCriterion({ key, label, description, weightBasisPoints, minimumScore, maximumScore })))
      setLabels(result.builtinLabels ?? defaultBuiltinLabels)
      setLabelsDirty(false)
      setMessage(`Evaluation plan version ${result.versionNumber} is active for new assignments.`)
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(false)
    }
  }

  if (resource.status === 'loading') return <section className="section-card evaluation-plan-card" role="status" aria-live="polite">Loading the active evaluation plan…</section>
  if (resource.status === 'error' && !missingPlan) return <section className="section-card evaluation-plan-card"><ErrorNotice error={asApiError(resource.error)} retry={resource.reload} /></section>

  return <section className="section-card evaluation-plan-card" aria-labelledby="evaluation-plan-heading"><div className="card-heading"><div><p className="overline">Review scoring</p><h2 id="evaluation-plan-heading">Evaluation plan</h2></div>{activePlan && <span className="status-badge status-live">Version {activePlan.versionNumber} active</span>}</div>{activePlan ? <div className="active-evaluation-plan"><strong>{activePlan.name}</strong><ul>{activePlan.criteria.map((criterion) => <li key={criterion.id}><span>{criterion.label}</span><small>{criterion.weightBasisPoints / 100}% · scores {criterion.minimumScore}–{criterion.maximumScore}</small></li>)}</ul></div> : <p>No evaluation plan is active. Existing assignments use the legacy originality and relevance scorecard until you activate one.</p>}<form className="evaluation-plan-form" onSubmit={save}><div className="review-plan-warning" role="note"><strong>{activePlan ? 'Create the next version' : 'Activate the first plan'}</strong><span>Activation applies only to assignments created afterward. Existing assignments remain pinned to their original scorecard.</span></div><label>Plan name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label><div className="evaluation-plan-criteria"><div className="card-heading"><h3>Criteria</h3><button type="button" className="button button-outline" disabled={criteria.length >= 20} onClick={() => setCriteria((current) => [...current, { key: nextCriterionKey(current), label: 'New criterion', description: '', weightBasisPoints: 1, weightText: '0.01', minimumScore: 1, maximumScore: 5 }])}>Add criterion</button></div>{criteria.map((criterion, index) => <fieldset key={index}><legend>Criterion {index + 1}</legend><div className="form-grid"><label>Key<input required pattern="[a-z][a-z0-9_-]{0,63}" value={criterion.key} onChange={(event) => updateCriterion(index, { key: event.target.value })} /></label><label>Label<input required maxLength={120} value={criterion.label} onChange={(event) => updateCriterion(index, { label: event.target.value })} /></label><label>Weight (%)<input required type="text" inputMode="decimal" value={criterion.weightText} onChange={(event) => updateCriterion(index, { weightText: event.target.value })} onBlur={() => normalizeWeight(index)} /></label><label>Minimum score<input required type="number" min="1" max="9" value={criterion.minimumScore} onChange={(event) => updateCriterion(index, { minimumScore: Number(event.target.value) })} /></label><label>Maximum score<input required type="number" min="2" max="10" value={criterion.maximumScore} onChange={(event) => updateCriterion(index, { maximumScore: Number(event.target.value) })} /></label><label className="wide">Reviewer guidance<textarea maxLength={1_000} value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} /></label></div><button type="button" className="plain-button danger-link" aria-label={`Remove ${criterion.label || `criterion ${index + 1}`}`} disabled={criteria.length === 1} onClick={() => setCriteria((current) => current.filter((_, criterionIndex) => criterionIndex !== index))}>Remove criterion</button></fieldset>)}</div><fieldset className="evaluation-plan-builtins"><legend>Builtin fields</legend><p className="builtin-note">Every scorecard also collects a recommendation dropdown and a comments field. Options are stored canonically (accept / discuss / reject); these labels control what reviewers and results screens display.</p><div className="form-grid"><label>Accept option label<input required maxLength={40} value={labels.recommendationAccept} onChange={(event) => { setLabels((current) => ({ ...current, recommendationAccept: event.target.value })); setLabelsDirty(true) }} /></label><label>Middle option label<input required maxLength={40} value={labels.recommendationDiscuss} onChange={(event) => { setLabels((current) => ({ ...current, recommendationDiscuss: event.target.value })); setLabelsDirty(true) }} /></label><label>Reject option label<input required maxLength={40} value={labels.recommendationReject} onChange={(event) => { setLabels((current) => ({ ...current, recommendationReject: event.target.value })); setLabelsDirty(true) }} /></label><label>Comments field label<input required maxLength={40} value={labels.commentsLabel} onChange={(event) => { setLabels((current) => ({ ...current, commentsLabel: event.target.value })); setLabelsDirty(true) }} /></label></div></fieldset><p className={valid && weightsTotal === 10_000 ? 'save-state' : 'field-error'} aria-live="polite">Total weight: {(weightsTotal / 100).toFixed(2)}%{!uniqueKeys ? ' · Criterion keys must be unique.' : ''}{!labelsValid ? ' · Builtin field labels must be 1–40 characters.' : ''}</p>{error && <ErrorNotice error={error} />}<button className="button button-primary" disabled={pending || !valid}>{pending ? 'Activating…' : activePlan ? 'Activate new version' : 'Activate evaluation plan'}</button><p className="save-state" aria-live="polite">{message}</p></form></section>
}

export function ConnectedReviewersAdmin({ eventSlug }: { eventSlug: string }) {
  return <RoleGate eventSlug={eventSlug} role="organizer">{(_, onUnauthorized) => <ReviewersWorkspace eventSlug={eventSlug} onUnauthorized={onUnauthorized} />}</RoleGate>
}

function ReviewerInvitationPanel({ eventSlug, onUnauthorized, onReviewerChanged }: { eventSlug: string; onUnauthorized: () => void; onReviewerChanged: () => void }) {
  const invitations = useApiResource((signal) => reviewerInvitationApi.list(eventSlug, signal), [eventSlug])
  const idempotencyKey = useRef(crypto.randomUUID())
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [pending, setPending] = useState<string | null>(null)
  const [acceptLink, setAcceptLink] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    if (invitations.status === 'error' && isAuthenticationError(invitations.error)) onUnauthorized()
  }, [invitations.status, invitations.error, onUnauthorized])

  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending) return
    setPending('create')
    setError(null)
    setMessage('')
    setAcceptLink('')
    try {
      const result = await reviewerInvitationApi.create(eventSlug, { displayName, email, expiresInDays, idempotencyKey: idempotencyKey.current })
      if (result.acceptPath) {
        setAcceptLink(`${window.location.origin}${result.acceptPath}`)
        setMessage('Invitation queued in the immutable outbox. Copy this link now; ConfPilot stores only its hash and cannot show it again.')
        idempotencyKey.current = crypto.randomUUID()
        setDisplayName('')
        setEmail('')
      } else {
        setMessage('That exact request was already recorded. Its single-use link cannot be recovered; revoke it and create a replacement if the link was lost.')
      }
      invitations.reload()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(null)
    }
  }

  const revoke = async (invitationId: string) => {
    if (pending) return
    setPending(invitationId)
    setError(null)
    setMessage('')
    try {
      await reviewerInvitationApi.revoke(eventSlug, invitationId)
      setAcceptLink('')
      setMessage('Invitation revoked. Its previous link can no longer be used.')
      invitations.reload()
      onReviewerChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(null)
    }
  }

  const outboxLabel = (state: string | null) => state === 'provider_accepted' ? 'Provider accepted' : state === 'leased' ? 'Delivery in progress' : state === 'failed' ? 'Delivery failed' : state === 'suppressed' ? 'Suppressed, will not send' : state === 'queued' ? 'Queued, not sent' : 'No outbox record'
  return <section className="section-card reviewer-invitations-card" aria-labelledby="reviewer-invitations-heading"><div className="card-heading"><div><p className="overline">Reviewer access</p><h2 id="reviewer-invitations-heading">Invite reviewers securely</h2></div>{invitations.status === 'success' && <span className="count-pill">{invitations.data.invitations.length}</span>}</div><p>Create an expiring, single-use account invitation. The invitation is queued for optional email delivery; queued does not mean sent or delivered.</p><form className="reviewer-invitation-form" onSubmit={create}><div className="form-grid"><label>Reviewer name<input required minLength={2} maxLength={120} autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><label>Email<input required type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Expires in days<input required type="number" min="1" max="30" value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))} /></label></div><button className="button button-primary" disabled={Boolean(pending)}>{pending === 'create' ? 'Creating…' : 'Create reviewer invitation'}</button></form>{acceptLink && <div className="one-time-invitation-link" role="status"><strong>Copy this link now</strong><div><input aria-label="One-time reviewer invitation link" readOnly value={acceptLink} onFocus={(event) => event.currentTarget.select()} /><button className="button button-outline" type="button" onClick={() => { void navigator.clipboard?.writeText(acceptLink).then(() => setMessage('Invitation link copied. It remains single-use and expires automatically.')) }}>Copy link</button></div></div>}{error && <ErrorNotice error={error} />}<p className="save-state" aria-live="polite">{message}</p>{invitations.status === 'loading' && <p role="status" aria-live="polite">Loading reviewer invitations…</p>}{invitations.status === 'error' && <ErrorNotice error={asApiError(invitations.error)} retry={invitations.reload} />}{invitations.status === 'success' && (invitations.data.invitations.length === 0 ? <p>No reviewer invitations have been created.</p> : <div className="reviewer-invitation-ledger"><div className="reviewer-invitation-ledger-head"><span>Reviewer</span><span>Access</span><span>Email outbox</span><span>Action</span></div>{invitations.data.invitations.map((invitation) => <article key={invitation.id}><span><strong>{invitation.displayName}</strong><small>{invitation.email}</small></span><span><strong>{invitation.state === 'pending' && Date.parse(invitation.expiresAt) <= Date.now() ? 'Expired' : fieldLabel(invitation.state)}</strong><small>{invitation.state === 'accepted' ? `Accepted ${formatDate(invitation.acceptedAt, '')}` : invitation.state === 'revoked' ? `Revoked ${formatDate(invitation.revokedAt, '')}` : `Expires ${formatDate(invitation.expiresAt)}`}</small></span><span><strong>{outboxLabel(invitation.outboxState)}</strong><small>Created {formatDate(invitation.createdAt)}</small></span><span>{invitation.state === 'pending' && Date.parse(invitation.expiresAt) > Date.now() ? <button type="button" className="plain-button danger-link" disabled={Boolean(pending)} onClick={() => void revoke(invitation.id)}>{pending === invitation.id ? 'Revoking…' : 'Revoke'}</button> : '—'}</span></article>)}</div>)}<p className="builtin-note">The raw link appears only at creation and inside the immutable email snapshot. ConfPilot stores its SHA-256 digest for validation.</p></section>
}

function ReviewersWorkspace({ eventSlug, onUnauthorized }: { eventSlug: string; onUnauthorized: () => void }) {
  const rounds = useApiResource((signal) => reviewApi.rounds(eventSlug, signal), [eventSlug])
  const reviewers = useApiResource((signal) => reviewApi.reviewers(eventSlug, signal), [eventSlug])
  const [progressRevision, setProgressRevision] = useState(0)
  const onAssignmentsChanged = () => { rounds.reload(); setProgressRevision((current) => current + 1) }
  useEffect(() => {
    if ((rounds.status === 'error' && isAuthenticationError(rounds.error)) || (reviewers.status === 'error' && isAuthenticationError(reviewers.error))) onUnauthorized()
  }, [rounds.status, rounds.error, reviewers.status, reviewers.error, onUnauthorized])
  if (rounds.status === 'loading' || reviewers.status === 'loading') return <main className="page"><PageHeader eyebrow="Program · Reviewers" title="Review operations" description="Loading rounds and reviewer progress…" /></main>
  if (rounds.status === 'error') return <main className="page"><PageHeader eyebrow="Program · Reviewers" title="Review operations" description="Rounds could not load." /><ErrorNotice error={asApiError(rounds.error)} retry={rounds.reload} /></main>
  if (reviewers.status === 'error') return <main className="page"><PageHeader eyebrow="Program · Reviewers" title="Review operations" description="Reviewers could not load." /><ErrorNotice error={asApiError(reviewers.error)} retry={reviewers.reload} /></main>
  return <main className="page reviewers-admin-page"><PageHeader eyebrow="Program · Reviewers" title="Review operations" description="Provision reviewer access, configure rounds and pools, distribute assignments, and follow per-reviewer progress." /><ReviewerInvitationPanel eventSlug={eventSlug} onUnauthorized={onUnauthorized} onReviewerChanged={reviewers.reload} /><RoundsBoard eventSlug={eventSlug} rounds={rounds.data.rounds} reviewers={reviewers.data.reviewers} onChanged={onAssignmentsChanged} onUnauthorized={onUnauthorized} /><ReviewerProgressPanel eventSlug={eventSlug} rounds={rounds.data.rounds} revision={progressRevision} onUnauthorized={onUnauthorized} /></main>
}

type RoundListItem = Awaited<ReturnType<typeof reviewApi.rounds>>['rounds'][number]
type ReviewerOption = Awaited<ReturnType<typeof reviewApi.reviewers>>['reviewers'][number]

function windowBadge(round: RoundListItem) {
  return round.windowState === 'open' ? <span className="status-badge status-live">Open</span> : round.windowState === 'upcoming' ? <span className="status-badge status-draft">Opens {formatDate(round.opensAt)}</span> : <span className="status-badge">Closed {formatDate(round.closesAt)}</span>
}

function RoundsBoard({ eventSlug, rounds, reviewers, onChanged, onUnauthorized }: { eventSlug: string; rounds: RoundListItem[]; reviewers: ReviewerOption[]; onChanged: () => void; onUnauthorized: () => void }) {
  return <section className="section-card review-rounds-card" aria-labelledby="review-rounds-heading"><div className="card-heading"><div><p className="overline">Review rounds</p><h2 id="review-rounds-heading">Rounds, pools, and scorecards</h2></div><span className="count-pill">{rounds.length}</span></div>{rounds.length === 0 && <p>No rounds yet. Rounds carry their own window, reviewer pool, and scorecard; assignments made without a round keep using the event-default evaluation plan.</p>}{rounds.map((round) => <RoundCard key={round.id} eventSlug={eventSlug} round={round} reviewers={reviewers} onChanged={onChanged} onUnauthorized={onUnauthorized} />)}<RoundCreateForm eventSlug={eventSlug} onCreated={onChanged} onUnauthorized={onUnauthorized} /></section>
}

function RoundCreateForm({ eventSlug, onCreated, onUnauthorized }: { eventSlug: string; onCreated: () => void; onUnauthorized: () => void }) {
  const [name, setName] = useState('')
  const [opensAt, setOpensAt] = useState('')
  const [closesAt, setClosesAt] = useState('')
  const [blindDefault, setBlindDefault] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await reviewApi.createRound(eventSlug, { name, opensAt: toContractDateTime(opensAt), closesAt: toContractDateTime(closesAt), blindDefault })
      setName('')
      setOpensAt('')
      setClosesAt('')
      onCreated()
    } catch (requestError) {
      const nextError = requestError instanceof RangeError ? new ApiError(400, 'INVALID_INPUT', 'Enter valid open and close times.') : asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(false)
    }
  }
  return <form className="round-create-form" onSubmit={submit}><h3>Create a round</h3><div className="form-grid"><label>Round name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label><label>Opens<input required type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} /></label><label>Closes<input required type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} /></label><label className="blind-check"><input type="checkbox" checked={blindDefault} onChange={(event) => setBlindDefault(event.target.checked)} /> Blind by default</label></div>{error && <ErrorNotice error={error} />}<button className="button button-primary" disabled={pending}>{pending ? 'Creating…' : 'Create round'}</button></form>
}

function RoundCard({ eventSlug, round, reviewers, onChanged, onUnauthorized }: { eventSlug: string; round: RoundListItem; reviewers: ReviewerOption[]; onChanged: () => void; onUnauthorized: () => void }) {
  const pool = useApiResource((signal) => reviewApi.roundPool(eventSlug, round.id, signal), [eventSlug, round.id])
  const [addReviewerId, setAddReviewerId] = useState('')
  const [capText, setCapText] = useState('')
  const [track, setTrack] = useState('')
  const [showScorecard, setShowScorecard] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const members = pool.status === 'success' ? pool.data.reviewers : []
  const candidates = reviewers.filter((reviewer) => !members.some((member) => member.userId === reviewer.userId))
  const mutatePool = async (reviewerUserIds: string[]) => {
    if (pending) return
    setPending(true)
    setError(null)
    setMessage('')
    try {
      const result = await reviewApi.saveRoundPool(eventSlug, round.id, { reviewerUserIds })
      setMessage(result.rejected.length === 0 ? 'Pool updated.' : `Pool updated with ${result.rejected.length} rejected change${result.rejected.length === 1 ? '' : 's'}: ${result.rejected.map((row) => `${row.userId} (${row.reason.replaceAll('_', ' ')})`).join(', ')}.`)
      setAddReviewerId('')
      pool.reload()
      onChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(false)
    }
  }
  const autoAssign = async () => {
    if (pending) return
    const cap = capText.trim() === '' ? undefined : Number(capText)
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > 50)) {
      setMessage('')
      setError(new ApiError(400, 'INVALID_INPUT', 'Per-reviewer cap must be a whole number between 1 and 50.'))
      return
    }
    setPending(true)
    setError(null)
    setMessage('')
    try {
      const result = await reviewApi.autoAssign(eventSlug, round.id, { ...(cap !== undefined ? { perReviewerCap: cap } : {}), ...(track.trim() ? { track: track.trim() } : {}) })
      const skippedNote = result.skipped.length === 0 ? '' : ` ${result.skipped.length} skipped: ${result.skipped.map((row) => `${row.proposalId} (${row.reason.replaceAll('_', ' ')})`).join(', ')}.`
      const continuationNote = result.hasMore ? ' More eligible proposals remain; run auto-distribute again to continue.' : ''
      setMessage(`Auto-distributed ${result.created.length} assignment${result.created.length === 1 ? '' : 's'} across the pool.${skippedNote}${continuationNote}`)
      onChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(false)
    }
  }
  return <article className="round-card"><div className="card-heading"><div><h3>{round.name}</h3><small>{formatDate(round.opensAt)} → {formatDate(round.closesAt)} · {round.blindDefault ? 'Blind by default' : 'Identified by default'}</small></div>{windowBadge(round)}</div><div className="round-pool"><p className="overline">Round pool · {members.length} reviewer{members.length === 1 ? '' : 's'}</p>{pool.status === 'error' && <ErrorNotice error={asApiError(pool.error)} retry={pool.reload} />}{pool.status === 'success' && (members.length === 0 ? <p>No reviewers in this round yet. Assignments in this round require pool membership.</p> : <ul className="round-pool-list">{members.map((member) => <li key={member.userId}><span>{member.displayName}</span><small>{member.email}</small><button type="button" className="plain-button danger-link" disabled={pending} onClick={() => void mutatePool(members.filter((candidate) => candidate.userId !== member.userId).map((candidate) => candidate.userId))}>Remove</button></li>)}</ul>)}<div className="round-pool-add"><label>Add reviewer<select value={addReviewerId} onChange={(event) => setAddReviewerId(event.target.value)}><option value="">Choose a reviewer…</option>{candidates.map((reviewer) => <option key={reviewer.userId} value={reviewer.userId}>{reviewer.displayName} · {reviewer.email}</option>)}</select></label><button type="button" className="button button-outline" disabled={pending || !addReviewerId} onClick={() => void mutatePool([...members.map((member) => member.userId), addReviewerId])}>Add to pool</button></div></div><div className="round-auto-assign"><p className="overline">Distribute assignments</p><div className="form-grid"><label>Per-reviewer cap<input type="number" min="1" max="50" value={capText} onChange={(event) => setCapText(event.target.value)} placeholder="No cap" /></label><label>Track filter<input maxLength={120} value={track} onChange={(event) => setTrack(event.target.value)} placeholder="All tracks" /></label></div><button type="button" className="button button-primary" disabled={pending || round.windowState !== 'open' || members.length === 0} onClick={() => void autoAssign()}>{pending ? 'Working…' : 'Auto-distribute unassigned proposals'}</button>{round.windowState !== 'open' && <small className="builtin-note">Distribution requires an open round window.</small>}</div><div className="round-scorecard"><button type="button" className="button button-outline" onClick={() => setShowScorecard((current) => !current)}>{showScorecard ? 'Hide round scorecard' : round.hasActivePlan ? 'Edit round scorecard' : 'Create round scorecard'}</button>{showScorecard && <EvaluationPlanManager key={round.id} eventSlug={eventSlug} roundId={round.id} onUnauthorized={onUnauthorized} />}</div>{error && <ErrorNotice error={error} />}<p className="save-state" aria-live="polite">{message}</p></article>
}

function ReviewerProgressPanel({ eventSlug, rounds, revision, onUnauthorized }: { eventSlug: string; rounds: RoundListItem[]; revision: number; onUnauthorized: () => void }) {
  const [roundFilter, setRoundFilter] = useState<string>('')
  const progress = useApiResource((signal) => reviewApi.reviewerProgress(eventSlug, signal, roundFilter || null), [eventSlug, roundFilter, revision])
  const idempotencyKey = useRef(crypto.randomUUID())
  const [pendingReviewer, setPendingReviewer] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  useEffect(() => {
    if (progress.status === 'error' && isAuthenticationError(progress.error)) onUnauthorized()
  }, [progress.status, progress.error, onUnauthorized])
  const remind = async (reviewerUserId: string) => {
    if (pendingReviewer) return
    setPendingReviewer(reviewerUserId)
    setError(null)
    setMessage('')
    try {
      const result = await reviewApi.enqueueReviewerReminder(eventSlug, { reviewerUserId, ...(roundFilter ? { roundId: roundFilter } : {}), templateKey: 'reviewer.pending-reviews-reminder', idempotencyKey: idempotencyKey.current })
      idempotencyKey.current = crypto.randomUUID()
      setMessage(`Reminder queued in the immutable outbox for ${result.pendingAssignments} pending review${result.pendingAssignments === 1 ? '' : 's'}. This action did not send it or claim delivery.`)
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPendingReviewer(null)
    }
  }
  return <section className="section-card reviewer-progress-card" aria-labelledby="reviewer-progress-heading"><div className="card-heading"><div><p className="overline">Reviewer progress</p><h2 id="reviewer-progress-heading">Per-reviewer completion</h2></div><label>Round<select value={roundFilter} onChange={(event) => setRoundFilter(event.target.value)}><option value="">All assignments</option>{rounds.map((round) => <option key={round.id} value={round.id}>{round.name}</option>)}</select></label></div>{progress.status === 'loading' && <p role="status" aria-live="polite">Loading reviewer progress…</p>}{progress.status === 'error' && <ErrorNotice error={asApiError(progress.error)} retry={progress.reload} />}{progress.status === 'success' && (progress.data.reviewers.length === 0 ? <p>No reviewers match this filter yet.</p> : <table className="reviewer-progress-table"><thead><tr><th scope="col">Reviewer</th><th scope="col">Assigned</th><th scope="col">Completed</th><th scope="col">Overdue</th><th scope="col">Reminder</th></tr></thead><tbody>{progress.data.reviewers.map((row) => <tr key={row.userId}><td><strong>{row.displayName}</strong><small>{row.email}</small></td><td>{row.assignedCount}</td><td>{row.completedCount} of {row.assignedCount}</td><td>{row.overdueCount}</td><td>{row.assignedCount > row.completedCount ? <button type="button" className="button button-outline" disabled={pendingReviewer !== null} onClick={() => void remind(row.userId)}>{pendingReviewer === row.userId ? 'Queueing…' : 'Queue reminder'}</button> : <span className="complete-text">✓ Up to date</span>}</td></tr>)}</tbody></table>)}{error && <ErrorNotice error={error} />}<p className="save-state" aria-live="polite">{message}</p><p className="builtin-note">Queueing creates an immutable outbox record; provider delivery is a separate, optionally configured operation.</p></section>
}

export function ConnectedReviewAdmin({ eventSlug, preferredProposalId }: { eventSlug: string; preferredProposalId?: string }) {
  return <RoleGate eventSlug={eventSlug} role="organizer">{(_, onUnauthorized) => <OrganizerReviewWorkspace eventSlug={eventSlug} preferredProposalId={preferredProposalId} onUnauthorized={onUnauthorized} />}</RoleGate>
}

function OrganizerReviewWorkspace({ eventSlug, preferredProposalId, onUnauthorized }: { eventSlug: string; preferredProposalId?: string; onUnauthorized: () => void }) {
  const progress = useApiResource((signal) => reviewApi.progress(eventSlug, signal), [eventSlug])
  const reviewers = useApiResource((signal) => reviewApi.reviewers(eventSlug, signal), [eventSlug])
  const decisions = useApiResource((signal) => decisionApi.list(eventSlug, signal), [eventSlug])
  const [selectedId, setSelectedId] = useState(preferredProposalId ?? '')
  const [activeTab, setActiveTab] = useState<'queue' | 'plan' | 'decisions'>('queue')
  const [scoreSort, setScoreSort] = useState<'submission' | 'descending' | 'ascending'>('submission')
  const [exportState, setExportState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle')

  const exportReviews = async () => {
    const filename = `${eventSlug}-review-results.csv`
    setExportState('downloading')
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventSlug)}/cfp/reviews/export.csv`, { headers: { accept: 'text/csv' } })
      if (response.status === 401 || response.status === 403) { setExportState('idle'); onUnauthorized(); return }
      if (!response.ok) throw new Error('Review results export failed')
      const objectUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      link.hidden = true
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
      setExportState('success')
    } catch {
      setExportState('error')
    }
  }

  useEffect(() => {
    if (progress.status !== 'success') return
    const preferred = preferredProposalId && progress.data.proposals.some((proposal) => proposal.proposalId === preferredProposalId)
      ? preferredProposalId
      : progress.data.proposals[0]?.proposalId ?? ''
    if (selectedId !== preferred) setSelectedId(preferred)
  }, [progress.status, progress.data, preferredProposalId, selectedId])

  useEffect(() => {
    if ((progress.status === 'error' && isAuthenticationError(progress.error)) || (reviewers.status === 'error' && isAuthenticationError(reviewers.error)) || (decisions.status === 'error' && isAuthenticationError(decisions.error))) onUnauthorized()
  }, [progress.status, progress.error, reviewers.status, reviewers.error, decisions.status, decisions.error, onUnauthorized])

  if (progress.status === 'loading' || reviewers.status === 'loading' || decisions.status === 'loading') return <main className="page"><PageHeader eyebrow="Program · Abstracts" title="Loading review operations…" description="Fetching proposals, reviewers, decisions, and review progress." /><p className="resource-note" role="status" aria-live="polite">Loading live program data…</p></main>
  if (progress.status === 'error') return <main className="page"><PageHeader eyebrow="Program · Abstracts" title="Review progress could not load." description="The organizer review workspace is unavailable." /><ErrorNotice error={asApiError(progress.error)} retry={progress.reload} /></main>
  if (reviewers.status === 'error') return <main className="page"><PageHeader eyebrow="Program · Abstracts" title="Reviewer roster could not load." description="Assignments remain unavailable until the roster loads." /><ErrorNotice error={asApiError(reviewers.error)} retry={reviewers.reload} /></main>
  if (decisions.status === 'error') return <main className="page"><PageHeader eyebrow="Program · Abstracts" title="Program decisions could not load." description="No decision controls are shown without canonical server state." /><ErrorNotice error={asApiError(decisions.error)} retry={decisions.reload} /></main>

  const proposals = progress.data.proposals
  const sortedProposals = scoreSort === 'submission' ? proposals : proposals
    .map((proposal, index) => ({ proposal, index }))
    .sort((left, right) => {
      const leftScore = left.proposal.averageScore
      const rightScore = right.proposal.averageScore
      if (leftScore === null && rightScore === null) return left.index - right.index
      if (leftScore === null) return 1
      if (rightScore === null) return -1
      const scoreDifference = scoreSort === 'descending' ? rightScore - leftScore : leftScore - rightScore
      return scoreDifference || left.index - right.index
    })
    .map(({ proposal }) => proposal)
  const selected = proposals.find((proposal) => proposal.proposalId === selectedId)
  const selectedDecision = decisions.data.decisions.find((item) => item.proposal.id === selectedId)
  const reviewQueue = <>{proposals.length === 0 ? <section className="section-card supporting-state"><div><h2>No submitted proposals are ready for review.</h2><p>Submitted proposals appear here without exposing drafts.</p></div></section> : <><div className="review-live-warning" role="note"><strong>Assign after the CFP closes.</strong><span>Reviewers see the current submitted proposal. Reviews do not take a separate snapshot while the CFP is open.</span></div><div className="review-admin-layout"><section className="section-card review-progress-list" aria-label="Proposal review progress"><div className="card-heading"><div><p className="overline">Review queue</p><h2>{proposals.length} proposals</h2></div><div className="review-results-actions"><label>Sort by average score<select value={scoreSort} onChange={(event) => setScoreSort(event.target.value as typeof scoreSort)}><option value="submission">Submission order</option><option value="descending">Highest score first</option><option value="ascending">Lowest score first</option></select></label><button type="button" className="button button-outline" disabled={exportState === 'downloading'} onClick={() => void exportReviews()}>{exportState === 'downloading' ? 'Preparing CSV…' : 'Export review results (CSV)'}</button></div></div><p className="builtin-note">Scores are normalized to a 1–5 scale so results from different scorecards can be compared. Select a proposal to see its assignments, completed reviews, and final-decision control.</p>{exportState === 'success' && <p className="download-success" role="status">Downloaded {eventSlug}-review-results.csv.</p>}{exportState === 'error' && <p className="error-text" role="alert">Could not download review results. Refresh and try again.</p>}{sortedProposals.map((proposal) => <ReviewProgressButton eventSlug={eventSlug} key={proposal.proposalId} proposal={proposal} selected={proposal.proposalId === selectedId} onSelect={() => setSelectedId(proposal.proposalId)} />)}</section>{selected && <OrganizerReviewDetail eventSlug={eventSlug} key={selected.proposalId} proposal={selected} reviewers={reviewers.data.reviewers} initialDecision={selectedDecision} onChanged={progress.reload} onDecisionChanged={decisions.reload} onUnauthorized={onUnauthorized} />}</div></>}</>
  return <main className="page review-admin-page"><PageHeader eyebrow="Program · Review" title="Proposals & reviews" description="Review submissions, configure scoring, and record final decisions." action={<Link to={`${eventWorkspacePath(eventSlug, 'admin')}/reviewers`} className="button button-outline">Reviewers</Link>} /><TaskTabs label="Proposal workflow" active={activeTab} onChange={(tab) => setActiveTab(tab as typeof activeTab)} tabs={[{ id: 'queue', label: 'Review queue' }, { id: 'plan', label: 'Review setup' }, { id: 'decisions', label: 'Decisions' }]} />{activeTab === 'queue' && reviewQueue}{activeTab === 'plan' && <EvaluationPlanManager eventSlug={eventSlug} onUnauthorized={onUnauthorized} />}{activeTab === 'decisions' && <DecisionLedger eventSlug={eventSlug} decisions={decisions.data.decisions} activeProposalId={selected?.proposalId} onChanged={decisions.reload} onUnauthorized={onUnauthorized} />}</main>
}

function ReviewProgressButton({ eventSlug, proposal, selected, onSelect }: { eventSlug: string; proposal: OrganizerProposalReviewProgress; selected: boolean; onSelect: () => void }) {
  return <Link to={`${eventWorkspacePath(eventSlug, 'admin')}/abstracts/${encodeURIComponent(proposal.proposalId)}`} className={`review-progress-row ${selected ? 'active' : ''}`} onClick={onSelect} ariaCurrent={selected ? 'page' : undefined}><span><small>{proposal.publicId} · {proposal.track}</small><strong>{proposal.title}</strong></span><span><b>{proposal.completedCount}/{proposal.assignedCount}</b><small>{proposal.averageScore === null ? 'No score' : `${proposal.averageScore.toFixed(1)} average score`}</small></span></Link>
}

function OrganizerReviewDetail({ eventSlug, proposal, reviewers, initialDecision, onChanged, onDecisionChanged, onUnauthorized }: { eventSlug: string; proposal: OrganizerProposalReviewProgress; reviewers: Array<{ userId: string; displayName: string; email: string }>; initialDecision?: DecisionListItem; onChanged: () => void; onDecisionChanged: () => void; onUnauthorized: () => void }) {
  const detail = useApiResource((signal) => reviewApi.proposalReviews(eventSlug, proposal.proposalId, signal), [eventSlug, proposal.proposalId])
  const rounds = useApiResource((signal) => reviewApi.rounds(eventSlug, signal), [eventSlug])
  const [reviewerId, setReviewerId] = useState(reviewers[0]?.userId ?? '')
  const [roundId, setRoundId] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [blind, setBlind] = useState(true)
  const [pending, setPending] = useState<'assign' | string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const reload = () => { detail.reload(); onChanged() }
  const roundOptions = rounds.status === 'success' ? rounds.data.rounds : []
  const firstOpenRoundId = roundOptions.find((round) => round.windowState === 'open')?.id ?? ''

  useEffect(() => {
    if ((detail.status === 'error' && isAuthenticationError(detail.error)) || (rounds.status === 'error' && isAuthenticationError(rounds.error))) onUnauthorized()
  }, [detail.status, detail.error, rounds.status, rounds.error, onUnauthorized])

  useEffect(() => {
    if (!initialDecision || roundOptions.some((round) => round.id === roundId && round.windowState === 'open')) return
    setRoundId(firstOpenRoundId)
  }, [initialDecision, firstOpenRoundId, roundId, roundOptions])

  const assign = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!reviewerId || pending) return
    setPending('assign')
    setError(null)
    try {
      await reviewApi.assign(eventSlug, proposal.proposalId, { reviewerUserId: reviewerId, blind, dueAt: dueAt ? new Date(dueAt).toISOString() : null, ...(roundId ? { reviewRoundId: roundId } : {}) })
      reload()
    } catch (requestError) {
      if (isAuthenticationError(requestError)) onUnauthorized()
      else setError(asApiError(requestError))
    } finally {
      setPending(null)
    }
  }

  const revoke = async (assignmentId: string) => {
    if (pending) return
    setPending(assignmentId)
    setError(null)
    try {
      await reviewApi.revoke(eventSlug, assignmentId)
      reload()
    } catch (requestError) {
      if (isAuthenticationError(requestError)) onUnauthorized()
      else setError(asApiError(requestError))
    } finally {
      setPending(null)
    }
  }

  if (detail.status === 'loading') return <section className="section-card organizer-review-detail" role="status" aria-live="polite">Loading assignment history…</section>
  if (detail.status === 'error') return <section className="section-card organizer-review-detail"><ErrorNotice error={asApiError(detail.error)} retry={detail.reload} /></section>
  const data: OrganizerProposalReviewDetailResponse = detail.data
  const standardFields = new Set(['title', 'abstract', 'track', 'format'])
  const additionalAnswers = Object.entries(data.proposal.values).filter(([key]) => !standardFields.has(key))
  const dossier = <section className="organizer-proposal-dossier" aria-labelledby="organizer-proposal-dossier-title"><h3 id="organizer-proposal-dossier-title">Submitted proposal</h3><div><article className="wide"><h4>Abstract</h4><p>{data.proposal.abstract}</p></article><article><h4>Track</h4><p>{data.proposal.track}</p></article><article><h4>Format</h4><p>{fieldLabel(data.proposal.format)}</p></article><article><h4>Duration</h4><p>{data.proposal.durationMinutes} minutes</p></article><article className="wide"><h4>Participants</h4><div className="organizer-participant-list">{data.proposal.participants.map((participant) => <span key={participant.id}><strong>{participant.name}</strong><small>{participant.role === 'primary' ? 'Primary presenter' : 'Co-presenter'}{participant.email ? ` · ${participant.email}` : ''}</small></span>)}</div></article>{additionalAnswers.map(([key, value]) => <article key={key}><h4>{fieldLabel(key)}</h4><p>{value || 'Not provided'}</p></article>)}</div></section>
  const hasOpenRound = Boolean(firstOpenRoundId)
  const assignmentForm = (!initialDecision || hasOpenRound) && <form className="assignment-form" onSubmit={assign}><label>Reviewer<select required value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">Select a reviewer</option>{reviewers.map((reviewer) => <option key={reviewer.userId} value={reviewer.userId}>{reviewer.displayName} · {reviewer.email}</option>)}</select></label>{roundOptions.length > 0 && <label>Review round<select required={Boolean(initialDecision)} value={roundId} onChange={(event) => setRoundId(event.target.value)}><option value="" disabled={Boolean(initialDecision)}>{initialDecision ? 'Select an open round' : 'Event default (no round)'}</option>{roundOptions.map((round) => <option key={round.id} value={round.id} disabled={round.windowState !== 'open'}>{round.name}{round.windowState === 'open' ? '' : ` (${round.windowState})`}</option>)}</select></label>}<label>Due date<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label><label className="blind-check"><input type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} /><span><strong>Blind assignment</strong><small>Hide author identity and speaker answers.</small></span></label><button className="button button-primary" disabled={pending === 'assign' || !reviewerId || Boolean(initialDecision && !roundId)}>{pending === 'assign' ? 'Assigning…' : 'Assign reviewer'}</button></form>
  return <section className="section-card organizer-review-detail"><header><p className="overline">{data.proposal.publicId} · {data.proposal.status}</p><h2>{data.proposal.title}</h2><div className="review-detail-metrics"><span><strong>{data.progress.assigned}</strong><small>active</small></span><span><strong>{data.progress.submitted}</strong><small>submitted</small></span><span><strong>{data.progress.revoked}</strong><small>revoked</small></span></div></header>{dossier}{initialDecision && rounds.status === 'loading' && <div className="review-live-warning" role="status" aria-live="polite"><strong>Loading review rounds…</strong><span>Assignment controls will appear after ConfPilot confirms the review-round window.</span></div>}{initialDecision && rounds.status === 'error' && <ErrorNotice error={asApiError(rounds.error)} retry={rounds.reload} />}{initialDecision && rounds.status === 'success' && <div className="review-live-warning" role="note"><strong>{hasOpenRound ? 'Additional round review' : 'Additional review is closed.'}</strong><span>{hasOpenRound ? 'Collect more reviewer input in an open named round. This does not reopen or replace the recorded decision.' : 'Create or open a named review round to collect additional input after this decision.'}</span></div>}{assignmentForm}{error && <ErrorNotice error={error} />}<div className="assignment-history"><h3>Assignment history</h3>{data.assignments.length === 0 ? <p>No reviewers assigned yet.</p> : data.assignments.map((assignment) => <article key={assignment.id}><span><strong>{assignment.reviewer.displayName}</strong><small>Round {assignment.round} · {assignment.blind ? 'Blind' : 'Identified'} · {formatDate(assignment.dueAt)} · Invitation {fieldLabel(assignment.invitationStatus)}</small>{assignment.responseReason && <small><strong>Response reason:</strong> {assignment.responseReason}</small>}{assignment.conflict && <small><strong>{fieldLabel(assignment.conflict.category)} conflict:</strong> {assignment.conflict.note}</small>}</span><span className={`status-badge status-${assignment.status}`}>{fieldLabel(assignment.status)}</span>{assignment.status === 'pending' && <button type="button" className="plain-button danger-link" disabled={pending === assignment.id} onClick={() => void revoke(assignment.id)}>{pending === assignment.id ? 'Revoking…' : 'Revoke'}</button>}</article>)}</div><div className="submitted-reviews"><h3>Submitted scorecards</h3>{data.reviews.length === 0 ? <p>Completed reviews will appear here.</p> : data.reviews.map((review) => <article key={review.id}><header><strong>{review.reviewer.displayName}</strong><span>{review.evaluationPlanVersion ? `Plan v${review.evaluationPlanVersion} · ${review.weightedScore?.toFixed(3)} weighted · ${fieldLabel(review.recommendation)}` : `${review.originality}/5 originality · ${review.relevance}/5 relevance · ${fieldLabel(review.recommendation)}`}</span></header>{review.evaluationPlanVersion && <ul className="organizer-criterion-scores">{review.criterionScores.map((score) => <li key={score.criterionId}>{score.label}: {score.score}</li>)}</ul>}<p>{review.comment}</p><small>Round {review.round} · {formatDate(review.submittedAt)}{review.correctedAt ? ` · Revision ${review.revisionNumber} · corrected ${formatDate(review.correctedAt)}` : ''}</small></article>)}</div><div className="decision-separation"><strong>Reviewer input does not email authors.</strong><span>Recording a decision and preparing its email are separate organizer actions.</span></div><DecisionPanel eventSlug={eventSlug} proposalId={proposal.proposalId} proposalTitle={proposal.title} initialDecision={initialDecision} onChanged={onDecisionChanged} onUnauthorized={onUnauthorized} /></section>
}

function DecisionPanel({ eventSlug, proposalId, proposalTitle, initialDecision, onChanged, onUnauthorized }: { eventSlug: string; proposalId: string; proposalTitle: string; initialDecision?: DecisionListItem; onChanged: () => void; onUnauthorized: () => void }) {
  const [decision, setDecision] = useState<DecisionRecordResponse | undefined>(initialDecision)
  const [selected, setSelected] = useState<DecisionValue>('accept')
  const [rationale, setRationale] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [previewPending, setPreviewPending] = useState(false)
  const [preview, setPreview] = useState<NotificationPreviewResponse | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [queuePending, setQueuePending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const recordButton = useRef<HTMLButtonElement>(null)
  const notifyButton = useRef<HTMLButtonElement>(null)

  useEffect(() => setDecision(initialDecision), [initialDecision])

  const record = async () => {
    if (pending || decision) return
    setPending(true)
    setError(null)
    try {
      const result = await decisionApi.record(eventSlug, { proposalId, decision: selected, rationale })
      setDecision(result)
      setConfirming(false)
      onChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else {
        setError(nextError)
        if (nextError.code === 'DECISION_ALREADY_RECORDED') {
          setConfirming(false)
          onChanged()
        }
      }
    } finally {
      setPending(false)
    }
  }

  const openPreview = async () => {
    if (!decision || previewPending || decision.notification.status !== 'not_queued') return
    setPreviewPending(true)
    setError(null)
    try {
      const result = await decisionApi.previewNotification(eventSlug, decision.decision.id)
      setPreview(result)
      setSubject(result.subject)
      setBody(result.body)
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPreviewPending(false)
    }
  }

  const queue = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!decision || queuePending) return
    setQueuePending(true)
    setError(null)
    try {
      const notification = await decisionApi.queueNotification(eventSlug, decision.decision.id, { subject, body })
      setDecision({ ...decision, notification })
      setPreview(null)
      onChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setQueuePending(false)
    }
  }

  if (!decision) return <section className="decision-panel"><div><p className="overline">Program decision</p><h3>Record the final outcome</h3><p>The first decision is permanent. You can prepare the decision email afterward.</p></div><fieldset className="decision-radio-group"><legend>Decision for {proposalTitle}</legend>{(['accept', 'reject', 'waitlist'] as const).map((value) => <label key={value}><input type="radio" name={`decision-${proposalId}`} value={value} checked={selected === value} onChange={() => setSelected(value)} /><span><strong>{decisionLabel(value)}</strong><small>{value === 'accept' ? 'Create the accepted session and speaker tasks.' : value === 'reject' ? 'Close this proposal without a session.' : 'Keep this proposal on the waitlist.'}</small></span></label>)}</fieldset><label className="decision-rationale">Organizer rationale<textarea required maxLength={4_000} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>{error && !confirming && <ErrorNotice error={error} />}<button ref={recordButton} type="button" className="button button-dark" disabled={!rationale.trim()} onClick={() => setConfirming(true)}>Review final decision</button>{confirming && <DecisionDialog labelledBy={`confirm-decision-${proposalId}`} trigger={recordButton.current} onClose={() => { if (!pending) setConfirming(false) }}><button type="button" className="dialog-close" aria-label="Close decision confirmation" disabled={pending} onClick={() => setConfirming(false)}>×</button><p className="overline">Permanent action</p><h2 id={`confirm-decision-${proposalId}`}>{decisionLabel(selected)} this proposal?</h2><p>You are recording <strong>{decisionLabel(selected).toLowerCase()}</strong> for “{proposalTitle}”. This first decision cannot be changed.</p>{error && <ErrorNotice error={error} />}<div className="decision-dialog-actions"><button type="button" className="button button-outline" disabled={pending} onClick={() => setConfirming(false)}>Go back</button><button type="button" className="button button-primary" disabled={pending} onClick={() => void record()}>{pending ? 'Recording…' : `Confirm ${decisionLabel(selected).toLowerCase()}`}</button></div></DecisionDialog>}</section>

  const notificationStatus = decision.notification.status
  return <section className="decision-panel decision-recorded"><div className="decision-recorded-heading"><div><p className="overline">Final program decision</p><h3>{decisionLabel(decision.decision.value)}</h3></div><span className={`decision-state decision-state-${decision.decision.value}`}>Immutable</span></div><p>{decision.decision.rationale}</p><small>Recorded by {decision.decision.decidedBy.displayName} · {formatDate(decision.decision.decidedAt)}</small>{decision.handoff.status === 'materialized' && <div className="acceptance-handoff"><strong>✓ Canonical session created immediately</strong><span>{decision.handoff.programSession.slug}</span></div>}<p className={`notification-copy notification-${notificationStatus}`}>{notificationStatus === 'not_queued' ? 'Decision visible in ConfPilot; no notification saved to the outbox.' : notificationStatus === 'queued' ? 'Notification saved to outbox; waiting for provider dispatch.' : notificationStatus === 'provider_accepted' ? 'Provider accepted the notification; delivery is unverified.' : 'Provider dispatch failed.'}</p>{error && !preview && <ErrorNotice error={error} />}{notificationStatus === 'not_queued' && <button ref={notifyButton} type="button" className="button button-outline" disabled={previewPending} onClick={() => void openPreview()}>{previewPending ? 'Preparing preview…' : 'Preview decision email'}</button>}{preview && <DecisionDialog labelledBy={`notification-preview-${proposalId}`} trigger={notifyButton.current} onClose={() => { if (!queuePending) setPreview(null) }}><button type="button" className="dialog-close" aria-label="Close email preview" disabled={queuePending} onClick={() => setPreview(null)}>×</button><p className="overline">Email preview · not saved</p><h2 id={`notification-preview-${proposalId}`}>Review decision email</h2><p className="notification-recipient"><strong>To</strong><span>{preview.recipient.name} · {preview.recipient.email}</span></p><form className="notification-form" onSubmit={queue}><label>Subject<input required maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea required maxLength={20_000} value={body} onChange={(event) => setBody(event.target.value)} /></label>{error && <ErrorNotice error={error} />}<div className="decision-dialog-actions"><button type="button" className="button button-outline" disabled={queuePending} onClick={() => setPreview(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={queuePending || !subject.trim() || !body.trim()}>{queuePending ? 'Saving…' : 'Save to outbox'}</button></div></form></DecisionDialog>}</section>
}

function DecisionLedger({ eventSlug, decisions, activeProposalId, onChanged, onUnauthorized }: { eventSlug: string; decisions: DecisionListItem[]; activeProposalId?: string; onChanged: () => void; onUnauthorized: () => void }) {
  return <section className="section-card decision-ledger"><div className="card-heading"><div><p className="overline">Decision ledger</p><h2>{decisions.length} recorded</h2></div><p>Canonical outcomes are immutable and notification outbox state is shown separately.</p></div>{decisions.length === 0 ? <p>No final decisions have been recorded.</p> : <div>{decisions.map((item) => <article key={item.decision.id}><span><small>{item.proposal.publicId}</small><strong>{item.proposal.title}</strong></span><span className={`decision-state decision-state-${item.decision.value}`}>{decisionLabel(item.decision.value)}</span><span>{item.handoff.status === 'materialized' ? `Session · ${item.handoff.programSession.slug}` : 'No session'}</span>{activeProposalId === item.proposal.id ? <span>{item.notification.status === 'not_queued' ? 'No outbox record' : item.notification.status === 'queued' ? 'Saved to outbox; waiting for provider dispatch.' : item.notification.status === 'provider_accepted' ? 'Provider accepted; delivery is unverified.' : 'Provider dispatch failed.'}</span> : <LedgerNotificationAction eventSlug={eventSlug} item={item} onChanged={onChanged} onUnauthorized={onUnauthorized} />}</article>)}</div>}</section>
}

function LedgerNotificationAction({ eventSlug, item, onChanged, onUnauthorized }: { eventSlug: string; item: DecisionListItem; onChanged: () => void; onUnauthorized: () => void }) {
  const [preview, setPreview] = useState<NotificationPreviewResponse | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  if (item.notification.status !== 'not_queued') return <span>{item.notification.status === 'queued' ? 'Saved to outbox; waiting for provider dispatch.' : item.notification.status === 'provider_accepted' ? 'Provider accepted; delivery is unverified.' : 'Provider dispatch failed.'}</span>

  const open = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = await decisionApi.previewNotification(eventSlug, item.decision.id)
      setPreview(result)
      setSubject(result.subject)
      setBody(result.body)
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(false)
    }
  }
  const queue = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await decisionApi.queueNotification(eventSlug, item.decision.id, { subject, body })
      setPreview(null)
      onChanged()
    } catch (requestError) {
      const nextError = asApiError(requestError)
      if (isAuthenticationError(nextError)) onUnauthorized()
      else setError(nextError)
    } finally {
      setPending(false)
    }
  }
  return <div className="ledger-notification-action">{error && !preview && <small role="alert">{error.message}</small>}<button ref={trigger} type="button" className="plain-button" disabled={pending} onClick={() => void open()}>{pending ? 'Preparing…' : 'Preview email'}</button>{preview && <DecisionDialog labelledBy={`ledger-notification-${item.decision.id}`} trigger={trigger.current} onClose={() => { if (!pending) setPreview(null) }}><button type="button" className="dialog-close" aria-label="Close email preview" disabled={pending} onClick={() => setPreview(null)}>×</button><p className="overline">Email preview · not saved</p><h2 id={`ledger-notification-${item.decision.id}`}>Review decision email</h2><p className="notification-recipient"><strong>To</strong><span>{preview.recipient.name} · {preview.recipient.email}</span></p><form className="notification-form" onSubmit={queue}><label>Subject<input required maxLength={998} value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea required maxLength={20_000} value={body} onChange={(event) => setBody(event.target.value)} /></label>{error && <ErrorNotice error={error} />}<div className="decision-dialog-actions"><button type="button" className="button button-outline" disabled={pending} onClick={() => setPreview(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={pending || !subject.trim() || !body.trim()}>{pending ? 'Saving…' : 'Save to outbox'}</button></div></form></DecisionDialog>}</div>
}
