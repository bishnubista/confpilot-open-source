import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const migrations = migrationFiles.map((name) => readFileSync(new URL(name, migrationsUrl), "utf8"));
const seed = readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8");

const fixtureSql = `
  INSERT INTO users (id, email, display_name, created_at) VALUES
    ('usr-ops-reviewer', 'ops-reviewer@example.com', 'Ops Reviewer', '2026-08-12T00:00:00Z'),
    ('usr-ops-reviewer-2', 'ops-reviewer-2@example.com', 'Second Ops Reviewer', '2026-08-12T00:00:00Z'),
    ('usr-ops-outsider', 'ops-outsider@example.com', 'Ops Outsider', '2026-08-12T00:00:00Z');

  INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES
    ('mem-ops-reviewer', 'evt-devflow', 'usr-ops-reviewer', 'reviewer', '2026-08-12T00:00:00Z'),
    ('mem-ops-reviewer-2', 'evt-devflow', 'usr-ops-reviewer-2', 'reviewer', '2026-08-12T00:00:00Z'),
    ('mem-ops-outsider', 'evt-fieldnotes', 'usr-ops-outsider', 'reviewer', '2026-08-12T00:00:00Z');

  INSERT INTO proposals (
    id, event_id, public_id, slug, title, abstract, track, format,
    duration_minutes, status, submitted_at, created_at, updated_at
  ) VALUES
    ('prop-ops-1', 'evt-devflow', 'ABS-OPS-1', 'ops-proposal-one', 'Ops proposal one',
      'A submitted round fixture.', 'AI Engineering', 'talk', 30, 'submitted',
      '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
    ('prop-ops-2', 'evt-devflow', 'ABS-OPS-2', 'ops-proposal-two', 'Ops proposal two',
      'A second submitted round fixture.', 'Platform & Infra', 'talk', 30, 'submitted',
      '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z');
`;

function splitSql(script) {
  const statements = [];
  let current = "";
  let inTrigger = false;
  for (const line of script.split("\n")) {
    current += `${line}\n`;
    if (/^CREATE TRIGGER\b/.test(line)) inTrigger = true;
    const complete = inTrigger ? /^END;\s*$/.test(line) : /;\s*$/.test(line);
    if (complete) {
      statements.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  if (current.trim()) throw new Error("Incomplete SQL fixture statement");
  return statements;
}

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration);
  database.exec(seed);
  database.exec(fixtureSql);
  return database;
}

const ORGANIZER = "usr-devflow-organizer";

function round(overrides = {}) {
  return {
    id: "round-initial",
    eventId: "evt-devflow",
    name: "Initial Review",
    opensAt: "2026-08-01T00:00:00Z",
    closesAt: "2026-10-15T00:00:00Z",
    blindDefault: 1,
    position: 0,
    createdByUserId: ORGANIZER,
    updatedByUserId: null,
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
    ...overrides,
  };
}

