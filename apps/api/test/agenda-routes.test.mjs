import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/index.ts";
import { serializeICalendar } from "../src/features/publication/calendar-routes.ts";

class SqliteD1Statement {
  constructor(statement) { this.statement = statement; this.params = []; }
  bind(...params) { const bound = new SqliteD1Statement(this.statement); bound.params = params; return bound; }
  async all() { return { results: this.statement.all(...this.params), success: true, meta: {} }; }
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
      for (const statement of statements) results.push(await statement.all());
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
  database.exec(readFileSync(new URL("../seed/agenda.sql", import.meta.url), "utf8"));
  if (database.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
    throw new Error("Foreign-key enforcement is disabled in the agenda fixture");
  }
  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length > 0) throw new Error(`Agenda fixture has foreign-key errors: ${JSON.stringify(foreignKeyErrors)}`);
  return database;
}

function addSession(database, userId, token) {
  database.prepare(`INSERT INTO auth_sessions (
    id, user_id, token_hash, expires_at, revoked_at, created_at
  ) VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, '2026-08-11T00:00:00Z')`).run(
    `session-${token}`, userId, createHash("sha256").update(token).digest("hex"),
  );
  return `__Host-confpilot_session=${token}`;
}

const mutationHeaders = {
  Origin: "http://localhost",
  "Content-Type": "application/json",
  "X-ConfPilot-Request": "1",
  "Sec-Fetch-Site": "same-origin",
};

