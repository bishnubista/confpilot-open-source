import { describe, expect, it } from "vitest";

import {
  reviewAssignmentLifecycleResponseSchema,
  reviewInvitationResponseRequestSchema,
  reviewRecusalRequestSchema,
  reviewerConflictDeclareSchema,
} from "./index";

describe("review assignment lifecycle contracts", () => {
  it("accepts only explicit accept or reasoned decline responses", () => {
    expect(reviewInvitationResponseRequestSchema.parse({ action: "accept" })).toEqual({ action: "accept" });
    expect(reviewInvitationResponseRequestSchema.parse({ action: "decline", reason: "  No capacity.  " }))
      .toEqual({ action: "decline", reason: "No capacity." });
    expect(reviewInvitationResponseRequestSchema.safeParse({ action: "decline", reason: " " }).success).toBe(false);
    expect(reviewInvitationResponseRequestSchema.safeParse({ action: "recuse", reason: "Conflict" }).success).toBe(false);
  });

  it("requires bounded reasons and closed conflict categories", () => {
    expect(reviewRecusalRequestSchema.safeParse({ reason: " " }).success).toBe(false);
    expect(reviewerConflictDeclareSchema.parse({
      category: "institutional",
      note: "  Shared reporting line.  ",
    })).toEqual({ category: "institutional", note: "Shared reporting line." });
    expect(reviewerConflictDeclareSchema.safeParse({ category: "unspecified", note: "Conflict" }).success).toBe(false);
    expect(reviewerConflictDeclareSchema.safeParse({ category: "other", note: "x".repeat(1_001) }).success).toBe(false);
  });

  it("keeps lifecycle responses strict and conflict declarations event-safe by shape", () => {
    const response = {
      id: "assignment-1",
      invitationStatus: "recused",
      respondedAt: "2026-08-12T12:00:00Z",
      reason: "Perceived bias.",
      conflict: {
        category: "personal",
        note: "Perceived bias.",
        declaredAt: "2026-08-12T12:00:00Z",
      },
    };
    expect(reviewAssignmentLifecycleResponseSchema.parse(response)).toEqual(response);
    expect(reviewAssignmentLifecycleResponseSchema.safeParse({ ...response, reviewerEmail: "private@example.test" }).success)
      .toBe(false);
  });
});
