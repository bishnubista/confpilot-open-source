/**
 * Pin the isolation the shared-Miniflare helper claims to provide.
 *
 * Sharing one `workerd` process across a test file only holds because each
 * `open()` returns a binding nothing has written to. The D1 suites notice when
 * that stops being true — a later test's fixture collides with an earlier one
 * and the suite goes red — but the R2 contract does not: its keys happen not to
 * overlap, so a bucket that quietly persisted between tests would still pass
 * every assertion in it.
 *
 * That is the gap this file closes. It asserts the guarantee directly, so a
 * regression in the helper fails here rather than lying dormant until someone
 * adds a store test that does depend on starting empty.
 */
import { describe, expect, it } from "vitest";

import { shareD1Database, shareR2Bucket } from "./support/miniflare.mjs";

const openDatabase = shareD1Database();
const openBucket = shareR2Bucket();

describe("shared Miniflare storage", () => {
  it("hands each D1 open an empty database", async () => {
    const first = await openDatabase();
    await first.prepare("CREATE TABLE leftover (id TEXT PRIMARY KEY)").run();
    await first.prepare("INSERT INTO leftover (id) VALUES ('written')").run();
    expect(await first.prepare("SELECT COUNT(*) AS n FROM leftover").first("n")).toBe(1);

    const second = await openDatabase();
    // The table itself must be gone, not merely its rows: a database that reset
    // data but kept the schema would still let a migration leak between tests.
    await expect(second.prepare("SELECT COUNT(*) AS n FROM leftover").first("n"))
      .rejects.toThrow(/no such table/i);
  });

  it("keeps an earlier handle usable after a later open", async () => {
    // What lets a suite take one database in `beforeAll` while its neighbours
    // keep opening their own. It holds because opens move to a new binding
    // rather than repointing one, and it would not hold under the obvious
    // alternative of rotating a single binding's storage id.
    const held = await openDatabase();
    await held.prepare("CREATE TABLE held (id TEXT PRIMARY KEY)").run();

    await openDatabase();

    await held.prepare("INSERT INTO held (id) VALUES ('still-there')").run();
    expect(await held.prepare("SELECT COUNT(*) AS n FROM held").first("n")).toBe(1);
  });

  it("hands each R2 open an empty bucket", async () => {
    const first = await openBucket();
    await first.put("event/leftover.bin", new TextEncoder().encode("bytes"));
    expect(await first.head("event/leftover.bin")).not.toBeNull();

    const second = await openBucket();
    expect(await second.head("event/leftover.bin")).toBeNull();
    expect(await second.get("event/leftover.bin")).toBeNull();
  });
});
