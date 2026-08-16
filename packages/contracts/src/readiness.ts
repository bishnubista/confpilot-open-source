import { z } from "zod";

export const programReadinessStageSchema = z.enum([
  "accepted",
  "profile_ready",
  "deliverables_ready",
  "scheduled",
  "approved",
  "published",
]);

export const programReadinessBlockerKindSchema = z.enum([
  "speaker_profile_incomplete",
  "speaker_tasks_incomplete",
  "deliverable_missing",
  "deliverable_unapproved",
  "content_approval_pending",
  "session_unscheduled",
  "speaker_conflict",
  "publication_pending",
]);

export const programReadinessEntityTypeSchema = z.enum(["event", "session", "speaker"]);

export const programReadinessLifecycleSchema = z.strictObject({
  stage: programReadinessStageSchema,
  label: z.string().trim().min(1).max(80),
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).refine((value) => value.count <= value.total, {
  path: ["count"],
  message: "Stage count cannot exceed its accepted-session denominator",
});

export const programReadinessBlockerSchema = z.strictObject({
  id: z.string().trim().min(1).max(512),
  kind: programReadinessBlockerKindSchema,
  entityType: programReadinessEntityTypeSchema,
  entityId: z.string().trim().min(1).max(128),
  entityLabel: z.string().trim().min(1).max(300),
  rule: z.string().trim().min(1).max(200),
  explanation: z.string().trim().min(1).max(500),
  actionLabel: z.string().trim().min(1).max(120),
  actionPath: z.string().trim().min(1).max(512).regex(/^\/admin(?:[/?]|$)/),
});

const programReadinessResponseObjectSchema = z.strictObject({
  event: z.strictObject({
    slug: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
  }),
  summary: z.strictObject({
    accepted: z.number().int().nonnegative(),
    publishReady: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    percent: z.number().int().min(0).max(100),
  }),
  lifecycle: z.array(programReadinessLifecycleSchema).length(6),
  blockers: z.array(programReadinessBlockerSchema),
});

const orderedStages = programReadinessStageSchema.options;

export const programReadinessResponseSchema = programReadinessResponseObjectSchema.superRefine((value, context) => {
  const { accepted, publishReady, blocked, percent } = value.summary;
  if (publishReady > accepted) {
    context.addIssue({ code: "custom", path: ["summary", "publishReady"], message: "Publish-ready count cannot exceed accepted count" });
  }
  if (blocked !== accepted - publishReady) {
    context.addIssue({ code: "custom", path: ["summary", "blocked"], message: "Blocked count must be accepted minus publish-ready" });
  }
  const expectedPercent = accepted === 0 ? 0 : Math.round((publishReady / accepted) * 100);
  if (percent !== expectedPercent) {
    context.addIssue({ code: "custom", path: ["summary", "percent"], message: "Percent must be derived from accepted and publish-ready counts" });
  }
  for (const [index, stage] of value.lifecycle.entries()) {
    if (stage.stage !== orderedStages[index]) {
      context.addIssue({ code: "custom", path: ["lifecycle", index, "stage"], message: "Lifecycle stages must use the canonical order" });
    }
    if (stage.total !== accepted) {
      context.addIssue({ code: "custom", path: ["lifecycle", index, "total"], message: "Every lifecycle stage must use the accepted-session denominator" });
    }
  }
  if (value.lifecycle[0]?.count !== accepted) {
    context.addIssue({ code: "custom", path: ["lifecycle", 0, "count"], message: "Accepted stage must match the accepted summary" });
  }
  const blockerIds = new Set<string>();
  for (const [index, blocker] of value.blockers.entries()) {
    if (blockerIds.has(blocker.id)) {
      context.addIssue({ code: "custom", path: ["blockers", index, "id"], message: "Blocker IDs must be unique" });
    }
    blockerIds.add(blocker.id);
  }
});

export type ProgramReadinessStage = z.infer<typeof programReadinessStageSchema>;
export type ProgramReadinessBlockerKind = z.infer<typeof programReadinessBlockerKindSchema>;
export type ProgramReadinessResponse = z.infer<typeof programReadinessResponseSchema>;
