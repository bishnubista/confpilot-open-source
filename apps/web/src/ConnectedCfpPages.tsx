import {
  type AuthSession,
  type CfpField,
  type CfpPublicConfigResponse,
  type ProposalCoPresenterListResponse,
  type ProposalResponse,
} from '@confpilot/contracts'
import { type SubmitEvent, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, cfpApi } from './api'
import { toContractDateTime } from './dateTime'
import { asApiError, eventWorkspacePath, isAccessError } from './session'
import { Link, PageHeader } from './ui'
import { useApiResource } from './useApiResource'
import { TurnstileWidget } from './TurnstileWidget'

const inaccurateStockConfirmationMessage = 'Thanks for sharing your proposal. You can edit it until the CFP closes.'
const truthfulStockConfirmationMessage = 'Thanks for sharing your proposal. You can view its status from this account.'

function truthfulConfirmationMessage(message: string) {
  return message === inaccurateStockConfirmationMessage ? truthfulStockConfirmationMessage : message
}

function withTruthfulConfirmation(config: CfpPublicConfigResponse) {
  const confirmationMessage = truthfulConfirmationMessage(config.confirmationMessage)
  return confirmationMessage === config.confirmationMessage ? config : { ...config, confirmationMessage }
}

function WorkflowHeader({ role, title, description, back = '/' }: { role: string; title: string; description: string; back?: string }) {
  return <header className="role-header"><div><Link to={back} className="role-logo"><span className="role-logo-mark">▥</span> ConfPilot</Link><span className="role-badge">{role}</span></div><div><strong>{title}</strong><span>{description}</span></div></header>
}

function ResourcePage({ title, message, retry }: { title: string; message: string; retry?: () => void }) {
  return <div className="role-app"><WorkflowHeader role="Public CFP" title="ConfPilot" description="Call for proposals" /><main className="role-empty"><span>CALL FOR PROPOSALS</span><h1>{title}</h1><p role="status" aria-live="polite">{message}</p>{retry && <button type="button" className="button button-primary" onClick={retry}>Try again</button>}</main></div>
}

function proposalStateLabel(proposal: ProposalResponse) {
  return proposal.decision === 'accept' ? 'Accepted' : proposal.decision === 'reject' ? 'Rejected' : proposal.decision === 'waitlist' ? 'Waitlisted' : proposal.status === 'in_review' ? 'In review' : proposal.status === 'submitted' ? 'Submitted' : proposal.status === 'draft' ? 'Draft' : 'Decision recorded'
}

function readableFieldKey(key: string) {
  const words = key.replaceAll('_', ' ').trim()
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : 'Submitted field'
}

function ClosedSubmissionArchive({ config, session, proposals, proposalsLoading, proposalsLoaded, proposalsError, preferredProposalId }: {
  config: CfpPublicConfigResponse
  session: AuthSession
  proposals: ProposalResponse[]
  proposalsLoading: boolean
  proposalsLoaded: boolean
  proposalsError: ApiError | null
  preferredProposalId?: string
}) {
  const selectedProposal = preferredProposalId
    ? proposals.find((proposal) => proposal.id === preferredProposalId) ?? null
    : proposals[0] ?? null
  const selectedUnavailable = Boolean(preferredProposalId && proposalsLoaded && !selectedProposal)
  const configuredFields = selectedProposal
    ? config.fields.filter((field) => Object.hasOwn(selectedProposal.values, field.key)).map((field) => ({ key: field.key, label: field.label, value: displayValue(field, selectedProposal.values[field.key]) }))
    : []
  const configuredKeys = new Set(config.fields.map((field) => field.key))
  const preservedFields = selectedProposal
    ? Object.entries(selectedProposal.values).filter(([key]) => !configuredKeys.has(key)).map(([key, value]) => ({ key, label: readableFieldKey(key), value }))
    : []
  const submittedFields = [...configuredFields, ...preservedFields]

  return <div className="role-app">
    <WorkflowHeader role="Submitter" title={session.user.displayName} description="Read-only submission archive" />
    <main className="cfp-shell">
      <section className="cfp-form section-card closed-submission-archive">
        <header><p className="overline">{config.event.name}</p><h1>Submissions are closed.</h1><p>Editing ended on {formatDate(config.closesAt)}. Your account still has the exact proposal records you submitted.</p></header>
        {proposalsLoading && <p className="resource-note" role="status">Loading your submitted records…</p>}
        {proposalsError && <div className="form-error" role="alert"><strong>{proposalsError.message}</strong></div>}
        {!proposalsLoading && proposalsLoaded && proposals.length === 0 && <p className="empty-copy">No proposals are connected to this account.</p>}
        {proposals.length > 0 && <div className="closed-submission-layout">
          <nav className="closed-submission-list" aria-label="Your submitted proposal records">
            <p className="overline">Your proposals</p>
            {proposals.map((proposal) => <Link key={proposal.id} to={eventWorkspacePath(config.event.slug, 'submit', proposal.id)} ariaCurrent={selectedProposal?.id === proposal.id ? 'page' : undefined} ariaLabel={`View ${proposal.publicId}: ${proposal.values.title || 'Untitled proposal'}`}><strong>{proposal.values.title || 'Untitled proposal'}</strong><small>{proposal.publicId} · {proposalStateLabel(proposal)}</small></Link>)}
          </nav>
          <div className="closed-submission-record">
            {selectedUnavailable && <div className="form-error" role="alert"><strong>This proposal is not available in your account.</strong><small> Choose one of your submitted records.</small></div>}
            {selectedProposal && <article aria-label={`Read-only record for ${selectedProposal.publicId}`}>
              <p className="overline">{selectedProposal.publicId} · {proposalStateLabel(selectedProposal)}</p>
              <h2>{selectedProposal.values.title || 'Untitled proposal'}</h2>
              <p className="read-only-note"><strong>Read-only submitted record.</strong> ConfPilot will not accept proposal changes after the CFP closes.</p>
              <div className="review-dossier">{submittedFields.map((field) => <span key={field.key}><small>{field.label}</small><strong>{field.value || 'Not provided'}</strong></span>)}</div>
              <small className="record-timestamp">Last recorded {formatDate(selectedProposal.updatedAt)}</small>
            </article>}
          </div>
        </div>}
      </section>
    </main>
  </div>
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))
}

