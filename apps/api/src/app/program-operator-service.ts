import {
  normalizedEmailSchema,
  type ProgramOperatorBriefResponse,
  type ProgramReadinessResponse,
} from "@confpilot/contracts";

import {
  SpeakerReminderIneligibleError,
  renderSpeakerReminderPreview,
} from "../speaker-reminders";
import { renderReviewerReminderPreview } from "../reviewer-reminders";
import type { Database } from "../runtime/database";
import { getProgramReadiness } from "./program-readiness-service";

const STALE_OUTBOX_HOURS = 24;
const MAX_RISKS = 100;
const MAX_PLAN_ITEMS = 50;
const MAX_EXCEPTIONS = 50;

interface EventRow {
  id: string;
  slug: string;
  name: string;
}

interface SpeakerRow {
  id: string;
  eventSlug: string;
  eventName: string;
  name: string;
  contactEmail: string;
  userId: string | null;
  hasSpeakerMembership: number;
  workflowStatus: "invited" | "confirmed" | "declined";
  profileStatus: "incomplete" | "ready";
  agreementStatus: "missing" | "signed";
  publicVisibility: "private" | "published";
  headshotObjectKey: string | null;
}

interface SpeakerTaskRow {
  id: string;
  speakerId: string;
  speakerName: string;
  sessionId: string;
  sessionTitle: string;
  label: string;
  dueAt: string | null;
}

interface DeliverableRow {
  id: string;
  sessionId: string;
  sessionTitle: string;
  speakerId: string;
  speakerName: string;
  label: string;
  dueAt: string;
  latestVersionId: string | null;
  latestReviewOutcome: "changes_requested" | "approved" | null;
}

interface SpeakerSessionRow {
  speakerId: string;
  id: string;
  title: string;
  deliverablesStatus: "missing" | "submitted" | "ready";
}

interface ReviewAssignmentRow {
  id: string;
  proposalId: string;
  proposalTitle: string;
  reviewerUserId: string;
  reviewerName: string;
  reviewerEmail: string;
  reviewRoundId: string | null;
  dueAt: string | null;
}

interface MessageOutboxRow {
  id: string;
  recipientName: string;
  state: "queued" | "leased" | "failed";
  updatedAt: string;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
}

interface NotificationOutboxRow {
  id: string;
  recipientName: string;
  state: "pending" | "failed";
  queuedAt: string;
  failureMessage: string | null;
}

type Evidence = ProgramOperatorBriefResponse["evidence"][number];
type Risk = ProgramOperatorBriefResponse["risks"][number];
type RankedRisk = Omit<Risk, "rank"> & { score: number };

export class ProgramOperatorEventNotFoundError extends Error {}

function utcSecond(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError("now must be a UTC timestamp with second precision");
  }
  return value;
}

function evidenceId(source: Evidence["source"], recordId: string) {
  return `${source}:${recordId}`;
}

function addEvidence(ledger: Map<string, Evidence>, value: Omit<Evidence, "id">) {
  const id = evidenceId(value.source, value.recordId);
  const existing = ledger.get(id);
  ledger.set(id, existing
    ? { ...existing, fields: [...new Set([...existing.fields, ...value.fields])].sort() }
    : { id, ...value, fields: [...value.fields].sort() });
  return id;
}

function readinessSeverity(kind: ProgramReadinessResponse["blockers"][number]["kind"]): Risk["severity"] {
  if (kind === "speaker_conflict") return "critical";
  if (["speaker_profile_incomplete", "speaker_tasks_incomplete", "deliverable_missing", "deliverable_unapproved"].includes(kind)) {
    return "high";
  }
  return "medium";
}

function readinessScore(kind: ProgramReadinessResponse["blockers"][number]["kind"]) {
  const scores: Record<ProgramReadinessResponse["blockers"][number]["kind"], number> = {
    speaker_conflict: 90,
    deliverable_missing: 80,
    deliverable_unapproved: 75,
    speaker_tasks_incomplete: 70,
    speaker_profile_incomplete: 65,
    content_approval_pending: 55,
    session_unscheduled: 50,
    publication_pending: 45,
  };
  return scores[kind] ?? 0;
}

