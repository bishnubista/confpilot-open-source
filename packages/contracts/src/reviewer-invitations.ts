import { z } from "zod";

import { normalizedEmailSchema } from "./speaker-content";

const utcSecondsSchema = z.iso.datetime({ offset: false, precision: 0 });
const invitationTokenSchema = z.string().min(32).max(512);

export const reviewerInvitationStateSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export const reviewerInvitationOutboxStateSchema = z.enum([
  "queued",
  "leased",
  "provider_accepted",
  "failed",
  "suppressed",
]);

export const reviewerInvitationCreateSchema = z.strictObject({
  email: normalizedEmailSchema,
  displayName: z.string().trim().min(2).max(120).regex(/^[^\u0000-\u001f\u007f]+$/, "Name cannot contain control characters"),
  idempotencyKey: z.string().trim().min(8).max(128),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const reviewerInvitationTokenRequestSchema = z.strictObject({
  token: invitationTokenSchema,
});

export const reviewerInvitationRegisterSchema = z.strictObject({
  token: invitationTokenSchema,
  displayName: z.string().trim().min(2).max(120).regex(/^[^\u0000-\u001f\u007f]+$/, "Name cannot contain control characters"),
  password: z.string().min(12).max(128),
});

export const reviewerInvitationResponseSchema = z.strictObject({
  id: z.string().min(1),
  email: normalizedEmailSchema,
  displayName: z.string().min(1).max(120),
  state: reviewerInvitationStateSchema,
  expiresAt: utcSecondsSchema,
  createdAt: utcSecondsSchema,
  updatedAt: utcSecondsSchema,
  acceptedAt: utcSecondsSchema.nullable(),
  revokedAt: utcSecondsSchema.nullable(),
  outboxState: reviewerInvitationOutboxStateSchema.nullable(),
});

export const reviewerInvitationListResponseSchema = z.strictObject({
  invitations: z.array(reviewerInvitationResponseSchema),
});

export const reviewerInvitationCreateResponseSchema = z.strictObject({
  invitation: reviewerInvitationResponseSchema,
  acceptPath: z.string().min(1).max(1_024).nullable(),
  replayed: z.boolean(),
}).superRefine(({ acceptPath, replayed }, context) => {
  if (replayed === (acceptPath !== null)) {
    context.addIssue({
      code: "custom",
      path: ["acceptPath"],
      message: "New invitations require an accept path; replays must not return one",
    });
  }
});

export const reviewerInvitationResolveResponseSchema = z.strictObject({
  event: z.strictObject({
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
  email: normalizedEmailSchema,
  displayName: z.string().min(1).max(120),
  expiresAt: utcSecondsSchema,
});

export type ReviewerInvitationCreate = z.infer<typeof reviewerInvitationCreateSchema>;
export type ReviewerInvitation = z.infer<typeof reviewerInvitationResponseSchema>;
export type ReviewerInvitationCreateResponse = z.infer<typeof reviewerInvitationCreateResponseSchema>;
export type ReviewerInvitationListResponse = z.infer<typeof reviewerInvitationListResponseSchema>;
export type ReviewerInvitationResolveResponse = z.infer<typeof reviewerInvitationResolveResponseSchema>;
export type ReviewerInvitationRegister = z.infer<typeof reviewerInvitationRegisterSchema>;
