import {
  normalizedEmailSchema,
  type SpeakerReminderEnqueue,
  type SpeakerReminderEnqueueResponse,
  type SpeakerReminderTemplate,
  type SpeakerReminderTemplateKey,
  type SpeakerReminderTemplateListResponse,
} from "@confpilot/contracts";

import { enqueueMessage, MessageDedupeConflictError, publicOutboxState } from "./features/messaging/message-outbox";
import type { Database } from "./runtime/database";
import { constraintMessage } from "./runtime/database";

export interface SpeakerReminderRecipient {
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

export interface SpeakerReminderTask {
  id: string;
  label: string;
  dueAt: string | null;
  sessionTitle: string;
}

export interface SpeakerReminderSession {
  id: string;
  title: string;
  deliverablesStatus: "missing" | "submitted" | "ready";
}

export const SPEAKER_REMINDER_TEMPLATES = [
  {
    key: "speaker.readiness-reminder",
    revision: 2,
    label: "Readiness reminder",
    description: "Lists the speaker's current incomplete profile, release, headshot, task, and deliverable items.",
  },
  {
    key: "speaker.task-reminder",
    revision: 2,
    label: "Open-task reminder",
    description: "Lists only the speaker's current open readiness tasks and their recorded due times.",
  },
] as const satisfies readonly SpeakerReminderTemplate[];

export class SpeakerReminderNotFoundError extends Error {}
export class SpeakerReminderTemplateNotFoundError extends Error {}
export class SpeakerReminderIdempotencyConflictError extends Error {}
export class SpeakerReminderAuthorizationError extends Error {}

export interface SpeakerReminderPreview {
  speakerId: string;
  recipientName: string;
  recipientEmail: string;
  templateKey: SpeakerReminderTemplateKey;
  templateRevision: number;
  subject: string;
  text: string;
}

export type SpeakerReminderIneligibleReason =
  | "NO_CONTACT_EMAIL"
  | "UNSAFE_RECIPIENT"
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

function ellipsize(value: string, maximum: number) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function taskLine(task: SpeakerReminderTask) {
  const item = `${ellipsize(task.sessionTitle, 300)} — ${ellipsize(task.label, 300)}`;
  return task.dueAt ? `${item} (due ${task.dueAt})` : `${item} (no due time recorded)`;
}

function renderReadinessReminder(
  speaker: SpeakerReminderRecipient,
  tasks: SpeakerReminderTask[],
  sessions: SpeakerReminderSession[],
) {
  const outstanding: string[] = [];
  if (speaker.workflowStatus !== "confirmed") outstanding.push("Confirm your participation");
  if (speaker.profileStatus !== "ready") outstanding.push("Complete your speaker profile");
  if (speaker.agreementStatus !== "signed") outstanding.push("Complete the speaker release requirements");
  if (!speaker.headshotObjectKey) outstanding.push("Upload your speaker headshot");
  outstanding.push(...tasks.map((task) => taskLine(task)));
  outstanding.push(...sessions
    .filter((session) => session.deliverablesStatus !== "ready")
    .map((session) => `Complete deliverables for “${ellipsize(session.title, 300)}”`));
  if (outstanding.length === 0) throw new SpeakerReminderIneligibleError("NO_OUTSTANDING_ITEMS");
  const visible = outstanding.slice(0, 20);
  if (outstanding.length > visible.length) visible.push(`And ${outstanding.length - visible.length} more outstanding items`);
  return {
    subject: `${speaker.eventName}: speaker readiness reminder`,
    text: [
      `Hello ${speaker.name},`,
      "",
      `The ${speaker.eventName} organizer recorded these outstanding speaker-readiness items:`,
      ...visible.map((item) => `- ${item}`),
      "",
      `Sign in to this ConfPilot instance and open ${portalPath(speaker.eventSlug)} to review the canonical status.`,
      "",
      "This is a deterministic status reminder generated from the event record.",
    ].join("\n"),
  };
}

function renderTaskReminder(speaker: SpeakerReminderRecipient, tasks: SpeakerReminderTask[]) {
  if (tasks.length === 0) throw new SpeakerReminderIneligibleError("NO_OUTSTANDING_ITEMS");
  const visible = tasks.slice(0, 20);
  return {
    subject: `${speaker.eventName}: open speaker tasks`,
    text: [
      `Hello ${speaker.name},`,
      "",
      `The ${speaker.eventName} organizer recorded these open speaker tasks:`,
      ...visible.map((task) => `- ${taskLine(task)}`),
      ...(tasks.length > visible.length ? [`- And ${tasks.length - visible.length} more open tasks`] : []),
      "",
      `Sign in to this ConfPilot instance and open ${portalPath(speaker.eventSlug)} to review the canonical status.`,
      "",
      "This is a deterministic task reminder generated from the event record.",
    ].join("\n"),
  };
}

export function renderSpeakerReminderPreview(
  speaker: SpeakerReminderRecipient,
  tasks: SpeakerReminderTask[],
  sessions: SpeakerReminderSession[],
  templateKey: SpeakerReminderTemplateKey,
): SpeakerReminderPreview {
  const template = SPEAKER_REMINDER_TEMPLATES.find((candidate) => candidate.key === templateKey);
  if (!template) throw new SpeakerReminderTemplateNotFoundError();
  if (!speaker.userId || speaker.hasSpeakerMembership !== 1) {
    throw new SpeakerReminderIneligibleError("SPEAKER_ACCESS_UNAVAILABLE");
  }
  if (speaker.workflowStatus === "declined") throw new SpeakerReminderIneligibleError("SPEAKER_DECLINED");
  if (!speaker.contactEmail.trim()) throw new SpeakerReminderIneligibleError("NO_CONTACT_EMAIL");
  const parsedEmail = normalizedEmailSchema.safeParse(speaker.contactEmail);
  if (!parsedEmail.success) throw new SpeakerReminderIneligibleError("UNSAFE_RECIPIENT");
  const rendered = templateKey === "speaker.task-reminder"
    ? renderTaskReminder(speaker, tasks)
    : renderReadinessReminder(speaker, tasks, sessions);
  return {
    speakerId: speaker.speakerId,
    recipientName: speaker.name,
    recipientEmail: parsedEmail.data,
    templateKey: template.key,
    templateRevision: template.revision,
    subject: rendered.subject,
    text: rendered.text,
  };
}

export async function previewSpeakerReminder(
  db: Database,
  eventId: string,
  input: Pick<SpeakerReminderEnqueue, "speakerId" | "templateKey">,
): Promise<SpeakerReminderPreview> {
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
    .bind(eventId, input.speakerId).first<SpeakerReminderRecipient>();
  if (!speaker) throw new SpeakerReminderNotFoundError();

  const taskResult = await db.prepare(`SELECT task.id, task.label, task.due_at AS dueAt,
      session.title AS sessionTitle
    FROM speaker_tasks AS task
    INNER JOIN program_sessions AS session
      ON session.event_id = task.event_id AND session.id = task.program_session_id
    WHERE task.event_id = ? AND task.speaker_id = ? AND task.state = 'open'
    ORDER BY task.due_at IS NULL, task.due_at, session.title, task.label, task.id`)
    .bind(eventId, input.speakerId).all<SpeakerReminderTask>();
  const sessionResult = await db.prepare(`SELECT session.id, session.title,
      session.deliverables_status AS deliverablesStatus
    FROM session_presenters AS presenter
    INNER JOIN program_sessions AS session
      ON session.event_id = presenter.event_id AND session.id = presenter.program_session_id
    WHERE presenter.event_id = ? AND presenter.speaker_id = ?
    ORDER BY session.title, session.id`).bind(eventId, input.speakerId).all<SpeakerReminderSession>();
  return renderSpeakerReminderPreview(speaker, taskResult.results, sessionResult.results, input.templateKey);
}

export async function enqueueSpeakerReminder(
  db: Database,
  eventId: string,
  actorUserId: string,
  input: SpeakerReminderEnqueue,
  now: string,
): Promise<SpeakerReminderEnqueueResponse> {
  const preview = await previewSpeakerReminder(db, eventId, input);
  let row;
  try {
    row = await enqueueMessage(db, {
      eventId,
      actorUserId,
      dedupeKey: await reminderDedupeKey(input),
      intent: "speaker_reminder",
      recipientEmail: preview.recipientEmail,
      recipientName: preview.recipientName,
      templateKey: preview.templateKey,
      templateRevision: preview.templateRevision,
      subject: preview.subject,
      text: preview.text,
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
    speakerId: preview.speakerId,
    templateKey: preview.templateKey,
    templateRevision: preview.templateRevision,
    outboxState: publicOutboxState(row.state),
  };
}
