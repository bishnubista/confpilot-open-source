import { z } from "zod";

const entityIdSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false, precision: 0 });
const revisionSchema = z.number().int().positive();
const httpUrlSchema = z.url().max(2_048).regex(/^https?:\/\//i, "Use an HTTP or HTTPS URL");
const nullableUrlSchema = httpUrlSchema.nullable();
const sameOriginPathSchema = z.string().startsWith("/").max(1_024).refine(
  (value) => !value.startsWith("//"),
  "Use a same-origin path",
);
const contentSessionFormatSchema = z.enum(["keynote", "talk", "lightning", "workshop", "panel"]);

export const speakerWorkflowStatusSchema = z.enum(["invited", "confirmed", "declined"]);
export const speakerPublicVisibilitySchema = z.enum(["private", "published"]);
export const speakerTaskStateSchema = z.enum(["open", "complete", "waived"]);
export const normalizedEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const deliverableRequestTypeSchema = z.literal("presentation");
export const deliverablesStatusSchema = z.enum(["missing", "submitted", "ready"]);
export const contentApprovalStatusSchema = z.enum(["pending", "changes_requested", "approved"]);
export const contentReviewOutcomeSchema = z.enum(["changes_requested", "approved"]);
export const eventDeliverablesArchivePathSchema = sameOriginPathSchema.refine(
  (value) => /^\/api\/events\/[^/]+\/content\/deliverables\.zip$/.test(value),
  "Use the authenticated event deliverables archive path",
);
export const organizerDeliverableDownloadPathSchema = sameOriginPathSchema.refine(
  (value) => /^\/api\/events\/[^/]+\/content\/deliverables\/[^/]+\/file$/.test(value),
  "Use the authenticated organizer deliverable path",
);

export const presentationContentTypeSchema = z.enum([
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
export const headshotContentTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
export const deliverableContentTypeSchema = presentationContentTypeSchema;

export const speakerSocialUrlsSchema = z.strictObject({
  website: nullableUrlSchema,
  linkedin: nullableUrlSchema,
  x: nullableUrlSchema,
});

export const speakerProfileUpdateSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  contactEmail: normalizedEmailSchema,
  title: z.string().trim().max(160),
  company: z.string().trim().max(160),
  bio: z.string().trim().max(4_000),
  socialUrls: speakerSocialUrlsSchema,
  travelPreferences: z.string().trim().max(2_000),
  publicVisibility: speakerPublicVisibilitySchema,
  revision: revisionSchema,
});

const normalizedRosterText = (maximum: number) => z.string().trim().max(maximum)
  .transform((value) => value.normalize("NFC"));

export const speakerRosterRowSchema = z.strictObject({
  name: normalizedRosterText(120).pipe(z.string().min(2)),
  email: normalizedEmailSchema,
  title: normalizedRosterText(160).default(""),
  company: normalizedRosterText(160).default(""),
  bio: normalizedRosterText(4_000).default(""),
});

export const speakerRosterIngestOutcomeSchema = z.strictObject({
  rowNumber: z.number().int().positive(),
  status: z.enum(["created", "duplicate", "invalid", "conflict", "failed"]),
  code: z.enum([
    "CREATED",
    "DUPLICATE_EMAIL",
    "VALIDATION_FAILED",
    "MALFORMED_CSV",
    "ACCOUNT_ROLE_CONFLICT",
    "CREATE_FAILED",
  ]),
  message: z.string().min(1).max(500),
  normalizedEmail: normalizedEmailSchema.nullable(),
  speakerId: entityIdSchema.nullable(),
  linkedAccount: z.boolean(),
});

export const speakerRosterIngestResponseSchema = z.strictObject({
  summary: z.strictObject({
    created: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  rows: z.array(speakerRosterIngestOutcomeSchema).max(500),
});

export const speakerOwnedProfileUpdateSchema = speakerProfileUpdateSchema.omit({
  publicVisibility: true,
});

export const speakerVisibilityUpdateSchema = z.strictObject({
  publicVisibility: speakerPublicVisibilitySchema,
  revision: revisionSchema,
});

export const speakerWorkflowUpdateSchema = z.strictObject({
  status: speakerWorkflowStatusSchema,
  revision: revisionSchema,
});

export const speakerReminderTemplateKeySchema = z.enum([
  "speaker.readiness-reminder",
  "speaker.task-reminder",
]);

export const speakerReminderTemplateSchema = z.strictObject({
  key: speakerReminderTemplateKeySchema,
  revision: z.number().int().positive(),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
});

export const speakerReminderTemplateListResponseSchema = z.strictObject({
  templates: z.array(speakerReminderTemplateSchema).min(1).max(20),
});

export const speakerReminderEnqueueSchema = z.strictObject({
  speakerId: entityIdSchema,
  templateKey: speakerReminderTemplateKeySchema,
  idempotencyKey: z.string().trim().min(8).max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, underscores, or hyphens"),
});

export const speakerReminderEnqueueResponseSchema = z.strictObject({
  messageId: entityIdSchema,
  speakerId: entityIdSchema,
  templateKey: speakerReminderTemplateKeySchema,
  templateRevision: z.number().int().positive(),
  outboxState: z.enum(["queued", "leased", "provider_accepted", "failed"]),
});

export const speakerHeadshotResponseSchema = z.strictObject({
  originalFilename: z.string().trim().min(1).max(255),
  contentType: headshotContentTypeSchema,
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: timestampSchema,
  revision: revisionSchema,
  viewPath: sameOriginPathSchema.refine((value) => value.startsWith("/api/events/"), "Use an authenticated API path"),
  publicUrl: sameOriginPathSchema.refine(
    (value) => value.startsWith("/api/public/events/"),
    "Use a public event API path",
  ).nullable(),
});

export const speakerTaskUpdateSchema = z.strictObject({
  state: z.enum(["open", "complete"]),
  revision: revisionSchema,
});

export const organizerSpeakerTaskUpdateSchema = z.strictObject({
  state: z.enum(["open", "waived"]),
  dueAt: timestampSchema.nullable().optional(),
  revision: revisionSchema,
});

const speakerTaskTargetSchema = z.strictObject({
  speakerId: entityIdSchema,
  sessionId: entityIdSchema,
});

export const speakerTaskBulkCreateSchema = z.strictObject({
  targets: z.array(speakerTaskTargetSchema).min(1).max(100).superRefine((targets, context) => {
    const seen = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const key = `${target.sessionId}\u0000${target.speakerId}`;
      if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "Task targets must be unique" });
      seen.add(key);
    }
  }),
  taskKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().trim().min(1).max(200),
  dueAt: timestampSchema,
});

