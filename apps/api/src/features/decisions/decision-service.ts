import {
  AcceptanceNotAllowedError,
  acceptanceStatements,
  materializeAcceptance,
  type AcceptanceSource,
} from "./acceptance";
import type { Database, DatabaseStatement } from "../../runtime/database";

export type DecisionValue = "accept" | "reject" | "waitlist";

interface DecisionSourceRow extends Omit<AcceptanceSource, "decisionId"> {
  decisionId: string | null;
  eventSlug: string;
  eventName: string;
  proposalPublicId: string;
  proposalStatus: "draft" | "submitted" | "in_review" | "decided";
  decisionValue: DecisionValue | null;
  rationale: string | null;
  decidedByUserId: string | null;
  decidedByDisplayName: string | null;
  decidedAt: string | null;
  notificationRecipientCount: number;
}

interface DecisionListRow {
  proposalId: string;
  proposalPublicId: string;
  proposalSlug: string;
  proposalTitle: string;
  decisionId: string;
  decisionValue: DecisionValue;
  rationale: string;
  decidedByUserId: string;
  decidedByDisplayName: string;
  decidedAt: string;
  acceptanceId: string | null;
  acceptedAt: string | null;
  programSessionId: string | null;
  programSessionSlug: string | null;
  programSessionTitle: string | null;
  notificationId: string | null;
  notificationState: "pending" | "sent" | "failed" | null;
  notificationSubject: string | null;
  notificationBody: string | null;
  notificationQueuedAt: string | null;
  notificationSentAt: string | null;
  notificationFailureMessage: string | null;
  notificationRecipientSpeakerId: string | null;
  notificationRecipientUserId: string | null;
  notificationRecipientName: string | null;
  notificationRecipientEmail: string | null;
}

interface NotificationTargetRow extends DecisionListRow {
  eventName: string;
  recipientSpeakerId: string | null;
  recipientUserId: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
}

type NotificationReadyTargetRow = NotificationTargetRow & {
  recipientSpeakerId: string;
  recipientUserId: string;
  recipientName: string;
  recipientEmail: string;
};

interface OwnerWorkspaceProposalRow {
  proposalId: string;
  publicId: string;
  title: string;
  status: "draft" | "submitted" | "in_review" | "decided";
  submittedAt: string | null;
  decisionValue: DecisionValue | null;
  decidedAt: string | null;
  notificationState: "pending" | "sent" | "failed" | null;
  notificationQueuedAt: string | null;
  notificationSentAt: string | null;
  sessionId: string | null;
  sessionSlug: string | null;
  sessionTitle: string | null;
  sessionTrack: string | null;
  sessionFormat: "keynote" | "talk" | "lightning" | "workshop" | "panel" | null;
  sessionDurationMinutes: number | null;
}

interface OwnerTaskRow {
  proposalId: string;
  id: string;
  taskKey: string;
  label: string;
  state: "open" | "complete" | "waived";
  completedAt: string | null;
}

interface OwnerPresenterRow {
  proposalId: string;
  speakerId: string;
  name: string;
  role: "primary" | "co_presenter";
}

export class DecisionNotFoundError extends Error {}
export class DecisionNotAllowedError extends Error {}
export class DecisionConflictError extends Error {}
export class NotificationNotAllowedError extends Error {}
export class NotificationConflictError extends Error {}

function notificationProjection(row: DecisionListRow) {
  if (!row.notificationId) return { status: "not_queued" as const };
  const status = row.notificationState === "pending"
    ? "queued" as const
    : row.notificationState === "sent"
      ? "provider_accepted" as const
      : row.notificationState!;
  const snapshot = {
    id: row.notificationId,
    recipient: {
      speakerId: row.notificationRecipientSpeakerId!,
      userId: row.notificationRecipientUserId,
      name: row.notificationRecipientName!,
      email: row.notificationRecipientEmail,
    },
    subject: row.notificationSubject!,
    body: row.notificationBody!,
    queuedAt: row.notificationQueuedAt!,
  };
  if (status === "provider_accepted") {
    return { ...snapshot, status, providerAcceptedAt: row.notificationSentAt! };
  }
  if (status === "failed") return { ...snapshot, status, failureMessage: row.notificationFailureMessage! };
  return { ...snapshot, status };
}

