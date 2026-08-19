import type { ProgramReadinessBlockerKind, ProgramReadinessResponse } from '@confpilot/contracts'
import { useEffect } from 'react'

import { readinessApi } from './api'
import { ConnectedProgramOperatorBrief } from './ConnectedProgramOperatorBrief'
import { eventWorkspacePath } from './session'
import { Link, PageHeader } from './ui'
import { useApiResource } from './useApiResource'

const blockerLabels: Record<ProgramReadinessBlockerKind, string> = {
  speaker_profile_incomplete: 'Speaker',
  speaker_tasks_incomplete: 'Tasks',
  deliverable_missing: 'Missing file',
  deliverable_unapproved: 'File review',
  content_approval_pending: 'Approval',
  session_unscheduled: 'Schedule',
  speaker_conflict: 'Conflict',
  publication_pending: 'Publish',
}

const blockerGroupDefinitions: readonly { id: string; label: string; kinds: readonly ProgramReadinessBlockerKind[] }[] = [
  { id: 'speakers', label: 'Speaker readiness', kinds: ['speaker_profile_incomplete', 'speaker_tasks_incomplete'] },
  { id: 'content', label: 'Files and approvals', kinds: ['deliverable_missing', 'deliverable_unapproved', 'content_approval_pending'] },
  { id: 'schedule', label: 'Schedule', kinds: ['session_unscheduled', 'speaker_conflict'] },
  { id: 'publish', label: 'Publish', kinds: ['publication_pending'] },
]

function workspaceActionPath(eventSlug: string, actionPath: string, scoped: boolean) {
  if (!scoped) return actionPath
  const url = new URL(actionPath, window.location.origin)
  const adminTail = url.pathname.slice('/admin'.length).replace(/^\//, '')
  const base = eventWorkspacePath(eventSlug, 'admin')
  return `${base}${adminTail ? `/${adminTail}` : ''}${url.search}`
}

function ProofLinks({ eventSlug, scoped }: { eventSlug: string; scoped: boolean }) {
  const programPath = scoped ? eventWorkspacePath(eventSlug, 'program') : '/program'
  const embedPath = scoped ? `${eventWorkspacePath(eventSlug, 'admin')}/embeds` : '/admin/embeds'
  return <section className="section-card readiness-proof"><div><p className="overline">Publication proof</p><h2>Verify the attendee outputs</h2><p>The same published records feed the program, saved embeds, and calendar export.</p></div><div className="readiness-proof-links"><Link to={programPath} className="button button-outline">Public program ↗</Link><Link to={embedPath} className="button button-outline">Saved embeds</Link><a className="button button-outline" href={`/api/program.ics?event=${encodeURIComponent(eventSlug)}`}>Calendar (.ics) ↗</a></div></section>
}

function Cockpit({ data, eventSlug, scoped }: { data: ProgramReadinessResponse; eventSlug: string; scoped: boolean }) {
  const { summary } = data
  const title = summary.accepted === 0
    ? 'No accepted sessions yet'
    : `${summary.publishReady} of ${summary.accepted} accepted sessions are publish-ready`
  const blockerGroups = blockerGroupDefinitions.map((group) => ({
    ...group,
    blockers: data.blockers.filter((blocker) => group.kinds.includes(blocker.kind)),
  })).filter((group) => group.blockers.length > 0)
  return <main className="page readiness-cockpit">
    <PageHeader eyebrow={`${data.event.name} · Live readiness`} title="Program operations overview" description="See what is ready, what is blocked, and where to fix it." action={<Link to={scoped ? `${eventWorkspacePath(eventSlug, 'admin')}/agenda` : '/admin/agenda'} className="button button-primary">Open schedule <span>→</span></Link>} />
    <ConnectedProgramOperatorBrief eventSlug={eventSlug} scoped={scoped} />
    <section className="section-card readiness-card" aria-labelledby="readiness-heading"><div className="card-heading"><div><p className="overline">Program readiness</p><h2 id="readiness-heading">{title}</h2></div><div className="readiness-score"><strong>{summary.percent}%</strong><span>{summary.blocked} {summary.blocked === 1 ? 'session' : 'sessions'} blocked</span></div></div><div className="lifecycle" aria-label="Program readiness lifecycle">{data.lifecycle.map((stage) => <div className="lifecycle-stage" key={stage.stage}><div className="stage-top"><span>{stage.label}</span><strong>{stage.count}</strong></div><div className="progress"><i style={{ width: `${stage.total === 0 ? 0 : Math.round(stage.count / stage.total * 100)}%` }} /></div><small>{stage.count} of {stage.total}</small></div>)}</div></section>
    <section className="section-card readiness-actions" aria-labelledby="readiness-actions-heading"><div className="card-heading"><div><p className="overline">What needs attention</p><h2 id="readiness-actions-heading">Next steps</h2></div><span className="count-pill">{data.blockers.length}</span></div>{summary.accepted === 0 ? <div className="empty-state"><h3>Accept a proposal to start tracking readiness.</h3><p>Accepted sessions will appear here with the next step needed to publish them.</p></div> : data.blockers.length === 0 ? <div className="empty-state readiness-clear"><h3>Every accepted session is published and clear.</h3><p>Use the attendee outputs below to verify the public program.</p></div> : <><p className="resource-note">{summary.blocked} blocked {summary.blocked === 1 ? 'session' : 'sessions'}. Actions are grouped by the team workflow that can resolve them.</p><div className="readiness-action-groups">{blockerGroups.map((group, index) => <details key={group.id} open={index === 0}><summary><span>{group.label}</span><span>{group.blockers.length}</span></summary><div className="attention-list">{group.blockers.map((blocker) => <Link to={workspaceActionPath(eventSlug, blocker.actionPath, scoped)} className="attention-row readiness-action-row" key={blocker.id}><span className={`severity readiness-kind readiness-kind-${blocker.kind}`}>{blockerLabels[blocker.kind]}</span><span><strong>{blocker.entityLabel}</strong><small>{blocker.rule}</small><em>{blocker.explanation}</em></span><b aria-hidden="true">→</b><span className="sr-only">{blocker.actionLabel}</span></Link>)}</div></details>)}</div></>}</section>
    <ProofLinks eventSlug={eventSlug} scoped={scoped} />
  </main>
}

export function ConnectedReadinessCockpit({ eventSlug, scoped }: { eventSlug: string; scoped: boolean }) {
  const resource = useApiResource((signal) => readinessApi.get(eventSlug, signal), [eventSlug])
  useEffect(() => {
    const refreshVisiblePage = () => {
      if (document.visibilityState === 'visible') resource.reload()
    }
    window.addEventListener('pageshow', refreshVisiblePage)
    window.addEventListener('focus', refreshVisiblePage)
    document.addEventListener('visibilitychange', refreshVisiblePage)
    return () => {
      window.removeEventListener('pageshow', refreshVisiblePage)
      window.removeEventListener('focus', refreshVisiblePage)
      document.removeEventListener('visibilitychange', refreshVisiblePage)
    }
  }, [resource.reload])
  if (resource.status === 'loading') return <main className="page" role="status"><PageHeader eyebrow="Program readiness" title="Loading program operations…" description="Calculating the accepted-session lifecycle from current records." /></main>
  if (resource.status === 'error') return <main className="page"><PageHeader eyebrow="Program readiness" title="Readiness unavailable" description={resource.error.message} action={<button type="button" className="button button-primary" onClick={resource.reload}>Try again</button>} /></main>
  return <Cockpit data={resource.data} eventSlug={eventSlug} scoped={scoped} />
}
