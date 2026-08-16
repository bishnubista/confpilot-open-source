import { describe, expect, it } from "vitest";

import {
  contentCommentCreateSchema,
  contentReviewCreateSchema,
  deliverableRequestCreateSchema,
  deliverableRequestUpdateSchema,
  deliverableUploadMetadataSchema,
  deliverableUploadResponseSchema,
  eventDeliverablesArchivePathSchema,
  organizerContentListResponseSchema,
  organizerDeliverableDownloadPathSchema,
  organizerSpeakerTaskUpdateSchema,
  sessionApprovalUpdateSchema,
  sessionContentUpdateSchema,
  speakerHeadshotResponseSchema,
  speakerOwnedProfileUpdateSchema,
  speakerProfileHistorySnapshotSchema,
  speakerProfileResponseSchema,
  speakerProfileUpdateSchema,
  speakerReminderEnqueueResponseSchema,
  speakerReminderEnqueueSchema,
  speakerReminderTemplateListResponseSchema,
  speakerRosterRowSchema,
  speakerTaskBulkCreateSchema,
  speakerTaskUpdateSchema,
  speakerVisibilityUpdateSchema,
  speakerWorkflowUpdateSchema,
} from "./index";

const timestamp = "2027-04-20T17:00:00Z";

describe("speaker and content contracts", () => {
  it("accepts only the authenticated event deliverables archive route", () => {
    expect(eventDeliverablesArchivePathSchema.safeParse(
      "/api/events/devflow-conf-2027/content/deliverables.zip",
    ).success).toBe(true);
    expect(eventDeliverablesArchivePathSchema.safeParse(
      "https://files.example.test/devflow.zip",
    ).success).toBe(false);
    expect(eventDeliverablesArchivePathSchema.safeParse(
      "/api/public/events/devflow-conf-2027/deliverables.zip",
    ).success).toBe(false);
  });

  it("keeps organizer library downloads on the authorized private-file route", () => {
    const organizerPath = "/api/events/devflow-conf-2027/content/deliverables/version-1/file";
    expect(organizerDeliverableDownloadPathSchema.safeParse(organizerPath).success).toBe(true);
    expect(organizerDeliverableDownloadPathSchema.safeParse(
      "/api/events/devflow-conf-2027/speaker/deliverables/version-1/file",
    ).success).toBe(false);
    expect(organizerDeliverableDownloadPathSchema.safeParse(
      "https://files.example.test/private/version-1.pdf",
    ).success).toBe(false);

    const version = {
      id: "version-1", requestId: "request-1", sessionId: "session-1",
      requestType: "presentation" as const, versionNumber: 1,
      originalFilename: "slides.pdf", contentType: "application/pdf" as const,
      byteSize: 1_200, sha256: "a".repeat(64), note: "First pass",
      uploader: { speakerId: "speaker-1", name: "Priya Raman" }, uploadedAt: timestamp,
      downloadPath: organizerPath, publicUrl: null,
    };
    const presenter = {
      id: "speaker-1", name: "Priya Raman", contactEmail: null, title: "", company: "",
      bio: "", socialUrls: { website: null, linkedin: null, x: null }, travelPreferences: "",
      workflowStatus: "confirmed" as const, profileStatus: "ready" as const,
      agreementStatus: "signed" as const, publicVisibility: "private" as const,
      headshot: null, revision: 1, updatedAt: timestamp,
    };
    const dossier = {
      id: "session-1", slug: "session-one", title: "Session one", abstract: "Abstract.",
      track: "Platform", format: "talk" as const, durationMinutes: 30,
      deliverablesStatus: "submitted" as const, approvalStatus: "pending" as const,
      revision: 1, presenters: [presenter], tasks: [], requests: [], versions: [version],
      comments: [], reviews: [], history: [], unmetApprovalGates: [],
    };
    expect(organizerContentListResponseSchema.safeParse({
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      approvedDeliverablesArchivePath: "/api/events/devflow-conf-2027/content/deliverables.zip",
      sessions: [{ ...dossier, versions: [{
        ...version,
        downloadPath: "/api/events/devflow-conf-2027/speaker/deliverables/version-1/file",
      }] }],
    }).success).toBe(false);
    expect(organizerContentListResponseSchema.safeParse({
      event: { slug: "devflow-conf-2027", name: "DevFlow Conf 2027" },
      approvedDeliverablesArchivePath: "/api/events/devflow-conf-2027/content/deliverables.zip",
      sessions: [dossier],
    }).success).toBe(true);
  });

  it("normalizes roster identity fields while retaining Unicode names", () => {
    expect(speakerRosterRowSchema.parse({
      name: "  Zoe\u0308 Rivera  ",
      email: " ZOE@EXAMPLE.TEST ",
      title: " Engineer ",
      company: " Example ",
      bio: " Biography ",
    })).toEqual({
      name: "Zoë Rivera",
      email: "zoe@example.test",
      title: "Engineer",
      company: "Example",
      bio: "Biography",
    });
    expect(speakerRosterRowSchema.safeParse({
      name: "李 明", email: "unicode-域@example.test", title: "", company: "", bio: "",
    }).success).toBe(false);
  });

  it("keeps speaker profile, visibility, and task revisions explicit", () => {
    expect(speakerProfileUpdateSchema.parse({
      name: " Priya Raman ",
      title: "Staff Engineer",
      company: "BuildRight",
      bio: "Builds dependable delivery systems.",
      contactEmail: "priya@example.com",
      socialUrls: { website: "https://example.com", linkedin: null, x: null },
      travelPreferences: "Vegetarian meals.",
      publicVisibility: "private",
      revision: 2,
    }).name).toBe("Priya Raman");
    expect(speakerProfileUpdateSchema.safeParse({
      name: "Priya Raman",
      title: "Staff Engineer",
      company: "BuildRight",
      bio: "Builds dependable delivery systems.",
      contactEmail: "priya@example.com",
      socialUrls: { website: null, linkedin: null, x: null },
      travelPreferences: "",
      publicVisibility: "published",
      revision: 0,
    }).success).toBe(false);
    expect(speakerOwnedProfileUpdateSchema.safeParse({
      name: "Priya Raman",
      title: "Staff Engineer",
      company: "BuildRight",
      bio: "Builds dependable delivery systems.",
      contactEmail: "priya@example.com",
      socialUrls: { website: null, linkedin: null, x: null },
      travelPreferences: "",
      revision: 3,
    }).success).toBe(true);
    expect(speakerOwnedProfileUpdateSchema.safeParse({
      name: "Priya Raman",
      title: "Staff Engineer",
      company: "BuildRight",
      bio: "Builds dependable delivery systems.",
      contactEmail: "priya@example.com",
      socialUrls: { website: null, linkedin: null, x: null },
      travelPreferences: "",
      publicVisibility: "published",
      revision: 3,
    }).success).toBe(false);
    expect(speakerVisibilityUpdateSchema.safeParse({ publicVisibility: "published", revision: 3 }).success)
      .toBe(true);
    expect(speakerTaskUpdateSchema.safeParse({ state: "complete", revision: 1 }).success).toBe(true);
    expect(speakerTaskUpdateSchema.safeParse({ state: "waived", revision: 1 }).success).toBe(false);
    expect(organizerSpeakerTaskUpdateSchema.safeParse({ state: "waived", revision: 1 }).success).toBe(true);
    expect(organizerSpeakerTaskUpdateSchema.safeParse({ state: "open", dueAt: "2027-04-01T17:00:00Z", revision: 1 }).success).toBe(true);
    expect(organizerSpeakerTaskUpdateSchema.safeParse({ state: "open", dueAt: null, revision: 1 }).success).toBe(true);
    expect(organizerSpeakerTaskUpdateSchema.safeParse({ state: "open", revision: 1 }).success).toBe(true);
    expect(organizerSpeakerTaskUpdateSchema.safeParse({ state: "complete", revision: 1 }).success).toBe(false);
    expect(speakerWorkflowUpdateSchema.safeParse({ status: "confirmed", revision: 3 }).success).toBe(true);
  });

  it("bounds deterministic speaker reminder templates and idempotency keys", () => {
    expect(speakerReminderTemplateListResponseSchema.parse({ templates: [{
      key: "speaker.readiness-reminder",
      revision: 1,
      label: "Readiness reminder",
      description: "Lists canonical outstanding readiness items.",
    }] }).templates).toHaveLength(1);
    expect(speakerReminderEnqueueSchema.parse({
      speakerId: "speaker-1",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "reminder_attempt_01",
    })).toEqual({
      speakerId: "speaker-1",
      templateKey: "speaker.task-reminder",
      idempotencyKey: "reminder_attempt_01",
    });
    expect(speakerReminderEnqueueSchema.safeParse({
      speakerId: "speaker-1",
      templateKey: "custom-prompt",
      idempotencyKey: "short",
    }).success).toBe(false);
    expect(speakerReminderEnqueueResponseSchema.safeParse({
      messageId: "message-1",
      speakerId: "speaker-1",
      templateKey: "speaker.readiness-reminder",
      templateRevision: 1,
      outboxState: "delivered",
    }).success).toBe(false);
  });

  it("keeps private headshot storage metadata out of the response", () => {
    const headshot = {
      originalFilename: "priya.webp",
      contentType: "image/webp" as const,
      byteSize: 42_000,
      sha256: "b".repeat(64),
      uploadedAt: timestamp,
      revision: 3,
      viewPath: "/api/events/devflow-conf-2027/speaker/headshot/file",
      publicUrl: "/api/public/events/devflow-conf-2027/speakers/priya-raman/headshot",
    };
    expect(speakerHeadshotResponseSchema.safeParse(headshot).success).toBe(true);
    expect(speakerHeadshotResponseSchema.safeParse({ ...headshot, objectKey: "events/private/key" }).success)
      .toBe(false);
    expect(speakerProfileUpdateSchema.safeParse({
      name: "Priya Raman", contactEmail: "priya@example.com", title: "", company: "", bio: "",
      socialUrls: { website: "javascript:alert(1)", linkedin: null, x: null },
      travelPreferences: "", publicVisibility: "private", revision: 1,
    }).success).toBe(false);
  });

  it("allows an unknown live contact email without retaining it in profile history", () => {
    const profile = {
      id: "speaker-priya",
      name: "Priya Raman",
      contactEmail: null,
      title: "Staff Engineer",
      company: "BuildRight",
      bio: "Builds dependable delivery systems.",
      socialUrls: { website: null, linkedin: null, x: null },
      travelPreferences: "",
      workflowStatus: "invited" as const,
      profileStatus: "incomplete" as const,
      agreementStatus: "missing" as const,
      publicVisibility: "private" as const,
      headshot: null,
      revision: 1,
      updatedAt: timestamp,
    };
    expect(speakerProfileResponseSchema.safeParse(profile).success).toBe(true);
    const { contactEmail: _contactEmail, ...historyProfile } = profile;
    expect(_contactEmail).toBeNull();
    expect(speakerProfileHistorySnapshotSchema.safeParse(historyProfile).success).toBe(true);
    expect(speakerProfileHistorySnapshotSchema.safeParse(profile).success).toBe(false);
  });

  it("keeps session deliverables presentation-only", () => {
    const base = {
      requestKey: "final-slides",
      label: "Final slides",
      instructions: "Upload the final presentation deck.",
      dueAt: "2027-05-01T23:59:00Z",
      maxBytes: 10 * 1024 * 1024,
      required: true,
    };
    expect(deliverableRequestCreateSchema.safeParse({
      ...base,
      requestType: "presentation",
      allowedContentTypes: ["application/pdf"],
    }).success).toBe(true);
    expect(deliverableRequestCreateSchema.safeParse({
      ...base,
      requestType: "presentation",
      allowedContentTypes: ["image/png"],
    }).success).toBe(false);
    expect(deliverableRequestCreateSchema.safeParse({
      ...base,
      requestType: "headshot",
      allowedContentTypes: ["image/jpeg"],
    }).success).toBe(false);
    expect(deliverableRequestUpdateSchema.safeParse({
      label: "Final slides",
      instructions: "Upload the final presentation deck.",
      dueAt: "2027-05-01T23:59:00Z",
      allowedContentTypes: ["application/pdf"],
      maxBytes: 10 * 1024 * 1024,
      required: true,
      active: true,
      revision: 2,
    }).success).toBe(true);
    expect(deliverableRequestUpdateSchema.safeParse({
      label: "Final headshot",
      instructions: "Upload a portrait.",
      dueAt: "2027-05-01T23:59:00Z",
      allowedContentTypes: ["image/webp"],
      maxBytes: 10 * 1024 * 1024,
      required: true,
      active: true,
      revision: 2,
    }).success).toBe(false);
  });

  it("targets content reviews at one immutable version and rejects synthetic identity", () => {
    expect(contentReviewCreateSchema.safeParse({
      versionId: "version-2",
      idempotencyKey: "review-version-2",
      outcome: "changes_requested",
      comment: "Please add sources to the benchmark slide.",
      expectedSessionRevision: 4,
    }).success).toBe(true);
    expect(contentReviewCreateSchema.safeParse({
      versionId: "version-2",
      idempotencyKey: "review-version-2",
      outcome: "approved",
      comment: "Ready.",
      expectedSessionRevision: 4,
      reviewedByUserId: "organizer-1",
    }).success).toBe(false);
    expect(contentCommentCreateSchema.parse({ versionId: "version-2", body: "  Slides v2 are ready for review.  " }))
      .toEqual({ versionId: "version-2", body: "Slides v2 are ready for review." });
  });

  it("returns immutable upload metadata without private object keys", () => {
    expect(deliverableUploadMetadataSchema.parse({
      idempotencyKey: "portal-upload-00000001",
      note: "  Second pass  ",
    })).toEqual({ idempotencyKey: "portal-upload-00000001", note: "Second pass" });
    const response = {
      version: {
        id: "version-2",
        requestId: "request-1",
        sessionId: "session-1",
        requestType: "presentation" as const,
        versionNumber: 2,
        originalFilename: "slides.pdf",
        contentType: "application/pdf" as const,
        byteSize: 1200,
        sha256: "a".repeat(64),
        note: "Second pass",
        uploader: { speakerId: "speaker-1", name: "Priya Raman" },
        uploadedAt: timestamp,
        downloadPath: "/api/events/devflow-conf-2027/speaker/deliverables/version-2/file",
        publicUrl: null,
      },
      session: {
        id: "session-1",
        deliverablesStatus: "submitted" as const,
        approvalStatus: "pending" as const,
        revision: 2,
      },
    };
    expect(deliverableUploadResponseSchema.safeParse(response).success).toBe(true);
    expect(deliverableUploadResponseSchema.safeParse({
      ...response,
      version: { ...response.version, objectKey: "events/private/key" },
    }).success).toBe(false);
  });

  it("creates bounded due-dated tasks for exact accepted-session targets", () => {
    expect(speakerTaskBulkCreateSchema.safeParse({
      targets: [{ speakerId: "speaker-1", sessionId: "session-1" }],
      taskKey: "travel-form",
      label: "Complete travel form",
      dueAt: "2027-04-20T23:59:00Z",
    }).success).toBe(true);
    expect(speakerTaskBulkCreateSchema.safeParse({
      targets: [{ speakerId: "speaker-1", sessionId: "session-1" }],
      taskKey: "Travel Form",
      label: "Complete travel form",
      dueAt: "2027-04-20T23:59:00Z",
    }).success).toBe(false);
  });

  it("requires optimistic revision for content edits", () => {
    expect(sessionContentUpdateSchema.safeParse({
      title: "Updated session title",
      abstract: "A precise updated description.",
      track: "Developer Experience",
      format: "talk",
      durationMinutes: 30,
      changeNote: "Clarified the attendee outcome.",
      expectedRevision: 2,
    }).success).toBe(true);
  });

  it("keeps session approval transitions explicit and revision guarded", () => {
    expect(sessionApprovalUpdateSchema.parse({
      approvalStatus: "approved",
      expectedRevision: 3,
    })).toEqual({ approvalStatus: "approved", expectedRevision: 3 });
    expect(sessionApprovalUpdateSchema.safeParse({
      approvalStatus: "changes_requested",
      expectedRevision: 3,
    }).success).toBe(false);
    expect(sessionApprovalUpdateSchema.safeParse({
      approvalStatus: "pending",
      expectedRevision: 0,
    }).success).toBe(false);
    expect(sessionApprovalUpdateSchema.safeParse({
      approvalStatus: "pending",
      expectedRevision: 1,
      actorUserId: "organizer-1",
    }).success).toBe(false);
  });
});
