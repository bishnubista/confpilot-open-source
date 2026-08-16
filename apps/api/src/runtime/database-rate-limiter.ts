/**
 * A `RateLimiter` whose counters live in the database.
 *
 * The port's own note says why this exists: limiter state must be shared across
 * every process serving the app. Cloudflare's binding is shared by construction;
 * an in-memory counter is not, and two Node processes behind a load balancer
 * would each get their own, quietly multiplying the configured login budget by
 * the number of workers. Putting the counters where every process already looks
 * — the database — is the smallest thing that restores the property.
 *
 * ## Why the counters are not in a migration
 *
 * They are host infrastructure, not application data. On Cloudflare they live
 * inside the rate-limiting binding and never reach D1, so adding them to the
 * shared schema would ship production a table production never reads. The table
 * is created here instead, by the code that owns it.
 *
 * ## Why an event row per permitted request, rather than a counter
 *
 * The first version of this kept one count per fixed window and weighted the
 * previous window by how much of it still overlapped — the standard
 * sliding-window-counter approximation. It is a *approximation*, and adversarial
 * review measured what that costs: with a limit of five, five attempts at 59.9s
 * and four more at 118.9s were all permitted, nine inside one real minute. For a
 * throttle in front of credential checks, "roughly five" is not the number the
 * configuration states.
 *
 * Recording each permitted request and counting the trailing period exactly
 * removes the approximation. The guarantee is now literal: **at most `limit`
 * requests succeed in any `periodSeconds` window**, with no edge case.
 *
 * Storage stays bounded because only *permitted* requests are recorded, so a key
 * holds at most `limit` rows, and rows older than the window are pruned on every
 * call. A refused request costs nothing to store, which also means hammering
 * cannot extend its own block past the window — it does not need to, since the
 * limit is enforced exactly either way.
 *
 * ## Why the database's clock
 *
 * Every replica reads time from the database rather than from its own host, so
 * two machines whose clocks disagree cannot each believe a different window is
 * current — and, more sharply, cannot prune counters the other still needs. The
 * injectable clock exists for tests, which is the only caller that should ever
 * supply one.
 *
 * ## Failure is not permission
 *
 * Errors propagate rather than resolving to `{ success: true }`. A limiter that
 * cannot record an attempt cannot establish that the attempt is under the limit,
 * and swallowing the error would silently remove brute-force protection at
 * exactly the moment something is already wrong. Transient lock contention is
 * handled below this layer, by the connection's busy timeout.
 */
import type { Database } from "./database";
import type { RateLimiter } from "./rate-limiter";

export interface DatabaseRateLimiterOptions {
  /** Distinguishes one limiter's events from another's in the shared table. */
  bucket: string;
  /** Requests permitted per `periodSeconds`. */
  limit: number;
  /** Window length in seconds, matching the `simple.period` of the binding it replaces. */
  periodSeconds: number;
  /** Seconds since the epoch. For tests only — production reads the database's clock. */
  now?: () => number | Promise<number>;
}

const TABLE = "host_rate_limit_events";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    bucket TEXT NOT NULL,
    subject TEXT NOT NULL,
    at INTEGER NOT NULL
  )
`;

/** Covers the count, whose selectivity is what keeps this cheap as keys accumulate. */
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_lookup ON ${TABLE} (bucket, subject, at)`;

/** Covers the prune, which is otherwise a scan of every key on every request. */
const CREATE_PRUNE_INDEX = `CREATE INDEX IF NOT EXISTS ${TABLE}_at ON ${TABLE} (at)`;

export async function createDatabaseRateLimiter(
  database: Database,
  options: DatabaseRateLimiterOptions,
): Promise<RateLimiter> {
  const { bucket, limit, periodSeconds, now } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("A rate limit must be a positive whole number of requests");
  }
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds < 1) {
    throw new RangeError("A rate limit period must be a positive whole number of seconds");
  }

  await database.prepare(CREATE_TABLE).run();
  await database.prepare(CREATE_INDEX).run();
  await database.prepare(CREATE_PRUNE_INDEX).run();

  const currentSeconds = async (): Promise<number> => {
    if (now) return now();
    const seconds = await database.prepare("SELECT unixepoch() AS seconds").first<number>("seconds");
    if (typeof seconds !== "number") throw new Error("The database did not report a current time");
    return seconds;
  };

  return {
    async limit({ key }) {
      const at = await currentSeconds();
      const since = at - periodSeconds;

      // One batch, so the count and the record that depends on it cannot be
      // separated by another replica's write. The insert is conditional on the
      // count, which is what makes the decision and the record a single act:
      // whether it inserted a row *is* whether the request was permitted.
      const [, recorded] = await database.batch([
        database.prepare(`DELETE FROM ${TABLE} WHERE at <= ?`).bind(since),
        database.prepare(`
          INSERT INTO ${TABLE} (bucket, subject, at)
          SELECT ?, ?, ?
          WHERE (SELECT COUNT(*) FROM ${TABLE} WHERE bucket = ? AND subject = ? AND at > ?) < ?
        `).bind(bucket, key, at, bucket, key, since, limit),
      ]);

      return { success: recorded.meta.changes === 1 };
    },
  };
}
