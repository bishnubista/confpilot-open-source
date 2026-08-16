import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEmbedRoutes, createPublicProgramRoutes } from "../src/features/publication/embed-routes.ts";
import { requireSameOriginMutation } from "../src/request-safety.ts";

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

class RacingEmbedD1Statement extends SqliteD1Statement {
  constructor(statement, beforeRun) {
    super(statement);
    this.beforeRun = beforeRun;
  }

  bind(...params) {
    const bound = new RacingEmbedD1Statement(this.statement, this.beforeRun);
    bound.params = params;
    return bound;
  }

  async run() {
    this.beforeRun();
    return super.run();
  }
}

class RacingEmbedD1Database extends SqliteD1Database {
  raced = false;

  prepare(query) {
    if (this.raced || !query.includes("INSERT INTO public_embed_configs")) return super.prepare(query);
    return new RacingEmbedD1Statement(this.database.prepare(query), () => {
      this.raced = true;
      this.database.prepare(`
        INSERT INTO public_embed_configs (
          id, event_id, slug, name, view, filters_json, enabled, revision,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        "embed-race-winner",
        "evt-devflow",
        "race-winner",
        "Different configuration",
        "sessions",
        '{"days":[],"tracks":[],"formats":[],"rooms":[]}',
        1,
        "usr-devflow-organizer",
        "usr-devflow-organizer",
        "2027-02-21T18:00:00Z",
        "2027-02-21T18:00:00Z",
      );
    });
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

function addSession(database, userId, token) {
  database.prepare(`INSERT INTO auth_sessions (
    id, user_id, token_hash, expires_at, revoked_at, created_at
  ) VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, '2026-08-11T00:00:00Z')`).run(
    `session-${token}`,
    userId,
    createHash("sha256").update(token).digest("hex"),
  );
  return `__Host-confpilot_session=${token}`;
}

function testApp() {
  const app = new Hono();
  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    await next();
    if (!context.res.headers.has("cache-control")) context.header("cache-control", "private, no-store");
  });
  app.use("/api/*", requireSameOriginMutation);
  app.route("/api", createPublicProgramRoutes());
  app.route("/api", createEmbedRoutes());
  return app;
}

const sameOriginHeaders = {
  Origin: "http://localhost",
  "Content-Type": "application/json",
  "X-ConfPilot-Request": "1",
  "Sec-Fetch-Site": "same-origin",
};

function request(app, path, { method = "GET", cookie, body, headers = {} } = {}, env) {
  return app.request(path, {
    method,
    headers: {
      ...(method === "GET" ? {} : sameOriginHeaders),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

const emptyFilters = { days: [], tracks: [], formats: [], rooms: [] };
const defaultAppearance = { theme: "light", accentColor: "#3157D5", density: "comfortable", showSearch: true, showFilters: true, showEventSummary: true };
const legacyAppearance = { ...defaultAppearance, showSearch: false, showFilters: false, showEventSummary: false };
const defaultPresentation = { outputFormat: "iframe", appearance: defaultAppearance };
const legacyPresentation = { outputFormat: "iframe", appearance: legacyAppearance };
const customizedPresentation = { outputFormat: "json", appearance: { theme: "dark", accentColor: "#A1B2C3", density: "compact", showSearch: false, showFilters: true, showEventSummary: false } };

describe("public program and durable embed routes", () => {
  let database;
  let env;
  let app;
  let organizerCookie;
  let reviewerCookie;

  beforeEach(() => {
    database = fixtureDatabase();
    env = {
      DB: new SqliteD1Database(database),
      LOGIN_SOURCE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      LOGIN_ACCOUNT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    organizerCookie = addSession(database, "usr-devflow-organizer", "embed-organizer");
    reviewerCookie = addSession(database, "usr-devflow-reviewer", "embed-reviewer");
    app = testApp();
  });

  afterEach(() => database.close());

  it("publishes only eligible sessions and strips private workflow data", async () => {
    const response = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.sessions.map(({ slug }) => slug)).toEqual([
      "workflows-that-explain-themselves",
      "taming-40-minute-ci",
      "ai-pair-programmer-verification",
      "docs-that-answer-back",
      "boring-path-to-reliability",
    ]);
    expect(body.data.sessions.find(({ slug }) => slug === "taming-40-minute-ci").speakers)
      .toHaveLength(2);
    expect(body.data.speakers.every(({ sessions }) => sessions.length > 0)).toBe(true);

    const serialized = JSON.stringify(body.data);
    for (const privateMarker of [
      "usr-",
      "@devflow.example",
      "Strong opening perspective",
      "reviewer_user_id",
      "decided_by",
      "recipient_email",
      "task:",
    ]) expect(serialized).not.toContain(privateMarker);
    expect(Object.keys(body.data.sessions[0])).not.toContain("id");
    expect(Object.keys(body.data.speakers[0])).not.toContain("id");

    const speakers = await request(app, "/api/program/speakers?event=devflow-conf-2027", {}, env);
    const speakerBody = await speakers.json();
    expect(speakers.status).toBe(200);
    expect(speakerBody.data.event.slug).toBe("devflow-conf-2027");
    expect(speakerBody.data.speakers).toEqual(body.data.speakers);
    expect(speakerBody.data).not.toHaveProperty("sessions");
  });

  it("derives visible initials when legacy public fallback data is blank-like", async () => {
    database.prepare(`UPDATE speakers SET name = '—— ——', headshot_fallback = '—', revision = revision + 1,
      updated_at = '2099-01-01T00:00:00Z' WHERE id = 'spk-d-priya'`).run();

    const response = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    const body = await response.json();
    const priya = body.data.speakers.find(({ slug }) => slug === "priya-raman");
    expect(response.status).toBe(200);
    expect(priya.headshotFallback).toBe("SP");
    expect(body.data.sessions.flatMap(({ speakers }) => speakers)
      .find(({ slug }) => slug === "priya-raman").headshotFallback).toBe("SP");
  });

  it("bounds Unicode-derived initials to two characters", async () => {
    database.prepare(`UPDATE speakers SET name = 'ßeta ßeta', headshot_fallback = '-', revision = revision + 1,
      updated_at = '2099-01-01T00:00:00Z' WHERE id = 'spk-d-priya'`).run();

    const response = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    const body = await response.json();
    const speaker = body.data.speakers.find(({ slug }) => slug === "priya-raman");
    expect(response.status).toBe(200);
    expect(speaker.headshotFallback).toBe("SS");
    expect(body.data.sessions.flatMap(({ speakers }) => speakers)
      .find(({ slug }) => slug === "priya-raman").headshotFallback).toBe("SS");
  });

  it("enforces every eligibility gate and omits a private co-presenter", async () => {
    database.prepare("UPDATE speakers SET public_visibility = 'private', revision = revision + 1, updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-marcus'").run();
    let body = await (await request(app, "/api/program?event=devflow-conf-2027", {}, env)).json();
    expect(body.data.sessions.find(({ slug }) => slug === "taming-40-minute-ci").speakers)
      .toHaveLength(1);
    database.prepare("UPDATE speakers SET public_visibility = 'published', revision = revision + 1, updated_at = '2027-04-20T17:01:00Z' WHERE id = 'spk-d-marcus'").run();

    // Simulate legacy corruption to prove the query's acceptance join is a real
    // defense-in-depth gate; normal D1 writes cannot create this state.
    database.exec("DROP TRIGGER acceptances_immutable_delete");
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM acceptances WHERE id = 'acc-d-1'").run();
    database.exec("PRAGMA foreign_keys = ON");
    body = await (await request(app, "/api/program?event=devflow-conf-2027", {}, env)).json();
    expect(body.data.sessions.map(({ slug }) => slug)).not.toContain("workflows-that-explain-themselves");

    database.prepare("UPDATE program_sessions SET approval_status = 'pending', revision = revision + 1, updated_at = '2027-04-20T17:00:00Z' WHERE id = 'ses-d-2'").run();
    body = await (await request(app, "/api/program?event=devflow-conf-2027", {}, env)).json();
    expect(body.data.sessions.map(({ slug }) => slug)).not.toContain("taming-40-minute-ci");

    database.prepare("UPDATE program_sessions SET publication_status = 'private', revision = revision + 1, updated_at = '2027-04-20T17:00:00Z' WHERE id = 'ses-d-3'").run();
    body = await (await request(app, "/api/program?event=devflow-conf-2027", {}, env)).json();
    expect(body.data.sessions.map(({ slug }) => slug)).not.toContain("ai-pair-programmer-verification");

    database.prepare("DELETE FROM schedule_placements WHERE id = 'plc-d-4'").run();
    body = await (await request(app, "/api/program?event=devflow-conf-2027", {}, env)).json();
    expect(body.data.sessions.map(({ slug }) => slug)).not.toContain("docs-that-answer-back");

    database.prepare("UPDATE speakers SET public_visibility = 'private', revision = revision + 1, updated_at = '2027-04-20T17:00:00Z' WHERE id = 'spk-d-maya'").run();
    body = await (await request(app, "/api/program?event=devflow-conf-2027", {}, env)).json();
    expect(body.data.sessions.map(({ slug }) => slug)).not.toContain("boring-path-to-reliability");

    expect(body.data.sessions.map(({ slug }) => slug)).toEqual([]);

    database.prepare("UPDATE events SET status = 'draft' WHERE id = 'evt-devflow'").run();
    const unpublished = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(unpublished.status).toBe(404);
    expect((await unpublished.json()).error.code).toBe("EVENT_NOT_FOUND");
  });

  it("does not hide an eligible session behind an overlapping non-public session", async () => {
    database.prepare(`UPDATE schedule_placements
      SET created_by_user_id = 'usr-devflow-organizer', updated_by_user_id = 'usr-devflow-organizer',
        revision = 1, created_at = '2027-04-20T17:00:00Z', updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'plc-d-3'`).run();
    database.prepare(`UPDATE schedule_placements
      SET starts_at = '2027-05-12T17:15:00Z', ends_at = '2027-05-12T17:45:00Z',
        revision = 2, updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T17:01:00Z'
      WHERE id = 'plc-d-3'`).run();
    database.prepare(`UPDATE program_sessions
      SET publication_status = 'private', revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'ses-d-3'`).run();

    const response = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(response.status).toBe(200);
    const slugs = (await response.json()).data.sessions.map(({ slug }) => slug);
    expect(slugs).toContain("taming-40-minute-ci");
    expect(slugs).not.toContain("ai-pair-programmer-verification");
  });

  it("does not hide an eligible session behind an overlapping session with open readiness work", async () => {
    database.prepare(`UPDATE schedule_placements
      SET created_by_user_id = 'usr-devflow-organizer', updated_by_user_id = 'usr-devflow-organizer',
        revision = 1, created_at = '2027-04-20T17:00:00Z', updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'plc-d-3'`).run();
    database.prepare(`UPDATE schedule_placements
      SET starts_at = '2027-05-12T17:15:00Z', ends_at = '2027-05-12T17:45:00Z',
        revision = 2, updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T17:01:00Z'
      WHERE id = 'plc-d-3'`).run();
    database.prepare(`INSERT INTO speaker_tasks (
      id, event_id, acceptance_id, program_session_id, speaker_id, task_key, label,
      state, created_at, completed_at, due_at, revision, updated_at, created_by_user_id
    ) VALUES ('task-overlap-open', 'evt-devflow', 'acc-d-3', 'ses-d-3', 'spk-d-priya',
      'slides-recheck', 'Recheck slides', 'open', '2027-04-20T17:00:00Z', NULL,
      '2027-05-01T00:00:00Z', 1, '2027-04-20T17:00:00Z', 'usr-devflow-organizer')`).run();

    const response = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(response.status).toBe(200);
    const slugs = (await response.json()).data.sessions.map(({ slug }) => slug);
    expect(slugs).toContain("taming-40-minute-ci");
    expect(slugs).not.toContain("ai-pair-programmer-verification");
  });

  it("serves cache-revalidated live data instead of a publication snapshot", async () => {
    const first = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    const firstBody = await first.json();
    const firstEtag = first.headers.get("etag");
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(firstEtag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(firstBody).not.toHaveProperty("requestId");

    const byteIdentical = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(await byteIdentical.text()).toBe(JSON.stringify(firstBody));

    const unchanged = await request(app, "/api/program?event=devflow-conf-2027", {
      headers: { "If-None-Match": `"not-current", W/${firstEtag}` },
    }, env);
    expect(unchanged.status).toBe(304);

    const wildcard = await request(app, "/api/program?event=devflow-conf-2027", {
      headers: { "If-None-Match": "*" },
    }, env);
    expect(wildcard.status).toBe(304);

    database.prepare("UPDATE program_sessions SET title = ?, revision = revision + 1, updated_at = '2027-04-20T17:00:00Z' WHERE id = 'ses-d-1'")
      .run("A live program title");
    const changed = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    const changedBody = await changed.json();
    expect(changed.headers.get("etag")).not.toBe(firstEtag);
    expect(changedBody.data.sessions[0].title).toBe("A live program title");
    expect(changedBody.data.sessions[0].title).not.toBe(firstBody.data.sessions[0].title);
  });

  it("projects a versioned same-origin URL for a newly uploaded public headshot", async () => {
    const sha256 = "a".repeat(64);
    database.prepare(`
      UPDATE speakers
      SET headshot_object_key = ?, headshot_original_filename = 'priya.webp',
        headshot_content_type = 'image/webp', headshot_byte_size = 128,
        headshot_sha256 = ?, headshot_uploaded_at = '2027-04-20T17:00:00Z',
        revision = revision + 1, updated_at = '2027-04-20T17:00:00Z'
      WHERE id = 'spk-d-priya'
    `).run("events/evt-devflow/speakers/spk-d-priya/headshots/test.webp", sha256);

    const response = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    const expected = `/api/public/events/devflow-conf-2027/speakers/priya-raman/headshot?v=${sha256.slice(0, 12)}`;
    expect(data.speakers.find(({ slug }) => slug === "priya-raman").headshotUrl).toBe(expected);
    expect(data.sessions.flatMap(({ speakers }) => speakers)
      .filter(({ slug }) => slug === "priya-raman")
      .every(({ headshotUrl }) => headshotUrl === expected)).toBe(true);
    expect(JSON.stringify(data)).not.toContain("events/evt-devflow/");
    expect(JSON.stringify(data)).not.toContain(sha256);
  });

  it("scopes public embeds by event and returns disabled or injected lookups as not found", async () => {
    const live = await request(
      app,
      "/api/public/events/devflow-conf-2027/embeds/homepage-agenda",
      {},
      env,
    );
    expect(live.status).toBe(200);
    expect((await live.json()).data.embed.slug).toBe("homepage-agenda");

    for (const path of [
      "/api/public/events/field-notes-2027/embeds/speaker-gallery",
      "/api/public/events/field-notes-2027/embeds/homepage-agenda",
      "/api/public/events/devflow-conf-2027%27%20OR%201=1--/embeds/homepage-agenda",
    ]) {
      const response = await request(app, path, {}, env);
      expect(response.status, path).toBe(404);
      expect((await response.json()).error.code).toBe("EMBED_NOT_FOUND");
    }
  });

  it("requires organizer auth and same-origin evidence for mutations", async () => {
    const path = "/api/events/devflow-conf-2027/embeds";
    expect((await request(app, path, {}, env)).status).toBe(401);
    expect((await request(app, path, { cookie: reviewerCookie }, env)).status).toBe(403);
    expect((await request(app, path, {
      method: "POST",
      cookie: organizerCookie,
      body: { slug: "schedule", name: "Schedule", view: "sessions", filters: emptyFilters, enabled: true },
      headers: { Origin: "https://attacker.example" },
    }, env)).status).toBe(403);
  });

  it("creates, retries, lists, updates, disables, and conflict-checks durable embeds", async () => {
    const path = "/api/events/devflow-conf-2027/embeds";
    const createBody = {
      slug: "ai-talks",
      name: "AI talks",
      view: "sessions",
      filters: {
        days: ["2027-05-12", "2027-05-12"],
        tracks: ["Platform & Infra", "AI Engineering"],
        formats: ["talk"],
        rooms: [],
      },
      ...defaultPresentation,
      enabled: true,
    };
    const created = await request(app, path, {
      method: "POST", cookie: organizerCookie, body: createBody,
    }, env);
    const repeated = await request(app, path, {
      method: "POST", cookie: organizerCookie, body: createBody,
    }, env);
    expect(created.status).toBe(201);
    expect(repeated.status).toBe(200);
    const createdData = (await created.json()).data;
    expect((await repeated.json()).data.id).toBe(createdData.id);
    expect(createdData).toMatchObject({
      revision: 1,
      publicPath: "/embed/devflow-conf-2027/ai-talks",
      jsonPath: "/api/public/events/devflow-conf-2027/embeds/ai-talks",
      calendarPath: "/api/public/events/devflow-conf-2027/embeds/ai-talks/calendar.ics",
      filters: {
        days: ["2027-05-12"],
        tracks: ["AI Engineering", "Platform & Infra"],
      },
      ...defaultPresentation,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM public_embed_configs WHERE slug = 'ai-talks'").get().count)
      .toBe(1);
    const publicCreated = await request(app, createdData.jsonPath, {}, env);
    expect(publicCreated.status).toBe(200);
    const publicEmbed = (await publicCreated.json()).data.embed;
    expect(publicEmbed).toMatchObject({ appearance: defaultAppearance });
    expect(publicEmbed).not.toHaveProperty("outputFormat");

    const differentCreate = await request(app, path, {
      method: "POST", cookie: organizerCookie, body: { ...createBody, name: "Different" },
    }, env);
    expect(differentCreate.status).toBe(409);

    const list = await request(app, path, { cookie: organizerCookie }, env);
    const listData = (await list.json()).data;
    expect(listData.embeds.map(({ slug }) => slug).sort()).toEqual(["ai-talks", "homepage-agenda"]);
    expect(JSON.stringify(listData)).not.toContain("speaker-gallery");

    const updatePath = `${path}/${encodeURIComponent(createdData.id)}`;
    const updateBody = { ...createBody, name: "AI agenda", view: "agenda", ...customizedPresentation, enabled: false, revision: 1 };
    delete updateBody.slug;
    const updated = await request(app, updatePath, {
      method: "PATCH", cookie: organizerCookie, body: updateBody,
    }, env);
    const retried = await request(app, updatePath, {
      method: "PATCH", cookie: organizerCookie, body: updateBody,
    }, env);
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ ...customizedPresentation, enabled: false, revision: 2 });
    expect((await retried.json()).data.revision).toBe(2);
    expect(database.prepare(`SELECT output_format AS outputFormat, theme, accent_color AS accentColor,
      density, show_search AS showSearch, show_filters AS showFilters,
      show_event_summary AS showEventSummary FROM public_embed_configs WHERE id = ?`).get(createdData.id)).toEqual({
      outputFormat: "json",
      theme: "dark",
      accentColor: "#A1B2C3",
      density: "compact",
      showSearch: 0,
      showFilters: 1,
      showEventSummary: 0,
    });

    const stale = await request(app, updatePath, {
      method: "PATCH", cookie: organizerCookie, body: { ...updateBody, name: "Stale change" },
    }, env);
    expect(stale.status).toBe(409);
    const disabled = await request(app, createdData.jsonPath, {}, env);
    expect(disabled.status).toBe(404);
  });

  it("advances the embed timestamp when an update clock does not move forward", async () => {
    const before = database.prepare(`SELECT id, revision, updated_at AS updatedAt
      FROM public_embed_configs WHERE event_id = 'evt-devflow' AND slug = 'homepage-agenda'`).get();
    const response = await request(
      app,
      `/api/events/devflow-conf-2027/embeds/${encodeURIComponent(before.id)}`,
      {
        method: "PATCH",
        cookie: organizerCookie,
        body: {
          name: "Homepage schedule",
          view: "agenda",
          filters: emptyFilters,
          ...legacyPresentation,
          enabled: true,
          revision: before.revision,
        },
      },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Date.parse(body.data.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it("treats reordered stored filter keys as the same configuration", async () => {
    database.prepare(`
      UPDATE public_embed_configs
      SET filters_json = ?, revision = revision + 1, updated_at = ?
      WHERE event_id = 'evt-devflow' AND slug = 'homepage-agenda'
    `).run('{"rooms":[],"formats":[],"tracks":[],"days":[]}', '2027-02-21T18:00:01Z');

    const repeated = await request(app, "/api/events/devflow-conf-2027/embeds", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "homepage-agenda",
        name: "Homepage agenda",
        view: "agenda",
        filters: emptyFilters,
        ...legacyPresentation,
        enabled: true,
      },
    }, env);

    expect(repeated.status).toBe(200);
    expect((await repeated.json()).data).toMatchObject({ slug: "homepage-agenda", revision: 2 });
  });

  it("maps a different concurrent create winner to the stable conflict response", async () => {
    const raceEnv = { ...env, DB: new RacingEmbedD1Database(database) };
    const raced = await request(app, "/api/events/devflow-conf-2027/embeds", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "race-winner",
        name: "Requested configuration",
        view: "agenda",
        filters: emptyFilters,
        enabled: false,
      },
    }, raceEnv);

    expect(raced.status).toBe(409);
    expect((await raced.json()).error.code).toBe("EMBED_CONFLICT");
  });

  it("creates the maximum-length slug with stable public paths and rejects the next byte", async () => {
    const slug = "a".repeat(128);
    const created = await request(app, "/api/events/devflow-conf-2027/embeds", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug,
        name: "Maximum length slug",
        view: "sessions",
        filters: emptyFilters,
        enabled: false,
      },
    }, env);

    expect(created.status).toBe(201);
    const data = (await created.json()).data;
    expect(data.slug).toBe(slug);
    expect(data.publicPath).toBe(`/embed/devflow-conf-2027/${slug}`);
    expect(data.jsonPath).toBe(`/api/public/events/devflow-conf-2027/embeds/${slug}`);
    expect(data.calendarPath).toBe(`/api/public/events/devflow-conf-2027/embeds/${slug}/calendar.ics`);

    const tooLong = await request(app, "/api/events/devflow-conf-2027/embeds", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "a".repeat(129),
        name: "Too long slug",
        view: "sessions",
        filters: emptyFilters,
        enabled: false,
      },
    }, env);
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("serves a cacheable filtered iCalendar feed only for an enabled saved embed", async () => {
    const created = await request(app, "/api/events/devflow-conf-2027/embeds", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "ai-calendar",
        name: "AI calendar",
        view: "itinerary",
        filters: { days: ["2027-05-12"], tracks: ["AI Engineering"], formats: ["talk"], rooms: [] },
        ...defaultPresentation,
        enabled: true,
      },
    }, env);
    expect(created.status).toBe(201);
    const config = (await created.json()).data;

    const [calendar, json] = await Promise.all([
      request(app, config.calendarPath, {}, env),
      request(app, config.jsonPath, {}, env),
    ]);
    expect(calendar.status).toBe(200);
    expect(calendar.headers.get("content-type")).toContain("text/calendar");
    expect(calendar.headers.get("content-disposition")).toContain('filename="devflow-conf-2027-ai-calendar.ics"');
    const tag = calendar.headers.get("etag");
    expect(tag).toMatch(/^"[a-f0-9]{64}"$/);
    const calendarText = await calendar.text();
    const program = (await json.json()).data.program;
    expect(program.sessions).toHaveLength(1);
    expect(program.sessions[0]).toMatchObject({ track: "AI Engineering", format: "talk" });
    expect(calendarText.match(/BEGIN:VEVENT/g)).toHaveLength(program.sessions.length);
    expect(calendarText.replace(/\r\n /g, "")).toContain(`SUMMARY:${program.sessions[0].title}`);
    expect(calendarText.replace(/\r\n /g, "")).toContain("X-WR-CALNAME:DevFlow Conf 2027 — AI calendar");
    expect(calendarText).not.toContain("Taming 40-Minute CI");

    const unchanged = await request(app, config.calendarPath, { headers: { "If-None-Match": tag } }, env);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("content-type")).toBeNull();
    expect(unchanged.headers.get("content-disposition")).toBeNull();

    const crossEvent = await request(app,
      "/api/public/events/field-notes-2027/embeds/ai-calendar/calendar.ics", {}, env);
    expect(crossEvent.status).toBe(404);
    expect((await request(app,
      "/api/public/events/devflow-conf-2027/embeds/not_valid/calendar.ics", {}, env)).status).toBe(404);

    database.prepare("UPDATE events SET status = 'draft' WHERE id = 'evt-devflow'").run();
    const unpublished = await request(app, config.calendarPath, {}, env);
    expect(unpublished.status).toBe(404);
    expect(unpublished.headers.get("cache-control")).toBe("private, no-store");
    database.prepare("UPDATE events SET status = 'published' WHERE id = 'evt-devflow'").run();

    const disabled = await request(app, `/api/events/devflow-conf-2027/embeds/${config.id}`, {
      method: "PATCH",
      cookie: organizerCookie,
      body: { name: config.name, view: config.view, filters: config.filters, outputFormat: config.outputFormat,
        appearance: config.appearance, enabled: false, revision: config.revision },
    }, env);
    expect(disabled.status).toBe(200);
    expect((await request(app, config.calendarPath, {}, env)).status).toBe(404);
  });

  it("stores supplementary-plane filter labels in D1 canonical order", async () => {
    const created = await request(app, "/api/events/devflow-conf-2027/embeds", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "unicode-tracks",
        name: "Unicode tracks",
        view: "sessions",
        filters: { days: [], tracks: ["😀 AI", "Ａ Platform"], formats: [], rooms: [] },
        enabled: false,
      },
    }, env);

    expect(created.status).toBe(201);
    expect((await created.json()).data.filters.tracks).toEqual(["Ａ Platform", "😀 AI"]);
    expect(database.prepare(
      "SELECT filters_json AS filtersJson FROM public_embed_configs WHERE slug = 'unicode-tracks'",
    ).get().filtersJson).toContain('"tracks":["Ａ Platform","😀 AI"]');
  });

  it("rejects unknown fields and applies embed filters only after eligibility", async () => {
    const organizerPath = "/api/events/devflow-conf-2027/embeds";
    const unknown = await request(app, organizerPath, {
      method: "POST",
      cookie: organizerCookie,
      body: {
        slug: "unsafe",
        name: "Unsafe",
        view: "sessions",
        filters: emptyFilters,
        enabled: true,
        eventId: "evt-fieldnotes",
      },
    }, env);
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("VALIDATION_FAILED");

    const seeded = database.prepare(
      "SELECT id, revision FROM public_embed_configs WHERE slug = 'homepage-agenda'",
    ).get();
    const filtered = await request(app, `${organizerPath}/${seeded.id}`, {
      method: "PATCH",
      cookie: organizerCookie,
      body: {
        name: "One eligible session",
        view: "agenda",
        filters: {
          days: ["2027-05-12"],
          tracks: ["AI Engineering"],
          formats: ["talk"],
          rooms: ["Room 2B"],
        },
        ...legacyPresentation,
        enabled: true,
        revision: seeded.revision,
      },
    }, env);
    expect(filtered.status).toBe(200);
    const publicResponse = await request(
      app,
      "/api/public/events/devflow-conf-2027/embeds/homepage-agenda",
      {},
      env,
    );
    const sessions = (await publicResponse.json()).data.program.sessions;
    expect(sessions.map(({ slug }) => slug)).toEqual(["ai-pair-programmer-verification"]);
    expect(sessions.every(({ schedule, track, format }) =>
      schedule.date === "2027-05-12"
        && schedule.room === "Room 2B"
        && track === "AI Engineering"
        && format === "talk")).toBe(true);
  });
});
