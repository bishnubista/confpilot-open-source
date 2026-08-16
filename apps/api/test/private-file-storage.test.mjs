import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  attachmentContentDisposition,
  PrivateFileValidationError,
  sha256Hex,
  storePrivateFile,
  validatePrivateUpload,
} from "../src/private-file-storage.ts";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function pptxArchive(names = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"]) {
  const bytes = [];
  const entries = [];
  const push16 = (value) => bytes.push(value & 0xff, (value >>> 8) & 0xff);
  const push32 = (value) => bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  for (const name of names) {
    const encoded = new TextEncoder().encode(name);
    const offset = bytes.length;
    push32(0x04034b50); push16(20); push16(0); push16(0); push16(0); push16(0);
    push32(0); push32(0); push32(0); push16(encoded.length); push16(0);
    bytes.push(...encoded);
    entries.push({ encoded, offset });
  }
  const centralOffset = bytes.length;
  for (const { encoded, offset } of entries) {
    push32(0x02014b50); push16(20); push16(20); push16(0); push16(0); push16(0); push16(0);
    push32(0); push32(0); push32(0); push16(encoded.length); push16(0); push16(0);
    push16(0); push16(0); push32(0); push32(offset); bytes.push(...encoded);
  }
  const centralSize = bytes.length - centralOffset;
  push32(0x06054b50); push16(0); push16(0); push16(entries.length); push16(entries.length);
  push32(centralSize); push32(centralOffset); push16(0);
  return new Uint8Array(bytes);
}

class FakeR2Bucket {
  objects = new Map();
  deleted = [];
  failPut = false;
  headCustomMetadata = null;

  async put(key, value, options) {
    if (this.failPut) throw new Error("R2 put failed");
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    const object = { bytes, ...structuredClone(options) };
    this.objects.set(key, object);
    // Reports what landed, as the port requires. Built from the stored object
    // rather than delegating to head(), because headCustomMetadata exists to
    // simulate a store whose read-back disagrees with the write — a double that
    // drifted on both sides would hide the mismatch it is here to produce.
    return {
      key,
      size: bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      checksums: { sha256: object.sha256 },
    };
  }

