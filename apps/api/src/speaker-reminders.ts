import type {
  SpeakerReminderEnqueue,
  SpeakerReminderEnqueueResponse,
  SpeakerReminderTemplate,
  SpeakerReminderTemplateKey,
  SpeakerReminderTemplateListResponse,
} from "@confpilot/contracts";

import { enqueueMessage, MessageDedupeConflictError, publicOutboxState } from "./features/messaging/message-outbox";
import type { Database } from "./runtime/database";
import { constraintMessage } from "./runtime/database";

interface SpeakerReminderRow {
  eventId: string;
  eventSlug: string;
  eventName: string;
  speakerId: string;
  userId: string | null;
  hasSpeakerMembership: number;
  name: string;
  contactEmail: string;
  workflowStatus: "invited" | "confirmed" | "declined";
  profileStatus: "incomplete" | "ready";
  agreementStatus: "missing" | "signed";
  headshotObjectKey: string | null;
}

interface TaskRow {
  id: string;
  label: string;
  dueAt: string | null;
  sessionTitle: string;
}

interface SessionRow {
  id: string;
  title: string;
  deliverablesStatus: "missing" | "submitted" | "ready";
}

export const SPEAKER_REMINDER_TEMPLATES = [
  {
    key: "speaker.readiness-reminder",
    revision: 1,
    label: "Readiness reminder",
    description: "Lists the speaker's current incomplete profile, release, headshot, task, and deliverable items.",
  },
  {
    key: "speaker.task-reminder",
    revision: 1,
    label: "Open-task reminder",
    description: "Lists only the speaker's current open readiness tasks and their recorded due times.",
  },
] as const satisfies readonly SpeakerReminderTemplate[];

export class SpeakerReminderNotFoundError extends Error {}
export class SpeakerReminderTemplateNotFoundError extends Error {}
export class SpeakerReminderIdempotencyConflictError extends Error {}
export class SpeakerReminderAuthorizationError extends Error {}

export type SpeakerReminderIneligibleReason =
  | "NO_CONTACT_EMAIL"
  | "SPEAKER_ACCESS_UNAVAILABLE"
  | "SPEAKER_DECLINED"
  | "NO_OUTSTANDING_ITEMS";

export class SpeakerReminderIneligibleError extends Error {
  constructor(public readonly reason: SpeakerReminderIneligibleReason) {
    super(reason);
  }
}

export function listSpeakerReminderTemplates(): SpeakerReminderTemplateListResponse {
  return { templates: SPEAKER_REMINDER_TEMPLATES.map((template) => ({ ...template })) };
}

function utcSecond(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError("now must be a UTC timestamp with second precision");
  }
  return value;
}

