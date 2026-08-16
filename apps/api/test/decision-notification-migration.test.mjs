import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const migrationByName = new Map(migrationFiles.map((name) => [
  name,
  readFileSync(new URL(name, migrationsUrl), "utf8"),
]));
const seed = readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8");

function database() {
  const result = new DatabaseSync(":memory:");
  result.exec("PRAGMA foreign_keys = ON");
  return result;
}

function applyThrough(database, lastName) {
  for (const name of migrationFiles) {
    database.exec(migrationByName.get(name));
    if (name === lastName) return;
  }
  throw new Error(`Migration ${lastName} was not found`);
}

function installLegacyFixtures(database) {
  database.exec(`
    INSERT INTO events (
      id, slug, name, tagline, location, description,
      starts_on, ends_on, cfp_deadline, status
    ) VALUES (
      'evt-upgrade', 'upgrade-conf', 'Upgrade Conf', 'Migration fixture',
      'Online', 'A forward-only migration fixture.',
      '2027-05-01', '2027-05-02', '2027-01-31T23:59:00Z', 'draft'
    );
    INSERT INTO users (id, email, display_name, created_at) VALUES
      ('usr-upgrade-organizer', 'organizer@upgrade.example', 'Upgrade Organizer', '2026-08-11T00:00:00Z'),
      ('usr-upgrade-owner', 'owner@upgrade.example', 'Proposal Owner', '2026-08-11T00:00:00Z');
    INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES
      ('mem-upgrade-organizer', 'evt-upgrade', 'usr-upgrade-organizer', 'organizer', '2026-08-11T00:00:00Z'),
      ('mem-upgrade-owner', 'evt-upgrade', 'usr-upgrade-owner', 'speaker', '2026-08-11T00:00:00Z');
    INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES
      ('spk-legacy', 'evt-upgrade', NULL, 'legacy-speaker', 'Legacy Speaker', '', '', '', NULL, 'LS', 'incomplete', 'missing', 'private'),
      ('spk-owner', 'evt-upgrade', 'usr-upgrade-owner', 'proposal-owner', 'Proposal Owner', '', '', '', NULL, 'PO', 'incomplete', 'missing', 'private');
  `);

  const insertProposal = database.prepare(`
    INSERT INTO proposals (
      id, event_id, owner_user_id, public_id, slug, title, abstract, track, format,
      duration_minutes, status, submitted_at, created_at, updated_at
    ) VALUES (?, 'evt-upgrade', ?, ?, ?, ?, 'Migration fixture.', 'Testing', 'talk',
      30, 'decided', '2027-02-01T00:00:00Z', '2027-02-01T00:00:00Z', '2027-02-02T00:00:00Z')
  `);
  const insertPresenter = database.prepare(`
    INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
    VALUES (?, 'evt-upgrade', ?, ?, 'primary')
  `);
  const insertDecision = database.prepare(`
    INSERT INTO decisions (
      id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
    ) VALUES (?, 'evt-upgrade', ?, ?, 'Migration decision.', 'usr-upgrade-organizer', '2027-02-02T00:00:00Z')
  `);

  for (let index = 1; index <= 10; index += 1) {
    const proposalId = `prop-legacy-${index}`;
    const decisionId = `decision-legacy-${index}`;
    const sessionId = `session-legacy-${index}`;
    const acceptanceId = `acceptance-legacy-${index}`;
    insertProposal.run(
      proposalId,
      null,
      `ABS-L${index}`,
      `legacy-proposal-${index}`,
      `Legacy Proposal ${index}`,
    );
    insertPresenter.run(`presenter-legacy-${index}`, proposalId, "spk-legacy");
    insertDecision.run(decisionId, proposalId, "accept");
    database.prepare(`
      INSERT INTO program_sessions (
        id, event_id, source_proposal_id, slug, title, abstract, track, format,
        duration_minutes, publication_status, deliverables_status, approval_status,
        created_at, updated_at
      ) VALUES (?, 'evt-upgrade', ?, ?, ?, 'Migration fixture.', 'Testing', 'talk',
        30, 'private', 'missing', 'pending', '2027-02-02T00:00:00Z', '2027-02-02T00:00:00Z')
    `).run(sessionId, proposalId, `legacy-session-${index}`, `Legacy Session ${index}`);
    database.prepare(`
      INSERT INTO acceptances (
        id, event_id, proposal_id, decision_id, program_session_id,
        accepted_by_user_id, idempotency_key, accepted_at
      ) VALUES (?, 'evt-upgrade', ?, ?, ?, 'usr-upgrade-organizer', ?, '2027-02-02T00:00:00Z')
    `).run(acceptanceId, proposalId, decisionId, sessionId, `legacy-key-${index}`);
    database.prepare(`
      INSERT INTO session_presenters (id, event_id, program_session_id, speaker_id, role)
      VALUES (?, 'evt-upgrade', ?, 'spk-legacy', 'primary')
    `).run(`session-presenter-legacy-${index}`, sessionId);
    const legacySubject = index === 1
      ? "   \t  "
      : index === 2
        ? `  ${"x".repeat(1_200)}  `
        : `Legacy decision ${index}`;
    database.prepare(`
      INSERT INTO notification_outbox (
        id, event_id, acceptance_id, decision_id, recipient_speaker_id,
        subject, state, queued_at, sent_at
      ) VALUES (?, 'evt-upgrade', ?, ?, 'spk-legacy', ?, ?, ?, ?)
    `).run(
      `notification-legacy-${index}`,
      acceptanceId,
      decisionId,
      legacySubject,
      index === 10 ? "pending" : "sent",
      `2027-02-02T00:${String(index).padStart(2, "0")}:00Z`,
      index === 10 ? null : `2027-02-02T00:${String(index + 10).padStart(2, "0")}:00Z`,
    );
  }

  for (const [suffix, decision] of [
    ["reject", "reject"],
    ["waitlist", "waitlist"],
    ["accept", "accept"],
  ]) {
    const proposalId = `prop-new-${suffix}`;
    insertProposal.run(
      proposalId,
      "usr-upgrade-owner",
      `ABS-${suffix.toUpperCase()}`,
      `new-${suffix}`,
      `New ${suffix} proposal`,
    );
    insertPresenter.run(`presenter-new-${suffix}`, proposalId, "spk-owner");
    insertDecision.run(`decision-new-${suffix}`, proposalId, decision);
  }
}

