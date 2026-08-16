import { createHash, pbkdf2Sync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index.ts";
import { enqueueMessage, purgeTerminalMessages } from "../src/features/messaging/message-outbox.ts";
import { PASSWORD_ITERATIONS } from "../src/password.ts";

class SqliteD1Statement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) { const bound = new SqliteD1Statement(this.statement); bound.params = params; return bound; }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() { const result = this.statement.run(...this.params); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }
  async first(column) { const row = this.statement.get(...this.params) ?? null; return column && row ? row[column] : row; }
}

class SqliteD1Database {
  constructor(database) { this.database = database; this.batchCount = 0; this.beforeBatch = null; this.beforeBatchAt = null; this.preparedQueries = []; }
  prepare(query) { this.preparedQueries.push(query); return new SqliteD1Statement(this.database.prepare(query)); }
  async batch(statements) {
    this.batchCount += 1;
    if (this.beforeBatch && (this.beforeBatchAt === null || this.beforeBatchAt === this.batchCount)) {
      const beforeBatch = this.beforeBatch;
      this.beforeBatch = null;
      this.beforeBatchAt = null;
      beforeBatch();
    }
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

function addSession(database, userId, token) {
  database.prepare(`INSERT INTO auth_sessions
    (id, user_id, token_hash, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, '2026-08-13T00:00:00Z')`)
    .run(`session-${token}`, userId, createHash("sha256").update(token).digest("hex"));
  return `__Host-confpilot_session=${token}`;
}

function addAccount(database, { id, email, displayName = "Existing Reviewer", password = "reviewer-password-123" }) {
  const salt = "00112233445566778899aabbccddeeff";
  const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), PASSWORD_ITERATIONS, 32, "sha256").toString("hex");
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, '2026-08-13T00:00:00Z')")
    .run(id, email, displayName);
  database.prepare(`INSERT INTO user_credentials
    (user_id, password_salt, password_hash, algorithm, iterations, created_at, updated_at)
    VALUES (?, ?, ?, 'pbkdf2-sha256', ?, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')`)
    .run(id, salt, hash, PASSWORD_ITERATIONS);
}

