/**
 * The timer that replaces the Worker's cron trigger.
 *
 * Two properties matter and neither is "it fires on time": a tick must not be
 * joined by the next one while it is still running, and a failing tick must not
 * take the process with it. Both are the kind of thing that looks fine in
 * development and shows up under a slow provider in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISPATCH_INTERVAL_MS, startScheduler } from "../src/host/scheduler.ts";

describe("node host scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("matches the Worker's five-minute cron", () => {
    expect(DISPATCH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("runs the tick on each interval", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const scheduler = startScheduler(tick, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it("does not start a tick while one is still running", async () => {
    // A dispatch slower than the interval would otherwise be joined by every
    // subsequent one, turning a slow provider into unbounded concurrent work
    // against the same database.
    let release;
    const tick = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const scheduler = startScheduler(tick, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);
    expect(tick, "four intervals passed while the first tick was still running").toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick, "the next interval runs once the first has finished").toHaveBeenCalledTimes(2);

    // `release` now belongs to the second tick, and stop() waits for whatever is
    // in flight — so leaving it pending hangs the shutdown rather than the test
    // being flaky. That is the behaviour the last case here asserts on purpose.
    release();
    await scheduler.stop();
  });

  it("skips missed intervals rather than queueing them", async () => {
    // The backlog matters: a scheduler already behind must not fire five times
    // in a row the moment it catches up.
    let release;
    const tick = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const scheduler = startScheduler(tick, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("reports a failing tick and keeps going", async () => {
    const onError = vi.fn();
    const tick = vi.fn()
      .mockRejectedValueOnce(new Error("provider unreachable"))
      .mockResolvedValue(undefined);
    const scheduler = startScheduler(tick, { intervalMs: 1000, onError });

    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(tick, "a failed dispatch must not stop the schedule").toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("stops firing once stopped, and waits for the tick in flight", async () => {
    // Shutdown closes the database, so returning before the tick finishes would
    // pull the connection out from under a write.
    let release;
    let finished = false;
    const scheduler = startScheduler(
      () => new Promise((resolve) => { release = () => { finished = true; resolve(); }; }),
      { intervalMs: 1000 },
    );
    await vi.advanceTimersByTimeAsync(1000);

    const stopping = scheduler.stop();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled, "stop() resolved while a tick was still running").toBe(false);

    release();
    await stopping;
    expect(finished).toBe(true);
  });
});
