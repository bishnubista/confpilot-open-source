import { z } from "zod";

export * from "./session-format";
export * from "./speaker-content";
export * from "./agenda";
export * from "./readiness";
export * from "./program-operator";
export * from "./communications";
export * from "./reviewer-invitations";
export * from "./speaker-claims";
import { normalizedEmailSchema } from "./speaker-content";
import { SESSION_FORMAT_DURATIONS, sessionFormatSchema } from "./session-format";

export const eventRoleSchema = z.enum(["organizer", "reviewer", "speaker"]);
export const decisionValueSchema = z.enum(["accept", "reject", "waitlist"]);

export const loginRequestSchema = z.strictObject({
  email: normalizedEmailSchema,
  password: z.string().min(1).max(128),
});

const cfpDateTimeSchema = z.iso.datetime({ offset: false, precision: 0 });
const cfpEventDateSchema = z.iso.date();
const cfpFieldKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
const cfpOptionSchema = z.strictObject({
  value: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(160),
  durationMinutes: z.number().int().positive().max(480).optional(),
});

export const cfpFieldSchema = z.strictObject({
  key: cfpFieldKeySchema,
  section: z.enum(["session", "speaker"]),
  type: z.enum(["short_text", "long_text", "dropdown"]),
  label: z.string().trim().min(1).max(160),
  helpText: z.string().trim().max(500).default(""),
  required: z.boolean(),
  options: z.array(cfpOptionSchema).max(50).default([]),
  sortOrder: z.number().int().nonnegative().max(10_000),
  showWhen: z.strictObject({
    fieldKey: cfpFieldKeySchema,
    equals: z.string().min(1).max(120),
  }).nullable().default(null),
});

export const cfpEventCustomizationSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  tagline: z.string().trim().max(500),
  location: z.string().trim().max(500),
  description: z.string().trim().max(20_000),
  startsOn: cfpEventDateSchema,
  endsOn: cfpEventDateSchema,
}).superRefine((value, context) => {
  if (value.startsOn > value.endsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "End date must be on or after start date" });
  }
});

export const cfpConfigUpdateSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  event: cfpEventCustomizationSchema,
  status: z.enum(["draft", "published"]),
  opensAt: cfpDateTimeSchema,
  closesAt: cfpDateTimeSchema,
  confirmationMessage: z.string().trim().min(1).max(1_000),
  fields: z.array(cfpFieldSchema).min(1).max(50),
}).superRefine((value, context) => {
  if (Date.parse(value.opensAt) >= Date.parse(value.closesAt)) {
    context.addIssue({ code: "custom", path: ["closesAt"], message: "Close time must be after open time" });
  }
  const keys = new Set<string>();
  for (const [index, field] of value.fields.entries()) {
    if (keys.has(field.key)) {
      context.addIssue({ code: "custom", path: ["fields", index, "key"], message: "Field keys must be unique" });
    }
    keys.add(field.key);
    if (field.type === "dropdown" && field.options.length === 0) {
      context.addIssue({ code: "custom", path: ["fields", index, "options"], message: "Dropdowns require options" });
    }
    if (field.type !== "dropdown" && field.options.length > 0) {
      context.addIssue({ code: "custom", path: ["fields", index, "options"], message: "Text fields cannot define options" });
    }
    if (field.showWhen?.fieldKey === field.key) {
      context.addIssue({ code: "custom", path: ["fields", index, "showWhen"], message: "A field cannot conditionally depend on itself" });
    }
    const optionValues = new Set<string>();
    for (const [optionIndex, option] of field.options.entries()) {
      if (optionValues.has(option.value)) {
        context.addIssue({ code: "custom", path: ["fields", index, "options", optionIndex, "value"], message: "Option values must be unique" });
      }
      optionValues.add(option.value);
      if (field.key !== "format" && option.durationMinutes !== undefined) {
        context.addIssue({ code: "custom", path: ["fields", index, "options", optionIndex, "durationMinutes"], message: "Only format options may define a duration" });
      }
    }
  }
  for (const [index, field] of value.fields.entries()) {
    if (field.showWhen) {
      const source = value.fields.find(({ key }) => key === field.showWhen?.fieldKey);
      if (!source) {
        context.addIssue({ code: "custom", path: ["fields", index, "showWhen"], message: "Conditional fields must reference another configured field" });
      } else if (source.type !== "dropdown" || !source.options.some(({ value: optionValue }) => optionValue === field.showWhen?.equals)) {
        context.addIssue({ code: "custom", path: ["fields", index, "showWhen"], message: "Conditional fields must reference a configured dropdown option" });
      }
    }
  }
  for (const [index, field] of value.fields.entries()) {
    const visited = new Set([field.key]);
    let dependency = field.showWhen?.fieldKey;
    while (dependency) {
      if (visited.has(dependency)) {
        context.addIssue({ code: "custom", path: ["fields", index, "showWhen"], message: "Conditional field dependencies cannot form a cycle" });
        break;
      }
      visited.add(dependency);
      dependency = value.fields.find(({ key }) => key === dependency)?.showWhen?.fieldKey;
    }
  }
  const byKey = new Map(value.fields.map((field) => [field.key, field]));
  const requiredFields = [
    ["title", ["short_text", "long_text"]],
    ["abstract", ["long_text"]],
    ["track", ["dropdown"]],
    ["format", ["dropdown"]],
  ] as const;
  for (const [key, types] of requiredFields) {
    const field = byKey.get(key);
    if (!field) {
      context.addIssue({ code: "custom", path: ["fields"], message: `The ${key} field is required` });
    } else if (!field.required || !(types as readonly string[]).includes(field.type) || field.showWhen !== null) {
      context.addIssue({ code: "custom", path: ["fields", value.fields.indexOf(field)], message: `${key} must be a required ${types.join(" or ")}` });
    }
  }
  const formatField = byKey.get("format");
  for (const [index, option] of (formatField?.options ?? []).entries()) {
    const format = sessionFormatSchema.safeParse(option.value);
    if (!format.success || option.durationMinutes !== SESSION_FORMAT_DURATIONS[format.data]) {
      context.addIssue({ code: "custom", path: ["fields", value.fields.indexOf(formatField!), "options", index], message: "Format values and durations must use the supported canonical formats" });
    }
  }
});