function queuedNotificationProjection(row: DecisionListRow) {
  const projection = notificationProjection(row);
  if (projection.status === "not_queued") throw new NotificationNotAllowedError();
  return projection;
}

function decisionProjection(row: DecisionListRow) {
  return {
    proposal: {
      id: row.proposalId,
      publicId: row.proposalPublicId,
      slug: row.proposalSlug,
      title: row.proposalTitle,
    },
    decision: {
      id: row.decisionId,
      value: row.decisionValue,
      rationale: row.rationale,
      decidedBy: {
        userId: row.decidedByUserId,
        displayName: row.decidedByDisplayName,
      },
      decidedAt: row.decidedAt,
    },
    handoff: row.acceptanceId && row.programSessionId
      ? {
          status: "materialized" as const,
          acceptanceId: row.acceptanceId,
          acceptedAt: row.acceptedAt!,
          programSession: {
            id: row.programSessionId,
            slug: row.programSessionSlug!,
          },
        }
      : { status: "not_applicable" as const },
    notification: notificationProjection(row),
  };
}

const DECISION_LIST_SELECT = `SELECT
  proposal.id AS proposalId,
  proposal.public_id AS proposalPublicId,
  proposal.slug AS proposalSlug,
  proposal.title AS proposalTitle,
  decision.id AS decisionId,
  decision.decision AS decisionValue,
  decision.rationale,
  actor.id AS decidedByUserId,
  actor.display_name AS decidedByDisplayName,
  decision.decided_at AS decidedAt,
  acceptance.id AS acceptanceId,
  acceptance.accepted_at AS acceptedAt,
  session.id AS programSessionId,
  session.slug AS programSessionSlug,
  session.title AS programSessionTitle,
  notification.id AS notificationId,
  notification.state AS notificationState,
  notification.subject AS notificationSubject,
  notification.body AS notificationBody,
  notification.queued_at AS notificationQueuedAt,
  notification.sent_at AS notificationSentAt,
  notification.failure_message AS notificationFailureMessage,
  notification.recipient_speaker_id AS notificationRecipientSpeakerId,
  notification.recipient_user_id AS notificationRecipientUserId,
  notification.recipient_name AS notificationRecipientName,
  notification.recipient_email AS notificationRecipientEmail
FROM decisions AS decision
INNER JOIN proposals AS proposal
  ON proposal.id = decision.proposal_id AND proposal.event_id = decision.event_id
INNER JOIN users AS actor ON actor.id = decision.decided_by_user_id
LEFT JOIN acceptances AS acceptance
  ON acceptance.decision_id = decision.id AND acceptance.event_id = decision.event_id
LEFT JOIN program_sessions AS session
  ON session.id = acceptance.program_session_id AND session.event_id = decision.event_id
LEFT JOIN notification_outbox AS notification
  ON notification.decision_id = decision.id AND notification.event_id = decision.event_id`;

async function decisionRowForProposal(database: Database, eventId: string, proposalId: string) {
  return database.prepare(`${DECISION_LIST_SELECT}
    WHERE decision.event_id = ? AND decision.proposal_id = ?
    LIMIT 1`).bind(eventId, proposalId).first<DecisionListRow>();
}

