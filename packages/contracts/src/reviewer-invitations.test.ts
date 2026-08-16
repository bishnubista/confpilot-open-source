import { describe, expect, it } from "vitest";

import {
  reviewerInvitationCreateResponseSchema,
  reviewerInvitationCreateSchema,
  reviewerInvitationRegisterSchema,
} from "./reviewer-invitations";

describe("reviewer invitation contracts", () => {
  it("normalizes organizer input and rejects control characters", () => {
    expect(reviewerInvitationCreateSchema.parse({
      email: "Reviewer@Example.Test",
      displayName: "  Nia Reviewer  ",
      idempotencyKey: "invite-key-1",
    })).toMatchObject({ email: "reviewer@example.test", displayName: "Nia Reviewer", expiresInDays: 7 });
    expect(reviewerInvitationCreateSchema.safeParse({
      email: "reviewer@example.test",
      displayName: "Nia\nReviewer",
      idempotencyKey: "invite-key-1",
    }).success).toBe(false);
  });

  it("requires a strong-enough password and a bearer-sized token", () => {
    expect(reviewerInvitationRegisterSchema.safeParse({
      token: "too-short",
      displayName: "Nia Reviewer",
      password: "short",
    }).success).toBe(false);
  });

  it("models a one-time link separately from the invitation ledger", () => {
    const parsed = reviewerInvitationCreateResponseSchema.parse({
      invitation: {
        id: "invitation-1",
        email: "reviewer@example.test",
        displayName: "Nia Reviewer",
        state: "pending",
        expiresAt: "2026-08-20T12:00:00Z",
        createdAt: "2026-08-13T12:00:00Z",
        updatedAt: "2026-08-13T12:00:00Z",
        acceptedAt: null,
        revokedAt: null,
        outboxState: "queued",
      },
      acceptPath: "/reviewer-invitation#abcdefghijklmnopqrstuvwxyz123456",
      replayed: false,
    });
    expect(parsed.acceptPath).toContain("#");
    expect(reviewerInvitationCreateResponseSchema.parse({ ...parsed, acceptPath: null, replayed: true }).acceptPath).toBeNull();
    expect(reviewerInvitationCreateResponseSchema.safeParse({ ...parsed, acceptPath: null, replayed: false }).success).toBe(false);
    expect(reviewerInvitationCreateResponseSchema.safeParse({ ...parsed, replayed: true }).success).toBe(false);
    expect(reviewerInvitationCreateResponseSchema.parse({
      ...parsed,
      invitation: { ...parsed.invitation, state: "expired", outboxState: "suppressed" },
      acceptPath: null,
      replayed: true,
    }).invitation.state).toBe("expired");
  });
});