export const speakerRegistrationSchema = z.strictObject({
  displayName: z.string().trim().min(2).max(120),
  email: normalizedEmailSchema,
  password: z.string().min(12).max(128),
  title: z.string().trim().max(160).default(""),
  company: z.string().trim().max(160).default(""),
  bio: z.string().trim().max(4_000).default(""),
  turnstileToken: z.string().trim().min(1).max(2_048),
});

export const proposalValuesSchema = z.record(
  cfpFieldKeySchema,
  z.string().max(20_000),
).refine((value) => Object.keys(value).length <= 50, "Too many proposal fields");

export const proposalDraftCreateSchema = z.strictObject({
  clientDraftKey: z.string().trim().min(8).max(128),
  values: proposalValuesSchema,
});

export const proposalDraftUpdateSchema = z.strictObject({
  values: proposalValuesSchema,
});

export const cfpOptionResponseSchema = cfpOptionSchema;
const cfpPublicEventResponseSchema = z.strictObject({
  slug: z.string(),
  ...cfpEventCustomizationSchema.shape,
}).superRefine((value, context) => {
  if (value.startsOn > value.endsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "End date must be on or after start date" });
  }
});
export const cfpPublicConfigResponseSchema = z.strictObject({
  event: cfpPublicEventResponseSchema,
  status: z.enum(["draft", "published"]),
  state: z.enum(["upcoming", "open", "closed"]),
  opensAt: cfpDateTimeSchema,
  closesAt: cfpDateTimeSchema,
  confirmationMessage: z.string(),
  turnstile: z.discriminatedUnion("enabled", [
    z.strictObject({ enabled: z.literal(true), siteKey: z.string().trim().min(1).max(2_048) }),
    z.strictObject({ enabled: z.literal(false), siteKey: z.null() }),
  ]),
  revision: z.number().int().positive(),
  fields: z.array(cfpFieldSchema),
});

export const proposalResponseSchema = z.strictObject({
  id: z.string(),
  publicId: z.string(),
  status: z.enum(["draft", "submitted", "in_review", "decided"]),
  submittedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  clientDraftKey: z.string().nullable(),
  decision: decisionValueSchema.nullable(),
  owner: z.strictObject({ name: z.string(), email: z.email() }).optional(),
  values: proposalValuesSchema,
}).superRefine((value, context) => {
  if ((value.status === "decided") !== (value.decision !== null)) {
    context.addIssue({
      code: "custom",
      path: ["decision"],
      message: "A proposal decision is present exactly when its lifecycle is decided",
    });
  }
});

export const organizerProposalPageResponseSchema = z.strictObject({
  proposals: z.array(proposalResponseSchema),
  page: z.strictObject({
    limit: z.number().int().min(1).max(90),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
});

export const speakerProposalListResponseSchema = z.strictObject({
  proposals: z.array(proposalResponseSchema),
});

const reviewIdSchema = z.string().min(1).max(128);
const reviewResponseDateTimeSchema = z.iso.datetime({ offset: false });
const reviewProposalTitleSchema = z.string().min(1).max(20_000);
const reviewProposalSummarySchema = z.strictObject({
  id: reviewIdSchema,
  publicId: z.string().min(1).max(128),
  title: reviewProposalTitleSchema,
});

export const reviewRecommendationSchema = z.enum(["accept", "discuss", "reject"]);
export const reviewAssignmentStatusSchema = z.enum(["pending", "completed", "revoked"]);
export const reviewInvitationStatusSchema = z.enum(["pending", "accepted", "declined", "recused"]);
export const reviewerConflictCategorySchema = z.enum([
  "author_relationship",
  "institutional",
  "financial",
  "personal",
  "other",
]);

export const reviewInvitationResponseRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept") }),
  z.strictObject({ action: z.literal("decline"), reason: z.string().trim().min(1).max(1_000) }),
]);

export const reviewRecusalRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1_000),
});

export const reviewerConflictDeclareSchema = z.strictObject({
  category: reviewerConflictCategorySchema,
  note: z.string().trim().min(1).max(1_000),
});

export const reviewerConflictSchema = z.strictObject({
  category: reviewerConflictCategorySchema,
  note: z.string().min(1).max(1_000),
  declaredAt: reviewResponseDateTimeSchema,
});

export const reviewAssignmentLifecycleResponseSchema = z.strictObject({
  id: reviewIdSchema,
  invitationStatus: reviewInvitationStatusSchema,
  respondedAt: reviewResponseDateTimeSchema,
  reason: z.string().min(1).max(1_000).nullable(),
  conflict: reviewerConflictSchema.nullable(),
});

export const organizerReviewAssignmentCreateSchema = z.strictObject({
  reviewerUserId: reviewIdSchema,
  dueAt: cfpDateTimeSchema.nullable().optional(),
  blind: z.boolean().default(true),
  reviewRoundId: reviewIdSchema.nullable().optional(),
});

export const reviewRoundWriteSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  opensAt: cfpDateTimeSchema,
  closesAt: cfpDateTimeSchema,
  blindDefault: z.boolean().default(true),
}).superRefine((round, context) => {
  if (round.opensAt >= round.closesAt) {
    context.addIssue({ code: "custom", path: ["closesAt"], message: "Round must close after it opens." });
  }
});

export const reviewRoundUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  opensAt: cfpDateTimeSchema,
  closesAt: cfpDateTimeSchema,
  blindDefault: z.boolean(),
  expectedUpdatedAt: reviewResponseDateTimeSchema,
}).superRefine((round, context) => {
  if (round.opensAt >= round.closesAt) {
    context.addIssue({ code: "custom", path: ["closesAt"], message: "Round must close after it opens." });
  }
});

