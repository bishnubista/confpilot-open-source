/**
 * Booting a Node host applies the schema, and several replicas may boot at once.
 *
 * The interesting case is the one that cannot happen in a single process: two
 * hosts that both read the same pending list. better-sqlite3 is synchronous, so
 * `Promise.all` over two callers serialises and the second simply finds the work
 * done — a real result, but not the collision. That branch is reached here with a
 * database double that returns a stale ledger, which is exactly what a replica
 * that read a moment too early would see.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { applyMigrations } from "../src/host/migrations.ts";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("node host migrations", () => {
  let directory;
  let driver;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "confpilot-migrate-"));
    driver = new BetterSqlite3(join(directory, "confpilot.sqlite"));
  });

  afterEach(() => {
    driver.close();
    rmSync(directory, { force: true, recursive: true });
  });

  const ledger = () => driver.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((r) => r.name);

  it("applies every migration and records them in wrangler's ledger", async () => {
    const applied = await applyMigrations(driver, migrationsDirectory);
    expect(applied.length).toBeGreaterThan(20);
    expect(ledger()).toEqual(applied);
    // The schema is real, not just recorded: the triggers are what enforce
    // authorization independently of middleware.
    const triggers = driver.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get();
    expect(triggers.n).toBeGreaterThan(100);
  });

  it("is a no-op once the schema is current", async () => {
    const first = await applyMigrations(driver, migrationsDirectory);
    expect(await applyMigrations(driver, migrationsDirectory)).toEqual([]);
    expect(ledger()).toEqual(first);
  });

  it("applies only what a partial ledger is missing", async () => {
    const all = await applyMigrations(driver, migrationsDirectory);
    const last = all.at(-1);
    driver.prepare("DELETE FROM d1_migrations WHERE name = ?").run(last);

    // Exactly the one the ledger no longer names — not everything, and not
    // nothing. The ledger is what decides the work, so removing a row is the
    // whole difference between a no-op and a re-run.
    expect(await applyMigrations(driver, migrationsDirectory)).toEqual([last]);
    expect(ledger()).toEqual(all);
  });

  it("treats a ledger written by wrangler as already migrated", async () => {
    // A deployment moved off Cloudflare arrives with this table populated. Losing
    // that would re-apply migration 0001 onto a full schema and fail the boot.
    await applyMigrations(driver, migrationsDirectory);
    const second = new BetterSqlite3(join(directory, "confpilot.sqlite"));
    try {
      expect(await applyMigrations(second, migrationsDirectory)).toEqual([]);
    } finally {
      second.close();
    }
  });

  it("treats losing the race as success, having changed nothing", async () => {
    await applyMigrations(driver, migrationsDirectory);
    const rowsBefore = ledger();

    // Reads the ledger as empty the first time, which is what a replica that read
    // a moment before another committed would see. The run then collides on the
    // ledger's uniqueness and must roll back rather than half-apply the schema.
    let staleReads = 0;
    const stale = {
      exec: (sql) => driver.exec(sql),
      prepare: (query) => {
        const statement = driver.prepare(query);
        if (!query.includes("SELECT name FROM d1_migrations")) return statement;
        return {
          all: () => (staleReads++ === 0 ? [] : statement.all()),
          run: (...parameters) => statement.run(...parameters),
          get reader() { return statement.reader; },
        };
      },
    };

    expect(await applyMigrations(stale, migrationsDirectory)).toEqual([]);
    expect(staleReads, "the stale read must actually have been used").toBeGreaterThan(1);
    expect(ledger(), "a losing run must leave the ledger exactly as it found it").toEqual(rowsBefore);
  });

  it.each([
    ["capitals", "0027_Add_Speaker.sql"],
    ["a hyphen", "0027_add-speaker.sql"],
    ["no ordinal", "add_speaker.sql"],
    ["too few digits", "027_add_speaker.sql"],
  ])("refuses a .sql file it cannot order — %s", async (_label, filename) => {
    // Skipping it would be worse than failing: the boot succeeds, the ledger is
    // internally consistent, and the schema is missing a migration. Every symptom
    // of that arrives later and somewhere else.
    const directory = mkdtempSync(join(tmpdir(), "confpilot-misnamed-"));
    try {
      writeFileSync(join(directory, filename), "SELECT 1;");
      await expect(applyMigrations(driver, directory)).rejects.toThrow(new RegExp(filename));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("ignores files that are not SQL at all", async () => {
    // The rule is about `.sql` files it cannot order, not about tidiness — a
    // README beside the migrations is not a migration.
    const directory = mkdtempSync(join(tmpdir(), "confpilot-extra-"));
    try {
      writeFileSync(join(directory, "0001_first.sql"), "CREATE TABLE first (a INTEGER);");
      writeFileSync(join(directory, "README.md"), "notes");
      writeFileSync(join(directory, ".DS_Store"), "");
      expect(await applyMigrations(driver, directory)).toEqual(["0001_first.sql"]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a migration that manages its own transaction", async () => {
    // Found by writing the test for the rollback guard: a script carrying its own
    // COMMIT ended the run's transaction early, so the ledger row was durable and
    // the rest of the script was not — and applyMigrations reported success over a
    // half-built schema. Guarding the rollback was not enough; the script has to
    // be refused, before anything is written.
    const directory = mkdtempSync(join(tmpdir(), "confpilot-commits-"));
    try {
      writeFileSync(join(directory, "0001_commits.sql"),
        "CREATE TABLE ok (a INTEGER);\nCOMMIT;\nCREATE TABLE bad (b INTEGER);");
      await expect(applyMigrations(driver, directory)).rejects.toThrow(/manages its own transaction/);
      expect(driver.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok'").get().n,
        "nothing may be applied when the run is refused").toBe(0);
      expect(ledger()).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["COMMIT", "CREATE TABLE ok (a INTEGER);\nCOMMIT;\nCREATE TABLE more (b INTEGER);"],
    // SQLite's grammar makes bare `END` a synonym for COMMIT, which is the form a
    // script is most likely to reach for by accident and the one a pattern
    // written for `COMMIT` misses.
    ["a bare END", "CREATE TABLE ok (a INTEGER);\nEND;\nCREATE TABLE more (b INTEGER);"],
    ["END TRANSACTION", "CREATE TABLE ok (a INTEGER);\nEND TRANSACTION;\nCREATE TABLE more (b INTEGER);"],
    ["ROLLBACK", "CREATE TABLE ok (a INTEGER);\nROLLBACK;"],
    ["BEGIN IMMEDIATE", "BEGIN IMMEDIATE;\nCREATE TABLE ok (a INTEGER);"],
    ["a plain BEGIN", "BEGIN;\nCREATE TABLE ok (a INTEGER);"],
    ["a same-line bare END", "CREATE TABLE ok (a INTEGER); END;\nTHIS IS INVALID;"],
  ])("refuses a migration that commits with %s", async (_label, script) => {
    const directory = mkdtempSync(join(tmpdir(), "confpilot-tc-"));
    try {
      writeFileSync(join(directory, "0001_controls.sql"), script);
      await expect(applyMigrations(driver, directory)).rejects.toThrow(/manages its own transaction/);
      // Refused before anything is written, so neither half of the state the
      // check exists to protect has moved.
      expect(driver.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok'").get().n).toBe(0);
      expect(ledger()).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not treat transaction words in strings, quoted identifiers, or comments as statements", async () => {
    const directory = mkdtempSync(join(tmpdir(), "confpilot-token-"));
    try {
      writeFileSync(join(directory, "0001_tokens.sql"), [
        "CREATE TABLE words (value TEXT, \"END\" TEXT);",
        "INSERT INTO words (value) VALUES ('text; END; COMMIT; BEGIN; ROLLBACK;');",
        "-- END; COMMIT;",
        "/* BEGIN; ROLLBACK; */",
      ].join("\n"));
      expect(await applyMigrations(driver, directory)).toEqual(["0001_tokens.sql"]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    // Each of these rejected the real schema during development. `END` closes a
    // CASE as well as a trigger and a transaction, and it appears in all three
    // forms across these migrations — so every one is kept as a fixture.
    ["a CASE ending mid-line inside a trigger",
      "CREATE TRIGGER g BEFORE INSERT ON t\nBEGIN\n  SELECT CASE WHEN 1 THEN RAISE(ABORT, 'no') END;\nEND;"],
    ["a CASE ending alone on a line inside a trigger",
      "CREATE TRIGGER g BEFORE INSERT ON t\nBEGIN\n  UPDATE t SET a = CASE WHEN 1 THEN 2\n  ELSE 3\n  END\n  WHERE a = 0;\nEND;"],
    ["a CASE ending with a comma outside a trigger",
      "CREATE TABLE u AS SELECT CASE WHEN 1 THEN 2\n  END,\n  1 AS b;"],
  ])("does not mistake %s for transaction control", async (_label, body) => {
    const directory = mkdtempSync(join(tmpdir(), "confpilot-case-"));
    try {
      writeFileSync(join(directory, "0001_case.sql"), `CREATE TABLE t (a INTEGER);\n${body}`);
      expect(await applyMigrations(driver, directory)).toEqual(["0001_case.sql"]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not mistake a trigger body's BEGIN for transaction control", async () => {
    // Most of the real migrations open a trigger with a bare BEGIN. A check that
    // matched it would refuse the entire schema.
    const directory = mkdtempSync(join(tmpdir(), "confpilot-trigger-"));
    try {
      writeFileSync(join(directory, "0001_trigger.sql"), [
        "CREATE TABLE t (a INTEGER);",
        "CREATE TRIGGER guard BEFORE INSERT ON t",
        "BEGIN",
        "  SELECT RAISE(ABORT, 'no');",
        "END;",
      ].join("\n"));
      expect(await applyMigrations(driver, directory)).toEqual(["0001_trigger.sql"]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports a real failure rather than reading it as contention", async () => {
    // The catch that absorbs a lost race must not absorb a broken migration. A
    // directory whose script cannot run leaves the ledger empty, so the
    // already-applied check fails and the error surfaces.
    const broken = mkdtempSync(join(tmpdir(), "confpilot-broken-"));
    try {
      writeFileSync(join(broken, "0001_broken.sql"), "CREATE TABLE ( ;");
      await expect(applyMigrations(driver, broken)).rejects.toThrow();
      expect(ledger()).toEqual([]);
    } finally {
      rmSync(broken, { force: true, recursive: true });
    }
  });
});
