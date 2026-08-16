/**
 * Run the rate limiter against both database implementations.
 *
 * The limiter is portable code over the `Database` port, so it has no adapter of
 * its own to test — what needs proving is that the same code behaves the same way
 * on D1 and on SQLite, since the Node host is the reason it exists at all.
 */
import BetterSqlite3 from "better-sqlite3";

import { createSqliteDatabase } from "../src/runtime/sqlite-database.ts";
import { shareD1Database } from "./support/miniflare.mjs";
import { describeRateLimiterContract } from "./support/rate-limiter-conformance.mjs";

/**
 * One Miniflare for the whole file, and one database inside it.
 *
 * Each instance is a `workerd` process, and the other suites here start their
 * own; a per-test instance made this file the heaviest in the repo and timed out
 * an unrelated Miniflare hook on CI. The contract isolates tests by bucket
 * instead, which is what the limiter partitions by anyway, so this opens one
 * database and hands the same one to every test. The promise rather than its
 * result is what gets memoized, so concurrent callers cannot each open one.
 */
const openSharedD1 = shareD1Database();
let opened;
async function openD1() {
  opened ??= openSharedD1();
  return { database: await opened, dispose: () => {} };
}

async function openSqlite() {
  const driver = new BetterSqlite3(":memory:");
  return {
    database: createSqliteDatabase(driver),
    dispose: () => driver.close(),
  };
}

describeRateLimiterContract("D1 (Miniflare)", openD1);
describeRateLimiterContract("better-sqlite3", openSqlite);