export const reviewRoundResponseSchema = z.strictObject({
  id: reviewIdSchema,
  name: z.string().min(1).max(120),
  opensAt: reviewResponseDateTimeSchema,
  closesAt: reviewResponseDateTimeSchema,
  blindDefault: z.boolean(),
  position: z.number().int().nonnegative(),
  windowState: z.enum(["upcoming", "open", "closed"]),
  poolSize: z.number().int().nonnegative(),
  hasActivePlan: z.boolean(),
  updatedAt: reviewResponseDateTimeSchema,
});

export const reviewRoundListResponseSchema = z.strictObject({
  rounds: z.array(reviewRoundResponseSchema),
});

export const reviewRoundPoolWriteSchema = z.strictObject({
  reviewerUserIds: z.array(reviewIdSchema).max(200),
});

export const reviewRoundPoolResponseSchema = z.strictObject({
  roundId: reviewIdSchema,
  reviewers: z.array(z.strictObject({
    userId: reviewIdSchema,
    displayName: z.string().min(1).max(120),
    email: z.email(),
  })),
  rejected: z.array(z.strictObject({
    userId: reviewIdSchema,
    reason: z.enum(["not_a_reviewer", "unknown_user", "active_assignments"]),
  })).default([]),
});

export const reviewerProgressRowSchema = z.strictObject({
  userId: reviewIdSchema,
  displayName: z.string().min(1).max(120),
  email: z.email(),
  assignedCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
});

export const reviewerProgressResponseSchema = z.strictObject({
  roundId: reviewIdSchema.nullable(),
  reviewers: z.array(reviewerProgressRowSchema),
});

export const reviewAutoAssignRequestSchema = z.strictObject({
  perReviewerCap: z.number().int().min(1).max(50).optional(),
  track: z.string().trim().min(1).max(120).optional(),
  blind: z.boolean().optional(),
  dueAt: cfpDateTimeSchema.nullable().optional(),
});

export const reviewAutoAssignResultSchema = z.strictObject({
  created: z.array(z.strictObject({
    assignmentId: reviewIdSchema,
    proposalId: reviewIdSchema,
    reviewerUserId: reviewIdSchema,
  })),
  skipped: z.array(z.strictObject({
    proposalId: reviewIdSchema,
    reviewerUserId: reviewIdSchema.nullable(),
    reason: z.enum([
      "conflict",
      "self_review",
      "already_assigned",
      "reviewer_at_cap",
      "no_pool_capacity",
      "insert_failed",
    ]),
  })),
  hasMore: z.boolean(),
});

export const reviewerReminderTemplateKeySchema = z.enum(["reviewer.pending-reviews-reminder"]);

export const reviewerReminderEnqueueSchema = z.strictObject({
  reviewerUserId: reviewIdSchema,
  roundId: reviewIdSchema.nullable().optional(),
  templateKey: reviewerReminderTemplateKeySchema,
  idempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
});

export const reviewerReminderResponseSchema = z.strictObject({
  messageId: reviewIdSchema,
  reviewerUserId: reviewIdSchema,
  templateKey: reviewerReminderTemplateKeySchema,
  templateRevision: z.number().int().positive(),
  outboxState: z.enum(["queued", "leased", "provider_accepted", "failed"]),
  pendingAssignments: z.number().int().positive(),
});

export const proposalCoPresenterWriteSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: normalizedEmailSchema.nullable().optional(),
});

export const proposalCoPresenterResponseSchema = z.strictObject({
  id: reviewIdSchema,
  name: z.string().min(1).max(120),
  email: z.email().nullable(),
  role: z.enum(["primary", "co_presenter"]),
});

export const proposalCoPresenterListResponseSchema = z.strictObject({
  participants: z.array(proposalCoPresenterResponseSchema).min(1).max(20),
});

export const evaluationPlanBuiltinLabelsSchema = z.strictObject({
  recommendationAccept: z.string().trim().min(1).max(40),
  recommendationDiscuss: z.string().trim().min(1).max(40),
  recommendationReject: z.string().trim().min(1).max(40),
  commentsLabel: z.string().trim().min(1).max(40),
});

const legacyReviewScorecardSubmitSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  originality: z.number().int().min(1).max(5),
  relevance: z.number().int().min(1).max(5),
  recommendation: reviewRecommendationSchema,
  comment: z.string().trim().min(1).max(4_000),
});

export const reviewCriterionSchema = z.strictObject({
  id: reviewIdSchema,
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  description: z.string().max(1_000),
  weightBasisPoints: z.number().int().min(1).max(10_000),
  minimumScore: z.number().int().min(1).max(9),
  maximumScore: z.number().int().min(2).max(10),
  sortOrder: z.number().int().nonnegative(),
});

export const evaluationPlanVersionSchema = z.strictObject({
  planId: reviewIdSchema,
  versionId: reviewIdSchema,
  versionNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  criteria: z.array(reviewCriterionSchema).min(1).max(20),
  builtinLabels: z.strictObject({
    recommendationAccept: z.string().trim().min(1).max(40),
    recommendationDiscuss: z.string().trim().min(1).max(40),
    recommendationReject: z.string().trim().min(1).max(40),
    commentsLabel: z.string().trim().min(1).max(40),
  }).nullable().default(null),
  createdAt: reviewResponseDateTimeSchema,
});

export const evaluationPlanWriteSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  criteria: z.array(z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    label: z.string().trim().min(1).max(120),
    description: z.string().max(1_000).default(""),
    weightBasisPoints: z.number().int().min(1).max(10_000),
    minimumScore: z.number().int().min(1).max(9).default(1),
    maximumScore: z.number().int().min(2).max(10).default(5),
  })).min(1).max(20),
  builtinLabels: z.strictObject({
    recommendationAccept: z.string().trim().min(1).max(40),
    recommendationDiscuss: z.string().trim().min(1).max(40),
    recommendationReject: z.string().trim().min(1).max(40),
    commentsLabel: z.string().trim().min(1).max(40),
  }).nullable().optional(),
}).superRefine((plan, context) => {
  if (new Set(plan.criteria.map(({ key }) => key)).size !== plan.criteria.length) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "Criterion keys must be unique." });
  }
  if (plan.criteria.reduce((total, criterion) => total + criterion.weightBasisPoints, 0) !== 10_000) {
    context.addIssue({ code: "custom", path: ["criteria"], message: "Criterion weights must total 10000 basis points." });
  }
  plan.criteria.forEach((criterion, index) => {
    if (criterion.minimumScore >= criterion.maximumScore) {
      context.addIssue({ code: "custom", path: ["criteria", index], message: "Minimum score must be below maximum score." });
    }
  });
});

