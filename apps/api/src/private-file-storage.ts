import type { PrivateFileStore } from "./runtime/private-file-store";
export const DEFAULT_MAX_PRIVATE_UPLOAD_BYTES = 10 * 1024 * 1024;

const MAGIC_BYTES: Record<string, (bytes: Uint8Array) => boolean> = {
  "application/pdf": (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  "application/vnd.ms-powerpoint": (bytes) =>
    startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": isPptx,
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/png": (bytes) =>
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (bytes) =>
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]),
};

export type PrivateUploadBody = ArrayBuffer | ArrayBufferView;

export interface ValidatedPrivateUpload {
  bytes: Uint8Array;
  contentType: string;
  size: number;
}

export interface StoredPrivateFile {
  key: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface StorePrivateFileOptions {
  bucket: PrivateFileStore;
  eventScope: string;
  pathSegments?: readonly string[];
  filename: string;
  contentType: string;
  body: PrivateUploadBody;
  allowedContentTypes: ReadonlySet<string> | readonly string[];
  maxBytes?: number;
  customMetadata?: Record<string, string>;
  finalize: (file: StoredPrivateFile) => Promise<void>;
  isReferenced?: (file: StoredPrivateFile) => Promise<boolean>;
}

export class PrivateFileValidationError extends Error {
  constructor(
    public readonly code:
      | "INVALID_MAX_BYTES"
      | "FILE_TOO_LARGE"
      | "MIME_NOT_ALLOWED"
      | "MIME_NOT_SUPPORTED"
      | "MAGIC_BYTES_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "PrivateFileValidationError";
  }
}

export class PrivateFilePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateFilePersistenceError";
  }
}

