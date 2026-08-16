import type { EmailDeliveryRuntime } from "../../runtime/email-sender";
import type { Database } from "../../runtime/database";

const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTENT = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const TEMPLATE_KEY = /^[a-z0-9][a-z0-9_.-]{0,119}$/;
const MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface EnqueueMessageInput {
  id?: string;
  eventId: string;
  actorUserId?: string;
  dedupeKey: string;
  intent: string;
  recipientEmail: string;
  recipientName: string;
  templateKey: string;
  templateRevision: number;
  subject: string;
  text: string;
  now: string;
  expiresAt?: string;
}

interface MessageRow {
  id: string;
  eventId: string;
  dedupeKey: string;
  recipientEmail: string;
  subject: string;
  text: string;
  contentSha256: string;
  state: "queued" | "leased" | "delivered" | "failed";
  attemptCount: number;
}

export interface PreparedMessageEnqueue {
  eventId: string;
  dedupeKey: string;
  contentSha256: string;
  statement: ReturnType<Database["prepare"]>;
}

export class MessageDedupeConflictError extends Error {
  constructor() {
    super("The message dedupe key already identifies different content.");
    this.name = "MessageDedupeConflictError";
  }
}

export class EmailDeliveryUnavailableError extends Error {
  readonly reason: Exclude<EmailDeliveryRuntime["capability"]["reason"], "configured">;

  constructor(reason: Exclude<EmailDeliveryRuntime["capability"]["reason"], "configured">) {
    super("Message delivery is not configured.");
    this.name = "EmailDeliveryUnavailableError";
    this.reason = reason;
  }
}

function requireUtcSeconds(name: string, value: string) {
  const parsed = Date.parse(value);
  const canonical = Number.isNaN(parsed)
    ? null
    : new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!UTC_SECONDS.test(value) || canonical !== value) throw new TypeError(`${name} must be a UTC timestamp with second precision`);
  return value;
}