const criteriaReviewScorecardSubmitSchema = z.strictObject({
  expectedRevision: z.number().int().positive().optional(),
  criterionScores: z.array(z.strictObject({
    criterionId: reviewIdSchema,
    score: z.number().int().min(1).max(10),
  })).min(1).max(20),
  recommendation: reviewRecommendationSchema,
  comment: z.string().trim().min(1).max(4_000),
}).superRefine((scorecard, context) => {
  const ids = scorecard.criterionScores.map(({ criterionId }) => criterionId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["criterionScores"],
      message: "Criterion scores must be unique.",
    });
  }
});

export const reviewScorecardSubmitSchema = z.union([
  legacyReviewScorecardSubmitSchema,
  criteriaReviewScorecardSubmitSchema,
]);

export const submittedReviewSchema = z.strictObject({
  id: reviewIdSchema,
  revisionNumber: z.number().int().positive().default(1),
  originality: z.number().int().min(1).max(5),
  relevance: z.number().int().min(1).max(5),
  evaluationPlanVersion: z.number().int().positive().nullable().default(null),
  criterionScores: z.array(z.strictObject({
    criterionId: reviewIdSchema,
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(120),
    score: z.number().int().min(1).max(10),
  })).default([]),
  weightedScore: z.number().min(1).max(5).nullable().default(null),
  recommendation: reviewRecommendationSchema,
  comment: z.string().min(1).max(4_000),
  submittedAt: reviewResponseDateTimeSchema,
  correctedAt: reviewResponseDateTimeSchema.nullable().default(null),
});

export const reviewerMembershipResponseSchema = z.strictObject({
  userId: reviewIdSchema,
  displayName: z.string().min(1).max(120),
  email: z.email(),
});

export const reviewerMembershipListResponseSchema = z.strictObject({
  reviewers: z.array(reviewerMembershipResponseSchema),
});

export const reviewAssignmentResponseSchema = z.strictObject({
  id: reviewIdSchema,
  round: z.number().int().positive(),
  reviewRoundId: reviewIdSchema.nullable().default(null),
  blind: z.boolean(),
  dueAt: reviewResponseDateTimeSchema.nullable(),
  status: reviewAssignmentStatusSchema,
  invitationStatus: reviewInvitationStatusSchema,
  assignedAt: reviewResponseDateTimeSchema,
  revokedAt: reviewResponseDateTimeSchema.nullable(),
  proposal: reviewProposalSummarySchema,
  reviewer: reviewerMembershipResponseSchema,
  conflict: reviewerConflictSchema.nullable().default(null),
});

export const reviewAssignmentRevokeResponseSchema = z.strictObject({
  id: reviewIdSchema,
  status: z.literal("revoked"),
  revokedAt: reviewResponseDateTimeSchema,
});

const reviewerQueueProposalSchema = z.strictObject({
  publicId: z.string().min(1).max(128),
  title: reviewProposalTitleSchema,
  track: z.string().min(1).max(160),
  format: sessionFormatSchema,
  durationMinutes: z.number().int().positive().max(480),
});

export const reviewerAssignmentQueueItemSchema = z.strictObject({
  id: reviewIdSchema,
  round: z.number().int().positive(),
  blind: z.boolean(),
  dueAt: reviewResponseDateTimeSchema.nullable(),
  status: z.enum(["pending", "completed"]),
  invitationStatus: reviewInvitationStatusSchema,
  proposal: reviewerQueueProposalSchema,
  conflict: reviewerConflictSchema.nullable().default(null),
});

export const reviewerAssignmentQueueResponseSchema = z.strictObject({
  assignments: z.array(reviewerAssignmentQueueItemSchema),
});

export const blindReviewProposalSchema = reviewerQueueProposalSchema.extend({
  abstract: z.string().min(1).max(20_000),
  sessionAnswers: proposalValuesSchema,
});

export const identifiedReviewProposalSchema = blindReviewProposalSchema.extend({
  authorDisplayName: z.string().min(1).max(120).optional(),
});

const reviewerAssignmentDetailBase = {
  id: reviewIdSchema,
  round: z.number().int().positive(),
  dueAt: reviewResponseDateTimeSchema.nullable(),
  status: z.enum(["pending", "completed"]),
  invitationStatus: reviewInvitationStatusSchema,
  respondedAt: reviewResponseDateTimeSchema.nullable().default(null),
  responseReason: z.string().min(1).max(1_000).nullable().default(null),
  review: submittedReviewSchema.nullable(),
  correctionAllowed: z.boolean().default(false),
  evaluationPlan: evaluationPlanVersionSchema.nullable().default(null),
  conflict: reviewerConflictSchema.nullable().default(null),
};

export const reviewerAssignmentDetailResponseSchema = z.discriminatedUnion("blind", [
  z.strictObject({
    ...reviewerAssignmentDetailBase,
    blind: z.literal(true),
    proposal: blindReviewProposalSchema,
  }),
  z.strictObject({
    ...reviewerAssignmentDetailBase,
    blind: z.literal(false),
    proposal: identifiedReviewProposalSchema,
  }),
]);

export const organizerProposalReviewProgressSchema = z.strictObject({
  proposalId: reviewIdSchema,
  publicId: z.string().min(1).max(128),
  title: reviewProposalTitleSchema,
  track: z.string().min(1).max(160),
  format: sessionFormatSchema,
  assignedCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  averageScore: z.number().min(1).max(5).nullable(),
  recommendations: z.strictObject({
    accept: z.number().int().nonnegative(),
    discuss: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative(),
  }),
});

export const organizerProposalReviewProgressResponseSchema = z.strictObject({
  proposals: z.array(organizerProposalReviewProgressSchema),
});

