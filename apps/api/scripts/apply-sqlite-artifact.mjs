import { constants } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";

import { migrationNames } from "./migration-files.mjs";
import { refuseTransactionControl } from "./sql-transaction-control.mjs";

export class SqliteArtifactError extends Error {}

async function readPrivateSqlArtifact(path) {
  let handle;
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow) || noFollow === 0) {
    throw new SqliteArtifactError("This platform cannot safely open a SQL artifact without following symlinks.");
  }
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch {
    throw new SqliteArtifactError("The SQL artifact does not exist, is a symlink, or cannot be read.");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new SqliteArtifactError("The SQL artifact must be a regular file.");
    if ((metadata.mode & 0o077) !== 0) {
      throw new SqliteArtifactError("The SQL artifact must have mode 0600 or stricter.");
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function expectedMigrations(directory) {
  try {
    return migrationNames(await readdir(directory));
  } catch {
    throw new SqliteArtifactError("The migrations directory cannot be read or contains an invalid SQL filename.");
  }
}

function requireCompleteMigrationLedger(driver, expected) {
  let applied;
  try {
    applied = driver.prepare("SELECT name FROM d1_migrations ORDER BY name").pluck().all();
  } catch {
    throw new SqliteArtifactError("The SQLite database has no readable migration ledger.");
  }
  if (applied.length !== expected.length || applied.some((name, index) => name !== expected[index])) {
    throw new SqliteArtifactError("The SQLite database migrations do not exactly match this ConfPilot build.");
  }
}

export async function applySqliteArtifact({ databasePath, inputPath, migrationsDirectory }) {
  const database = resolve(databasePath);
  const input = resolve(inputPath);
  const migrations = resolve(migrationsDirectory ?? fileURLToPath(new URL("../migrations/", import.meta.url)));
  try {
    const metadata = await stat(database);
    if (!metadata.isFile()) throw new Error();
  } catch {
    throw new SqliteArtifactError("The SQLite database must already exist and have its migrations applied.");
  }

  const sql = await readPrivateSqlArtifact(input);
  if (!sql.trim()) throw new SqliteArtifactError("The SQL artifact is empty.");
  try {
    refuseTransactionControl("The SQL artifact", sql);
  } catch {
    throw new SqliteArtifactError("The SQL artifact must not manage its own transaction.");
  }

  const expected = await expectedMigrations(migrations);
  if (expected.length === 0) throw new SqliteArtifactError("The migrations directory contains no SQL migrations.");

  const driver = new BetterSqlite3(database, { fileMustExist: true });
  try {
    driver.pragma("foreign_keys = ON");
    driver.pragma("busy_timeout = 5000");
    requireCompleteMigrationLedger(driver, expected);
    driver.exec("BEGIN IMMEDIATE");
    try {
      driver.exec(sql);
      const foreignKeyFailures = driver.pragma("foreign_key_check");
      if (foreignKeyFailures.length > 0) throw new SqliteArtifactError("The artifact would leave foreign-key violations.");
      driver.exec("COMMIT");
    } catch (error) {
      try { driver.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  } finally {
    driver.close();
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--database", "--input"].includes(flag)) {
      throw new SqliteArtifactError("Usage: apply-sqlite-artifact --database <sqlite-file> --input <mode-0600-sql-file>");
    }
    values[flag.slice(2)] = value;
  }
  if (!values.database || !values.input) {
    throw new SqliteArtifactError("Usage: apply-sqlite-artifact --database <sqlite-file> --input <mode-0600-sql-file>");
  }
  return { databasePath: values.database, inputPath: values.input };
}

async function main() {
  await applySqliteArtifact({
    ...parseArguments(process.argv.slice(2)),
    migrationsDirectory: process.env.MIGRATIONS_DIRECTORY,
  });
  console.log("Applied the SQLite artifact in one transaction.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof SqliteArtifactError ? error.message : "The SQLite artifact was not applied.");
    process.exitCode = 1;
  });
}
