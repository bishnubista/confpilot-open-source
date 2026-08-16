import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";

class SqliteD1Statement {
  constructor(statement) {
    this.statement = statement;
    this.params = [];
  }
  bind(...params) {
    const bound = new SqliteD1Statement(this.statement);
    bound.params = params;
    return bound;
  }
  async all() {
    return { results: this.statement.all(...this.params), success: true, meta: {} };
  }
  async run() {
    const result = this.statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first(column) {
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
}

class SqliteD1Database {
  constructor(database) { this.database = database; }
  prepare(query) { return new SqliteD1Statement(this.database.prepare(query)); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsUrl = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrationsUrl).filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
  return database;
}

const sameOriginHeaders = {
  Origin: "http://localhost",
  "Content-Type": "application/json",
  "X-ConfPilot-Request": "1",
  "Sec-Fetch-Site": "same-origin",
};
const allowRateLimiter = { limit: async () => ({ success: true }) };

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

function addReviewer(database, { suffix, eventId = "evt-devflow" }) {
  const userId = `usr-review-${suffix}`;
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, `${suffix}@review.example`, `Reviewer ${suffix}`, "2026-08-11T00:00:00Z");
  database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'reviewer', ?)")
    .run(`mem-review-${suffix}`, eventId, userId, "2026-08-11T00:00:00Z");
  return { userId, cookie: addSession(database, { userId, token: `review-${suffix}` }) };
}