function queueInput(overrides = {}) {
  return {
    id: "notification-new-reject",
    eventId: "evt-upgrade",
    decisionId: "decision-new-reject",
    acceptanceId: null,
    recipientSpeakerId: "spk-owner",
    recipientUserId: "usr-upgrade-owner",
    recipientName: "Proposal Owner",
    recipientEmail: "owner@upgrade.example",
    queuedByUserId: "usr-upgrade-organizer",
    subject: "Your Upgrade Conf proposal",
    body: "Thank you for submitting your proposal.",
    state: "pending",
    queuedAt: "2027-02-02T01:00:00Z",
    sentAt: null,
    failureMessage: null,
    ...overrides,
  };
}

function insertNotification(database, input = queueInput()) {
  return database.prepare(`
    INSERT INTO notification_outbox (
      id, event_id, decision_id, acceptance_id, recipient_speaker_id,
      recipient_user_id, recipient_name, recipient_email, queued_by_user_id,
      subject, body, state, queued_at, sent_at, failure_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.eventId,
    input.decisionId,
    input.acceptanceId,
    input.recipientSpeakerId,
    input.recipientUserId,
    input.recipientName,
    input.recipientEmail,
    input.queuedByUserId,
    input.subject,
    input.body,
    input.state,
    input.queuedAt,
    input.sentAt,
    input.failureMessage,
  );
}

describe("decision notification migration", () => {
  const databases = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop().close();
  });

  it("upgrades and preserves ten legacy rows without foreign-key drift", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0003_reviewer_workflow.sql");
    installLegacyFixtures(db);
    const before = db.prepare(`
      SELECT id, event_id AS eventId, acceptance_id AS acceptanceId,
        decision_id AS decisionId, recipient_speaker_id AS recipientSpeakerId,
        subject, state, queued_at AS queuedAt, sent_at AS sentAt
      FROM notification_outbox ORDER BY id
    `).all();

    db.exec(migrationByName.get("0004_decision_notifications.sql"));

    const after = db.prepare(`
      SELECT id, event_id AS eventId, acceptance_id AS acceptanceId,
        decision_id AS decisionId, recipient_speaker_id AS recipientSpeakerId,
        subject, state, queued_at AS queuedAt, sent_at AS sentAt
      FROM notification_outbox ORDER BY id
    `).all();
    expect(after.map(({ subject: _subject, ...row }) => row)).toEqual(
      before.map(({ subject: _subject, ...row }) => row),
    );
    expect(after).toHaveLength(10);
    expect(after.find(({ id }) => id === "notification-legacy-1").subject)
      .toBe("Program decision notification");
    expect(after.find(({ id }) => id === "notification-legacy-2").subject)
      .toBe("x".repeat(998));
    expect(after.find(({ id }) => id === "notification-legacy-3").subject)
      .toBe("Legacy decision 3");
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM notification_outbox
      WHERE recipient_name = 'Legacy Speaker'
        AND recipient_user_id IS NULL AND recipient_email IS NULL
        AND body = 'Legacy notification body unavailable'
    `).get().count).toBe(10);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("normalizes legacy snapshot values that were legal before the new checks", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0003_reviewer_workflow.sql");
    installLegacyFixtures(db);

    const longName = "N".repeat(140);
    const longEmail = `${"e".repeat(250)}@x.io`;
    db.prepare("UPDATE users SET email = ? WHERE id = 'usr-upgrade-organizer'").run(longEmail);
    db.prepare(`
      UPDATE speakers SET user_id = 'usr-upgrade-organizer', name = ?
      WHERE id = 'spk-legacy'
    `).run(longName);
    db.prepare(`
      UPDATE notification_outbox
      SET subject = ?, queued_at = ?, sent_at = ?
      WHERE id = 'notification-legacy-3'
    `).run(
      `${"s".repeat(997)} trailing content`,
      "2027-02-02T00:03:00.123Z",
      "2027-02-02T00:13:00.456Z",
    );
    db.prepare(`
      UPDATE notification_outbox SET queued_at = 'not-a-timestamp'
      WHERE id = 'notification-legacy-10'
    `).run();

    expect(() => db.exec(migrationByName.get("0004_decision_notifications.sql"))).not.toThrow();

    expect(db.prepare(`
      SELECT recipient_user_id AS recipientUserId, recipient_name AS recipientName,
        recipient_email AS recipientEmail, subject, queued_at AS queuedAt, sent_at AS sentAt
      FROM notification_outbox WHERE id = 'notification-legacy-3'
    `).get()).toEqual({
      recipientUserId: null,
      recipientName: "N".repeat(120),
      recipientEmail: null,
      subject: "s".repeat(997),
      queuedAt: "2027-02-02T00:03:00Z",
      sentAt: "2027-02-02T00:13:00Z",
    });
    expect(db.prepare(`
      SELECT queued_at AS queuedAt FROM notification_outbox
      WHERE id = 'notification-legacy-10'
    `).get()).toEqual({ queuedAt: "1970-01-01T00:00:00Z" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_outbox").get().count).toBe(10);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'notification_outbox_legacy_0004'
    `).get().count).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("queues a rejection without acceptance and enforces the decision-owner chain", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0003_reviewer_workflow.sql");
    installLegacyFixtures(db);
    db.exec(migrationByName.get("0004_decision_notifications.sql"));

    expect(() => insertNotification(db)).not.toThrow();
    expect(db.prepare(`
      SELECT decision_id AS decisionId, acceptance_id AS acceptanceId, state
      FROM notification_outbox WHERE id = 'notification-new-reject'
    `).get()).toEqual({
      decisionId: "decision-new-reject",
      acceptanceId: null,
      state: "pending",
    });
    expect(() => insertNotification(db, queueInput({
      id: "wrong-owner",
      recipientSpeakerId: "spk-legacy",
      recipientUserId: null,
      recipientName: "Legacy Speaker",
      recipientEmail: null,
    }))).toThrow(/proposal owner and primary presenter/);
    expect(() => insertNotification(db, queueInput({
      id: "reject-with-acceptance",
      acceptanceId: "acceptance-legacy-1",
    }))).toThrow(/cannot reference an acceptance/);
    expect(() => insertNotification(db, queueInput({
      id: "duplicate-natural-key",
    }))).toThrow(/UNIQUE constraint failed/);
    expect(() => insertNotification(db, queueInput({
      id: "notification-new-waitlist",
      decisionId: "decision-new-waitlist",
      subject: "Your proposal is on the waitlist",
      body: "We will contact you if program capacity becomes available.",
      queuedAt: "2027-02-02T01:01:00Z",
    }))).not.toThrow();
    expect(db.prepare(`
      SELECT acceptance_id AS acceptanceId
      FROM notification_outbox WHERE id = 'notification-new-waitlist'
    `).get().acceptanceId).toBeNull();
  });

  it("rejects an accepted notification until its acceptance exists", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0003_reviewer_workflow.sql");
    installLegacyFixtures(db);
    db.exec(migrationByName.get("0004_decision_notifications.sql"));

    expect(() => insertNotification(db, queueInput({
      id: "notification-new-accept",
      decisionId: "decision-new-accept",
    }))).toThrow(/requires its materialized acceptance/);
  });

  it("freezes queued content and permits only one terminal delivery transition", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0003_reviewer_workflow.sql");
    installLegacyFixtures(db);
    db.exec(migrationByName.get("0004_decision_notifications.sql"));
    insertNotification(db);
    insertNotification(db, queueInput({
      id: "notification-new-waitlist-failure",
      decisionId: "decision-new-waitlist",
    }));

    expect(() => db.exec(`
      UPDATE notification_outbox
      SET state = 'failed', failure_message = 'Mailbox unavailable'
      WHERE id = 'notification-new-waitlist-failure'
    `)).not.toThrow();
    expect(db.prepare(`
      SELECT state, failure_message AS failureMessage
      FROM notification_outbox WHERE id = 'notification-new-waitlist-failure'
    `).get()).toEqual({ state: "failed", failureMessage: "Mailbox unavailable" });

    expect(() => db.exec(`
      UPDATE notification_outbox SET subject = 'Changed'
      WHERE id = 'notification-new-reject'
    `)).toThrow(/queued content are immutable/);
    expect(() => db.exec(`
      DELETE FROM notification_outbox WHERE id = 'notification-new-reject'
    `)).toThrow(/cannot be deleted/);
    expect(() => db.exec(`
      UPDATE notification_outbox
      SET state = 'sent', sent_at = '2027-02-02T01:01:00Z'
      WHERE id = 'notification-new-reject'
    `)).not.toThrow();
    expect(() => db.exec(`
      UPDATE notification_outbox
      SET state = 'pending', sent_at = NULL
      WHERE id = 'notification-new-reject'
    `)).toThrow(/terminal and forward-only/);
    expect(() => db.exec(`
      UPDATE notification_outbox
      SET state = 'failed', sent_at = NULL, failure_message = 'Retry failed'
      WHERE id = 'notification-new-reject'
    `)).toThrow(/terminal and forward-only/);
  });

  it("applies every migration before the current seed and retains ten notifications", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    db.exec(seed);

    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_outbox").get().count).toBe(10);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM proposals
      WHERE event_id = 'evt-devflow' AND status IN ('submitted', 'in_review')
        AND NOT EXISTS (
          SELECT 1 FROM decisions
          WHERE decisions.event_id = proposals.event_id
            AND decisions.proposal_id = proposals.id
        )
    `).get().count).toBe(2);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM review_assignments
      WHERE event_id = 'evt-devflow' AND state = 'assigned'
    `).get().count).toBe(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM notification_outbox
      WHERE recipient_user_id IS NOT NULL AND recipient_email IS NOT NULL
        AND length(body) > 0 AND queued_by_user_id IS NOT NULL
    `).get().count).toBe(10);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("atomically advances submitted proposals and rejects draft decisions", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    db.exec(seed);

    const insertProposal = db.prepare(`
      INSERT INTO proposals (
        id, event_id, owner_user_id, public_id, slug, title, abstract, track, format,
        duration_minutes, status, submitted_at, created_at, updated_at
      ) VALUES (?, 'evt-devflow', 'usr-d-elena', ?, ?, ?, 'Lifecycle fixture.',
        'Developer Experience', 'talk', 30, ?, ?, '2027-03-01T00:00:00Z', ?)
    `);
    const insertPresenter = db.prepare(`
      INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES (?, 'evt-devflow', ?, 'spk-d-elena', 'primary')
    `);
    insertProposal.run(
      "prop-lifecycle-submitted",
      "ABS-LIFECYCLE-SUBMITTED",
      "lifecycle-submitted",
      "Submitted lifecycle fixture",
      "submitted",
      "2027-03-01T01:00:00Z",
      "2027-03-01T01:00:00Z",
    );
    insertPresenter.run(
      "presenter-lifecycle-submitted",
      "prop-lifecycle-submitted",
    );
    insertProposal.run(
      "prop-lifecycle-draft",
      "ABS-LIFECYCLE-DRAFT",
      "lifecycle-draft",
      "Draft lifecycle fixture",
      "draft",
      null,
      "2027-03-01T02:00:00Z",
    );
    insertPresenter.run("presenter-lifecycle-draft", "prop-lifecycle-draft");

    expect(() => db.exec(`
      INSERT INTO decisions (
        id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
      ) VALUES (
        'decision-lifecycle-submitted', 'evt-devflow', 'prop-lifecycle-submitted',
        'reject', 'Lifecycle fixture.', 'usr-devflow-organizer', '2027-03-02T12:00:00Z'
      )
    `)).not.toThrow();
    expect(db.prepare(`
      SELECT status, updated_at AS updatedAt
      FROM proposals WHERE id = 'prop-lifecycle-submitted'
    `).get()).toEqual({
      status: "decided",
      updatedAt: "2027-03-02T12:00:00Z",
    });

    expect(() => db.exec(`
      INSERT INTO decisions (
        id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
      ) VALUES (
        'decision-lifecycle-draft', 'evt-devflow', 'prop-lifecycle-draft',
        'reject', 'Lifecycle fixture.', 'usr-devflow-organizer', '2027-03-02T12:01:00Z'
      )
    `)).toThrow(/submitted or reviewed event proposal/);
    expect(db.prepare(`
      SELECT status, updated_at AS updatedAt
      FROM proposals WHERE id = 'prop-lifecycle-draft'
    `).get()).toEqual({
      status: "draft",
      updatedAt: "2027-03-01T02:00:00Z",
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM decisions WHERE id = 'decision-lifecycle-draft'
    `).get().count).toBe(0);
  });
});
