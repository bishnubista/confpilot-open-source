import { describe, expect, it } from "vitest";

import {
  ARCHIVE_MAX_CONTENT_BYTES,
  ARCHIVE_MAX_ENTRIES,
  DeliverablesArchiveLimitError,
  planDeliverablesArchive,
  safeArchiveSegment,
} from "../src/features/speakers/deliverables-archive.ts";

const source = (changes = {}) => ({
  eventId: "event-1",
  sessionSlug: "session-1",
  sessionTitle: "Session one",
  requestKey: "slides",
  requestLabel: "Final slides",
  objectKey: "events/event-1/deliverables/file-1",
  originalFilename: "slides.pdf",
  contentType: "application/pdf",
  byteSize: 12,
  sha256: "a".repeat(64),
  uploadedAt: "2027-04-20T17:00:00Z",
  ...changes,
});

describe("deliverables ZIP32 planning", () => {
  it("sanitizes path segments and separates same-named files by ordinal prefix", () => {
    expect(safeArchiveSegment(" ../Unsafe\\name\u0000 ", "fallback")).toBe("Unsafe-name");
    const plan = planDeliverablesArchive([
      source({ originalFilename: "../Slides.pdf" }),
      source({ objectKey: "events/event-1/deliverables/file-2", originalFilename: "slides.PDF" }),
    ]);
    expect(plan.entries.map(({ archivePath }) => archivePath)).toEqual([
      "Session one/01 - Final slides - Slides.pdf",
      "Session one/02 - Final slides - slides.PDF",
    ]);
  });

  it("enforces Worker resource limits before storage reads", () => {
    expect(() => planDeliverablesArchive([source({ byteSize: ARCHIVE_MAX_CONTENT_BYTES + 1 })]))
      .toThrow(DeliverablesArchiveLimitError);
    expect(() => planDeliverablesArchive(Array.from({ length: ARCHIVE_MAX_ENTRIES + 1 }, (_, index) =>
      source({ objectKey: `object-${index}`, originalFilename: `${index}.pdf`, byteSize: 0 }))))
      .toThrow(DeliverablesArchiveLimitError);
    expect(() => planDeliverablesArchive([
      source({ objectKey: "object-1", byteSize: ARCHIVE_MAX_CONTENT_BYTES }),
      source({ objectKey: "object-2", byteSize: 1 }),
    ])).toThrow(DeliverablesArchiveLimitError);
  });
});
