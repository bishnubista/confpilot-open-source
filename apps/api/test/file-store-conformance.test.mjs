/**
 * Hold both private-file-store implementations to one contract.
 *
 * R2 is the reference, because that is what production runs. The filesystem
 * adapter exists to prove the contract is implementable off Cloudflare — until it
 * passed this suite, the port was a set of borrowed method names.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFilesystemPrivateFileStore } from "../src/runtime/filesystem-file-store.ts";
import { describeFileStoreContract } from "./support/file-store-conformance.mjs";
import { shareR2Bucket } from "./support/miniflare.mjs";

// One workerd process for the file rather than fourteen. Every test still starts
// from an empty bucket, because `shareR2Bucket` hands out a fresh binding, so
// the contract keeps asserting absence — `head()` is null, a rejected write left
// nothing behind — without having to know which keys its neighbours used.
// `test/miniflare-sharing.test.mjs` is what holds that freshness honest: the
// contract's keys happen not to collide today, so nothing here would notice if
// buckets started leaking between tests.
const openSharedBucket = shareR2Bucket();

describeFileStoreContract("R2 (Miniflare)", async () => ({
  store: await openSharedBucket(),
  dispose: () => {},
}));

describeFileStoreContract("filesystem", async () => {
  const directory = mkdtempSync(join(tmpdir(), "confpilot-files-"));
  return {
    store: createFilesystemPrivateFileStore(directory),
    dispose: () => rmSync(directory, { force: true, recursive: true }),
  };
});