async function decisionSource(database: Database, eventId: string, proposalId: string) {
  return database.prepare(
    `SELECT
      event.id AS eventId,
      event.slug AS eventSlug,
      event.name AS eventName,
      proposal.id AS proposalId,
      proposal.public_id AS proposalPublicId,
      proposal.slug,
      proposal.title,
      proposal.abstract,
      proposal.track,
      proposal.format,
      proposal.duration_minutes AS durationMinutes,
      proposal.status AS proposalStatus,
      (SELECT COUNT(*) FROM proposal_presenters presenter
        WHERE presenter.event_id = proposal.event_id
          AND presenter.proposal_id = proposal.id) AS presenterCount,
      (SELECT COUNT(*) FROM proposal_presenters presenter
        WHERE presenter.event_id = proposal.event_id
          AND presenter.proposal_id = proposal.id
          AND presenter.role = 'primary') AS primaryPresenterCount,
      (SELECT COUNT(*)
        FROM proposal_presenters presenter
        INNER JOIN speakers speaker
          ON speaker.event_id = presenter.event_id
          AND speaker.id = presenter.speaker_id
        WHERE presenter.event_id = proposal.event_id
          AND presenter.proposal_id = proposal.id
          AND presenter.role = 'primary'
          AND speaker.user_id = proposal.owner_user_id) AS notificationRecipientCount,
      decision.id AS decisionId,
      decision.decision AS decisionValue,
      decision.rationale,
      decision.decided_by_user_id AS decidedByUserId,
      actor.display_name AS decidedByDisplayName,
      decision.decided_at AS decidedAt,
      acceptance.id AS existingAcceptanceId,
      session.id AS existingProgramSessionId
    FROM proposals AS proposal
    INNER JOIN events AS event ON event.id = proposal.event_id
    LEFT JOIN decisions AS decision
      ON decision.event_id = proposal.event_id AND decision.proposal_id = proposal.id
    LEFT JOIN users AS actor ON actor.id = decision.decided_by_user_id
    LEFT JOIN acceptances AS acceptance
      ON acceptance.event_id = proposal.event_id AND acceptance.proposal_id = proposal.id
    LEFT JOIN program_sessions AS session
      ON session.event_id = proposal.event_id AND session.source_proposal_id = proposal.id
    WHERE proposal.event_id = ? AND proposal.id = ?
    LIMIT 1`,
  ).bind(eventId, proposalId).first<DecisionSourceRow>();
}

export async function listDecisions(database: Database, eventId: string, eventSlug: string) {
  const event = await database.prepare(
    "SELECT slug, name FROM events WHERE id = ? AND slug = ? LIMIT 1",
  ).bind(eventId, eventSlug).first<{ slug: string; name: string }>();
  if (!event) throw new DecisionNotFoundError();
  const { results } = await database.prepare(`${DECISION_LIST_SELECT}
    WHERE decision.event_id = ?
    ORDER BY decision.decided_at ASC, decision.id ASC`).bind(eventId).all<DecisionListRow>();
  return { event, decisions: results.map(decisionProjection) };
}

