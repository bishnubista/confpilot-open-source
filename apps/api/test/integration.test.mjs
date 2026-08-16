import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AcceptanceNotAllowedError,
  DEFAULT_TASKS,
  materializeAcceptance,
} from "../src/features/decisions/acceptance.ts";
import { runScheduledEmailDispatch } from "../src/app/email-dispatch.ts";
import { dispatchQueuedMessages } from "../src/features/messaging/message-outbox.ts";
import { createApp } from "../src/index.ts";

class SqliteD1Statement {
  constructor(statement, maxBoundParameters = Number.POSITIVE_INFINITY) {
    this.statement = statement;
    this.maxBoundParameters = maxBoundParameters;
    this.params = [];
  }

  bind(...params) {
    if (params.length > this.maxBoundParameters) {
      throw new Error(`D1 bound parameter limit exceeded: ${params.length}`);
    }
    const bound = new SqliteD1Statement(this.statement, this.maxBoundParameters);
    bound.params = params;
    return bound;
  }

  async all() {
    return { results: this.statement.all(...this.params), success: true, meta: {} };
  }

  async raw() {
    this.statement.setReturnArrays(true);
    return this.statement.all(...this.params);
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
  constructor(database, maxBoundParameters = Number.POSITIVE_INFINITY) {
    this.database = database;
    this.maxBoundParameters = maxBoundParameters;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database.prepare(query), this.maxBoundParameters);
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
  const migrationFiles = readdirSync(migrationsUrl)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  for (const name of migrationFiles) {
    database.exec(readFileSync(new URL(name, migrationsUrl), "utf8"));
  }
  database.exec(readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../seed/agenda.sql", import.meta.url), "utf8"));
  if (database.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
    throw new Error("Test database must enforce foreign keys");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("Seed data violates foreign keys");
  }
  return database;
}

const organizerToken = "test-devflow-organizer-session";
const organizerCookie = { Cookie: `__Host-confpilot_session=${organizerToken}` };

function addSession(database, userId, token = organizerToken, expiresAt = "2099-01-01T00:00:00Z") {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  database.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(
    `auth-${tokenHash.slice(0, 16)}`,
    userId,
    tokenHash,
    expiresAt,
    "2026-08-10T00:00:00Z",
  );
}

function addAcceptedDecisionFixture(database) {
  database.exec(`
    INSERT INTO proposals (
      id, event_id, public_id, slug, title, abstract, track, format,
      duration_minutes, status, submitted_at, created_at, updated_at
    ) VALUES (
      'prop-d-new', 'evt-devflow', 'ABS-999', 'evidence-first-agents',
      'Evidence-First Agents', 'A new accepted proposal.', 'AI Engineering', 'talk',
      30, 'decided', '2027-01-20T18:00:00Z', '2027-01-20T18:00:00Z', '2027-02-20T18:00:00Z'
    );
    INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role) VALUES
      ('pp-d-new-primary', 'evt-devflow', 'prop-d-new', 'spk-d-priya', 'primary'),
      ('pp-d-new-co', 'evt-devflow', 'prop-d-new', 'spk-d-marcus', 'co_presenter');
    INSERT INTO decisions (
      id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
    ) VALUES (
      'dec-d-new', 'evt-devflow', 'prop-d-new', 'accept', 'Strong evidence.',
      'usr-devflow-organizer', '2027-02-20T18:00:00Z'
    );
  `);
}

const acceptanceInput = {
  eventId: "evt-devflow",
  decisionId: "dec-d-new",
  acceptedByUserId: "usr-devflow-organizer",
  acceptedAt: "2027-02-20T18:01:00Z",
};

function addDecisionCandidate(database, suffix, { coPresenter = false, activeAssignment = false, primary = true } = {}) {
  database.exec(`
    INSERT INTO proposals (
      id, event_id, owner_user_id, public_id, slug, title, abstract, track, format,
      duration_minutes, status, submitted_at, created_at, updated_at
    ) VALUES (
      'prop-decision-${suffix}', 'evt-devflow', 'usr-d-priya', 'ABS-DEC-${suffix}',
      'decision-${suffix}', 'Decision candidate ${suffix}', 'A decision workflow candidate.',
      'AI Engineering', 'talk', 30, 'submitted', '2027-02-20T18:00:00Z',
      '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z'
    );
    ${primary ? `INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('pp-decision-${suffix}-primary', 'evt-devflow', 'prop-decision-${suffix}', 'spk-d-priya', 'primary');` : ""}
    ${coPresenter ? `INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('pp-decision-${suffix}-co', 'evt-devflow', 'prop-decision-${suffix}', 'spk-d-marcus', 'co_presenter');` : ""}
  `);
  if (activeAssignment) {
    database.exec(`
      INSERT OR IGNORE INTO users (id, email, display_name, created_at)
      VALUES ('usr-decision-reviewer', 'decision-reviewer@devflow.example', 'Decision Reviewer', '2027-02-20T18:00:00Z');
      INSERT OR IGNORE INTO event_memberships (id, event_id, user_id, role, created_at)
      VALUES ('mem-decision-reviewer', 'evt-devflow', 'usr-decision-reviewer', 'reviewer', '2027-02-20T18:00:00Z');
      INSERT INTO review_assignments (
        id, event_id, proposal_id, reviewer_user_id, created_by_user_id, round, blind,
        state, due_at, revoked_at, revoked_by_user_id, created_at, updated_at
      ) VALUES (
        'assignment-decision-${suffix}', 'evt-devflow', 'prop-decision-${suffix}',
        'usr-decision-reviewer', 'usr-devflow-organizer', 1, 1, 'assigned', NULL,
        NULL, NULL, '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z'
      );
    `);
  }
  return `prop-decision-${suffix}`;
}

function decisionRequest(env, path, { method = "GET", body, cookie = organizerCookie, safe = true } = {}) {
  return createApp().request(`https://confpilot.test${path}`, {
    method,
    headers: {
      ...cookie,
      ...(safe && method !== "GET" ? { Origin: "https://confpilot.test", "x-confpilot-request": "1", "content-type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

describe("event-scoped API contracts", () => {
  let database;
  let env;

  beforeEach(() => {
    database = fixtureDatabase();
    addSession(database, "usr-devflow-organizer");
    env = { DB: new SqliteD1Database(database) };
  });

  afterEach(() => database.close());

  it("returns the complete published event projection in chronological order", async () => {
    const response = await createApp().request("/api/events", undefined, env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      {
        slug: "devflow-conf-2027",
        name: "DevFlow Conf 2027",
        tagline: "The developer workflow conference",
        location: "Moscone West, San Francisco, CA",
        description: "A three-day, three-track conference on developer tooling, AI-assisted engineering, and platform infrastructure.",
        startsOn: "2027-05-12",
        endsOn: "2027-05-14",
        cfpDeadline: "2027-04-30T23:59:00Z",
        status: "published",
      },
      {
        slug: "field-notes-2027",
        name: "Field Notes 2027",
        tagline: "Build gatherings people remember",
        location: "Oakland Convention Center, Oakland, CA",
        description: "A practical gathering for independent organizers and program teams.",
        startsOn: "2027-09-08",
        endsOn: "2027-09-10",
        cfpDeadline: "2027-05-15T23:59:00Z",
        status: "published",
      },
    ]);
  });

  it("queues an exact selected speaker audience and exposes truthful event-scoped history", async () => {
    const input = {
      speakerIds: ["spk-d-priya", "spk-f-lina"],
      subject: "{first_name}: {session_title}",
      body: "Hello {first_name}, open {portal_link} to review the latest program details.",
      idempotencyKey: "bulk-speaker-update-1",
    };
    const queued = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: input,
    });
    const queuedBody = await queued.json();

    expect(queued.status).toBe(201);
    expect(queuedBody.data).toMatchObject({
      requestedCount: 2,
      queuedCount: 1,
      skipped: [{ speakerId: "spk-f-lina", reason: "not_found" }],
    });
    expect(database.prepare(`SELECT event_id AS eventId, actor_user_id AS actorUserId,
      recipient_email AS recipientEmail, subject, text_body AS text, state
      FROM message_outbox WHERE intent = 'speaker_bulk'`).get())
      .toEqual({
        eventId: "evt-devflow",
        actorUserId: "usr-devflow-organizer",
        recipientEmail: "priya@devflow.example",
        subject: "Priya: Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
        text: "Hello Priya, open https://confpilot.test/events/devflow-conf-2027/speaker to review the latest program details.\n\nThis message was sent by an organizer through ConfPilot.",
        state: "queued",
      });

    const replay = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: input,
    });
    expect((await replay.json()).data.messageIds).toEqual(queuedBody.data.messageIds);
    expect(database.prepare("SELECT COUNT(*) AS value FROM message_outbox WHERE intent = 'speaker_bulk'").get().value).toBe(1);

    const history = await decisionRequest(env, "/api/events/devflow-conf-2027/communications");
    expect(history.status).toBe(200);
    expect((await history.json()).data).toMatchObject({
      capability: { enabled: false, provider: null, reason: "delivery_disabled" },
      messages: [expect.objectContaining({
        id: queuedBody.data.messageIds[0],
        transportStatus: "queued",
        deliveryStatus: "not_attempted",
        recipient: { name: "Priya Raman", email: "priya@devflow.example" },
      })],
    });
  });

  it("reports provider acceptance without claiming inbox delivery", async () => {
    const queued = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: {
        speakerIds: ["spk-d-priya"],
        subject: "Accepted by provider",
        body: "This message has transport evidence only.",
        idempotencyKey: "provider-acceptance-1",
      },
    });
    expect(queued.status).toBe(201);
    await dispatchQueuedMessages(env.DB, {
      capability: {
        enabled: true,
        provider: "synthetic-provider",
        reason: "configured",
        sendAfter: "1970-01-01T00:00:00Z",
      },
      sender: { send: async () => ({ ok: true, provider: "synthetic-provider", providerMessageId: "provider-1" }) },
    }, { now: "2099-08-13T09:00:00Z" });

    const history = await decisionRequest(env, "/api/events/devflow-conf-2027/communications");
    const item = (await history.json()).data.messages[0];
    expect(item).toMatchObject({
      transportStatus: "provider_accepted",
      deliveryStatus: "unverified",
      provider: "synthetic-provider",
      providerMessageId: "provider-1",
      providerAcceptedAt: "2099-08-13T09:00:00Z",
    });
    expect(JSON.stringify(item)).not.toMatch(/inbox|delivered/i);
  });

  it("uses the same deterministic session order as the organizer roster for merge fields", async () => {
    addAcceptedDecisionFixture(database);
    database.prepare(`INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('pp-d-new-maya', 'evt-devflow', 'prop-d-new', 'spk-d-maya', 'co_presenter')`).run();
    await materializeAcceptance(env.DB, acceptanceInput);
    database.prepare(`DELETE FROM schedule_placements WHERE event_id = 'evt-devflow'
      AND program_session_id = 'ses-d-5'`).run();

    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: {
        speakerIds: ["spk-d-maya"],
        subject: "{session_title}",
        body: "Review {session_title} in {portal_link}.",
        idempotencyKey: "merge-session-order-1",
      },
    });

    expect(response.status).toBe(201);
    expect(database.prepare(`SELECT subject, text_body AS text FROM message_outbox
      WHERE intent = 'speaker_bulk' AND recipient_email = 'maya@devflow.example'`).get()).toEqual({
      subject: "Evidence-First Agents",
      text: "Hello Maya Chen,\n\nReview Evidence-First Agents in https://confpilot.test/events/devflow-conf-2027/speaker.\n\nThis message was sent by an organizer through ConfPilot.",
    });
  });