function request(app, path, { method = "GET", cookie, body, headers = {} } = {}, env) {
  return app.request(path, {
    method,
    headers: {
      ...(method === "GET" ? {} : mutationHeaders),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

describe("connected agenda routes", () => {
  let database;
  let env;
  let app;
  let organizerCookie;
  let fieldNotesCookie;

  beforeEach(() => {
    database = fixtureDatabase();
    env = {
      DB: new SqliteD1Database(database),
      FILES: {},
      LOGIN_SOURCE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      LOGIN_ACCOUNT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    organizerCookie = addSession(database, "usr-devflow-organizer", "agenda-organizer");
    fieldNotesCookie = addSession(database, "usr-fieldnotes-organizer", "agenda-fieldnotes");
    app = createApp();
  });

  afterEach(() => database.close());

  it("requires the event organizer and returns an accepted-only isolated builder", async () => {
    expect((await request(app, "/api/events/devflow-conf-2027/agenda", {}, env)).status).toBe(401);
    expect((await request(app, "/api/events/devflow-conf-2027/agenda", {
      cookie: fieldNotesCookie,
    }, env)).status).toBe(403);

    const response = await request(app, "/api/events/devflow-conf-2027/agenda", {
      cookie: organizerCookie,
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.event).toMatchObject({
      slug: "devflow-conf-2027", timeZone: "America/Los_Angeles", status: "published",
    });
    expect(body.data.days).toHaveLength(3);
    expect(body.data.rooms).toHaveLength(4);
    expect(body.data.tracks.map(({ name }) => name)).toEqual([
      "AI Engineering", "Platform & Infra", "Developer Experience",
    ]);
    expect(body.data.sessions).toHaveLength(8);
    expect(body.data.publication).toEqual({
      publicSessionCount: 5,
      unplacedCount: 0,
      contentNotApprovedCount: 2,
      primarySpeakerNotPublicCount: 0,
      readinessBlockedCount: 1,
      awaitingPublicationCount: 0,
    });
    expect(body.data.sessions.every(({ acceptanceStatus }) => acceptanceStatus === "accepted")).toBe(true);
    expect(body.data.sessions.find(({ id }) => id === "ses-d-2").presenters).toEqual([
      expect.objectContaining({ name: "Priya Raman", role: "primary" }),
      expect.objectContaining({ name: "Marcus Okafor", role: "co_presenter" }),
    ]);
    expect(JSON.stringify(body.data)).not.toContain("field-notes-2027");

    database.prepare(`UPDATE speakers SET public_visibility = 'private', revision = revision + 1,
      updated_at = '2027-04-20T19:00:00Z' WHERE id = 'spk-d-amara'`).run();
    const drifted = await request(app, "/api/events/devflow-conf-2027/agenda", {
      cookie: organizerCookie,
    }, env);
    expect(drifted.status).toBe(200);
    // The speakers_demote_approved_update trigger moves the affected session
    // back to pending before the publication summary is recalculated.
    expect((await drifted.json()).data.publication).toEqual({
      publicSessionCount: 4,
      unplacedCount: 0,
      contentNotApprovedCount: 3,
      primarySpeakerNotPublicCount: 0,
      readinessBlockedCount: 1,
      awaitingPublicationCount: 0,
    });
  });

  it("creates configuration with strict validation, semantic replay, and future-safe updates", async () => {
    const path = "/api/events/devflow-conf-2027/agenda/rooms";
    const invalid = await request(app, path, {
      method: "POST", cookie: organizerCookie,
      body: { name: "Overflow Room", capacity: 80, sortOrder: 5, extra: true },
    }, env);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_FAILED");

    const created = await request(app, path, {
      method: "POST", cookie: organizerCookie,
      body: { name: "Overflow Room", capacity: 80, sortOrder: 5 },
    }, env);
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    const room = createdBody.data.rooms.find(({ name }) => name === "Overflow Room");
    expect(room).toMatchObject({ capacity: 80, revision: 1 });

    const replay = await request(app, path, {
      method: "POST", cookie: organizerCookie,
      body: { name: "Overflow Room", capacity: 80, sortOrder: 5 },
    }, env);
    expect(replay.status).toBe(201);
    expect((await replay.json()).data.rooms.filter(({ name }) => name === "Overflow Room")).toHaveLength(1);

    const updated = await request(app, `${path}/${room.id}`, {
      method: "PATCH", cookie: organizerCookie,
      body: { name: "Overflow Room", capacity: 100, sortOrder: 5, revision: 1 },
    }, env);
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.rooms.find(({ id }) => id === room.id))
      .toMatchObject({ capacity: 100, revision: 2 });

    const stale = await request(app, `${path}/${room.id}`, {
      method: "PATCH", cookie: organizerCookie,
      body: { name: "Overflow Room", capacity: 120, sortOrder: 5, revision: 1 },
    }, env);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("REVISION_CONFLICT");

    const track = await request(app, "/api/events/devflow-conf-2027/agenda/tracks", {
      method: "POST", cookie: organizerCookie,
      body: { name: "Community", color: "teal", sortOrder: 4 },
    }, env);
    expect(track.status).toBe(201);
    expect((await track.json()).data.tracks).toContainEqual(expect.objectContaining({
      name: "Community", color: "teal", revision: 1,
    }));

    const dayUpdate = await request(app, "/api/events/devflow-conf-2027/agenda/days/day-d-1", {
      method: "PATCH", cookie: organizerCookie,
      body: {
        date: "2027-05-12", label: "Opening day", opensAt: "2027-05-12T16:00:00Z",
        closesAt: "2027-05-12T23:00:00Z", slotMinutes: 15, revision: 1,
      },
    }, env);
    expect(dayUpdate.status).toBe(200);
    expect((await dayUpdate.json()).data.days.find(({ id }) => id === "day-d-1"))
      .toMatchObject({ label: "Opening day", revision: 2 });

    const referencedDay = await request(app, "/api/events/devflow-conf-2027/agenda/days/day-d-1", {
      method: "PATCH", cookie: organizerCookie,
      body: {
        date: "2027-05-12", label: "Opening day", opensAt: "2027-05-12T15:00:00Z",
        closesAt: "2027-05-12T23:00:00Z", slotMinutes: 15, revision: 2,
      },
    }, env);
    expect(referencedDay.status).toBe(409);
    expect((await referencedDay.json()).error.code).toBe("DAY_HAS_PLACEMENTS");
  });

  it("assigns distinct day numbers when different dates are created concurrently", async () => {
    database.prepare("UPDATE events SET ends_on = '2027-05-16' WHERE id = 'evt-devflow'").run();
    const createDay = (date, label) => request(app, "/api/events/devflow-conf-2027/agenda/days", {
      method: "POST",
      cookie: organizerCookie,
      body: {
        date,
        label,
        opensAt: `${date}T16:00:00Z`,
        closesAt: `${date}T23:00:00Z`,
        slotMinutes: 15,
      },
    }, env);

    const responses = await Promise.all([
      createDay("2027-05-15", "Day 4"),
      createDay("2027-05-16", "Day 5"),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    const createdDays = database.prepare(`SELECT day_number AS dayNumber, date FROM event_days
      WHERE event_id = 'evt-devflow' AND date >= '2027-05-15'`).all();
    expect(createdDays.map(({ dayNumber }) => dayNumber).sort()).toEqual([4, 5]);
    expect(createdDays.map(({ date }) => date).sort()).toEqual(["2027-05-15", "2027-05-16"]);
  });

  it("persists manual speaker overlaps as diagnostics while rejecting room overlaps", async () => {
    const move = (placementId, body) => request(app,
      `/api/events/devflow-conf-2027/agenda/placements/${placementId}`,
      { method: "PATCH", cookie: organizerCookie, body }, env);

    expect((await move("plc-d-2", {
      dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T17:00:00Z", revision: 1,
    })).status).toBe(200);
    const conflictResponse = await move("plc-d-3", {
      dayId: "day-d-1", roomId: "room-d-2b", startsAt: "2027-05-12T17:00:00Z", revision: 1,
    });
    expect(conflictResponse.status).toBe(200);
    const conflictBody = await conflictResponse.json();
    expect(conflictBody.data.conflicts).toEqual([expect.objectContaining({
      speaker: expect.objectContaining({ name: "Priya Raman" }),
      sessionIds: ["ses-d-2", "ses-d-3"],
      startsAt: "2027-05-12T17:00:00Z",
      endsAt: "2027-05-12T17:30:00Z",
    })]);

    const roomConflict = await move("plc-d-4", {
      dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T17:00:00Z", revision: 1,
    });
    expect(roomConflict.status).toBe(409);
    expect((await roomConflict.json()).error.code).toBe("ROOM_CONFLICT");
    expect(database.prepare("SELECT event_day_id AS dayId FROM schedule_placements WHERE id = 'plc-d-4'").get())
      .toEqual({ dayId: "day-d-2" });

    const cleared = await move("plc-d-3", {
      dayId: "day-d-1", roomId: "room-d-2b", startsAt: "2027-05-12T21:00:00Z", revision: 2,
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.conflicts).toEqual([]);
  });

  it("fails closed across program, embed, calendar, and readiness during a speaker overlap", async () => {
    const conflicted = await request(app,
      "/api/events/devflow-conf-2027/agenda/placements/plc-d-3",
      {
        method: "PATCH",
        cookie: organizerCookie,
        body: {
          dayId: "day-d-1",
          roomId: "room-d-2b",
          startsAt: "2027-05-12T17:15:00Z",
          revision: 1,
        },
      }, env);
    expect(conflicted.status).toBe(200);
    expect((await conflicted.json()).data.conflicts).toHaveLength(1);

    const program = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    const programSlugs = (await program.json()).data.sessions.map(({ slug }) => slug);
    expect(programSlugs).not.toContain("taming-40-minute-ci");
    expect(programSlugs).not.toContain("ai-pair-programmer-verification");

    const embed = await request(app,
      "/api/public/events/devflow-conf-2027/embeds/homepage-agenda", {}, env);
    const embedSlugs = (await embed.json()).data.program.sessions.map(({ slug }) => slug);
    expect(embedSlugs).not.toContain("taming-40-minute-ci");
    expect(embedSlugs).not.toContain("ai-pair-programmer-verification");

    const calendar = await request(app, "/api/program.ics?event=devflow-conf-2027", {}, env);
    const calendarText = await calendar.text();
    expect(calendarText).not.toContain("Taming 40-Minute CI");
    expect(calendarText).not.toContain("Your AI Pair Programmer Is Lying to You");

    const readiness = await request(app, "/api/events/devflow-conf-2027/readiness", {
      cookie: organizerCookie,
    }, env);
    const readinessBody = await readiness.json();
    const conflictBlockers = readinessBody.data.blockers.filter(({ kind }) => kind === "speaker_conflict");
    expect(conflictBlockers).toEqual([
      expect.objectContaining({ entityId: "ses-d-2", actionPath: "/admin/agenda?session=ses-d-2" }),
      expect.objectContaining({ entityId: "ses-d-3", actionPath: "/admin/agenda?session=ses-d-3" }),
    ]);
  });

  it("demotes a published session when a placement is deleted outside the agenda route", () => {
    const before = database.prepare(
      "SELECT publication_status AS status, revision FROM program_sessions WHERE id = 'ses-d-1'",
    ).get();
    expect(before.status).toBe("published");

    database.prepare("DELETE FROM schedule_placements WHERE id = 'plc-d-1'").run();

    expect(database.prepare(
      "SELECT publication_status AS status, revision FROM program_sessions WHERE id = 'ses-d-1'",
    ).get()).toEqual({ status: "ready", revision: before.revision + 1 });
  });

  it("creates and unplaces accepted sessions without leaking a second event", async () => {
    database.prepare("DELETE FROM schedule_placements WHERE id = 'plc-d-8'").run();
    const create = await request(app, "/api/events/devflow-conf-2027/agenda/placements", {
      method: "POST", cookie: organizerCookie,
      body: { sessionId: "ses-d-8", dayId: "day-d-3", roomId: "room-d-2b", startsAt: "2027-05-14T21:15:00Z" },
    }, env);
    expect(create.status).toBe(201);
    const createdBody = await create.json();
    const placement = createdBody.data.sessions.find(({ id }) => id === "ses-d-8").placement;
    expect(placement).toMatchObject({ startsAt: "2027-05-14T21:15:00Z", endsAt: "2027-05-14T21:45:00Z" });

    const deleted = await request(app,
      `/api/events/devflow-conf-2027/agenda/placements/${placement.id}?expectedRevision=1`,
      { method: "DELETE", cookie: organizerCookie }, env);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data.sessions.find(({ id }) => id === "ses-d-8").placement).toBeNull();

    const otherEventSession = await request(app, "/api/events/devflow-conf-2027/agenda/placements", {
      method: "POST", cookie: organizerCookie,
      body: { sessionId: "ses-f-1", dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T22:00:00Z" },
    }, env);
    expect(otherEventSession.status).toBe(409);
    expect((await otherEventSession.json()).error.code).toBe("SESSION_NOT_SCHEDULABLE");
  });

  it("atomically demotes a published session when unplaced across program, embed, and calendar", async () => {
    const before = database.prepare(
      "SELECT publication_status AS status, revision FROM program_sessions WHERE id = 'ses-d-2'",
    ).get();
    expect(before.status).toBe("published");

    const deleted = await request(app,
      "/api/events/devflow-conf-2027/agenda/placements/plc-d-2?expectedRevision=1",
      { method: "DELETE", cookie: organizerCookie }, env);
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data.sessions.find(({ id }) => id === "ses-d-2"))
      .toMatchObject({ publicationStatus: "ready", placement: null });
    expect(database.prepare(
      "SELECT publication_status AS status, revision FROM program_sessions WHERE id = 'ses-d-2'",
    ).get()).toEqual({ status: "ready", revision: before.revision + 1 });

    const program = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect((await program.json()).data.sessions.map(({ slug }) => slug)).not.toContain("taming-40-minute-ci");

    const embed = await request(app,
      "/api/public/events/devflow-conf-2027/embeds/homepage-agenda", {}, env);
    expect(embed.status).toBe(200);
    expect((await embed.json()).data.program.sessions.map(({ slug }) => slug)).not.toContain("taming-40-minute-ci");

    const calendar = await request(app, "/api/program.ics?event=devflow-conf-2027", {}, env);
    expect(calendar.status).toBe(200);
    expect(await calendar.text()).not.toContain("Taming 40-Minute CI");

    const readiness = await request(app, "/api/events/devflow-conf-2027/readiness", {
      cookie: organizerCookie,
    }, env);
    expect(readiness.status).toBe(200);
    const readinessBody = await readiness.json();
    expect(readinessBody.data.lifecycle.find(({ stage }) => stage === "scheduled"))
      .toMatchObject({ count: 7, total: 8 });
    expect(readinessBody.data.lifecycle.find(({ stage }) => stage === "published"))
      .toMatchObject({ count: 4, total: 8 });
    expect(readinessBody.data.blockers).toContainEqual(expect.objectContaining({
      id: "session_unscheduled:ses-d-2",
      kind: "session_unscheduled",
      entityId: "ses-d-2",
      actionPath: "/admin/agenda?session=ses-d-2",
    }));
  });

  it("auto-places deterministically without room or presenter conflicts", async () => {
    database.prepare("DELETE FROM schedule_placements WHERE id = 'plc-d-8'").run();
    const response = await request(app, "/api/events/devflow-conf-2027/agenda/auto-place", {
      method: "POST", cookie: organizerCookie, body: { sessionIds: ["ses-d-8"] },
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.results).toEqual([{
      sessionId: "ses-d-8",
      status: "placed",
      placement: expect.objectContaining({
        dayId: "day-d-1", roomId: "room-d-2a",
        startsAt: "2027-05-12T16:00:00Z", endsAt: "2027-05-12T16:30:00Z",
      }),
    }]);
    expect(body.data.agenda.conflicts).toEqual([]);

    const replay = await request(app, "/api/events/devflow-conf-2027/agenda/auto-place", {
      method: "POST", cookie: organizerCookie, body: { sessionIds: ["ses-d-8"] },
    }, env);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.results).toEqual([{
      sessionId: "ses-d-8", status: "unplaced", reason: "SESSION_ALREADY_PLACED",
    }]);
  });

  it("blocks conflicted publication and publishes a conflict-free agenda idempotently", async () => {
    const move = (placementId, body) => request(app,
      `/api/events/devflow-conf-2027/agenda/placements/${placementId}`,
      { method: "PATCH", cookie: organizerCookie, body }, env);
    await move("plc-d-2", {
      dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T17:00:00Z", revision: 1,
    });
    await move("plc-d-3", {
      dayId: "day-d-1", roomId: "room-d-2b", startsAt: "2027-05-12T17:00:00Z", revision: 1,
    });
    const blocked = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("AGENDA_HAS_CONFLICTS");

    await move("plc-d-3", {
      dayId: "day-d-1", roomId: "room-d-2b", startsAt: "2027-05-12T21:00:00Z", revision: 2,
    });
    database.prepare("UPDATE events SET status = 'scheduled', agenda_published_at = NULL WHERE id = 'evt-devflow'").run();
    database.prepare(`UPDATE program_sessions SET publication_status = 'ready', revision = revision + 1,
      updated_at = '2027-05-01T18:00:00Z' WHERE id = 'ses-d-2'`).run();

    const published = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(published.status).toBe(200);
    const body = await published.json();
    expect(body.data.agenda.event).toMatchObject({ status: "published" });
    expect(body.data.agenda.event.agendaPublishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(body.data.publicPaths).toEqual({
      program: "/program", calendar: "/api/program.ics?event=devflow-conf-2027",
    });
    expect(body.data.publication).toEqual({
      outcome: "changed",
      newlyPublicSessionCount: 5,
      publicSessionCount: 5,
      skipped: [
        { reason: "CONTENT_NOT_APPROVED", count: 2 },
        { reason: "READINESS_BLOCKED", count: 1 },
      ],
    });
    expect(database.prepare("SELECT publication_status AS value FROM program_sessions WHERE id = 'ses-d-2'").get())
      .toEqual({ value: "published" });

    database.prepare(`UPDATE program_sessions SET publication_status = 'ready', revision = revision + 1,
      updated_at = '2099-05-01T18:00:00Z' WHERE id = 'ses-d-2'`).run();
    const pendingProgram = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(pendingProgram.status).toBe(200);
    expect((await pendingProgram.json()).data.sessions.map(({ slug }) => slug))
      .not.toContain("taming-40-minute-ci");

    const replay = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(Date.parse(replayBody.data.agenda.event.agendaPublishedAt))
      .toBeGreaterThan(Date.parse(body.data.agenda.event.agendaPublishedAt));
    expect(replayBody.data.publication).toEqual({
      outcome: "changed",
      newlyPublicSessionCount: 1,
      publicSessionCount: 5,
      skipped: [
        { reason: "CONTENT_NOT_APPROVED", count: 2 },
        { reason: "READINESS_BLOCKED", count: 1 },
      ],
    });
    const republishedProgram = await request(app, "/api/program?event=devflow-conf-2027", {}, env);
    expect(republishedProgram.status).toBe(200);
    const republishedProgramBody = await republishedProgram.json();
    expect(republishedProgramBody.data.sessions.map(({ slug }) => slug)).toContain("taming-40-minute-ci");
    expect(republishedProgramBody.data.sessions).toHaveLength(replayBody.data.publication.publicSessionCount);

    const unchanged = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(unchanged.status).toBe(200);
    const unchangedBody = await unchanged.json();
    expect(unchangedBody.data.agenda.event.agendaPublishedAt)
      .toBe(replayBody.data.agenda.event.agendaPublishedAt);
    expect(unchangedBody.data.publication).toEqual({
      outcome: "unchanged",
      newlyPublicSessionCount: 0,
      publicSessionCount: 5,
      skipped: [
        { reason: "CONTENT_NOT_APPROVED", count: 2 },
        { reason: "READINESS_BLOCKED", count: 1 },
      ],
    });
  });

  it("requires at least one placement before publishing", async () => {
    database.prepare("DELETE FROM schedule_placements WHERE event_id = 'evt-devflow'").run();
    const response = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("NOTHING_TO_PUBLISH");
  });

  it("does not mark an event published when no scheduled session can be public", async () => {
    database.prepare("UPDATE events SET status = 'scheduled', agenda_published_at = NULL WHERE id = 'evt-devflow'").run();
    database.prepare(`UPDATE speakers SET public_visibility = 'private',
      revision = revision + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
      WHERE event_id = 'evt-devflow'`).run();

    const response = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("NO_PUBLIC_SESSIONS");
    expect(database.prepare(`SELECT status, agenda_published_at AS agendaPublishedAt
      FROM events WHERE id = 'evt-devflow'`).get()).toEqual({
      status: "scheduled", agendaPublishedAt: null,
    });
  });

  it("publishes eligible sessions while reporting a legacy private-primary session", async () => {
    // Reproduce a legacy inconsistent row that predates the current demotion trigger.
    database.exec("DROP TRIGGER speakers_demote_approved_update");
    database.prepare(`UPDATE speakers SET public_visibility = 'private',
      revision = revision + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+1 second')
      WHERE id = 'spk-d-amara'`).run();
    database.prepare("UPDATE events SET status = 'scheduled', agenda_published_at = NULL WHERE id = 'evt-devflow'").run();
    database.prepare(`UPDATE program_sessions SET publication_status = 'ready', revision = revision + 1,
      updated_at = '2027-05-01T18:00:00Z'
      WHERE event_id = 'evt-devflow' AND approval_status = 'approved'`).run();

    const response = await request(app, "/api/events/devflow-conf-2027/agenda/publish", {
      method: "POST", cookie: organizerCookie,
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.publication).toEqual({
      outcome: "changed",
      newlyPublicSessionCount: 4,
      publicSessionCount: 4,
      skipped: [
        { reason: "CONTENT_NOT_APPROVED", count: 2 },
        { reason: "PRIMARY_SPEAKER_NOT_PUBLIC", count: 1 },
        { reason: "READINESS_BLOCKED", count: 1 },
      ],
    });
    expect(body.data.agenda.sessions.find(({ id }) => id === "ses-d-1").publicationStatus)
      .toBe("ready");
  });

  it("serves a revalidated RFC 5545 calendar from the live public projection", async () => {
    const response = await request(app, "/api/program.ics?event=devflow-conf-2027", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const etag = response.headers.get("etag");
    const body = await response.text();
    expect(body.endsWith("\r\n")).toBe(true);
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(5);
    expect(body).toContain("UID:taming-40-minute-ci.devflow-conf-2027@localhost\r\n");
    expect(body).toContain("DTSTART:20270512T171500Z\r\n");

    const moved = await request(app, "/api/events/devflow-conf-2027/agenda/placements/plc-d-2", {
      method: "PATCH", cookie: organizerCookie,
      body: { dayId: "day-d-1", roomId: "room-d-2a", startsAt: "2027-05-12T22:00:00Z", revision: 1 },
    }, env);
    expect(moved.status).toBe(200);
    const refreshed = await request(app, "/api/program.ics?event=devflow-conf-2027", {
      headers: { "If-None-Match": etag },
    }, env);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).toContain("DTSTART:20270512T220000Z\r\n");

    const unchanged = await request(app, "/api/program.ics?event=devflow-conf-2027", {
      headers: { "If-None-Match": refreshed.headers.get("etag") },
    }, env);
    expect(unchanged.status).toBe(304);
  });

  it("exports only the attendee's selected public sessions", async () => {
    const response = await request(app, "/api/program.ics", {
      method: "POST",
      body: {
        event: "devflow-conf-2027",
        sessionSlugs: ["taming-40-minute-ci", "docs-that-answer-back"],
      },
    }, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition"))
      .toContain('filename="devflow-conf-2027-my-schedule.ics"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const calendar = await response.text();
    expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(calendar).toContain("SUMMARY:Taming 40-Minute CI");
    expect(calendar).toContain("SUMMARY:Docs That Answer Back");
    expect(calendar).toContain("DTSTART:20270512T171500Z");
    expect(calendar).toContain("DTEND:20270512T174500Z");
    expect(calendar).not.toContain("SUMMARY:Workflows That Explain Themselves");

    expect(response.headers.get("etag")).toBeNull();
  });

  it("fails closed for legacy session selectors in a GET query", async () => {
    const response = await request(app,
      "/api/program.ics?event=devflow-conf-2027&session=taming-40-minute-ci", {}, env);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("SESSIONS_IN_BODY_REQUIRED");
  });

  it.each([
    ["unapproved", "devflow-conf-2027", "maintainers-at-scale"],
    ["private", "field-notes-2027", "access-is-an-operating-system"],
    ["cross-event", "devflow-conf-2027", "programs-with-a-point-of-view"],
  ])("never exports a %s session selector", async (_case, eventSlug, sessionSlug) => {
    const response = await request(app, "/api/program.ics", {
      method: "POST", body: { event: eventSlug, sessionSlugs: [sessionSlug] },
    }, env);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SESSIONS_CHANGED");
  });

  it("deduplicates repeated public session selectors", async () => {
    const response = await request(app, "/api/program.ics", {
      method: "POST",
      body: { event: "devflow-conf-2027", sessionSlugs: ["taming-40-minute-ci", "taming-40-minute-ci"] },
    }, env);

    expect(response.status).toBe(200);
    expect((await response.text()).match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("rejects personal calendars beyond the bounded selection limit", async () => {
    const response = await request(app, "/api/program.ics", {
      method: "POST",
      body: {
        event: "devflow-conf-2027",
        sessionSlugs: Array.from({ length: 101 }, () => "taming-40-minute-ci"),
      },
    }, env);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("SESSIONS_INVALID");
  });

  it("rejects malformed personal-calendar session selectors", async () => {
    const response = await request(app, "/api/program.ics", {
      method: "POST", body: { event: "devflow-conf-2027", sessionSlugs: ["bad\nslug"] },
    }, env);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("SESSIONS_INVALID");
  });

  it("rejects malformed personal-calendar JSON", async () => {
    const response = await app.request("http://localhost/api/program.ics", {
      method: "POST",
      headers: mutationHeaders,
      body: "{",
    }, env);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
  });

  it("rejects an oversized declared personal-calendar body before reading it", async () => {
    const response = await app.request("http://localhost/api/program.ics", {
      method: "POST",
      headers: { ...mutationHeaders, "Content-Length": String(16 * 1024 + 1) },
      body: "{}",
    }, env);

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("REQUEST_TOO_LARGE");
  });

  it("stops reading a streamed personal-calendar body at the byte limit", async () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8 * 1024));
      },
    });
    const personalCalendarRequest = new Request("http://localhost/api/program.ics", {
      method: "POST",
      headers: mutationHeaders,
      body,
      duplex: "half",
    });
    expect(personalCalendarRequest.headers.has("content-length")).toBe(false);

    const response = await app.fetch(personalCalendarRequest, env);

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("REQUEST_TOO_LARGE");
    expect(pulls).toBe(3);
  });

  it("accepts exactly 100 bounded personal-calendar selectors", async () => {
    const response = await request(app, "/api/program.ics", {
      method: "POST",
      body: {
        event: "devflow-conf-2027",
        sessionSlugs: Array.from({ length: 100 }, () => "taming-40-minute-ci"),
      },
    }, env);

    expect(response.status).toBe(200);
    expect((await response.text()).match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it("rejects a partially stale personal schedule instead of silently truncating it", async () => {
    const response = await request(app, "/api/program.ics", {
      method: "POST",
      body: {
        event: "devflow-conf-2027",
        sessionSlugs: ["taming-40-minute-ci", "maintainers-at-scale"],
      },
    }, env);

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("SESSIONS_CHANGED");
  });

  it("rejects cross-origin personal-calendar POSTs", async () => {
    const response = await app.request("http://localhost/api/program.ics", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
        "X-ConfPilot-Request": "1",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({
        event: "devflow-conf-2027", sessionSlugs: ["taming-40-minute-ci"],
      }),
    }, env);

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("UNSAFE_REQUEST_REJECTED");
  });

  it("uses the configured instance domain for stable calendar UIDs", async () => {
    env.CALENDAR_UID_DOMAIN = "events.community.example";
    const response = await request(app, "/api/program.ics?event=devflow-conf-2027", {}, env);
    expect(response.status).toBe(200);
    expect(await response.text())
      .toContain("UID:taming-40-minute-ci.devflow-conf-2027@events.community.example\r\n");
  });

  it("falls back to the request host when calendar UID configuration is unsafe", async () => {
    env.CALENDAR_UID_DOMAIN = "unsafe.example\r\nX-INJECTED:1";
    const response = await app.request(
      "https://conference.example/api/program.ics?event=devflow-conf-2027",
      {},
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("UID:taming-40-minute-ci.devflow-conf-2027@conference.example\r\n");
    expect(body).not.toContain("X-INJECTED");
  });

  it("escapes calendar text and folds every content line to 75 UTF-8 bytes", () => {
    const title = `A long, deliberate; title ${"é".repeat(45)}`;
    const calendar = serializeICalendar({
      event: {
        slug: "sample-event", name: "Sample, Event", tagline: "", location: "Hall; West",
        description: "", startsOn: "2027-05-12", endsOn: "2027-05-12",
        timeZone: "America/Los_Angeles", status: "published",
      },
      sessions: [{
        slug: "sample-session", title, abstract: "First\rline\nSecond, line; done", track: "Platform",
        format: "talk", durationMinutes: 30, publicationStatus: "published",
        schedule: { dayNumber: 1, date: "2027-05-12", label: "Day 1", room: "Room, A",
          startsAt: "2027-05-12T17:00:00Z", endsAt: "2027-05-12T17:30:00Z" },
        speakers: [{ slug: "speaker", name: "Speaker", title: "", company: "",
          headshotUrl: null, headshotFallback: "SP" }],
      }],
      speakers: [],
    }, "2027-04-20T18:00:00Z", "conference.example", "Filtered\rX-INJECTED:TRUE");
    expect(calendar).toContain("X-WR-CALNAME:Filtered\\nX-INJECTED:TRUE");
    expect(calendar).not.toContain("\rX-INJECTED:TRUE");
    expect(calendar).toContain("DESCRIPTION:First\\nline\\nSecond\\, line\\; done");
    expect(calendar).toContain("LOCATION:Room\\, A\\, Hall\\; West");
    expect(calendar.split("\r\n").every((line) => new TextEncoder().encode(line).byteLength <= 75))
      .toBe(true);
    expect(calendar).toMatch(/SUMMARY:.*\r\n /);
  });
});