function overdue(dueAt: string | null, now: string) {
  return dueAt !== null && dueAt < now;
}

function sha256(value: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function affectedRecord(
  blocker: ProgramReadinessResponse["blockers"][number],
): Risk["affectedRecords"][number] {
  return {
    type: blocker.entityType,
    id: blocker.entityId,
    label: blocker.entityLabel,
  };
}

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

function ellipsize(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRecipient(name: string, email: string) {
  const parsedEmail = normalizedEmailSchema.safeParse(email);
  return name === name.trim() && name.length >= 1 && name.length <= 120
    && parsedEmail.success && parsedEmail.data === email;
}

function addGrouped<Row>(map: Map<string, Row[]>, key: string, row: Row) {
  const group = map.get(key);
  if (group) group.push(row);
  else map.set(key, [row]);
}

export async function getDailyProgramBrief(
  database: Database,
  eventId: string,
  nowValue: string,
): Promise<ProgramOperatorBriefResponse> {
  const now = utcSecond(nowValue);
  const readiness = await getProgramReadiness(database, eventId);
  if (!readiness) throw new ProgramOperatorEventNotFoundError();
  const staleBefore = new Date(Date.parse(now) - STALE_OUTBOX_HOURS * 60 * 60 * 1_000)
    .toISOString().replace(".000Z", "Z");

  const [eventResult, speakerResult, taskResult, deliverableResult, speakerSessionResult, assignmentResult,
    messageOutboxResult, notificationOutboxResult] = await database.batch([
    database.prepare("SELECT id, slug, name FROM events WHERE id = ? LIMIT 1").bind(eventId),
    database.prepare(`SELECT DISTINCT speaker.id, event.slug AS eventSlug, event.name AS eventName,
      speaker.name, speaker.contact_email AS contactEmail,
      speaker.user_id AS userId,
      EXISTS (SELECT 1 FROM event_memberships AS membership
        WHERE membership.event_id = speaker.event_id AND membership.user_id = speaker.user_id
          AND membership.role = 'speaker') AS hasSpeakerMembership,
      speaker.workflow_status AS workflowStatus, speaker.profile_status AS profileStatus,
      speaker.agreement_status AS agreementStatus, speaker.public_visibility AS publicVisibility,
      speaker.headshot_object_key AS headshotObjectKey
      FROM speakers AS speaker
      INNER JOIN events AS event ON event.id = speaker.event_id
      INNER JOIN session_presenters AS presenter ON presenter.event_id = speaker.event_id
        AND presenter.speaker_id = speaker.id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = presenter.event_id
        AND acceptance.program_session_id = presenter.program_session_id
      WHERE speaker.event_id = ? AND (
        speaker.workflow_status != 'confirmed' OR speaker.profile_status != 'ready'
        OR speaker.agreement_status != 'signed'
        OR (presenter.role = 'primary' AND speaker.public_visibility != 'published')
        OR EXISTS (SELECT 1 FROM speaker_tasks AS task
          WHERE task.event_id = speaker.event_id AND task.speaker_id = speaker.id AND task.state = 'open')
        OR EXISTS (SELECT 1 FROM program_sessions AS session
          WHERE session.event_id = presenter.event_id AND session.id = presenter.program_session_id
            AND session.deliverables_status != 'ready')
      ) ORDER BY speaker.name COLLATE NOCASE, speaker.id`).bind(eventId),
    database.prepare(`SELECT task.id, task.speaker_id AS speakerId, speaker.name AS speakerName,
      task.program_session_id AS sessionId, session.title AS sessionTitle, task.label, task.due_at AS dueAt
      FROM speaker_tasks AS task
      INNER JOIN speakers AS speaker ON speaker.event_id = task.event_id AND speaker.id = task.speaker_id
      INNER JOIN program_sessions AS session ON session.event_id = task.event_id AND session.id = task.program_session_id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = task.event_id
        AND acceptance.program_session_id = task.program_session_id
      WHERE task.event_id = ? AND task.state = 'open'
      ORDER BY speaker.id, task.due_at IS NULL, task.due_at,
        session.title, task.label, task.id`).bind(eventId),
    database.prepare(`SELECT request.id, request.program_session_id AS sessionId,
      session.title AS sessionTitle, speaker.id AS speakerId, speaker.name AS speakerName,
      request.label, request.due_at AS dueAt,
      (SELECT version.id FROM deliverable_versions AS version
        WHERE version.event_id = request.event_id AND version.request_id = request.id
        ORDER BY version.version_number DESC, version.id DESC LIMIT 1) AS latestVersionId,
      (SELECT review.outcome FROM content_reviews AS review
        WHERE review.event_id = request.event_id AND review.version_id = (
          SELECT version.id FROM deliverable_versions AS version
          WHERE version.event_id = request.event_id AND version.request_id = request.id
          ORDER BY version.version_number DESC, version.id DESC LIMIT 1)
        ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 1) AS latestReviewOutcome
      FROM deliverable_requests AS request
      INNER JOIN program_sessions AS session ON session.event_id = request.event_id
        AND session.id = request.program_session_id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = request.event_id
        AND acceptance.program_session_id = request.program_session_id
      INNER JOIN session_presenters AS presenter ON presenter.event_id = request.event_id
        AND presenter.program_session_id = request.program_session_id
      INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id AND speaker.id = presenter.speaker_id
      WHERE request.event_id = ? AND request.active = 1 AND request.required = 1
        AND ((SELECT version.id FROM deliverable_versions AS version
          WHERE version.event_id = request.event_id AND version.request_id = request.id
          ORDER BY version.version_number DESC, version.id DESC LIMIT 1) IS NULL
          OR COALESCE((SELECT review.outcome FROM content_reviews AS review
            WHERE review.event_id = request.event_id AND review.version_id = (
              SELECT version.id FROM deliverable_versions AS version
              WHERE version.event_id = request.event_id AND version.request_id = request.id
              ORDER BY version.version_number DESC, version.id DESC LIMIT 1)
            ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 1), '') != 'approved')
      ORDER BY speaker.id, request.due_at, session.title, request.id`).bind(eventId),
    database.prepare(`SELECT presenter.speaker_id AS speakerId, session.id, session.title,
      session.deliverables_status AS deliverablesStatus
      FROM session_presenters AS presenter
      INNER JOIN program_sessions AS session ON session.event_id = presenter.event_id
        AND session.id = presenter.program_session_id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      WHERE presenter.event_id = ?
      ORDER BY presenter.speaker_id, session.title, session.id`).bind(eventId),
    database.prepare(`SELECT assignment.id, assignment.proposal_id AS proposalId,
      proposal.title AS proposalTitle, assignment.reviewer_user_id AS reviewerUserId,
      account.display_name AS reviewerName, account.email AS reviewerEmail,
      assignment.review_round_id AS reviewRoundId, assignment.due_at AS dueAt
      FROM review_assignments AS assignment
      INNER JOIN proposals AS proposal ON proposal.event_id = assignment.event_id
        AND proposal.id = assignment.proposal_id
      INNER JOIN event_memberships AS membership ON membership.event_id = assignment.event_id
        AND membership.user_id = assignment.reviewer_user_id AND membership.role = 'reviewer'
      INNER JOIN users AS account ON account.id = membership.user_id
      WHERE assignment.event_id = ? AND assignment.state = 'assigned'
        AND NOT EXISTS (SELECT 1 FROM reviews WHERE assignment_id = assignment.id)
        AND NOT EXISTS (SELECT 1 FROM review_assignment_actions AS action
          WHERE action.assignment_id = assignment.id AND action.action IN ('declined', 'recused'))
        AND NOT EXISTS (SELECT 1 FROM reviewer_conflicts WHERE assignment_id = assignment.id)
      ORDER BY assignment.reviewer_user_id, assignment.due_at IS NULL,
        assignment.due_at, proposal.title, assignment.id`).bind(eventId),
    database.prepare(`SELECT id, recipient_name AS recipientName, state, updated_at AS updatedAt,
      lease_expires_at AS leaseExpiresAt, last_error_code AS lastErrorCode FROM message_outbox
      WHERE event_id = ? AND (state = 'failed' OR (state = 'leased' AND lease_expires_at <= ?))
      ORDER BY CASE state WHEN 'failed' THEN 0 ELSE 1 END, updated_at, id`).bind(eventId, staleBefore),
    database.prepare(`SELECT id, recipient_name AS recipientName, state, queued_at AS queuedAt,
      failure_message AS failureMessage FROM notification_outbox
      WHERE event_id = ? AND state = 'failed'
      ORDER BY queued_at, id`).bind(eventId),
  ]);

  const event = eventResult.results[0] as unknown as EventRow | undefined;
  if (!event) throw new ProgramOperatorEventNotFoundError();
  const speakers = speakerResult.results as unknown as SpeakerRow[];
  const tasks = taskResult.results as unknown as SpeakerTaskRow[];
  const deliverables = deliverableResult.results as unknown as DeliverableRow[];
  const speakerSessions = speakerSessionResult.results as unknown as SpeakerSessionRow[];
  const assignments = assignmentResult.results as unknown as ReviewAssignmentRow[];
  const messageOutbox = messageOutboxResult.results as unknown as MessageOutboxRow[];
  const notificationOutbox = notificationOutboxResult.results as unknown as NotificationOutboxRow[];
  const evidence = new Map<string, Evidence>();
  const eventEvidenceId = addEvidence(evidence, {
    source: "event", recordId: event.id, fields: ["slug", "name"],
  });

  const tasksBySpeaker = new Map<string, SpeakerTaskRow[]>();
  const deliverablesBySpeaker = new Map<string, DeliverableRow[]>();
  const sessionsBySpeaker = new Map<string, SpeakerSessionRow[]>();
  const deliverablesBySession = new Map<string, DeliverableRow[]>();
  for (const task of tasks) addGrouped(tasksBySpeaker, task.speakerId, task);
  for (const deliverable of deliverables) {
    addGrouped(deliverablesBySpeaker, deliverable.speakerId, deliverable);
    addGrouped(deliverablesBySession, deliverable.sessionId, deliverable);
  }
  for (const session of speakerSessions) addGrouped(sessionsBySpeaker, session.speakerId, session);

  const rankedRisks: RankedRisk[] = readiness.blockers.map((blocker) => {
    const ids = [addEvidence(evidence, {
      source: "program_readiness",
      recordId: blocker.id,
      fields: ["kind", "entityType", "entityId", "rule", "explanation", "actionPath"],
    })];
    const matchingTasks = blocker.kind === "speaker_tasks_incomplete"
      ? (tasksBySpeaker.get(blocker.entityId) ?? []).filter((task) =>
        blocker.id === `speaker_tasks_incomplete:${task.sessionId}:${task.speakerId}`)
      : [];
    const matchingDeliverables = ["deliverable_missing", "deliverable_unapproved"].includes(blocker.kind)
      ? (deliverablesBySession.get(blocker.entityId) ?? []).filter((item) =>
        blocker.id === `${blocker.kind}:${item.sessionId}:${item.id}`)
      : [];
    for (const task of matchingTasks) {
      ids.push(addEvidence(evidence, { source: "speaker_task", recordId: task.id, fields: ["speakerId", "sessionId", "label", "dueAt", "state"] }));
    }
    for (const item of matchingDeliverables) {
      ids.push(addEvidence(evidence, { source: "deliverable_request", recordId: item.id, fields: ["sessionId", "label", "dueAt", "latestVersionId", "latestReviewOutcome"] }));
    }
    const hasOverdueEvidence = [...matchingTasks, ...matchingDeliverables]
      .some((item) => overdue(item.dueAt, now));
    return {
      id: `risk:${blocker.id}`,
      score: readinessScore(blocker.kind) + (hasOverdueEvidence ? 20 : 0),
      severity: hasOverdueEvidence ? "critical" : readinessSeverity(blocker.kind),
      kind: "readiness_blocker",
      title: ellipsize(`${hasOverdueEvidence ? "Overdue: " : ""}${blocker.entityLabel}`, 300),
      explanation: ellipsize(blocker.explanation, 1_000),
      suggestedResolution: ellipsize(`${blocker.actionLabel} at ${blocker.actionPath}.`, 500),
      affectedRecords: [affectedRecord(blocker)],
      evidenceIds: unique(ids).slice(0, 50),
      confidence: "high",
    };
  });

  const assignmentsByReviewer = new Map<string, ReviewAssignmentRow[]>();
  for (const assignment of assignments) {
    addGrouped(assignmentsByReviewer, assignment.reviewerUserId, assignment);
  }
  for (const [reviewerUserId, pending] of assignmentsByReviewer) {
    const overdueCount = pending.filter(({ dueAt }) => overdue(dueAt, now)).length;
    const ids = [addEvidence(evidence, {
      source: "reviewer_summary",
      recordId: reviewerUserId,
      fields: ["pendingAssignmentCount", "overdueAssignmentCount", "missingDueAtCount"],
    }), ...pending.slice(0, 49).map((assignment) => addEvidence(evidence, {
      source: "review_assignment",
      recordId: assignment.id,
      fields: ["proposalId", "reviewerUserId", "reviewRoundId", "dueAt", "state", "reviewStatus"],
    }))];
    rankedRisks.push({
      id: `risk:review-backlog:${reviewerUserId}`,
      score: overdueCount > 0 ? 95 : 60,
      severity: overdueCount > 0 ? "critical" : "high",
      kind: "review_backlog",
      title: ellipsize(`${pending[0]!.reviewerName} has ${pending.length} pending ${pending.length === 1 ? "review" : "reviews"}`, 300),
      explanation: overdueCount > 0
        ? `${overdueCount} ${overdueCount === 1 ? "assignment is" : "assignments are"} past the recorded due time.`
        : "The assignments are incomplete; no recorded due time has passed.",
      suggestedResolution: "Review the assignments, then approve one exact-recipient reminder if follow-up is appropriate.",
      affectedRecords: pending.slice(0, 20).map((assignment) => ({
        type: "review_assignment" as const,
        id: assignment.id,
        label: ellipsize(assignment.proposalTitle, 300),
      })),
      evidenceIds: ids,
      confidence: "high",
    });
  }

  for (const row of messageOutbox) {
    const failed = row.state === "failed";
    const id = addEvidence(evidence, {
      source: "message_outbox", recordId: row.id,
      fields: ["recipientName", "state", "updatedAt", "leaseExpiresAt", "lastErrorCode"],
    });
    rankedRisks.push({
      id: `risk:message-outbox:${row.id}`,
      score: failed ? 88 : 58,
      severity: failed ? "high" : "medium",
      kind: failed ? "outbox_failure" : "stale_outbox",
      title: failed ? `Message delivery failed for ${row.recipientName}` : `Message for ${row.recipientName} has not progressed`,
      explanation: failed
        ? `The outbox records failure code ${row.lastErrorCode ?? "unknown"}.`
        : `The delivery lease expired at ${row.leaseExpiresAt}, at least ${STALE_OUTBOX_HOURS} hours before this snapshot.`,
      suggestedResolution: "Inspect communication history and delivery configuration before retrying.",
      affectedRecords: [{ type: "message", id: row.id, label: row.recipientName }],
      evidenceIds: [id],
      confidence: "high",
    });
  }
  for (const row of notificationOutbox) {
    const id = addEvidence(evidence, {
      source: "notification_outbox", recordId: row.id,
      fields: ["recipientName", "state", "queuedAt", "failureMessage"],
    });
    rankedRisks.push({
      id: `risk:notification-outbox:${row.id}`,
      score: 88,
      severity: "high",
      kind: "outbox_failure",
      title: `Decision notification failed for ${row.recipientName}`,
      explanation: "The decision-notification outbox records a delivery failure.",
      suggestedResolution: "Inspect the immutable notification record and delivery status before any follow-up.",
      affectedRecords: [{ type: "message", id: row.id, label: row.recipientName }],
      evidenceIds: [id],
      confidence: "high",
    });
  }

  const plan: ProgramOperatorBriefResponse["plan"] = [];
  const exceptions: ProgramOperatorBriefResponse["exceptions"] = [];
  for (const speaker of speakers) {
    const ids = [addEvidence(evidence, {
      source: "speaker", recordId: speaker.id,
      fields: ["name", "contactEmail", "userId", "workflowStatus", "profileStatus", "agreementStatus", "publicVisibility", "headshotObjectKey"],
    })];
    for (const task of tasksBySpeaker.get(speaker.id) ?? []) {
      ids.push(addEvidence(evidence, { source: "speaker_task", recordId: task.id, fields: ["speakerId", "sessionId", "label", "dueAt", "state"] }));
    }
    for (const item of deliverablesBySpeaker.get(speaker.id) ?? []) {
      ids.push(addEvidence(evidence, { source: "deliverable_request", recordId: item.id, fields: ["sessionId", "label", "dueAt", "latestVersionId", "latestReviewOutcome"] }));
    }
    for (const session of sessionsBySpeaker.get(speaker.id) ?? []) {
      ids.push(addEvidence(evidence, { source: "program_session", recordId: session.id, fields: ["title", "deliverablesStatus"] }));
    }
    if (!exactRecipient(speaker.name, speaker.contactEmail) || !speaker.userId || speaker.hasSpeakerMembership !== 1) {
      exceptions.push({
        id: `exception:speaker-recipient:${speaker.id}`,
        kind: "missing_recipient",
        title: ellipsize(`No safe reminder recipient for ${speaker.name}`, 300),
        explanation: "ConfPilot will not draft a readiness reminder without both an exact contact email and same-event speaker access.",
        evidenceIds: unique(ids).slice(0, 50),
      });
      continue;
    }
    if (speaker.workflowStatus === "declined") {
      exceptions.push({
        id: `exception:speaker-declined:${speaker.id}`,
        kind: "manual_judgment",
        title: ellipsize(`${speaker.name} has declined`, 300),
        explanation: "A declined speaker is excluded from automated reminder drafts and requires organizer judgment.",
        evidenceIds: unique(ids).slice(0, 50),
      });
      continue;
    }
    try {
      const preview = renderSpeakerReminderPreview({
        eventId,
        eventSlug: speaker.eventSlug,
        eventName: speaker.eventName,
        speakerId: speaker.id,
        userId: speaker.userId,
        hasSpeakerMembership: speaker.hasSpeakerMembership,
        name: speaker.name,
        contactEmail: speaker.contactEmail,
        workflowStatus: speaker.workflowStatus,
        profileStatus: speaker.profileStatus,
        agreementStatus: speaker.agreementStatus,
        headshotObjectKey: speaker.headshotObjectKey,
      }, tasksBySpeaker.get(speaker.id) ?? [], sessionsBySpeaker.get(speaker.id) ?? [], "speaker.readiness-reminder");
      plan.push({
        id: `draft:speaker-reminder:${speaker.id}`,
        kind: "speaker_reminder",
        status: "draft",
        requiredApproval: "human",
        queueOperation: "speakers.queueReminders",
        recipient: { type: "speaker", id: speaker.id, name: preview.recipientName, email: preview.recipientEmail },
        draft: {
          templateKey: preview.templateKey,
          templateRevision: preview.templateRevision,
          subject: preview.subject,
          text: preview.text,
        },
        expectedStateChange: "If approved and queued, one immutable outbox intent is created. Readiness remains unchanged until the speaker completes the cited work.",
        evidenceIds: unique(ids).slice(0, 50),
      });
    } catch (error) {
      if (!(error instanceof SpeakerReminderIneligibleError)) throw error;
      exceptions.push({
        id: `exception:speaker-reminder:${speaker.id}`,
        kind: "manual_judgment",
        title: ellipsize(`No eligible reminder for ${speaker.name}`, 300),
        explanation: `The deterministic reminder policy rejected this draft: ${error.reason}.`,
        evidenceIds: unique(ids).slice(0, 50),
      });
    }
  }

  for (const [reviewerUserId, pending] of assignmentsByReviewer) {
    const ids = [addEvidence(evidence, {
      source: "reviewer_summary", recordId: reviewerUserId,
      fields: ["pendingAssignmentCount", "overdueAssignmentCount", "missingDueAtCount"],
    }), ...pending.slice(0, 49).map((assignment) => addEvidence(evidence, {
      source: "review_assignment", recordId: assignment.id,
      fields: ["proposalId", "reviewerUserId", "reviewRoundId", "dueAt", "state", "reviewStatus"],
    }))];
    const first = pending[0]!;
    if (!exactRecipient(first.reviewerName, first.reviewerEmail)) {
      exceptions.push({
        id: `exception:reviewer-recipient:${reviewerUserId}`,
        kind: "missing_recipient",
        title: ellipsize(`No safe reminder recipient for ${first.reviewerName}`, 300),
        explanation: "ConfPilot will not draft a review reminder without an exact valid same-event reviewer email.",
        evidenceIds: ids,
      });
      continue;
    }
    const preview = renderReviewerReminderPreview({
      eventSlug: event.slug,
      eventName: event.name,
      userId: reviewerUserId,
      displayName: first.reviewerName,
      email: first.reviewerEmail,
    }, pending, "reviewer.pending-reviews-reminder");
    plan.push({
      id: `draft:reviewer-reminder:${reviewerUserId}`,
      kind: "reviewer_reminder",
      status: "draft",
      requiredApproval: "human",
      queueOperation: "review.queueReviewerReminder",
      recipient: { type: "reviewer", id: reviewerUserId, name: preview.recipientName, email: preview.recipientEmail },
      draft: {
        templateKey: preview.templateKey,
        templateRevision: preview.templateRevision,
        subject: preview.subject,
        text: preview.text,
      },
      expectedStateChange: "If approved and queued, one immutable outbox intent is created. Review progress remains unchanged until the reviewer submits scorecards.",
      evidenceIds: ids,
    });
  }

  const missingTaskDeadlines = tasks.filter(({ dueAt }) => dueAt === null);
  if (missingTaskDeadlines.length > 0) {
    exceptions.push({
      id: "exception:missing-speaker-task-deadlines",
      kind: "missing_deadline",
      title: `${missingTaskDeadlines.length} open speaker ${missingTaskDeadlines.length === 1 ? "task has" : "tasks have"} no due time`,
      explanation: "The operator can report these tasks but cannot truthfully classify their urgency until an organizer records deadlines.",
      evidenceIds: missingTaskDeadlines.slice(0, 50).map((task) => addEvidence(evidence, {
        source: "speaker_task", recordId: task.id,
        fields: ["speakerId", "sessionId", "label", "dueAt", "state"],
      })),
    });
  }
  const missingReviewDeadlines = assignments.filter(({ dueAt }) => dueAt === null);
  if (missingReviewDeadlines.length > 0) {
    exceptions.push({
      id: "exception:missing-review-deadlines",
      kind: "missing_deadline",
      title: `${missingReviewDeadlines.length} pending review ${missingReviewDeadlines.length === 1 ? "has" : "have"} no due time`,
      explanation: "The operator can draft follow-up but cannot truthfully classify these assignments as overdue.",
      evidenceIds: missingReviewDeadlines.slice(0, 50).map((assignment) => addEvidence(evidence, {
        source: "review_assignment", recordId: assignment.id,
        fields: ["proposalId", "reviewerUserId", "reviewRoundId", "dueAt", "state", "reviewStatus"],
      })),
    });
  }

  rankedRisks.sort((left, right) => right.score - left.score || compareStrings(left.id, right.id));
  const allRisks = rankedRisks.map(({ score: _score, ...risk }, index) => ({ ...risk, rank: index + 1 }));
  const risks = allRisks.slice(0, MAX_RISKS);
  plan.sort((left, right) => compareStrings(left.kind, right.kind)
    || compareStrings(left.recipient.name, right.recipient.name)
    || compareStrings(left.id, right.id));
  const omittedRiskCount = allRisks.length - risks.length;
  const omittedPlanCount = Math.max(0, plan.length - MAX_PLAN_ITEMS);
  const boundedPlan = plan.slice(0, MAX_PLAN_ITEMS);
  exceptions.sort((left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id));
  const needsScopeException = omittedRiskCount > 0 || omittedPlanCount > 0 || exceptions.length > MAX_EXCEPTIONS;
  const exceptionCapacity = needsScopeException ? MAX_EXCEPTIONS - 1 : MAX_EXCEPTIONS;
  const omittedExceptionCount = Math.max(0, exceptions.length - exceptionCapacity);
  const boundedExceptions = exceptions.slice(0, exceptionCapacity);
  if (needsScopeException) {
    boundedExceptions.push({
      id: "exception:scope-limit",
      kind: "scope_limit",
      title: "The daily brief reached its bounded output limit",
      explanation: `${omittedRiskCount} lower-ranked risks, ${omittedPlanCount} reminder drafts, and ${omittedExceptionCount} exceptions were omitted. Narrow the event state or inspect the cited canonical workspaces for the complete record.`,
      evidenceIds: [eventEvidenceId],
    });
  }
  const referencedEvidence = new Set([
    eventEvidenceId,
    ...risks.flatMap(({ evidenceIds }) => evidenceIds),
    ...boundedPlan.flatMap(({ evidenceIds }) => evidenceIds),
    ...boundedExceptions.flatMap(({ evidenceIds }) => evidenceIds),
  ]);
  const orderedEvidence = [...evidence.values()]
    .filter(({ id }) => referencedEvidence.has(id))
    .sort((left, right) => compareStrings(left.id, right.id));
  const fingerprint = await sha256(JSON.stringify({
    event,
    readiness: readiness.summary,
    staleBefore,
    risks,
    plan: boundedPlan,
    exceptions: boundedExceptions,
  }));

  return {
    event,
    snapshot: {
      schemaVersion: 1,
      capturedAt: now,
      staleLeaseBefore: staleBefore,
      fingerprint,
      evidenceCount: orderedEvidence.length,
    },
    generation: {
      mode: "deterministic",
      modelStatus: "not_configured",
      policyVersion: "program-operator-shadow-v1",
    },
    summary: {
      status: risks.length === 0 && boundedExceptions.length === 0 ? "complete" : "attention_needed",
      acceptedSessions: readiness.summary.accepted,
      publishReadySessions: readiness.summary.publishReady,
      riskCount: risks.length,
      reminderDraftCount: boundedPlan.length,
      exceptionCount: boundedExceptions.length,
    },
    evidence: orderedEvidence,
    risks,
    plan: boundedPlan,
    exceptions: boundedExceptions,
    guardrails: { shadowMode: true, writesPerformed: 0, unauthorizedActions: 0 },
  };
}
