import type {
  ProgramReadinessBlockerKind,
  ProgramReadinessResponse,
} from "@confpilot/contracts";
import type { Database } from "../runtime/database";

interface EventRow {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "open" | "scheduled" | "published";
}

interface SessionRow {
  id: string;
  title: string;
  approvalStatus: "pending" | "changes_requested" | "approved";
  publicationStatus: "private" | "ready" | "published";
  deliverablesStatus: "missing" | "submitted" | "ready";
  placementId: string | null;
}

interface PresenterRow {
  sessionId: string;
  speakerId: string;
  name: string;
  role: "primary" | "co_presenter";
  workflowStatus: "invited" | "confirmed" | "declined";
  profileStatus: "incomplete" | "ready";
  agreementStatus: "missing" | "signed";
  publicVisibility: "private" | "published";
}

interface OpenTaskRow {
  id: string;
  sessionId: string;
  speakerId: string;
  speakerName: string;
  label: string;
}

interface DeliverableRow {
  id: string;
  sessionId: string;
  label: string;
  latestVersionId: string | null;
  latestReviewOutcome: "changes_requested" | "approved" | null;
}

interface ConflictRow {
  speakerId: string;
  speakerName: string;
  leftSessionId: string;
  leftTitle: string;
  rightSessionId: string;
  rightTitle: string;
}

type SessionConflictRow = ConflictRow & {
  sessionId: string;
  otherSessionId: string;
  otherTitle: string;
};

type Blocker = ProgramReadinessResponse["blockers"][number];

const blockerPriority: Record<ProgramReadinessBlockerKind, number> = {
  speaker_profile_incomplete: 0,
  speaker_tasks_incomplete: 1,
  deliverable_missing: 2,
  deliverable_unapproved: 3,
  content_approval_pending: 4,
  session_unscheduled: 5,
  speaker_conflict: 6,
  publication_pending: 7,
};

function actionPath(area: "agenda" | "content" | "speakers", key?: "session" | "speaker", id?: string) {
  if (!key || !id) return `/admin/${area}`;
  return `/admin/${area}?${key}=${encodeURIComponent(id)}`;
}

function addToMap<Row extends { sessionId: string }>(map: Map<string, Row[]>, row: Row) {
  const values = map.get(row.sessionId) ?? [];
  values.push(row);
  map.set(row.sessionId, values);
}

