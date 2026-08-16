import type {
  BulkSpeakerCommunicationEnqueue,
  BulkSpeakerCommunicationResponse,
  CommunicationHistoryResponse,
  EmailCapabilityResponse,
} from "@confpilot/contracts";

import {
  MessageDedupeConflictError,
  prepareMessageEnqueue,
  resolveMessageEnqueue,
} from "./message-outbox";
import type { Database } from "../../runtime/database";

interface SpeakerRecipientRow {
  id: string;
  name: string;
  contactEmail: string;
  eventSlug: string;
  sessionTitle: string | null;
}

interface MessageHistoryRow {
  id: string;
  intent: string;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  state: "queued" | "leased" | "delivered" | "failed";
  attemptCount: number;
  provider: string | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  canceledAt: string | null;
  cancellationCode: string | null;
}

const SPEAKER_LOOKUP_CHUNK_SIZE = 90;

async function stableHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function transportStatus(row: MessageHistoryRow) {
  if (row.state === "delivered") return "provider_accepted" as const;
  if (row.state === "failed") return "failed" as const;
  if (row.canceledAt) return "canceled" as const;
  if (row.state === "leased") return "sending" as const;
  return row.attemptCount > 0 ? "retrying" as const : "queued" as const;
}

export async function listCommunicationHistory(
  database: Database,
  eventId: string,
  capability: EmailCapabilityResponse,
  limit = 100,
): Promise<CommunicationHistoryResponse> {
  const boundedLimit = Math.min(Math.max(limit, 1), 250);
  const result = await database.prepare(`SELECT id, intent,
      recipient_name AS recipientName, recipient_email AS recipientEmail,
      subject, state, attempt_count AS attemptCount, provider,
      provider_message_id AS providerMessageId, last_error_code AS lastErrorCode,
      created_at AS createdAt, updated_at AS updatedAt, delivered_at AS deliveredAt,
      canceled_at AS canceledAt, cancellation_code AS cancellationCode
    FROM message_outbox
    WHERE event_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?`).bind(eventId, boundedLimit).all<MessageHistoryRow>();
  return {
    capability,
    messages: result.results.map((row) => {
      const status = transportStatus(row);
      return {
        id: row.id,
        intent: row.intent,
        recipient: { name: row.recipientName, email: row.recipientEmail },
        subject: row.subject,
        transportStatus: status,
        deliveryStatus: status === "provider_accepted"
          ? "unverified"
          : row.attemptCount > 0 ? "attempted_unverified" : "not_attempted",
        attemptCount: row.attemptCount,
        provider: row.provider,
        providerMessageId: row.providerMessageId,
        lastErrorCode: row.lastErrorCode,
        cancellationCode: row.cancellationCode,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        providerAcceptedAt: status === "provider_accepted" ? row.deliveredAt : null,
      };
    }),
  };
}

export class CommunicationMergeResultError extends Error {
  constructor(public readonly field: "subject" | "body") {
    super(`The personalized ${field} exceeds the immutable message limit.`);
  }
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name.trim();
}

function renderMergeTokens(value: string, speaker: SpeakerRecipientRow, publicOrigin: string) {
  const portalLink = new URL(`/events/${encodeURIComponent(speaker.eventSlug)}/speaker`, publicOrigin).toString();
  const replacements: Record<string, string> = {
    first_name: firstName(speaker.name),
    session_title: speaker.sessionTitle ?? "your ConfPilot session",
    portal_link: portalLink,
  };
  return value.replace(/\{(first_name|session_title|portal_link)\}/g, (_, token: string) => replacements[token]);
}

function personalizedBody(speaker: SpeakerRecipientRow, body: string, publicOrigin: string) {
  const rendered = renderMergeTokens(body, speaker, publicOrigin).trim();
  const content = body.includes("{first_name}") ? rendered : [`Hello ${speaker.name},`, "", rendered].join("\n");
  return [content, "", "This message was sent by an organizer through ConfPilot."].join("\n");
}

