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

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function applyThrough(db, lastMigration) {
  if (!migrationByName.has(lastMigration)) {
    throw new Error(`Migration not found: ${lastMigration}`);
  }
  for (const name of migrationFiles) {
    db.exec(migrationByName.get(name));
    if (name === lastMigration) break;
  }
}

function insertConfig(db, overrides = {}) {
  const input = {
    id: "embed-new",
    eventId: "evt-devflow",
    slug: "session-list",
    name: "Session list",
    view: "sessions",
    filtersJson: '{"days":[],"tracks":[],"formats":[],"rooms":[]}',
    enabled: 1,
    revision: 1,
    createdByUserId: "usr-devflow-organizer",
    updatedByUserId: "usr-devflow-organizer",
    createdAt: "2027-02-21T18:00:00Z",
    updatedAt: "2027-02-21T18:00:00Z",
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO public_embed_configs (
      id, event_id, slug, name, view, filters_json, enabled, revision,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.eventId,
    input.slug,
    input.name,
    input.view,
    input.filtersJson,
    input.enabled,
    input.revision,
    input.createdByUserId,
    input.updatedByUserId,
    input.createdAt,
    input.updatedAt,
  );
}

function upgradeFixtures(db) {
  db.exec(`
    INSERT INTO users (id, email, display_name, created_at) VALUES
      ('usr-upgrade-organizer', 'organizer@upgrade.example', 'Upgrade Organizer', '2027-01-01T00:00:00Z'),
      ('usr-other-organizer', 'organizer@other.example', 'Other Organizer', '2027-01-01T00:00:00Z');
    INSERT INTO events (
      id, slug, name, tagline, location, description,
      starts_on, ends_on, cfp_deadline, status
    ) VALUES
      ('evt-upgrade', 'upgrade-conf', 'Upgrade Conf', '', '', '',
        '2027-07-01', '2027-07-02', '2027-02-01T00:00:00Z', 'published'),
      ('evt-other', 'other-conf', 'Other Conf', '', '', '',
        '2027-08-01', '2027-08-02', '2027-02-01T00:00:00Z', 'published');
    INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES
      ('mem-upgrade', 'evt-upgrade', 'usr-upgrade-organizer', 'organizer', '2027-01-01T00:00:00Z'),
      ('mem-other', 'evt-other', 'usr-other-organizer', 'organizer', '2027-01-01T00:00:00Z');
  `);
}

describe("public embeds migration", () => {
  const databases = [];
  afterEach(() => {
    while (databases.length > 0) databases.pop().close();
  });

  it("applies fresh migrations and seeds isolated event-scoped configs", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    db.exec(seed);

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA table_info(public_embed_configs)").all().map(({ name }) => name))
      .toEqual([
        "id", "event_id", "slug", "name", "view", "filters_json", "enabled", "revision",
        "created_by_user_id", "updated_by_user_id", "created_at", "updated_at",
      ]);

    expect(db.prepare(`
      SELECT event_id AS eventId, slug, view, enabled, revision, filters_json AS filtersJson
      FROM public_embed_configs ORDER BY event_id
    `).all()).toEqual([
      {
        eventId: "evt-devflow",
        slug: "homepage-agenda",
        view: "agenda",
        enabled: 1,
        revision: 1,
        filtersJson: '{"days":[],"tracks":[],"formats":[],"rooms":[]}',
      },
      {
        eventId: "evt-fieldnotes",
        slug: "speaker-gallery",
        view: "gallery",
        enabled: 0,
        revision: 1,
        filtersJson: '{"days":[],"tracks":[],"formats":[],"rooms":[]}',
      },
    ]);

    const objects = new Set(db.prepare(`
      SELECT type || ':' || name AS object FROM sqlite_master
      WHERE name LIKE 'public_embed_configs_%' AND type IN ('index', 'trigger')
    `).all().map(({ object }) => object));
    for (const expected of [
      "index:public_embed_configs_event_slug_unique",
      "index:public_embed_configs_event_updated_index",
      "index:public_embed_configs_public_lookup_index",
      "trigger:public_embed_configs_valid_insert",
      "trigger:public_embed_configs_identity_immutable_update",
      "trigger:public_embed_configs_valid_update",
      "trigger:public_embed_configs_immutable_delete",
    ]) expect(objects.has(expected), expected).toBe(true);
  });

  it("upgrades a populated pre-embed database without changing existing rows", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0004_decision_notifications.sql");
    upgradeFixtures(db);
    const before = db.prepare("SELECT id, slug, name FROM events ORDER BY id").all();

    db.exec(migrationByName.get("0005_public_embeds.sql"));

    expect(db.prepare("SELECT id, slug, name FROM events ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT DISTINCT time_zone AS timeZone FROM events").all()).toEqual([{ timeZone: "UTC" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_embed_configs").get().count).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => insertConfig(db, {
      eventId: "evt-upgrade",
      createdByUserId: "usr-upgrade-organizer",
      updatedByUserId: "usr-upgrade-organizer",
    })).not.toThrow();
  });

  it("adds presentation defaults without rewriting existing embed identity and constrains direct writes", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0014_agenda_placement_publication_guard.sql");
    db.exec(seed);
    const before = db.prepare("SELECT id, event_id AS eventId, slug, revision FROM public_embed_configs ORDER BY id").all();

    db.exec(migrationByName.get("0015_embed_presentation.sql"));

    expect(db.prepare("SELECT id, event_id AS eventId, slug, revision FROM public_embed_configs ORDER BY id").all()).toEqual(before);
    expect(db.prepare(`SELECT output_format AS outputFormat, theme, accent_color AS accentColor,
      density, show_search AS showSearch, show_filters AS showFilters,
      show_event_summary AS showEventSummary
      FROM public_embed_configs WHERE id = 'embed-d-homepage-agenda'`).get()).toEqual({
      outputFormat: "iframe",
      theme: "light",
      accentColor: "#3157D5",
      density: "comfortable",
      showSearch: 0,
      showFilters: 0,
      showEventSummary: 0,
    });

    for (const assignment of [
      "output_format = 'xml'",
      "theme = 'system'",
      "accent_color = '#aabbcc'",
      "accent_color = '#GG0000'",
      "density = 'tiny'",
      "show_search = 2",
      "show_filters = -1",
      "show_event_summary = 3",
    ]) expect(() => db.prepare(`UPDATE public_embed_configs SET ${assignment}, revision = revision + 1,
      updated_at = '2027-02-21T18:00:01Z' WHERE id = 'embed-d-homepage-agenda'`).run(), assignment).toThrow();

    expect(() => db.prepare(`UPDATE public_embed_configs SET output_format = 'json', theme = 'dark',
      accent_color = '#A1B2C3', density = 'compact', show_search = 1, show_filters = 1,
      show_event_summary = 1, revision = revision + 1, updated_at = '2027-02-21T18:00:01Z'
      WHERE id = 'embed-d-homepage-agenda'`).run()).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces organizer scope, stable identity, event-local slugs, and revisions", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    db.exec(seed);

    expect(db.prepare("SELECT time_zone AS timeZone FROM events WHERE id = 'evt-devflow'").get())
      .toEqual({ timeZone: "America/Los_Angeles" });

    expect(() => insertConfig(db, { createdByUserId: "usr-fieldnotes-organizer" }))
      .toThrow(/organizer in the same event/);
    expect(() => insertConfig(db, { revision: 2 })).toThrow(/revision one/);
    expect(() => insertConfig(db, { updatedAt: "2027-02-21T18:00:01Z" }))
      .toThrow(/revision one/);

    insertConfig(db);
    expect(() => insertConfig(db, { id: "embed-duplicate", slug: "session-list" })).toThrow();
    expect(() => insertConfig(db, {
      id: "embed-other-same-slug",
      eventId: "evt-fieldnotes",
      createdByUserId: "usr-fieldnotes-organizer",
      updatedByUserId: "usr-fieldnotes-organizer",
    })).not.toThrow();

    expect(() => db.prepare(`
      UPDATE public_embed_configs SET slug = 'renamed', revision = 2
      WHERE id = 'embed-new'
    `).run()).toThrow(/public identity are immutable/);
    expect(() => db.prepare(`
      UPDATE public_embed_configs SET event_id = 'evt-fieldnotes', revision = 2
      WHERE id = 'embed-new'
    `).run()).toThrow();
    expect(() => db.prepare(`
      UPDATE public_embed_configs SET enabled = 0 WHERE id = 'embed-new'
    `).run()).toThrow(/next revision/);
    expect(() => db.prepare(`
      UPDATE public_embed_configs
      SET enabled = 0, revision = 2, updated_by_user_id = 'usr-fieldnotes-organizer',
        updated_at = '2027-02-21T18:00:01Z'
      WHERE id = 'embed-new'
    `).run()).toThrow(/organizer in the same event/);
    expect(() => db.prepare(`
      UPDATE public_embed_configs
      SET enabled = 0, revision = 2, updated_at = '2027-02-21T18:00:01Z'
      WHERE id = 'embed-new'
    `).run()).not.toThrow();
    expect(() => db.prepare("DELETE FROM public_embed_configs WHERE id = 'embed-new'").run())
      .toThrow(/disable them instead/);
    expect(db.prepare(`
      SELECT event_id AS eventId, slug, enabled, revision
      FROM public_embed_configs WHERE id = 'embed-new'
    `).get()).toEqual({ eventId: "evt-devflow", slug: "session-list", enabled: 0, revision: 2 });
  });

  it("blocks event deletion when immutable embed history exists", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    upgradeFixtures(db);
    insertConfig(db, {
      eventId: "evt-upgrade",
      createdByUserId: "usr-upgrade-organizer",
      updatedByUserId: "usr-upgrade-organizer",
    });

    expect(() => db.prepare("DELETE FROM events WHERE id = 'evt-upgrade'").run())
      .toThrow(/FOREIGN KEY constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_embed_configs WHERE event_id = 'evt-upgrade'").get())
      .toEqual({ count: 1 });
  });

  it("rejects malformed, non-canonical, duplicate, unsorted, and unsupported filters", () => {
    const db = database();
    databases.push(db);
    applyThrough(db, "0005_public_embeds.sql");
    db.exec(seed);

    const invalidFilters = [
      '{"days":[],"tracks":[],"formats":[]}',
      '{"days":[],"tracks":[],"formats":[],"rooms":[],"speakers":[]}',
      '{ "days": [], "tracks": [], "formats": [], "rooms": [] }',
      '{"days":"2027-05-12","tracks":[],"formats":[],"rooms":[]}',
      '{"days":["2027-5-12"],"tracks":[],"formats":[],"rooms":[]}',
      '{"days":["2027-02-30"],"tracks":[],"formats":[],"rooms":[]}',
      '{"days":[],"tracks":[" AI Engineering"],"formats":[],"rooms":[]}',
      '{"days":[],"tracks":[],"formats":["webinar"],"rooms":[]}',
      '{"days":[],"tracks":[],"formats":[],"rooms":["Main Stage","Main Stage"]}',
      '{"days":[],"tracks":["Platform","AI"],"formats":[],"rooms":[]}',
    ];
    for (const [index, filtersJson] of invalidFilters.entries()) {
      expect(() => insertConfig(db, { id: `embed-invalid-${index}`, filtersJson }), filtersJson)
        .toThrow();
    }

    expect(() => insertConfig(db, {
      id: "embed-valid-filters",
      filtersJson: '{"days":["2027-05-12","2027-05-13"],"tracks":["AI Engineering","Platform & Infra"],"formats":["talk","workshop"],"rooms":["Main Stage","Workshop Lab"]}',
    })).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