export const organizerSubmittedReviewSchema = submittedReviewSchema.extend({
  assignmentId: reviewIdSchema,
  round: z.number().int().positive(),
  reviewer: z.strictObject({
    userId: reviewIdSchema,
    displayName: z.string().min(1).max(120),
  }),
});

export const organizerReviewAssignmentSummarySchema = z.strictObject({
  id: reviewIdSchema,
  reviewer: z.strictObject({
    userId: reviewIdSchema,
    displayName: z.string().min(1).max(120),
  }),
  round: z.number().int().positive(),
  blind: z.boolean(),
  status: reviewAssignmentStatusSchema,
  invitationStatus: reviewInvitationStatusSchema,
  respondedAt: reviewResponseDateTimeSchema.nullable().default(null),
  responseReason: z.string().min(1).max(1_000).nullable().default(null),
  dueAt: reviewResponseDateTimeSchema.nullable(),
  createdAt: reviewResponseDateTimeSchema,
  conflict: reviewerConflictSchema.nullable().default(null),
});

export const organizerProposalReviewDetailResponseSchema = z.strictObject({
  proposal: z.strictObject({
    id: reviewIdSchema,
    publicId: z.string().min(1).max(128),
    title: reviewProposalTitleSchema,
    abstract: z.string().max(20_000),
    track: z.string().max(160),
    format: sessionFormatSchema,
    durationMinutes: z.number().int().positive().max(480),
    status: z.enum(["draft", "submitted", "in_review", "decided"]),
    participants: z.array(proposalCoPresenterResponseSchema).min(1).max(20),
    values: proposalValuesSchema,
  }),
  progress: z.strictObject({
    assigned: z.number().int().nonnegative(),
    submitted: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
  }),
  assignments: z.array(organizerReviewAssignmentSummarySchema),
  reviews: z.array(organizerSubmittedReviewSchema),
});

const decisionIdSchema = z.string().min(1).max(128);
const decisionTimestampSchema = z.iso.datetime({ offset: false, precision: 0 });
const decisionProposalSchema = z.strictObject({
  id: decisionIdSchema,
  publicId: z.string().min(1).max(128),
  slug: z.string().min(1).max(128),
  title: z.string().min(1).max(20_000),
});

export const decisionRecordRequestSchema = z.strictObject({
  proposalId: decisionIdSchema,
  decision: decisionValueSchema,
  rationale: z.string().trim().min(1).max(4_000),
});

export const decisionActorSchema = z.strictObject({
  userId: decisionIdSchema,
  displayName: z.string().min(1).max(120),
});

export const decisionStateSchema = z.strictObject({
  id: decisionIdSchema,
  value: decisionValueSchema,
  rationale: z.string().min(1).max(4_000),
  decidedBy: decisionActorSchema,
  decidedAt: decisionTimestampSchema,
});

export const acceptanceHandoffSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_applicable") }),
  z.strictObject({
    status: z.literal("materialized"),
    acceptanceId: decisionIdSchema,
    acceptedAt: decisionTimestampSchema,
    programSession: z.strictObject({
      id: decisionIdSchema,
      slug: z.string().min(1).max(128),
    }),
  }),
]);

export const notificationDeliveryStatusSchema = z.enum([
  "not_queued",
  "queued",
  "provider_accepted",
  "failed",
]);

export const notificationRecipientSchema = z.strictObject({
  speakerId: decisionIdSchema,
  userId: decisionIdSchema,
  name: z.string().min(1).max(120),
  email: z.email().max(254),
});

export const notificationRecipientSnapshotSchema = z.strictObject({
  speakerId: decisionIdSchema,
  userId: decisionIdSchema.nullable(),
  name: z.string().min(1).max(120),
  email: z.email().max(254).nullable(),
});

const notificationSnapshotBase = {
  id: decisionIdSchema,
  recipient: notificationRecipientSnapshotSchema,
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(20_000),
  queuedAt: decisionTimestampSchema,
};

export const queuedNotificationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...notificationSnapshotBase,
    status: z.literal("queued"),
  }),
  z.strictObject({
    ...notificationSnapshotBase,
    status: z.literal("provider_accepted"),
    providerAcceptedAt: decisionTimestampSchema,
  }),
  z.strictObject({
    ...notificationSnapshotBase,
    status: z.literal("failed"),
    failureMessage: z.string().min(1).max(1_000),
  }),
]);

export const notificationStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_queued") }),
  ...queuedNotificationSchema.options,
]);

export const decisionListItemSchema = z.strictObject({
  proposal: decisionProposalSchema,
  decision: decisionStateSchema,
  handoff: acceptanceHandoffSchema,
  notification: notificationStateSchema,
}).superRefine((value, context) => {
  const shouldMaterialize = value.decision.value === "accept";
  if (shouldMaterialize !== (value.handoff.status === "materialized")) {
    context.addIssue({
      code: "custom",
      path: ["handoff"],
      message: "Only an accepted decision has a materialized downstream handoff",
    });
  }
});

export const decisionRecordResponseSchema = decisionListItemSchema;

export const decisionListResponseSchema = z.strictObject({
  event: z.strictObject({
    slug: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
  }),
  decisions: z.array(decisionListItemSchema),
});

export const notificationPreviewResponseSchema = z.strictObject({
  proposal: decisionProposalSchema,
  decision: z.strictObject({
    id: decisionIdSchema,
    value: decisionValueSchema,
  }),
  recipient: notificationRecipientSchema,
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(20_000),
});

export const notificationQueueRequestSchema = z.strictObject({
  subject: z.string().trim().min(1).max(998),
  body: z.string().trim().min(1).max(20_000),
});

export const notificationQueueResponseSchema = queuedNotificationSchema;