const deliverableRequestBase = {
  label: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(4_000),
  dueAt: timestampSchema,
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024),
  required: z.boolean(),
};

export const deliverableRequestCreateSchema = z.strictObject({
  ...deliverableRequestBase,
  requestKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
  requestType: deliverableRequestTypeSchema,
  allowedContentTypes: z.array(presentationContentTypeSchema).min(1).max(3),
});

export const deliverableRequestUpdateSchema = z.strictObject({
  ...deliverableRequestBase,
  allowedContentTypes: z.array(presentationContentTypeSchema).min(1).max(3),
  active: z.boolean(),
  revision: revisionSchema,
});

export const deliverableUploadMetadataSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(8).max(128),
  note: z.string().trim().max(1_000).default(""),
});

export const contentReviewCreateSchema = z.strictObject({
  versionId: entityIdSchema,
  idempotencyKey: z.string().trim().min(8).max(128),
  outcome: contentReviewOutcomeSchema,
  comment: z.string().trim().min(1).max(4_000),
  expectedSessionRevision: revisionSchema,
});

export const contentCommentCreateSchema = z.strictObject({
  versionId: entityIdSchema,
  body: z.string().trim().min(1).max(4_000),
});

export const sessionContentUpdateSchema = z.strictObject({
  title: z.string().trim().min(1).max(300),
  abstract: z.string().trim().min(1).max(20_000),
  track: z.string().trim().min(1).max(160),
  format: contentSessionFormatSchema,
  durationMinutes: z.number().int().positive().max(480),
  changeNote: z.string().trim().min(1).max(1_000),
  expectedRevision: revisionSchema,
});