function insertRound(database, input = round()) {
  return database.prepare(`
    INSERT INTO review_rounds (
      id, event_id, name, opens_at, closes_at, blind_default, position,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.eventId,
    input.name,
    input.opensAt,
    input.closesAt,
    input.blindDefault,
    input.position,
    input.createdByUserId,
    input.updatedByUserId,
    input.createdAt,
    input.updatedAt,
  );
}

function insertPoolEntry(database, overrides = {}) {
  const entry = {
    id: "pool-initial-reviewer",
    eventId: "evt-devflow",
    reviewRoundId: "round-initial",
    reviewerUserId: "usr-ops-reviewer",
    addedByUserId: ORGANIZER,
    createdAt: "2026-08-12T00:00:00Z",
    ...overrides,
  };
  return database.prepare(`
    INSERT INTO review_round_reviewers (
      id, event_id, review_round_id, reviewer_user_id, added_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.eventId,
    entry.reviewRoundId,
    entry.reviewerUserId,
    entry.addedByUserId,
    entry.createdAt,
  );
}

function insertPlan(database, overrides = {}) {
  const plan = {
    id: "plan-ops",
    eventId: "evt-devflow",
    name: "Round evaluation",
    createdByUserId: ORGANIZER,
    createdAt: "2026-08-12T00:00:00Z",
    reviewRoundId: null,
    ...overrides,
  };
  return database.prepare(`
    INSERT INTO review_plans (id, event_id, name, created_by_user_id, created_at, review_round_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(plan.id, plan.eventId, plan.name, plan.createdByUserId, plan.createdAt, plan.reviewRoundId);
}

function insertVersion(database, overrides = {}) {
  const version = {
    id: "planv-ops-1",
    eventId: "evt-devflow",
    planId: "plan-ops",
    versionNumber: 1,
    name: "Round evaluation",
    createdByUserId: ORGANIZER,
    createdAt: "2026-08-12T00:00:00Z",
    builtinLabelsJson: null,
    ...overrides,
  };
  return database.prepare(`
    INSERT INTO review_plan_versions (
      id, event_id, plan_id, version_number, name, created_by_user_id, created_at, builtin_labels_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.eventId,
    version.planId,
    version.versionNumber,
    version.name,
    version.createdByUserId,
    version.createdAt,
    version.builtinLabelsJson,
  );
}

function activatePlan(database, planId, versionId) {
  database.prepare(`
    INSERT INTO review_criteria (
      id, event_id, plan_version_id, criterion_key, label, description,
      weight_basis_points, minimum_score, maximum_score, sort_order
    ) VALUES
      ('crit-' || ?2 || '-a', 'evt-devflow', ?2, 'originality', 'Originality', '', 6667, 1, 5, 0),
      ('crit-' || ?2 || '-b', 'evt-devflow', ?2, 'relevance', 'Relevance', '', 3333, 1, 5, 1)
  `).run(planId, versionId);
  database.prepare(`
    UPDATE review_plans SET active_version_id = ?, activated_by_user_id = ? WHERE id = ?
  `).run(versionId, ORGANIZER, planId);
}

function assignment(overrides = {}) {
  return {
    id: "assignment-ops-1",
    eventId: "evt-devflow",
    proposalId: "prop-ops-1",
    reviewerUserId: "usr-ops-reviewer",
    createdByUserId: ORGANIZER,
    round: 1,
    blind: 1,
    state: "assigned",
    dueAt: "2026-09-01T00:00:00Z",
    revokedAt: null,
    revokedByUserId: null,
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
    reviewPlanVersionId: null,
    requiresResponse: 0,
    reviewRoundId: null,
    ...overrides,
  };
}

function insertAssignment(database, input = assignment()) {
  return database.prepare(`
    INSERT INTO review_assignments (
      id, event_id, proposal_id, reviewer_user_id, created_by_user_id,
      round, blind, state, due_at, revoked_at, revoked_by_user_id, created_at, updated_at,
      review_plan_version_id, requires_response, review_round_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.eventId,
    input.proposalId,
    input.reviewerUserId,
    input.createdByUserId,
    input.round,
    input.blind,
    input.state,
    input.dueAt,
    input.revokedAt,
    input.revokedByUserId,
    input.createdAt,
    input.updatedAt,
    input.reviewPlanVersionId,
    input.requiresResponse,
    input.reviewRoundId,
  );
}

const VALID_LABELS = JSON.stringify({
  recommendationAccept: "Accept",
  recommendationDiscuss: "Maybe",
  recommendationReject: "Reject",
  commentsLabel: "Comments",
});

describe("review rounds", () => {
  it("rejects a round created by a non-organizer", () => {
    const database = fixtureDatabase();
    expect(() => insertRound(database, round({ createdByUserId: "usr-ops-reviewer" })))
      .toThrow(/review round requires an event organizer/);
  });

  it("rejects a round that does not start unmodified", () => {
    const database = fixtureDatabase();
    expect(() => insertRound(database, round({ updatedByUserId: ORGANIZER })))
      .toThrow(/review round must start unmodified/);
    expect(() => insertRound(database, round({ updatedAt: "2026-08-12T00:00:01Z" })))
      .toThrow(/review round must start unmodified/);
  });

  it("rejects an inverted window", () => {
    const database = fixtureDatabase();
    expect(() => insertRound(database, round({ opensAt: "2026-10-16T00:00:00Z" })))
      .toThrow(/CHECK constraint failed/);
  });

  it("requires canonical UTC-second round windows on insert and update", () => {
    const database = fixtureDatabase();
    expect(() => insertRound(database, round({ opensAt: "2026-08-01T00:00:00.000Z" })))
      .toThrow(/canonical UTC-second timestamps/);
    insertRound(database);
    expect(() => database.prepare(`UPDATE review_rounds
      SET closes_at = '2026-10-15T00:00:00+00:00', updated_by_user_id = ?, updated_at = '2026-08-12T01:00:00Z'
      WHERE id = 'round-initial'`).run(ORGANIZER)).toThrow(/canonical UTC-second timestamps/);
  });

  it("requires an organizer update actor and freezes identity", () => {
    const database = fixtureDatabase();
    insertRound(database);
    expect(() => database.prepare(
      "UPDATE review_rounds SET name = 'Renamed', updated_at = '2026-08-12T01:00:00Z' WHERE id = 'round-initial'",
    ).run()).toThrow(/review round update requires an event organizer/);
    expect(() => database.prepare(
      "UPDATE review_rounds SET name = 'Renamed', updated_by_user_id = 'usr-ops-reviewer', updated_at = '2026-08-12T01:00:00Z' WHERE id = 'round-initial'",
    ).run()).toThrow(/review round update requires an event organizer/);
    database.prepare(
      "UPDATE review_rounds SET name = 'Renamed', updated_by_user_id = ?, updated_at = '2026-08-12T01:00:00Z' WHERE id = 'round-initial'",
    ).run(ORGANIZER);
    expect(() => database.prepare(
      "UPDATE review_rounds SET updated_by_user_id = 'usr-ops-reviewer' WHERE id = 'round-initial'",
    ).run()).toThrow(/review round update requires an event organizer/);
    expect(() => database.prepare(
      "UPDATE review_rounds SET event_id = 'evt-fieldnotes' WHERE id = 'round-initial'",
    ).run()).toThrow(/review round identity is immutable/);
  });

  it("blocks deleting a referenced round and allows an unreferenced delete", () => {
    const database = fixtureDatabase();
    insertRound(database);
    insertPlan(database, { reviewRoundId: "round-initial" });
    expect(() => database.prepare("DELETE FROM review_rounds WHERE id = 'round-initial'").run())
      .toThrow(/review round with plans or assignments cannot be deleted/);
    insertRound(database, round({ id: "round-final", name: "Final Review", position: 1, opensAt: "2026-10-16T00:00:00Z", closesAt: "2026-11-30T00:00:00Z" }));
    database.prepare("DELETE FROM review_rounds WHERE id = 'round-final'").run();
  });
});

describe("review round pools", () => {
  it("rejects cross-event rounds, non-reviewers, and non-organizer adders", () => {
    const database = fixtureDatabase();
    insertRound(database);
    expect(() => insertPoolEntry(database, { eventId: "evt-fieldnotes", reviewerUserId: "usr-ops-outsider" }))
      .toThrow(/review round pool entry must belong to a same-event round/);
    expect(() => insertPoolEntry(database, { reviewerUserId: ORGANIZER }))
      .toThrow(/review round pool entry requires an event reviewer/);
    expect(() => insertPoolEntry(database, { addedByUserId: "usr-ops-reviewer" }))
      .toThrow(/review round pool entry requires an event organizer/);
    insertPoolEntry(database);
    expect(() => insertPoolEntry(database, { id: "pool-duplicate" }))
      .toThrow(/UNIQUE constraint failed/);
  });

  it("blocks removing a pool entry while the reviewer has an active round assignment", () => {
    const database = fixtureDatabase();
    insertRound(database);
    insertPoolEntry(database);
    insertPlan(database, { id: "plan-round", reviewRoundId: "round-initial" });
    insertVersion(database, { id: "planv-round-1", planId: "plan-round" });
    activatePlan(database, "plan-round", "planv-round-1");
    insertAssignment(database, assignment({ reviewRoundId: "round-initial", reviewPlanVersionId: "planv-round-1" }));
    expect(() => database.prepare("DELETE FROM review_round_reviewers WHERE id = 'pool-initial-reviewer'").run())
      .toThrow(/review round pool entry with active assignments cannot be removed/);
    database.prepare(
      "UPDATE review_assignments SET state = 'revoked', revoked_at = '2026-08-12T02:00:00Z', revoked_by_user_id = ?, updated_at = '2026-08-12T02:00:00Z' WHERE id = 'assignment-ops-1'",
    ).run(ORGANIZER);
    database.prepare("DELETE FROM review_round_reviewers WHERE id = 'pool-initial-reviewer'").run();
  });
});

describe("per-round review plans", () => {
  it("keeps one default plan per event and one plan per round", () => {
    const database = fixtureDatabase();
    insertRound(database);
    insertPlan(database, { id: "plan-default", reviewRoundId: null });
    expect(() => insertPlan(database, { id: "plan-default-2", reviewRoundId: null }))
      .toThrow(/UNIQUE constraint failed/);
    insertPlan(database, { id: "plan-round", reviewRoundId: "round-initial" });
    expect(() => insertPlan(database, { id: "plan-round-2", reviewRoundId: "round-initial" }))
      .toThrow(/UNIQUE constraint failed/);
  });

  it("rejects a plan whose round belongs to another event and freezes review_round_id", () => {
    const database = fixtureDatabase();
    insertRound(database);
    expect(() => insertPlan(database, { id: "plan-cross", eventId: "evt-fieldnotes", createdByUserId: "usr-fieldnotes-organizer", reviewRoundId: "round-initial" }))
      .toThrow(/review plan round must belong to the same event/);
    insertPlan(database, { id: "plan-frozen", reviewRoundId: "round-initial" });
    expect(() => database.prepare("UPDATE review_plans SET review_round_id = NULL WHERE id = 'plan-frozen'").run())
      .toThrow(/review plan identity is immutable/);
  });
});

describe("builtin scorecard labels", () => {
  it("accepts NULL and a fully labeled object", () => {
    const database = fixtureDatabase();
    insertPlan(database);
    insertVersion(database, { id: "planv-null", builtinLabelsJson: null });
    insertVersion(database, { id: "planv-labeled", versionNumber: 2, builtinLabelsJson: VALID_LABELS });
  });

  it("rejects malformed label payloads", () => {
    const database = fixtureDatabase();
    insertPlan(database);
    const reject = (value, id) =>
      expect(() => insertVersion(database, { id, builtinLabelsJson: value }))
        .toThrow(/review plan builtin labels must name the three recommendations and the comments field/);
    // SQLite's json_type raises its own parse error before the trigger message;
    // either way the insert is rejected.
    expect(() => insertVersion(database, { id: "planv-bad-1", builtinLabelsJson: "not-json{" }))
      .toThrow(/malformed JSON|review plan builtin labels/);
    reject(JSON.stringify(["Accept", "Maybe", "Reject", "Comments"]), "planv-bad-2");
    reject(JSON.stringify({ recommendationAccept: "Accept", recommendationDiscuss: "Maybe", recommendationReject: "Reject" }), "planv-bad-3");
    reject(JSON.stringify({ recommendationAccept: "Accept", recommendationDiscuss: "Maybe", recommendationReject: "Reject", commentsLabel: 7 }), "planv-bad-4");
    reject(JSON.stringify({ recommendationAccept: "Accept", recommendationDiscuss: "Maybe", recommendationReject: "Reject", commentsLabel: "x".repeat(41) }), "planv-bad-5");
    reject(JSON.stringify({ recommendationAccept: "Accept", recommendationDiscuss: "Maybe", recommendationReject: "Reject", commentsLabel: "Comments", extra: "no" }), "planv-bad-6");
  });
});

describe("round-scoped assignments", () => {
  it("requires pool membership and a same-event round", () => {
    const database = fixtureDatabase();
    insertRound(database);
    insertPlan(database, { id: "plan-round", reviewRoundId: "round-initial" });
    insertVersion(database, { id: "planv-round-1", planId: "plan-round" });
    activatePlan(database, "plan-round", "planv-round-1");
    expect(() => insertAssignment(database, assignment({ reviewRoundId: "round-initial", reviewPlanVersionId: "planv-round-1" })))
      .toThrow(/review assignment reviewer must belong to the round pool/);
    insertPoolEntry(database);
    insertAssignment(database, assignment({ reviewRoundId: "round-initial", reviewPlanVersionId: "planv-round-1" }));
    expect(() => database.prepare("UPDATE review_assignments SET review_round_id = NULL WHERE id = 'assignment-ops-1'").run())
      .toThrow(/review assignment identity is immutable/);
  });

  it("pins the round plan version, not the event default", () => {
    const database = fixtureDatabase();
    insertRound(database);
    insertPoolEntry(database);
    insertPlan(database, { id: "plan-default", reviewRoundId: null });
    insertVersion(database, { id: "planv-default-1", planId: "plan-default" });
    activatePlan(database, "plan-default", "planv-default-1");
    insertPlan(database, { id: "plan-round", reviewRoundId: "round-initial" });
    insertVersion(database, { id: "planv-round-1", planId: "plan-round" });
    activatePlan(database, "plan-round", "planv-round-1");
    expect(() => insertAssignment(database, assignment({ reviewRoundId: "round-initial", reviewPlanVersionId: "planv-default-1" })))
      .toThrow(/review assignment must pin the active plan version for its round/);
    insertAssignment(database, assignment({ reviewRoundId: "round-initial", reviewPlanVersionId: "planv-round-1" }));
    expect(() => insertAssignment(database, assignment({ id: "assignment-ops-2", proposalId: "prop-ops-2", reviewPlanVersionId: "planv-round-1" })))
      .toThrow(/review assignment must pin the active plan version for its round/);
    insertAssignment(database, assignment({ id: "assignment-ops-2", proposalId: "prop-ops-2", reviewPlanVersionId: "planv-default-1" }));
  });
});

describe("reviewer reminder outbox actor", () => {
  function enqueue(database, overrides = {}) {
    const message = {
      id: "msg-ops-1",
      eventId: "evt-devflow",
      intent: "reviewer_reminder",
      recipientEmail: "ops-reviewer@example.com",
      recipientName: "Ops Reviewer",
      templateKey: "reviewer.pending-reviews-reminder",
      templateRevision: 1,
      subject: "Reviews waiting",
      textBody: "You have pending reviews.",
      dedupeKey: "reviewer-reminder:ops-1",
      contentSha256: "a".repeat(64),
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: "2026-08-12T00:00:00Z",
      actorUserId: ORGANIZER,
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
      ...overrides,
    };
    return database.prepare(`
      INSERT INTO message_outbox (
        id, event_id, intent, recipient_email, recipient_name, template_key, template_revision,
        subject, text_body, dedupe_key, content_sha256, state, attempt_count,
        next_attempt_at, actor_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.eventId,
      message.intent,
      message.recipientEmail,
      message.recipientName,
      message.templateKey,
      message.templateRevision,
      message.subject,
      message.textBody,
      message.dedupeKey,
      message.contentSha256,
      message.state,
      message.attemptCount,
      message.nextAttemptAt,
      message.actorUserId,
      message.createdAt,
      message.updatedAt,
    );
  }

  it("requires an organizer actor for reviewer reminders", () => {
    const database = fixtureDatabase();
    expect(() => enqueue(database, { actorUserId: null }))
      .toThrow(/message actor must be a same-event organizer/);
    expect(() => enqueue(database, { actorUserId: "usr-ops-reviewer" }))
      .toThrow(/message actor must be a same-event organizer/);
    enqueue(database);
  });
});