export const ownerWorkspaceProposalSchema = z.strictObject({
  id: decisionIdSchema,
  publicId: z.string().min(1).max(128),
  title: z.string().min(1).max(20_000),
  status: z.enum(["draft", "submitted", "in_review", "decided"]),
  decision: decisionValueSchema.nullable(),
  notificationStatus: notificationDeliveryStatusSchema,
  acceptedSession: z.strictObject({
    id: decisionIdSchema,
    slug: z.string().min(1).max(128),
    title: z.string().min(1).max(20_000),
    track: z.string().min(1).max(160),
    format: sessionFormatSchema,
    durationMinutes: z.number().int().positive().max(480),
    presenters: z.array(z.strictObject({
      speakerId: decisionIdSchema,
      name: z.string().min(1).max(120),
      role: z.enum(["primary", "co_presenter"]),
    })).min(1),
    tasks: z.array(z.strictObject({
      id: decisionIdSchema,
      taskKey: z.string().min(1).max(64),
      label: z.string().min(1).max(200),
      state: z.enum(["open", "complete", "waived"]),
      completedAt: decisionTimestampSchema.nullable(),
    })),
  }).nullable(),
}).superRefine((value, context) => {
  if ((value.status === "decided") !== (value.decision !== null)) {
    context.addIssue({
      code: "custom",
      path: ["decision"],
      message: "A proposal decision is present exactly when its lifecycle is decided",
    });
  }
  if ((value.decision === "accept") !== (value.acceptedSession !== null)) {
    context.addIssue({
      code: "custom",
      path: ["acceptedSession"],
      message: "Only an accepted proposal has a downstream session",
    });
  }
  if (value.decision === null && value.notificationStatus !== "not_queued") {
    context.addIssue({
      code: "custom",
      path: ["notificationStatus"],
      message: "A proposal cannot have a decision notification before it is decided",
    });
  }
});

export const ownerWorkspaceResponseSchema = z.strictObject({
  event: z.strictObject({
    slug: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
  }),
  proposals: z.array(ownerWorkspaceProposalSchema),
});

const publicSlugSchema = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase kebab-case slug");
const publicDateSchema = z.iso.date();
const publicTimestampSchema = z.iso.datetime({ offset: false, precision: 0 });
const publicLabelSchema = z.string().trim().min(1).max(160);
const publicTimeZoneSchema = z.string().trim().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Use a valid IANA time zone");

export const publicEventResponseSchema = z.strictObject({
  slug: publicSlugSchema,
  name: z.string().min(1).max(200),
  tagline: z.string().max(500),
  location: z.string().max(500),
  description: z.string().max(20_000),
  startsOn: publicDateSchema,
  endsOn: publicDateSchema,
  timeZone: publicTimeZoneSchema,
  status: z.literal("published"),
});

const publicHeadshotUrlSchema = z.union([
  z.url().max(2_048).regex(/^https?:\/\//i, "Use an HTTP or HTTPS URL"),
  z.string().startsWith("/api/public/events/").max(1_024),
]);

export const publicSessionSpeakerSchema = z.strictObject({
  slug: publicSlugSchema,
  name: z.string().min(1).max(120),
  title: z.string().max(160),
  company: z.string().max(160),
  headshotUrl: publicHeadshotUrlSchema.nullable(),
  headshotFallback: z.string().min(1).max(12),
});

export const publicSessionScheduleSchema = z.strictObject({
  dayNumber: z.number().int().positive(),
  date: publicDateSchema,
  label: z.string().min(1).max(120),
  room: z.string().min(1).max(160),
  startsAt: publicTimestampSchema,
  endsAt: publicTimestampSchema,
}).refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), {
  path: ["endsAt"],
  error: "Session end time must be after its start time",
});

export const publicSessionResponseSchema = z.strictObject({
  slug: publicSlugSchema,
  title: z.string().min(1).max(20_000),
  abstract: z.string().min(1).max(20_000),
  track: publicLabelSchema,
  format: sessionFormatSchema,
  durationMinutes: z.number().int().positive().max(480),
  publicationStatus: z.literal("published"),
  schedule: publicSessionScheduleSchema,
  speakers: z.array(publicSessionSpeakerSchema).min(1),
});

export const publicSpeakerSessionSchema = z.strictObject({
  slug: publicSlugSchema,
  title: z.string().min(1).max(20_000),
  track: publicLabelSchema,
  format: sessionFormatSchema,
});

export const publicSpeakerResponseSchema = z.strictObject({
  slug: publicSlugSchema,
  name: z.string().min(1).max(120),
  title: z.string().max(160),
  company: z.string().max(160),
  bio: z.string().max(4_000),
  headshotUrl: publicHeadshotUrlSchema.nullable(),
  headshotFallback: z.string().min(1).max(12),
  publicVisibility: z.literal("published"),
  sessions: z.array(publicSpeakerSessionSchema),
});

export const publicProgramResponseSchema = z.strictObject({
  event: publicEventResponseSchema,
  sessions: z.array(publicSessionResponseSchema),
  speakers: z.array(publicSpeakerResponseSchema),
});

export const personalCalendarRequestSchema = z.strictObject({
  event: publicSlugSchema,
  sessionSlugs: z.array(publicSlugSchema).min(1).max(100),
});

export const embedViewSchema = z.enum([
  "sessions",
  "speakers",
  "agenda",
  "itinerary",
  "gallery",
]);

export const embedOutputFormatSchema = z.enum(["iframe", "json"]);

export const defaultEmbedAppearance = {
  theme: "light",
  accentColor: "#3157D5",
  density: "comfortable",
  showSearch: true,
  showFilters: true,
  showEventSummary: true,
} as const;

export const embedAppearanceSchema = z.strictObject({
  theme: z.enum(["light", "dark"]),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).transform((value) => value.toUpperCase()),
  density: z.enum(["comfortable", "compact"]),
  showSearch: z.boolean(),
  showFilters: z.boolean(),
  showEventSummary: z.boolean(),
});

function normalizedTextFilter(maxLength: number) {
  return z.array(z.string().trim().min(1).max(maxLength)).max(100)
    .transform((values) => [...new Set(values)].sort(compareUnicodeCodePoints));
}

function compareUnicodeCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export const embedFiltersSchema = z.strictObject({
  days: z.array(publicDateSchema).max(31)
    .transform((values) => [...new Set(values)].sort(compareUnicodeCodePoints)),
  tracks: normalizedTextFilter(160),
  formats: z.array(sessionFormatSchema).max(sessionFormatSchema.options.length)
    .transform((values) => [...new Set(values)].sort(compareUnicodeCodePoints)),
  rooms: normalizedTextFilter(160),
});

