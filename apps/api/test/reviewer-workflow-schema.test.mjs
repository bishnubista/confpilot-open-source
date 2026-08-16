import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shareD1Database } from "./support/miniflare.mjs";
import { applyD1Sql } from "./support/migration-conformance.mjs";

// One workerd process for the file rather than one per test.
const openSharedD1 = shareD1Database();

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const migrations = migrationFiles.map((name) => readFileSync(new URL(name, migrationsUrl), "utf8"));
const seed = readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8");

const fixtureSql = `
  INSERT INTO users (id, email, display_name, created_at) VALUES
    ('usr-reviewer-d', 'reviewer-d@example.com', 'DevFlow Reviewer', '2026-08-11T00:00:00Z'),
    ('usr-reviewer-f', 'reviewer-f@example.com', 'Field Notes Reviewer', '2026-08-11T00:00:00Z');

  INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES
    ('mem-reviewer-d', 'evt-devflow', 'usr-reviewer-d', 'reviewer', '2026-08-11T00:00:00Z'),
    ('mem-reviewer-f', 'evt-fieldnotes', 'usr-reviewer-f', 'reviewer', '2026-08-11T00:00:00Z');

  INSERT INTO proposals (
    id, event_id, public_id, slug, title, abstract, track, format,
    duration_minutes, status, submitted_at, created_at, updated_at
  ) VALUES
    ('prop-review-d', 'evt-devflow', 'ABS-REVIEW-D', 'review-me', 'Review me',
      'A submitted review fixture.', 'AI Engineering', 'talk', 30, 'submitted',
      '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'),
    ('prop-review-f', 'evt-fieldnotes', 'ABS-REVIEW-F', 'review-field-notes', 'Review field notes',
      'A second-event review fixture.', 'Programming', 'talk', 30, 'submitted',
      '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'),
    ('prop-review-draft', 'evt-devflow', 'ABS-REVIEW-DRAFT', 'review-draft', 'Review draft',
      'A draft must not enter review.', 'AI Engineering', 'talk', 30, 'draft', NULL,
      '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z');

  INSERT INTO speakers (
    id, event_id, user_id, slug, name, title, company, bio,
    headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
  ) VALUES (
    'spk-reviewer-d', 'evt-devflow', 'usr-reviewer-d', 'devflow-reviewer',
    'DevFlow Reviewer', '', '', '', NULL, 'DR', 'incomplete', 'missing', 'private'
  );

  INSERT INTO proposals (
    id, event_id, public_id, slug, title, abstract, track, format,
    duration_minutes, status, submitted_at, created_at, updated_at
  ) VALUES (
    'prop-self-review', 'evt-devflow', 'ABS-SELF', 'self-review', 'Self review',
    'A presenter must not review their own proposal.', 'AI Engineering', 'talk', 30,
    'submitted', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z'
  );

  INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
  VALUES ('pp-self-review', 'evt-devflow', 'prop-self-review', 'spk-reviewer-d', 'primary');
`;

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) database.exec(migration);
  database.exec(seed);
  database.exec(fixtureSql);
  return database;
}