function addSubmittedProposal(database, { suffix, eventId = "evt-devflow", title = `Proposal ${suffix}` }) {
  const ownerId = `usr-owner-${suffix}`;
  const speakerId = `spk-owner-${suffix}`;
  const proposalId = `prop-review-${suffix}`;
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run(ownerId, `${suffix}@speaker.example`, `Speaker ${suffix}`, "2026-08-11T00:00:00Z");
  database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'speaker', ?)")
    .run(`mem-owner-${suffix}`, eventId, ownerId, "2026-08-11T00:00:00Z");
  database.prepare(`INSERT INTO speakers (
    id, event_id, user_id, slug, name, title, company, bio,
    headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
  ) VALUES (?, ?, ?, ?, ?, '', '', '', NULL, 'SF', 'incomplete', 'missing', 'private')`).run(
    speakerId,
    eventId,
    ownerId,
    `speaker-${suffix}`,
    `Speaker ${suffix}`,
  );
  database.prepare(`INSERT INTO proposals (
    id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
    status, submitted_at, created_at, updated_at, owner_user_id, client_draft_key
  ) VALUES (?, ?, ?, ?, ?, ?, 'AI Engineering', 'talk', 30, 'submitted', ?, ?, ?, ?, ?)`).run(
    proposalId,
    eventId,
    `ABS-${suffix.toUpperCase()}`,
    `proposal-${suffix}`,
    title,
    `Abstract for ${suffix}.`,
    "2026-08-11T00:00:00Z",
    "2026-08-11T00:00:00Z",
    "2026-08-11T00:00:00Z",
    ownerId,
    `draft-${suffix}`,
  );
  database.prepare("INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role) VALUES (?, ?, ?, ?, 'primary')")
    .run(`presenter-${suffix}`, eventId, proposalId, speakerId);
  if (eventId === "evt-devflow") {
    for (const [fieldKey, value] of [
      ["title", title],
      ["abstract", `Abstract for ${suffix}.`],
      ["track", "AI Engineering"],
      ["format", "talk"],
      ["speaker_bio", `PRIVATE BIO ${suffix}`],
      ["key_takeaway", `Public takeaway ${suffix}`],
    ]) {
      database.prepare(`INSERT INTO proposal_answers (
        id, event_id, proposal_id, field_key, value, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        `answer-${suffix}-${fieldKey}`,
        eventId,
        proposalId,
        fieldKey,
        value,
        "2026-08-11T00:00:00Z",
        "2026-08-11T00:00:00Z",
      );
    }
  }
  return {
    proposalId,
    ownerId,
    ownerCookie: addSession(database, { userId: ownerId, token: `owner-${suffix}` }),
    title,
  };
}

function request(path, { method = "GET", cookie, body, headers = {} } = {}, env) {
  return createApp().request(path, {
    method,
    headers: {
      ...(method === "GET" ? {} : sameOriginHeaders),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

async function acceptAssignment(assignmentId, reviewerCookie, env) {
  const response = await request(
    `/api/events/devflow-conf-2027/review/assignments/${assignmentId}/invitation`,
    { method: "POST", cookie: reviewerCookie, body: { action: "accept" } },
    env,
  );
  expect([200, 201]).toContain(response.status);
  return response;
}

describe("reviewer assignment and scorecard API", () => {
  let database;
  let env;
  let organizerCookie;
  let reviewerA;
  let reviewerB;
  let reviewerOtherEvent;
  let proposalA;
  let proposalB;
  let otherEventProposal;

  beforeEach(() => {
    database = fixtureDatabase();
    env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
    };
    organizerCookie = addSession(database, { userId: "usr-devflow-organizer", token: "review-organizer" });
    reviewerA = addReviewer(database, { suffix: "a" });
    reviewerB = addReviewer(database, { suffix: "b" });
    reviewerOtherEvent = addReviewer(database, { suffix: "other", eventId: "evt-fieldnotes" });
    proposalA = addSubmittedProposal(database, { suffix: "a", title: "Evidence-First Review Systems" });
    proposalB = addSubmittedProposal(database, { suffix: "b", title: "Reliable Conference Workflows" });
    otherEventProposal = addSubmittedProposal(database, { suffix: "other", eventId: "evt-fieldnotes" });
  });

  afterEach(() => database.close());

  it("requires the correct event role and mutation evidence", async () => {
    const path = "/api/events/devflow-conf-2027/cfp/reviewers";
    expect((await request(path, {}, env)).status).toBe(401);
    expect((await request(path, { cookie: reviewerA.cookie }, env)).status).toBe(403);
    const unsafe = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId }, headers: { Origin: "https://attacker.example" } },
      env,
    );
    expect(unsafe.status).toBe(403);
    expect((await unsafe.json()).error.code).toBe("UNSAFE_REQUEST_REJECTED");
  });

  it("lists event reviewers and atomically locks a proposal with one idempotent blind assignment", async () => {
    const list = await request("/api/events/devflow-conf-2027/cfp/reviewers", { cookie: organizerCookie }, env);
    expect(list.status).toBe(200);
    expect((await list.json()).data.reviewers.map(({ userId }) => userId).sort()).toEqual([
      "usr-devflow-reviewer",
      reviewerA.userId,
      reviewerB.userId,
    ].sort());

    const path = `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`;
    const body = { reviewerUserId: reviewerA.userId, dueAt: "2027-04-20T17:00:00Z" };
    const created = await request(path, { method: "POST", cookie: organizerCookie, body }, env);
    const repeated = await request(path, { method: "POST", cookie: organizerCookie, body }, env);
    const changed = await request(path, {
      method: "POST", cookie: organizerCookie, body: { ...body, blind: false },
    }, env);
    expect(created.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(changed.status).toBe(409);
    expect((await created.json()).data).toMatchObject({
      blind: true,
      status: "pending",
      proposal: { id: proposalA.proposalId },
      reviewer: { userId: reviewerA.userId },
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_assignments WHERE proposal_id = ?",
    ).get(proposalA.proposalId).count).toBe(1);
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposalA.proposalId).status).toBe("in_review");
    const locked = await request(
      `/api/events/devflow-conf-2027/proposals/${proposalA.proposalId}`,
      { method: "PUT", cookie: proposalA.ownerCookie, body: { values: { title: "Changed after assignment" } } },
      env,
    );
    expect(locked.status).toBe(409);
    expect((await locked.json()).error.code).toBe("PROPOSAL_LOCKED");
    expect(database.prepare("SELECT title FROM proposals WHERE id = ?").get(proposalA.proposalId).title).toBe(proposalA.title);
  });

  it("fails closed for wrong-event reviewers, unreviewable proposals, and self-review", async () => {
    const path = `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`;
    const wrongReviewer = await request(path, {
      method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerOtherEvent.userId },
    }, env);
    expect(wrongReviewer.status).toBe(404);

    const wrongEventProposal = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${otherEventProposal.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    );
    expect(wrongEventProposal.status).toBe(404);

    database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposalA.proposalId);
    const decided = await request(path, {
      method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId },
    }, env);
    expect(decided.status).toBe(409);

    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES ('spk-reviewer-a', 'evt-devflow', ?, 'reviewer-a', 'Reviewer A', '', '', '',
      NULL, 'RA', 'incomplete', 'missing', 'private')`).run(reviewerA.userId);
    database.prepare(`INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('presenter-reviewer-a', 'evt-devflow', ?, 'spk-reviewer-a', 'co_presenter')`).run(proposalB.proposalId);
    const self = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    );
    expect(self.status).toBe(409);
    expect((await self.json()).error.code).toBe("SELF_REVIEW_NOT_ALLOWED");
  });

  it("isolates queues and returns a structurally blind session-only dossier", async () => {
    const assignmentA = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const assignmentB = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerB.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);

    const queue = await request("/api/events/devflow-conf-2027/review/assignments", { cookie: reviewerA.cookie }, env);
    const queueBody = await queue.json();
    expect(queue.status).toBe(200);
    expect(queueBody.data.assignments.map(({ id }) => id)).toEqual([assignmentA.id]);
    expect(JSON.stringify(queueBody)).not.toContain(proposalB.title);

    const detail = await request(`/api/events/devflow-conf-2027/review/assignments/${assignmentA.id}`, { cookie: reviewerA.cookie }, env);
    const detailBody = await detail.json();
    expect(detail.status).toBe(200);
    expect(detailBody.data.proposal.sessionAnswers.key_takeaway).toBe("Public takeaway a");
    expect(detailBody.data.proposal.sessionAnswers).not.toHaveProperty("speaker_bio");
    expect(JSON.stringify(detailBody)).not.toContain("PRIVATE BIO a");
    expect(JSON.stringify(detailBody)).not.toContain("Speaker a");
    expect(JSON.stringify(detailBody)).not.toContain("a@speaker.example");

    const guessed = await request(`/api/events/devflow-conf-2027/review/assignments/${assignmentB.id}`, { cookie: reviewerA.cookie }, env);
    const missing = await request("/api/events/devflow-conf-2027/review/assignments/not-real", { cookie: reviewerA.cookie }, env);
    expect(guessed.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await guessed.json()).error.code).toBe((await missing.json()).error.code);
  });

  it("appends an immutable scorecard correction and exposes the latest revision to organizers", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    await acceptAssignment(assignment.id, reviewerA.cookie, env);
    const path = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`;
    const body = { originality: 4, relevance: 5, recommendation: "accept", comment: "  Strong evidence.  " };
    const created = await request(path, { method: "POST", cookie: reviewerA.cookie, body }, env);
    const repeated = await request(path, {
      method: "POST", cookie: reviewerA.cookie, body: { ...body, comment: "Strong evidence." },
    }, env);
    expect(created.status).toBe(201);
    expect(repeated.status).toBe(200);
    const legacyChanged = await request(path, {
      method: "POST", cookie: reviewerA.cookie, body: { ...body, originality: 3 },
    }, env);
    expect(legacyChanged.status).toBe(409);
    expect((await legacyChanged.json()).error.code).toBe("REVIEW_ALREADY_SUBMITTED");
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_corrections").get().count).toBe(0);
    const changed = await request(path, {
      method: "POST", cookie: reviewerA.cookie, body: { ...body, expectedRevision: 1, originality: 3 },
    }, env);
    expect(changed.status).toBe(201);
    expect((await created.json()).data).toEqual((await repeated.json()).data);
    const correction = (await changed.json()).data;
    expect(correction).toMatchObject({ revisionNumber: 2, originality: 3, correctedAt: expect.any(String) });
    const correctionRetry = await request(path, {
      method: "POST", cookie: reviewerA.cookie, body: { ...body, expectedRevision: 1, originality: 3 },
    }, env);
    expect(correctionRetry.status).toBe(200);
    expect((await correctionRetry.json()).data.id).toBe(correction.id);
    const staleCorrection = await request(path, {
      method: "POST", cookie: reviewerA.cookie,
      body: { ...body, expectedRevision: 1, originality: 2, comment: "Stale correction." },
    }, env);
    expect(staleCorrection.status).toBe(409);
    expect((await staleCorrection.json()).error.code).toBe("REVIEW_CORRECTION_CONFLICT");
    expect((await request(path, {
      method: "POST", cookie: reviewerB.cookie,
      body: { ...body, expectedRevision: 2, originality: 2, comment: "Wrong reviewer." },
    }, env)).status).toBe(404);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviews").get().count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_corrections").get().count).toBe(1);
    expect(database.prepare(`SELECT originality_score AS originality, relevance_score AS relevance
      FROM reviews WHERE assignment_id = ?`).get(assignment.id)).toEqual({ originality: 4, relevance: 5 });
    expect(database.prepare(`SELECT revision_number AS revisionNumber, originality_score AS originality,
      relevance_score AS relevance FROM review_corrections WHERE review_id =
      (SELECT id FROM reviews WHERE assignment_id = ?)` ).get(assignment.id)).toEqual({
      revisionNumber: 2, originality: 3, relevance: 5,
    });
    expect(() => database.prepare("UPDATE review_corrections SET relevance_score = 2 WHERE id = ?")
      .run(correction.id)).toThrow(/immutable/);
    expect(() => database.prepare("DELETE FROM review_corrections WHERE id = ?")
      .run(correction.id)).toThrow(/immutable/);
    const locked = await request(
      `/api/events/devflow-conf-2027/proposals/${proposalA.proposalId}`,
      { method: "PUT", cookie: proposalA.ownerCookie, body: { values: { title: "Changed after review" } } },
      env,
    );
    expect(locked.status).toBe(409);
    expect((await locked.json()).error.code).toBe("PROPOSAL_LOCKED");

    const progress = await request("/api/events/devflow-conf-2027/cfp/reviews/progress", { cookie: organizerCookie }, env);
    expect(progress.status).toBe(200);
    expect((await progress.json()).data.proposals.find(({ proposalId }) => proposalId === proposalA.proposalId)).toMatchObject({
      assignedCount: 1,
      completedCount: 1,
      averageScore: 4,
      recommendations: { accept: 1, discuss: 0, reject: 0 },
    });

    database.prepare(
      "UPDATE cfp_fields SET active = 0 WHERE event_id = 'evt-devflow' AND field_key = 'speaker_bio'",
    ).run();

    const reviews = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/reviews`,
      { cookie: organizerCookie },
      env,
    );
    const reviewsBody = await reviews.json();
    expect(reviews.status).toBe(200);
    expect(reviewsBody.data).toMatchObject({
      proposal: {
        id: proposalA.proposalId,
        publicId: "ABS-A",
        title: proposalA.title,
        abstract: "Abstract for a.",
        track: "AI Engineering",
        format: "talk",
        durationMinutes: 30,
        status: "in_review",
        values: {
          title: proposalA.title,
          abstract: "Abstract for a.",
          track: "AI Engineering",
          format: "talk",
          key_takeaway: "Public takeaway a",
        },
      },
      progress: { assigned: 1, submitted: 1, revoked: 0 },
      reviews: [{
        revisionNumber: 2,
        originality: 3,
        relevance: 5,
        recommendation: "accept",
        comment: "Strong evidence.",
      }],
    });
    expect(reviewsBody.data.proposal.values).not.toHaveProperty("speaker_bio");

    const revoke = await request(
      `/api/events/devflow-conf-2027/cfp/assignments/${assignment.id}/revoke`,
      { method: "POST", cookie: organizerCookie },
      env,
    );
    expect(revoke.status).toBe(409);
    expect((await revoke.json()).error.code).toBe("REVIEW_ALREADY_SUBMITTED");
  });

  it("exports canonical review results only to organizers with safe CSV cells", async () => {
    const formulaProposal = addSubmittedProposal(database, {
      suffix: "formula",
      title: '=HYPERLINK("https://example.test","open"), report',
    });
    const score = async (proposalId, reviewer, originality, relevance, recommendation) => {
      const assignment = await request(
        `/api/events/devflow-conf-2027/cfp/proposals/${proposalId}/assignments`,
        { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewer.userId } },
        env,
      ).then((response) => response.json()).then(({ data }) => data);
      await acceptAssignment(assignment.id, reviewer.cookie, env);
      const response = await request(
        `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`,
        {
          method: "POST",
          cookie: reviewer.cookie,
          body: { originality, relevance, recommendation, comment: "Internal reviewer note." },
        },
        env,
      );
      expect(response.status).toBe(201);
    };
    await score(proposalA.proposalId, reviewerA, 4, 5, "accept");
    await score(proposalB.proposalId, reviewerB, 2, 3, "discuss");

    const path = "/api/events/devflow-conf-2027/cfp/reviews/export.csv";
    expect((await request(path, {}, env)).status).toBe(401);
    expect((await request(path, { cookie: reviewerA.cookie }, env)).status).toBe(403);

    const exported = await request(path, { cookie: organizerCookie }, env);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(exported.headers.get("cache-control")).toBe("private, no-store");
    expect(exported.headers.get("content-disposition")).toBe(
      'attachment; filename="devflow-conf-2027-review-results.csv"',
    );

    const csv = await exported.text();
    expect(csv.startsWith(
      '"public_id","title","track","format","proposal_status","assigned_reviews","completed_reviews","average_score","accept_count","discuss_count","reject_count"\r\n',
    )).toBe(true);
    expect(csv).toContain('"ABS-A","Evidence-First Review Systems","AI Engineering","talk","in_review","1","1","4.5","1","0","0"');
    expect(csv).toContain('"ABS-B","Reliable Conference Workflows","AI Engineering","talk","in_review","1","1","2.5","0","1","0"');
    expect(csv).toContain('"ABS-FORMULA"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"",""open""), report"');
    expect(csv).not.toContain("Internal reviewer note.");
    expect(csv).not.toContain("@review.example");
    expect(csv).not.toContain("Reviewer a");
    expect(csv).not.toContain("PRIVATE BIO");
    expect(csv).not.toContain(otherEventProposal.title);
  });

  it("versions evaluation criteria, pins assignments, and calculates a deterministic weighted score", async () => {
    const planPath = "/api/events/devflow-conf-2027/cfp/review-plan";
    const firstPlanInput = {
      name: "Program committee rubric",
      criteria: [
        { key: "evidence", label: "Evidence", description: "Grounded claims.", weightBasisPoints: 3333, minimumScore: 1, maximumScore: 10 },
        { key: "impact", label: "Attendee impact", description: "Useful outcomes.", weightBasisPoints: 6667, minimumScore: 1, maximumScore: 10 },
      ],
    };
    expect((await request(planPath, {}, env)).status).toBe(401);
    expect((await request(planPath, { cookie: reviewerA.cookie }, env)).status).toBe(403);
    const invalid = await request(planPath, {
      method: "PUT",
      cookie: organizerCookie,
      body: { ...firstPlanInput, criteria: firstPlanInput.criteria.map((criterion) => ({ ...criterion, weightBasisPoints: 4000 })) },
    }, env);
    expect(invalid.status).toBe(400);

    const firstPlanResponse = await request(planPath, {
      method: "PUT", cookie: organizerCookie, body: firstPlanInput,
    }, env);
    expect(firstPlanResponse.status).toBe(201);
    const firstPlan = (await firstPlanResponse.json()).data;
    expect(firstPlan.versionNumber).toBe(1);
    const identicalPlanResponse = await request(planPath, {
      method: "PUT", cookie: organizerCookie, body: firstPlanInput,
    }, env);
    expect(identicalPlanResponse.status).toBe(201);
    expect((await identicalPlanResponse.json()).data).toEqual(firstPlan);
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_plan_versions").get().count).toBe(1);

    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    expect(database.prepare(
      "SELECT review_plan_version_id AS versionId FROM review_assignments WHERE id = ?",
    ).get(assignment.id).versionId).toBe(firstPlan.versionId);

    const secondPlan = await request(planPath, {
      method: "PUT",
      cookie: organizerCookie,
      body: {
        name: "Program committee rubric",
        criteria: [
          { key: "evidence", label: "Evidence", description: "Grounded claims.", weightBasisPoints: 5000, minimumScore: 1, maximumScore: 5 },
          { key: "impact", label: "Attendee impact", description: "Useful outcomes.", weightBasisPoints: 5000, minimumScore: 1, maximumScore: 5 },
        ],
      },
    }, env).then((response) => response.json()).then(({ data }) => data);
    expect(secondPlan.versionNumber).toBe(2);

    const pinnedDetail = await request(
      `/api/events/devflow-conf-2027/review/assignments/${assignment.id}`,
      { cookie: reviewerA.cookie },
      env,
    );
    expect(pinnedDetail.status).toBe(200);
    expect((await pinnedDetail.json()).data.evaluationPlan).toMatchObject({
      versionId: firstPlan.versionId,
      versionNumber: 1,
      criteria: firstPlan.criteria,
    });

    const reviewPath = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`;
    await acceptAssignment(assignment.id, reviewerA.cookie, env);
    const reviewBody = {
      criterionScores: [
        { criterionId: firstPlan.criteria[0].id, score: 2 },
        { criterionId: firstPlan.criteria[1].id, score: 8 },
      ],
      recommendation: "accept",
      comment: "Weighted against the pinned rubric.",
    };
    const submitted = await request(
      reviewPath,
      {
        method: "POST",
        cookie: reviewerA.cookie,
        body: reviewBody,
      },
      env,
    );
    expect(submitted.status).toBe(201);
    const submittedData = (await submitted.json()).data;
    expect(submittedData).toMatchObject({
      evaluationPlanVersion: 1,
      weightedScore: 3.222,
      criterionScores: [{ key: "evidence", score: 2 }, { key: "impact", score: 8 }],
    });
    expect(() => database.prepare(`INSERT INTO review_corrections (
      id, event_id, review_id, revision_number, corrected_by_user_id,
      originality_score, relevance_score, recommendation, comment,
      review_plan_version_id, weighted_score_milli, corrected_at, criterion_scores_staged
    ) VALUES (?, 'evt-devflow', ?, 2, ?, 4, 5, 'accept', 'Incomplete direct correction', ?, 3222, ?, 0)`)
      .run("correction-without-scores", submittedData.id, reviewerA.userId, firstPlan.versionId, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")))
      .toThrow(/exactly one criterion score for every plan criterion/);
    const repeated = await request(reviewPath, {
      method: "POST",
      cookie: reviewerA.cookie,
      body: { ...reviewBody, criterionScores: [...reviewBody.criterionScores].reverse() },
    }, env);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).data.id).toBe(submittedData.id);
    const corrected = await request(reviewPath, {
      method: "POST",
      cookie: reviewerA.cookie,
      body: {
        ...reviewBody,
        expectedRevision: 1,
        criterionScores: reviewBody.criterionScores.map((score, index) =>
          index === 0 ? { ...score, score: 3 } : score),
      },
    }, env);
    expect(corrected.status).toBe(201);
    expect((await corrected.json()).data).toMatchObject({
      revisionNumber: 2,
      weightedScore: 3.37,
      criterionScores: [{ key: "evidence", score: 3 }, { key: "impact", score: 8 }],
    });
    expect(database.prepare(
      "SELECT weighted_score_milli AS score, review_plan_version_id AS versionId FROM reviews WHERE assignment_id = ?",
    ).get(assignment.id)).toEqual({ score: 3222, versionId: firstPlan.versionId });
    expect(database.prepare(
      "SELECT weighted_score_milli AS score, review_plan_version_id AS versionId FROM current_reviews WHERE assignment_id = ?",
    ).get(assignment.id)).toEqual({ score: 3370, versionId: firstPlan.versionId });

    const progress = await request(
      "/api/events/devflow-conf-2027/cfp/reviews/progress",
      { cookie: organizerCookie },
      env,
    );
    expect(progress.status).toBe(200);
    expect((await progress.json()).data.proposals.find(({ proposalId }) => proposalId === proposalA.proposalId))
      .toMatchObject({ averageScore: 3.37 });

    const csv = await request(
      "/api/events/devflow-conf-2027/cfp/reviews/export.csv",
      { cookie: organizerCookie },
      env,
    ).then((response) => response.text());
    const [headerLine, ...dataLines] = csv.trim().split("\r\n");
    const cells = (line) => [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)]
      .map(([, quoted, bare]) => quoted === undefined ? bare : quoted.replaceAll('""', '"'));
    const headers = cells(headerLine);
    const correctedEvidenceColumn = headers.indexOf("criterion_v1_evidence_average");
    expect(headers).toContain("criterion_v2_evidence_average");
    expect(correctedEvidenceColumn).toBeGreaterThan(-1);
    expect(dataLines.map(cells).some((row) => row[correctedEvidenceColumn] === "3")).toBe(true);
    expect(csv).not.toContain("Reviewer a");
    expect(csv).not.toContain("@review.example");
  });

  it("keeps identical assignment and scorecard retries stable after a proposal is decided", async () => {
    const assignmentPath = `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`;
    const assignmentBody = { reviewerUserId: reviewerA.userId, dueAt: "2027-04-20T17:00:00Z" };
    const assignment = await request(
      assignmentPath,
      { method: "POST", cookie: organizerCookie, body: assignmentBody },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const reviewPath = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`;
    await acceptAssignment(assignment.id, reviewerA.cookie, env);
    const reviewBody = {
      originality: 4,
      relevance: 5,
      recommendation: "accept",
      comment: "Stable immutable review.",
    };
    const review = await request(
      reviewPath,
      { method: "POST", cookie: reviewerA.cookie, body: reviewBody },
      env,
    ).then((response) => response.json()).then(({ data }) => data);

    database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposalA.proposalId);

    const repeatedAssignment = await request(
      assignmentPath,
      { method: "POST", cookie: organizerCookie, body: assignmentBody },
      env,
    );
    const changedAssignment = await request(
      assignmentPath,
      { method: "POST", cookie: organizerCookie, body: { ...assignmentBody, blind: false } },
      env,
    );
    const repeatedReview = await request(
      reviewPath,
      { method: "POST", cookie: reviewerA.cookie, body: reviewBody },
      env,
    );
    const changedReview = await request(
      reviewPath,
      { method: "POST", cookie: reviewerA.cookie, body: { ...reviewBody, relevance: 3 } },
      env,
    );

    expect(repeatedAssignment.status).toBe(200);
    expect((await repeatedAssignment.json()).data.id).toBe(assignment.id);
    expect(changedAssignment.status).toBe(409);
    expect(repeatedReview.status).toBe(200);
    expect((await repeatedReview.json()).data).toEqual(review);
    expect(changedReview.status).toBe(409);
  });

  it("recovers concurrent assignment and scorecard races at the database constraints", async () => {
    const assignmentPath = `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`;
    const assignmentBody = { reviewerUserId: reviewerA.userId };
    const assignmentResponses = await Promise.all([
      request(assignmentPath, { method: "POST", cookie: organizerCookie, body: assignmentBody }, env),
      request(assignmentPath, { method: "POST", cookie: organizerCookie, body: assignmentBody }, env),
    ]);
    expect(assignmentResponses.map(({ status }) => status).sort()).toEqual([200, 201]);
    const assignments = await Promise.all(assignmentResponses.map((response) => response.json()));
    expect(new Set(assignments.map(({ data }) => data.id)).size).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM review_assignments WHERE proposal_id = ?",
    ).get(proposalA.proposalId).count).toBe(1);

    const assignmentId = assignments[0].data.id;
    await acceptAssignment(assignmentId, reviewerA.cookie, env);
    const reviewPath = `/api/events/devflow-conf-2027/review/assignments/${assignmentId}/review`;
    const scorecard = { originality: 5, relevance: 4, recommendation: "accept", comment: "Race-safe." };
    const identicalReviews = await Promise.all([
      request(reviewPath, { method: "POST", cookie: reviewerA.cookie, body: scorecard }, env),
      request(reviewPath, { method: "POST", cookie: reviewerA.cookie, body: scorecard }, env),
    ]);
    expect(identicalReviews.map(({ status }) => status).sort()).toEqual([200, 201]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviews").get().count).toBe(1);

    const conflicting = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerB.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    await acceptAssignment(conflicting.id, reviewerB.cookie, env);
    const conflictingPath = `/api/events/devflow-conf-2027/review/assignments/${conflicting.id}/review`;
    const conflictingReviews = await Promise.all([
      request(conflictingPath, {
        method: "POST", cookie: reviewerB.cookie,
        body: { originality: 5, relevance: 5, recommendation: "accept", comment: "Winner A." },
      }, env),
      request(conflictingPath, {
        method: "POST", cookie: reviewerB.cookie,
        body: { originality: 2, relevance: 2, recommendation: "reject", comment: "Winner B." },
      }, env),
    ]);
    expect(conflictingReviews.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviews WHERE assignment_id = ?")
      .get(conflicting.id).count).toBe(1);
  });

  it("rejects a competing correction instead of silently overwriting the winning revision", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    await acceptAssignment(assignment.id, reviewerA.cookie, env);
    const path = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`;
    expect((await request(path, {
      method: "POST", cookie: reviewerA.cookie,
      body: { originality: 4, relevance: 4, recommendation: "discuss", comment: "Initial." },
    }, env)).status).toBe(201);

    const corrections = await Promise.all([
      request(path, {
        method: "POST", cookie: reviewerA.cookie,
        body: { expectedRevision: 1, originality: 5, relevance: 4, recommendation: "accept", comment: "Correction A." },
      }, env),
      request(path, {
        method: "POST", cookie: reviewerA.cookie,
        body: { expectedRevision: 1, originality: 2, relevance: 3, recommendation: "reject", comment: "Correction B." },
      }, env),
    ]);
    expect(corrections.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_corrections WHERE review_id = (SELECT id FROM reviews WHERE assignment_id = ?)")
      .get(assignment.id).count).toBe(1);
  });

  it("blocks scorecard submission if the reviewer later becomes a presenter", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES ('spk-late-reviewer-a', 'evt-devflow', ?, 'late-reviewer-a', 'Reviewer A', '', '', '',
      NULL, 'RA', 'incomplete', 'missing', 'private')`).run(reviewerA.userId);
    database.prepare(`INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('presenter-late-reviewer-a', 'evt-devflow', ?, 'spk-late-reviewer-a', 'co_presenter')`)
      .run(proposalA.proposalId);

    const response = await request(
      `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`,
      {
        method: "POST",
        cookie: reviewerA.cookie,
        body: { originality: 4, relevance: 4, recommendation: "discuss", comment: "Conflict." },
      },
      env,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SELF_REVIEW_NOT_ALLOWED");
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviews").get().count).toBe(0);
  });

  it("soft-revokes an incomplete assignment and hides it from the reviewer", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const revokePath = `/api/events/devflow-conf-2027/cfp/assignments/${assignment.id}/revoke`;
    const revoked = await request(revokePath, { method: "POST", cookie: organizerCookie }, env);
    const repeated = await request(revokePath, { method: "POST", cookie: organizerCookie }, env);
    expect(revoked.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect((await revoked.json()).data).toMatchObject({ id: assignment.id, status: "revoked" });

    const queue = await request("/api/events/devflow-conf-2027/review/assignments", { cookie: reviewerA.cookie }, env);
    expect((await queue.json()).data.assignments).toEqual([]);
    const detail = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}`, { cookie: reviewerA.cookie }, env);
    const submit = await request(
      `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`,
      { method: "POST", cookie: reviewerA.cookie, body: { originality: 4, relevance: 4, recommendation: "discuss", comment: "Needs work." } },
      env,
    );
    expect(detail.status).toBe(404);
    expect(submit.status).toBe(404);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviews").get().count).toBe(0);
  });

  it("creates a new server-derived round when a revoked assignment is replaced", async () => {
    const path = `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`;
    const first = await request(
      path,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    await request(
      `/api/events/devflow-conf-2027/cfp/assignments/${first.id}/revoke`,
      { method: "POST", cookie: organizerCookie },
      env,
    );

    const replacements = await Promise.all([
      request(
        path,
        { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId, blind: false } },
        env,
      ),
      request(
        path,
        { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId, blind: false } },
        env,
      ),
    ]);
    expect(replacements.map(({ status }) => status).sort()).toEqual([200, 201]);
    const replacementBodies = await Promise.all(replacements.map((response) => response.json()));
    expect(new Set(replacementBodies.map(({ data }) => data.id)).size).toBe(1);
    expect(replacementBodies[0].data).toMatchObject({ round: 2, blind: false, status: "pending" });
    expect(database.prepare(`
      SELECT round, state, blind FROM review_assignments
      WHERE event_id = 'evt-devflow' AND proposal_id = ? AND reviewer_user_id = ?
      ORDER BY round
    `).all(proposalA.proposalId, reviewerA.userId)).toEqual([
      { round: 1, state: "revoked", blind: 1 },
      { round: 2, state: "assigned", blind: 0 },
    ]);
  });

  it("keeps every reviewer surface available for titles allowed by the CFP write contract", async () => {
    const longTitle = "T".repeat(600);
    const longProposal = addSubmittedProposal(database, { suffix: "long", title: longTitle });
    const assignmentResponse = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${longProposal.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    );
    expect(assignmentResponse.status).toBe(201);
    const assignment = (await assignmentResponse.json()).data;
    expect(assignment.proposal.title).toBe(longTitle);

    const queue = await request(
      "/api/events/devflow-conf-2027/review/assignments",
      { cookie: reviewerA.cookie },
      env,
    );
    const detail = await request(
      `/api/events/devflow-conf-2027/review/assignments/${assignment.id}`,
      { cookie: reviewerA.cookie },
      env,
    );
    const progress = await request(
      "/api/events/devflow-conf-2027/cfp/reviews/progress",
      { cookie: organizerCookie },
      env,
    );
    const organizerDetail = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${longProposal.proposalId}/reviews`,
      { cookie: organizerCookie },
      env,
    );

    for (const response of [queue, detail, progress, organizerDetail]) expect(response.status).toBe(200);
    const progressData = (await progress.json()).data.proposals;
    expect(progressData.some(({ proposalId }) => proposalId === longProposal.proposalId)).toBe(true);
    expect(progressData.some(({ proposalId }) => proposalId === proposalA.proposalId)).toBe(true);
    expect((await detail.json()).data.proposal.title).toBe(longTitle);
  });

  it("reveals only the display name when an organizer explicitly disables blind review", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId, blind: false } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const detail = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}`, { cookie: reviewerA.cookie }, env);
    const body = await detail.json();
    expect(detail.status).toBe(200);
    expect(body.data.proposal.authorDisplayName).toBe("Speaker a");
    expect(JSON.stringify(body)).not.toContain("a@speaker.example");
    expect(body.data.proposal.sessionAnswers).not.toHaveProperty("speaker_bio");
  });

  it("requires an assignment invitation response and keeps it scoped and immutable", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    expect(assignment.invitationStatus).toBe("pending");

    const invitationPath = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/invitation`;
    const guessed = await request(invitationPath, {
      method: "POST", cookie: reviewerB.cookie, body: { action: "accept" },
    }, env);
    expect(guessed.status).toBe(404);

    const blockedReview = await request(
      `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`,
      { method: "POST", cookie: reviewerA.cookie, body: { originality: 4, relevance: 4, recommendation: "accept", comment: "Too early." } },
      env,
    );
    expect(blockedReview.status).toBe(409);
    expect((await blockedReview.json()).error.code).toBe("ASSIGNMENT_NOT_ACCEPTED");

    const accepted = await request(invitationPath, {
      method: "POST", cookie: reviewerA.cookie, body: { action: "accept" },
    }, env);
    const repeated = await request(invitationPath, {
      method: "POST", cookie: reviewerA.cookie, body: { action: "accept" },
    }, env);
    expect(accepted.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect((await accepted.json()).data).toMatchObject({ id: assignment.id, invitationStatus: "accepted", reason: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_assignment_actions WHERE assignment_id = ?")
      .get(assignment.id).count).toBe(1);

    const changed = await request(invitationPath, {
      method: "POST", cookie: reviewerA.cookie, body: { action: "decline", reason: "Changed my mind." },
    }, env);
    expect(changed.status).toBe(409);
  });

  it("records decline and recusal reasons for organizers and closes scoring", async () => {
    const declinedProposal = addSubmittedProposal(database, { suffix: "decline", title: "Declined invitation" });
    const declinedAssignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${declinedProposal.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const decline = await request(
      `/api/events/devflow-conf-2027/review/assignments/${declinedAssignment.id}/invitation`,
      { method: "POST", cookie: reviewerA.cookie, body: { action: "decline", reason: "No capacity this round." } },
      env,
    );
    expect(decline.status).toBe(201);

    const recusedAssignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerB.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    await acceptAssignment(recusedAssignment.id, reviewerB.cookie, env);
    const recused = await request(
      `/api/events/devflow-conf-2027/review/assignments/${recusedAssignment.id}/recuse`,
      { method: "POST", cookie: reviewerB.cookie, body: { reason: "A new collaboration creates perceived bias." } },
      env,
    );
    expect(recused.status).toBe(201);
    expect((await recused.json()).data.invitationStatus).toBe("recused");

    for (const [assignmentId, reviewer] of [[declinedAssignment.id, reviewerA], [recusedAssignment.id, reviewerB]]) {
      const score = await request(
        `/api/events/devflow-conf-2027/review/assignments/${assignmentId}/review`,
        { method: "POST", cookie: reviewer.cookie, body: { originality: 4, relevance: 4, recommendation: "discuss", comment: "Must stay closed." } },
        env,
      );
      expect(score.status).toBe(409);
      expect((await score.json()).error.code).toBe("ASSIGNMENT_NOT_ACCEPTED");
    }

    const declinedDetail = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${declinedProposal.proposalId}/reviews`,
      { cookie: organizerCookie }, env,
    ).then((response) => response.json());
    expect(declinedDetail.data.assignments[0]).toMatchObject({
      invitationStatus: "declined", responseReason: "No capacity this round.",
    });
    const recusedDetail = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalA.proposalId}/reviews`,
      { cookie: organizerCookie }, env,
    ).then((response) => response.json());
    expect(recusedDetail.data.assignments[0]).toMatchObject({
      invitationStatus: "recused", responseReason: "A new collaboration creates perceived bias.",
    });
  });

  it("declares a reviewer conflict atomically and blocks reassignment to that proposal", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const path = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/conflict`;
    const body = { category: "institutional", note: "The author is in my reporting chain." };
    const declared = await request(path, { method: "POST", cookie: reviewerA.cookie, body }, env);
    const repeated = await request(path, { method: "POST", cookie: reviewerA.cookie, body }, env);
    expect(declared.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect((await declared.json()).data).toMatchObject({
      invitationStatus: "declined",
      conflict: { category: "institutional", note: body.note },
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviewer_conflicts WHERE assignment_id = ?")
      .get(assignment.id).count).toBe(1);

    const activeRetry = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    );
    expect(activeRetry.status).toBe(409);
    expect((await activeRetry.json()).error.code).toBe("REVIEWER_CONFLICT_DECLARED");

    await request(
      `/api/events/devflow-conf-2027/cfp/assignments/${assignment.id}/revoke`,
      { method: "POST", cookie: organizerCookie }, env,
    );
    const reassigned = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    );
    expect(reassigned.status).toBe(409);
    expect((await reassigned.json()).error.code).toBe("REVIEWER_CONFLICT_DECLARED");
  });

  it("returns a stable lifecycle timestamp for a persisted conflict without an action row", async () => {
    const assignment = await request(
      `/api/events/devflow-conf-2027/cfp/proposals/${proposalB.proposalId}/assignments`,
      { method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId } },
      env,
    ).then((response) => response.json()).then(({ data }) => data);
    const declaredAt = "2026-08-12T14:00:00.000Z";
    const note = "A legacy import recorded the conflict without an invitation action.";
    database.prepare(`INSERT INTO review_assignment_actions (
      id, event_id, assignment_id, reviewer_user_id, sequence, action, reason, created_at
    ) VALUES (?, 'evt-devflow', ?, ?, 1, 'declined', ?, ?)`).run(
      "action-legacy-conflict", assignment.id, reviewerA.userId, note, declaredAt,
    );
    database.prepare(`INSERT INTO reviewer_conflicts (
      id, event_id, proposal_id, reviewer_user_id, assignment_id, category, note, created_at
    ) VALUES (?, 'evt-devflow', ?, ?, ?, 'institutional', ?, ?)`).run(
      "conflict-legacy-actionless", proposalB.proposalId, reviewerA.userId, assignment.id, note, declaredAt,
    );
    database.exec("DROP TRIGGER review_assignment_actions_immutable_delete");
    database.prepare("DELETE FROM review_assignment_actions WHERE assignment_id = ?").run(assignment.id);

    const repeated = await request(
      `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/conflict`,
      { method: "POST", cookie: reviewerA.cookie, body: { category: "institutional", note } },
      env,
    );
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).data).toMatchObject({
      id: assignment.id,
      respondedAt: declaredAt,
      conflict: { category: "institutional", note, declaredAt },
    });
  });
});