function visibleField(field: CfpField, values: Record<string, string>) {
  return !field.showWhen || values[field.showWhen.fieldKey] === field.showWhen.equals
}

function sanitizeProposalValues(fields: CfpField[], values: Record<string, string>) {
  const knownKeys = new Set(fields.map((field) => field.key))
  const sanitized = Object.fromEntries(Object.entries(values).filter(([key]) => knownKeys.has(key)))
  let changed = true
  while (changed) {
    changed = false
    for (const field of fields) {
      if (field.showWhen && sanitized[field.showWhen.fieldKey] !== field.showWhen.equals && field.key in sanitized) {
        delete sanitized[field.key]
        changed = true
      }
    }
  }
  return sanitized
}

function fieldError(issues: ApiError['issues'], fieldKey: string) {
  return issues.find((issue) => issue.field === fieldKey)?.message
}

function proposalSummary(fields: CfpField[], values: Record<string, string>) {
  const summaryField = fields.find((field) => field.key === 'title' && values[field.key]?.trim())
    ?? fields.find((field) => field.section === 'session' && values[field.key]?.trim())
  return summaryField ? values[summaryField.key]?.trim() ?? '' : ''
}

function FieldControl({ field, value, error, onChange }: { field: CfpField; value: string; error?: string; onChange: (value: string) => void }) {
  const id = `cfp-${field.key}`
  const helpId = field.helpText ? `${id}-help` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined
  return <label className={field.type === 'long_text' ? 'wide' : undefined} htmlFor={id}>
    <span>{field.label} {field.required && <b aria-hidden="true">*</b>}</span>
    {field.helpText && <small id={helpId}>{field.helpText}</small>}
    {field.type === 'dropdown'
      ? <select id={id} name={field.key} required={field.required} value={value} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)}><option value="">Select {field.label.toLowerCase()}</option>{field.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
      : field.type === 'long_text'
        ? <textarea id={id} name={field.key} required={field.required} value={value} maxLength={20_000} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} />
        : <input id={id} name={field.key} required={field.required} value={value} maxLength={20_000} aria-invalid={Boolean(error)} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} />}
    {error && <small className="field-error" id={errorId}>{error}</small>}
  </label>
}

function hasSpeakerMembership(session: AuthSession | null, eventSlug: string) {
  return session?.memberships.some((membership) => membership.eventSlug === eventSlug && membership.role === 'speaker') ?? false
}

function makeDraftKey() {
  return `web-${crypto.randomUUID()}`
}