function assignment(overrides = {}) {
  return {
    id: "assignment-d-1",
    eventId: "evt-devflow",
    proposalId: "prop-review-d",
    reviewerUserId: "usr-reviewer-d",
    createdByUserId: "usr-devflow-organizer",
    round: 1,
    blind: 1,
    state: "assigned",
    dueAt: "2026-08-20T00:00:00Z",
    revokedAt: null,
    revokedByUserId: null,
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
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

function insertReview(database, overrides = {}) {
  const review = {
    id: "review-d-1",
    eventId: "evt-devflow",
    assignmentId: "assignment-d-1",
    originalityScore: 4,
    relevanceScore: 5,
    recommendation: "accept",
    comment: "Strong evidence and a clear attendee takeaway.",
    submittedAt: "2026-08-12T00:00:00Z",
    ...overrides,
  };
  return database.prepare(`
    INSERT INTO reviews (
      id, event_id, assignment_id, originality_score, relevance_score,
      recommendation, comment, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id,
    review.eventId,
    review.assignmentId,
    review.originalityScore,
    review.relevanceScore,
    review.recommendation,
    review.comment,
    review.submittedAt,
  );
}

describe("reviewer workflow migration", () => {
  let database;

  beforeEach(() => {
    database = fixtureDatabase();
  });

  afterEach(() => database.close());

  it("applies criteria scoring to an empty instance without seed assumptions", () => {
    const empty = new DatabaseSync(":memory:");
    empty.exec("PRAGMA foreign_keys = ON");
    try {
      for (const migration of migrations) empty.exec(migration);
      expect(migrationFiles.at(-1)).toBe("0025_release_review_guards.sql");
      expect(empty.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const table of [
        "review_plans", "review_plan_versions", "review_criteria", "review_criterion_scores",
        "review_corrections", "review_correction_criterion_scores",
        "review_correction_criterion_score_staging",
      ]) {
        expect(empty.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table).count).toBe(1);
      }
      expect(empty.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      empty.close();
    }
  });

  it("upgrades legacy assignments and reviews without reinterpreting their scores", () => {
    const predecessor = new DatabaseSync(":memory:");
    predecessor.exec("PRAGMA foreign_keys = ON");
    try {
      for (const migration of migrations.slice(0, -1)) predecessor.exec(migration);
      predecessor.exec(seed);
      predecessor.prepare(`INSERT INTO reviews (
        id, event_id, assignment_id, originality_score, relevance_score,
        recommendation, comment, submitted_at
      ) VALUES ('legacy-review', 'evt-devflow', 'assignment-d-supplemental-review', 4, 5,
        'accept', 'Legacy review remains unchanged.', '2027-02-20T00:00:00Z')`).run();

      predecessor.exec(migrations.at(-1));

      expect(predecessor.prepare(`SELECT originality_score AS originality,
        relevance_score AS relevance, review_plan_version_id AS versionId,
        weighted_score_milli AS weightedScore
        FROM reviews WHERE id = 'legacy-review'`).get()).toEqual({
        originality: 4,
        relevance: 5,
        versionId: null,
        weightedScore: null,
      });
      expect(predecessor.prepare(`SELECT review_plan_version_id AS versionId
        FROM review_assignments WHERE id = 'assignment-d-supplemental-review'`).get())
        .toEqual({ versionId: null });
      expect(predecessor.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      predecessor.close();
    }
  });

  it("applies the ordered migration with the required structure and queue index", () => {
    expect(migrationFiles).toContain("0003_reviewer_workflow.sql");
    expect(migrationFiles.indexOf("0003_reviewer_workflow.sql"))
      .toBeGreaterThan(migrationFiles.findIndex((name) => name.startsWith("0002_")));
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const assignmentColumns = database.prepare("PRAGMA table_info(review_assignments)")
      .all().map(({ name }) => name);
    expect(assignmentColumns).toEqual([
      "id", "event_id", "proposal_id", "reviewer_user_id", "created_by_user_id",
      "round", "blind", "state", "due_at", "revoked_at", "revoked_by_user_id",
      "created_at", "updated_at", "review_plan_version_id",
      "requires_response", "review_round_id",
    ]);
    const reviewColumns = database.prepare("PRAGMA table_info(reviews)")
      .all().map(({ name }) => name);
    expect(reviewColumns).toEqual([
      "id", "event_id", "assignment_id", "originality_score", "relevance_score",
      "recommendation", "comment", "submitted_at", "review_plan_version_id", "weighted_score_milli",
    ]);

    const objects = new Set(database.prepare(`
      SELECT type || ':' || name AS object
      FROM sqlite_master
      WHERE name LIKE 'review%' AND type IN ('index', 'trigger')
    `).all().map(({ object }) => object));
    for (const object of [
      "index:review_assignments_event_proposal_reviewer_round_unique",
      "index:review_assignments_event_reviewer_state_queue_index",
      "index:review_assignments_one_active_default_unique",
      "index:review_assignments_one_active_review_round_unique",
      "index:review_assignment_actions_assignment_sequence_unique",
      "index:reviewer_conflicts_assignment_unique",
      "index:reviewer_conflicts_event_proposal_reviewer_unique",
      "index:reviews_assignment_unique",
      "trigger:review_assignments_scope_insert",
      "trigger:review_assignments_identity_immutable_update",
      "trigger:review_assignments_state_update",
      "trigger:review_assignments_immutable_delete",
      "trigger:review_assignments_revoked_frozen_update",
      "trigger:reviews_valid_assignment_insert",
      "trigger:reviews_immutable_update",
      "trigger:reviews_immutable_delete",
    ]) expect(objects.has(object), object).toBe(true);

    insertAssignment(database);
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT assignment.id
      FROM review_assignments AS assignment
      LEFT JOIN reviews AS review ON review.assignment_id = assignment.id
      WHERE assignment.event_id = ? AND assignment.reviewer_user_id = ?
        AND assignment.state = 'assigned'
      ORDER BY review.id IS NOT NULL ASC, assignment.due_at IS NULL ASC,
        assignment.due_at ASC, assignment.created_at ASC, assignment.id ASC
    `).all("evt-devflow", "usr-reviewer-d");
    expect(plan.some(({ detail }) =>
      detail.includes("review_assignments_event_reviewer_state_queue_index"),
    )).toBe(true);
  });

  it("enforces event, role, lifecycle, self-review, and semantic uniqueness", () => {
    expect(() => insertAssignment(database, assignment({ id: "cross-event", eventId: "evt-fieldnotes" })))
      .toThrow(/proposal must be reviewable in the same event/);
    expect(() => insertAssignment(database, assignment({ id: "wrong-reviewer", reviewerUserId: "usr-devflow-organizer" })))
      .toThrow(/requires an event reviewer/);
    expect(() => insertAssignment(database, assignment({ id: "wrong-creator", createdByUserId: "usr-reviewer-d" })))
      .toThrow(/requires an event organizer/);
    expect(() => insertAssignment(database, assignment({ id: "draft", proposalId: "prop-review-draft" })))
      .toThrow(/proposal must be reviewable in the same event/);
    expect(() => insertAssignment(database, assignment({ id: "self", proposalId: "prop-self-review" })))
      .toThrow(/cannot be self-review/);
    expect(() => insertAssignment(database, assignment({ id: "incomplete-revocation", state: "revoked" })))
      .toThrow(/must start assigned/);
    expect(() => insertAssignment(database, assignment({
      id: "forged-revocation",
      state: "revoked",
      revokedAt: "2026-08-11T01:00:00Z",
      revokedByUserId: "usr-reviewer-d",
    }))).toThrow(/must start assigned/);

    insertAssignment(database);
    expect(() => insertAssignment(database, assignment({ id: "duplicate" }))).toThrow();
    expect(() => insertAssignment(database, assignment({ id: "active-round-2", round: 2 }))).toThrow();
    database.prepare(`
      UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      "2026-08-13T00:00:00Z",
      "usr-devflow-organizer",
      "2026-08-13T00:00:00Z",
      "assignment-d-1",
    );
    insertAssignment(database, assignment({ id: "round-2", round: 2 }));
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM review_assignments
      WHERE event_id = 'evt-devflow' AND proposal_id = 'prop-review-d'
    `).get().count).toBe(2);
    expect(database.prepare("SELECT status FROM proposals WHERE id = 'prop-review-d'").get().status)
      .toBe("submitted");
  });

  it("allows decided proposals only through an open named round and closes review with its window", () => {
    const addRound = ({ id, position, closesAt }) => {
      database.prepare(`INSERT INTO review_rounds (
        id, event_id, name, opens_at, closes_at, blind_default, position,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (?, 'evt-devflow', ?, '2020-01-01T00:00:00Z', ?, 1, ?,
        'usr-devflow-organizer', NULL, '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z')`)
        .run(id, id, closesAt, position);
      database.prepare(`INSERT INTO review_round_reviewers (
        id, event_id, review_round_id, reviewer_user_id, added_by_user_id, created_at
      ) VALUES (?, 'evt-devflow', ?, 'usr-reviewer-d', 'usr-devflow-organizer', '2026-08-11T00:00:00Z')`)
        .run(`pool-${id}`, id);
    };

    addRound({ id: "round-decision-open", position: 20, closesAt: "2090-01-01T00:00:00Z" });
    expect(() => insertAssignment(database, assignment({ id: "decided-unbounded", proposalId: "prop-d-1" })))
      .toThrow(/proposal must be reviewable/);
    insertAssignment(database, assignment({
      id: "decided-open", proposalId: "prop-d-1", reviewRoundId: "round-decision-open",
    }));
    expect(() => insertReview(database, { id: "review-decided-open", assignmentId: "decided-open" }))
      .not.toThrow();

    addRound({ id: "round-decision-closed", position: 21, closesAt: "2025-01-01T00:00:00Z" });
    expect(() => insertAssignment(database, assignment({
      id: "decided-closed", proposalId: "prop-d-1", round: 2,
      reviewRoundId: "round-decision-closed",
    }))).toThrow(/proposal must be reviewable/);

    addRound({ id: "round-review-closes", position: 22, closesAt: "2090-01-01T00:00:00Z" });
    insertAssignment(database, assignment({
      id: "decided-review-closes", proposalId: "prop-d-1", round: 3,
      reviewRoundId: "round-review-closes",
    }));
    database.prepare(`UPDATE review_rounds
      SET closes_at = '2026-08-11T12:00:00Z', updated_by_user_id = 'usr-devflow-organizer',
        updated_at = '2026-08-11T01:00:00Z'
      WHERE id = 'round-review-closes'`).run();
    expect(() => insertReview(database, {
      id: "review-decided-closed", assignmentId: "decided-review-closes",
    })).toThrow(/accepted active event assignment/);
  });

  it("enforces event-scoped immutable plan versions and active-weight validation", () => {
    database.prepare(`INSERT INTO review_plans
      (id, event_id, name, created_by_user_id, created_at)
      VALUES ('plan-d', 'evt-devflow', 'Rubric', 'usr-devflow-organizer', '2026-08-11T00:00:00Z')`).run();
    database.prepare(`INSERT INTO review_plan_versions
      (id, event_id, plan_id, version_number, name, created_by_user_id, created_at)
      VALUES ('plan-d-v1', 'evt-devflow', 'plan-d', 1, 'Rubric', 'usr-devflow-organizer', '2026-08-11T00:00:00Z')`).run();
    database.prepare(`INSERT INTO review_criteria
      (id, event_id, plan_version_id, criterion_key, label, description,
       weight_basis_points, minimum_score, maximum_score, sort_order)
      VALUES ('criterion-evidence', 'evt-devflow', 'plan-d-v1', 'evidence', 'Evidence', '', 4000, 1, 5, 0)`).run();
    expect(() => database.prepare(
      "UPDATE review_plans SET active_version_id = 'plan-d-v1', activated_by_user_id = 'usr-devflow-organizer' WHERE id = 'plan-d'",
    ).run()).toThrow(/totaling 10000 basis points/);
    database.prepare(`INSERT INTO review_criteria
      (id, event_id, plan_version_id, criterion_key, label, description,
       weight_basis_points, minimum_score, maximum_score, sort_order)
      VALUES ('criterion-impact', 'evt-devflow', 'plan-d-v1', 'impact', 'Impact', '', 6000, 1, 5, 1)`).run();
    expect(() => database.prepare(
      "UPDATE review_plans SET active_version_id = 'plan-d-v1', activated_by_user_id = 'usr-reviewer-d' WHERE id = 'plan-d'",
    ).run()).toThrow(/requires criteria totaling|event organizer/);
    expect(database.prepare(`SELECT active_version_id AS activeVersionId,
      activated_by_user_id AS activatedByUserId FROM review_plans WHERE id = 'plan-d'`).get())
      .toEqual({ activeVersionId: null, activatedByUserId: null });
    database.prepare(
      "UPDATE review_plans SET active_version_id = 'plan-d-v1', activated_by_user_id = 'usr-devflow-organizer' WHERE id = 'plan-d'",
    ).run();
    expect(() => database.prepare(
      "UPDATE review_plans SET active_version_id = 'plan-d-v1', activated_by_user_id = 'usr-devflow-organizer' WHERE id = 'plan-d'",
    ).run()).not.toThrow();
    expect(() => database.prepare(
      "UPDATE review_plans SET active_version_id = 'plan-d-v1', activated_by_user_id = 'usr-reviewer-d' WHERE id = 'plan-d'",
    ).run()).toThrow(/requires criteria totaling|event organizer/);
    expect(database.prepare(`SELECT active_version_id AS activeVersionId,
      activated_by_user_id AS activatedByUserId FROM review_plans WHERE id = 'plan-d'`).get())
      .toEqual({ activeVersionId: "plan-d-v1", activatedByUserId: "usr-devflow-organizer" });

    expect(() => database.prepare(`INSERT INTO review_criteria
      (id, event_id, plan_version_id, criterion_key, label, description,
       weight_basis_points, minimum_score, maximum_score, sort_order)
      VALUES ('late', 'evt-devflow', 'plan-d-v1', 'late', 'Late', '', 1, 1, 5, 2)`).run())
      .toThrow(/unused inactive/);
    expect(() => database.prepare("UPDATE review_criteria SET label = 'Changed' WHERE id = 'criterion-evidence'").run())
      .toThrow(/immutable/);
    expect(() => database.prepare("UPDATE review_plan_versions SET name = 'Changed' WHERE id = 'plan-d-v1'").run())
      .toThrow(/immutable/);
    expect(() => database.prepare(`INSERT INTO review_plan_versions
      (id, event_id, plan_id, version_number, name, created_by_user_id, created_at)
      VALUES ('cross-event', 'evt-fieldnotes', 'plan-d', 2, 'Wrong', 'usr-fieldnotes-organizer', '2026-08-11T00:00:00Z')`).run())
      .toThrow(/one event/);

    insertAssignment(database, assignment({ reviewPlanVersionId: "plan-d-v1" }));
    expect(database.prepare(
      "SELECT review_plan_version_id AS versionId FROM review_assignments WHERE id = 'assignment-d-1'",
    ).get()).toEqual({ versionId: "plan-d-v1" });
    expect(() => database.prepare(
      "UPDATE review_assignments SET review_plan_version_id = NULL WHERE id = 'assignment-d-1'",
    ).run()).toThrow(/identity is immutable/);
  });

  it("seals an unused plan version once a newer version exists", () => {
    database.prepare(`INSERT INTO review_plans
      (id, event_id, name, created_by_user_id, created_at)
      VALUES ('plan-sealed', 'evt-devflow', 'Rubric', 'usr-devflow-organizer', '2026-08-11T00:00:00Z')`).run();
    database.prepare(`INSERT INTO review_plan_versions
      (id, event_id, plan_id, version_number, name, created_by_user_id, created_at)
      VALUES ('plan-sealed-v1', 'evt-devflow', 'plan-sealed', 1, 'Rubric v1',
        'usr-devflow-organizer', '2026-08-11T00:00:00Z')`).run();
    database.prepare(`INSERT INTO review_plan_versions
      (id, event_id, plan_id, version_number, name, created_by_user_id, created_at)
      VALUES ('plan-sealed-v2', 'evt-devflow', 'plan-sealed', 2, 'Rubric v2',
        'usr-devflow-organizer', '2026-08-11T00:01:00Z')`).run();

    expect(() => database.prepare(`INSERT INTO review_criteria
      (id, event_id, plan_version_id, criterion_key, label, description,
       weight_basis_points, minimum_score, maximum_score, sort_order)
      VALUES ('criterion-stale', 'evt-devflow', 'plan-sealed-v1', 'stale', 'Stale', '', 10000, 1, 5, 0)`).run())
      .toThrow(/unused inactive/);
    database.prepare(`INSERT INTO review_criteria
      (id, event_id, plan_version_id, criterion_key, label, description,
       weight_basis_points, minimum_score, maximum_score, sort_order)
      VALUES ('criterion-current', 'evt-devflow', 'plan-sealed-v2', 'current', 'Current', '', 10000, 1, 5, 0)`).run();
  });

  it("keeps assignment identity immutable and uses terminal soft revocation", () => {
    insertAssignment(database);
    database.prepare(`
      UPDATE review_assignments SET due_at = ?, updated_at = ? WHERE id = ?
    `).run("2026-08-25T00:00:00Z", "2026-08-12T00:00:00Z", "assignment-d-1");
    expect(database.prepare("SELECT due_at AS dueAt FROM review_assignments WHERE id = ?")
      .get("assignment-d-1").dueAt).toBe("2026-08-25T00:00:00Z");

    expect(() => database.prepare("UPDATE review_assignments SET blind = 0 WHERE id = ?")
      .run("assignment-d-1")).toThrow(/identity is immutable/);
    expect(() => database.prepare("DELETE FROM review_assignments WHERE id = ?")
      .run("assignment-d-1")).toThrow(/soft revocation/);

    expect(() => database.prepare(`
      UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      "2026-08-13T00:00:00Z",
      "usr-reviewer-d",
      "2026-08-13T00:00:00Z",
      "assignment-d-1",
    )).toThrow(/cannot change state/);
    database.prepare(`
      UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      "2026-08-13T00:00:00Z",
      "usr-devflow-organizer",
      "2026-08-13T00:00:00Z",
      "assignment-d-1",
    );
    expect(() => database.prepare("UPDATE review_assignments SET state = 'assigned' WHERE id = ?")
      .run("assignment-d-1")).toThrow(/cannot change state/);
    expect(() => database.prepare("UPDATE review_assignments SET revoked_at = ? WHERE id = ?")
      .run("2026-08-14T00:00:00Z", "assignment-d-1")).toThrow(/cannot change state/);
    expect(() => database.prepare("UPDATE review_assignments SET due_at = ? WHERE id = ?")
      .run("2026-08-30T00:00:00Z", "assignment-d-1")).toThrow(/revoked review assignment cannot change/);
    expect(() => database.prepare("UPDATE review_assignments SET updated_at = ? WHERE id = ?")
      .run("2026-08-30T00:00:00Z", "assignment-d-1")).toThrow(/revoked review assignment cannot change/);
  });

  it("accepts one constrained immutable review and prevents post-review revocation", () => {
    insertAssignment(database);

    expect(() => insertReview(database, { id: "wrong-event", eventId: "evt-fieldnotes" }))
      .toThrow(/active event assignment/);
    expect(() => insertReview(database, { id: "low-score", originalityScore: 0 })).toThrow();
    expect(() => insertReview(database, { id: "fractional-score", relevanceScore: 4.5 })).toThrow();
    expect(() => insertReview(database, { id: "bad-recommendation", recommendation: "maybe" })).toThrow();
    expect(() => insertReview(database, { id: "blank-comment", comment: "   " })).toThrow();
    expect(() => insertReview(database, { id: "long-comment", comment: "x".repeat(4001) })).toThrow();

    insertReview(database);
    expect(database.prepare(`
      SELECT originality_score AS originality, relevance_score AS relevance,
        recommendation, comment
      FROM reviews WHERE assignment_id = ?
    `).get("assignment-d-1")).toEqual({
      originality: 4,
      relevance: 5,
      recommendation: "accept",
      comment: "Strong evidence and a clear attendee takeaway.",
    });
    expect(() => insertReview(database, { id: "duplicate-review" })).toThrow();
    expect(() => database.prepare("UPDATE reviews SET relevance_score = 3 WHERE id = ?")
      .run("review-d-1")).toThrow(/immutable/);
    expect(() => database.prepare("DELETE FROM reviews WHERE id = ?")
      .run("review-d-1")).toThrow(/immutable/);
    expect(() => database.prepare(`
      UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?
      WHERE id = ?
    `).run(
      "2026-08-13T00:00:00Z",
      "usr-devflow-organizer",
      "assignment-d-1",
    )).toThrow(/completed/);
  });

  it("appends sequential reviewer-owned corrections while keeping the base review immutable", () => {
    insertAssignment(database);
    insertReview(database);
    const insertCorrection = (overrides = {}) => {
      const correction = {
        id: "correction-d-2",
        eventId: "evt-devflow",
        reviewId: "review-d-1",
        revisionNumber: 2,
        correctedByUserId: "usr-reviewer-d",
        originalityScore: 3,
        relevanceScore: 5,
        recommendation: "discuss",
        comment: "Corrected after checking the rubric.",
        correctedAt: "2026-08-13T00:00:00Z",
        ...overrides,
      };
      return database.prepare(`INSERT INTO review_corrections (
        id, event_id, review_id, revision_number, corrected_by_user_id,
        originality_score, relevance_score, recommendation, comment,
        review_plan_version_id, weighted_score_milli, corrected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run(correction.id, correction.eventId, correction.reviewId, correction.revisionNumber,
          correction.correctedByUserId, correction.originalityScore, correction.relevanceScore,
          correction.recommendation, correction.comment, correction.correctedAt);
    };

    expect(() => insertCorrection({ id: "wrong-actor", correctedByUserId: "usr-devflow-organizer" }))
      .toThrow(/assigned reviewer/);
    expect(() => insertCorrection({ id: "skipped", revisionNumber: 3 }))
      .toThrow(/next sequence/);
    insertCorrection();
    expect(database.prepare(`SELECT id, base_review_id AS baseReviewId,
      revision_number AS revisionNumber, originality_score AS originality,
      recommendation FROM current_reviews WHERE assignment_id = 'assignment-d-1'`).get()).toEqual({
      id: "correction-d-2",
      baseReviewId: "review-d-1",
      revisionNumber: 2,
      originality: 3,
      recommendation: "discuss",
    });
    expect(database.prepare("SELECT originality_score AS originality FROM reviews WHERE id = 'review-d-1'").get())
      .toEqual({ originality: 4 });
    expect(() => database.prepare("UPDATE review_corrections SET originality_score = 2 WHERE id = 'correction-d-2'").run())
      .toThrow(/immutable/);
    expect(() => database.prepare("DELETE FROM review_corrections WHERE id = 'correction-d-2'").run())
      .toThrow(/immutable/);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects reviews for revoked assignments", () => {
    insertAssignment(database);
    database.prepare(`
      UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?
      WHERE id = ?
    `).run("2026-08-13T00:00:00Z", "usr-devflow-organizer", "assignment-d-1");
    expect(() => insertReview(database)).toThrow(/active event assignment/);
  });

  it("rechecks current reviewer membership and proposal state at submission", () => {
    insertAssignment(database);
    database.prepare("UPDATE event_memberships SET role = 'speaker' WHERE id = 'mem-reviewer-d'").run();
    expect(() => insertReview(database)).toThrow(/active event assignment/);

    database.prepare("UPDATE event_memberships SET role = 'reviewer' WHERE id = 'mem-reviewer-d'").run();
    database.prepare("UPDATE proposals SET status = 'decided' WHERE id = 'prop-review-d'").run();
    expect(() => insertReview(database)).toThrow(/active event assignment/);
  });

  it("rechecks self-review after assignment and before scorecard submission", () => {
    insertAssignment(database);
    database.prepare(`
      INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('pp-late-self-review', 'evt-devflow', 'prop-review-d', 'spk-reviewer-d', 'co_presenter')
    `).run();
    expect(() => insertReview(database)).toThrow(/self-review/);
  });

  it("enforces invitation, recusal, and declared-conflict lifecycle invariants in SQLite", () => {
    insertAssignment(database, assignment({ requiresResponse: 1 }));
    expect(() => insertReview(database)).toThrow(/accepted active event assignment/);

    expect(() => database.prepare(`INSERT INTO review_assignment_actions (
      id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
    ) VALUES ('wrong-reviewer-action', 'evt-devflow', 'assignment-d-1', 'usr-reviewer-f',
      1, 'accepted', NULL, '2026-08-12T00:00:00Z')`).run()).toThrow(/active event reviewer/);

    database.prepare(`INSERT INTO review_assignment_actions (
      id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
    ) VALUES ('accepted-action', 'evt-devflow', 'assignment-d-1', 'usr-reviewer-d',
      1, 'accepted', NULL, '2026-08-12T00:00:00Z')`).run();
    expect(() => database.prepare(
      "UPDATE review_assignment_actions SET action = 'declined' WHERE id = 'accepted-action'",
    ).run()).toThrow(/immutable/);
    database.prepare(`INSERT INTO review_assignment_actions (
      id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
    ) VALUES ('recused-action', 'evt-devflow', 'assignment-d-1', 'usr-reviewer-d',
      2, 'recused', 'Shared reporting line.', '2026-08-12T00:01:00Z')`).run();

    expect(() => database.prepare(`INSERT INTO reviewer_conflicts (
      id, event_id, proposal_id, reviewer_user_id, assignment_id, category, note, created_at
    ) VALUES ('wrong-scope-conflict', 'evt-fieldnotes', 'prop-review-d', 'usr-reviewer-d',
      'assignment-d-1', 'personal', 'Wrong event.', '2026-08-12T00:00:00Z')`).run())
      .toThrow(/active assignment/);
    database.prepare(`INSERT INTO reviewer_conflicts (
      id, event_id, proposal_id, reviewer_user_id, assignment_id, category, note, created_at
    ) VALUES ('declared-conflict', 'evt-devflow', 'prop-review-d', 'usr-reviewer-d',
      'assignment-d-1', 'institutional', 'Shared reporting line.', '2026-08-12T00:00:00Z')`).run();
    expect(() => insertReview(database)).toThrow(/without conflict/);
    expect(() => database.prepare("DELETE FROM reviewer_conflicts WHERE id = 'declared-conflict'").run())
      .toThrow(/immutable/);
    database.prepare(`UPDATE review_assignments SET state = 'revoked', revoked_at = ?,
      revoked_by_user_id = ?, updated_at = ? WHERE id = 'assignment-d-1'`).run(
      "2026-08-12T00:02:00Z", "usr-devflow-organizer", "2026-08-12T00:02:00Z",
    );
    expect(() => insertAssignment(database, assignment({
      id: "assignment-d-2", round: 2, requiresResponse: 1,
    }))).toThrow(/declared reviewer conflict/);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("reviewer workflow on the D1 runtime", () => {
  let database;

  /**
   * A migrated database per test, because these two tests genuinely conflict:
   * the first proves that a second active assignment for a (proposal, reviewer)
   * pair is refused, and the second needs its own round-1 assignment for that
   * same pair. Sharing would have the schema reject the second test's fixture
   * for exactly the reason the first test asserts.
   *
   * So the process is shared instead, and the migrations go in as one batch per
   * file rather than 485 separate round-trips into workerd. This hook used to
   * spend 3.3-4.3s of a 10s budget and timed out on CI the moment a neighbouring
   * suite started competing for the machine; it now spends ~1.2s, which is why
   * it stays on the default budget rather than being given a raised one.
   */
  beforeEach(async () => {
    database = await openSharedD1();
    for (const migration of migrations) await applyD1Sql(database, migration);
    await applyD1Sql(database, seed);
    await applyD1Sql(database, fixtureSql);
  });

  it("preserves assignment and review invariants in Miniflare D1", async () => {
    const input = assignment();
    await database.prepare(`
      INSERT INTO review_assignments (
        id, event_id, proposal_id, reviewer_user_id, created_by_user_id,
        round, blind, state, due_at, revoked_at, revoked_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id, input.eventId, input.proposalId, input.reviewerUserId,
      input.createdByUserId, input.round, input.blind, input.state, input.dueAt,
      input.revokedAt, input.revokedByUserId, input.createdAt, input.updatedAt,
    ).run();

    expect(await database.prepare("SELECT status FROM proposals WHERE id = ?")
      .bind(input.proposalId).first("status")).toBe("submitted");
    await expect(database.prepare(`
      INSERT INTO review_assignments (
        id, event_id, proposal_id, reviewer_user_id, created_by_user_id,
        round, blind, state, due_at, created_at, updated_at
      ) VALUES ('runtime-active-round-2', ?, ?, ?, ?, 2, 1, 'assigned', NULL, ?, ?)
    `).bind(
      input.eventId,
      input.proposalId,
      input.reviewerUserId,
      input.createdByUserId,
      input.createdAt,
      input.updatedAt,
    ).run()).rejects.toThrow();
    await expect(database.prepare(`
      INSERT INTO reviews (
        id, event_id, assignment_id, originality_score, relevance_score,
        recommendation, comment, submitted_at
      ) VALUES ('runtime-wrong-event', 'evt-fieldnotes', ?, 4, 4, 'accept', 'No.', ?)
    `).bind(input.id, "2026-08-12T00:00:00Z").run()).rejects.toThrow();

    await database.prepare(`
      INSERT INTO reviews (
        id, event_id, assignment_id, originality_score, relevance_score,
        recommendation, comment, submitted_at
      ) VALUES ('runtime-review', ?, ?, 4, 5, 'accept', 'D1 preserves the review.', ?)
    `).bind(input.eventId, input.id, "2026-08-12T00:00:00Z").run();

    expect(await database.prepare("SELECT COUNT(*) AS count FROM reviews WHERE assignment_id = ?")
      .bind(input.id).first("count")).toBe(1);
    await expect(database.prepare("UPDATE reviews SET originality_score = 3 WHERE id = 'runtime-review'")
      .run()).rejects.toThrow();
    await expect(database.prepare(`
      UPDATE review_assignments
      SET state = 'revoked', revoked_at = ?, revoked_by_user_id = ?
      WHERE id = ?
    `).bind("2026-08-13T00:00:00Z", "usr-devflow-organizer", input.id).run()).rejects.toThrow();
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("atomically persists a configured scorecard and rolls back invalid criterion scores in D1", async () => {
    const now = "2026-08-12T00:00:00Z";
    await database.prepare(`INSERT INTO review_plans
      (id, event_id, name, created_by_user_id, created_at)
      VALUES ('runtime-plan', 'evt-devflow', 'Runtime rubric', 'usr-devflow-organizer', ?)`).bind(now).run();
    await database.prepare(`INSERT INTO review_plan_versions
      (id, event_id, plan_id, version_number, name, created_by_user_id, created_at)
      VALUES ('runtime-plan-v1', 'evt-devflow', 'runtime-plan', 1, 'Runtime rubric',
        'usr-devflow-organizer', ?)`).bind(now).run();
    await database.batch([
      database.prepare(`INSERT INTO review_criteria
        (id, event_id, plan_version_id, criterion_key, label, description,
         weight_basis_points, minimum_score, maximum_score, sort_order)
        VALUES ('runtime-five', 'evt-devflow', 'runtime-plan-v1', 'five', 'Five point', '', 5000, 1, 5, 0)`),
      database.prepare(`INSERT INTO review_criteria
        (id, event_id, plan_version_id, criterion_key, label, description,
         weight_basis_points, minimum_score, maximum_score, sort_order)
        VALUES ('runtime-ten', 'evt-devflow', 'runtime-plan-v1', 'ten', 'Ten point', '', 5000, 1, 10, 1)`),
      database.prepare(`UPDATE review_plans
        SET active_version_id = 'runtime-plan-v1', activated_by_user_id = 'usr-devflow-organizer'
        WHERE id = 'runtime-plan' AND event_id = 'evt-devflow'`),
    ]);
    await database.prepare(`INSERT INTO review_assignments (
      id, event_id, proposal_id, reviewer_user_id, created_by_user_id,
      round, blind, state, due_at, created_at, updated_at, review_plan_version_id
    ) VALUES ('runtime-plan-assignment', 'evt-devflow', 'prop-review-d', 'usr-reviewer-d',
      'usr-devflow-organizer', 1, 1, 'assigned', NULL, ?, ?, 'runtime-plan-v1')`).bind(now, now).run();

    await expect(database.batch([
      database.prepare(`INSERT INTO reviews (
        id, event_id, assignment_id, originality_score, relevance_score,
        recommendation, comment, submitted_at, review_plan_version_id, weighted_score_milli
      ) VALUES ('runtime-invalid-review', 'evt-devflow', 'runtime-plan-assignment', 5, 5,
        'accept', 'Must roll back.', ?, 'runtime-plan-v1', 5000)`).bind(now),
      database.prepare(`INSERT INTO review_criterion_scores (review_id, event_id, criterion_id, score)
        VALUES ('runtime-invalid-review', 'evt-fieldnotes', 'runtime-five', 5)`),
    ])).rejects.toThrow();
    expect(await database.prepare("SELECT COUNT(*) AS count FROM reviews WHERE id = 'runtime-invalid-review'")
      .first("count")).toBe(0);

    await database.batch([
      database.prepare(`INSERT INTO reviews (
        id, event_id, assignment_id, originality_score, relevance_score,
        recommendation, comment, submitted_at, review_plan_version_id, weighted_score_milli
      ) VALUES ('runtime-plan-review', 'evt-devflow', 'runtime-plan-assignment', 5, 5,
        'accept', 'D1 keeps the configured scorecard atomic.', ?, 'runtime-plan-v1', 5000)`).bind(now),
      database.prepare(`INSERT INTO review_criterion_scores (review_id, event_id, criterion_id, score)
        VALUES ('runtime-plan-review', 'evt-devflow', 'runtime-five', 5)`),
      database.prepare(`INSERT INTO review_criterion_scores (review_id, event_id, criterion_id, score)
        VALUES ('runtime-plan-review', 'evt-devflow', 'runtime-ten', 10)`),
    ]);

    expect(await database.prepare(`SELECT weighted_score_milli AS weightedScore,
      review_plan_version_id AS versionId FROM reviews WHERE id = 'runtime-plan-review'`).first())
      .toEqual({ weightedScore: 5000, versionId: "runtime-plan-v1" });
    expect(await database.prepare(
      "SELECT COUNT(*) AS count FROM review_criterion_scores WHERE review_id = 'runtime-plan-review'",
    ).first("count")).toBe(2);
    await expect(database.prepare(`INSERT INTO review_corrections (
      id, event_id, review_id, revision_number, corrected_by_user_id,
      originality_score, relevance_score, recommendation, comment,
      review_plan_version_id, weighted_score_milli, corrected_at, criterion_scores_staged
    ) VALUES ('runtime-incomplete-correction', 'evt-devflow', 'runtime-plan-review', 2,
      'usr-reviewer-d', 5, 5, 'accept', 'Missing criterion scores.',
      'runtime-plan-v1', 5000, '2026-08-13T00:00:00Z', 1)`).run())
      .rejects.toThrow(/criterion score/);
    await expect(database.batch([
      database.prepare(`INSERT INTO review_correction_criterion_score_staging
        (correction_id, event_id, review_id, criterion_id, score)
        VALUES ('runtime-rolled-back-correction', 'evt-devflow', 'runtime-plan-review', 'runtime-five', 5)`),
      database.prepare(`INSERT INTO review_corrections (
        id, event_id, review_id, revision_number, corrected_by_user_id,
        originality_score, relevance_score, recommendation, comment,
        review_plan_version_id, weighted_score_milli, corrected_at, criterion_scores_staged
      ) VALUES ('runtime-rolled-back-correction', 'evt-devflow', 'runtime-plan-review', 2,
        'usr-reviewer-d', 5, 5, 'accept', 'Incomplete staged scores.',
        'runtime-plan-v1', 5000, '2026-08-13T00:00:00Z', 1)`),
    ])).rejects.toThrow(/criterion score/);
    expect(await database.prepare(`SELECT COUNT(*) AS count
      FROM review_correction_criterion_score_staging
      WHERE correction_id = 'runtime-rolled-back-correction'`).first("count")).toBe(0);
    await database.batch([
      database.prepare(`INSERT INTO review_correction_criterion_score_staging
        (correction_id, event_id, review_id, criterion_id, score)
        VALUES ('runtime-complete-correction', 'evt-devflow', 'runtime-plan-review', 'runtime-five', 5)`),
      database.prepare(`INSERT INTO review_correction_criterion_score_staging
        (correction_id, event_id, review_id, criterion_id, score)
        VALUES ('runtime-complete-correction', 'evt-devflow', 'runtime-plan-review', 'runtime-ten', 10)`),
      database.prepare(`INSERT INTO review_corrections (
        id, event_id, review_id, revision_number, corrected_by_user_id,
        originality_score, relevance_score, recommendation, comment,
        review_plan_version_id, weighted_score_milli, corrected_at, criterion_scores_staged
      ) VALUES ('runtime-complete-correction', 'evt-devflow', 'runtime-plan-review', 2,
        'usr-reviewer-d', 5, 5, 'accept', 'Complete criterion scores.',
        'runtime-plan-v1', 5000, '2026-08-13T00:00:00Z', 1)`),
    ]);
    expect(await database.prepare(`SELECT COUNT(*) AS count
      FROM review_correction_criterion_scores
      WHERE correction_id = 'runtime-complete-correction'`).first("count")).toBe(2);
    expect(await database.prepare(`SELECT COUNT(*) AS count
      FROM review_correction_criterion_score_staging
      WHERE correction_id = 'runtime-complete-correction'`).first("count")).toBe(0);
    await expect(database.prepare(`INSERT INTO review_corrections (
      id, event_id, review_id, revision_number, corrected_by_user_id,
      originality_score, relevance_score, recommendation, comment,
      review_plan_version_id, weighted_score_milli, corrected_at
    ) VALUES ('runtime-old-worker-correction', 'evt-devflow', 'runtime-plan-review', 3,
      'usr-reviewer-d', 5, 5, 'accept', 'Old writer compatibility.',
      'runtime-plan-v1', 5000, '2026-08-13T00:01:00Z')`).run())
      .rejects.toThrow(/criterion score/);
    expect(await database.prepare(`SELECT COUNT(*) AS count
      FROM review_corrections WHERE id = 'runtime-old-worker-correction'`).first("count")).toBe(0);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

});
