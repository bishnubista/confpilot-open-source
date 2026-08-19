import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { programOperatorBriefResponseSchema } from "@confpilot/contracts";
import { createApp } from "../src/index.ts";
import { getDailyProgramBrief } from "../src/app/program-operator-service.ts";
import {
  ReviewerReminderIneligibleError,
  previewReviewerReminder,
  renderReviewerReminderPreview,
} from "../src/reviewer-reminders.ts";
import {
  SpeakerReminderIneligibleError,
  previewSpeakerReminder,
  renderSpeakerReminderPreview,
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
  async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); }
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

function addSession(database, { userId, token }) {
  database.prepare(`INSERT INTO auth_sessions (
    id, user_id, token_hash, expires_at, revoked_at, created_at
  ) VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, '2026-08-11T00:00:00Z')`).run(
    `session-${token}`,
    userId,
    createHash("sha256").update(token).digest("hex"),
  );
  return `__Host-confpilot_session=${token}`;
}

const NOW = "2027-05-01T12:00:00Z";

describe("shadow-mode Program Operator daily brief", () => {
  let sqlite;
  let db;

  beforeEach(() => {
    sqlite = fixtureDatabase();
    db = new SqliteD1Database(sqlite);
  });

  it("normalizes valid reminder recipients and rejects unsafe addresses before drafting", () => {
    const speaker = {
      eventId: "evt-devflow",
      eventSlug: "devflow-conf-2027",
      eventName: "DevFlow Conf 2027",
      speakerId: "speaker-safe",
      userId: "user-safe",
      hasSpeakerMembership: 1,
      name: "Safe Speaker",
      contactEmail: " Speaker@Example.Test ",
      workflowStatus: "confirmed",
      profileStatus: "incomplete",
      agreementStatus: "signed",
      headshotObjectKey: "headshot.jpg",
    };
    expect(renderSpeakerReminderPreview(
      speaker, [], [], "speaker.readiness-reminder",
    ).recipientEmail).toBe("speaker@example.test");
    expect(() => renderSpeakerReminderPreview(
      { ...speaker, contactEmail: "not-an-email" }, [], [], "speaker.readiness-reminder",
    )).toThrow(expect.objectContaining({
      constructor: SpeakerReminderIneligibleError,
      reason: "UNSAFE_RECIPIENT",
    }));

    const reviewer = {
      eventSlug: "devflow-conf-2027",
      eventName: "DevFlow Conf 2027",
      userId: "reviewer-safe",
      displayName: "Safe Reviewer",
      email: " Reviewer@Example.Test ",
    };
    const pending = [{ proposalTitle: "A pending proposal", dueAt: null }];
    expect(renderReviewerReminderPreview(
      reviewer, pending, "reviewer.pending-reviews-reminder",
    ).recipientEmail).toBe("reviewer@example.test");
    expect(() => renderReviewerReminderPreview(
      { ...reviewer, email: "not-an-email" }, pending, "reviewer.pending-reviews-reminder",
    )).toThrow(expect.objectContaining({
      constructor: ReviewerReminderIneligibleError,
      reason: "UNSAFE_RECIPIENT",
    }));
  });

  it("reports a complete event without inventing work", async () => {
    sqlite.prepare(`INSERT INTO events (
      id, slug, name, tagline, location, description, starts_on, ends_on,
      cfp_deadline, status, time_zone
    ) VALUES ('evt-complete', 'complete-2027', 'Complete 2027', '', '', '',
      '2027-10-01', '2027-10-01', '2027-06-01T00:00:00Z', 'draft', 'UTC')`).run();

    const brief = await getDailyProgramBrief(db, "evt-complete", NOW);

    expect(programOperatorBriefResponseSchema.parse(brief)).toEqual(brief);
    expect(brief.summary).toEqual({
      status: "complete",
      acceptedSessions: 0,
      publishReadySessions: 0,
      riskCount: 0,
      reminderDraftCount: 0,
      exceptionCount: 0,
    });
    expect(brief.plan).toEqual([]);
  });

  it("ranks overdue speaker work and drafts the exact queue payload without writing", async () => {
    sqlite.prepare(`UPDATE speaker_tasks SET due_at = '2027-04-20T12:00:00Z',
      revision = revision + 1, updated_at = '2027-04-01T12:00:00Z'
      WHERE event_id = 'evt-devflow' AND speaker_id = 'spk-d-sanaa' AND state = 'open'`).run();
    const before = sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count;

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const draft = brief.plan.find((item) => item.kind === "speaker_reminder" && item.recipient.id === "spk-d-sanaa");
    const after = sqlite.prepare("SELECT COUNT(*) AS count FROM message_outbox").get().count;
    const queuePreview = await previewSpeakerReminder(db, "evt-devflow", {
      speakerId: "spk-d-sanaa",
      templateKey: "speaker.readiness-reminder",
    });

    expect(brief.risks.some((risk) => risk.severity === "critical"
      && risk.evidenceIds.some((id) => id.startsWith("speaker_task:")))).toBe(true);
    expect(draft).toMatchObject({
      status: "draft",
      requiredApproval: "human",
      queueOperation: "speakers.queueReminders",
      recipient: { name: "Sanaa Idris", email: "sanaa@devflow.example" },
      draft: { templateKey: "speaker.readiness-reminder", templateRevision: 2 },
    });
    expect(draft.draft.text).toContain("Confirm participation (due 2027-04-20T12:00:00Z)");
    expect(draft.draft.text).toBe(queuePreview.text);
    expect(draft.draft.text).toContain("Upload your speaker headshot");
    expect(draft.evidenceIds.some((id) => id.startsWith("program_session:"))).toBe(true);
    expect(brief.evidence.find((item) => item.id === "speaker:spk-d-sanaa").fields)
      .toContain("headshotObjectKey");
    expect(after).toBe(before);
    expect(brief.guardrails).toEqual({ shadowMode: true, writesPerformed: 0, unauthorizedActions: 0 });
  });

  it("grounds missing deliverables in canonical request records", async () => {
    sqlite.prepare(`INSERT INTO deliverable_requests (
      id, event_id, program_session_id, request_key, request_type, label, instructions,
      due_at, allowed_content_types_json, max_bytes, required, active, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (
      'request-program-operator-slides', 'evt-devflow', 'ses-d-8', 'operator-slides',
      'presentation', 'Final slides', 'Upload the attendee-ready presentation.',
      '2027-04-25T12:00:00Z', '["application/pdf"]', 10485760, 1, 1, 1,
      'usr-devflow-organizer', 'usr-devflow-organizer',
      '2027-04-01T12:00:00Z', '2027-04-01T12:00:00Z'
    )`).run();
    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const deliverableRisk = brief.risks.find((risk) => risk.evidenceIds.some((id) => id.startsWith("deliverable_request:")));

    expect(deliverableRisk).toBeDefined();
    for (const id of deliverableRisk.evidenceIds) {
      expect(brief.evidence.some((item) => item.id === id)).toBe(true);
    }
    expect(brief.evidence.some((item) => item.source === "deliverable_request"
      && item.fields.includes("latestReviewOutcome"))).toBe(true);
    expect(brief.risks.find((risk) => risk.id === "risk:content_approval_pending:ses-d-8")?.title)
      .not.toMatch(/^Overdue:/);
  });

  it("surfaces conflicting sessions as the highest-severity schedule risk", async () => {
    sqlite.prepare(`UPDATE schedule_placements SET
      created_by_user_id = 'usr-devflow-organizer', updated_by_user_id = 'usr-devflow-organizer',
      created_at = '2027-04-01T12:00:00Z', updated_at = '2027-04-01T12:00:00Z'
      WHERE id = 'plc-d-3'`).run();
    sqlite.prepare(`UPDATE schedule_placements SET starts_at = '2027-05-12T17:30:00Z',
      ends_at = '2027-05-12T18:00:00Z', revision = revision + 1,
      updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-30T12:00:00Z'
      WHERE id = 'plc-d-3'`).run();

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const conflict = brief.risks.find((risk) => risk.id.includes("speaker_conflict"));

    expect(conflict).toMatchObject({
      severity: "critical",
      kind: "readiness_blocker",
      confidence: "high",
    });
    expect(conflict.suggestedResolution).toContain("/admin/agenda");
  });

  it("reports stale outbox state without claiming delivery or retrying", async () => {
    sqlite.prepare(`INSERT INTO message_outbox (
      id, event_id, actor_user_id, dedupe_key, intent, recipient_email, recipient_name,
      template_key, template_revision, subject, text_body, content_sha256, state,
      attempt_count, next_attempt_at, lease_expires_at, lease_token, provider,
      provider_message_id, last_error_code, created_at, updated_at, delivered_at
    ) VALUES (
      'message-expired-lease', 'evt-devflow', 'usr-devflow-organizer',
      'program-operator-expired-lease', 'speaker_reminder', 'sanaa@devflow.example',
      'Sanaa Idris', 'speaker.readiness-reminder', 1, 'Readiness reminder',
      'This delivery lease is intentionally expired for the fixture.',
      '${"a".repeat(64)}', 'leased', 1, '2027-04-29T10:00:00Z',
      '2027-04-29T11:00:00Z', 'expired-lease-token-0001', NULL, NULL, NULL,
      '2027-04-29T09:00:00Z', '2027-04-29T10:00:00Z', NULL
    )`).run();
    const before = sqlite.prepare("SELECT state, lease_expires_at AS leaseExpiresAt FROM message_outbox WHERE id = 'message-expired-lease'").get();
    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const after = sqlite.prepare("SELECT state, lease_expires_at AS leaseExpiresAt FROM message_outbox WHERE id = 'message-expired-lease'").get();

    expect(brief.risks).toContainEqual(expect.objectContaining({
      id: "risk:message-outbox:message-expired-lease",
      kind: "stale_outbox",
      severity: "medium",
    }));
    expect(brief.risks.some((risk) => risk.id === "risk:notification-outbox:note-d-4")).toBe(false);
    expect(after).toEqual(before);
  });

  it("bounds large reviewer backlogs and long proposal titles without losing the exact count", async () => {
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const title = index === 0 ? "L".repeat(400) : `Backlog proposal ${suffix}`;
      sqlite.prepare(`INSERT INTO proposals (
        id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
        status, submitted_at, created_at, updated_at, owner_user_id, client_draft_key
      ) VALUES (?, 'evt-devflow', ?, ?, ?, 'Fixture abstract', 'AI Engineering', 'talk', 30,
        'in_review', '2027-03-01T12:00:00Z', '2027-03-01T12:00:00Z',
        '2027-03-01T12:00:00Z', 'usr-d-elena', NULL)`).run(
        `prop-backlog-${suffix}`, `ABS-B${suffix}`, `backlog-${suffix}`, title,
      );
      sqlite.prepare(`INSERT INTO review_assignments (
        id, event_id, proposal_id, reviewer_user_id, created_by_user_id, round, blind,
        state, due_at, revoked_at, revoked_by_user_id, created_at, updated_at
      ) VALUES (?, 'evt-devflow', ?, 'usr-devflow-reviewer', 'usr-devflow-organizer',
        1, 1, 'assigned', '2027-04-15T12:00:00Z', NULL, NULL,
        '2027-03-01T12:00:00Z', '2027-03-01T12:00:00Z')`).run(
        `assignment-backlog-${suffix}`, `prop-backlog-${suffix}`,
      );
    }

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const risk = brief.risks.find((item) => item.id === "risk:review-backlog:usr-devflow-reviewer");
    const draft = brief.plan.find((item) => item.kind === "reviewer_reminder"
      && item.recipient.id === "usr-devflow-reviewer");

    expect(programOperatorBriefResponseSchema.safeParse(brief).success).toBe(true);
    expect(risk.title).toContain("26 pending reviews");
    expect(risk.affectedRecords).toHaveLength(20);
    expect(risk.affectedRecords.every((record) => record.label.length <= 300)).toBe(true);
    expect(draft.draft.text).toContain("And 6 more pending assignments");
    const queuePreview = await previewReviewerReminder(db, "evt-devflow", {
      reviewerUserId: "usr-devflow-reviewer",
      roundId: null,
      templateKey: "reviewer.pending-reviews-reminder",
    });
    expect(draft.draft.text).toBe(queuePreview.text);
  });

  it("bounds overdue risk titles derived from long canonical session titles", async () => {
    sqlite.prepare(`UPDATE program_sessions SET title = ?, revision = revision + 1,
      updated_at = '2027-04-30T12:00:00Z' WHERE id = 'ses-d-8'`).run("S".repeat(400));
    sqlite.prepare(`INSERT INTO deliverable_requests (
      id, event_id, program_session_id, request_key, request_type, label, instructions,
      due_at, allowed_content_types_json, max_bytes, required, active, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (
      'request-long-session', 'evt-devflow', 'ses-d-8', 'long-session-slides',
      'presentation', 'Final slides', 'Upload slides.', '2027-04-20T12:00:00Z',
      '["application/pdf"]', 10485760, 1, 1, 1, 'usr-devflow-organizer',
      'usr-devflow-organizer', '2027-04-01T12:00:00Z', '2027-04-01T12:00:00Z'
    )`).run();

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);

    expect(programOperatorBriefResponseSchema.safeParse(brief).success).toBe(true);
    expect(brief.risks.every((risk) => risk.title.length <= 300)).toBe(true);
  });

  it("turns a malformed stored recipient into an exception instead of a contract failure", async () => {
    sqlite.prepare(`UPDATE speakers SET contact_email = ' sanaa@devflow.example ',
      revision = revision + 1, updated_at = '2027-04-30T12:00:00Z'
      WHERE id = 'spk-d-sanaa'`).run();

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);

    expect(programOperatorBriefResponseSchema.safeParse(brief).success).toBe(true);
    expect(brief.plan.some((item) => item.kind === "speaker_reminder"
      && item.recipient.id === "spk-d-sanaa")).toBe(false);
    expect(brief.exceptions).toContainEqual(expect.objectContaining({
      id: "exception:speaker-recipient:spk-d-sanaa",
      kind: "missing_recipient",
    }));
  });

  it("marks only the task blocker whose own canonical task is overdue", async () => {
    sqlite.prepare(`UPDATE speaker_tasks SET state = 'open', completed_at = NULL,
      due_at = '2027-04-20T12:00:00Z', revision = revision + 1,
      updated_at = '2027-04-30T10:00:00Z'
      WHERE program_session_id = 'ses-d-2' AND speaker_id = 'spk-d-priya'
        AND task_key = 'confirm'`).run();
    sqlite.prepare(`UPDATE speaker_tasks SET state = 'open', completed_at = NULL,
      due_at = '2027-05-20T12:00:00Z', revision = revision + 1,
      updated_at = '2027-04-30T10:00:00Z'
      WHERE program_session_id = 'ses-d-3' AND speaker_id = 'spk-d-priya'
        AND task_key = 'confirm'`).run();

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const overdueRisk = brief.risks.find((risk) =>
      risk.id === "risk:speaker_tasks_incomplete:ses-d-2:spk-d-priya");
    const futureRisk = brief.risks.find((risk) =>
      risk.id === "risk:speaker_tasks_incomplete:ses-d-3:spk-d-priya");

    expect(overdueRisk.title).toMatch(/^Overdue:/);
    expect(overdueRisk.severity).toBe("critical");
    expect(futureRisk.title).not.toMatch(/^Overdue:/);
    expect(futureRisk.severity).toBe("high");
  });

  it("bounds the top-level response and reports omitted lower-priority work", async () => {
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      sqlite.prepare(`INSERT INTO deliverable_requests (
        id, event_id, program_session_id, request_key, request_type, label, instructions,
        due_at, allowed_content_types_json, max_bytes, required, active, revision,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, 'evt-devflow', 'ses-d-1', ?, 'presentation', ?, 'Upload file.',
        '2027-05-20T12:00:00Z', '["application/pdf"]', 10485760, 1, 1, 1,
        'usr-devflow-organizer', 'usr-devflow-organizer',
        '2027-04-01T12:00:00Z', '2027-04-01T12:00:00Z')`).run(
        `request-limit-${suffix}`, `limit-${suffix}`, `Required file ${suffix}`,
      );
    }

    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);
    const scope = brief.exceptions.find((item) => item.kind === "scope_limit");

    expect(programOperatorBriefResponseSchema.safeParse(brief).success).toBe(true);
    expect(brief.risks).toHaveLength(100);
    expect(brief.plan.length).toBeLessThanOrEqual(50);
    expect(brief.exceptions.length).toBeLessThanOrEqual(50);
    expect(scope?.explanation).toMatch(/[1-9]\d* lower-ranked risks/);
  });

  it("fails closed against cross-event access and does not leak recipient data", async () => {
    const cookie = addSession(sqlite, { userId: "usr-devflow-organizer", token: "program-operator-cross-event" });
    const env = { DB: db };

    const response = await createApp().request(
      "http://localhost/api/events/field-notes-2027/program-operator/daily-brief",
      { headers: { Cookie: cookie } },
      env,
    );
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain("fieldnotes.example");
    expect(body).not.toContain("Lina Haddad");
  });

  it("remains available and truthful when no model provider exists", async () => {
    const brief = await getDailyProgramBrief(db, "evt-devflow", NOW);

    expect(brief.generation).toEqual({
      mode: "deterministic",
      modelStatus: "not_configured",
      policyVersion: "program-operator-shadow-v1",
    });
    expect(brief.plan.every((item) => item.requiredApproval === "human")).toBe(true);
    expect(programOperatorBriefResponseSchema.safeParse(brief).success).toBe(true);
  });
});