async function reminderDedupeKey(input: SpeakerReminderEnqueue) {
  const canonical = `${input.speakerId}\u0000${input.templateKey}\u0000${input.idempotencyKey}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `speaker-reminder:${hash}`;
}

function portalPath(eventSlug: string) {
  return `/events/${encodeURIComponent(eventSlug)}/speaker`;
}

function taskLine(task: TaskRow) {
  const item = `${task.sessionTitle} — ${task.label}`;
  return task.dueAt ? `${item} (due ${task.dueAt})` : `${item} (no due time recorded)`;
}

function renderReadinessReminder(speaker: SpeakerReminderRow, tasks: TaskRow[], sessions: SessionRow[]) {
  const outstanding: string[] = [];
  if (speaker.workflowStatus !== "confirmed") outstanding.push("Confirm your participation");
  if (speaker.profileStatus !== "ready") outstanding.push("Complete your speaker profile");
  if (speaker.agreementStatus !== "signed") outstanding.push("Complete the speaker release requirements");
  if (!speaker.headshotObjectKey) outstanding.push("Upload your speaker headshot");
  outstanding.push(...tasks.map((task) => taskLine(task)));
  outstanding.push(...sessions
    .filter((session) => session.deliverablesStatus !== "ready")
    .map((session) => `Complete deliverables for “${session.title}”`));
  if (outstanding.length === 0) throw new SpeakerReminderIneligibleError("NO_OUTSTANDING_ITEMS");
  return {
    subject: `${speaker.eventName}: speaker readiness reminder`,
    text: [
      `Hello ${speaker.name},`,
      "",
      `The ${speaker.eventName} organizer recorded these outstanding speaker-readiness items:`,
      ...outstanding.map((item) => `- ${item}`),
      "",
      `Sign in to this ConfPilot instance and open ${portalPath(speaker.eventSlug)} to review the canonical status.`,
      "",
      "This is a deterministic status reminder generated from the event record.",
    ].join("\n"),
  };
}

function renderTaskReminder(speaker: SpeakerReminderRow, tasks: TaskRow[]) {
  if (tasks.length === 0) throw new SpeakerReminderIneligibleError("NO_OUTSTANDING_ITEMS");
  return {
    subject: `${speaker.eventName}: open speaker tasks`,
    text: [
      `Hello ${speaker.name},`,
      "",
      `The ${speaker.eventName} organizer recorded these open speaker tasks:`,
      ...tasks.map((task) => `- ${taskLine(task)}`),
      "",
      `Sign in to this ConfPilot instance and open ${portalPath(speaker.eventSlug)} to review the canonical status.`,
      "",
      "This is a deterministic task reminder generated from the event record.",
    ].join("\n"),
  };
}

export async function enqueueSpeakerReminder(
  db: Database,
  eventId: string,
  actorUserId: string,
  input: SpeakerReminderEnqueue,
  now: string,
): Promise<SpeakerReminderEnqueueResponse> {
  const template = SPEAKER_REMINDER_TEMPLATES.find((candidate) => candidate.key === input.templateKey);
  if (!template) throw new SpeakerReminderTemplateNotFoundError();
  const speaker = await db.prepare(`SELECT
      event.id AS eventId, event.slug AS eventSlug, event.name AS eventName,
      speaker.id AS speakerId, speaker.user_id AS userId, speaker.name,
      EXISTS (SELECT 1 FROM event_memberships AS membership
        WHERE membership.event_id = speaker.event_id AND membership.user_id = speaker.user_id
          AND membership.role = 'speaker') AS hasSpeakerMembership,
      speaker.contact_email AS contactEmail, speaker.workflow_status AS workflowStatus,
      speaker.profile_status AS profileStatus, speaker.agreement_status AS agreementStatus,
      speaker.headshot_object_key AS headshotObjectKey
    FROM speakers AS speaker
    INNER JOIN events AS event ON event.id = speaker.event_id
    WHERE speaker.event_id = ? AND speaker.id = ? LIMIT 1`)
    .bind(eventId, input.speakerId).first<SpeakerReminderRow>();
  if (!speaker) throw new SpeakerReminderNotFoundError();
  if (!speaker.userId || speaker.hasSpeakerMembership !== 1) {
    throw new SpeakerReminderIneligibleError("SPEAKER_ACCESS_UNAVAILABLE");
  }
  if (speaker.workflowStatus === "declined") throw new SpeakerReminderIneligibleError("SPEAKER_DECLINED");
  if (!speaker.contactEmail.trim()) throw new SpeakerReminderIneligibleError("NO_CONTACT_EMAIL");

  const taskResult = await db.prepare(`SELECT task.id, task.label, task.due_at AS dueAt,
      session.title AS sessionTitle
    FROM speaker_tasks AS task
    INNER JOIN program_sessions AS session
      ON session.event_id = task.event_id AND session.id = task.program_session_id
    WHERE task.event_id = ? AND task.speaker_id = ? AND task.state = 'open'
    ORDER BY task.due_at IS NULL, task.due_at, session.title, task.label, task.id`)
    .bind(eventId, input.speakerId).all<TaskRow>();
  const sessionResult = await db.prepare(`SELECT session.id, session.title,
      session.deliverables_status AS deliverablesStatus
    FROM session_presenters AS presenter
    INNER JOIN program_sessions AS session
      ON session.event_id = presenter.event_id AND session.id = presenter.program_session_id
    WHERE presenter.event_id = ? AND presenter.speaker_id = ?
    ORDER BY session.title, session.id`).bind(eventId, input.speakerId).all<SessionRow>();
  const rendered = input.templateKey === "speaker.task-reminder"
    ? renderTaskReminder(speaker, taskResult.results)
    : renderReadinessReminder(speaker, taskResult.results, sessionResult.results);
  let row;
  try {
    row = await enqueueMessage(db, {
      eventId,
      actorUserId,
      dedupeKey: await reminderDedupeKey(input),
      intent: "speaker_reminder",
      recipientEmail: speaker.contactEmail,
      recipientName: speaker.name,
      templateKey: template.key,
      templateRevision: template.revision,
      subject: rendered.subject,
      text: rendered.text,
      now: utcSecond(now),
    });
  } catch (error) {
    if (error instanceof MessageDedupeConflictError) throw new SpeakerReminderIdempotencyConflictError();
    if (/message actor must be a same-event organizer/i.test(constraintMessage(error))) {
      throw new SpeakerReminderAuthorizationError();
    }
    throw error;
  }
  return {
    messageId: row.id,
    speakerId: speaker.speakerId,
    templateKey: template.key as SpeakerReminderTemplateKey,
    templateRevision: template.revision,
    outboxState: publicOutboxState(row.state),
  };
}
