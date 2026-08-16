/**
 * The behavioural contract every `PrivateFileStore` implementation must satisfy.
 *
 * The port used to be `Pick<R2Bucket, …>` — four method names borrowed from a
 * concrete type, with the semantics left implicit and a note conceding that
 * ConfPilot was Cloudflare-first rather than provider-neutral. That note can only
 * be retired by a second implementation passing the same tests as the first, so
 * this suite exists to be run against both.
 *
 * The expectations are not arbitrary: the upload path reads all four metadata
 * fields back immediately and rolls the write back on any mismatch, and the
 * deliverables archive re-verifies them per entry while streaming. An adapter
 * that quietly drops `customMetadata`, or returns a digest it did not verify,
 * breaks integrity checks rather than merely differing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const encoder = new TextEncoder();

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes) {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function drain(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function describeFileStoreContract(name, openStore) {
  describe(`PrivateFileStore contract: ${name}`, () => {
    let store;
    let dispose;
    const payload = encoder.encode("deliverable bytes");

    beforeEach(async () => {
      ({ store, dispose } = await openStore());
    }, 30_000);

    afterEach(async () => dispose?.());

    it("round-trips bytes with the metadata that was written", async () => {
      await store.put("event/deck.pdf", payload, {
        httpMetadata: { contentType: "application/pdf", contentDisposition: 'attachment; filename="deck.pdf"' },
        customMetadata: { eventScope: "evt-devflow", originalFilename: "deck.pdf" },
      });

      const head = await store.head("event/deck.pdf");
      expect(head).not.toBeNull();
      expect(head.size).toBe(payload.byteLength);
      expect(head.httpMetadata?.contentType).toBe("application/pdf");
      expect(head.customMetadata?.eventScope).toBe("evt-devflow");
      expect(head.customMetadata?.originalFilename).toBe("deck.pdf");
    });

    it("reports the stored digest so an integrity check can compare it", async () => {
      // R2 records a checksum only when the caller supplies one on write, rather
      // than computing one unprompted — so the contract is "reports back what was
      // written", and the upload path always writes it. Asserting it without
      // supplying it would test a behaviour production never relies on.
      const digest = await crypto.subtle.digest("SHA-256", payload);
      await store.put("event/digest.bin", payload, { sha256: digest });

      const head = await store.head("event/digest.bin");
      const stored = [...new Uint8Array(head.checksums?.sha256)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      expect(stored).toBe(await sha256Hex(payload));
    });

    it("streams the bytes back through get(), with the same metadata head() reports", async () => {
      // The archive path calls objectMatches() on the get() result, not just on
      // head(), so a store that populated metadata on one and not the other would
      // fail integrity checks mid-stream rather than up front.
      const digest = await crypto.subtle.digest("SHA-256", payload);
      await store.put("event/stream.bin", payload, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { eventScope: "evt-devflow" },
        sha256: digest,
      });

      const [head, object] = [await store.head("event/stream.bin"), await store.get("event/stream.bin")];
      expect(object).not.toBeNull();
      expect(await drain(object.body)).toEqual(payload);
      expect(object.size).toBe(head.size);
      expect(object.httpMetadata?.contentType).toBe(head.httpMetadata?.contentType);
      expect(object.customMetadata).toEqual(head.customMetadata);
      expect(new Uint8Array(object.checksums?.sha256)).toEqual(new Uint8Array(head.checksums?.sha256));
    });

    it("yields byte chunks, not strings or ArrayBuffers", async () => {
      // The contract types body as ReadableStream<Uint8Array>, and the archive
      // path relies on it: it reads value.byteLength and feeds each chunk to a
      // CRC32. A stream of strings or ArrayBuffers satisfies a bare
      // ReadableStream and corrupts archives instead of failing, so the chunk
      // type is asserted here rather than left to the type system — which cannot
      // see through an adapter's cast.
      await store.put("event/chunks.bin", payload);
      const reader = (await store.get("event/chunks.bin")).body.getReader();
      let chunks = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        expect(value, "each chunk must be a Uint8Array").toBeInstanceOf(Uint8Array);
        expect(typeof value.byteLength).toBe("number");
        chunks += 1;
      }
      expect(chunks).toBeGreaterThan(0);
    });

    it("rejects a write whose supplied digest does not match the bytes", async () => {
      // The upload path treats a mismatch as corruption and rolls back, which it
      // can only do if the store refuses the write rather than persisting it.
      const wrong = await crypto.subtle.digest("SHA-256", encoder.encode("different"));
      await expect(store.put("event/bad.bin", payload, { sha256: wrong })).rejects.toThrow();

      // And leaves nothing behind: the upload path rolls back on rejection, which
      // only works if the rejected write never became visible.
      expect(await store.head("event/bad.bin")).toBeNull();
      expect(await store.get("event/bad.bin")).toBeNull();
    });

    it("accepts a write whose supplied digest matches", async () => {
      const correct = await crypto.subtle.digest("SHA-256", payload);
      await expect(store.put("event/good.bin", payload, { sha256: correct })).resolves.toBeDefined();
      expect((await store.head("event/good.bin")).size).toBe(payload.byteLength);
    });

    it("returns null for an absent key rather than throwing", async () => {
      expect(await store.head("event/missing")).toBeNull();
      expect(await store.get("event/missing")).toBeNull();
    });

    it("deletes idempotently", async () => {
      // Upload rollback deletes on a failure path that may itself be retried.
      await store.put("event/gone.bin", payload);
      await store.delete("event/gone.bin");
      await expect(store.delete("event/gone.bin")).resolves.not.toThrow();
      expect(await store.head("event/gone.bin")).toBeNull();
    });

    it("keeps objects with similar keys separate", async () => {
      await store.put("event/a/file.bin", encoder.encode("first"));
      await store.put("event/b/file.bin", encoder.encode("second"));
      expect(await drain((await store.get("event/a/file.bin")).body)).toEqual(encoder.encode("first"));
      expect(await drain((await store.get("event/b/file.bin")).body)).toEqual(encoder.encode("second"));
    });

    it("never pairs one write's bytes with another write's metadata", async () => {
      // The property the app depends on: it writes, reads straight back, and
      // compares size/digest/metadata. A store that commits bytes and metadata
      // separately can satisfy that check against the wrong bytes.
      // Twelve writers at distinct lengths, because three was not enough: at
      // three, a store committing bytes and metadata separately passed roughly a
      // third of runs on luck alone.
      const writes = Array.from({ length: 12 }, (_, index) =>
        encoder.encode(`payload-${index}`.padEnd(8 + index * 7, "x")));
      // Each writer supplies its own digest, exactly as the upload path does —
      // R2 reports back only a checksum it was given, so a write without one
      // would leave nothing to compare the landed bytes against.
      await Promise.all(writes.map(async (bytes) => store.put("event/raced.bin", bytes, {
        sha256: await crypto.subtle.digest("SHA-256", bytes),
      })));

      const head = await store.head("event/raced.bin");
      const object = await store.get("event/raced.bin");
      const landed = await drain(object.body);

      // Whichever writer won, the object must be internally consistent.
      expect(writes.some((bytes) => bytes.length === landed.length)).toBe(true);
      expect(head.size).toBe(landed.byteLength);
      expect(await sha256Hex(landed)).toBe(toHex(head.checksums?.sha256));
    });

    it("never strips bytes that a published record still names", async () => {
      // A different failure from the one above, and the test above cannot see it:
      // it gives every writer distinct bytes and starts from an absent key, so
      // nothing is ever superseded and the reclamation path never runs.
      //
      // Overwriting has to reclaim the copy it replaced. Two conditions expose a
      // store that reclaims by content rather than by write: an object must
      // already exist, and a concurrent writer must store bytes identical to it,
      // so both writes land in the same place and one reclaims the other's.
      const first = encoder.encode("alpha");
      const second = encoder.encode("beta-is-longer");
      const [firstDigest, secondDigest] = await Promise.all(
        [first, second].map((bytes) => crypto.subtle.digest("SHA-256", bytes)),
      );

      for (let round = 0; round < 8; round += 1) {
        const key = `event/reused-${round}.bin`;
        await store.put(key, first, { sha256: firstDigest });
        await Promise.all([
          store.put(key, second, { sha256: secondDigest }),
          store.put(key, first, { sha256: firstDigest }),
        ]);

        const head = await store.head(key);
        const object = await store.get(key);
        // A record whose bytes are gone is the state that matters: the archive
        // path verifies each entry through head() and then streams it through
        // get(), so it would pass verification and then read nothing.
        expect(object, "head() reported an object that get() could not read").not.toBeNull();

        const landed = await drain(object.body);
        expect([first.length, second.length]).toContain(landed.length);
        expect(head.size).toBe(landed.byteLength);
        expect(await sha256Hex(landed)).toBe(toHex(head.checksums?.sha256));
      }
    });

    it("does not let a delete remove bytes a concurrent write has published", async () => {
      // The same collision reached from the other side: delete() removes a record
      // and then its bytes, so a write landing in between must keep its own. The
      // ordering that exposes this is far rarer than the overwrite case above —
      // it is asserted as a property rather than because it was reproduced.
      const digest = await crypto.subtle.digest("SHA-256", payload);
      for (let round = 0; round < 8; round += 1) {
        const key = `event/raced-delete-${round}.bin`;
        await store.put(key, payload, { sha256: digest });
        await Promise.all([store.delete(key), store.put(key, payload, { sha256: digest })]);

        // Either the delete or the write won; both are legitimate outcomes of a
        // race the caller asked for. A record without bytes is not.
        const head = await store.head(key);
        const object = await store.get(key);
        if (head === null) expect(object).toBeNull();
        else {
          expect(object, "the record survived the delete but its bytes did not").not.toBeNull();
          expect(await drain(object.body)).toEqual(payload);
        }
      }
    });

    it("reports the same metadata from put() that head() then reports", async () => {
      // put() used to be typed Promise<unknown>, so the two adapters could return
      // structurally different values and nothing would notice. Whatever comes
      // back must describe the object that landed.
      const digest = await crypto.subtle.digest("SHA-256", payload);
      const written = await store.put("event/returned.bin", payload, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { eventScope: "evt-devflow" },
        sha256: digest,
      });

      const head = await store.head("event/returned.bin");
      expect(written).not.toBeNull();
      expect(written.size).toBe(head.size);
      expect(written.httpMetadata?.contentType).toBe(head.httpMetadata?.contentType);
      expect(written.customMetadata).toEqual(head.customMetadata);
      expect(toHex(written.checksums?.sha256)).toBe(toHex(head.checksums?.sha256));
    });

    it("overwrites a key in place", async () => {
      await store.put("event/replace.bin", encoder.encode("before"));
      await store.put("event/replace.bin", encoder.encode("after-longer"));
      const head = await store.head("event/replace.bin");
      expect(head.size).toBe(encoder.encode("after-longer").byteLength);
      expect(await drain((await store.get("event/replace.bin")).body)).toEqual(encoder.encode("after-longer"));
    });
  });
}
