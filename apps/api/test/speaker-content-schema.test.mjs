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
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db, lastMigration) {
  if (!migrationByName.has(lastMigration)) throw new Error(`Migration not found: ${lastMigration}`);
  for (const name of migrationFiles) {
    db.exec(migrationByName.get(name));
    if (name === lastMigration) break;
  }
}

function insertRequest(db, overrides = {}) {
  const row = {
    id: "request-new",
    eventId: "evt-devflow",
    sessionId: "ses-d-2",
    requestKey: "final-slides",
    requestType: "presentation",
    label: "Final slides",
    instructions: "Upload the final deck.",
    dueAt: "2027-05-01T23:59:00Z",
    contentTypes: '["application/pdf"]',
    maxBytes: 10 * 1024 * 1024,
    required: 1,
    active: 1,
    revision: 1,
    actor: "usr-devflow-organizer",
    now: "2027-04-20T17:00:00Z",
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO deliverable_requests (
      id, event_id, program_session_id, request_key, request_type, label, instructions,
      due_at, allowed_content_types_json, max_bytes, required, active, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.eventId, row.sessionId, row.requestKey, row.requestType, row.label,
    row.instructions, row.dueAt, row.contentTypes, row.maxBytes, row.required, row.active,
    row.revision, row.actor, row.actor, row.now, row.now,
  );
}

function insertVersion(db, overrides = {}) {
  const row = {
    id: "version-new",
    eventId: "evt-devflow",
    requestId: "request-new",
    sessionId: "ses-d-2",
    speakerId: "spk-d-priya",
    versionNumber: 1,
    idempotencyKey: "upload-one",
    filename: "slides.pdf",
    objectKey: "events/evt-devflow/deliverables/request-new/object-one",
    contentType: "application/pdf",
    byteSize: 1200,
    sha256: "a".repeat(64),
    note: "Initial upload",
    uploadedAt: "2027-04-20T17:05:00Z",
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO deliverable_versions (
      id, event_id, request_id, program_session_id, uploaded_by_speaker_id,
      version_number, idempotency_key, original_filename, object_key, content_type,
      byte_size, sha256, note, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.eventId, row.requestId, row.sessionId, row.speakerId,
    row.versionNumber, row.idempotencyKey, row.filename, row.objectKey, row.contentType,
    row.byteSize, row.sha256, row.note, row.uploadedAt,
  );
}

describe("speaker content migration", () => {
  const databases = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop().close();
  });

  it("adds revisioned profile, task, session, and immutable content tables on fresh seed", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare(`
      SELECT revision, workflow_status AS workflowStatus, contact_email AS contactEmail
      FROM speakers WHERE id = 'spk-d-priya'
    `).get()).toEqual({
      revision: 2,
      workflowStatus: "confirmed",
      contactEmail: "priya@devflow.example",
    });
    expect(db.prepare("SELECT revision, due_at AS dueAt FROM speaker_tasks LIMIT 1").get())
      .toEqual({ revision: 1, dueAt: null });
    expect(db.prepare("SELECT revision FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ revision: 1 });

    for (const table of [
      "deliverable_requests", "deliverable_versions", "content_reviews",
      "content_comments", "session_content_history", "speaker_content_history",
    ]) expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.name).toBe(table);
  });

  it("advances trigger-owned session timestamps for same-second invalidations", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    const currentSecond = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS value").get().value;
    db.prepare(`INSERT INTO proposals (
      id, event_id, public_id, slug, title, abstract, track, format,
      duration_minutes, status, submitted_at, created_at, updated_at
    ) VALUES (
      'prop-same-second', 'evt-devflow', 'ABS-SAME', 'same-second', 'Same second',
      'Timestamp regression fixture.', 'Platform & Infra', 'talk', 30,
      'submitted', ?, ?, ?
    )`).run(currentSecond, currentSecond, currentSecond);
    db.prepare(`INSERT INTO program_sessions (
      id, event_id, source_proposal_id, slug, title, abstract, track, format,
      duration_minutes, publication_status, deliverables_status, approval_status,
      created_at, updated_at
    ) VALUES (
      'ses-same-second', 'evt-devflow', 'prop-same-second', 'same-second', 'Same second',
      'Timestamp regression fixture.', 'Platform & Infra', 'talk', 30,
      'published', 'ready', 'approved', ?, ?
    )`).run(currentSecond, currentSecond);

    expect(() => insertRequest(db, {
      id: "request-same-second",
      sessionId: "ses-same-second",
      requestKey: "same-second-slides",
      now: currentSecond,
    })).not.toThrow();
    const session = db.prepare(`SELECT approval_status AS approvalStatus,
      deliverables_status AS deliverablesStatus, revision, updated_at AS updatedAt
      FROM program_sessions WHERE id = 'ses-same-second'`).get();
    expect(session.approvalStatus).toBe("pending");
    expect(session.deliverablesStatus).toBe("missing");
    expect(session.revision).toBe(2);
    expect(session.updatedAt > currentSecond).toBe(true);
  });

  it("preserves populated rows when upgrading from the released migration", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    db.exec(`
      INSERT INTO users (id, email, display_name, created_at)
      VALUES ('usr-upgrade', 'speaker@upgrade.example', 'Upgrade Speaker', '2027-01-01T00:00:00Z');
      INSERT INTO events (
        id, slug, name, tagline, location, description, starts_on, ends_on,
        cfp_deadline, status, time_zone
      ) VALUES (
        'evt-upgrade', 'upgrade-conf', 'Upgrade Conf', '', '', '', '2027-07-01', '2027-07-02',
        '2027-02-01T00:00:00Z', 'published', 'UTC'
      );
      INSERT INTO speakers (
        id, event_id, user_id, slug, name, title, company, bio, headshot_url,
        headshot_fallback, profile_status, agreement_status, public_visibility
      ) VALUES (
        'spk-upgrade', 'evt-upgrade', 'usr-upgrade', 'upgrade-speaker', 'Upgrade Speaker',
        '', '', '', NULL, 'US', 'incomplete', 'missing', 'private'
      );
    `);
    const before = db.prepare("SELECT COUNT(*) AS count FROM speakers").get();
    db.exec(migrationByName.get("0006_speaker_content.sql"));

    expect(db.prepare("SELECT COUNT(*) AS count FROM speakers").get()).toEqual(before);
    expect(db.prepare("SELECT contact_email AS contactEmail FROM speakers WHERE id = 'spk-upgrade'").get())
      .toEqual({ contactEmail: "speaker@upgrade.example" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces event scope, organizer actors, active request uniqueness, and revisions", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);

    expect(() => insertRequest(db, { actor: "usr-fieldnotes-organizer" })).toThrow(/same-event organizer/);
    expect(() => insertRequest(db, { sessionId: "ses-f-1" })).toThrow(/same event/);
    expect(() => insertRequest(db, {
      id: "request-headshot",
      requestKey: "final-headshot",
      requestType: "headshot",
      contentTypes: '["image/webp"]',
    })).toThrow();
    insertRequest(db);
    expect(() => insertRequest(db, { id: "request-duplicate" })).toThrow();
    expect(() => db.prepare(`
      UPDATE deliverable_requests
      SET id = 'request-renamed', revision = 2, updated_at = '2027-04-20T17:01:00Z'
      WHERE id = 'request-new'
    `).run()).toThrow(/identity is immutable/);
    expect(() => db.prepare("DELETE FROM deliverable_requests WHERE id = 'request-new'").run())
      .toThrow(/deactivate/);
    expect(() => db.prepare("UPDATE deliverable_requests SET label = 'Changed' WHERE id = 'request-new'").run())
      .toThrow(/next revision/);
    expect(() => db.prepare(`
      UPDATE deliverable_requests
      SET label = 'Changed', revision = 2, updated_at = '2027-04-20T17:01:00Z'
      WHERE id = 'request-new'
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      UPDATE deliverable_requests
      SET revision = 3, updated_at = '2027-04-20T17:02:00Z'
      WHERE id = 'request-new'
    `).run()).toThrow(/request change/);
  });

  it("keeps versions contiguous, idempotent, presenter-owned, and immutable", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    insertRequest(db);

    expect(() => insertVersion(db, { speakerId: "spk-f-lina" })).toThrow(/accepted session presenter/);
    expect(() => insertVersion(db, { contentType: "image/webp" })).toThrow();
    expect(() => insertVersion(db, { objectKey: "events/evt-fieldnotes/deliverables/object" }))
      .toThrow(/same event scope/);
    expect(() => insertVersion(db, { versionNumber: 2 })).toThrow(/next contiguous/);
    insertVersion(db);
    expect(() => insertVersion(db, { id: "version-retry", versionNumber: 2 })).toThrow();
    expect(() => insertVersion(db, {
      id: "version-two",
      versionNumber: 2,
      idempotencyKey: "upload-two",
      objectKey: "events/evt-devflow/deliverables/request-new/object-two",
    })).not.toThrow();
    expect(() => db.prepare("UPDATE deliverable_versions SET note = 'rewrite' WHERE id = 'version-new'").run())
      .toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM deliverable_versions WHERE id = 'version-new'").run())
      .toThrow(/immutable/);
  });

  it("keeps private object keys globally unique and inside their exact event prefix", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);

    const metadata = `headshot_original_filename = 'priya.webp', headshot_content_type = 'image/webp',
      headshot_byte_size = 1200, headshot_sha256 = '${"b".repeat(64)}',
      headshot_uploaded_at = '2027-04-20T17:00:00Z'`;
    expect(() => db.prepare(`
      UPDATE speakers SET headshot_object_key = 'events/evt-fieldnotes/headshots/priya', ${metadata},
        revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'spk-d-priya'
    `).run()).toThrow(/same event scope/);
    db.prepare(`
      UPDATE speakers SET headshot_object_key = 'events/evt-devflow/headshots/priya', ${metadata},
        revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'spk-d-priya'
    `).run();

    insertRequest(db);
    expect(() => insertVersion(db, { objectKey: "events/evt-devflow/headshots/priya" }))
      .toThrow(/globally unique/);
  });

  it("scopes immutable reviews, comments, and content history to organizer and presenter chains", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    insertRequest(db);
    insertVersion(db);

    expect(() => db.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key, outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES ('review-wrong', 'evt-devflow', 'ses-d-2', 'version-new', 'review-wrong', 'approved', 'Ready',
        'usr-fieldnotes-organizer', '2027-04-20T17:10:00Z')
    `).run()).toThrow(/same-event organizer/);
    expect(() => db.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key, outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES ('review-one', 'evt-devflow', 'ses-d-2', 'version-new', 'review-one', 'approved', 'Ready',
        'usr-devflow-organizer', '2027-04-20T17:10:00Z')
    `).run()).not.toThrow();
    expect(() => db.prepare("UPDATE content_reviews SET comment = 'rewrite' WHERE id = 'review-one'").run())
      .toThrow(/immutable/);

    expect(() => db.prepare(`
      INSERT INTO content_comments (
        id, event_id, program_session_id, version_id, author_user_id, author_speaker_id, body, created_at
      ) VALUES ('comment-one', 'evt-devflow', 'ses-d-2', 'version-new', NULL, 'spk-d-priya', 'Slides uploaded.',
        '2027-04-20T17:11:00Z')
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO content_comments (
        id, event_id, program_session_id, version_id, author_user_id, author_speaker_id, body, created_at
      ) VALUES ('comment-wrong', 'evt-devflow', 'ses-d-2', 'version-new', NULL, 'spk-f-lina', 'Cross event.',
        '2027-04-20T17:11:00Z')
    `).run()).toThrow(/session presenter/);

    expect(() => db.prepare(`
      INSERT INTO session_content_history (
        id, event_id, program_session_id, action, title, abstract, track, format,
        duration_minutes, change_note, actor_user_id, created_at
      ) SELECT 'history-one', event_id, id, 'updated', title, abstract, track, format,
        duration_minutes, 'Clarified title', 'usr-devflow-organizer', '2027-04-20T17:12:00Z'
      FROM program_sessions WHERE id = 'ses-d-2'
    `).run()).not.toThrow();
    expect(() => db.prepare("DELETE FROM session_content_history WHERE id = 'history-one'").run())
      .toThrow(/immutable/);
  });

  it("allows immutable profile history from only the target speaker or a same-event organizer", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    const insert = ({ id, action = "updated", actor = "usr-d-priya" }) => db.prepare(`
      INSERT INTO speaker_content_history (
        id, event_id, speaker_id, action, profile_json, change_note, actor_user_id, created_at
      ) VALUES (?, 'evt-devflow', 'spk-d-priya', ?, '{}', 'Pre-change snapshot', ?, '2027-04-20T17:00:00Z')
    `).run(id, action, actor);

    expect(() => insert({ id: "speaker-history-owner" })).not.toThrow();
    expect(() => insert({ id: "speaker-history-other", actor: "usr-d-marcus" }))
      .toThrow(/target speaker/);
    expect(() => insert({ id: "speaker-history-cross-event", actor: "usr-f-lina" }))
      .toThrow(/target speaker/);
    expect(() => insert({ id: "speaker-history-owner-restored", action: "restored" }))
      .toThrow(/target speaker/);
    expect(() => insert({ id: "speaker-history-owner-headshot", action: "headshot_uploaded" }))
      .toThrow(/target speaker/);
    expect(() => insert({
      id: "speaker-history-organizer-restored",
      action: "restored",
      actor: "usr-devflow-organizer",
    })).not.toThrow();
    expect(() => db.prepare(`
      UPDATE speaker_content_history SET change_note = 'Changed' WHERE id = 'speaker-history-owner'
    `).run()).toThrow(/immutable/);
    expect(() => db.prepare(`
      DELETE FROM speaker_content_history WHERE id = 'speaker-history-owner'
    `).run()).toThrow(/immutable/);
  });

  it("requires exact revisions and consistent task completion timestamps", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    const task = db.prepare("SELECT id FROM speaker_tasks WHERE speaker_id = 'spk-d-priya' LIMIT 1").get();

    expect(() => db.prepare("UPDATE speakers SET contact_email = 'changed@example.com' WHERE id = 'spk-d-priya'").run())
      .toThrow(/next revision/);
    expect(() => db.prepare(`
      UPDATE speaker_tasks SET state = 'open', revision = 2,
        updated_at = '2027-04-20T17:00:00Z' WHERE id = ?
    `).run(task.id))
      .toThrow(/completion timestamp/);
    expect(() => db.prepare(`
      UPDATE speaker_tasks SET state = 'open', completed_at = NULL,
        revision = 2, updated_at = '2027-04-20T17:00:00Z' WHERE id = ?
    `).run(task.id)).not.toThrow();
    expect(() => db.prepare(`
      UPDATE speaker_tasks SET revision = 3, updated_at = '2027-04-20T17:01:00Z' WHERE id = ?
    `).run(task.id)).toThrow(/task change/);
    expect(() => db.prepare(`
      UPDATE speakers SET revision = revision + 1,
        updated_at = '2027-04-20T17:01:00Z' WHERE id = 'spk-d-priya'
    `).run()).toThrow(/profile change/);
    expect(() => db.prepare(`
      UPDATE program_sessions SET revision = revision + 1,
        updated_at = '2027-04-20T17:01:00Z' WHERE id = 'ses-d-2'
    `).run()).toThrow(/content change/);
  });

  it("requires same-event organizer provenance for custom tasks", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    const insert = (id, actor) => db.prepare(`
      INSERT INTO speaker_tasks (
        id, event_id, acceptance_id, program_session_id, speaker_id, task_key, label,
        state, created_at, completed_at, due_at, revision, updated_at, created_by_user_id
      ) VALUES (?, 'evt-devflow', 'acc-d-2', 'ses-d-2', 'spk-d-priya', 'travel-form',
        'Complete travel form', 'open', '2027-04-20T17:00:00Z', NULL,
        '2027-04-30T23:59:00Z', 1, '2027-04-20T17:00:00Z', ?)
    `).run(id, actor);

    expect(() => insert("task-custom-missing", null)).toThrow(/creating organizer/);
    expect(() => insert("task-custom-cross-event", "usr-fieldnotes-organizer")).toThrow(/same-event organizer/);
    expect(() => insert("task-custom-valid", "usr-devflow-organizer")).not.toThrow();
  });

  it("advances revision timestamps monotonically when fixture timestamps are in the future", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);

    expect(db.prepare(`
      SELECT revision, updated_at AS updatedAt FROM speakers WHERE id = 'spk-d-priya'
    `).get()).toEqual({ revision: 2, updatedAt: "2027-02-18T18:05:00Z" });
    expect(() => db.prepare(`
      UPDATE speakers
      SET bio = 'A current edit against a future-dated fixture',
        revision = revision + 1,
        updated_at = CASE
          WHEN updated_at >= ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
          ELSE ?
        END
      WHERE id = 'spk-d-priya'
    `).run("2026-08-11T18:00:00Z", "2026-08-11T18:00:00Z")).not.toThrow();
    expect(db.prepare(`
      SELECT revision, updated_at AS updatedAt FROM speakers WHERE id = 'spk-d-priya'
    `).get()).toEqual({ revision: 3, updatedAt: "2027-02-18T18:05:01Z" });
  });

  it("advances a future speaker timestamp when a presenter link confirms their workflow", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    const before = db.prepare("SELECT revision FROM speakers WHERE id = 'spk-d-priya'").get();
    db.prepare("DELETE FROM session_presenters WHERE id = 'presenter-d-2-primary'").run();
    db.prepare(`
      UPDATE speakers SET workflow_status = 'invited', revision = revision + 1,
        updated_at = '2030-01-01T00:00:00Z' WHERE id = 'spk-d-priya'
    `).run();
    db.prepare(`
      INSERT INTO session_presenters (id, event_id, program_session_id, speaker_id, role)
      VALUES ('presenter-d-2-primary', 'evt-devflow', 'ses-d-2', 'spk-d-priya', 'primary')
    `).run();

    expect(db.prepare(`
      SELECT workflow_status AS status, revision, updated_at AS updatedAt
      FROM speakers WHERE id = 'spk-d-priya'
    `).get()).toEqual({ status: "confirmed", revision: before.revision + 2, updatedAt: "2030-01-01T00:00:01Z" });
  });

  it("does not bump a confirmed userless speaker when presenter linking cannot fill an email", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    db.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, headshot_url,
      headshot_fallback, profile_status, agreement_status, public_visibility,
      contact_email, workflow_status, social_urls_json, travel_preferences, revision, updated_at
    ) VALUES (
      'spk-userless', 'evt-devflow', NULL, 'userless-speaker', 'Userless Speaker',
      'Guest', 'Independent', 'Imported speaker without an account.', NULL,
      'US', 'incomplete', 'missing', 'private', '', 'confirmed',
      '{"website":null,"linkedin":null,"x":null}', '', 1, '2027-02-20T18:00:00Z'
    )`).run();
    db.prepare(`INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('proposal-presenter-userless', 'evt-devflow', 'prop-d-supplemental-submitted', 'spk-userless', 'co_presenter')`).run();
    db.prepare(`INSERT INTO program_sessions (
      id, event_id, source_proposal_id, slug, title, abstract, track, format,
      duration_minutes, publication_status, deliverables_status, approval_status, created_at, updated_at
    ) VALUES (
      'ses-userless', 'evt-devflow', 'prop-d-supplemental-submitted', 'userless-session',
      'Userless session', 'Fixture session.', 'Developer Experience', 'talk', 30,
      'private', 'missing', 'pending', '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z'
    )`).run();

    expect(() => db.prepare(`INSERT INTO session_presenters (
      id, event_id, program_session_id, speaker_id, role
    ) VALUES ('presenter-userless', 'evt-devflow', 'ses-userless', 'spk-userless', 'co_presenter')`).run())
      .not.toThrow();
    expect(db.prepare(`SELECT contact_email AS contactEmail, workflow_status AS status, revision
      FROM speakers WHERE id = 'spk-userless'`).get())
      .toEqual({ contactEmail: "", status: "confirmed", revision: 1 });
  });

  it("demotes approved sessions when a new or reactivated required request invalidates readiness", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);

    insertRequest(db);
    expect(db.prepare(`
      SELECT deliverables_status AS status FROM program_sessions WHERE id = 'ses-d-2'
    `).get()).toEqual({ status: "missing" });
    expect(db.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });

    const second = database();
    databases.push(second);
    applyThrough(second, "0006_speaker_content.sql");
    second.exec(seed);
    insertRequest(second, { active: 0 });
    second.prepare(`
      UPDATE deliverable_requests
      SET active = 1, revision = 2, updated_at = '2027-04-20T17:01:00Z'
      WHERE id = 'request-new'
    `).run();
    expect(second.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });
  });

  it("demotes approved sessions for new versions, latest change requests, reopened tasks, and presenter regressions", () => {
    const versionDb = database();
    databases.push(versionDb);
    applyThrough(versionDb, "0006_speaker_content.sql");
    versionDb.exec(seed);
    insertRequest(versionDb, { required: 0 });
    insertVersion(versionDb);
    expect(versionDb.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });

    versionDb.prepare(`
      UPDATE speaker_tasks
      SET state = 'waived', completed_at = NULL,
        revision = revision + 1, updated_at = '2027-04-20T17:10:00Z'
      WHERE event_id = 'evt-devflow' AND program_session_id = 'ses-d-2'
    `).run();
    versionDb.prepare(`
      UPDATE program_sessions
      SET approval_status = 'approved', revision = revision + 1, updated_at = '2027-04-20T17:11:00Z'
      WHERE id = 'ses-d-2'
    `).run();
    versionDb.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key,
        outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES (
        'review-regression', 'evt-devflow', 'ses-d-2', 'version-new', 'review-regression',
        'changes_requested', 'Revise this version', 'usr-devflow-organizer', '2027-04-20T17:12:00Z'
      )
    `).run();
    expect(versionDb.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });

    const taskDb = database();
    databases.push(taskDb);
    applyThrough(taskDb, "0006_speaker_content.sql");
    taskDb.exec(seed);
    const task = taskDb.prepare(`
      SELECT id FROM speaker_tasks WHERE program_session_id = 'ses-d-2' LIMIT 1
    `).get();
    taskDb.prepare(`
      UPDATE speaker_tasks SET state = 'waived', completed_at = NULL,
        revision = 2, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = ?
    `).run(task.id);
    taskDb.prepare(`
      UPDATE speaker_tasks SET state = 'open', revision = 3, updated_at = '2027-04-20T17:01:00Z'
      WHERE id = ?
    `).run(task.id);
    expect(taskDb.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });

    const speakerDb = database();
    databases.push(speakerDb);
    applyThrough(speakerDb, "0006_speaker_content.sql");
    speakerDb.exec(seed);
    speakerDb.prepare(`
      UPDATE speakers
      SET profile_status = 'incomplete', revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'spk-d-marcus'
    `).run();
    expect(speakerDb.prepare("SELECT approval_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "pending" });
  });

  it("gates approval on the approved latest required version and presenter readiness", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);

    expect(() => db.prepare(`
      UPDATE program_sessions SET approval_status = 'pending' WHERE id = 'ses-d-2'
    `).run()).toThrow(/next revision/);
    db.prepare(`
      UPDATE program_sessions
      SET approval_status = 'pending', revision = 2, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'ses-d-2'
    `).run();
    insertRequest(db);
    expect(db.prepare("SELECT deliverables_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "missing" });
    insertVersion(db);
    expect(db.prepare("SELECT deliverables_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "submitted" });
    db.prepare(`
      UPDATE speaker_tasks
      SET state = 'waived', completed_at = NULL,
        revision = revision + 1, updated_at = '2027-04-20T17:01:00Z'
      WHERE event_id = 'evt-devflow' AND program_session_id = 'ses-d-2'
    `).run();

    expect(() => db.prepare(`
      UPDATE program_sessions
      SET approval_status = 'approved', revision = 3, updated_at = '2027-04-20T17:10:00Z'
      WHERE id = 'ses-d-2'
    `).run()).toThrow(/approved latest required deliverables/);

    db.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key,
        outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES (
        'review-gate', 'evt-devflow', 'ses-d-2', 'version-new', 'review-gate',
        'approved', 'Ready', 'usr-devflow-organizer', '2027-04-20T17:11:00Z'
      )
    `).run();
    expect(db.prepare("SELECT deliverables_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "ready" });
    expect(() => db.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key,
        outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES (
        'review-same-second', 'evt-devflow', 'ses-d-2', 'version-new', 'review-same-second',
        'approved', 'Also ready', 'usr-devflow-organizer', '2027-04-20T17:11:00Z'
      )
    `).run()).toThrow(/must follow/);
    const session = db.prepare("SELECT revision FROM program_sessions WHERE id = 'ses-d-2'").get();
    expect(() => db.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key,
        outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES (
        'review-gate-retry', 'evt-devflow', 'ses-d-2', 'version-new', 'review-gate',
        'approved', 'Ready', 'usr-devflow-organizer', '2027-04-20T17:12:00Z'
      )
    `).run()).toThrow();
    expect(() => db.prepare(`
      UPDATE program_sessions
      SET approval_status = 'approved', revision = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
      WHERE id = 'ses-d-2'
    `).run(session.revision + 1)).not.toThrow();

    db.prepare(`
      INSERT INTO content_reviews (
        id, event_id, program_session_id, version_id, idempotency_key,
        outcome, comment, reviewed_by_user_id, reviewed_at
      ) VALUES (
        'review-changes', 'evt-devflow', 'ses-d-2', 'version-new', 'review-changes',
        'changes_requested', 'One more edit', 'usr-devflow-organizer', '2027-04-20T17:13:00Z'
      )
    `).run();
    expect(db.prepare(`
      SELECT deliverables_status AS deliverables, approval_status AS approval
      FROM program_sessions WHERE id = 'ses-d-2'
    `).get()).toEqual({ deliverables: "submitted", approval: "pending" });
    db.prepare(`
      UPDATE deliverable_requests
      SET active = 0, revision = revision + 1, updated_at = '2027-04-20T17:14:00Z'
      WHERE id = 'request-new'
    `).run();
    expect(db.prepare("SELECT deliverables_status AS status FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ status: "ready" });
  });
});
