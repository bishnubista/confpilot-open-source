/**
 * The pragmas that make a SQLite file safe to serve requests from.
 *
 * The one worth a test is the journal mode, because `PRAGMA journal_mode = WAL`
 * *reports* what it settled on rather than failing when it cannot honour the
 * request. On a filesystem that does not support WAL — several network mounts do
 * not — SQLite stays on rollback journaling and says nothing, and every
 * concurrency claim this host makes becomes false with no error to show for it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { BUSY_TIMEOUT_MS, configureSqliteConnection } from "../src/host/sqlite-connection.ts";

describe("node host sqlite connection", () => {
  let directory;
  let driver;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "confpilot-conn-"));
    driver = new BetterSqlite3(join(directory, "confpilot.sqlite"));
  });

  afterEach(() => {
    try { driver.close(); } catch { /* already closed by the test */ }
    rmSync(directory, { force: true, recursive: true });
  });

  const pragma = (name) => driver.prepare(`PRAGMA ${name}`).all()[0];

  it("puts the connection in write-ahead logging", async () => {
    configureSqliteConnection(driver);
    expect(pragma("journal_mode").journal_mode).toBe("wal");
  });

  it("waits for a held lock instead of failing immediately", () => {
    // Without this a writer meeting a held lock fails instantly with SQLITE_BUSY,
    // surfacing as a 500 on a request that would have succeeded milliseconds
    // later. It is also what makes the migration runner safe to race.
    configureSqliteConnection(driver);
    expect(pragma("busy_timeout").timeout).toBe(BUSY_TIMEOUT_MS);
  });

  it("flushes each commit", () => {
    // WAL's usual pairing is NORMAL, which cannot corrupt the database but can
    // lose the last committed transactions to a power cut. At a CFP's write rate
    // the cost is irrelevant and an acknowledged submission should survive.
    configureSqliteConnection(driver);
    expect(pragma("synchronous").synchronous).toBe(2); // 2 = FULL
  });

  it("accepts an in-memory database, which cannot use WAL and does not need it", () => {
    // Nothing else can open it, so there is no reader for a writer to block.
    const memory = new BetterSqlite3(":memory:");
    try {
      expect(() => configureSqliteConnection(memory)).not.toThrow();
    } finally {
      memory.close();
    }
  });

  it("refuses to continue when the journal mode is not what was asked for", () => {
    // Simulated by a driver that reports the mode SQLite would report on a
    // filesystem that cannot do WAL: the pragma succeeds and returns `delete`.
    // The real thing cannot be produced without such a filesystem, and the
    // failure it causes is silent, so the check is worth having under test.
    const refusing = {
      exec: (sql) => driver.exec(sql),
      prepare: (sql) => (sql.includes("journal_mode")
        ? { all: () => [{ journal_mode: "delete" }] }
        : driver.prepare(sql)),
      close: () => {},
    };
    expect(() => configureSqliteConnection(refusing)).toThrow(/write-ahead logging/i);
    expect(() => configureSqliteConnection(refusing)).toThrow(/delete/);
  });

  it("returns a database that speaks the port", async () => {
    const { database } = configureSqliteConnection(driver);
    await database.prepare("CREATE TABLE t (a INTEGER)").run();
    await database.prepare("INSERT INTO t (a) VALUES (?)").bind(1).run();
    expect((await database.prepare("SELECT a FROM t").all()).results).toEqual([{ a: 1 }]);
  });
});
