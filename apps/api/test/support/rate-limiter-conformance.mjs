/**
 * The behaviour a database-backed rate limiter must have, on any `Database`.
 *
 * Written as a shared suite for the same reason the other contracts are: the
 * limiter is portable code over the database port, so asserting it against one
 * implementation would only document that implementation. It runs against D1 and
 * better-sqlite3 alike.
 *
 * The clock is injected throughout. A limiter tested by sleeping is slow and
 * flaky, and worse, it cannot test the window boundaries that matter — the whole
 * question is what happens as one window ages out of relevance.
 */
import { describe, expect, it } from "vitest";

import { createDatabaseRateLimiter } from "../../src/runtime/database-rate-limiter.ts";

export function describeRateLimiterContract(name, openDatabase) {
  describe(`database rate limiter: ${name}`, () => {
    /**
     * Isolate each test by bucket rather than by database.
     *
     * A database per test is the obvious shape and, for the D1 run, means a
     * Miniflare instance per test — ten `workerd` processes for one suite. That
     * was enough extra load to time out the Miniflare hook in an unrelated file
     * on CI, which is the sort of thing a slow suite does to its neighbours. The
     * limiter already partitions its storage by bucket, so tests can share one
     * database and still not see each other.
     */
    let suffix = 0;
    async function withLimiter(options, body) {
      const { database, dispose } = await openDatabase();
      const bucket = `login-source-${suffix += 1}`;
      // Aligned to a 60-second boundary, so a test that means to cross one does.
      // An arbitrary start lands mid-window, and `advance(59)` then `advance(1)`
      // stays inside a single window — which reads as a boundary test and is not.
      const clock = { now: 1_000_000_020_000 };
      try {
        const limiter = await createDatabaseRateLimiter(database, {
          bucket,
          limit: 5,
          periodSeconds: 60,
          // Seconds, matching the database clock this stands in for. The fixture
          // tracks milliseconds because `advance` reads better that way.
          now: () => Math.floor(clock.now / 1000),
          ...options,
        });
        await body({ limiter, clock, database, bucket });
      } finally {
        await dispose();
      }
    }

    /** Rows this test wrote, which is not every row when the database is shared. */
    const storedRows = async (database, bucket) => {
      const { results } = await database
        .prepare("SELECT COUNT(*) AS rows FROM host_rate_limit_events WHERE bucket = ?")
        .bind(bucket).all();
      return results[0].rows;
    };

    const advance = (clock, seconds) => { clock.now += seconds * 1000; };
    const attempt = (limiter, key = "203.0.113.7") => limiter.limit({ key });

    it("permits exactly the configured number of requests in a window", async () => {
      await withLimiter({}, async ({ limiter }) => {
        for (let index = 0; index < 5; index += 1) {
          expect(await attempt(limiter), `request ${index + 1} of 5`).toEqual({ success: true });
        }
        expect(await attempt(limiter)).toEqual({ success: false });
      });
    });

    it("counts each key separately", async () => {
      await withLimiter({}, async ({ limiter }) => {
        for (let index = 0; index < 5; index += 1) await attempt(limiter, "first");
        expect(await attempt(limiter, "first")).toEqual({ success: false });
        expect(await attempt(limiter, "second")).toEqual({ success: true });
      });
    });

    it("gives hammering no more successes than patience would", { timeout: 30_000 }, async () => {
      // Refused attempts are not recorded, so a flood cannot grow the table. What
      // must hold regardless is the only property that matters: the number that
      // got through is the configured limit, however many were tried.
      await withLimiter({}, async ({ limiter }) => {
        let permitted = 0;
        // Five times the limit is enough to prove it. Every attempt here is a
        // round trip to Miniflare, and a suite slow enough to time out on a CI
        // runner also starves the Miniflare tests running beside it.
        for (let index = 0; index < 25; index += 1) {
          if ((await attempt(limiter)).success) permitted += 1;
        }
        expect(permitted).toBe(5);
      });
    });

    it("permits no more than the limit in ANY window, not just an aligned one", { timeout: 30_000 }, async () => {
      // The case adversarial review reproduced against the sliding-window-counter
      // this replaced: spend the budget at the end of one window and most of it
      // again early in the next, and nine got through against a limit of five.
      // Walked second by second so the window that matters is the trailing one
      // from every point, not the one the implementation happens to track.
      await withLimiter({}, async ({ limiter, clock }) => {
        const permittedAt = [];
        // Two full periods, in four-second steps: enough to cross both boundaries
        // with the budget spent at an edge, and short enough to stay well inside
        // the time budget against Miniflare, where every attempt is a real batched
        // round trip.
        for (let second = 0; second < 132; second += 4) {
          for (let burst = 0; burst < 2; burst += 1) {
            if ((await attempt(limiter)).success) permittedAt.push(second);
          }
          advance(clock, 4);
        }
        expect(permittedAt.length, "some requests must get through").toBeGreaterThan(0);
        for (const start of permittedAt) {
          const inWindow = permittedAt.filter((t) => t > start - 60 && t <= start).length;
          expect(inWindow, `window ending at ${start}s`).toBeLessThanOrEqual(5);
        }
      });
    });

    it("does not hand back a full budget the moment a window turns over", async () => {
      await withLimiter({}, async ({ limiter, clock }) => {
        advance(clock, 59);
        for (let index = 0; index < 5; index += 1) {
          expect(await attempt(limiter), `request ${index + 1} before the boundary`).toEqual({ success: true });
        }
        advance(clock, 1);
        expect(await attempt(limiter), "first request after the boundary").toEqual({ success: false });
      });
    });

    it("restores the budget once the previous window has fully aged out", async () => {
      await withLimiter({}, async ({ limiter, clock }) => {
        for (let index = 0; index < 5; index += 1) await attempt(limiter);
        expect(await attempt(limiter)).toEqual({ success: false });
        advance(clock, 120);
        expect(await attempt(limiter)).toEqual({ success: true });
      });
    });

    it("shares state between limiters over the same database", async () => {
      // The property the port's note is about: two processes are two limiter
      // instances over one database, and they must not each get their own budget.
      await withLimiter({}, async ({ limiter, database, clock, bucket }) => {
        const second = await createDatabaseRateLimiter(database, {
          bucket, limit: 5, periodSeconds: 60, now: () => Math.floor(clock.now / 1000),
        });
        for (let index = 0; index < 3; index += 1) await attempt(limiter);
        for (let index = 0; index < 2; index += 1) await attempt(second);
        expect(await attempt(second), "the sixth request across both").toEqual({ success: false });
      });
    });

    it("keeps buckets independent, so one limiter cannot exhaust another", async () => {
      await withLimiter({}, async ({ limiter, database, clock, bucket }) => {
        const account = await createDatabaseRateLimiter(database, {
          bucket: `${bucket}-account`, limit: 5, periodSeconds: 60,
          now: () => Math.floor(clock.now / 1000),
        });
        for (let index = 0; index < 5; index += 1) await attempt(limiter, "same-key");
        expect(await attempt(limiter, "same-key")).toEqual({ success: false });
        expect(await attempt(account, "same-key")).toEqual({ success: true });
      });
    });

    it("discards events it can no longer count", async () => {
      // Pruning is what keeps the table bounded without a sweep, so it is checked
      // rather than assumed — an unbounded table is a slow leak that only shows
      // up in production.
      await withLimiter({}, async ({ limiter, clock, database, bucket }) => {
        for (const key of ["a", "b", "c"]) await attempt(limiter, key);
        advance(clock, 300);
        await attempt(limiter, "d");
        expect(await storedRows(database, bucket)).toBe(1);
      });
    });

    it("records only what it permitted, so a flood cannot grow the table", { timeout: 30_000 }, async () => {
      await withLimiter({}, async ({ limiter, database, bucket }) => {
        for (let index = 0; index < 20; index += 1) await attempt(limiter);
        expect(await storedRows(database, bucket)).toBe(5);
      });
    });

    it("refuses a limit or period that cannot throttle anything", async () => {
      const { database, dispose } = await openDatabase();
      try {
        await expect(createDatabaseRateLimiter(database, { bucket: "b", limit: 0, periodSeconds: 60 }))
          .rejects.toThrow(RangeError);
        await expect(createDatabaseRateLimiter(database, { bucket: "b", limit: 5, periodSeconds: 0 }))
          .rejects.toThrow(RangeError);
      } finally {
        await dispose();
      }
    });
  });
}
