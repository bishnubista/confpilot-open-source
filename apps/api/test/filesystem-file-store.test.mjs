/**
 * The filesystem adapter's own behaviour, below the shared contract.
 *
 * `file-store-conformance.test.mjs` covers everything the port promises, and runs
 * against R2 too, so it cannot reach for a sidecar on disk. These tests do: they
 * corrupt one and assert the store refuses it. Every case here is a claim the
 * module docblock makes — that a sidecar is validated rather than trusted, and
 * that a write id is checked before it becomes a path — held to a test rather
 * than left as prose.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFilesystemPrivateFileStore } from "../src/runtime/filesystem-file-store.ts";

const encoder = new TextEncoder();
const payload = encoder.encode("deliverable bytes");
const KEY = "event/deck.pdf";

async function sidecarPathFor(directory, key) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  const name = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return join(directory, `${name}.json`);
}

describe("filesystem private file store", () => {
  let directory;
  let store;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "confpilot-fs-store-"));
    store = createFilesystemPrivateFileStore(directory);
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  /** Replace the stored sidecar with `mutate`'s result, leaving the bytes alone. */
  async function corruptSidecar(mutate) {
    const path = await sidecarPathFor(directory, KEY);
    const stored = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, typeof mutate === "string" ? mutate : JSON.stringify(mutate(stored)));
  }

  describe("refuses a sidecar it did not write", () => {
    beforeEach(async () => {
      await store.put(KEY, payload, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { eventScope: "evt-devflow" },
        sha256: await crypto.subtle.digest("SHA-256", payload),
      });
      expect(await store.head(KEY)).not.toBeNull();
    });

    it.each([
      ["unparseable JSON", "{ not json"],
      ["a different key", (stored) => ({ ...stored, key: "event/other.pdf" })],
      ["a negative size", (stored) => ({ ...stored, size: -1 })],
      ["a fractional size", (stored) => ({ ...stored, size: 12.5 })],
      ["a non-numeric size", (stored) => ({ ...stored, size: "17" })],
      ["a malformed digest", (stored) => ({ ...stored, sha256: "not-a-digest" })],
      ["a missing write id", ({ object, ...rest }) => rest],
      ["a non-string metadata value", (stored) => ({ ...stored, customMetadata: { eventScope: 7 } })],
      ["metadata of the wrong type", (stored) => ({ ...stored, httpMetadata: "application/pdf" })],
    ])("rejects %s", async (_label, mutate) => {
      await corruptSidecar(mutate);
      // Both readers, because the archive path verifies with head() and then
      // streams with get(): a sidecar accepted by one and refused by the other is
      // the torn state, reached through corruption instead of a race.
      expect(await store.head(KEY)).toBeNull();
      expect(await store.get(KEY)).toBeNull();
    });

    it("does not follow a write id that escapes the directory", async () => {
      // The write id is interpolated into a filename, so it is the one field in a
      // file read off disk that could reach outside the store.
      await corruptSidecar((stored) => ({ ...stored, object: "../../../etc/passwd" }));
      expect(await store.head(KEY)).toBeNull();
      expect(await store.get(KEY)).toBeNull();
    });
  });

  it("deletes idempotently before its directory exists", async () => {
    // Only `put` creates the directory, and `delete` flushes it — so a delete
    // that arrives first meets a directory that is not there. Treating that as a
    // failure would break the port's promise that deleting an absent key
    // succeeds. Pointed at a path that does not exist rather than the fixture's,
    // which the test setup has already created.
    const fresh = createFilesystemPrivateFileStore(join(directory, "not-created-yet"));
    await expect(fresh.delete("event/never-written.pdf")).resolves.not.toThrow();
  });

  it("leaves one data file per key after repeated overwrites", async () => {
    // Superseded bytes are reclaimed rather than accumulating. Orphans are
    // acceptable on an interrupted write; steady growth on a working one is not.
    for (const text of ["first", "second-longer", "third"]) {
      await store.put(KEY, encoder.encode(text));
    }
    const files = await readdir(directory);
    expect(files.filter((name) => name.endsWith(".bin"))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });
});
