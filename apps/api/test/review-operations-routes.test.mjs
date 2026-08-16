import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index.ts";

class SqliteD1Statement {
  constructor(statement, { afterAll = null } = {}) {
    this.statement = statement;
    this.params = [];
    this.afterAll = afterAll;
  }
  bind(...params) {
    const bound = new SqliteD1Statement(this.statement, { afterAll: this.afterAll });
    bound.params = params;
    return bound;
  }
  async all() {
    const results = this.statement.all(...this.params);
    await this.afterAll?.();
    return { results, success: true, meta: {} };
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
  constructor(database) {
    this.database = database;
    this.preparedQueries = [];
    this.afterEvaluationCriteriaLookup = null;
  }
  prepare(query) {
    this.preparedQueries.push(query);
    const afterAll = query.includes("FROM review_criteria WHERE event_id = ? AND plan_version_id = ?")
      ? () => {
          const hook = this.afterEvaluationCriteriaLookup;
          this.afterEvaluationCriteriaLookup = null;
          return hook?.();
        }
      : null;
    return new SqliteD1Statement(this.database.prepare(query), { afterAll });
  }
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

function addSubmittedProposal(database, { suffix, track = "AI Engineering", createdAt = "2026-08-11T00:00:00Z" }) {
  const eventId = "evt-devflow";
  const ownerId = `usr-owner-${suffix}`;
  const speakerId = `spk-owner-${suffix}`;
  const proposalId = `prop-ops-${suffix}`;
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run(ownerId, `${suffix}@speaker.example`, `Speaker ${suffix}`, createdAt);
  database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'speaker', ?)")
    .run(`mem-owner-${suffix}`, eventId, ownerId, createdAt);
  database.prepare(`INSERT INTO speakers (
    id, event_id, user_id, slug, name, title, company, bio,
    headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
  ) VALUES (?, ?, ?, ?, ?, '', '', '', NULL, 'SF', 'incomplete', 'missing', 'private')`).run(
    speakerId, eventId, ownerId, `speaker-${suffix}`, `Speaker ${suffix}`,
  );
  database.prepare(`INSERT INTO proposals (
    id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
    status, submitted_at, created_at, updated_at, owner_user_id, client_draft_key
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'talk', 30, 'submitted', ?, ?, ?, ?, ?)`).run(
    proposalId, eventId, `ABS-${suffix.toUpperCase()}`, `proposal-${suffix}`,
    `Proposal ${suffix}`, `Abstract for ${suffix}.`, track,
    createdAt, createdAt, createdAt, ownerId, `draft-${suffix}`,
  );
  database.prepare("INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role) VALUES (?, ?, ?, ?, 'primary')")
    .run(`presenter-${suffix}`, eventId, proposalId, speakerId);
  return { proposalId, ownerId };
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

const OPEN_WINDOW = { opensAt: "2020-01-01T00:00:00Z", closesAt: "2090-01-01T00:00:00Z" };
const CLOSED_WINDOW = { opensAt: "2020-01-01T00:00:00Z", closesAt: "2020-02-01T00:00:00Z" };

const PLAN_BODY = {
  name: "Initial scorecard",
  criteria: [
    { key: "originality", label: "Originality", weightBasisPoints: 6667, minimumScore: 1, maximumScore: 5 },
    { key: "relevance", label: "Relevance", weightBasisPoints: 3333, minimumScore: 1, maximumScore: 5 },
  ],
};

describe("review operations API", () => {
  let database;
  let env;
  let organizerCookie;
  let reviewerA;
  let reviewerB;

  beforeEach(() => {
    database = fixtureDatabase();
    env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
    };
    organizerCookie = addSession(database, { userId: "usr-devflow-organizer", token: "ops-organizer" });
    reviewerA = addReviewer(database, { suffix: "opsa" });
    reviewerB = addReviewer(database, { suffix: "opsb" });
  });

  async function createRound(overrides = {}) {
    const response = await request("/api/events/devflow-conf-2027/cfp/review-rounds", {
      method: "POST",
      cookie: organizerCookie,
      body: { name: "Initial Review", blindDefault: true, ...OPEN_WINDOW, ...overrides },
    }, env);
    expect(response.status).toBe(201);
    return (await response.json()).data;
  }

  async function setPool(roundId, reviewerUserIds) {
    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${roundId}/pool`, {
      method: "PUT",
      cookie: organizerCookie,
      body: { reviewerUserIds },
    }, env);
    expect(response.status).toBe(200);
    return (await response.json()).data;
  }

  async function acceptAssignment(assignmentId, reviewerCookie) {
    const response = await request(`/api/events/devflow-conf-2027/review/assignments/${assignmentId}/invitation`, {
      method: "POST", cookie: reviewerCookie, body: { action: "accept" },
    }, env);
    expect([200, 201]).toContain(response.status);
  }

  it("creates, lists, and edits rounds with stale-write protection", async () => {
    const initial = await createRound();
    const final = await createRound({ name: "Final Review", opensAt: "2090-01-02T00:00:00Z", closesAt: "2090-06-01T00:00:00Z" });
    expect(initial.windowState).toBe("open");
    expect(final.windowState).toBe("upcoming");

    const list = await request("/api/events/devflow-conf-2027/cfp/review-rounds", { cookie: organizerCookie }, env);
    const rounds = (await list.json()).data.rounds;
    expect(rounds.map((round) => round.name)).toEqual(["Initial Review", "Final Review"]);

    const rename = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${initial.id}`, {
      method: "PATCH",
      cookie: organizerCookie,
      body: { name: "Renamed Review", blindDefault: false, ...OPEN_WINDOW, expectedUpdatedAt: initial.updatedAt },
    }, env);
    expect(rename.status).toBe(200);
    expect((await rename.json()).data.name).toBe("Renamed Review");

    const stale = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${initial.id}`, {
      method: "PATCH",
      cookie: organizerCookie,
      body: { name: "Too late", blindDefault: true, ...OPEN_WINDOW, expectedUpdatedAt: initial.updatedAt },
    }, env);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("REVIEW_ROUND_STALE");

    const denied = await request("/api/events/devflow-conf-2027/cfp/review-rounds", {
      method: "POST",
      cookie: reviewerA.cookie,
      body: { name: "Not allowed", blindDefault: true, ...OPEN_WINDOW },
    }, env);
    expect(denied.status).toBe(403);
  });

  it("manages round pools with per-row rejections", async () => {
    const round = await createRound();
    const pool = await setPool(round.id, [reviewerA.userId, "usr-devflow-organizer", "usr-missing"]);
    expect(pool.reviewers.map((member) => member.userId)).toEqual([reviewerA.userId]);
    expect(pool.rejected).toEqual(expect.arrayContaining([
      { userId: "usr-devflow-organizer", reason: "not_a_reviewer" },
      { userId: "usr-missing", reason: "unknown_user" },
    ]));

    const proposal = addSubmittedProposal(database, { suffix: "poolkeep" });
    const assign = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(assign.status).toBe(201);

    const removal = await setPool(round.id, []);
    expect(removal.reviewers.map((member) => member.userId)).toEqual([reviewerA.userId]);
    expect(removal.rejected).toEqual([{ userId: reviewerA.userId, reason: "active_assignments" }]);
  });

  it("keeps per-round evaluation plans and builtin labels independent and versioned", async () => {
    const round = await createRound();
    const defaultPlan = await request("/api/events/devflow-conf-2027/cfp/review-plan", {
      method: "PUT", cookie: organizerCookie, body: PLAN_BODY,
    }, env);
    expect(defaultPlan.status).toBe(201);

    const labels = {
      recommendationAccept: "Accept",
      recommendationDiscuss: "Maybe",
      recommendationReject: "Reject",
      commentsLabel: "Comments",
    };
    const roundPlan = await request(`/api/events/devflow-conf-2027/cfp/review-plan?roundId=${round.id}`, {
      method: "PUT",
      cookie: organizerCookie,
      body: { ...PLAN_BODY, name: "Round scorecard", builtinLabels: labels },
    }, env);
    expect(roundPlan.status).toBe(201);
    const roundPlanData = (await roundPlan.json()).data;
    expect(roundPlanData.builtinLabels).toEqual(labels);
    expect(roundPlanData.versionNumber).toBe(1);

    const labelOnlyEdit = await request(`/api/events/devflow-conf-2027/cfp/review-plan?roundId=${round.id}`, {
      method: "PUT",
      cookie: organizerCookie,
      body: { ...PLAN_BODY, name: "Round scorecard", builtinLabels: { ...labels, recommendationDiscuss: "Discuss more" } },
    }, env);
    expect(labelOnlyEdit.status).toBe(201);
    expect((await labelOnlyEdit.json()).data.versionNumber).toBe(2);

    const replay = await request(`/api/events/devflow-conf-2027/cfp/review-plan?roundId=${round.id}`, {
      method: "PUT",
      cookie: organizerCookie,
      body: { ...PLAN_BODY, name: "Round scorecard", builtinLabels: { ...labels, recommendationDiscuss: "Discuss more" } },
    }, env);
    expect((await replay.json()).data.versionNumber).toBe(2);

    const fetchedDefault = await request("/api/events/devflow-conf-2027/cfp/review-plan", { cookie: organizerCookie }, env);
    const fetchedDefaultData = (await fetchedDefault.json()).data;
    expect(fetchedDefaultData.name).toBe("Initial scorecard");
    expect(fetchedDefaultData.builtinLabels).toBeNull();

    const missingRound = await request("/api/events/devflow-conf-2027/cfp/review-plan?roundId=missing", { cookie: organizerCookie }, env);
    expect(missingRound.status).toBe(404);
    expect((await missingRound.json()).error.code).toBe("REVIEW_ROUND_NOT_FOUND");
  });

  it("auto-distributes deterministically with caps, conflicts, and per-row skips", async () => {
    const round = await createRound();
    await setPool(round.id, [reviewerA.userId, reviewerB.userId]);
    const track = "Ops Test Track";
    const first = addSubmittedProposal(database, { suffix: "autoa", track, createdAt: "2026-08-01T00:00:00Z" });
    const second = addSubmittedProposal(database, { suffix: "autob", track, createdAt: "2026-08-02T00:00:00Z" });
    const third = addSubmittedProposal(database, { suffix: "autoc", track, createdAt: "2026-08-03T00:00:00Z" });
    env.DB.preparedQueries = [];

    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { perReviewerCap: 1, track },
    }, env);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.created).toEqual([
      expect.objectContaining({ proposalId: first.proposalId, reviewerUserId: reviewerA.userId }),
      expect.objectContaining({ proposalId: second.proposalId, reviewerUserId: reviewerB.userId }),
    ]);
    expect(result.skipped).toEqual([
      { proposalId: third.proposalId, reviewerUserId: null, reason: "reviewer_at_cap" },
    ]);
    expect(result.hasMore).toBe(false);
    for (const marker of [
      "auto-assign presenter blockers",
      "auto-assign conflict blockers",
      "auto-assign active-assignment blockers",
      "auto-assign retry rounds",
    ]) {
      expect(env.DB.preparedQueries.filter((query) => query.includes(marker))).toHaveLength(1);
    }

    const rerun = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { track },
    }, env);
    const rerunResult = (await rerun.json()).data;
    expect(rerunResult.created).toEqual([
      expect.objectContaining({ proposalId: third.proposalId }),
    ]);
  });

  it("bounds each auto-distribution scan and signals when eligible proposals remain", async () => {
    const round = await createRound();
    const track = "Bounded Assignment Track";
    database.exec("BEGIN");
    try {
      for (let index = 0; index < 251; index += 1) {
        addSubmittedProposal(database, {
          suffix: `bounded-${String(index).padStart(3, "0")}`,
          track,
          createdAt: `2026-08-10T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
        });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { track },
    }, env);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result).toMatchObject({ created: [], hasMore: true });
    expect(result.skipped).toHaveLength(250);
    expect(result.skipped.every(({ reason }) => reason === "no_pool_capacity")).toBe(true);
  });

  it("rolls back an auto-assignment when its proposal transition fails", async () => {
    const round = await createRound();
    await setPool(round.id, [reviewerA.userId]);
    const track = "Atomic Assignment Track";
    const proposal = addSubmittedProposal(database, { suffix: "atomic-auto", track });
    database.exec(`CREATE TRIGGER reject_atomic_auto_transition
      BEFORE UPDATE OF status ON proposals
      WHEN OLD.id = '${proposal.proposalId}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated proposal transition failure');
      END`);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { track },
    }, env);

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      created: [],
      skipped: expect.arrayContaining([
        { proposalId: proposal.proposalId, reviewerUserId: reviewerA.userId, reason: "insert_failed" },
      ]),
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM review_assignments
      WHERE proposal_id = ? AND review_round_id = ?`).get(proposal.proposalId, round.id).count).toBe(0);
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposal.proposalId))
      .toEqual({ status: "submitted" });
    expect(consoleError).toHaveBeenCalledWith("Review auto-assignment batch failed", expect.objectContaining({
      requestId: expect.any(String),
      error: expect.any(Error),
    }));
    consoleError.mockRestore();
  });

  it("uses the round blind default and redistributes a declined proposal", async () => {
    const round = await createRound({ name: "Identified Review", blindDefault: false });
    await setPool(round.id, [reviewerA.userId, reviewerB.userId]);
    const track = "Ops Decline Track";
    const proposal = addSubmittedProposal(database, { suffix: "declined-auto", track });

    const initial = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: false, reviewRoundId: round.id },
    }, env);
    expect(initial.status).toBe(201);
    const initialAssignment = (await initial.json()).data;

    const decline = await request(`/api/events/devflow-conf-2027/review/assignments/${initialAssignment.id}/invitation`, {
      method: "POST",
      cookie: reviewerA.cookie,
      body: { action: "decline", reason: "No capacity for this proposal." },
    }, env);
    expect(decline.status).toBe(201);

    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { track },
    }, env);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.created).toEqual([
      expect.objectContaining({ proposalId: proposal.proposalId, reviewerUserId: reviewerB.userId }),
    ]);
    expect(result.skipped).toEqual([]);
    expect(database.prepare("SELECT blind FROM review_assignments WHERE id = ?")
      .get(result.created[0].assignmentId).blind).toBe(0);
  });

  it("allows the same reviewer to evaluate one proposal in separate named rounds", async () => {
    const initialRound = await createRound({ name: "Initial Review" });
    const finalRound = await createRound({ name: "Final Review" });
    await setPool(initialRound.id, [reviewerA.userId]);
    await setPool(finalRound.id, [reviewerA.userId]);
    const proposal = addSubmittedProposal(database, { suffix: "parallel-rounds" });

    const initial = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: initialRound.id },
    }, env);
    expect(initial.status).toBe(201);

    const final = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: false, reviewRoundId: finalRound.id },
    }, env);
    expect(final.status).toBe(201);
    expect((await final.json()).data).toMatchObject({
      round: 2,
      reviewRoundId: finalRound.id,
      blind: false,
    });
  });

  it("auto-assigns a decided proposal into an open named round", async () => {
    const round = await createRound({ name: "Final Review" });
    await setPool(round.id, [reviewerA.userId]);
    const proposal = addSubmittedProposal(database, { suffix: "decided-auto", track: "Final Review Track" });
    const decision = await request("/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      cookie: organizerCookie,
      body: { proposalId: proposal.proposalId, decision: "reject", rationale: "Reconsider in the final round." },
    }, env);
    expect(decision.status).toBe(201);

    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { track: "Final Review Track" },
    }, env);
    expect(response.status).toBe(200);
    expect((await response.json()).data.created).toEqual([
      expect.objectContaining({ proposalId: proposal.proposalId, reviewerUserId: reviewerA.userId }),
    ]);
  });

  it("reports self-review skips without letting a legacy assignment block a named round", async () => {
    const round = await createRound();
    await setPool(round.id, [reviewerA.userId, reviewerB.userId]);
    const track = "Ops Reason Track";
    const owned = addSubmittedProposal(database, { suffix: "selfrev", track });
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES ('spk-reviewer-copresent', 'evt-devflow', ?, 'reviewer-copresenter', 'Reviewer Copresenter', '', '', '', NULL, 'RC', 'incomplete', 'missing', 'private')`)
      .run(reviewerA.userId);
    database.prepare("INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role) VALUES ('presenter-selfrev-reviewer', 'evt-devflow', ?, 'spk-reviewer-copresent', 'co_presenter')")
      .run(owned.proposalId);
    const conflictedAssign = await request(`/api/events/devflow-conf-2027/cfp/proposals/${owned.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerB.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(conflictedAssign.status).toBe(201);
    const conflictedAssignment = (await conflictedAssign.json()).data;
    const conflict = await request(`/api/events/devflow-conf-2027/review/assignments/${conflictedAssignment.id}/conflict`, {
      method: "POST",
      cookie: reviewerB.cookie,
      body: { category: "other", note: "I cannot review this proposal." },
    }, env);
    expect(conflict.status).toBe(201);
    const taken = addSubmittedProposal(database, { suffix: "taken", track });
    const legacyAssign = await request(`/api/events/devflow-conf-2027/cfp/proposals/${taken.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true },
    }, env);
    expect(legacyAssign.status).toBe(201);

    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: { track },
    }, env);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    expect(result.created).toEqual([
      expect.objectContaining({ proposalId: taken.proposalId, reviewerUserId: reviewerA.userId }),
    ]);
    expect(result.skipped).toEqual([
      { proposalId: owned.proposalId, reviewerUserId: reviewerA.userId, reason: "self_review" },
      { proposalId: owned.proposalId, reviewerUserId: reviewerB.userId, reason: "conflict" },
    ]);
    expect(database.prepare("SELECT round, review_round_id AS reviewRoundId FROM review_assignments WHERE id = ?")
      .get(result.created[0].assignmentId)).toEqual({ round: 2, reviewRoundId: round.id });
  });

  it("refuses auto-assignment while the round window is closed", async () => {
    const round = await createRound({ name: "Closed Review", ...CLOSED_WINDOW });
    await setPool(round.id, [reviewerA.userId]);
    addSubmittedProposal(database, { suffix: "closed" });
    const response = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}/assignments/auto`, {
      method: "POST",
      cookie: organizerCookie,
      body: {},
    }, env);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("REVIEW_ROUND_NOT_OPEN");
  });

  it("requires pool membership for round-scoped single assignments", async () => {
    const round = await createRound();
    const proposal = addSubmittedProposal(database, { suffix: "single" });
    const outsidePool = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(outsidePool.status).toBe(409);
    expect((await outsidePool.json()).error.code).toBe("REVIEWER_NOT_IN_POOL");

    await setPool(round.id, [reviewerA.userId]);
    const assigned = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(assigned.status).toBe(201);
    expect((await assigned.json()).data.reviewRoundId).toBe(round.id);
  });

  it("continues a decided proposal into an open named round without reopening its decision", async () => {
    const round = await createRound({ name: "Final Review" });
    await setPool(round.id, [reviewerA.userId, reviewerB.userId]);
    const proposal = addSubmittedProposal(database, { suffix: "decided-round" });
    const decision = await request("/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      cookie: organizerCookie,
      body: { proposalId: proposal.proposalId, decision: "accept", rationale: "Advance to final program review." },
    }, env);
    expect(decision.status).toBe(201);
    const canonicalBefore = database.prepare(`SELECT
      (SELECT COUNT(*) FROM decisions WHERE proposal_id = ?) AS decisions,
      (SELECT COUNT(*) FROM acceptances WHERE proposal_id = ?) AS acceptances,
      (SELECT COUNT(*) FROM program_sessions WHERE source_proposal_id = ?) AS sessions`).get(
      proposal.proposalId, proposal.proposalId, proposal.proposalId,
    );

    const unbounded = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST", cookie: organizerCookie, body: { reviewerUserId: reviewerA.userId, blind: true },
    }, env);
    expect(unbounded.status).toBe(409);
    expect((await unbounded.json()).error.code).toBe("REVIEW_ROUND_REQUIRED_AFTER_DECISION");

    const assigned = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST", cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(assigned.status).toBe(201);
    const assignment = (await assigned.json()).data;
    expect(assignment.reviewRoundId).toBe(round.id);
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposal.proposalId)).toEqual({ status: "decided" });

    await acceptAssignment(assignment.id, reviewerA.cookie);
    const submitted = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`, {
      method: "POST", cookie: reviewerA.cookie,
      body: { originality: 5, relevance: 4, recommendation: "accept", comment: "Final-round evidence." },
    }, env);
    expect(submitted.status).toBe(201);
    expect(database.prepare(`SELECT
      (SELECT COUNT(*) FROM decisions WHERE proposal_id = ?) AS decisions,
      (SELECT COUNT(*) FROM acceptances WHERE proposal_id = ?) AS acceptances,
      (SELECT COUNT(*) FROM program_sessions WHERE source_proposal_id = ?) AS sessions`).get(
      proposal.proposalId, proposal.proposalId, proposal.proposalId,
    )).toEqual(canonicalBefore);

    const second = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST", cookie: organizerCookie,
      body: { reviewerUserId: reviewerB.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(second.status).toBe(201);
    const secondAssignment = (await second.json()).data;
    await acceptAssignment(secondAssignment.id, reviewerB.cookie);
    database.prepare("UPDATE review_rounds SET closes_at = '2020-02-01T00:00:00Z', updated_by_user_id = 'usr-devflow-organizer', updated_at = '2020-01-02T00:00:00Z' WHERE id = ?")
      .run(round.id);
    const blocked = await request(`/api/events/devflow-conf-2027/review/assignments/${secondAssignment.id}/review`, {
      method: "POST", cookie: reviewerB.cookie,
      body: { originality: 4, relevance: 4, recommendation: "discuss", comment: "Too late." },
    }, env);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("REVIEW_ROUND_NOT_OPEN");
  });

  it("reports per-reviewer progress and queues reviewer reminders", async () => {
    const round = await createRound();
    await setPool(round.id, [reviewerA.userId, reviewerB.userId]);
    const first = addSubmittedProposal(database, { suffix: "proga" });
    const second = addSubmittedProposal(database, { suffix: "progb" });
    for (const proposal of [first, second]) {
      const response = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
        method: "POST",
        cookie: organizerCookie,
        body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id, dueAt: "2026-01-01T00:00:00Z" },
      }, env);
      expect(response.status).toBe(201);
    }

    const progress = await request(`/api/events/devflow-conf-2027/cfp/reviews/reviewer-progress?roundId=${round.id}`, {
      cookie: organizerCookie,
    }, env);
    expect(progress.status).toBe(200);
    const rows = (await progress.json()).data.reviewers;
    expect(rows).toEqual([
      expect.objectContaining({ userId: reviewerA.userId, assignedCount: 2, completedCount: 0, overdueCount: 2 }),
      expect.objectContaining({ userId: reviewerB.userId, assignedCount: 0, completedCount: 0, overdueCount: 0 }),
    ]);

    const reminder = await request("/api/events/devflow-conf-2027/cfp/reviews/reminders", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        reviewerUserId: reviewerA.userId,
        roundId: round.id,
        templateKey: "reviewer.pending-reviews-reminder",
        idempotencyKey: "reviewer-reminder-1",
      },
    }, env);
    expect(reminder.status).toBe(201);
    const reminderData = (await reminder.json()).data;
    expect(reminderData.outboxState).toBe("queued");
    expect(reminderData.pendingAssignments).toBe(2);

    const replay = await request("/api/events/devflow-conf-2027/cfp/reviews/reminders", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        reviewerUserId: reviewerA.userId,
        roundId: round.id,
        templateKey: "reviewer.pending-reviews-reminder",
        idempotencyKey: "reviewer-reminder-1",
      },
    }, env);
    expect(replay.status).toBe(201);
    expect((await replay.json()).data.messageId).toBe(reminderData.messageId);

    const ineligible = await request("/api/events/devflow-conf-2027/cfp/reviews/reminders", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        reviewerUserId: reviewerB.userId,
        roundId: round.id,
        templateKey: "reviewer.pending-reviews-reminder",
        idempotencyKey: "reviewer-reminder-2",
      },
    }, env);
    expect(ineligible.status).toBe(409);
    expect((await ineligible.json()).error.code).toBe("REMINDER_NOT_ELIGIBLE");

    const outbox = database.prepare(
      "SELECT intent, state, actor_user_id AS actorUserId FROM message_outbox",
    ).all();
    expect(outbox).toEqual([
      { intent: "reviewer_reminder", state: "queued", actorUserId: "usr-devflow-organizer" },
    ]);
  });

  it("blocks evaluation submission after the round closes", async () => {
    const round = await createRound();
    await setPool(round.id, [reviewerA.userId]);
    const proposal = addSubmittedProposal(database, { suffix: "window" });
    const assigned = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env);
    const assignment = (await assigned.json()).data;

    const accept = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/invitation`, {
      method: "POST", cookie: reviewerA.cookie, body: { action: "accept" },
    }, env);
    expect([200, 201]).toContain(accept.status);

    database.prepare("UPDATE review_rounds SET closes_at = '2020-02-01T00:00:00Z', updated_by_user_id = 'usr-devflow-organizer', updated_at = '2020-01-02T00:00:00Z' WHERE id = ?")
      .run(round.id);

    const submit = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`, {
      method: "POST",
      cookie: reviewerA.cookie,
      body: { originality: 4, relevance: 4, recommendation: "accept", comment: "Solid work." },
    }, env);
    expect(submit.status).toBe(409);
    expect((await submit.json()).error.code).toBe("REVIEW_ROUND_NOT_OPEN");
  });

  it("uses one instant for the open-round gate and first review insert at the close boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T11:59:59.999Z"));
    try {
      const round = await createRound({
        opensAt: "2026-08-13T11:00:00Z",
        closesAt: "2026-08-13T12:00:00Z",
      });
      await setPool(round.id, [reviewerA.userId]);
      const plan = await request(`/api/events/devflow-conf-2027/cfp/review-plan?roundId=${round.id}`, {
        method: "PUT", cookie: organizerCookie, body: PLAN_BODY,
      }, env).then((response) => response.json()).then(({ data }) => data);
      const proposal = addSubmittedProposal(database, { suffix: "first-review-edge" });
      const assignment = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
        method: "POST", cookie: organizerCookie,
        body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
      }, env).then((response) => response.json()).then(({ data }) => data);
      await acceptAssignment(assignment.id, reviewerA.cookie);
      database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposal.proposalId);

      env.DB.afterEvaluationCriteriaLookup = () => vi.setSystemTime(new Date("2026-08-13T12:00:00.001Z"));
      const submitted = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`, {
        method: "POST", cookie: reviewerA.cookie,
        body: { criterionScores: plan.criteria.map((criterion) => ({ criterionId: criterion.id, score: 4 })), recommendation: "accept", comment: "Boundary-safe review." },
      }, env);

      expect(submitted.status).toBe(201);
      expect(database.prepare("SELECT submitted_at AS submittedAt FROM reviews WHERE assignment_id = ?")
        .get(assignment.id)).toEqual({ submittedAt: "2026-08-13T11:59:59Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a conflict when an organizer closes the round during first review submission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T11:30:00.000Z"));
    try {
      const round = await createRound({
        opensAt: "2026-08-13T10:00:00Z",
        closesAt: "2026-08-13T12:00:00Z",
      });
      await setPool(round.id, [reviewerA.userId]);
      const plan = await request(`/api/events/devflow-conf-2027/cfp/review-plan?roundId=${round.id}`, {
        method: "PUT", cookie: organizerCookie, body: PLAN_BODY,
      }, env).then((response) => response.json()).then(({ data }) => data);
      const proposal = addSubmittedProposal(database, { suffix: "concurrent-round-close" });
      const assignment = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
        method: "POST", cookie: organizerCookie,
        body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
      }, env).then((response) => response.json()).then(({ data }) => data);
      await acceptAssignment(assignment.id, reviewerA.cookie);
      database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposal.proposalId);

      env.DB.afterEvaluationCriteriaLookup = async () => {
        const closed = await request(`/api/events/devflow-conf-2027/cfp/review-rounds/${round.id}`, {
          method: "PATCH", cookie: organizerCookie,
          body: {
            name: round.name,
            opensAt: "2026-08-13T10:00:00Z",
            closesAt: "2026-08-13T11:00:00Z",
            blindDefault: round.blindDefault,
            expectedUpdatedAt: round.updatedAt,
          },
        }, env);
        expect(closed.status).toBe(200);
      };
      const submitted = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`, {
        method: "POST", cookie: reviewerA.cookie,
        body: { criterionScores: plan.criteria.map((criterion) => ({ criterionId: criterion.id, score: 4 })), recommendation: "accept", comment: "Concurrent-close review." },
      }, env);

      expect(submitted.status).toBe(409);
      expect((await submitted.json()).error.code).toBe("REVIEW_ROUND_NOT_OPEN");
      expect(database.prepare("SELECT COUNT(*) AS count FROM reviews WHERE assignment_id = ?").get(assignment.id).count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives an actionable error for a stale unbounded assignment after a named-round reassignment", async () => {
    const proposal = addSubmittedProposal(database, { suffix: "stale-unbounded" });
    const original = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST", cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true },
    }, env).then((response) => response.json()).then(({ data }) => data);
    await acceptAssignment(original.id, reviewerA.cookie);
    database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposal.proposalId);

    const round = await createRound();
    await setPool(round.id, [reviewerA.userId]);
    const continuation = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST", cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env);
    expect(continuation.status).toBe(201);

    const queue = await request("/api/events/devflow-conf-2027/review/assignments", { cookie: reviewerA.cookie }, env);
    expect((await queue.json()).data.assignments.filter((item) => item.proposal.publicId === "ABS-STALE-UNBOUNDED")).toHaveLength(2);

    const blocked = await request(`/api/events/devflow-conf-2027/review/assignments/${original.id}/review`, {
      method: "POST", cookie: reviewerA.cookie,
      body: { originality: 4, relevance: 4, recommendation: "accept", comment: "Attempt from stale row." },
    }, env);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toMatchObject({
      code: "REVIEW_CLOSED",
      message: "This assignment is outside any named review round. Use another assignment for this proposal if one exists; otherwise ask the organizer to revoke this one and assign you into an open named round.",
    });
  });

  it("allows an auditable correction on a decided proposal only while its named round is open", async () => {
    const round = await createRound();
    await setPool(round.id, [reviewerA.userId]);
    const proposal = addSubmittedProposal(database, { suffix: "decided-correction" });
    const assignment = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
      method: "POST",
      cookie: organizerCookie,
      body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
    }, env).then((response) => response.json()).then(({ data }) => data);
    await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/invitation`, {
      method: "POST", cookie: reviewerA.cookie, body: { action: "accept" },
    }, env);
    const reviewPath = `/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`;
    const initial = await request(reviewPath, {
      method: "POST", cookie: reviewerA.cookie,
      body: { originality: 4, relevance: 4, recommendation: "accept", comment: "Initial review." },
    }, env);
    expect(initial.status).toBe(201);
    database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposal.proposalId);

    const openDetail = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}`, {
      cookie: reviewerA.cookie,
    }, env);
    expect((await openDetail.json()).data.correctionAllowed).toBe(true);
    const corrected = await request(reviewPath, {
      method: "POST", cookie: reviewerA.cookie,
      body: { expectedRevision: 1, originality: 5, relevance: 4, recommendation: "accept", comment: "Corrected review." },
    }, env);
    expect(corrected.status).toBe(201);
    expect((await corrected.json()).data).toMatchObject({ revisionNumber: 2, originality: 5 });

    database.prepare("UPDATE review_rounds SET closes_at = '2020-02-01T00:00:00Z', updated_by_user_id = 'usr-devflow-organizer', updated_at = '2020-01-02T00:00:00Z' WHERE id = ?")
      .run(round.id);
    const closedDetail = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}`, {
      cookie: reviewerA.cookie,
    }, env);
    expect((await closedDetail.json()).data.correctionAllowed).toBe(false);
    const blocked = await request(reviewPath, {
      method: "POST", cookie: reviewerA.cookie,
      body: { expectedRevision: 2, originality: 5, relevance: 3, recommendation: "discuss", comment: "Too late." },
    }, env);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("REVIEW_ROUND_NOT_OPEN");
    expect(database.prepare("SELECT COUNT(*) AS count FROM review_corrections WHERE review_id = (SELECT id FROM reviews WHERE assignment_id = ?)")
      .get(assignment.id).count).toBe(1);
  });

  it("uses the same second-precision instant in the route and correction trigger at a round edge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T11:59:59.999Z"));
    try {
      const round = await createRound({
        opensAt: "2026-08-13T11:00:00Z",
        closesAt: "2026-08-13T12:00:00Z",
      });
      await setPool(round.id, [reviewerA.userId]);
      const plan = await request(`/api/events/devflow-conf-2027/cfp/review-plan?roundId=${round.id}`, {
        method: "PUT", cookie: organizerCookie, body: PLAN_BODY,
      }, env).then((response) => response.json()).then(({ data }) => data);
      const proposal = addSubmittedProposal(database, { suffix: "round-edge" });
      const assignment = await request(`/api/events/devflow-conf-2027/cfp/proposals/${proposal.proposalId}/assignments`, {
        method: "POST", cookie: organizerCookie,
        body: { reviewerUserId: reviewerA.userId, blind: true, reviewRoundId: round.id },
      }, env).then((response) => response.json()).then(({ data }) => data);
      await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/invitation`, {
        method: "POST", cookie: reviewerA.cookie, body: { action: "accept" },
      }, env);
      database.prepare(`INSERT INTO reviews (
        id, event_id, assignment_id, originality_score, relevance_score,
        recommendation, comment, submitted_at, review_plan_version_id, weighted_score_milli
      ) VALUES (?, 'evt-devflow', ?, 4, 4, 'accept', 'Initial review.', ?, ?, 4000)`)
        .run("review-round-edge", assignment.id, "2026-08-13T11:30:00Z", plan.versionId);
      for (const criterion of plan.criteria) {
        database.prepare("INSERT INTO review_criterion_scores (review_id, event_id, criterion_id, score) VALUES (?, 'evt-devflow', ?, 4)")
          .run("review-round-edge", criterion.id);
      }
      database.prepare("UPDATE proposals SET status = 'decided' WHERE id = ?").run(proposal.proposalId);

      env.DB.afterEvaluationCriteriaLookup = () => vi.setSystemTime(new Date("2026-08-13T12:00:00.001Z"));
      const corrected = await request(`/api/events/devflow-conf-2027/review/assignments/${assignment.id}/review`, {
        method: "POST", cookie: reviewerA.cookie,
        body: { expectedRevision: 1, criterionScores: plan.criteria.map((criterion) => ({ criterionId: criterion.id, score: 5 })), recommendation: "accept", comment: "Edge correction." },
      }, env);
      expect(corrected.status).toBe(201);
      expect(database.prepare("SELECT corrected_at AS correctedAt FROM review_corrections WHERE review_id = ?")
        .get("review-round-edge")).toEqual({ correctedAt: "2026-08-13T11:59:59Z" });
    } finally {
      vi.useRealTimers();
    }
  });
});
