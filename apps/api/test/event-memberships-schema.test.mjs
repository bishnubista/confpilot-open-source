import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const migrationByName = new Map(migrationFiles.map((name) => [
  name,
  readFileSync(new URL(name, migrationsUrl), "utf8"),
]));
const seed = readFileSync(new URL("../seed/seed.sql", import.meta.url), "utf8");

describe("event membership role migration", () => {
  it("preserves existing access while allowing each additional role exactly once", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    try {
      for (const name of migrationFiles.filter((name) => name < "0018_event_multi_role_memberships.sql")) {
        database.exec(migrationByName.get(name));
      }
      database.exec(seed);

      expect(() => database.prepare(`INSERT INTO event_memberships
        (id, event_id, user_id, role, created_at) VALUES
        ('mem-organizer-speaker', 'evt-devflow', 'usr-devflow-organizer', 'speaker', '2026-08-13T00:00:00Z')`).run())
        .toThrow();

      database.exec(migrationByName.get("0018_event_multi_role_memberships.sql"));
      expect(() => database.exec(migrationByName.get("0018_event_multi_role_memberships.sql"))).not.toThrow();
      database.prepare(`INSERT INTO event_memberships
        (id, event_id, user_id, role, created_at) VALUES
        ('mem-organizer-speaker', 'evt-devflow', 'usr-devflow-organizer', 'speaker', '2026-08-13T00:00:00Z')`).run();

      expect(database.prepare(`SELECT role FROM event_memberships
        WHERE event_id = 'evt-devflow' AND user_id = 'usr-devflow-organizer' ORDER BY role`).all())
        .toEqual([{ role: "organizer" }, { role: "speaker" }]);
      expect(() => database.prepare(`INSERT INTO event_memberships
        (id, event_id, user_id, role, created_at) VALUES
        ('mem-organizer-speaker-duplicate', 'evt-devflow', 'usr-devflow-organizer', 'speaker', '2026-08-13T00:00:01Z')`).run())
        .toThrow();
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
