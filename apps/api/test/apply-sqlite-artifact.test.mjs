import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySqliteArtifact, SqliteArtifactError } from "../scripts/apply-sqlite-artifact.mjs";

describe("SQLite operator artifact application", () => {
  let root;
  let databasePath;
  let inputPath;
  let migrationsDirectory;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "confpilot-artifact-"));
    databasePath = join(root, "confpilot.sqlite");
    inputPath = join(root, "artifact.sql");
    migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    writeFileSync(join(migrationsDirectory, "0001_first.sql"), "SELECT 1;");
    writeFileSync(join(migrationsDirectory, "0002_second.sql"), "SELECT 2;");
    const database = new BetterSqlite3(databasePath);
    database.exec(`
      CREATE TABLE existing (value TEXT NOT NULL);
      CREATE TABLE d1_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO d1_migrations (name) VALUES ('0001_first.sql'), ('0002_second.sql');
    `);
    database.close();
  });

  afterEach(() => rmSync(root, { force: true, recursive: true }));

  function artifact(sql, mode = 0o600) {
    writeFileSync(inputPath, sql, { mode });
    chmodSync(inputPath, mode);
  }

  function apply() {
    return applySqliteArtifact({ databasePath, inputPath, migrationsDirectory });
  }

  it("applies a private artifact atomically to an existing database", async () => {
    artifact("INSERT INTO existing VALUES ('ready'); CREATE TABLE added (id INTEGER PRIMARY KEY);");
    await apply();
    const database = new BetterSqlite3(databasePath, { readonly: true });
    expect(database.prepare("SELECT value FROM existing").pluck().all()).toEqual(["ready"]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'added'").pluck().get()).toBe("added");
    database.close();
  });

  it("rolls back every statement when a later statement fails", async () => {
    artifact("INSERT INTO existing VALUES ('must-roll-back'); THIS IS INVALID;");
    await expect(apply()).rejects.toThrow();
    const database = new BetterSqlite3(databasePath, { readonly: true });
    expect(database.prepare("SELECT COUNT(*) FROM existing").pluck().get()).toBe(0);
    database.close();
  });

  it.each(["COMMIT", "END", "ROLLBACK", "BEGIN TRANSACTION"])(
    "refuses embedded %s before any statement can become durable",
    async (control) => {
      artifact(`INSERT INTO existing VALUES ('must-not-commit'); ${control}; THIS IS INVALID;`);
      await expect(apply())
        .rejects.toThrow("must not manage its own transaction");
      const database = new BetterSqlite3(databasePath, { readonly: true });
      expect(database.prepare("SELECT COUNT(*) FROM existing").pluck().get()).toBe(0);
      database.close();
    },
  );

  it("refuses an artifact readable by another user", async () => {
    artifact("INSERT INTO existing VALUES ('unsafe');", 0o644);
    await expect(apply()).rejects.toBeInstanceOf(SqliteArtifactError);
  });

  it("refuses a symlink without following it", async () => {
    const target = join(root, "target.sql");
    writeFileSync(target, "INSERT INTO existing VALUES ('unsafe');", { mode: 0o600 });
    symlinkSync(target, inputPath);
    await expect(apply()).rejects.toThrow("symlink");
  });

  it("refuses a database with no migration ledger", async () => {
    artifact("INSERT INTO existing VALUES ('unsafe');");
    const database = new BetterSqlite3(databasePath);
    database.exec("DROP TABLE d1_migrations");
    database.close();
    await expect(apply()).rejects.toThrow("no readable migration ledger");
  });

  it("refuses an empty migration ledger", async () => {
    artifact("INSERT INTO existing VALUES ('unsafe');");
    const database = new BetterSqlite3(databasePath);
    database.exec("DELETE FROM d1_migrations");
    database.close();
    await expect(apply()).rejects.toThrow("do not exactly match");
  });

  it("refuses a partially migrated database", async () => {
    artifact("INSERT INTO existing VALUES ('unsafe');");
    const database = new BetterSqlite3(databasePath);
    database.prepare("DELETE FROM d1_migrations WHERE name = ?").run("0002_second.sql");
    database.close();
    await expect(apply()).rejects.toThrow("do not exactly match");

    const unchanged = new BetterSqlite3(databasePath, { readonly: true });
    expect(unchanged.prepare("SELECT COUNT(*) FROM existing").pluck().get()).toBe(0);
    unchanged.close();
  });

  it("refuses a database migrated beyond this build", async () => {
    artifact("INSERT INTO existing VALUES ('unsafe');");
    const database = new BetterSqlite3(databasePath);
    database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("0003_future.sql");
    database.close();
    await expect(apply()).rejects.toThrow("do not exactly match");
  });
});