  it("rejects an oversized personalized snapshot before inserting any recipient", async () => {
    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: {
        speakerIds: ["spk-d-maya", "spk-d-priya"],
        subject: "{session_title}".repeat(20),
        body: "Review your session.",
        idempotencyKey: "merge-result-too-long-1",
      },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      code: "COMMUNICATION_MERGE_RESULT_INVALID",
      issues: [{ field: "subject" }],
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE intent = 'speaker_bulk'").get())
      .toEqual({ count: 0 });
  });

  it("rolls back every recipient when a later bulk enqueue insert fails", async () => {
    database.exec(`CREATE TRIGGER fail_second_bulk_recipient
      BEFORE INSERT ON message_outbox
      WHEN NEW.intent = 'speaker_bulk' AND NEW.recipient_email = 'maya@devflow.example'
      BEGIN SELECT RAISE(ABORT, 'injected bulk enqueue failure'); END`);

    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: {
        speakerIds: ["spk-d-priya", "spk-d-maya"],
        subject: "Atomic bulk message",
        body: "No recipient should remain queued after a later insert fails.",
        idempotencyKey: "bulk-atomic-failure-1",
      },
    });

    expect(response.status).toBe(500);
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE intent = 'speaker_bulk'").get())
      .toEqual({ count: 0 });
  });

  it("keeps a 250-speaker audience below D1's 100-parameter query ceiling", async () => {
    const limitedEnv = { DB: new SqliteD1Database(database, 100) };
    const speakerIds = ["spk-d-priya", ...Array.from({ length: 249 }, (_, index) => `missing-speaker-${index}`)];
    const queued = await decisionRequest(
      limitedEnv,
      "/api/events/devflow-conf-2027/communications/speakers/bulk",
      {
        method: "POST",
        body: {
          speakerIds,
          subject: "Bounded audience lookup",
          body: "This request exercises the maximum contract audience.",
          idempotencyKey: "bulk-speaker-limit-250",
        },
      },
    );
    const body = await queued.json();
    expect(queued.status).toBe(201);
    expect(body.data).toMatchObject({ requestedCount: 250, queuedCount: 1 });
    expect(body.data.skipped).toHaveLength(249);
  });

  it("accounts truthfully for a per-recipient idempotency conflict after earlier inserts", async () => {
    const first = {
      speakerIds: ["spk-d-marcus"],
      subject: "Stable request",
      body: "The body stays stable while one recipient snapshot changes.",
      idempotencyKey: "bulk-partial-conflict-1",
    };
    expect((await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST", body: first,
    })).status).toBe(201);
    database.prepare(`UPDATE speakers SET name = 'Marcus Updated', revision = revision + 1,
      updated_at = '2098-01-01T00:00:00Z' WHERE id = 'spk-d-marcus'`).run();

    const replay = await decisionRequest(env, "/api/events/devflow-conf-2027/communications/speakers/bulk", {
      method: "POST",
      body: { ...first, speakerIds: ["spk-d-priya", "spk-d-marcus"] },
    });
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toMatchObject({
      requestedCount: 2,
      queuedCount: 1,
      skipped: [{ speakerId: "spk-d-marcus", reason: "idempotency_conflict" }],
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE intent = 'speaker_bulk'").get())
      .toEqual({ count: 2 });
  });

  it("protects communication history by organizer role and event", async () => {
    const anonymous = await decisionRequest(env, "/api/events/devflow-conf-2027/communications", { cookie: {} });
    addSession(database, "usr-devflow-reviewer", "reviewer-communications-session");
    const reviewer = await decisionRequest(env, "/api/events/devflow-conf-2027/communications", {
      cookie: { Cookie: "__Host-confpilot_session=reviewer-communications-session" },
    });

    expect(anonymous.status).toBe(401);
    expect(reviewer.status).toBe(403);
  });

  it("lets an existing organizer atomically create a draft event and organizer membership", async () => {
    const input = {
      slug: "community-conf-2028",
      name: "Community Conf 2028",
      tagline: "A practical gathering",
      location: "Oakland, CA",
      description: "A community-run event.",
      startsOn: "2028-09-08",
      endsOn: "2028-09-10",
      timeZone: "America/Los_Angeles",
      cfpOpensAt: "2028-01-15T18:00:00Z",
      cfpClosesAt: "2028-05-15T23:59:00Z",
      initialTrack: "Programming",
    };
    const response = await decisionRequest(env, "/api/events", { method: "POST", body: input });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.event).toEqual({ slug: input.slug, name: input.name, status: "draft" });
    expect(body.data.session.memberships).toContainEqual({ eventSlug: input.slug, role: "organizer" });
    expect(database.prepare(`SELECT slug, status, time_zone AS timeZone
      FROM events WHERE slug = ?`).get(input.slug)).toEqual({
      slug: input.slug,
      status: "draft",
      timeZone: input.timeZone,
    });
    expect(database.prepare(`SELECT membership.role
      FROM event_memberships AS membership
      INNER JOIN events AS event ON event.id = membership.event_id
      WHERE event.slug = ? AND membership.user_id = ?`).get(input.slug, "usr-devflow-organizer"))
      .toEqual({ role: "organizer" });
    expect(database.prepare(`SELECT cfp_configs.status, opens_at AS opensAt, closes_at AS closesAt
      FROM cfp_configs
      INNER JOIN events ON events.id = cfp_configs.event_id
      WHERE events.slug = ?`).get(input.slug)).toEqual({
      status: "draft",
      opensAt: input.cfpOpensAt,
      closesAt: input.cfpClosesAt,
    });
    expect(database.prepare(`SELECT field_key AS fieldKey
      FROM cfp_fields
      INNER JOIN events ON events.id = cfp_fields.event_id
      WHERE events.slug = ? ORDER BY sort_order`).all(input.slug).map((row) => row.fieldKey))
      .toEqual(["title", "abstract", "track", "format"]);
  });

  it("fails event creation closed for anonymous and non-organizer accounts", async () => {
    const input = {
      slug: "blocked-conf-2028",
      name: "Blocked Conf 2028",
      tagline: "",
      location: "",
      description: "",
      startsOn: "2028-09-08",
      endsOn: "2028-09-10",
      timeZone: "UTC",
      cfpOpensAt: "2028-01-15T18:00:00Z",
      cfpClosesAt: "2028-05-15T23:59:00Z",
      initialTrack: "General",
    };
    const anonymous = await decisionRequest(env, "/api/events", {
      method: "POST",
      body: input,
      cookie: {},
    });
    addSession(database, "usr-devflow-reviewer", "reviewer-create-session");
    const reviewer = await decisionRequest(env, "/api/events", {
      method: "POST",
      body: input,
      cookie: { Cookie: "__Host-confpilot_session=reviewer-create-session" },
    });

    expect(anonymous.status).toBe(401);
    expect(reviewer.status).toBe(403);
    expect(database.prepare("SELECT COUNT(*) AS value FROM events WHERE slug = ?").get(input.slug).value).toBe(0);
  });

  it("returns a stable conflict without adding another membership when an event slug exists", async () => {
    const response = await decisionRequest(env, "/api/events", {
      method: "POST",
      body: {
        slug: "devflow-conf-2027",
        name: "Duplicate",
        tagline: "",
        location: "",
        description: "",
        startsOn: "2028-09-08",
        endsOn: "2028-09-10",
        timeZone: "UTC",
        cfpOpensAt: "2028-01-15T18:00:00Z",
        cfpClosesAt: "2028-05-15T23:59:00Z",
        initialTrack: "General",
      },
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("EVENT_SLUG_TAKEN");
    expect(database.prepare(`SELECT COUNT(*) AS value
      FROM event_memberships WHERE event_id = 'evt-devflow' AND user_id = 'usr-devflow-organizer'`).get().value).toBe(1);
  });

  it("publishes only accepted sessions that still satisfy every readiness invariant", async () => {
    const response = await createApp().request(
      "/api/program?event=devflow-conf-2027",
      undefined,
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.sessions).toHaveLength(5);
    expect(body.data.sessions.map((session) => session.slug)).toEqual([
      "workflows-that-explain-themselves",
      "taming-40-minute-ci",
      "ai-pair-programmer-verification",
      "docs-that-answer-back",
      "boring-path-to-reliability",
    ]);
    expect(body.data.sessions.map((session) => session.slug)).not.toContain("evals-you-can-trust");
    expect(body.data.sessions.map((session) => session.slug)).not.toContain("maintainers-at-scale");

    const ciSession = body.data.sessions.find((session) => session.slug === "taming-40-minute-ci");
    expect(ciSession.speakers.map((speaker) => speaker.name)).toEqual([
      "Priya Raman",
      "Marcus Okafor",
    ]);
  });

  it("does not leak sessions across event boundaries", async () => {
    const response = await createApp().request(
      "/api/program?event=field-notes-2027",
      undefined,
      env,
    );
    const body = await response.json();

    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0].slug).toBe("programs-with-a-point-of-view");
    expect(JSON.stringify(body)).not.toContain("Priya Raman");
    expect(JSON.stringify(body)).not.toContain("devflow-conf-2027");
  });

  it("does not expose an unpublished event through anonymous program endpoints", async () => {
    database.exec("UPDATE events SET status = 'draft' WHERE slug = 'field-notes-2027'");

    const programResponse = await createApp().request(
      "/api/program?event=field-notes-2027",
      undefined,
      env,
    );
    const speakersResponse = await createApp().request(
      "/api/program/speakers?event=field-notes-2027",
      undefined,
      env,
    );
    const eventsResponse = await createApp().request("/api/events", undefined, env);
    const eventsBody = await eventsResponse.json();

    expect(programResponse.status).toBe(404);
    expect(speakersResponse.status).toBe(404);
    expect(eventsBody.data.map((event) => event.slug)).not.toContain("field-notes-2027");
  });

  it("keeps program decisions distinct from notification delivery", async () => {
    const response = await createApp().request(
      "/api/events/devflow-conf-2027/decisions",
      { headers: organizerCookie },
      env,
    );
    const body = await response.json();
    const docsDecision = body.data.decisions.find(
      (item) => item.proposal.slug === "docs-that-answer-back",
    );

    expect(body.data.decisions).toHaveLength(8);
    expect(docsDecision.decision.value).toBe("accept");
    expect(docsDecision.notification.status).toBe("queued");
  });

  it("protects exact and wildcard decision routes and validates same-origin mutations", async () => {
    const proposalId = addDecisionCandidate(database, "security");
    const list = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", { cookie: {} });
    const preview = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions/missing/notification-preview", { cookie: {} });
    const unsafe = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", safe: false, body: { proposalId, decision: "accept", rationale: "Strong evidence." },
    });
    const invalid = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision: "accept", rationale: "   ", extra: true },
    });

    expect(list.status).toBe(401);
    expect(preview.status).toBe(401);
    expect(unsafe.status).toBe(403);
    expect((await unsafe.json()).error.code).toBe("UNSAFE_REQUEST_REJECTED");
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_FAILED");
    expect(database.prepare("SELECT COUNT(*) AS count FROM decisions WHERE proposal_id = ?").get(proposalId).count).toBe(0);
  });

  it("does not resolve proposal or decision identifiers from another event", async () => {
    const foreignProposal = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      body: { proposalId: "prop-f-1", decision: "accept", rationale: "Must remain event scoped." },
    });
    const foreignDecision = await decisionRequest(
      env,
      "/api/events/devflow-conf-2027/decisions/dec-f-1/notification-preview",
    );

    expect(foreignProposal.status).toBe(404);
    expect((await foreignProposal.json()).error.code).toBe("DECISION_NOT_FOUND");
    expect(foreignDecision.status).toBe(404);
    expect((await foreignDecision.json()).error.code).toBe("DECISION_NOT_FOUND");
    expect(database.prepare("SELECT decision FROM decisions WHERE id = 'dec-f-1'").get().decision).toBe("accept");
  });

  it("records an acceptance and its full handoff in one batch without queuing notification", async () => {
    const proposalId = addDecisionCandidate(database, "accept", { coPresenter: true, activeAssignment: true });
    const originalBatch = env.DB.batch.bind(env.DB);
    let batchCount = 0;
    env.DB.batch = async (statements) => {
      batchCount += 1;
      return originalBatch(statements);
    };
    const payload = { proposalId, decision: "accept", rationale: "  Strong program fit.  " };
    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", { method: "POST", body: payload });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      proposal: { id: proposalId, slug: "decision-accept" },
      decision: { value: "accept", rationale: "Strong program fit." },
      handoff: { status: "materialized" },
      notification: { status: "not_queued" },
    });
    expect(batchCount).toBe(1);
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposalId).status).toBe("decided");
    expect(database.prepare("SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = ?").get(proposalId).count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_presenters WHERE program_session_id = ?").get(body.data.handoff.programSession.id).count).toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speaker_tasks WHERE program_session_id = ?").get(body.data.handoff.programSession.id).count).toBe(8);
    expect(database.prepare(`SELECT MIN(revision) AS minRevision, MAX(revision) AS maxRevision,
      SUM(CASE WHEN updated_at = created_at THEN 1 ELSE 0 END) AS timestampMatches,
      SUM(CASE WHEN created_by_user_id = 'usr-devflow-organizer' THEN 1 ELSE 0 END) AS actorMatches
      FROM speaker_tasks WHERE program_session_id = ?`).get(body.data.handoff.programSession.id)).toEqual({
      minRevision: 1,
      maxRevision: 1,
      timestampMatches: 8,
      actorMatches: 8,
    });
    expect(database.prepare("SELECT state, revoked_by_user_id AS actor FROM review_assignments WHERE id = 'assignment-decision-accept'").get()).toEqual({ state: "revoked", actor: "usr-devflow-organizer" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE decision_id = ?").get(body.data.decision.id).count).toBe(0);

    const retry = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", { method: "POST", body: payload });
    expect(retry.status).toBe(201);
    expect((await retry.json()).data.decision.id).toBe(body.data.decision.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM decisions WHERE proposal_id = ?").get(proposalId).count).toBe(1);
    const changed = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { ...payload, decision: "reject" },
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe("DECISION_ALREADY_RECORDED");
  });

  it("reuses a pre-existing canonical program session when recording the first acceptance", async () => {
    const proposalId = addDecisionCandidate(database, "existing-session");
    database.prepare(
      `INSERT INTO program_sessions (
        id, event_id, source_proposal_id, slug, title, abstract, track, format,
        duration_minutes, publication_status, deliverables_status, approval_status,
        created_at, updated_at
      ) VALUES (?, 'evt-devflow', ?, 'existing-session', 'Existing session',
        'A canonical session created before the acceptance.', 'AI Engineering', 'talk',
        30, 'private', 'missing', 'pending', '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z')`,
    ).run("session-existing-canonical", proposalId);

    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      body: { proposalId, decision: "accept", rationale: "Reuse the canonical handoff." },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.handoff).toMatchObject({
      status: "materialized",
      programSession: { id: "session-existing-canonical", slug: "existing-session" },
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = ?").get(proposalId).count).toBe(1);
    expect(database.prepare("SELECT program_session_id AS sessionId FROM acceptances WHERE proposal_id = ?").get(proposalId).sessionId).toBe("session-existing-canonical");
    expect(database.prepare("SELECT COUNT(*) AS count FROM speaker_tasks WHERE program_session_id = 'session-existing-canonical'").get().count).toBe(4);
  });

  it("does not record an acceptance without an owner-primary recipient link", async () => {
    const proposalId = addDecisionCandidate(database, "recipient-accept");
    database.prepare("UPDATE proposals SET owner_user_id = NULL WHERE id = ?").run(proposalId);

    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      body: { proposalId, decision: "accept", rationale: "Must remain notifiable before becoming immutable." },
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("NOTIFICATION_NOT_ALLOWED");
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposalId).status).toBe("submitted");
    expect(database.prepare("SELECT COUNT(*) AS count FROM decisions WHERE proposal_id = ?").get(proposalId).count).toBe(0);
  });

  it.each(["reject", "waitlist"])("records %s without a recipient but blocks notification", async (decision) => {
    const proposalId = addDecisionCandidate(database, `recipient-${decision}`);
    database.prepare("UPDATE proposals SET owner_user_id = ? WHERE id = ?")
      .run("usr-d-marcus", proposalId);

    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      body: { proposalId, decision, rationale: "The program decision must remain independent of delivery." },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.decision.value).toBe(decision);
    expect(body.data.notification).toEqual({ status: "not_queued" });
    const preview = await decisionRequest(
      env,
      `/api/events/devflow-conf-2027/decisions/${body.data.decision.id}/notification-preview`,
    );
    expect(preview.status).toBe(409);
    expect((await preview.json()).error.code).toBe("NOTIFICATION_NOT_ALLOWED");
  });

  it("converges concurrent identical decision requests on one immutable decision", async () => {
    const proposalId = addDecisionCandidate(database, "race");
    const request = () => decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision: "accept", rationale: "Same semantic request." },
    });
    const [first, second] = await Promise.all([request(), request()]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await first.json()).data.decision.id).toBe((await second.json()).data.decision.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM decisions WHERE proposal_id = ?").get(proposalId).count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM acceptances WHERE proposal_id = ?").get(proposalId).count).toBe(1);
  });

  it.each(["reject", "waitlist"])("records %s without materializing an accepted session", async (decision) => {
    const proposalId = addDecisionCandidate(database, decision, { activeAssignment: true });
    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision, rationale: `${decision} rationale` },
    });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.data.handoff).toEqual({ status: "not_applicable" });
    expect(body.data.notification).toEqual({ status: "not_queued" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = ?").get(proposalId).count).toBe(0);
    expect(database.prepare("SELECT state FROM review_assignments WHERE id = ?").get(`assignment-decision-${decision}`).state).toBe("revoked");
  });

  it("rolls back the decision when an acceptance handoff cannot be created", async () => {
    const proposalId = addDecisionCandidate(database, "no-primary", { primary: false });
    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision: "accept", rationale: "Cannot materialize." },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ACCEPTANCE_NOT_ALLOWED");
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposalId).status).toBe("submitted");
    expect(database.prepare("SELECT COUNT(*) AS count FROM decisions WHERE proposal_id = ?").get(proposalId).count).toBe(0);
  });

  it("rolls back every first-accept write when a later batch statement fails", async () => {
    const proposalId = addDecisionCandidate(database, "batch-failure", { activeAssignment: true });
    const originalBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = (statements) => originalBatch([
      ...statements,
      env.DB.prepare("INSERT INTO decisions (id) VALUES ('forced-late-failure')"),
    ]);
    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision: "accept", rationale: "Must roll back." },
    });
    expect(response.status).toBe(500);
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(proposalId).status).toBe("submitted");
    expect(database.prepare("SELECT COUNT(*) AS count FROM decisions WHERE proposal_id = ?").get(proposalId).count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = ?").get(proposalId).count).toBe(0);
    expect(database.prepare("SELECT state FROM review_assignments WHERE id = 'assignment-decision-batch-failure'").get().state).toBe("assigned");
  });

  it("previews without writing and queues the exact editable snapshot for accept and reject", async () => {
    for (const decision of ["accept", "reject"]) {
      const proposalId = addDecisionCandidate(database, `notice-${decision}`);
      const recorded = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
        method: "POST", body: { proposalId, decision, rationale: `Internal ${decision} rationale must stay private.` },
      });
      const recordedBody = await recorded.json();
      const decisionId = recordedBody.data.decision.id;
      const preview = await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification-preview`);
      const previewBody = await preview.json();
      expect(preview.status).toBe(200);
      expect(previewBody.data.body).not.toContain("Internal");
      expect(previewBody.data.body).toContain(decision === "accept"
        ? "has been accepted to DevFlow Conf 2027."
        : "was not selected for DevFlow Conf 2027.");
      expect(database.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE decision_id = ?").get(decisionId).count).toBe(0);

      const snapshot = { subject: `Edited ${decision} subject`, body: `Edited ${decision} body` };
      const queued = await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, { method: "POST", body: snapshot });
      const queuedBody = await queued.json();
      expect(queued.status).toBe(201);
      expect(queuedBody.data).toMatchObject({ status: "queued", ...snapshot });
      const stored = database.prepare("SELECT subject, body, state FROM notification_outbox WHERE decision_id = ?").get(decisionId);
      expect(stored).toEqual({ ...snapshot, state: "pending" });

      const replay = await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, { method: "POST", body: snapshot });
      expect(replay.status).toBe(201);
      expect((await replay.json()).data.id).toBe(queuedBody.data.id);
      if (decision === "reject") {
        database.prepare("UPDATE speakers SET user_id = NULL WHERE id = ?")
          .run(queuedBody.data.recipient.speakerId);
        const replayAfterUnlink = await decisionRequest(
          env,
          `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`,
          { method: "POST", body: snapshot },
        );
        expect(replayAfterUnlink.status).toBe(201);
        expect((await replayAfterUnlink.json()).data).toEqual(queuedBody.data);
      }
      const changed = await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, {
        method: "POST", body: { ...snapshot, body: "Changed after queue" },
      });
      expect(changed.status).toBe(409);
      expect((await changed.json()).error.code).toBe("NOTIFICATION_ALREADY_QUEUED");
    }
  });

  it("bridges a queued decision exactly once and exposes only provider acceptance", async () => {
    database.prepare(`UPDATE notification_outbox
      SET state = 'failed', failure_message = 'Fixture terminal state.'
      WHERE state = 'pending'`).run();
    const proposalId = addDecisionCandidate(database, "provider-accepted");
    const recorded = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      body: { proposalId, decision: "reject", rationale: "Private rationale." },
    });
    const decisionId = (await recorded.json()).data.decision.id;
    const snapshot = { subject: "Program decision", body: "Thank you for your proposal." };
    await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, {
      method: "POST", body: snapshot,
    });

    await expect(runScheduledEmailDispatch({ ...env, EMAIL_DELIVERY_ENABLED: "false" }, Date.parse("2099-01-01T00:00:00Z")))
      .resolves.toEqual({ status: "disabled", reason: "delivery_disabled" });
    expect(database.prepare("SELECT state FROM notification_outbox WHERE decision_id = ?").get(decisionId))
      .toEqual({ state: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE intent = 'decision_notification'").get())
      .toEqual({ count: 0 });

    const sentMessages = [];
    const deliveryEnv = {
      ...env,
      EMAIL: { async send(message) { sentMessages.push(message); return { messageId: "provider-decision-1" }; } },
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_SEND_AFTER: "2026-01-01T00:00:00Z",
      EMAIL_FROM_ADDRESS: "program@confpilot.example",
      EMAIL_FROM_NAME: "ConfPilot Program Team",
    };
    await expect(runScheduledEmailDispatch(deliveryEnv, Date.parse("2099-01-01T00:00:00Z")))
      .resolves.toEqual({
        status: "dispatched",
        bridge: { bridged: 1, failed: 0 },
        summary: { providerAccepted: 1, retried: 0, failed: 0, recovered: 0, skipped: 0 },
      });
    expect(sentMessages).toEqual([expect.objectContaining({
      to: "priya@devflow.example",
      subject: snapshot.subject,
      text: snapshot.body,
    })]);
    expect(database.prepare(`SELECT state, sent_at AS sentAt
      FROM notification_outbox WHERE decision_id = ?`).get(decisionId)).toEqual({
      state: "sent", sentAt: "2099-01-01T00:00:00Z",
    });
    expect(database.prepare(`SELECT state, actor_user_id AS actorUserId, intent,
        recipient_email AS recipientEmail, subject, text_body AS body
      FROM message_outbox WHERE intent = 'decision_notification'`).get()).toEqual({
      state: "delivered",
      actorUserId: null,
      intent: "decision_notification",
      recipientEmail: "priya@devflow.example",
      ...snapshot,
    });

    const listed = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions");
    const projection = (await listed.json()).data.decisions.find((item) => item.decision.id === decisionId);
    expect(projection.notification).toMatchObject({
      status: "provider_accepted",
      providerAcceptedAt: "2099-01-01T00:00:00Z",
    });
    expect(projection.notification).not.toHaveProperty("sentAt");

    await runScheduledEmailDispatch(deliveryEnv, Date.parse("2099-01-01T00:05:00Z"));
    expect(sentMessages).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE intent = 'decision_notification'").get())
      .toEqual({ count: 1 });
  });

  it("records a terminal provider rejection without leaking provider details", async () => {
    database.prepare(`UPDATE notification_outbox
      SET state = 'failed', failure_message = 'Fixture terminal state.'
      WHERE state = 'pending'`).run();
    const proposalId = addDecisionCandidate(database, "provider-failed");
    const recorded = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST",
      body: { proposalId, decision: "waitlist", rationale: "Private rationale." },
    });
    const decisionId = (await recorded.json()).data.decision.id;
    await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, {
      method: "POST", body: { subject: "Program decision", body: "We will keep you updated." },
    });
    const privateProviderError = Object.assign(new Error("private provider response for priya@devflow.example"), {
      code: "E_BAD_REQUEST",
    });

    await expect(runScheduledEmailDispatch({
      ...env,
      EMAIL: { async send() { throw privateProviderError; } },
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_SEND_AFTER: "2026-01-01T00:00:00Z",
      EMAIL_FROM_ADDRESS: "program@confpilot.example",
      EMAIL_FROM_NAME: "ConfPilot Program Team",
    }, Date.parse("2099-01-01T00:00:00Z"))).resolves.toEqual({
      status: "dispatched",
      bridge: { bridged: 1, failed: 0 },
      summary: { providerAccepted: 0, retried: 0, failed: 1, recovered: 0, skipped: 0 },
    });
    expect(database.prepare(`SELECT state, failure_message AS failureMessage
      FROM notification_outbox WHERE decision_id = ?`).get(decisionId)).toEqual({
      state: "failed", failureMessage: "Provider dispatch failed (E_BAD_REQUEST).",
    });
    const listed = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions");
    const projection = (await listed.json()).data.decisions.find((item) => item.decision.id === decisionId);
    expect(projection.notification).toMatchObject({
      status: "failed", failureMessage: "Provider dispatch failed (E_BAD_REQUEST).",
    });
    expect(JSON.stringify(projection.notification)).not.toContain("private provider response");
  });

  it("isolates an invalid legacy notification without stalling unrelated delivery", async () => {
    database.prepare(`UPDATE notification_outbox
      SET state = 'failed', failure_message = 'Fixture terminal state.'
      WHERE state = 'pending'`).run();
    const decisionIds = [];
    for (const suffix of ["poisoned", "healthy"]) {
      const proposalId = addDecisionCandidate(database, suffix);
      const recorded = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
        method: "POST", body: { proposalId, decision: "reject", rationale: "Private rationale." },
      });
      const decisionId = (await recorded.json()).data.decision.id;
      decisionIds.push(decisionId);
      await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, {
        method: "POST", body: { subject: `Decision ${suffix}`, body: `Notification ${suffix}.` },
      });
    }
    database.exec("DROP TRIGGER notification_outbox_content_immutable_update");
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare("UPDATE notification_outbox SET recipient_email = 'invalid' WHERE decision_id = ?")
      .run(decisionIds[0]);
    database.exec("PRAGMA ignore_check_constraints = OFF");

    const sent = [];
    await expect(runScheduledEmailDispatch({
      ...env,
      EMAIL: { async send(message) { sent.push(message); return { messageId: "provider-healthy" }; } },
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_SEND_AFTER: "2026-01-01T00:00:00Z",
      EMAIL_FROM_ADDRESS: "program@confpilot.example",
      EMAIL_FROM_NAME: "ConfPilot Program Team",
    }, Date.parse("2099-01-01T00:00:00Z"))).resolves.toEqual({
      status: "dispatched",
      bridge: { bridged: 1, failed: 1 },
      summary: { providerAccepted: 1, retried: 0, failed: 0, recovered: 0, skipped: 0 },
    });
    expect(sent).toEqual([expect.objectContaining({ subject: "Decision healthy" })]);
    expect(database.prepare(`SELECT state, failure_message AS failureMessage
      FROM notification_outbox WHERE decision_id = ?`).get(decisionIds[0])).toEqual({
      state: "failed",
      failureMessage: "Notification could not be prepared for provider dispatch (INVALID_SNAPSHOT).",
    });
  });

  it("leaves a legacy notification pending when its bridge hits a transient database error", async () => {
    database.prepare(`UPDATE notification_outbox
      SET state = 'failed', failure_message = 'Fixture terminal state.'
      WHERE state = 'pending'`).run();
    const proposalId = addDecisionCandidate(database, "transient-bridge");
    const recorded = await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision: "reject", rationale: "Private rationale." },
    });
    const decisionId = (await recorded.json()).data.decision.id;
    await decisionRequest(env, `/api/events/devflow-conf-2027/decisions/${decisionId}/notification`, {
      method: "POST", body: { subject: "Decision retry", body: "Retry this bridge later." },
    });

    const transientDb = {
      prepare(query) {
        const statement = env.DB.prepare(query);
        if (!query.includes("INSERT INTO message_outbox")) return statement;
        return {
          bind(...params) {
            statement.bind(...params);
            return { async run() { throw new Error("transient D1 unavailable"); } };
          },
        };
      },
    };
    await expect(runScheduledEmailDispatch({
      ...env,
      DB: transientDb,
      EMAIL: { async send() { return { messageId: "must-not-send" }; } },
      EMAIL_DELIVERY_ENABLED: "true",
      EMAIL_DELIVERY_SEND_AFTER: "2026-01-01T00:00:00Z",
      EMAIL_FROM_ADDRESS: "program@confpilot.example",
      EMAIL_FROM_NAME: "ConfPilot Program Team",
    }, Date.parse("2099-01-01T00:00:00Z"))).rejects.toThrow("transient D1 unavailable");
    expect(database.prepare("SELECT state, failure_message AS failureMessage FROM notification_outbox WHERE decision_id = ?")
      .get(decisionId)).toEqual({ state: "pending", failureMessage: null });
  });

  it("keeps the speaker workspace owner-scoped without rationale, reviewer, or co-presenter task leakage", async () => {
    const proposalId = addDecisionCandidate(database, "workspace", { coPresenter: true, activeAssignment: true });
    await decisionRequest(env, "/api/events/devflow-conf-2027/decisions", {
      method: "POST", body: { proposalId, decision: "accept", rationale: "Private committee rationale." },
    });
    const speakerToken = "test-priya-workspace-session";
    addSession(database, "usr-d-priya", speakerToken);
    const cookie = { Cookie: `__Host-confpilot_session=${speakerToken}` };
    const response = await decisionRequest(env, "/api/events/devflow-conf-2027/speaker/workspace", { cookie });
    const body = await response.json();
    const proposal = body.data.proposals.find((item) => item.id === proposalId);
    expect(response.status).toBe(200);
    expect(proposal).toMatchObject({ decision: "accept", notificationStatus: "not_queued" });
    expect(proposal.acceptedSession.presenters).toHaveLength(2);
    expect(proposal.acceptedSession.tasks).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain("Private committee rationale");
    expect(JSON.stringify(body)).not.toContain("Decision Reviewer");
    expect(proposal.acceptedSession.tasks.every((task) => !task.id.includes("-co"))).toBe(true);

    const crossEvent = await decisionRequest(env, "/api/events/field-notes-2027/speaker/workspace", { cookie });
    expect(crossEvent.status).toBe(403);
  });

  it("returns null materialization and notification projections for an unaccepted decision", async () => {
    database.exec(`
      INSERT INTO proposals (
        id, event_id, public_id, slug, title, abstract, track, format,
        duration_minutes, status, submitted_at, created_at, updated_at
      ) VALUES (
        'prop-d-rejected', 'evt-devflow', 'ABS-998', 'bounded-rejection',
        'Bounded Rejection', 'A rejected proposal fixture.', 'AI Engineering', 'talk',
        30, 'decided', '2027-01-20T18:00:00Z', '2027-01-20T18:00:00Z',
        '2027-02-20T18:00:00Z'
      );
      INSERT INTO decisions (
        id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
      ) VALUES (
        'dec-d-rejected', 'evt-devflow', 'prop-d-rejected', 'reject',
        'Outside this program scope.', 'usr-devflow-organizer', '2027-02-20T18:00:00Z'
      );
    `);

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/decisions",
      { headers: organizerCookie },
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const rejected = body.data.decisions.find(
      (item) => item.proposal.id === "prop-d-rejected",
    );

    expect(rejected).toBeDefined();
    expect(rejected.handoff).toEqual({ status: "not_applicable" });
    expect(rejected.notification).toEqual({ status: "not_queued" });
    expect(rejected.decision).toMatchObject({
      value: "reject",
      decidedBy: { displayName: "Jordan Alvarez" },
    });
  });

  it("materializes one accepted session and remains idempotent across retries", async () => {
    addAcceptedDecisionFixture(database);

    const first = await materializeAcceptance(env.DB, acceptanceInput);
    const removedTask = database.prepare("SELECT id FROM speaker_tasks WHERE program_session_id = ? LIMIT 1").get(first.programSessionId);
    database.prepare("DELETE FROM speaker_tasks WHERE id = ?").run(removedTask.id);
    const retry = await materializeAcceptance(env.DB, acceptanceInput);
    const secondReplay = await materializeAcceptance(env.DB, acceptanceInput);

    expect(retry).toEqual(first);
    expect(secondReplay).toEqual(first);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = 'prop-d-new'",
    ).get().count).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM acceptances WHERE proposal_id = 'prop-d-new' OR decision_id = 'dec-d-new'",
    ).get().count).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM session_presenters WHERE program_session_id = ?",
    ).get(first.programSessionId).count).toBe(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM speaker_tasks WHERE program_session_id = ?",
    ).get(first.programSessionId).count).toBe(8);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM notification_outbox WHERE acceptance_id = ?",
    ).get(first.id).count).toBe(0);
  });

  it("derives an independent acceptance key for each accepted decision", async () => {
    addAcceptedDecisionFixture(database);
    await materializeAcceptance(env.DB, {
      ...acceptanceInput,
    });
    database.exec(`
      INSERT INTO proposals (
        id, event_id, public_id, slug, title, abstract, track, format,
        duration_minutes, status, submitted_at, created_at, updated_at
      ) VALUES (
        'prop-d-next', 'evt-devflow', 'ABS-1000', 'another-accepted-proposal',
        'Another accepted proposal', 'A second accepted proposal.', 'AI Engineering', 'talk',
        30, 'decided', '2027-01-20T18:00:00Z', '2027-01-20T18:00:00Z',
        '2027-02-20T18:00:00Z'
      );
      INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('pp-d-next-primary', 'evt-devflow', 'prop-d-next', 'spk-d-maya', 'primary');
      INSERT INTO decisions (
        id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at
      ) VALUES (
        'dec-d-next', 'evt-devflow', 'prop-d-next', 'accept', 'Strong evidence.',
        'usr-devflow-organizer', '2027-02-20T18:02:00Z'
      );
    `);

    const next = await materializeAcceptance(env.DB, {
      eventId: "evt-devflow",
      decisionId: "dec-d-next",
      acceptedByUserId: "usr-devflow-organizer",
      acceptedAt: "2027-02-20T18:03:00Z",
    });
    expect(next.idempotencyKey).toBe("decision:dec-d-next");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM acceptances WHERE proposal_id = 'prop-d-next'",
    ).get().count).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = 'prop-d-next'",
    ).get().count).toBe(1);
  });

  it("enforces one acceptance per proposal and decision at the schema boundary", async () => {
    addAcceptedDecisionFixture(database);
    const accepted = await materializeAcceptance(env.DB, acceptanceInput);

    expect(() => database.prepare(`
      INSERT INTO acceptances (
        id, event_id, proposal_id, decision_id, program_session_id,
        accepted_by_user_id, idempotency_key, accepted_at
      ) VALUES (?, 'evt-devflow', 'prop-d-new', 'dec-d-new', ?,
        'usr-devflow-organizer', 'another-key', '2027-02-20T18:02:00Z')
    `).run("duplicate-acceptance", accepted.programSessionId)).toThrow();
  });

  it("retains the load-bearing acceptance indexes and triggers", () => {
    const objects = new Set(database.prepare(`
      SELECT type || ':' || name AS object
      FROM sqlite_master
      WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'
    `).all().map(({ object }) => object));

    const requiredObjects = [
      "index:proposal_presenters_one_primary_unique",
      "index:acceptances_event_proposal_unique",
      "index:acceptances_event_decision_unique",
      "index:acceptances_event_program_session_unique",
      "index:acceptances_event_idempotency_key_unique",
      "index:session_presenters_one_primary_unique",
      "index:speaker_tasks_event_session_speaker_key_unique",
      "index:notification_outbox_event_decision_recipient_unique",
      "index:notification_outbox_event_state_queue_index",
      "index:message_outbox_delivery_queue_index",
      "trigger:decisions_scope_insert",
      "trigger:decisions_immutable_update",
      "trigger:decisions_immutable_delete",
      "trigger:acceptances_valid_chain_insert",
      "trigger:acceptances_immutable_update",
      "trigger:acceptances_immutable_delete",
      "trigger:session_presenters_valid_chain_insert",
      "trigger:speaker_tasks_valid_chain_insert",
      "trigger:notification_outbox_valid_chain_insert",
      "trigger:message_outbox_content_immutable_update",
      "trigger:message_outbox_lifetime_insert",
      "trigger:message_outbox_cancellation_update",
      "trigger:message_outbox_actor_valid_insert",
      "trigger:message_outbox_state_transition_update",
      "trigger:message_outbox_active_delete",
    ];
    for (const object of requiredObjects) expect(objects.has(object), object).toBe(true);
  });

  it("keeps the ordered SQL migration authoritative and pins every trigger", () => {
    const migrationFiles = readdirSync(new URL("../migrations", import.meta.url));
    expect(migrationFiles).toContain("0000_initial.sql");
    expect(migrationFiles.every((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))).toBe(true);
    expect(migrationFiles.some((name) => /meta|journal|snapshot/i.test(name))).toBe(false);

    const triggerNames = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all().map(({ name }) => name);
    expect(triggerNames).toEqual([
      "acceptances_immutable_delete",
      "acceptances_immutable_update",
      "acceptances_valid_chain_insert",
      "content_comments_immutable_delete",
      "content_comments_immutable_update",
      "content_comments_valid_insert",
      "content_reviews_chronological_insert",
      "content_reviews_demote_approved_insert",
      "content_reviews_immutable_delete",
      "content_reviews_immutable_update",
      "content_reviews_valid_insert",
      "decisions_immutable_delete",
      "decisions_immutable_update",
      "decisions_scope_insert",
      "deliverable_requests_demote_approved_insert",
      "deliverable_requests_demote_approved_update",
      "deliverable_requests_identity_immutable_update",
      "deliverable_requests_immutable_delete",
      "deliverable_requests_valid_insert",
      "deliverable_requests_valid_update",
      "deliverable_versions_demote_approved_insert",
      "deliverable_versions_immutable_delete",
      "deliverable_versions_immutable_update",
      "deliverable_versions_valid_insert",
      "event_days_immutable_delete",
      "event_days_legacy_hydration_update",
      "event_days_valid_insert",
      "event_days_valid_update",
      "event_memberships_proposal_owner_delete",
      "event_memberships_proposal_owner_update",
      "event_tracks_immutable_delete",
      "event_tracks_valid_insert",
      "event_tracks_valid_update",
      "message_outbox_active_delete",
      "message_outbox_actor_valid_insert",
      "message_outbox_cancellation_update",
      "message_outbox_content_immutable_update",
      "message_outbox_lifetime_insert",
      "message_outbox_state_transition_update",
      "notification_outbox_content_immutable_update",
      "notification_outbox_immutable_delete",
      "notification_outbox_state_forward_only_update",
      "notification_outbox_valid_chain_insert",
      "placements_agenda_valid_insert",
      "placements_agenda_valid_update",
      "placements_legacy_hydration_update",
      "placements_no_room_overlap_insert",
      "placements_no_room_overlap_update",
      "placements_same_event_insert",
      "placements_same_event_update",
      "program_sessions_approval_gate_update",
      "program_sessions_content_revision_update",
      "program_sessions_duration_requires_unplaced",
      "program_sessions_identity_immutable_update",
      "program_sessions_revision_requires_change",
      "program_sessions_same_event_insert",
      "proposal_answers_locked_delete",
      "proposal_answers_locked_insert",
      "proposal_answers_locked_update",
      "proposal_answers_scope_insert",
      "proposal_answers_scope_update",
      "proposal_presenters_locked_after_acceptance_delete",
      "proposal_presenters_owner_insert",
      "proposal_presenters_owner_update",
      "proposal_presenters_same_event_insert",
      "proposal_presenters_same_event_update",
      "proposals_owner_scope_insert",
      "proposals_owner_scope_update",
      "public_embed_configs_identity_immutable_update",
      "public_embed_configs_immutable_delete",
      "public_embed_configs_valid_insert",
      "public_embed_configs_valid_update",
      "review_assignment_actions_immutable_delete",
      "review_assignment_actions_immutable_update",
      "review_assignment_actions_valid_insert",
      "review_assignments_conflict_insert",
      "review_assignments_identity_immutable_update",
      "review_assignments_immutable_delete",
      "review_assignments_plan_version_insert",
      "review_assignments_revoked_frozen_update",
      "review_assignments_scope_insert",
      "review_assignments_state_update",
      "review_correction_criterion_scores_immutable_delete",
      "review_correction_criterion_scores_immutable_update",
      "review_correction_criterion_scores_valid_insert",
      "review_correction_score_staging_immutable_update",
      "review_correction_score_staging_valid_insert",
      "review_corrections_complete_scores_insert",
      "review_corrections_immutable_delete",
      "review_corrections_immutable_update",
      "review_corrections_promote_staged_scores_insert",
      "review_corrections_valid_insert",
      "review_criteria_immutable_delete",
      "review_criteria_immutable_update",
      "review_criteria_valid_insert",
      "review_criterion_scores_immutable_delete",
      "review_criterion_scores_immutable_update",
      "review_criterion_scores_valid_insert",
      "review_plan_versions_builtin_labels_valid_insert",
      "review_plan_versions_immutable_delete",
      "review_plan_versions_immutable_update",
      "review_plan_versions_valid_insert",
      "review_plans_activate_valid_version",
      "review_plans_identity_immutable_update",
      "review_plans_immutable_delete",
      "review_plans_valid_insert",
      "review_round_reviewers_assigned_delete",
      "review_round_reviewers_immutable_update",
      "review_round_reviewers_valid_insert",
      "review_rounds_canonical_window_insert",
      "review_rounds_canonical_window_update",
      "review_rounds_identity_immutable_update",
      "review_rounds_referenced_delete",
      "review_rounds_valid_insert",
      "review_rounds_valid_update",
      "reviewer_conflicts_immutable_delete",
      "reviewer_conflicts_immutable_update",
      "reviewer_conflicts_valid_insert",
      "reviewer_invitation_acceptances_immutable",
      "reviewer_invitation_acceptances_insert_guard",
      "reviewer_invitation_acceptances_no_delete",
      "reviewer_invitations_identity_immutable",
      "reviewer_invitations_insert_guard",
      "reviewer_invitations_transition_guard",
      "reviews_immutable_delete",
      "reviews_immutable_update",
      "reviews_plan_version_insert",
      "reviews_valid_assignment_insert",
      "rooms_immutable_delete",
      "rooms_legacy_hydration_update",
      "rooms_valid_insert",
      "rooms_valid_update",
      "schedule_placements_demote_published_delete",
      "session_content_history_immutable_delete",
      "session_content_history_immutable_update",
      "session_content_history_valid_insert",
      "session_presenters_identity_immutable_update",
      "session_presenters_speaker_workflow_insert",
      "session_presenters_valid_chain_insert",
      "speaker_claim_acceptance_immutable",
      "speaker_claim_acceptance_insert_guard",
      "speaker_claim_acceptance_no_delete",
      "speaker_claim_identity_immutable",
      "speaker_claim_insert_guard",
      "speaker_claim_link_guard",
      "speaker_claim_transition_guard",
      "speaker_content_history_immutable_delete",
      "speaker_content_history_immutable_update",
      "speaker_content_history_valid_insert",
      "speaker_tasks_demote_approved_insert",
      "speaker_tasks_demote_approved_update",
      "speaker_tasks_identity_immutable_update",
      "speaker_tasks_provenance_insert",
      "speaker_tasks_revision_requires_change",
      "speaker_tasks_state_revision_update",
      "speaker_tasks_valid_chain_insert",
      "speakers_demote_approved_update",
      "speakers_headshot_metadata_insert",
      "speakers_headshot_object_scope_update",
      "speakers_profile_revision_update",
      "speakers_revision_requires_change",
      "user_credentials_supported_insert",
      "user_credentials_supported_material_update",
    ]);
  });

  it("rejects acceptance without exactly one primary proposal presenter", async () => {
    addAcceptedDecisionFixture(database);
    database.exec("DELETE FROM proposal_presenters WHERE proposal_id = 'prop-d-new' AND role = 'primary'");

    await expect(materializeAcceptance(env.DB, acceptanceInput))
      .rejects.toBeInstanceOf(AcceptanceNotAllowedError);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM program_sessions WHERE source_proposal_id = 'prop-d-new'",
    ).get().count).toBe(0);
  });

  it("keeps decisions and acceptances immutable", async () => {
    addAcceptedDecisionFixture(database);
    const accepted = await materializeAcceptance(env.DB, acceptanceInput);

    expect(() => database.exec(
      "UPDATE decisions SET event_id = 'evt-fieldnotes' WHERE id = 'dec-d-new'",
    )).toThrow(/immutable/);
    expect(() => database.prepare(
      "UPDATE acceptances SET idempotency_key = 'mutated' WHERE id = ?",
    ).run(accepted.id)).toThrow(/immutable/);
    expect(() => database.prepare("DELETE FROM decisions WHERE id = ?").run("dec-d-new"))
      .toThrow(/immutable/);
    expect(() => database.prepare("DELETE FROM acceptances WHERE id = ?").run(accepted.id))
      .toThrow(/immutable/);
    expect(() => database.prepare("DELETE FROM proposals WHERE id = ?").run("prop-d-new"))
      .toThrow();
    expect(() => database.prepare("DELETE FROM events WHERE id = ?").run("evt-devflow"))
      .toThrow();
  });

  it("keeps seeded speaker tasks aligned with the materialization defaults", () => {
    const seededTasks = database.prepare(`
      SELECT DISTINCT task_key AS taskKey, label
      FROM speaker_tasks
      ORDER BY task_key
    `).all().map(({ taskKey, label }) => [taskKey, label]);
    const expectedTasks = [...DEFAULT_TASKS].sort(([left], [right]) => left.localeCompare(right));

    expect(seededTasks).toEqual(expectedTasks);
  });

  it("locks the complete proposal presenter set after acceptance", async () => {
    addAcceptedDecisionFixture(database);
    await materializeAcceptance(env.DB, acceptanceInput);

    expect(() => database.exec(
      "DELETE FROM proposal_presenters WHERE id = 'pp-d-new-primary'",
    )).toThrow(/immutable/);
    expect(() => database.exec(`
      INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('pp-d-new-late', 'evt-devflow', 'prop-d-new', 'spk-d-maya', 'co_presenter')
    `)).toThrow(/immutable/);
  });

  it("rejects cross-event acceptance and presenter references", async () => {
    addAcceptedDecisionFixture(database);

    await expect(materializeAcceptance(env.DB, {
      ...acceptanceInput,
      eventId: "evt-fieldnotes",
    })).rejects.toBeInstanceOf(AcceptanceNotAllowedError);
    await expect(materializeAcceptance(env.DB, {
      ...acceptanceInput,
      acceptedByUserId: "usr-fieldnotes-organizer",
    })).rejects.toBeInstanceOf(AcceptanceNotAllowedError);
    expect(() => database.exec(`
      INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role)
      VALUES ('cross-event-presenter', 'evt-devflow', 'prop-d-new', 'spk-f-lina', 'co_presenter')
    `)).toThrow(/event-scoped/);
  });

  it("publishes a materialized session only after every public eligibility gate", async () => {
    addAcceptedDecisionFixture(database);
    const accepted = await materializeAcceptance(env.DB, acceptanceInput);
    const readProgram = async () => {
      const response = await createApp().request(
        "/api/program?event=devflow-conf-2027",
        undefined,
        env,
      );
      return (await response.json()).data.sessions.map((session) => session.slug);
    };

    expect(await readProgram()).not.toContain("evidence-first-agents");
    expect(() => database.prepare(`
      UPDATE program_sessions
      SET publication_status = 'published', approval_status = 'approved',
          revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = ?
    `).run(accepted.programSessionId)).toThrow(/tasks complete or waived/);
    database.prepare(`
      UPDATE speaker_tasks
      SET state = 'complete', completed_at = '2027-04-20T17:01:00Z',
          revision = revision + 1, updated_at = '2027-04-20T17:01:00Z'
      WHERE event_id = 'evt-devflow' AND program_session_id = ?
    `).run(accepted.programSessionId);
    database.prepare(`
      UPDATE program_sessions
      SET publication_status = 'published', approval_status = 'approved',
          revision = revision + 1, updated_at = '2027-04-20T17:02:00Z'
      WHERE id = ?
    `).run(accepted.programSessionId);
    expect(await readProgram()).not.toContain("evidence-first-agents");
    database.prepare(`
      INSERT INTO schedule_placements (
        id, event_id, program_session_id, event_day_id, room_id, starts_at, ends_at,
        revision, created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES (
        'plc-d-new', 'evt-devflow', ?, 'day-d-3', 'room-d-2a',
        '2027-05-14T22:00:00Z', '2027-05-14T22:30:00Z', 1,
        'usr-devflow-organizer', 'usr-devflow-organizer',
        '2027-04-20T17:03:00Z', '2027-04-20T17:03:00Z'
      )
    `).run(accepted.programSessionId);

    expect(await readProgram()).toContain("evidence-first-agents");
  });

  it("requires parseable canonical UTC placement timestamps before checking room overlap", () => {
    expect(() => database.exec(`
      UPDATE schedule_placements
      SET room_id = 'room-d-main',
          starts_at = '2027-05-12T09:00:00-07:00',
          ends_at = '2027-05-12T09:45:00-07:00'
      WHERE id = 'plc-d-2'
    `)).toThrow(/CHECK constraint failed/);
    expect(() => database.exec(`
      UPDATE schedule_placements
      SET room_id = 'room-d-main',
          starts_at = ' 2027-05-12T16:00:00Z',
          ends_at = ' 2027-05-12T16:45:00Z'
      WHERE id = 'plc-d-2'
    `)).toThrow(/CHECK constraint failed/);
    expect(() => database.exec(`
      UPDATE schedule_placements
      SET room_id = 'room-d-main',
          starts_at = '2027-05-12T16:00:00Z',
          ends_at = '2027-05-12T16:30:00Z',
          revision = revision + 1,
          updated_by_user_id = 'usr-devflow-organizer',
          updated_at = '2027-04-20T18:00:00Z'
      WHERE id = 'plc-d-2'
    `)).toThrow(/overlaps/);
  });

  it("derives a strict readiness contract and exact organizer actions from event-scoped state", async () => {
    const response = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const body = await response.json();
    const counts = Object.fromEntries(
      body.data.lifecycle.map((stage) => [stage.stage, stage.count]),
    );
    expect(response.status).toBe(200);
    expect(body.data.summary).toEqual({
      accepted: 8,
      publishReady: 5,
      blocked: 3,
      percent: 63,
    });
    expect(counts).toEqual({
      accepted: 8,
      profile_ready: 7,
      deliverables_ready: 8,
      scheduled: 8,
      approved: 6,
      published: 5,
    });
    expect(body.data.lifecycle.every((stage) => stage.total === 8)).toBe(true);
    expect(body.data.blockers.map((blocker) => blocker.kind)).toEqual([
      "speaker_profile_incomplete",
      "speaker_tasks_incomplete",
      "speaker_tasks_incomplete",
      "content_approval_pending",
      "content_approval_pending",
    ]);
    expect(body.data.blockers.map((blocker) => blocker.actionPath)).toEqual([
      "/admin/speakers?speaker=spk-d-theo",
      "/admin/speakers?speaker=spk-d-jules",
      "/admin/speakers?speaker=spk-d-sanaa",
      "/admin/content?session=ses-d-6",
      "/admin/content?session=ses-d-7",
    ]);
    expect(JSON.stringify(body.data)).not.toMatch(/contact_email|contactEmail|travel_preferences|travelPreferences/);
  });

  it("keeps the readiness endpoint total for a legally long accepted-session title", async () => {
    const longTitle = "T".repeat(301);
    database.prepare(`UPDATE program_sessions
      SET title = ?, approval_status = 'pending', revision = revision + 1,
        updated_at = '2027-05-01T18:00:00Z'
      WHERE id = 'ses-d-1'`).run(longTitle);

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const body = await response.json();
    const blocker = body.data?.blockers.find(({ entityId }) => entityId === "ses-d-1");

    expect(response.status).toBe(200);
    expect(blocker).toMatchObject({
      entityId: "ses-d-1",
      kind: "content_approval_pending",
    });
    expect(blocker.entityLabel.length).toBeLessThanOrEqual(300);
    expect(blocker.entityLabel.endsWith("…")).toBe(true);
    expect(blocker.explanation.length).toBeLessThanOrEqual(500);
  });

  it("bounds a task blocker assembled from legal long labels", async () => {
    database.prepare(`UPDATE program_sessions
      SET title = ?, revision = revision + 1, updated_at = '2027-05-01T18:00:00Z'
      WHERE id = 'ses-d-7'`).run("S".repeat(300));
    const tasks = database.prepare(`SELECT id FROM speaker_tasks
      WHERE event_id = 'evt-devflow' AND program_session_id = 'ses-d-7'
      ORDER BY id LIMIT 2`).all();
    expect(tasks).toHaveLength(2);
    for (const [index, task] of tasks.entries()) {
      database.prepare(`UPDATE speaker_tasks
        SET label = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?`).run(`${index}`.repeat(200), `2027-05-01T18:00:0${index + 1}Z`, task.id);
    }

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const body = await response.json();
    const blocker = body.data?.blockers.find(({ id }) =>
      id === "speaker_tasks_incomplete:ses-d-7:spk-d-jules");

    expect(response.status).toBe(200);
    expect(blocker).toBeTruthy();
    expect(blocker.explanation.length).toBeLessThanOrEqual(500);
    expect(blocker.explanation).toContain("more");
  });

  it("does not count an accepted session without a presenter as profile ready", async () => {
    const before = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const beforeCounts = Object.fromEntries(
      (await before.json()).data.lifecycle.map((stage) => [stage.stage, stage.count]),
    );
    const readySession = database.prepare(`SELECT session.id
      FROM program_sessions AS session
      WHERE session.event_id = 'evt-devflow'
        AND EXISTS (SELECT 1 FROM session_presenters AS presenter
          WHERE presenter.event_id = session.event_id
            AND presenter.program_session_id = session.id)
        AND NOT EXISTS (SELECT 1 FROM session_presenters AS presenter
          INNER JOIN speakers AS speaker ON speaker.id = presenter.speaker_id
            AND speaker.event_id = presenter.event_id
          WHERE presenter.event_id = session.event_id
            AND presenter.program_session_id = session.id
            AND speaker.profile_status != 'ready')
      ORDER BY session.id LIMIT 1`).get();
    expect(readySession).toBeTruthy();
    database.prepare("DELETE FROM session_presenters WHERE event_id = 'evt-devflow' AND program_session_id = ?")
      .run(readySession.id);

    const after = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const afterCounts = Object.fromEntries(
      (await after.json()).data.lifecycle.map((stage) => [stage.stage, stage.count]),
    );

    expect(afterCounts.accepted).toBe(beforeCounts.accepted);
    expect(afterCounts.profile_ready).toBe(beforeCounts.profile_ready - 1);
  });

  it("keeps publish readiness separate from the organizer publication action", async () => {
    database.prepare(`UPDATE program_sessions
      SET publication_status = 'ready', revision = revision + 1,
        updated_at = '2027-05-01T19:00:00Z'
      WHERE id = 'ses-d-1'`).run();

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const data = (await response.json()).data;

    expect(response.status).toBe(200);
    expect(data.summary).toEqual({ accepted: 8, publishReady: 5, blocked: 3, percent: 63 });
    expect(data.lifecycle.find(({ stage }) => stage === "published"))
      .toEqual({ stage: "published", label: "Published", count: 4, total: 8 });
    expect(data.blockers).toContainEqual(expect.objectContaining({
      id: "publication_pending:ses-d-1",
      kind: "publication_pending",
      entityId: "ses-d-1",
      actionPath: "/admin/agenda?session=ses-d-1",
    }));
  });

  it("names the exact required deliverable record that blocks publication readiness", async () => {
    database.prepare(`INSERT INTO deliverable_requests (
      id, event_id, program_session_id, request_key, request_type, label, instructions,
      due_at, allowed_content_types_json, max_bytes, required, active, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (
      'request-readiness-slides', 'evt-devflow', 'ses-d-1', 'readiness-slides',
      'presentation', 'Final presentation', 'Upload the attendee-ready presentation.',
      '2027-05-01T20:00:00Z', '["application/pdf"]', 10485760, 1, 1, 1,
      'usr-devflow-organizer', 'usr-devflow-organizer',
      '2027-04-20T19:00:00Z', '2027-04-20T19:00:00Z'
    )`).run();

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const data = (await response.json()).data;

    expect(response.status).toBe(200);
    expect(data.lifecycle.find(({ stage }) => stage === "deliverables_ready"))
      .toEqual({ stage: "deliverables_ready", label: "Deliverables ready", count: 7, total: 8 });
    expect(data.blockers).toContainEqual(expect.objectContaining({
      id: "deliverable_missing:ses-d-1:request-readiness-slides",
      kind: "deliverable_missing",
      entityId: "ses-d-1",
      entityLabel: "Workflows That Explain Themselves",
      actionPath: "/admin/content?session=ses-d-1",
    }));
  });

  it("reports zero readiness counts for an event without accepted sessions", async () => {
    database.exec(`
      INSERT INTO events (
        id, slug, name, tagline, location, description,
        starts_on, ends_on, cfp_deadline, status
      ) VALUES (
        'evt-empty', 'empty-conf-2027', 'Empty Conf 2027', 'A clean readiness fixture',
        'Online', 'An event without accepted sessions.',
        '2027-10-01', '2027-10-01', '2027-06-01T23:59:00Z', 'draft'
      );
      INSERT INTO event_memberships (id, event_id, user_id, role, created_at)
      VALUES (
        'mem-empty-organizer', 'evt-empty', 'usr-devflow-organizer', 'organizer',
        '2026-08-10T00:00:00Z'
      );
    `);

    const response = await createApp().request(
      "/api/events/empty-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary).toEqual({ accepted: 0, publishReady: 0, blocked: 0, percent: 0 });
    expect(body.data.blockers).toEqual([]);
    expect(Object.fromEntries(
      body.data.lifecycle.map((stage) => [stage.stage, stage.count]),
    )).toEqual({
      accepted: 0,
      profile_ready: 0,
      deliverables_ready: 0,
      scheduled: 0,
      approved: 0,
      published: 0,
    });
  });

  it("requires a valid server session for organizer projections", async () => {
    const missing = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      undefined,
      env,
    );
    const invalid = await createApp().request(
      "/api/events/devflow-conf-2027/decisions",
      { headers: { Cookie: "__Host-confpilot_session=invalid-session" } },
      env,
    );

    expect(missing.status).toBe(401);
    expect((await missing.json()).error.code).toBe("UNAUTHENTICATED");
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("compares session expiry as an instant instead of lexical timestamp text", async () => {
    const token = "offset-expired-session";
    const expiredInstant = new Date(Date.now() - 60_000);
    const offsetTimestamp = new Date(expiredInstant.getTime() + 14 * 60 * 60 * 1_000)
      .toISOString()
      .replace("Z", "+14:00");
    addSession(database, "usr-devflow-organizer", token, offsetTimestamp);

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: { Cookie: `__Host-confpilot_session=${token}` } },
      env,
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects revoked sessions and sessions with the wrong event role", async () => {
    database.exec(`
      UPDATE auth_sessions
      SET revoked_at = '2027-01-01T00:00:00Z'
      WHERE user_id = 'usr-devflow-organizer';
    `);
    const revoked = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );

    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe("UNAUTHENTICATED");

    database.exec(`
      UPDATE auth_sessions SET revoked_at = NULL WHERE user_id = 'usr-devflow-organizer';
      UPDATE event_memberships
      SET role = 'reviewer'
      WHERE event_id = 'evt-devflow' AND user_id = 'usr-devflow-organizer';
    `);
    const wrongRole = await createApp().request(
      "/api/events/devflow-conf-2027/readiness",
      { headers: organizerCookie },
      env,
    );

    expect(wrongRole.status).toBe(403);
    expect((await wrongRole.json()).error.code).toBe("FORBIDDEN");
  });

  it("does not let an organizer session cross event boundaries", async () => {
    const response = await createApp().request(
      "/api/events/field-notes-2027/readiness",
      { headers: organizerCookie },
      env,
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  it("returns public speaker profiles with fallback headshots and eligible linked sessions", async () => {
    const response = await createApp().request(
      "/api/program/speakers?event=devflow-conf-2027",
      undefined,
      env,
    );
    const body = await response.json();
    const priya = body.data.speakers.find((speaker) => speaker.slug === "priya-raman");
    const marcus = body.data.speakers.find((speaker) => speaker.slug === "marcus-okafor");

    expect(body.data.speakers.map((speaker) => speaker.name)).toEqual([
      "Maya Chen",
      "Amara Okafor",
      "Marcus Okafor",
      "Priya Raman",
    ]);
    expect(priya.headshotUrl).toBeNull();
    expect(priya.headshotFallback).toBe("PR");
    expect(priya.sessions.map((session) => session.slug)).toEqual([
      "taming-40-minute-ci",
      "ai-pair-programmer-verification",
      "docs-that-answer-back",
    ]);
    expect(marcus.sessions.map((session) => session.slug)).toEqual([
      "taming-40-minute-ci",
    ]);

    database.exec(`UPDATE speakers
      SET public_visibility = 'private', revision = revision + 1,
          updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'spk-d-priya'`);
    const hiddenProgramResponse = await createApp().request(
      "/api/program?event=devflow-conf-2027",
      undefined,
      env,
    );
    const hiddenSpeakersResponse = await createApp().request(
      "/api/program/speakers?event=devflow-conf-2027",
      undefined,
      env,
    );

    expect(JSON.stringify(await hiddenProgramResponse.json())).not.toContain("taming-40-minute-ci");
    expect(JSON.stringify(await hiddenSpeakersResponse.json())).not.toContain("taming-40-minute-ci");
  });

  it("orders public speaker names for people instead of binary SQLite text", async () => {
    database.exec(`
      UPDATE speakers SET name = 'zoe', revision = revision + 1,
        updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-amara';
      UPDATE speakers SET name = 'Ángela', revision = revision + 1,
        updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-marcus';
      UPDATE speakers SET name = 'alice', revision = revision + 1,
        updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-maya';
    `);

    const response = await createApp().request(
      "/api/program/speakers?event=devflow-conf-2027",
      undefined,
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.speakers.map((speaker) => speaker.name)).toEqual([
      "alice",
      "Ángela",
      "Priya Raman",
      "zoe",
    ]);
  });

  it("uses a strict slug tie-breaker when speaker names and locale order are equal", async () => {
    database.exec(`
      UPDATE speakers SET name = 'Same Name', slug = 'item2', revision = revision + 1,
        updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-amara';
      UPDATE speakers SET name = 'same name', slug = 'item02', revision = revision + 1,
        updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-maya';
    `);

    const response = await createApp().request(
      "/api/program/speakers?event=devflow-conf-2027",
      undefined,
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.speakers
      .filter((speaker) => speaker.name.toLowerCase() === "same name")
      .map((speaker) => speaker.slug)).toEqual(["item02", "item2"]);
  });
});
