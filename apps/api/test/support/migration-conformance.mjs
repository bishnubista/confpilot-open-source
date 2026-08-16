/**
 * Prove the real schema applies, and still defends itself, on any driver.
 *
 * The synthetic contract in `database-conformance.mjs` pins how a driver behaves.
 * This pins something more consequential: that the actual 26 migrations apply,
 * that foreign keys are enforced afterwards, and that the `RAISE(ABORT)` triggers
 * still fire with text the application can still match.
 *
 * Those triggers are the reason this project stays on SQLite rather than moving
 * to Postgres — 192 of them re-check authorization independently of middleware,
 * so they are a security boundary, not a convenience. A driver that applied the
 * migrations but silently dropped a trigger, or reported foreign keys as off,
 * would look healthy in every other test here.
 */
import { readFileSync, readdirSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { constraintMessage } from "../../src/runtime/database.ts";

const migrationsUrl = new URL("../../migrations/", import.meta.url);
const seedUrl = new URL("../../seed/seed.sql", import.meta.url);

export const migrationScripts = readdirSync(migrationsUrl)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(new URL(name, migrationsUrl), "utf8"));

export const seedScript = readFileSync(seedUrl, "utf8");

/**
 * Split a migration into single statements.
 *
 * Needed because this suite applies migrations through the `Database` port, so
 * that D1 and SQLite run the same path — and neither `prepare` accepts more than
 * one statement. The Node host does not share this: it hands whole scripts to
 * SQLite's own multi-statement `exec`, which needs no splitting.
 *
 * Trigger bodies contain their own semicolons, so a naive split on `;` tears them
 * in half. Migrations keep bodies terminated by a lone `END;`, which is what the
 * `inTrigger` flag tracks.
 */
export function splitSql(script) {
  const statements = [];
  let current = "";
  let inTrigger = false;
  for (const line of script.split("\n")) {
    current += `${line}\n`;
    if (/^CREATE TRIGGER\b/.test(line)) inTrigger = true;
    const complete = inTrigger ? /^END;\s*$/.test(line) : /;\s*$/.test(line);
    if (complete) {
      statements.push(current.trim());
      current = "";
      inTrigger = false;
    }
  }
  if (current.trim()) throw new Error("Incomplete SQL fixture statement");
  return statements;
}

export async function applySql(database, script) {
  for (const statement of splitSql(script)) await database.prepare(statement).run();
}

/**
 * Apply one script to D1 as a single `batch()` rather than a statement at a time.
 *
 * The statements and their order are unchanged; what changes is the number of
 * round-trips into `workerd`, and that is nearly all of the cost. Applying the
 * 26 migrations and the seed — 485 statements — takes ~3.2s one `await` at a
 * time and ~1.1s as 27 batches. The same SQL runs through better-sqlite3 in
 * 70ms, so the 3.2s was never SQL; it was 485 crossings of a process boundary.
 *
 * D1 only, and not an oversight: `batch()` takes already-prepared statements,
 * and the better-sqlite3 adapter compiles at `prepare()` time, so preparing a
 * whole migration up front dies on the first statement that references a table a
 * later statement in the same file creates (`0000_initial.sql` does exactly
 * this). D1 prepares lazily. The SQLite path stays on `applySql` and needs no
 * help at 70ms.
 *
 * A batch is also a transaction, which is what the three migrations opening with
 * `PRAGMA defer_foreign_keys` were written for — that pragma only means anything
 * inside one.
 */
export async function applyD1Sql(database, script) {
  await database.batch(splitSql(script).map((statement) => database.prepare(statement)));
}

/**
 * Every row of every table, in a form two reads can be compared by.
 *
 * Contents rather than counts, so that an `UPDATE` rewriting a row in place is
 * caught as well as an insert or a delete. Reading the rows is affordable only
 * because this runs against a freshly seeded schema, where the whole database is
 * a few hundred rows; it would be the wrong shape for a populated one.
 *
 * `total_changes()` is the obvious cheaper answer and it does not work: D1
 * advances it on plain reads and on rejected writes alike, so a guard built on it
 * would be the flaky thing it was added to prevent.
 *
 * Rows are sorted because neither driver promises an order without `ORDER BY`,
 * and there is no column known to be sortable across every table here. Serialized
 * because that is what makes them sortable and comparable at all; the two reads
 * are always from the same driver, so how a driver renders a blob only has to be
 * consistent with itself.
 *
 * A query per table, rather than one `UNION ALL` over all of them: D1 caps the
 * terms in a compound SELECT well below stock SQLite's 500, and this schema has
 * more tables than that cap allows.
 *
 * The prefixes are filtered here rather than with `LIKE` because `_` is itself a
 * LIKE wildcard, so the pattern for D1's own `_cf_METADATA` — which exists only
 * on D1, and which D1 answers with SQLITE_AUTH rather than rows — would need an
 * ESCAPE clause to mean what it looks like it means.
 */
