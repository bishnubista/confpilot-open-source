/**
 * Apply the schema on a host that has no `wrangler d1 migrations apply`.
 *
 * On Cloudflare, migrations are a deploy step run by a human or a pipeline. A
 * container has neither, so the server applies them on boot — which introduces a
 * problem the Cloudflare path does not have: several replicas may boot at once,
 * and all of them will find the same work to do.
 *
 * ## Why this takes the driver rather than the `Database` port
 *
 * The port's `batch()` is the only transaction it exposes, and it takes
 * statements that are already prepared. Preparing is not free of the schema:
 * `better-sqlite3` compiles a statement when it is prepared, so a statement that
 * mentions a table an earlier migration creates cannot be prepared before that
 * migration has run. Migrations are the one workload that changes the schema it
 * is being compiled against, so the port is the wrong shape for them — and it
 * costs nothing here, because this code only ever runs on the Node host. On
 * Cloudflare, wrangler does this job and this module is never loaded.
 *
 * Taking the driver also means whole scripts go to SQLite's own multi-statement
 * `exec`, so nothing has to parse SQL to find statement boundaries — which for
 * this schema would mean getting trigger bodies and their internal semicolons
 * right, for no benefit.
 *
 * ## Mutual exclusion without a lock table
 *
 * A lock row is the obvious answer and the wrong one: a process that dies holding
 * it leaves every future boot blocked on a lock whose owner will never return,
 * and the repair is manual. Instead the run happens inside `BEGIN IMMEDIATE`,
 * which takes SQLite's write lock, and each ledger row is inserted *before* the
 * migration it names. A second process that had already read the same pending
 * list collides on the ledger's uniqueness, rolls back having changed nothing,
 * and re-reads to find the work done. Nothing outlives the transaction, so
 * nothing survives a crash to be cleaned up.
 *
 * ## The ledger is wrangler's
 *
 * `d1_migrations` is the table `wrangler d1 migrations apply` maintains, with the
 * same columns. A database migrated on Cloudflare and then exported to a Node
 * host is therefore recognised as already migrated rather than re-applied from
 * the beginning, which is the difference between moving a deployment and losing
 * it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { migrationNames } from "../../scripts/migration-files.mjs";
import { refuseTransactionControl } from "../../scripts/sql-transaction-control.mjs";
import type { SqliteDriver } from "../runtime/sqlite-database";

const LEDGER = "d1_migrations";

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS ${LEDGER} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function appliedNames(driver: SqliteDriver): Set<string> {
  const rows = driver.prepare(`SELECT name FROM ${LEDGER}`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Bring the database up to the migrations on disk, returning what was applied.
 *
 * Safe to call from every replica on every boot: it is a no-op once the ledger
 * names every migration, and concurrent callers resolve through the transaction
 * described above rather than through coordination between them.
 */
export async function applyMigrations(driver: SqliteDriver, directory: string): Promise<string[]> {
  driver.exec(CREATE_LEDGER);

  const names = migrationNames(await readdir(directory));
  const applied = appliedNames(driver);
  const pending = names.filter((name) => !applied.has(name));
  if (pending.length === 0) return [];

  // Read before the transaction opens, so the write lock is not held across file
  // I/O while another replica waits on it.
  const scripts = await Promise.all(pending.map((name) => readFile(join(directory, name), "utf8")));
  // Checked before the transaction opens, so a bad script fails without having
  // written anything at all.
  pending.forEach((name, index) => refuseTransactionControl(name, scripts[index]));

  driver.exec("BEGIN IMMEDIATE");
  try {
    const record = driver.prepare(`INSERT INTO ${LEDGER} (name) VALUES (?)`);
    pending.forEach((name, index) => {
      // Ledger first, so a competing run collides here rather than part way
      // through the schema.
      record.run(name);
      driver.exec(scripts[index]);
    });
    driver.exec("COMMIT");
    return pending;
  } catch (error) {
    // SQLite ends the transaction itself on some failures, and a script carrying
    // its own COMMIT leaves none open either — so this can throw "cannot rollback
    // - no transaction is active". Letting that escape would replace the real
    // error with a misleading one *and* skip the contention check below, turning
    // a lost race into a failed boot.
    try {
      driver.exec("ROLLBACK");
    } catch {
      // Nothing to roll back: the transaction is already closed.
    }
    // Losing the race is a success for the caller: the schema is current, it just
    // was not this process that made it so. Anything else is a real failure and
    // must not be mistaken for contention.
    const settled = appliedNames(driver);
    if (pending.every((name) => settled.has(name))) return [];
    throw error;
  }
}