  async head(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: this.headCustomMetadata ?? object.customMetadata,
      checksums: { sha256: object.sha256 },
    };
  }

  async delete(key) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function storeOptions(bucket, overrides = {}) {
  return {
    bucket,
    eventScope: "evt-devflow",
    filename: "speaker deck.pdf",
    contentType: "application/pdf",
    body: PDF,
    allowedContentTypes: new Set(["application/pdf"]),
    customMetadata: { purpose: "speaker-material" },
    finalize: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("private file storage", () => {
  it("rejects disallowed MIME types, bad signatures, and oversized files before writing", () => {
    expect(() => validatePrivateUpload(PDF, "application/pdf", ["image/png"])).toThrowError(
      expect.objectContaining({ code: "MIME_NOT_ALLOWED" }),
    );
    expect(() =>
      validatePrivateUpload(new Uint8Array([0x00, 0x01]), "application/pdf", ["application/pdf"]),
    ).toThrowError(expect.objectContaining({ code: "MAGIC_BYTES_MISMATCH" }));
    expect(() => validatePrivateUpload(PDF, "application/pdf", ["application/pdf"], 4)).toThrowError(
      expect.objectContaining({ code: "FILE_TOO_LARGE" }),
    );
    expect(() => validatePrivateUpload(PDF, "text/plain", ["text/plain"])).toThrowError(
      expect.objectContaining({ code: "MIME_NOT_SUPPORTED" }),
    );
    expect(() => validatePrivateUpload(
      PDF,
      "application/pdf",
      ["application/pdf"],
      10 * 1024 * 1024 + 1,
    )).toThrowError(expect.objectContaining({ code: "INVALID_MAX_BYTES" }));
    expect(() =>
      validatePrivateUpload(
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        "application/zip",
        ["application/zip"],
      ),
    ).toThrowError(expect.objectContaining({ code: "MIME_NOT_SUPPORTED" }));
    expect(() => validatePrivateUpload(
      pptxArchive(["not-a-presentation.txt"]),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    )).toThrowError(expect.objectContaining({ code: "MAGIC_BYTES_MISMATCH" }));
  });

  it.each([
    ["application/pdf", PDF],
    [
      "application/vnd.ms-powerpoint",
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      pptxArchive(),
    ],
    ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
    ["image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    [
      "image/webp",
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    ],
  ])("accepts the supported %s signature", (contentType, bytes) => {
    expect(validatePrivateUpload(bytes, contentType, [contentType])).toMatchObject({
      contentType,
      size: bytes.byteLength,
    });
  });

  it("does not invoke the metadata callback when R2 write fails", async () => {
    const bucket = new FakeR2Bucket();
    bucket.failPut = true;
    const options = storeOptions(bucket);

    await expect(storePrivateFile(options)).rejects.toThrow("R2 put failed");

    expect(options.finalize).not.toHaveBeenCalled();
    expect(bucket.objects.size).toBe(0);
    expect(bucket.deleted).toEqual([]);
  });

  it("deletes only the exact new key when metadata finalization fails", async () => {
    const bucket = new FakeR2Bucket();
    bucket.objects.set("events/evt-devflow/prior", {
      bytes: PDF,
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { sha256: "prior" },
    });
    const finalize = vi.fn(async () => {
      throw new Error("database write failed");
    });
    const isReferenced = vi.fn(async () => false);

    await expect(storePrivateFile(storeOptions(bucket, { finalize, isReferenced }))).rejects.toThrow(
      "database write failed",
    );

    expect(finalize).toHaveBeenCalledOnce();
    expect(isReferenced).toHaveBeenCalledOnce();
    expect(isReferenced.mock.calls[0][0].key).toMatch(/^events\/evt-devflow\/[0-9a-f-]+$/);
    expect(bucket.deleted).toEqual([isReferenced.mock.calls[0][0].key]);
    expect(bucket.objects.has("events/evt-devflow/prior")).toBe(true);
    expect(bucket.objects.size).toBe(1);
  });

  it("retains a finalized object when D1 references its exact key", async () => {
    const bucket = new FakeR2Bucket();
    const finalize = vi.fn(async () => {
      throw new Error("projection failed after commit");
    });
    const isReferenced = vi.fn(async () => true);

    await expect(storePrivateFile(storeOptions(bucket, { finalize, isReferenced }))).rejects.toThrow(
      "projection failed after commit",
    );

    expect(isReferenced).toHaveBeenCalledOnce();
    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.size).toBe(1);
  });

  it("fails closed and retains an object when exact-key reference verification fails", async () => {
    const bucket = new FakeR2Bucket();
    const finalize = vi.fn(async () => {
      throw new Error("database finalize failed");
    });
    const isReferenced = vi.fn(async () => {
      throw new Error("database reference check failed");
    });

    await expect(storePrivateFile(storeOptions(bucket, { finalize, isReferenced }))).rejects.toThrow(
      "database finalize failed",
    );

    expect(bucket.deleted).toEqual([]);
    expect(bucket.objects.size).toBe(1);
  });

  it("uses only an ArrayBuffer view's selected bytes for validation, hashing, and storage", async () => {
    const backing = new Uint8Array([0xaa, ...PDF, 0xbb]);
    const view = backing.subarray(1, backing.byteLength - 1);
    const validated = validatePrivateUpload(view, "application/pdf", ["application/pdf"]);
    const expectedSha = createHash("sha256").update(view).digest("hex");

    expect(validated.bytes.buffer).toBe(backing.buffer);
    expect(validated.bytes.byteOffset).toBe(view.byteOffset);
    await expect(sha256Hex(view)).resolves.toBe(expectedSha);

    const bucket = new FakeR2Bucket();
    const stored = await storePrivateFile(storeOptions(bucket, { body: view }));
    expect(bucket.objects.get(stored.key).bytes).toEqual(PDF);
    expect(stored.sha256).toBe(expectedSha);
  });

  it("persists and verifies HTTP metadata, custom metadata, and checksum before finalizing", async () => {
    const bucket = new FakeR2Bucket();
    const options = storeOptions(bucket, {
      filename: "slides\r\nX-Evil: yes.pdf",
      pathSegments: ["deliverables", "request/final"],
    });

    const result = await storePrivateFile(options);
    const object = bucket.objects.get(result.key);
    const expectedSha = createHash("sha256").update(PDF).digest("hex");

    expect(result).toEqual({
      key: expect.stringMatching(/^events\/evt-devflow\/deliverables\/request%2Ffinal\/[0-9a-f-]+$/),
      filename: "slidesX-Evil: yes.pdf",
      contentType: "application/pdf",
      size: PDF.byteLength,
      sha256: expectedSha,
    });
    expect(object.httpMetadata).toEqual({
      contentType: "application/pdf",
      contentDisposition:
        "attachment; filename=\"slidesX-Evil: yes.pdf\"; filename*=UTF-8''slidesX-Evil%3A%20yes.pdf",
    });
    expect(object.customMetadata).toEqual({
      purpose: "speaker-material",
      eventScope: "evt-devflow",
      originalFilename: "slidesX-Evil: yes.pdf",
      sha256: expectedSha,
    });
    expect(Buffer.from(object.sha256).toString("hex")).toBe(expectedSha);
    expect(options.finalize).toHaveBeenCalledWith(result);
    expect(bucket.deleted).toEqual([]);
    await expect(sha256Hex(PDF)).resolves.toBe(expectedSha);
  });

  it.each([
    ["event scope", { eventScope: "evt-fieldnotes", originalFilename: "speaker deck.pdf" }],
    ["original filename", { eventScope: "evt-devflow", originalFilename: "other.pdf" }],
  ])("deletes the exact upload when persisted %s metadata does not match", async (_label, metadata) => {
    const bucket = new FakeR2Bucket();
    bucket.headCustomMetadata = {
      ...metadata,
      sha256: await sha256Hex(PDF),
    };
    const options = storeOptions(bucket);

    await expect(storePrivateFile(options)).rejects.toThrow("persistence verification");
    expect(options.finalize).not.toHaveBeenCalled();
    expect(bucket.deleted).toHaveLength(1);
    expect(bucket.objects.size).toBe(0);
  });

  it("builds an attachment header without paths, quotes, or response splitting", () => {
    const header = attachmentContentDisposition('../bad\r\nname/quo"te ü.pdf');

    expect(header).toBe(
      "attachment; filename=\"quo_te _.pdf\"; filename*=UTF-8''quo%22te%20%C3%BC.pdf",
    );
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("exposes typed validation failures", () => {
    try {
      validatePrivateUpload(PDF, "image/png", ["application/pdf"]);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateFileValidationError);
    }
  });
});