function addSeconds(value: string, seconds: number) {
  return new Date(Date.parse(value) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function contentHash(input: EnqueueMessageInput) {
  const canonical = JSON.stringify({
    intent: input.intent,
    recipientEmail: input.recipientEmail.trim().toLowerCase(),
    recipientName: input.recipientName.trim(),
    templateKey: input.templateKey,
    templateRevision: input.templateRevision,
    subject: input.subject.trim(),
    text: input.text.trim(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boundedTrimmed(name: string, value: string, maximum: number) {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new TypeError(`${name} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function normalizeInput(input: EnqueueMessageInput): EnqueueMessageInput {
  const id = input.id === undefined ? undefined : boundedTrimmed("id", input.id, 200);
  const eventId = boundedTrimmed("eventId", input.eventId, 200);
  const actorUserId = input.actorUserId === undefined
    ? undefined
    : boundedTrimmed("actorUserId", input.actorUserId, 200);
  const dedupeKey = boundedTrimmed("dedupeKey", input.dedupeKey, 200);
  const intent = input.intent.trim();
  if (!INTENT.test(intent)) throw new TypeError("intent must be a lowercase identifier");
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  if (recipientEmail.length > 254 || !EMAIL_ADDRESS.test(recipientEmail)) {
    throw new TypeError("recipientEmail must be a valid normalized address");
  }
  const recipientName = boundedTrimmed("recipientName", input.recipientName, 120);
  const templateKey = input.templateKey.trim();
  if (!TEMPLATE_KEY.test(templateKey)) throw new TypeError("templateKey must be a lowercase identifier");
  if (!Number.isSafeInteger(input.templateRevision) || input.templateRevision < 1) {
    throw new TypeError("templateRevision must be a positive integer");
  }
  const now = requireUtcSeconds("now", input.now);
  const expiresAt = input.expiresAt === undefined ? undefined : requireUtcSeconds("expiresAt", input.expiresAt);
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new TypeError("expiresAt must be later than now");
  }
  return {
    ...input,
    id,
    eventId,
    actorUserId,
    dedupeKey,
    intent,
    recipientEmail,
    recipientName,
    templateKey,
    subject: boundedTrimmed("subject", input.subject, 998),
    text: boundedTrimmed("text", input.text, 20_000),
    now,
    expiresAt,
  };
}

async function findMessage(db: Database, eventId: string, dedupeKey: string) {
  return db.prepare(`SELECT id, event_id AS eventId, dedupe_key AS dedupeKey,
      recipient_email AS recipientEmail, subject, text_body AS text,
      content_sha256 AS contentSha256, state, attempt_count AS attemptCount
    FROM message_outbox WHERE event_id = ? AND dedupe_key = ? LIMIT 1`)
    .bind(eventId, dedupeKey).first<MessageRow>();
}

export async function prepareMessageInsert(db: Database, input: EnqueueMessageInput) {
  const normalized = normalizeInput(input);
  const hash = await contentHash(normalized);
  const id = normalized.id ?? crypto.randomUUID();
  return {
    id,
    eventId: normalized.eventId,
    dedupeKey: normalized.dedupeKey,
    contentSha256: hash,
    statement: db.prepare(`INSERT INTO message_outbox (
        id, event_id, actor_user_id, dedupe_key, intent, recipient_email, recipient_name,
        template_key, template_revision, subject, text_body, content_sha256,
        state, attempt_count, next_attempt_at, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`)
      .bind(
        id, normalized.eventId, normalized.actorUserId ?? null,
        normalized.dedupeKey, normalized.intent,
        normalized.recipientEmail, normalized.recipientName, normalized.templateKey,
        normalized.templateRevision, normalized.subject, normalized.text, hash,
        normalized.now, normalized.now, normalized.now, normalized.expiresAt ?? null,
      ),
  };
}

export async function prepareMessageEnqueue(
  db: Database,
  input: EnqueueMessageInput,
): Promise<PreparedMessageEnqueue> {
  const normalized = normalizeInput(input);
  const hash = await contentHash(normalized);
  return {
    eventId: normalized.eventId,
    dedupeKey: normalized.dedupeKey,
    contentSha256: hash,
    statement: db.prepare(`INSERT INTO message_outbox (
        id, event_id, actor_user_id, dedupe_key, intent, recipient_email, recipient_name,
        template_key, template_revision, subject, text_body, content_sha256,
        state, attempt_count, next_attempt_at, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      ON CONFLICT(event_id, dedupe_key) DO NOTHING`)
      .bind(
        normalized.id ?? crypto.randomUUID(), normalized.eventId, normalized.actorUserId ?? null,
        normalized.dedupeKey, normalized.intent,
        normalized.recipientEmail, normalized.recipientName, normalized.templateKey,
        normalized.templateRevision, normalized.subject, normalized.text, hash,
        normalized.now, normalized.now, normalized.now, normalized.expiresAt ?? null,
      ),
  };
}

export async function resolveMessageEnqueue(db: Database, prepared: PreparedMessageEnqueue) {
  const row = await findMessage(db, prepared.eventId, prepared.dedupeKey);
  if (!row) throw new Error("Message enqueue did not create or find an outbox row.");
  if (row.contentSha256 !== prepared.contentSha256) throw new MessageDedupeConflictError();
  return row;
}

export async function enqueueMessage(db: Database, input: EnqueueMessageInput) {
  const prepared = await prepareMessageEnqueue(db, input);
  await prepared.statement.run();
  return resolveMessageEnqueue(db, prepared);
}

function safeProviderCode(code: string) {
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "PROVIDER_FAILURE";
}

export interface DispatchOptions {
  now: string;
  limit?: number;
  leaseSeconds?: number;
  sendTimeoutMs?: number;
}

export function publicOutboxState(state: MessageRow["state"]) {
  return state === "delivered" ? "provider_accepted" as const : state;
}

export interface PurgeMessagesOptions {
  before: string;
  limit?: number;
}

/** Bounded retention primitive. Authorization and scheduling belong to the host runtime. */
export async function purgeTerminalMessages(db: Database, options: PurgeMessagesOptions) {
  const before = requireUtcSeconds("before", options.before);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
  const deleted = await db.prepare(`DELETE FROM message_outbox WHERE id IN (
      SELECT id FROM message_outbox
      WHERE (state IN ('delivered', 'failed') OR canceled_at IS NOT NULL) AND state != 'leased' AND updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM reviewer_invitations WHERE outbox_message_id = message_outbox.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM speaker_claim_invitations WHERE outbox_message_id = message_outbox.id
        )
      ORDER BY updated_at, id LIMIT ?
    )`).bind(before, limit).run();
  return deleted.meta.changes ?? 0;
}

export async function dispatchQueuedMessages(
  db: Database,
  runtime: EmailDeliveryRuntime,
  options: DispatchOptions,
) {
  if (!runtime.capability.enabled) throw new EmailDeliveryUnavailableError(runtime.capability.reason);
  const now = requireUtcSeconds("now", options.now);
  const sendAfter = requireUtcSeconds("sendAfter", runtime.capability.sendAfter);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const leaseSeconds = Math.min(Math.max(options.leaseSeconds ?? 60, 10), 900);
  const sendTimeoutMs = Math.min(Math.max(options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS, 1), 60_000);
  const summary = { providerAccepted: 0, retried: 0, failed: 0, recovered: 0, skipped: 0 };

  const recovered = await db.prepare(`UPDATE message_outbox SET state = 'queued', lease_expires_at = NULL,
      lease_token = NULL, last_error_code = 'LEASE_EXPIRED', updated_at = ?,
      next_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ', ?,
        '+' || MIN(3600, 30 * (1 << (attempt_count - 1))) || ' seconds')
    WHERE state = 'leased' AND lease_expires_at <= ? AND attempt_count < ?`)
    .bind(now, now, now, MAX_DELIVERY_ATTEMPTS).run();
  summary.recovered = recovered.meta.changes ?? 0;
  const exhausted = await db.prepare(`UPDATE message_outbox SET state = 'failed', lease_expires_at = NULL,
      lease_token = NULL, last_error_code = 'MAX_ATTEMPTS', updated_at = ?
    WHERE state = 'leased' AND lease_expires_at <= ? AND attempt_count >= ?`)
    .bind(now, now, MAX_DELIVERY_ATTEMPTS).run();
  summary.failed += exhausted.meta.changes ?? 0;

  const expired = await db.prepare(`UPDATE message_outbox
    SET canceled_at = ?, cancellation_code = 'MESSAGE_EXPIRED', updated_at = ?
    WHERE state = 'queued' AND canceled_at IS NULL
      AND expires_at IS NOT NULL AND expires_at <= ?`)
    .bind(now, now, now).run();
  summary.skipped += expired.meta.changes ?? 0;

  const candidates = await db.prepare(`SELECT id FROM message_outbox
    WHERE state = 'queued' AND created_at >= ? AND next_attempt_at <= ? AND attempt_count < ?
      AND canceled_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY CASE intent
      WHEN 'decision_notification' THEN 0
      WHEN 'reviewer_reminder' THEN 1
      WHEN 'speaker_reminder' THEN 2
      ELSE 3 END,
      next_attempt_at, created_at, id LIMIT ?`).bind(sendAfter, now, MAX_DELIVERY_ATTEMPTS, now, limit)
    .all<{ id: string }>();
  for (const candidate of candidates.results) {
    const leaseToken = crypto.randomUUID();
    const leased = await db.prepare(`UPDATE message_outbox SET state = 'leased',
        attempt_count = attempt_count + 1, lease_expires_at = ?, lease_token = ?, last_error_code = NULL,
        updated_at = ? WHERE id = ? AND state = 'queued' AND next_attempt_at <= ?
          AND canceled_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(addSeconds(now, leaseSeconds), leaseToken, now, candidate.id, now, now).run();
    if ((leased.meta.changes ?? 0) !== 1) {
      summary.skipped += 1;
      continue;
    }
    const row = await db.prepare(`SELECT id, recipient_email AS recipientEmail,
        subject, text_body AS text, attempt_count AS attemptCount, canceled_at AS canceledAt
      FROM message_outbox WHERE id = ? LIMIT 1`).bind(candidate.id)
      .first<Pick<MessageRow, "id" | "recipientEmail" | "subject" | "text" | "attemptCount">
        & { canceledAt: string | null }>();
    if (!row) {
      summary.skipped += 1;
      continue;
    }
    if (row.canceledAt !== null) {
      await db.prepare(`UPDATE message_outbox SET state = 'queued', lease_expires_at = NULL,
          lease_token = NULL, attempt_count = max(attempt_count - 1, 0), updated_at = max(updated_at, ?)
        WHERE id = ? AND state = 'leased' AND lease_token = ? AND canceled_at IS NOT NULL`)
        .bind(now, row.id, leaseToken).run();
      summary.skipped += 1;
      continue;
    }
    let result;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      result = await Promise.race([
        runtime.sender.send({
          outboxId: row.id,
          to: row.recipientEmail,
          subject: row.subject,
          text: row.text,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error("SENDER_TIMEOUT"));
          }, sendTimeoutMs);
        }),
      ]);
    } catch {
      result = {
        ok: false,
        provider: runtime.capability.provider,
        code: timedOut ? "SENDER_TIMEOUT" : "SENDER_THREW",
        retryable: true,
      } as const;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (result.ok) {
      const delivered = await db.prepare(`UPDATE message_outbox SET state = 'delivered', lease_expires_at = NULL,
          lease_token = NULL,
          provider = ?, provider_message_id = ?, delivered_at = ?, last_error_code = NULL,
          updated_at = ? WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(result.provider, result.providerMessageId, now, now, row.id, leaseToken).run();
      if ((delivered.meta.changes ?? 0) === 1) summary.providerAccepted += 1;
      else summary.skipped += 1;
      continue;
    }
    const code = safeProviderCode(result.code);
    if (code === "E_DAILY_LIMIT_EXCEEDED") {
      const deferred = await db.prepare(`UPDATE message_outbox SET state = 'queued',
          attempt_count = max(attempt_count - 1, 0), lease_expires_at = NULL, lease_token = NULL,
          provider = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(result.provider, code, addSeconds(now, 86_400), now, row.id, leaseToken).run();
      if ((deferred.meta.changes ?? 0) === 1) summary.retried += 1;
      else summary.skipped += 1;
      continue;
    }
    if (result.retryable && row.attemptCount < MAX_DELIVERY_ATTEMPTS) {
      const delay = Math.min(3600, 30 * (2 ** (row.attemptCount - 1)));
      const retried = await db.prepare(`UPDATE message_outbox SET state = 'queued', lease_expires_at = NULL,
          lease_token = NULL,
          provider = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(result.provider, code, addSeconds(now, delay), now, row.id, leaseToken).run();
      if ((retried.meta.changes ?? 0) === 1) summary.retried += 1;
      else summary.skipped += 1;
    } else {
      const failed = await db.prepare(`UPDATE message_outbox SET state = 'failed', lease_expires_at = NULL,
          lease_token = NULL,
          provider = ?, last_error_code = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?`)
        .bind(result.provider, code, now, row.id, leaseToken).run();
      if ((failed.meta.changes ?? 0) === 1) summary.failed += 1;
      else summary.skipped += 1;
    }
  }
  return summary;
}
