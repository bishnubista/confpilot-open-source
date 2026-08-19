import type { ProgramOperatorBriefResponse } from '@confpilot/contracts'

import { programOperatorApi } from './api'
import { eventWorkspacePath } from './session'
import { Link } from './ui'
import { useApiResource } from './useApiResource'

type Risk = ProgramOperatorBriefResponse['risks'][number]
type PlanItem = ProgramOperatorBriefResponse['plan'][number]

const severityLabels: Record<Risk['severity'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

function Evidence({ brief, evidenceIds }: { brief: ProgramOperatorBriefResponse; evidenceIds: string[] }) {
  const records = evidenceIds.flatMap((id) => {
    const evidence = brief.evidence.find((candidate) => candidate.id === id)
    return evidence ? [evidence] : []
  })
  return <details className="operator-evidence"><summary>Evidence ({records.length})</summary><ul>{records.map((record) => <li key={record.id}><strong>{record.source.replaceAll('_', ' ')}</strong><span>{record.recordId}</span><small>{record.fields.join(', ')}</small></li>)}</ul></details>
}

function operatorAction(suggestedResolution: string, eventSlug: string, scoped: boolean) {
  const match = suggestedResolution.match(/^(.*) at (\/admin\/\S+)\.$/)
  if (!match) return null
  const adminTail = match[2].slice('/admin/'.length)
  return { label: match[1], href: scoped ? `${eventWorkspacePath(eventSlug, 'admin')}/${adminTail}` : match[2] }
}

function RiskItem({ brief, risk, eventSlug, scoped }: { brief: ProgramOperatorBriefResponse; risk: Risk; eventSlug: string; scoped: boolean }) {
  const action = operatorAction(risk.suggestedResolution, eventSlug, scoped)
  return <article className="operator-risk"><div className="operator-risk-rank">{risk.rank}</div><div><div className="operator-risk-heading"><span className={`operator-severity operator-severity-${risk.severity}`}>{severityLabels[risk.severity]}</span><span>{risk.confidence} confidence</span></div><h3>{risk.title}</h3><p>{risk.explanation}</p><dl><div><dt>Affected</dt><dd>{risk.affectedRecords.map((record) => record.label).join(' · ')}</dd></div><div><dt>Suggested resolution</dt><dd>{action ? <>{action.label}. <Link to={action.href}>Open record <span aria-hidden="true">→</span></Link></> : risk.suggestedResolution}</dd></div></dl><Evidence brief={brief} evidenceIds={risk.evidenceIds} /></div></article>
}

function DraftItem({ brief, item }: { brief: ProgramOperatorBriefResponse; item: PlanItem }) {
  return <details className="operator-draft"><summary><span><strong>{item.recipient.name}</strong><small>{item.kind === 'speaker_reminder' ? 'Speaker reminder' : 'Reviewer reminder'}</small></span><span>Review draft</span></summary><div className="operator-draft-body"><div className="operator-recipient"><span>To</span><strong>{item.recipient.name}</strong><code>{item.recipient.email}</code></div><div className="operator-message"><small>Subject</small><strong>{item.draft.subject}</strong><pre>{item.draft.text}</pre></div><div className="operator-approval"><span>Human approval required</span><p>{item.expectedStateChange}</p></div><Evidence brief={brief} evidenceIds={item.evidenceIds} /></div></details>
}

function Brief({ brief, eventSlug, scoped, onRefresh }: { brief: ProgramOperatorBriefResponse; eventSlug: string; scoped: boolean; onRefresh: () => void }) {
  const { summary } = brief
  const statusLabel = summary.status === 'complete' ? 'Clear' : 'Action needed'
  const visibleRisks = brief.risks.slice(0, 5)
  const remainingRisks = brief.risks.slice(5)
  return <section className="section-card operator-brief" aria-labelledby="operator-brief-heading">
    <div className="operator-brief-header"><div><p className="overline">Program Operator · Shadow mode</p><h2 id="operator-brief-heading">Today’s program brief</h2><p>Grounded in the latest event records. Review suggested work before anything is queued or sent.</p></div><div className="operator-brief-status"><span className={`operator-status operator-status-${summary.status}`}>{statusLabel}</span><button type="button" className="button button-outline" onClick={onRefresh}>Refresh brief</button></div></div>
    <div className="operator-metrics" aria-label="Daily brief summary"><span><strong>{summary.riskCount}</strong> ranked {summary.riskCount === 1 ? 'risk' : 'risks'}</span><span><strong>{summary.reminderDraftCount}</strong> reminder {summary.reminderDraftCount === 1 ? 'draft' : 'drafts'}</span><span><strong>{summary.exceptionCount}</strong> {summary.exceptionCount === 1 ? 'exception' : 'exceptions'}</span><span><strong>{summary.publishReadySessions}/{summary.acceptedSessions}</strong> publish-ready</span></div>
    <div className="operator-mode-note" role="note"><strong>Draft only.</strong> Nothing has been queued or sent. Every communication still requires human approval.</div>
    <div className="operator-section"><div className="card-heading"><div><p className="overline">Today</p><h3>Highest-risk work</h3></div><span className="count-pill">{summary.riskCount}</span></div>{brief.risks.length === 0 ? <div className="operator-empty"><strong>No risks need attention.</strong><span>The current snapshot is clear.</span></div> : <div className="operator-risk-list">{visibleRisks.map((risk) => <RiskItem key={risk.id} brief={brief} risk={risk} eventSlug={eventSlug} scoped={scoped} />)}{remainingRisks.length > 0 && <details className="operator-more"><summary>Show {remainingRisks.length} more ranked {remainingRisks.length === 1 ? 'risk' : 'risks'}</summary><div>{remainingRisks.map((risk) => <RiskItem key={risk.id} brief={brief} risk={risk} eventSlug={eventSlug} scoped={scoped} />)}</div></details>}</div>}</div>
    <div className="operator-columns"><section className="operator-section" aria-labelledby="operator-plan-heading"><div className="card-heading"><div><p className="overline">Agent plan</p><h3 id="operator-plan-heading">Drafts awaiting approval</h3></div><span className="count-pill">{summary.reminderDraftCount}</span></div>{brief.plan.length === 0 ? <div className="operator-empty"><strong>No reminders proposed.</strong><span>ConfPilot found no safe exact-recipient draft to prepare.</span></div> : <div className="operator-draft-list">{brief.plan.map((item) => <DraftItem key={item.id} brief={brief} item={item} />)}</div>}</section><section className="operator-section" aria-labelledby="operator-exceptions-heading"><div className="card-heading"><div><p className="overline">Exceptions</p><h3 id="operator-exceptions-heading">Needs organizer judgment</h3></div><span className="count-pill">{summary.exceptionCount}</span></div>{brief.exceptions.length === 0 ? <div className="operator-empty"><strong>No exceptions.</strong><span>Every proposed item passed the current policy checks.</span></div> : <div className="operator-exception-list">{brief.exceptions.map((exception) => <article key={exception.id}><h4>{exception.title}</h4><p>{exception.explanation}</p><Evidence brief={brief} evidenceIds={exception.evidenceIds} /></article>)}</div>}</section></div>
    <footer className="operator-snapshot"><span>Latest snapshot</span><time dateTime={brief.snapshot.capturedAt}>{new Date(brief.snapshot.capturedAt).toLocaleString()}</time><code title={brief.snapshot.fingerprint}>{brief.snapshot.fingerprint.slice(0, 12)}</code><span>{brief.snapshot.evidenceCount} evidence records</span></footer>
  </section>
}

export function ConnectedProgramOperatorBrief({ eventSlug, scoped }: { eventSlug: string; scoped: boolean }) {
  const resource = useApiResource((signal) => programOperatorApi.dailyBrief(eventSlug, signal), [eventSlug])
  if (resource.status === 'loading') return <section className="section-card operator-brief operator-brief-loading" role="status"><p className="overline">Program Operator</p><h2>Preparing today’s program brief…</h2></section>
  if (resource.status === 'error') return <section className="section-card operator-brief operator-brief-error" role="alert"><div><p className="overline">Program Operator</p><h2>Daily brief unavailable</h2><p>{resource.error.message}</p></div><button type="button" className="button button-outline" onClick={resource.reload}>Try again</button></section>
  return <Brief brief={resource.data} eventSlug={eventSlug} scoped={scoped} onRefresh={resource.reload} />
}