export const sessionApprovalUpdateSchema = z.strictObject({
  approvalStatus: z.enum(["pending", "approved"]),
  expectedRevision: revisionSchema,
});

export const deliverableVersionResponseSchema = z.strictObject({
  id: entityIdSchema,
  requestId: entityIdSchema,
  sessionId: entityIdSchema,
  requestType: deliverableRequestTypeSchema,
  versionNumber: z.number().int().positive(),
  originalFilename: z.string().min(1).max(255),
  contentType: deliverableContentTypeSchema,
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().max(1_000),
  uploader: z.strictObject({ speakerId: entityIdSchema, name: z.string().min(1).max(120) }),
  uploadedAt: timestampSchema,
  downloadPath: sameOriginPathSchema.refine((value) => value.startsWith("/api/events/"), "Use an authenticated API path"),
  publicUrl: z.null(),
});

export const organizerDeliverableVersionResponseSchema = deliverableVersionResponseSchema.safeExtend({
  downloadPath: organizerDeliverableDownloadPathSchema,
});

export const speakerProfileResponseSchema = z.strictObject({
  id: entityIdSchema,
  name: z.string().min(1).max(120),
  contactEmail: z.email().max(254).nullable(),
  title: z.string().max(160),
  company: z.string().max(160),
  bio: z.string().max(4_000),
  socialUrls: speakerSocialUrlsSchema,
  travelPreferences: z.string().max(2_000),
  workflowStatus: speakerWorkflowStatusSchema,
  profileStatus: z.enum(["incomplete", "ready"]),
  agreementStatus: z.enum(["missing", "signed"]),
  publicVisibility: speakerPublicVisibilitySchema,
  headshot: speakerHeadshotResponseSchema.nullable(),
  revision: revisionSchema,
  updatedAt: timestampSchema,
});

export const speakerProfileHistorySnapshotSchema = speakerProfileResponseSchema.omit({
  contactEmail: true,
});

export const speakerTaskResponseSchema = z.strictObject({
  id: entityIdSchema,
  sessionId: entityIdSchema,
  taskKey: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  state: speakerTaskStateSchema,
  dueAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
  revision: revisionSchema,
  updatedAt: timestampSchema,
}).superRefine((value, context) => {
  if ((value.state === "complete") !== (value.completedAt !== null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Completion time must match task state" });
  }
});

export const deliverableRequestResponseSchema = z.strictObject({
  id: entityIdSchema,
  sessionId: entityIdSchema,
  requestKey: z.string().min(1).max(64),
  requestType: deliverableRequestTypeSchema,
  label: z.string().min(1).max(200),
  instructions: z.string().max(4_000),
  dueAt: timestampSchema,
  allowedContentTypes: z.array(presentationContentTypeSchema).min(1).max(3),
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024),
  required: z.boolean(),
  active: z.boolean(),
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const contentCommentResponseSchema = z.strictObject({
  id: entityIdSchema,
  sessionId: entityIdSchema,
  versionId: entityIdSchema,
  author: z.strictObject({
    kind: z.enum(["speaker", "organizer"]),
    name: z.string().min(1).max(120),
    speakerId: entityIdSchema.nullable(),
  }),
  body: z.string().min(1).max(4_000),
  createdAt: timestampSchema,
});

export const contentReviewResponseSchema = z.strictObject({
  id: entityIdSchema,
  sessionId: entityIdSchema,
  versionId: entityIdSchema,
  outcome: contentReviewOutcomeSchema,
  comment: z.string().min(1).max(4_000),
  reviewerName: z.string().min(1).max(120),
  reviewedAt: timestampSchema,
});

export const sessionContentHistoryResponseSchema = z.strictObject({
  id: entityIdSchema,
  sessionId: entityIdSchema,
  action: z.enum(["updated", "restored"]),
  title: z.string().min(1).max(300),
  abstract: z.string().min(1).max(20_000),
  track: z.string().min(1).max(160),
  format: contentSessionFormatSchema,
  durationMinutes: z.number().int().positive().max(480),
  changeNote: z.string().min(1).max(1_000),
  actorName: z.string().min(1).max(120),
  createdAt: timestampSchema,
});

export const speakerContentHistoryResponseSchema = z.strictObject({
  id: entityIdSchema,
  speakerId: entityIdSchema,
  action: z.enum(["updated", "headshot_uploaded", "restored"]),
  profile: speakerProfileHistorySnapshotSchema,
  changeNote: z.string().min(1).max(1_000),
  actorName: z.string().min(1).max(120),
  createdAt: timestampSchema,
});

const contentSessionSummarySchema = z.strictObject({
  id: entityIdSchema,
  slug: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  track: z.string().min(1).max(160),
  format: contentSessionFormatSchema,
  deliverablesStatus: deliverablesStatusSchema,
  approvalStatus: contentApprovalStatusSchema,
  revision: revisionSchema,
  schedule: z.strictObject({
    room: z.string().min(1).max(160),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
  }).refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), {
    path: ["endsAt"], error: "Schedule end must follow start",
  }).nullable().optional(),
});