export function PublicCfp({ eventSlug, preferredProposalId }: { eventSlug: string; preferredProposalId?: string }) {
  const configResource = useApiResource((signal) => cfpApi.publicConfig(eventSlug, signal), [eventSlug])
  const sessionResource = useApiResource<AuthSession | null>(async (signal) => {
    try {
      return await cfpApi.session(signal)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') return null
      throw error
    }
  }, [])
  const [session, setSession] = useState<AuthSession | null>(null)
  const [proposals, setProposals] = useState<ProposalResponse[]>([])
  const [proposalsLoading, setProposalsLoading] = useState(false)
  const [proposalsLoaded, setProposalsLoaded] = useState(false)
  const [step, setStep] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<ProposalResponse | null>(null)
  const [participants, setParticipants] = useState<ProposalCoPresenterListResponse['participants']>([])
  const [coPresenterName, setCoPresenterName] = useState('')
  const [coPresenterEmail, setCoPresenterEmail] = useState('')
  const [draftKey, setDraftKey] = useState(makeDraftKey)
  const [authMode, setAuthMode] = useState<'register' | 'signin'>('register')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [speakerTitle, setSpeakerTitle] = useState('')
  const [company, setCompany] = useState('')
  const [bio, setBio] = useState('')
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileResetKey, setTurnstileResetKey] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [success, setSuccess] = useState('')
  const [complete, setComplete] = useState<ProposalResponse | null>(null)
  const [completionAction, setCompletionAction] = useState<'submitted' | 'updated'>('submitted')
  const errorRef = useRef<HTMLDivElement>(null)
  const [errorFocusRevision, setErrorFocusRevision] = useState(0)
  const preferredProposalHandled = useRef<string | null>(null)
  const steps = ['Welcome', 'Account', 'Submission', 'Participants', 'Review']

  useEffect(() => {
    if (sessionResource.status === 'success') setSession(sessionResource.data)
  }, [sessionResource.status, sessionResource.data])

  useEffect(() => {
    if (!hasSpeakerMembership(session, eventSlug)) {
      setProposals([])
      setProposalsLoaded(false)
      return
    }
    const controller = new AbortController()
    setProposalsLoading(true)
    setProposalsLoaded(false)
    cfpApi.proposals(eventSlug, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setProposals(result.proposals)
          setProposalsLoaded(true)
        }
      },
      (requestError: unknown) => {
        if (!controller.signal.aborted) setError(asApiError(requestError))
      },
    ).finally(() => {
      if (!controller.signal.aborted) setProposalsLoading(false)
    })
    return () => controller.abort()
  }, [eventSlug, session])

  useEffect(() => {
    if (errorFocusRevision > 0) errorRef.current?.focus()
  }, [errorFocusRevision])

  const config = configResource.status === 'success' ? configResource.data : null
  const visibleFields = useMemo(() => config?.fields.filter((field) => visibleField(field, values)) ?? [], [config, values])
  const sessionFields = visibleFields.filter((field) => field.section === 'session')
  const speakerFields = visibleFields.filter((field) => field.section === 'speaker')
  const identityReady = hasSpeakerMembership(session, eventSlug)
  const accountProposals = proposals

  const raiseError = (nextError: ApiError) => {
    setError(nextError)
    setErrorFocusRevision((current) => current + 1)
  }

  const updateValue = (key: string, value: string) => {
    setValues((current) => {
      const next = { ...current, [key]: value }
      for (const field of config?.fields ?? []) {
        if (field.showWhen?.fieldKey === key && next[key] !== field.showWhen.equals) delete next[field.key]
      }
      return next
    })
    setError((current) => {
      if (!current) return null
      const issues = current.issues.filter((issue) => issue.field !== key)
      return issues.length ? new ApiError(current.status, current.code, current.message, current.requestId, issues) : null
    })
    setSuccess('')
  }

  const authenticate = async () => {
    setPending('auth')
    setError(null)
    try {
      let nextSession = session
      if (!nextSession) {
        nextSession = authMode === 'signin'
          ? await cfpApi.login({ email, password })
          : config?.turnstile.enabled && turnstileToken
            ? await cfpApi.register(eventSlug, { displayName, email, password, title: speakerTitle, company, bio, turnstileToken })
            : (() => { throw new ApiError(503, 'REGISTRATION_UNAVAILABLE', 'Account verification is not available. Try again shortly.') })()
      }
      if (!hasSpeakerMembership(nextSession, eventSlug)) nextSession = await cfpApi.join(eventSlug)
      if (!hasSpeakerMembership(nextSession, eventSlug)) {
        throw new ApiError(409, 'MEMBERSHIP_CONFLICT', 'Speaker access could not be confirmed for this event.')
      }
      setSession(nextSession)
      setPassword('')
      if (bio && !values.speaker_bio) setValues((current) => ({ ...current, speaker_bio: bio }))
      setStep(2)
      setSuccess(`Signed in as ${nextSession.user.displayName}.`)
    } catch (requestError) {
      if (authMode === 'register') {
        setTurnstileToken(null)
        setTurnstileResetKey((current) => current + 1)
      }
      raiseError(asApiError(requestError))
    } finally {
      setPending(null)
    }
  }

  const validateSection = (section: CfpField['section']) => {
    const issues = visibleFields
      .filter((field) => field.section === section && field.required && !values[field.key]?.trim())
      .map((field) => ({ field: field.key, message: 'This field is required.' }))
    if (!issues.length) return true
    raiseError(new ApiError(400, 'PROPOSAL_INCOMPLETE', 'Complete every required field before continuing.', undefined, issues))
    return false
  }

  const persistDraft = async () => {
    const sanitizedValues = sanitizeProposalValues(config?.fields ?? [], values)
    const proposal = draft
      ? await cfpApi.updateProposal(eventSlug, draft.id, { values: sanitizedValues })
      : await cfpApi.createProposal(eventSlug, { clientDraftKey: draftKey, values: sanitizedValues })
    setDraft(proposal)
    setValues(proposal.values)
    setProposals((current) => [...current.filter((item) => item.id !== proposal.id), proposal])
    return proposal
  }

  const saveDraft = async () => {
    setPending('draft')
    setError(null)
    setSuccess('')
    try {
      const proposal = await persistDraft()
      setSuccess(proposal.status === 'submitted' ? `Proposal ${proposal.publicId} updated.` : `Draft ${proposal.publicId} saved.`)
    } catch (requestError) {
      const requestErrorValue = asApiError(requestError)
      if (requestErrorValue.code === 'PROPOSAL_INVALID') {
        configResource.reload()
        raiseError(new ApiError(requestErrorValue.status, requestErrorValue.code, 'The submission form changed. Review the refreshed fields and try again.', requestErrorValue.requestId, requestErrorValue.issues))
      } else {
        raiseError(requestErrorValue)
      }
    } finally {
      setPending(null)
    }
  }

  const openParticipants = async () => {
    setPending('participants')
    setError(null)
    setSuccess('')
    try {
      const proposal = await persistDraft()
      const result = await cfpApi.proposalParticipants(eventSlug, proposal.id)
      setParticipants(result.participants)
      setStep(3)
    } catch (requestError) {
      const requestErrorValue = asApiError(requestError)
      if (requestErrorValue.code === 'PROPOSAL_INVALID') configResource.reload()
      raiseError(requestErrorValue)
    } finally {
      setPending(null)
    }
  }

  const addCoPresenter = async () => {
    if (!draft || pending) return
    if (!coPresenterName.trim()) {
      raiseError(new ApiError(400, 'VALIDATION_FAILED', 'Enter the co-presenter name before adding them.', undefined, [{ field: 'coPresenterName', message: 'This field is required.' }]))
      return
    }
    setPending('co-presenter-add')
    setError(null)
    setSuccess('')
    try {
      const result = await cfpApi.addCoPresenter(eventSlug, draft.id, {
        name: coPresenterName,
        email: coPresenterEmail.trim() || null,
      })
      setParticipants(result.participants)
      setCoPresenterName('')
      setCoPresenterEmail('')
      setSuccess('Co-presenter added to this proposal.')
    } catch (requestError) {
      raiseError(asApiError(requestError))
    } finally {
      setPending(null)
    }
  }

  const removeCoPresenter = async (presenterId: string) => {
    if (!draft || pending) return
    setPending(`co-presenter-remove:${presenterId}`)
    setError(null)
    setSuccess('')
    try {
      const result = await cfpApi.removeCoPresenter(eventSlug, draft.id, presenterId)
      setParticipants(result.participants)
      setSuccess('Co-presenter removed from this proposal.')
    } catch (requestError) {
      raiseError(asApiError(requestError))
    } finally {
      setPending(null)
    }
  }

  const submitProposal = async () => {
    if (!validateSection('session') || !validateSection('speaker')) return
    setPending('submit')
    setError(null)
    setSuccess('')
    try {
      const wasSubmitted = draft?.status === 'submitted'
      const proposal = await persistDraft()
      const submitted = proposal.status === 'submitted' ? proposal : await cfpApi.submitProposal(eventSlug, proposal.id)
      setDraft(submitted)
      setCompletionAction(wasSubmitted ? 'updated' : 'submitted')
      setComplete(submitted)
      setProposals((current) => [...current.filter((item) => item.id !== submitted.id), submitted])
    } catch (requestError) {
      const requestErrorValue = asApiError(requestError)
      if (requestErrorValue.code === 'PROPOSAL_INVALID') {
        configResource.reload()
        raiseError(new ApiError(requestErrorValue.status, requestErrorValue.code, 'The submission form changed. Review the refreshed fields and try again.', requestErrorValue.requestId, requestErrorValue.issues))
      } else {
        raiseError(requestErrorValue)
      }
    } finally {
      setPending(null)
    }
  }

  const submitStep = (event: SubmitEvent) => {
    event.preventDefault()
    if (pending) return
    if (step === 0) {
      setStep(1)
      return
    }
    if (step === 1) {
      if (identityReady) {
        startAnother()
        return
      }
      void authenticate()
      return
    }
    if (step === 2) {
      if (!validateSection('session')) return
      void openParticipants()
      return
    }
    if (step === 3 && !validateSection('speaker')) return
    if (step < 4) {
      setError(null)
      setStep((current) => current + 1)
      return
    }
    void submitProposal()
  }

  const resumeProposal = (proposal: ProposalResponse) => {
    setDraft(proposal)
    setParticipants([])
    setCoPresenterName('')
    setCoPresenterEmail('')
    setValues(sanitizeProposalValues(config?.fields ?? [], proposal.values))
    setStep(2)
    setError(null)
    setSuccess(`${proposal.status === 'submitted' ? 'Editing' : 'Continuing'} ${proposal.publicId}.`)
  }

  const startAnother = () => {
    setDraftKey(makeDraftKey())
    setDraft(null)
    setParticipants([])
    setCoPresenterName('')
    setCoPresenterEmail('')
    setValues({ speaker_bio: values.speaker_bio ?? bio })
    setError(null)
    setSuccess('')
    setCompletionAction('submitted')
    setComplete(null)
    setStep(2)
  }

  useEffect(() => {
    if (!preferredProposalId || !config || config.state !== 'open' || !identityReady || !proposalsLoaded || preferredProposalHandled.current === preferredProposalId) return
    preferredProposalHandled.current = preferredProposalId
    const proposal = proposals.find((item) => item.id === preferredProposalId)
    if (!proposal || (proposal.status !== 'draft' && proposal.status !== 'submitted')) {
      setStep(1)
      raiseError(new ApiError(404, 'PROPOSAL_NOT_FOUND', 'This proposal is not available to edit. Choose an editable proposal from your account.'))
      return
    }
    setDraft(proposal)
    setParticipants([])
    setCoPresenterName('')
    setCoPresenterEmail('')
    setValues(sanitizeProposalValues(config.fields, proposal.values))
    setStep(2)
    setError(null)
    setSuccess(`${proposal.status === 'submitted' ? 'Editing' : 'Continuing'} ${proposal.publicId}.`)
  }, [config, identityReady, preferredProposalId, proposals, proposalsLoaded])

  if (configResource.status === 'loading' || sessionResource.status === 'loading') return <ResourcePage title="Loading the submission form…" message="Fetching the current event fields and account status." />
  if (configResource.status === 'error') return <ResourcePage title="The submission form could not load." message={configResource.error.message} retry={configResource.reload} />
  if (sessionResource.status === 'error') return <ResourcePage title="Account status could not load." message={sessionResource.error.message} retry={sessionResource.reload} />
  if (!config) return null
  if (config.state === 'closed' && identityReady && session) return <ClosedSubmissionArchive config={config} session={session} proposals={proposals} proposalsLoading={proposalsLoading} proposalsLoaded={proposalsLoaded} proposalsError={error} preferredProposalId={preferredProposalId} />
  if (config.state !== 'open') return <ResourcePage title={config.state === 'upcoming' ? 'Submissions are not open yet.' : 'Submissions are closed.'} message={`${config.event.name} accepts proposals from ${formatDate(config.opensAt)} through ${formatDate(config.closesAt)}.`} />
  if (complete) {
    const summary = proposalSummary(config.fields, complete.values)
    return <div className="role-app"><WorkflowHeader role="Submitter" title={session?.user.displayName ?? 'Speaker'} description="Submission workspace" /><main className="confirmation"><span>✓</span><p className="overline">{complete.publicId} {completionAction}</p><h1>{completionAction === 'updated' ? 'Your proposal has been updated.' : 'Your proposal is in the review queue.'}</h1>{summary && <p>{summary}</p>}<p>{truthfulConfirmationMessage(config.confirmationMessage)}</p><div><button type="button" className="button button-outline" onClick={startAnother}>Submit another proposal</button></div></main></div>
  }

  const proposalCountLabel = `${proposals.length} ${proposals.length === 1 ? 'proposal' : 'proposals'} in this account`
  const editingSubmitted = draft?.status === 'submitted'

  return <div className="role-app"><WorkflowHeader role="Public CFP" title={config.event.name} description={`Closes ${formatDate(config.closesAt)} · ${proposalCountLabel}`} />
    <main className="cfp-shell">
      <ol className="stepper" aria-label="Submission progress" tabIndex={0}>{steps.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? '✓' : index + 1}</span><strong>{label}</strong></li>)}</ol>
      <form className="cfp-form section-card" onSubmit={submitStep}>
        {step === 0 && <><p className="overline">{config.event.name}</p><h1>{config.event.tagline}</h1><p>{config.event.description}</p><div className="cfp-facts"><span><small>Deadline</small><strong>{formatDate(config.closesAt)}</strong></span><span><small>Location</small><strong>{config.event.location}</strong></span><span><small>Fields</small><strong>{config.fields.filter((field) => field.required).length} required</strong></span></div></>}
        {step === 1 && <AccountStep session={session} mode={authMode} pending={pending === 'auth'} displayName={displayName} email={email} password={password} title={speakerTitle} company={company} bio={bio} proposals={accountProposals} proposalsLoading={proposalsLoading} turnstile={config.turnstile} turnstileResetKey={turnstileResetKey} onTurnstileToken={setTurnstileToken} onMode={(mode) => { setAuthMode(mode); setTurnstileToken(null) }} onDisplayName={setDisplayName} onEmail={setEmail} onPassword={setPassword} onTitle={setSpeakerTitle} onCompany={setCompany} onBio={setBio} onResume={resumeProposal} />}
        {step === 2 && <><p className="overline">Submission</p><h1>Tell us about your session.</h1><div className="form-grid">{sessionFields.map((field) => <FieldControl key={field.key} field={field} value={values[field.key] ?? ''} error={fieldError(error?.issues ?? [], field.key)} onChange={(value) => updateValue(field.key, value)} />)}</div></>}
        {step === 3 && <>
          <p className="overline">Participants</p><h1>Who is presenting?</h1>
          <div className="participant-list" aria-label="Proposal participants">{participants.map((participant) => <div className="participant-card" key={participant.id}><span className="avatar avatar-large">{initials(participant.name)}</span><div><strong>{participant.name}</strong><span>{participant.role === 'primary' ? 'Primary presenter' : 'Co-presenter'} · {participant.email ?? 'Email not provided'}</span></div>{participant.role === 'primary' ? <b>Required</b> : <button type="button" className="plain-button" disabled={Boolean(pending)} onClick={() => void removeCoPresenter(participant.id)}>{pending === `co-presenter-remove:${participant.id}` ? 'Removing…' : `Remove ${participant.name}`}</button>}</div>)}</div>
          <fieldset className="co-presenter-editor" disabled={Boolean(pending)}><legend>Add a co-presenter</legend><div className="form-grid"><label htmlFor="co-presenter-name"><span>Name <b aria-hidden="true">*</b></span><input id="co-presenter-name" name="coPresenterName" maxLength={120} value={coPresenterName} aria-invalid={Boolean(fieldError(error?.issues ?? [], 'coPresenterName'))} onChange={(event) => setCoPresenterName(event.target.value)} /></label><label htmlFor="co-presenter-email"><span>Email</span><input id="co-presenter-email" name="coPresenterEmail" type="email" maxLength={254} value={coPresenterEmail} onChange={(event) => setCoPresenterEmail(event.target.value)} /></label></div><button type="button" className="button button-outline" onClick={() => void addCoPresenter()}>{pending === 'co-presenter-add' ? 'Adding…' : 'Add co-presenter'}</button><small>Adding a person does not create or link an account. Organizer invitations remain a separate verified step.</small></fieldset>
          {speakerFields.length > 0 && <div className="form-grid participant-fields">{speakerFields.map((field) => <FieldControl key={field.key} field={field} value={values[field.key] ?? ''} error={fieldError(error?.issues ?? [], field.key)} onChange={(value) => updateValue(field.key, value)} />)}</div>}
        </>}
        {step === 4 && <><p className="overline">Review</p><h1>Ready to submit?</h1><div className="review-dossier">{visibleFields.map((field) => <span key={field.key}><small>{field.label}</small><strong>{displayValue(field, values[field.key]) || 'Not provided'}</strong></span>)}{participants.map((participant) => <span key={participant.id}><small>{participant.role === 'primary' ? 'Primary presenter' : 'Co-presenter'}</small><strong>{participant.name}</strong></span>)}</div><p className="legal-note">By submitting, you confirm this proposal is accurate and may be reviewed by the {config.event.name} program committee.</p></>}
        {error && <div className="form-error" role="alert" tabIndex={-1} ref={errorRef}><strong>{error.message}</strong>{error.requestId && <small> Request {error.requestId}</small>}</div>}
        <p className="save-state" aria-live="polite">{pending === 'auth' ? 'Signing in…' : pending === 'draft' ? editingSubmitted ? 'Updating proposal…' : 'Saving draft…' : pending === 'submit' ? editingSubmitted ? 'Updating proposal…' : 'Submitting proposal…' : pending === 'participants' ? 'Saving the proposal and loading participants…' : success}</p>
        <footer className="form-actions"><button type="button" className="button button-outline" disabled={step === 0 || Boolean(pending)} onClick={() => setStep((current) => Math.max(0, current - 1))}>← Back</button>{step >= 2 && step <= 4 && <button type="button" className="plain-button" disabled={!identityReady || Boolean(pending)} onClick={() => void saveDraft()}>{editingSubmitted ? 'Save proposal changes' : 'Save draft'}</button>}<span />{step < 4 ? <button type="submit" className="button button-primary" disabled={Boolean(pending) || (step === 1 && !session && !identityReady && authMode === 'register' && (!config.turnstile.enabled || !turnstileToken))}>{step === 0 ? 'Start submission' : step === 1 ? identityReady ? 'Start a new proposal' : session ? 'Join as speaker' : authMode === 'register' ? 'Create account' : 'Sign in' : 'Continue'} →</button> : <button type="submit" className="button button-primary" disabled={Boolean(pending)}>{editingSubmitted ? 'Update proposal' : 'Submit proposal'} →</button>}</footer>
      </form>
    </main>
  </div>
}