function startsWith(bytes: Uint8Array, expected: readonly number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function isZip(bytes: Uint8Array) {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
}

function uint16(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 2 > bytes.byteLength) return null;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function isPptx(bytes: Uint8Array) {
  if (!isZip(bytes) || bytes.byteLength < 22) return false;

  const earliestEocd = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= earliestEocd; offset -= 1) {
    if (uint32(bytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) return false;

  const entryCount = uint16(bytes, eocd + 10);
  const centralSize = uint32(bytes, eocd + 12);
  const centralOffset = uint32(bytes, eocd + 16);
  if (
    entryCount === null || centralSize === null || centralOffset === null ||
    entryCount === 0 || entryCount === 0xffff || centralOffset + centralSize > eocd
  ) return false;

  const names = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let cursor = centralOffset;
  try {
    for (let index = 0; index < entryCount; index += 1) {
      if (uint32(bytes, cursor) !== 0x02014b50) return false;
      const nameLength = uint16(bytes, cursor + 28);
      const extraLength = uint16(bytes, cursor + 30);
      const commentLength = uint16(bytes, cursor + 32);
      if (nameLength === null || extraLength === null || commentLength === null || nameLength === 0) return false;
      const nameStart = cursor + 46;
      const next = nameStart + nameLength + extraLength + commentLength;
      if (next > eocd) return false;
      names.add(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
      cursor = next;
    }
  } catch {
    return false;
  }

  return cursor === centralOffset + centralSize &&
    names.has("[Content_Types].xml") &&
    names.has("_rels/.rels") &&
    names.has("ppt/presentation.xml");
}

function uploadBytes(body: PrivateUploadBody): Uint8Array<ArrayBuffer> {
  const view = ArrayBuffer.isView(body)
    ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : new Uint8Array(body);
  // Narrowed rather than copied. `ArrayBufferLike` admits `SharedArrayBuffer`,
  // which is not a valid digest input, but these bytes are always a request body
  // and never shared memory. The parameter only became visible when this started
  // compiling against Node's lib as well as the Workers one; copying to satisfy
  // it would duplicate every upload for a case that cannot arise.
  return view as Uint8Array<ArrayBuffer>;
}

function normalizedMime(value: string) {
  return value.trim().toLowerCase();
}

export function validatePrivateUpload(
  body: PrivateUploadBody,
  contentType: string,
  allowedContentTypes: ReadonlySet<string> | readonly string[],
  maxBytes = DEFAULT_MAX_PRIVATE_UPLOAD_BYTES,
): ValidatedPrivateUpload {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_PRIVATE_UPLOAD_BYTES) {
    throw new PrivateFileValidationError(
      "INVALID_MAX_BYTES",
      "The upload limit must be positive and no more than 10 MiB.",
    );
  }

  const bytes = uploadBytes(body);
  if (bytes.byteLength > maxBytes) {
    throw new PrivateFileValidationError("FILE_TOO_LARGE", "The file exceeds the upload limit.");
  }

  const normalizedContentType = normalizedMime(contentType);
  const allowed = new Set(Array.from(allowedContentTypes, normalizedMime));
  if (!allowed.has(normalizedContentType)) {
    throw new PrivateFileValidationError("MIME_NOT_ALLOWED", "The file type is not allowed.");
  }

  const matchesMagicBytes = MAGIC_BYTES[normalizedContentType];
  if (!matchesMagicBytes) {
    throw new PrivateFileValidationError(
      "MIME_NOT_SUPPORTED",
      "The file type does not have a supported signature.",
    );
  }
  if (!matchesMagicBytes(bytes)) {
    throw new PrivateFileValidationError(
      "MAGIC_BYTES_MISMATCH",
      "The file contents do not match the declared type.",
    );
  }

  return { bytes, contentType: normalizedContentType, size: bytes.byteLength };
}

export async function sha256Hex(body: PrivateUploadBody) {
  return (await sha256Digest(body)).hex;
}

function hex(bytes: ArrayBuffer | ArrayBufferView) {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Digest(body: PrivateUploadBody) {
  const digest = await crypto.subtle.digest("SHA-256", uploadBytes(body));
  return { digest, hex: hex(digest) };
}

export function createPrivateObjectKey(eventScope: string, pathSegments: readonly string[] = []) {
  const scope = eventScope.trim();
  if (!scope) throw new Error("An event scope is required.");
  const path = pathSegments.map((segment) => {
    const value = segment.trim();
    if (!value) throw new Error("Private object path segments cannot be empty.");
    return encodeURIComponent(value);
  });
  return ["events", encodeURIComponent(scope), ...path, crypto.randomUUID()].join("/");
}

export function safeAttachmentFilename(filename: string) {
  const leaf = filename.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const value = !leaf || leaf === "." || leaf === ".." ? "download" : Array.from(leaf).slice(0, 180).join("");
  return value;
}

export function attachmentContentDisposition(filename: string) {
  const safe = safeAttachmentFilename(filename);
  const fallback = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function storePrivateFile(options: StorePrivateFileOptions): Promise<StoredPrivateFile> {
  const upload = validatePrivateUpload(
    options.body,
    options.contentType,
    options.allowedContentTypes,
    options.maxBytes,
  );
  const filename = safeAttachmentFilename(options.filename);
  const checksum = await sha256Digest(upload.bytes);
  const sha256 = checksum.hex;
  const key = createPrivateObjectKey(options.eventScope, options.pathSegments);
  const customMetadata = {
    ...options.customMetadata,
    eventScope: options.eventScope,
    originalFilename: filename,
    sha256,
  };
  const stored: StoredPrivateFile = {
    key,
    filename,
    contentType: upload.contentType,
    size: upload.size,
    sha256,
  };

  let wroteObject = false;
  let finalizeStarted = false;
  try {
    await options.bucket.put(key, upload.bytes, {
      httpMetadata: {
        contentType: upload.contentType,
        contentDisposition: attachmentContentDisposition(filename),
      },
      customMetadata,
      sha256: checksum.digest,
    });
    wroteObject = true;

    const persisted = await options.bucket.head(key);
    if (
      !persisted ||
      persisted.size !== upload.size ||
      persisted.httpMetadata?.contentType !== upload.contentType ||
      persisted.customMetadata?.eventScope !== options.eventScope ||
      persisted.customMetadata?.originalFilename !== filename ||
      persisted.customMetadata?.sha256 !== sha256 ||
      !persisted.checksums?.sha256 ||
      hex(persisted.checksums.sha256) !== sha256
    ) {
      throw new PrivateFilePersistenceError("The stored file did not pass persistence verification.");
    }

    finalizeStarted = true;
    await options.finalize(stored);
    return stored;
  } catch (error) {
    if (!wroteObject) throw error;
    if (finalizeStarted && options.isReferenced) {
      let referenced: boolean;
      try {
        referenced = await options.isReferenced(stored);
      } catch {
        // If reference verification itself fails, retain the object. An orphan
        // is recoverable; deleting a file that D1 may reference is not.
        throw error;
      }
      if (referenced) throw error;
    }
    try {
      await options.bucket.delete(key);
    } catch (deleteError) {
      throw new AggregateError([error, deleteError], "The private file operation and cleanup both failed.");
    }
    throw error;
  }
}