export const speakerContentWorkspaceResponseSchema = z.strictObject({
  event: z.strictObject({ slug: z.string().min(1).max(128), name: z.string().min(1).max(200) }),
  speaker: speakerProfileResponseSchema,
  sessions: z.array(contentSessionSummarySchema.extend({
    tasks: z.array(speakerTaskResponseSchema),
    requests: z.array(deliverableRequestResponseSchema.safeExtend({
      versions: z.array(deliverableVersionResponseSchema),
    })),
    comments: z.array(contentCommentResponseSchema),
    reviews: z.array(contentReviewResponseSchema),
  })),
});

export const organizerSpeakerRosterResponseSchema = z.strictObject({
  event: z.strictObject({ slug: z.string().min(1).max(128), name: z.string().min(1).max(200) }),
  speakers: z.array(z.strictObject({
    accountLinked: z.boolean().default(false),
    profile: speakerProfileResponseSchema,
    history: z.array(speakerContentHistoryResponseSchema),
    sessions: z.array(contentSessionSummarySchema),
    tasks: z.array(speakerTaskResponseSchema),
    readiness: z.strictObject({
      profileReady: z.boolean(), agreementReady: z.boolean(), headshotReady: z.boolean(),
      requiredTasksReady: z.boolean(), deliverablesReady: z.boolean(), nextDueAt: timestampSchema.nullable(),
    }),
  })),
});

export const organizerContentDossierSchema = contentSessionSummarySchema.extend({
  abstract: z.string().min(1).max(20_000),
  durationMinutes: z.number().int().positive().max(480),
  presenters: z.array(speakerProfileResponseSchema).min(1),
  tasks: z.array(speakerTaskResponseSchema),
  requests: z.array(deliverableRequestResponseSchema),
  versions: z.array(organizerDeliverableVersionResponseSchema),
  comments: z.array(contentCommentResponseSchema),
  reviews: z.array(contentReviewResponseSchema),
  history: z.array(sessionContentHistoryResponseSchema),
  unmetApprovalGates: z.array(z.string().min(1).max(200)),
});

export const organizerContentListResponseSchema = z.strictObject({
  event: z.strictObject({ slug: z.string().min(1).max(128), name: z.string().min(1).max(200) }),
  approvedDeliverablesArchivePath: eventDeliverablesArchivePathSchema,
  sessions: z.array(organizerContentDossierSchema),
});

