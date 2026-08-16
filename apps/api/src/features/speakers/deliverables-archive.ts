import { safeAttachmentFilename } from "../../private-file-storage";
import type { PrivateFileStore } from "../../runtime/private-file-store";
import type { PrivateFileMetadata } from "../../runtime/private-file-store";

const ZIP32_MAX = 0xffff_ffff;
export const ARCHIVE_MAX_ENTRIES = 20;
export const ARCHIVE_MAX_CONTENT_BYTES = 25 * 1024 * 1024;
const ZIP_VERSION = 20;
const ZIP_FLAGS = 0x0808; // UTF-8 names and a trailing data descriptor.
const ZIP_STORE = 0;
const encoder = new TextEncoder();

export interface DeliverableArchiveSource {
  eventId: string;
  sessionSlug: string;
  sessionTitle: string;
  requestKey: string;
  requestLabel: string;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  uploadedAt: string;
}

export interface PlannedDeliverableArchiveEntry extends DeliverableArchiveSource {
  archivePath: string;
  archivePathBytes: Uint8Array;
  localHeaderOffset: number;
  dosDate: number;
  dosTime: number;
}

export interface DeliverablesArchivePlan {
  entries: PlannedDeliverableArchiveEntry[];
  byteSize: number;
  centralOffset: number;
}

export class DeliverablesArchiveLimitError extends Error {}
export class DeliverablesArchiveIntegrityError extends Error {}

function littleEndian(values: readonly [number, number][]) {
  const size = values.reduce((total, [, bytes]) => total + bytes, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const [value, bytes] of values) {
    if (bytes === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    offset += bytes;
  }
  return output;
}

function utf8Prefix(value: string, maxBytes: number) {
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character).byteLength > maxBytes) break;
    output += character;
  }
  return output;
}

export function safeArchiveSegment(value: string, fallback: string) {
  const normalized = value.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, ".")
    .trim()
    .replace(/^[. -]+|[. ]+$/g, "");
  const safe = normalized && normalized !== "." && normalized !== ".." ? normalized : fallback;
  return utf8Prefix(safe, 160) || fallback;
}

function archiveFilename(filename: string) {
  return safeArchiveSegment(safeAttachmentFilename(filename), "deliverable");
}

function plannedArchivePath(source: DeliverableArchiveSource, index: number) {
  const folder = safeArchiveSegment(source.sessionTitle || source.sessionSlug, "session");
  const label = safeArchiveSegment(source.requestLabel || source.requestKey, "deliverable");
  const filename = archiveFilename(source.originalFilename);
  const ordinal = String(index + 1).padStart(2, "0");
  return `${folder}/${ordinal} - ${label} - ${filename}`;
}

function dosTimestamp(value: string) {
  const date = new Date(value);
  const year = Number.isFinite(date.getTime()) ? Math.min(2107, Math.max(1980, date.getUTCFullYear())) : 1980;
  const month = Number.isFinite(date.getTime()) ? date.getUTCMonth() + 1 : 1;
  const day = Number.isFinite(date.getTime()) ? date.getUTCDate() : 1;
  const hours = Number.isFinite(date.getTime()) ? date.getUTCHours() : 0;
  const minutes = Number.isFinite(date.getTime()) ? date.getUTCMinutes() : 0;
  const seconds = Number.isFinite(date.getTime()) ? date.getUTCSeconds() : 0;
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
  };
}

export function planDeliverablesArchive(sources: readonly DeliverableArchiveSource[]): DeliverablesArchivePlan {
  if (sources.length > ARCHIVE_MAX_ENTRIES) {
    throw new DeliverablesArchiveLimitError("The archive exceeds the Worker entry limit.");
  }
  const entries: PlannedDeliverableArchiveEntry[] = [];
  let offset = 0;
  let centralSize = 0;
  let contentBytes = 0;
  for (const [index, source] of sources.entries()) {
    if (!Number.isSafeInteger(source.byteSize) || source.byteSize < 0 || source.byteSize > ZIP32_MAX) {
      throw new DeliverablesArchiveLimitError("A deliverable exceeds the ZIP32 file-size limit.");
    }
    contentBytes += source.byteSize;
    if (!Number.isSafeInteger(contentBytes) || contentBytes > ARCHIVE_MAX_CONTENT_BYTES) {
      throw new DeliverablesArchiveLimitError("The archive exceeds the Worker content-size limit.");
    }
    const archivePath = plannedArchivePath(source, index);
    const archivePathBytes = encoder.encode(archivePath);
    if (archivePathBytes.byteLength > 0xffff) {
      throw new DeliverablesArchiveLimitError("A deliverable archive path exceeds the ZIP32 name limit.");
    }
    const localSize = 30 + archivePathBytes.byteLength + source.byteSize + 16;
    const nextOffset = offset + localSize;
    const nextCentralSize = centralSize + 46 + archivePathBytes.byteLength;
    if (offset > ZIP32_MAX || nextOffset > ZIP32_MAX || nextCentralSize > ZIP32_MAX) {
      throw new DeliverablesArchiveLimitError("The archive exceeds the ZIP32 size limit.");
    }
    entries.push({
      ...source,
      ...dosTimestamp(source.uploadedAt),
      archivePath,
      archivePathBytes,
      localHeaderOffset: offset,
    });
    offset = nextOffset;
    centralSize = nextCentralSize;
  }
  const byteSize = offset + centralSize + 22;
  if (byteSize > ZIP32_MAX) {
    throw new DeliverablesArchiveLimitError("The archive exceeds the ZIP32 size limit.");
  }
  return { entries, byteSize, centralOffset: offset };
}