function AccountStep(props: {
  session: AuthSession | null
  mode: 'register' | 'signin'
  pending: boolean
  displayName: string
  email: string
  password: string
  title: string
  company: string
  bio: string
  proposals: ProposalResponse[]
  proposalsLoading: boolean
  turnstile: CfpPublicConfigResponse['turnstile']
  turnstileResetKey: number
  onTurnstileToken: (token: string | null) => void
  onMode: (mode: 'register' | 'signin') => void
  onDisplayName: (value: string) => void
  onEmail: (value: string) => void
  onPassword: (value: string) => void
  onTitle: (value: string) => void
  onCompany: (value: string) => void
  onBio: (value: string) => void
  onResume: (proposal: ProposalResponse) => void
}) {
  if (props.session) return <><p className="overline">Account</p><h1>Welcome, {props.session.user.displayName}.</h1><div className="identity-card"><span className="avatar avatar-large">{initials(props.session.user.displayName)}</span><div><strong>{props.session.user.displayName}</strong><span>{props.session.user.email}</span></div></div><p>Your drafts and submitted proposals stay connected to this account.</p>{props.proposalsLoading ? <p className="resource-note">Loading your proposals…</p> : props.proposals.length > 0 && <div className="resume-list"><p className="overline">Your proposals</p>{props.proposals.map((proposal) => { const state = proposal.decision === 'accept' ? 'Accepted' : proposal.decision === 'reject' ? 'Rejected' : proposal.decision === 'waitlist' ? 'Waitlisted' : proposal.status === 'in_review' ? 'In review' : proposal.status === 'submitted' ? 'Submitted' : proposal.status === 'draft' ? 'Draft' : 'Decision recorded'; return proposal.status === 'draft' || proposal.status === 'submitted' ? <button type="button" key={proposal.id} onClick={() => props.onResume(proposal)}><span><strong>{proposal.values.title || (proposal.status === 'draft' ? 'Untitled draft' : 'Untitled proposal')}</strong><small>{proposal.publicId} · {state}</small></span><b>{proposal.status === 'submitted' ? 'Edit proposal' : 'Continue'} →</b></button> : <article key={proposal.id}><span><strong>{proposal.values.title || 'Untitled proposal'}</strong><small>{proposal.publicId} · {state}</small></span><b>{state}</b></article> })}</div>}</>
  return <><p className="overline">Account</p><h1>{props.mode === 'register' ? 'Create your speaker account.' : 'Welcome back.'}</h1><div className="auth-switch" role="group" aria-label="Account action"><button type="button" className={props.mode === 'register' ? 'active' : ''} onClick={() => props.onMode('register')}>Create account</button><button type="button" className={props.mode === 'signin' ? 'active' : ''} onClick={() => props.onMode('signin')}>Sign in</button></div><div className="form-grid account-fields">{props.mode === 'register' && <><label className="wide">Full name <b>*</b><input name="displayName" required minLength={2} maxLength={120} autoComplete="name" value={props.displayName} onChange={(event) => props.onDisplayName(event.target.value)} /></label><label>Role or title<input name="title" maxLength={160} autoComplete="organization-title" value={props.title} onChange={(event) => props.onTitle(event.target.value)} /></label><label>Company<input name="company" maxLength={160} autoComplete="organization" value={props.company} onChange={(event) => props.onCompany(event.target.value)} /></label><label className="wide">Short biography<textarea name="bio" maxLength={4_000} value={props.bio} onChange={(event) => props.onBio(event.target.value)} /></label></>}<label className="wide">Email <b>*</b><input name="email" type="email" required maxLength={254} autoComplete="email" value={props.email} onChange={(event) => props.onEmail(event.target.value)} /></label><label className="wide">Password <b>*</b><input name="password" type="password" required minLength={props.mode === 'register' ? 12 : 1} maxLength={128} autoComplete={props.mode === 'register' ? 'new-password' : 'current-password'} value={props.password} onChange={(event) => props.onPassword(event.target.value)} /><small>{props.mode === 'register' ? 'Use at least 12 characters.' : 'Enter the password for your account.'}</small></label></div>{props.mode === 'register' && (props.turnstile.enabled ? <TurnstileWidget siteKey={props.turnstile.siteKey} resetKey={props.turnstileResetKey} onToken={props.onTurnstileToken} /> : <div className="form-error" role="status">Account verification is temporarily unavailable. Existing speakers can still sign in.</div>)}{props.pending && <p className="resource-note">Securing your account…</p>}</>
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'SP'
}

