/**
 * A `PrivateFileStore` backed by a local directory.
 *
 * This is the second implementation the contract was written for, and the reason
 * the contract could stop describing itself as R2-shaped.
 * `test/file-store-conformance.test.mjs` runs the same suite against this and
 * against real R2 under Miniflare.
 *
 * **Never import this from the Worker entry.** It uses `node:fs`, so it belongs
 * to the Node host and is deliberately absent from `runtime/index.ts`.
 *
 * ## Why an object is stored as two files, named this way
 *
 * R2 commits an object atomically. A filesystem does not, and the application
 * leans on that atomicity harder than it looks: the upload path writes, then
 * immediately reads the object back and rolls the write back unless the size,
 * content type, custom metadata and digest all match; the archive path
 * re-verifies the same fields per entry while streaming. Every one of those
 * checks reads metadata from the store and trusts it.
 *
 * So a naive `writeFile(data)` then `writeFile(sidecar)` is not merely untidy —
 * it can pair one write's bytes with another write's metadata, and a same-length
 * corruption then passes every check above and serves the wrong bytes.
 *
 * The layout is:
 *
 *   <keyHash>-<writeId>.bin   the bytes, named for the write that produced them
 *   <keyHash>.json            the sidecar, naming the write it published
 *
 * Both are written under a temporary name and `rename`d into place, which is
 * atomic on POSIX within a filesystem, and each is flushed — the file, then the
 * directory entry the rename created — before the next is issued, so the sidecar
 * is published only once its data file is durable rather than merely visible.
 * Without that flush the ordering holds for a killed process but not for a lost
 * host: a filesystem is free to replay the sidecar's rename without the data
 * file's, which produces the very state this layout exists to prevent.
 *
 * An interrupted write therefore leaves either the previous consistent state or
 * the new one, never a mixture; concurrent writers race on the sidecar rename,
 * and whichever wins names its own bytes.
 *
 * ## Why the data file is named for the write and not for its content
 *
 * Naming it `<keyHash>-<contentDigest>.bin` reads better and is wrong here.
 * Overwriting a key has to reclaim the copy it superseded, and under content
 * addressing two writers storing identical bytes share one file — so one
 * writer's reclamation deletes the bytes the other has just published, leaving a
 * sidecar whose data file is gone. That is not a narrow window: seeding a key and
 * then racing two writes, one of which restores the seeded content, produced
 * exactly that state in 37 of 40 rounds.
 *
 * A write id makes every data file the property of a single write, written once
 * and never overwritten. Reclamation is then safe by construction: the sidecar a
 * writer superseded was published strictly before its own, and every publication
 * names a fresh write id, so no sidecar published afterwards can name the file
 * being removed.
 *
 * The tradeoff is orphans rather than corruption. A write interrupted before it
 * publishes, or one whose sidecar a concurrent `delete` removes, leaves a `.bin`
 * no sidecar names. Those bytes are unreachable and inert — reclaiming them means
 * deleting data files no sidecar refers to, which a host can do out of band.
 *
 * Three further properties are security decisions, not conveniences:
 *
 * - **Keys are hashed, not joined.** Object keys are application-generated but
 *   still untrusted as far as the filesystem is concerned; joining one onto a
 *   base directory invites `../` escapes. Hashing gives a flat, fixed-shape name
 *   with no traversal surface, and the original key is kept in the sidecar.
 * - **The sidecar's write id is validated before it becomes a path.** It is read
 *   back off disk and interpolated into a filename, so it is checked against the
 *   shape this module writes rather than trusted, for the same reason keys are
 *   never joined.
 * - **The directory must sit outside anything served statically.** R2 objects
 *   are unreachable by URL by construction; a directory is only unreachable if
 *   you put it somewhere the static handler cannot see. That is a deployment
 *   obligation this module cannot enforce, so it is stated here.
 */
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
  PrivateFileMetadata,
  PrivateFileObject,
  PrivateFilePutOptions,
  PrivateFileStore,
} from "./private-file-store";

