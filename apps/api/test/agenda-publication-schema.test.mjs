import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const migrationByName = new Map(migrationFiles.map((name) => [
  name,
  readFileSync(new URL(name, migrationsUrl), "utf8"),
]));
const seed = readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8");

function agendaSeed() {
  return readFileSync(new URL("../seed/agenda.sql", import.meta.url), "utf8");
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db, lastMigration) {
  if (!migrationByName.has(lastMigration)) throw new Error(`Migration not found: ${lastMigration}`);
  for (const name of migrationFiles) {
    db.exec(migrationByName.get(name));
    if (name === lastMigration) break;
  }
}

function seededAgendaDatabase() {
  const db = database();
  applyThrough(db, "0007_agenda_publication.sql");
  db.exec(seed);
  db.exec(agendaSeed());
  return db;
}

function placement(db, overrides = {}) {
  const value = {
    id: "plc-new",
    eventId: "evt-devflow",
    sessionId: "ses-d-3",
    dayId: "day-d-1",
    roomId: "room-d-2b",
    startsAt: "2027-05-12T17:15:00Z",
    endsAt: "2027-05-12T17:45:00Z",
    revision: 1,
    actor: "usr-devflow-organizer",
    now: "2027-04-20T18:00:00Z",
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO schedule_placements (
      id, event_id, program_session_id, event_day_id, room_id, starts_at, ends_at,
      revision, created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.id, value.eventId, value.sessionId, value.dayId, value.roomId,
    value.startsAt, value.endsAt, value.revision, value.actor, value.actor,
    value.now, value.now,
  );
}

describe("agenda publication migration", () => {
  const databases = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop().close();
  });

  it("adds revisioned agenda configuration and preserves the seeded schedule", () => {
    const db = seededAgendaDatabase();
    databases.push(db);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schedule_placements").get().count).toBe(10);
    expect(db.prepare(`
      SELECT opens_at AS opensAt, closes_at AS closesAt, slot_minutes AS slotMinutes,
        revision, created_by_user_id AS createdBy
      FROM event_days WHERE id = 'day-d-1'
    `).get()).toEqual({
      opensAt: "2027-05-12T16:00:00Z",
      closesAt: "2027-05-12T23:00:00Z",
      slotMinutes: 15,
      revision: 1,
      createdBy: "usr-devflow-organizer",
    });
    expect(db.prepare(`
      SELECT name, color, sort_order AS sortOrder, revision
      FROM event_tracks WHERE event_id = 'evt-devflow' ORDER BY sort_order
    `).all()).toEqual([
      { name: "AI Engineering", color: "plum", sortOrder: 1, revision: 1 },
      { name: "Platform & Infra", color: "blue", sortOrder: 2, revision: 1 },
      { name: "Developer Experience", color: "gold", sortOrder: 3, revision: 1 },
    ]);
    expect(db.prepare(`
      SELECT revision, created_by_user_id AS createdBy, updated_by_user_id AS updatedBy
      FROM schedule_placements WHERE id = 'plc-d-2'
    `).get()).toEqual({ revision: 1, createdBy: "usr-devflow-organizer", updatedBy: "usr-devflow-organizer" });
  });

  it("upgrades populated 0006 data without moving sessions and backfills all referenced tracks", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    db.prepare(`
      UPDATE schedule_placements
      SET event_day_id = 'day-d-1', room_id = 'room-d-2b',
        starts_at = '2027-05-12T17:10:00Z', ends_at = '2027-05-12T17:20:00Z'
      WHERE id = 'plc-d-4'
    `).run();
    const before = db.prepare(`
      SELECT id, event_id, program_session_id, event_day_id, room_id, starts_at, ends_at
      FROM schedule_placements ORDER BY id
    `).all();

    db.exec(migrationByName.get("0007_agenda_publication.sql"));

    expect(db.prepare(`
      SELECT id, event_id, program_session_id, event_day_id, room_id, starts_at, ends_at
      FROM schedule_placements ORDER BY id
    `).all()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare(`
      SELECT COUNT(DISTINCT name) AS count FROM event_tracks WHERE event_id = 'evt-devflow'
    `).get().count).toBe(3);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM schedule_placements AS placement
      INNER JOIN event_days AS day ON day.id = placement.event_day_id AND day.event_id = placement.event_id
      WHERE placement.starts_at < day.opens_at OR placement.ends_at > day.closes_at
    `).get().count).toBe(0);
    expect(db.prepare("SELECT slot_minutes AS value FROM event_days WHERE id = 'day-d-1'").get())
      .toEqual({ value: 5 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM schedule_placements AS placement
      INNER JOIN event_days AS day ON day.id = placement.event_day_id AND day.event_id = placement.event_id
      WHERE (unixepoch(placement.starts_at) - unixepoch(day.opens_at)) % (day.slot_minutes * 60) != 0
    `).get().count).toBe(0);
  });

  it("deduplicates case-variant legacy tracks and bounds wide operating-window padding", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    db.prepare("UPDATE proposals SET track = 'platform & infra' WHERE id = 'prop-d-supplemental-submitted'").run();
    db.prepare(`UPDATE schedule_placements SET starts_at = '2027-05-12T00:00:00Z',
      ends_at = '2027-05-12T00:45:00Z' WHERE id = 'plc-d-1'`).run();
    db.prepare(`UPDATE schedule_placements SET starts_at = '2027-05-12T23:15:00Z',
      ends_at = '2027-05-12T23:45:00Z' WHERE id = 'plc-d-3'`).run();

    expect(() => db.exec(migrationByName.get("0007_agenda_publication.sql"))).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM event_tracks
      WHERE event_id = 'evt-devflow' AND lower(name) = 'platform & infra'`).get().count).toBe(1);
    const day = db.prepare(`SELECT opens_at AS opensAt, closes_at AS closesAt
      FROM event_days WHERE id = 'day-d-1'`).get();
    expect(day).toEqual({ opensAt: "2027-05-12T00:00:00Z", closesAt: "2027-05-12T23:45:00Z" });
    expect((Date.parse(day.closesAt) - Date.parse(day.opensAt)) / 1000).toBeLessThanOrEqual(86_400);
  });

  it("fails upgrades early for ambiguous room names or unreadable legacy continuity", () => {
    const duplicateRooms = database();
    databases.push(duplicateRooms);
    applyThrough(duplicateRooms, "0006_speaker_content.sql");
    duplicateRooms.exec(seed);
    duplicateRooms.prepare(`INSERT INTO rooms (id, event_id, name, capacity, sort_order)
      VALUES ('room-case-duplicate', 'evt-devflow', ' main stage ', 10, 99)`).run();
    expect(() => duplicateRooms.exec(migrationByName.get("0007_agenda_publication.sql")))
      .toThrow(/agenda_room_names_must_be_unique/);

    const invalidContinuity = database();
    databases.push(invalidContinuity);
    applyThrough(invalidContinuity, "0006_speaker_content.sql");
    invalidContinuity.exec(seed);
    invalidContinuity.prepare(`UPDATE schedule_placements SET ends_at = '2027-05-12T17:44:00Z'
      WHERE id = 'plc-d-2'`).run();
    expect(() => invalidContinuity.exec(migrationByName.get("0007_agenda_publication.sql")))
      .toThrow(/agenda_legacy_sessions_must_have_valid_continuity/);

    const overlongDay = database();
    databases.push(overlongDay);
    applyThrough(overlongDay, "0006_speaker_content.sql");
    overlongDay.exec(seed);
    overlongDay.prepare(`UPDATE schedule_placements SET starts_at = '2027-05-12T00:00:00Z',
      ends_at = '2027-05-12T00:45:00Z' WHERE id = 'plc-d-1'`).run();
    overlongDay.prepare(`UPDATE schedule_placements SET starts_at = '2027-05-13T00:15:00Z',
      ends_at = '2027-05-13T00:45:00Z' WHERE id = 'plc-d-3'`).run();
    expect(() => overlongDay.exec(migrationByName.get("0007_agenda_publication.sql")))
      .toThrow(/agenda_legacy_placements_must_fit_one_day/);

    const missingPrimary = database();
    databases.push(missingPrimary);
    applyThrough(missingPrimary, "0006_speaker_content.sql");
    missingPrimary.exec(seed);
    missingPrimary.prepare("DELETE FROM session_presenters WHERE id = 'presenter-d-2-primary'").run();
    expect(() => missingPrimary.exec(migrationByName.get("0007_agenda_publication.sql")))
      .toThrow(/agenda_legacy_sessions_must_have_valid_continuity/);
  });

  it("keeps sub-five-minute legacy starts visible and allows correction onto the new grid", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0006_speaker_content.sql");
    db.exec(seed);
    db.prepare(`UPDATE schedule_placements SET event_day_id = 'day-d-1', room_id = 'room-d-2b',
      starts_at = '2027-05-12T17:12:00Z', ends_at = '2027-05-12T17:22:00Z'
      WHERE id = 'plc-d-4'`).run();

    db.exec(migrationByName.get("0007_agenda_publication.sql"));
    expect(db.prepare("SELECT slot_minutes AS value FROM event_days WHERE id = 'day-d-1'").get())
      .toEqual({ value: 5 });
    expect(db.prepare("SELECT starts_at AS value FROM schedule_placements WHERE id = 'plc-d-4'").get())
      .toEqual({ value: "2027-05-12T17:12:00Z" });
    expect(() => db.prepare(`UPDATE schedule_placements
      SET starts_at = '2027-05-12T17:10:00Z', ends_at = '2027-05-12T17:20:00Z', revision = 2,
        updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T18:00:01Z'
      WHERE id = 'plc-d-4'`).run()).not.toThrow();
  });

  it("enforces organizer scope, semantic revisions, stable identities, and referenced configuration", () => {
    const db = seededAgendaDatabase();
    databases.push(db);

    expect(() => db.prepare(`
      INSERT INTO rooms (
        id, event_id, name, capacity, sort_order, revision,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES ('room-new', 'evt-devflow', 'Room 3', 120, 5, 1,
        'usr-fieldnotes-organizer', 'usr-fieldnotes-organizer',
        '2027-04-20T18:00:00Z', '2027-04-20T18:00:00Z')
    `).run()).toThrow(/same-event organizer/);
    expect(() => db.prepare(`
      INSERT INTO rooms (id, event_id, name, capacity, sort_order, created_at, updated_at)
      VALUES ('room-no-actor', 'evt-devflow', 'Room 4', 120, 6,
        '2027-04-20T18:00:00Z', '2027-04-20T18:00:00Z')
    `).run()).toThrow(/same-event organizer/);
    expect(() => db.prepare(`
      INSERT INTO rooms (
        id, event_id, name, capacity, sort_order, revision,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES ('room-new', 'evt-devflow', 'Room 3', 120, 5, 1,
        'usr-devflow-organizer', 'usr-devflow-organizer',
        '2027-04-20T18:00:00Z', '2027-04-20T18:00:00Z')
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO rooms (
        id, event_id, name, capacity, sort_order, revision,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES ('room-duplicate', 'evt-devflow', 'room 3', 100, 7, 1,
        'usr-devflow-organizer', 'usr-devflow-organizer',
        '2027-04-20T18:00:01Z', '2027-04-20T18:00:01Z')
    `).run()).toThrow();
    expect(() => db.prepare("UPDATE rooms SET capacity = 130 WHERE id = 'room-new'").run())
      .toThrow(/next revision/);
    expect(() => db.prepare(`
      UPDATE rooms SET capacity = 130, revision = 2,
        updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T18:00:01Z'
      WHERE id = 'room-new'
    `).run()).not.toThrow();
    expect(() => db.prepare("DELETE FROM rooms WHERE id = 'room-d-2a'").run()).toThrow();
    expect(() => db.prepare(`
      UPDATE event_tracks SET name = 'Renamed', revision = 2,
        updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T18:00:01Z'
      WHERE id = 'track-d-platform'
    `).run()).toThrow(/track identity is immutable/);
    expect(() => db.prepare(`
      UPDATE event_days SET opens_at = '2027-05-12T15:00:00Z', revision = 2,
        updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T18:00:01Z'
      WHERE id = 'day-d-1'
    `).run()).toThrow(/unplace sessions first/);
    expect(() => db.prepare(`
      UPDATE event_days SET label = 'Opening day', revision = 2,
        updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T18:00:01Z'
      WHERE id = 'day-d-1'
    `).run()).not.toThrow();
  });

  it("enforces placement duration, day bounds, slot alignment, overlap, and optimistic revisions", () => {
    const db = seededAgendaDatabase();
    databases.push(db);
    db.prepare("DELETE FROM schedule_placements WHERE id = 'plc-d-3'").run();

    expect(() => placement(db, { endsAt: "2027-05-12T17:44:00Z" })).toThrow(/session duration/);
    expect(() => placement(db, {
      startsAt: "2027-05-12T15:45:00Z", endsAt: "2027-05-12T16:15:00Z",
    })).toThrow(/operating window/);
    expect(() => placement(db, {
      startsAt: "2027-05-12T17:07:00Z", endsAt: "2027-05-12T17:37:00Z",
    })).toThrow(/slot interval/);
    expect(() => placement(db, { roomId: "room-d-2a" })).toThrow(/overlaps an existing room booking/);

    expect(() => placement(db)).not.toThrow();
    expect(() => db.prepare(`
      UPDATE schedule_placements SET starts_at = '2027-05-12T17:30:00Z', ends_at = '2027-05-12T18:00:00Z'
      WHERE id = 'plc-new'
    `).run()).toThrow(/next revision/);
    expect(() => db.prepare(`
      UPDATE schedule_placements
      SET starts_at = '2027-05-12T17:30:00Z', ends_at = '2027-05-12T18:00:00Z', revision = 2,
        updated_by_user_id = 'usr-devflow-organizer', updated_at = '2027-04-20T18:00:01Z'
      WHERE id = 'plc-new'
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      UPDATE program_sessions
      SET duration_minutes = 45, revision = revision + 1, updated_at = '2027-04-20T18:00:02Z'
      WHERE id = 'ses-d-3'
    `).run()).toThrow(/unplace the session first/);
  });

  it("allows a manual speaker overlap in separate rooms so the application can surface a warning", () => {
    const db = seededAgendaDatabase();
    databases.push(db);
    db.prepare("DELETE FROM schedule_placements WHERE id = 'plc-d-3'").run();

    expect(() => placement(db)).not.toThrow();
    const overlap = db.prepare(`
      SELECT COUNT(*) AS count
      FROM schedule_placements AS left_placement
      INNER JOIN session_presenters AS left_presenter
        ON left_presenter.event_id = left_placement.event_id
        AND left_presenter.program_session_id = left_placement.program_session_id
      INNER JOIN session_presenters AS right_presenter
        ON right_presenter.event_id = left_presenter.event_id
        AND right_presenter.speaker_id = left_presenter.speaker_id
        AND right_presenter.program_session_id != left_presenter.program_session_id
      INNER JOIN schedule_placements AS right_placement
        ON right_placement.event_id = right_presenter.event_id
        AND right_placement.program_session_id = right_presenter.program_session_id
      WHERE left_placement.id = 'plc-new'
        AND left_placement.starts_at < right_placement.ends_at
        AND right_placement.starts_at < left_placement.ends_at
    `).get();
    expect(overlap.count).toBeGreaterThan(0);
  });
});
