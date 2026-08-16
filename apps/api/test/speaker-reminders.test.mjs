import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  SPEAKER_REMINDER_TEMPLATES,
  SpeakerReminderIdempotencyConflictError,
  SpeakerReminderIneligibleError,
  SpeakerReminderNotFoundError,
  SpeakerReminderTemplateNotFoundError,
  SpeakerReminderAuthorizationError,
  enqueueSpeakerReminder,
  listSpeakerReminderTemplates,
} from "../src/speaker-reminders.ts";

class SqliteD1Statement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) {
    const bound = new SqliteD1Statement(this.statement);
    bound.params = params;
    return bound;
  }
  async first(column) {
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() {
    const result = this.statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1Database {
  constructor(database) { this.database = database; }
  prepare(query) { return new SqliteD1Statement(this.database.prepare(query)); }
}

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
  return database;
}

const now = "2026-08-12T12:00:00Z";
const organizerUserId = "usr-devflow-organizer";

describe("deterministic speaker reminders", () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = fixtureDatabase();
    db = new SqliteD1Database(sqlite);
  });

  it("publishes a fixed, revisioned template catalog", () => {
    expect(listSpeakerReminderTemplates()).toEqual({
      templates: SPEAKER_REMINDER_TEMPLATES.map((template) => ({ ...template })),
    });
    expect(listSpeakerReminderTemplates().templates.map((template) => template.key)).toEqual([
      "speaker.readiness-reminder",
      "speaker.task-reminder",
    ]);
  });

  it("renders canonical open tasks and enqueues exactly one immutable message idempotently", async () => {
    const input = {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "sanaa-task-reminder-01",
    };
    const first = await enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, input, now);
    const replay = await enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, input, now);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.task-reminder",
      templateRevision: 1,
      outboxState: "queued",
    });
    expect(sqlite.prepare(`SELECT intent, recipient_email AS recipientEmail, recipient_name AS recipientName,
      template_key AS templateKey, template_revision AS templateRevision, subject, text_body AS text,
      actor_user_id AS actorUserId, state, attempt_count AS attemptCount FROM message_outbox`).get()).toEqual({
      actorUserId: organizerUserId,
      intent: "speaker_reminder",
      recipientEmail: "sanaa@devflow.example",
      recipientName: "Sanaa Idris",
      templateKey: "speaker.task-reminder",
      templateRevision: 1,
      subject: "DevFlow Conf 2027: open speaker tasks",
      text: expect.stringContaining("- Evals You Can Trust — Confirm participation (no due time recorded)"),
      state: "queued",
      attemptCount: 0,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 1 });
  });

  it("rejects content drift under the same idempotency key", async () => {
    const input = {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "sanaa-task-reminder-02",
    };
    await enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, input, now);
    sqlite.prepare(`UPDATE speaker_tasks SET label = label || ' updated', revision = revision + 1,
      updated_at = '2027-04-19T00:00:00Z'
      WHERE event_id = 'evt-devflow' AND speaker_id = 'spk-d-sanaa' AND state = 'open'`).run();
    await expect(enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, input, now))
      .rejects.toBeInstanceOf(SpeakerReminderIdempotencyConflictError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 1 });
  });

  it("fails closed for another event, unlinked profiles, and templates with nothing to report", async () => {
    await expect(enqueueSpeakerReminder(db, "evt-fieldnotes", organizerUserId, {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.readiness-reminder",
      idempotencyKey: "wrong-event-speaker",
    }, now)).rejects.toBeInstanceOf(SpeakerReminderNotFoundError);

    sqlite.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, headshot_fallback, contact_email
    ) VALUES ('spk-unlinked', 'evt-devflow', NULL, 'unlinked-speaker', 'Unlinked Speaker', '', '', '', 'US', 'unlinked@example.test')`).run();
    await expect(enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, {
      speakerId: "spk-unlinked",
      templateKey: "speaker.readiness-reminder",
      idempotencyKey: "unlinked-reminder-01",
    }, now)).rejects.toMatchObject({ reason: "SPEAKER_ACCESS_UNAVAILABLE" });

    sqlite.prepare(`UPDATE speakers SET workflow_status = 'declined', revision = revision + 1,
      updated_at = '2027-04-19T00:00:00Z' WHERE id = 'spk-d-sanaa'`).run();
    await expect(enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "declined-reminder-01",
    }, now)).rejects.toMatchObject({ reason: "SPEAKER_DECLINED" });

    await expect(enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, {
      speakerId: "spk-d-priya",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "priya-no-open-tasks",
    }, now)).rejects.toBeInstanceOf(SpeakerReminderIneligibleError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 0 });
  });

  it("fails closed when an untrusted caller supplies an unknown template key", async () => {
    await expect(enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.unknown-template",
      idempotencyKey: "unknown-template-01",
    }, now)).rejects.toBeInstanceOf(SpeakerReminderTemplateNotFoundError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 0 });
  });

  it("atomically rejects reminder enqueue after organizer access is revoked", async () => {
    sqlite.prepare(`DELETE FROM event_memberships
      WHERE event_id = 'evt-devflow' AND user_id = ? AND role = 'organizer'`).run(organizerUserId);

    await expect(enqueueSpeakerReminder(db, "evt-devflow", organizerUserId, {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "revoked-organizer-reminder",
    }, now)).rejects.toBeInstanceOf(SpeakerReminderAuthorizationError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 0 });

    await expect(enqueueSpeakerReminder(db, "evt-devflow", "usr-devflow-reviewer", {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "reviewer-reminder",
    }, now)).rejects.toBeInstanceOf(SpeakerReminderAuthorizationError);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get()).toEqual({ count: 0 });
  });
});
