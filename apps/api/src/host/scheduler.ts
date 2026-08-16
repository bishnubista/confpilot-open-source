/**
 * The Node host's replacement for the Worker's cron trigger.
 *
 * `wrangler.jsonc` schedules a five-minute cron and Cloudflare invokes
 * `scheduled()`. A container has no such thing, so the server keeps its own
 * timer, at the same cadence.
 *
 * ## Why there is no distributed lock
 *
 * The obvious worry is several replicas each firing this timer and sending the
 * same email twice. `dispatchQueuedMessages` leases every message before sending
 * it, with a compare-and-set (`WHERE id = ? AND state = 'queued'`) whose affected
 * row count it checks, plus a lease token that stops a late writer recording a
 * result it no longer owns. Concurrent dispatchers were part of that design.
 *
 * That is *not* the same as exactly-once, and an earlier draft of this comment
 * claimed it was. Adversarial review found the gap: a dispatcher still inside the
 * provider call when its lease expires can be joined by a replica that recovers
 * the message and sends it again. With the shipped timings the send is capped at
 * ten seconds against a sixty-second lease, so this needs the process to stall
 * for the best part of a minute — but "needs a stall" is a narrow window, not a
 * guarantee. The outbox is at-least-once, and the durable fix belongs to whatever
 * mail adapter is written for this host: an idempotency key on the provider call,
 * carrying `outboxId`, so a repeat is deduplicated where the send happens.
 *
 * A lock here would not close that. The same expiry problem exists at the message
 * level, and a lock adds a failure of its own: one that outlives the process
 * holding it stops delivery until a human notices, and the symptom is silent — the
 * queue just stops draining. Duplicate ticks, by contrast, cost a few queries that
 * claim nothing. Between a cheap failure and a silent one, keep the cheap one.
 *
 * What a single process does need is to not overlap *itself*: a tick that runs
 * longer than the interval must not be joined by the next one, or a slow provider
 * turns into unbounded concurrent dispatches against the same database.
 */

export interface SchedulerOptions {
  /** Milliseconds between ticks. Matches the Worker's cron by default. */
  intervalMs?: number;
  /** Called when a tick throws, so the caller decides how to report it. */
  onError?: (error: unknown) => void;
}

export interface Scheduler {
  /** Resolves once any in-flight tick has finished. */
  stop(): Promise<void>;
}

/** The Worker's cron cadence, in milliseconds. */
export const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

export function startScheduler(tick: () => Promise<unknown>, options: SchedulerOptions = {}): Scheduler {
  const { intervalMs = DISPATCH_INTERVAL_MS, onError } = options;
  let running: Promise<unknown> | null = null;
  let stopped = false;

  const run = () => {
    // Skipped rather than queued. A backlog of deferred ticks would all fire at
    // once when a slow one finishes, which is the opposite of what a scheduler
    // that is already behind needs.
    if (running || stopped) return;
    running = Promise.resolve()
      .then(tick)
      .catch((error: unknown) => onError?.(error))
      .finally(() => { running = null; });
  };

  const timer = setInterval(run, intervalMs);
  // Does not hold the event loop open on its own; the server does that, and a
  // process with nothing else to do should be free to exit.
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Awaited so shutdown does not close the database under a tick that is
      // still writing to it.
      await running;
    },
  };
}