export const embedConfigCreateSchema = z.strictObject({
  slug: publicSlugSchema,
  name: z.string().trim().min(1).max(120),
  view: embedViewSchema,
  filters: embedFiltersSchema,
  outputFormat: embedOutputFormatSchema.default("iframe"),
  appearance: embedAppearanceSchema.default(defaultEmbedAppearance),
  enabled: z.boolean(),
});

export const embedConfigUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  view: embedViewSchema,
  filters: embedFiltersSchema,
  outputFormat: embedOutputFormatSchema,
  appearance: embedAppearanceSchema,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
});

export const embedConfigResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  eventSlug: publicSlugSchema,
  slug: publicSlugSchema,
  name: z.string().min(1).max(120),
  view: embedViewSchema,
  filters: embedFiltersSchema,
  outputFormat: embedOutputFormatSchema,
  appearance: embedAppearanceSchema,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: publicTimestampSchema,
  updatedAt: publicTimestampSchema,
  publicPath: z.string().regex(/^\/embed\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  jsonPath: z.string().regex(/^\/api\/public\/events\/[a-z0-9]+(?:-[a-z0-9]+)*\/embeds\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  calendarPath: z.string().regex(/^\/api\/public\/events\/[a-z0-9]+(?:-[a-z0-9]+)*\/embeds\/[a-z0-9]+(?:-[a-z0-9]+)*\/calendar\.ics$/),
});

export const embedConfigListResponseSchema = z.strictObject({
  embeds: z.array(embedConfigResponseSchema),
});

export const publicEmbedResponseSchema = z.strictObject({
  embed: z.strictObject({
    slug: publicSlugSchema,
    name: z.string().min(1).max(120),
    view: embedViewSchema,
    filters: embedFiltersSchema,
    appearance: embedAppearanceSchema,
    revision: z.number().int().positive(),
  }),
  program: publicProgramResponseSchema,
});

export const organizerEventCreateSchema = z.strictObject({
  slug: publicSlugSchema,
  name: z.string().trim().min(1).max(200),
  tagline: z.string().trim().max(500).default(""),
  location: z.string().trim().max(500).default(""),
  description: z.string().trim().max(20_000).default(""),
  startsOn: publicDateSchema,
  endsOn: publicDateSchema,
  timeZone: publicTimeZoneSchema,
  cfpOpensAt: publicTimestampSchema,
  cfpClosesAt: publicTimestampSchema,
  initialTrack: z.string().trim().min(1).max(120),
}).superRefine((value, context) => {
  if (value.startsOn > value.endsOn) {
    context.addIssue({ code: "custom", path: ["endsOn"], message: "End date must be on or after the start date" });
  }
  if (Date.parse(value.cfpOpensAt) >= Date.parse(value.cfpClosesAt)) {
    context.addIssue({ code: "custom", path: ["cfpClosesAt"], message: "CFP close time must be after the open time" });
  }
});

export const authUserSchema = z.strictObject({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1),
});

export const eventMembershipSchema = z.strictObject({
  eventSlug: z.string().min(1),
  role: eventRoleSchema,
});

export const authSessionSchema = z.strictObject({
  user: authUserSchema,
  memberships: z.array(eventMembershipSchema),
});

export const organizerEventCreateResponseSchema = z.strictObject({
  event: z.strictObject({
    slug: publicSlugSchema,
    name: z.string().min(1).max(200),
    status: z.literal("draft"),
  }),
  session: authSessionSchema,
});