interface StoredSidecar {
  key: string;
  /** Identifies the write whose data file this sidecar names. */
  object: string;
  size: number;
  sha256: string;
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
}

/** The shape `crypto.randomUUID()` produces, and the only shape accepted back. */
const WRITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

/** Normalise the caller's expected digest. A string is lowercase hex, as R2 accepts. */
function expectedDigestHex(sha256: PrivateFilePutOptions["sha256"]): string | null {
  if (sha256 === undefined) return null;
  return typeof sha256 === "string" ? sha256.toLowerCase() : toHex(sha256);
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

/**
 * Codes meaning the platform or filesystem refuses to flush a directory at all,
 * as opposed to trying and failing. Windows has no directory handle to sync, and
 * some filesystems reject the operation outright.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);

/** Metadata read back off disk must hold the types the port promises, not merely exist. */
function isHttpMetadata(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { contentType, contentDisposition } = value as Record<string, unknown>;
  return (contentType === undefined || typeof contentType === "string")
    && (contentDisposition === undefined || typeof contentDisposition === "string");
}

function isCustomMetadata(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/**
 * Reject a sidecar that is not the shape we wrote, so stale or corrupt JSON fails
 * closed.
 *
 * Every field is checked, not only the ones that would crash. `object` becomes a
 * path component; `size` and the metadata are handed to callers that compare them
 * against what they wrote, so a value of the wrong type turns a verification into
 * an accident of coercion. Downstream code does re-check most of this — that is
 * an argument for validating here, not against it, since a validator that only
 * half-validates is the weaker claim.
 */
function isSidecar(value: unknown): value is StoredSidecar {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const size = record.size;
  return typeof record.key === "string"
    && typeof record.object === "string"
    && WRITE_ID.test(record.object)
    && typeof size === "number"
    && Number.isSafeInteger(size)
    && size >= 0
    && typeof record.sha256 === "string"
    && /^[0-9a-f]{64}$/.test(record.sha256)
    && isHttpMetadata(record.httpMetadata)
    && isCustomMetadata(record.customMetadata);
}

function metadataFrom(sidecar: StoredSidecar): PrivateFileMetadata {
  return {
    size: sidecar.size,
    httpMetadata: sidecar.httpMetadata,
    customMetadata: sidecar.customMetadata,
    checksums: { sha256: fromHex(sidecar.sha256) },
  };
}

export function createFilesystemPrivateFileStore(directory: string): PrivateFileStore {
  const keyHash = (key: string) => digestHex(new TextEncoder().encode(key));
  const sidecarPath = async (key: string) => join(directory, `${await keyHash(key)}.json`);
  const dataPath = async (key: string, writeId: string) =>
    join(directory, `${await keyHash(key)}-${writeId}.bin`);

  /**
   * Flush the directory itself, making the entries renames and unlinks created
   * durable rather than merely visible.
   *
   * Tolerating "this platform will not do that" is deliberate; tolerating "the
   * flush failed" would not be. A bare catch here reports a successful write
   * after the flush that was supposed to make it durable did not happen, which
   * is worse than not flushing at all — the guarantee would be stated and empty.
   * So only the unsupported-operation codes pass, and I/O errors propagate.
   */
  const syncDirectory = async () => {
    let handle;
    try {
      handle = await open(directory, "r");
      await handle.sync();
    } catch (error) {
      // ENOENT means nothing has been written here yet, so there is nothing to
      // make durable and `delete` on a fresh store must still succeed. The rest
      // are platforms that refuse the operation outright.
      const code = errorCode(error);
      if (code !== "ENOENT" && !DIRECTORY_SYNC_UNSUPPORTED.has(code)) throw error;
    } finally {
      // A close failure on a handle opened for reading says nothing about
      // durability, and throwing here would mask the error being propagated.
      await handle?.close().catch(() => {});
    }
  };

  /**
   * Write to a temporary name and rename into place, so a reader never sees a
   * partial file.
   *
   * The file and then the directory are flushed because `rename` buys atomic
   * *visibility*, not durable *ordering*: after a host crash a filesystem is free
   * to replay the sidecar's rename without the data file's, which is the torn
   * state this layout exists to prevent, reached by a different route. Flushing
   * each write before the next is issued makes the order the code writes in the
   * order a recovering host sees.
   */
  const writeAtomic = async (target: string, contents: Uint8Array | string) => {
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory();
  };

  const readSidecar = async (key: string): Promise<StoredSidecar | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(await sidecarPath(key), "utf8"));
      // The stored key is verified, not merely kept. The filename is a digest of
      // the key, so a sidecar naming a different one has been copied or edited
      // into place, and answering this key's read with it would serve another
      // key's object — the one failure hashing the filename cannot rule out.
      return isSidecar(parsed) && parsed.key === key ? parsed : null;
    } catch {
      return null;
    }
  };

  return {
    async put(key, value, options) {
      const bytes = toBytes(value);
      const contentDigest = await digestHex(bytes);
      const expected = expectedDigestHex(options?.sha256);
      if (expected !== null && expected !== contentDigest) {
        // Rejected before anything is written, so a failed integrity check leaves
        // no trace at all — the upload path's rollback has nothing to undo.
        throw new Error("put failed: the supplied sha256 does not match the content");
      }

      await mkdir(directory, { recursive: true });
      const previous = await readSidecar(key);

      // Data first, sidecar second: until a sidecar names this write, its data
      // file is invisible, so an interrupted write keeps the previous state.
      const writeId = crypto.randomUUID();
      await writeAtomic(await dataPath(key, writeId), bytes);
      const sidecar: StoredSidecar = {
        key,
        object: writeId,
        size: bytes.byteLength,
        sha256: contentDigest,
        ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
        ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
      };
      await writeAtomic(await sidecarPath(key), JSON.stringify(sidecar));

      // Best-effort reclamation of the copy this write superseded. Safe because
      // `previous` was published before this sidecar and every write id is fresh,
      // so no sidecar published later can name that file. Failing must not fail
      // the write — an unreclaimed data file is unreachable, not corrupt.
      if (previous) {
        await rm(await dataPath(key, previous.object), { force: true }).catch(() => {});
      }
      return metadataFrom(sidecar);
    },

    async head(key) {
      const sidecar = await readSidecar(key);
      return sidecar ? metadataFrom(sidecar) : null;
    },

    async get(key): Promise<PrivateFileObject | null> {
      const sidecar = await readSidecar(key);
      if (!sidecar) return null;

      const path = await dataPath(key, sidecar.object);
      let stream: ReadableStream<Uint8Array>;
      try {
        // Opened before returning so a missing data file reads as null rather
        // than throwing mid-stream, halfway through an archive.
        const handle = createReadStream(path);
        await new Promise<void>((resolve, reject) => {
          handle.once("readable", resolve);
          handle.once("end", resolve);
          handle.once("error", reject);
        });
        // `Readable.toWeb` is typed ReadableStream<any>, so this cast names the
        // chunk type rather than widening. Sound because a byte-mode fs stream
        // yields Buffers, and the conformance suite asserts it at runtime.
        stream = Readable.toWeb(handle) as ReadableStream<Uint8Array>;
      } catch {
        return null;
      }

      return { ...metadataFrom(sidecar), body: stream };
    },

    async delete(key) {
      const sidecar = await readSidecar(key);
      // Sidecar first: once it is gone the key reads as absent, so the data file
      // becoming unreachable can never be observed as a torn object. Removing
      // that file cannot strip a concurrent write either, since that write owns
      // a different one.
      await rm(await sidecarPath(key), { force: true });
      // Flushed before the bytes go, for the same reason a write flushes between
      // its two renames: an unlink that survives a crash while the sidecar
      // removal does not leaves a sidecar naming bytes that are gone.
      await syncDirectory();
      if (sidecar) await rm(await dataPath(key, sidecar.object), { force: true });
    },
  };
}
