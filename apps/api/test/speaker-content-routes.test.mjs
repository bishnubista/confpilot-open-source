import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireSameOriginMutation } from "../src/request-safety.ts";
import { createSpeakerContentRoutes } from "../src/features/speakers/speaker-content-routes.ts";

class SqliteD1Statement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) {
    const bound = new SqliteD1Statement(this.statement);
    bound.params = params;
    return bound;
  }
  async first(column) {
    const row = this.statement.get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
  async run() {
    const result = this.statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1Database {
  constructor(database) { this.database = database; }
  prepare(query) { return new SqliteD1Statement(this.database.prepare(query)); }
}

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/.test(value)).sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
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

function appWith(handlers) {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("requestId", crypto.randomUUID());
    await next();
  });
  app.use("/api/*", requireSameOriginMutation);
  app.route("/api", createSpeakerContentRoutes(handlers));
  return app;
}

const mutationHeaders = {
  Origin: "http://localhost",
  "X-ConfPilot-Request": "1",
  "Sec-Fetch-Site": "same-origin",
};

function request(app, path, { method = "GET", cookie, json, body, headers = {} } = {}, env) {
  return app.request(path, {
    method,
    headers: {
      ...(method === "GET" ? {} : mutationHeaders),
      ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(body === undefined ? {} : { body }),
  }, env);
}

describe("speaker content route surface", () => {
  let database;
  let env;
  let speakerCookie;
  let organizerCookie;
  let reviewerCookie;

  beforeEach(() => {
    database = fixtureDatabase();
    env = { DB: new SqliteD1Database(database) };
    speakerCookie = addSession(database, "usr-d-priya", "content-speaker");
    organizerCookie = addSession(database, "usr-devflow-organizer", "content-organizer");
    reviewerCookie = addSession(database, "usr-devflow-reviewer", "content-reviewer");
  });

  afterEach(() => database.close());

  it("declares the stable method and path packet", () => {
    const routes = createSpeakerContentRoutes();
    expect(routes.routes
      .filter(({ method }) => method !== "ALL")
      .map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /events/:eventSlug/speaker/content-workspace",
      "PATCH /events/:eventSlug/speaker/profile",
      "POST /events/:eventSlug/speaker/headshot",
      "GET /events/:eventSlug/speaker/headshot/file",
      "PATCH /events/:eventSlug/speaker/tasks/:taskId",
      "POST /events/:eventSlug/speaker/deliverables/:requestId/versions",
      "GET /events/:eventSlug/speaker/deliverables/:versionId/file",
      "POST /events/:eventSlug/speaker/sessions/:sessionId/comments",
      "GET /events/:eventSlug/speakers",
      "POST /events/:eventSlug/speakers",
      "POST /events/:eventSlug/speakers/import",
      "GET /events/:eventSlug/speakers/communications/templates",
      "POST /events/:eventSlug/speakers/communications/reminders",
      "GET /events/:eventSlug/content",
      "GET /events/:eventSlug/content/deliverables.zip",
      "PATCH /events/:eventSlug/content/:sessionId/approval",
      "POST /events/:eventSlug/content/:sessionId/requests",
      "PATCH /events/:eventSlug/content/:sessionId/requests/:requestId",
      "POST /events/:eventSlug/content/:sessionId/reviews",
      "POST /events/:eventSlug/content/:sessionId/comments",
      "PATCH /events/:eventSlug/content/:sessionId",
      "POST /events/:eventSlug/content/:sessionId/history/:historyId/restore",
      "GET /events/:eventSlug/content/deliverables/:versionId/file",
      "PATCH /events/:eventSlug/speakers/:speakerId/tasks/:taskId",
      "POST /events/:eventSlug/speakers/tasks",
      "PATCH /events/:eventSlug/speakers/:speakerId/profile",
      "PATCH /events/:eventSlug/speakers/:speakerId/visibility",
      "PATCH /events/:eventSlug/speakers/:speakerId/workflow",
      "POST /events/:eventSlug/speakers/:speakerId/headshot",
      "GET /events/:eventSlug/speakers/:speakerId/headshot/file",
      "POST /events/:eventSlug/speakers/:speakerId/history/:historyId/restore",
      "GET /public/events/:eventSlug/speakers/:speakerSlug/headshot",
    ]);
  });

  it("enforces speaker, organizer, and anonymous boundaries before dispatch", async () => {
    const speakerWorkspace = vi.fn((context) => context.json({ lane: "speaker" }));
    const organizerRoster = vi.fn((context) => context.json({ lane: "organizer" }));
    const speakerReminderTemplates = vi.fn((context) => context.json({ lane: "templates" }));
    const enqueueSpeakerReminder = vi.fn((context) => context.json({ lane: "reminder" }));
    const exportOrganizerDeliverables = vi.fn(() => new Response("zip", { status: 200 }));
    const publicHeadshot = vi.fn(() => new Response("image", { status: 200 }));
    const app = appWith({ speakerWorkspace, organizerRoster, speakerReminderTemplates, enqueueSpeakerReminder, exportOrganizerDeliverables, publicHeadshot });

    expect((await request(app, "/api/events/devflow-conf-2027/speaker/content-workspace", {}, env)).status)
      .toBe(401);
    expect((await request(app, "/api/events/devflow-conf-2027/speaker/content-workspace", { cookie: organizerCookie }, env)).status)
      .toBe(403);
    expect((await request(app, "/api/events/devflow-conf-2027/speaker/content-workspace", { cookie: speakerCookie }, env)).status)
      .toBe(200);
    expect((await request(app, "/api/events/devflow-conf-2027/speakers", { cookie: reviewerCookie }, env)).status)
      .toBe(403);
    expect((await request(app, "/api/events/devflow-conf-2027/speakers", { cookie: organizerCookie }, env)).status)
      .toBe(200);
    expect((await request(app, "/api/events/devflow-conf-2027/speakers/communications/templates", { cookie: speakerCookie }, env)).status)
      .toBe(403);
    expect((await request(app, "/api/events/devflow-conf-2027/speakers/communications/templates", { cookie: organizerCookie }, env)).status)
      .toBe(200);
    expect((await request(app, "/api/events/devflow-conf-2027/speakers/communications/reminders", {
      method: "POST",
      cookie: organizerCookie,
      json: { speakerId: "spk-d-sanaa", templateKey: "speaker.task-reminder", idempotencyKey: "route-reminder-01" },
    }, env)).status).toBe(200);
    expect((await request(app, "/api/events/devflow-conf-2027/content/deliverables.zip", { cookie: speakerCookie }, env)).status)
      .toBe(403);
    expect((await request(app, "/api/events/devflow-conf-2027/content/deliverables.zip", { cookie: reviewerCookie }, env)).status)
      .toBe(403);
    expect((await request(app, "/api/events/devflow-conf-2027/content/deliverables.zip", { cookie: organizerCookie }, env)).status)
      .toBe(200);
    expect((await request(app, "/api/public/events/devflow-conf-2027/speakers/priya-raman/headshot", {}, env)).status)
      .toBe(200);
    expect(speakerWorkspace).toHaveBeenCalledOnce();
    expect(organizerRoster).toHaveBeenCalledOnce();
    expect(speakerReminderTemplates).toHaveBeenCalledOnce();
    expect(enqueueSpeakerReminder).toHaveBeenCalledOnce();
    expect(exportOrganizerDeliverables).toHaveBeenCalledOnce();
    expect(publicHeadshot).toHaveBeenCalledOnce();
  });

  it("keeps manual and CSV roster ingestion organizer-only", async () => {
    const createOrganizerSpeaker = vi.fn((context) => context.json({ lane: "manual" }));
    const importOrganizerSpeakers = vi.fn((context) => context.json({ lane: "csv" }));
    const app = appWith({ createOrganizerSpeaker, importOrganizerSpeakers });
    const manual = { name: "Avery Stone", email: "avery@example.test", title: "", company: "", bio: "" };
    const csv = new FormData();
    csv.set("file", new File(["name,email\nAvery Stone,avery@example.test"], "speakers.csv", { type: "text/csv" }));

    for (const cookie of [undefined, speakerCookie, reviewerCookie]) {
      expect((await request(app, "/api/events/devflow-conf-2027/speakers", {
        method: "POST", cookie, json: manual,
      }, env)).status).toBe(cookie ? 403 : 401);
      expect((await request(app, "/api/events/devflow-conf-2027/speakers/import", {
        method: "POST", cookie, body: csv,
      }, env)).status).toBe(cookie ? 403 : 401);
    }
    expect((await request(app, "/api/events/devflow-conf-2027/speakers", {
      method: "POST", cookie: organizerCookie, json: manual,
    }, env)).status).toBe(200);
    expect(createOrganizerSpeaker).toHaveBeenCalledOnce();
    expect((await request(app, "/api/events/devflow-conf-2027/speakers/import", {
      method: "POST", cookie: organizerCookie, body: csv,
    }, env)).status).toBe(200);
    expect(importOrganizerSpeakers).toHaveBeenCalledOnce();
  });

  it("rejects speaker-owned visibility changes before calling the profile handler", async () => {
    const updateSpeakerProfile = vi.fn((context) => context.json({ ok: true }));
    const app = appWith({ updateSpeakerProfile });
    const response = await request(app, "/api/events/devflow-conf-2027/speaker/profile", {
      method: "PATCH",
      cookie: speakerCookie,
      json: {
        name: "Priya Raman",
        contactEmail: "priya@devflow.example",
        title: "Principal Engineer",
        company: "Latticework Systems",
        bio: "Builds dependable delivery systems.",
        socialUrls: { website: null, linkedin: null, x: null },
        travelPreferences: "",
        publicVisibility: "private",
        revision: 1,
      },
    }, env);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    expect(updateSpeakerProfile).not.toHaveBeenCalled();
  });

  it("rejects session-scoped headshot deliverable requests", async () => {
    const createDeliverableRequest = vi.fn();
    const app = appWith({ createDeliverableRequest });
    const response = await request(app, "/api/events/devflow-conf-2027/content/ses-d-2/requests", {
      method: "POST", cookie: organizerCookie, json: {
        requestKey: "headshot", requestType: "headshot", label: "Headshot",
        instructions: "Upload image", dueAt: "2027-04-01T17:00:00Z",
        allowedContentTypes: ["image/png"], maxBytes: 10485760, required: true,
      },
    }, env);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
    expect(createDeliverableRequest).not.toHaveBeenCalled();
  });

  it("normalizes multipart upload metadata and requires an idempotency header", async () => {
    const uploadDeliverable = vi.fn((context, input) => context.json({
      name: input.file.name,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    }));
    const app = appWith({ uploadDeliverable });
    const path = "/api/events/devflow-conf-2027/speaker/deliverables/request-1/versions";
    const missingKey = new FormData();
    missingKey.set("file", new File(["%PDF-1.7"], "slides.pdf", { type: "application/pdf" }));
    expect((await request(app, path, {
      method: "POST", cookie: speakerCookie, body: missingKey,
    }, env)).status).toBe(400);

    const valid = new FormData();
    valid.set("file", new File(["%PDF-1.7"], "slides.pdf", { type: "application/pdf" }));
    valid.set("note", "  Second pass  ");
    const response = await request(app, path, {
      method: "POST",
      cookie: speakerCookie,
      body: valid,
      headers: { "Idempotency-Key": "slides-v2-retry" },
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "slides.pdf",
      note: "Second pass",
      idempotencyKey: "slides-v2-retry",
    });
    expect(uploadDeliverable).toHaveBeenCalledOnce();
  });

  it("rejects an oversized declared multipart body before parsing it", async () => {
    const uploadOwnHeadshot = vi.fn();
    const app = appWith({ uploadOwnHeadshot });
    const response = await request(app, "/api/events/devflow-conf-2027/speaker/headshot", {
      method: "POST",
      cookie: speakerCookie,
      body: "not parsed",
      headers: {
        "Content-Type": "multipart/form-data; boundary=unused",
        "Content-Length": String(11 * 1024 * 1024 + 1),
      },
    }, env);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("UPLOAD_TOO_LARGE");
    expect(uploadOwnHeadshot).not.toHaveBeenCalled();
  });

  it("rejects invalid length metadata and oversized parsed files", async () => {
    const uploadOwnHeadshot = vi.fn();
    const app = appWith({ uploadOwnHeadshot });
    const invalid = await request(app, "/api/events/devflow-conf-2027/speaker/headshot", {
      method: "POST", cookie: speakerCookie, body: "unused",
      headers: { "Content-Type": "multipart/form-data; boundary=unused", "Content-Length": "unknown" },
    }, env);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_CONTENT_LENGTH");

    const form = new FormData();
    form.set("file", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
    const oversized = await request(app, "/api/events/devflow-conf-2027/speaker/headshot", {
      method: "POST", cookie: speakerCookie, body: form,
    }, env);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.code).toBe("FILE_TOO_LARGE");
    expect(uploadOwnHeadshot).not.toHaveBeenCalled();
  });

  it("bounds a missing-length streaming multipart body before parsing", async () => {
    const uploadOwnHeadshot = vi.fn();
    const app = appWith({ uploadOwnHeadshot });
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (chunks === 12) controller.close();
      },
    });
    const request = new Request("http://localhost/api/events/devflow-conf-2027/speaker/headshot", {
      method: "POST",
      headers: {
        ...mutationHeaders,
        Cookie: speakerCookie,
        "Content-Type": "multipart/form-data; boundary=unused",
      },
      body,
      duplex: "half",
    });
    expect(request.headers.has("content-length")).toBe(false);
    const response = await app.fetch(request, env);
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("UPLOAD_TOO_LARGE");
    expect(uploadOwnHeadshot).not.toHaveBeenCalled();
  });

  it("rejects unsafe mutation origins before parsing or dispatch", async () => {
    const createContentReview = vi.fn((context) => context.json({ ok: true }));
    const app = appWith({ createContentReview });
    const response = await request(app, "/api/events/devflow-conf-2027/content/ses-d-2/reviews", {
      method: "POST",
      cookie: organizerCookie,
      headers: { Origin: "https://attacker.example" },
      json: {
        versionId: "version-1",
        idempotencyKey: "review-version-1",
        outcome: "approved",
        comment: "Ready.",
        expectedSessionRevision: 1,
      },
    }, env);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("UNSAFE_REQUEST_REJECTED");
    expect(createContentReview).not.toHaveBeenCalled();
  });
});
