import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index.ts";

const registrationTestPassword = ["test-only", "password-123"].join("-");

// D1 refuses the 101st bound parameter. node:sqlite does not, so without this
// guard a query that fails in production passes here. See
// test/database-conformance.test.mjs, which pins the same limit on both drivers.
const MAX_BOUND_PARAMETERS = 100;

function guardBindings(params) {
  if (params.length > MAX_BOUND_PARAMETERS) {
    throw new Error(`too many SQL variables: ${params.length} exceeds the ${MAX_BOUND_PARAMETERS} supported per statement`);
  }
}

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
    guardBindings(this.params);
    return { results: this.statement.all(...this.params), success: true, meta: {} };
  }
  async run() {
    guardBindings(this.params);
    const result = this.statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first(column) {
    guardBindings(this.params);
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
}

class SqliteD1Database {
  constructor(database) {
    this.database = database;
    this.beforeBatch = null;
  }
  prepare(query) { return new SqliteD1Statement(this.database.prepare(query)); }
  async batch(statements) {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    beforeBatch?.();
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

function siteverifyResponse(body = {
  success: true,
  action: "speaker_registration",
  hostname: "localhost",
}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function addSpeakerSession(database, { eventId = "evt-devflow", eventSlug = "devflow-conf-2027", suffix = "speaker" } = {}) {
  const userId = `usr-${suffix}`;
  const speakerId = `spk-${suffix}`;
  const token = `token-${suffix}`;
  database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, `${suffix}@example.com`, `Test ${suffix}`, "2026-08-11T00:00:00Z");
  database.prepare("INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'speaker', ?)")
    .run(`mem-${suffix}`, eventId, userId, "2026-08-11T00:00:00Z");
  database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, ?, ?, ?, ?, '', '', '', NULL, 'TS', 'incomplete', 'missing', 'private')`)
    .run(speakerId, eventId, userId, `test-${suffix}`, `Test ${suffix}`);
  database.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, ?)`)
    .run(`session-${suffix}`, userId, createHash("sha256").update(token).digest("hex"), "2026-08-11T00:00:00Z");
  return { userId, speakerId, eventSlug, cookie: `__Host-confpilot_session=${token}` };
}

function addOrganizerSession(database) {
  const token = "organizer-cfp-token";
  database.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, ?)`)
    .run("session-cfp-organizer", "usr-devflow-organizer", createHash("sha256").update(token).digest("hex"), "2026-08-11T00:00:00Z");
  return `__Host-confpilot_session=${token}`;
}

function write(path, method, cookie, body) {
  return createApp().request(path, {
    method,
    headers: { ...sameOriginHeaders, ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, currentEnv);
}

const completeValues = {
  title: "Taming 40-Minute CI: Incremental Builds at Monorepo Scale",
  abstract: "Our monorepo CI took 40 minutes on a good day. Learn how caching cut it to six.",
  track: "Platform & Infra",
  format: "workshop",
  speaker_bio: "Priya leads a build-tooling platform team.",
  key_takeaway: "Measure the dependency graph before buying more runners.",
  audience_level: "Advanced",
  workshop_prerequisites: "Bring a laptop with a sample build graph.",
};

function organizerConfigWrite(config, overrides = {}) {
  const { slug: _slug, ...event } = config.event;
  return {
    expectedRevision: config.revision,
    event,
    status: config.status,
    opensAt: config.opensAt,
    closesAt: config.closesAt,
    confirmationMessage: config.confirmationMessage,
    fields: config.fields,
    ...overrides,
  };
}

let currentEnv;

describe("CFP configuration and proposal roundtrip", () => {
  let database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00Z"));
    database = fixtureDatabase();
    currentEnv = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: allowRateLimiter,
      LOGIN_ACCOUNT_RATE_LIMITER: allowRateLimiter,
      TURNSTILE_SITE_KEY: "test-site-key",
      TURNSTILE_SECRET_KEY: "test-secret-key",
      TURNSTILE_ALLOWED_HOSTNAMES: "localhost",
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(siteverifyResponse())));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("publishes exact event branding, options, required fields, and the workshop condition", async () => {
    const response = await createApp().request("/api/cfp/devflow-conf-2027", undefined, currentEnv);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      event: { name: "DevFlow Conf 2027", location: "Moscone West, San Francisco, CA" },
      status: "published",
      state: "open",
      closesAt: "2027-04-30T23:59:00Z",
      confirmationMessage: "Thanks for sharing your proposal. You can view its status from this account.",
      turnstile: { enabled: true, siteKey: "test-site-key" },
      revision: 1,
    });
    expect(body.data.fields.map(({ key }) => key)).toEqual([
      "title", "abstract", "track", "format", "speaker_bio", "key_takeaway", "audience_level", "workshop_prerequisites",
    ]);
    expect(body.data.fields.find(({ key }) => key === "track").options.map(({ label }) => label)).toEqual([
      "AI Engineering", "Platform & Infra", "Developer Experience",
    ]);
    expect(body.data.fields.find(({ key }) => key === "format").options.map(({ label }) => label)).toEqual([
      "Keynote (45 min)", "Talk (30 min)", "Lightning Talk (10 min)", "Workshop (120 min)", "Panel (45 min)",
    ]);
    expect(body.data.fields.find(({ key }) => key === "workshop_prerequisites").showWhen).toEqual({ fieldKey: "format", equals: "workshop" });
  });

  it("normalizes only the legacy stock confirmation at the API boundary", async () => {
    const legacyMessage = "Thanks for sharing your proposal. You can edit it until the CFP closes.";
    const truthfulMessage = "Thanks for sharing your proposal. You can view its status from this account.";
    const customMessage = "We received your proposal and will share the outcome in this account.";
    database.prepare("UPDATE cfp_configs SET confirmation_message = ? WHERE event_id = 'evt-devflow'").run(legacyMessage);

    const publicLegacy = await createApp().request("/api/cfp/devflow-conf-2027", undefined, currentEnv);
    expect((await publicLegacy.json()).data.confirmationMessage).toBe(truthfulMessage);
    expect(database.prepare("SELECT confirmation_message AS message FROM cfp_configs WHERE event_id = 'evt-devflow'").get())
      .toEqual({ message: legacyMessage });

    const cookie = addOrganizerSession(database);
    const organizerLegacy = await createApp().request("/api/events/devflow-conf-2027/cfp", { headers: { Cookie: cookie } }, currentEnv);
    const config = (await organizerLegacy.json()).data;
    expect(config.confirmationMessage).toBe(truthfulMessage);

    const update = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, { confirmationMessage: legacyMessage }));
    expect((await update.json()).data.confirmationMessage).toBe(truthfulMessage);
    expect(database.prepare("SELECT confirmation_message AS message FROM cfp_configs WHERE event_id = 'evt-devflow'").get())
      .toEqual({ message: truthfulMessage });

    database.prepare("UPDATE cfp_configs SET confirmation_message = ? WHERE event_id = 'evt-devflow'").run(customMessage);
    const publicCustom = await createApp().request("/api/cfp/devflow-conf-2027", undefined, currentEnv);
    expect((await publicCustom.json()).data.confirmationMessage).toBe(customMessage);
  });

  it("lets an organizer revise and unpublish configuration without exposing the draft publicly", async () => {
    const cookie = addOrganizerSession(database);
    const current = await createApp().request("/api/events/devflow-conf-2027/cfp", { headers: { Cookie: cookie } }, currentEnv);
    const config = (await current.json()).data;
    const update = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, {
        status: "draft",
        closesAt: "2027-04-29T23:59:00Z",
        event: {
          name: "DevFlow Community Summit 2027",
          tagline: "Shape the program with us",
          location: "Oakland Convention Center, Oakland, CA",
          description: "A customized three-day event for software builders.",
          startsOn: "2027-05-11",
          endsOn: "2027-05-15",
        },
      }));
    const publicResponse = await createApp().request("/api/cfp/devflow-conf-2027", undefined, currentEnv);

    expect(update.status).toBe(200);
    expect((await update.json()).data).toMatchObject({
      status: "draft",
      revision: 2,
      closesAt: "2027-04-29T23:59:00Z",
      event: {
        name: "DevFlow Community Summit 2027",
        tagline: "Shape the program with us",
        startsOn: "2027-05-11",
        endsOn: "2027-05-15",
      },
    });
    expect(publicResponse.status).toBe(404);
    expect(database.prepare("SELECT cfp_deadline AS deadline FROM events WHERE id = 'evt-devflow'").get().deadline)
      .toBe("2027-04-29T23:59:00Z");
  });

  it("rejects event dates that would strand an existing agenda day", async () => {
    const cookie = addOrganizerSession(database);
    const current = await createApp().request("/api/events/devflow-conf-2027/cfp", { headers: { Cookie: cookie } }, currentEnv);
    const config = (await current.json()).data;
    const update = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, { event: { ...organizerConfigWrite(config).event, startsOn: "2027-06-02", endsOn: "2027-06-04" } }));

    expect(update.status).toBe(400);
    expect(await update.json()).toMatchObject({
      error: { code: "AGENDA_DATE_CONFLICT", issues: [{ field: "event.endsOn" }] },
    });
    expect(database.prepare("SELECT starts_on AS startsOn, ends_on AS endsOn FROM events WHERE id = 'evt-devflow'").get())
      .toEqual({ startsOn: "2027-05-12", endsOn: "2027-05-14" });
  });

  it("rejects config shapes that cannot map safely into the durable proposal schema", async () => {
    const cookie = addOrganizerSession(database);
    const current = await createApp().request("/api/events/devflow-conf-2027/cfp", { headers: { Cookie: cookie } }, currentEnv);
    const config = (await current.json()).data;
    const unsafeFormat = structuredClone(config.fields);
    unsafeFormat.find(({ key }) => key === "format").options[0] = {
      value: "seminar", label: "Seminar", durationMinutes: 45,
    };
    const formatResponse = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, { fields: unsafeFormat }));
    const offsetResponse = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, { opensAt: "2027-01-01T00:00:00+05:00", closesAt: "2027-01-02T00:00:00Z" }));
    const impossibleDate = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, { closesAt: "2027-02-30T23:59:00Z" }));
    const missingTrack = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, { fields: config.fields.filter(({ key }) => key !== "track") }));

    for (const response of [formatResponse, offsetResponse, impossibleDate, missingTrack]) {
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    }
    expect(database.prepare("SELECT revision FROM cfp_configs WHERE event_id = 'evt-devflow'").get().revision).toBe(1);
  });

  it("rejects stale organizer saves without partially changing event copy or fields", async () => {
    const cookie = addOrganizerSession(database);
    const current = await createApp().request("/api/events/devflow-conf-2027/cfp", { headers: { Cookie: cookie } }, currentEnv);
    const config = (await current.json()).data;
    const changedFields = structuredClone(config.fields);
    changedFields.find(({ key }) => key === "key_takeaway").label = "What attendees will apply";

    currentEnv.DB.beforeBatch = () => {
      database.prepare("UPDATE cfp_configs SET revision = revision + 1, updated_at = ? WHERE event_id = 'evt-devflow'")
        .run("2026-08-11T12:00:01Z");
    };
    const stale = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, {
        event: { ...config.event, slug: undefined, name: "Stale event name" },
        fields: changedFields,
      }));

    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("CFP_REVISION_CONFLICT");
    expect(database.prepare("SELECT name FROM events WHERE id = 'evt-devflow'").get().name).toBe("DevFlow Conf 2027");
    expect(database.prepare("SELECT label FROM cfp_fields WHERE event_id = 'evt-devflow' AND field_key = 'key_takeaway'").get().label)
      .toBe("Key takeaway");
    expect(database.prepare("SELECT revision FROM cfp_configs WHERE event_id = 'evt-devflow'").get().revision).toBe(2);
  });

  it("rolls back event, config, and fields together when a relational field write fails", async () => {
    const cookie = addOrganizerSession(database);
    const current = await createApp().request("/api/events/devflow-conf-2027/cfp", { headers: { Cookie: cookie } }, currentEnv);
    const config = (await current.json()).data;
    const changedFields = structuredClone(config.fields);
    changedFields.find(({ key }) => key === "key_takeaway").label = "Atomic label";
    currentEnv.DB.beforeBatch = () => database.exec(`CREATE TRIGGER fail_cfp_field_update
      BEFORE UPDATE ON cfp_fields BEGIN SELECT RAISE(ABORT, 'synthetic field write failure'); END`);

    const failed = await write("/api/events/devflow-conf-2027/cfp", "PUT", cookie,
      organizerConfigWrite(config, {
        event: { ...organizerConfigWrite(config).event, name: "Atomic event name" },
        confirmationMessage: "Atomic confirmation",
        fields: changedFields,
      }));

    expect(failed.status).toBe(500);
    expect(database.prepare("SELECT name FROM events WHERE id = 'evt-devflow'").get().name).toBe("DevFlow Conf 2027");
    expect(database.prepare("SELECT revision, confirmation_message AS message FROM cfp_configs WHERE event_id = 'evt-devflow'").get())
      .toEqual({ revision: 1, message: "Thanks for sharing your proposal. You can view its status from this account." });
    expect(database.prepare("SELECT label FROM cfp_fields WHERE event_id = 'evt-devflow' AND field_key = 'key_takeaway'").get().label)
      .toBe("Key takeaway");
  });

  it("does not expose a published CFP when its event is still private", async () => {
    database.prepare("UPDATE events SET status = 'draft' WHERE id = 'evt-devflow'").run();
    const response = await createApp().request("/api/cfp/devflow-conf-2027", undefined, currentEnv);
    expect(response.status).toBe(404);
  });

  it("creates a speaker account atomically and returns only a hardened session", async () => {
    const response = await write("/api/cfp/devflow-conf-2027/register", "POST", null, {
      displayName: "Avery Quinn",
      email: "avery@example.com",
      password: registrationTestPassword,
      title: "Staff Engineer",
      company: "Example Labs",
      bio: "Builds reliable delivery systems.",
      turnstileToken: "valid-registration-token",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      user: { email: "avery@example.com", displayName: "Avery Quinn" },
      memberships: [{ eventSlug: "devflow-conf-2027", role: "speaker" }],
    });
    expect(response.headers.get("set-cookie")).toContain("__Host-confpilot_session=");
    expect(response.headers.get("set-cookie")).toContain("; HttpOnly; Secure");
    expect(JSON.stringify(body)).not.toMatch(/password|token/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'avery@example.com'").get().count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE user_id = (SELECT id FROM users WHERE email = 'avery@example.com') AND event_id = 'evt-devflow'").get().count).toBe(1);
  });

  it("does not let public registration claim an organizer-created profile by known email", async () => {
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, 'incomplete', 'missing', 'private')`)
      .run(
        "spk-precreated", "evt-devflow", "precreated-speaker", "Roster Display Name",
        "Roster Title", "Roster Company", "Roster biography", "claim-me@example.com", "RD",
      );

    const response = await write("/api/cfp/devflow-conf-2027/register", "POST", null, {
      displayName: "Account Display Name",
      email: " CLAIM-ME@example.com ",
      password: registrationTestPassword,
      title: "Account Title",
      company: "Account Company",
      bio: "Account biography",
      turnstileToken: "valid-registration-token",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("REGISTRATION_CONFLICT");
    expect(database.prepare(`SELECT name, title, company, bio, contact_email AS email,
      user_id AS userId FROM speakers WHERE id = ?`).get("spk-precreated")).toMatchObject({
      name: "Roster Display Name",
      title: "Roster Title",
      company: "Roster Company",
      bio: "Roster biography",
      email: "claim-me@example.com",
      userId: null,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE lower(trim(email)) = ?")
      .get("claim-me@example.com").count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND lower(trim(contact_email)) = ?")
      .get("evt-devflow", "claim-me@example.com").count).toBe(1);
  });

  it("rolls back registration when an unowned matching profile appears before its transaction", async () => {
    currentEnv.DB.beforeBatch = () => {
      database.prepare(`INSERT INTO speakers (
        id, event_id, user_id, slug, name, title, company, bio, contact_email,
        headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
      ) VALUES (?, ?, NULL, ?, ?, '', '', '', ?, NULL, 'RR', 'incomplete', 'missing', 'private')`)
        .run("spk-register-race", "evt-devflow", "register-race", "Registration Race", "race@example.test");
    };

    const response = await write("/api/cfp/devflow-conf-2027/register", "POST", null, {
      displayName: "Race Account",
      email: "race@example.test",
      password: registrationTestPassword,
      title: "",
      company: "",
      bio: "",
      turnstileToken: "valid-registration-token",
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("REGISTRATION_CONFLICT");
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE lower(trim(email)) = ?")
      .get("race@example.test").count).toBe(0);
    expect(database.prepare("SELECT user_id AS userId FROM speakers WHERE id = ?")
      .get("spk-register-race").userId).toBeNull();
  });

  it("keeps generated speaker slugs canonical at the normalization boundary", async () => {
    // 63 characters place the next separator exactly at safeSlug's 64-byte cutoff.
    const boundaryLength = 63;
    const displayName = `${"A".repeat(boundaryLength)} B`;
    const response = await write("/api/cfp/devflow-conf-2027/register", "POST", null, {
      displayName,
      email: "slug-boundary@example.com",
      password: registrationTestPassword,
      title: "",
      company: "",
      bio: "",
      turnstileToken: "valid-registration-token",
    });

    expect(response.status).toBe(201);
    const speaker = database.prepare(
      "SELECT slug FROM speakers WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    ).get("slug-boundary@example.com");
    expect(speaker.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(speaker.slug).toMatch(new RegExp(`^a{${boundaryLength}}-[0-9a-f]{8}$`));
    expect(speaker.slug).not.toContain("--");
  });

  it("rejects invalid or unavailable verification before creating an account", async () => {
    const registration = {
      displayName: "Morgan Ellis",
      email: "morgan@example.com",
      password: registrationTestPassword,
      title: "",
      company: "",
      bio: "",
      turnstileToken: "invalid-registration-token",
    };
    vi.mocked(fetch).mockResolvedValueOnce(siteverifyResponse({
      success: true,
      action: "speaker_registration",
      hostname: "unexpected.example",
    }));

    const invalid = await write("/api/cfp/devflow-conf-2027/register", "POST", null, registration);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("TURNSTILE_INVALID");
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get(registration.email).count).toBe(0);

    currentEnv.TURNSTILE_SECRET_KEY = undefined;
    const unavailable = await write("/api/cfp/devflow-conf-2027/register", "POST", null, {
      ...registration,
      email: "unavailable@example.com",
    });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("REGISTRATION_UNAVAILABLE");
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'unavailable@example.com'").get().count).toBe(0);
  });

  it("rejects an explicit Siteverify denial before creating an account", async () => {
    const registration = {
      displayName: "Riley Chen",
      email: "siteverify-denied@example.com",
      password: registrationTestPassword,
      title: "",
      company: "",
      bio: "",
      turnstileToken: "denied-registration-token",
    };
    vi.mocked(fetch).mockResolvedValueOnce(siteverifyResponse({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    }));

    const response = await write("/api/cfp/devflow-conf-2027/register", "POST", null, registration);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("TURNSTILE_INVALID");
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get(registration.email).count).toBe(0);
  });

  it.each([
    ["a rejected provider request", "siteverify-rejected@example.com", () => Promise.reject(new Error("Siteverify unavailable"))],
    ["a non-200 provider response", "siteverify-non-200@example.com", () => Promise.resolve(siteverifyResponse({ success: false }, 502))],
  ])("fails closed on %s before creating an account", async (_case, email, providerResult) => {
    vi.mocked(fetch).mockImplementationOnce(providerResult);

    const response = await write("/api/cfp/devflow-conf-2027/register", "POST", null, {
      displayName: "Taylor Morgan",
      email,
      password: registrationTestPassword,
      title: "",
      company: "",
      bio: "",
      turnstileToken: "unavailable-registration-token",
    });

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("REGISTRATION_UNAVAILABLE");
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?").get(email).count).toBe(0);
  });

  it("lets an authenticated speaker join a second event without creating another identity", async () => {
    const speaker = addSpeakerSession(database, { suffix: "multi-event" });
    const joined = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);
    const repeated = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);
    const body = await joined.json();
    expect(joined.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(body.data.memberships).toEqual([
      { eventSlug: "devflow-conf-2027", role: "speaker" },
      { eventSlug: "field-notes-2027", role: "speaker" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(speaker.userId).count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE user_id = ?").get(speaker.userId).count).toBe(2);
  });

  it("lets an authenticated organizer add speaker access without losing organizer access", async () => {
    const organizerCookie = addOrganizerSession(database);

    const joined = await write("/api/cfp/devflow-conf-2027/join", "POST", organizerCookie);
    const repeated = await write("/api/cfp/devflow-conf-2027/join", "POST", organizerCookie);
    const body = await joined.json();

    expect(joined.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(body.data.memberships).toEqual([
      { eventSlug: "devflow-conf-2027", role: "organizer" },
      { eventSlug: "devflow-conf-2027", role: "speaker" },
    ]);
    expect(database.prepare(`SELECT role FROM event_memberships
      WHERE event_id = 'evt-devflow' AND user_id = 'usr-devflow-organizer' ORDER BY role`).all())
      .toEqual([{ role: "organizer" }, { role: "speaker" }]);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM speakers
      WHERE event_id = 'evt-devflow' AND user_id = 'usr-devflow-organizer'`).get().count).toBe(1);

    const organizerWorkspace = await write("/api/events/devflow-conf-2027/cfp", "GET", organizerCookie);
    const speakerWorkspace = await write("/api/events/devflow-conf-2027/proposals", "GET", organizerCookie);
    expect(organizerWorkspace.status).toBe(200);
    expect(speakerWorkspace.status).toBe(200);
  });

  it("restores the speaker membership when a concurrent join creates the same speaker", async () => {
    const speaker = addSpeakerSession(database, { suffix: "join-speaker-race" });
    currentEnv.DB.beforeBatch = () => {
      database.prepare(`INSERT INTO speakers (
        id, event_id, user_id, slug, name, title, company, bio, contact_email,
        headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
      ) VALUES (?, ?, ?, ?, ?, '', '', '', ?, NULL, 'JS', 'incomplete', 'missing', 'private')`)
        .run(
          "spk-field-join-speaker-race",
          "evt-fieldnotes",
          speaker.userId,
          "join-speaker-race",
          "Join Speaker Race",
          "join-speaker-race@example.com",
        );
    };

    const joined = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);

    expect(joined.status).toBe(200);
    expect(database.prepare(`SELECT role FROM event_memberships
      WHERE event_id = ? AND user_id = ?`).all("evt-fieldnotes", speaker.userId))
      .toEqual([{ role: "speaker" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).count).toBe(1);
  });

  it("preserves a concurrently added reviewer role while completing a speaker join", async () => {
    const speaker = addSpeakerSession(database, { suffix: "join-role-race" });
    currentEnv.DB.beforeBatch = () => {
      database.prepare(`INSERT INTO event_memberships (
        id, event_id, user_id, role, created_at
      ) VALUES (?, ?, ?, 'reviewer', ?)`).run(
        "mem-field-join-role-race",
        "evt-fieldnotes",
        speaker.userId,
        "2026-08-12T12:00:00Z",
      );
    };

    const joined = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);

    expect(joined.status).toBe(200);
    expect(database.prepare(`SELECT role FROM event_memberships
      WHERE event_id = ? AND user_id = ? ORDER BY role`).all("evt-fieldnotes", speaker.userId))
      .toEqual([{ role: "reviewer" }, { role: "speaker" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).count).toBe(1);
  });

  it("does not let an unverified authenticated email claim an unowned second-event profile", async () => {
    const speaker = addSpeakerSession(database, { suffix: "claim-second-event" });
    const accountEmail = database.prepare("SELECT email FROM users WHERE id = ?").get(speaker.userId).email;
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, ?, NULL, ?, ?, '', '', '', ?, NULL, 'CP', 'incomplete', 'missing', 'private')`)
      .run("spk-field-claim", "evt-fieldnotes", "field-claim", "Precreated Field Speaker", accountEmail);

    const joined = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);
    expect(joined.status).toBe(409);
    expect((await joined.json()).error.code).toBe("SPEAKER_CLAIM_REQUIRES_VERIFICATION");
    expect(database.prepare("SELECT user_id AS userId, name FROM speakers WHERE id = ?").get("spk-field-claim"))
      .toEqual({ userId: null, name: "Precreated Field Speaker" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).count).toBe(0);
  });

  it("rolls back join membership when an unowned matching profile appears before its transaction", async () => {
    const speaker = addSpeakerSession(database, { suffix: "join-race" });
    currentEnv.DB.beforeBatch = () => {
      database.prepare(`INSERT INTO speakers (
        id, event_id, user_id, slug, name, title, company, bio, contact_email,
        headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
      ) VALUES (?, ?, NULL, ?, ?, '', '', '', ?, NULL, 'JR', 'incomplete', 'missing', 'private')`)
        .run("spk-field-join-race", "evt-fieldnotes", "join-race", "Join Race", "join-race@example.com");
    };

    const joined = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);

    expect(joined.status).toBe(409);
    expect((await joined.json()).error.code).toBe("SPEAKER_CLAIM_REQUIRES_VERIFICATION");
    expect(database.prepare("SELECT COUNT(*) AS count FROM event_memberships WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).count).toBe(0);
    expect(database.prepare("SELECT user_id AS userId FROM speakers WHERE id = ?")
      .get("spk-field-join-race").userId).toBeNull();
  });

  it("never claims another email's unowned profile during authenticated join", async () => {
    const speaker = addSpeakerSession(database, { suffix: "claim-boundary" });
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, ?, NULL, ?, ?, '', '', '', ?, NULL, 'VP', 'incomplete', 'missing', 'private')`)
      .run(
        "spk-field-victim", "evt-fieldnotes", "field-victim", "Victim Profile",
        "victim@example.test",
      );

    const joined = await write("/api/cfp/field-notes-2027/join", "POST", speaker.cookie);

    expect(joined.status).toBe(200);
    expect(database.prepare("SELECT user_id AS userId, name FROM speakers WHERE id = ?").get("spk-field-victim"))
      .toEqual({ userId: null, name: "Victim Profile" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM speakers WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).count).toBe(1);
    expect(database.prepare("SELECT contact_email AS email FROM speakers WHERE event_id = ? AND user_id = ?")
      .get("evt-fieldnotes", speaker.userId).email).toBe("claim-boundary@example.com");
  });

  it("returns a conflict instead of a server error when another owned profile holds the normalized email", async () => {
    const organizerCookie = addOrganizerSession(database);
    const organizerEmail = database.prepare("SELECT email FROM users WHERE id = 'usr-devflow-organizer'").get().email;
    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run("usr-owned-email-collision", "owned-email-collision@example.test", "Existing Owner", "2026-08-11T00:00:00Z");
    database.prepare(`INSERT INTO speakers (
      id, event_id, user_id, slug, name, title, company, bio, contact_email,
      headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility
    ) VALUES (?, ?, ?, ?, ?, '', '', '', ?, NULL, 'EO', 'incomplete', 'missing', 'private')`)
      .run("spk-owned-email-collision", "evt-devflow", "usr-owned-email-collision", "owned-email-collision", "Existing Owner", ` ${organizerEmail.toUpperCase()} `);

    const joined = await write("/api/cfp/devflow-conf-2027/join", "POST", organizerCookie);

    expect(joined.status).toBe(409);
    expect((await joined.json()).error.code).toBe("SPEAKER_EMAIL_CONFLICT");
    expect(database.prepare(`SELECT COUNT(*) AS count FROM event_memberships
      WHERE event_id = 'evt-devflow' AND user_id = 'usr-devflow-organizer' AND role = 'speaker'`).get().count).toBe(0);
  });

  it("saves a partial draft idempotently, rejects incomplete submission, and roundtrips exact values", async () => {
    const speaker = addSpeakerSession(database, { suffix: "priya-test" });
    const create = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "local-draft-0001",
      values: { title: completeValues.title },
    });
    const created = (await create.json()).data;
    const repeated = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "local-draft-0001",
      values: { title: "A conflicting retry title" },
    });
    const incomplete = await write(`/api/events/${speaker.eventSlug}/proposals/${created.id}/submit`, "POST", speaker.cookie);

    expect(create.status).toBe(201);
    expect((await repeated.json()).data).toEqual(created);
    expect(incomplete.status).toBe(400);
    expect((await incomplete.json()).error).toMatchObject({ code: "PROPOSAL_INCOMPLETE" });
    expect(database.prepare("SELECT status FROM proposals WHERE id = ?").get(created.id).status).toBe("draft");

    const update = await write(`/api/events/${speaker.eventSlug}/proposals/${created.id}`, "PUT", speaker.cookie, { values: completeValues });
    const submitted = await write(`/api/events/${speaker.eventSlug}/proposals/${created.id}/submit`, "POST", speaker.cookie);
    const reloaded = await createApp().request(`/api/events/${speaker.eventSlug}/proposals/${created.id}`, { headers: { Cookie: speaker.cookie } }, currentEnv);

    expect(update.status).toBe(200);
    expect(submitted.status).toBe(200);
    expect((await submitted.json()).data).toMatchObject({ status: "submitted", values: completeValues });
    expect((await reloaded.json()).data.values).toEqual(completeValues);
    expect(database.prepare("SELECT format, duration_minutes AS duration FROM proposals WHERE id = ?").get(created.id)).toEqual({ format: "workshop", duration: 120 });

    const editedValues = { ...completeValues, key_takeaway: "Profile the graph before changing the build." };
    const edited = await write(`/api/events/${speaker.eventSlug}/proposals/${created.id}`, "PUT", speaker.cookie, { values: editedValues });
    expect(edited.status).toBe(200);
    expect((await edited.json()).data).toMatchObject({ status: "submitted", values: editedValues });
  });

  it("keeps editable co-presenters owner-scoped, reloadable, organizer-visible, and acceptance-safe", async () => {
    const owner = addSpeakerSession(database, { suffix: "co-presenter-owner" });
    const outsider = addSpeakerSession(database, { suffix: "co-presenter-outsider" });
    const foreign = addSpeakerSession(database, {
      eventId: "evt-fieldnotes",
      eventSlug: "field-notes-2027",
      suffix: "co-presenter-foreign",
    });
    const proposal = await write(`/api/events/${owner.eventSlug}/proposals`, "POST", owner.cookie, {
      clientDraftKey: "co-presenter-owner-0001",
      values: completeValues,
    }).then((response) => response.json()).then(({ data }) => data);

    const initial = await createApp().request(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/participants`,
      { headers: { Cookie: owner.cookie } },
      currentEnv,
    );
    expect((await initial.json()).data.participants).toEqual([{
      id: expect.any(String),
      name: "Test co-presenter-owner",
      email: null,
      role: "primary",
    }]);

    const added = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      owner.cookie,
      { name: "  Morgan Lee  ", email: "  MORGAN.LEE@EXAMPLE.TEST  " },
    );
    expect(added.status).toBe(201);
    const addedParticipants = (await added.json()).data.participants;
    expect(addedParticipants).toEqual([
      expect.objectContaining({ name: "Test co-presenter-owner", role: "primary" }),
      expect.objectContaining({ name: "Morgan Lee", email: "morgan.lee@example.test", role: "co_presenter" }),
    ]);
    const morgan = addedParticipants.find(({ role }) => role === "co_presenter");

    const repeated = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      owner.cookie,
      { name: "Morgan Lee", email: "morgan.lee@example.test" },
    );
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).data.participants).toHaveLength(2);

    const removable = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      owner.cookie,
      { name: "Pat Rivera", email: null },
    ).then((response) => response.json()).then(({ data }) =>
      data.participants.find(({ name }) => name === "Pat Rivera"));
    const removed = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters/${removable.id}`,
      "DELETE",
      owner.cookie,
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).data.participants.map(({ name }) => name)).toEqual([
      "Test co-presenter-owner",
      "Morgan Lee",
    ]);
    expect(database.prepare("SELECT id FROM speakers WHERE name = 'Pat Rivera'").get()).toBeUndefined();

    const readded = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      owner.cookie,
      { name: "Pat Rivera", email: null },
    );
    expect(readded.status).toBe(201);
    const readdedPat = (await readded.json()).data.participants.find(({ name }) => name === "Pat Rivera");
    expect(readdedPat).toBeDefined();
    const removedAgain = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters/${readdedPat.id}`,
      "DELETE",
      owner.cookie,
    );
    expect(removedAgain.status).toBe(200);
    expect(database.prepare("SELECT id FROM speakers WHERE name = 'Pat Rivera'").get()).toBeUndefined();

    const existingIdentity = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      owner.cookie,
      { name: "Priya Raman", email: "priya@devflow.example" },
    );
    expect(existingIdentity.status).toBe(409);
    expect((await existingIdentity.json()).error).toMatchObject({
      code: "CO_PRESENTER_CONFLICT",
      message: "This co-presenter could not be added with the submitted details.",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM proposal_presenters WHERE proposal_id = ? AND speaker_id = 'spk-d-priya'",
    ).get(proposal.id).count).toBe(0);

    for (const [eventSlug, cookie] of [
      [outsider.eventSlug, outsider.cookie],
      [foreign.eventSlug, foreign.cookie],
    ]) {
      const scoped = await createApp().request(
        `/api/events/${eventSlug}/proposals/${proposal.id}/participants`,
        { headers: { Cookie: cookie } },
        currentEnv,
      );
      expect(scoped.status).toBe(404);
      expect((await scoped.json()).error.code).toBe("PROPOSAL_NOT_FOUND");
    }
    const outsiderWrite = await write(
      `/api/events/${outsider.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      outsider.cookie,
      { name: "Unauthorized Person", email: "unauthorized@example.test" },
    );
    expect(outsiderWrite.status).toBe(404);
    expect((await outsiderWrite.json()).error.code).toBe("PROPOSAL_NOT_FOUND");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM speakers WHERE event_id = 'evt-devflow' AND name = 'Unauthorized Person'",
    ).get().count).toBe(0);

    const reloaded = await createApp().request(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/participants`,
      { headers: { Cookie: owner.cookie } },
      currentEnv,
    );
    expect((await reloaded.json()).data.participants).toEqual(addedParticipants);

    const submitted = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/submit`,
      "POST",
      owner.cookie,
    );
    expect(submitted.status).toBe(200);
    const organizerCookie = addOrganizerSession(database);
    const organizerDetail = await createApp().request(
      `/api/events/${owner.eventSlug}/cfp/proposals/${proposal.id}/reviews`,
      { headers: { Cookie: organizerCookie } },
      currentEnv,
    );
    expect(organizerDetail.status).toBe(200);
    expect((await organizerDetail.json()).data.proposal.participants).toEqual(addedParticipants);

    const decision = await write(
      `/api/events/${owner.eventSlug}/decisions`,
      "POST",
      organizerCookie,
      { proposalId: proposal.id, decision: "accept", rationale: "The complete team should move downstream." },
    );
    expect(decision.status).toBe(201);
    const sessionId = (await decision.json()).data.handoff.programSession.id;
    expect(database.prepare(
      `SELECT speaker.name, presenter.role
      FROM session_presenters AS presenter
      INNER JOIN speakers AS speaker ON speaker.id = presenter.speaker_id
      WHERE presenter.program_session_id = ? ORDER BY presenter.role DESC, speaker.name`,
    ).all(sessionId)).toEqual([
      { name: "Test co-presenter-owner", role: "primary" },
      { name: "Morgan Lee", role: "co_presenter" },
    ]);

    const lockedAdd = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters`,
      "POST",
      owner.cookie,
      { name: "Too Late", email: "too-late@example.test" },
    );
    const lockedDelete = await write(
      `/api/events/${owner.eventSlug}/proposals/${proposal.id}/co-presenters/${morgan.id}`,
      "DELETE",
      owner.cookie,
    );
    for (const response of [lockedAdd, lockedDelete]) {
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("PROPOSAL_LOCKED");
    }
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM session_presenters WHERE program_session_id = ?",
    ).get(sessionId).count).toBe(2);
  });

  it("keeps proposal update timestamps monotonic across fractional-second values", async () => {
    const speaker = addSpeakerSession(database, { suffix: "monotonic-timestamp" });
    const proposal = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "monotonic-timestamp-0001",
      values: completeValues,
    }).then((response) => response.json()).then(({ data }) => data);

    database.prepare("UPDATE proposals SET updated_at = ? WHERE id = ?")
      .run("2026-08-11T12:00:00.500Z", proposal.id);
    const updated = await write(
      `/api/events/${speaker.eventSlug}/proposals/${proposal.id}`,
      "PUT",
      speaker.cookie,
      { values: { ...completeValues, title: "Monotonic update" } },
    );
    expect(updated.status).toBe(200);
    expect(database.prepare("SELECT updated_at AS updatedAt FROM proposals WHERE id = ?").get(proposal.id))
      .toEqual({ updatedAt: "2026-08-11T12:00:01Z" });

    database.prepare("UPDATE proposals SET updated_at = ? WHERE id = ?")
      .run("2026-08-11T12:00:01.500Z", proposal.id);
    const submitted = await write(
      `/api/events/${speaker.eventSlug}/proposals/${proposal.id}/submit`,
      "POST",
      speaker.cookie,
    );
    expect(submitted.status).toBe(200);
    expect(database.prepare("SELECT updated_at AS updatedAt FROM proposals WHERE id = ?").get(proposal.id))
      .toEqual({ updatedAt: "2026-08-11T12:00:02Z" });
  });

  it("fails a submitted edit atomically when review starts after the ownership read", async () => {
    const speaker = addSpeakerSession(database, { suffix: "review-race" });
    const created = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "review-race-0001",
      values: completeValues,
    }).then((response) => response.json()).then(({ data }) => data);
    expect((await write(
      `/api/events/${speaker.eventSlug}/proposals/${created.id}/submit`,
      "POST",
      speaker.cookie,
    )).status).toBe(200);

    const originalDatabase = currentEnv.DB;
    let reviewStarted = false;
    const racingEnv = {
      ...currentEnv,
      DB: {
        prepare: (query) => originalDatabase.prepare(query),
        batch: async (statements) => {
          if (!reviewStarted) {
            database.prepare("UPDATE proposals SET status = 'in_review' WHERE id = ?").run(created.id);
            reviewStarted = true;
          }
          return originalDatabase.batch(statements);
        },
      },
    };
    const changedValues = {
      ...completeValues,
      title: "Changed after review started",
      speaker_bio: "Changed after review started.",
    };
    const response = await createApp().request(
      `/api/events/${speaker.eventSlug}/proposals/${created.id}`,
      {
        method: "PUT",
        headers: { ...sameOriginHeaders, Cookie: speaker.cookie },
        body: JSON.stringify({ values: changedValues }),
      },
      racingEnv,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PROPOSAL_LOCKED");
    expect(database.prepare("SELECT status, title FROM proposals WHERE id = ?").get(created.id)).toEqual({
      status: "in_review",
      title: completeValues.title,
    });
    expect(database.prepare("SELECT bio FROM speakers WHERE id = ?").get(speaker.speakerId).bio).toBe(completeValues.speaker_bio);
    expect(Object.fromEntries(database.prepare(
      "SELECT field_key, value FROM proposal_answers WHERE proposal_id = ? ORDER BY field_key",
    ).all(created.id).map(({ field_key, value }) => [field_key, value]))).toEqual(completeValues);
  });

  it("fails submission when review starts after the ownership read", async () => {
    const speaker = addSpeakerSession(database, { suffix: "submit-review-race" });
    const created = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "submit-review-race-0001",
      values: completeValues,
    }).then((response) => response.json()).then(({ data }) => data);
    expect((await write(
      `/api/events/${speaker.eventSlug}/proposals/${created.id}/submit`,
      "POST",
      speaker.cookie,
    )).status).toBe(200);

    const originalDatabase = currentEnv.DB;
    let reviewStarted = false;
    const racingEnv = {
      ...currentEnv,
      DB: {
        prepare: (query) => {
          const statement = originalDatabase.prepare(query);
          if (!query.includes("UPDATE proposals SET status = 'submitted'")) return statement;
          return {
            bind: (...params) => {
              const bound = statement.bind(...params);
              return {
                run: async () => {
                  if (!reviewStarted) {
                    database.prepare("UPDATE proposals SET status = 'in_review' WHERE id = ?").run(created.id);
                    reviewStarted = true;
                  }
                  return bound.run();
                },
              };
            },
          };
        },
        batch: (statements) => originalDatabase.batch(statements),
      },
    };
    const response = await createApp().request(
      `/api/events/${speaker.eventSlug}/proposals/${created.id}/submit`,
      { method: "POST", headers: { ...sameOriginHeaders, Cookie: speaker.cookie } },
      racingEnv,
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("PROPOSAL_LOCKED");
    expect(database.prepare("SELECT status, submitted_at AS submittedAt FROM proposals WHERE id = ?").get(created.id))
      .toEqual({ status: "in_review", submittedAt: "2026-08-11T12:00:00Z" });
  });

  it("keeps proposals event- and owner-scoped while giving the organizer an exact projection", async () => {
    const first = addSpeakerSession(database, { suffix: "first" });
    const second = addSpeakerSession(database, { suffix: "second" });
    const fieldNotes = addSpeakerSession(database, { eventId: "evt-fieldnotes", eventSlug: "field-notes-2027", suffix: "fieldnotes" });
    const created = await write(`/api/events/${first.eventSlug}/proposals`, "POST", first.cookie, {
      clientDraftKey: "owner-scope-0001",
      values: completeValues,
    });
    const proposal = (await created.json()).data;

    const otherOwner = await createApp().request(`/api/events/${second.eventSlug}/proposals/${proposal.id}`, { headers: { Cookie: second.cookie } }, currentEnv);
    const otherEvent = await createApp().request(`/api/events/${fieldNotes.eventSlug}/proposals/${proposal.id}`, { headers: { Cookie: fieldNotes.cookie } }, currentEnv);
    const organizerCookie = addOrganizerSession(database);
    const organizer = await createApp().request("/api/events/devflow-conf-2027/cfp/proposals", { headers: { Cookie: organizerCookie } }, currentEnv);
    const visible = (await organizer.json()).data.proposals.find(({ id }) => id === proposal.id);

    expect(otherOwner.status).toBe(404);
    expect(otherEvent.status).toBe(404);
    expect(visible).toMatchObject({ values: completeValues, owner: { email: "first@example.com" } });
  });

  it("submits successfully for the second event and keeps bounded organizer pages owner-aware", async () => {
    const fieldNotes = addSpeakerSession(database, { eventId: "evt-fieldnotes", eventSlug: "field-notes-2027", suffix: "fieldnotes-roundtrip" });
    const values = {
      title: "Programs With a Point of View",
      abstract: "Shape a coherent program without flattening the voices inside it.",
      track: "Programming",
      format: "talk",
    };
    const created = await write("/api/events/field-notes-2027/proposals", "POST", fieldNotes.cookie, {
      clientDraftKey: "fieldnotes-draft-0001", values,
    });
    const proposal = (await created.json()).data;
    const submitted = await write(`/api/events/field-notes-2027/proposals/${proposal.id}/submit`, "POST", fieldNotes.cookie);
    expect(submitted.status).toBe(200);
    expect((await submitted.json()).data).toMatchObject({ status: "submitted", values });

    const organizerCookie = addOrganizerSession(database);
    const organizer = await createApp().request("/api/events/devflow-conf-2027/cfp/proposals?limit=3&offset=0", { headers: { Cookie: organizerCookie } }, currentEnv);
    const body = await organizer.json();
    expect(organizer.status).toBe(200);
    expect(body.data.proposals).toHaveLength(3);
    expect(body.data.proposals.some((item) => item.owner?.email)).toBe(true);
    expect(body.data.proposals.every((item) => Object.hasOwn(item, "decision"))).toBe(true);
    expect(body.data.page).toEqual({ limit: 3, offset: 0, hasMore: true });
    const clamped = await createApp().request("/api/events/devflow-conf-2027/cfp/proposals?limit=100", { headers: { Cookie: organizerCookie } }, currentEnv);
    expect((await clamped.json()).data.page.limit).toBe(90);
  });

  it("blocks creation, editing, and submission after the close time", async () => {
    const speaker = addSpeakerSession(database, { suffix: "closed" });
    const created = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "before-close-0001",
      values: { title: completeValues.title },
    });
    const proposal = (await created.json()).data;
    vi.setSystemTime(new Date("2027-05-01T00:00:00Z"));

    const another = await write(`/api/events/${speaker.eventSlug}/proposals`, "POST", speaker.cookie, {
      clientDraftKey: "after-close-0002",
      values: { title: "Late proposal" },
    });
    const edit = await write(`/api/events/${speaker.eventSlug}/proposals/${proposal.id}`, "PUT", speaker.cookie, { values: completeValues });
    const submit = await write(`/api/events/${speaker.eventSlug}/proposals/${proposal.id}/submit`, "POST", speaker.cookie);

    for (const response of [another, edit, submit]) {
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("CFP_CLOSED");
    }
  });

  it("enforces owner and answer event scope in D1 itself", () => {
    database.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES ('outsider', 'outsider@example.com', 'Outsider', '2026-08-11T00:00:00Z')").run();
    expect(() => database.prepare(`INSERT INTO proposals (
      id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
      status, submitted_at, created_at, updated_at, owner_user_id, client_draft_key
    ) VALUES ('bad-owner', 'evt-devflow', 'ABS-BAD', 'bad-owner', 'Bad', '', '', 'talk', 30,
      'draft', NULL, '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', 'outsider', 'bad-owner-key')`).run())
      .toThrow(/proposal owner must be a speaker for the same event/);
    expect(() => database.prepare(`INSERT INTO proposal_answers (
      id, event_id, proposal_id, field_key, value, created_at, updated_at
    ) VALUES ('locked-answer', 'evt-devflow', 'prop-d-2', 'title', 'Nope', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z')`).run())
      .toThrow(/answers for reviewed proposals are immutable/);
    database.prepare("UPDATE proposals SET status = 'draft', submitted_at = NULL WHERE id = 'prop-d-1'").run();
    expect(() => database.prepare(`INSERT INTO proposal_answers (
      id, event_id, proposal_id, field_key, value, created_at, updated_at
    ) VALUES ('bad-answer', 'evt-fieldnotes', 'prop-d-1', 'title', 'Leak', '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z')`).run())
      .toThrow(/proposal answer must use a field from the same event/);
  });

  it("lists a speaker's proposals when the id list exceeds one statement's parameter budget", async () => {
    // The speaker listing has no LIMIT, and every proposal id becomes a bound
    // parameter alongside the event id. Past the 100-parameter ceiling D1 rejects
    // the statement outright, so this failed for any speaker with enough
    // proposals until the lookup was chunked.
    const speaker = addSpeakerSession(database, { suffix: "bulk-proposals" });
    const total = 120;
    for (let index = 0; index < total; index += 1) {
      database.prepare(`INSERT INTO proposals (
        id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
        status, submitted_at, created_at, updated_at, owner_user_id
      ) VALUES (?, 'evt-devflow', ?, ?, ?, 'Bulk abstract.', 'AI Engineering', 'talk', 30,
        'draft', NULL, '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', ?)`)
        .run(`prop-bulk-${index}`, `ABS-B${index}`, `proposal-bulk-${index}`, `Bulk ${index}`, speaker.userId);
    }

    const response = await createApp().request(
      "/api/events/devflow-conf-2027/proposals",
      { headers: { Cookie: speaker.cookie } },
      currentEnv,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.proposals).toHaveLength(total);
  });
});
