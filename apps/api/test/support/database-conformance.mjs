/**
 * The behavioural contract every `Database` implementation must satisfy.
 *
 * This exists because the interface alone does not constrain the things that
 * actually differ between drivers. A shim can implement all six methods, satisfy
 * TypeScript, pass the suite it was written for, and still return an empty array
 * where production returns rows.
 *
 * That is not hypothetical: before this suite existed, thirteen hand-rolled D1
 * shims lived in this directory, and twelve of them returned no rows from
 * `batch()` while `agenda-service` reads six result sets straight out of one.
 *
 * Every expectation below was measured against real D1 running under Miniflare,
 * so D1 is the reference and any other adapter is judged against it. Run it with
 * `describeDatabaseContract(name, openDatabase)` where `openDatabase` resolves to
 * `{ database, dispose }`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { constraintMessage } from "../../src/runtime/database.ts";

const SCHEMA = `
  CREATE TABLE parent (id TEXT PRIMARY KEY, label TEXT NOT NULL);
  CREATE TABLE child (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL REFERENCES parent(id),
    n INTEGER NOT NULL
  );
`;

export function describeDatabaseContract(name, openDatabase) {
  describe(`Database contract: ${name}`, () => {
    let database;
    let dispose;

    beforeEach(async () => {
      ({ database, dispose } = await openDatabase());
      for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
        await database.prepare(statement).run();
      }
      await database.prepare("INSERT INTO parent (id, label) VALUES ('p1', 'first')").run();
      await database.prepare("INSERT INTO parent (id, label) VALUES ('p2', 'second')").run();
      await database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('c1', 'p1', 1)").run();
      await database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('c2', 'p1', 2)").run();
    }, 30_000);

    afterEach(async () => dispose?.());

    it("returns rows from run() on a read, not just from all()", async () => {
      // The failure this pins: a driver treating run() as write-only. Production
      // reads rows back from run(), so an empty array here is silently wrong.
      const viaRun = await database.prepare("SELECT id, n FROM child ORDER BY id").run();
      const viaAll = await database.prepare("SELECT id, n FROM child ORDER BY id").all();

      expect(viaRun.results).toEqual([{ id: "c1", n: 1 }, { id: "c2", n: 2 }]);
      expect(viaRun.results).toEqual(viaAll.results);
      expect(viaRun.success).toBe(true);
    });

    it("returns one result per batched statement, with rows for reads", async () => {
      const results = await database.batch([
        database.prepare("SELECT id FROM child WHERE id = ?").bind("c1"),
        database.prepare("SELECT n FROM child ORDER BY n DESC"),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].results).toEqual([{ id: "c1" }]);
      expect(results[1].results).toEqual([{ n: 2 }, { n: 1 }]);
    });

    it("reports changes for writes and rows for reads in the same batch", async () => {
      const results = await database.batch([
        database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('c3', 'p2', 3)"),
        database.prepare("SELECT COUNT(*) AS total FROM child"),
      ]);

      expect(results[0].meta.changes).toBe(1);
      expect(results[0].results).toEqual([]);
      expect(results[1].results).toEqual([{ total: 3 }]);
    });

    it("rolls the whole batch back when a later statement fails", async () => {
      // Several write paths rely on batch atomicity instead of an explicit
      // transaction, so a driver that commits per statement corrupts them.
      await expect(database.batch([
        database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('rollback', 'p1', 9)"),
        database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('c1', 'p1', 9)"),
      ])).rejects.toThrow();

      const survivor = await database.prepare("SELECT COUNT(*) AS total FROM child WHERE id = 'rollback'").first("total");
      expect(survivor).toBe(0);
    });

    it("keeps concurrent batches from interleaving", async () => {
      // An adapter that awaits between statements inside its transaction leaves a
      // yield point where a second batch can start its own BEGIN, which SQLite
      // rejects outright. Both batches must complete and commit every row.
      const [first, second] = await Promise.all([
        database.batch([
          database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('a1', 'p1', 11)"),
          database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('a2', 'p1', 12)"),
        ]),
        database.batch([
          database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('b1', 'p2', 21)"),
          database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('b2', 'p2', 22)"),
        ]),
      ]);

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      const total = await database.prepare("SELECT COUNT(*) AS total FROM child").first("total");
      expect(total).toBe(6);
    });

    it("reports meta.changes for a write", async () => {
      const updated = await database.prepare("UPDATE child SET n = n + 1 WHERE parent_id = ?").bind("p1").run();
      expect(updated.meta.changes).toBe(2);

      const untouched = await database.prepare("UPDATE child SET n = 0 WHERE parent_id = ?").bind("absent").run();
      expect(untouched.meta.changes).toBe(0);
    });

    it("resolves first() to a row, a column, or null", async () => {
      const row = await database.prepare("SELECT id, n FROM child ORDER BY id").first();
      expect(row).toEqual({ id: "c1", n: 1 });

      const column = await database.prepare("SELECT id, n FROM child ORDER BY id").first("n");
      expect(column).toBe(1);

      const missingRow = await database.prepare("SELECT id FROM child WHERE id = ?").bind("nope").first();
      expect(missingRow).toBeNull();
    });

    it("throws when first() names a column the query did not select", async () => {
      await expect(database.prepare("SELECT id FROM child").first("absent")).rejects.toThrow(/not ?found/i);
    });

    it("accepts 100 bound parameters and refuses 101", async () => {
      // Measured against D1: the 101st is rejected with "too many SQL variables".
      // An adapter without this limit accepts queries production refuses, so the
      // divergence would only ever surface in production.
      const bindMany = (count) => {
        const placeholders = Array.from({ length: count }, () => "?").join(",");
        return database.prepare(`SELECT id FROM child WHERE id IN (${placeholders})`)
          .bind(...Array.from({ length: count }, (_, index) => `x${index}`))
          .all();
      };

      await expect(bindMany(100)).resolves.toBeDefined();
      await expect(bindMany(101)).rejects.toThrow(/too many SQL variables/i);
    });

    it("enforces foreign keys", async () => {
      await expect(
        database.prepare("INSERT INTO child (id, parent_id, n) VALUES ('orphan', 'missing', 1)").run(),
      ).rejects.toThrow(/FOREIGN KEY/i);
    });

    it("surfaces the SQLite constraint text on the error", async () => {
      // `constraintMessage()` classifies failures by matching trigger and
      // constraint text, so that text has to survive whatever the driver wraps
      // the error in.
      let caught;
      try {
        await database.prepare("INSERT INTO parent (id, label) VALUES ('p1', 'duplicate')").run();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      // Asserted through the normalizer the application actually uses, so this
      // fails if `constraintMessage` ever stops reaching the driver's text.
      expect(constraintMessage(caught)).toMatch(/UNIQUE constraint failed/i);
    });
  });
}