export async function enqueueBulkSpeakerCommunication(
  database: Database,
  eventId: string,
  actorUserId: string,
  input: BulkSpeakerCommunicationEnqueue,
  now: string,
  publicOrigin: string,
): Promise<BulkSpeakerCommunicationResponse> {
  const byId = new Map<string, SpeakerRecipientRow>();
  for (let start = 0; start < input.speakerIds.length; start += SPEAKER_LOOKUP_CHUNK_SIZE) {
    const chunk = input.speakerIds.slice(start, start + SPEAKER_LOOKUP_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await database.prepare(`SELECT speaker.id, speaker.name,
        speaker.contact_email AS contactEmail, event.slug AS eventSlug,
        (SELECT session.title FROM session_presenters AS presenter
          INNER JOIN program_sessions AS session
            ON session.event_id = presenter.event_id AND session.id = presenter.program_session_id
          LEFT JOIN schedule_placements AS placement
            ON placement.event_id = session.event_id AND placement.program_session_id = session.id
          WHERE presenter.event_id = speaker.event_id AND presenter.speaker_id = speaker.id
          ORDER BY placement.starts_at IS NULL ASC, placement.starts_at ASC,
            lower(session.title) ASC, session.id ASC
          LIMIT 1) AS sessionTitle
      FROM speakers AS speaker INNER JOIN events AS event ON event.id = speaker.event_id
      WHERE speaker.event_id = ? AND speaker.id IN (${placeholders})`)
      .bind(eventId, ...chunk).all<SpeakerRecipientRow>();
    for (const row of result.results) byId.set(row.id, row);
  }
  const requestHash = (await stableHash(`${actorUserId}\u0000${input.idempotencyKey}`)).slice(0, 32);
  const messageIds: string[] = [];
  const skipped: BulkSpeakerCommunicationResponse["skipped"] = [];
  const rendered = new Map<string, { subject: string; text: string }>();
  const preparedMessages: Array<{
    speakerId: string;
    message: Awaited<ReturnType<typeof prepareMessageEnqueue>>;
  }> = [];

  for (const speakerId of input.speakerIds) {
    const speaker = byId.get(speakerId);
    if (!speaker || !speaker.contactEmail.trim()) continue;
    const subject = renderMergeTokens(input.subject, speaker, publicOrigin).trim();
    const text = personalizedBody(speaker, input.body, publicOrigin).trim();
    if (subject.length < 1 || subject.length > 998) throw new CommunicationMergeResultError("subject");
    if (text.length < 1 || text.length > 20_000) throw new CommunicationMergeResultError("body");
    rendered.set(speakerId, { subject, text });
  }

  for (const speakerId of input.speakerIds) {
    const speaker = byId.get(speakerId);
    if (!speaker) {
      skipped.push({ speakerId, reason: "not_found" });
      continue;
    }
    if (!speaker.contactEmail.trim()) {
      skipped.push({ speakerId, reason: "contact_email_missing" });
      continue;
    }
    const personalized = rendered.get(speakerId)!;
    const targetHash = (await stableHash(speakerId)).slice(0, 32);
    preparedMessages.push({
      speakerId,
      message: await prepareMessageEnqueue(database, {
        eventId,
        actorUserId,
        dedupeKey: `speaker-bulk:${requestHash}:${targetHash}`,
        intent: "speaker_bulk",
        recipientEmail: speaker.contactEmail,
        recipientName: speaker.name,
        templateKey: "speaker.bulk-custom",
        templateRevision: 1,
        subject: personalized.subject,
        text: personalized.text,
        now,
      }),
    });
  }

  if (preparedMessages.length > 0) {
    await database.batch(preparedMessages.map(({ message }) => message.statement));
  }
  for (const { speakerId, message } of preparedMessages) {
    try {
      const row = await resolveMessageEnqueue(database, message);
      messageIds.push(row.id);
    } catch (error) {
      if (error instanceof MessageDedupeConflictError) {
        skipped.push({ speakerId, reason: "idempotency_conflict" });
        continue;
      }
      throw error;
    }
  }
  return {
    requestedCount: input.speakerIds.length,
    queuedCount: messageIds.length,
    messageIds,
    skipped,
  };
}