function displayValue(field: CfpField, value = '') {
  if (field.type !== 'dropdown') return value
  return field.options.find((option) => option.value === value)?.label ?? value
}

function inputDateTime(value: string) {
  const date = new Date(value)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

const canonicalCfpFieldKeys = new Set(['title', 'abstract', 'track', 'format'])

function orderedFields(fields: CfpField[]) {
  return fields.map((field, index) => ({ ...field, sortOrder: (index + 1) * 10 }))
}

function customFieldKey() {
  return `custom_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function previewControl(field: CfpField, value: string, onChange: (value: string) => void) {
  if (field.type === 'dropdown') return <select aria-label={`${field.label} preview`} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select {field.label.toLowerCase()}</option>{field.options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
  if (field.type === 'long_text') return <textarea aria-label={`${field.label} preview`} value={value} onChange={(event) => onChange(event.target.value)} />
  return <input aria-label={`${field.label} preview`} value={value} onChange={(event) => onChange(event.target.value)} />
}

export function CfpAdmin({ eventSlug }: { eventSlug: string }) {
  const resource = useApiResource((signal) => cfpApi.organizerConfig(eventSlug, signal), [eventSlug])
  const [config, setConfig] = useState<CfpPublicConfigResponse | null>(null)
  const [savedConfig, setSavedConfig] = useState<CfpPublicConfigResponse | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<ApiError | null>(null)
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit')
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({})

  useEffect(() => {
    if (resource.status === 'success') {
      const normalized = withTruthfulConfirmation(resource.data)
      setConfig(normalized)
      setSavedConfig(normalized)
      setError(null)
    }
    if (resource.status === 'error') {
      const resourceError = asApiError(resource.error)
      if (isAccessError(resourceError)) setConfig(null)
      setError(resourceError)
    }
  }, [resource.status, resource.data, resource.error])

  const signIn = async (event: SubmitEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      const session = await cfpApi.login({ email, password })
      const organizer = session.memberships.some((membership) => membership.eventSlug === eventSlug && membership.role === 'organizer')
      if (!organizer) throw new ApiError(403, 'FORBIDDEN', `This account is not an organizer for ${eventSlug}.`)
      setPassword('')
      resource.reload()
    } catch (requestError) {
      const signInError = asApiError(requestError)
      if (isAccessError(signInError)) setConfig(null)
      setError(signInError)
    } finally {
      setPending(false)
    }
  }

  const save = async () => {
    if (!config) return
    setPending(true)
    setMessage('')
    setError(null)
    try {
      const saved = await cfpApi.updateOrganizerConfig(eventSlug, {
        expectedRevision: config.revision,
        event: {
          name: config.event.name,
          tagline: config.event.tagline,
          location: config.event.location,
          description: config.event.description,
          startsOn: config.event.startsOn,
          endsOn: config.event.endsOn,
        },
        status: config.status,
        opensAt: config.opensAt,
        closesAt: config.closesAt,
        confirmationMessage: config.confirmationMessage,
        fields: config.fields,
      })
      setConfig(saved)
      setSavedConfig(saved)
      setMessage(`Saved version ${saved.revision}.`)
    } catch (requestError) {
      const saveError = asApiError(requestError)
      if (saveError.code === 'CFP_REVISION_CONFLICT') setMessage('Reload the latest version before saving your changes.')
      if (isAccessError(saveError)) setConfig(null)
      setMobileView('edit')
      setError(saveError)
    } finally {
      setPending(false)
    }
  }

  if (resource.status === 'loading' && !config) return <main className="page"><PageHeader eyebrow="Program · Call for Proposals" title="Submission form" description="Loading the current event configuration…" /></main>
  if (error?.code === 'FORBIDDEN') return <main className="page"><PageHeader eyebrow="Program · Call for Proposals" title="Access denied" description={`This account is not an organizer for ${eventSlug}.`} /><div className="form-error" role="alert">{error.message}</div></main>
  if (error?.code === 'UNAUTHENTICATED') return <main className="page"><PageHeader eyebrow="Program · Call for Proposals" title="Organizer sign in" description="Sign in to edit this event’s submission-form configuration." /><form className="section-card admin-auth" onSubmit={signIn}><label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><div className="form-error" role="alert">{error.message}</div><button className="button button-primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button></form></main>
  if (!config) return <main className="page"><PageHeader eyebrow="Program · Call for Proposals" title="Submission form unavailable" description={error?.message ?? 'The configuration could not be loaded.'} action={<button type="button" className="button button-primary" onClick={resource.reload}>Try again</button>} /></main>

  const updateEvent = (key: 'name' | 'tagline' | 'location' | 'description' | 'startsOn' | 'endsOn', value: string) => {
    setConfig({ ...config, event: { ...config.event, [key]: value } })
  }
  const updateField = (key: string, update: (field: CfpField) => CfpField) => {
    setConfig({ ...config, fields: config.fields.map((field) => field.key === key ? update(field) : field) })
  }
  const changeFieldType = (key: string, type: CfpField['type']) => {
    setConfig({
      ...config,
      fields: config.fields.map((field) => {
        if (field.key === key) return { ...field, type, options: type === 'dropdown' ? [{ value: 'option_1', label: 'Option 1' }] : [], showWhen: null }
        if (type !== 'dropdown' && field.showWhen?.fieldKey === key) return { ...field, showWhen: null }
        return field
      }),
    })
  }
  const updateDropdownOptions = (key: string, options: CfpField['options']) => {
    const seen = new Set<string>()
    const uniqueOptions = options.filter(({ value }) => {
      if (seen.has(value)) return false
      seen.add(value)
      return true
    })
    const validValues = new Set(uniqueOptions.map(({ value }) => value))
    setConfig({
      ...config,
      fields: config.fields.map((field) => {
        if (field.key === key) return { ...field, options: uniqueOptions }
        if (field.showWhen?.fieldKey === key && !validValues.has(field.showWhen.equals)) {
          return { ...field, showWhen: uniqueOptions[0] ? { fieldKey: key, equals: uniqueOptions[0].value } : null }
        }
        return field
      }),
    })
  }
  const moveField = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= config.fields.length) return
    const fields = [...config.fields]
    ;[fields[index], fields[target]] = [fields[target], fields[index]]
    setConfig({ ...config, fields: orderedFields(fields) })
  }
  const addField = () => {
    const key = customFieldKey()
    setConfig({ ...config, fields: orderedFields([...config.fields, { key, section: 'session', type: 'short_text', label: 'New question', helpText: '', required: false, options: [], sortOrder: 0, showWhen: null }]) })
  }
  const removeField = (key: string) => {
    if (canonicalCfpFieldKeys.has(key)) return
    setConfig({ ...config, fields: orderedFields(config.fields.filter((field) => field.key !== key).map((field) => field.showWhen?.fieldKey === key ? { ...field, showWhen: null } : field)) })
  }
  const dropdownSources = config.fields.filter((field) => field.type === 'dropdown')
  const isDirty = savedConfig !== null && JSON.stringify(config) !== JSON.stringify(savedConfig)

  return <main className="page">
    <PageHeader eyebrow="Program · Call for Proposals" title="Customize submission form" description="Edit event copy and questions while the public preview updates before you save." action={<div className="split-actions"><Link to={eventWorkspacePath(eventSlug, 'submit')} className="button button-outline">Open saved public form ↗</Link><button type="button" className="button button-primary" disabled={pending || !isDirty} onClick={() => void save()}>{pending ? 'Saving…' : 'Save changes'}</button></div>} />
    <div className="customization-tabs" role="tablist" aria-label="Customization view"><button type="button" role="tab" aria-selected={mobileView === 'edit'} onClick={() => setMobileView('edit')}>Edit</button><button type="button" role="tab" aria-selected={mobileView === 'preview'} onClick={() => setMobileView('preview')}>Preview</button></div>
    <div className={`customization-layout mobile-${mobileView}`}>
      <section className="customization-editor" aria-label="Submission form editor">
        <section className="section-card customization-section connected-inspector"><div className="builder-title"><div><p className="overline">Event identity</p><h2>Public event copy</h2></div><span className={`status-badge ${config.status === 'published' ? 'status-live' : 'status-draft'}`}>● {config.status === 'published' ? 'Published' : 'Draft'}</span></div><div className="customization-grid"><label>Event name<input value={config.event.name} maxLength={200} onChange={(event) => updateEvent('name', event.target.value)} /></label><label>Tagline<input value={config.event.tagline} maxLength={500} onChange={(event) => updateEvent('tagline', event.target.value)} /></label><label className="wide">Description<textarea value={config.event.description} maxLength={20_000} onChange={(event) => updateEvent('description', event.target.value)} /></label><label>Location<input value={config.event.location} maxLength={500} onChange={(event) => updateEvent('location', event.target.value)} /></label><label>Starts<input type="date" value={config.event.startsOn} onChange={(event) => updateEvent('startsOn', event.target.value)} /></label><label>Ends<input type="date" value={config.event.endsOn} onChange={(event) => updateEvent('endsOn', event.target.value)} /></label></div></section>
        <section className="section-card customization-section connected-inspector"><p className="overline">Publication</p><div className="customization-grid"><label>Status<select value={config.status} onChange={(event) => setConfig({ ...config, status: event.target.value as 'draft' | 'published' })}><option value="draft">Draft</option><option value="published">Published</option></select></label><label>Opens<input type="datetime-local" required value={inputDateTime(config.opensAt)} onChange={(event) => { if (event.target.value) setConfig({ ...config, opensAt: toContractDateTime(event.target.value) }) }} /></label><label>Closes<input type="datetime-local" required value={inputDateTime(config.closesAt)} onChange={(event) => { if (event.target.value) setConfig({ ...config, closesAt: toContractDateTime(event.target.value) }) }} /></label><label className="wide">Confirmation message<textarea required value={config.confirmationMessage} maxLength={1_000} onChange={(event) => setConfig({ ...config, confirmationMessage: event.target.value })} /></label></div></section>
        <section className="section-card customization-section"><div className="builder-title"><div><p className="overline">Questions</p><h2>Submission fields</h2></div><button type="button" className="button button-outline" onClick={addField}>Add field</button></div><div className="custom-field-stack">{config.fields.map((field, index) => {
          const canonical = canonicalCfpFieldKeys.has(field.key)
          const source = dropdownSources.find(({ key }) => key === field.showWhen?.fieldKey)
          return <fieldset className="custom-field-card connected-inspector" key={field.key}><legend>{field.label || field.key}</legend><div className="field-card-actions"><button type="button" aria-label={`Move ${field.label} up`} disabled={index === 0} onClick={() => moveField(index, -1)}>↑</button><button type="button" aria-label={`Move ${field.label} down`} disabled={index === config.fields.length - 1} onClick={() => moveField(index, 1)}>↓</button><button type="button" aria-label={`Remove ${field.label}`} disabled={canonical} title={canonical ? 'Required canonical field' : undefined} onClick={() => removeField(field.key)}>Remove</button></div><div className="customization-grid"><label>Key<input value={field.key} disabled title="Stable answer identifier" /></label><label>Label<input value={field.label} maxLength={160} onChange={(event) => updateField(field.key, (current) => ({ ...current, label: event.target.value }))} /></label><label>Section<select value={field.section} onChange={(event) => updateField(field.key, (current) => ({ ...current, section: event.target.value as CfpField['section'] }))}><option value="session">Session</option><option value="speaker">Speaker</option></select></label><label>Type<select value={field.type} disabled={canonical} onChange={(event) => changeFieldType(field.key, event.target.value as CfpField['type'])}><option value="short_text">Short text</option><option value="long_text">Long text</option><option value="dropdown">Dropdown</option></select></label><label className="wide">Help text<input value={field.helpText} maxLength={500} onChange={(event) => updateField(field.key, (current) => ({ ...current, helpText: event.target.value }))} /></label><label className="check-row"><input type="checkbox" checked={field.required} disabled={canonical} onChange={(event) => updateField(field.key, (current) => ({ ...current, required: event.target.checked }))} /> Required</label>{field.type === 'dropdown' && <label className="wide">Options <small>One per line as value | label{field.key === 'format' ? '; canonical values and durations stay fixed.' : '.'}</small><textarea value={field.options.map((option) => `${option.value} | ${option.label}`).join('\n')} disabled={field.key === 'format'} onChange={(event) => updateDropdownOptions(field.key, event.target.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [value, ...label] = line.split('|'); return { value: value.trim(), label: (label.join('|').trim() || value.trim()) } }))} /></label>}{!canonical && <label>Visible when<select value={field.showWhen?.fieldKey ?? ''} onChange={(event) => updateField(field.key, (current) => ({ ...current, showWhen: event.target.value ? { fieldKey: event.target.value, equals: dropdownSources.find(({ key }) => key === event.target.value)?.options[0]?.value ?? '' } : null }))}><option value="">Always visible</option>{dropdownSources.filter(({ key }) => key !== field.key).map((candidate) => <option value={candidate.key} key={candidate.key}>{candidate.label}</option>)}</select></label>}{field.showWhen && <label>Equals<select value={field.showWhen.equals} onChange={(event) => updateField(field.key, (current) => ({ ...current, showWhen: current.showWhen ? { ...current.showWhen, equals: event.target.value } : null }))}>{source?.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}</div></fieldset>
        })}</div></section>
        <div className="customization-save"><div className="inspector-note"><strong>Saved version {config.revision}</strong><span>Preview changes remain local until Save.</span></div>{error && <div className="form-error" role="alert"><strong>{error.message}</strong>{error.issues.length > 0 && <ul>{error.issues.map((issue) => <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>)}</ul>}{error.code === 'CFP_REVISION_CONFLICT' && <button type="button" className="plain-button" onClick={resource.reload}>Reload latest version</button>}</div>}<p className="save-state" aria-live="polite">{message}</p><button type="button" className="button button-primary" disabled={pending || !isDirty} onClick={() => void save()}>{pending ? 'Saving…' : 'Save changes'}</button></div>
      </section>
      <aside className="customization-preview" aria-label="Public CFP preview"><div className="preview-sticky"><div className="preview-toolbar"><span>Live preview</span><small>{isDirty ? 'Unsaved changes' : `Saved version ${config.revision}`}</small></div><div className="cfp-live-preview"><p className="overline">{config.event.name}</p><h2>{config.event.tagline}</h2><p>{config.event.description}</p><div className="cfp-facts"><span><small>Deadline</small><strong>{formatDate(config.closesAt)}</strong></span><span><small>Location</small><strong>{config.event.location}</strong></span></div><div className="preview-field-list">{config.fields.filter((field) => visibleField(field, previewValues)).map((field) => <label key={field.key}><span>{field.label}{field.required && ' *'}</span>{field.helpText && <small>{field.helpText}</small>}{previewControl(field, previewValues[field.key] ?? '', (value) => setPreviewValues((current) => ({ ...current, [field.key]: value })))}</label>)}</div></div></div></aside>
    </div>
  </main>
}
