/**
 * Private object storage, as a contract rather than a borrowed type.
 *
 * ConfPilot stores headshots and presentation versions as private objects served
 * only through authorization-checked routes. This port previously read
 * `Pick<R2Bucket, "get" | "put" | "head" | "delete">`, which named the four
 * methods but silently inherited R2's option bags and object shape — so "satisfy
 * the type" and "behave correctly" were different things, and the file said as
 * much: *describe ConfPilot as Cloudflare-first rather than provider-neutral.*
 *
 * The surface the application actually consumes is small enough to state
 * outright, so it is stated here. R2 still satisfies it structurally, which keeps
 * the Cloudflare adapter an identity binding; the difference is that a filesystem
 * or S3 adapter now has a contract to implement instead of a type to imitate.
 *
 * Semantics an adapter must reproduce, none of which the types can enforce:
 *
 * - `put` persists the bytes and treats `sha256` as an integrity check, failing
 *   the write when the digest does not match.
 * - `head` and `get` return exactly the `size`, `httpMetadata.contentType`,
 *   `customMetadata`, and `checksums.sha256` that were written. The upload path
 *   reads all four back immediately and rolls the write back on any mismatch,
 *   and the archive path re-verifies them per entry, so an adapter that drops a
 *   field fails closed rather than silently serving unverified bytes.
 * - `get` streams through `body`, because deliverable archives are built without
 *   buffering whole files.
 * - `delete` is idempotent, so upload rollback cannot fail on a retry.
 * - Objects are never reachable over a public URL.
 */

/** Metadata a caller sets on write and reads back to verify the object landed intact. */
export interface PrivateFileHttpMetadata {
  contentType?: string;
  contentDisposition?: string;
}

export interface PrivateFileMetadata {
  size: number;
  httpMetadata?: PrivateFileHttpMetadata;
  customMetadata?: Record<string, string>;
  /** Raw digest bytes, as R2 returns them — not the hex string form. */
  checksums?: { sha256?: ArrayBuffer };
}

/**
 * A stored object plus its bytes.
 *
 * The chunk type is part of the contract, not decoration. `deliverables-archive`
 * streams objects straight into a zip, reading `value.byteLength` and feeding
 * each chunk to a CRC32. An adapter yielding `ArrayBuffer` or string chunks would
 * satisfy a bare `ReadableStream` and then corrupt archives at runtime — exactly
 * the "satisfies the type, breaks the behaviour" gap this contract exists to close.
 */
export interface PrivateFileObject extends PrivateFileMetadata {
  body: ReadableStream<Uint8Array>;
}

export interface PrivateFilePutOptions {
  httpMetadata?: PrivateFileHttpMetadata;
  customMetadata?: Record<string, string>;
  /**
   * Verified by the store on write; a mismatch must reject rather than persist.
   *
   * A string is **lowercase hexadecimal**, matching what R2 accepts — not base64.
   * The upload path passes the raw `ArrayBuffer` from `crypto.subtle.digest`, so
   * the string form is unused today; it is stated because an adapter handed one
   * has no other way to know, and guessing base64 would compare two different
   * encodings and reject every valid write.
   */
  sha256?: ArrayBuffer | string;
}

export interface PrivateFileStore {
  /**
   * Returns the metadata that landed, agreeing with what `head()` then reports.
   *
   * This was `Promise<unknown>`, which is the absence of a contract rather than a
   * permissive one: two adapters returned structurally different values and
   * nothing could notice.
   *
   * It is not nullable. R2 has a nullable `put` overload, but only for the
   * conditional `onlyIf` write this port does not expose, so the unconditional
   * overload — which always resolves to an object — is the one R2 satisfies this
   * signature with.
   *
   * The upload path still re-reads with `head()` rather than trusting what comes
   * back here, because only a fresh read proves what is actually stored.
   */
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: PrivateFilePutOptions,
  ): Promise<PrivateFileMetadata>;
  head(key: string): Promise<PrivateFileMetadata | null>;
  get(key: string): Promise<PrivateFileObject | null>;
  /** Idempotent: deleting an absent key succeeds. */
  delete(key: string): Promise<void>;
}

/**
 * Wire the Cloudflare R2 binding as the private file store.
 *
 * R2 satisfies the contract as written, so this stays an identity binding. It
 * exists so composition happens in one place and a second adapter has an obvious
 * seam to slot into.
 */
export function createR2PrivateFileStore(bucket: PrivateFileStore): PrivateFileStore {
  return bucket;
}