export const deliverableUploadResponseSchema = z.strictObject({
  version: deliverableVersionResponseSchema,
  session: z.strictObject({
    id: entityIdSchema,
    deliverablesStatus: deliverablesStatusSchema,
    approvalStatus: contentApprovalStatusSchema,
    revision: revisionSchema,
  }),
});

export type SpeakerProfileUpdate = z.infer<typeof speakerProfileUpdateSchema>;
export type SpeakerOwnedProfileUpdate = z.infer<typeof speakerOwnedProfileUpdateSchema>;
export type SpeakerVisibilityUpdate = z.infer<typeof speakerVisibilityUpdateSchema>;
export type SpeakerWorkflowUpdate = z.infer<typeof speakerWorkflowUpdateSchema>;
export type SpeakerReminderTemplateKey = z.infer<typeof speakerReminderTemplateKeySchema>;
export type SpeakerReminderTemplate = z.infer<typeof speakerReminderTemplateSchema>;
export type SpeakerReminderTemplateListResponse = z.infer<typeof speakerReminderTemplateListResponseSchema>;
export type SpeakerReminderEnqueue = z.infer<typeof speakerReminderEnqueueSchema>;
export type SpeakerReminderEnqueueResponse = z.infer<typeof speakerReminderEnqueueResponseSchema>;
export type SpeakerRosterRow = z.infer<typeof speakerRosterRowSchema>;
export type SpeakerRosterIngestOutcome = z.infer<typeof speakerRosterIngestOutcomeSchema>;
export type SpeakerRosterIngestResponse = z.infer<typeof speakerRosterIngestResponseSchema>;
export type SpeakerTaskUpdate = z.infer<typeof speakerTaskUpdateSchema>;
export type OrganizerSpeakerTaskUpdate = z.infer<typeof organizerSpeakerTaskUpdateSchema>;
export type SpeakerTaskBulkCreate = z.infer<typeof speakerTaskBulkCreateSchema>;
export type DeliverableRequestCreate = z.infer<typeof deliverableRequestCreateSchema>;
export type DeliverableRequestUpdate = z.infer<typeof deliverableRequestUpdateSchema>;
export type DeliverableUploadMetadata = z.infer<typeof deliverableUploadMetadataSchema>;
export type DeliverableVersionResponse = z.infer<typeof deliverableVersionResponseSchema>;
export type DeliverableUploadResponse = z.infer<typeof deliverableUploadResponseSchema>;
export type ContentReviewCreate = z.infer<typeof contentReviewCreateSchema>;
export type ContentCommentCreate = z.infer<typeof contentCommentCreateSchema>;
export type SessionContentUpdate = z.infer<typeof sessionContentUpdateSchema>;
export type SessionApprovalUpdate = z.infer<typeof sessionApprovalUpdateSchema>;
export type SpeakerProfileResponse = z.infer<typeof speakerProfileResponseSchema>;
export type SpeakerProfileHistorySnapshot = z.infer<typeof speakerProfileHistorySnapshotSchema>;
export type SpeakerTaskResponse = z.infer<typeof speakerTaskResponseSchema>;
export type DeliverableRequestResponse = z.infer<typeof deliverableRequestResponseSchema>;
export type ContentCommentResponse = z.infer<typeof contentCommentResponseSchema>;
export type ContentReviewResponse = z.infer<typeof contentReviewResponseSchema>;
export type SessionContentHistoryResponse = z.infer<typeof sessionContentHistoryResponseSchema>;
export type SpeakerContentHistoryResponse = z.infer<typeof speakerContentHistoryResponseSchema>;
export type SpeakerContentWorkspaceResponse = z.infer<typeof speakerContentWorkspaceResponseSchema>;
export type OrganizerSpeakerRosterResponse = z.infer<typeof organizerSpeakerRosterResponseSchema>;
export type OrganizerContentDossier = z.infer<typeof organizerContentDossierSchema>;
export type OrganizerContentListResponse = z.infer<typeof organizerContentListResponseSchema>;