function ellipsize(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function taskLabelSummary(tasks: OpenTaskRow[]) {
  const visible = tasks.slice(0, 2).map(({ label }) => `“${ellipsize(label, 60)}”`);
  const hidden = tasks.length - visible.length;
  return `${visible.join(", ")}${hidden > 0 ? `, and ${hidden} more` : ""}`;
}

export async function getProgramReadiness(
  database: Database,
  eventId: string,
): Promise<ProgramReadinessResponse | null> {
  const event = await database.prepare(`SELECT id, slug, name, status
    FROM events WHERE id = ? LIMIT 1`).bind(eventId).first<EventRow>();
  if (!event) return null;

  const [sessionResult, presenterResult, taskResult, deliverableResult, conflictResult] = await Promise.all([
    database.prepare(`SELECT session.id, session.title,
      session.approval_status AS approvalStatus,
      session.publication_status AS publicationStatus,
      readiness.deliverables_status AS deliverablesStatus,
      placement.id AS placementId
      FROM program_sessions AS session
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = session.event_id
        AND acceptance.program_session_id = session.id
      INNER JOIN session_deliverable_readiness AS readiness ON readiness.event_id = session.event_id
        AND readiness.program_session_id = session.id
      LEFT JOIN schedule_placements AS placement ON placement.event_id = session.event_id
        AND placement.program_session_id = session.id
      WHERE session.event_id = ?
      ORDER BY session.title COLLATE NOCASE, session.id`).bind(eventId).all<SessionRow>(),
    database.prepare(`SELECT presenter.program_session_id AS sessionId,
      speaker.id AS speakerId, speaker.name, presenter.role,
      speaker.workflow_status AS workflowStatus,
      speaker.profile_status AS profileStatus,
      speaker.agreement_status AS agreementStatus,
      speaker.public_visibility AS publicVisibility
      FROM session_presenters AS presenter
      INNER JOIN speakers AS speaker ON speaker.event_id = presenter.event_id
        AND speaker.id = presenter.speaker_id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = presenter.event_id
        AND acceptance.program_session_id = presenter.program_session_id
      WHERE presenter.event_id = ?
      ORDER BY presenter.program_session_id,
        CASE presenter.role WHEN 'primary' THEN 0 ELSE 1 END,
        speaker.name COLLATE NOCASE, speaker.id`).bind(eventId).all<PresenterRow>(),
    database.prepare(`SELECT task.id, task.program_session_id AS sessionId,
      speaker.id AS speakerId, speaker.name AS speakerName, task.label
      FROM speaker_tasks AS task
      INNER JOIN speakers AS speaker ON speaker.event_id = task.event_id
        AND speaker.id = task.speaker_id
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = task.event_id
        AND acceptance.program_session_id = task.program_session_id
      WHERE task.event_id = ? AND task.state = 'open'
      ORDER BY task.program_session_id, speaker.name COLLATE NOCASE, task.label COLLATE NOCASE, task.id`)
      .bind(eventId).all<OpenTaskRow>(),
    database.prepare(`SELECT request.id, request.program_session_id AS sessionId, request.label,
      (SELECT version.id FROM deliverable_versions AS version
        WHERE version.event_id = request.event_id AND version.request_id = request.id
        ORDER BY version.version_number DESC, version.id DESC LIMIT 1) AS latestVersionId,
      (SELECT review.outcome FROM content_reviews AS review
        WHERE review.event_id = request.event_id AND review.version_id = (
          SELECT version.id FROM deliverable_versions AS version
          WHERE version.event_id = request.event_id AND version.request_id = request.id
          ORDER BY version.version_number DESC, version.id DESC LIMIT 1
        )
        ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 1) AS latestReviewOutcome
      FROM deliverable_requests AS request
      INNER JOIN acceptances AS acceptance ON acceptance.event_id = request.event_id
        AND acceptance.program_session_id = request.program_session_id
      WHERE request.event_id = ? AND request.active = 1 AND request.required = 1
      ORDER BY request.program_session_id, request.due_at, request.label COLLATE NOCASE, request.id`)
      .bind(eventId).all<DeliverableRow>(),
    database.prepare(`SELECT DISTINCT speaker.id AS speakerId, speaker.name AS speakerName,
      left_session.id AS leftSessionId, left_session.title AS leftTitle,
      right_session.id AS rightSessionId, right_session.title AS rightTitle
      FROM schedule_placements AS left_placement
      INNER JOIN schedule_placements AS right_placement
        ON right_placement.event_id = left_placement.event_id
        AND right_placement.id > left_placement.id
        AND left_placement.starts_at < right_placement.ends_at
        AND right_placement.starts_at < left_placement.ends_at
      INNER JOIN session_presenters AS left_presenter
        ON left_presenter.event_id = left_placement.event_id
        AND left_presenter.program_session_id = left_placement.program_session_id
      INNER JOIN session_presenters AS right_presenter
        ON right_presenter.event_id = right_placement.event_id
        AND right_presenter.program_session_id = right_placement.program_session_id
        AND right_presenter.speaker_id = left_presenter.speaker_id
      INNER JOIN speakers AS speaker ON speaker.event_id = left_presenter.event_id
        AND speaker.id = left_presenter.speaker_id
      INNER JOIN program_sessions AS left_session ON left_session.event_id = left_placement.event_id
        AND left_session.id = left_placement.program_session_id
      INNER JOIN program_sessions AS right_session ON right_session.event_id = right_placement.event_id
        AND right_session.id = right_placement.program_session_id
      INNER JOIN acceptances AS left_acceptance ON left_acceptance.event_id = left_session.event_id
        AND left_acceptance.program_session_id = left_session.id
      INNER JOIN acceptances AS right_acceptance ON right_acceptance.event_id = right_session.event_id
        AND right_acceptance.program_session_id = right_session.id
      WHERE left_placement.event_id = ?
      ORDER BY left_placement.starts_at, speaker.name COLLATE NOCASE,
        left_session.title COLLATE NOCASE, right_session.title COLLATE NOCASE, speaker.id`)
      .bind(eventId).all<ConflictRow>(),
  ]);

  const sessions = sessionResult.results;
  const presentersBySession = new Map<string, PresenterRow[]>();
  const tasksBySession = new Map<string, OpenTaskRow[]>();
  const deliverablesBySession = new Map<string, DeliverableRow[]>();
  const conflictsBySession = new Map<string, SessionConflictRow[]>();
  for (const row of presenterResult.results) addToMap(presentersBySession, row);
  for (const row of taskResult.results) addToMap(tasksBySession, row);
  for (const row of deliverableResult.results) addToMap(deliverablesBySession, row);
  for (const row of conflictResult.results) {
    addToMap(conflictsBySession, { ...row, sessionId: row.leftSessionId, otherSessionId: row.rightSessionId, otherTitle: row.rightTitle });
    addToMap(conflictsBySession, { ...row, sessionId: row.rightSessionId, otherSessionId: row.leftSessionId, otherTitle: row.leftTitle });
  }

  let profileReadyCount = 0;
  let deliverablesReadyCount = 0;
  let scheduledCount = 0;
  let approvedCount = 0;
  let publishedCount = 0;
  let publishReadyCount = 0;
  const blockers: Blocker[] = [];

  for (const session of sessions) {
    const sessionLabel = ellipsize(session.title, 300);
    const presenters = presentersBySession.get(session.id) ?? [];
    const primary = presenters.find((presenter) => presenter.role === "primary");
    const profileReady = presenters.length > 0 && Boolean(primary) && presenters.every((presenter) =>
      presenter.workflowStatus === "confirmed"
      && presenter.profileStatus === "ready"
      && presenter.agreementStatus === "signed");
    const primaryPublic = primary?.publicVisibility === "published";
    const tasks = tasksBySession.get(session.id) ?? [];
    const deliverables = deliverablesBySession.get(session.id) ?? [];
    const deliverablesReady = session.deliverablesStatus === "ready"
      && deliverables.every((request) => request.latestVersionId && request.latestReviewOutcome === "approved");
    const scheduled = session.placementId !== null;
    const approved = session.approvalStatus === "approved";
    const conflicts = conflictsBySession.get(session.id) ?? [];
    const publishReady = profileReady && primaryPublic && tasks.length === 0
      && deliverablesReady && scheduled && approved && conflicts.length === 0;

    if (profileReady) profileReadyCount += 1;
    if (deliverablesReady) deliverablesReadyCount += 1;
    if (scheduled) scheduledCount += 1;
    if (approved) approvedCount += 1;
    if (publishReady && session.publicationStatus === "published" && event.status === "published") {
      publishedCount += 1;
    }
    if (publishReady) publishReadyCount += 1;

    if (presenters.length === 0) {
      blockers.push({
        id: `speaker_profile_incomplete:${session.id}:no-presenter`,
        kind: "speaker_profile_incomplete",
        entityType: "session",
        entityId: session.id,
        entityLabel: sessionLabel,
        rule: "Accepted sessions need a primary presenter",
        explanation: "This accepted session has no linked presenter profile.",
        actionLabel: "Open speaker readiness",
        actionPath: actionPath("speakers"),
      });
    } else {
      for (const presenter of presenters) {
        const missing: string[] = [];
        if (presenter.workflowStatus !== "confirmed") missing.push("confirmation");
        if (presenter.profileStatus !== "ready") missing.push("profile details");
        if (presenter.agreementStatus !== "signed") missing.push("speaker release");
        if (presenter.role === "primary" && presenter.publicVisibility !== "published") {
          missing.push("public visibility");
        }
        if (missing.length === 0) continue;
        blockers.push({
          id: `speaker_profile_incomplete:${session.id}:${presenter.speakerId}`,
          kind: "speaker_profile_incomplete",
          entityType: "speaker",
          entityId: presenter.speakerId,
          entityLabel: presenter.name,
          rule: presenter.role === "primary"
            ? "Primary presenters must be confirmed, complete, signed, and public"
            : "Co-presenters must be confirmed, complete, and signed",
          explanation: ellipsize(`${sessionLabel} is waiting on ${missing.join(", ")}.`, 500),
          actionLabel: "Open speaker",
          actionPath: actionPath("speakers", "speaker", presenter.speakerId),
        });
      }
      if (!primary) {
        blockers.push({
          id: `speaker_profile_incomplete:${session.id}:no-primary`,
          kind: "speaker_profile_incomplete",
          entityType: "session",
          entityId: session.id,
          entityLabel: sessionLabel,
          rule: "Accepted sessions need one primary presenter",
          explanation: "Presenters are linked, but none is designated as the primary presenter.",
          actionLabel: "Open speaker readiness",
          actionPath: actionPath("speakers"),
        });
      }
    }

    const tasksBySpeaker = new Map<string, OpenTaskRow[]>();
    for (const task of tasks) {
      const speakerTasks = tasksBySpeaker.get(task.speakerId) ?? [];
      speakerTasks.push(task);
      tasksBySpeaker.set(task.speakerId, speakerTasks);
    }
    for (const [speakerId, speakerTasks] of tasksBySpeaker) {
      const task = speakerTasks[0]!;
      const labels = taskLabelSummary(speakerTasks);
      blockers.push({
        id: `speaker_tasks_incomplete:${session.id}:${speakerId}`,
        kind: "speaker_tasks_incomplete",
        entityType: "speaker",
        entityId: speakerId,
        entityLabel: task.speakerName,
        rule: "All speaker tasks must be complete or waived",
        explanation: ellipsize(`${sessionLabel} has ${speakerTasks.length} open ${speakerTasks.length === 1 ? "task" : "tasks"}: ${labels}.`, 500),
        actionLabel: "Open task ledger",
        actionPath: actionPath("speakers", "speaker", speakerId),
      });
    }

    for (const request of deliverables) {
      const missing = request.latestVersionId === null;
      if (!missing && request.latestReviewOutcome === "approved") continue;
      blockers.push({
        id: `${missing ? "deliverable_missing" : "deliverable_unapproved"}:${session.id}:${request.id}`,
        kind: missing ? "deliverable_missing" : "deliverable_unapproved",
        entityType: "session",
        entityId: session.id,
        entityLabel: sessionLabel,
        rule: "The latest version of each required deliverable must be approved",
        explanation: missing
          ? `The required deliverable “${request.label}” has not been uploaded.`
          : `The latest “${request.label}” version is awaiting approval or changes.`,
        actionLabel: "Review deliverable",
        actionPath: actionPath("content", "session", session.id),
      });
    }

    if (!approved) {
      blockers.push({
        id: `content_approval_pending:${session.id}`,
        kind: "content_approval_pending",
        entityType: "session",
        entityId: session.id,
        entityLabel: sessionLabel,
        rule: "Session content must be approved",
        explanation: `Content approval is ${session.approvalStatus.replace("_", " ")}.`,
        actionLabel: "Open content review",
        actionPath: actionPath("content", "session", session.id),
      });
    }

    if (!scheduled) {
      blockers.push({
        id: `session_unscheduled:${session.id}`,
        kind: "session_unscheduled",
        entityType: "session",
        entityId: session.id,
        entityLabel: sessionLabel,
        rule: "Accepted sessions need an agenda placement",
        explanation: "This accepted session has no agenda placement.",
        actionLabel: "Place session",
        actionPath: actionPath("agenda", "session", session.id),
      });
    }

    for (const conflict of conflicts) {
      blockers.push({
        id: `speaker_conflict:${session.id}:${conflict.speakerId}:${conflict.otherSessionId}`,
        kind: "speaker_conflict",
        entityType: "session",
        entityId: session.id,
        entityLabel: sessionLabel,
        rule: "A speaker cannot present overlapping sessions",
        explanation: ellipsize(`${conflict.speakerName} is also presenting “${ellipsize(conflict.otherTitle, 300)}” at an overlapping time.`, 500),
        actionLabel: "Resolve agenda conflict",
        actionPath: actionPath("agenda", "session", session.id),
      });
    }

    if (publishReady && (session.publicationStatus !== "published" || event.status !== "published")) {
      blockers.push({
        id: `publication_pending:${session.id}`,
        kind: "publication_pending",
        entityType: "session",
        entityId: session.id,
        entityLabel: sessionLabel,
        rule: "Publish-ready sessions require an organizer publication action",
        explanation: "Every prerequisite is satisfied, but this session is not visible in the published program yet.",
        actionLabel: "Review and publish agenda",
        actionPath: actionPath("agenda", "session", session.id),
      });
    }
  }

  blockers.sort((left, right) => blockerPriority[left.kind] - blockerPriority[right.kind]
    || left.entityLabel.localeCompare(right.entityLabel)
    || left.id.localeCompare(right.id));

  const accepted = sessions.length;
  return {
    event: { slug: event.slug, name: event.name },
    summary: {
      accepted,
      publishReady: publishReadyCount,
      blocked: accepted - publishReadyCount,
      percent: accepted === 0 ? 0 : Math.round((publishReadyCount / accepted) * 100),
    },
    lifecycle: [
      { stage: "accepted", label: "Accepted", count: accepted, total: accepted },
      { stage: "profile_ready", label: "Profile ready", count: profileReadyCount, total: accepted },
      { stage: "deliverables_ready", label: "Deliverables ready", count: deliverablesReadyCount, total: accepted },
      { stage: "scheduled", label: "Scheduled", count: scheduledCount, total: accepted },
      { stage: "approved", label: "Approved", count: approvedCount, total: accepted },
      { stage: "published", label: "Published", count: publishedCount, total: accepted },
    ],
    blockers,
  };
}
