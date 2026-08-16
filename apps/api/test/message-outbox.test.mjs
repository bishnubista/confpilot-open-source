import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dispatchQueuedMessages,
  EmailDeliveryUnavailableError,
  enqueueMessage,
  MessageDedupeConflictError,
  purgeTerminalMessages,
} from "../src/features/messaging/message-outbox.ts";
import { listCommunicationHistory } from "../src/features/messaging/communication-service.ts";
import { runScheduledEmailDispatch } from "../src/app/email-dispatch.ts";
import { createCloudflareEmailSender } from "../src/runtime/cloudflare-email-sender.ts";
import { resolveEmailDeliveryRuntime } from "../src/runtime/email-delivery-runtime.ts";
import { createDisabledEmailSender } from "../src/runtime/email-sender.ts";

class SqliteD1Statement {
  constructor(statement, beforeRun, beforeFirst) {
    this.statement = statement; this.beforeRun = beforeRun; this.beforeFirst = beforeFirst; this.params = [];
  }
  bind(...params) {
    const bound = new SqliteD1Statement(this.statement, this.beforeRun, this.beforeFirst);
    bound.params = params;
    return bound;
  }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() {
    this.beforeRun?.(this.params);
    const result = this.statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first(column) {
    this.beforeFirst?.(this.params);
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
}

class SqliteD1Database {
  constructor(database, beforeRun, beforeFirst) {
    this.database = database; this.beforeRun = beforeRun; this.beforeFirst = beforeFirst;
  }
  prepare(query) {
    return new SqliteD1Statement(
      this.database.prepare(query),
      (params) => this.beforeRun?.(query, params),
      (params) => this.beforeFirst?.(query, params),
    );
  }
}

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsUrl = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrationsUrl).filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.prepare(`INSERT INTO events (
    id, slug, name, tagline, location, description, starts_on, ends_on,
    cfp_deadline, status, time_zone
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "evt-devflow", "test-event", "Test Event", "Test", "Online", "Test event.",
    "2027-01-01", "2027-01-02", "2026-12-01T00:00:00Z", "draft", "UTC",
  );
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return database;
}

const now = "2026-08-12T12:00:00Z";
const input = {
  id: "message-1",
  eventId: "evt-devflow",
  dedupeKey: "speaker-invite:speaker-1:v1",
  intent: "speaker_invite",
  recipientEmail: "speaker@example.test",
  recipientName: "Example Speaker",
  templateKey: "speaker.invite",
  templateRevision: 1,
  subject: "Your speaker invitation",
  text: "Open your private speaker portal.",
  now,
};

function configuredRuntime(send, provider = "test-transport") {
  return {
    capability: { enabled: true, provider, reason: "configured", sendAfter: "1970-01-01T00:00:00Z" },
    sender: { send },
  };
}

describe("generic message outbox", () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = fixtureDatabase();
    db = new SqliteD1Database(sqlite);
  });

  it("enqueues idempotently and rejects dedupe-key content drift", async () => {
    const first = await enqueueMessage(db, input);
    const replay = await enqueueMessage(db, { ...input, id: "message-replay" });

    expect(replay.id).toBe(first.id);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count).toBe(1);
    await expect(enqueueMessage(db, { ...input, subject: "Changed subject" }))
      .rejects.toBeInstanceOf(MessageDedupeConflictError);
    const historicalCanonical = JSON.stringify({
      intent: input.intent,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName,
      templateKey: input.templateKey,
      templateRevision: input.templateRevision,
      subject: input.subject,
      text: input.text,
    });
    expect(sqlite.prepare("SELECT content_sha256 AS hash FROM message_outbox WHERE id = 'message-1'").get().hash)
      .toBe(createHash("sha256").update(historicalCanonical).digest("hex"));
  });

  it("rejects impossible UTC calendar dates instead of normalizing them", async () => {
    await expect(enqueueMessage(db, { ...input, now: "2026-02-30T00:00:00Z" }))
      .rejects.toBeInstanceOf(TypeError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count).toBe(0);

    const runtime = configuredRuntime(vi.fn());
    runtime.capability.sendAfter = "2026-02-30T00:00:00Z";
    await expect(dispatchQueuedMessages(db, runtime, { now }))
      .rejects.toBeInstanceOf(TypeError);
  });

  it("requires an organizer actor for speaker reminders but permits generic system messages", async () => {
    await expect(enqueueMessage(db, {
      ...input,
      id: "actorless-reminder",
      dedupeKey: "speaker-reminder:actorless",
      intent: "speaker_reminder",
    })).rejects.toThrow(/message actor must be a same-event organizer/);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 0 });

    await expect(enqueueMessage(db, {
      ...input,
      id: "system-message",
      dedupeKey: "system-message:actorless",
      intent: "system_notice",
    })).resolves.toMatchObject({ id: "system-message", state: "queued" });
    expect(sqlite.prepare(`SELECT id, actor_user_id AS actorUserId, intent
      FROM message_outbox`).get()).toEqual({
      id: "system-message",
      actorUserId: null,
      intent: "system_notice",
    });
  });

  it("leases a bounded batch and records delivery without changing content", async () => {
    await enqueueMessage(db, input);
    const send = vi.fn(async () => ({
      ok: true, provider: "test-transport", providerMessageId: "provider-1",
    }));

    await expect(dispatchQueuedMessages(db, configuredRuntime(send), { now })).resolves.toEqual({
      providerAccepted: 1, retried: 0, failed: 0, recovered: 0, skipped: 0,
    });
    expect(send).toHaveBeenCalledWith({
      outboxId: "message-1",
      to: "speaker@example.test",
      subject: "Your speaker invitation",
      text: "Open your private speaker portal.",
    });
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount, provider,
      provider_message_id AS providerMessageId, delivered_at AS deliveredAt,
      subject, text_body AS text FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "delivered",
      attemptCount: 1,
      provider: "test-transport",
      providerMessageId: "provider-1",
      deliveredAt: now,
      subject: input.subject,
      text: input.text,
    });
  });

  it("suppresses expired messages before a provider attempt", async () => {
    const dispatchAt = "2026-08-12T12:01:00Z";
    await enqueueMessage(db, { ...input, expiresAt: "2026-08-12T12:00:30Z" });
    const send = vi.fn(async () => ({
      ok: true, provider: "test-transport", providerMessageId: "should-not-send",
    }));

    expect(await dispatchQueuedMessages(db, configuredRuntime(send), { now: dispatchAt })).toEqual({
      providerAccepted: 0, retried: 0, failed: 0, recovered: 0, skipped: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount,
      canceled_at AS canceledAt, cancellation_code AS cancellationCode
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", attemptCount: 0, canceledAt: dispatchAt, cancellationCode: "MESSAGE_EXPIRED",
    });
  });

  it("blocks leasing a canceled message at the database boundary", async () => {
    await enqueueMessage(db, input);
    sqlite.prepare(`UPDATE message_outbox SET canceled_at = ?, cancellation_code = 'MESSAGE_EXPIRED', updated_at = ?
      WHERE id = 'message-1'`).run(now, now);
    expect(() => sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-12T12:01:00Z', lease_token = 'canceled-message-lease', updated_at = ?
      WHERE id = 'message-1'`).run(now)).toThrow(/canceled message cannot be leased/);
  });

  it("keeps an in-flight cancellation durable when a provider attempt must retry", async () => {
    await enqueueMessage(db, input);
    const send = vi.fn(async () => {
      sqlite.prepare(`UPDATE message_outbox SET canceled_at = ?, cancellation_code = 'INVITATION_REVOKED', updated_at = ?
        WHERE id = 'message-1' AND state = 'leased'`).run(now, now);
      return { ok: false, provider: "test-transport", code: "TEMPORARY", retryable: true };
    });

    expect(await dispatchQueuedMessages(db, configuredRuntime(send), { now })).toEqual({
      providerAccepted: 0, retried: 1, failed: 0, recovered: 0, skipped: 0,
    });
    expect(sqlite.prepare(`SELECT state, canceled_at AS canceledAt, cancellation_code AS code
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", canceledAt: now, code: "INVITATION_REVOKED",
    });
    expect(await dispatchQueuedMessages(db, configuredRuntime(send), { now: "2026-08-12T12:01:00Z" }))
      .toMatchObject({ providerAccepted: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a canceled active lease as canceled rather than sending", async () => {
    await enqueueMessage(db, input);
    sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-12T12:01:00Z', lease_token = 'cancel-report-lease', updated_at = ?
      WHERE id = 'message-1'`).run(now);
    sqlite.prepare(`UPDATE message_outbox
      SET canceled_at = ?, cancellation_code = 'INVITATION_REVOKED', updated_at = ?
      WHERE id = 'message-1'`).run(now, now);

    const history = await listCommunicationHistory(db, "evt-devflow", configuredRuntime(vi.fn()).capability);
    expect(history.messages[0].transportStatus).toBe("canceled");
  });

  it("skips a leased message canceled immediately before provider dispatch", async () => {
    await enqueueMessage(db, input);
    let canceled = false;
    const cancelBeforeDispatchDb = new SqliteD1Database(sqlite, undefined, (query) => {
      if (canceled || !query.includes("SELECT id, recipient_email AS recipientEmail")) return;
      canceled = true;
      sqlite.prepare(`UPDATE message_outbox
        SET canceled_at = ?, cancellation_code = 'INVITATION_REVOKED', updated_at = ?
        WHERE id = 'message-1' AND state = 'leased'`).run(now, now);
    });
    const send = vi.fn(async () => ({
      ok: true, provider: "test-transport", providerMessageId: "must-not-send",
    }));

    expect(await dispatchQueuedMessages(cancelBeforeDispatchDb, configuredRuntime(send), { now }))
      .toEqual({ providerAccepted: 0, retried: 0, failed: 0, recovered: 0, skipped: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT state, lease_token AS leaseToken, canceled_at AS canceledAt,
      attempt_count AS attemptCount
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", leaseToken: null, canceledAt: now, attemptCount: 0,
    });
  });

  it("records provider acceptance truthfully when cancellation arrives during an active lease", async () => {
    await enqueueMessage(db, input);
    const runtime = configuredRuntime(vi.fn(async () => {
      sqlite.prepare(`UPDATE message_outbox SET canceled_at = ?, cancellation_code = 'INVITATION_REVOKED', updated_at = ?
        WHERE id = 'message-1' AND state = 'leased'`).run(now, now);
      return { ok: true, provider: "test-transport", providerMessageId: "accepted-after-cancel" };
    }));
    expect(await dispatchQueuedMessages(db, runtime, { now })).toMatchObject({ providerAccepted: 1 });
    const history = await listCommunicationHistory(db, "evt-devflow", runtime.capability);
    expect(history.messages[0]).toMatchObject({
      transportStatus: "provider_accepted",
      deliveryStatus: "unverified",
      cancellationCode: "INVITATION_REVOKED",
      providerMessageId: "accepted-after-cancel",
    });
  });

  it("retries transient failures with deterministic backoff and terminal limits", async () => {
    await enqueueMessage(db, input);
    const sender = configuredRuntime(vi.fn(async () => ({
      ok: false, provider: "test-transport", code: "rate limited: speaker@example.test", retryable: true,
    })));

    expect(await dispatchQueuedMessages(db, sender, { now })).toEqual({
      providerAccepted: 0, retried: 1, failed: 0, recovered: 0, skipped: 0,
    });
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount,
      next_attempt_at AS nextAttemptAt, last_error_code AS lastErrorCode
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", attemptCount: 1, nextAttemptAt: "2026-08-12T12:00:30Z",
      lastErrorCode: "PROVIDER_FAILURE",
    });
    sqlite.prepare("UPDATE message_outbox SET attempt_count = 4 WHERE id = 'message-1'").run();
    expect(await dispatchQueuedMessages(db, sender, {
      now: "2026-08-12T12:00:30Z",
    })).toEqual({ providerAccepted: 0, retried: 0, failed: 1, recovered: 0, skipped: 0 });
    expect(sqlite.prepare("SELECT state, attempt_count AS attemptCount FROM message_outbox").get())
      .toEqual({ state: "failed", attemptCount: 5 });
  });

  it("recovers expired leases with backoff and fails an exhausted lease", async () => {
    await enqueueMessage(db, input);
    sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-12T11:59:00Z', lease_token = 'expired-lease-token'
      WHERE id = 'message-1'`).run();
    const send = vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: null }));
    const sender = configuredRuntime(send, "test");

    expect(await dispatchQueuedMessages(db, sender, { now })).toEqual({
      providerAccepted: 0, retried: 0, failed: 0, recovered: 1, skipped: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT state, next_attempt_at AS nextAttemptAt, last_error_code AS code,
      lease_token AS leaseToken FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", nextAttemptAt: "2026-08-12T12:00:30Z", code: "LEASE_EXPIRED", leaseToken: null,
    });
    expect(await dispatchQueuedMessages(db, sender, { now: "2026-08-12T12:00:30Z" }))
      .toMatchObject({ providerAccepted: 1 });

    await enqueueMessage(db, { ...input, id: "message-2", dedupeKey: "second" });
    sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 5,
      lease_expires_at = '2026-08-12T11:59:00Z', lease_token = 'expired-lease-token'
      WHERE id = 'message-2'`).run();
    expect(await dispatchQueuedMessages(db, sender, { now })).toEqual({
      providerAccepted: 0, retried: 0, failed: 1, recovered: 0, skipped: 0,
    });
    expect(sqlite.prepare("SELECT state, last_error_code AS code FROM message_outbox WHERE id = 'message-2'").get())
      .toEqual({ state: "failed", code: "MAX_ATTEMPTS" });
  });

  it("keeps delivery history and message content immutable", async () => {
    await enqueueMessage(db, input);
    expect(() => sqlite.prepare("UPDATE message_outbox SET subject = 'Changed' WHERE id = 'message-1'").run())
      .toThrow(/message identity and content are immutable/);
    expect(() => sqlite.prepare("DELETE FROM message_outbox WHERE id = 'message-1'").run())
      .toThrow(/active message delivery cannot be deleted/);
    expect(() => sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-12T12:01:00Z' WHERE id = 'message-1'`).run())
      .toThrow(/CHECK constraint failed/);
    expect(() => sqlite.prepare("UPDATE message_outbox SET state = 'delivered' WHERE id = 'message-1'").run())
      .toThrow(/message delivery state transition is invalid/);
  });

  it("purges only bounded terminal history older than the retention cutoff", async () => {
    const send = vi.fn(async ({ outboxId }) => ({
      ok: true, provider: "test-transport", providerMessageId: `provider-${outboxId}`,
    }));
    await enqueueMessage(db, input);
    await enqueueMessage(db, { ...input, id: "message-2", dedupeKey: "second" });
    await enqueueMessage(db, { ...input, id: "message-active", dedupeKey: "active" });
    await dispatchQueuedMessages(db, configuredRuntime(send), { now, limit: 2 });

    await expect(purgeTerminalMessages(db, {
      before: "2026-08-13T12:00:00Z", limit: 1,
    })).resolves.toBe(1);
    expect(sqlite.prepare("SELECT id, state FROM message_outbox ORDER BY id").all()).toEqual([
      { id: "message-2", state: "delivered" },
      { id: "message-active", state: "queued" },
    ]);
    await expect(purgeTerminalMessages(db, { before: "not-a-date" })).rejects.toBeInstanceOf(TypeError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count).toBe(2);
  });

  it("purges canceled message content after the retention cutoff", async () => {
    await enqueueMessage(db, input);
    sqlite.prepare(`UPDATE message_outbox
      SET canceled_at = ?, cancellation_code = 'MESSAGE_EXPIRED', updated_at = ?
      WHERE id = 'message-1'`).run(now, now);

    await expect(purgeTerminalMessages(db, { before: "2026-08-13T12:00:00Z" })).resolves.toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count).toBe(0);
  });

  it("does not purge a canceled message while its provider lease is active", async () => {
    await enqueueMessage(db, input);
    sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-12T12:01:00Z', lease_token = 'active-provider-call',
      canceled_at = ?, cancellation_code = 'INVITATION_REVOKED', updated_at = ?
      WHERE id = 'message-1'`).run(now, now);

    await expect(purgeTerminalMessages(db, { before: "2026-08-13T12:00:00Z" })).resolves.toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count).toBe(1);
  });

  it.each([
    ["disabled delivery", () => createDisabledEmailSender(), "delivery_disabled"],
    ["an unconfigured Cloudflare sender", () => createCloudflareEmailSender(undefined, undefined), "sender_missing"],
    ["an invalid Cloudflare sender", () => createCloudflareEmailSender({ send: vi.fn() }, {
      fromAddress: "not-an-email",
      fromName: "",
      sendAfter: "2026-08-12T00:00:00Z",
    }), "sender_invalid"],
    ["a Cloudflare sender with missing runtime fields", () => createCloudflareEmailSender({ send: vi.fn() }, {
      fromAddress: undefined,
      fromName: undefined,
      sendAfter: "2026-08-12T00:00:00Z",
    }), "sender_invalid"],
    ["a Cloudflare sender with no activation cutoff", () => createCloudflareEmailSender({ send: vi.fn() }, {
      fromAddress: "sender@example.test",
      fromName: "Example Events",
    }), "activation_cutoff_missing"],
  ])("fails closed without leasing for %s", async (_label, runtimeFactory, reason) => {
    const runtime = runtimeFactory();
    const senderSpy = vi.spyOn(runtime.sender, "send");
    await enqueueMessage(db, input);
    expect(runtime.capability).toEqual({ enabled: false, provider: null, reason });
    await expect(dispatchQueuedMessages(db, runtime, { now })).rejects.toMatchObject({
      name: EmailDeliveryUnavailableError.name,
      reason,
    });
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount, lease_expires_at AS leaseExpiresAt
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", attemptCount: 0, leaseExpiresAt: null,
    });
    expect(senderSpy).not.toHaveBeenCalled();
  });

  it("requires an explicit host opt-in in addition to binding and sender configuration", async () => {
    const send = vi.fn(async () => ({ messageId: "provider-1" }));
    const configuredFields = {
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: "sender@example.test",
      EMAIL_FROM_NAME: "Example Events",
      EMAIL_DELIVERY_SEND_AFTER: "2026-08-12T00:00:00Z",
    };
    expect(resolveEmailDeliveryRuntime(configuredFields).capability).toEqual({
      enabled: false, provider: null, reason: "delivery_disabled",
    });
    expect(resolveEmailDeliveryRuntime({ ...configuredFields, EMAIL_DELIVERY_ENABLED: "yes" }).capability)
      .toEqual({ enabled: false, provider: null, reason: "sender_invalid" });
    expect(resolveEmailDeliveryRuntime({ ...configuredFields, EMAIL_DELIVERY_ENABLED: "true" }).capability)
      .toEqual({
        enabled: true,
        provider: "cloudflare-email",
        reason: "configured",
        sendAfter: "2026-08-12T00:00:00Z",
      });
    expect(resolveEmailDeliveryRuntime({
      ...configuredFields,
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_SEND_AFTER: undefined,
    }).capability).toEqual({ enabled: false, provider: null, reason: "activation_cutoff_missing" });
  });

  it("accepts valid leap days and rejects normalized calendar-invalid activation cutoffs", () => {
    const binding = { send: vi.fn() };
    const config = {
      fromAddress: "sender@example.test",
      fromName: "Example Events",
      sendAfter: "2028-02-29T00:00:00Z",
    };
    expect(createCloudflareEmailSender(binding, config).capability).toMatchObject({
      enabled: true,
      sendAfter: "2028-02-29T00:00:00Z",
    });
    expect(createCloudflareEmailSender(binding, { ...config, sendAfter: "2027-02-29T00:00:00Z" }).capability)
      .toEqual({ enabled: false, provider: null, reason: "activation_cutoff_missing" });
    expect(resolveEmailDeliveryRuntime({
      EMAIL: binding,
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_FROM_ADDRESS: config.fromAddress,
      EMAIL_FROM_NAME: config.fromName,
      EMAIL_DELIVERY_SEND_AFTER: config.sendAfter,
    }).capability).toMatchObject({ enabled: true, sendAfter: config.sendAfter });
    expect(resolveEmailDeliveryRuntime({
      EMAIL: binding,
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_FROM_ADDRESS: config.fromAddress,
      EMAIL_FROM_NAME: config.fromName,
      EMAIL_DELIVERY_SEND_AFTER: "2027-02-29T00:00:00Z",
    }).capability).toEqual({ enabled: false, provider: null, reason: "activation_cutoff_missing" });
  });

  it("leaves the queue untouched when the scheduled host dispatcher is disabled", async () => {
    await enqueueMessage(db, input);
    await expect(runScheduledEmailDispatch({ DB: db, EMAIL_DELIVERY_ENABLED: "false" }, Date.parse(now)))
      .resolves.toEqual({ status: "disabled", reason: "delivery_disabled" });
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount
      FROM message_outbox WHERE id = 'message-1'`).get())
      .toEqual({ state: "queued", attemptCount: 0 });
  });

  it("runs a bounded scheduled dispatch and records only provider acceptance", async () => {
    await enqueueMessage(db, input);
    const send = vi.fn(async () => ({ messageId: "cloudflare-accepted-1" }));
    await expect(runScheduledEmailDispatch({
      DB: db,
      EMAIL: { send },
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_FROM_ADDRESS: "sender@example.test",
      EMAIL_FROM_NAME: "Example Events",
      EMAIL_DELIVERY_SEND_AFTER: "2026-08-12T00:00:00Z",
    }, Date.parse(now))).resolves.toEqual({
      status: "dispatched",
      bridge: { bridged: 0, failed: 0 },
      summary: { providerAccepted: 1, retried: 0, failed: 0, recovered: 0, skipped: 0 },
    });
    expect(sqlite.prepare(`SELECT state, provider, provider_message_id AS providerMessageId
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "delivered",
      provider: "cloudflare-email",
      providerMessageId: "cloudflare-accepted-1",
    });
  });

  it.each([
    ["success", { ok: true, provider: "test-transport", providerMessageId: "stale-result" }],
    ["retry", { ok: false, provider: "test-transport", code: "E_RATE_LIMIT_EXCEEDED", retryable: true }],
    ["failure", { ok: false, provider: "test-transport", code: "E_REJECTED", retryable: false }],
  ])("does not record a stale %s result after its lease is lost", async (_label, result) => {
    await enqueueMessage(db, input);
    const send = vi.fn(async () => {
      sqlite.prepare(`UPDATE message_outbox SET state = 'queued', lease_expires_at = NULL,
        lease_token = NULL, next_attempt_at = '2026-08-12T12:10:00Z', last_error_code = 'LEASE_EXPIRED'
        WHERE id = 'message-1'`).run();
      return result;
    });

    expect(await dispatchQueuedMessages(db, configuredRuntime(send), { now })).toEqual({
      providerAccepted: 0, retried: 0, failed: 0, recovered: 0, skipped: 1,
    });
    expect(sqlite.prepare(`SELECT state, provider, provider_message_id AS providerMessageId,
      delivered_at AS deliveredAt FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", provider: null, providerMessageId: null, deliveredAt: null,
    });
  });

  it("skips a row when another dispatcher wins the lease", async () => {
    await enqueueMessage(db, input);
    let intercepted = false;
    const contendedDb = new SqliteD1Database(sqlite, (query) => {
      if (intercepted || !query.includes("UPDATE message_outbox SET state = 'leased'")) return;
      intercepted = true;
      sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = attempt_count + 1,
        lease_expires_at = '2026-08-12T12:01:00Z', lease_token = 'competing-lease-token',
        updated_at = ? WHERE id = 'message-1'`).run(now);
    });
    const send = vi.fn();

    expect(await dispatchQueuedMessages(contendedDb, configuredRuntime(send), { now })).toEqual({
      providerAccepted: 0, retried: 0, failed: 0, recovered: 0, skipped: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount, lease_token AS leaseToken
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "leased", attemptCount: 1, leaseToken: "competing-lease-token",
    });
  });

  it("retries a thrown sender failure and continues the remaining batch", async () => {
    await enqueueMessage(db, input);
    await enqueueMessage(db, { ...input, id: "message-2", dedupeKey: "second" });
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("private provider failure"))
      .mockResolvedValueOnce({ ok: true, provider: "test-transport", providerMessageId: "provider-2" });

    expect(await dispatchQueuedMessages(db, configuredRuntime(send), { now, limit: 2 })).toEqual({
      providerAccepted: 1, retried: 1, failed: 0, recovered: 0, skipped: 0,
    });
    expect(sqlite.prepare(`SELECT id, state, last_error_code AS code
      FROM message_outbox ORDER BY id`).all()).toEqual([
      { id: "message-1", state: "queued", code: "SENDER_THREW" },
      { id: "message-2", state: "delivered", code: null },
    ]);
  });

  it("times out a stalled sender and continues the remaining bounded batch", async () => {
    await enqueueMessage(db, input);
    await enqueueMessage(db, { ...input, id: "message-2", dedupeKey: "second" });
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, provider: "test-transport", providerMessageId: "provider-2" });

    expect(await dispatchQueuedMessages(db, configuredRuntime(send), {
      now, limit: 2, sendTimeoutMs: 10,
    })).toEqual({ providerAccepted: 1, retried: 1, failed: 0, recovered: 0, skipped: 0 });
    expect(sqlite.prepare(`SELECT id, state, attempt_count AS attemptCount,
      last_error_code AS code FROM message_outbox ORDER BY id`).all()).toEqual([
      { id: "message-1", state: "queued", attemptCount: 1, code: "SENDER_TIMEOUT" },
      { id: "message-2", state: "delivered", attemptCount: 1, code: null },
    ]);
  });

  it("rejects malformed message input without swallowing database constraints", async () => {
    for (const invalid of [
      { ...input, templateRevision: 0 },
      { ...input, intent: "Speaker Invite" },
      { ...input, recipientName: " " },
      { ...input, subject: "x".repeat(999) },
      { ...input, text: "x".repeat(20_001) },
    ]) {
      await expect(enqueueMessage(db, invalid)).rejects.toBeInstanceOf(TypeError);
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count).toBe(0);
  });

  it("keeps the Cloudflare adapter injected, configured, and error-redacted", async () => {
    const send = vi.fn(async () => ({ messageId: "cloudflare-message-1" }));
    const runtime = createCloudflareEmailSender({ send }, {
      fromAddress: "sender@example.test", fromName: "Example Events",
      sendAfter: "2026-08-12T00:00:00Z",
    });
    expect(runtime.capability).toEqual({
      enabled: true, provider: "cloudflare-email", reason: "configured",
      sendAfter: "2026-08-12T00:00:00Z",
    });
    expect(await runtime.sender.send({
      outboxId: "x", to: "recipient@example.test", subject: "Subject", text: "Body",
    })).toEqual({ ok: true, provider: "cloudflare-email", providerMessageId: "cloudflare-message-1" });
    expect(send).toHaveBeenCalledWith({
      to: "recipient@example.test",
      from: { email: "sender@example.test", name: "Example Events" },
      subject: "Subject",
      html: "<p>Body</p>",
      text: "Body",
    });
    await runtime.sender.send({
      outboxId: "crlf", to: "recipient@example.test", subject: "Lines",
      text: "Line one\r\nLine two\r\n\r\nNext paragraph",
    });
    expect(send).toHaveBeenLastCalledWith({
      to: "recipient@example.test",
      from: { email: "sender@example.test", name: "Example Events" },
      subject: "Lines",
      html: "<p>Line one<br>Line two</p><p>Next paragraph</p>",
      text: "Line one\r\nLine two\r\n\r\nNext paragraph",
    });

    const privateError = Object.assign(new Error("recipient@example.test rejected"), { code: "E_DELIVERY_FAILED" });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = createCloudflareEmailSender({ send: vi.fn(async () => { throw privateError; }) }, {
      fromAddress: "sender@example.test", fromName: "Example Events",
      sendAfter: "2026-08-12T00:00:00Z",
    });
    expect(await failed.sender.send({
      outboxId: "x", to: "recipient@example.test", subject: "Private subject", text: "Private body",
    })).toEqual({
      ok: false, provider: "cloudflare-email", code: "E_DELIVERY_FAILED", retryable: true,
    });
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("retries Cloudflare daily quota exhaustion instead of terminally failing it", async () => {
    const dailyLimit = Object.assign(new Error("daily quota exhausted"), { code: "E_DAILY_LIMIT_EXCEEDED" });
    const runtime = createCloudflareEmailSender({ send: vi.fn(async () => { throw dailyLimit; }) }, {
      fromAddress: "sender@example.test",
      fromName: "Example Events",
      sendAfter: "2026-08-12T00:00:00Z",
    });
    expect(await runtime.sender.send({
      outboxId: "x", to: "recipient@example.test", subject: "Subject", text: "Body",
    })).toEqual({
      ok: false,
      provider: "cloudflare-email",
      code: "E_DAILY_LIMIT_EXCEEDED",
      retryable: true,
    });

    await enqueueMessage(db, input);
    sqlite.prepare("UPDATE message_outbox SET attempt_count = 4 WHERE id = 'message-1'").run();
    expect(await dispatchQueuedMessages(db, runtime, { now })).toEqual({
      providerAccepted: 0, retried: 1, failed: 0, recovered: 0, skipped: 0,
    });
    expect(sqlite.prepare(`SELECT state, attempt_count AS attemptCount,
      next_attempt_at AS nextAttemptAt, last_error_code AS code
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued",
      attemptCount: 4,
      nextAttemptAt: "2026-08-13T12:00:00Z",
      code: "E_DAILY_LIMIT_EXCEEDED",
    });
  });

  it("leaves pre-activation snapshots untouched", async () => {
    await enqueueMessage(db, input);
    const send = vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: "provider-1" }));
    const runtime = configuredRuntime(send, "test");
    runtime.capability.sendAfter = "2026-08-12T12:00:01Z";

    expect(await dispatchQueuedMessages(db, runtime, { now: "2026-08-12T12:01:00Z" })).toEqual({
      providerAccepted: 0, retried: 0, failed: 0, recovered: 0, skipped: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT state, attempt_count AS attempts FROM message_outbox").get())
      .toEqual({ state: "queued", attempts: 0 });
  });

  it("recovers an expired pre-cutoff lease without making it eligible to send", async () => {
    await enqueueMessage(db, input);
    sqlite.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-12T12:00:10Z', lease_token = 'expired-pre-cutoff-lease'
      WHERE id = 'message-1'`).run();
    const send = vi.fn(async () => ({ ok: true, provider: "test", providerMessageId: "provider-1" }));
    const runtime = configuredRuntime(send, "test");
    runtime.capability.sendAfter = "2026-08-13T00:00:00Z";

    expect(await dispatchQueuedMessages(db, runtime, { now: "2026-08-13T00:01:00Z" })).toEqual({
      providerAccepted: 0, retried: 0, failed: 0, recovered: 1, skipped: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT state, lease_token AS leaseToken, last_error_code AS code
      FROM message_outbox WHERE id = 'message-1'`).get()).toEqual({
      state: "queued", leaseToken: null, code: "LEASE_EXPIRED",
    });
  });
});
