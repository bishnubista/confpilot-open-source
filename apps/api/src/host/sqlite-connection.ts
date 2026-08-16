/**
 * Open the SQLite file the way a served application needs it.
 *
 * `createSqliteDatabase` sets the one pragma that is a *semantic* difference from
 * D1 — foreign keys, which SQLite leaves off per connection and D1 has on. The
 * pragmas here are different in kind: they are about a file being read and
 * written by concurrent requests, and by more than one process, which is a
 * property of this deployment rather than of the adapter. They live with the host
 * that opens the connection for that reason.
 *
 * - **WAL.** The default rollback journal takes an exclusive lock for every
 *   write, so one submission blocks every concurrent read. WAL lets readers
 *   continue against the last committed state while a writer works, which is the
 *   difference between a server and a script.
 * - **`busy_timeout`.** Without it a writer that meets a held lock fails
 *   instantly with `SQLITE_BUSY`, surfacing as a 500 on a request that would have
 *   succeeded a few milliseconds later. With it SQLite waits. This is also what
 *   makes the migration runner's `BEGIN IMMEDIATE` safe to race: the loser waits
 *   rather than erroring.
 * - **`synchronous = FULL`.** WAL's usual pairing is `NORMAL`, which cannot
 *   corrupt the database but can lose the last few committed transactions to a
 *   power cut. For a CFP the write rate is low enough that the cost is
 *   irrelevant, and losing an accepted submission that was acknowledged is not a
 *   trade worth making silently.
 */
import type { Database } from "../runtime/database";
import { createSqliteDatabase, type SqliteDriver } from "../runtime/sqlite-database";

/** How long a blocked writer waits for the lock before giving up. */
export const BUSY_TIMEOUT_MS = 5_000;

export interface SqliteConnection {
  database: Database;
  driver: SqliteDriver;
  close(): void;
}

/** The part of `better-sqlite3`'s constructor result this module needs. */
export interface OpenedDriver extends SqliteDriver {
  close(): void;
}

/**
 * Apply the serving pragmas and wrap the connection as a `Database`.
 *
 * Takes an already-opened driver rather than a path so the caller owns the
 * dependency on `better-sqlite3`, and so tests can hand in an in-memory one.
 */
/**
 * Modes that satisfy what this host assumes about concurrency.
 *
 * `memory` is here for in-memory databases, which cannot use WAL and do not need
 * it: nothing else can open them, so there is no reader to block.
 */
const ACCEPTABLE_JOURNAL_MODES = new Set(["wal", "memory"]);

export function configureSqliteConnection(driver: OpenedDriver): SqliteConnection {
  // Order matters: journal_mode is a no-op inside a transaction, and busy_timeout
  // should be in force before anything can contend, so both precede any work.
  //
  // The result is read rather than discarded, because this pragma *reports* the
  // mode it settled on and does not fail when it cannot honour the request. On a
  // filesystem that does not support WAL — several network filesystems do not —
  // SQLite quietly stays on rollback journaling and returns `delete`. Everything
  // above would then be false, with no error to say so, and the first symptom
  // would be writes blocking reads under load.
  const [selected] = driver.prepare(`PRAGMA journal_mode = WAL`).all() as Array<{ journal_mode?: unknown }>;
  const journalMode = String(selected?.journal_mode ?? "").toLowerCase();
  if (!ACCEPTABLE_JOURNAL_MODES.has(journalMode)) {
    throw new Error(
      `SQLite refused write-ahead logging and selected "${journalMode || "unknown"}" instead. `
      + "The database file is most likely on a filesystem that cannot support it, such as a network mount; "
      + "move it to local storage.",
    );
  }

  driver.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  driver.exec(`PRAGMA synchronous = FULL`);

  return {
    database: createSqliteDatabase(driver),
    driver,
    close: () => driver.close(),
  };
}