export async function recordDecision(
  database: Database,
  input: {
    eventId: string;
    proposalId: string;
    decision: DecisionValue;
    rationale: string;
    decidedByUserId: string;
    decidedAt: string;
  },
) {
  const source = await decisionSource(database, input.eventId, input.proposalId);
  if (!source) throw new DecisionNotFoundError();
  const rationale = input.rationale.trim();

  if (source.decisionId) {
    if (source.decisionValue !== input.decision || source.rationale !== rationale) {
      throw new DecisionConflictError();
    }
    if (input.decision === "accept") {
      await materializeAcceptance(database, {
        eventId: input.eventId,
        decisionId: source.decisionId,
        acceptedByUserId: input.decidedByUserId,
        acceptedAt: source.decidedAt!,
      });
    }
    const replay = await decisionRowForProposal(database, input.eventId, input.proposalId);
    if (!replay) throw new DecisionNotFoundError();
    return decisionProjection(replay);
  }

  if (source.proposalStatus !== "submitted" && source.proposalStatus !== "in_review") {
    throw new DecisionNotAllowedError();
  }
  if (input.decision === "accept" && (source.presenterCount < 1 || source.primaryPresenterCount !== 1)) {
    throw new AcceptanceNotAllowedError();
  }
  if (input.decision === "accept"
    && (source.primaryPresenterCount !== 1 || source.notificationRecipientCount !== 1)) {
    throw new NotificationNotAllowedError();
  }

  const decisionId = crypto.randomUUID();
  const firstSource: AcceptanceSource = {
    ...source,
    decisionId,
  };
  const statements: DatabaseStatement[] = [
    database.prepare(
      `INSERT INTO decisions (
        id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      decisionId,
      input.eventId,
      input.proposalId,
      input.decision,
      rationale,
      input.decidedByUserId,
      input.decidedAt,
    ),
    database.prepare(
      `UPDATE proposals
      SET status = 'decided', updated_at = ?
      WHERE id = ? AND event_id = ? AND status IN ('submitted', 'in_review')`,
    ).bind(input.decidedAt, input.proposalId, input.eventId),
    database.prepare(
      `UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?
      WHERE event_id = ? AND proposal_id = ? AND state = 'assigned'
        AND NOT EXISTS (SELECT 1 FROM reviews WHERE reviews.assignment_id = review_assignments.id)`,
    ).bind(input.decidedAt, input.decidedByUserId, input.eventId, input.proposalId),
  ];
  if (input.decision === "accept") {
    statements.push(...acceptanceStatements(database, firstSource, {
      acceptedByUserId: input.decidedByUserId,
      acceptedAt: input.decidedAt,
    }));
  }

  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await decisionSource(database, input.eventId, input.proposalId);
    if (raced?.decisionId) {
      if (raced.decisionValue !== input.decision || raced.rationale !== rationale) {
        throw new DecisionConflictError();
      }
      if (input.decision === "accept") {
        await materializeAcceptance(database, {
          eventId: input.eventId,
          decisionId: raced.decisionId,
          acceptedByUserId: input.decidedByUserId,
          acceptedAt: raced.decidedAt!,
        });
      }
    } else {
      throw error;
    }
  }

  const recorded = await decisionRowForProposal(database, input.eventId, input.proposalId);
  if (!recorded) throw new DecisionNotFoundError();
  return decisionProjection(recorded);
}

async function notificationTarget(database: Database, eventId: string, decisionId: string) {
  return database.prepare(`SELECT
    proposal.id AS proposalId,
    proposal.public_id AS proposalPublicId,
    proposal.slug AS proposalSlug,
    proposal.title AS proposalTitle,
    decision.id AS decisionId,
    decision.decision AS decisionValue,
    decision.rationale,
    actor.id AS decidedByUserId,
    actor.display_name AS decidedByDisplayName,
    decision.decided_at AS decidedAt,
    acceptance.id AS acceptanceId,
    acceptance.accepted_at AS acceptedAt,
    session.id AS programSessionId,
    session.slug AS programSessionSlug,
    session.title AS programSessionTitle,
    notification.id AS notificationId,
    notification.state AS notificationState,
    notification.subject AS notificationSubject,
    notification.body AS notificationBody,
    notification.queued_at AS notificationQueuedAt,
    notification.sent_at AS notificationSentAt,
    notification.failure_message AS notificationFailureMessage,
    notification.recipient_speaker_id AS notificationRecipientSpeakerId,
    notification.recipient_user_id AS notificationRecipientUserId,
    notification.recipient_name AS notificationRecipientName,
    notification.recipient_email AS notificationRecipientEmail,
    event.name AS eventName,
    speaker.id AS recipientSpeakerId,
    owner.id AS recipientUserId,
    owner.display_name AS recipientName,
    lower(trim(owner.email)) AS recipientEmail
    FROM decisions AS decision
    INNER JOIN proposals AS proposal
      ON proposal.id = decision.proposal_id AND proposal.event_id = decision.event_id
    INNER JOIN events AS event ON event.id = decision.event_id
    INNER JOIN users AS actor ON actor.id = decision.decided_by_user_id
    LEFT JOIN proposal_presenters AS presenter
      ON presenter.event_id = proposal.event_id
      AND presenter.proposal_id = proposal.id
      AND presenter.role = 'primary'
    LEFT JOIN speakers AS speaker
      ON speaker.id = presenter.speaker_id
      AND speaker.event_id = presenter.event_id
    LEFT JOIN users AS owner
      ON owner.id = proposal.owner_user_id
      AND owner.id = speaker.user_id
    LEFT JOIN acceptances AS acceptance
      ON acceptance.decision_id = decision.id AND acceptance.event_id = decision.event_id
    LEFT JOIN program_sessions AS session
      ON session.id = acceptance.program_session_id AND session.event_id = decision.event_id
    LEFT JOIN notification_outbox AS notification
      ON notification.decision_id = decision.id AND notification.event_id = decision.event_id
    WHERE decision.event_id = ? AND decision.id = ?
    LIMIT 1`).bind(eventId, decisionId).first<NotificationTargetRow>();
}

function notificationRecipient(target: NotificationTargetRow): NotificationReadyTargetRow {
  if (!target.recipientSpeakerId || !target.recipientUserId
    || !target.recipientName || !target.recipientEmail) {
    throw new NotificationNotAllowedError();
  }
  return target as NotificationReadyTargetRow;
}

function defaultNotification(target: NotificationReadyTargetRow) {
  const subject = target.decisionValue === "accept"
    ? `Your proposal has been accepted to ${target.eventName}`
    : target.decisionValue === "reject"
      ? `An update on your ${target.eventName} proposal`
      : `Your ${target.eventName} proposal is on the waitlist`;
  const outcome = target.decisionValue === "accept"
    ? `has been accepted to ${target.eventName}`
    : target.decisionValue === "reject"
      ? `was not selected for ${target.eventName}`
      : `has been placed on the waitlist for ${target.eventName}`;
  return {
    proposal: { id: target.proposalId, publicId: target.proposalPublicId, slug: target.proposalSlug, title: target.proposalTitle },
    decision: { id: target.decisionId, value: target.decisionValue },
    recipient: {
      speakerId: target.recipientSpeakerId,
      userId: target.recipientUserId,
      name: target.recipientName,
      email: target.recipientEmail,
    },
    subject,
    body: `Hi ${target.recipientName},\n\nYour proposal “${target.proposalTitle}” ${outcome}.`,
  };
}

export async function previewDecisionNotification(database: Database, eventId: string, decisionId: string) {
  const target = await notificationTarget(database, eventId, decisionId);
  if (!target) throw new DecisionNotFoundError();
  return defaultNotification(notificationRecipient(target));
}

export async function queueDecisionNotification(
  database: Database,
  input: {
    eventId: string;
    decisionId: string;
    queuedByUserId: string;
    subject: string;
    body: string;
    queuedAt: string;
  },
) {
  const target = await notificationTarget(database, input.eventId, input.decisionId);
  if (!target) throw new DecisionNotFoundError();
  if (target.notificationId) {
    if (target.notificationSubject !== input.subject || target.notificationBody !== input.body) {
      throw new NotificationConflictError();
    }
    return queuedNotificationProjection(target);
  }
  const recipient = notificationRecipient(target);
  if (target.decisionValue === "accept" && !target.acceptanceId) throw new NotificationNotAllowedError();

  const notificationId = `notification:${input.eventId}:${input.decisionId}:${recipient.recipientSpeakerId}`;
  try {
    await database.prepare(
      `INSERT INTO notification_outbox (
        id, event_id, decision_id, acceptance_id, recipient_speaker_id,
        recipient_user_id, recipient_name, recipient_email, queued_by_user_id,
        subject, body, state, queued_at, sent_at, failure_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
    ).bind(
      notificationId,
      input.eventId,
      input.decisionId,
      target.acceptanceId,
      recipient.recipientSpeakerId,
      recipient.recipientUserId,
      recipient.recipientName,
      recipient.recipientEmail,
      input.queuedByUserId,
      input.subject,
      input.body,
      input.queuedAt,
    ).run();
    return queuedNotificationProjection({
      ...target,
      notificationId,
      notificationState: "pending",
      notificationSubject: input.subject,
      notificationBody: input.body,
      notificationQueuedAt: input.queuedAt,
      notificationSentAt: null,
      notificationFailureMessage: null,
      notificationRecipientSpeakerId: recipient.recipientSpeakerId,
      notificationRecipientUserId: recipient.recipientUserId,
      notificationRecipientName: recipient.recipientName,
      notificationRecipientEmail: recipient.recipientEmail,
    });
  } catch (error) {
    const raced = await notificationTarget(database, input.eventId, input.decisionId);
    if (!raced?.notificationId) throw error;
    if (raced.notificationSubject !== input.subject || raced.notificationBody !== input.body) {
      throw new NotificationConflictError();
    }
    return queuedNotificationProjection(raced);
  }
}

export async function ownerWorkspace(database: Database, eventId: string, ownerUserId: string) {
  const event = await database.prepare(
    "SELECT slug, name FROM events WHERE id = ? LIMIT 1",
  ).bind(eventId).first<{ slug: string; name: string }>();
  if (!event) throw new DecisionNotFoundError();
  const { results: proposals } = await database.prepare(
    `SELECT
      proposal.id AS proposalId,
      proposal.public_id AS publicId,
      proposal.title,
      proposal.status,
      proposal.submitted_at AS submittedAt,
      decision.decision AS decisionValue,
      decision.decided_at AS decidedAt,
      notification.state AS notificationState,
      notification.queued_at AS notificationQueuedAt,
      notification.sent_at AS notificationSentAt,
      session.id AS sessionId,
      session.slug AS sessionSlug,
      session.title AS sessionTitle,
      session.track AS sessionTrack,
      session.format AS sessionFormat,
      session.duration_minutes AS sessionDurationMinutes
    FROM proposals AS proposal
    LEFT JOIN decisions AS decision
      ON decision.event_id = proposal.event_id AND decision.proposal_id = proposal.id
    LEFT JOIN acceptances AS acceptance
      ON acceptance.event_id = proposal.event_id AND acceptance.proposal_id = proposal.id
    LEFT JOIN program_sessions AS session
      ON session.id = acceptance.program_session_id AND session.event_id = proposal.event_id
    LEFT JOIN notification_outbox AS notification
      ON notification.decision_id = decision.id AND notification.event_id = proposal.event_id
    WHERE proposal.event_id = ? AND proposal.owner_user_id = ?
    ORDER BY proposal.created_at ASC, proposal.id ASC`,
  ).bind(eventId, ownerUserId).all<OwnerWorkspaceProposalRow>();

  const { results: tasks } = await database.prepare(
    `SELECT
      proposal.id AS proposalId,
      task.id,
      task.task_key AS taskKey,
      task.label,
      task.state,
      task.completed_at AS completedAt
    FROM speaker_tasks AS task
    INNER JOIN program_sessions AS session
      ON session.id = task.program_session_id AND session.event_id = task.event_id
    INNER JOIN proposals AS proposal
      ON proposal.id = session.source_proposal_id AND proposal.event_id = task.event_id
    INNER JOIN speakers AS speaker
      ON speaker.id = task.speaker_id AND speaker.event_id = task.event_id
    WHERE task.event_id = ? AND proposal.owner_user_id = ?
      AND speaker.user_id = ?
    ORDER BY task.created_at ASC, task.id ASC`,
  ).bind(eventId, ownerUserId, ownerUserId).all<OwnerTaskRow>();
  const { results: presenters } = await database.prepare(
    `SELECT
      proposal.id AS proposalId,
      speaker.id AS speakerId,
      speaker.name,
      presenter.role
    FROM session_presenters AS presenter
    INNER JOIN program_sessions AS session
      ON session.id = presenter.program_session_id AND session.event_id = presenter.event_id
    INNER JOIN proposals AS proposal
      ON proposal.id = session.source_proposal_id AND proposal.event_id = presenter.event_id
    INNER JOIN speakers AS speaker
      ON speaker.id = presenter.speaker_id AND speaker.event_id = presenter.event_id
    WHERE presenter.event_id = ? AND proposal.owner_user_id = ?
    ORDER BY presenter.role = 'primary' DESC, speaker.name COLLATE NOCASE ASC, speaker.id ASC`,
  ).bind(eventId, ownerUserId).all<OwnerPresenterRow>();
  const tasksByProposal = new Map<string, OwnerTaskRow[]>();
  for (const task of tasks) {
    const grouped = tasksByProposal.get(task.proposalId) ?? [];
    grouped.push(task);
    tasksByProposal.set(task.proposalId, grouped);
  }
  const presentersByProposal = new Map<string, OwnerPresenterRow[]>();
  for (const presenter of presenters) {
    const grouped = presentersByProposal.get(presenter.proposalId) ?? [];
    grouped.push(presenter);
    presentersByProposal.set(presenter.proposalId, grouped);
  }

  return {
    event,
    proposals: proposals.map((proposal) => ({
      id: proposal.proposalId,
      publicId: proposal.publicId,
      title: proposal.title,
      status: proposal.status,
      decision: proposal.decisionValue,
      notificationStatus: (proposal.notificationState === "pending"
        ? "queued"
        : proposal.notificationState === "sent"
          ? "provider_accepted"
          : proposal.notificationState ?? "not_queued") as "not_queued" | "queued" | "provider_accepted" | "failed",
      acceptedSession: proposal.sessionId ? {
        id: proposal.sessionId,
        slug: proposal.sessionSlug!,
        title: proposal.sessionTitle!,
        track: proposal.sessionTrack!,
        format: proposal.sessionFormat!,
        durationMinutes: proposal.sessionDurationMinutes!,
        presenters: (presentersByProposal.get(proposal.proposalId) ?? []).map(({ proposalId: _, ...presenter }) => presenter),
        tasks: (tasksByProposal.get(proposal.proposalId) ?? []).map(({ proposalId: _, ...task }) => task),
      } : null,
    })),
  };
}
