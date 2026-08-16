import { z } from "zod";

import { normalizedEmailSchema } from "./speaker-content";

const utcSecondsSchema = z.iso.datetime({ offset: false, precision: 0 });
const tokenSchema = z.string().min(32).max(512);

export const speakerClaimStateSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export const speakerClaimOutboxStateSchema = z.enum(["queued", "leased", "provider_accepted", "failed", "suppressed"]);

export const speakerClaimCreateSchema = z.strictObject({
  speakerId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(128),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const speakerClaimTokenRequestSchema = z.strictObject({ token: tokenSchema });
export const speakerClaimRegisterSchema = z.strictObject({
  token: tokenSchema,
  displayName: z.string().trim().min(2).max(120).regex(/^[^\u0000-\u001f\u007f]+$/, "Name cannot contain control characters"),
  password: z.string().min(12).max(128),
});

export const speakerClaimResponseSchema = z.strictObject({
  id: z.string().min(1),
  speaker: z.strictObject({ id: z.string().min(1), name: z.string().min(1).max(120) }),
  email: normalizedEmailSchema,
  state: speakerClaimStateSchema,
  expiresAt: utcSecondsSchema,
  createdAt: utcSecondsSchema,
  updatedAt: utcSecondsSchema,
  acceptedAt: utcSecondsSchema.nullable(),
  revokedAt: utcSecondsSchema.nullable(),
  outboxState: speakerClaimOutboxStateSchema.nullable(),
});

export const speakerClaimListResponseSchema = z.strictObject({ claims: z.array(speakerClaimResponseSchema) });
export const speakerClaimCreateResponseSchema = z.strictObject({
  claim: speakerClaimResponseSchema,
  acceptPath: z.string().min(1).max(1_024).nullable(),
  replayed: z.boolean(),
}).superRefine(({ acceptPath, replayed }, context) => {
  if (replayed === (acceptPath !== null)) {
    context.addIssue({
      code: "custom",
      path: ["acceptPath"],
      message: "New claims require an accept path; replays must not return one",
    });
  }
});
export const speakerClaimResolveResponseSchema = z.strictObject({
  event: z.strictObject({ slug: z.string().min(1), name: z.string().min(1) }),
  speaker: z.strictObject({ id: z.string().min(1), name: z.string().min(1).max(120) }),
  email: normalizedEmailSchema,
  expiresAt: utcSecondsSchema,
});

export type SpeakerClaim = z.infer<typeof speakerClaimResponseSchema>;
export type SpeakerClaimCreate = z.infer<typeof speakerClaimCreateSchema>;
export type SpeakerClaimCreateResponse = z.infer<typeof speakerClaimCreateResponseSchema>;
export type SpeakerClaimListResponse = z.infer<typeof speakerClaimListResponseSchema>;
export type SpeakerClaimResolveResponse = z.infer<typeof speakerClaimResolveResponseSchema>;
export type SpeakerClaimRegister = z.infer<typeof speakerClaimRegisterSchema>;
