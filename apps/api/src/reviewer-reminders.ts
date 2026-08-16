import type { ReviewerReminderEnqueue, ReviewerReminderResponse } from "@confpilot/contracts";

import { enqueueMessage, MessageDedupeConflictError, publicOutboxState } from "./features/messaging/message-outbox";
import type { Database } from "./runtime/database";
import { constraintMessage } from "./runtime/database";

interface ReviewerRow {
  eventSlug: string;
  eventName: string;
  userId: string;
  displayName: string;
  email: string;
}

interface PendingAssignmentRow {
  proposalTitle: string;
  dueAt: string | null;
}

export const REVIEWER_REMINDER_TEMPLATES = [
  {
    key: "reviewer.pending-reviews-reminder",
    revision: 1,
    label: "Pending-reviews reminder",
    description: "Lists the reviewer's active assignments that have no submitted evaluation yet.",
  },
] as const;

export class ReviewerReminderNotFoundError extends Error {}
export class ReviewerReminderTemplateNotFoundError extends Error {}
export class ReviewerReminderIdempotencyConflictError extends Error {}
export class ReviewerReminderAuthorizationError extends Error {}

export type ReviewerReminderIneligibleReason = "NO_PENDING_REVIEWS";

export class ReviewerReminderIneligibleError extends Error {
  constructor(public readonly reason: ReviewerReminderIneligibleReason) {
    super(reason);
  }
}

function utcSecond(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError("now must be a UTC timestamp with second precision");
  }
  return value;
}

async function reminderDedupeKey(input: ReviewerReminderEnqueue) {
  const canonical = `${input.reviewerUserId}\u0000${input.roundId ?? ""}\u0000${input.templateKey}\u0000${input.idempotencyKey}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `reviewer-reminder:${hash}`;
}

function assignmentLine(row: PendingAssignmentRow) {
  return row.dueAt ? `${row.proposalTitle} (due ${row.dueAt})` : `${row.proposalTitle} (no due time recorded)`;
}

export async function enqueueReviewerReminder(
  db: Database,
  eventId: string,
  actorUserId: string,
  input: ReviewerReminderEnqueue,
  now: string,
): Promise<ReviewerReminderResponse> {
  const template = REVIEWER_REMINDER_TEMPLATES.find((candidate) => candidate.key === input.templateKey);
  if (!template) throw new ReviewerReminderTemplateNotFoundError();
  const reviewer = await db.prepare(`SELECT
      event.slug AS eventSlug, event.name AS eventName,
      account.id AS userId, account.display_name AS displayName, account.email AS email
    FROM event_memberships AS membership
    INNER JOIN events AS event ON event.id = membership.event_id
    INNER JOIN users AS account ON account.id = membership.user_id
    WHERE membership.event_id = ? AND membership.user_id = ? AND membership.role = 'reviewer'
    LIMIT 1`)
    .bind(eventId, input.reviewerUserId).first<ReviewerRow>();
  if (!reviewer) throw new ReviewerReminderNotFoundError();

  const pending = await db.prepare(`SELECT proposal.title AS proposalTitle, assignment.due_at AS dueAt
    FROM review_assignments AS assignment
    INNER JOIN proposals AS proposal ON proposal.id = assignment.proposal_id
    WHERE assignment.event_id = ?1 AND assignment.reviewer_user_id = ?2
      AND assignment.state = 'assigned'
      AND (?3 IS NULL OR assignment.review_round_id IS ?3)
      AND NOT EXISTS (SELECT 1 FROM reviews WHERE assignment_id = assignment.id)
      AND NOT EXISTS (
        SELECT 1 FROM review_assignment_actions
        WHERE assignment_id = assignment.id AND action IN ('declined', 'recused')
      )
      AND NOT EXISTS (SELECT 1 FROM reviewer_conflicts WHERE assignment_id = assignment.id)
    ORDER BY assignment.due_at IS NULL, assignment.due_at, proposal.title, assignment.id`)
    .bind(eventId, input.reviewerUserId, input.roundId ?? null).all<PendingAssignmentRow>();
  if (pending.results.length === 0) throw new ReviewerReminderIneligibleError("NO_PENDING_REVIEWS");

  const rendered = {
    subject: `${reviewer.eventName}: pending review reminder`,
    text: [
      `Hello ${reviewer.displayName},`,
      "",
      `The ${reviewer.eventName} organizer recorded these assignments awaiting your evaluation:`,
      ...pending.results.map((row) => `- ${assignmentLine(row)}`),
      "",
      `Sign in to this ConfPilot instance and open /events/${encodeURIComponent(reviewer.eventSlug)}/reviewer to review the canonical status.`,
      "",
      "This is a deterministic status reminder generated from the event record.",
    ].join("\n"),
  };

  let row;
  try {
    row = await enqueueMessage(db, {
      eventId,
      actorUserId,
      dedupeKey: await reminderDedupeKey(input),
      intent: "reviewer_reminder",
      recipientEmail: reviewer.email,
      recipientName: reviewer.displayName,
      templateKey: template.key,
      templateRevision: template.revision,
      subject: rendered.subject,
      text: rendered.text,
      now: utcSecond(now),
    });
  } catch (error) {
    if (error instanceof MessageDedupeConflictError) throw new ReviewerReminderIdempotencyConflictError();
    if (/message actor must be a same-event organizer/i.test(constraintMessage(error))) {
      throw new ReviewerReminderAuthorizationError();
    }
    throw error;
  }
  return {
    messageId: row.id,
    reviewerUserId: reviewer.userId,
    templateKey: template.key,
    templateRevision: template.revision,
    outboxState: publicOutboxState(row.state),
    pendingAssignments: pending.results.length,
  };
}