function request(path, { method = "GET", cookie, body } = {}, env) {
  return createApp().request(`http://localhost${path}`, {
    method,
    headers: {
      ...(method === "GET" ? {} : sameOriginHeaders),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

function tokenFromPath(path) { return path.split("#")[1]; }

describe("reviewer invitation provisioning", () => {
  let database;
  let env;
  let organizerCookie;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00Z"));
    database = fixtureDatabase();
    env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
    };
    organizerCookie = addSession(database, "usr-devflow-organizer", "invite-organizer");
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  async function invite(overrides = {}) {
    const response = await request("/api/events/devflow-conf-2027/reviewer-invitations", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        email: "new-reviewer@example.com",
        displayName: "New Reviewer",
        idempotencyKey: "invite-attempt-1",
        expiresInDays: 7,
        ...overrides,
      },
    }, env);
    return { response, body: await response.json() };
  }

  it("atomically creates a one-time link and immutable queued email without storing the raw token in the invitation", async () => {
    const created = await invite();
    expect(created.response.status).toBe(201);
    expect(created.body.data).toMatchObject({ replayed: false, invitation: { email: "new-reviewer@example.com", state: "pending", outboxState: "queued" } });
    expect(created.body.data.acceptPath).toMatch(/^\/reviewer-invitation#[A-Za-z0-9_-]{43}$/);

    const token = tokenFromPath(created.body.data.acceptPath);
    const row = database.prepare(`SELECT invitation.token_hash AS tokenHash, message.text_body AS textBody
      FROM reviewer_invitations AS invitation
      INNER JOIN message_outbox AS message ON message.id = invitation.outbox_message_id`).get();
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.tokenHash).not.toContain(token);
    expect(row.textBody).toContain(`http://localhost/reviewer-invitation#${token}`);

    const replay = await invite();
    expect(replay.response.status).toBe(200);
    expect(replay.body.data).toMatchObject({ replayed: true, acceptPath: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviewer_invitations").get().count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE intent = 'reviewer_invitation'").get().count).toBe(1);

    const mismatchedReplay = await invite({ email: "different@example.com" });
    expect(mismatchedReplay.response.status).toBe(409);
    expect(mismatchedReplay.body.error.code).toBe("REVIEWER_INVITATION_IDEMPOTENCY_CONFLICT");

    const list = await request("/api/events/devflow-conf-2027/reviewer-invitations", { cookie: organizerCookie }, env);
    expect((await list.json()).data.invitations).toHaveLength(1);
  });

  it("registers the invited identity, consumes once, and reloads a reviewer-only session", async () => {
    const created = await invite();
    const token = tokenFromPath(created.body.data.acceptPath);
    const resolved = await request("/api/reviewer-invitations/resolve", { method: "POST", body: { token } }, env);
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).data).toMatchObject({ event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" }, email: "new-reviewer@example.com" });

    const registered = await request("/api/reviewer-invitations/register", {
      method: "POST",
      body: { token, displayName: "Nia Reviewer", password: "secure-reviewer-pass-123" },
    }, env);
    expect(registered.status).toBe(201);
    const registeredBody = await registered.json();
    expect(registeredBody.data).toMatchObject({
      user: { email: "new-reviewer@example.com", displayName: "Nia Reviewer" },
      memberships: [{ eventSlug: "devflow-conf-2027", role: "reviewer" }],
    });
    const cookie = /__Host-confpilot_session=([^;]+)/.exec(registered.headers.get("set-cookie") ?? "")?.[1];
    const session = await request("/api/auth/session", { cookie: `__Host-confpilot_session=${cookie}` }, env);
    expect((await session.json()).data.memberships).toEqual([{ eventSlug: "devflow-conf-2027", role: "reviewer" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviewer_invitation_acceptances").get().count).toBe(1);
    expect(database.prepare(`SELECT message.cancellation_code AS code
      FROM message_outbox AS message INNER JOIN reviewer_invitations AS invitation
        ON invitation.outbox_message_id = message.id WHERE invitation.email = 'new-reviewer@example.com'`).get().code)
      .toBe("INVITATION_ACCEPTED");

    const replay = await request("/api/reviewer-invitations/register", {
      method: "POST", body: { token, displayName: "Nia Reviewer", password: "secure-reviewer-pass-123" },
    }, env);
    expect(replay.status).toBe(410);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'new-reviewer@example.com'").get().count).toBe(1);
  });

  it("lets an existing matching account accept, rejects a mismatched identity, and never changes another event", async () => {
    addAccount(database, { id: "usr-invited", email: "existing@example.com" });
    addAccount(database, { id: "usr-wrong", email: "wrong@example.com" });
    const invitedCookie = addSession(database, "usr-invited", "invited-account");
    const wrongCookie = addSession(database, "usr-wrong", "wrong-account");
    const created = await invite({ email: "existing@example.com", idempotencyKey: "existing-account-invite" });
    const token = tokenFromPath(created.body.data.acceptPath);

    const wrong = await request("/api/reviewer-invitations/accept", { method: "POST", cookie: wrongCookie, body: { token } }, env);
    expect(wrong.status).toBe(403);
    expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships WHERE user_id = 'usr-wrong'").get().count).toBe(0);

    const accepted = await request("/api/reviewer-invitations/accept", { method: "POST", cookie: invitedCookie, body: { token } }, env);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data.memberships).toEqual([{ eventSlug: "devflow-conf-2027", role: "reviewer" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships WHERE event_id = 'evt-fieldnotes' AND user_id = 'usr-invited'").get().count).toBe(0);
  });

  it("adds reviewer access to an existing speaker account without removing speaker access", async () => {
    addAccount(database, { id: "usr-speaker-reviewer", email: "speaker-reviewer@example.com" });
    database.prepare(`INSERT INTO event_memberships
      (id, event_id, user_id, role, created_at) VALUES
      ('mem-speaker-reviewer', 'evt-devflow', 'usr-speaker-reviewer', 'speaker', '2026-08-13T00:00:00Z')`).run();
    const speakerCookie = addSession(database, "usr-speaker-reviewer", "speaker-reviewer");

    const created = await invite({
      email: "speaker-reviewer@example.com",
      displayName: "Speaker Reviewer",
      idempotencyKey: "existing-speaker-invite",
    });
    expect(created.response.status).toBe(201);

    const accepted = await request("/api/reviewer-invitations/accept", {
      method: "POST",
      cookie: speakerCookie,
      body: { token: tokenFromPath(created.body.data.acceptPath) },
    }, env);

    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data.memberships).toEqual([
      { eventSlug: "devflow-conf-2027", role: "reviewer" },
      { eventSlug: "devflow-conf-2027", role: "speaker" },
    ]);
    expect(database.prepare(`SELECT role FROM event_memberships
      WHERE event_id = 'evt-devflow' AND user_id = 'usr-speaker-reviewer' ORDER BY role`).all())
      .toEqual([{ role: "reviewer" }, { role: "speaker" }]);
  });

  it("returns an exact conflict when reviewer access wins the invitation creation race", async () => {
    addAccount(database, { id: "usr-reviewer-race", email: "reviewer-race@example.com" });
    env.DB.beforeBatchAt = env.DB.batchCount + 2;
    env.DB.beforeBatch = () => database.prepare(`INSERT INTO event_memberships
      (id, event_id, user_id, role, created_at) VALUES
      ('mem-reviewer-race', 'evt-devflow', 'usr-reviewer-race', 'reviewer', '2026-08-13T00:00:00Z')`).run();

    const raced = await invite({
      email: "reviewer-race@example.com",
      displayName: "Reviewer Race",
      idempotencyKey: "reviewer-race-invite",
    });

    expect(raced.response.status).toBe(409);
    expect(raced.body.error.code).toBe("REVIEWER_INVITATION_CONFLICT");
    expect(database.prepare("SELECT COUNT(*) AS count FROM reviewer_invitations WHERE email = 'reviewer-race@example.com'").get().count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_outbox WHERE recipient_email = 'reviewer-race@example.com'").get().count).toBe(0);
  });

  it("returns an exact conflict when reviewer access wins the invitation acceptance race", async () => {
    addAccount(database, { id: "usr-accept-race", email: "accept-race@example.com" });
    const cookie = addSession(database, "usr-accept-race", "accept-race");
    const created = await invite({
      email: "accept-race@example.com",
      displayName: "Accept Race",
      idempotencyKey: "accept-race-invite",
    });
    env.DB.beforeBatchAt = env.DB.batchCount + 1;
    env.DB.beforeBatch = () => database.prepare(`INSERT INTO event_memberships
      (id, event_id, user_id, role, created_at) VALUES
      ('mem-accept-race', 'evt-devflow', 'usr-accept-race', 'reviewer', '2026-08-13T00:00:00Z')`).run();

    const raced = await request("/api/reviewer-invitations/accept", {
      method: "POST",
      cookie,
      body: { token: tokenFromPath(created.body.data.acceptPath) },
    }, env);

    expect(raced.status).toBe(409);
    expect((await raced.json()).error.code).toBe("REVIEWER_INVITATION_ROLE_CONFLICT");
    expect(database.prepare("SELECT state FROM reviewer_invitations WHERE id = ?").get(created.body.data.invitation.id))
      .toEqual({ state: "pending" });
  });

  it("rate limits invitation-backed account creation before password work or mutation", async () => {
    const created = await invite({ email: "limited@example.com", idempotencyKey: "limited-registration" });
    const token = tokenFromPath(created.body.data.acceptPath);
    env.DB.preparedQueries = [];
    env.LOGIN_SOURCE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const limited = await request("/api/reviewer-invitations/register", {
      method: "POST",
      body: { token, displayName: "Limited Reviewer", password: "secure-reviewer-pass-123" },
    }, env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(env.DB.preparedQueries.some((query) => query.includes("invitation.token_hash"))).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'limited@example.com'").get().count).toBe(0);
  });

  it("rate limits signed-in acceptance before invitation token lookup", async () => {
    addAccount(database, { id: "usr-limited-accept", email: "limited-accept@example.com" });
    const cookie = addSession(database, "usr-limited-accept", "limited-accept-user");
    const created = await invite({ email: "limited-accept@example.com", idempotencyKey: "limited-acceptance" });
    const token = tokenFromPath(created.body.data.acceptPath);
    env.DB.preparedQueries = [];
    env.LOGIN_SOURCE_RATE_LIMITER = { limit: async () => ({ success: false }) };

    const limited = await request("/api/reviewer-invitations/accept", {
      method: "POST",
      cookie,
      body: { token },
    }, env);

    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("INVITATION_RESOLUTION_RATE_LIMITED");
    expect(env.DB.preparedQueries.some((query) => query.includes("invitation.token_hash"))).toBe(false);
  });

  it("rate limits unauthenticated invitation resolution before database lookup", async () => {
    const created = await invite({ email: "resolve-limited@example.com", idempotencyKey: "limited-resolution" });
    const token = tokenFromPath(created.body.data.acceptPath);
    env.LOGIN_SOURCE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const limited = await request("/api/reviewer-invitations/resolve", { method: "POST", body: { token } }, env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await limited.json()).error.code).toBe("INVITATION_RESOLUTION_RATE_LIMITED");
  });

  it("fails closed for event-role conflicts, cross-event organizers, revocation, expiry, and database invariant bypasses", async () => {
    const existingRole = await invite({ email: "reviewer@devflow.example", idempotencyKey: "reviewer-role-conflict" });
    expect(existingRole.response.status).toBe(409);

    const fieldCookie = addSession(database, "usr-fieldnotes-organizer", "field-organizer");
    const forbidden = await request("/api/events/devflow-conf-2027/reviewer-invitations", {
      method: "POST", cookie: fieldCookie, body: { email: "cross@example.com", displayName: "Cross Event", idempotencyKey: "cross-event-invite" },
    }, env);
    expect(forbidden.status).toBe(403);

    const created = await invite({ idempotencyKey: "revoked-invite" });
    const revoked = await request(`/api/events/devflow-conf-2027/reviewer-invitations/${created.body.data.invitation.id}/revoke`, {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(revoked.status).toBe(200);
    expect((await revoked.clone().json()).data.outboxState).toBe("suppressed");
    const token = tokenFromPath(created.body.data.acceptPath);
    expect((await request("/api/reviewer-invitations/resolve", { method: "POST", body: { token } }, env)).status).toBe(410);

    const expiring = await invite({ email: "expires@example.com", idempotencyKey: "expires-invite", expiresInDays: 1 });
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    expect((await request("/api/reviewer-invitations/resolve", { method: "POST", body: { token: tokenFromPath(expiring.body.data.acceptPath) } }, env)).status).toBe(410);
    const replacement = await invite({ email: "expires@example.com", idempotencyKey: "expires-replacement", expiresInDays: 2 });
    expect(replacement.response.status).toBe(201);
    expect(database.prepare("SELECT state, expired_at AS expiredAt, revoked_by_user_id AS revokedBy FROM reviewer_invitations WHERE id = ?")
      .get(expiring.body.data.invitation.id)).toEqual({
        state: "expired", expiredAt: "2026-08-14T12:00:00Z", revokedBy: null,
      });
    expect(database.prepare(`SELECT message.cancellation_code AS code
      FROM message_outbox AS message INNER JOIN reviewer_invitations AS invitation
        ON invitation.outbox_message_id = message.id WHERE invitation.id = ?`).get(expiring.body.data.invitation.id).code)
      .toBe("MESSAGE_EXPIRED");

    expect(() => database.prepare("UPDATE reviewer_invitations SET email = 'changed@example.com' WHERE id = ?")
      .run(expiring.body.data.invitation.id)).toThrow(/identity is immutable|invalid reviewer invitation transition/);
    expect(() => database.prepare(`INSERT INTO reviewer_invitation_acceptances
      (invitation_id, event_id, user_id, accepted_at) VALUES (?, 'evt-fieldnotes', 'usr-fieldnotes-organizer', '2026-08-15T12:00:00Z')`)
      .run(expiring.body.data.invitation.id)).toThrow(/receipt mismatch/);
  });

  it("durably cancels an in-flight invitation without claiming suppression until the lease settles", async () => {
    const created = await invite({ idempotencyKey: "leased-revocation" });
    const messageId = database.prepare("SELECT outbox_message_id AS id FROM reviewer_invitations WHERE id = ?")
      .get(created.body.data.invitation.id).id;
    database.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
      lease_expires_at = '2026-08-13T12:01:00Z', lease_token = 'active-invitation-lease', updated_at = '2026-08-13T12:00:00Z'
      WHERE id = ?`).run(messageId);

    const revoked = await request(`/api/events/devflow-conf-2027/reviewer-invitations/${created.body.data.invitation.id}/revoke`, {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data.outboxState).toBe("leased");
    expect(database.prepare(`SELECT state, cancellation_code AS code FROM message_outbox WHERE id = ?`).get(messageId))
      .toEqual({ state: "leased", code: "INVITATION_REVOKED" });
  });

  it("retains referenced invitation history without blocking unrelated terminal-message purge", async () => {
    const created = await invite({ idempotencyKey: "retained-invitation" });
    const invitationMessageId = database.prepare("SELECT outbox_message_id AS id FROM reviewer_invitations WHERE id = ?")
      .get(created.body.data.invitation.id).id;
    await enqueueMessage(env.DB, {
      id: "unrelated-terminal", eventId: "evt-devflow", actorUserId: "usr-devflow-organizer",
      dedupeKey: "unrelated-terminal", intent: "system_notice", recipientEmail: "ops@example.test",
      recipientName: "Ops", templateKey: "system.notice", templateRevision: 1,
      subject: "Old terminal message", text: "Old terminal message body.", now: "2026-08-13T12:00:00Z",
    });
    for (const id of [invitationMessageId, "unrelated-terminal"]) {
      database.prepare(`UPDATE message_outbox SET state = 'leased', attempt_count = 1,
        lease_expires_at = '2026-08-13T12:01:00Z', lease_token = 'terminal-message-lease', updated_at = '2026-08-13T12:00:00Z'
        WHERE id = ?`).run(id);
      database.prepare(`UPDATE message_outbox SET state = 'delivered', lease_expires_at = NULL,
        lease_token = NULL, provider = 'test', provider_message_id = ?, delivered_at = '2026-08-13T12:00:00Z',
        last_error_code = NULL, updated_at = '2026-08-13T12:00:00Z' WHERE id = ?`).run(`provider-${id}`, id);
    }

    await expect(purgeTerminalMessages(env.DB, { before: "2026-08-14T00:00:00Z", limit: 10 })).resolves.toBe(1);
    expect(database.prepare("SELECT id FROM message_outbox ORDER BY id").all()).toEqual([{ id: invitationMessageId }]);
  });
});
