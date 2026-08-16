import { z } from "zod";

const entityIdSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.iso.datetime({ offset: false, precision: 0 });
const allowedCommunicationMergeTokens = new Set(["first_name", "session_title", "portal_link"]);

function communicationTemplateSchema(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).superRefine((value, context) => {
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
      if (!allowedCommunicationMergeTokens.has(match[1])) {
        context.addIssue({
          code: "custom",
          message: `Unknown merge token {${match[1]}}`,
        });
      }
    }
  });
}

export const emailCapabilitySchema = z.discriminatedUnion("enabled", [
  z.strictObject({
    enabled: z.literal(true),
    provider: z.string().trim().min(1).max(80),
    reason: z.literal("configured"),
    sendAfter: timestampSchema,
  }),
  z.strictObject({
    enabled: z.literal(false),
    provider: z.null(),
    reason: z.enum(["delivery_disabled", "sender_missing", "sender_invalid", "activation_cutoff_missing"]),
  }),
]);

export const communicationTransportStatusSchema = z.enum([
  "queued",
  "sending",
  "retrying",
  "provider_accepted",
  "failed",
  "canceled",
]);

export const communicationHistoryItemSchema = z.strictObject({
  id: entityIdSchema,
  intent: z.string().trim().min(1).max(80),
  recipient: z.strictObject({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(254),
  }),
  subject: z.string().trim().min(1).max(998),
  transportStatus: communicationTransportStatusSchema,
  deliveryStatus: z.enum(["not_attempted", "attempted_unverified", "unverified"]),
  attemptCount: z.number().int().nonnegative().max(20),
  provider: z.string().trim().min(1).max(80).nullable(),
  providerMessageId: z.string().trim().min(1).max(500).nullable(),
  lastErrorCode: z.string().trim().min(1).max(80).nullable(),
  cancellationCode: z.string().trim().min(1).max(80).nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  providerAcceptedAt: timestampSchema.nullable(),
}).superRefine((value, context) => {
  const accepted = value.transportStatus === "provider_accepted";
  const expectedDeliveryStatus = accepted
    ? "unverified"
    : value.attemptCount > 0 ? "attempted_unverified" : "not_attempted";
  if (value.deliveryStatus !== expectedDeliveryStatus) {
    context.addIssue({
      code: "custom",
      path: ["deliveryStatus"],
      message: "Delivery status must truthfully reflect provider attempts and acceptance",
    });
  }
  if ((value.providerAcceptedAt !== null) !== accepted) {
    context.addIssue({
      code: "custom",
      path: ["providerAcceptedAt"],
      message: "Provider acceptance time must match provider-accepted status",
    });
  }
  if (value.transportStatus === "canceled" && value.cancellationCode === null) {
    context.addIssue({
      code: "custom",
      path: ["cancellationCode"],
      message: "Canceled transport status must include its cancellation code",
    });
  }
  if (["sending", "retrying", "provider_accepted", "failed"].includes(value.transportStatus)
    && value.attemptCount === 0) {
    context.addIssue({
      code: "custom",
      path: ["attemptCount"],
      message: "Attempted transport statuses must record at least one attempt",
    });
  }
});

export const communicationHistoryResponseSchema = z.strictObject({
  capability: emailCapabilitySchema,
  messages: z.array(communicationHistoryItemSchema).max(250),
});

export const bulkSpeakerCommunicationEnqueueSchema = z.strictObject({
  speakerIds: z.array(entityIdSchema).min(1).max(250).superRefine((speakerIds, context) => {
    const seen = new Set<string>();
    for (const [index, speakerId] of speakerIds.entries()) {
      if (seen.has(speakerId)) {
        context.addIssue({ code: "custom", path: [index], message: "Speaker targets must be unique" });
      }
      seen.add(speakerId);
    }
  }),
  subject: communicationTemplateSchema(998),
  body: communicationTemplateSchema(20_000),
  idempotencyKey: z.string().trim().min(8).max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, underscores, or hyphens"),
});

export const bulkSpeakerCommunicationSkipSchema = z.strictObject({
  speakerId: entityIdSchema,
  reason: z.enum(["not_found", "contact_email_missing", "idempotency_conflict"]),
});

export const bulkSpeakerCommunicationResponseSchema = z.strictObject({
  requestedCount: z.number().int().positive().max(250),
  queuedCount: z.number().int().nonnegative().max(250),
  messageIds: z.array(entityIdSchema).max(250),
  skipped: z.array(bulkSpeakerCommunicationSkipSchema).max(250),
}).superRefine((value, context) => {
  if (value.queuedCount !== value.messageIds.length) {
    context.addIssue({ code: "custom", path: ["queuedCount"], message: "Queued count must match message IDs" });
  }
  if (value.queuedCount + value.skipped.length !== value.requestedCount) {
    context.addIssue({ code: "custom", path: ["requestedCount"], message: "Every requested speaker must be accounted for" });
  }
  if (new Set(value.messageIds).size !== value.messageIds.length) {
    context.addIssue({ code: "custom", path: ["messageIds"], message: "Queued message IDs must be unique" });
  }
  const skippedSpeakerIds = value.skipped.map(({ speakerId }) => speakerId);
  if (new Set(skippedSpeakerIds).size !== skippedSpeakerIds.length) {
    context.addIssue({ code: "custom", path: ["skipped"], message: "Skipped speaker IDs must be unique" });
  }
});

export type EmailCapabilityResponse = z.infer<typeof emailCapabilitySchema>;
export type CommunicationHistoryItem = z.infer<typeof communicationHistoryItemSchema>;
export type CommunicationHistoryResponse = z.infer<typeof communicationHistoryResponseSchema>;
export type BulkSpeakerCommunicationEnqueue = z.infer<typeof bulkSpeakerCommunicationEnqueueSchema>;
export type BulkSpeakerCommunicationResponse = z.infer<typeof bulkSpeakerCommunicationResponseSchema>;