async function tableContents(database) {
  const { results } = await database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  const contents = {};
  for (const { name } of results) {
    if (name.startsWith("sqlite_") || name.startsWith("_cf_")) continue;
    const { results: rows } = await database.prepare(`SELECT * FROM "${name}"`).all();
    contents[name] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return contents;
}

export function describeMigrationContract(name, openDatabase) {
  describe(`Schema contract: ${name}`, () => {
    let database;
    let dispose;
    let seeded;

    /**
     * Migrated once for the suite, not once per test.
     *
     * Nothing below mutates the database: two tests only read, and the other two
     * assert that a write is *refused*, so they leave no row behind either way.
     * That holds whatever order the tests run in — a rejected insert cannot dirty
     * `foreign_key_check` for a test that runs after it. Re-applying 26
     * migrations four times bought no isolation and cost ~9s of hook budget.
     *
     * `applySql` here rather than `applyD1Sql`, and that is a choice rather than
     * an oversight — batching the D1 arm finishes this file 2.3s sooner, measured.
     * It is declined because this is the one suite whose purpose is to attribute
     * a difference to the *driver*, which it can only do while both arms run the
     * same code. Give D1 a transaction the SQLite arm does not get, and the next
     * migration that behaves differently inside one sends somebody hunting a
     * driver bug that is really a harness bug. That is worth more than 2.3s of a
     * 60s budget on a hook that now runs once per suite.
     */
    beforeAll(async () => {
      ({ database, dispose } = await openDatabase());
      for (const migration of migrationScripts) await applySql(database, migration);
      await applySql(database, seedScript);
      seeded = await tableContents(database);
    }, 60_000);

    /**
     * Hold the sharing above to the claim that justifies it.
     *
     * "Nothing below mutates" is true by inspection today, and inspection is
     * exactly what stops happening when someone adds a fifth test. A write that
     * lands where one was meant to be refused would not fail here — it would
     * quietly make the other three order-dependent, which surfaces later as
     * flakiness rather than as this suite's own failure. So the invariant is
     * checked rather than asserted in a comment.
     *
     * Gated on `seeded` rather than on `database`, because `database` is assigned
     * by the first line of the setup and `seeded` by the last. A migration that
     * throws in between leaves a database to read and no baseline to read it
     * against, and this hook still runs — so the gate has to be the thing that
     * proves setup finished, or a failed setup reports itself twice: once truly,
     * and once as a content mismatch against `undefined`.
     *
     * Disposal is in a `finally` because a workerd process that outlives a failed
     * assertion hangs the run on exit instead of reporting it.
     */
    afterAll(async () => {
      try {
        if (seeded) expect(await tableContents(database)).toEqual(seeded);
      } finally {
        await dispose?.();
      }
    });

    it("applies every migration and leaves referential integrity intact", async () => {
      expect(migrationScripts.length).toBeGreaterThanOrEqual(26);
      expect(await database.prepare("PRAGMA foreign_keys").first("foreign_keys")).toBe(1);
      expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    });

    it("installs the authorization triggers the application relies on", async () => {
      const { results } = await database.prepare(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger'",
      ).all();
      // The exact count moves with the schema; what matters is that they survived
      // the driver, rather than being silently skipped while migrations "passed".
      expect(results[0].total).toBeGreaterThan(150);
    });

    it("still refuses a write the schema forbids, with matchable text", async () => {
      // A proposal may only be owned by a speaker of the same event. This is a
      // RAISE(ABORT) trigger, not a foreign key, so it exercises the exact
      // mechanism the review and agenda paths classify failures by.
      let caught;
      try {
        await database.prepare(`INSERT INTO proposals (
          id, event_id, public_id, slug, title, abstract, track, format, duration_minutes,
          status, submitted_at, created_at, updated_at, owner_user_id
        ) VALUES ('prop-conformance', 'evt-devflow', 'ABS-CONF', 'conformance', 'Conformance',
          'Body.', 'AI Engineering', 'talk', 30, 'draft', NULL,
          '2026-08-11T00:00:00Z', '2026-08-11T00:00:00Z', 'usr-not-a-speaker')`).run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(constraintMessage(caught)).toMatch(/proposal owner must be a speaker for the same event/i);
    });

    it("enforces a foreign key from the real schema", async () => {
      let caught;
      try {
        await database.prepare(
          "INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES (?, ?, ?, 'speaker', ?)",
        ).bind("mem-orphan", "evt-does-not-exist", "usr-devflow-organizer", "2026-08-11T00:00:00Z").run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(constraintMessage(caught)).toMatch(/FOREIGN KEY constraint failed|must be a same-event/i);
    });
  });
}
