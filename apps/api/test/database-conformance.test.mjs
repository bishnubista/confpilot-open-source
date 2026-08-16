/**
 * Hold every `Database` implementation to the same behaviour.
 *
 * D1 is the reference: it is what production runs, so where an adapter disagrees
 * the adapter is wrong. Running both through one suite is the point — a contract
 * asserted against a single implementation only documents that implementation.
 */
import BetterSqlite3 from "better-sqlite3";

import { createSqliteDatabase } from "../src/runtime/sqlite-database.ts";
import { describeDatabaseContract } from "./support/database-conformance.mjs";
import { shareD1Database } from "./support/miniflare.mjs";
import { describeMigrationContract } from "./support/migration-conformance.mjs";

// One workerd process for the file rather than fifteen. Every open below still
// returns an empty database — `shareD1Database` gives out a fresh binding, not a
// fresh process — so the behavioural contract keeps its database per test and
// the schema contract keeps the one it takes for its suite.
const openSharedD1 = shareD1Database();

async function openD1() {
  return { database: await openSharedD1(), dispose: () => {} };
}

async function openSqlite() {
  const driver = new BetterSqlite3(":memory:");
  return {
    database: createSqliteDatabase(driver),
    dispose: () => driver.close(),
  };
}

describeDatabaseContract("D1 (Miniflare)", openD1);
describeDatabaseContract("better-sqlite3", openSqlite);

// The behavioural contract above runs on a synthetic schema. These run the real
// migrations, which is where the authorization triggers live.
describeMigrationContract("D1 (Miniflare)", openD1);
describeMigrationContract("better-sqlite3", openSqlite);
