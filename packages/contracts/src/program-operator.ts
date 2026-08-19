import { z } from "zod";

const utcSecondSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  "Expected a UTC timestamp with second precision",
);

export const programOperatorEvidenceSourceSchema = z.enum([
  "event",
  "program_readiness",
  "speaker",
  "speaker_task",
  "program_session",
  "deliverable_request",
  "review_assignment",
  "reviewer_summary",
  "message_outbox",
  "notification_outbox",
]);

export const programOperatorEvidenceSchema = z.strictObject({
  id: z.string().trim().min(1).max(512),
  source: programOperatorEvidenceSourceSchema,
  recordId: z.string().trim().min(1).max(256),
  fields: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
});

const evidenceIdsSchema = z.array(z.string().trim().min(1).max(512)).min(1).max(50);

export const programOperatorRiskSchema = z.strictObject({
  id: z.string().trim().min(1).max(512),
  rank: z.number().int().positive(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  kind: z.enum([
    "readiness_blocker",
    "overdue_speaker_task",
    "overdue_deliverable",
    "review_backlog",
    "outbox_failure",
    "stale_outbox",
  ]),
  title: z.string().trim().min(1).max(300),
  explanation: z.string().trim().min(1).max(1_000),
  suggestedResolution: z.string().trim().min(1).max(500),
  affectedRecords: z.array(z.strictObject({
    type: z.enum(["event", "session", "speaker", "speaker_task", "deliverable_request", "review_assignment", "message"]),
    id: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(300),
  })).min(1).max(20),
  evidenceIds: evidenceIdsSchema,
  confidence: z.enum(["high", "medium", "low"]),
});

const exactRecipientSchema = z.strictObject({
  type: z.enum(["speaker", "reviewer"]),
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(120),
  email: z.email(),
});

const reminderDraftSchema = z.strictObject({
  templateKey: z.string().trim().min(1).max(120),
  templateRevision: z.number().int().positive(),
  subject: z.string().trim().min(1).max(998),
  text: z.string().trim().min(1).max(20_000),
});

export const programOperatorPlanItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: z.string().trim().min(1).max(512),
    kind: z.literal("speaker_reminder"),
    status: z.literal("draft"),
    requiredApproval: z.literal("human"),
    queueOperation: z.literal("speakers.queueReminders"),
    recipient: exactRecipientSchema.extend({ type: z.literal("speaker") }),
    draft: reminderDraftSchema,
    expectedStateChange: z.string().trim().min(1).max(500),
    evidenceIds: evidenceIdsSchema,
  }),
  z.strictObject({
    id: z.string().trim().min(1).max(512),
    kind: z.literal("reviewer_reminder"),
    status: z.literal("draft"),
    requiredApproval: z.literal("human"),
    queueOperation: z.literal("review.queueReviewerReminder"),
    recipient: exactRecipientSchema.extend({ type: z.literal("reviewer") }),
    draft: reminderDraftSchema,
    expectedStateChange: z.string().trim().min(1).max(500),
    evidenceIds: evidenceIdsSchema,
  }),
]);

export const programOperatorExceptionSchema = z.strictObject({
  id: z.string().trim().min(1).max(512),
  kind: z.enum(["missing_recipient", "missing_deadline", "manual_judgment", "scope_limit"]),
  title: z.string().trim().min(1).max(300),
  explanation: z.string().trim().min(1).max(1_000),
  evidenceIds: evidenceIdsSchema,
});

const programOperatorBriefObjectSchema = z.strictObject({
  event: z.strictObject({
    id: z.string().trim().min(1).max(256),
    slug: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(200),
  }),
  snapshot: z.strictObject({
    schemaVersion: z.literal(1),
    capturedAt: utcSecondSchema,
    staleLeaseBefore: utcSecondSchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceCount: z.number().int().nonnegative(),
  }),
  generation: z.strictObject({
    mode: z.literal("deterministic"),
    modelStatus: z.literal("not_configured"),
    policyVersion: z.literal("program-operator-shadow-v1"),
  }),
  summary: z.strictObject({
    status: z.enum(["complete", "attention_needed"]),
    acceptedSessions: z.number().int().nonnegative(),
    publishReadySessions: z.number().int().nonnegative(),
    riskCount: z.number().int().nonnegative(),
    reminderDraftCount: z.number().int().nonnegative(),
    exceptionCount: z.number().int().nonnegative(),
  }),
  evidence: z.array(programOperatorEvidenceSchema).max(10_001),
  risks: z.array(programOperatorRiskSchema).max(100),
  plan: z.array(programOperatorPlanItemSchema).max(50),
  exceptions: z.array(programOperatorExceptionSchema).max(50),
  guardrails: z.strictObject({
    shadowMode: z.literal(true),
    writesPerformed: z.literal(0),
    unauthorizedActions: z.literal(0),
  }),
});

export const programOperatorBriefResponseSchema = programOperatorBriefObjectSchema.superRefine((value, context) => {
  if (value.snapshot.evidenceCount !== value.evidence.length) {
    context.addIssue({ code: "custom", path: ["snapshot", "evidenceCount"], message: "Evidence count must match the evidence ledger" });
  }
  if (value.summary.riskCount !== value.risks.length) {
    context.addIssue({ code: "custom", path: ["summary", "riskCount"], message: "Risk count must match the ranked risks" });
  }
  if (value.summary.reminderDraftCount !== value.plan.length) {
    context.addIssue({ code: "custom", path: ["summary", "reminderDraftCount"], message: "Reminder count must match the draft plan" });
  }
  if (value.summary.exceptionCount !== value.exceptions.length) {
    context.addIssue({ code: "custom", path: ["summary", "exceptionCount"], message: "Exception count must match the exception list" });
  }
  if ((value.summary.status === "complete") !== (value.risks.length === 0 && value.exceptions.length === 0)) {
    context.addIssue({ code: "custom", path: ["summary", "status"], message: "Complete status requires no risks or exceptions" });
  }
  const evidenceIds = new Set(value.evidence.map(({ id }) => id));
  if (evidenceIds.size !== value.evidence.length) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Evidence IDs must be unique" });
  }
  const linked = [
    ...value.risks.map((item, index) => ({ item, path: ["risks", index] as const })),
    ...value.plan.map((item, index) => ({ item, path: ["plan", index] as const })),
    ...value.exceptions.map((item, index) => ({ item, path: ["exceptions", index] as const })),
  ];
  for (const { item, path } of linked) {
    for (const evidenceId of item.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({ code: "custom", path: [...path, "evidenceIds"], message: `Unknown evidence reference: ${evidenceId}` });
      }
    }
  }
  value.risks.forEach((risk, index) => {
    if (risk.rank !== index + 1) {
      context.addIssue({ code: "custom", path: ["risks", index, "rank"], message: "Risk ranks must be contiguous and ordered" });
    }
  });
});

export type ProgramOperatorBriefResponse = z.infer<typeof programOperatorBriefResponseSchema>;