function digestHex(value: ArrayBuffer | ArrayBufferView) {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectMatches(
  object: PrivateFileMetadata,
  entry: DeliverableArchiveSource,
) {
  return object.size === entry.byteSize
    && object.httpMetadata?.contentType === entry.contentType
    && object.customMetadata?.eventScope === entry.eventId
    && object.customMetadata?.originalFilename === entry.originalFilename
    && object.customMetadata?.sha256 === entry.sha256
    && !!object.checksums?.sha256
    && digestHex(object.checksums.sha256) === entry.sha256;
}

export async function verifyDeliverablesArchiveObjects(
  store: PrivateFileStore,
  plan: DeliverablesArchivePlan,
) {
  for (const entry of plan.entries) {
    const object = await store.head(entry.objectKey);
    if (!object || !objectMatches(object, entry)) {
      throw new DeliverablesArchiveIntegrityError("Private object metadata does not match its database record.");
    }
  }
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function updateCrc32(crc: number, bytes: Uint8Array) {
  let value = crc;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

function localHeader(entry: PlannedDeliverableArchiveEntry) {
  return littleEndian([
    [0x0403_4b50, 4], [ZIP_VERSION, 2], [ZIP_FLAGS, 2], [ZIP_STORE, 2],
    [entry.dosTime, 2], [entry.dosDate, 2], [0, 4], [0, 4], [0, 4],
    [entry.archivePathBytes.byteLength, 2], [0, 2],
  ]);
}

function dataDescriptor(crc: number, size: number) {
  return littleEndian([[0x0807_4b50, 4], [crc, 4], [size, 4], [size, 4]]);
}

function centralHeader(entry: PlannedDeliverableArchiveEntry, crc: number) {
  return littleEndian([
    [0x0201_4b50, 4], [ZIP_VERSION, 2], [ZIP_VERSION, 2], [ZIP_FLAGS, 2], [ZIP_STORE, 2],
    [entry.dosTime, 2], [entry.dosDate, 2], [crc, 4], [entry.byteSize, 4], [entry.byteSize, 4],
    [entry.archivePathBytes.byteLength, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 4],
    [entry.localHeaderOffset, 4],
  ]);
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number) {
  return littleEndian([
    [0x0605_4b50, 4], [0, 2], [0, 2], [entryCount, 2], [entryCount, 2],
    [centralSize, 4], [centralOffset, 4], [0, 2],
  ]);
}

async function* zipChunks(store: PrivateFileStore, plan: DeliverablesArchivePlan) {
  const records: Array<{ entry: PlannedDeliverableArchiveEntry; crc: number }> = [];
  for (const entry of plan.entries) {
    yield localHeader(entry);
    yield entry.archivePathBytes;
    const object = await store.get(entry.objectKey);
    if (!object || !objectMatches(object, entry)) {
      throw new DeliverablesArchiveIntegrityError("Private object metadata changed while building the archive.");
    }
    const reader = object.body.getReader();
    let crc = 0xffff_ffff;
    let streamed = 0;
    let complete = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        streamed += value.byteLength;
        if (streamed > entry.byteSize) {
          throw new DeliverablesArchiveIntegrityError("Private object length exceeds its database record.");
        }
        crc = updateCrc32(crc, value);
        yield value;
      }
    } finally {
      if (!complete) await reader.cancel();
      reader.releaseLock();
    }
    if (streamed !== entry.byteSize) {
      throw new DeliverablesArchiveIntegrityError("Private object length does not match its database record.");
    }
    crc = (crc ^ 0xffff_ffff) >>> 0;
    yield dataDescriptor(crc, streamed);
    records.push({ entry, crc });
  }
  let centralSize = 0;
  for (const record of records) {
    const header = centralHeader(record.entry, record.crc);
    centralSize += header.byteLength + record.entry.archivePathBytes.byteLength;
    yield header;
    yield record.entry.archivePathBytes;
  }
  yield endOfCentralDirectory(records.length, centralSize, plan.centralOffset);
}

export function streamDeliverablesArchive(store: PrivateFileStore, plan: DeliverablesArchivePlan) {
  const iterator = zipChunks(store, plan)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