export type AuthSession = z.infer<typeof authSessionSchema>;
export type OrganizerEventCreate = z.infer<typeof organizerEventCreateSchema>;
export type OrganizerEventCreateResponse = z.infer<typeof organizerEventCreateResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type CfpField = z.infer<typeof cfpFieldSchema>;
export type CfpEventCustomization = z.infer<typeof cfpEventCustomizationSchema>;
export type CfpConfigUpdate = z.infer<typeof cfpConfigUpdateSchema>;
export type SpeakerRegistration = z.infer<typeof speakerRegistrationSchema>;
export type ProposalDraftCreate = z.infer<typeof proposalDraftCreateSchema>;
export type ProposalDraftUpdate = z.infer<typeof proposalDraftUpdateSchema>;
export type CfpPublicConfigResponse = z.infer<typeof cfpPublicConfigResponseSchema>;
export type ProposalResponse = z.infer<typeof proposalResponseSchema>;
export type OrganizerProposalPageResponse = z.infer<typeof organizerProposalPageResponseSchema>;
export type SpeakerProposalListResponse = z.infer<typeof speakerProposalListResponseSchema>;
export type CfpOption = z.infer<typeof cfpOptionResponseSchema>;
export type ReviewRecommendation = z.infer<typeof reviewRecommendationSchema>;
export type ReviewAssignmentStatus = z.infer<typeof reviewAssignmentStatusSchema>;
export type ReviewInvitationStatus = z.infer<typeof reviewInvitationStatusSchema>;
export type ReviewerConflictCategory = z.infer<typeof reviewerConflictCategorySchema>;
export type ReviewInvitationResponseRequest = z.infer<typeof reviewInvitationResponseRequestSchema>;
export type ReviewRecusalRequest = z.infer<typeof reviewRecusalRequestSchema>;
export type ReviewerConflictDeclare = z.infer<typeof reviewerConflictDeclareSchema>;
export type ReviewerConflict = z.infer<typeof reviewerConflictSchema>;
export type ReviewAssignmentLifecycleResponse = z.infer<typeof reviewAssignmentLifecycleResponseSchema>;
export type OrganizerReviewAssignmentCreate = z.infer<typeof organizerReviewAssignmentCreateSchema>;
export type ReviewRoundWrite = z.infer<typeof reviewRoundWriteSchema>;
export type ReviewRoundUpdate = z.infer<typeof reviewRoundUpdateSchema>;
export type ReviewRoundResponse = z.infer<typeof reviewRoundResponseSchema>;
export type ReviewRoundListResponse = z.infer<typeof reviewRoundListResponseSchema>;
export type ReviewRoundPoolWrite = z.infer<typeof reviewRoundPoolWriteSchema>;
export type ReviewRoundPoolResponse = z.infer<typeof reviewRoundPoolResponseSchema>;
export type ReviewerProgressResponse = z.infer<typeof reviewerProgressResponseSchema>;
export type ReviewAutoAssignRequest = z.infer<typeof reviewAutoAssignRequestSchema>;
export type ReviewAutoAssignResult = z.infer<typeof reviewAutoAssignResultSchema>;
export type ReviewerReminderTemplateKey = z.infer<typeof reviewerReminderTemplateKeySchema>;
export type ReviewerReminderEnqueue = z.infer<typeof reviewerReminderEnqueueSchema>;
export type ReviewerReminderResponse = z.infer<typeof reviewerReminderResponseSchema>;
export type ProposalCoPresenterWrite = z.infer<typeof proposalCoPresenterWriteSchema>;
export type ProposalCoPresenterListResponse = z.infer<typeof proposalCoPresenterListResponseSchema>;
export type EvaluationPlanBuiltinLabels = z.infer<typeof evaluationPlanBuiltinLabelsSchema>;
export type ReviewScorecardSubmit = z.infer<typeof reviewScorecardSubmitSchema>;
export type SubmittedReview = z.infer<typeof submittedReviewSchema>;
export type EvaluationPlanWrite = z.infer<typeof evaluationPlanWriteSchema>;
export type EvaluationPlanVersion = z.infer<typeof evaluationPlanVersionSchema>;
export type ReviewerMembershipResponse = z.infer<typeof reviewerMembershipResponseSchema>;
export type ReviewerMembershipListResponse = z.infer<typeof reviewerMembershipListResponseSchema>;
export type ReviewAssignmentResponse = z.infer<typeof reviewAssignmentResponseSchema>;
export type ReviewAssignmentRevokeResponse = z.infer<typeof reviewAssignmentRevokeResponseSchema>;
export type ReviewerAssignmentQueueItem = z.infer<typeof reviewerAssignmentQueueItemSchema>;
export type ReviewerAssignmentQueueResponse = z.infer<typeof reviewerAssignmentQueueResponseSchema>;
export type BlindReviewProposal = z.infer<typeof blindReviewProposalSchema>;
export type IdentifiedReviewProposal = z.infer<typeof identifiedReviewProposalSchema>;
export type ReviewerAssignmentDetailResponse = z.infer<typeof reviewerAssignmentDetailResponseSchema>;
export type OrganizerProposalReviewProgress = z.infer<typeof organizerProposalReviewProgressSchema>;
export type OrganizerProposalReviewProgressResponse = z.infer<typeof organizerProposalReviewProgressResponseSchema>;
export type OrganizerSubmittedReview = z.infer<typeof organizerSubmittedReviewSchema>;
export type OrganizerReviewAssignmentSummary = z.infer<typeof organizerReviewAssignmentSummarySchema>;
export type OrganizerProposalReviewDetailResponse = z.infer<typeof organizerProposalReviewDetailResponseSchema>;
export type DecisionValue = z.infer<typeof decisionValueSchema>;
export type DecisionRecordRequest = z.infer<typeof decisionRecordRequestSchema>;
export type DecisionActor = z.infer<typeof decisionActorSchema>;
export type DecisionState = z.infer<typeof decisionStateSchema>;
export type AcceptanceHandoff = z.infer<typeof acceptanceHandoffSchema>;
export type NotificationDeliveryStatus = z.infer<typeof notificationDeliveryStatusSchema>;
export type NotificationRecipient = z.infer<typeof notificationRecipientSchema>;
export type NotificationRecipientSnapshot = z.infer<typeof notificationRecipientSnapshotSchema>;
export type QueuedNotification = z.infer<typeof queuedNotificationSchema>;
export type NotificationState = z.infer<typeof notificationStateSchema>;
export type DecisionListItem = z.infer<typeof decisionListItemSchema>;
export type DecisionRecordResponse = z.infer<typeof decisionRecordResponseSchema>;
export type DecisionListResponse = z.infer<typeof decisionListResponseSchema>;
export type NotificationPreviewResponse = z.infer<typeof notificationPreviewResponseSchema>;
export type NotificationQueueRequest = z.infer<typeof notificationQueueRequestSchema>;
export type NotificationQueueResponse = z.infer<typeof notificationQueueResponseSchema>;
export type OwnerWorkspaceProposal = z.infer<typeof ownerWorkspaceProposalSchema>;
export type OwnerWorkspaceResponse = z.infer<typeof ownerWorkspaceResponseSchema>;
export type PublicEventResponse = z.infer<typeof publicEventResponseSchema>;
export type PublicSessionSpeaker = z.infer<typeof publicSessionSpeakerSchema>;
export type PublicSessionSchedule = z.infer<typeof publicSessionScheduleSchema>;
export type PublicSessionResponse = z.infer<typeof publicSessionResponseSchema>;
export type PublicSpeakerSession = z.infer<typeof publicSpeakerSessionSchema>;
export type PublicSpeakerResponse = z.infer<typeof publicSpeakerResponseSchema>;
export type PublicProgramResponse = z.infer<typeof publicProgramResponseSchema>;
export type PersonalCalendarRequest = z.infer<typeof personalCalendarRequestSchema>;
export type EmbedView = z.infer<typeof embedViewSchema>;
export type EmbedFilters = z.infer<typeof embedFiltersSchema>;
export type EmbedConfigCreate = z.infer<typeof embedConfigCreateSchema>;
export type EmbedConfigUpdate = z.infer<typeof embedConfigUpdateSchema>;
export type EmbedConfigResponse = z.infer<typeof embedConfigResponseSchema>;
export type EmbedConfigListResponse = z.infer<typeof embedConfigListResponseSchema>;
export type EmbedAppearance = z.infer<typeof embedAppearanceSchema>;
export type EmbedOutputFormat = z.infer<typeof embedOutputFormatSchema>;
export type PublicEmbedResponse = z.infer<typeof publicEmbedResponseSchema>;
