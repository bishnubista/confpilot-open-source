/**
 * One Miniflare instance per test file, handing out fresh storage per test.
 *
 * Every Miniflare is a `workerd` process. Constructing one per test had this
 * directory starting 34 of them for a single `vitest run`, and that churn is the
 * kind of load that timed out an unrelated Miniflare hook on CI. A suite that is
 * merely expensive still fails its neighbours.
 *
 * Isolation comes from a pool of bindings rather than a pool of processes. The
 * instance declares many bindings up front — which costs nothing until one is
 * touched, because storage is created on first access — and each `open()` hands
 * back the next, which no test has written to. That is the same guarantee a new
 * instance gave, on one process, at ~18ms instead of ~85ms.
 *
 * `setOptions()` with a rotating storage id looks like the tidier way to do this
 * and is not: it restarts `workerd`, so every open still spawns a process and
 * the churn this exists to remove comes straight back. Measured rather than
 * assumed — the process id changes on every call.
 *
 * Handles stay valid for the life of the file, so a suite that takes one
 * database in `beforeAll` keeps it however often its neighbours open their own.
 */
import { Miniflare } from "miniflare";
import { afterAll } from "vitest";

const WORKER = {
  modules: true,
  script: "export default { fetch() { return new Response('ok') } }",
  compatibilityDate: "2026-08-06",
};

/**
 * Bindings per instance, and so the most `open()` calls one file may make.
 * Comfortably above the largest suite here — fourteen, in the file store
 * contract. Running out fails loudly rather than quietly recycling storage that
 * a live test still holds.
 */
const POOL_SIZE = 32;

function shareMiniflare(storageKey, prefix, get) {
  const bindings = Array.from({ length: POOL_SIZE }, (_, index) => `${prefix}_${index}`);
  let miniflare;
  let opened = 0;

  afterAll(async () => {
    await miniflare?.dispose();
    miniflare = undefined;
  });

  return async function open() {
    if (opened >= bindings.length) {
      throw new Error(
        `Shared Miniflare ran out of ${storageKey} bindings after ${POOL_SIZE} opens. Raise POOL_SIZE in test/support/miniflare.mjs.`,
      );
    }
    const binding = bindings[opened];
    opened += 1;
    try {
      miniflare ??= new Miniflare({ ...WORKER, [storageKey]: bindings });
      return await get(miniflare, binding);
    } catch (error) {
      const failed = miniflare;
      miniflare = undefined;
      // Without this the workerd process outlives a failed setup, and the suite
      // hangs on exit rather than reporting the real failure.
      await failed?.dispose();
      throw error;
    }
  };
}

/** Open a fresh D1 database on this file's shared Miniflare. */
export function shareD1Database(prefix = "DB") {
  return shareMiniflare("d1Databases", prefix, (miniflare, binding) => miniflare.getD1Database(binding));
}

/** Open a fresh R2 bucket on this file's shared Miniflare. */
export function shareR2Bucket(prefix = "FILES") {
  return shareMiniflare("r2Buckets", prefix, (miniflare, binding) => miniflare.getR2Bucket(binding));
}
